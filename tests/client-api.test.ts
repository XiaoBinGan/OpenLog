/**
 * tests/client-api.test.ts
 *
 * 覆盖 client/src/api/client.ts —— 现在所有 API 错误都经由这一层，
 * 但它此前没有任何测试。
 *
 * 放在根 tests/ 而不是 client/src/：client/tsconfig.json 的 include 是 ["src"]，
 * 放到 src 下会被 `tsc -b`（npm run build 的第一步）类型检查，
 * 而客户端 tsconfig 里没有 vitest 的类型。根目录没有 tsconfig，
 * vitest 的默认 include 仍能发现本文件。
 *
 * 只 stub globalThis.fetch，不需要 jsdom —— client.ts 运行时只用 fetch。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, apiJson, ApiError, isAuthError } from '../client/src/api/client';

/** 只实现 apiFetch 真正用到的那几个字段。 */
function mockResponse(
  status: number,
  body = '',
  statusText = '',
): { ok: boolean; status: number; statusText: string; text: () => Promise<string> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(body),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch — 成功路径', () => {
  it('200 + JSON 返回解析后的对象', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, JSON.stringify({ skills: [{ id: 'a' }] })));
    await expect(apiFetch('/api/skills')).resolves.toEqual({ skills: [{ id: 'a' }] });
  });

  it('200 + JSON 数组原样返回', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '[1,2,3]'));
    await expect(apiFetch('/api/monitor/history')).resolves.toEqual([1, 2, 3]);
  });

  it('204 返回 undefined（而非抛解析错误）', async () => {
    fetchMock.mockResolvedValue(mockResponse(204, ''));
    await expect(apiFetch('/api/skills/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('200 但空响应体返回 undefined', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, ''));
    await expect(apiFetch('/api/whatever')).resolves.toBeUndefined();
  });

  it('把调用方的 init 原样透传给 fetch', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    const init = { method: 'POST', body: '{"a":1}', signal: undefined };
    await apiFetch('/api/x', init as RequestInit);
    expect(fetchMock).toHaveBeenCalledWith('/api/x', init);
  });
});

describe('apiFetch — 失败路径（这正是此前 45 处静默失败所缺的）', () => {
  it('500 + {"error":...} 抛出 ApiError，消息取自响应体', async () => {
    fetchMock.mockResolvedValue(mockResponse(500, JSON.stringify({ error: '数据库炸了' })));
    await expect(apiFetch('/api/x')).rejects.toThrow('数据库炸了');

    fetchMock.mockResolvedValue(mockResponse(500, JSON.stringify({ error: '数据库炸了' })));
    const err = await apiFetch('/api/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.url).toBe('/api/x');
    expect(err.body).toEqual({ error: '数据库炸了' });
  });

  it('500 + message 字段同样可用', async () => {
    fetchMock.mockResolvedValue(mockResponse(500, JSON.stringify({ message: '内部错误' })));
    await expect(apiFetch('/api/x')).rejects.toThrow('内部错误');
  });

  it('500 + 非 JSON 文本时用截断文本作为消息', async () => {
    fetchMock.mockResolvedValue(mockResponse(500, '<html>Internal Server Error</html>'));
    const err = await apiFetch('/api/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain('Internal Server Error');
  });

  it('空错误体退回 "状态码 状态文本"', async () => {
    fetchMock.mockResolvedValue(mockResponse(502, '', 'Bad Gateway'));
    await expect(apiFetch('/api/x')).rejects.toThrow('502 Bad Gateway');
  });

  it('401 / 403 被 isAuthError 识别', async () => {
    fetchMock.mockResolvedValue(mockResponse(401, ''));
    const unauthorized = await apiFetch('/api/x').catch((e) => e);
    expect(isAuthError(unauthorized)).toBe(true);

    fetchMock.mockResolvedValue(mockResponse(403, ''));
    const forbidden = await apiFetch('/api/x').catch((e) => e);
    expect(isAuthError(forbidden)).toBe(true);

    fetchMock.mockResolvedValue(mockResponse(500, ''));
    const serverError = await apiFetch('/api/x').catch((e) => e);
    expect(isAuthError(serverError)).toBe(false);
  });

  it('200 但响应体不是合法 JSON 时抛 ApiError', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, 'not json at all'));
    const err = await apiFetch('/api/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('响应不是合法 JSON');
  });

  it('网络层错误原样向上传播（不被包装成 ApiError）', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(apiFetch('/api/x')).rejects.toThrow(TypeError);
  });

  it('错误消息长度被限制，避免把整个页面塞进 toast', async () => {
    fetchMock.mockResolvedValue(mockResponse(500, 'x'.repeat(5000)));
    const err = await apiFetch('/api/x').catch((e) => e);
    expect(err.message.length).toBeLessThanOrEqual(300);
  });
});

describe('apiJson', () => {
  it('自动设置 Content-Type 并序列化 body', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{"success":true}'));
    await apiJson('/api/skills', 'POST', { name: 'n', command: 'c' });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/skills');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ name: 'n', command: 'c' });
  });

  it('无 body 时不发送 body（DELETE 场景）', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await apiJson('/api/skills/abc', 'DELETE');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('失败时同样抛出 ApiError', async () => {
    fetchMock.mockResolvedValue(mockResponse(400, JSON.stringify({ error: 'name and command required' })));
    await expect(apiJson('/api/skills', 'POST', {})).rejects.toThrow('name and command required');
  });
});
