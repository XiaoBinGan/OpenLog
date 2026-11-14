import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTsdbStore } from '../tsdb/store.js';
import {
  normalizeScrapeConfigs, instanceFromUrl, joinTargetUrl, scrapeTarget,
  createScraper, DEFAULT_SCRAPE_INTERVAL_MS, DEFAULT_SCRAPE_TIMEOUT_MS, MAX_BODY_BYTES,
} from '../tsdb/scrape.js';

const T0 = 1_700_000_000_000;

describe('配置校验', () => {
  it('正常配置通过', () => {
    const { configs, errors } = normalizeScrapeConfigs({
      scrapeConfigs: [{ job: 'node', targets: ['http://a:9100', 'http://b:9100'] }],
    });
    expect(errors).toEqual([]);
    expect(configs).toHaveLength(1);
    expect(configs[0].job).toBe('node');
    expect(configs[0].metricsPath).toBe('/metrics');
  });

  it('缺 job 名报错', () => {
    const { configs, errors } = normalizeScrapeConfigs({ scrapeConfigs: [{ targets: ['http://a'] }] });
    expect(configs).toEqual([]);
    expect(errors[0]).toMatch(/缺少 job/);
  });

  it('非法 job 名报错', () => {
    const { errors } = normalizeScrapeConfigs({ scrapeConfigs: [{ job: '1bad', targets: ['http://a'] }] });
    expect(errors[0]).toMatch(/job 名非法/);
  });

  it('没有 target 报错', () => {
    const { errors } = normalizeScrapeConfigs({ scrapeConfigs: [{ job: 'x', targets: [] }] });
    expect(errors[0]).toMatch(/没有 target/);
  });

  it('target 缺 scheme 报错', () => {
    const { errors } = normalizeScrapeConfigs({ scrapeConfigs: [{ job: 'x', targets: ['a:9100'] }] });
    expect(errors[0]).toMatch(/http/);
  });

  it('metricsPath 必须以 / 开头', () => {
    const { errors } = normalizeScrapeConfigs({
      scrapeConfigs: [{ job: 'x', targets: ['http://a'], metricsPath: 'metrics' }],
    });
    expect(errors[0]).toMatch(/metricsPath/);
  });

  it('interval 字符串被解析成毫秒', () => {
    const { configs } = normalizeScrapeConfigs({
      scrapeConfigs: [{ job: 'x', targets: ['http://a'], interval: '30s', timeout: '5s' }],
    });
    expect(configs[0].intervalMs).toBe(30_000);
    expect(configs[0].timeoutMs).toBe(5_000);
  });

  it('interval 纯数字当毫秒', () => {
    const { configs } = normalizeScrapeConfigs({
      scrapeConfigs: [{ job: 'x', targets: ['http://a'], interval: '20000' }],
    });
    expect(configs[0].intervalMs).toBe(20_000);
  });

  it('空配置不报错', () => {
    expect(normalizeScrapeConfigs({}).errors).toEqual([]);
    expect(normalizeScrapeConfigs(null).errors).toEqual([]);
  });

  it('非法条目被跳过但其余仍生效', () => {
    const { configs, errors } = normalizeScrapeConfigs({
      scrapeConfigs: [null, { job: 'ok', targets: ['http://a'] }],
    });
    expect(configs).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

describe('URL 工具', () => {
  it('从 URL 抽 instance', () => {
    expect(instanceFromUrl('http://10.0.0.1:9100/metrics')).toBe('10.0.0.1:9100');
  });

  it('无端口时补默认端口', () => {
    expect(instanceFromUrl('http://example.com/metrics')).toBe('example.com:80');
    expect(instanceFromUrl('https://example.com/metrics')).toBe('example.com:443');
  });

  it('非法 URL 原样返回', () => {
    expect(instanceFromUrl('not a url')).toBe('not a url');
  });

  it('拼 metricsPath', () => {
    expect(joinTargetUrl('http://a:9100', '/metrics')).toBe('http://a:9100/metrics');
    expect(joinTargetUrl('http://a:9100/', '/metrics')).toBe('http://a:9100/metrics');
    expect(joinTargetUrl('http://a:9100', 'metrics')).toBe('http://a:9100/metrics');
  });
});

describe('单目标抓取', () => {
  const text = [
    '# HELP http_requests_total 请求数',
    '# TYPE http_requests_total counter',
    'http_requests_total{method="GET"} 42',
    'node_load1 0.5',
    '',
  ].join('\n');

  const okFetch = (body) => vi.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => null },
    text: async () => body,
  }));

  it('成功抓取并注入 job/instance 标签', async () => {
    const r = await scrapeTarget(
      { url: 'http://a:9100/metrics', job: 'node' }, T0, okFetch(text),
    );
    expect(r.ok).toBe(true);
    expect(r.up).toBe(1);
    expect(r.samples).toHaveLength(2);
    const req = r.samples.find((s) => s.name === 'http_requests_total');
    expect(req.labels).toMatchObject({ job: 'node', instance: 'a:9100', method: 'GET' });
    expect(req.value).toBe(42);
    expect(req.timestamp).toBe(T0);
  });

  it('exporter 自己导出的同名标签不被覆盖', async () => {
    const body = 'm{job="exporter_own"} 1\n';
    const r = await scrapeTarget({ url: 'http://a/m', job: 'cfg' }, T0, okFetch(body));
    expect(r.samples[0].labels.job).toBe('exporter_own');
  });

  it('额外标签注入', async () => {
    const r = await scrapeTarget(
      { url: 'http://a/m', job: 'j', extraLabels: { env: 'prod' } }, T0, okFetch('x 1\n'),
    );
    expect(r.samples[0].labels.env).toBe('prod');
  });

  it('HTTP 非 200 记失败', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', headers: { get: () => null } }));
    const r = await scrapeTarget({ url: 'http://a/m', job: 'j' }, T0, f);
    expect(r.ok).toBe(false);
    expect(r.up).toBe(0);
    expect(r.error).toMatch(/500/);
  });

  it('网络异常记失败', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await scrapeTarget({ url: 'http://a/m', job: 'j' }, T0, f);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it('超时按失败处理', async () => {
    const f = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }));
    const r = await scrapeTarget({ url: 'http://a/m', job: 'j', timeoutMs: 50 }, T0, f);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时/);
  });

  it('响应体过大被拒（content-length 预检）', async () => {
    const f = vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => String(MAX_BODY_BYTES + 1) },
      text: async () => 'x',
    }));
    const r = await scrapeTarget({ url: 'http://a/m', job: 'j' }, T0, f);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/过大/);
  });

  it('部分行解析失败仍算抓取成功', async () => {
    const body = 'good 1\nbad line here\n';
    const r = await scrapeTarget({ url: 'http://a/m', job: 'j' }, T0, okFetch(body));
    expect(r.ok).toBe(true);
    expect(r.samples).toHaveLength(1);
    expect(r.error).toMatch(/解析失败/);
  });

  it('空响应体算成功（up=1，无样本）', async () => {
    const r = await scrapeTarget({ url: 'http://a/m', job: 'j' }, T0, okFetch(''));
    expect(r.ok).toBe(true);
    expect(r.up).toBe(1);
    expect(r.samples).toHaveLength(0);
  });

  it('fetch 不可用时返回失败而不是抛错', async () => {
    const r = await scrapeTarget({ url: 'http://a/m', job: 'j' }, T0, null);
    expect(r.ok).toBe(false);
  });
});

