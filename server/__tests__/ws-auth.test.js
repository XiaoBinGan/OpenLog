/**
 * server/__tests__/ws-auth.test.js
 *
 * `server/ws-auth.js` 的回归测试：token 从 URL query 迁到
 * `Sec-WebSocket-Protocol` 子协议。
 *
 * 这里钉死三件事：
 *   1. 解析规则（协议头 / query / 常量时间比较）
 *   2. 握手判定（协议头优先、query 仅兼容期、过期/关闭后的拒绝行为）
 *   3. **回显的值里永远不出现 token** —— 回显 token 等于把凭证写进 101 响应头，
 *      和原来的 `?token=` 一样会进反代日志，属于"改了但没改对"。
 *
 * 另外用源码断言守住客户端侧：`withWsToken()` 不许再拼 `?token=`，
 * 且 `wsProtocols()` 必须存在（真正的 token 通道）。
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';

import {
  WS_SUBPROTOCOL,
  DEPRECATED_QUERY_PARAM,
  parseTokenFromProtocolHeader,
  parseTokenFromQuery,
  isTokenValid,
  timingSafeCompare,
  evaluateUpgradeRequest,
  createVerifyClient,
  selectResponseProtocol,
  createHandleProtocols,
} from '../ws-auth.js';

const EXPECTED = 'expected-token-abc';

/** 静音 logger：断言用，同时确认没有意外输出。 */
function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() };
}

/** 造一个 ws verifyClient 的 info 对象。 */
function makeInfo({ protocolHeader, url = '/ws' } = {}) {
  const headers = {};
  if (protocolHeader !== undefined) headers['sec-websocket-protocol'] = protocolHeader;
  const req = { url, headers };
  return { req, origin: 'http://localhost:5173', secure: false };
}

