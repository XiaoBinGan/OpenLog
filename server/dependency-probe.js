/**
 * server/dependency-probe.js —— 外部依赖拨测（契约 4.9）
 *
 * 动机：LLM 引擎 / Docker socket / SSH 挂掉时，现在只能等用户提问或点按钮才被动暴露。
 * 定时拨测把「可用性」变成一条连续的线，先看曲线再谈工单。
 *
 * 三条硬约束：
 * 1. IO 全注入（fetchImpl / execImpl / now），测试里不产生真实网络、不起真实进程。
 * 2. 目标之间强隔离：DNS 卡死、命令不存在、注入的实现直接 throw，都只污染自己那一行。
 * 3. 超时既 abort 又 race。abort 让真实实现尽快释放连接/杀子进程；race 保证「实现根本
 *    不看 signal」时这一轮照样能结算，不会把整轮拨测挂死。
 */
import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 3000; // 契约默认单目标超时
const HISTORY_LIMIT = 100; // 每目标滚动样本数（最近 100 次）
const TAIL_CHARS = 200; // stderr / message 摘要截断长度
const SELF_ID = 'self'; // 自身拨测在 uptime 里占的 id
const SELF_PATH = '/api/health'; // 自身拨测路径

/**
 * 纯函数：从探针历史算可用率。空历史返回 0 而不是 NaN（页面不能显示 NaN%）。
 * @param {Array<{ ok: boolean }>} history 该目标的滚动样本，旧 → 新
 * @returns {{ ok: number, fail: number, rate: number }} rate 为百分比，保留 1 位小数
 */
export function computeUptime(history) {
  const list = Array.isArray(history) ? history : [];
  let ok = 0;
  let fail = 0;
  for (const item of list) {
    if (!item) continue;
    if (item.ok) ok += 1;
    else fail += 1;
  }
  const total = ok + fail;
  // 先乘 1000 再取整：避免 66.666… 被浮点误差带偏
  const rate = total === 0 ? 0 : Math.round((ok / total) * 1000) / 10;
  return { ok, fail, rate };
}

/**
 * 创建拨测器。
 * @param {object} opts
 * @param {Array<{ id: string, kind: 'http'|'exec', url?: string, command?: string, timeoutMs?: number }>} opts.targets
 *   拨测目标；缺 id 或缺少 url/command 的条目直接跳过（配置写错不该让整轮崩）
 * @param {typeof fetch} [opts.fetchImpl] HTTP 实现，默认 globalThis.fetch
 * @param {(cmd: string, extra?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<string>} [opts.execImpl]
 *   命令实现，默认 execFile；resolve 即退出码 0
 * @param {() => number} [opts.now] 时钟，默认 Date.now（假 timer 可推进）
 * @param {string} [opts.selfUrl] 自身基址，如 http://127.0.0.1:30999，供 probeSelf() 用
 * @returns {{ targets: Array, probeAll: Function, snapshot: Function, probeSelf: Function }}
 */
