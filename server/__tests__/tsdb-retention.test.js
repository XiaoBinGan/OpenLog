import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTsdbStore } from '../tsdb/store.js';
import {
  downsampleSeries, aggregate, downsampledName, formatResolution,
  parseDownsampledName, createTieredRetention, DEFAULT_TIERS, AGGREGATIONS,
} from '../tsdb/retention.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function makeAdapter(sqlite) {
  return {
    async run(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; const i = sqlite.prepare(sql).run(...f); return { changes: i.changes }; },
    async get(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).get(...f); },
    async all(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).all(...f); },
  };
}

describe('聚合函数', () => {
  const pts = (...vals) => vals.map((v, i) => ({ ts: i * 1000, value: v }));

  it('max / min / avg / count / sum', () => {
    const p = pts(1, 5, 3);
    expect(aggregate(p, 'max')).toBe(5);
    expect(aggregate(p, 'min')).toBe(1);
    expect(aggregate(p, 'avg')).toBe(3);
    expect(aggregate(p, 'count')).toBe(3);
    expect(aggregate(p, 'sum')).toBe(9);
  });

  it('空输入返回 null（不写 0 假装有数据）', () => {
    expect(aggregate([], 'max')).toBeNull();
  });

  it('跳过非有限值', () => {
    expect(aggregate([{ ts: 0, value: NaN }, { ts: 1, value: 5 }], 'max')).toBe(5);
  });
});

describe('降采样名', () => {
  it('生成带分辨率与聚合方式的名字', () => {
    expect(downsampledName('cpu', 300_000, 'max')).toBe('cpu:5m_max');
    expect(downsampledName('cpu', 3_600_000, 'avg')).toBe('cpu:1h_avg');
  });

  it('分辨率格式化', () => {
    expect(formatResolution(300_000)).toBe('5m');
    expect(formatResolution(3_600_000)).toBe('1h');
    expect(formatResolution(30_000)).toBe('30s');
  });

  it('能反解', () => {
    const r = parseDownsampledName('cpu:5m_max');
    expect(r).toEqual({ baseName: 'cpu', resolution: '5m', aggregation: 'max' });
  });

  it('普通指标名反解为 null', () => {
    expect(parseDownsampledName('openlog_cpu_usage_percent')).toBeNull();
    expect(parseDownsampledName('up')).toBeNull();
  });

  it('带冒号的记录规则名不误判', () => {
    // job:errors:rate5m 不是降采样产物
    expect(parseDownsampledName('job:errors:rate5m')).toBeNull();
  });
});

describe('分桶聚合', () => {
  it('按分辨率分桶', () => {
    // 10 分钟内每 5 分钟一个桶，共 2 个桶
    const series = [{
      name: 'cpu',
      labels: { host: 'a' },
      points: [
        { ts: T0, value: 1 },
        { ts: T0 + 1000, value: 3 },
        { ts: T0 + 5 * MIN, value: 10 },
      ],
    }];
    const out = downsampleSeries(series, 5 * MIN, ['max']);
    expect(out).toHaveLength(2);
    const first = out.find((s) => s.timestamp === Math.floor(T0 / (5 * MIN)) * (5 * MIN));
    expect(first.value).toBe(3);
    expect(first.name).toBe('cpu:5m_max');
    expect(first.labels).toEqual({ host: 'a' });
  });

  it('四个聚合各产出一条', () => {
    const series = [{ name: 'x', labels: {}, points: [{ ts: T0, value: 2 }, { ts: T0 + 1, value: 8 }] }];
    const out = downsampleSeries(series, 5 * MIN);
    expect(out).toHaveLength(4);
    expect(out.map((s) => parseDownsampledName(s.name).aggregation).sort()).toEqual(['avg', 'count', 'max', 'min']);
    expect(out.find((s) => s.name.endsWith('_max')).value).toBe(8);
    expect(out.find((s) => s.name.endsWith('_min')).value).toBe(2);
    expect(out.find((s) => s.name.endsWith('_avg')).value).toBe(5);
    expect(out.find((s) => s.name.endsWith('_count')).value).toBe(2);
  });

  it('**max 保留尖峰**（只存 avg 会把它抹平）', () => {
    const series = [{
      name: 'cpu', labels: {},
      points: [{ ts: T0, value: 1 }, { ts: T0 + 1, value: 99 }, { ts: T0 + 2, value: 1 }],
    }];
    const out = downsampleSeries(series, 5 * MIN, ['max', 'avg']);
    expect(out.find((s) => s.name.endsWith('_max')).value).toBe(99);
    expect(out.find((s) => s.name.endsWith('_avg')).value).toBeCloseTo(33.67, 1);
  });

  it('空输入返回空', () => {
    expect(downsampleSeries([], 5 * MIN)).toEqual([]);
    expect(downsampleSeries(null, 5 * MIN)).toEqual([]);
  });

  it('非法分辨率返回空', () => {
    expect(downsampleSeries([{ name: 'x', labels: {}, points: [{ ts: 0, value: 1 }] }], 0)).toEqual([]);
    expect(downsampleSeries([{ name: 'x', labels: {}, points: [{ ts: 0, value: 1 }] }], NaN)).toEqual([]);
  });

  it('桶下界对齐（同一时刻总在同一桶）', () => {
    const series = [{ name: 'x', labels: {}, points: [{ ts: 5 * MIN - 1, value: 1 }] }];
    const out = downsampleSeries(series, 5 * MIN, ['max']);
    expect(out[0].timestamp % (5 * MIN)).toBe(0);
  });
});

