/**
 * server/infra/gateway.js —— AI Infra 网关自动注册（B1）
 *
 * 集群里的网关是一个 **hostNetwork 的 nginx（stream 模块）**：它按端口把 TCP 流量
 * 转给 `Service`。这一层负责三件事，每一件都对应一次真机事故：
 *
 *   renderGatewayConfig  —— 把「服务 + expose.gatewayPort」渲染成 nginx stream 配置片段。
 *                           **端口冲突先于渲染报出来**：同一 listen 端口出现两个 server 块，
 *                           nginx 直接 `bind() failed (98: Address in use)` 起不来。
 *   planGatewayUpdate    —— 与现存 nginx.conf 做 unified diff，并给出给人看的中文操作序列。
 *   applyGatewayConfig   —— 注入 client 写 ConfigMap（幂等），再给 Deployment 打 reload 注解。
 *
 * 三条真机教训（设计上的硬约束）：
 *
 * 1. **上游只能写死域名**：nginx OSS 的 stream 模块不支持 `proxy_pass` 里写变量 + resolver
 *    （那是 NGINX Plus 的能力）。所以 `proxy_pass` 一律是
 *    `<name>.<ns>.svc.cluster.local:<port>`。代价是「改名 / 换端口必须双写」：
 *    配置里引用了一个不存在的 Service（历史事故：`ms-reranker7`）→
 *    `[emerg] host not found in upstream` → CrashLoop → 一小时刷 5916 条 Warning。
 *    本文件把这句话写进生成配置的注释里，并在 plan 的 steps 里排成执行顺序。
 * 2. **listen 端口是独占资源**：hostNetwork 下端口属于节点，旧容器/旧进程没退干净时
 *    nginx `bind() 8007 failed (98: Address in use)`（历史事故：docker 里的旧容器占着 hostPort）。
 *    因此渲染阶段就要检测「服务之间」以及「服务 vs baseConfig 里既有 server 块」的端口冲突。
 * 3. **不能整体覆盖别人的路由**：baseConfig 里不属于 infra 管理的 server 块必须原样保留。
 *    本文件只重写自己用 `# BEGIN/END openlog-infra:gateway` 围起来的区间，
 *    并用每块的 `# openlog-service: <ns>/<name>` 标记来认领「哪些块是我上次渲染的」。
 *
 * 本模块不 import 任何会连集群的模块：client 由调用方注入（见 applyGatewayConfig）。
 * 所有错误文案中文且可操作，返回结构稳定（ok / changed / action / steps / error）。
 */

/** 生成区间的开始标记（重写边界，必须原样出现在输出里）。 */
export const REGION_BEGIN = '# BEGIN openlog-infra:gateway';

/** 生成区间的结束标记。 */
export const REGION_END = '# END openlog-infra:gateway';

/** 每个 server 块的归属标记：下次渲染靠它认出「这块是 OpenLog 写的」。 */
export const SERVICE_MARKER = 'openlog-service:';

/** 触发 nginx reload 的注解键（值必须每次不同，否则 k8s 认为 Deployment 没变化）。 */
export const RELOAD_ANNOTATION = 'openlog.io/nginx-reload';

/** 网关 Deployment 的默认名字（真实集群请用 opts.deploymentName 指定）。 */
export const DEFAULT_GATEWAY_DEPLOYMENT = 'openlog-gateway';

/** ConfigMap 里 nginx 配置的默认键名。 */
export const DEFAULT_CONFIG_KEY = 'nginx.conf';

/** baseConfig 里既有 server 块在冲突列表里的 owner 标签。 */
export const BASE_CONFIG_OWNER = 'baseConfig';

/** 合法端口区间（TCP 端口 1..65535，0 与 >65535 都不是端口）。 */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/** DNS-1123 label：小写字母 / 数字 / 连字符，首尾必须是字母或数字。 */
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** DNS-1123 subdomain：在 label 的基础上允许用点分隔（ConfigMap 名允许）。 */
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** 生成配置的抬头注释：把「为什么必须双写」「端口冲突会怎样」写在配置里，而不是只写在文档里。 */
const GATEWAY_HEADER_LINES = Object.freeze([
  '# ────────────────────────────────────────────────────────────────',
  '# OpenLog AI Infra 自动生成的网关配置（nginx stream 模块）。',
  '# 本段每次都整段重写，请勿手工编辑；需要保留的路由请写在 BEGIN / END 之外。',
  '#',
  '# 为什么「改名 / 换端口必须双写」：',
  '#   nginx OSS 的 stream 模块不支持在 proxy_pass 里写变量 + resolver（那是 NGINX Plus 的能力），',
  '#   所以上游只能写死成 <name>.<ns>.svc.cluster.local:<port>。于是：',
  '#     a) Service 改了名而本文件没跟着改 → nginx 启动即 [emerg] host not found in upstream，',
  '#        Pod CrashLoop 不断重试并持续刷 Warning（真机事故：引用了不存在的 Service ms-reranker7，',
  '#        一小时内刷了 5916 条 Warning）；',
  '#     b) listen 端口换了而旧容器还占着 → nginx bind() failed (98: Address in use)。',
  '#   所以任何改名 / 换端口都必须同时改 Service 与这份配置，并按 planGatewayUpdate 的 steps 顺序执行。',
  '#',
  '# 端口冲突：同一 listen 端口只允许一个 server 块，冲突时只保留第一个服务，其余跳过（见下方注释）。',
  '# ────────────────────────────────────────────────────────────────',
]);

/* ────────────────────────────── 小工具 ────────────────────────────── */

/** 严格的对象判断（null / 数组都不算）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 端口是否合法（整数且在 1..65535）。 */
function isValidPort(value) {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/** 是否合法 DNS-1123 label（长度单独校验，默认 63）。 */
function isValidDnsLabel(value, maxLength = 63) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && DNS1123_LABEL.test(value);
}

/** 是否合法 DNS-1123 subdomain（长度单独校验，默认 253）。 */
function isValidDnsSubdomain(value, maxLength = 253) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && DNS1123_SUBDOMAIN.test(value);
}

