import { describe, it, expect } from 'vitest';
import { errorMessage, UNKNOWN_ERROR } from '../errors.js';

/**
 * 这个模块存在的唯一理由：AggregateError 的 message 是空串，
 * 导致 86 处 `{ error: err.message }` 返回 `{"error":""}`，
 * 用户看到空白提示，而 ECONNREFUSED / 端口 / 地址这些关键信息全被丢掉。
 */
describe('errorMessage — 核心契约：永不返回空串', () => {
  // 注意：不能用 String(input) 做标签 —— Object.create(null) 没有原型，
  // String() 自己会抛 "Cannot convert object to primitive value"。
  const label = (v) => {
    try { return Object.prototype.toString.call(v) + ' ' + JSON.stringify(v); }
    catch { return Object.prototype.toString.call(v); }
  };

  it('对一大批畸形输入都不返回空串', () => {
    const inputs = [
      null, undefined, 0, 1, 42, -1, NaN, false, true,
      '', '   ', '\n\t', {}, [], [1, 2], () => {}, Symbol('s'),
      new Error(''), new Error('   '), new Error(),
      new AggregateError([], ''), new AggregateError([new Error('')], ''),
      Object.create(null), { message: '' }, { message: null }, { message: 42 },
    ];
    for (const input of inputs) {
      const out = errorMessage(input);
      expect(typeof out, `输入 ${label(input)} 应返回字符串`).toBe('string');
      expect(out.trim().length, `输入 ${label(input)} 返回了空串`).toBeGreaterThan(0);
    }
  });
});

describe('errorMessage — AggregateError（本次事故的主角）', () => {
  it('message 为空时取 errors[] 里的内容', () => {
    const err = new AggregateError([
      new Error('connect ECONNREFUSED ::1:2375'),
      new Error('connect ECONNREFUSED 127.0.0.1:2375'),
    ], '');
    const out = errorMessage(err);
    expect(out).not.toBe('');
    expect(out).toContain('ECONNREFUSED');
    expect(out).toContain('2375');
  });

  it('message 非空时优先用 message', () => {
    const err = new AggregateError([new Error('inner')], 'outer');
    expect(errorMessage(err)).toContain('outer');
  });

  it('errors 去重，同一个错误重复出现只保留一次', () => {
    const e = new Error('same');
    expect(errorMessage(new AggregateError([e, e, e], ''))).toBe('same');
  });

  it('最多拼 3 条，避免前端 toast 被撑爆', () => {
    const err = new AggregateError([
      new Error('a'), new Error('b'), new Error('c'), new Error('d'), new Error('e'),
    ], '');
    const out = errorMessage(err);
    expect(out.split('; ').length).toBeLessThanOrEqual(3);
    expect(out).toContain('a');
    expect(out).not.toContain('e');
  });

  it('errors 为空时退到 code', () => {
    const err = new AggregateError([], '');
    err.code = 'ECONNREFUSED';
    expect(errorMessage(err)).toBe('ECONNREFUSED');
  });

  it('errors 为空、无 code 时退到构造器名', () => {
    expect(errorMessage(new AggregateError([], ''))).toBe('AggregateError');
  });
});

describe('errorMessage — 常规 Error', () => {
  it('直接用 message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('去掉首尾空白', () => {
    expect(errorMessage(new Error('  spaced  '))).toBe('spaced');
  });

  it('message 为空时退到 code（ECONNREFUSED / ETIMEDOUT 本身就有诊断价值）', () => {
    const err = new Error('');
    err.code = 'ETIMEDOUT';
    expect(errorMessage(err)).toBe('ETIMEDOUT');
  });

  it('退到 errno', () => {
    const err = new Error('');
    err.errno = -61;
    expect(errorMessage(err)).toBe('errno -61');
  });

  it('退到 HTTP 状态码', () => {
    const err = new Error('');
    err.statusCode = 404;
    expect(errorMessage(err)).toBe('HTTP 404');
  });
});

describe('errorMessage — cause 链', () => {
  it('message 为空时下钻到 cause', () => {
    const err = new Error('');
    err.cause = new Error('底层原因');
    expect(errorMessage(err)).toBe('底层原因');
  });

  it('嵌套超过 3 层就停止，不会无限递归', () => {
    let e = new Error('deep');
    for (let i = 0; i < 10; i++) {
      const outer = new Error('');
      outer.cause = e;
      e = outer;
    }
    expect(() => errorMessage(e)).not.toThrow();
    expect(errorMessage(e).length).toBeGreaterThan(0);
  });

  it('自引用 cause 不会死循环', () => {
    const err = new Error('');
    err.cause = err;
    expect(() => errorMessage(err)).not.toThrow();
  });
});

describe('errorMessage — 非 Error 抛出物', () => {
  it('字符串直接抛出', () => {
    expect(errorMessage('炸了')).toBe('炸了');
  });

  it('空字符串抛出退到兜底', () => {
    expect(errorMessage('')).toBe(UNKNOWN_ERROR);
    expect(errorMessage('   ')).toBe(UNKNOWN_ERROR);
  });

  it('数字与布尔转成字符串', () => {
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(false)).toBe('false');
  });

  it('null / undefined 退到兜底', () => {
    expect(errorMessage(null)).toBe(UNKNOWN_ERROR);
    expect(errorMessage(undefined)).toBe(UNKNOWN_ERROR);
  });

  it('纯对象无任何线索时退到兜底', () => {
    expect(errorMessage({})).toBe(UNKNOWN_ERROR);
  });
});

describe('errorMessage — 长度上限', () => {
  it('超长消息被截断并加省略号', () => {
    const out = errorMessage(new Error('x'.repeat(1000)));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(true);
  });
});
