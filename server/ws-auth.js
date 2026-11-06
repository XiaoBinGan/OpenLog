/**
 * server/ws-auth.js —— WebSocket 握手鉴权：token 走 `Sec-WebSocket-Protocol`
 *
 * 为什么要改
 * ----------
 * 之前浏览器端是 `new WebSocket('wss://host/ws?token=<token>')`。URL 里的 token 会
 * 落到：反代/access log、浏览器历史、`Referer`、错误上报（Sentry 之类）、APM 采样。
 * 而这些地方都不该出现凭证。浏览器 WebSocket API 不允许自定义 header，所以唯一
 * 干净的通道是握手时就有的 `Sec-WebSocket-Protocol` 头：
 *
 *     new WebSocket('wss://host/ws', ['openlog.v1', 'token.' + token])
 *     -> Sec-WebSocket-Protocol: openlog.v1, token.<token>
 *
 * 两个必须同时做对的细节
 * ----------------------
 * 1) 服务端必须在 101 响应里回显**一个**客户端提议过的子协议，否则浏览器认为协商
 *    失败并断开。回显值只能是 `openlog.v1`，绝不能是 `token.<token>` 那一段——
 *    那等于把 token 抄回响应头（响应头同样会进反代日志）。
 *    见 `createHandleProtocols()` / `selectResponseProtocol()`。
 * 2) 兼容期旧客户端仍在 URL 上带 `?token=`，所以 query 回退通道保留，但默认只在
 *    协议头没有 token 时生效，并打一条**不含 token**的 deprecation 警告。
 *    见 `createVerifyClient()`。
 *
 * 日志纪律：本文件任何一行日志都不打印 token 本身，也不打印带 query 的 URL
 * （`?token=` 就在 query 里）。打日志前一律用 `safePath()` 把 query 砍掉。
 *
 * 纯逻辑、无副作用，方便单测；接线由 server/index.js 负责。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** 客户端与服务端约定的子协议名（协商成功时服务端要回显它）。 */
export const WS_SUBPROTOCOL = 'openlog.v1';

/** token 子协议前缀：`token.<token>`。 */
export const TOKEN_PROTOCOL_PREFIX = 'token.';

/** 兼容期 query 参数名（deprecated，会进日志，必须尽快退场）。 */
export const DEPRECATED_QUERY_PARAM = 'token';

/** 拒绝握手时回给客户端的 HTTP 状态码（ws 的 cb(false, code, message)）。 */
export const REJECT_STATUS = 401;

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 header 值规整成条目数组。
 * Node 可能给 string（重复头被拼成 'a, b'）也可能给 string[]（raw header 场景），
 * 两种都吃。空值/空串一律返回 []。
 */
function toProtocolList(headerValue) {
  if (headerValue === undefined || headerValue === null) return [];
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : String(headerValue);
  if (raw.length === 0) return [];
  const entries = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value.length > 0) entries.push(value);
  }
  return entries;
}

/**
 * token 子协议里的值做一次安全百分号解码。
 * 客户端用 `encodeURIComponent()` 编码（输出全部落在 RFC 7230 tchar 集合内，
 * 不会让 ws 的 subprotocol 解析器抛 SyntaxError）；服务端这里对称还原。
 * 没有 '%' 时原值返回，避免把 token 里合法的 '%' 弄坏。
 */
