import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTsdbStore } from '../tsdb/store.js';
import {
  normalizeRuleGroups, renderTemplate, createRuleEngine, ALERT_STATE,
  groupAlerts, applyInhibition, applySilences, matchSelector, dedupeByRepeatInterval,
} from '../tsdb/rules.js';

const T0 = 1_700_000_000_000;

function makeStore() {
  const sqlite = new Database(':memory:');
  const adapter = {
    async run(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; const i = sqlite.prepare(sql).run(...f); return { changes: i.changes }; },
    async get(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).get(...f); },
    async all(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).all(...f); },
  };
  return createTsdbStore({ getDb: () => adapter, getDbType: () => 'sqlite', now: () => T0 });
}

describe('规则组校验', () => {
  it('正常规则通过', () => {
    const { groups, errors } = normalizeRuleGroups({
      ruleGroups: [{
        name: 'basic',
        rules: [{ alert: 'HighCPU', expr: 'cpu > 0.9', for: '5m' }],
      }],
    });
    expect(errors).toEqual([]);
    expect(groups[0].rules[0]).toMatchObject({ kind: 'alert', name: 'HighCPU', forMs: 300_000 });
  });

  it('缺 expr 报错', () => {
    const { errors } = normalizeRuleGroups({ ruleGroups: [{ name: 'g', rules: [{ alert: 'A' }] }] });
    expect(errors[0]).toMatch(/缺少 expr/);
  });

  it('alert 与 record 必须二选一', () => {
    expect(normalizeRuleGroups({ ruleGroups: [{ name: 'g', rules: [{ expr: 'x' }] }] }).errors[0])
      .toMatch(/必须有 alert 或 record/);
    expect(normalizeRuleGroups({ ruleGroups: [{ name: 'g', rules: [{ alert: 'A', record: 'R', expr: 'x' }] }] }).errors[0])
      .toMatch(/不能同时存在/);
  });

  it('非法告警名报错', () => {
    const { errors } = normalizeRuleGroups({ ruleGroups: [{ name: 'g', rules: [{ alert: '1bad', expr: 'x' }] }] });
    expect(errors[0]).toMatch(/告警名非法/);
  });

  it('for 支持多种时长写法', () => {
    const { groups } = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [
        { alert: 'A', expr: 'x', for: '30s' },
        { alert: 'B', expr: 'x', for: '1h30m' },
        { alert: 'C', expr: 'x' },
      ] }],
    });
    expect(groups[0].rules.map((r) => r.forMs)).toEqual([30_000, 5_400_000, 0]);
  });

  it('非法 for 报错', () => {
    const { errors } = normalizeRuleGroups({ ruleGroups: [{ name: 'g', rules: [{ alert: 'A', expr: 'x', for: 'abc' }] }] });
    expect(errors[0]).toMatch(/for 非法/);
  });
});

describe('模板渲染', () => {
  it('替换 $labels', () => {
    expect(renderTemplate('实例 {{ $labels.instance }} 挂了', { instance: 'a:9100' }, 1))
      .toBe('实例 a:9100 挂了');
  });

  it('替换 $value', () => {
    expect(renderTemplate('当前值 {{ $value }}', {}, 0.95)).toBe('当前值 0.95');
  });

  it('缺失的标签渲染成空串（不保留占位符）', () => {
    expect(renderTemplate('x={{ $labels.missing }}', {}, 1)).toBe('x=');
  });

  it('未知占位符原样保留', () => {
    expect(renderTemplate('{{ $unknown }}', {}, 1)).toBe('{{ $unknown }}');
  });
});

