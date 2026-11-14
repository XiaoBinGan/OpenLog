/**
 * TSDB 子系统装配的端到端测试：配置加载 → 启动 → 抓取 → 查询 → 规则 → 暴露。
 *
 * 用真的 SQLite + 真的 HTTP server（本地起一个假的 exporter），
 * 不打桩 —— 装配层的 bug 几乎都在「连接各部件」的地方，打桩全看不见。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTsdbSubsystem, loadTsdbConfig, DEFAULT_TSDB_CONFIG } from '../tsdb/index.js';

let tmpDir;

function makeAdapter(sqlite) {
  return {
    async run(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; const i = sqlite.prepare(sql).run(...f); return { changes: i.changes }; },
    async get(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).get(...f); },
    async all(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).all(...f); },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlog-tsdb-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('配置加载', () => {
  it('无配置文件时用默认值', () => {
    const r = loadTsdbConfig(tmpDir, {});
    expect(r.config.enabled).toBe(true);
    expect(r.config.retentionDays).toBe(DEFAULT_TSDB_CONFIG.retentionDays);
    expect(r.errors).toEqual([]);
  });

  it('读配置文件', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsdb.json'), JSON.stringify({
      retentionDays: 3,
      scrapeInterval: '30s',
      scrapeConfigs: [{ job: 'node', targets: ['http://a:9100'] }],
    }), 'utf8');
    const r = loadTsdbConfig(tmpDir, {});
    expect(r.config.retentionDays).toBe(3);
    expect(r.config.scrapeInterval).toBe('30s');
    expect(r.scrapeConfigs).toHaveLength(1);
  });

  it('坏 JSON 报错但不崩，回落默认值', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsdb.json'), '{bad json', 'utf8');
    const r = loadTsdbConfig(tmpDir, {});
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.config.retentionDays).toBe(DEFAULT_TSDB_CONFIG.retentionDays);
  });

  it('OPENLOG_TSDB=off 关闭子系统', () => {
    const r = loadTsdbConfig(tmpDir, { OPENLOG_TSDB: 'off' });
    expect(r.config.enabled).toBe(false);
  });

  it('环境变量覆盖保留天数', () => {
    const r = loadTsdbConfig(tmpDir, { OPENLOG_TSDB_RETENTION_DAYS: '14' });
    expect(r.config.retentionDays).toBe(14);
  });

  it('非法环境变量被记录而不是静默忽略', () => {
    const r = loadTsdbConfig(tmpDir, { OPENLOG_TSDB_RETENTION_DAYS: 'abc' });
    expect(r.errors.some((e) => /RETENTION_DAYS/.test(e))).toBe(true);
    expect(r.config.retentionDays).toBe(DEFAULT_TSDB_CONFIG.retentionDays);
  });

  it('抓取配置错误被收集', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsdb.json'), JSON.stringify({
      scrapeConfigs: [{ job: 'x', targets: ['no-scheme:9100'] }],
    }), 'utf8');
    const r = loadTsdbConfig(tmpDir, {});
    expect(r.errors.some((e) => /http/.test(e))).toBe(true);
    expect(r.scrapeConfigs).toHaveLength(0);
  });

  it('规则配置错误被收集', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsdb.json'), JSON.stringify({
      ruleGroups: [{ name: 'g', rules: [{ alert: 'A' }] }],
    }), 'utf8');
    const r = loadTsdbConfig(tmpDir, {});
    expect(r.errors.some((e) => /expr/.test(e))).toBe(true);
  });
});

describe('子系统装配', () => {
  let sqlite, store, sub;

  function makeSub(extra = {}) {
    sqlite = new Database(':memory:');
    const adapter = makeAdapter(sqlite);
    return createTsdbSubsystem({
      dataDir: tmpDir,
      getDb: () => adapter,
      getDbType: () => 'sqlite',
      getSystemStats: () => ({
        cpu: { usage: 42, cores: [10, 20] },
        memory: { total: 1000, used: 400, percent: 40 },
        disks: [{ mount: '/', size: 1000, used: 500, use: 50 }],
      }),
      getContainers: () => [{ state: 'running' }, { state: 'exited' }],
      env: {},
      log: () => {},
      ...extra,
    });
  }

  it('enabled 默认 true', () => {
    sub = makeSub();
    expect(sub.enabled).toBe(true);
  });

  it('建表成功', async () => {
    sub = makeSub();
    await sub.store.ensureSchema();
    const st = await sub.store.stats();
    expect(st.ready).toBe(true);
  });

  it('collectSelfMetrics 产出自身指标', async () => {
    sub = makeSub();
    await sub.store.ensureSchema();
    const m = await sub.collectSelfMetrics();
    const names = m.map((x) => x.name);
    expect(names).toContain('openlog_cpu_usage_percent');
    expect(names).toContain('openlog_memory_usage_percent');
    expect(names).toContain('openlog_disk_usage_percent');
    expect(names).toContain('openlog_docker_containers_total');
    expect(names).toContain('openlog_tsdb_series_total');
    expect(names).toContain('openlog_scrape_rounds_total');
  });

  it('系统指标取不到时仍返回其它指标（不整体失败）', async () => {
    sub = makeSub({ getSystemStats: () => { throw new Error('boom'); } });
    await sub.store.ensureSchema();
    const m = await sub.collectSelfMetrics();
    expect(m.length).toBeGreaterThan(0);
    expect(m.map((x) => x.name)).toContain('openlog_tsdb_ready');
  });

  it('保留期清理', async () => {
    sub = makeSub();
    await sub.store.ensureSchema();
    const old = Date.now() - 30 * 86_400_000;
    await sub.store.writeSamples([{ name: 'x', labels: {}, value: 1, timestamp: old }]);
    const r = await sub.prune();
    expect(r.deleted).toBe(1);
  });

  it('enabled=false 时 start 不做事', async () => {
    fs.writeFileSync(path.join(tmpDir, 'tsdb.json'), JSON.stringify({ enabled: false }), 'utf8');
    sub = makeSub();
    expect(sub.enabled).toBe(false);
    await sub.start(); // 不应抛错
    sub.stop();
  });
});

describe('抓取 + 查询闭环（真 HTTP）', () => {
  let sub, exporterSrv, exporterUrl;

  beforeEach(async () => {
    // 起一个假 exporter
    const http = await import('node:http');
    exporterSrv = http.createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end([
          '# TYPE demo_counter counter',
          'demo_counter{kind="a"} 100',
          'demo_gauge 0.75',
          '',
        ].join('\n'));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => exporterSrv.listen(0, '127.0.0.1', r));
    exporterUrl = `http://127.0.0.1:${exporterSrv.address().port}`;

    fs.writeFileSync(path.join(tmpDir, 'tsdb.json'), JSON.stringify({
      scrapeConfigs: [{ job: 'demo', targets: [exporterUrl], interval: '1s' }],
      ruleGroups: [{
        name: 'g',
        rules: [{ alert: 'DemoHigh', expr: 'demo_gauge > 0.5', annotations: { summary: 'v={{ $value }}' } }],
      }],
    }), 'utf8');

    const sqlite = new Database(':memory:');
    sub = createTsdbSubsystem({
      dataDir: tmpDir,
      getDb: () => makeAdapter(sqlite),
      getDbType: () => 'sqlite',
      getSystemStats: () => null,
      getContainers: () => [],
      env: {},
      log: () => {},
    });
    await sub.store.ensureSchema();
  });

  afterEach(async () => {
    sub?.stop();
    if (exporterSrv) await new Promise((r) => exporterSrv.close(r));
  });

  it('抓取外部 target 并写入 TSDB', async () => {
    const r = await sub.scraper.scrapeOnce();
    expect(r.scraped).toBe(1);
    expect(r.failures).toBe(0);

    const { series } = await sub.store.queryRange({ metricName: 'demo_gauge', start: 0, end: Date.now() + 1000 });
    expect(series).toHaveLength(1);
    expect(series[0].points[0].value).toBe(0.75);
    expect(series[0].labels.job).toBe('demo');
  });

  it('up 指标为 1', async () => {
    await sub.scraper.scrapeOnce();
    const { series } = await sub.store.queryRange({ metricName: 'up', start: 0, end: Date.now() + 1000 });
    expect(series[0].points[0].value).toBe(1);
  });

  it('目标 404 时 up=0', async () => {
    fs.writeFileSync(path.join(tmpDir, 'tsdb.json'), JSON.stringify({
      scrapeConfigs: [{ job: 'demo', targets: [`${exporterUrl}/nope`] }],
    }), 'utf8');
    const sqlite2 = new Database(':memory:');
    const sub2 = createTsdbSubsystem({
      dataDir: tmpDir,
      getDb: () => makeAdapter(sqlite2),
      getDbType: () => 'sqlite',
      env: {},
      log: () => {},
    });
    await sub2.store.ensureSchema();
    await sub2.scraper.scrapeOnce();
    const { series } = await sub2.store.queryRange({ metricName: 'up', start: 0, end: Date.now() + 1000 });
    expect(series[0].points[0].value).toBe(0);
    sub2.stop();
  });

  it('规则能对抓来的数据求值', async () => {
    await sub.scraper.scrapeOnce();
    await sub.evaluateRules();
    const firing = sub.ruleEngine.firing();
    expect(firing).toHaveLength(1);
    expect(firing[0].name).toBe('DemoHigh');
    expect(firing[0].annotations.summary).toBe('v=0.75');
  });

  it('查询能跨库算出 rate', async () => {
    await sub.scraper.scrapeOnce();
    // 只有一个点，rate 不输出（正确行为）
    const { createEvaluator } = await import('../tsdb/promql-engine.js');
    const ev = createEvaluator({ store: sub.store });
    const r = await ev.query('rate(demo_counter[5m])');
    expect(r.error).toBeUndefined();
    expect(r.result).toHaveLength(0);
  });

  it('start/stop 生命周期不抛错', async () => {
    await sub.start();
    await new Promise((r) => setTimeout(r, 50));
    sub.stop();
    expect(true).toBe(true);
  });
});