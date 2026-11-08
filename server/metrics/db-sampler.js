/**
 * server/metrics/db-sampler.js —— 数据库采样器（契约 4.5，负责人 #8 sampler）
 *
 * 硬性约束（为什么这么写）：1. IO 全注入（db/pool/now/poolInfo/readFileSize/random），不 import 其它
 * metrics 模块、不 require server/db —— 单测拿假 db 就能跑。2. 重采样不重叠：上轮没结束就跳过本轮
 * （running）；慢库上 `PRAGMA quick_check` 能跑几十秒，setInterval 会把采样堆成并发，打空连接池。
 * 3. 每条采样 SQL 都有超时：有 pool 时借独立连接 BEGIN + `SET LOCAL statement_timeout`（会话级 SET
 * 会漏给池里别的请求，必须 LOCAL）；只有池化 db 时用 race 超时兜底（语句仍在服务端跑，但采样协程不会
 * 永远挂着把 running 卡死）。4. 权限不足/方言不支持 → 只记 unavailable + 字段 null，给 0 = 假数据。
 * 5. 定时用 setTimeout 链（不是 setInterval），每轮结束再排下一轮，加 jitterRatio 错峰。
 * 采样 SQL 原文集中在下方 SQL 常量里（Lead 逐条审的就是那几条），方言差异见 sampleSqlite/sampleMysql。
 */
const LIGHT_MS = 30_000, HEAVY_MS = 300_000, JITTER = 0.2, TIMEOUT_MS = 3000, GAP_MS = 6 * 3_600_000;
const SQL = {
  activity: `SELECT state, EXTRACT(EPOCH FROM (now() - xact_start)) * 1000 AS duration_ms, wait_event, SUBSTR(query, 1, 200) AS query
  FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state IS NOT NULL`,
  locks: `SELECT (l.granted = false) AS waiting, (pg_blocking_pids(l.pid))[1] AS blocked_by
  FROM pg_locks l WHERE l.pid IS NOT NULL AND l.pid <> pg_backend_pid()`,
  tables: `SELECT c.relname AS relname, pg_total_relation_size(c.oid) AS bytes, s.n_live_tup AS live_tup,
       s.n_dead_tup AS dead_tup, s.idx_scan AS idx_scan, s.seq_scan AS seq_scan
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
 WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 20`,
  probe: `SELECT 1 AS ok`,
  mysqlStatus: `SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Slow_queries', 'Table_locks_waited')`,
  pageCount: `PRAGMA page_count`, pageSize: `PRAGMA page_size`, quickCheck: `PRAGMA quick_check`,
  /**
   * SQLite 的表体积。`dbstat` 是 SQLite 自带的虚拟表，按页给出占用字节 ——
   * 这是**唯一的真实来源**（不像 PG 有 pg_total_relation_size）。
   *
   * 坑：dbstat 的行**既包含表也包含索引**（没有 type 列可区分），只按 name 过滤会把
   * `idx_log_records_timestamp` 这种索引当成表列出来，还对它跑 count(*) 报错。
   * 所以必须 JOIN sqlite_master 且限定 m.type='table'。
   *
   * 有些发行版编译时没开 SQLITE_ENABLE_DBSTAT_VTAB，调用侧必须有兜底：
   * 拿不到就退到 sqlite_master 只出表名，并把原因写进 unavailable —— 不假装体积是 0。
   */
  sqliteTablesByDbstat: `SELECT d.name AS name, SUM(d.pgsize) AS bytes
   FROM dbstat d
   JOIN sqlite_master m ON m.name = d.name AND m.type = 'table'
  WHERE d.name NOT LIKE 'sqlite_%'
  GROUP BY d.name ORDER BY bytes DESC LIMIT 20`,
  sqliteTablesByMaster: `SELECT name FROM sqlite_master
   WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 20`,
  /** 精确行数：dbstat 只给字节，行数得 count(*)。只在 heavy 里跑，且限表数，避免在别人的大库上全表扫 */
  sqliteCountRows: (table) => `SELECT COUNT(*) AS n FROM "${String(table).replace(/"/g, '""')}"`,
};
const DB_TYPES = { postgres: 'postgres', postgresql: 'postgres', pg: 'postgres', sqlite: 'sqlite', sqlite3: 'sqlite',
  'better-sqlite3': 'sqlite', mysql: 'mysql', mariadb: 'mysql' };
