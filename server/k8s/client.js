/**
 * Kubernetes API 只读客户端。
 *
 * 输入是 kubeconfig 解析结果（KubeConfigResolved），输出一组「拿到 path 就能用」的方法。
 * 这里刻意不 import ./kubeconfig.js：解析与连接解耦，单元测试可以直接构造对象。
 *
 * 三条设计约束（契约见 /tmp/k8s-contract.md）：
 * 1. 只依赖 node 内置模块，禁止新增依赖；
 * 2. 同时支持 mTLS（cert/key）与 Bearer token，也支持 insecureSkipTlsVerify（k3s 自签证书场景）；
 * 3. 所有失败都抛**中文** Error，并附带 status / path / body，方便路由层分类成 400/502。
 */
import http from 'node:http';
import https from 'node:https';
import { errorMessage } from '../errors.js';

/** 默认超时：10s。列表接口在几千 Pod 的集群上可能偏慢，但超时了宁可报错也不要吊死请求。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 错误信息里最多回显多少字符的响应体，避免把整个 HTML 错误页塞进前端 toast。 */
const BODY_PREVIEW = 200;

/** 毫秒 → 人类可读秒数（10000 → "10s"，100 → "0.1s"）。 */
function formatSeconds(ms) {
  return `${Number((ms / 1000).toFixed(3))}s`;
}

/**
 * 从 URL 路径推断 resource / verb，用于 403 的权限提示。
 *
 * 例：
 *   /api/v1/namespaces/default/pods            → pods / LIST
 *   /api/v1/namespaces/default/pods/web-0      → pods / GET
 *   /apis/apps/v1/namespaces/x/deployments     → deployments / LIST
 *   /api/v1/namespaces/default/pods/web-0/log  → pods/log / GET
 *   /api/v1/nodes                              → nodes / LIST
 */
function inferRequestTarget(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean);
  let rest = segments;
  if (rest[0] === 'api') rest = rest.slice(2); // /api/<version>/...
  else if (rest[0] === 'apis') rest = rest.slice(3); // /apis/<group>/<version>/...

  // 命名空间作用域：跳过 "/namespaces/<ns>"，剩下的第一个才是资源名
  if (rest[0] === 'namespaces' && rest.length >= 2) rest = rest.slice(2);

  const resource = rest[0] ?? '未知资源';
  const hasName = rest.length >= 2;
  const subresource = rest[2];

  return {
    resource: subresource ? `${resource}/${subresource}` : resource,
    verb: hasName ? 'GET' : 'LIST',
  };
}

/** 把 HTTP 非 2xx 响应变成带中文说明的 Error（status/path/body 一并挂在错误上）。 */
function createHttpError(statusCode, body, pathname) {
  const text = typeof body === 'string' ? body : '';
  const preview = text.slice(0, BODY_PREVIEW).trim();
  const suffix = preview ? `：${preview}` : '';

  let message;
  if (statusCode === 401) {
    message = 'Kubernetes API 鉴权失败（HTTP 401）：凭证无效或已过期，请检查 kubeconfig 的 token / 客户端证书';
  } else if (statusCode === 403) {
    const { resource, verb } = inferRequestTarget(pathname);
    message = `Kubernetes API 权限不足，缺少对 ${resource} 的 ${verb} 权限（HTTP 403）${suffix}`;
  } else if (statusCode === 404) {
    message = `Kubernetes API 资源不存在（HTTP 404）：${pathname}${suffix}`;
  } else {
    message = `Kubernetes API 请求失败（HTTP ${statusCode}）${suffix}`;
  }

  const err = new Error(message);
  err.status = statusCode;
  err.path = pathname;
  err.body = text;
  return err;
}

/** 网络层失败（DNS / TLS / 连接重置）统一包成中文，原始原因留在 cause 上。 */
function wrapNetworkError(err) {
  if (err instanceof Error && err.message.startsWith('Kubernetes API ')) return err;
  const wrapped = new Error(`Kubernetes API 连接失败：${errorMessage(err)}`);
  wrapped.cause = err;
  return wrapped;
}

/** 校验并解析 apiserver 地址；非法配置在创建客户端时就报错，而不是等到第一个请求。 */
function parseServerUrl(server) {
  if (typeof server !== 'string' || server.trim() === '') {
    throw new Error('创建 Kubernetes 客户端失败：kubeconfig 里缺少 apiserver 地址（server）');
  }
  let url;
  try {
    url = new URL(server.trim());
  } catch {
    throw new Error(`创建 Kubernetes 客户端失败：apiserver 地址不合法（${server}）`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`创建 Kubernetes 客户端失败：不支持的协议 ${url.protocol}（只支持 http/https）`);
  }
  return url;
}