/** 统一抛错：带上 code，方便路由层分类成 400。 */
function gatewayError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 把任意抛出物压成一句可读文本（不引入对 errors.js 的依赖，保持本模块零依赖）。 */
function describeIoError(err) {
  const base = typeof err?.message === 'string' && err.message ? err.message : String(err ?? '未知错误');
  const status = err?.status ?? err?.statusCode ?? err?.response?.statusCode;
  const bodyText = typeof err?.body === 'string' ? err.body.trim() : '';
  let reason = '';
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed.message === 'string') reason = parsed.message;
      else reason = bodyText;
    } catch {
      reason = bodyText;
    }
  }
  const head = status ? `HTTP ${status} ${base}` : base;
  if (!reason) return head;
  const clipped = reason.slice(0, 300);
  if (head.includes(clipped)) return head;
  return `${head}｜集群返回：${clipped}`;
}

/** 404 判定（注入的 client 可能用 status / statusCode / 错误文本）。 */
function isNotFoundError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.statusCode;
  if (status === 404) return true;
  return /HTTP 404/.test(String(err?.message ?? ''));
}

/* ────────────────────────── ① 端口冲突检测 ────────────────────────── */

/**
 * 检测端口冲突：同一个 `expose.gatewayPort` 被多个服务占用。
 *
 * 为什么必须在渲染前做：nginx stream 里同一 listen 端口出现两个 server 块，
 * 启动时就是 `bind() failed (98: Address in use)`，Pod 直接 CrashLoop。
 *
 * 本函数独立可用、不抛错：非对象 / 没有 expose / gatewayPort 不是合法整数的条目一律跳过
 * （合法性校验是 `renderGatewayConfig` 的职责，本函数只负责「谁和谁抢同一个端口」）。
 *
 * @param {Array<{name?: string, namespace?: string, expose?: {gatewayPort?: number}|null}>} services
 *   服务列表（render.js 的 ModelService 形状，最少只需要 name / namespace / expose.gatewayPort）
 * @returns {Array<{port: number, owners: string[]}>} 按端口升序；没有冲突时返回 `[]`
 */
