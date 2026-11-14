import { describe, it, expect } from 'vitest';
import express from 'express';
import {
  createPrometheusRouter, parseTimeParam, parseStepParam, parseSeriesSelector,
} from '../routes/prometheus.js';
import {
  systemStatsToSamples, containersToSamples, tsdbStatsToSamples,
  scraperStatsToSamples, mergeSamples,
} from '../tsdb/self-metrics.js';
import Database from 'better-sqlite3';
import { createTsdbStore } from '../tsdb/store.js';
import { createRuleEngine, normalizeRuleGroups } from '../tsdb/rules.js';

const T0 = 1_700_000_000_000;

// ────────────────── 参数解析 ──────────────────

describe('时间参数解析', () => {
  it('秒级数字（10 位）', () => {
    expect(parseTimeParam('1700000000')).toBe(1_700_000_000_000);
  });

  it('毫秒级数字（13 位）', () => {
    expect(parseTimeParam('1700000000000')).toBe(1_700_000_000_000);
  });

  it('RFC3339', () => {
    expect(parseTimeParam('2023-11-14T22:13:20Z')).toBe(1_700_000_000_000);
  });

  it('空值返回 undefined', () => {
    expect(parseTimeParam('')).toBeUndefined();
    expect(parseTimeParam(null)).toBeUndefined();
    expect(parseTimeParam(undefined)).toBeUndefined();
  });

  it('非法值返回 undefined', () => {
    expect(parseTimeParam('abc')).toBeUndefined();
  });
});

describe('step 参数解析', () => {
  it('纯数字按秒', () => {
    expect(parseStepParam('15')).toBe(15_000);
  });

  it('带单位', () => {
    expect(parseStepParam('1m')).toBe(60_000);
    expect(parseStepParam('500ms')).toBe(500);
  });

  it('非法返回 undefined', () => {
    expect(parseStepParam('x')).toBeUndefined();
  });
});

describe('match[] 解析', () => {
  it('带标签', () => {
    const r = parseSeriesSelector('http_requests_total{method="GET"}');
    expect(r.metricName).toBe('http_requests_total');
    expect(r.matchers).toHaveLength(1);
  });

  it('__name__ 等值提为 metricName', () => {
    const r = parseSeriesSelector('{__name__="up"}');
    expect(r.metricName).toBe('up');
    expect(r.matchers).toBeUndefined();
  });

  it('__name__ 正则留在 matchers', () => {
    const r = parseSeriesSelector('{__name__=~"node_.*"}');
    expect(r.metricName).toBeUndefined();
    expect(r.matchers).toHaveLength(1);
  });

  it('非选择器报错', () => {
    expect(parseSeriesSelector('rate(x[5m])').error).toBeTruthy();
  });
});

// ────────────────── 自身指标 ──────────────────

