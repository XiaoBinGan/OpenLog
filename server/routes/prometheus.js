/**
 * Prometheus 兼容 API 路由。
 *
 * 端点与 Prometheus HTTP API 对齐，让 Grafana / 现有工具能直接接：
 *   GET  /metrics                       —— 自身的 Prometheus 暴露格式
 *   GET  /api/v1/query?query=&time=     —— 瞬时查询
 *   GET  /api/v1/query_range?query=&start=&end=&step=
 *   GET  /api/v1/labels                 —— 全部标签名
 *   GET  /api/v1/label/:name/values     —— 某标签的值
 *   GET  /api/v1/series?match[]=        —— 序列列表
 *   GET  /api/v1/targets                —— 抓取目标状态
 *   GET  /api/v1/rules                  —— 规则与告警
 *   GET  /api/v1/alerts                 —— 当前告警
 *
 * 响应形状严格按 Prometheus：`{status:"success", data:{...}}` /
 * `{status:"error", errorType:"...", error:"..."}`。
 * 为什么不改成更「好看」的形状：Grafana 的数据源实现是按这个协议写的，
 * 改了就接不上 —— 兼容性就是功能。
 */

import express from 'express';
import { formatExposition } from '../tsdb/exposition.js';
import { createEvaluator } from '../tsdb/promql-engine.js';
import { parse } from '../tsdb/promql-parser.js';
import { groupAlerts, applyInhibition, applySilences } from '../tsdb/rules.js';
import { isDemoMode, DEMO_DISABLED } from '../demo/mode.js';
import * as demoFixtures from '../demo/fixtures.js';

/**
 * 解析 Prometheus 风格的时间参数。
 * 支持：毫秒/秒数字、RFC3339。空值返回 undefined。
 */
export function parseTimeParam(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // 10 位数按秒，13 位按毫秒 —— Grafana 两种都发
    return n > 1e11 ? n : n * 1000;
  }
  const d = Date.parse(s);
  return Number.isNaN(d) ? undefined : d;
}

