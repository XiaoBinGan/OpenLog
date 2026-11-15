import { describe, it, expect } from 'vitest';
import {
  validateQueryArgs, parseTimeArg, summarizeQueryResult, summarizeSeries,
  explainQueryError, METRICS_TOOL_DEFINITION, LIST_METRICS_TOOL_DEFINITION,
  MAX_RANGE_MS, MAX_SERIES,
} from '../tsdb/ai-tools.js';

const T0 = 1_700_000_000_000;

describe('时间参数解析', () => {
  it('相对写法', () => {
    expect(parseTimeArg('-1h', T0)).toBe(T0 - 3_600_000);
    expect(parseTimeArg('-30m', T0)).toBe(T0 - 1_800_000);
    expect(parseTimeArg('-7d', T0)).toBe(T0 - 7 * 86_400_000);
  });

  it('秒级时间戳', () => {
    expect(parseTimeArg('1700000000', T0)).toBe(1_700_000_000_000);
  });

  it('毫秒级时间戳', () => {
    expect(parseTimeArg('1700000000000', T0)).toBe(1_700_000_000_000);
  });

  it('ISO 字符串', () => {
    expect(parseTimeArg('2023-11-14T22:13:20Z', T0)).toBe(1_700_000_000_000);
  });

  it('空值返回 null', () => {
    expect(parseTimeArg(null, T0)).toBeNull();
    expect(parseTimeArg('', T0)).toBeNull();
    expect(parseTimeArg(undefined, T0)).toBeNull();
  });

  it('非法值返回 null', () => {
    expect(parseTimeArg('abc', T0)).toBeNull();
    expect(parseTimeArg('-5x', T0)).toBeNull();
  });
});

describe('查询参数校验', () => {
  it('正常查询通过', () => {
    const r = validateQueryArgs({ query: 'up' }, T0);
    expect(r.ok).toBe(true);
    expect(r.query).toBe('up');
    expect(r.end).toBe(T0);
    // 默认看最近 1 小时
    expect(r.end - r.start).toBe(3_600_000);
  });

  it('缺 query 报错', () => {
    expect(validateQueryArgs({}, T0).error).toMatch(/缺少 query/);
  });

  it('查询过长报错', () => {
    expect(validateQueryArgs({ query: 'x'.repeat(3000) }, T0).error).toMatch(/过长/);
  });

  it('**子查询步长过小被拒**（会拖垮服务）', () => {
    const r = validateQueryArgs({ query: 'rate(sum(x)[1h:100ms])' }, T0);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/步长/);
  });

  it('子查询步长正常时通过', () => {
    expect(validateQueryArgs({ query: 'rate(sum(x)[1h:1m])' }, T0).ok).toBe(true);
  });

  it('**全表扫被拒**', () => {
    const r = validateQueryArgs({ query: '{__name__=~".*"}' }, T0);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/全表扫/);
  });

  it('end 早于 start 报错', () => {
    const r = validateQueryArgs({ query: 'up', start: '0', end: '-1h' }, T0);
    expect(r.ok).toBe(false);
  });

  it('时间跨度超上限报错', () => {
    const r = validateQueryArgs({ query: 'up', start: '-30d' }, T0);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/跨度/);
  });

  it('step 自动按点数计算', () => {
    const r = validateQueryArgs({ query: 'up', start: '-1h' }, T0);
    // 1 小时 / 120 点 = 30 秒
    expect(r.step).toBe(30_000);
  });

  it('显式 step 生效', () => {
    const r = validateQueryArgs({ query: 'up', step: 60000 }, T0);
    expect(r.step).toBe(60_000);
  });

  it('step 小于 1 秒被忽略改用自动值', () => {
    const r = validateQueryArgs({ query: 'up', step: 100 }, T0);
    expect(r.step).toBeGreaterThanOrEqual(1000);
  });
});