export function createProbes(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : defaultFetch;
  const execImpl = typeof opts.execImpl === 'function' ? opts.execImpl : defaultExec;
  const selfUrl = typeof opts.selfUrl === 'string' ? opts.selfUrl.replace(/\/+$/, '') : '';

  const targets = (Array.isArray(opts.targets) ? opts.targets : [])
    .filter((t) => t && typeof t.id === 'string' && t.id.length > 0)
    .map((t) => ({ ...t, kind: t.kind === 'exec' ? 'exec' : 'http' }))
    .filter((t) => (t.kind === 'exec' ? Boolean(t.command) : Boolean(t.url)));

  /** @type {Map<string, boolean[]>} 每个目标的滚动 ok/fail 序列（只留最近 100 次） */
  const history = new Map();
  for (const t of targets) history.set(t.id, []);
  let lastResults = []; // 上一轮 probeAll 结果，供 snapshot() 直接读，不用再拨一次

  const elapsed = (startedAt) => Math.max(0, Math.round(now() - startedAt));
  const pickTimeout = (t) => {
    const v = Number(t?.timeoutMs);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
  };

  function record(id, ok) {
    const list = history.get(id) || [];
    list.push(Boolean(ok));
    // 定长滑窗：只留最近 100 次，超出的从头部丢弃，长期运行内存不会缓慢增长
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
    history.set(id, list);
  }

  /** 挂一个「到点就算失败」的 timer；调用方必须在 finally 里 cancel()，否则残留 timer 拖住退出 */
  function makeTimeout(timeoutMs, onTimeout) {
    let timer = null;
    const promise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timer = null;
        reject(onTimeout());
      }, timeoutMs);
    });
    return {
      promise,
      cancel() {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      },
    };
  }

  /** http 拨测：2xx/3xx 算 ok；其余给 `HTTP <status>` 便于定位 */
  async function probeHttp(target) {
    const timeoutMs = pickTimeout(target);
    const startedAt = now();
    const controller = new AbortController();
    // 到点先 abort（真实 fetch 立刻断连），再由 race 结算（对不看 signal 的实现兜底）
    const timeout = makeTimeout(timeoutMs, () => {
      controller.abort();
      return new Error(`timeout after ${timeoutMs}ms`);
    });
    try {
      const response = await Promise.race([
        // 包一层 async：注入的实现如果同步 throw，也会走 catch
        (async () => fetchImpl(target.url, { method: 'GET', signal: controller.signal }))(),
        timeout.promise,
      ]);
      const status = Number(response?.status);
      const code = Number.isFinite(status) ? status : 0;
      const ok = code >= 200 && code < 400;
      await disposeBody(response);
      const out = { id: target.id, kind: 'http', ok, ms: elapsed(startedAt) };
      out.status = code || undefined;
      if (!ok) out.error = `HTTP ${code || 'no-status'}`;
      return out;
    } catch (err) {
      return { id: target.id, kind: 'http', ok: false, ms: elapsed(startedAt), error: messageOf(err) };
    } finally {
      timeout.cancel();
    }
  }

  /** exec 拨测：退出码 0 算 ok；失败给 exitCode + stderr 摘要 */
  async function probeExec(target) {
    const timeoutMs = pickTimeout(target);
    const startedAt = now();
    const controller = new AbortController();
    const timeout = makeTimeout(timeoutMs, () => {
      controller.abort();
      return Object.assign(new Error(`timeout after ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
    });
    try {
      const call = (async () => execImpl(target.command, { timeoutMs, signal: controller.signal }))();
      await Promise.race([call, timeout.promise]);
      return { id: target.id, kind: 'exec', ok: true, ms: elapsed(startedAt) };
    } catch (err) {
      const timedOut = err?.code === 'ETIMEDOUT' || /timeout/i.test(String(err?.message || ''));
      const exitCode =
        typeof err?.code === 'number' ? err.code : typeof err?.exitCode === 'number' ? err.exitCode : null;
      const stderr = tail(err?.stderr);
      // 超时优先报 timeout：此时执行码通常为 null，报 stderr 反而误导
      const reason = timedOut
        ? `exec timeout after ${timeoutMs}ms`
        : `exec exit ${exitCode ?? 'n/a'}: ${stderr || messageOf(err)}`;
      return { id: target.id, kind: 'exec', ok: false, ms: elapsed(startedAt), exitCode, error: reason };
    } finally {
      timeout.cancel();
    }
  }

  /**
   * 并发拨测全部目标，永不 reject。
   * @returns {Promise<Array<{ id: string, kind: string, ok: boolean, ms: number, error?: string }>>}
   */
  async function probeAll() {
    // 为什么用 allSettled 而不是 all：一个依赖挂了不能把整轮拨测打挂。
    // 单个 probeX 内部已经 try/catch，正常不会 reject；allSettled 是兜底层 —— 就算将来有人
    // 往这里加了个会抛的探针，其余目标的结果照样交得出去，接口永远有一份可显示的快照。
    const settled = await Promise.allSettled(targets.map((t) => (t.kind === 'exec' ? probeExec(t) : probeHttp(t))));
    const results = settled.map((item, i) => {
      if (item.status === 'fulfilled') return item.value;
      const t = targets[i] || {};
      return { id: t.id || `#${i}`, kind: t.kind || 'http', ok: false, ms: 0, error: messageOf(item.reason) };
    });
    for (const r of results) record(r.id, r.ok);
    lastResults = results;
    return results;
  }

  /**
   * 结果快照：上一轮结果 + 每个目标的滚动 uptime（不触发新的拨测）。
   * @returns {{ results: Array<object>, uptime: Record<string, { ok: number, fail: number, rate: number }> }}
   */
  function snapshot() {
    const uptime = {};
    for (const [id, flags] of history) uptime[id] = computeUptime(flags.map((ok) => ({ ok })));
    return { results: lastResults.map((r) => ({ ...r })), uptime };
  }

  /**
   * 拨测自身 /api/health（GET），结果并入 uptime，id 固定 'self'。
   * @returns {Promise<{ id: string, kind: string, ok: boolean, ms: number, error?: string }>}
   */
  async function probeSelf() {
    // 没配 selfUrl 是接线问题，不该算进可用率（否则曲线永远是脏的）
    if (!selfUrl) return { id: SELF_ID, kind: 'http', ok: false, ms: 0, error: 'selfUrl not configured' };
    const result = await probeHttp({ id: SELF_ID, kind: 'http', url: `${selfUrl}${SELF_PATH}` });
    record(SELF_ID, result.ok);
    return result;
  }

  return { targets, probeAll, snapshot, probeSelf };
}

/** 截断到 200 字并压平换行：错误摘要要能塞进一列 UI */
function tail(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, TAIL_CHARS);
}

/** 任意异常 → 可展示的一行文本（timeout 文案要能被 /timeout/ 命中） */
function messageOf(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return tail(err) || 'unknown error';
  return tail(err.message) || String(err);
}

/** 不读 body 也要主动 cancel，否则真实 fetch 的 keep-alive 连接会被一直占着 */
async function disposeBody(response) {
  try {
    if (response?.body && typeof response.body.cancel === 'function') await response.body.cancel();
  } catch {
    /* 关不掉就算了，清理动作不能影响拨测结论 */
  }
}

/** 默认 HTTP 实现（测试一律注入假实现，走不到这里） */
function defaultFetch(url, init) {
  return globalThis.fetch(url, init);
}

/** 默认命令实现：execFile 直接起进程（不经 shell，少一层引号地狱）。resolve 即退出码 0 */
function defaultExec(cmd, extra = {}) {
  return new Promise((resolve, reject) => {
    const parts = splitCommand(cmd);
    if (parts.length === 0) return reject(new Error('empty command'));
    // timeout + signal 双保险：超时真能杀掉子进程，不只是放弃等待
    const spawnOpts = { timeout: extra.timeoutMs || DEFAULT_TIMEOUT_MS, signal: extra.signal, windowsHide: true, maxBuffer: 1 << 20 };
    execFile(parts[0], parts.slice(1), spawnOpts, (err, stdout, stderr) => {
      if (err) {
        if (!err.stderr) err.stderr = String(stderr || ''); // 让上层摘要能拿到 stderr
        return reject(err);
      }
      resolve(String(stdout || ''));
    });
  });
}

/** 极简分词：支持单/双引号成组（`ssh -o "BatchMode=yes" host true`） */
function splitCommand(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of String(cmd || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
