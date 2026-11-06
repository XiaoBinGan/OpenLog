import { describe, it, expect } from 'vitest';
import {
  normalizeDbSnapshot,
  poolUsage,
  poolLevel,
  topTables,
  formatBytes,
  formatIndexHit,
  unavailableReason,
  buildProbeSeries,
} from './dbMetrics';
import type { DbTableStat } from './dbMetrics';

// ─── normalizeDbSnapshot ────────────────────────────────────────────────────
describe('normalizeDbSnapshot', () => {
  it('null / undefined / 字符串 / 数组一律兜底成空结构', () => {
    for (const bad of [null, undefined, 'oops', 42, [], [1, 2]]) {
      const s = normalizeDbSnapshot(bad);
      expect(s.pool).toBeNull();
      expect(s.tables).toEqual([]);
      expect(s.unavailable).toEqual([]);
      expect(s.type).toBeNull();
      expect(s.probeMs).toBeNull();
      expect(s.enabled).toBeUndefined(); // 未知 ≠ 关闭
    }
  });

  it('完整 payload 原样保留（PG 形状）', () => {
    const s = normalizeDbSnapshot({
      enabled: true,
      type: 'postgres',
      pool: { total: 8, idle: 3, waiting: 1, max: 20 },
      lastLight: { kind: 'light', tsMs: 1700000000000, probeMs: 1.4 },
      lastHeavy: { kind: 'heavy', tables: [{ name: 'users', bytes: 8192 }] },
      unavailable: ['pg_locks'],
      probeMs: 1.4,
      storage: { rows: 1234, approxBytes: 65536 },
    });
    expect(s.enabled).toBe(true);
    expect(s.type).toBe('postgres');
    expect(s.pool).toEqual({ total: 8, idle: 3, waiting: 1, max: 20 });
    expect(s.lastLight?.tsMs).toBe(1700000000000);
    expect(s.tables.map((t) => t.name)).toEqual(['users']);
    expect(s.storage).toEqual({ rows: 1234, approxBytes: 65536 });
  });

  it('脏字段逐项降级：字符串数字转数字、NaN/布尔/对象转 null', () => {
    const s = normalizeDbSnapshot({
      type: '   ',
      pool: { total: '12', idle: Number.NaN, waiting: true, max: {} },
      probeMs: '3.5',
      storage: { rows: '99', approxBytes: 'nope' },
    });
    expect(s.type).toBeNull();
    expect(s.pool).toEqual({ total: 12, idle: null, waiting: null, max: null });
    expect(s.probeMs).toBe(3.5);
    expect(s.storage).toEqual({ rows: 99, approxBytes: null });
  });

  it('pool 四字段全空时整体判为 null（没接线 ≠ 全 0）', () => {
    expect(normalizeDbSnapshot({ pool: {} }).pool).toBeNull();
    expect(normalizeDbSnapshot({ pool: { total: null, idle: null, waiting: null, max: null } }).pool).toBeNull();
    expect(normalizeDbSnapshot({ pool: [1, 2, 3] }).pool).toBeNull();
  });

  it('tables 非数组给空数组；无表名/非对象的行被丢弃；relname 别名被识别', () => {
    expect(normalizeDbSnapshot({ tables: { a: 1 } }).tables).toEqual([]);
    const s = normalizeDbSnapshot({
      tables: [
        null, 'x', { bytes: 100 }, { name: '  ' },
        { relname: 'orders', bytes: 2048, live_tup: 10, dead_tup: 2, idx_scan: 9, seq_scan: 1 },
      ],
    });
    expect(s.tables).toHaveLength(1);
    expect(s.tables[0]).toMatchObject({ name: 'orders', bytes: 2048, liveTup: 10, deadTup: 2 });
  });

  it('缺顶层 tables 时回退到 lastHeavy.tables，并用 lastLight.probeMs 补 probeMs', () => {
    const s = normalizeDbSnapshot({ lastHeavy: { tables: [{ name: 'logs', bytes: '4096' }] }, lastLight: { probeMs: 7 } });
    expect(s.tables).toEqual([{ name: 'logs', bytes: 4096, liveTup: null, deadTup: null, indexHitRate: null }]);
    expect(s.probeMs).toBe(7);
  });

  it('indexHitRate 两种口径都能收：0.98 保持，98 折算成 0.98', () => {
    const s = normalizeDbSnapshot({
      tables: [{ name: 'a', index_hit_rate: 0.98 }, { name: 'b', index_hit_rate: 98 }, { name: 'c', index_hit_rate: 7 }],
    });
    expect(s.tables[0].indexHitRate).toBeCloseTo(0.98, 4);
    expect(s.tables[1].indexHitRate).toBeCloseTo(0.98, 4);
    expect(s.tables[2].indexHitRate).toBeCloseTo(0.07, 4); // 有歧义时按百分数折算
  });

  it('unavailable 只保留非空字符串并去重', () => {
    const s = normalizeDbSnapshot({ unavailable: ['pg_locks', ' pg_locks ', '', 3, null, 'pg_tables'] });
    expect(s.unavailable).toEqual(['pg_locks', 'pg_tables']);
    expect(normalizeDbSnapshot({ unavailable: 'pg_locks' }).unavailable).toEqual([]);
  });
});

