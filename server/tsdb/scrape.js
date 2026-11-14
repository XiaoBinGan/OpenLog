/**
 * 抓取器 —— Prometheus 的 pull 模型。
 *
 * 核心循环：按 interval 对每个 target 发 HTTP GET，解析文本格式，写进 TSDB。
 *
 * 与 Prometheus 对齐的几条语义：
 *
 *   · **up 指标**：每次抓取都产出一条 `up{job,instance}`，成功为 1、失败为 0。
 *     这是 Prometheus 里最重要的一条指标 —— 所有「目标是否活着」的告警都基于它。
 *     少了它，目标挂掉时你只会看到「数据停止更新」，而无法区分「挂了」和「没数据」。
 *
 *   · **scrape_duration_seconds**：抓取耗时，用于发现慢 exporter。
 *
 *   · **超时**：单次抓取有硬超时，超时按失败处理并记 up=0。不设超时会占据
 *     整个调度周期，慢目标把快目标挤掉。
 *
 *   · **不重叠**：上一轮没结束就跳过本轮（与 deploy 的 db-sampler 同一取舍）。
 *     用 setTimeout 链而不是 setInterval —— setInterval 会堆积并发。
 */

import { parseExposition } from './exposition.js';

/** 默认抓取间隔（毫秒） */
export const DEFAULT_SCRAPE_INTERVAL_MS = 15_000;
/** 默认超时 */
export const DEFAULT_SCRAPE_TIMEOUT_MS = 10_000;
/** 单个响应体上限：防止一个坏 exporter 吐几个 G 把内存打爆 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * 校验抓取配置。
 *
 * @param {object} cfg
 * @param {Array<{job:string, targets:string[], metricsPath?:string, interval?:string}]} cfg.scrapeConfigs
 * @returns {{ configs: Array<object>, errors: Array<string> }}
 */
export function normalizeScrapeConfigs(cfg) {
  const errors = [];
  const configs = [];
  const raw = cfg && Array.isArray(cfg.scrapeConfigs) ? cfg.scrapeConfigs : [];

  raw.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`scrapeConfigs[${idx}] 不是对象`);
      return;
    }
    const job = String(entry.job || '').trim();
    if (!job) {
      errors.push(`scrapeConfigs[${idx}] 缺少 job 名`);
      return;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(job)) {
      errors.push(`scrapeConfigs[${idx}] 的 job 名非法: ${job}`);
      return;
    }
    const targets = (Array.isArray(entry.targets) ? entry.targets : [])
      .map((t) => String(t || '').trim())
      .filter(Boolean);
    if (targets.length === 0) {
      errors.push(`scrapeConfigs[${idx}] (${job}) 没有 target`);
      return;
    }
    const bad = targets.filter((t) => !/^https?:\/\//i.test(t));
    if (bad.length) {
      errors.push(`scrapeConfigs[${idx}] (${job}) 的 target 必须以 http:// 或 https:// 开头: ${bad.join(', ')}`);
      return;
    }
    const path = String(entry.metricsPath || '/metrics');
    if (!path.startsWith('/')) {
      errors.push(`scrapeConfigs[${idx}] (${job}) 的 metricsPath 必须以 / 开头`);
      return;
    }
    const intervalMs = entry.interval ? String(entry.interval) : null;
    // 鉴权：很多 /metrics 端点不是公开的（OpenLog 自己就是）。
    // 支持 bearer token 与 basic auth，对应 Prometheus 的
    // `authorization: {credentials: ...}` 和 `basic_auth`。
    const auth = normalizeAuth(entry);
    if (auth && auth.error) {
      errors.push(`scrapeConfigs[${idx}] (${job}) ${auth.error}`);
      return;
    }
    configs.push({
      job,
      targets,
      metricsPath: path,
      intervalMs: intervalMs ? parseDurationLoose(intervalMs) : null,
      labels: entry.labels && typeof entry.labels === 'object' ? entry.labels : {},
      timeoutMs: entry.timeout ? parseDurationLoose(String(entry.timeout)) : null,
      auth: auth && auth.value ? auth.value : null,
    });
  });

  return { configs, errors };
}

/** 宽松的时长解析：接受 `15s` / `1m` / 纯数字（当毫秒） */
function parseDurationLoose(s) {
  const str = String(s).trim();
  if (/^\d+$/.test(str)) return Number(str);
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(str);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return n * unit;
}