const errText = (err) => (err && err.message ? String(err.message) : String(err));
/** 数值归一：null/NaN/Infinity/'' 一律 null，绝不把脏数据当 0 */
const asNumber = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const positiveInt = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : fallback);
/** PRAGMA / SHOW 返回行形状随驱动不同：{page_count:n} / [{page_count:n}] / {0:n}，都兜住 */
const pragmaNumber = (row, key) => {
  const head = Array.isArray(row) ? row[0] : row;
  if (!head) return null;
  if (head[key] !== undefined) return asNumber(head[key]);
  const values = Object.values(head);
  return values.length ? asNumber(values[0]) : null;
};
/** 超时兜底；同步抛错也转成 rejection（假 db 与真 db 行为一致）。label 进报错便于定位 */
function withTimeout(run, ms, label) {
  const work = Promise.resolve().then(run);
  if (!(ms > 0)) return work; // timeoutMs<=0 表示不超时（测试/特殊场景显式关掉）
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`采样超时 ${ms}ms: ${label}`)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}
/** 纯函数：pg_stat_activity 行 → 摘要；duration_ms 为 null（idle、无 xact_start）不计入 longestMs。
 * @param {Array<{state?:string,duration_ms?:number,wait_event?:string,query?:string}>} rows
 * @returns {{byState:Record<string,number>,longestMs:number,longestQuery?:string,waitEvents:Array<{event:string,count:number}>}} */
export function summarizeActivities(rows) {
  const byState = {}, events = new Map();
  let longestMs = 0, longestQuery; // longestMs 只在 duration_ms 是数字时更新
  for (const row of Array.isArray(rows) ? rows : []) {
    const state = row?.state ? String(row.state) : 'unknown';
    byState[state] = (byState[state] || 0) + 1;
    const ms = asNumber(row?.duration_ms), ev = row?.wait_event ? String(row.wait_event) : null;
    if (ms !== null && ms > longestMs) { longestMs = ms; longestQuery = typeof row?.query === 'string' ? row.query : undefined; }
    if (ev) events.set(ev, (events.get(ev) || 0) + 1);
  }
  const waitEvents = [...events.entries()].map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
  return { byState, longestMs, longestQuery, waitEvents };
}
/** 纯函数：锁等待摘要；blocking 按「不同阻塞者 pid」去重 —— 一个长事务能堵 20 条锁但阻塞源只有一个。
 * @param {Array<{waiting?:boolean,blocked_by?:number|string}>} rows @returns {{waiting:number,blocking:number}} */
export function summarizeLocks(rows) {
  let waiting = 0, blockers = new Set(); // 去重阻塞者 pid：一个长事务能堵 20 条锁，但阻塞源只有一个
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.waiting === true) waiting += 1;
    const by = row?.blocked_by;
    if (by !== null && by !== undefined) blockers.add(String(by));
  }
  return { waiting, blocking: blockers.size };
}
/** 纯函数：每张表的体积/命中率（按体积降序）。indexHitRate 分母为 0 给 null 而不是 0：0 会被读成「索引
 * 完全没命中，快加索引」，真实含义是「这张表压根没被扫过」。
 * @param {Array<{relname:string,bytes:number,live_tup:number,idx_scan:number,seq_scan:number,dead_tup:number}>} rows
 * @returns {Array<{relname:string,bytes:number|null,liveTup:number|null,deadTup:number|null,idxScan:number,seqScan:number,indexHitRate:number|null}>} */
export function summarizeTables(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const idxScan = asNumber(row?.idx_scan), seqScan = asNumber(row?.seq_scan);
    // 两个计数任一缺失 = 统计行不存在（LEFT JOIN 没命中）→ 命中率给 null，不能拿 0 当分母算
    const scans = idxScan !== null && seqScan !== null ? idxScan + seqScan : null;
    return {
      relname: row?.relname ? String(row.relname) : '(unknown)', idxScan, seqScan,
      bytes: asNumber(row?.bytes), liveTup: asNumber(row?.live_tup), deadTup: asNumber(row?.dead_tup),
      indexHitRate: scans !== null && scans > 0 ? Math.round((idxScan / scans) * 10_000) / 10_000 : null,
    };
  }).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}
/** 纯函数：SQLite 读数归一；page_count/page_size 任一缺失 → sizeBytes 为 null（0 字节的库和「读不到」是两件事）。
 * busy 固定 null：better-sqlite3 没有可靠的 busy 计数器（sqlite3_status 不可达），编 0 骗人。
 * @param {number|null} pageCount @param {number|null} pageSize @param {number|null} walBytes
 * @returns {{pageCount:number|null,pageSize:number|null,sizeBytes:number|null,walBytes:number|null,totalBytes:number|null,busy:null}} */
