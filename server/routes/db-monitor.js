/**
 * server/routes/db-monitor.js —— DB 监控 HTTP 端点（#13 db-router，契约 docs/monitoring-contract.md §5）
 *
 * 挂载方式：路径写全（`/api/monitor/db/...`），Lead 直接 `app.use(createDbMonitorRouter(deps))`，
 * 不要再套 `/api` 前缀（与 server/routes/db-info.js 同一惯例）。
 *
 * ══ 为什么权限不足必须显式透出，而不是回 0 ══
 * 监控端点的读者是值班的人，他看到「0」的唯一解释是「一切正常」：
 * active 连接 0 条、锁等待 0 个、慢查询 0 条、体积 0 字节 —— 全是「健康」的语义。
 * 但 `pg_stat_activity` 在缺 `pg_monitor` 角色时是**读不到**的，`pg_locks` 同理，
 * SQLite 的 `PRAGMA page_count` 在库忙/句柄异常时也会失败。这时候如果回 0：
 *   1) 页面绿灯，真实故障（连接池打满、长事务堵锁、慢查询堆积）被 0 盖掉，监控工具反过来
 *      变成了「故障隐形器」—— 这比没有监控更糟，因为人会信它。
 *   2) 故障修完（授了权限）也没有任何状态变化可以观察到，运维无从确认「是不是已经好了」。
 * 所以本文件的铁律是：**读不到就 null + 把失败项原样写进 `unavailable[]`**，
 * 前端渲染成「不可用/权限不足」而不是 0。`snapshot()` 的 `unavailable` 一律原样透出，
 * 不合并、不过滤、不改名 —— 它是整条链路上「权限不足」的唯一出口。
 *
 * 第二条铁律：**永不 500**。监控是旁路视图，依赖（sampler/store/slowQueryLog/db）可能因为
 * 库没就绪、OPENLOG_METRICS=off、还没接线而为 null 或抛错。这时字段给 null / `available:false`，
 * HTTP 仍回 200：前端要能画出「不可用」的灰条，而不是整页弹错误提示。
 */
import express from 'express';
import { normalizeDbType, placeholder } from '../metrics/sql-dialect.js';

/** 契约 §5：history 默认 120 点（30s 一采样 ≈ 1 小时），上限 500 挡住手滑的 ?limit=1e9 */
const DEFAULT_HISTORY_LIMIT = 120;
const MAX_HISTORY_LIMIT = 500;
const DEFAULT_SLOW_LIMIT = 50;
const MAX_SLOW_LIMIT = 500;
const DEFAULT_TABLES_TOP = 20;
const MAX_TABLES_TOP = 50;
/** history 拿不到数据的统一说明：前端据此显示「历史读取未接入」而不是「没有历史」 */
const HISTORY_UNAVAILABLE = 'db_metric_sample 读取未接入';

const errText = (err) => (err && err.message ? String(err.message) : String(err));

/** 有界整数：非法/负数/超限一律夹到 [1, max]，NULL 走 fallback */
function boundedInt(raw, fallback, max) {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** 依赖是函数就调，抛错/非函数都折成 fallback —— 这是「永不 500」的第一道闸 */
async function safeCall(fn, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return await fn(); } catch { return fallback; }
}

/** JSON 列解析：脏数据返回 null（不是 {}），让前端能区分「空对象」和「解析失败」 */
function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 创建 DB 监控路由。
 * @param {object} [deps]
 * @param {{snapshot:Function, sample:Function}} [deps.sampler] createDbSampler() 实例
 * @param {{stats:Function, queryRange?:Function}} [deps.store] createApiStore() 实例
 * @param {{list:Function, reset:Function, thresholdMs?:number}} [deps.slowQueryLog] createSlowQueryLog() 实例
 * @param {() => ({type?:string, pool?:object, sqlite?:object})} [deps.dbInfo] server/db 的 getDbInfo()
 * @param {{all:Function}} [deps.db] 可选：读 db_metric_sample 用的 DB 适配层（server/db 的 getDb()）
 * @param {string} [deps.dbType] 可选：方言，缺省从 dbInfo().type 推断
 * @param {number} [deps.slowQueryThresholdMs] 可选：slow-query 阈值（实例没暴露时用它）
 * @param {() => boolean} [deps.enabled] 总开关（OPENLOG_METRICS=off 时由 Lead 注入 false）
 * @returns {import('express').Router}
 */