describe('系统指标转样本', () => {
  // 形状严格照抄 /api/monitor/stats 的实际返回（cpu 只有 load+cores、
  // disk 用 name/usePercent、gpus 用 util/memUsed/temp）—— 之前按"直觉形状"写，
  // 结果字段一个都对不上，测试却是绿的，掩盖了真实缺陷。
  const stats = {
    cpu: { load: 42.5, cores: [10, 20, 30, 40] },
    memory: { used: 8e9, total: 16e9, free: 8e9, percent: 50 },
    disk: [{ name: '/', total: 100e9, used: 40e9, usePercent: 40 }, { name: '/data', total: 500e9, used: 100e9, usePercent: 20 }],
    network: [{ iface: 'eth0', rx: 1000, tx: 2000 }],
    gpus: [{ index: 0, name: 'RTX', util: 80, memUsed: 8192, memTotal: 24576, temp: 65 }],
    processes: { pid: 1, name: 'x', cpu: 1, mem: 1 },
    uptime: 86400,
  };

  it('CPU 指标：整体使用率由每核平均算出', () => {
    const s = systemStatsToSamples(stats, { timestamp: T0 });
    const usage = s.find((x) => x.name === 'openlog_cpu_usage_percent');
    // (10+20+30+40)/4 = 25
    expect(usage.value).toBe(25);
    expect(s.filter((x) => x.name === 'openlog_cpu_core_usage_percent')).toHaveLength(4);
    expect(s.find((x) => x.name === 'openlog_cpu_load_percent').value).toBe(42.5);
  });

  it('内存指标', () => {
    const s = systemStatsToSamples(stats, { timestamp: T0 });
    expect(s.find((x) => x.name === 'openlog_memory_usage_percent').value).toBe(50);
    expect(s.find((x) => x.name === 'openlog_memory_total_bytes').value).toBe(16e9);
  });

  it('磁盘按挂载点分组', () => {
    const s = systemStatsToSamples(stats, { timestamp: T0 });
    const disks = s.filter((x) => x.name === 'openlog_disk_usage_percent');
    expect(disks).toHaveLength(2);
    expect(disks.map((d) => d.labels.mount).sort()).toEqual(['/', '/data']);
  });

  it('网络按网卡分组（累计字节，counter 语义）', () => {
    const s = systemStatsToSamples(stats, { timestamp: T0 });
    const rx = s.find((x) => x.name === 'openlog_network_receive_bytes_total');
    expect(rx.labels.iface).toBe('eth0');
    expect(rx.type).toBe('counter');
  });

  it('GPU 按序号分组（不用 UUID，基数低），显存 MiB → 字节', () => {
    const s = systemStatsToSamples(stats, { timestamp: T0 });
    const gpu = s.find((x) => x.name === 'openlog_gpu_utilization_percent');
    expect(gpu.labels.gpu).toBe('0');
    expect(gpu.value).toBe(80);
    const memUsed = s.find((x) => x.name === 'openlog_gpu_memory_used_bytes');
    expect(memUsed.value).toBe(8192 * 1024 * 1024);
  });

  it('uptime 是 counter', () => {
    const s = systemStatsToSamples(stats, { timestamp: T0 });
    expect(s.find((x) => x.name === 'openlog_system_uptime_seconds').type).toBe('counter');
  });

  it('缺失字段不产生样本（不写 0 假装有数据）', () => {
    const s = systemStatsToSamples({ cpu: { load: 10 } }, { timestamp: T0 });
    expect(s.map((x) => x.name)).toEqual(['openlog_cpu_load_percent']);
  });

  it('NaN 值被跳过', () => {
    const s = systemStatsToSamples({ cpu: { usage: NaN } }, { timestamp: T0 });
    expect(s).toHaveLength(0);
  });

  it('空输入返回空数组', () => {
    expect(systemStatsToSamples(null, {})).toEqual([]);
    expect(systemStatsToSamples({}, {})).toEqual([]);
  });

  it('容量告警也被导出（弹窗历史能画成趋势）', () => {
    const s = systemStatsToSamples({
      capacityAlerts: [{ key: 'memory', level: 'critical' }],
    }, { timestamp: T0 });
    const a = s.find((x) => x.name === 'openlog_capacity_alert');
    expect(a.labels.key).toBe('memory');
    expect(a.labels.level).toBe('critical');
    expect(a.value).toBe(1);
  });
});

describe('容器指标转样本', () => {
  it('按状态统计', () => {
    const s = containersToSamples([
      { state: 'running' }, { state: 'running' }, { state: 'exited' },
    ], T0);
    expect(s.find((x) => x.name === 'openlog_docker_containers_total').value).toBe(3);
    expect(s.find((x) => x.labels.state === 'running').value).toBe(2);
    expect(s.find((x) => x.labels.state === 'exited').value).toBe(1);
  });

  it('**不给每个容器一条序列**（基数控制）', () => {
    const s = containersToSamples([
      { state: 'running', id: 'abc123', name: 'c1' },
      { state: 'running', id: 'def456', name: 'c2' },
    ], T0);
    // 所有样本的标签里都不该出现容器 id/name
    for (const x of s) {
      expect(JSON.stringify(x.labels)).not.toMatch(/abc123|def456|c1|c2/);
    }
  });

  it('空输入返回 total=0', () => {
    const s = containersToSamples([], T0);
    expect(s.find((x) => x.name === 'openlog_docker_containers_total').value).toBe(0);
  });
});