export function summarizeSqlite(pageCount, pageSize, walBytes) {
  const sizeBytes = pageCount !== null && pageSize !== null ? pageCount * pageSize : null;
  return { pageCount, pageSize, sizeBytes, walBytes, totalBytes: sizeBytes !== null ? sizeBytes + (walBytes ?? 0) : null, busy: null };
}
/** 创建 DB 采样器。
 * @param {object} opts @param {{all:Function,get:Function,run?:Function}} opts.db 注入的 DB 适配层
 * @param {string} opts.dbType 'postgres' | 'sqlite' | 'mysql'
 * @param {{connect?:Function}} [opts.pool] PG 原生池；给了就用独立连接跑 SET LOCAL statement_timeout
 * @param {() => number} [opts.now] 时钟  @param {() => object} [opts.poolInfo] 池水位 {total,idle,waiting,max}
 * @param {(p:string) => number|null} [opts.readFileSize] SQLite 文件大小（文件不存在返回 null）
 * @param {string} [opts.sqlitePath] SQLite 主库路径，用来定位 `-wal` @param {() => number} [opts.random] jitter 随机源
 * @param {number} [opts.lightIntervalMs=30000] @param {number} [opts.heavyIntervalMs=300000]
 * @param {number} [opts.jitterRatio=0.2] @param {number} [opts.timeoutMs=3000] 单条 SQL 超时
 * @returns {{start:Function,stop:Function,sample:Function,snapshot:Function}} */
