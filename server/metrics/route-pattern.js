/**
 * 接口指标的路由模板归一化 —— 指标表的「命门」。
 *
 * 为什么需要这一层：Express 的 `req.path` 是**真实 URL**，里面带着 uuid、容器 id、
 * 数字主键、域名。若直接拿它当 api_metrics_minute.route，每来一个不同的 id 就是一条
 * 新路由，一分钟几百条，表会被撑爆、聚合查询直接失去意义。
 * 所以入口处先把动态段替换成 `:id` / `:sourceId` / `:containerId` 这类模板占位符，
 * 保证「同一路由的无限多条真实路径」最终塌缩成 1 条模板。
 *
 * 设计原则：
 * 1. 纯函数，无 IO、无依赖、不抛异常（脏输入返回 '/'，绝不因为一条奇怪路径让埋点炸掉）。
 * 2. 未知段默认**保留原文**（宁可多条，不可把语义段 `history` / `files` 揉成一个桶）。
 * 3. 已知前缀按位置命名标签（`:sourceId` / `:containerId`），只是为了让看板可读，
 *    与「低基数」目标无关。
 *
 * 契约：docs/monitoring-contract.md 4.1。
 */

/** 单个路由模板的最大长度；超长路径（攻击/异常输入）会污染主键并浪费存储 */
const MAX_ROUTE_LEN = 200;
/** 截断标记；保留固定后缀以便看板能识别出「这条是异常长路径」 */
const TRUNCATED_SUFFIX = '/__truncated__';

/**
 * 基数上限保护值：registry 侧超过这个数量就把新路由归到 `OTHER_ROUTE`。
 * @type {number}
 */
export const MAX_ROUTES = 300;

/** 溢出兜底路由：registry 超过 MAX_ROUTES 后所有新路由都记到这里 */
export const OTHER_ROUTE = '/__other__';

/* ------------------------------ 形态识别正则 ------------------------------ */

/** 标准 UUID v1-v5（8-4-4-4-12） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 24 位以上纯 hex：md5/sha 摘要、完整容器 id（契约要求 ≥24） */
const HEX_LONG_RE = /^[0-9a-f]{24,}$/i;
/**
 * 12-23 位纯 hex：docker 短 id（`4b53b00c8d2f`）就长这样，比契约的 24 位更短。
 * 这类段在真实流量里基数同样无界，必须一起归一，否则短 id 会把表撕开。
 */
const HEX_SHORT_RE = /^[0-9a-f]{12,23}$/i;
/** 纯数字主键（1-20 位；超过 20 位按长随机串处理，避免误吞大数语义） */
const DIGITS_RE = /^\d{1,20}$/;
/** IPv4（`203.0.113.10`） */
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
/** 域名形态：标签 + 至少一个点，末段是字母 TLD（`example.com` / `node-1.lan`） */
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,62}(?:\.[a-z0-9-]{1,62})*\.[a-z]{2,24}$/i;

/**
 * 已知语义词：出现在特化位置上（如 `/api/remote/servers/stats`）时**不能**被当成动态 id，
 * 否则 `stats` 会和 `/<uuid>` 撞进同一个模板，丢掉真实路由的身份。
 */
const RESERVED_SEGMENTS = new Set([
  'stats', 'batch', 'import', 'export', 'test', 'ping', 'connect', 'disconnect',
  'local', 'all', 'unknown', 'configs', 'settings', 'history', 'files', 'file',
  'logs', 'upload', 'chunk', 'complete', 'cancel', 'init', 'read', 'write', 'op',
]);

/** `/api/docker/<x>/...` 里 `<x>` 若是这些词，说明它不是 sourceId 而是功能前缀 */
const DOCKER_RESERVED_SECOND = new Set([
  'containers', 'container', 'ping', 'logs', 'analyze', 'health-check',
  'patrol', 'trace', 'configs', 'stats',
]);