/** 跑一次 verifyClient，收集 cb 参数。 */
function runVerifyClient(verifyClient, info) {
  const calls = [];
  verifyClient(info, (...args) => calls.push(args));
  return calls;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. parseTokenFromProtocolHeader
// ─────────────────────────────────────────────────────────────────────────────
describe('parseTokenFromProtocolHeader — 从子协议头取 token', () => {
  it('正常两段：openlog.v1 + token.abc123', () => {
    expect(parseTokenFromProtocolHeader('openlog.v1, token.abc123')).toEqual({
      token: 'abc123',
      protocol: 'openlog.v1',
    });
  });

  it('顺序无关（token 在前）', () => {
    expect(parseTokenFromProtocolHeader('token.abc123, openlog.v1')).toEqual({
      token: 'abc123',
      protocol: 'openlog.v1',
    });
  });

  it('只有 openlog.v1 → token 为 null，protocol 仍是 openlog.v1', () => {
    expect(parseTokenFromProtocolHeader('openlog.v1')).toEqual({
      token: null,
      protocol: 'openlog.v1',
    });
  });

  it('空 / null / undefined / 纯空白 → token null，protocol 回落约定值', () => {
    for (const value of ['', '   ', null, undefined]) {
      expect(parseTokenFromProtocolHeader(value)).toEqual({
        token: null,
        protocol: WS_SUBPROTOCOL,
      });
    }
  });

  it('大小写：前缀大小写不敏感，值原样保留', () => {
    expect(parseTokenFromProtocolHeader('openlog.v1, TOKEN.abc123').token).toBe('abc123');
    expect(parseTokenFromProtocolHeader('Token.abc123, openlog.v1').token).toBe('abc123');
    // 值是大小写敏感的，不能被 toLowerCase 掉
    expect(parseTokenFromProtocolHeader('openlog.v1, token.AbC123').token).toBe('AbC123');
    // 协议名保留客户端原始大小写（回显必须逐字符匹配客户端提议值）
    expect(parseTokenFromProtocolHeader('OpenLog.V1, token.x').protocol).toBe('OpenLog.V1');
  });

  it('多余空格 / tab / 尾逗号 / 连续逗号都能容忍', () => {
    expect(parseTokenFromProtocolHeader('  openlog.v1 ,   token.abc123  ').token).toBe('abc123');
    expect(parseTokenFromProtocolHeader('openlog.v1,\ttoken.abc123').token).toBe('abc123');
    expect(parseTokenFromProtocolHeader('openlog.v1, token.abc123,').token).toBe('abc123');
    expect(parseTokenFromProtocolHeader('openlog.v1,,token.abc123').token).toBe('abc123');
    expect(parseTokenFromProtocolHeader('openlog.v1, token.abc123').protocol).toBe('openlog.v1');
  });

  it('token 里含点号：token.a.b 要取全部 a.b', () => {
    expect(parseTokenFromProtocolHeader('openlog.v1, token.a.b').token).toBe('a.b');
    expect(parseTokenFromProtocolHeader('openlog.v1, token.a.b.c.d').token).toBe('a.b.c.d');
    // 只有 token 一段时点号同样完整
    expect(parseTokenFromProtocolHeader('token.a.b').token).toBe('a.b');
  });

  it('token. 后面为空 → 不算 token（不给空串开后门）', () => {
    expect(parseTokenFromProtocolHeader('openlog.v1, token.').token).toBeNull();
  });

  it('百分号编码的值对称还原（客户端 encodeURIComponent）', () => {
    expect(parseTokenFromProtocolHeader('openlog.v1, token.a%2Bb%2Fc').token).toBe('a+b/c');
    // 坏的编码不抛错，原样保留
    expect(parseTokenFromProtocolHeader('openlog.v1, token.a%zz').token).toBe('a%zz');
  });

  it('多个 token 段只取第一个（不允许头里塞两个让服务端挑到合法的）', () => {
    expect(parseTokenFromProtocolHeader('openlog.v1, token.first, token.second').token).toBe(
      'first',
    );
  });

  it('header 是数组时也能解析', () => {
    expect(parseTokenFromProtocolHeader(['openlog.v1', 'token.abc123'])).toEqual({
      token: 'abc123',
      protocol: 'openlog.v1',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. parseTokenFromQuery（兼容期，deprecated）
// ─────────────────────────────────────────────────────────────────────────────
describe('parseTokenFromQuery — 旧客户端的 ?token=（deprecated）', () => {
  it('?token=x 能解析，并标记 deprecated', () => {
    expect(parseTokenFromQuery('/ws?token=x')).toEqual({
      token: 'x',
      deprecated: true,
      source: 'query',
    });
  });

  it('多参数：token 与其它参数共存', () => {
    expect(parseTokenFromQuery('/ws/docker/logs/a/b?stream=1&token=x&tail=100').token).toBe('x');
    expect(parseTokenFromQuery('ws://127.0.0.1:3011/ws?x=1&token=y').token).toBe('y');
  });

  it('没有 token → token null 且不算 deprecated 来源', () => {
    expect(parseTokenFromQuery('/ws')).toEqual({
      token: null,
      deprecated: false,
      source: 'query',
    });
    expect(parseTokenFromQuery('/ws?a=1&b=2').token).toBeNull();
    expect(parseTokenFromQuery('/ws?token=').token).toBeNull();
    expect(parseTokenFromQuery('').token).toBeNull();
    expect(parseTokenFromQuery(null).token).toBeNull();
  });

  it('URL 编码会被解码成原 token', () => {
    expect(parseTokenFromQuery('/ws?token=a%2Bb%2Fc%3D').token).toBe('a+b/c=');
    expect(parseTokenFromQuery(`/ws?token=${encodeURIComponent('点号.与 空格')}`).token).toBe(
      '点号.与 空格',
    );
  });

  it('参数名大小写敏感：TOKEN=x 不是 token', () => {
    expect(parseTokenFromQuery('/ws?TOKEN=x').token).toBeNull();
    expect(DEPRECATED_QUERY_PARAM).toBe('token');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. isTokenValid（常量时间比较）
// ─────────────────────────────────────────────────────────────────────────────
describe('isTokenValid — 常量时间比较', () => {
  it('相等 → true', () => {
    expect(isTokenValid('abc', 'abc')).toBe(true);
    expect(timingSafeCompare('abc', 'abc')).toBe(true);
  });

  it('不等 → false', () => {
    expect(isTokenValid('abc', 'abd')).toBe(false);
    // 只差最后一位（`===` 早期实现里最容易泄漏前缀的那种输入）
    expect(isTokenValid('abcdefgh', 'abcdefgi')).toBe(false);
  });

  it('长度不同 → false（长度差折进结果，不提前短路）', () => {
    expect(isTokenValid('abc', 'abcd')).toBe(false);
    expect(isTokenValid('abcd', 'abc')).toBe(false);
    // 前缀完全相同的长串，长度仍必须是否决条件
    expect(isTokenValid('abc', 'abc' + 'x'.repeat(200))).toBe(false);
  });

  it('空值一律 false（不给"两边都空"开后门）', () => {
    expect(isTokenValid('', '')).toBe(false);
    expect(isTokenValid('', 'abc')).toBe(false);
    expect(isTokenValid('abc', '')).toBe(false);
    expect(isTokenValid(null, 'abc')).toBe(false);
    expect(isTokenValid('abc', null)).toBe(false);
    expect(isTokenValid(undefined, undefined)).toBe(false);
    expect(isTokenValid(123, '123')).toBe(false);
  });

  it('比较函数可注入（单测只想看判定逻辑时用恒等比较）', () => {
    const compare = vi.fn((a, b) => a === b);
    expect(isTokenValid('abc', 'abc', compare)).toBe(true);
    expect(compare).toHaveBeenCalledWith('abc', 'abc');
    expect(isTokenValid('abc', 'abd', compare)).toBe(false);
    // 注入的比较函数抛错 → 当无效，不能让异常冒到握手栈里
    expect(
      isTokenValid('abc', 'abc', () => {
        throw new Error('boom');
      }),
    ).toBe(false);
    // 空值不走注入比较器（否则 '' === '' 就成后门了）
    compare.mockClear();
    expect(isTokenValid('', '', compare)).toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. createVerifyClient
// ─────────────────────────────────────────────────────────────────────────────
describe('createVerifyClient — 握手判定', () => {
  it('协议头有效 → 通过，并在 info.req 上标注 wsToken', () => {
    const logger = fakeLogger();
    const verify = createVerifyClient({ expectedToken: EXPECTED, logger });
    const info = makeInfo({ protocolHeader: `openlog.v1, token.${EXPECTED}` });

    const calls = runVerifyClient(verify, info);

    expect(calls).toEqual([[true]]);
    expect(info.req.wsToken).toBe(EXPECTED);
    expect(info.req.wsTokenSource).toBe('protocol');
    expect(info.req.wsProtocol).toBe('openlog.v1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('协议头无效 + query 有效（fallback 开）→ 通过，来源标 query，且只警告一次', () => {
    const logger = fakeLogger();
    const verify = createVerifyClient({ expectedToken: EXPECTED, logger });
    const info = makeInfo({
      protocolHeader: 'openlog.v1, token.wrong',
      url: `/ws?token=${encodeURIComponent(EXPECTED)}`,
    });

    expect(runVerifyClient(verify, info)).toEqual([[true]]);
    expect(info.req.wsToken).toBe(EXPECTED);
    expect(info.req.wsTokenSource).toBe('query');
    // deprecation 警告一次就够，不要每次重连刷屏
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // 警告文案里绝不能出现 token 值
    const message = String(logger.warn.mock.calls[0][0]);
    expect(message).not.toContain(EXPECTED);
    // url 也不能整条打出来（?token= 就在 query 里）
    expect(message).not.toContain('token=');

    runVerifyClient(verify, makeInfo({ url: `/ws?token=${EXPECTED}` }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('协议头没有 token 但 query 有效（fallback 开）→ 通过', () => {
    const verify = createVerifyClient({ expectedToken: EXPECTED, logger: fakeLogger() });
    const info = makeInfo({ protocolHeader: 'openlog.v1', url: `/ws?token=${EXPECTED}` });
    expect(runVerifyClient(verify, info)).toEqual([[true]]);
    expect(info.req.wsTokenSource).toBe('query');
  });

  it('fallback 关 → 只有 query 有效也拒绝', () => {
    const logger = fakeLogger();
    const verify = createVerifyClient({
      expectedToken: EXPECTED,
      allowQueryFallback: false,
      logger,
    });
    const info = makeInfo({ protocolHeader: 'openlog.v1', url: `/ws?token=${EXPECTED}` });

    const calls = runVerifyClient(verify, info);

    expect(calls).toEqual([[false, 401, 'Unauthorized']]);
    expect(info.req.wsToken).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).not.toContain(EXPECTED);
  });

  it('两者都无 → 拒绝，cb 第一个参数是 false', () => {
    const verify = createVerifyClient({ expectedToken: EXPECTED, logger: fakeLogger() });
    const info = makeInfo({ protocolHeader: 'openlog.v1' });

    const calls = runVerifyClient(verify, info);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(false);
    expect(calls[0][1]).toBe(401);
    expect(info.req.wsToken).toBeUndefined();
  });

  it('协议头 token 错误 + query 也没有 → 拒绝', () => {
    const verify = createVerifyClient({ expectedToken: EXPECTED, logger: fakeLogger() });
    expect(runVerifyClient(verify, makeInfo({ protocolHeader: 'token.nope' }))[0][0]).toBe(false);
  });

  it('服务端没配 token（expectedToken 空）→ 一律拒绝', () => {
    const verify = createVerifyClient({ expectedToken: '', logger: fakeLogger() });
    expect(runVerifyClient(verify, makeInfo({ protocolHeader: 'openlog.v1, token.' }))[0][0]).toBe(
      false,
    );
    const verify2 = createVerifyClient({ logger: fakeLogger() });
    expect(runVerifyClient(verify2, makeInfo({ protocolHeader: 'token.anything' }))[0][0]).toBe(
      false,
    );
  });

  it('也接受直接传 req（没有 info.req 包装），并返回布尔值', () => {
    const req = { url: '/ws', headers: { 'sec-websocket-protocol': `openlog.v1, token.${EXPECTED}` } };
    const verify = createVerifyClient({ expectedToken: EXPECTED, logger: fakeLogger() });
    expect(verify(req)).toBe(true);
    expect(req.wsToken).toBe(EXPECTED);
    expect(verify({ url: '/ws', headers: {} })).toBe(false);
  });

  it('logger 抛错不影响判定；缺 logger 也不崩', () => {
    const logger = {
      warn() {
        throw new Error('log sink down');
      },
    };
    const verify = createVerifyClient({ expectedToken: EXPECTED, logger });
    expect(runVerifyClient(verify, makeInfo({ url: `/ws?token=${EXPECTED}` }))[0][0]).toBe(true);

    const verifyNoLogger = createVerifyClient({ expectedToken: EXPECTED, logger: null });
    expect(runVerifyClient(verifyNoLogger, makeInfo({ url: '/ws' }))[0][0]).toBe(false);
  });

  it('info.req 缺失也不崩（防御性）', () => {
    const verify = createVerifyClient({ expectedToken: EXPECTED, logger: fakeLogger() });
    expect(() => verify({}, () => {})).not.toThrow();
    expect(verify(undefined, undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5/6. 子协议回显 —— 绝不能把 token 抄回响应头
// ─────────────────────────────────────────────────────────────────────────────
describe('createHandleProtocols / selectResponseProtocol — 只回显 openlog.v1', () => {
  it('createHandleProtocols 返回 openlog.v1', () => {
    const handle = createHandleProtocols();
    const protocols = new Set(['openlog.v1', `token.${EXPECTED}`]);
    expect(handle(protocols, {})).toBe('openlog.v1');
  });

  it('createHandleProtocols 绝不返回 token 项（含断言返回值不含 "token."）', () => {
    const handle = createHandleProtocols();
    const result = handle(new Set(['openlog.v1', `token.${EXPECTED}`]), {});
    expect(result).not.toContain('token.');
    expect(result).not.toContain(EXPECTED);
    expect(String(result).toLowerCase()).not.toContain('token');
  });

  it('createHandleProtocols：只有 token 项 → 不回显（undefined），不能把 token 顶上去', () => {
    const handle = createHandleProtocols();
    const result = handle(new Set([`token.${EXPECTED}`]), {});
    expect(result).toBeUndefined();
    expect(result ?? '').not.toContain('token.');
  });

  it('createHandleProtocols：空 Set / 未带头 → undefined', () => {
    const handle = createHandleProtocols();
    expect(handle(new Set(), {})).toBeUndefined();
    expect(handle(undefined, {})).toBeUndefined();
    expect(handle(null, {})).toBeUndefined();
  });

  it('createHandleProtocols：大小写不同的提议保留客户端原始字面量（回显必须逐字符匹配）', () => {
    const handle = createHandleProtocols();
    expect(handle(new Set(['OpenLog.V1', `token.${EXPECTED}`]), {})).toBe('OpenLog.V1');
  });

  it('createHandleProtocols 也吃逗号分隔字符串', () => {
    const handle = createHandleProtocols();
    expect(handle(`openlog.v1, token.${EXPECTED}`, {})).toBe('openlog.v1');
  });

  it('selectResponseProtocol 返回 openlog.v1', () => {
    expect(selectResponseProtocol('openlog.v1, token.abc123')).toBe('openlog.v1');
    expect(selectResponseProtocol('token.abc123, openlog.v1')).toBe('openlog.v1');
  });

  it('selectResponseProtocol 返回值不含 "token."，也不含 token 值', () => {
    const result = selectResponseProtocol(`openlog.v1, token.${EXPECTED}`);
    expect(result).not.toContain('token.');
    expect(result).not.toContain(EXPECTED);
    expect(result).toBe(WS_SUBPROTOCOL);
  });

  it('selectResponseProtocol：只有 token 项 / 空头 → null', () => {
    expect(selectResponseProtocol(`token.${EXPECTED}`)).toBeNull();
    expect(selectResponseProtocol('')).toBeNull();
    expect(selectResponseProtocol(null)).toBeNull();
    expect(selectResponseProtocol(undefined)).toBeNull();
  });

  it('两个 handler 与解析器互相一致：协商值与 token 通道分离', () => {
    const header = `openlog.v1, token.${EXPECTED}`;
    const parsed = parseTokenFromProtocolHeader(header);
    const echoed = selectResponseProtocol(header);
    expect(parsed.token).toBe(EXPECTED);
    expect(echoed).toBe(parsed.protocol);
    expect(echoed).toBe('openlog.v1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 附加：evaluateUpgradeRequest（index.js 在 upgrade 里可用它做同步门禁）
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateUpgradeRequest — 纯判定', () => {
  it('协议头优先于 query（两侧都合法时 source=protocol，不触发 deprecation）', () => {
    const outcome = evaluateUpgradeRequest(
      {
        url: `/ws?token=from-query`,
        headers: { 'sec-websocket-protocol': `openlog.v1, token.${EXPECTED}` },
      },
      { expectedToken: EXPECTED },
    );
    expect(outcome).toMatchObject({
      ok: true,
      source: 'protocol',
      deprecated: false,
      reason: 'ok',
    });
  });

  it('无 token → ok:false, reason:no-token', () => {
    const outcome = evaluateUpgradeRequest({ url: '/ws', headers: {} }, { expectedToken: EXPECTED });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('no-token');
    expect(outcome.token).toBeNull();
  });

  it('token 错 → ok:false, reason:bad-protocol-token', () => {
    const outcome = evaluateUpgradeRequest(
      { url: '/ws', headers: { 'sec-websocket-protocol': 'openlog.v1, token.wrong' } },
      { expectedToken: EXPECTED },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('bad-protocol-token');
    expect(outcome.source).toBe('protocol');
  });

  it('req.headers 缺失也不崩', () => {
    expect(() => evaluateUpgradeRequest({}, { expectedToken: EXPECTED })).not.toThrow();
    expect(evaluateUpgradeRequest(null, { expectedToken: EXPECTED }).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 客户端源码断言
// ─────────────────────────────────────────────────────────────────────────────
describe('client/src/api/auth.ts — 源码不再把 token 拼进 URL', () => {
  const source = readFileSync(
    new URL('../../client/src/api/auth.ts', import.meta.url),
    'utf8',
  );

  /** 取出某个函数（导出或私有）的函数体文本。 */
  function functionBody(name) {
    const start = source.indexOf(`function ${name}(`);
    expect(start, `${name} 必须存在于 auth.ts`).toBeGreaterThan(-1);
    const open = source.indexOf('{', start);
    expect(open).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(open + 1, i);
      }
    }
    throw new Error(`没能取到 ${name} 的函数体`);
  }

  it('存在 wsProtocols()（新的 token 通道）', () => {
    expect(source).toContain('export function wsProtocols(');
    expect(source).toContain('Sec-WebSocket-Protocol');
    const body = functionBody('wsProtocols');
    // 子协议第一项是约定的 openlog.v1
    expect(body).toContain('WS_SUBPROTOCOL');
    // token 走 'token.' 前缀的子协议
    expect(source).toContain("'token.'");
    // 没 token 时也必须给出合法的协议数组，而不是空数组
    expect(body).toMatch(/\[\s*WS_SUBPROTOCOL\s*\]/);
  });

  it('withWsToken 不再拼 ?token=（只剩 URL 清理）', () => {
    const body = functionBody('withWsToken');
    // 老实现的三个指纹，一个都不许留
    expect(body).not.toContain('encodeURIComponent');
    expect(body).not.toContain('separator');
    expect(body).not.toMatch(/\?token=/);
    expect(body).not.toMatch(/[?&]token=/);
    expect(body).not.toContain('getToken()');
    // 仍然是 url -> url 的签名，调用点不用改签名
    expect(source).toContain('export function withWsToken(url: string): string');
    expect(body).toContain('stripLegacyTokenParam');
  });

  it('stripLegacyTokenParam 会真的删掉 token 参数（并保留其它 query）', () => {
    const body = functionBody('stripLegacyTokenParam');
    expect(body).toContain('LEGACY_WS_TOKEN_PARAM');
    expect(source).toContain("const LEGACY_WS_TOKEN_PARAM = 'token';");
    // 保留其它参数 / hash 的痕迹
    expect(body).toContain('kept.join');
    expect(body).toContain('hash');
  });

  it('auth.ts 里没有任何把 token 写进日志的调用', () => {
    // console.* 后 200 字符内不许出现 token 变量插值
    const consoleCalls = source.match(/console\.(log|warn|error|info|debug)\([\s\S]{0,400}?\);/g) ?? [];
    for (const call of consoleCalls) {
      expect(call).not.toMatch(/\$\{[^}]*[Tt]oken[^}]*\}/);
      expect(call).not.toMatch(/[Tt]oken\s*\+/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. 客户端运行时行为（真 import 一遍，不只读源码）
// ─────────────────────────────────────────────────────────────────────────────
describe('client/src/api/auth.ts — 运行时行为', () => {
  it('wsProtocols() 带上 token 子协议；withWsToken() 剥掉旧的 ?token=', async () => {
    // auth.ts 把状态挂在 window 上，node 环境需要一个最小 stub。
    const store = new Map();
    const fakeWindow = {
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => void store.set(key, String(value)),
        removeItem: (key) => void store.delete(key),
      },
      location: { href: 'http://localhost/', origin: 'http://localhost' },
      dispatchEvent: () => true,
      fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    };
    vi.stubGlobal('window', fakeWindow);

    try {
      const auth = await import('../../client/src/api/auth.ts');

      // 未登录：只有协商用的协议名，没有 token 项
      auth.setToken('');
      expect(auth.wsProtocols()).toEqual(['openlog.v1']);

      // 有 token：第二项是 token.<encoded>
      auth.setToken('a.b+c/d');
      const protocols = auth.wsProtocols();
      expect(protocols).toHaveLength(2);
      expect(protocols[0]).toBe('openlog.v1');
      expect(protocols[1]).toBe(`token.${encodeURIComponent('a.b+c/d')}`);
      expect(protocols[1].startsWith('token.')).toBe(true);

      // withWsToken 只做清理：token 参数被删除，其它 query 原样保留
      expect(auth.withWsToken('wss://host/ws?token=a.b')).toBe('wss://host/ws');
      expect(auth.withWsToken('wss://host/ws?a=1&token=x&b=2')).toBe('wss://host/ws?a=1&b=2');
      expect(auth.withWsToken('wss://host/ws')).toBe('wss://host/ws');
      expect(auth.withWsToken('wss://host/ws?a=1')).toBe('wss://host/ws?a=1');
      expect(auth.withWsToken('wss://host/ws/a?x=1#frag')).toBe('wss://host/ws/a?x=1#frag');
      expect(auth.withWsToken('wss://host/ws?token=x#frag')).toBe('wss://host/ws#frag');
      // 绝不能把 token 再加回 URL
      expect(auth.withWsToken('wss://host/ws')).not.toContain('token=');

      // 两端对得上：客户端产出的头能被服务端解析器读回来
      const parsed = parseTokenFromProtocolHeader(protocols.join(', '));
      expect(parsed.token).toBe('a.b+c/d');
      expect(parsed.protocol).toBe('openlog.v1');
      expect(selectResponseProtocol(protocols.join(', '))).toBe('openlog.v1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
