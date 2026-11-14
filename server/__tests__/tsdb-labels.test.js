import { describe, it, expect } from 'vitest';
import {
  normalizeLabels, labelsToString, seriesFingerprint, makeSeries,
  matchesLabels, isValidMetricName, isValidLabelName, escapeLabelValue,
} from '../tsdb/labels.js';

describe('标签规范化', () => {
  it('键排序，保证序列化稳定', () => {
    expect(Object.keys(normalizeLabels({ b: '2', a: '1' }))).toEqual(['a', 'b']);
  });

  it('数字归一成字符串（200 与 "200" 必须是同一序列）', () => {
    expect(normalizeLabels({ status: 200 })).toEqual({ status: '200' });
  });

  it('空值标签丢弃（等价于不存在）', () => {
    expect(normalizeLabels({ a: '', b: null, c: undefined, d: 'x' })).toEqual({ d: 'x' });
  });

  it('非严格模式静默丢弃非法标签名', () => {
    expect(normalizeLabels({ 'bad-name': 'x', good: 'y' })).toEqual({ good: 'y' });
  });

  it('严格模式对非法标签名抛错', () => {
    expect(() => normalizeLabels({ 'bad-name': 'x' }, { strict: true })).toThrow(/非法标签名/);
  });

  it('__name__ 作为标签名是非法的（指标名单独存）', () => {
    expect(isValidLabelName('__name__')).toBe(false);
    expect(normalizeLabels({ __name__: 'foo' })).toEqual({});
  });

  it('输入非对象时返回空对象', () => {
    expect(normalizeLabels(null)).toEqual({});
    expect(normalizeLabels('x')).toEqual({});
    expect(normalizeLabels(undefined)).toEqual({});
  });
});

describe('指标名与标签名合法性', () => {
  it('允许字母开头的名字', () => {
    expect(isValidMetricName('http_requests_total')).toBe(true);
    expect(isValidMetricName('node_cpu_seconds_total')).toBe(true);
  });

  it('允许冒号（记录规则用）', () => {
    expect(isValidMetricName('job:http_errors:rate5m')).toBe(true);
  });

  it('拒绝数字开头与空名', () => {
    expect(isValidMetricName('1abc')).toBe(false);
    expect(isValidMetricName('')).toBe(false);
    expect(isValidMetricName(null)).toBe(false);
  });

  it('标签名不能有冒号', () => {
    expect(isValidLabelName('instance')).toBe(true);
    expect(isValidLabelName('a:b')).toBe(false);
  });
});

describe('序列指纹', () => {
  it('标签顺序不影响指纹', () => {
    const a = seriesFingerprint('m', { x: '1', y: '2' });
    const b = seriesFingerprint('m', { y: '2', x: '1' });
    expect(a).toBe(b);
  });

  it('数字与字符串值指纹相同', () => {
    expect(seriesFingerprint('m', { x: 200 })).toBe(seriesFingerprint('m', { x: '200' }));
  });

  it('不同指标名指纹不同', () => {
    expect(seriesFingerprint('a', {})).not.toBe(seriesFingerprint('b', {}));
  });

  it('不同标签值指纹不同', () => {
    expect(seriesFingerprint('m', { x: '1' })).not.toBe(seriesFingerprint('m', { x: '2' }));
  });

  it('固定长度前缀（去重键不能随标签长度膨胀）', () => {
    const short = seriesFingerprint('m', { a: '1' });
    const long = seriesFingerprint('m', { a: 'x'.repeat(500) });
    expect(short.split('-')[0]).toHaveLength(8);
    expect(long.split('-')[0]).toHaveLength(8);
  });
});

describe('makeSeries', () => {
  it('返回指纹、指标名、规范化标签', () => {
    const s = makeSeries('http_requests_total', { method: 'GET', status: 200 });
    expect(s.name).toBe('http_requests_total');
    expect(s.labels).toEqual({ method: 'GET', status: '200' });
    expect(s.fingerprint).toMatch(/^[0-9a-f]{8}-[0-9a-f]+$/);
  });

  it('非法指标名抛错', () => {
    expect(() => makeSeries('1bad', {})).toThrow(/非法指标名/);
  });
});

describe('标签选择器匹配', () => {
  const L = { env: 'prod', instance: 'a:9100', status: '200' };

  it('空 matchers 全匹配', () => {
    expect(matchesLabels(L, [])).toBe(true);
    expect(matchesLabels(L, undefined)).toBe(true);
  });

  it('等值匹配', () => {
    expect(matchesLabels(L, [{ name: 'env', op: '=', value: 'prod' }])).toBe(true);
    expect(matchesLabels(L, [{ name: 'env', op: '=', value: 'dev' }])).toBe(false);
  });

  it('不存在的标签：= 不匹配', () => {
    expect(matchesLabels(L, [{ name: 'missing', op: '=', value: '' }])).toBe(false);
  });

  it('**不存在的标签：!= 匹配**（不存在等价空串，空串 != x）', () => {
    expect(matchesLabels(L, [{ name: 'missing', op: '!=', value: 'x' }])).toBe(true);
  });

  it('正则匹配是全集匹配（不是子串）', () => {
    expect(matchesLabels(L, [{ name: 'instance', op: '=~', value: 'a:.*' }])).toBe(true);
    // 'a' 只匹配子串，但 Prometheus 语义要求整串匹配
    expect(matchesLabels(L, [{ name: 'instance', op: '=~', value: 'a' }])).toBe(false);
  });

  it('负正则', () => {
    expect(matchesLabels(L, [{ name: 'env', op: '!~', value: 'dev' }])).toBe(true);
    expect(matchesLabels(L, [{ name: 'env', op: '!~', value: 'prod' }])).toBe(false);
  });

  it('不存在的标签：=~ 不匹配、!~ 匹配', () => {
    expect(matchesLabels(L, [{ name: 'missing', op: '=~', value: '.*' }])).toBe(false);
    expect(matchesLabels(L, [{ name: 'missing', op: '!~', value: '.*' }])).toBe(true);
  });

  it('坏正则不抛错，按不匹配处理', () => {
    expect(() => matchesLabels(L, [{ name: 'env', op: '=~', value: '[' }])).not.toThrow();
    expect(matchesLabels(L, [{ name: 'env', op: '=~', value: '[' }])).toBe(false);
  });

  it('多个 matcher 是与关系', () => {
    expect(matchesLabels(L, [
      { name: 'env', op: '=', value: 'prod' },
      { name: 'status', op: '=', value: '500' },
    ])).toBe(false);
  });
});

describe('labelsToString', () => {
  it('按 Prometheus 风格输出', () => {
    expect(labelsToString({ b: '2', a: '1' })).toBe('a="1",b="2"');
  });

  it('转义引号与反斜杠', () => {
    expect(labelsToString({ q: 'a"b' })).toBe('q="a\\"b"');
    expect(escapeLabelValue('a\\b')).toBe('a\\\\b');
  });

  it('换行转成 \\n', () => {
    expect(escapeLabelValue('a\nb')).toBe('a\\nb');
  });
});