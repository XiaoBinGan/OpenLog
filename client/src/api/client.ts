/**
 * api/client.ts — 统一的 API 调用层
 *
 * 背景：此前客户端有 85 处直接 `fetch()`，散落在 18 个文件里，其中
 * **45 处既不检查 `res.ok` 也没有 `catch`** —— 服务端返回 500/401 时，
 * 错误响应体会被当作正常数据继续解析，故障静默发生。
 *
 * 这一层把「检查响应状态」和「解析 JSON」收敛到一处，调用方只需要
 * try/catch 一次并把消息交给已有的错误态。
 *
 * 认证不在这里处理：`api/auth.ts` 已经拦截了全局 fetch，只对**同源
 * `/api/` 请求**注入 `Authorization: Bearer`（跨域请求完全不动，
 * 因此不存在 token 泄露到第三方源的风险）。本层不重复实现该逻辑。
 *
 * 用法：
 *   const data = await apiFetch<{ skills: Skill[] }>('/api/skills');
 *   await apiFetch('/api/skills', { method: 'POST', body: JSON.stringify(x) });
 *   await apiJson('/api/skills', 'POST', payload);          // 自动加 Content-Type
 *   const best = await apiFetch<Stats>('/api/monitor/stats').catch(() => null); // 允许失败
 */

/** 非 2xx 响应。带上状态码与响应体，便于调用方区分 401/404/500。 */
export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;

  constructor(message: string, status: number, url: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.body = body;
    // 让 instanceof 在 ES5 目标下也能工作
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/** 从错误响应体里尽量提取一条人类可读的消息。 */
function extractMessage(status: number, statusText: string, raw: string): string {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      const fromBody = parsed?.error ?? parsed?.message;
      if (typeof fromBody === 'string' && fromBody.trim()) return fromBody;
    } catch {
      // 不是 JSON，退回截断的原始文本
      const trimmed = raw.trim();
      if (trimmed) return trimmed.slice(0, 300);
    }
  }
  return `${status}${statusText ? ` ${statusText}` : ''}`;
}

/**
 * 发起请求并在非 2xx 时抛 `ApiError`。
 * 204 或空响应体返回 `undefined`（与旧代码里 `res.json()` 会抛错的行为不同，
 * 空响应不再被当成失败）。
 */
export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);

  if (!res.ok) {
    let raw = '';
    try {
      raw = await res.text();
    } catch {
      // 响应体读取失败不影响抛出状态错误
    }
    throw new ApiError(
      extractMessage(res.status, res.statusText, raw),
      res.status,
      path,
      tryParse(raw),
    );
  }

  if (res.status === 204) return undefined as T;

  const raw = await res.text();
  if (!raw) return undefined as T;

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError('响应不是合法 JSON', res.status, path, raw.slice(0, 300));
  }
}

/**
 * 带 JSON 请求体的便捷方法。
 *
 * `init` 用于传递 signal 等额外选项（分片上传需要 AbortSignal）；
 * method / body / headers 由本函数接管，不接受覆盖。
 */
export function apiJson<T = unknown>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  init?: Omit<RequestInit, 'method' | 'body' | 'headers'>,
): Promise<T> {
  return apiFetch<T>(path, {
    ...init,
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function tryParse(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 300);
  }
}

/** 判断是否为鉴权失败，便于调用方区别对待。 */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}
