/**
 * 把任意抛出物转成一句**永远不会是空字符串**的错误说明。
 *
 * 事故背景：全项目有 86 处 `res.status(500).json({ error: err.message })`。
 * 但最常见的失败 —— 连不上 Docker / SSH 主机 —— 抛的是 Node 的 AggregateError：
 *
 *     const e = new AggregateError([...], '');   // ← message 就是空串
 *     e.message      // ""
 *     e.code         // "ECONNREFUSED"
 *     e.errors       // [Error: connect ECONNREFUSED ::1:2375,
 *                    //  Error: connect ECONNREFUSED 127.0.0.1:2375]
 *
 * 结果 API 返回 `{"error":""}`，前端弹出**一片空白**的提示，
 * 而真正有用的信息（ECONNREFUSED、端口、地址）全被丢掉了。
 *
 * 所以这里按 message → errors[] → cause → code → errno → 构造器名 的顺序取值，
 * 并保证：对任何输入都返回非空字符串。
 */

/** 兜底文案。绝不返回空串是本模块的核心契约。 */
export const UNKNOWN_ERROR = '未知错误';

/** 子错误消息最多拼接几条，避免把一堆信息塞进前端 toast。 */
const MAX_PARTS = 3;

/** 单条消息最长保留多少字符。 */
const MAX_LENGTH = 300;

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** 递归收集一个错误对象里所有可用的文案（含嵌套的 errors / cause）。 */
function collect(err, out, depth) {
  if (depth > 3 || err === null || err === undefined) return;

  if (typeof err === 'string') {
    const s = nonEmptyString(err);
    if (s) out.push(s);
    return;
  }
  if (typeof err !== 'object') {
    out.push(String(err));
    return;
  }

  const own = nonEmptyString(err.message);
  if (own) out.push(own);

  // AggregateError：真正的内容在 errors[]
  if (Array.isArray(err.errors)) {
    for (const sub of err.errors) collect(sub, out, depth + 1);
  }
  // Error 链：cause 里可能是真正的原因
  if (err.cause) collect(err.cause, out, depth + 1);
}

/** 去重 + 限条数 + 限长度。 */
function tidy(parts) {
  const seen = new Set();
  const kept = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    kept.push(s);
    if (kept.length >= MAX_PARTS) break;
  }
  let text = kept.join('; ');
  if (text.length > MAX_LENGTH) text = text.slice(0, MAX_LENGTH - 1) + '…';
  return text;
}

/**
 * @param {unknown} err 任意抛出物（Error / AggregateError / string / 任意值）
 * @returns {string} 非空的错误说明
 */
export function errorMessage(err) {
  if (err === null || err === undefined) return UNKNOWN_ERROR;

  if (typeof err === 'string') return nonEmptyString(err) || UNKNOWN_ERROR;
  if (typeof err !== 'object') return String(err) || UNKNOWN_ERROR;

  const parts = [];
  collect(err, parts, 0);

  // message / errors / cause 全都没有内容时，退到错误码 ——
  // ECONNREFUSED、ETIMEDOUT、ENOTFOUND 这些本身就有诊断价值。
  if (parts.length === 0) {
    const code = nonEmptyString(err.code);
    if (code) return code;
    if (typeof err.errno === 'number') return `errno ${err.errno}`;
    const status = err.statusCode ?? err.status;
    if (typeof status === 'number') return `HTTP ${status}`;
  }

  const text = tidy(parts);
  if (text) return text;

  // 最后兜底：至少把类型名给出来，便于定位。
  const name = err.constructor?.name;
  return name && name !== 'Object' ? name : UNKNOWN_ERROR;
}

export default errorMessage;

/**
 * 瞬时网络错误码。
 *
 * 这些是 socket 层的 I/O 失败，**不涉及应用逻辑**，因此不可能让内存里的状态
 * 进入不一致状态 —— 与「未知异常可能已破坏状态、必须重启」是两回事。
 *
 * 实测事故：SSH 连接空闲读超时抛 ETIMEDOUT，经 ssh2 的
 * `this.emit('error', err)`（当时该 Client 上零个 error 监听者）升级成
 * uncaughtException，整个监控面板退出。根因在 server/ssh-guard.js 修掉，
 * 这里是不依赖任何单个调用点是否记得挂监听的兜底。
 */
export const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
]);

/**
 * 是否属于「可安全继续运行」的瞬时网络错误。
 *
 * 刻意收得很紧：必须同时满足
 *   1. code 在白名单里
 *   2. 明确来自 socket（level 为 client/server-socket，或带 syscall）
 * 这样应用逻辑自己抛的同码错误仍然走退出路径，不会掩盖真 bug。
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientNetworkError(err) {
  if (!err || typeof err !== 'object') return false;
  if (!TRANSIENT_NETWORK_CODES.has(err.code)) return false;
  return err.level === 'client-socket' || err.level === 'server-socket' || err.syscall !== undefined;
}
