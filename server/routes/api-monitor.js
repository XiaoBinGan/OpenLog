/**
 * server/routes/api-monitor.js —— 接口监控看板 HTTP 面（#12 api-router，契约第 5 节）
 * 只读展示面：把 registry / api-store / route-coverage / dependency-probe 拼成前端能直接渲染的
 * JSON。外层已鉴权，这里不重复鉴权。
 * 为什么所有降级都回 200 而不是 4xx/5xx：
 *  1) 监控自己坏掉时，看板必须还能打开并显示「未启用 / 数据不可用」——这是运维唯一能看出
 *     「为什么没有数据」的入口；这里 500 就白屏，等于把唯一线索也弄丢。
 *  2) 前端秒级轮询 + 整块渲染，4xx/5xx 会触发全局错误提示与重试风暴，反过来压死主服务。
 *  3) 依赖都是注入的、可能为 null（OFF、库没就绪、collectRoutes 未接线），null 是**合法状态**
 *     而不是异常；失败 → 200 + 对应字段 null/[]/unavailable，前端只写一套分支。
 */
import express from 'express';
import { buildCoverage } from '../metrics/route-coverage.js';
const MINUTE_MS = 60_000, HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
const ALERT_WINDOW_MS = 5 * MINUTE_MS; // 规则写的就是「5 分钟内」
const SEEN_ROUTES_CAP = 1000; // seenRoutes 上限：未归一化的随机路径不该把表撑成泄漏
/** 允许的窗口别名 → 毫秒；只认这三档（前端下拉框就三档），其余值一律回退 5m */
export const WINDOW_MS = { '1m': MINUTE_MS, '5m': 5 * MINUTE_MS, '1h': HOUR_MS };
export const DEFAULT_WINDOW = '5m';
export const HISTORY_LIMIT_MAX = 5000; // 与 api-store.queryRange 的内部上限一致
export const HISTORY_DEFAULT_MS = DAY_MS;
export const COVERAGE_WINDOW_DAYS = 7;
/** 告警默认阈值（可调项集中在此，Lead 用 deps.thresholds 覆盖任意一项） */
export const DEFAULT_THRESHOLDS = Object.freeze({
  err5xx: { ratio: 0.05, minCalls: 50 },
  latency: { p95Ms: 2000, minCalls: 20 },
  silent: { windowMs: ALERT_WINDOW_MS },
  rateLimited: { status: 429, minCount: 20 },
});
const numOr = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const asArray = (v) => (Array.isArray(v) ? v : []);
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const msgOf = (e) => String((e && e.message) || e || 'unknown error');
const isObj = (v) => Boolean(v) && typeof v === 'object';
const rkey = (m, r) => `${String(m || 'GET').toUpperCase()} ${r || '/'}`;
const routeLabel = (r) => `${r.method || 'GET'} ${r.route}`;
const parseWindow = (raw) => (Object.prototype.hasOwnProperty.call(WINDOW_MS, String(raw == null ? '' : raw)) ? String(raw) : DEFAULT_WINDOW);
const parseTs = (raw, fb) => { const n = Number(raw); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fb; };
const parseLimit = (raw) => { const n = Number(raw); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), HISTORY_LIMIT_MAX) : 500; };
/** 阈值深合并一层：只覆盖调用方给到的键，其余沿用默认 */
function mergeThresholds(override) {
  const src = isObj(override) ? override : {};
  const out = {};
  for (const id of Object.keys(DEFAULT_THRESHOLDS)) out[id] = { ...DEFAULT_THRESHOLDS[id], ...(isObj(src[id]) ? src[id] : {}) };
  return out;
}
/** 一条规则的可展示描述；fired 决定它进不进 fired[] */
const rule = (id, level, title, detail, meta, fired) => ({ id, level, title, detail, meta, fired: Boolean(fired) });
/**
 * 纯函数：用一份 registry 快照算四条告警规则（无 IO、无时钟、无全局状态）。
 * shadow 只决定「要不要发通知」，**不参与计算**（影子期要能看到「开线上会报什么」）。
 * 数据不足的规则**跳过而不是瞎报**：silent 要历史路由名单（快照按 calls>0 过滤，拿不到 calls=0
 * 的路由），rateLimited 要按状态码计数（快照只给 err4xx 总量，冒充 429 必然误报）→ 缺数据源时
 * meta.skipped=true 且不进 fired[]。
 * @param {object|null} snapshot registry.snapshot() 的返回
 * @param {object} [opts] { thresholds?, shadow?, seenRoutes?, statusCounts? }
 * @returns {{ rules: Array<object>, fired: Array<object>, shadow: boolean }}
 */