describe('TSDB 自身指标', () => {
  it('序列数与点数', () => {
    const s = tsdbStatsToSamples({ seriesCount: 10, sampleCount: 1000, ready: true, oldestMs: T0 }, T0);
    expect(s.find((x) => x.name === 'openlog_tsdb_series_total').value).toBe(10);
    expect(s.find((x) => x.name === 'openlog_tsdb_samples_total').value).toBe(1000);
    expect(s.find((x) => x.name === 'openlog_tsdb_ready').value).toBe(1);
  });

  it('无数据时不输出 oldest（避免 1970 年）', () => {
    const s = tsdbStatsToSamples({ seriesCount: 0, sampleCount: 0, ready: true, oldestMs: null }, T0);
    expect(s.find((x) => x.name === 'openlog_tsdb_oldest_sample_timestamp_seconds')).toBeUndefined();
  });
});

describe('抓取器指标', () => {
  it('累计计数', () => {
    const s = scraperStatsToSamples({ rounds: 5, scrapes: 10, failures: 1, samples: 500, targetCount: 2 }, T0);
    expect(s.find((x) => x.name === 'openlog_scrape_rounds_total').value).toBe(5);
    expect(s.find((x) => x.name === 'openlog_scrape_failures_total').value).toBe(1);
    expect(s.find((x) => x.name === 'openlog_scrape_targets_configured').type).toBe('gauge');
  });
});

describe('样本合并去重', () => {
  it('同指标同标签只留第一个', () => {
    const m = mergeSamples(
      [{ name: 'a', labels: { x: '1' }, value: 1 }],
      [{ name: 'a', labels: { x: '1' }, value: 2 }],
    );
    expect(m).toHaveLength(1);
    expect(m[0].value).toBe(1);
  });

  it('不同标签保留', () => {
    const m = mergeSamples(
      [{ name: 'a', labels: { x: '1' }, value: 1 }],
      [{ name: 'a', labels: { x: '2' }, value: 2 }],
    );
    expect(m).toHaveLength(2);
  });

  it('非法值被跳过', () => {
    const m = mergeSamples([{ name: 'a', labels: {}, value: NaN }, { name: 'b', labels: {}, value: 1 }]);
    expect(m.map((x) => x.name)).toEqual(['b']);
  });
});

// ────────────────── HTTP 路由 ──────────────────

function makeStore() {
  const sqlite = new Database(':memory:');
  const adapter = {
    async run(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; const i = sqlite.prepare(sql).run(...f); return { changes: i.changes }; },
    async get(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).get(...f); },
    async all(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).all(...f); },
  };
  return createTsdbStore({ getDb: () => adapter, getDbType: () => 'sqlite', now: () => T0 });
}

