/**
 * SQLite 表体积采样（Lead 在 4卡T4 上实测发现的真缺陷）
 *
 * 现象：T4 的数据库面板「表体积」永远 0 张表（`available:false`）。
 * 原因：`sampleSqlite('heavy')` 只做了 quick_check，**根本没采 tables** ——
 * PG 分支有 pg_total_relation_size 可查，SQLite 分支当时直接漏了这一段。
 * 面板就永远显示「没有表」，而实际库里有 11 张表在写指标。
 *
 * 这里锁三件事：
 *   1. heavy 会给每张表真实字节数（dbstat）+ 真实行数（count(*)）
 *   2. 发行版没开 dbstat 时，退到只列表名，并把原因写进 unavailable（不编造体积 0）
 *   3. 单表 count 失败不影响其它表（大库上被权限/超时卡住也得partially 可用）
 */
import { describe, it, expect, vi } from 'vitest';
import { createDbSampler } from '../metrics/db-sampler.js';

/** 极简 sqlite 假驱动：按 SQL 前缀应答，记录收到的 SQL */
function fakeSqlite({ dbstat = true, counts = {}, failCountFor = [] } = {}) {
  const seen = [];
  const db = {
    async all(sql) {
      seen.push(sql);
      if (/FROM dbstat/i.test(sql)) {
        if (!dbstat) throw new Error('no such table: dbstat');
        // 真实 SQL 里有 JOIN sqlite_master ... m.type='table'，索引不会进来
        return [
          { name: 'log_records', bytes: 409600 },
          { name: 'api_metrics_minute', bytes: 909312 },
          { name: 'kv_store', bytes: 12288 },
        ];
      }
      if (/sqlite_master/i.test(sql)) {
        return [{ name: 'log_records' }, { name: 'api_metrics_minute' }, { name: 'kv_store' }];
      }
      if (/quick_check/i.test(sql)) return [{ quick_check: 'ok' }];
      return [];
    },
    async get(sql) {
      seen.push(sql);
      if (/PRAGMA page_count/i.test(sql)) return { page_count: 17 };
      if (/PRAGMA page_size/i.test(sql)) return { page_size: 4096 };
      if (/PRAGMA quick_check/i.test(sql)) return { quick_check: 'ok' };
      const m = /FROM "(.+)"$/.exec(sql);
      if (m) {
        const table = m[1];
        if (failCountFor.includes(table)) throw new Error(`disk I/O error on ${table}`);
        return { n: counts[table] ?? 100 };
      }
      return { ok: 1 };
    },
    async run() { return { changes: 0 }; },
    async exec() { /* noop */ },
  };
  return { db, seen };
}

const makeSampler = (db, extra = {}) => createDbSampler({
  db, dbType: 'sqlite', enabled: () => true, ...extra,
});

describe('sampleSqlite heavy —— 表体积', () => {
  it('dbstat 可用：每张表都有真实字节数与行数', async () => {
    const { db } = fakeSqlite({ counts: { log_records: 1200, api_metrics_minute: 5436, kv_store: 7 } });
    const sampler = makeSampler(db);
    const snap = await sampler.sample('heavy');

    expect(snap.ok).toBe(true);
    expect(Array.isArray(snap.tables)).toBe(true);
    expect(snap.tables).toHaveLength(3);
    // 按字节降序（dbstat 查询已排序，这里验证没被打乱）
    expect(snap.tables[0]).toMatchObject({ relname: 'api_metrics_minute', bytes: 909312, liveTup: 5436 });
    expect(snap.tables[1]).toMatchObject({ relname: 'log_records', bytes: 409600, liveTup: 1200 });
    expect(snap.tables[2]).toMatchObject({ relname: 'kv_store', bytes: 12288, liveTup: 7 });
    // SQLite 没有死元组概念 → null，不是 0
    expect(snap.tables.every((t) => t.deadTup === null)).toBe(true);
    expect(snap.unavailable).toEqual([]);
  });

  it('行数是去真库 count(*) 得来的', async () => {
    const { db, seen } = fakeSqlite();
    await makeSampler(db).sample('heavy');
    const countSqls = seen.filter((s) => /^SELECT COUNT\(\*\) AS n FROM/.test(s));
    expect(countSqls.length).toBe(3);
    // 按字节降序后，最大的是 api_metrics_minute
    expect(countSqls[0]).toContain('"api_metrics_minute"');
    expect(countSqls.join(' ')).toContain('"log_records"');
  });

  it('dbstat 不可用：只列表名 + 把原因写进 unavailable（绝不编体积 0）', async () => {
    const { db } = fakeSqlite({ dbstat: false });
    const snap = await makeSampler(db).sample('heavy');

    expect(snap.tables).toHaveLength(3);
    // 体积必须是 null，不能是 0
    expect(snap.tables.every((t) => t.bytes === null)).toBe(true);
    expect(snap.tables.map((t) => t.relname)).toEqual(['log_records', 'api_metrics_minute', 'kv_store']);
    expect(snap.unavailable.join(' ')).toContain('dbstat');
    expect(snap.unavailable.join(' ')).toContain('表体积不可得');
  });

  it('单表 count 失败不影响其它表', async () => {
    const { db } = fakeSqlite({ failCountFor: ['log_records'] });
    const snap = await makeSampler(db).sample('heavy');

    const logs = snap.tables.find((t) => t.relname === 'log_records');
    expect(logs.bytes).toBe(409600);       // 体积还在
    expect(logs.liveTup).toBe(null);        // 行数拿不到 → null，不是 0
    const others = snap.tables.filter((t) => t.relname !== 'log_records');
    expect(others.every((t) => typeof t.liveTup === 'number')).toBe(true);
    expect(snap.ok).toBe(true);
  });

  it('quick_check 仍然照跑，且 6 小时内第二轮跳过（不重复扫全库）', async () => {
    const { db, seen } = fakeSqlite();
    const sampler = makeSampler(db);
    const first = await sampler.sample('heavy');
    expect(first.quickCheck.skipped).toBe(false);
    expect(first.quickCheck.ok).toBe(true);

    const second = await sampler.sample('heavy');
    expect(second.quickCheck.skipped).toBe(true);
    // 第二轮虽然跳过 quick_check，但表体积仍然要采（否则面板会闪空）
    expect(second.tables).toHaveLength(3);
    const quickChecks = seen.filter((s) => /quick_check/i.test(s));
    expect(quickChecks.length).toBe(1);
  });

  it('表数量上限 20（避免在大库上拖时间）', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, bytes: 1000 * (30 - i) }));
    const db = {
      async all(sql) {
        if (/FROM dbstat/i.test(sql)) return many.slice(0, 20); // 真 SQL 里 LIMIT 20
        if (/quick_check/i.test(sql)) return [{ quick_check: 'ok' }];
        return [];
      },
      async get(sql) {
        if (/COUNT/.test(sql)) return { n: 1 };
        return { ok: 1 };
      },
      async run() { return {}; },
      async exec() { /* noop */ },
    };
    const snap = await makeSampler(db).sample('heavy');
    expect(snap.tables).toHaveLength(20);
  });
});

describe('sampleSqlite light —— 体积与探针', () => {
  it('page_count × page_size 得库大小，探针用单调时钟', async () => {
    const { db } = fakeSqlite();
    const snap = await makeSampler(db).sample('light');
    expect(snap.sqlite.sizeBytes).toBe(17 * 4096);
    expect(typeof snap.probeMs).toBe('number');
    expect(snap.probeMs).toBeGreaterThanOrEqual(0);
  });
});