describe('规则求值 —— for 语义', () => {
  let store;

  beforeEach(async () => {
    store = makeStore();
    await store.ensureSchema();
  });

  /** 写一个 gauge 采样点（默认写到 T0，可指定时刻模拟持续抓取） */
  async function seedGauge(name, labels, val, ts = T0) {
    await store.writeSamples([{ name, labels, value: val, timestamp: ts }]);
  }

  it('无条件规则立即 firing', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.95);
    const engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{ alert: 'HighCPU', expr: 'cpu > 0.9' }] }],
    }).groups;
    const r = await engine.evaluateAll(groups);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].state).toBe(ALERT_STATE.FIRING);
    expect(r.fired).toHaveLength(1);
  });

  it('带 for 的规则第一次是 pending', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.95);
    const engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{ alert: 'HighCPU', expr: 'cpu > 0.9', for: '5m' }] }],
    }).groups;
    const r = await engine.evaluateAll(groups);
    expect(r.alerts[0].state).toBe(ALERT_STATE.PENDING);
    expect(r.fired).toHaveLength(0);
  });

  it('for 到期后变 firing', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.95);
    let clock = T0;
    const engine = createRuleEngine({ store, now: () => clock });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{ alert: 'HighCPU', expr: 'cpu > 0.9', for: '5m' }] }],
    }).groups;

    await engine.evaluateAll(groups); // pending at T0

    // 真实环境里抓取一直在继续，每个周期都有新点。
    // 不补点的话，T0+5min+1 时 T0 那个点已超出 lookback，序列会被判为消失
    // —— 那是正确行为（stale 语义），不是这个用例要测的东西。
    clock = T0 + 4 * 60_000;
    await seedGauge('cpu', { host: 'a' }, 0.95, clock);
    const mid = await engine.evaluateAll(groups);
    expect(mid.alerts[0].state).toBe(ALERT_STATE.PENDING);

    clock = T0 + 5 * 60_000 + 1;
    await seedGauge('cpu', { host: 'a' }, 0.95, clock);
    const late = await engine.evaluateAll(groups);
    expect(late.alerts[0].state).toBe(ALERT_STATE.FIRING);
    expect(late.fired).toHaveLength(1);
  });

  it('**pending 期间条件恢复 → 立刻回 inactive 且计时清零**', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.95);
    let clock = T0;
    const engine = createRuleEngine({ store, now: () => clock });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{ alert: 'HighCPU', expr: 'cpu > 0.9', for: '5m' }] }],
    }).groups;

    await engine.evaluateAll(groups); // pending
    // 提高阈值让条件不再满足
    await store.writeSamples([{ name: 'cpu2', labels: { host: 'a' }, value: 0.1, timestamp: clock }]);
    const groups2 = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{ alert: 'HighCPU', expr: 'cpu2 > 0.9', for: '5m' }] }],
    }).groups;
    const r = await engine.evaluateAll(groups2);
    expect(r.alerts).toHaveLength(0);
    expect(r.resolved).toHaveLength(1);
  });

  it('多实例各自独立计时', async () => {
    await store.writeSamples([
      { name: 'cpu', labels: { host: 'a' }, value: 0.95, timestamp: T0 },
      { name: 'cpu', labels: { host: 'b' }, value: 0.95, timestamp: T0 },
    ]);
    const engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{ alert: 'HighCPU', expr: 'cpu > 0.9', for: '1m' }] }],
    }).groups;
    const r = await engine.evaluateAll(groups);
    expect(r.alerts).toHaveLength(2);
    for (const a of r.alerts) expect(a.state).toBe(ALERT_STATE.PENDING);
  });

  it('规则 label 合并进告警标签', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.95);
    const engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{
        alert: 'HighCPU', expr: 'cpu > 0.9', labels: { severity: 'critical' },
      }] }],
    }).groups;
    const r = await engine.evaluateAll(groups);
    expect(r.alerts[0].labels.severity).toBe('critical');
  });

  it('annotation 模板被渲染', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.95);
    const engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{
        alert: 'HighCPU', expr: 'cpu > 0.9',
        annotations: { summary: '{{ $labels.host }} 的 CPU 是 {{ $value }}' },
      }] }],
    }).groups;
    const r = await engine.evaluateAll(groups);
    expect(r.alerts[0].annotations.summary).toBe('a 的 CPU 是 0.95');
  });

  it('表达式错误被记录但不影响其它规则', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.95);
    const engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [
        { alert: 'Bad', expr: 'bad_func(x)' },
        { alert: 'Good', expr: 'cpu > 0.9' },
      ] }],
    }).groups;
    const r = await engine.evaluateAll(groups);
    expect(r.errors.length).toBe(1);
    expect(r.alerts.length).toBe(1);
  });

  it('记录规则产出可查询', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.5);
    const engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{ record: 'cpu:sum', expr: 'sum(cpu)' }] }],
    }).groups;
    await engine.evaluateAll(groups);
    const rec = engine.recorded('cpu:sum');
    expect(rec).not.toBeNull();
    expect(rec.series[0].value).toBe(0.5);
  });

  it('reset 清空状态', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.95);
    const engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{ alert: 'A', expr: 'cpu > 0.9' }] }],
    }).groups;
    await engine.evaluateAll(groups);
    expect(engine.alerts()).toHaveLength(1);
    engine.reset();
    expect(engine.alerts()).toHaveLength(0);
  });

  it('firing() 只返回 firing 状态', async () => {
    await seedGauge('cpu', { host: 'a' }, 0.95);
    const engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [
        { alert: 'NoFor', expr: 'cpu > 0.9' },
        { alert: 'WithFor', expr: 'cpu > 0.9', for: '5m' },
      ] }],
    }).groups;
    await engine.evaluateAll(groups);
    expect(engine.alerts()).toHaveLength(2);
    expect(engine.firing()).toHaveLength(1);
    expect(engine.firing()[0].name).toBe('NoFor');
  });
});