export function evaluateAlertRules(snapshot, opts = {}) {
  const th = mergeThresholds(opts.thresholds);
  const snap = isObj(snapshot) ? snapshot : null;
  const routes = asArray(snap && snap.routes);
  const totalCalls = numOr(snap && snap.totalCalls, 0);
  const total5xx = numOr(snap && snap.totalErrors5xx, 0);
  const shadow = opts.shadow === true;
  const rules = [];
  // ① err5xx：两个条件都必须「严格大于」，否则刚够阈值就喊狼来了
  const ratio5xx = totalCalls > 0 ? total5xx / totalCalls : 0;
  rules.push(rule('err5xx', 'error', '5xx 比例过高',
    snap ? `窗口内 5xx ${total5xx} / ${totalCalls}（${(ratio5xx * 100).toFixed(1)}%）` : '注册表不可用，跳过',
    { totalCalls, totalErrors5xx: total5xx, ratio: round4(ratio5xx), ratioLimit: th.err5xx.ratio, minCalls: th.err5xx.minCalls, skipped: !snap },
    Boolean(snap) && ratio5xx > th.err5xx.ratio && totalCalls > th.err5xx.minCalls));
  // ② latency：calls 太少时 p95 不可信，必须同时过 minCalls
  const slow = routes.filter((r) => numOr(r && r.p95) > th.latency.p95Ms && numOr(r && r.calls) > th.latency.minCalls);
  rules.push(rule('latency', 'warning', '路由 p95 超阈值',
    slow.length ? `${slow.length} 条路由 p95 > ${th.latency.p95Ms}ms：${slow.slice(0, 3).map((r) => `${routeLabel(r)}(${Math.round(numOr(r.p95))}ms)`).join('、')}`
      : `无路由 p95 > ${th.latency.p95Ms}ms`,
    { p95Limit: th.latency.p95Ms, minCalls: th.latency.minCalls,
      routes: slow.slice(0, 10).map((r) => ({ method: r.method || 'GET', route: r.route, p95: numOr(r.p95), calls: numOr(r.calls) })) },
    slow.length > 0));
  // ③ silent：曾有流量、当前窗口 0 请求。没有历史名单就跳过，绝不凭「快照里没有」瞎报
  const seen = Array.isArray(opts.seenRoutes) ? opts.seenRoutes.filter((s) => s && s.route) : null;
  const liveKeys = new Set(routes.map((r) => rkey(r && r.method, r && r.route)));
  const silent = seen === null || seen.length === 0 ? null : seen.filter((s) => !liveKeys.has(rkey(s.method, s.route)));
  rules.push(rule('silent', 'warning', '路由静默（曾有流量、当前为 0）',
    silent === null ? '缺少历史路由名单，跳过该规则'
      : (silent.length ? `${silent.length} 条路由静默：${silent.slice(0, 3).map(routeLabel).join('、')}` : '无静默路由'),
    { checked: silent === null ? 0 : seen.length, silentRoutes: silent === null ? [] : silent.slice(0, 10),
      windowMs: th.silent.windowMs, skipped: silent === null },
    silent !== null && silent.length > 0));
  // ④ rateLimited：429 次数。数据源缺失时跳过，绝不用 err4xx 总量顶替
  const counts = isObj(opts.statusCounts) ? opts.statusCounts : (isObj(snap && snap.statusCounts) ? snap.statusCounts : null);
  const c429 = counts ? numOr(counts[th.rateLimited.status] ?? counts[String(th.rateLimited.status)], 0) : null;
  rules.push(rule('rateLimited', 'warning', '429 限流次数过多',
    c429 === null ? '快照不含按状态码计数，跳过该规则' : `429 共 ${c429} 次（阈值 ${th.rateLimited.minCount}）`,
    { status: th.rateLimited.status, count: c429, minCount: th.rateLimited.minCount, skipped: c429 === null },
    c429 !== null && c429 > th.rateLimited.minCount));
  return { rules, fired: rules.filter((r) => r.fired), shadow };
}
/**
 * 创建接口监控路由（挂在根上，路径自带 /api/monitor 前缀，同 routes/monitor.js）。
 * @param {object} deps { registry?, store?, probes?, collectRoutes?, app?, enabled?, now?,
 *   thresholds?, dropped?, lastFlushAt?, seenRoutes?, statusCounts? }；enabled 默认
 *   `OPENLOG_METRICS !== 'off'`，每次请求现读，所以热切换立刻生效。
 * @returns {import('express').Router}
 */
