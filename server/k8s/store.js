/**
 * k8s/store.js —— Kubernetes 集群配置的内存操作层（A4）。
 *
 * 职责边界（见 /tmp/k8s-contract.md）：
 *   - 只做纯逻辑：不联网、不读写文件、不依赖 A1 的 kubeconfig 解析器；
 *   - settings 由调用方（server/routes/k8s.js）传入，本模块只返回**新的** settings
 *     对象，绝不原地修改入参 —— 谁持久化、何时持久化由路由层决定；
 *   - kubeconfig 是敏感字段：任何对外返回（K8sClusterView）都不含明文。
 *
 * 关于 kubeconfig 解析：真正的多 cluster / 多 context 解析归 A1（server/k8s/kubeconfig.js）。
 * 这里为了不给 A1 制造启动顺序依赖，只用轻量正则从文本里提取 `server:`、
 * `current-context:` 以及判断认证方式；解析失败一律降级（server: ''、authType: 'token'），
 * 绝不抛异常 —— 列表接口不能因为一条坏配置就整体 500。
 *
 * 数据形状：
 *   K8sClusterConfig = { id, name, kubeconfig, context?, enabled, updatedAt? }
 *   K8sClusterView   = { id, name, context, server, enabled, authType, hasKubeconfig, updatedAt? }
 */

import { randomUUID } from 'node:crypto';

/** settings 里存放集群数组的字段名（与数据契约一致，不得改） */
export const K8S_CLUSTERS_KEY = 'k8sClusters';

/** 认证方式枚举值 */
const AUTH_CERT = 'cert';
const AUTH_TOKEN = 'token';

/** 空配置的兜底错误文案 */
const EMPTY_KUBECONFIG_ERROR = 'kubeconfig 不能为空';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只保留字符串，其它类型（undefined/null/数字/对象）一律视作空串。 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/** 取出 settings 里的集群数组；不存在或类型不对时给空数组，绝不抛。 */
function readRecords(settings) {
  const source = isPlainObject(settings) ? settings[K8S_CLUSTERS_KEY] : undefined;
  if (!Array.isArray(source)) return [];
  return source.filter(isPlainObject);
}

/**
 * 从文本里按 key 取值，同时兼容两种写法：
 *   YAML：`server: https://127.0.0.1:6443`
 *   JSON：`"server": "https://127.0.0.1:6443"`
 * 返回去掉首尾引号的值；取不到返回 ''。
 */