/** 拼接请求 URL：path 相对 server，query 支持数组（多值用重复 key，和 k8s API 一致）。 */
function buildUrl(base, path, query) {
  const raw = typeof path === 'string' ? path.trim() : '';
  if (raw === '') throw new Error('Kubernetes API 请求失败：path 不能为空');

  const url = new URL(raw.startsWith('/') ? raw : `/${raw}`, base);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) continue;
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

/** 非空字符串才当作凭证/证书，避免把 "" 传给 https.Agent 触发底层报错。 */
function pemOrUndefined(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 创建只读 Kubernetes API 客户端。
 *
 * @param {object} resolved kubeconfig 解析结果（KubeConfigResolved）
 * @returns {{
 *   request: (path: string, opts?: { query?: object, timeoutMs?: number, method?: string })
 *     => Promise<{ statusCode: number, headers: object, body: string }>,
 *   getJson: (path: string, opts?: object) => Promise<any>,
 *   getText: (path: string, opts?: object) => Promise<string>,
 *   apiServerVersion: () => Promise<{ version: string, gitVersion: string, platform: string }>
 * }}
 */
export function createK8sClient(resolved) {
  if (!resolved || typeof resolved !== 'object') {
    throw new Error('创建 Kubernetes 客户端失败：resolved（kubeconfig 解析结果）不能为空');
  }

  const base = parseServerUrl(resolved.server);
  const useTls = base.protocol === 'https:';
  const token = typeof resolved.token === 'string' ? resolved.token.trim() : '';

  // mTLS + 自定义 CA + 跳过校验，全部在这里一次性绑定到 Agent 上。
  // 注意：rejectUnauthorized 必须显式传 —— 自签证书集群默认会被拒绝。
  const agent = useTls
    ? new https.Agent({
        cert: pemOrUndefined(resolved.cert),
        key: pemOrUndefined(resolved.key),
        ca: pemOrUndefined(resolved.ca),
        rejectUnauthorized: !resolved.insecureSkipTlsVerify,
      })
    : undefined;

  const transport = useTls ? https : http;

  /**
   * 发起一次 GET/自定义 method 请求。
   * 2xx → resolve({ statusCode, headers, body })；非 2xx / 网络错误 / 超时 → reject(Error)。
   */
  function request(path, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    const method = String(opts.method || 'GET').toUpperCase();

    const timeoutError = () => {
      const err = new Error(`Kubernetes API 超时（${formatSeconds(timeoutMs)}）`);
      err.code = 'ETIMEDOUT';
      err.path = path;
      return err;
    };

    return new Promise((resolve, reject) => {
      let url;
      try {
        url = buildUrl(base, path, opts.query);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(errorMessage(err)));
        return;
      }

      const pathname = url.pathname;
      let settled = false;
      let timedOut = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const req = transport.request(
        url,
        {
          method,
          agent,
          headers: {
            accept: 'application/json, text/plain, */*',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.setEncoding('utf8');
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', (err) => finish(reject, wrapNetworkError(err)));
          res.on('end', () => {
            const body = chunks.join('');
            const statusCode = res.statusCode ?? 0;
            if (statusCode >= 200 && statusCode < 300) {
              finish(resolve, { statusCode, headers: res.headers, body });
            } else {
              finish(reject, createHttpError(statusCode, body, pathname));
            }
          });
        },
      );

      // 服务端迟迟不响应（apiserver 卡住、网络黑洞）时必须自己断开，否则请求会永久挂着。
      req.setTimeout(timeoutMs, () => {
        if (settled) return;
        timedOut = true;
        req.destroy(timeoutError());
      });

      req.on('error', (err) => {
        if (settled) return;
        finish(reject, timedOut ? timeoutError() : wrapNetworkError(err));
      });

      req.end();
    });
  }

  /** GET + JSON.parse。空响应体（204）返回 null；非 JSON 报中文错误而不是把 SyntaxError 直抛。 */
  async function getJson(path, options) {
    const res = await request(path, options);
    const text = String(res.body ?? '').trim();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Kubernetes API 返回的不是合法 JSON（${path}）：${text.slice(0, BODY_PREVIEW)}`);
    }
  }

  /** GET 纯文本（Pod 日志、metrics 等）。 */
  async function getText(path, options) {
    const res = await request(path, options);
    return res.body;
  }

  /** GET /version → 只挑集群页需要的三个字段，其余丢弃。 */
  async function apiServerVersion() {
    const data = await getJson('/version');
    const info = data && typeof data === 'object' ? data : {};
    return {
      version: typeof info.version === 'string' ? info.version : '',
      gitVersion: typeof info.gitVersion === 'string' ? info.gitVersion : '',
      platform: typeof info.platform === 'string' ? info.platform : '',
    };
  }

  return { request, getJson, getText, apiServerVersion };
}
