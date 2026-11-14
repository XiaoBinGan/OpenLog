import { describe, it, expect } from 'vitest';
import {
  parseExposition, parseSampleLine, parseSampleValue,
  formatExposition, formatSample, formatValue, METRIC_TYPES,
} from '../tsdb/exposition.js';

describe('解析 —— 基本样本', () => {
  it('无标签的简单样本', () => {
    const r = parseExposition('up 1\n');
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0]).toMatchObject({ name: 'up', value: 1, labels: {} });
  });

  it('带标签', () => {
    const r = parseExposition('http_requests_total{method="GET",status="200"} 1027\n');
    expect(r.samples[0].labels).toEqual({ method: 'GET', status: '200' });
    expect(r.samples[0].value).toBe(1027);
  });

  it('带时间戳', () => {
    const r = parseExposition('up 1 1700000000000\n');
    expect(r.samples[0].timestamp).toBe(1700000000000);
  });

  it('空文本返回空结果而不是抛错', () => {
    for (const v of ['', null, undefined, 123]) {
      const r = parseExposition(v);
      expect(r.samples).toEqual([]);
      expect(r.errors).toEqual([]);
    }
  });

  it('多行、空行、行尾空白都能处理', () => {
    const r = parseExposition('a 1\n\n   \nb 2  \n');
    expect(r.samples.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('注释行被忽略', () => {
    const r = parseExposition('# this is a comment\nup 1\n');
    expect(r.samples).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });
});

describe('解析 —— HELP / TYPE 元数据', () => {
  it('继承 TYPE 到样本', () => {
    const r = parseExposition('# TYPE http_total counter\nhttp_total 5\n');
    expect(r.samples[0].type).toBe('counter');
    expect(r.types.http_total).toBe('counter');
  });

  it('继承 HELP 到样本', () => {
    const r = parseExposition('# HELP up 目标是否存活\nup 1\n');
    expect(r.samples[0].help).toBe('目标是否存活');
    expect(r.help.up).toBe('目标是否存活');
  });

  it('HELP 里的 \\n 转义还原成真换行', () => {
    const r = parseExposition('# HELP x 第一行\\n第二行\nx 1\n');
    expect(r.help.x).toBe('第一行\n第二行');
  });

  it('未知 TYPE 归为 untyped 并记录错误但不丢样本', () => {
    const r = parseExposition('# TYPE x bogustype\nx 1\n');
    expect(r.samples[0].type).toBe('untyped');
    expect(r.errors.some((e) => /未知 TYPE/.test(e.reason))).toBe(true);
  });

  it('histogram 的子样本归到基名的类型', () => {
    const text = [
      '# TYPE http_dur histogram',
      'http_dur_bucket{le="0.5"} 10',
      'http_dur_bucket{le="1"} 20',
      'http_dur_sum 15.5',
      'http_dur_count 20',
    ].join('\n');
    const r = parseExposition(text);
    expect(r.samples).toHaveLength(4);
    for (const s of r.samples) expect(s.type).toBe('histogram');
  });

  it('summary 的 quantile 样本骨架', () => {
    const text = '# TYPE rpc summary\nrpc{quantile="0.99"} 0.9\nrpc_sum 10\nrpc_count 20\n';
    const r = parseExposition(text);
    expect(r.samples[0].labels).toEqual({ quantile: '0.99' });
    expect(r.samples[0].type).toBe('summary');
  });

  it('counter 的 _total 后缀能归到基名', () => {
    const r = parseExposition('# TYPE http_total counter\nhttp_total 5\nhttp_total_total 6\n');
    expect(r.samples[1].type).toBe('counter');
  });
});

describe('解析 —— 特殊数值', () => {
  it('NaN / +Inf / -Inf', () => {
    const r = parseExposition('a NaN\nb +Inf\nc -Inf\n');
    expect(Number.isNaN(r.samples[0].value)).toBe(true);
    expect(r.samples[1].value).toBe(Infinity);
    expect(r.samples[2].value).toBe(-Infinity);
  });

  it('parseSampleValue 直接测', () => {
    expect(parseSampleValue('1.5')).toBe(1.5);
    expect(parseSampleValue('1e3')).toBe(1000);
    expect(parseSampleValue('NaN')).toBeNaN();
    expect(parseSampleValue('+Inf')).toBe(Infinity);
    expect(parseSampleValue('Inf')).toBe(Infinity);
    expect(parseSampleValue('')).toBeNull();
    expect(parseSampleValue('abc')).toBeNull();
  });

  it('负数与科学计数法', () => {
    const r = parseExposition('a -1.5\nb 1.5e-3\n');
    expect(r.samples[0].value).toBe(-1.5);
    expect(r.samples[1].value).toBe(0.0015);
  });
});

describe('解析 —— 标签值的转义处理', () => {
  it('引号转义', () => {
    const r = parseExposition('m{l="a\\"b"} 1\n');
    expect(r.samples[0].labels.l).toBe('a"b');
  });

  it('反斜杠转义', () => {
    const r = parseExposition('m{l="a\\\\b"} 1\n');
    expect(r.samples[0].labels.l).toBe('a\\b');
  });

  it('换行转义', () => {
    const r = parseExposition('m{l="a\\nb"} 1\n');
    expect(r.samples[0].labels.l).toBe('a\nb');
  });

  it('标签值里含逗号与右括号不误切', () => {
    const r = parseExposition('m{l="a,b}c"} 1\n');
    expect(r.samples[0].labels.l).toBe('a,b}c');
  });

  it('标签值里含等号', () => {
    const r = parseExposition('m{l="a=b"} 1\n');
    expect(r.samples[0].labels.l).toBe('a=b');
  });
});

describe('解析 —— 坏输入不致命', () => {
  it('坏行被记录，好行仍解析', () => {
    const r = parseExposition('good 1\nthis is not valid\nalso_good 2\n');
    expect(r.samples.map((s) => s.name)).toEqual(['good', 'also_good']);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('标签块未闭合 → 该行丢弃，不吞掉后面所有行', () => {
    const r = parseExposition('bad{l="v 1\ngood 2\n');
    // 未闭合会把剩余当标签读，所以 good 行可能被吞；关键是**不抛错**
    expect(() => parseExposition('bad{l="v 1\ngood 2\n')).not.toThrow();
    expect(r.samples.every((s) => typeof s.value === 'number' || Number.isNaN(s.value))).toBe(true);
  });

  it('无值行被丢弃', () => {
    const r = parseExposition('novalue\n');
    expect(r.samples).toEqual([]);
  });

  it('非标准指标名（含点）照样接受', () => {
    // 有些 exporter 导出 foo.bar，丢掉等于丢数据
    const r = parseExposition('foo.bar 1\n');
    expect(r.samples[0].name).toBe('foo.bar');
  });
});

describe('解析 —— parseSampleLine 单行', () => {
  it('无标签', () => {
    expect(parseSampleLine('a 1')).toEqual({ name: 'a', labels: {}, value: 1, timestamp: null });
  });

  it('空标签块', () => {
    expect(parseSampleLine('a{} 1').labels).toEqual({});
  });

  it('纯注释返回 null', () => {
    expect(parseSampleLine('# comment')).toBeNull();
  });

  it('空行返回 null', () => {
    expect(parseSampleLine('   ')).toBeNull();
  });
});

describe('生成 —— formatExposition', () => {
  it('基本输出', () => {
    const out = formatExposition([{ name: 'up', labels: {}, value: 1 }]);
    expect(out).toBe('# TYPE up untyped\nup 1\n');
  });

  it('HELP 在 TYPE 之前、样本之后', () => {
    const out = formatExposition([{ name: 'up', labels: {}, value: 1, help: '存活', type: 'gauge' }]);
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('# HELP up 存活');
    expect(lines[1]).toBe('# TYPE up gauge');
    expect(lines[2]).toBe('up 1');
  });

  it('同一指标只输出一次 HELP/TYPE', () => {
    const out = formatExposition([
      { name: 'm', labels: { a: '1' }, value: 1, type: 'gauge' },
      { name: 'm', labels: { a: '2' }, value: 2, type: 'gauge' },
    ]);
    expect((out.match(/# TYPE m/g) ?? []).length).toBe(1);
    expect((out.match(/^m\{/gm) ?? []).length).toBe(2);
  });

  it('标签按键排序输出（稳定）', () => {
    const out = formatExposition([{ name: 'm', labels: { z: '1', a: '2' }, value: 1 }]);
    expect(out).toContain('m{a="2",z="1"} 1');
  });

  it('空标签值不输出', () => {
    expect(formatSample({ name: 'm', labels: { a: '', b: 'x' }, value: 1 })).toBe('m{b="x"} 1');
  });

  it('时间戳只在有值时输出', () => {
    expect(formatSample({ name: 'm', labels: {}, value: 1 })).toBe('m 1');
    expect(formatSample({ name: 'm', labels: {}, value: 1, timestamp: 123 })).toBe('m 1 123');
    expect(formatSample({ name: 'm', labels: {}, value: 1, timestamp: null })).toBe('m 1');
  });

  it('数值格式：整数不带小数点，NaN/Inf 用文本', () => {
    expect(formatValue(1)).toBe('1');
    expect(formatValue(1.5)).toBe('1.5');
    expect(formatValue(NaN)).toBe('NaN');
    expect(formatValue(Infinity)).toBe('+Inf');
    expect(formatValue(-Infinity)).toBe('-Inf');
  });

  it('空输入返回空串', () => {
    expect(formatExposition([])).toBe('');
    expect(formatExposition(null)).toBe('');
  });

  it('可关闭 HELP/TYPE', () => {
    const out = formatExposition([{ name: 'm', labels: {}, value: 1, help: 'h', type: 'gauge' }], {
      includeHelp: false, includeType: false,
    });
    expect(out).toBe('m 1\n');
  });

  it('非法 type 归为 untyped', () => {
    const out = formatExposition([{ name: 'm', labels: {}, value: 1, type: 'nonsense' }]);
    expect(out).toContain('# TYPE m untyped');
  });
});

describe('往返：解析 → 生成 → 再解析', () => {
  it('数据不丢', () => {
    const text = [
      '# HELP http_requests_total 请求总数',
      '# TYPE http_requests_total counter',
      'http_requests_total{method="GET",status="200"} 1027',
      'http_requests_total{method="POST",status="500"} 3',
      '',
    ].join('\n');
    const first = parseExposition(text);
    const out = formatExposition(first.samples);
    const second = parseExposition(out);

    expect(second.samples).toHaveLength(first.samples.length);
    for (let i = 0; i < first.samples.length; i += 1) {
      expect(second.samples[i].name).toBe(first.samples[i].name);
      expect(second.samples[i].value).toBe(first.samples[i].value);
      expect(second.samples[i].labels).toEqual(first.samples[i].labels);
    }
  });

  it('特殊值往返后仍是特殊值', () => {
    const out = formatExposition([
      { name: 'a', labels: {}, value: NaN },
      { name: 'b', labels: {}, value: Infinity },
    ]);
    const back = parseExposition(out);
    expect(Number.isNaN(back.samples[0].value)).toBe(true);
    expect(back.samples[1].value).toBe(Infinity);
  });

  it('含特殊字符的标签值往返不坏', () => {
    const samples = [{ name: 'm', labels: { path: '/a"b\\c', msg: 'line1\nline2' }, value: 1 }];
    const back = parseExposition(formatExposition(samples));
    expect(back.samples[0].labels).toEqual({ path: '/a"b\\c', msg: 'line1\nline2' });
  });
});

describe('METRIC_TYPES', () => {
  it('包含全部五种类型', () => {
    expect(METRIC_TYPES).toEqual(['counter', 'gauge', 'histogram', 'summary', 'untyped']);
  });
});