describe('调度器', () => {
  let sqlite, store, scraper;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const adapter = {
      async run(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; const i = sqlite.prepare(sql).run(...f); return { changes: i.changes }; },
      async get(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).get(...f); },
      async all(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).all(...f); },
    };
    store = createTsdbStore({ getDb: () => adapter, getDbType: () => 'sqlite', now: () => T0 });
  });

  it('抓一轮产出 up 与 scrape_duration_seconds', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'x 1\n' }));
    scraper = createScraper({
      store,
      getTargets: () => [{ url: 'http://a:9100/metrics', job: 'node' }],
      fetchImpl: f,
      now: () => T0,
    });
    await store.ensureSchema();
    const r = await scraper.scrapeOnce();
    expect(r.scraped).toBe(1);
    expect(r.samples).toBeGreaterThanOrEqual(3); // up + duration + x

    const { series } = await store.queryRange({ metricName: 'up', start: T0, end: T0 });
    expect(series).toHaveLength(1);
    expect(series[0].points[0].value).toBe(1);
    expect(series[0].labels.job).toBe('node');
  });

  it('目标挂掉时 up=0（而不是没有数据）', async () => {
    const f = vi.fn(async () => { throw new Error('refused'); });
    scraper = createScraper({
      store,
      getTargets: () => [{ url: 'http://dead:9100/metrics', job: 'node' }],
      fetchImpl: f,
      now: () => T0,
    });
    await store.ensureSchema();
    await scraper.scrapeOnce();
    const { series } = await store.queryRange({ metricName: 'up', start: T0, end: T0 });
    expect(series).toHaveLength(1);
    expect(series[0].points[0].value).toBe(0);
  });

  it('targets() 返回最近状态', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'x 1\n' }));
    scraper = createScraper({
      store,
      getTargets: () => [{ url: 'http://a:9100/metrics', job: 'node' }],
      fetchImpl: f,
      now: () => T0,
    });
    await store.ensureSchema();
    await scraper.scrapeOnce();
    const list = scraper.targets();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ job: 'node', health: 'up' });
  });

  it('多个 target 并发抓取', async () => {
    const f = vi.fn(async (url) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => `m{src="${url}"} 1\n` }));
    scraper = createScraper({
      store,
      getTargets: () => [
        { url: 'http://a/m', job: 'j' },
        { url: 'http://b/m', job: 'j' },
      ],
      fetchImpl: f,
      now: () => T0,
    });
    await store.ensureSchema();
    const r = await scraper.scrapeOnce();
    expect(r.scraped).toBe(2);
    const { series } = await store.queryRange({ metricName: 'm', start: T0, end: T0 });
    expect(series).toHaveLength(2);
  });

  it('无 target 时安全返回', async () => {
    scraper = createScraper({ store, getTargets: () => [], now: () => T0 });
    await store.ensureSchema();
    const r = await scraper.scrapeOnce();
    expect(r.scraped).toBe(0);
  });

  it('统计累加', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'x 1\n' }));
    scraper = createScraper({
      store,
      getTargets: () => [{ url: 'http://a/m', job: 'j' }],
      fetchImpl: f,
      now: () => T0,
    });
    await store.ensureSchema();
    await scraper.scrapeOnce();
    const s = scraper.stats();
    expect(s.rounds).toBe(1);
    expect(s.scrapes).toBe(1);
    expect(s.failures).toBe(0);
  });

  it('失败计入统计', async () => {
    const f = vi.fn(async () => { throw new Error('x'); });
    scraper = createScraper({
      store,
      getTargets: () => [{ url: 'http://a/m', job: 'j' }],
      fetchImpl: f,
      now: () => T0,
    });
    await store.ensureSchema();
    await scraper.scrapeOnce();
    expect(scraper.stats().failures).toBe(1);
  });

  it('默认间隔与超时是合理值', () => {
    expect(DEFAULT_SCRAPE_INTERVAL_MS).toBe(15_000);
    expect(DEFAULT_SCRAPE_TIMEOUT_MS).toBe(10_000);
    expect(MAX_BODY_BYTES).toBe(32 * 1024 * 1024);
  });
});