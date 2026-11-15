/**
 * 时序库查询面板的两个纯函数。
 *
 * 为什么单独测这两个：它们处理的是 Prometheus 返回的 matrix 结构，
 * 而那个结构有两个容易错的点：
 *   · 时间戳是**秒**，recharts 要毫秒
 *   · 序列标识来自标签拼装，纯 `__name__` 的指标和带标签的必须都正确
 * 这两点错了图表会整片空白或全部挤成一条线，但不会报错。
 */
import { describe, it, expect } from 'vitest';
import { toChartRows, seriesNames } from '../TsdbSection';

const T0 = 1_700_000_000; // 秒

describe('toChartRows', () => {
  it('把 matrix 转成按时间排序的行', () => {
    const rows = toChartRows([{
      metric: { __name__: 'cpu' },
      values: [[T0, '1'], [T0 + 60, '2']],
    }]);
    expect(rows).toHaveLength(2);
    expect(rows[0].ts).toBe(T0 * 1000); // 秒 → 毫秒
    expect(rows[0].cpu).toBe(1);
    expect(rows[1].cpu).toBe(2);
  });

  it('多条序列合并到同一行（按时间对齐）', () => {
    const rows = toChartRows([
      { metric: { __name__: 'a' }, values: [[T0, '1'], [T0 + 60, '2']] },
      { metric: { __name__: 'b' }, values: [[T0, '10'], [T0 + 60, '20']] },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ a: 1, b: 10 });
    expect(rows[1]).toMatchObject({ a: 2, b: 20 });
  });

  it('**时间戳是秒，必须换成毫秒**（否则图表坐标全错）', () => {
    const rows = toChartRows([{ metric: {}, values: [[T0, '1']] }]);
    expect(rows[0].ts).toBe(1_700_000_000_000);
  });

  it('没有 __name__ 时用标签拼名字', () => {
    const rows = toChartRows([{ metric: { host: 'a', job: 'web' }, values: [[T0, '1']] }]);
    expect(rows[0]['host=a,job=web']).toBe(1);
  });

  it('无标签无名字时退化成 value', () => {
    const rows = toChartRows([{ metric: {}, values: [[T0, '5']] }]);
    expect(rows[0].value).toBe(5);
  });

  it('非数字值变成 null（不画成 0）', () => {
    const rows = toChartRows([{ metric: {}, values: [[T0, 'NaN']] }]);
    expect(rows[0].value).toBeNull();
  });

  it('空输入返回空数组', () => {
    expect(toChartRows([])).toEqual([]);
    expect(toChartRows(null as never)).toEqual([]);
  });

  it('序列缺 values 时跳过不崩', () => {
    const rows = toChartRows([{ metric: { __name__: 'x' } }, { metric: { __name__: 'y' }, values: [[T0, '1']] }]);
    expect(rows).toHaveLength(1);
  });

  it('结果按时间升序（recharts 要求）', () => {
    const rows = toChartRows([{ metric: {}, values: [[T0 + 120, '3'], [T0, '1'], [T0 + 60, '2']] }]);
    const ts = rows.map((r) => r.ts as number);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});

describe('seriesNames', () => {
  it('优先用 __name__', () => {
    expect(seriesNames([{ metric: { __name__: 'cpu', host: 'a' } }])).toEqual(['cpu']);
  });

  it('无 __name__ 时拼标签（键排序保证稳定）', () => {
    expect(seriesNames([{ metric: { b: '2', a: '1' } }])).toEqual(['a=1,b=2']);
  });

  it('去重', () => {
    expect(seriesNames([
      { metric: { __name__: 'x' } },
      { metric: { __name__: 'x' } },
    ])).toEqual(['x']);
  });

  it('空输入返回空数组', () => {
    expect(seriesNames([])).toEqual([]);
    expect(seriesNames(null as never)).toEqual([]);
  });
});