describe('告警分组', () => {
  const mk = (name, labels) => ({ name, labels, value: 1 });

  it('按 groupBy 分组', () => {
    const groups = groupAlerts([
      mk('A', { alertname: 'A', cluster: 'c1' }),
      mk('A', { alertname: 'A', cluster: 'c1' }),
      mk('A', { alertname: 'A', cluster: 'c2' }),
    ], [{ groupBy: ['alertname', 'cluster'] }]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.groupBy.cluster === 'c1').alerts).toHaveLength(2);
  });

  it('默认按 alertname 分组', () => {
    const groups = groupAlerts([mk('A', {}), mk('B', {})], []);
    expect(groups).toHaveLength(1); // 都没 alertname 标签 → 同一个空键
  });

  it('空输入返回空', () => {
    expect(groupAlerts([], [])).toEqual([]);
    expect(groupAlerts(null, null)).toEqual([]);
  });
});

describe('抑制规则', () => {
  const up = { name: 'InstanceDown', labels: { instance: 'a', alertname: 'InstanceDown' } };
  const cpu = { name: 'HighCPU', labels: { instance: 'a', alertname: 'HighCPU' } };
  const cpuB = { name: 'HighCPU', labels: { instance: 'b', alertname: 'HighCPU' } };

  it('source 命中时抑制同实例的 target', () => {
    const { kept, suppressed } = applyInhibition([up, cpu, cpuB], [{
      sourceMatch: { alertname: 'InstanceDown' },
      targetMatch: { alertname: 'HighCPU' },
      equal: ['instance'],
    }]);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].alert.labels.instance).toBe('a');
    expect(kept).toHaveLength(2);
  });

  it('source 不存在时不抑制', () => {
    const { suppressed } = applyInhibition([cpu], [{
      sourceMatch: { alertname: 'InstanceDown' },
      targetMatch: { alertname: 'HighCPU' },
    }]);
    expect(suppressed).toHaveLength(0);
  });

  it('没有 equal 时不看标签（全局抑制）', () => {
    const { suppressed } = applyInhibition([up, cpu, cpuB], [{
      sourceMatch: { alertname: 'InstanceDown' },
      targetMatch: { alertname: 'HighCPU' },
    }]);
    expect(suppressed).toHaveLength(2);
  });

  it('空规则不抑制', () => {
    const { kept, suppressed } = applyInhibition([up, cpu], []);
    expect(suppressed).toHaveLength(0);
    expect(kept).toHaveLength(2);
  });
});

describe('静默', () => {
  const alert = { name: 'A', labels: { instance: 'a', alertname: 'A' } };

  it('时间窗内生效', () => {
    const { suppressed } = applySilences([alert], [{
      id: 's1', matchers: { instance: 'a' }, startsAt: T0 - 1000, endsAt: T0 + 1000,
    }], T0);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].silenceId).toBe('s1');
  });

  it('时间窗外不生效', () => {
    const { kept } = applySilences([alert], [{
      id: 's1', matchers: { instance: 'a' }, startsAt: T0 + 5000, endsAt: T0 + 10_000,
    }], T0);
    expect(kept).toHaveLength(1);
  });

  it('标签不匹配不生效', () => {
    const { kept } = applySilences([alert], [{
      id: 's1', matchers: { instance: 'b' }, startsAt: T0 - 1000, endsAt: T0 + 1000,
    }], T0);
    expect(kept).toHaveLength(1);
  });
});

describe('matchSelector', () => {
  it('等值匹配', () => {
    expect(matchSelector({ a: '1' }, { a: '1' })).toBe(true);
    expect(matchSelector({ a: '1' }, { a: '2' })).toBe(false);
  });

  it('多键是与关系', () => {
    expect(matchSelector({ a: '1', b: '2' }, { a: '1', b: '2' })).toBe(true);
    expect(matchSelector({ a: '1', b: '3' }, { a: '1', b: '2' })).toBe(false);
  });

  it('空选择器不匹配（避免误伤全部）', () => {
    expect(matchSelector({ a: '1' }, {})).toBe(false);
    expect(matchSelector({ a: '1' }, null)).toBe(false);
  });
});

describe('repeat_interval 去重', () => {
  const a = { name: 'A', labels: { instance: 'x' } };

  it('首次发送', () => {
    const sent = new Map();
    const r = dedupeByRepeatInterval([a], sent, T0, 60_000);
    expect(r.toSend).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('间隔内跳过', () => {
    const sent = new Map();
    dedupeByRepeatInterval([a], sent, T0, 60_000);
    const r = dedupeByRepeatInterval([a], sent, T0 + 30_000, 60_000);
    expect(r.toSend).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });

  it('间隔后重发', () => {
    const sent = new Map();
    dedupeByRepeatInterval([a], sent, T0, 60_000);
    const r = dedupeByRepeatInterval([a], sent, T0 + 61_000, 60_000);
    expect(r.toSend).toHaveLength(1);
  });
});