// ─── poolUsage ──────────────────────────────────────────────────────────────
describe('poolUsage', () => {
  it('正常情况算 ratio 并给出 total/max 文案', () => {
    const u = poolUsage({ total: 5, idle: 2, waiting: 0, max: 20 });
    expect(u.ratio).toBeCloseTo(0.25, 6);
    expect(u.label).toContain('25.0%');
    expect(u.label).toContain('5/20');
    expect(u.label).not.toContain('等待');
  });

  it('max=0 不除零：ratio 给 null，文案回退成连接数', () => {
    const u = poolUsage({ total: 3, idle: 0, waiting: 0, max: 0 });
    expect(u.ratio).toBeNull();
    expect(u.label).toContain('3 个连接');
    expect(u.label).not.toContain('3/0');
  });

  it('max 为 null 时同样不算占比', () => {
    expect(poolUsage({ total: 3, idle: 1, waiting: null, max: null }).ratio).toBeNull();
  });

  it('waiting>0 必须出现在文案里（唯一可靠的打满信号）', () => {
    const u = poolUsage({ total: 20, idle: 0, waiting: 7, max: 20 });
    expect(u.ratio).toBe(1);
    expect(u.label).toContain('7 个等待');
  });

  it('pool 为 null/undefined 时不崩，给出不可用文案', () => {
    expect(poolUsage(null)).toEqual({ ratio: null, label: '连接池信息不可用' });
    expect(poolUsage(undefined).label).toBe('连接池信息不可用');
  });

  it('total 超过 max 时 ratio 夹到 1', () => {
    expect(poolUsage({ total: 30, idle: 0, waiting: 0, max: 20 }).ratio).toBe(1);
  });
});

// ─── poolLevel ──────────────────────────────────────────────────────────────
describe('poolLevel', () => {
  it('三档：<70% ok、70~90% warn、>=90% bad', () => {
    expect(poolLevel(0.3, 0)).toBe('ok');
    expect(poolLevel(0.699, 0)).toBe('ok');
    expect(poolLevel(0.7, 0)).toBe('warn');
    expect(poolLevel(0.899, 0)).toBe('warn');
    expect(poolLevel(0.9, 0)).toBe('bad');
    expect(poolLevel(1, 0)).toBe('bad');
  });

  it('waiting>0 直接 bad，哪怕 ratio 很低', () => {
    expect(poolLevel(0.1, 1)).toBe('bad');
    expect(poolLevel(null, 5)).toBe('bad');
  });

  it('ratio 未知且没人等待时不当故障（交给 unavailable 警示条解释）', () => {
    expect(poolLevel(null, null)).toBe('ok');
    expect(poolLevel(null, 0)).toBe('ok');
  });
});

// ─── topTables ──────────────────────────────────────────────────────────────
describe('topTables', () => {
  const mk = (name: string, bytes: number | null): DbTableStat =>
    ({ name, bytes, liveTup: null, deadTup: null, indexHitRate: null });

  it('按 bytes 降序', () => {
    expect(topTables([mk('a', 10), mk('b', 300), mk('c', 50)]).map((t) => t.name)).toEqual(['b', 'c', 'a']);
  });

  it('bytes 为 null 的排最后，且不被丢弃', () => {
    const out = topTables([mk('n1', null), mk('big', 900), mk('n2', null), mk('small', 1)]);
    expect(out.map((t) => t.name)).toEqual(['big', 'small', 'n1', 'n2']);
    expect(out).toHaveLength(4);
  });

  it('默认 limit 10，自定义 limit 生效，limit=0 给空数组', () => {
    const many = Array.from({ length: 25 }, (_, i) => mk(`t${i}`, i));
    expect(topTables(many)).toHaveLength(10);
    expect(topTables(many, 3).map((t) => t.name)).toEqual(['t24', 't23', 't22']);
    expect(topTables(many, 0)).toEqual([]);
  });

  it('undefined / 空数组 / 脏行都安全', () => {
    expect(topTables(undefined)).toEqual([]);
    expect(topTables([])).toEqual([]);
    expect(topTables([null as unknown as DbTableStat, mk('', 5), mk('ok', 1)]).map((t) => t.name)).toEqual(['ok']);
  });
});

