import { describe, it, expect } from 'vitest';
import { tokenize, parseDuration, formatDuration, T } from '../tsdb/promql-lexer.js';

const types = (src) => tokenize(src).tokens.map((t) => t.type);
const values = (src) => tokenize(src).tokens.filter((t) => t.type !== T.EOF).map((t) => t.value);

describe('时长解析', () => {
  it('单单位', () => {
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1w')).toBe(604_800_000);
    expect(parseDuration('1y')).toBe(31_536_000_000);
    expect(parseDuration('500ms')).toBe(500);
  });

  it('组合单位累加（1h30m = 5400s）', () => {
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1d12h')).toBe(86_400_000 + 43_200_000);
    expect(parseDuration('1h30m10s')).toBe(5_400_000 + 10_000);
  });

  it('小数', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
  });

  it('非法输入返回 null', () => {
    for (const bad of ['', 'm', '5', 'abc', '5x', '-5m', null, undefined]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });

  it('0 合法', () => {
    expect(parseDuration('0s')).toBe(0);
  });
});

describe('时长格式化', () => {
  it('常见值', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(300_000)).toBe('5m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(5_400_000)).toBe('1h30m');
    expect(formatDuration(86_400_000)).toBe('1d');
  });

  it('毫秒余数', () => {
    expect(formatDuration(1500)).toBe('1s500ms');
  });

  it('非法输入兜底', () => {
    expect(formatDuration(-1)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
  });

  it('往返一致', () => {
    for (const s of ['5m', '1h30m', '1d', '30s', '2w']) {
      expect(formatDuration(parseDuration(s))).toBe(s);
    }
  });
});

describe('词法 —— 基本 token', () => {
  it('简单指标名', () => {
    expect(types('up')).toEqual([T.IDENT, T.EOF]);
    expect(values('up')).toEqual(['up']);
  });

  it('带冒号的记录规则名', () => {
    expect(values('job:errors:rate5m')).toEqual(['job:errors:rate5m']);
  });

  it('数字', () => {
    expect(types('123')).toEqual([T.NUMBER, T.EOF]);
    expect(types('1.5')).toEqual([T.NUMBER, T.EOF]);
    expect(values('1e3')).toEqual(['1e3']);
  });

  it('时长 token', () => {
    expect(types('5m')).toEqual([T.DURATION, T.EOF]);
    expect(values('5m')).toEqual(['300000']);
  });

  it('组合时长', () => {
    expect(values('1h30m')).toEqual(['5400000']);
  });

  it('字符串三种引号', () => {
    expect(values('"abc"')).toEqual(['abc']);
    expect(values("'abc'")).toEqual(['abc']);
    expect(values('`abc`')).toEqual(['abc']);
  });

  it('字符串转义', () => {
    expect(values('"a\\"b"')).toEqual(['a"b']);
    expect(values('"a\\nb"')).toEqual(['a\nb']);
    expect(values('`a\\nb`')).toEqual(['a\\nb']); // 反引号不处理转义
  });

  it('运算符', () => {
    expect(values('a != b')).toEqual(['a', '!=', 'b']);
    expect(values('a =~ b')).toEqual(['a', '=~', 'b']);
    expect(values('a == b')).toEqual(['a', '==', 'b']);
    expect(values('a >= b')).toEqual(['a', '>=', 'b']);
    expect(values('a + b')).toEqual(['a', '+', 'b']);
  });

  it('全部标点', () => {
    expect(types('{}()[],:')).toEqual([
      T.LBRACE, T.RBRACE, T.LPAREN, T.RPAREN,
      T.LBRACKET, T.RBRACKET, T.COMMA, T.COLON, T.EOF,
    ]);
  });
});

describe('词法 —— 真实查询', () => {
  it('带标签选择器', () => {
    const r = tokenize('http_requests_total{method="GET",status=~"2.."}');
    expect(r.error).toBeNull();
    expect(r.tokens.map((t) => t.value).filter(Boolean)).toEqual([
      'http_requests_total', '{', 'method', '=', 'GET', ',', 'status', '=~', '2..', '}',
    ]);
  });

  it('rate 表达式', () => {
    const r = tokenize('rate(http_requests_total[5m])');
    expect(r.error).toBeNull();
    expect(r.tokens.map((t) => t.type)).toEqual([
      T.IDENT, T.LPAREN, T.IDENT, T.LBRACKET, T.DURATION, T.RBRACKET, T.RPAREN, T.EOF,
    ]);
  });

  it('聚合 with by', () => {
    const r = tokenize('sum by (job) (rate(x[1m]))');
    expect(r.error).toBeNull();
    expect(r.tokens.map((t) => t.value).filter(Boolean))
      .toEqual(['sum', 'by', '(', 'job', ')', '(', 'rate', '(', 'x', '[', '60000', ']', ')', ')']);
  });

  it('二元运算与优先级无关（语法层处理）', () => {
    const r = tokenize('a / b * 100');
    expect(r.error).toBeNull();
    expect(r.tokens.filter((t) => t.type === T.OP).map((t) => t.value)).toEqual(['/', '*']);
  });

  it('注释被跳过', () => {
    const r = tokenize('# 注释\nup');
    expect(r.error).toBeNull();
    expect(values('# 注释\nup')).toEqual(['up']);
  });
});

describe('词法 —— 错误处理', () => {
  it('字符串未闭合', () => {
    const r = tokenize('m{a="unclosed}');
    expect(r.error).not.toBeNull();
    expect(r.error.message).toMatch(/未闭合/);
  });

  it('无法识别的字符', () => {
    const r = tokenize('m $ x');
    expect(r.error).not.toBeNull();
    expect(r.error.message).toMatch(/无法识别/);
  });

  it('@ 修饰符明确报不支持（比静默忽略更诚实）', () => {
    const r = tokenize('m @ 1234');
    expect(r.error).not.toBeNull();
    expect(r.error.message).toMatch(/@/);
  });

  it('非法时长', () => {
    const r = tokenize('m[5x]');
    expect(r.error).not.toBeNull();
    expect(r.error.message).toMatch(/非法时长/);
  });

  it('错误带位置信息', () => {
    const r = tokenize('m $ x');
    expect(typeof r.error.pos).toBe('number');
    expect(r.error.pos).toBe(2);
  });
});