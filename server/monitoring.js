/**
 * server/monitoring.js —— 监控体系的启动与调度（Lead 从 index.js 抽出）
 *
 * 为什么单独一个文件：`server/index.js` 已经 2100+ 行，监控的定时器/落库/启停
 * 全部塞进去会更难维护。这里只做「编排」，所有能力都来自可单测的 metrics/* 模块。
 *
 * 三条铁律（对应 docs/monitoring-contract.md）：
 *   1. 任何一步失败都只 warn，绝不让主服务启动失败（监控是可选能力）
 *   2. 所有定时器都要能被 stopMonitoring() 清掉，否则进程退不出去
 *   3. OPENLOG_METRICS=off 时整体旁路
 */
import fs from 'node:fs';

/** 读连接池水位时的兜底：getDbInfo 抛错不能让采样器整轮失败 */
function safePool(getDbInfo) {
  try { return getDbInfo()?.pool ?? null; } catch { return null; }
}

/**
 * 启动监控：建表 → 落库定时器 → DB 采样 → 依赖拨测。
 *
 * @param {object} deps
 * @param {object} deps.registry      接口指标注册表（createRegistry）
 * @param {Function} deps.createApiStore
 * @param {Function} deps.createDbSampler
 * @param {Function} deps.createProbes
 * @param {Function} deps.db           getDb 的惰性 getter
 * @param {Function} deps.dbType       getDbType 的 getter
 * @param {Function} [deps.rawDb]      getRawDb 的 getter（PG 借专属连接用）
 * @param {Function} [deps.sqlitePath] getSqlitePath 的 getter（WAL 大小用）
 * @param {Function} [deps.dbInfo]     getDbInfo 的 getter
 * @param {Function} deps.slowQueryLog 慢查询环形缓冲实例
 * @param {Function} deps.enabled      () => boolean
 * @param {Function} [deps.now]
 * @param {Function} [deps.logger]     (level, msg, err?) 便于单测
 * @param {Function} [deps.setTimer]   默认为 (fn, ms) => setInterval(fn, ms)，测试可注入
 * @param {Function} [deps.clearTimer]
 * @returns {Promise<{store, sampler, probes, timers, state}>}
 */
