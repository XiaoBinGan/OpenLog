import { describe, it, expect } from 'vitest';
import {
  apiBucketsToSamples, collectApiMetricSamples, recommendedApiRules,
} from '../metrics/api-tsdb-bridge.js';

const T0 = 1_700_000_000_000;

const mkBucket = (over = {}) => ({
  bucketMs: T0,
  route: '/api/users/:id',
  method: 'GET',
  calls: 100,
  err4xx: 3,
  err5xx: 1,
  p50Ms: 20,
  p95Ms: 80,
  p99Ms: 150,
  maxMs: 500,
  ...over,
});

describe('接口指标转样本', () => {
  it('生成 requests_total / 4xx / 5xx', () => {
    const s = apiBucketsToSamples([mkBucket()]);
    const names = s.map((x) => x.name);
    expect(names).toContain('openlog_api_requests_total');
    expect(names).toContain('openlog_api_requests_4xx_total');
    expect(names).toContain('openlog_api_requests_5xx_total');
    expect(s.find((x) => x.name === 'openlog_api_requests_total').value).toBe(100);
  });

  it('**延迟用秒**（Prometheus 约定，毫秒会被面板当秒读）', () => {
    const s = apiBucketsToSamples([mkBucket()]);
    const p99 = s.find((x) => x.name === 'openlog_api_request_duration_seconds' && x.labels.quantile === '0.99');
    expect(p99.value).toBe(0.15); // 150ms → 0.15s
  });

  it('**分位数是同一指标的 quantile 标签**，不是四个不同指标名', () => {
    const s = apiBucketsToSamples([mkBucket()]);
    const dur = s.filter((x) => x.name === 'openlog_api_request_duration_seconds');
    expect(dur).toHaveLength(4);
    expect(dur.map((x) => x.labels.quantile).sort()).toEqual(['0.5', '0.95', '0.99', '1']);
  });

  it('route / method 作为标签（基数低）', () => {
    const s = apiBucketsToSamples([mkBucket()]);
    const req = s.find((x) => x.name === 'openlog_api_requests_total');
    expect(req.labels).toEqual({ route: '/api/users/:id', method: 'GET' });
  });

  it('mnthod 统一大写', () => {
    const s = apiBucketsToSamples([mkBucket({ method: 'post' })]);
    expect(s.find((x) => x.name === 'openlog_api_requests_total').labels.method).toBe('POST');
  });

  it('**延迟为 null 时跳过而不是写 0**（否则「没流量」看起来像「0 秒响应」）', () => {
    const s = apiBucketsToSamples([mkBucket({ p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null })]);
    expect(s.filter((x) => x.name === 'openlog_api_request_duration_seconds')).toHaveLength(0);
    // 但计数类还在
    expect(s.filter((x) => x.name.endsWith('_total')).length).toBeGreaterThan(0);
  });

  it('时间戳用 bucketMs', () => {
    const s = apiBucketsToSamples([mkBucket()]);
    for (const x of s) expect(x.timestamp).toBe(T0);
  });

  it('多个桶各产出一组', () => {
    const s = apiBucketsToSamples([
      mkBucket({ bucketMs: T0 }),
      mkBucket({ bucketMs: T0 + 60_000 }),
    ]);
    expect(s.filter((x) => x.name === 'openlog_api_requests_total')).toHaveLength(2);
  });

  it('自定义前缀', () => {
    const s = apiBucketsToSamples([mkBucket()], { prefix: 'myapp' });
    expect(s.some((x) => x.name === 'myapp_requests_total')).toBe(true);
  });

  it('兼容 snake_case 输入', () => {
    const s = apiBucketsToSamples([{
      bucket_ms: T0, route: '/x', method: 'GET', calls: 5, err4xx: 0, err5xx: 0,
      p50_ms: 10, p95_ms: 20, p99_ms: 30, max_ms: 40,
    }]);
    expect(s.find((x) => x.name === 'openlog_api_requests_total').value).toBe(5);
  });

  it('空输入返回空数组', () => {
    expect(apiBucketsToSamples([])).toEqual([]);
    expect(apiBucketsToSamples(null)).toEqual([]);
  });

  it('坏桶被跳过不崩', () => {
    const s = apiBucketsToSamples([null, {}, mkBucket()]);
    expect(s.length).toBeGreaterThan(0);
  });
});

describe('从 api-store 采集', () => {
  it('调用 queryRange 并转样本', async () => {
    const store = {
      queryRange: async ({ fromMs, toMs }) => {
        expect(fromMs).toBe(T0 - 60_000);
        expect(toMs).toBe(T0);
        return [mkBucket()];
      },
    };
    const s = await collectApiMetricSamples(store, { sinceMs: T0 - 60_000, untilMs: T0 });
    expect(s.length).toBeGreaterThan(0);
  });

  it('store 缺失时返回空', async () => {
    expect(await collectApiMetricSamples(null, { sinceMs: 0, untilMs: 1 })).toEqual([]);
    expect(await collectApiMetricSamples({}, { sinceMs: 0, untilMs: 1 })).toEqual([]);
  });
});

describe('推荐告警规则', () => {
  it('三条规则', () => {
    const r = recommendedApiRules();
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.alert)).toEqual(['HighApiErrorRate', 'SlowApiP99', 'ApiTrafficDrop']);
  });

  it('每条都有 expr / for / annotations', () => {
    for (const rule of recommendedApiRules()) {
      expect(rule.expr).toBeTruthy();
      expect(rule.for).toMatch(/^\d+[smh]$/);
      expect(rule.annotations.summary).toBeTruthy();
    }
  });

  it('5xx 规则用 clamp_min 防除零', () => {
    const r = recommendedApiRules().find((x) => x.alert === 'HighApiErrorRate');
    expect(r.expr).toContain('clamp_min');
  });

  it('自定义前缀被带入', () => {
    const r = recommendedApiRules('myapp');
    for (const rule of r) expect(rule.expr).toContain('myapp_');
  });
});