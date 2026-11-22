/**
 * 演示模式 · 日志页 + TSDB 只读面板的路由接线测试
 *
 * 被测对象：
 *   · `server/demo/fixtures-observability.js`（假数据本体）
 *   · `server/routes/logs.js` 的 `GET /api/logs`、`GET /api/logs/history`
 *   · `server/routes/prometheus.js` 的只读面板与 `/metrics`、`/api/tsdb/status`
 *
 * 这里要证明三件事，任何一条不成立演示就白做了：
 *   1. 演示模式下这些端点返回 fixture + `demo:true`，**一次都没碰真实依赖**
 *      （数据库 / 时序存储 / 抓取器 / 规则引擎 / 自身指标采集）—— 用 spy 断言 0 次；
 *   2. `/api/logs` 的过滤与分页在 fixture 内部与真实路由同语义
 *      （level 严格相等、total 是切片前条数、offset/limit 生效、多次调用 deepEqual）；
 *   3. 关掉开关后走真实分支：内存缓冲 / `listLogRecords` / 存储 / 抓取器照旧被调用。
 *
 * 为什么要 `vi.mock('../db/index.js')`：logs.js 依赖真实数据库模块。演示模式的全部
 * 价值就是「没有真实依赖也能出数据」，所以这个测试文件永远不该建立任何连接。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';

// ─────────────────────────────────────────────────────────────
// 真实依赖：全部 mock（一次都不该被调用 / 关闭演示模式时按真实分支被调用）
// ─────────────────────────────────────────────────────────────
vi.mock('../db/index.js', () => ({
  getDb: vi.fn(() => {
    throw new Error('演示模式不该拿 db 句柄');
  }),
  listLogRecords: vi.fn(async () => []),
}));

import * as db from '../db/index.js';
import createLogsRouter from '../routes/logs.js';
import { createPrometheusRouter } from '../routes/prometheus.js';
import { parseExposition } from '../tsdb/exposition.js';
import {
  demoLogEntries,
  demoLogHistory,
  DEMO_LOG_LEVEL_COUNTS,
} from '../demo/fixtures-observability.js';

// ─────────────────────────────────────────────────────────────
// 被测路由 + 依赖桩
// ─────────────────────────────────────────────────────────────
const logBuffer = [];

const tsdbStore = {
  queryRange: vi.fn(async () => ({ series: [] })),
  listSeries: vi.fn(async () => []),
  labelValues: vi.fn(async () => []),
  listMetricNames: vi.fn(async () => []),
  stats: vi.fn(async () => ({ ready: false, seriesCount: 0 })),
};

const scraper = {
  targets: vi.fn(() => [{
    job: 'real-job',
    url: 'http://127.0.0.1:9100/metrics',
    health: 'up',
    lastScrapeMs: 1_700_000_000_000,
    lastDurationMs: 12,
    lastError: '',
    samplesCount: 10,
  }]),
  stats: vi.fn(() => ({ rounds: 1, targetCount: 1 })),
};

const ruleEngine = {
  snapshot: vi.fn(() => ({ at: 1_700_000_000_000, groups: [], errors: [] })),
  alerts: vi.fn(() => []),
  firing: vi.fn(() => []),
};

const getSelfMetrics = vi.fn(() => [{ name: 'openlog_real_metric', labels: {}, value: 1, type: 'gauge' }]);
const notifier = { sendTest: vi.fn(async () => true) };

const app = express();
app.use(express.json());
app.use(createLogsRouter({
  logs: logBuffer,
  ensureSettings: () => ({}),
  saveLog: () => {},
  broadcast: () => {},
}));
app.use(createPrometheusRouter({
  store: tsdbStore,
  getScraper: () => scraper,
  getRuleEngine: () => ruleEngine,
  getRuleConfig: () => ({ ruleGroups: [], inhibitRules: [], silences: [], receivers: [] }),
  getSelfMetrics,
  getNotifier: () => notifier,
  auth: (req, res, next) => next(),
}));

let server;
let base;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

/** 统一请求助手：返回 { status, body, contentType } */
async function api(pathname, init) {
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, contentType: res.headers.get('content-type') || '' };
}