/** 解析 step 参数（秒或带单位） */
export function parseStepParam(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

/** 把 `a{b="c"}` 这样的 match[] 解析成 {metricName, matchers} */
export function parseSeriesSelector(raw) {
  const { ast, error } = parse(String(raw));
  if (error) return { error: error.message };
  if (!ast || ast.type !== 'selector') return { error: 'match[] 必须是单个向量选择器' };
  const matchers = [];
  let metricName = ast.name || undefined;
  for (const m of ast.matchers || []) {
    if (m.name === '__name__' && m.op === '=') { metricName = m.value; continue; }
    matchers.push(m);
  }
  return { metricName, matchers: matchers.length ? matchers : undefined };
}

/** 统一的错误响应 */
function fail(res, status, errorType, message) {
  res.status(status).json({ status: 'error', errorType, error: message });
}

/** 统一的成功响应 */
function ok(res, data, warnings) {
  const body = { status: 'success', data };
  if (Array.isArray(warnings) && warnings.length) body.warnings = warnings;
  res.json(body);
}

// ─── 演示模式（OPENLOG_DEMO=1）────────────────────────────────────────
// 时序数据只来自 server/demo/fixtures.js（命名空间导入，导出缺失不会在链接阶段崩掉整条路由）。
// 关闭演示模式时下面的分支都不会进，原有的 PromQL 求值/存储读取保持原样。

/** 取一份演示数据；fixture 缺失/抛错时返回 undefined，让端点降级而非 500 */
function demoValue(name, ...args) {
  const fn = demoFixtures[name];
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch (err) {
    console.warn(`[demo] ${name} 调用失败:`, String(err?.message || err));
    return undefined;
  }
}

/**
 * 演示模式的查询结果，包成 Prometheus 响应形状：`{ demo:true, status:'success', data }`。
 * fixture 可能返回 `{resultType,result}`（Prometheus data 本体）或已包一层 `{data}`，两种都接受。
 */
function okDemo(res, params) {
  const raw = demoValue('demoTsdbQuery', params);
  const data = (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object')
    ? raw.data
    : (raw && typeof raw === 'object' ? raw : { resultType: 'matrix', result: [] });
  res.json({ demo: true, status: 'success', data });
}

/**
 * 创建路由。
 *
 * @param {object} deps
 * @param {{queryRange:Function, listMetricNames:Function, labelValues:Function, stats:Function}} deps.store
 * @param {() => number} [deps.now]
 * @param {() => object} [deps.getScraper] 返回抓取器（可空）
 * @param {() => object} [deps.getRuleEngine] 返回规则引擎（可空）
 * @param {() => object} [deps.getRuleConfig] 返回 {ruleGroups, inhibitRules, silences}
 * @param {() => Array} [deps.getSelfMetrics] 返回 OpenLog 自身的指标（用于 /metrics）
 * @param {{auth:Function}} [deps.auth] 鉴权中间件
 */
export function createPrometheusRouter(deps = {}) {
  const router = express.Router();
  const store = deps.store;
  const now = deps.now || (() => Date.now());
  const getScraper = deps.getScraper || (() => null);
  const getRuleEngine = deps.getRuleEngine || (() => null);
  const getRuleConfig = deps.getRuleConfig || (() => ({ ruleGroups: [], inhibitRules: [], silences: [] }));
  const getSelfMetrics = deps.getSelfMetrics || (() => []);
  const getNotifier = deps.getNotifier || (() => null);
  const evaluator = createEvaluator({ store, now });
  const auth = deps.auth || ((req, res, next) => next());

  // ── 瞬时查询 ──
  router.get('/api/v1/query', auth, async (req, res) => {
    const query = req.query.query;
    if (!query) return fail(res, 400, 'bad_data', '缺少 query 参数');
    // 演示模式：不查存储、不求值 PromQL，直接回 fixture 序列
    if (isDemoMode()) return okDemo(res, { query: String(query), time: parseTimeParam(req.query.time) });
    const time = parseTimeParam(req.query.time);
    const r = await evaluator.query(String(query), time === undefined ? {} : { time });
    if (r.error) return fail(res, 400, r.error.type || 'bad_data', r.error.message);
    return ok(res, { resultType: r.resultType, result: r.result }, r.warnings);
  });

  // ── 区间查询 ──
  router.get('/api/v1/query_range', auth, async (req, res) => {
    const query = req.query.query;
    if (!query) return fail(res, 400, 'bad_data', '缺少 query 参数');
    const start = parseTimeParam(req.query.start);
    const end = parseTimeParam(req.query.end);
    const step = parseStepParam(req.query.step);
    if (start === undefined || end === undefined) {
      return fail(res, 400, 'bad_data', 'start 与 end 必须是有效时间');
    }
    // 演示模式：区间查询同样走 fixture（60 点 1 小时序列由 fixture 负责）
    if (isDemoMode()) return okDemo(res, { query: String(query), start, end, step });
    const stepMs = step === undefined ? Math.max(1000, Math.floor((end - start) / 100)) : step;
    const r = await evaluator.queryRange(String(query), start, end, stepMs);
    if (r.error) return fail(res, 400, r.error.type || 'bad_data', r.error.message);
    return ok(res, { resultType: 'matrix', result: r.result });
  });

  // ── 标签名 ──
  router.get('/api/v1/labels', auth, async (req, res) => {
    const matchers = readMultiQuery(req.query, 'match[]');
    const names = await collectLabelNames(store, matchers);
    return ok(res, names);
  });

  // ── 某标签的值 ──
  router.get('/api/v1/label/:name/values', auth, async (req, res) => {
    const values = await store.labelValues(String(req.params.name));
    return ok(res, values);
  });

  // ── 序列列表 ──
  router.get('/api/v1/series', auth, async (req, res) => {
    const match = readMultiQuery(req.query, 'match[]');
    if (match.length === 0) return fail(res, 400, 'bad_data', '至少需要一个 match[] 参数');

    const seen = new Map();
    for (const raw of match) {
      const sel = parseSeriesSelector(raw);
      if (sel.error) return fail(res, 400, 'bad_data', sel.error);
      // 用 listSeries 而不是 queryRange：这里只要序列存在性，不需要任何采样点。
      // queryRange 的 limit 是**总点数**上限，配 1 会只返回一条序列（踩过）。
      const list = await store.listSeries({ metricName: sel.metricName, matchers: sel.matchers });
      for (const s of list) {
        const labels = { __name__: s.name, ...s.labels };
        const key = JSON.stringify(labels);
        if (!seen.has(key)) seen.set(key, labels);
      }
    }
    return ok(res, [...seen.values()]);
  });

  // ── 抓取目标 ──
  router.get('/api/v1/targets', auth, (req, res) => {
    const scraper = getScraper();
    if (!scraper) return ok(res, { activeTargets: [], droppedTargets: [] });
    const activeTargets = scraper.targets().map((t) => ({
      labels: { job: t.job, instance: t.url },
      scrapeUrl: t.url,
      health: t.health,
      lastScrape: new Date(t.lastScrapeMs).toISOString(),
      lastDurationMs: t.lastDurationMs,
      lastError: t.lastError || '',
      samplesCount: t.samplesCount,
    }));
    return ok(res, { activeTargets, droppedTargets: [] });
  });

  // ── 规则 ──
  router.get('/api/v1/rules', auth, (req, res) => {
    const engine = getRuleEngine();
    if (!engine) return ok(res, { groups: [] });
    const snap = engine.snapshot();
    const groups = (snap.groups || []).map((g) => ({
      name: g.name,
      file: 'openlog-rules',
      interval: g.intervalMs ? `${g.intervalMs / 1000}s` : '15s',
      lastEvaluation: g.lastEvalMs ? new Date(g.lastEvalMs).toISOString() : null,
      rules: (g.rules || []).map((r) => (r.kind === 'alert' ? {
        name: r.name,
        type: 'alerting',
        health: r.health,
        query: '',
        state: (r.alerts || []).some((a) => a.state === 'firing') ? 'firing'
          : (r.alerts || []).length ? 'pending' : 'inactive',
        alerts: (r.alerts || []).map((a) => ({
          labels: { alertname: r.name, ...a.labels },
          annotations: a.annotations,
          state: a.state,
          activeAt: a.activeAt ? new Date(a.activeAt).toISOString() : null,
          value: String(a.value),
        })),
      } : {
        name: r.name,
        type: 'recording',
        health: r.health,
        seriesCount: r.seriesCount ?? 0,
      })),
    }));
    return ok(res, { groups });
  });

  // ── 当前告警（经过抑制与静默）──
  router.get('/api/v1/alerts', auth, (req, res) => {
    const engine = getRuleEngine();
    if (!engine) return ok(res, { alerts: [] });
    const cfg = getRuleConfig() || {};
    const firing = engine.firing();
    const { kept } = applyInhibition(firing, cfg.inhibitRules || []);
    const { kept: visible } = applySilences(kept, cfg.silences || [], now());
    const alerts = visible.map((a) => ({
      labels: { alertname: a.name, ...a.labels },
      annotations: a.annotations,
      state: a.state,
      activeAt: a.activeAt ? new Date(a.activeAt).toISOString() : null,
      value: String(a.value),
    }));
    return ok(res, { alerts });
  });

  // ── 分组视图（给通知模块用）──
  router.get('/api/v1/alert_groups', auth, (req, res) => {
    const engine = getRuleEngine();
    if (!engine) return ok(res, { groups: [] });
    const cfg = getRuleConfig() || {};
    const firing = engine.firing();
    const { kept } = applyInhibition(firing, cfg.inhibitRules || []);
    const { kept: visible } = applySilences(kept, cfg.silences || [], now());
    const groups = groupAlerts(visible, cfg.routes || [{ groupBy: ['alertname'] }]);
    return ok(res, {
      groups: groups.map((g) => ({
        labels: g.groupBy,
        alerts: g.alerts.map((a) => ({
          labels: { alertname: a.name, ...a.labels },
          annotations: a.annotations,
          value: String(a.value),
        })),
      })),
    });
  });

  // ── 自身暴露格式 ──
  router.get('/metrics', auth, async (req, res) => {
    // getSelfMetrics 可以是同步数组，也可以返回 Promise（要读 DB 统计时）。
    // 统一 await：抓取端不关心里面是缓存还是现算。
    let samples = [];
    try {
      samples = await getSelfMetrics();
    } catch (err) {
      return fail(res, 500, 'internal', `自身指标采集失败: ${String(err?.message || err)}`);
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(formatExposition(Array.isArray(samples) ? samples : []));
  });

  // ── 测试通知通道 ──
  // 配完 webhook 想验证通不通，不用等真出故障。
  // 之前用户只能自己造一次告警，或者干脆不验证就上线。
  router.post('/api/tsdb/test-notify', auth, async (req, res) => {
    // 演示模式：测试通知会真发 webhook 请求，属于写操作/外部动作，禁用
    if (isDemoMode()) return res.status(409).json(DEMO_DISABLED);
    const notifier = getNotifier();
    if (!notifier) return fail(res, 503, 'unavailable', '通知模块未启用');
    const cfg = getRuleConfig() || {};
    const receivers = (cfg.receivers || []).filter((r) => r && r.url);
    if (receivers.length === 0) {
      return fail(res, 400, 'bad_data', '未配置通知接收器（tsdb.json 里的 receivers）');
    }
    const results = [];
    for (const r of receivers) {
      const ok = await notifier.sendTest(r);
      results.push({ receiver: r.id || r.name || r.url, url: r.url, ok });
    }
    return ok(res, { results, sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length });
  });

  // ── TSDB 运行状态 ──
  router.get('/api/tsdb/status', auth, async (req, res) => {
    const s = await store.stats();
    const scraper = getScraper();
    const engine = getRuleEngine();
    res.json({
      storage: s,
      scraper: scraper ? scraper.stats() : null,
      rules: engine ? {
        lastEvalMs: engine.snapshot().at,
        alertCount: engine.alerts().length,
        firingCount: engine.firing().length,
      } : null,
    });
  });

  return router;
}

/**
 * 把一个 query 参数归一成数组（Express 对重复参数给数组，单个给字符串）。
 *
 * 注意：Express 4 的默认 qs 解析器会把 `match[]=a&match[]=b` 解析成
 * `{ match: ['a','b'] }` —— **方括号被吃掉了**，键名不是 `match[]`。
 * 但用 simple 解析器或某些客户端发 `match%5B%5D=` 时键名又是 `match[]`。
 * 两种形状都得认，否则 Grafana 的 /api/v1/series 会直接 400。
 */
function readMultiQuery(query, name) {
  const direct = query[name];
  const bare = query[name.replace(/\[\]$/, '')];
  const v = direct !== undefined ? direct : bare;
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

/**
 * 收集全部标签名。
 * 有 match[] 时只统计匹配的序列 —— 否则 Grafana 的级联变量会拿到无关的值。
 */
async function collectLabelNames(store, matchSelectors) {
  const names = new Set();
  if (matchSelectors.length === 0) {
    // 没有过滤：从全部序列里取
    const metricNames = await store.listMetricNames();
    if (metricNames.length === 0) return [];
    const r = await store.queryRange({ start: 0, end: Date.now(), limit: 1 });
    for (const s of r.series) for (const k of Object.keys(s.labels)) names.add(k);
    names.add('__name__');
    return [...names].sort();
  }
  for (const raw of matchSelectors) {
    const sel = parseSeriesSelector(raw);
    if (sel.error) continue;
    const r = await store.queryRange({
      metricName: sel.metricName, matchers: sel.matchers, start: 0, end: Date.now(), limit: 1,
    });
    for (const s of r.series) for (const k of Object.keys(s.labels)) names.add(k);
    names.add('__name__');
  }
  return [...names].sort();
}