function decodeProtocolTokenValue(value) {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 只取 pathname，永不带 query（query 里可能有 token）。 */
function safePath(req) {
  const url = req && typeof req.url === 'string' ? req.url : '';
  const index = url.indexOf('?');
  const path = index === -1 ? url : url.slice(0, index);
  return path.length > 0 ? path : '(unknown)';
}

/** 日志调用一律包一层：logger 被人换掉/抛错都不能影响握手判定。 */
function logSafely(logger, level, message) {
  if (!logger) return;
  const fn = typeof logger[level] === 'function' ? logger[level] : null;
  if (fn === null) return;
  try {
    fn.call(logger, message);
  } catch {
    // 日志失败不是鉴权失败。
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 `Sec-WebSocket-Protocol` 头里解析 token 与协商协议名。
 *
 *   'openlog.v1, token.abc123' -> { token: 'abc123', protocol: 'openlog.v1' }
 *   'openlog.v1'               -> { token: null,     protocol: 'openlog.v1' }
 *   'token.a.b, openlog.v1'    -> { token: 'a.b',    protocol: 'openlog.v1' }（点号全保留）
 *
 * 语义说明：
 *  - 前缀 `token.` 大小写不敏感（`TOKEN.` / `Token.` 都认），值本身原样保留。
 *  - `token.` 后面是空串不算 token，继续往后找；全都没有就是 null。
 *  - protocol 优先取 `openlog.v1`（保留客户端原始大小写，回显要用客户端给的字面量），
 *    没有其它条目时回落成 WS_SUBPROTOCOL，保证返回值始终是"可选中的协议名"。
 *
 * @param {string|string[]|undefined|null} headerValue
 * @returns {{ token: string|null, protocol: string }}
 */
export function parseTokenFromProtocolHeader(headerValue) {
  const entries = toProtocolList(headerValue);

  let token = null;
  const nonTokenEntries = [];

  for (const entry of entries) {
    if (entry.toLowerCase().startsWith(TOKEN_PROTOCOL_PREFIX)) {
      if (token === null) {
        const value = entry.slice(TOKEN_PROTOCOL_PREFIX.length);
        if (value.length > 0) token = decodeProtocolTokenValue(value);
      }
      continue;
    }
    nonTokenEntries.push(entry);
  }

  let protocol = nonTokenEntries.find(
    (entry) => entry.toLowerCase() === WS_SUBPROTOCOL,
  );
  if (protocol === undefined) protocol = nonTokenEntries[0];
  if (protocol === undefined) protocol = WS_SUBPROTOCOL;

  return { token, protocol };
}

/**
 * 从 URL query 解析 token —— **兼容旧客户端，deprecated**。
 *
 * 这条路正是要消除的东西：`?token=` 会进反代日志/浏览器历史/Referer/上报。
 * 保留它只是为了灰度期不把旧标签页踹掉；`deprecated: true` 明确标记来源，
 * 调用方（createVerifyClient）据此打一次告警。正式版应把
 * `allowQueryFallback` 关掉。
 *
 *   '/ws?token=x'                -> { token: 'x', deprecated: true,  source: 'query' }
 *   '/ws?a=1&token=x%2By&b=2'    -> { token: 'x+y', ... }（searchParams 负责解码）
 *   '/ws'、'/ws?token='          -> { token: null, deprecated: false, source: 'query' }
 *
 * @param {string|undefined|null} url 完整 URL 或 `req.url`（相对形式也可以）
 * @returns {{ token: string|null, deprecated: boolean, source: 'query' }}
 */
export function parseTokenFromQuery(url) {
  const miss = { token: null, deprecated: false, source: 'query' };
  if (typeof url !== 'string' || url.length === 0) return miss;

  let params;
  try {
    // base 只是为了能把 '/ws?token=x' 这种相对形式交给 URL 解析。
    params = new URL(url, 'http://localhost').searchParams;
  } catch {
    return miss;
  }

  const value = params.get(DEPRECATED_QUERY_PARAM);
  if (typeof value !== 'string' || value.length === 0) return miss;

  return { token: value, deprecated: true, source: 'query' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 比较
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 常量时间字符串比较。
 *
 * 为什么不用 `a === b`：JS 的字符串比较在第一个不同字节处就短路返回，耗时随
 * "公共前缀长度"变化，逐字节可以把 token 一位一位猜出来（时序侧信道）。这里先
 * 把两边各自 sha256 成定长摘要再 `timingSafeEqual`，比较耗时与输入长度、内容
 * 都无关；长度差异单独用 XOR 折进结果（不短路），所以"长度不同"也不会提前返回。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  const sameDigest = timingSafeEqual(digestA, digestB);
  const lengthDiff = a.length ^ b.length;
  return sameDigest && lengthDiff === 0;
}

/**
 * 判断 token 是否有效。`compare` 可注入（单测里换成恒等函数便于观测调用）。
 *
 * 空/非字符串一律 invalid —— `''  ===  ''` 这种"两边都空就算过"是最经典的
 * 鉴权后门，这里显式挡掉：expected 为空等于服务端没配 token，任何请求都不放行。
 *
 * @param {unknown} token 客户端提交的 token
 * @param {unknown} expected 服务端期望的 token
 * @param {(a: string, b: string) => boolean} [compare] 比较函数，默认常量时间比较
 * @returns {boolean}
 */
export function isTokenValid(token, expected, compare = timingSafeCompare) {
  if (typeof token !== 'string' || token.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof compare !== 'function') return false;
  try {
    return compare(token, expected) === true;
  } catch {
    // 比较函数自己抛错（含 timingSafeEqual 的长度不匹配），一律当无效。
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定（纯函数，便于直接单测 / index.js 在 upgrade 里同步用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判定一次升级请求是否放行。不做 I/O、不打日志，把结果交给调用方决定。
 *
 * @param {{ headers?: object, url?: string }|null|undefined} req
 * @param {{ expectedToken?: string, allowQueryFallback?: boolean }} [options]
 * @returns {{
 *   ok: boolean,
 *   token: string|null,
 *   source: 'protocol'|'query'|null,
 *   protocol: string,
 *   deprecated: boolean,
 *   reason: 'ok'|'query-fallback'|'bad-protocol-token'|'no-token'
 * }}
 */
export function evaluateUpgradeRequest(req, options = {}) {
  const { expectedToken, allowQueryFallback = true } = options;
  const headers = (req && req.headers) || {};
  const protocolAuth = parseTokenFromProtocolHeader(headers['sec-websocket-protocol']);

  if (protocolAuth.token !== null && isTokenValid(protocolAuth.token, expectedToken)) {
    return {
      ok: true,
      token: protocolAuth.token,
      source: 'protocol',
      protocol: protocolAuth.protocol,
      deprecated: false,
      reason: 'ok',
    };
  }

  const hadProtocolToken = protocolAuth.token !== null;

  if (allowQueryFallback) {
    const queryAuth = parseTokenFromQuery(req && req.url);
    if (queryAuth.token !== null && isTokenValid(queryAuth.token, expectedToken)) {
      return {
        ok: true,
        token: queryAuth.token,
        source: 'query',
        protocol: protocolAuth.protocol,
        deprecated: true,
        reason: 'query-fallback',
      };
    }
  }

  return {
    ok: false,
    token: null,
    source: hadProtocolToken ? 'protocol' : null,
    protocol: protocolAuth.protocol,
    deprecated: false,
    reason: hadProtocolToken ? 'bad-protocol-token' : 'no-token',
  };
}

/**
 * 生成 ws 的 `verifyClient` 风格函数：`(info, cb) => void`。
 *
 * 优先级：协议头有效 -> 放行；协议头无效/缺失且 allowQueryFallback -> 再看 query；
 * 两者都不行 -> `cb(false, 401, 'Unauthorized')`（ws 据此 abortHandshake，不升级）。
 *
 * 放行时会在 `info.req` 上标注：
 *   - `req.wsToken`        实际生效的 token（供后续 handler 复用，避免二次解析）
 *   - `req.wsTokenSource`  'protocol' | 'query'
 * `info` 也可以直接传 req 本身（没有 `info.req` 包装时按 req 处理），方便在
 * `server.on('upgrade')` 里早于 handleUpgrade 做门禁。
 *
 * 日志纪律：只打 pathname（query 已剥掉），绝不带 token；query 回退只告警一次，
 * 避免每个重连都刷一行。
 *
 * @param {{ expectedToken?: string, allowQueryFallback?: boolean, logger?: object|null }} [config]
 * @returns {(info: any, cb?: (ok: boolean, code?: number, message?: string) => void) => boolean}
 */
export function createVerifyClient(config = {}) {
  const {
    expectedToken,
    allowQueryFallback = true,
    logger = console,
  } = config;

  let legacyQueryWarned = false;

  return function verifyClient(info, cb) {
    const req =
      info !== null && typeof info === 'object' && info.req !== undefined ? info.req : info;

    const outcome = evaluateUpgradeRequest(req, { expectedToken, allowQueryFallback });

    if (outcome.ok) {
      // 把结果挂到 req 上，后续 handler 直接复用，不用再解析一遍头。
      if (req !== null && typeof req === 'object') {
        try {
          req.wsToken = outcome.token;
          req.wsTokenSource = outcome.source;
          req.wsProtocol = outcome.protocol;
        } catch {
          // req 被冻结（理论上不该发生）也不影响放行。
        }
      }

      if (outcome.source === 'query' && !legacyQueryWarned) {
        legacyQueryWarned = true;
        logSafely(
          logger,
          'warn',
          `[ws-auth] websocket token came from the deprecated "${DEPRECATED_QUERY_PARAM}" query `
            + `parameter on ${safePath(req)} — a query credential leaks into proxy access logs `
            + 'and browser history. Upgrade the client to the Sec-WebSocket-Protocol transport.',
        );
      }

      if (typeof cb === 'function') cb(true);
      return true;
    }

    logSafely(
      logger,
      'warn',
      `[ws-auth] rejected websocket upgrade on ${safePath(req)} (${outcome.reason}); `
        + 'no valid token in Sec-WebSocket-Protocol'
        + (allowQueryFallback ? ' or query string.' : ' (query fallback disabled).'),
    );

    if (typeof cb === 'function') cb(false, REJECT_STATUS, 'Unauthorized');
    return false;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 子协议回显
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 服务端要回显的子协议值：只可能是 `openlog.v1`（保留客户端原始大小写），否则 null。
 *
 * 关键：**绝不会**返回 `token.<token>`。回显 token 那一段等于把凭证写进 101 响应头，
 * 反代/抓包/错误快照一样能捞到，等于白改。
 *
 * @param {string|string[]|undefined|null} headerValue 请求里的 Sec-WebSocket-Protocol
 * @returns {string|null}
 */
export function selectResponseProtocol(headerValue) {
  const entries = toProtocolList(headerValue);
  const match = entries.find((entry) => entry.toLowerCase() === WS_SUBPROTOCOL);
  return match === undefined ? null : match;
}

/**
 * 生成 ws 的 `handleProtocols(protocols, request)` 回调。
 *
 * `protocols` 是 ws 解析出来的 `Set<string>`（也可能是逗号分隔的字符串，两种都吃）。
 * 返回匹配到的 `openlog.v1`；一个都不匹配时返回 `undefined` —— ws 会省略
 * `Sec-WebSocket-Protocol` 响应头，连接照常建立（服务器没有可回显的值时这是唯一
 * 安全选择）。
 *
 * @returns {(protocols: Set<string>|string|undefined|null, request?: unknown) => string|undefined}
 */
export function createHandleProtocols() {
  return function handleProtocols(protocols, request) { // eslint-disable-line no-unused-vars
    const entries = protocols instanceof Set ? Array.from(protocols) : toProtocolList(protocols);
    const match = entries.find(
      (entry) => typeof entry === 'string' && entry.toLowerCase() === WS_SUBPROTOCOL,
    );
    return match === undefined ? undefined : match;
  };
}