// ─── formatBytes ────────────────────────────────────────────────────────────
describe('formatBytes', () => {
  it('字节 / KB / MB / GB 按 1024 进制', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB');
    expect(formatBytes(1024 ** 3 * 2.5)).toBe('2.5 GB');
  });

  it('null / undefined / NaN / 负数 一律 —（读不到 ≠ 0 字节）', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-5)).toBe('—');
  });
});

// ─── formatIndexHit ─────────────────────────────────────────────────────────
describe('formatIndexHit', () => {
  it('0 / 0.5 / 1 格式化', () => {
    expect(formatIndexHit(0)).toBe('0.0%');
    expect(formatIndexHit(0.5)).toBe('50.0%');
    expect(formatIndexHit(1)).toBe('100.0%');
    expect(formatIndexHit(0.98)).toBe('98.0%');
  });

  it('null / undefined / NaN → —', () => {
    expect(formatIndexHit(null)).toBe('—');
    expect(formatIndexHit(undefined)).toBe('—');
    expect(formatIndexHit(Number.NaN)).toBe('—');
  });

  it('越界值夹到 0~100%', () => {
    expect(formatIndexHit(1.4)).toBe('100.0%');
    expect(formatIndexHit(-0.2)).toBe('0.0%');
  });
});

// ─── unavailableReason ──────────────────────────────────────────────────────
describe('unavailableReason', () => {
  it('空数组 / 非数组 → 空串（组件据此决定不显示警示条）', () => {
    expect(unavailableReason([])).toBe('');
    expect(unavailableReason(undefined)).toBe('');
    expect(unavailableReason('pg_locks' as unknown as string[])).toBe('');
  });

  it('单项翻成人话并保留原始键名便于排查', () => {
    const text = unavailableReason(['pg_stat_activity']);
    expect(text).toBe('权限不足，看不到其他会话（pg_stat_activity）');
  });

  it('多条用「；」拼接，未知键给通用说明', () => {
    const parts = unavailableReason(['pg_stat_activity', 'pg_locks', 'weird_key']).split('；');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toContain('锁等待');
    expect(parts[2]).toContain('weird_key');
  });

  it('重复键只算一次；dialect: 前缀单独解释；路由层给的中文原因原样透出', () => {
    expect(unavailableReason(['pg_locks', 'pg_locks', 'dialect:mysql']).split('；')).toHaveLength(2);
    expect(unavailableReason(['dialect:mysql'])).toContain('mysql');
    // server/routes/db-monitor.js 在 sampler 未接线时直接写中文，套壳会变成「…（sampler 未接入）」
    expect(unavailableReason(['sampler 未接入'])).toBe('sampler 未接入');
  });
});

// ─── buildProbeSeries ───────────────────────────────────────────────────────
describe('buildProbeSeries', () => {
  it('按时间升序排列，丢掉缺失/负数/非数采样', () => {
    const out = buildProbeSeries([
      { tsMs: 3000, probeMs: 3 },
      { tsMs: 1000, probeMs: 1 },
      { tsMs: 2000, probeMs: null },
      { tsMs: 2500 },
      { tsMs: 2600, probeMs: -1 },
      { tsMs: 2700, probeMs: Number.NaN },
    ]);
    expect(out).toEqual([{ t: 1000, v: 1 }, { t: 3000, v: 3 }]);
  });

  it('limit 只保留最近 N 个点', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ tsMs: 1000 + i, probeMs: i }));
    expect(buildProbeSeries(samples, 3)).toEqual([{ t: 1007, v: 7 }, { t: 1008, v: 8 }, { t: 1009, v: 9 }]);
  });

  it('默认保留 60 个点；空输入与脏输入给空数组', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ tsMs: i, probeMs: 1 }));
    expect(buildProbeSeries(many)).toHaveLength(60);
    expect(buildProbeSeries([])).toEqual([]);
    expect(buildProbeSeries(null as unknown as Array<{ tsMs: number; probeMs?: number | null }>)).toEqual([]);
    expect(buildProbeSeries([null as unknown as { tsMs: number }])).toEqual([]);
  });
});