export async function startMonitoring(deps) {
  const {
    registry,
    createApiStore,
    createDbSampler,
    createProbes,
    db,
    dbType,
    rawDb,
    sqlitePath,
    dbInfo,
    slowQueryLog,
    enabled,
    now = Date.now,
    logger = defaultLogger,
    setTimer = (fn, ms) => setInterval(fn, ms),
    clearTimer = (t) => clearInterval(t),
    selfUrl,
    probeTargets,
    fetchImpl,
  } = deps;

  const timers = { flush: null, prune: null, probe: null, sample: null };
  const state = { schemaReady: false, lastFlushAt: null, lastFlushRows: 0, lastError: null };
  const out = { store: null, sampler: null, probes: null, timers, state };
  /** 已经落过库的采样（`kind:tsMs`），防止每分钟把同一份样本重复写 */
  const writtenSamples = new Set();

  if (!enabled()) {
    logger('info', '[Metrics] OPENLOG_METRICS=off，监控已关闭');
    return out;
  }

  // ── 1. 指标表 ────────────────────────────────────────────────
  let store = null;
  try {
    store = createApiStore({ db: db(), dbType: dbType() });
    state.schemaReady = await store.ensureSchema();
    if (!state.schemaReady) {
      logger('warn', '[Metrics] 指标表创建失败，接口历史/覆盖率将不可用（实时面板不受影响）');
    }
  } catch (err) {
    state.lastError = String(err?.message || err);
    logger('warn', '[Metrics] 指标存储初始化异常，降级为纯内存模式:', err);
    store = null;
  }
  out.store = store;

  // ── 2. 每分钟落库（取走已结束分钟的聚合）─────────────────────
  if (store && state.schemaReady) {
    timers.flush = setTimer(async () => {
      try {
        const buckets = registry.takeMinuteBuckets(now());
        if (!buckets || buckets.length === 0) return;
        const n = await store.writeBuckets(buckets);
        state.lastFlushAt = now();
        state.lastFlushRows = n;
        // 写失败（比如 SQLite BUSY）只丢这批，不重试、不阻塞下一次
        if (n === 0) logger('warn', `[Metrics] 落库 0 行（本批 ${buckets.length} 条被丢弃）`);
      } catch (err) {
        state.lastError = String(err?.message || err);
        logger('warn', '[Metrics] 指标落库异常（已跳过本批）:', err);
      }
    }, 60_000);
    if (timers.flush.unref) timers.flush.unref();

    // 每小时清理过期指标（PG 7 天 / SQLite 3 天 + 行数硬上限）
    timers.prune = setTimer(async () => {
      try { await store.prune(now()); } catch (err) { logger('warn', '[Metrics] 指标清理异常:', err); }
    }, 3_600_000);
    if (timers.prune.unref) timers.prune.unref();
  }

  // ── 3. 数据库采样 ────────────────────────────────────────────
  // 采样器自己管定时；但它的结果是纯内存的，而 db-router 的 /history 要读
  // `db_metric_sample` 表 —— 所以这里额外挂一个「把最新一次采样落库」的定时器。
  // 为什么不在 sampler 里加回调：那样得改已交付并测过的模块，风险大于收益。
  try {
    const sampler = createDbSampler({
      db: db(),
      dbType: dbType(),
      // PG 只有在原生 pool 上开事务才能 `SET LOCAL statement_timeout`（会话级 SET 会污染别人）
      pool: rawDb && dbType() === 'postgres' ? rawDb() : null,
      poolInfo: dbType() === 'postgres' && dbInfo ? () => safePool(dbInfo) : null,
      // SQLite 的 WAL 大小要直接 stat `-wal` 兄弟文件
      sqlitePath: sqlitePath ? sqlitePath() : null,
      readFileSize: (p) => { try { return fs.statSync(p).size; } catch { return null; } },
    });
    sampler.start();
    out.sampler = sampler;

    // 采样器默认把 heavy（表体积/索引命中）排到 5 分钟后 —— 但用户点开面板的第一眼
    // 看到「0 张表」会以为功能没做。启动 12s 后补一次 heavy，让首屏就有数据。
    const firstHeavy = setTimeout(() => {
      Promise.resolve(sampler.sample('heavy')).catch((err) => {
        logger('warn', '[Metrics] 首轮 heavy 采样失败:', err);
      });
    }, 12_000);
    if (firstHeavy.unref) firstHeavy.unref();
    out.timers.firstHeavy = firstHeavy;

    timers.sample = setTimer(async () => {
      try {
        const snap = sampler.snapshot();
        const rows = [snap?.lastLight, snap?.lastHeavy].filter(Boolean);
        for (const row of rows) {
          const ts = Number(row.tsMs);
          if (!Number.isFinite(ts) || writtenSamples.has(`${row.kind}:${ts}`)) continue;
          writtenSamples.add(`${row.kind}:${ts}`);
          await insertSampleRow(db(), dbType(), row);
        }
        // 内存去重集合别无限涨
        if (writtenSamples.size > 500) writtenSamples.clear();
      } catch (err) {
        logger('warn', '[Metrics] DB 采样落库失败（已跳过）:', err);
      }
    }, 60_000);
    if (timers.sample.unref) timers.sample.unref();
  } catch (err) {
    logger('warn', '[Metrics] DB 采样器启动失败:', err);
  }

  // ── 4. 依赖拨测（LLM / Docker / SSH / 自检）──────────────────
  try {
    const probes = createProbes({
      targets: probeTargets || [],
      selfUrl: selfUrl || '',
      // 拨测 /api/health 要过鉴权：fetch 的鉴权头由调用方注入（见 index.js 的 probeFetch）
      ...(typeof fetchImpl === 'function' ? { fetchImpl } : {}),
    });
    out.probes = probes;
    timers.probe = setTimer(async () => {
      try {
        await probes.probeAll();
        await probes.probeSelf();
      } catch (err) {
        logger('warn', '[Metrics] 依赖拨测异常:', err);
      }
    }, 30_000);
    if (timers.probe.unref) timers.probe.unref();
    // 启动后立刻跑一轮，别等 30 秒（面板首次打开就有数据）
    void probes.probeAll().then(() => probes.probeSelf()).catch(() => { /* 首轮失败无所谓 */ });
  } catch (err) {
    logger('warn', '[Metrics] 依赖拨测启动失败:', err);
  }

  logger('info', `[Metrics] 监控已启动（store=${Boolean(store)} sampler=${Boolean(out.sampler)} probes=${Boolean(out.probes)}）`);
  return out;
}

/**
 * 把一次采样写进 `db_metric_sample`（payload 存 JSON）。
 *
 * 为什么用 upsert 而不是纯 INSERT：同一 (ts_ms, kind) 可能被重复尝试写入
 * （比如上一轮写成功但异常发生在返回前），用「冲突即忽略」比抛错好。
 */
async function insertSampleRow(db, dbType, sample) {
  if (!db || !sample) return false;
  const payload = JSON.stringify(sample);
  const sql = dbType === 'postgres'
    ? 'INSERT INTO db_metric_sample (ts_ms, kind, payload) VALUES (?, ?, ?) ON CONFLICT (ts_ms) DO NOTHING'
    : dbType === 'mysql'
      ? 'INSERT IGNORE INTO db_metric_sample (ts_ms, kind, payload) VALUES (?, ?, ?)'
      : 'INSERT OR IGNORE INTO db_metric_sample (ts_ms, kind, payload) VALUES (?, ?, ?)';
  // 适配层对 PG 的 `?` 会自己转成 $n（server/db/index.js 的 normalizeParams 行为）
  await db.run(sql, Number(sample.tsMs), String(sample.kind || 'light'), payload);
  return true;
}

/**
 * 停止监控：清掉全部定时器 + 停采样器。幂等（重复调用安全）。
 * @param {{sampler?: {stop?: Function}, timers?: object}} handle
 * @param {{clearTimer?: Function}} [opts]
 */
export function stopMonitoring(handle, opts = {}) {
  const clearTimer = opts.clearTimer || ((t) => clearInterval(t));
  if (!handle) return;
  try { handle.sampler?.stop?.(); } catch { /* 已停 */ }
  for (const key of ['flush', 'prune', 'probe', 'sample']) {
    const t = handle.timers?.[key];
    if (t) {
      try { clearTimer(t); } catch { /* 已清 */ }
      handle.timers[key] = null;
    }
  }
}

function defaultLogger(level, ...args) {
  const fn = level === 'warn' ? console.warn : console.log;
  fn(...args);
}