export function createDbMonitorRouter(deps = {}) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const router = express.Router();

  /** 没接线默认开：默认静默关闭会让整页永远空着且没人知道是开关问题；开关抛错按关闭处理 */
  const isEnabled = () => {
    if (typeof d.enabled !== 'function') return true;
    try { return Boolean(d.enabled()); } catch { return false; }
  };
  /** dbInfo() 只用来标类型/池水位，抛错就当没接线（pool 给 null，不编 0） */
  const readDbInfo = () => {
    if (typeof d.dbInfo !== 'function') return null;
    try {
      const info = d.dbInfo();
      return info && typeof info === 'object' ? info : null;
    } catch { return null; }
  };
  const resolveDbType = () => {
    if (typeof d.dbType === 'string' && d.dbType) return normalizeDbType(d.dbType);
    return normalizeDbType(readDbInfo()?.type);
  };
  /**
   * 快照的唯一入口。三类结果都要能区分：
   *  - 有快照 → `unavailable` 原样透出（契约要求，不许过滤/改名）；
   *  - 没接线/抛错/返回非对象 → 快照为 null，并把失败原因塞进 `unavailable`
   *    （此处是「没有快照可透出」的降级分支，不是覆盖 sampler 自己的列表）。
   */
  const readSnapshot = () => {
    if (!d.sampler || typeof d.sampler.snapshot !== 'function') return { snap: null, unavailable: ['sampler 未接入'] };
    try {
      const snap = d.sampler.snapshot();
      if (!snap || typeof snap !== 'object') return { snap: null, unavailable: ['sampler.snapshot 返回非对象'] };
      return { snap, unavailable: Array.isArray(snap.unavailable) ? snap.unavailable : [] };
    } catch (err) {
      return { snap: null, unavailable: [`sampler.snapshot: ${errText(err)}`] };
    }
  };

  /** 1. 总览：池水位 / 最近两次采样 / 存储计数 / 不可用清单 */
  router.get('/api/monitor/db', async (req, res) => {
    if (!isEnabled()) return res.json({ enabled: false });
    const { snap, unavailable } = readSnapshot();
    const info = readDbInfo();
    const lastLight = snap?.lastLight ?? null;
    const lastHeavy = snap?.lastHeavy ?? null;
    // storage 失败给 null：0 行会被读成「监控表还是空的」，那是「没数据」不是「读不到」
    const storage = await safeCall(d.store?.stats ? () => d.store.stats() : null, null);
    return res.json({
      enabled: true,
      type: info?.type ?? null,
      pool: info?.pool ?? null,
      lastLight,
      lastHeavy,
      unavailable,
      tables: Array.isArray(lastHeavy?.tables) ? lastHeavy.tables : [],
      probeMs: lastLight?.probeMs ?? lastHeavy?.probeMs ?? null,
      storage,
    });
  });

  /**
   * 2. 采样历史。契约指定这张表由本文件负责读：api-store 的 queryRange 只认
   * `api_metrics_minute`，`db_metric_sample` 没有对应方法，所以直接用注入的 `db` 查。
   * 没注入 db → 明确的 `unavailable` 文案 + 空样本，而不是 500 或「空历史」。
   */
  router.get('/api/monitor/db/history', async (req, res) => {
    if (!isEnabled()) return res.json({ enabled: false });
    const kind = req.query.kind === 'heavy' ? 'heavy' : 'light';
    const limit = boundedInt(req.query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const db = d.db;
    if (!db || typeof db.all !== 'function') return res.json({ kind, samples: [], unavailable: HISTORY_UNAVAILABLE });
    // LIMIT 已夹成整数，其余全部走占位符；表名/列名都是本文件里的常量
    const sql = `SELECT ts_ms, kind, payload FROM db_metric_sample WHERE kind = ${placeholder(resolveDbType(), 1)}`
      + ` ORDER BY ts_ms DESC LIMIT ${limit}`;
    try {
      const rows = await db.all(sql, kind);
      const samples = (Array.isArray(rows) ? rows : [])
        .map((r) => ({ tsMs: Number(r?.ts_ms) || null, kind: r?.kind ?? kind, data: parseJson(r?.payload) }))
        .reverse(); // 表里按时间倒序取最近 N 条，回给图表时翻回升序
      return res.json({ kind, samples });
    } catch (err) {
      return res.json({ kind, samples: [], unavailable: `db_metric_sample 读取失败: ${errText(err)}` });
    }
  });

  /** 3. 慢查询（内存环形缓冲，list 已按时间倒序；阈值实例没暴露时读 deps 或给 null） */
  router.get('/api/monitor/db/slow-queries', (req, res) => {
    if (!isEnabled()) return res.json({ enabled: false });
    const limit = boundedInt(req.query.limit, DEFAULT_SLOW_LIMIT, MAX_SLOW_LIMIT);
    const log = d.slowQueryLog;
    const threshold = d.slowQueryThresholdMs ?? log?.thresholdMs ?? null;
    if (!log || typeof log.list !== 'function') return res.json({ threshold, items: [], unavailable: 'slowQueryLog 未接入' });
    try {
      const items = log.list(limit);
      return res.json({ threshold, items: Array.isArray(items) ? items : [] });
    } catch (err) {
      return res.json({ threshold, items: [], unavailable: `slowQueryLog.list: ${errText(err)}` });
    }
  });

  /** 4. 清空慢查询：`cleared:false` 只有一种含义 —— 没清掉，前端别把「清空成功」的提示打出来 */
  router.delete('/api/monitor/db/slow-queries', (req, res) => {
    if (!isEnabled()) return res.json({ enabled: false });
    const log = d.slowQueryLog;
    if (!log || typeof log.reset !== 'function') return res.json({ cleared: false, unavailable: 'slowQueryLog 未接入' });
    try {
      log.reset();
      return res.json({ cleared: true });
    } catch (err) {
      return res.json({ cleared: false, unavailable: `slowQueryLog.reset: ${errText(err)}` });
    }
  });

  /** 5. 立刻刷新：手动跑一次 light 采样（不动 running 锁，sampler 自己防重叠 → busy:true 原样回） */
  router.post('/api/monitor/db/sample', async (req, res) => {
    if (!isEnabled()) return res.json({ enabled: false });
    const sampler = d.sampler;
    if (!sampler || typeof sampler.sample !== 'function') return res.json({ ok: false, error: 'sampler 未接入' });
    try {
      return res.json(summarizeSample(await sampler.sample('light')));
    } catch (err) {
      return res.json({ ok: false, error: errText(err) });
    }
  });

  /** 6. 表体积/行数 top N：只翻 lastHeavy（heavy 采样 5min 一次，够用且不额外打库） */
  router.get('/api/monitor/db/tables', (req, res) => {
    if (!isEnabled()) return res.json({ enabled: false });
    const limit = boundedInt(req.query.limit, DEFAULT_TABLES_TOP, MAX_TABLES_TOP);
    const { snap, unavailable } = readSnapshot();
    const all = Array.isArray(snap?.lastHeavy?.tables) ? snap.lastHeavy.tables : null;
    if (!all || all.length === 0) {
      // 空数组≠没有表：可能是 heavy 还没跑过、sqlite 方言没表统计、或权限不足
      return res.json({
        available: false,
        tables: [],
        unavailable: unavailable.length ? unavailable : ['lastHeavy 尚无表统计'],
      });
    }
    const tables = [...all]
      .sort((a, b) => (b?.bytes ?? -1) - (a?.bytes ?? -1))
      .slice(0, limit)
      .map((t) => ({
        relname: t?.relname ?? '(unknown)',
        bytes: t?.bytes ?? null,
        liveTup: t?.liveTup ?? null,
        deadTup: t?.deadTup ?? null,
        indexHitRate: t?.indexHitRate ?? null,
      }));
    return res.json({ available: true, tsMs: snap.lastHeavy?.tsMs ?? null, total: all.length, tables });
  });

  return router;
}

/**
 * 采样结果摘要：只留前端要显示的几个字段（activity/locks 明细走 `/api/monitor/db`）。
 * `ok:false` + `error` 是「这次没采到」，不是「库有问题」；busy/skipped 表示上一轮还没跑完。
 * @param {any} result sampler.sample() 的返回值
 * @returns {{ok:boolean, kind:string, tsMs:number|null, probeMs:number|null, unavailable:string[], error?:string, busy?:boolean, skipped?:boolean}}
 */
export function summarizeSample(result) {
  if (!result || typeof result !== 'object') return { ok: false, kind: 'light', tsMs: null, probeMs: null, unavailable: [], error: 'sampler.sample() 无返回值' };
  const out = {
    ok: result.ok !== false,
    kind: result.kind === 'heavy' ? 'heavy' : 'light',
    tsMs: Number.isFinite(result.tsMs) ? result.tsMs : null,
    probeMs: Number.isFinite(result.probeMs) ? result.probeMs : null,
    unavailable: Array.isArray(result.unavailable) ? result.unavailable : [],
  };
  if (result.busy) out.busy = true;
  if (result.skipped) out.skipped = true;
  if (result.error) { out.ok = false; out.error = String(result.error); }
  return out;
}

export default createDbMonitorRouter;