/** 长串里出现这些词就认为它有语义，不该当随机 id（`/api/report/download` 之类） */
const SEMANTIC_HINT_RE =
  /(api|uuid|index|history|files?|logs?|upload|download|export|import|report|config|settings|session|token|backup|chunk|part|stream|content|static|assets|public|private|default|template|analyze|diagnose|health|monitor)/i;

/* ------------------------------ 小工具 ------------------------------ */

/** 是否是 uuid */
function isUuid(seg) {
  return UUID_RE.test(seg);
}

/** 是否是 hex 摘要 / 容器 id（长 hex 或 docker 短 id） */
function isHexId(seg) {
  return HEX_LONG_RE.test(seg) || HEX_SHORT_RE.test(seg);
}

/** 是否是域名 / IP 形态 */
function isHostLike(seg) {
  return IPV4_RE.test(seg) || DOMAIN_RE.test(seg);
}

/**
 * 长度 > 40 且随机度高的段判定。
 * 为什么要单独一条：哈希、base64、nanoid 这类 token 没有明显特征，只能靠「长 + 字符混杂」识别。
 */
function isLongRandom(seg) {
  if (seg.length <= 40) return false;
  // 含非 ASCII（中文段、emoji）说明是业务语义，保留
  if (/[^\x20-\x7e]/.test(seg)) return false;
  const hasDigit = /\d/.test(seg);
  const hasAlpha = /[a-z]/i.test(seg);
  if (hasDigit && hasAlpha) return !SEMANTIC_HINT_RE.test(seg);
  if (!hasAlpha) return false;
  // 纯字母超长串：字符区分度高且没有成对元音，才像随机串（否则是人写的词句）
  return new Set(seg).size > seg.length * 0.5 && !/[aeiou]{2}/i.test(seg);
}

/* ------------------------------ 已知前缀特化 ------------------------------ */

/**
 * 按位置给动态段命名。返回稀疏数组：非 null 表示「这一位强制用这个标签」。
 * @param {string[]} parts 去掉首尾空段后的路径段
 * @returns {Array<string|null>}
 */
function specialize(parts) {
  const out = new Array(parts.length).fill(null);
  const at = (i) => (i < parts.length ? parts[i] : undefined);

  if (at(0) === 'api' && at(1) === 'docker') {
    const second = at(2);
    if (second === 'containers' || second === 'container') {
      // /api/docker/containers/<src>/<id>/...  —— contract 4.1 明确要求这两个位置；
      // 这里连 `local` 也一起换成 :sourceId（契约示例就是这么写的）。
      if (parts.length > 3) out[3] = ':sourceId';
      if (parts.length > 4) out[4] = ':containerId';
    } else if (second === 'trace') {
      // /api/docker/trace/<src>/<id>
      if (parts.length > 3) out[3] = ':sourceId';
      if (parts.length > 4) out[4] = ':containerId';
    } else if (second && !DOCKER_RESERVED_SECOND.has(second)) {
      // /api/docker/<src>/<id>/<op>（start/stop/exec/:op ...）
      if (parts.length > 3) out[2] = ':sourceId';
      if (parts.length > 4) out[3] = ':containerId';
    }
  } else if (at(0) === 'api' && at(1) === 'remote' && at(2) === 'servers') {
    const v = at(3);
    // /api/remote/servers/<id>/...  —— 第 4 段是服务器标识
    if (v && !RESERVED_SEGMENTS.has(v)) out[3] = isHostLike(v) ? ':host' : ':id';
  } else if (at(0) === 'ws' && at(1) === 'docker' && at(2) === 'logs') {
    // /ws/docker/logs/<src>/<id> —— websocket 实时日志流
    if (parts.length > 3) out[3] = ':sourceId';
    if (parts.length > 4) out[4] = ':containerId';
  } else if (at(0) === 'ws' && (at(1) === 'shell' || at(1) === 'aishell')) {
    // /ws/shell/<serverId>、/ws/aishell/<serverId>
    if (parts.length > 2) out[2] = ':id';
  }
  return out;
}