/** 真实依赖的 spy 清单：演示模式下这些必须是 0 次 */
const realSpies = () => [
  db.getDb, db.listLogRecords,
  tsdbStore.queryRange, tsdbStore.listSeries, tsdbStore.labelValues,
  tsdbStore.listMetricNames, tsdbStore.stats,
  scraper.targets, scraper.stats,
  ruleEngine.snapshot, ruleEngine.alerts, ruleEngine.firing,
  getSelfMetrics, notifier.sendTest,
];

function expectNoRealDependencyCalls() {
  const called = realSpies()
    .map((spy, i) => [i, spy?.mock?.calls?.length || 0])
    .filter(([, n]) => n > 0);
  expect(called, `演示模式下不该调用真实依赖（索引→次数）: ${JSON.stringify(called)}`).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  logBuffer.length = 0;
});

// ═════════════════════════════════════════════════════════════
// 1) 日志页：GET /api/logs
// ═════════════════════════════════════════════════════════════
describe('演示模式 · GET /api/logs 返回 fixture 且过滤/分页同语义', () => {
  beforeEach(() => { vi.stubEnv('OPENLOG_DEMO', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('默认分页：200 条里回 100 条，total 是过滤后总数，元素字段与真实形状一致', async () => {
    const r = await api('/api/logs');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.total).toBe(200);
    expect(r.body.logs).toHaveLength(100);

    const first = r.body.logs[0];
    // 必填字段与真实写入一致（metadata 可选：只有请求类日志带）
    expect(Object.keys(first)).toEqual(expect.arrayContaining(['id', 'level', 'message', 'source', 'timestamp']));
    expect(Object.keys(first).filter((k) => !['id', 'level', 'message', 'source', 'timestamp', 'metadata'].includes(k))).toEqual([]);
    expect(typeof first.id).toBe('string');
    expect(Number.isNaN(Date.parse(first.timestamp))).toBe(false);
    expect(['INFO', 'WARN', 'ERROR']).toContain(first.level);
    expect(['vllm', 'sglang', 'redis', 'openlog']).toContain(first.source);
    // 新 → 旧（真实缓冲是 unshift 写入的）
    expect(Date.parse(r.body.logs[0].timestamp)).toBeGreaterThan(Date.parse(r.body.logs[1].timestamp));
    // metadata 是 JSON 字符串（真实写入就是这么存的）
    const withMeta = r.body.logs.find((l) => l.metadata);
    expect(withMeta).toBeTruthy();
    expect(() => JSON.parse(withMeta.metadata)).not.toThrow();

    expectNoRealDependencyCalls();
  });

  it('等级分布是 INFO 多数 / WARN 若干 / ERROR 少量，且 level=ERROR 只回 ERROR', async () => {
    expect(DEMO_LOG_LEVEL_COUNTS.INFO).toBeGreaterThan(DEMO_LOG_LEVEL_COUNTS.WARN);
    expect(DEMO_LOG_LEVEL_COUNTS.WARN).toBeGreaterThan(DEMO_LOG_LEVEL_COUNTS.ERROR);
    expect(DEMO_LOG_LEVEL_COUNTS.ERROR).toBeGreaterThan(0);

    const r = await api('/api/logs?level=ERROR&limit=500');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(DEMO_LOG_LEVEL_COUNTS.ERROR);
    expect(r.body.logs).toHaveLength(DEMO_LOG_LEVEL_COUNTS.ERROR);
    expect(r.body.logs.every((l) => l.level === 'ERROR')).toBe(true);

    // 与真实路由同口径：严格相等，小写匹配不到
    const lower = await api('/api/logs?level=error&limit=500');
    expect(lower.body.total).toBe(0);
    expect(lower.body.logs).toEqual([]);
  });

  it('source 与 search 过滤在 fixture 内部生效（search 大小写不敏感）', async () => {
    const bySource = await api('/api/logs?source=vllm&limit=500');
    expect(bySource.body.logs.length).toBeGreaterThan(0);
    expect(bySource.body.logs.every((l) => l.source === 'vllm')).toBe(true);
    expect(bySource.body.total).toBe(bySource.body.logs.length);

    const bySearch = await api('/api/logs?search=CUDA&limit=500');
    expect(bySearch.body.logs.length).toBeGreaterThan(0);
    expect(bySearch.body.logs.every((l) => l.message.toLowerCase().includes('cuda'))).toBe(true);

    // 组合过滤：搜索命中数不能超过单一 level 的命中数
    const combined = await api('/api/logs?level=ERROR&search=cuda&limit=500');
    expect(combined.body.logs.every((l) => l.level === 'ERROR' && /cuda/i.test(l.message))).toBe(true);
    expect(combined.body.total).toBeLessThanOrEqual(bySearch.body.total);
  });

  it('offset/limit 生效：total 不随分页变化，切片与 fixture 一致', async () => {
    const all = await api('/api/logs?limit=500');
    const page = await api('/api/logs?limit=10&offset=5');

    expect(page.status).toBe(200);
    expect(page.body.total).toBe(all.body.total);
    expect(page.body.logs).toHaveLength(10);
    expect(page.body.logs).toEqual(all.body.logs.slice(5, 15));

    const tail = await api('/api/logs?limit=10&offset=195');
    expect(tail.body.logs).toHaveLength(5);

    const beyond = await api('/api/logs?limit=10&offset=500');
    expect(beyond.body.logs).toEqual([]);
    expect(beyond.body.total).toBe(all.body.total);

    // 传垃圾 offset/limit → 与真实路由一样得到空数组（slice(NaN, NaN)）
    const junk = await api('/api/logs?limit=abc');
    expect(junk.body.logs).toEqual([]);
    expect(junk.body.total).toBe(all.body.total);
  });

  it('确定性：同参数两次请求 deepEqual', async () => {
    const a = await api('/api/logs?level=WARN&limit=20&offset=3');
    const b = await api('/api/logs?level=WARN&limit=20&offset=3');
    expect(a.body).toEqual(b.body);
    // 直接调 fixture 也必须一致（不只是「同一进程内缓存」）
    expect(demoLogEntries({ level: 'WARN', limit: '20', offset: '3' }))
      .toEqual(demoLogEntries({ level: 'WARN', limit: '20', offset: '3' }));
  });

  it('不读内存缓冲：即使缓冲里有内容也不回它（演示模式只回 fixture）', async () => {
    logBuffer.push({ id: 'real-1', timestamp: '2026-06-08T09:48:00.000Z', level: 'INFO', message: 'real buffer line', source: 'vllm' });

    const r = await api('/api/logs?limit=500');
    expect(r.body.logs.some((l) => l.id === 'real-1')).toBe(false);
    expect(r.body.total).toBe(200);
    expectNoRealDependencyCalls();
  });
});

// ═════════════════════════════════════════════════════════════
// 2) 日志页：GET /api/logs/history
// ═════════════════════════════════════════════════════════════
describe('演示模式 · GET /api/logs/history 读 fixture 而不读库', () => {
  beforeEach(() => { vi.stubEnv('OPENLOG_DEMO', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('返回 { logs, total, source:"database" }，行字段与 log_records 一致', async () => {
    const r = await api('/api/logs/history');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.source).toBe('database');
    expect(r.body.total).toBe(r.body.logs.length);
    expect(r.body.logs.length).toBeGreaterThan(0);

    const row = r.body.logs[0];
    expect(Object.keys(row).sort()).toEqual([
      'content', 'created_at', 'id', 'machine_id', 'parsed', 'severity', 'source_name', 'source_type', 'timestamp',
    ].sort());
    // timestamp 是 epoch 秒（insertLogRecord 用 /1000），parsed 是 JSON 字符串
    expect(row.timestamp).toBeGreaterThan(1_700_000_000);
    expect(row.timestamp).toBeLessThan(1_800_000_000);
    expect(['warn', 'error']).toContain(row.severity);
    expect(typeof row.parsed).toBe('string');
    expect(JSON.parse(row.parsed)).toHaveProperty('message');
    // 排序：新 → 旧（SQL 是 ORDER BY timestamp DESC）
    expect(r.body.logs[0].timestamp).toBeGreaterThanOrEqual(r.body.logs[1].timestamp);

    expect(db.listLogRecords).not.toHaveBeenCalled();
    expect(db.getDb).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('severity / limit / offset 生效，total 是时间过滤后的条数', async () => {
    const all = await api('/api/logs/history?limit=500');
    const errors = await api('/api/logs/history?severity=error&limit=500');
    expect(errors.body.logs.every((r) => r.severity === 'error')).toBe(true);
    expect(errors.body.total).toBeLessThan(all.body.total);

    const page = await api('/api/logs/history?limit=3&offset=2');
    expect(page.body.logs).toHaveLength(3);
    expect(page.body.logs).toEqual(all.body.logs.slice(2, 5));

    // 时间范围过滤（startDate 在很久以前 → 全部保留；endDate 在很久以前 → 全部滤掉）
    const wide = await api('/api/logs/history?startDate=2000-01-01T00:00:00Z');
    expect(wide.body.total).toBe(all.body.total);
    const narrow = await api('/api/logs/history?endDate=2000-01-01T00:00:00Z');
    expect(narrow.body.logs).toEqual([]);
    expect(narrow.body.total).toBe(0);

    expect(db.listLogRecords).not.toHaveBeenCalled();
  });

  it('确定性：同参数两次请求 deepEqual', async () => {
    const a = await api('/api/logs/history?severity=warn&limit=5');
    const b = await api('/api/logs/history?severity=warn&limit=5');
    expect(a.body).toEqual(b.body);
    expect(demoLogHistory({ severity: 'warn', limit: '5' })).toEqual(demoLogHistory({ severity: 'warn', limit: '5' }));
  });
});

// ═════════════════════════════════════════════════════════════
// 3) TSDB 只读面板
// ═════════════════════════════════════════════════════════════
describe('演示模式 · TSDB 只读面板返回 fixture 且不碰存储/抓取器/规则引擎', () => {
  beforeEach(() => { vi.stubEnv('OPENLOG_DEMO', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('GET /api/v1/targets → 目标列表（含一台 down），不调 scraper.targets', async () => {
    const r = await api('/api/v1/targets');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.status).toBe('success');
    expect(r.body.data.droppedTargets).toEqual([]);
    expect(r.body.data.activeTargets.length).toBeGreaterThan(0);
    expect(r.body.data.activeTargets.map((t) => t.health)).toContain('down');
    const t = r.body.data.activeTargets[0];
    expect(Object.keys(t).sort()).toEqual([
      'health', 'labels', 'lastDurationMs', 'lastError', 'lastScrape', 'samplesCount', 'scrapeUrl',
    ].sort());
    expect(t.labels).toHaveProperty('job');
    expect(t.labels).toHaveProperty('instance');
    expect(scraper.targets).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/v1/rules → 规则组（alerting 带 alerts[]、recording 带 seriesCount）', async () => {
    const r = await api('/api/v1/rules');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    const groups = r.body.data.groups;
    expect(groups.length).toBeGreaterThan(0);

    const rule = groups[0].rules.find((x) => x.type === 'alerting');
    expect(rule).toMatchObject({ type: 'alerting', health: expect.any(String) });
    expect(['firing', 'pending', 'inactive']).toContain(rule.state);
    expect(rule.alerts[0].labels).toHaveProperty('alertname');
    expect(rule.alerts[0].activeAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const recording = groups[0].rules.find((x) => x.type === 'recording');
    expect(recording.seriesCount).toBeGreaterThan(0);

    expect(ruleEngine.snapshot).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/v1/alerts 与 /api/v1/alert_groups → 告警与分组', async () => {
    const alerts = await api('/api/v1/alerts');
    expect(alerts.status).toBe(200);
    expect(alerts.body.demo).toBe(true);
    expect(alerts.body.data.alerts.length).toBeGreaterThanOrEqual(2);
    expect(alerts.body.data.alerts[0].labels).toHaveProperty('alertname');
    expect(alerts.body.data.alerts.some((a) => a.state === 'firing')).toBe(true);
    expect(alerts.body.data.alerts.every((a) => typeof a.value === 'string')).toBe(true);

    const groups = await api('/api/v1/alert_groups');
    expect(groups.status).toBe(200);
    expect(groups.body.demo).toBe(true);
    expect(groups.body.data.groups.length).toBeGreaterThan(0);
    expect(groups.body.data.groups[0].labels).toHaveProperty('alertname');
    expect(groups.body.data.groups[0].alerts[0]).toHaveProperty('annotations');

    expect(ruleEngine.firing).not.toHaveBeenCalled();
    expect(ruleEngine.alerts).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/v1/series 按指标名过滤；缺 match[] 仍 400', async () => {
    const r = await api('/api/v1/series?match%5B%5D=openlog_gpu_utilization_percent');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.data.every((s) => s.__name__ === 'openlog_gpu_utilization_percent')).toBe(true);
    // 序列必须带 host / gpu（GPU 面板按 gpu 拆图）
    expect(r.body.data[0]).toHaveProperty('host');
    expect(r.body.data[0]).toHaveProperty('gpu');

    const multi = await api('/api/v1/series?match%5B%5D=openlog_cpu_usage_percent&match%5B%5D=openlog_memory_usage_percent');
    const names = new Set(multi.body.data.map((s) => s.__name__));
    expect(names).toEqual(new Set(['openlog_cpu_usage_percent', 'openlog_memory_usage_percent']));

    const missing = await api('/api/v1/series');
    expect(missing.status).toBe(400);
    expect(missing.body.errorType).toBe('bad_data');

    const broken = await api('/api/v1/series?match%5B%5D=%7B%7D%7B');
    expect(broken.status).toBe(400);

    expect(tsdbStore.listSeries).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/v1/labels 与 /api/v1/label/:name/values → 至少含 __name__/host/gpu', async () => {
    const labels = await api('/api/v1/labels');
    expect(labels.status).toBe(200);
    expect(labels.body.demo).toBe(true);
    expect(labels.body.data).toEqual(expect.arrayContaining(['__name__', 'host', 'gpu']));
    expect(labels.body.data).toEqual([...labels.body.data].sort());

    const gpu = await api('/api/v1/label/gpu/values');
    expect(gpu.status).toBe(200);
    expect(gpu.body.demo).toBe(true);
    expect(gpu.body.data).toEqual(['0', '1', '2', '3']);

    const host = await api('/api/v1/label/host/values');
    expect(host.body.data.length).toBeGreaterThan(0);
    expect(host.body.data.every((h) => h.startsWith('srv-'))).toBe(true);

    const metricNames = await api('/api/v1/label/__name__/values');
    expect(metricNames.body.data).toContain('openlog_gpu_utilization_percent');

    const unknown = await api('/api/v1/label/nope/values');
    expect(unknown.status).toBe(200);
    expect(unknown.body.data).toEqual([]);

    expect(tsdbStore.labelValues).not.toHaveBeenCalled();
    expect(tsdbStore.listMetricNames).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /metrics → 合法 exposition 文本，且不调自身指标采集', async () => {
    const r = await api('/metrics');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/plain');
    expect(r.body).toContain('# TYPE');

    const parsed = parseExposition(String(r.body));
    expect(parsed.errors).toEqual([]);
    expect(parsed.samples.length).toBeGreaterThan(20);
    expect(parsed.samples.some((s) => s.name === 'openlog_gpu_utilization_percent' && s.labels.gpu === '0')).toBe(true);
    expect(parsed.samples.some((s) => s.name === 'openlog_scrape_duration_seconds_bucket')).toBe(true);

    expect(getSelfMetrics).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/tsdb/status → 状态对象（storage/scraper/rules 三段）', async () => {
    const r = await api('/api/tsdb/status');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.storage.seriesCount).toBeGreaterThan(0);
    expect(r.body.storage).toHaveProperty('dbType');
    expect(r.body.scraper.targetCount).toBeGreaterThan(0);
    expect(r.body.scraper).toHaveProperty('running');
    expect(r.body.rules).toMatchObject({ alertCount: expect.any(Number), firingCount: expect.any(Number) });

    expect(tsdbStore.stats).not.toHaveBeenCalled();
    expect(scraper.stats).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('确定性：面板类端点两次请求 deepEqual（固定时间锚点）', async () => {
    for (const path of ['/api/v1/targets', '/api/v1/rules', '/api/v1/alerts', '/api/v1/alert_groups', '/api/tsdb/status']) {
      const a = await api(path);
      const b = await api(path);
      expect(a.body, path).toEqual(b.body);
    }
    const m1 = await api('/metrics');
    const m2 = await api('/metrics');
    expect(m1.body).toEqual(m2.body);
  });

  it('写操作仍是 409：POST /api/tsdb/test-notify 不发真实通知', async () => {
    const r = await api('/api/tsdb/test-notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(409);
    expect(r.body.demo).toBe(true);
    expect(String(r.body.error)).toContain('演示模式');
    expect(notifier.sendTest).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════
// 4) 关闭演示模式：行为与之前一致（真实分支被调用）
// ═════════════════════════════════════════════════════════════
describe('关闭演示模式 · 日志与 TSDB 走真实分支', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('GET /api/logs 读内存缓冲，响应无 demo 标记，过滤/分页由路由自己做', async () => {
    expect(process.env.OPENLOG_DEMO).toBeUndefined();
    logBuffer.push(
      { id: 'r1', timestamp: '2026-06-08T09:47:00.000Z', level: 'INFO', message: 'real info', source: 'vllm' },
      { id: 'r2', timestamp: '2026-06-08T09:46:00.000Z', level: 'ERROR', message: 'real cuda boom', source: 'vllm' },
      { id: 'r3', timestamp: '2026-06-08T09:45:00.000Z', level: 'WARN', message: 'real warn', source: 'redis' },
    );

    const all = await api('/api/logs');
    expect(all.status).toBe(200);
    expect(all.body.demo).toBeUndefined();
    expect(all.body.total).toBe(3);
    expect(all.body.logs.map((l) => l.id)).toEqual(['r1', 'r2', 'r3']);

    const errors = await api('/api/logs?level=ERROR');
    expect(errors.body.total).toBe(1);
    expect(errors.body.logs[0].id).toBe('r2');

    const paged = await api('/api/logs?limit=1&offset=2');
    expect(paged.body.logs.map((l) => l.id)).toEqual(['r3']);
    expect(paged.body.total).toBe(3);

    expect(db.listLogRecords).not.toHaveBeenCalled();
  });

  it('GET /api/logs/history 调 listLogRecords，响应无 demo 标记', async () => {
    db.listLogRecords.mockResolvedValueOnce([
      { id: 'h1', machine_id: 'srv-4090-a', severity: 'error', timestamp: 1_780_911_880, content: 'x' },
    ]);

    const r = await api('/api/logs/history?severity=error&limit=10&offset=0');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBeUndefined();
    expect(r.body.source).toBe('database');
    expect(r.body.logs.map((x) => x.id)).toEqual(['h1']);
    expect(db.listLogRecords).toHaveBeenCalledTimes(1);
    expect(db.listLogRecords).toHaveBeenCalledWith({ machine_id: undefined, severity: 'error', limit: 10, offset: 0 });
  });

  it('TSDB 面板读真实依赖：targets / labels / series / status / metrics', async () => {
    const targets = await api('/api/v1/targets');
    expect(targets.status).toBe(200);
    expect(targets.body.demo).toBeUndefined();
    expect(targets.body.data.activeTargets[0].labels.job).toBe('real-job');
    expect(scraper.targets).toHaveBeenCalledTimes(1);

    const labels = await api('/api/v1/labels');
    expect(labels.body.demo).toBeUndefined();
    expect(tsdbStore.listMetricNames).toHaveBeenCalledTimes(1);

    const series = await api('/api/v1/series?match%5B%5D=openlog_cpu_usage_percent');
    expect(series.status).toBe(200);
    expect(tsdbStore.listSeries).toHaveBeenCalledTimes(1);

    const values = await api('/api/v1/label/host/values');
    expect(values.body.demo).toBeUndefined();
    expect(tsdbStore.labelValues).toHaveBeenCalledWith('host');

    const status = await api('/api/tsdb/status');
    expect(status.body.demo).toBeUndefined();
    expect(status.body.storage).toEqual({ ready: false, seriesCount: 0 });
    expect(tsdbStore.stats).toHaveBeenCalledTimes(1);
    expect(scraper.stats).toHaveBeenCalledTimes(1);

    const metrics = await api('/metrics');
    expect(metrics.contentType).toContain('text/plain');
    expect(getSelfMetrics).toHaveBeenCalledTimes(1);
    expect(String(metrics.body)).toContain('openlog_real_metric');
  });

  it('写操作在真实模式正常下发（不是 409）', async () => {
    const r = await api('/api/tsdb/test-notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    // receivers 为空 → 400 bad_data（而不是 409）
    expect(r.status).toBe(400);
    expect(r.body.status).toBe('error');
    expect(notifier.sendTest).not.toHaveBeenCalled();
  });
});