export function detectPortConflicts(services) {
  const list = Array.isArray(services) ? services : [];
  /** @type {Map<number, string[]>} */
  const byPort = new Map();

  for (const svc of list) {
    if (!isPlainObject(svc)) continue;
    const port = svc?.expose?.gatewayPort;
    if (!isValidPort(port)) continue;
    if (!byPort.has(port)) byPort.set(port, []);
    const owners = byPort.get(port);
    const name = typeof svc.name === 'string' && svc.name ? svc.name : '(未命名服务)';
    // 同名不同命名空间时用 ns/name 区分，否则保持纯服务名（与生成配置里的注释一致）
    const label = owners.includes(name) ? `${svc.namespace ?? '?'}/${name}` : name;
    owners.push(label);
  }

  return [...byPort.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort((left, right) => left[0] - right[0])
    .map(([port, owners]) => ({ port, owners }));
}

/* ───────────────────────── ② nginx 配置结构扫描 ───────────────────────── */

/** 取 `{` 前面的那个单词（server / stream / events / http …），用来判断块类型。 */
function precedingWord(text, index) {
  const head = text.slice(Math.max(0, index - 64), index);
  const match = head.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * 轻量结构扫描：配对 `{` / `}`，跳过 `#` 注释与引号内容。
 *
 * 不解析完整 nginx 语法，只回答两个问题：有哪些 `server { ... }` 块、大括号是否配平。
 *
 * @param {string} text nginx 配置文本
 * @returns {{blocks: Array<{keyword: string|null, openIdx: number, closeIdx: number, depth: number}>,
 *   openAtEnd: number, strayClose: number}}
 */
function scanNginx(text) {
  const source = typeof text === 'string' ? text : '';
  /** @type {Array<{keyword: string|null, openIdx: number}>} */
  const stack = [];
  const blocks = [];
  let strayClose = 0;
  let i = 0;
  let inComment = false;
  let quote = null;

  while (i < source.length) {
    const ch = source[i];
    if (inComment) {
      if (ch === '\n') inComment = false;
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '#') {
      inComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '{') {
      stack.push({ keyword: precedingWord(source, i), openIdx: i });
      i += 1;
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (!top) strayClose += 1;
      else blocks.push({ keyword: top.keyword, openIdx: top.openIdx, closeIdx: i, depth: stack.length });
      i += 1;
      continue;
    }
    i += 1;
  }

  blocks.sort((left, right) => left.openIdx - right.openIdx);
  return { blocks, openAtEnd: stack.length, strayClose };
}

/** 收集所有 `server { ... }` 块，并附带块体文本。 */
function collectServerBlocks(text) {
  return scanNginx(text).blocks
    .filter((block) => block.keyword === 'server')
    .map((block) => ({ ...block, body: text.slice(block.openIdx + 1, block.closeIdx) }));
}

/** 块体里所有 `listen <port>` 的端口号。 */
function listenPortsOf(body) {
  const ports = [];
  const pattern = /\blisten\s+([0-9]{1,5})\b/g;
  let match = pattern.exec(body);
  while (match) {
    ports.push(Number(match[1]));
    match = pattern.exec(body);
  }
  return ports;
}

/** 这个 server 块是不是 OpenLog 上次渲染出来的（靠块前的归属标记认领）。 */
function isOwnedBlock(text, block) {
  const lead = text.slice(Math.max(0, block.openIdx - 200), block.openIdx);
  return lead.includes(SERVICE_MARKER) || block.body.includes(SERVICE_MARKER);
}

/** 找到生成区间；没有（或只有一半）时返回 null。 */
function findRegion(text) {
  const start = text.indexOf(REGION_BEGIN);
  if (start === -1) return null;
  const endMarker = text.indexOf(REGION_END, start);
  if (endMarker === -1) return null;
  return { start, end: endMarker + REGION_END.length };
}

/* ────────────────────────── ③ 服务规范化 ────────────────────────── */

/**
 * 校验并规范化输入服务，同时算出每条路由的后端端口。
 *
 * 上游端口取 `expose.upstreamPort` > 主容器端口 `ports[0].containerPort` > gatewayPort。
 * （网关端口是对外的 listen，主容器端口是 Service 转发的目标，两者通常不同：
 * 8007 → 8000 是常态，所以不假设它们相等。）
 *
 * @param {unknown} services 原始服务数组
 * @returns {Array<{key: string, name: string, namespace: string, gatewayPort: number, backendPort: number}>}
 * @throws {Error} 输入不是数组 / 服务名或命名空间不是 DNS-1123 / 端口越界 / 重复服务名时抛中文错误
 */
function normalizeGatewayServices(services) {
  if (services === null || services === undefined) return [];
  if (!Array.isArray(services)) {
    throw gatewayError(
      `services 必须是数组（收到 ${typeof services}）：网关渲染的输入是 render.js 的 ModelService 列表，`
      + '每个元素至少要有 name / namespace / expose.gatewayPort',
      'INFRA_GATEWAY_INVALID_SERVICE',
    );
  }

  const seen = new Map();
  return services.map((svc, index) => {
    const where = `services[${index}]`;
    if (!isPlainObject(svc)) {
      throw gatewayError(`${where} 不是对象（收到 ${svc === null ? 'null' : typeof svc}）：每个服务必须是 ModelService 形状的对象`, 'INFRA_GATEWAY_INVALID_SERVICE');
    }

    const name = typeof svc.name === 'string' ? svc.name.trim() : '';
    if (!isValidDnsLabel(name)) {
      throw gatewayError(
        `${where}.name 不是合法 DNS-1123 标签：「${String(svc.name ?? '')}」。`
        + '网关上游拼的是 <name>.<ns>.svc.cluster.local，名字必须是小写字母 / 数字 / 连字符、'
        + '首尾为字母或数字、≤63 字符（大写与下划线会导致域名不可解析，nginx 启动即 host not found in upstream）',
        'INFRA_GATEWAY_INVALID_SERVICE',
      );
    }

    const namespace = typeof svc.namespace === 'string' ? svc.namespace.trim() : '';
    if (!isValidDnsLabel(namespace)) {
      throw gatewayError(
        `${where}.namespace 不是合法 DNS-1123 标签：「${String(svc.namespace ?? '')}」。`
        + '集群内域名里的命名空间段不允许大写字母和下划线',
        'INFRA_GATEWAY_INVALID_SERVICE',
      );
    }

    const key = `${namespace}/${name}`;
    if (seen.has(key)) {
      throw gatewayError(
        `services 里出现重复服务「${key}」（第 ${seen.get(key)} 与第 ${index} 项）：同一 ns/name 只能有一条网关路由，`
        + '否则会生成两个 listen 同端口的 server 块',
        'INFRA_GATEWAY_INVALID_SERVICE',
      );
    }
    seen.set(key, index);

    const expose = svc.expose;
    if (expose !== null && expose !== undefined && !isPlainObject(expose)) {
      throw gatewayError(
        `${where}.expose 必须是 { gatewayPort } 对象或 null（null 表示不注册网关，收到 ${typeof expose}）`,
        'INFRA_GATEWAY_INVALID_SERVICE',
      );
    }
    const gatewayPort = expose?.gatewayPort;
    if (gatewayPort === undefined || gatewayPort === null) {
      // 没有显式端口 → 不渲染（契约：expose.gatewayPort 存在才生成 server 块）
      return { key, name, namespace, gatewayPort: null, backendPort: null };
    }
    if (!isValidPort(gatewayPort)) {
      throw gatewayError(
        `${where}.expose.gatewayPort 必须是 ${MIN_PORT}..${MAX_PORT} 的整数（收到 ${String(gatewayPort)}）。`
        + '0 与 >65535 都不是合法 TCP 端口，nginx 会直接拒绝启动',
        'INFRA_GATEWAY_INVALID_SERVICE',
      );
    }

    const upstreamPort = expose?.upstreamPort;
    const containerPort = Array.isArray(svc.ports) ? svc.ports[0]?.containerPort : undefined;
    const backendPort = Number.isInteger(upstreamPort) ? upstreamPort : (Number.isInteger(containerPort) ? containerPort : gatewayPort);
    if (!isValidPort(backendPort)) {
      throw gatewayError(
        `${where}.expose.upstreamPort / ports[0].containerPort 必须是 ${MIN_PORT}..${MAX_PORT} 的整数（后端端口算出来是 ${String(backendPort)}）`,
        'INFRA_GATEWAY_INVALID_SERVICE',
      );
    }

    return { key, name, namespace, gatewayPort, backendPort };
  }).filter((entry) => entry.gatewayPort !== null);
}

/* ────────────────────────── ④ 渲染 ────────────────────────── */

/** 单个 server 块（含归属标记，供下次渲染认领）。 */
function renderServerBlock(svc) {
  return [
    `# ${SERVICE_MARKER} ${svc.key}`,
    'server {',
    `    listen ${svc.gatewayPort};`,
    `    proxy_pass ${svc.name}.${svc.namespace}.svc.cluster.local:${svc.backendPort};`,
    '}',
  ].join('\n');
}

/**
 * 把生成区间插入 baseConfig，同时保住别人的路由。
 *
 * 规则（顺序固定）：
 *  1. 已有 BEGIN/END 区间 → 用占位符替换掉（整段由本次渲染重写）；
 *  2. 删掉区间外残留的「我们上次渲染的块」（带归属标记），避免 listen 端口重复；
 *  3. 没有区间时：baseConfig 里有 `stream {` 就插到它的收尾大括号之前，否则追加到末尾。
 *
 * 除这三步之外，baseConfig 的原文（别人的 server 块、worker 配置、注释）一律原样保留。
 *
 * @param {string} baseText 现存 nginx 配置文本
 * @param {string} regionText 本次渲染出的区间文本
 * @returns {string} 合并后的完整配置
 */
function assembleConfig(baseText, regionText) {
  const placeholder = '#__OPENLOG_GATEWAY_REGION_PLACEHOLDER__';
  const text = typeof baseText === 'string' ? baseText : '';
  const region = findRegion(text);

  let working = text;
  if (region) {
    // 区间替换：占位符顶替「BEGIN..END」整段，之后的换行沿用原文，
    // 否则每重新渲染一次就会多出一个空行，plan 便会一直判定「有变化」而反复 reload
    working = `${working.slice(0, region.start)}${placeholder}${working.slice(region.end)}`;
  }

  // 区间外残留的自有块：用占位符保护区间本身，再按从后往前的顺序删除
  const placeholderIdx = working.indexOf(placeholder);
  const strays = collectServerBlocks(working)
    .filter((block) => isOwnedBlock(working, block))
    .filter((block) => !(placeholderIdx >= block.openIdx && placeholderIdx <= block.closeIdx + 1));
  for (const block of strays.sort((left, right) => right.openIdx - left.openIdx)) {
    // 连同块上方那行归属标记一起删掉（否则会留下孤立的 "# openlog-service: ..." 注释）
    const markerIdx = working.lastIndexOf(SERVICE_MARKER, block.openIdx);
    let cutStart = block.openIdx;
    if (markerIdx !== -1 && block.openIdx - markerIdx < 200) {
      const lineStart = working.lastIndexOf('\n', markerIdx);
      cutStart = lineStart === -1 ? 0 : lineStart;
    }
    working = `${working.slice(0, cutStart)}${working.slice(block.closeIdx + 1)}`;
  }

  if (!region) {
    const streamBlock = scanNginx(working).blocks.find((block) => block.keyword === 'stream');
    if (streamBlock) {
      const before = working.slice(0, streamBlock.closeIdx);
      const pad = before.endsWith('\n') ? '' : '\n';
      working = `${before}${pad}${placeholder}\n${working.slice(streamBlock.closeIdx)}`;
    } else {
      const pad = working === '' || working.endsWith('\n') ? '' : '\n';
      working = `${working}${pad}${placeholder}\n`;
    }
  }

  const replaced = working.replace(placeholder, regionText);
  const collapsed = replaced
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${collapsed}\n`;
}

/**
 * 渲染网关配置：`expose.gatewayPort` → 一个 stream server 块。
 *
 * 端口冲突**先于**渲染判定：冲突端口只保留第一个服务（按端口、再按 ns/name 排序确定），
 * 其余在配置里留一行中文注释「冲突，已跳过 <name>」，同时进 `conflicts` 返回给调用方。
 * baseConfig 里已有 server 块占用了同一端口时同样只报冲突、不生成重复的 listen
 * （重复 listen 就是 `bind() failed (98: Address in use)`）。
 *
 * @param {object} [params]
 * @param {Array<object>} [params.services] ModelService 列表（至少 name / namespace / expose.gatewayPort）
 * @param {string} [params.baseConfig] 现存 nginx 配置文本（片段或整份文件都行）
 * @returns {{nginxConf: string, routes: Array<{port: number, upstream: string}>,
 *   conflicts: Array<{port: number, owners: string[]}>}}
 *   `routes` 只含真正生成的端口（按端口升序，同端口按 ns/name 升序）；
 *   `conflicts` 含服务之间的冲突，以及 `owners` 里出现 `baseConfig` 的「与既有块抢端口」冲突
 * @throws {Error} 服务名 / 命名空间不是 DNS-1123、端口越界、重复服务名时抛中文错误
 *   （code = INFRA_GATEWAY_INVALID_SERVICE）
 */
export function renderGatewayConfig({ services = [], baseConfig = '' } = {}) {
  const normalized = normalizeGatewayServices(services);
  const baseText = typeof baseConfig === 'string' ? baseConfig : String(baseConfig ?? '');

  const conflicts = detectPortConflicts(Array.isArray(services) ? services : []);

  // baseConfig 里既有的（不属于我们的）server 块占用了哪些端口
  const occupied = new Map();
  for (const block of collectServerBlocks(baseText)) {
    if (isOwnedBlock(baseText, block)) continue;
    for (const port of listenPortsOf(block.body)) {
      if (!occupied.has(port)) occupied.set(port, BASE_CONFIG_OWNER);
    }
  }

  // 第一轮：按**输入顺序**决定每个端口的归属（「只保留第一个」= 用户先定义的那个），
  // 冲突的其余服务记下跳过原因，不进入 routes。
  const winners = [];
  const skipped = [];
  const used = new Map();

  for (const svc of normalized) {
    const owner = used.get(svc.gatewayPort);
    if (owner) {
      skipped.push({
        key: svc.key,
        reason: `# 冲突，已跳过 ${svc.name}（端口 ${svc.gatewayPort} 已被 ${owner} 占用；同一 listen 端口只允许一个 server 块，否则 nginx 启动即 bind() failed (98: Address in use)）`,
      });
      continue;
    }
    if (occupied.has(svc.gatewayPort)) {
      conflicts.push({ port: svc.gatewayPort, owners: [BASE_CONFIG_OWNER, svc.name] });
      skipped.push({
        key: svc.key,
        reason: `# 冲突，已跳过 ${svc.name}（端口 ${svc.gatewayPort} 已被 ${BASE_CONFIG_OWNER} 里的既有 server 块占用；请先给该块换端口，否则会重复 bind 同一个端口）`,
      });
      continue;
    }
    used.set(svc.gatewayPort, svc.name);
    winners.push(svc);
  }

  // 第二轮：输出按端口升序（同端口按 ns/name），保证两次渲染的 diff 稳定。
  winners.sort((left, right) => {
    if (left.gatewayPort !== right.gatewayPort) return left.gatewayPort - right.gatewayPort;
    if (left.key === right.key) return 0;
    return left.key < right.key ? -1 : 1;
  });
  skipped.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

  const routes = winners.map((svc) => ({
    port: svc.gatewayPort,
    upstream: `${svc.name}.${svc.namespace}.svc.cluster.local:${svc.backendPort}`,
  }));
  const chunks = [...winners.map(renderServerBlock), ...skipped.map((item) => item.reason)];

  conflicts.sort((left, right) => left.port - right.port);

  const body = chunks.length > 0
    ? chunks.join('\n\n')
    : '# （当前没有需要暴露的服务：所有定义都没有 expose.gatewayPort，或全部因冲突被跳过）';
  const regionText = [REGION_BEGIN, ...GATEWAY_HEADER_LINES, '', body, REGION_END].join('\n');

  return {
    nginxConf: assembleConfig(baseText, regionText),
    routes,
    conflicts,
  };
}