describe('序列摘要', () => {
  it('给出 min/max/avg/首末值', () => {
    const values = [[T0 / 1000, '1'], [(T0 + 60_000) / 1000, '5'], [(T0 + 120_000) / 1000, '3']];
    const s = summarizeSeries({ host: 'a' }, values);
    expect(s.points).toBe(3);
    expect(s.first).toBe(1);
    expect(s.last).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.avg).toBe(3);
    expect(s.labels).toEqual({ host: 'a' });
  });

  it('maxAt / minAt 指出峰值时刻', () => {
    const values = [[T0 / 1000, '1'], [(T0 + 60_000) / 1000, '99'], [(T0 + 120_000) / 1000, '3']];
    const s = summarizeSeries({}, values);
    expect(s.maxAt).toBe(new Date(T0 + 60_000).toISOString());
  });

  it('趋势：上升', () => {
    const values = Array.from({ length: 10 }, (_, i) => [(T0 + i * 60_000) / 1000, String(i * 10)]);
    expect(summarizeSeries({}, values).trend).toBe('rising');
  });

  it('趋势：下降', () => {
    const values = Array.from({ length: 10 }, (_, i) => [(T0 + i * 60_000) / 1000, String(100 - i * 10)]);
    expect(summarizeSeries({}, values).trend).toBe('falling');
  });

  it('趋势：平稳', () => {
    const values = Array.from({ length: 10 }, (_, i) => [(T0 + i * 60_000) / 1000, '50']);
    expect(summarizeSeries({}, values).trend).toBe('flat');
  });

  it('空序列不崩', () => {
    expect(summarizeSeries({}, []).points).toBe(0);
    expect(summarizeSeries({}, null).points).toBe(0);
  });

  it('小数保留合理位数', () => {
    const s = summarizeSeries({}, [[T0 / 1000, '0.123456789']]);
    expect(s.last).toBe(0.1235);
  });
});

describe('查询结果摘要', () => {
  it('标量', () => {
    const r = summarizeQueryResult({ resultType: 'scalar', result: [T0 / 1000, '42'] });
    expect(r.ok).toBe(true);
    expect(r.value).toBe('42');
  });

  it('**空结果给出可能原因**（否则模型会编造）', () => {
    const r = summarizeQueryResult({ resultType: 'vector', result: [] });
    expect(r.ok).toBe(true);
    expect(r.seriesCount).toBe(0);
    expect(r.note).toMatch(/指标名拼写|没有采集到/);
  });

  it('vector 结果', () => {
    const r = summarizeQueryResult({
      resultType: 'vector',
      result: [{ metric: { host: 'a' }, value: [T0 / 1000, '1.5'] }],
    });
    expect(r.seriesCount).toBe(1);
    expect(r.series[0].value).toBe(1.5);
  });

  it('matrix 结果带统计', () => {
    const r = summarizeQueryResult({
      resultType: 'matrix',
      result: [{ metric: { host: 'a' }, values: [[T0 / 1000, '1'], [(T0 + 60_000) / 1000, '5']] }],
    });
    expect(r.series[0].max).toBe(5);
    expect(r.series[0].trend).toBe('rising');
  });

  it('序列过多时截断并标记', () => {
    const result = Array.from({ length: MAX_SERIES + 5 }, (_, i) => ({
      metric: { i: String(i) }, value: [T0 / 1000, '1'],
    }));
    const r = summarizeQueryResult({ resultType: 'vector', result });
    expect(r.truncated).toBe(true);
    expect(r.series).toHaveLength(MAX_SERIES);
    expect(r.seriesCount).toBe(MAX_SERIES + 5);
  });

  it('错误结果带 hint', () => {
    const r = summarizeQueryResult({ error: { message: '未知函数: foo' } });
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/函数名拼写/);
  });
});

describe('错误解释', () => {
  it('未知函数', () => {
    expect(explainQueryError('未知函数: foo')).toMatch(/函数名拼写/);
  });

  it('步数超限', () => {
    expect(explainQueryError('子查询步数 36001 超过上限')).toMatch(/step 调大/);
  });

  it('未知错误返回空串', () => {
    expect(explainQueryError('some random error')).toBe('');
  });
});

describe('工具定义', () => {
  it('query_metrics 有必需参数', () => {
    const f = METRICS_TOOL_DEFINITION.function;
    expect(f.name).toBe('query_metrics');
    expect(f.parameters.required).toEqual(['query']);
    expect(f.parameters.properties.query).toBeDefined();
  });

  it('list_metrics 无必需参数', () => {
    const f = LIST_METRICS_TOOL_DEFINITION.function;
    expect(f.name).toBe('list_metrics');
    expect(f.parameters.required).toBeUndefined();
  });

  it('常量合理', () => {
    expect(MAX_RANGE_MS).toBe(7 * 86_400_000);
    expect(MAX_SERIES).toBe(20);
  });
});