export function createApiMonitorRouter(deps = {}) {
  const registry = deps.registry || null;
  const store = deps.store || null;
  const probes = deps.probes || null;
  const collectRoutes = typeof deps.collectRoutes === 'function' ? deps.collectRoutes : null;
  const targetApp = deps.app || null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const enabledFn = typeof deps.enabled === 'function' ? deps.enabled : () => process.env.OPENLOG_METRICS !== 'off';
  const seenRoutes = new Map(); // 'METHOD route' -> lastSeenMs：silent 规则的历史名单
  const router = express.Router();
  /** 开关：enabled() 自己炸了就当关（宁可少报，不能让看板挂掉） */
  const isOn = () => { try { return Boolean(enabledFn()); } catch { return false; } };
  /** 快照降级：registry 为 null / 抛错 → snapshot=null，调用方把相关字段写成 null 或 [] */
  function takeSnapshot(windowMs) {
    if (!registry || typeof registry.snapshot !== 'function') return { snapshot: null, reason: 'registry' };
    try {
      const s = registry.snapshot({ windowMs });
      return isObj(s) ? { snapshot: s, reason: null } : { snapshot: null, reason: 'registry' };
    } catch { return { snapshot: null, reason: 'registry.snapshot' }; }
  }
  /** 存储统计降级：失败给 null（不拿「0 行」冒充很干净，那会误导排障） */
  async function takeStorage() {
    if (!store || typeof store.stats !== 'function') return { value: null, reason: 'store' };
    try { return { value: await store.stats(), reason: null }; } catch { return { value: null, reason: 'store.stats' }; }
  }
  /** 记住本轮看到的路由，下一轮才能判断「谁静默了」（进程重启后自然从头积累） */
  function remember(snapshot) {
    const ts = now();
    for (const r of asArray(snapshot && snapshot.routes)) {
      if (r && r.route && numOr(r.calls) > 0) seenRoutes.set(rkey(r.method, r.route), ts);
    }
    while (seenRoutes.size > SEEN_ROUTES_CAP) {
      const first = seenRoutes.keys().next();
      if (first.done) break;
      seenRoutes.delete(first.value); // 淘汰最早插入的：Map 保序，够用且 O(1)
    }
  }
  /** 历史名单：deps.seenRoutes 优先（可接落库），否则用本路由自己攒的内存表 */
  function resolveSeen() {
    try {
      if (typeof deps.seenRoutes === 'function') { const v = deps.seenRoutes(); if (Array.isArray(v)) return v; }
      else if (Array.isArray(deps.seenRoutes)) return deps.seenRoutes;
    } catch { /* 注入实现炸了就退回内存表，告警不能用不了 */ }
    return [...seenRoutes.keys()].map((k) => {
      const i = k.indexOf(' ');
      return { method: k.slice(0, i), route: k.slice(i + 1) };
    });
  }
  function readStatusCounts(snapshot) {
    try {
      if (typeof deps.statusCounts === 'function') return deps.statusCounts() || null;
      if (isObj(deps.statusCounts)) return deps.statusCounts;
    } catch { /* 落到快照自带的 */ }
    return isObj(snapshot && snapshot.statusCounts) ? snapshot.statusCounts : null;
  }
  function readDropped() {
    try {
      const d = deps.dropped;
      if (typeof d === 'function') return numOr(d(), 0);
      if (isObj(d)) return numOr(d.dropped, 0);
      return numOr(d, 0);
    } catch { return 0; }
  }
  function readLastFlushAt() {
    try {
      if (typeof deps.lastFlushAt === 'function') return numOrNull(deps.lastFlushAt());
      return numOrNull(deps.lastFlushAt);
    } catch { return null; }
  }
  /** 空壳响应：字段名与正常响应一致，前端只写一套渲染分支 */
  const emptySummary = (window, reason) => ({ enabled: true, window, windowMs: WINDOW_MS[window],
    qps: null, errorRate: null, totalCalls: null, routes: [], slowest: [], errorTop: [],
    dropped: 0, droppedRoutes: null, storage: null, unavailable: [reason] });
  /** 注册 GET 并兜住一切异常：handler 抛错也只是降级响应，永不 500 */
  function get(path, handler, degraded) {
    router.get(path, (req, res) => Promise.resolve().then(() => handler(req, res))
      .catch(() => (res.headersSent ? undefined : res.status(200).json(degraded(req)))));
  }
  // ① 概览：qps / errorRate / 路由表 / 慢路由 / 错误榜 / 存储
  get('/api/monitor/api', async (req, res) => {
    if (!isOn()) return res.status(200).json({ enabled: false });
    const window = parseWindow(req.query && req.query.window);
    const askedMs = WINDOW_MS[window];
    const { snapshot, reason } = takeSnapshot(askedMs);
    remember(snapshot);
    const storage = await takeStorage();
    // windowMs 回显 registry 真正用的值（它会把窗口钳到自己的 retention，别骗前端）
    return res.status(200).json({
      enabled: true, window, windowMs: snapshot ? numOr(snapshot.windowMs, askedMs) : askedMs,
      qps: snapshot ? numOr(snapshot.qps, 0) : null,
      errorRate: snapshot ? numOr(snapshot.errorRate, 0) : null,
      totalCalls: snapshot ? numOr(snapshot.totalCalls, 0) : null,
      routes: asArray(snapshot && snapshot.routes),
      slowest: asArray(snapshot && snapshot.slowest),
      errorTop: asArray(snapshot && snapshot.errorTop),
      dropped: readDropped(),
      droppedRoutes: snapshot ? numOr(snapshot.droppedRoutes, 0) : null,
      storage: storage.value,
      // 这些数字是**内存滑窗**里的，进程重启就从 0 重新累计。
      // 不写清楚，用户会拿它跟 api_metrics_minute 的历史行对不上，
      // 以为面板在编数 —— 真实原因只是「内存 vs 落库」两个数据源。
      sinceMs: Date.now() - Math.round(process.uptime() * 1000),
      source: 'memory',
      unavailable: [reason, storage.reason].filter(Boolean),
    });
  }, (req) => emptySummary(parseWindow(req.query && req.query.window), 'handler'));
  // ② 历史：区间查询落库数据，route 可选精确匹配
  get('/api/monitor/api/history', async (req, res) => {
    if (!isOn()) return res.status(200).json({ enabled: false });
    const q = req.query || {};
    const toMs = parseTs(q.to, now());
    const fromMs = Math.min(parseTs(q.from, toMs - HISTORY_DEFAULT_MS), toMs);
    const limit = parseLimit(q.limit);
    const route = typeof q.route === 'string' && q.route !== '' ? q.route : null;
    let rows = [], reason = null;
    if (!store || typeof store.queryRange !== 'function') reason = 'store';
    else { try { rows = asArray(await store.queryRange({ fromMs, toMs, route, limit })); } catch { reason = 'store.queryRange'; } }
    return res.status(200).json({ enabled: true, from: fromMs, to: toMs, limit, route, rows, unavailable: reason ? [reason] : [] });
  }, () => ({ enabled: true, from: null, to: null, limit: 500, route: null, rows: [], unavailable: ['handler'] }));
  // ③ 告警：只算不发（通知走既有通道；shadow=1 时结论同样只回给调用方）
  get('/api/monitor/api/alerts', async (req, res) => {
    if (!isOn()) return res.status(200).json({ enabled: false });
    const shadow = String((req.query && req.query.shadow) ?? '') === '1';
    const { snapshot, reason } = takeSnapshot(ALERT_WINDOW_MS);
    remember(snapshot);
    const out = evaluateAlertRules(snapshot, { thresholds: deps.thresholds, shadow, seenRoutes: resolveSeen(), statusCounts: readStatusCounts(snapshot) });
    return res.status(200).json({
      enabled: true, shadow, windowMs: snapshot ? numOr(snapshot.windowMs, ALERT_WINDOW_MS) : ALERT_WINDOW_MS,
      rules: out.rules, fired: out.fired, unavailable: reason ? [reason] : [],
    });
  }, () => ({ enabled: true, shadow: false, windowMs: ALERT_WINDOW_MS, rules: [], fired: [], unavailable: ['handler'] }));
  // ④ 覆盖率：接口清单（活的路由栈）× 7 天落库流量
  get('/api/monitor/coverage', async (req, res) => {
    if (!isOn()) return res.status(200).json({ enabled: false });
    const toMs = now();
    const fromMs = toMs - COVERAGE_WINDOW_DAYS * DAY_MS;
    const fail = (reason) => res.status(200).json({ enabled: true, available: false, reason, windowDays: COVERAGE_WINDOW_DAYS });
    if (!collectRoutes) return fail('collectRoutes 未接线'); // 「没接线」绝不报成 0% 覆盖率
    let inventory;
    try {
      inventory = collectRoutes(targetApp);
      if (!Array.isArray(inventory)) throw new Error('collectRoutes 返回值不是数组');
    } catch (err) { return fail(msgOf(err)); }
    // 清单为空几乎只可能是「没把 app 传进来」：报 0% 会让人以为所有接口都没人调
    if (inventory.length === 0) return fail('接口清单为空（deps.app 是否未接线？）');
    let traffic = [], reason = null;
    if (!store || typeof store.queryRange !== 'function') reason = 'store';
    else {
      try {
        // 分钟桶行摊成 buildCoverage 认识的形状：lastSeen 取桶时间最大值，让报表这一列真有值
        traffic = asArray(await store.queryRange({ fromMs, toMs, limit: HISTORY_LIMIT_MAX })).map((r) => ({
          method: r && r.method, route: r && r.route, calls: numOr(r && r.calls), lastSeenMs: numOrNull(r && r.bucketMs),
        }));
      } catch { reason = 'store.queryRange'; }
    }
    // 补上「内存里还没落库的这一分钟」：否则刚启动的那一分钟里覆盖率会假报 0
    // （分钟桶每 60s 才写一次，而那正是用户最想确认「监控到底通不通」的时候）
    const liveRes = takeSnapshot(COVERAGE_WINDOW_DAYS * DAY_MS);
    const live = liveRes.snapshot;
    if (live) {
      const index = new Map(traffic.map((r) => [`${String(r.method).toUpperCase()} ${r.route}`, r]));
      for (const r of asArray(live.routes)) {
        const key = `${String(r.method).toUpperCase()} ${r.route}`;
        const hit = index.get(key);
        if (hit) hit.calls = numOr(hit.calls) + numOr(r.calls);
        else traffic.push({ method: r.method, route: r.route, calls: numOr(r.calls), lastSeenMs: toMs });
      }
    }
    let coverage;
    try { coverage = buildCoverage({ inventory, traffic, nowMs: toMs }); } catch (err) { return fail(msgOf(err)); }
    return res.status(200).json({
      enabled: true, available: true, windowDays: COVERAGE_WINDOW_DAYS, from: fromMs, to: toMs,
      ...coverage, unavailable: reason ? [reason] : [],
    });
  }, () => ({ enabled: true, available: false, reason: 'handler', windowDays: COVERAGE_WINDOW_DAYS }));
  // ⑤ 拨测：透传 probes 的上一轮快照（本路由不主动拨，否则被轮询放大成拨测风暴）
  get('/api/monitor/probes', (req, res) => {
    if (!isOn()) return res.status(200).json({ enabled: false });
    if (!probes || typeof probes.snapshot !== 'function') return res.status(200).json({ enabled: true, available: false, reason: 'probes 未接线' });
    try {
      const snap = probes.snapshot() || {};
      return res.status(200).json({ enabled: true, available: true, results: asArray(snap.results), uptime: isObj(snap.uptime) ? snap.uptime : {} });
    } catch (err) { return res.status(200).json({ enabled: true, available: false, reason: msgOf(err) }); }
  }, () => ({ enabled: true, available: false, reason: 'handler' }));
  // ⑥ 总览：前端用它判断「监控开没开、有没有在落库」
  get('/api/monitor/status', async (req, res) => {
    // 关闭态也把四个字段给全：前端只读 metricsEnabled 就能显示「未启用」而不是报错
    if (!isOn()) return res.status(200).json({ enabled: false, metricsEnabled: false, storage: null, lastFlushAt: null });
    const storage = await takeStorage();
    return res.status(200).json({
      enabled: true, metricsEnabled: true, storage: storage.value, lastFlushAt: readLastFlushAt(),
      unavailable: storage.reason ? [storage.reason] : [],
    });
  }, () => ({ enabled: isOn(), metricsEnabled: false, storage: null, lastFlushAt: null, unavailable: ['handler'] }));

  return router;
}
export default createApiMonitorRouter;