/* ────────────────────────── ⑤ diff ────────────────────────── */

/**
 * 归一化用于比较的配置文本：统一换行、去行尾空白、去首尾空行。
 *
 * 这么做的目的：CRLF / 尾随空格这类「看不出来」的差异不应该触发一次 nginx reload
 * （每次 reload 都是一次连接抖动，且写 ConfigMap 会让注解值变化）。
 *
 * @param {string} text 配置文本
 * @returns {string} 归一化后的文本
 */
export function normalizeConfigForCompare(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const lines = source.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/**
 * 逐行 LCS 差异（返回 equal / del / add 序列）。
 *
 * @param {string[]} before 旧行数组
 * @param {string[]} after 新行数组
 * @returns {Array<{type: 'equal'|'del'|'add', line: string}>}
 */
function diffLines(before, after) {
  const rows = before.length;
  const cols = after.length;
  if (rows * cols > 4_000_000) {
    // 超大配置放弃 LCS（内存优先）：退化成「整段替换」，diff 依然可读
    return [
      ...before.map((line) => ({ type: 'del', line })),
      ...after.map((line) => ({ type: 'add', line })),
    ];
  }

  const table = Array.from({ length: rows + 1 }, () => new Int32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ type: 'equal', line: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'del', line: before[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', line: after[j] });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ type: 'del', line: before[i] });
    i += 1;
  }
  while (j < cols) {
    ops.push({ type: 'add', line: after[j] });
    j += 1;
  }
  return ops;
}

/**
 * unified 风格 diff（`---` / `+++` / `@@` 头 + 上下文行）。
 *
 * @param {string} before 旧文本
 * @param {string} after 新文本
 * @param {{context?: number, labelBefore?: string, labelAfter?: string}} [options]
 * @returns {string} 无差异时返回空字符串
 */
export function renderUnifiedDiff(before, after, options = {}) {
  const context = Math.max(0, Number.isInteger(options.context) ? options.context : 3);
  const labelBefore = typeof options.labelBefore === 'string' ? options.labelBefore : 'current/nginx.conf';
  const labelAfter = typeof options.labelAfter === 'string' ? options.labelAfter : 'desired/nginx.conf';

  const oldLines = normalizeConfigForCompare(before).split('\n').filter((line, index, all) => !(all.length === 1 && line === ''));
  const newLines = normalizeConfigForCompare(after).split('\n').filter((line, index, all) => !(all.length === 1 && line === ''));
  if (oldLines.join('\n') === newLines.join('\n')) return '';

  const ops = diffLines(oldLines, newLines);
  const isChange = (op) => op.type !== 'equal';

  // 给每个 op 记上它在两侧的行号，hunk 头要用
  let oldNo = 1;
  let newNo = 1;
  const rows = ops.map((op) => {
    const row = { op, oldNo, newNo };
    if (op.type !== 'add') newNo += 1;
    if (op.type !== 'del') oldNo += 1;
    return row;
  });

  const output = [`--- ${labelBefore}`, `+++ ${labelAfter}`];
  let index = 0;
  while (index < rows.length) {
    if (!isChange(rows[index].op)) {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    while (end < rows.length) {
      if (isChange(rows[end].op)) {
        end += 1;
        continue;
      }
      let next = end;
      while (next < rows.length && !isChange(rows[next].op)) next += 1;
      if (next >= rows.length) break;
      end = next;
    }
    const tail = Math.min(rows.length, end + context);
    const slice = rows.slice(start, tail);

    const oldStart = slice[0].oldNo;
    const newStart = slice[0].newNo;
    const oldCount = slice.filter((row) => row.op.type !== 'add').length;
    const newCount = slice.filter((row) => row.op.type !== 'del').length;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const row of slice) {
      const prefix = row.op.type === 'add' ? '+' : (row.op.type === 'del' ? '-' : ' ');
      output.push(`${prefix}${row.op.line}`);
    }
    index = tail;
  }

  return output.join('\n');
}

/* ────────────────────────── ⑥ 增量计划 ────────────────────────── */

/** 把 configMapName / deploymentName 这类占位符在提示里显式留出来，避免被当成真实名字。 */
function buildUpdateSteps({ changed, conflicts, routes }) {
  if (!changed) {
    return [
      '配置无实质变化：跳过 ConfigMap 写入与 reload（幂等路径，不会产生任何集群写入）',
      '如需强制让 nginx 重新加载，请手工给 Deployment 打一个新的 openlog.io/nginx-reload 注解值（例如当前时间戳）',
    ];
  }

  const warnings = [];
  if (conflicts.length > 0) {
    const detail = conflicts.map((item) => `端口 ${item.port} ← ${item.owners.join(' / ')}`).join('；');
    warnings.push(
      `⚠ 存在 ${conflicts.length} 处端口冲突（${detail}）：冲突端口只保留第一个服务，其余必须在定义里换端口后重新渲染。`
      + '带着冲突写入，nginx 会因为重复 listen 直接 bind() failed (98: Address in use)',
    );
  }

  const upstreams = routes.map((route) => route.upstream);
  const names = upstreams.length > 0 ? upstreams.slice(0, 5).join('、') + (upstreams.length > 5 ? ` 等 ${upstreams.length} 条` : '') : '（本次没有任何路由）';

  const steps = [
    `预检上游：确认这 ${routes.length} 条 Service 都已存在且可解析 —— ${names}。`
    + 'nginx 启动时解析不到就会 [emerg] host not found in upstream 并进入 CrashLoop（真机踩过：ms-reranker7 导致一小时 5916 条 Warning）',
    '预检端口：在网关所在节点确认要 listen 的端口没有被旧容器 / 旧进程占用（ss -ltnp 或 docker ps 对照），否则 bind() failed (98: Address in use)',
    '备份现状：kubectl -n <ns> get cm <configMapName> -o yaml > nginx-conf.backup.yaml（本函数的 diff 就是回滚依据）',
    '写入 ConfigMap：调用 applyGatewayConfig({ client, namespace, configMapName, nginxConf }) 走 merge-patch 更新 data 键',
    '触发 reload：给网关 Deployment 打 openlog.io/nginx-reload=<新时间戳> 注解（应用内部完成，注解值每次必须不同）',
    '观察：kubectl -n <ns> rollout status deployment/<gatewayDeployment>；日志里出现 [emerg] 说明配置有问题，按第 3 步回滚',
    '验证：上游 Pod 就绪后，对每个 listen 端口做一次 TCP 连通性检查（就绪前连接失败属正常）',
    '回滚：把备份写回 ConfigMap，并再打一次 reload 注解。注意改名 / 换端口必须与 Service 双写，因为 nginx stream 不支持变量 + resolver',
  ].map((text, index) => `${index + 1}. ${text}`);

  return [...warnings, ...steps];
}

/**
 * 生成增量计划：现存 nginx.conf → 期望 nginx.conf。
 *
 * 判定「有没有变化」用的是归一化文本（换行符、行尾空白、首尾空行不算差异），
 * 因此重复调用同一份渲染结果不会反复触发 reload（幂等）。
 *
 * @param {object} params
 * @param {{nginxConf: string, routes?: object[], conflicts?: object[]}|string} params.desired
 *   `renderGatewayConfig()` 的返回值，或直接给 nginx.conf 文本
 * @param {string} params.current 现存 nginx.conf 文本（ConfigMap 里的 data 值；不存在时传空串）
 * @returns {{changed: boolean, diff: string, conflicts: Array<{port: number, owners: string[]}>, steps: string[]}}
 *   `changed=false` 时 `diff` 为空串；`steps` 永远是中文、可直接展示给人看的操作序列
 * @throws {Error} desired 为空或不是文本时抛中文错误（code = INFRA_GATEWAY_INVALID_PLAN）
 */
export function planGatewayUpdate({ desired, current } = {}) {
  const desiredConf = typeof desired === 'string' ? desired : desired?.nginxConf;
  if (typeof desiredConf !== 'string' || desiredConf.trim() === '') {
    throw gatewayError(
      'planGatewayUpdate 需要 desired：请先调用 renderGatewayConfig({ services, baseConfig }) 并把它的返回值（或 nginxConf 文本）传进来；'
      + `当前收到的是 ${desired === null ? 'null' : typeof desired}`,
      'INFRA_GATEWAY_INVALID_PLAN',
    );
  }

  const currentText = current === null || current === undefined ? '' : String(current);
  const before = normalizeConfigForCompare(currentText);
  const after = normalizeConfigForCompare(desiredConf);
  const changed = before !== after;

  const conflicts = Array.isArray(desired?.conflicts)
    ? desired.conflicts
      .filter((item) => isPlainObject(item) && Number.isInteger(item.port))
      .map((item) => ({ port: item.port, owners: Array.isArray(item.owners) ? [...item.owners] : [] }))
      .sort((left, right) => left.port - right.port)
    : [];
  const routes = Array.isArray(desired?.routes) ? desired.routes : [];

  return {
    changed,
    diff: changed ? renderUnifiedDiff(before, after) : '',
    conflicts,
    steps: buildUpdateSteps({ changed, conflicts, routes }),
  };
}

/* ────────────────────────── ⑦ 写入 ────────────────────────── */

/**
 * 轻量自检：写进 ConfigMap 之前就能发现「这份配置一定起不来」的问题。
 *
 * 检查项：非空、大括号配平、`listen` 端口区间、`proxy_pass` 上游是不是合法 DNS 名。
 * 上游名带大写或下划线是最典型的隐形炸弹：k8s 域名解析不到，nginx 直接 [emerg]。
 *
 * @param {string} text nginx 配置文本
 * @returns {{ok: boolean, errors: string[], warnings: string[]}} errors 非空时不要写入
 */
export function lintNginxConf(text) {
  const errors = [];
  const warnings = [];
  const source = typeof text === 'string' ? text : '';

  if (source.trim() === '') {
    errors.push('nginx.conf 为空：至少需要一段 server { listen <port>; proxy_pass <upstream>; }（或明确说明本段无路由的注释）');
    return { ok: false, errors, warnings };
  }

  const scan = scanNginx(source);
  if (scan.openAtEnd > 0) errors.push(`大括号不匹配：还有 ${scan.openAtEnd} 个 "{" 没有闭合，写进 ConfigMap 后 nginx 会直接 [emerg] 退出`);
  if (scan.strayClose > 0) errors.push(`大括号不匹配：多出 ${scan.strayClose} 个 "}"，写进 ConfigMap 后 nginx 会直接 [emerg] 退出`);

  // 区间标记必须成对且只有一段：少了 END 会让下一次渲染再追加一段（重复 listen → 起不来），
  // 多了 BEGIN 说明上一次合并出了岔子，写进去等于把同一端口 bind 两次。
  const begins = source.split(REGION_BEGIN).length - 1;
  const ends = source.split(REGION_END).length - 1;
  if (begins !== ends) {
    errors.push(
      `生成区间标记不成对（${REGION_BEGIN} × ${begins}，${REGION_END} × ${ends}）：`
      + '请手工补齐或两条都删掉再重新渲染，否则下次渲染会追加出第二段配置、重复 bind 同一端口',
    );
  }
  if (begins > 1) {
    errors.push(`检测到 ${begins} 段生成区间（${REGION_BEGIN}）：只能有一段，重复的 server 块会让 nginx bind() failed (98: Address in use)`);
  }

  const servers = collectServerBlocks(source);
  if (servers.length === 0) warnings.push('配置里没有任何 server 块：网关将不转发任何端口（如果这是有意的，请忽略）');

  for (const block of servers) {
    for (const port of listenPortsOf(block.body)) {
      if (!isValidPort(port)) errors.push(`listen ${port} 不是合法端口：必须落在 ${MIN_PORT}..${MAX_PORT}`);
    }
  }

  const upstreamPattern = /proxy_pass\s+([^\s;]+)/g;
  let match = upstreamPattern.exec(source);
  while (match) {
    const target = match[1];
    const host = target.split(':')[0];
    if (host) {
      const badCase = /[A-Z]/.test(host);
      const badChar = host.includes('_');
      if (badCase || badChar) {
        errors.push(
          `上游 ${host} 不是合法 DNS 名称（${badCase ? '含大写字母' : '含下划线'}）：`
          + 'Kubernetes Service 域名必须是小写 DNS-1123，否则 nginx 启动时 host not found in upstream',
        );
      }
    }
    match = upstreamPattern.exec(source);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** reload 注解的值：显式传入 > 注入时钟 > 当前时间。 */
function resolveReloadStamp(options) {
  if (typeof options.reloadStamp === 'string' && options.reloadStamp.trim() !== '') return options.reloadStamp.trim();
  const raw = typeof options.now === 'function' ? options.now() : Date.now();
  const date = raw instanceof Date ? raw : new Date(Number(raw));
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

/**
 * 把 nginx 配置落到 ConfigMap，并触发网关 reload。
 *
 * 状态机（顺序固定）：
 *
 *   参数校验 ──失败──▶ rejected（零 API 调用）
 *     ▼
 *   开关校验（OPENLOG_K8S_INFRA=1） ──未启用──▶ rejected
 *     ▼
 *   GET ConfigMap ──404──▶ 走创建（postJson）
 *     │           ──其它错误──▶ 失败：未写入任何配置，线上仍运行旧配置
 *     ▼
 *   比对（归一化文本） ──相同──▶ { ok:true, changed:false }（幂等，零写入）
 *     ▼
 *   PATCH/POST ConfigMap ──失败──▶ 失败：网关配置未变更，线上仍运行旧配置
 *     ▼
 *   PATCH Deployment 注解 openlog.io/nginx-reload=<ISO 时间>
 *        └─失败──▶ ok:false + changed:true：ConfigMap 已写但没 reload，给出 rollout restart 的补救命令
 *
 * @param {object} params
 * @param {{getJson: Function, patchJson?: Function, postJson?: Function}} params.client
 *   注入的 k8s 客户端（见 server/k8s/client.js）；本模块自己不连集群
 * @param {string} params.namespace 网关所在命名空间（DNS-1123 label）
 * @param {string} params.configMapName 网关 ConfigMap 名（DNS-1123 subdomain）
 * @param {string} params.nginxConf 渲染好的完整 nginx.conf
 * @param {object} [params.opts]
 * @param {string} [params.opts.dataKey='nginx.conf'] ConfigMap 里的键名
 * @param {string} [params.opts.deploymentName='openlog-gateway'] 网关 Deployment 名（真实的请务必传）
 * @param {boolean} [params.opts.skipReload=false] 只写 ConfigMap，不触发 reload
 * @param {string} [params.opts.reloadStamp] 指定注解值（测试/重放用）
 * @param {() => number|Date} [params.opts.now] 毫秒时钟或 Date 供应器（测试注入，默认 Date.now）
 * @param {object} [params.opts.env] 环境变量表（默认 process.env，用来校验 OPENLOG_K8S_INFRA）
 * @returns {Promise<{ok: boolean, changed: boolean, action: 'noop'|'patched'|'created'|'rejected'|'configmap-written',
 *   steps: Array<{name: string, ok: boolean, detail: string}>, error?: string,
 *   configMapPath?: string, deploymentPath?: string, reloadAnnotation?: string|null}>}
 */
export async function applyGatewayConfig({ client, namespace, configMapName, nginxConf, opts = {} } = {}) {
  const options = isPlainObject(opts) ? opts : {};
  const steps = [];
  const dataKey = typeof options.dataKey === 'string' && options.dataKey.trim() !== '' ? options.dataKey.trim() : DEFAULT_CONFIG_KEY;
  const deploymentName = typeof options.deploymentName === 'string' && options.deploymentName.trim() !== ''
    ? options.deploymentName.trim()
    : DEFAULT_GATEWAY_DEPLOYMENT;

  const rejected = (error) => ({ ok: false, changed: false, action: 'rejected', steps, error });

  // ① 开关：写操作默认关闭（与 apply.js 一致，正交于 OPENLOG_K8S_WRITE）
  const env = options.env ?? process.env;
  if (String(env?.OPENLOG_K8S_INFRA ?? '') !== '1') {
    return rejected('AI Infra 变更能力未启用：请设置 OPENLOG_K8S_INFRA=1 后重启服务；本次未写入任何内容，网关仍运行旧配置');
  }

  // ② 参数校验（本地就能判死的错误，不要用一次集群往返来发现）
  const ns = typeof namespace === 'string' ? namespace.trim() : '';
  if (!isValidDnsLabel(ns)) {
    return rejected(`namespace 不合法：「${String(namespace ?? '')}」不是 DNS-1123 标签（小写字母 / 数字 / 连字符，≤63）。网关配置未变更`);
  }
  const cmName = typeof configMapName === 'string' ? configMapName.trim() : '';
  if (!isValidDnsSubdomain(cmName)) {
    return rejected(`configMapName 不合法：「${String(configMapName ?? '')}」不是 DNS 名称（小写字母 / 数字 / 连字符 / 点，≤253）。网关配置未变更`);
  }
  const lint = lintNginxConf(nginxConf);
  if (!lint.ok) {
    return rejected(`nginx.conf 自检未通过，已拒绝写入：${lint.errors.join('；')}`);
  }
  for (const warning of lint.warnings) steps.push({ name: '自检', ok: true, detail: warning });

  if (!client || typeof client.getJson !== 'function') {
    return rejected(`注入的 Kubernetes 客户端缺少 getJson：无法读取 ConfigMap ${ns}/${cmName}，未写入任何内容，网关仍运行旧配置`);
  }

  // ③ 读现状
  const cmPath = `/api/v1/namespaces/${ns}/configmaps/${cmName}`;
  let current = null;
  try {
    const read = await client.getJson(cmPath);
    current = isPlainObject(read) ? read : null;
    steps.push({
      name: '读取 ConfigMap',
      ok: true,
      detail: current ? `已读取 ${ns}/${cmName}` : `集群返回空对象，按「不存在」处理：${ns}/${cmName}`,
    });
  } catch (err) {
    if (isNotFoundError(err)) {
      steps.push({ name: '读取 ConfigMap', ok: true, detail: `${ns}/${cmName} 不存在（HTTP 404），将新建` });
    } else {
      steps.push({ name: '读取 ConfigMap', ok: false, detail: describeIoError(err) });
      return rejected(`读取 ConfigMap ${ns}/${cmName} 失败：${describeIoError(err)}；未写入任何配置，线上仍运行旧配置`);
    }
  }

  // ④ 比对（幂等：同样的配置不写、不 reload）
  const currentConf = typeof current?.data?.[dataKey] === 'string' ? current.data[dataKey] : '';
  if (current && normalizeConfigForCompare(currentConf) === normalizeConfigForCompare(nginxConf)) {
    steps.push({ name: '比对配置', ok: true, detail: `data.${dataKey} 与期望一致（归一化后无差异），跳过写入与 reload` });
    return { ok: true, changed: false, action: 'noop', steps, configMapPath: cmPath, reloadAnnotation: null };
  }

  // ⑤ 写 ConfigMap
  const isCreate = !current;
  const writer = isCreate ? 'postJson' : 'patchJson';
  if (typeof client[writer] !== 'function') {
    return rejected(
      `注入的 Kubernetes 客户端缺少 ${writer}：无法${isCreate ? '创建' : '更新'} ConfigMap ${ns}/${cmName}（需要可写客户端）。`
      + '未写入任何内容，网关仍运行旧配置',
    );
  }
  try {
    if (isCreate) {
      await client.postJson(
        `/api/v1/namespaces/${ns}/configmaps?fieldManager=openlog-infra`,
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: cmName, namespace: ns },
          data: { [dataKey]: nginxConf },
        },
        { contentType: 'application/json' },
      );
    } else {
      await client.patchJson(
        `${cmPath}?fieldManager=openlog-infra`,
        { data: { [dataKey]: nginxConf } },
        { contentType: 'application/merge-patch+json' },
      );
    }
    steps.push({
      name: isCreate ? '创建 ConfigMap' : '写入 ConfigMap',
      ok: true,
      detail: `${isCreate ? '已创建' : '已更新'} ${ns}/${cmName} 的 data.${dataKey}（${normalizeConfigForCompare(nginxConf).split('\n').length} 行）`,
    });
  } catch (err) {
    steps.push({ name: '写入 ConfigMap', ok: false, detail: describeIoError(err) });
    return rejected(`ConfigMap 写入失败：${describeIoError(err)}；网关配置未变更，线上仍运行旧配置`);
  }

  // ⑥ 触发 reload
  if (options.skipReload === true) {
    steps.push({ name: '触发 reload', ok: true, detail: '已按 opts.skipReload 跳过 Deployment 注解：ConfigMap 已更新，但 nginx 尚未 reload' });
    return {
      ok: true,
      changed: true,
      action: isCreate ? 'created' : 'patched',
      steps,
      configMapPath: cmPath,
      reloadAnnotation: null,
    };
  }

  const stamp = resolveReloadStamp(options);
  const depPath = `/apis/apps/v1/namespaces/${ns}/deployments/${deploymentName}`;
  if (typeof client.patchJson !== 'function') {
    steps.push({ name: '触发 reload', ok: false, detail: '客户端缺少 patchJson' });
    return {
      ok: false,
      changed: true,
      action: 'configmap-written',
      steps,
      configMapPath: cmPath,
      error: `ConfigMap 已写入（${ns}/${cmName}），但客户端缺少 patchJson，无法给 Deployment ${ns}/${deploymentName} 打 reload 注解；`
        + `请手工执行 kubectl -n ${ns} rollout restart deployment/${deploymentName}，否则线上仍运行旧配置`,
    };
  }
  try {
    await client.patchJson(
      depPath,
      { metadata: { annotations: { [RELOAD_ANNOTATION]: stamp } } },
      { contentType: 'application/merge-patch+json' },
    );
    steps.push({ name: '触发 reload', ok: true, detail: `已给 ${ns}/${deploymentName} 打 ${RELOAD_ANNOTATION}=${stamp}，nginx 将重新加载配置` });
  } catch (err) {
    steps.push({ name: '触发 reload', ok: false, detail: describeIoError(err) });
    return {
      ok: false,
      changed: true,
      action: 'configmap-written',
      steps,
      configMapPath: cmPath,
      error: `ConfigMap 已写入（${ns}/${cmName}），但给 Deployment ${ns}/${deploymentName} 打 reload 注解失败：${describeIoError(err)}；`
        + `请手工执行 kubectl -n ${ns} rollout restart deployment/${deploymentName}，否则线上仍运行旧配置`,
    };
  }

  return {
    ok: true,
    changed: true,
    action: isCreate ? 'created' : 'patched',
    steps,
    configMapPath: cmPath,
    deploymentPath: depPath,
    reloadAnnotation: stamp,
  };
}

export default {
  renderGatewayConfig,
  planGatewayUpdate,
  applyGatewayConfig,
  detectPortConflicts,
  lintNginxConf,
  renderUnifiedDiff,
  normalizeConfigForCompare,
};