/** 起一个临时 express 应用，返回 baseUrl */
async function serve(router) {
  const app = express();
  app.use(router);
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

describe('HTTP API', () => {
  let store, engine, server;

  beforeEach(async () => {
    store = makeStore();
    await store.ensureSchema();
    await store.writeSamples([
      { name: 'cpu', labels: { host: 'a' }, value: 0.9, timestamp: T0 },
      { name: 'cpu', labels: { host: 'b' }, value: 0.2, timestamp: T0 },
    ]);
    engine = createRuleEngine({ store, now: () => T0 });
    const groups = normalizeRuleGroups({
      ruleGroups: [{ name: 'g', rules: [{ alert: 'HighCPU', expr: 'cpu > 0.5' }] }],
    }).groups;
    await engine.evaluateAll(groups);

    const router = createPrometheusRouter({
      store,
      now: () => T0,
      getRuleEngine: () => engine,
      getRuleConfig: () => ({ ruleGroups: groups, inhibitRules: [], silences: [] }),
      getSelfMetrics: () => systemStatsToSamples({ cpu: { cores: [42] } }, { timestamp: T0 }),
    });
    server = await serve(router);
  });

  const get = async (path) => {
    const r = await fetch(server.url + path);
    return { status: r.status, body: await r.json() };
  };

  it('/api/v1/query 成功', async () => {
    const r = await get('/api/v1/query?query=cpu');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('success');
    expect(r.body.data.resultType).toBe('vector');
    expect(r.body.data.result).toHaveLength(2);
  });

  it('/api/v1/query 缺 query 报 400', async () => {
    const r = await get('/api/v1/query');
    expect(r.status).toBe(400);
    expect(r.body.status).toBe('error');
    expect(r.body.errorType).toBe('bad_data');
  });

  it('/api/v1/query 语法错误报 400 且带错误信息', async () => {
    const r = await get('/api/v1/query?query=' + encodeURIComponent('bad_func(x)'));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/未知函数/);
  });

  it('/api/v1/query_range', async () => {
    const r = await get(`/api/v1/query_range?query=cpu&start=${T0 - 10_000}&end=${T0}&step=5`);
    expect(r.status).toBe(200);
    expect(r.body.data.resultType).toBe('matrix');
  });

  it('/api/v1/query_range 缺 start/end 报 400', async () => {
    const r = await get('/api/v1/query_range?query=cpu&step=5');
    expect(r.status).toBe(400);
  });

  it('/api/v1/labels', async () => {
    const r = await get('/api/v1/labels');
    expect(r.body.status).toBe('success');
    expect(r.body.data).toContain('__name__');
    expect(r.body.data).toContain('host');
  });

  it('/api/v1/label/:name/values', async () => {
    const r = await get('/api/v1/label/host/values');
    expect(r.body.data).toEqual(['a', 'b']);
  });

  it('/api/v1/label/__name__/values', async () => {
    const r = await get('/api/v1/label/__name__/values');
    expect(r.body.data).toContain('cpu');
  });

  it('/api/v1/series', async () => {
    const r = await get('/api/v1/series?match[]=' + encodeURIComponent('cpu'));
    expect(r.body.status).toBe('success');
    expect(r.body.data).toHaveLength(2);
    for (const s of r.body.data) expect(s.__name__).toBe('cpu');
  });

  it('/api/v1/series 缺 match[] 报 400', async () => {
    const r = await get('/api/v1/series');
    expect(r.status).toBe(400);
  });

  it('/api/v1/rules 返回告警规则', async () => {
    const r = await get('/api/v1/rules');
    expect(r.body.data.groups).toHaveLength(1);
    const rule = r.body.data.groups[0].rules[0];
    expect(rule.name).toBe('HighCPU');
    expect(rule.type).toBe('alerting');
    expect(rule.state).toBe('firing'); // 无 for，立即 firing
  });

  it('/api/v1/alerts 只返回 firing', async () => {
    const r = await get('/api/v1/alerts');
    expect(r.body.data.alerts).toHaveLength(1);
    expect(r.body.data.alerts[0].labels.alertname).toBe('HighCPU');
  });

  it('/api/v1/alert_groups 分组', async () => {
    const r = await get('/api/v1/alert_groups');
    expect(r.body.data.groups).toHaveLength(1);
  });

  it('/metrics 返回 Prometheus 文本格式', async () => {
    const res = await fetch(server.url + '/metrics');
    const text = await res.text();
    expect(res.headers.get('content-type')).toMatch(/text\/plain.*0\.0\.4/);
    expect(text).toContain('# TYPE openlog_cpu_usage_percent');
    expect(text).toContain('openlog_cpu_usage_percent 42');
  });

  it('/api/tsdb/status', async () => {
    const r = await get('/api/tsdb/status');
    expect(r.status).toBe(200);
    expect(r.body.storage.seriesCount).toBeGreaterThan(0);
    expect(r.body.rules.firingCount).toBe(1);
  });

  it('/api/v1/targets 无抓取器时返回空', async () => {
    const r = await get('/api/v1/targets');
    expect(r.body.data.activeTargets).toEqual([]);
  });

  afterEach(async () => { await server.close(); });
});

describe('/metrics 输出可被自己解析（闭环）', () => {
  it('生成的文本能被 parseExposition 读回', async () => {
    const { parseExposition } = await import('../tsdb/exposition.js');
    const samples = systemStatsToSamples({
      cpu: { load: 42, cores: [10, 20] },
      memory: { percent: 55 },
    }, { timestamp: T0 });
    const { formatExposition } = await import('../tsdb/exposition.js');
    const text = formatExposition(samples);
    const back = parseExposition(text);
    expect(back.errors).toEqual([]);
    expect(back.samples.length).toBe(samples.length);
    const usage = back.samples.find((s) => s.name === 'openlog_cpu_usage_percent');
    expect(usage.value).toBe(15); // (10+20)/2
  });
});