export function createDbSampler(opts = {}) {
  const { db } = opts;
  if (!db || typeof db.all !== 'function') throw new TypeError('createDbSampler: 需要注入 db{all,get,run}');
  const pick = (name, fallback) => (typeof opts[name] === 'function' ? opts[name] : fallback);
  const pool = opts.pool && typeof opts.pool.connect === 'function' ? opts.pool : null;
  const dbType = DB_TYPES[String(opts.dbType ?? '').trim().toLowerCase()] || 'unknown';
  const lightMs = positiveInt(opts.lightIntervalMs, LIGHT_MS), heavyMs = positiveInt(opts.heavyIntervalMs, HEAVY_MS);
  const timeoutMs = positiveInt(opts.timeoutMs, TIMEOUT_MS), gapMs = positiveInt(opts.quickCheckMinGapMs, GAP_MS);
  const jitterRatio = Math.min(1, Math.max(0, asNumber(opts.jitterRatio) ?? JITTER));
  const now = pick('now', () => Date.now()), poolInfo = pick('poolInfo', null), readFileSize = pick('readFileSize', null);
  const random = pick('random', Math.random);
  const sqlitePath = typeof opts.sqlitePath === 'string' && opts.sqlitePath ? opts.sqlitePath : null;
  let running = false, started = false, samples = 0, lastError = null, lastQuickCheckMs = null, lastLight = null, lastHeavy = null;
  const timers = { light: null, heavy: null };
  const unavailableByKind = { light: new Set(), heavy: new Set() };
  // notes：给「降级原因」留的位置（和 failures 的机器键区分开，界面上要能读懂）
    const newRound = (kind) => ({ kind, tsMs: now(), failures: new Set(), errors: [], notes: [] });
  const sqliteGet = (sql) => withTimeout(() => db.get(sql), timeoutMs, sql), sqliteAll = (sql) => withTimeout(() => db.all(sql), timeoutMs, sql);
  const finalize = (round, snap) => ({
      ...snap,
      unavailable: [...round.failures, ...round.notes],
      ...(round.errors.length ? { error: round.errors[0] } : {}),
    });
  /** 单条采样失败只记 unavailable + 错误，不把异常抛给调用方/定时器 */
  const attempt = async (round, key, fn) => {
    try {
      return await fn();
    } catch (err) {
      round.failures.add(key);
      round.errors.push(`${key}: ${errText(err)}`);
      return null;
    }
  };
  /** 探针延迟用单调时钟，NTP 跳回也不会出现负值（契约 §2） */
  const probe = (round, run) => attempt(round, 'probe', async () => {
    const t0 = process.hrtime.bigint();
    await run();
    return Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
  });
  /** 一次 PG 采样：有 pool 借独立连接（事务内 SET LOCAL statement_timeout），否则 db + race 超时 */
  async function runPg(fn) {
    if (!pool) return fn((sql) => withTimeout(() => db.all(sql), timeoutMs, sql.slice(0, 32)));
    const client = await withTimeout(() => pool.connect(), timeoutMs, 'pool.connect');
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);
      const out = await fn((sql) => Promise.resolve(client.query(sql)).then((r) => r.rows || []));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* 连接已断，忽略 */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* 已释放，忽略 */ }
    }
  }
  async function samplePg(kind) {
    const round = newRound(kind);
    const snap = { tsMs: round.tsMs, kind, probeMs: null, pool: null, activity: null, locks: null, tables: null };
    if (kind === 'light' && poolInfo) { // 没接线 ≠ 故障：给 null 但不记 unavailable
      try {
        const info = poolInfo();
        snap.pool = info ? { total: asNumber(info.total), idle: asNumber(info.idle), waiting: asNumber(info.waiting), max: asNumber(info.max) } : null;
      } catch (err) { round.failures.add('pool_info'); round.errors.push(`pool_info: ${errText(err)}`); }
    }
    try {
      await runPg(async (q) => {
        if (kind === 'heavy') {
          const rows = await attempt(round, 'pg_tables', () => q(SQL.tables));
          snap.tables = rows ? summarizeTables(rows) : null;
          return;
        }
        const acts = await attempt(round, 'pg_stat_activity', () => q(SQL.activity));
        snap.activity = acts ? summarizeActivities(acts) : null;
        const locks = await attempt(round, 'pg_locks', () => q(SQL.locks));
        snap.locks = locks ? summarizeLocks(locks) : null;
        snap.probeMs = await probe(round, () => q(SQL.probe));
      });
    } catch (err) {
      round.errors.push(`pg_session: ${errText(err)}`);
      for (const key of ['pg_session', 'pg_stat_activity', 'pg_locks', 'pg_tables']) round.failures.add(key);
    }
    return finalize(round, snap);
  }
  async function sampleSqlite(kind) {
    const round = newRound(kind);
    if (kind === 'heavy') {
      // 表体积：dbstat 给每个表真实占用的字节数（这是唯一的真来源）。
      // 拿不到 dbstat（发行版没编译进去）就退到 sqlite_master 只出表名，
      // 并把原因记进 unavailable —— 「看不见体积」和「体积是 0」是两件事。
      let tables = null;
      const statRows = await attempt(round, 'sqlite_dbstat', () => sqliteAll(SQL.sqliteTablesByDbstat));
      if (statRows) {
        tables = statRows.map((r) => ({
          relname: String(r.name ?? ''),
          bytes: asNumber(r.bytes),
          liveTup: null,
          deadTup: null,
        }))
          // SQL 里已 ORDER BY；再排一次不依赖驱动的排序行为
          .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
        // 行数：dbstat 只给字节，得 count(*)。只数最大的几张，避免在别人的大库上做无意义全扫。
        // 单表失败只进 failures（降级），不进 errors —— 一张表数不出来不该让整轮采样算失败。
        for (const t of tables.slice(0, 8)) {
          if (!t.relname) continue;
          try {
            const row = await sqliteGet(SQL.sqliteCountRows(t.relname));
            const head = Array.isArray(row) ? row[0] : row;
            t.liveTup = head ? asNumber(head.n ?? Object.values(head)[0]) : null;
          } catch {
            round.failures.add('sqlite_count');
          }
        }
      } else {
        // dbstat 不可用：至少把表名列出来，体积留 null
        const names = await attempt(round, 'sqlite_master', () => sqliteAll(SQL.sqliteTablesByMaster));
        if (names) {
          tables = names.map((r) => ({ relname: String(r.name ?? ''), bytes: null, liveTup: null, deadTup: null }));
        }
        round.notes.push('sqlite_dbstat: 该 SQLite 未启用 dbstat 虚拟表，表体积不可得（只列出了表名）');
      }

      // quick_check 扫全库：距上次不足 6 小时直接跳过，显式记 skipped（不是假装 ok）
      if (lastQuickCheckMs !== null && round.tsMs - lastQuickCheckMs < gapMs) {
        return finalize(round, {
          tsMs: round.tsMs, kind, tables,
          quickCheck: { skipped: true, lastRunMs: lastQuickCheckMs, nextDueMs: lastQuickCheckMs + gapMs },
        });
      }
      const rows = await attempt(round, 'sqlite_quick_check', () => sqliteAll(SQL.quickCheck));
      let quickCheck = { skipped: false, ok: null, problems: null };
      if (rows) {
        const problems = rows.map((row) => row && (row.quick_check ?? Object.values(row)[0]))
          .filter((v) => v && String(v).toLowerCase() !== 'ok').slice(0, 10).map(String);
        quickCheck = { skipped: false, ok: problems.length === 0, problems, checkedMs: round.tsMs };
        lastQuickCheckMs = round.tsMs; // 只有真跑过才推进时间戳，失败下轮还得再跑
      }
      return finalize(round, { tsMs: round.tsMs, kind, tables, quickCheck });
    }
    const readPragma = async (key, sql) => pragmaNumber(await attempt(round, 'sqlite_pragma', () => sqliteGet(sql)), key);
    const pageCount = await readPragma('page_count', SQL.pageCount), pageSize = await readPragma('page_size', SQL.pageSize);
    // WAL：注入了路径 + 读取器才有数；文件不存在 → 0 字节且 walExists=false（事实，不是编造）
    let wal = { walBytes: null, walExists: null };
    if (readFileSize && sqlitePath) {
      try {
        const size = await readFileSize(`${sqlitePath}-wal`);
        wal = size === null || size === undefined ? { walBytes: 0, walExists: false } : { walBytes: asNumber(size), walExists: true };
      } catch (err) { round.failures.add('sqlite_wal'); round.errors.push(`sqlite_wal: ${errText(err)}`); }
    }
    const sqlite = { ...summarizeSqlite(pageCount, pageSize, wal.walBytes), walExists: wal.walExists };
    return finalize(round, { tsMs: round.tsMs, kind, sqlite, probeMs: await probe(round, () => sqliteGet(SQL.probe)) });
  }
  /** 本项目没有 MySQL 实测环境：能力探测失败就把 'mysql' 记进 unavailable，不假装支持 */
  async function sampleMysql(round) {
    const snap = { tsMs: round.tsMs, kind: round.kind, probeMs: await probe(round, () => sqliteGet(SQL.probe)), mysql: null };
    const rows = await attempt(round, 'mysql', () => sqliteAll(SQL.mysqlStatus));
    if (rows) {
      const map = {};
      for (const row of rows) {
        const name = row?.Variable_name ?? Object.values(row || {})[0];
        if (name) map[String(name).toLowerCase()] = asNumber(row?.Value ?? Object.values(row || {})[1]);
      }
      snap.mysql = { threadsConnected: map.threads_connected ?? null, slowQueries: map.slow_queries ?? null, tableLocksWaited: map.table_locks_waited ?? null };
    }
    return finalize(round, snap);
  }
  async function sample(kind) {
    const k = kind === 'heavy' ? 'heavy' : 'light';
    if (running) return { ok: false, kind: k, busy: true, skipped: true }; // 不重叠
    running = true;
    try {
      let snap;
      if (dbType === 'postgres') snap = await samplePg(k);
      else if (dbType === 'sqlite') snap = await sampleSqlite(k);
      else if (dbType === 'mysql') snap = await sampleMysql(newRound(k));
      else {
        const round = newRound(k);
        round.failures.add(`dialect:${dbType}`);
        round.errors.push(`不支持的方言: ${dbType}`);
        snap = finalize(round, { tsMs: round.tsMs, kind: k });
      }
      snap.ok = !snap.error;
      unavailableByKind[k] = new Set(snap.unavailable || []); // 整体替换：权限修好后过期失败项要能消失
      samples += 1;
      lastError = snap.error || null; // 成功一轮就清掉旧错误
      if (k === 'heavy') lastHeavy = snap; else lastLight = snap;
      return snap;
    } catch (err) {
      lastError = errText(err);
      return { ok: false, kind: k, error: lastError };
    } finally {
      running = false;
    }
  }
  const nextDelay = (base) => Math.max(1000, Math.round(base + base * jitterRatio * (random() * 2 - 1)));
  /** setTimeout 链 + jitter（间隔 [base*(1-r), base*(1+r)]）：每轮结束才排下一轮 */
  function schedule(kind, delay) {
    const timer = setTimeout(async () => {
      timers[kind] = null;
      if (!started) return; // stop() 之后不再排下一轮
      await sample(kind);
      if (started) schedule(kind, nextDelay(kind === 'heavy' ? heavyMs : lightMs));
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    timers[kind] = timer;
  }
  return {
    /** 启动定时采样；重复调用安全。首轮 light 立刻跑，Monitor 页不用等 30s 才有数据。 */
    start() {
      if (started) return;
      started = true;
      schedule('light', 0);
      schedule('heavy', nextDelay(heavyMs));
    },
    /** 立刻停：清 timer，重复调用安全。正在跑的那一轮不中断，但结束后不再排下一轮。 */
    stop() {
      started = false;
      for (const kind of ['light', 'heavy']) { if (timers[kind]) clearTimeout(timers[kind]); timers[kind] = null; }
    },
    sample,
    /** 只读快照（返回内部引用，调用方不要改） */
    snapshot() {
      const unavailable = [];
      for (const kind of ['light', 'heavy']) for (const key of unavailableByKind[kind]) if (!unavailable.includes(key)) unavailable.push(key);
      return { lastLight, lastHeavy, lastError, samples, unavailable, running };
    },
  };
}