import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createDbSampler, summarizeActivities, summarizeLocks, summarizeSqlite, summarizeTables,
} from '../metrics/db-sampler.js';

// 负责人 #8 sampler —— 契约 4.5 的单测。
// 全部用「手工假 db」：一个按 SQL 关键字分派的 { all, get, run }，可以让任意一条采样 SQL
// 返回数据、抛 permission denied、或返回永不 resolve 的 promise。绝不连真库。

/**
 * 造一个假 db。routes 是 { SQL 关键字: 返回值 | handler | Error }，按 Object.entries 顺序首个 includes 命中。
 * 未命中的 SQL 直接抛错 —— 采样了契约里没有的 SQL 会立刻在测试里暴露。
 */
function fakeDb(routes = {}) {
  const calls = [];
  const dispatch = (sql) => {
    calls.push(String(sql));
    for (const [needle, handler] of Object.entries(routes)) {
      if (String(sql).includes(needle)) {
        if (handler instanceof Error) throw handler;
        return typeof handler === 'function' ? handler(sql) : handler;
      }
    }
    throw new Error(`fake db: 未预期的 SQL → ${String(sql).slice(0, 60)}`);
  };
  return { calls, all: (sql) => dispatch(sql), get: (sql) => dispatch(sql), run: (sql) => dispatch(sql) };
}

const countCalls = (db, needle) => db.calls.filter((sql) => sql.includes(needle)).length;

