/**
 * server/datasource/api-probe.js —— 探测某个服务有没有开放 API 文档（Swagger / OpenAPI）
 *
 * 能拿到什么、拿不到什么（必须写清楚，否则界面会误导）：
 *   ✅ 有哪些文档地址存在（/openapi.json、/swagger.json、/v3/api-docs…）
 *   ✅ 文档里的接口清单（路径 + 方法），以及服务是否活着、探测延迟
 *   ❌ **拿不到 QPS / P95 / 错误率** —— 那不是文档里的信息，是流量事实，
 *      只在服务自己的访问日志或 Prometheus 指标里。所以面板要明确区分
 *      「接口清单（来自文档）」和「流量指标（来自埋点）」两类数据。
 *
 * 安全：只对用户显式确认过的地址发 GET，不加任何认证头（除非用户填了），
 * 且只读文档路径，不遍历业务接口 —— 扫描别人的站点不是这个功能的用途。
 */

/** 常见的文档地址。顺序按「信息最全 → 最不重要」排，命中即止 */
export const SPEC_PATHS = [
  '/openapi.json',
  '/v3/api-docs',
  '/swagger/v1/swagger.json',
  '/api-docs',
  '/swagger.json',
  '/docs/swagger.json',
  '/openapi.yaml',
  '/swagger-ui/index.html',
  '/swagger-ui.html',
  '/docs',
];

/** 文档太大时只读这么多就够判断（避免拖垮内存） */
const MAX_BODY = 4 * 1024 * 1024;

/**
 * 从 OpenAPI/Swagger 文档里抽出接口清单。
 * 兼容 v2（swagger: '2.0' + basePath）与 v3（openapi + servers[0].url）。
 *
 * @returns {{ title: string, version: string, specVersion: string, basePath: string, endpoints: Array<{method:string,path:string}> }}
 */
export function summarizeSpec(doc) {
  const empty = { title: '', version: '', specVersion: '', basePath: '', endpoints: [] };
  if (!doc || typeof doc !== 'object') return empty;

  const title = String(doc.info?.title || '').slice(0, 120);
  const version = String(doc.info?.version || '').slice(0, 40);
  const specVersion = String(doc.openapi || doc.swagger || '').slice(0, 20);

  let basePath = '';
  if (typeof doc.basePath === 'string') basePath = doc.basePath; // v2
  else if (Array.isArray(doc.servers) && doc.servers[0]?.url) {
    // v3 的 servers url 可能是绝对地址，只保留 path 部分
    const u = String(doc.servers[0].url);
    basePath = u.startsWith('http') ? (() => { try { return new URL(u).pathname; } catch { return ''; } })() : u;
    if (basePath === '/') basePath = '';
  }

  const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const endpoints = [];
  const paths = doc.paths && typeof doc.paths === 'object' ? doc.paths : {};
  for (const [p, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const m of METHODS) {
      if (!item[m]) continue;
      endpoints.push({ method: m.toUpperCase(), path: String(p) });
    }
  }
  // 排序固定，避免每次探测顺序抖动导致 diff 噪声
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { title, version, specVersion, basePath, endpoints };
}

/**
 * 探测一个基地址上的 API 文档。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl      形如 http://host:8080（不带结尾斜杠）
 * @param {(url: string, init?: object) => Promise<Response>} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]  单个地址的超时，默认 2500ms
 * @param {string[]} [opts.paths]    覆盖默认探测列表（测试用）
 * @param {Record<string,string>} [opts.headers] 需要带认证时给
 * @returns {Promise<{ ok: boolean, baseUrl: string, found: string|null, ms: number, summary: object|null, attempts: Array<{path:string,status:number|null,error?:string}>, error?: string }>}
 */
export async function probeApiDocs({
  baseUrl, fetchImpl, timeoutMs = 2500, paths = SPEC_PATHS, headers = {},
}) {
  const impl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, baseUrl: '', found: null, ms: 0, summary: null, attempts: [], error: 'baseUrl 为空' };
  if (typeof impl !== 'function') return { ok: false, baseUrl: base, found: null, ms: 0, summary: null, attempts: [], error: '没有可用的 fetch' };

  const attempts = [];
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  for (const p of paths) {
    const url = base + p;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await impl(url, { method: 'GET', signal: ctrl?.signal, headers: { Accept: 'application/json, */*', ...headers } });
      if (timer) clearTimeout(timer);
      attempts.push({ path: p, status: res.status });
      // 404/401/403 都不算「有文档」，继续试下一个
      if (!res.ok) continue;
      const text = (await res.text()).slice(0, MAX_BODY);
      // 有些 /docs 返回的是 HTML 页面（没给 json），那种只能算「有文档页」，拿不到接口清单
      const doc = tryParseJson(text);
      const ms = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 10) / 10;
      if (!doc) {
        return {
          ok: true, baseUrl: base, found: p, ms, summary: null, attempts,
          error: '文档地址存在但返回的不是 JSON（可能是 Swagger UI 页面），拿不到接口清单',
        };
      }
      return { ok: true, baseUrl: base, found: p, ms, summary: summarizeSpec(doc), attempts };
    } catch (err) {
      if (timer) clearTimeout(timer);
      const msg = err?.name === 'AbortError' ? 'timeout' : String(err?.message || err);
      attempts.push({ path: p, status: null, error: msg });
    }
  }

  const ms = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 10) / 10;
  return {
    ok: false, baseUrl: base, found: null, ms, summary: null, attempts,
    error: attempts.some((a) => a.status === null) ? '连不上（网络不可达或拒绝连接）' : '没有找到常见的接口文档地址',
  };
}

function tryParseJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