describe('分层保留', () => {
  let sqlite, store, retention;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    store = createTsdbStore({ getDb: () => makeAdapter(sqlite), getDbType: () => 'sqlite', now: () => T0 });
    await store.ensureSchema();
    retention = createTieredRetention({ store, now: () => T0, log: () => {} });
  });

  const DAY = 86_400_000;

  it('降采样后清理原始数据', async () => {
    // 写 10 天前的原始数据
    const old = T0 - 10 * DAY;
    const samples = [];
    for (let i = 0; i < 20; i += 1) {
      samples.push({ name: 'cpu', labels: { h: 'a' }, value: i, timestamp: old + i * 15_000 });
    }
    await store.writeSamples(samples);

    const r = await retention.run([{ resolutionMs: 5 * MIN, retentionDays: 90, sourceRetentionDays: 7 }], {
      rawRetentionDays: 7, batchDays: 30,
    });

    expect(r.errors).toEqual([]);
    expect(r.rawDeleted).toBeGreaterThan(0);

    // 原始已清
    const raw = await store.queryRange({ metricName: 'cpu', start: 0, end: T0 });
    expect(raw.series).toHaveLength(0);

    // 降采样产物在
    const ds = await store.queryRange({ metricName: 'cpu:5m_max', start: 0, end: T0 });
    expect(ds.series.length).toBeGreaterThan(0);
  });

  it('**降采样先写再删原始**（反过来会丢历史）', async () => {
    const old = T0 - 10 * DAY;
    await store.writeSamples(Array.from({ length: 10 }, (_, i) => ({
      name: 'm', labels: {}, value: i, timestamp: old + i * 15_000,
    })));

    const r = await retention.run([{ resolutionMs: 5 * MIN, retentionDays: 90, sourceRetentionDays: 7 }], {
      batchDays: 30,
    });
    // 降采样必须有产出，否则说明先删了
    expect(r.downsampleWritten).toBeGreaterThan(0);
  });

  it('保留期内的原始数据不动', async () => {
    const recent = T0 - 1 * DAY;
    await store.writeSamples([{ name: 'm', labels: {}, value: 1, timestamp: recent }]);
    await retention.run([{ resolutionMs: 5 * MIN, retentionDays: 90, sourceRetentionDays: 7 }], { batchDays: 30 });
    const r = await store.queryRange({ metricName: 'm', start: 0, end: T0 });
    expect(r.series).toHaveLength(1);
  });

  it('降采样数据超过保留期会被清', async () => {
    // 直接写一个 200 天前的降采样点
    await store.writeSamples([{ name: 'm:5m_max', labels: {}, value: 1, timestamp: T0 - 200 * DAY }]);
    const r = await retention.run([{ resolutionMs: 5 * MIN, retentionDays: 90, sourceRetentionDays: 7 }], { batchDays: 1 });
    expect(r.tierDeleted).toBeGreaterThan(0);
  });

  it('不重复降采样已有产物', async () => {
    const old = T0 - 10 * DAY;
    await store.writeSamples([
      { name: 'm', labels: {}, value: 1, timestamp: old },
      { name: 'm:5m_max', labels: {}, value: 9, timestamp: old },
    ]);
    await retention.run([{ resolutionMs: 5 * MIN, retentionDays: 90, sourceRetentionDays: 7 }], { batchDays: 30 });
    // 不该出现 m:5m_max:5m_max 这种二次降采样
    const names = await store.listMetricNames();
    expect(names.some((n) => n.startsWith('m:5m_max:'))).toBe(false);
  });

  it('非法分辨率被报告而不是静默跳过', async () => {
    const r = await retention.run([{ resolutionMs: 0, retentionDays: 90 }]);
    expect(r.errors.some((e) => /非法分辨率/.test(e))).toBe(true);
  });

  it('**降采样没追平时不删原始数据**（否则丢历史）', async () => {
    // 从 60 天前一直有数据，但只给 1 个 chunk 的预算
    const old = T0 - 60 * DAY;
    const samples = [];
    for (let i = 0; i < 50; i += 1) {
      samples.push({ name: 'm', labels: {}, value: i, timestamp: old + i * 86_400_000 });
    }
    await store.writeSamples(samples);

    const r = await retention.run(
      [{ resolutionMs: 5 * MIN, retentionDays: 90, sourceRetentionDays: 7 }],
      { batchDays: 1, maxChunks: 1 },
    );
    // 只推进了 1 天，远没到 7 天前 → 不该删原始
    expect(r.rawDeletedSkipped).toBeTruthy();
    expect(r.rawDeleted).toBe(0);
    const raw = await store.queryRange({ metricName: 'm', start: 0, end: T0 });
    expect(raw.series.length).toBeGreaterThan(0);
  });

  it('分多轮能逐步追平', async () => {
    const old = T0 - 20 * DAY;
    const samples = [];
    for (let i = 0; i < 20; i += 1) {
      samples.push({ name: 'm', labels: {}, value: i, timestamp: old + i * 86_400_000 });
    }
    await store.writeSamples(samples);

    let caughtUp = false;
    for (let round = 0; round < 40 && !caughtUp; round += 1) {
      const r = await retention.run(
        [{ resolutionMs: 5 * MIN, retentionDays: 90, sourceRetentionDays: 7 }],
        { batchDays: 5, maxChunks: 2 },
      );
      caughtUp = r.tiers[0]?.reachedCutoff === true;
    }
    expect(caughtUp).toBe(true);
  });

  it('oldestRawTimestamp 忽略降采样序列', async () => {
    const old = T0 - 10 * DAY;
    await store.writeSamples([
      { name: 'm:5m_max', labels: {}, value: 1, timestamp: old - 86_400_000 },
      { name: 'm', labels: {}, value: 1, timestamp: old },
    ]);
    const t = await store.oldestRawTimestamp();
    expect(t).toBe(old);
  });

  it('空库时 oldestRawTimestamp 返回 null', async () => {
    const sqlite2 = new Database(':memory:');
    const store2 = createTsdbStore({ getDb: () => makeAdapter(sqlite2), getDbType: () => 'sqlite', now: () => T0 });
    await store2.ensureSchema();
    expect(await store2.oldestRawTimestamp()).toBeNull();
  });

  it('DEFAULT_TIERS 是合理值', () => {
    expect(DEFAULT_TIERS[0].resolutionMs).toBe(5 * MIN);
    expect(DEFAULT_TIERS[0].retentionDays).toBe(90);
  });

  it('AGGREGATIONS 是四个值', () => {
    expect(AGGREGATIONS).toEqual(['max', 'min', 'avg', 'count']);
  });
});