// PG light 三件套的返回数据
const ACTIVITY_ROWS = [
  { state: 'active', duration_ms: 120.5, wait_event: 'Lock', query: 'UPDATE t SET x=1' },
  { state: 'active', duration_ms: 840.25, wait_event: 'IO', query: 'SELECT * FROM big' },
  { state: 'idle', duration_ms: null, wait_event: null, query: null },
  { state: 'active', duration_ms: 30, wait_event: 'Lock', query: 'SELECT 1' },
];
const LOCK_ROWS = [
  { waiting: true, blocked_by: 42 },
  { waiting: true, blocked_by: 42 },
  { waiting: false, blocked_by: null },
  { waiting: true, blocked_by: 7 },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('summarizeActivities —— pg_stat_activity 摘要', () => {
  it('1. 正确聚合 byState / longestMs / longestQuery / waitEvents', () => {
    const res = summarizeActivities(ACTIVITY_ROWS);
    expect(res.byState).toEqual({ active: 3, idle: 1 });
    expect(res.longestMs).toBe(840.25);
    expect(res.longestQuery).toBe('SELECT * FROM big');
    // Lock 2 次 > IO 1 次，按 count 降序
    expect(res.waitEvents).toEqual([{ event: 'Lock', count: 2 }, { event: 'IO', count: 1 }]);
  });

  it('1b. 空输入 / 非数组 / 缺 state 不抛，longestMs 为 0', () => {
    expect(summarizeActivities([])).toEqual({ byState: {}, longestMs: 0, longestQuery: undefined, waitEvents: [] });
    expect(summarizeActivities(null).longestMs).toBe(0);
    expect(summarizeActivities([{ duration_ms: null }]).byState).toEqual({ unknown: 1 });
    // duration_ms 是脏数据（字符串）时不能参与比较
    expect(summarizeActivities([{ state: 'active', duration_ms: 'not-a-number' }]).longestMs).toBe(0);
  });
});

describe('summarizeLocks —— 锁等待摘要', () => {
  it('2. waiting 计次数，blocking 按阻塞者 pid 去重', () => {
    expect(summarizeLocks(LOCK_ROWS)).toEqual({ waiting: 3, blocking: 2 }); // 42 重复两次只算一个
  });

  it('2b. 空输入给 0/0（这里 0 是真实值，不是占位）', () => {
    expect(summarizeLocks([])).toEqual({ waiting: 0, blocking: 0 });
    expect(summarizeLocks(null)).toEqual({ waiting: 0, blocking: 0 });
    expect(summarizeLocks([{ waiting: false, blocked_by: null }])).toEqual({ waiting: 0, blocking: 0 });
  });
});

describe('summarizeTables —— 表体积与索引命中率', () => {
  it('3. indexHitRate = idx/(idx+seq)，并按体积降序', () => {
    const res = summarizeTables([
      { relname: 'small', bytes: 8192, live_tup: 10, dead_tup: 1, idx_scan: 90, seq_scan: 10 },
      { relname: 'big', bytes: 1048576, live_tup: 500, dead_tup: 44, idx_scan: 0, seq_scan: 300 },
    ]);
    expect(res.map((r) => r.relname)).toEqual(['big', 'small']);
    expect(res[1].indexHitRate).toBe(0.9);
    expect(res[0].indexHitRate).toBe(0);
    expect(res[0].bytes).toBe(1048576);
    expect(res[0].deadTup).toBe(44);
  });

  it('3b. 除零保护：idx+seq 为 0 时 indexHitRate 是 null 而不是 0（0 会被误读成「索引全废」）', () => {
    const [row] = summarizeTables([{ relname: 'never_scanned', bytes: 4096, live_tup: 0, dead_tup: 0, idx_scan: 0, seq_scan: 0 }]);
    expect(row.idxScan).toBe(0);
    expect(row.seqScan).toBe(0);
    expect(row.indexHitRate).toBeNull();
    // 脏数据也不能把命中率算成 NaN
    const [dirty] = summarizeTables([{ relname: 'x', bytes: null, live_tup: null, dead_tup: null, idx_scan: null, seq_scan: null }]);
    expect(dirty.indexHitRate).toBeNull();
    expect(dirty.bytes).toBeNull();
    // 缺统计行（pg_stat_user_tables 没命中）时计数是 null，命中率也是 null，不能编 0 冒充
    const [missing] = summarizeTables([{ relname: 'brand_new', bytes: 8192 }]);
    expect(missing.idxScan).toBeNull();
    expect(missing.indexHitRate).toBeNull();
  });
});

describe('summarizeSqlite —— PRAGMA 读数归一', () => {
  it('3c. sizeBytes = page_count × page_size；缺一半就是 null', () => {
    expect(summarizeSqlite(100, 4096, 8192)).toEqual({
      pageCount: 100, pageSize: 4096, sizeBytes: 409600, walBytes: 8192, totalBytes: 417792, busy: null,
    });
    expect(summarizeSqlite(100, null, null).sizeBytes).toBeNull();
    expect(summarizeSqlite(null, null, null).totalBytes).toBeNull();
    // busy 恒为 null（没有可靠 API），绝不编 0
    expect(summarizeSqlite(1, 1, 0).busy).toBeNull();
  });
});

describe('sample() —— PostgreSQL 采样（假 db）', () => {
  it('4. light 采样写出 lastLight、探针延迟是 >=0 的 number，并带上连接池水位', async () => {
    const db = fakeDb({
      pg_stat_activity: ACTIVITY_ROWS,
      pg_locks: LOCK_ROWS,
      'SELECT 1': [{ ok: 1 }],
    });
    const sampler = createDbSampler({
      db, dbType: 'postgres', now: () => 1_700_000_000_000,
      poolInfo: () => ({ total: 5, idle: 2, waiting: 1, max: 10 }),
    });

    const snap = await sampler.sample('light');
    expect(snap.ok).toBe(true);
    expect(typeof snap.probeMs).toBe('number');
    expect(snap.probeMs).toBeGreaterThanOrEqual(0);
    expect(snap.activity.byState).toEqual({ active: 3, idle: 1 });
    expect(snap.locks).toEqual({ waiting: 3, blocking: 2 });
    expect(snap.pool).toEqual({ total: 5, idle: 2, waiting: 1, max: 10 });
    expect(snap.tsMs).toBe(1_700_000_000_000);

    const s = sampler.snapshot();
    expect(s.lastLight).toBe(snap);
    expect(s.lastLight.probeMs).toBeGreaterThanOrEqual(0);
    expect(s.samples).toBe(1);
    expect(s.unavailable).toEqual([]);
    expect(s.lastError).toBeNull();
    expect(s.running).toBe(false);
  });

  it('4b. poolInfo 缺失时 pool 是 null，但不算 unavailable', async () => {
    const db = fakeDb({ pg_stat_activity: [], pg_locks: [], 'SELECT 1': [{ ok: 1 }] });
    const snap = await createDbSampler({ db, dbType: 'postgres' }).sample('light');
    expect(snap.pool).toBeNull();
    expect(snap.unavailable).toEqual([]);
  });

  it('4c. heavy 采样拿到表列表，字段按体积降序', async () => {
    const db = fakeDb({
      pg_total_relation_size: [
        { relname: 'log_records', bytes: 2_097_152, live_tup: 900, dead_tup: 30, idx_scan: 120, seq_scan: 40 },
        { relname: 'kv_store', bytes: 16_384, live_tup: 12, dead_tup: 0, idx_scan: 0, seq_scan: 0 },
      ],
    });
    const sampler = createDbSampler({ db, dbType: 'postgres' });
    const snap = await sampler.sample('heavy');
    expect(snap.tables.map((t) => t.relname)).toEqual(['log_records', 'kv_store']);
    expect(snap.tables[0].indexHitRate).toBe(0.75);
    expect(snap.tables[1].indexHitRate).toBeNull();
    expect(sampler.snapshot().lastHeavy).toBe(snap);
  });

  it('4d. 注入 pool 时借独立连接：BEGIN + SET LOCAL statement_timeout + COMMIT + release', async () => {
    const log = [];
    const client = {
      query(sql) {
        log.push(String(sql));
        if (/FROM pg_stat_activity/.test(sql)) return Promise.resolve({ rows: ACTIVITY_ROWS });
        if (/FROM pg_locks/.test(sql)) return Promise.resolve({ rows: LOCK_ROWS });
        return Promise.resolve({ rows: [{ ok: 1 }] });
      },
      release() { log.push('release'); },
    };
    const pool = { connect: () => { log.push('connect'); return Promise.resolve(client); } };
    // db 存在但绝不该被用到；用了就会抛「未预期的 SQL」
    const db = fakeDb({});

    const snap = await createDbSampler({ db, pool, dbType: 'postgres', timeoutMs: 3000 }).sample('light');
    expect(snap.activity.byState).toEqual({ active: 3, idle: 1 });
    expect(log[0]).toBe('connect');
    expect(log[1]).toBe('BEGIN');
    expect(log[2]).toBe('SET LOCAL statement_timeout = 3000');
    expect(log).toContain('COMMIT');
    expect(log.at(-1)).toBe('release');
    expect(db.calls).toEqual([]); // 有独立连接就不该走池化 db
  });
});

describe('权限不足 —— unavailable + null，绝不抛', () => {
  it('5. pg_stat_activity 抛 permission denied：记 unavailable，字段为 null，不抛异常', async () => {
    const denied = new Error('permission denied for relation pg_stat_activity');
    const db = fakeDb({
      pg_stat_activity: denied,
      pg_locks: LOCK_ROWS,
      'SELECT 1': [{ ok: 1 }],
    });
    const sampler = createDbSampler({ db, dbType: 'postgres' });

    const snap = await sampler.sample('light'); // 不抛
    expect(snap.activity).toBeNull(); // 不是 {}、不是 0
    expect(snap.locks).toEqual({ waiting: 3, blocking: 2 }); // 其它项照常
    expect(snap.unavailable).toContain('pg_stat_activity');
    expect(snap.ok).toBe(false);

    const s = sampler.snapshot();
    expect(s.unavailable).toContain('pg_stat_activity');
    expect(s.lastLight.activity).toBeNull();
    expect(s.lastError).toContain('permission denied');
  });

  it('5b. 全部采样都失败时所有字段 null，probe 也记 unavailable', async () => {
    const db = { all: () => { throw new Error('permission denied'); }, get: () => { throw new Error('permission denied'); }, run: () => {} };
    const snap = await createDbSampler({ db, dbType: 'postgres' }).sample('light');
    expect(snap.activity).toBeNull();
    expect(snap.locks).toBeNull();
    expect(snap.probeMs).toBeNull();
    expect(snap.unavailable).toEqual(expect.arrayContaining(['pg_stat_activity', 'pg_locks', 'probe']));
  });

  it('5c. MySQL 能力探测失败 → 把 mysql 记进 unavailable，不假装支持', async () => {
    const db = fakeDb({ 'SELECT 1': [{ ok: 1 }], 'SHOW GLOBAL STATUS': new Error('unsupported dialect') });
    const sampler = createDbSampler({ db, dbType: 'mysql' });
    const snap = await sampler.sample('light');
    expect(snap.mysql).toBeNull();
    expect(snap.unavailable).toContain('mysql');
    expect(sampler.snapshot().unavailable).toContain('mysql');
  });
});

describe('SQLite 分支（PRAGMA）', () => {
  const sqliteRoutes = () => ({
    'PRAGMA page_count': [{ page_count: 100 }],
    'PRAGMA page_size': [{ page_size: 4096 }],
    'PRAGMA quick_check': [{ quick_check: 'ok' }],
    'SELECT 1': [{ ok: 1 }],
  });

  it('6. light 走 pragma：库大小 = page_count × page_size，WAL 由注入的 readFileSize 提供', async () => {
    const db = fakeDb(sqliteRoutes());
    const sampler = createDbSampler({
      db, dbType: 'sqlite', sqlitePath: '/data/openlog.db',
      readFileSize: (p) => (p.endsWith('-wal') ? 53248 : null),
    });
    const snap = await sampler.sample('light');
    expect(snap.sqlite.pageCount).toBe(100);
    expect(snap.sqlite.sizeBytes).toBe(409600);
    expect(snap.sqlite.walBytes).toBe(53248);
    expect(snap.sqlite.walExists).toBe(true);
    expect(snap.sqlite.busy).toBeNull(); // 没有可靠 API → null，不编 0
    expect(typeof snap.probeMs).toBe('number');
    expect(snap.probeMs).toBeGreaterThanOrEqual(0);
    // light 绝不跑 quick_check（它扫全库）
    expect(countCalls(db, 'quick_check')).toBe(0);
  });

  it('6b. heavy 首次跑 quick_check，6 小时内第二次记 skipped，过了 6 小时再跑', async () => {
    const db = fakeDb(sqliteRoutes());
    let clock = 1_700_000_000_000;
    const sampler = createDbSampler({ db, dbType: 'sqlite', now: () => clock });

    const first = await sampler.sample('heavy');
    expect(first.quickCheck.skipped).toBe(false);
    expect(first.quickCheck.ok).toBe(true);
    expect(countCalls(db, 'quick_check')).toBe(1);

    clock += 3_600_000; // +1h
    const second = await sampler.sample('heavy');
    expect(second.quickCheck.skipped).toBe(true);
    expect(second.quickCheck.nextDueMs).toBe(first.quickCheck.checkedMs + 6 * 3_600_000);
    expect(countCalls(db, 'quick_check')).toBe(1); // 没再扫全库

    clock += 6 * 3_600_000; // 距首次已 7h
    const third = await sampler.sample('heavy');
    expect(third.quickCheck.skipped).toBe(false);
    expect(countCalls(db, 'quick_check')).toBe(2);
  });

  it('6c. quick_check 报告 corrupt 时 ok=false 并带上问题行', async () => {
    const db = fakeDb({ ...sqliteRoutes(), 'PRAGMA quick_check': [{ quick_check: '*** in database main ***' }] });
    const snap = await createDbSampler({ db, dbType: 'sqlite' }).sample('heavy');
    expect(snap.quickCheck.ok).toBe(false);
    expect(snap.quickCheck.problems[0]).toContain('in database main');
  });
});

describe('重采样不重叠', () => {
  it('7. 上一轮没结束时第二次 sample 直接返回 busy/skipped', async () => {
    const db = fakeDb({ pg_stat_activity: () => new Promise(() => {}), pg_locks: LOCK_ROWS, 'SELECT 1': [{ ok: 1 }] });
    const sampler = createDbSampler({ db, dbType: 'postgres', timeoutMs: 20 });

    const first = sampler.sample('light'); // 挂住
    const second = await sampler.sample('light');
    expect(second).toMatchObject({ ok: false, busy: true, skipped: true });
    expect(sampler.snapshot().running).toBe(true);

    // 超时兜底让第一轮自己结束（不会永远卡住 running）
    const settled = await first;
    expect(settled.unavailable).toContain('pg_stat_activity');
    expect(settled.activity).toBeNull();
    expect(sampler.snapshot().running).toBe(false);
  });
});

describe('start / stop —— 幂等且能立刻停', () => {
  const sqliteDb = () => fakeDb({
    'PRAGMA page_count': [{ page_count: 10 }],
    'PRAGMA page_size': [{ page_size: 4096 }],
    'SELECT 1': [{ ok: 1 }],
  });

  it('8. start 幂等（只挂一条链）、stop 后不再采样、重复 stop 安全', async () => {
    vi.useFakeTimers();
    const db = sqliteDb();
    const sampler = createDbSampler({ db, dbType: 'sqlite', jitterRatio: 0 });

    sampler.start();
    sampler.start(); // 第二次必须无效，否则采样频率直接翻倍（下面的计数会变成 2）
    await vi.advanceTimersByTimeAsync(0); // 首轮 light 立刻跑
    expect(sampler.snapshot().samples).toBe(1);
    expect(countCalls(db, 'PRAGMA page_count')).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000); // 第二轮 light
    expect(sampler.snapshot().samples).toBe(2);

    sampler.stop();
    sampler.stop(); // 重复调用安全，不抛
    await vi.advanceTimersByTimeAsync(600_000); // 10 分钟，若没停会再跑 20 轮
    expect(sampler.snapshot().samples).toBe(2);

    // stop 之后重新 start 能恢复（幂等，不是一次性）
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sampler.snapshot().samples).toBe(3);
    sampler.stop();
  });

  it('8b. jitterRatio 生效：默认 20% 错峰，random 固定为 1 时间隔变成 1.2 倍', async () => {
    vi.useFakeTimers();
    const sampler = createDbSampler({ db: sqliteDb(), dbType: 'sqlite', random: () => 1 }); // jitter 默认 0.2
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sampler.snapshot().samples).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000); // 30s 还没到 36s，不该采
    expect(sampler.snapshot().samples).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sampler.snapshot().samples).toBe(2);
    sampler.stop();
  });

  it('8c. stop 在 sample 进行中也能把后续轮次停掉', async () => {
    vi.useFakeTimers();
    const sampler = createDbSampler({ db: sqliteDb(), dbType: 'sqlite', jitterRatio: 0 });
    sampler.start();
    sampler.stop(); // 还没开始跑就停
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sampler.snapshot().samples).toBe(0);
  });
});

describe('探针延迟', () => {
  it('9. 三次采样拿到的 probeMs 都是 >= 0 的 number（不是 null/字符串）', async () => {
    const db = fakeDb({ pg_stat_activity: [], pg_locks: [], 'SELECT 1': [{ ok: 1 }] });
    const sampler = createDbSampler({ db, dbType: 'postgres' });
    for (let i = 0; i < 3; i += 1) {
      const snap = await sampler.sample('light'); // eslint-disable-line no-await-in-loop
      expect(typeof snap.probeMs).toBe('number');
      expect(Number.isFinite(snap.probeMs)).toBe(true);
      expect(snap.probeMs).toBeGreaterThanOrEqual(0);
    }
    expect(sampler.snapshot().lastLight.probeMs).toBeGreaterThanOrEqual(0);
  });
});
