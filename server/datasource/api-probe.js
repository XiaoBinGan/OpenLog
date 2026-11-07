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
 * **反误判**：很多 SPA 站点对任意路径都回 200 + 同一个 index.html（前端路由兜底），
 * 直接按状态码判会把「没有文档」报成「找到文档」。所以先探一个肯定不存在的路径
 * 当**指纹**，之后凡是内容和指纹一致的，一律当「兜底页面」不算命中。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl      形如 http://host:8080（不带结尾斜杠）
 * @param {(url: string, init?: object) => Promise<Response>} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]  单个地址的超时，默认 2500ms
 * @param {string[]} [opts.paths]    覆盖默认探测列表（测试用）
 * @param {Record<string,string>} [opts.headers] 需要带认证时给
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

  const fetchOnce = async (url) => {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await impl(url, { method: 'GET', signal: ctrl?.signal, headers: { Accept: 'application/json, */*', ...headers } });
      const text = res.ok ? (await res.text()).slice(0, MAX_BODY) : '';
      return { status: res.status, ok: res.ok, text };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // ① 兜底指纹：探一个几乎不可能存在的路径，看服务器是不是「什么都回 200 + 同一页面」
  let fallbackSig = null;
  try {
    const sentinel = await fetchOnce(base + '/__openlog_probe_no_such_path__');
    if (sentinel.ok && sentinel.text) fallbackSig = signature(sentinel.text);
  } catch { /* 探不到指纹就按正常流程走 */ }

  for (const p of paths) {
    const url = base + p;
    try {
      const r = await fetchOnce(url);
      if (!r.ok) {
        attempts.push({ path: p, status: r.status });
        continue;
      }

      const doc = tryParseJson(r.text);
      if (doc) {
        attempts.push({ path: p, status: r.status });
        const ms = elapsed(t0);
        return { ok: true, baseUrl: base, found: p, ms, summary: summarizeSpec(doc), attempts };
      }

      // 不是 JSON：先判断是不是「所有路径都回同一个页面」
      const isFallback = fallbackSig !== null && signature(r.text) === fallbackSig;
      // Swagger UI / ReDoc 页面里通常带这些关键词；没有就不是文档页
      const looksLikeDocUi = /swagger|redoc|openapi|api-?docs/i.test(r.text.slice(0, 4000));
      if (isFallback || !looksLikeDocUi) {
        attempts.push({ path: p, status: r.status, error: isFallback ? 'SPA 兜底页面（不是文档）' : '不是文档页面' });
        continue;
      }

      attempts.push({ path: p, status: r.status });
      const ms = elapsed(t0);
      return {
        ok: true, baseUrl: base, found: p, ms, summary: null, attempts,
        error: '这里是一个 Swagger UI 页面，但它要自己再去后端取 JSON 才有接口清单；可以直接打开这个地址看',
      };
    } catch (err) {
      const msg = err?.name === 'AbortError' ? 'timeout' : String(err?.message || err);
      attempts.push({ path: p, status: null, error: msg });
    }
  }

  const ms = elapsed(t0);
  const allFallback = attempts.length > 0 && attempts.every((a) => a.error === 'SPA 兜底页面（不是文档）');
  let hint = '没有找到常见的接口文档地址';
  if (attempts.some((a) => a.status === null)) hint = '连不上（网络不可达或拒绝连接）';
  else if (allFallback) hint = '这个服务把所有路径都返回同一个前端页面（SPA 兜底），没有接口文档';
  return { ok: false, baseUrl: base, found: null, ms, summary: null, attempts, error: hint };
}

function elapsed(t0) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return Math.round((now - t0) * 10) / 10;
}

/** 内容指纹：长度 + 前后各 64 字符。够区分不同页面，又不做无意义哈希 */
function signature(text) {
  const s = String(text || '');
  return `${s.length}:${s.slice(0, 64)}:${s.slice(-64)}`;
}

function tryParseJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