/**
 * 归一化鉴权配置。
 *
 * 支持两种写法：
 *   { "bearerToken": "xxx" }
 *   { "basicAuth": { "username": "u", "password": "p" } }
 *
 * 为什么要支持：OpenLog 自己的 /metrics 就在鉴权后面（这是对的 ——
 * 暴露内存/磁盘/容器数量给未认证的人没好处）。抓取器不带凭据就只能抓 401，
 * 而 401 的表现是「up=0 但没有其它线索」，非常难查。
 *
 * @returns {{value?:{type:string, token?:string, username?:string, password?:string}, error?:string}|null}
 */
function normalizeAuth(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.bearerToken) {
    return { value: { type: 'bearer', token: String(entry.bearerToken) } };
  }
  const ba = entry.basicAuth;
  if (ba && typeof ba === 'object') {
    if (!ba.username) return { error: 'basicAuth 缺少 username' };
    return {
      value: {
        type: 'basic',
        username: String(ba.username),
        password: String(ba.password ?? ''),
      },
    };
  }
  return null;
}

/**
 * 从 target URL 里抽出 instance 标签。
 * Prometheus 的约定是 `host:port`（去掉 scheme 与 path）。
 */
export function instanceFromUrl(url) {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname}:${port}`;
  } catch {
    return String(url);
  }
}

/** 把 metricsPath 拼到 target 上 */
export function joinTargetUrl(target, metricsPath) {
  const base = String(target).replace(/\/+$/, '');
  const path = String(metricsPath || '/metrics');
  return base + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * 抓一个目标。
 *
 * @param {object} target
 * @param {string} target.url 完整 URL
 * @param {string} target.job
 * @param {object} [target.extraLabels]
 * @param {number} [target.timeoutMs]
 * @param {number} [time] 抓取时刻（毫秒），用作所有样本的时间戳
 * @param {Function} [fetchImpl] 注入 fetch（测试用）
 * @returns {Promise<{ ok:boolean, samples:Array, up:number, durationMs:number, error?:string, samplesCount:number }>}
 */
export async function scrapeTarget(target, time, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const started = Date.now();
  const ts = Number.isFinite(time) ? Number(time) : started;
  const timeoutMs = Number(target.timeoutMs) > 0 ? Number(target.timeoutMs) : DEFAULT_SCRAPE_TIMEOUT_MS;

  const instance = target.instance || instanceFromUrl(target.url);
  const baseLabels = { job: String(target.job || ''), instance, ...(target.extraLabels || {}) };

  const finish = (ok, samples, error, durationMs) => ({
    ok,
    samples,
    up: ok ? 1 : 0,
    durationMs: durationMs ?? (Date.now() - started),
    error: error || null,
    samplesCount: samples.length,
  });

  if (!doFetch) return finish(false, [], 'fetch 不可用（Node < 18 或环境受限）');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 鉴权头：不带凭据去抓受保护的 /metrics 只会拿到 401，
  // 而 401 在 up=0 时看不出区别 —— 所以宁可显式配置也不猜。
  const headers = { Accept: 'text/plain;version=0.0.4', 'User-Agent': 'OpenLog-TSDB/1.0' };
  const auth = target.auth;
  if (auth && auth.type === 'bearer' && auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  } else if (auth && auth.type === 'basic' && auth.username) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password ?? ''}`).toString('base64')}`;
  }

  try {
    const res = await doFetch(target.url, {
      signal: controller.signal,
      headers,
      redirect: 'follow',
    });

    if (!res.ok) {
      // 401/403 单独提示，否则用户只会看到「HTTP 401」而不知道要配凭据
      const hint = res.status === 401 || res.status === 403
        ? '（该端点需要鉴权，请在 scrapeConfigs 里配 bearerToken 或 basicAuth）'
        : '';
      return finish(false, [], `HTTP ${res.status} ${res.statusText || ''}${hint}`.trim());
    }

    // 内容长度预检，避免把超大响应读进内存
    const lenHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
      return finish(false, [], `响应体过大: ${lenHeader} 字节`);
    }

    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      return finish(false, [], `响应体过大: ${text.length} 字节`);
    }

    const parsed = parseExposition(text);
    // 抓取到的指标统一加 job/instance（以及配置里的额外标签），
    // 但**不覆盖** exporter 自己导出的同名标签 —— 目标比我更清楚它是什么
    const samples = [];
    for (const s of parsed.samples) {
      const labels = { ...baseLabels, ...s.labels };
      samples.push({ name: s.name, labels, value: s.value, timestamp: ts });
    }

    return finish(true, samples, parsed.errors.length ? `${parsed.errors.length} 行解析失败` : null);
  } catch (err) {
    const msg = err && err.name === 'AbortError'
      ? `抓取超时 (${timeoutMs}ms)`
      : String(err?.message || err);
    return finish(false, [], msg);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 创建抓取调度器。
 *
 * @param {object} deps
 * @param {{writeSamples:Function}} deps.store
 * @param {() => Array} deps.getTargets 返回当前 target 列表
 * @param {() => number} [deps.now]
 * @param {Function} [deps.fetchImpl]
 * @param {(evt:object) => void} [deps.onEvent] 事件回调（日志/指标）
 */
export function createScraper(deps = {}) {
  const store = deps.store;
  const getTargets = deps.getTargets || (() => []);
  const now = deps.now || (() => Date.now());
  const fetchImpl = deps.fetchImpl;
  const onEvent = deps.onEvent || (() => {});

  let timer = null;
  let running = false;
  let stopped = true;
  /** 每个目标的最近一次抓取结果，供 /api/v1/targets 展示 */
  const lastResults = new Map();
  /** 累计统计 */
  const stats = { rounds: 0, scrapes: 0, failures: 0, samples: 0, lastRoundMs: null, lastError: null };

  /** 抓一轮（所有 target 并发） */
  async function scrapeOnce() {
    const targets = getTargets();
    if (!Array.isArray(targets) || targets.length === 0) return { scraped: 0, samples: 0 };

    const ts = now();
    const results = await Promise.all(
      targets.map(async (t) => {
        const key = `${t.job}\u0000${t.url}`;
        const r = await scrapeTarget(t, ts, fetchImpl);
        // up 与 scrape_duration_seconds 是调度器自己产的指标，
        // 不依赖 exporter 是否配合 —— 目标挂掉时也要有
        const baseLabels = { job: String(t.job || ''), instance: t.instance || instanceFromUrl(t.url) };
        const meta = [
          { name: 'up', labels: baseLabels, value: r.up, timestamp: ts },
          { name: 'scrape_duration_seconds', labels: baseLabels, value: r.durationMs / 1000, timestamp: ts },
        ];
        lastResults.set(key, {
          job: String(t.job || ''),
          url: t.url,
          health: r.ok ? 'up' : 'down',
          lastScrapeMs: ts,
          lastDurationMs: r.durationMs,
          lastError: r.error,
          samplesCount: r.samplesCount,
        });
        return { meta, samples: r.samples, ok: r.ok };
      }),
    );

    const all = [];
    let scraped = 0;
    let failures = 0;
    for (const r of results) {
      all.push(...r.meta, ...r.samples);
      scraped += 1;
      if (!r.ok) failures += 1;
    }

    const written = await store.writeSamples(all, { timestamp: ts });
    stats.rounds += 1;
    stats.scrapes += scraped;
    stats.failures += failures;
    stats.samples += written.written || 0;
    stats.lastRoundMs = now();
    stats.lastError = written.error || null;

    if (written.error) onEvent({ type: 'write-error', error: written.error });
    return { scraped, samples: written.written || 0, failures };
  }

  /** 调度循环：setTimeout 链，不重叠 */
  async function tick() {
    if (stopped) return;
    if (running) {
      // 上一轮还没结束 —— 跳过本轮而不是排队
      onEvent({ type: 'skip', reason: '上一轮仍在进行' });
      schedule();
      return;
    }
    running = true;
    try {
      await scrapeOnce();
    } catch (err) {
      stats.lastError = String(err?.message || err);
      onEvent({ type: 'round-error', error: stats.lastError });
    } finally {
      running = false;
    }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    const interval = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : DEFAULT_SCRAPE_INTERVAL_MS;
    timer = setTimeout(() => { tick(); }, interval);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      // 启动立刻抓一轮，不等第一个 interval —— 否则刚部署完有 15s 数据空白
      tick();
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    scrapeOnce,
    /** 目标状态列表（/api/v1/targets） */
    targets() {
      return [...lastResults.values()];
    },
    stats() {
      return { ...stats, running, stopped, targetCount: lastResults.size };
    },
  };
}