describe('store 的分层清理方法', () => {
  let sqlite, store;
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    store = createTsdbStore({ getDb: () => makeAdapter(sqlite), getDbType: () => 'sqlite', now: () => T0 });
    await store.ensureSchema();
  });

  it('pruneSamplesBefore 不删降采样序列', async () => {
    const old = T0 - 10 * 86_400_000;
    await store.writeSamples([
      { name: 'raw', labels: {}, value: 1, timestamp: old },
      { name: 'raw:5m_max', labels: {}, value: 2, timestamp: old },
    ]);
    await store.pruneSamplesBefore(T0 - 86_400_000);
    const raw = await store.queryRange({ metricName: 'raw', start: 0, end: T0 });
    const ds = await store.queryRange({ metricName: 'raw:5m_max', start: 0, end: T0 });
    expect(raw.series).toHaveLength(0);
    expect(ds.series).toHaveLength(1);
  });

  it('pruneDownsampledBefore 只删指定分辨率', async () => {
    const old = T0 - 200 * 86_400_000;
    await store.writeSamples([
      { name: 'x:5m_max', labels: {}, value: 1, timestamp: old },
      { name: 'x:1h_max', labels: {}, value: 1, timestamp: old },
    ]);
    await store.pruneDownsampledBefore(5 * MIN, T0 - 86_400_000);
    const a = await store.queryRange({ metricName: 'x:5m_max', start: 0, end: T0 });
    const b = await store.queryRange({ metricName: 'x:1h_max', start: 0, end: T0 });
    expect(a.series).toHaveLength(0);
    expect(b.series).toHaveLength(1);
  });

  it('pruneSamplesBefore 不改动记录规则的普通名（含冒号但不是降采样）', async () => {
    const old = T0 - 10 * 86_400_000;
    await store.writeSamples([{ name: 'job:errors:rate5m', labels: {}, value: 1, timestamp: old }]);
    await store.pruneSamplesBefore(T0 - 86_400_000);
    const r = await store.queryRange({ metricName: 'job:errors:rate5m', start: 0, end: T0 });
    // 这个是原始数据（不是降采样产物），应该被清掉
    expect(r.series).toHaveLength(0);
  });
});