/** 通用逐段分类：没有特化命中的段走这里 */
function classify(parts, i) {
  const seg = parts[i];
  if (isUuid(seg) || isHexId(seg) || DIGITS_RE.test(seg)) return ':id';
  if (isHostLike(seg)) {
    // 紧跟 `servers` 的域名/IP 是可读的主机标识，用 :host；其它位置的 `a.b` 一律 :id
    return parts[i - 1] === 'servers' ? ':host' : ':id';
  }
  if (isLongRandom(seg)) return ':id';
  return seg;
}

/* ------------------------------ 对外导出 ------------------------------ */

/**
 * 把真实请求路径归一化成路由模板，用于把无界基数的指标压成有界集合。
 * 先丢弃 query string 与 fragment（里面有 token，绝不能进指标表），再逐段归一。
 * @param {string} path 真实请求路径，例如 `/api/remote/servers/<uuid>/files?token=x`
 * @returns {string} 模板，例如 `/api/remote/servers/:id/files`
 */
export function normalizeRoutePath(path) {
  if (typeof path !== 'string' || path === '') return '/';

  // query 与 fragment 直接砍掉：`?token=secret` 这类内容既不该进主键也不该被存下来
  let p = path;
  const hashAt = p.indexOf('#');
  if (hashAt !== -1) p = p.slice(0, hashAt);
  const queryAt = p.indexOf('?');
  if (queryAt !== -1) p = p.slice(0, queryAt);
  if (p === '') return '/';

  // 去尾部斜杠；`///` 这类异常输入归一成根路径
  p = p.replace(/\/+$/, '');
  if (p === '') return '/';

  // 段内空串（`/api//docker`）直接丢掉，避免模板里出现 `//`
  const parts = p.split('/').filter((s) => s !== '');
  if (parts.length === 0) return '/';

  const forced = specialize(parts);
  const labels = parts.map((seg, i) => (forced[i] !== null ? forced[i] : classify(parts, i)));
  let result = `/${labels.join('/')}`;

  // 超长模板会明显拖垮主键与看板；截断在最后一个 '/' 边界上，避免留下半个段名
  if (result.length > MAX_ROUTE_LEN) {
    let cut = result.slice(0, MAX_ROUTE_LEN);
    const lastSlash = cut.lastIndexOf('/');
    if (lastSlash > 0) cut = cut.slice(0, lastSlash);
    result = cut + TRUNCATED_SUFFIX;
  }
  return result;
}

/** 需要跳过的静态资源后缀（含契约列表的超集，字体/图片一并排除） */
const SKIP_EXT_RE =
  /\.(?:js|mjs|cjs|css|map|png|svg|ico|woff2?|ttf|eot|jpe?g|gif|webp|webmanifest)$/i;

/**
 * 是否应该跳过该路径（不进接口指标）。
 * 为什么：前端 SPA 路由、打包产物、favicon、HMR 通道都打到同一个 Node 服务上，
 * 它们没有接口语义，混进来只会把「接口监控」变成「静态文件监控」。
 * @param {string} path 原始请求路径
 * @returns {boolean} true 表示跳过
 */
export function shouldSkipPath(path) {
  if (typeof path !== 'string' || path === '') return true;

  let p = path;
  const hashAt = p.indexOf('#');
  if (hashAt !== -1) p = p.slice(0, hashAt);
  const queryAt = p.indexOf('?');
  if (queryAt !== -1) p = p.slice(0, queryAt);
  if (p === '') return true;

  const lower = p.toLowerCase();

  if (lower.startsWith('/favicon')) return true;      // 浏览器自动请求，无信息量
  if (lower.startsWith('/__vite')) return true;       // Vite HMR / 预构建产物
  if (lower.startsWith('/assets/') || lower.includes('/assets/')) return true;
  if (lower.startsWith('/static/') || lower.includes('/static/')) return true;
  if (SKIP_EXT_RE.test(lower)) return true;

  // 只监控接口与 websocket：`/docker`、`/settings` 这些是前端路由，不是接口
  const isApi = lower === '/api' || lower.startsWith('/api/');
  const isWs = lower === '/ws' || lower.startsWith('/ws/');
  return !(isApi || isWs);
}