function pickValue(text, key) {
  if (typeof text !== 'string' || text === '') return '';

  // JSON 形式（kubeconfig 以 `{` 开头时 A1 会走 JSON.parse，这里也要能认）
  const jsonRe = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const jsonHit = text.match(jsonRe);
  if (jsonHit) return jsonHit[1].replace(/\\(.)/g, '$1').trim();

  // YAML 形式：行首（允许 `- ` 列表项前缀）的 `key: value`
  const yamlRe = new RegExp(`^[ \\t]*(?:-[ \\t]+)?${key}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, 'm');
  const yamlHit = text.match(yamlRe);
  if (!yamlHit) return '';

  let value = yamlHit[1].trim();
  // 去掉行尾注释与包裹引号
  const commentAt = value.search(/\s#/);
  if (commentAt >= 0) value = value.slice(0, commentAt).trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/**
 * 轻量解析 kubeconfig 摘要：只取 server、context、authType。
 * 永不抛异常；坏配置降级为 `{ server: '', context: '', authType: 'token' }`。
 */
function summarizeKubeconfig(text) {
  const fallback = { server: '', context: '', authType: AUTH_TOKEN };
  if (typeof text !== 'string' || text.trim() === '') return fallback;

  try {
    const server = pickValue(text, 'server');
    const context = pickValue(text, 'current-context');
    // 有客户端证书就是 mTLS（cert），否则按 token（SA token / bearer）处理
    const authType = /client-certificate-data\s*:|"client-certificate-data"\s*:/.test(text)
      ? AUTH_CERT
      : AUTH_TOKEN;
    return { server, context, authType };
  } catch {
    return fallback;
  }
}

/**
 * 把持久化的 record 转成对外视图（K8sClusterView），**不含 kubeconfig 明文**。
 * @param {object} record
 * @returns {{id:string,name:string,context:string,server:string,enabled:boolean,authType:'cert'|'token',hasKubeconfig:boolean,updatedAt?:string}}
 */
export function toView(record) {
  const rec = isPlainObject(record) ? record : {};
  const kubeconfig = str(rec.kubeconfig);
  const summary = summarizeKubeconfig(kubeconfig);

  // 显式指定的 context 优先；否则用 current-context；都没有就空串
  const explicitContext = str(rec.context).trim();
  const context = explicitContext || summary.context;

  const view = {
    id: str(rec.id),
    name: str(rec.name),
    context,
    server: summary.server,
    enabled: rec.enabled !== false,
    authType: summary.authType,
    hasKubeconfig: kubeconfig.trim() !== '',
  };
  const updatedAt = str(rec.updatedAt);
  if (updatedAt) view.updatedAt = updatedAt;
  return view;
}

/**
 * 列出所有集群视图。**不返回 kubeconfig 明文**。
 * @param {object} settings
 */
export function listClusters(settings) {
  return readRecords(settings).map(toView);
}

/**
 * 按 id 取原始 record（含 kubeconfig 明文，仅供服务端内部使用）。
 * 找不到返回 undefined。
 */
export function getClusterRecord(settings, id) {
  if (typeof id !== 'string' || id === '') return undefined;
  return readRecords(settings).find((rec) => rec.id === id);
}

/** 浅拷贝 settings 并挂上新的集群数组，保证入参不被修改。 */
function withRecords(settings, records) {
  const base = isPlainObject(settings) ? settings : {};
  return { ...base, [K8S_CLUSTERS_KEY]: records };
}

/**
 * 新增或更新一个集群。
 *
 * @param {object} settings 当前 settings（不会被修改）
 * @param {{id?:string,name?:string,kubeconfig?:string,context?:string,enabled?:boolean}} input
 * @returns {{record:object, settings:object}} 新的 record 与新的 settings
 * @throws {Error} 新增时 kubeconfig 为空 → 「kubeconfig 不能为空」
 */
export function upsertCluster(settings, input) {
  const source = isPlainObject(input) ? input : {};
  const records = readRecords(settings).slice();

  const wantedId = str(source.id).trim();
  const existingIndex = wantedId
    ? records.findIndex((rec) => rec.id === wantedId)
    : -1;
  const isUpdate = existingIndex >= 0;
  const existing = isUpdate ? records[existingIndex] : null;

  // 新建才生成 id；更新沿用原 id（即使入参带了别的 id 也不覆盖）
  const id = isUpdate ? existing.id : randomUUID();

  let kubeconfig;
  if (isUpdate) {
    // 更新时 kubeconfig 省略或空串 → 沿用旧值，避免前端「改个名字就把证书丢了」
    const incoming = str(source.kubeconfig);
    kubeconfig = incoming.trim() !== '' ? incoming : str(existing.kubeconfig);
  } else {
    kubeconfig = str(source.kubeconfig);
    if (kubeconfig.trim() === '') throw new Error(EMPTY_KUBECONFIG_ERROR);
  }

  const rawName = str(source.name).trim();
  const fallbackName = `cluster-${id.slice(0, 8)}`;
  const name = rawName || (isUpdate ? str(existing.name) || fallbackName : fallbackName);

  // context：显式给了就用（空串表示回到 current-context），没给则沿用旧值
  const hasContextInput = typeof source.context === 'string';
  const context = hasContextInput
    ? source.context.trim()
    : (isUpdate ? str(existing.context).trim() : '');

  // enabled：没给就保持原状（新建默认 true）
  const enabled = typeof source.enabled === 'boolean'
    ? source.enabled
    : (isUpdate ? existing.enabled !== false : true);

  const record = {
    id,
    name,
    kubeconfig,
    context,
    enabled,
    updatedAt: new Date().toISOString(),
  };

  if (isUpdate) records[existingIndex] = record;
  else records.push(record);

  return { record, settings: withRecords(settings, records) };
}

/**
 * 删除指定 id 的集群。
 * @returns {{removed:boolean, settings:object}} removed=false 表示本来就没有
 */
export function deleteCluster(settings, id) {
  const records = readRecords(settings);
  const target = typeof id === 'string' ? id : '';
  const next = records.filter((rec) => rec.id !== target);
  const removed = next.length !== records.length;
  return { removed, settings: withRecords(settings, next) };
}

/**
 * 给日志/错误信息用的打码：`*-data:` 与 `token` 的值都替换为 `***`。
 * 只用于**输出**，不改变持久化的原始文本。
 */
export function maskKubeconfig(text) {
  if (typeof text !== 'string' || text === '') return '';
  let out = text;

  // YAML：`client-certificate-data: LS0t...` / `certificate-authority-data: ...`
  out = out.replace(/^([ \t]*[A-Za-z0-9_.-]+-data[ \t]*:[ \t]*)(.+)$/gm, '$1***');
  // YAML：`token: eyJ...`
  out = out.replace(/^([ \t]*token[ \t]*:[ \t]*)(.+)$/gim, '$1***');
  // JSON 形式：`"client-certificate-data": "LS0t..."` / `"token": "eyJ..."`
  out = out.replace(/("[A-Za-z0-9_.-]+-data"[ \t]*:[ \t]*)"(?:[^"\\]|\\.)*"/g, '$1"***"');
  out = out.replace(/("token"[ \t]*:[ \t]*)"(?:[^"\\]|\\.)*"/gi, '$1"***"');
  // 兜底：行内流式写法（`{ token: abc }`、`token=abc`）
  out = out.replace(/(\btoken\b[ \t]*[:=][ \t]*)(?!\*{3})([^\s,}"']+)/gi, '$1***');

  return out;
}