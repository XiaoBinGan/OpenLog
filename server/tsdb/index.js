/**
 * TSDB 子系统装配 —— 把存储、抓取、规则、暴露格式串成一个可启动的整体。
 *
 * 配置文件（可选）：`<dataDir>/tsdb.json`
 *   {
 *     "enabled": true,
 *     "retentionDays": 7,
 *     "scrapeInterval": "15s",
 *     "scrapeConfigs": [{ "job": "...", "targets": ["http://..."], "metricsPath": "/metrics" }],
 *     "ruleGroups": [{ "name": "...", "rules": [{ "alert": "...", "expr": "...", "for": "5m" }] }],
 *     "inhibitRules": [{ "sourceMatch": {...}, "targetMatch": {...}, "equal": ["instance"] }]
 *   }
 *
 * 环境变量覆盖：
 *   OPENLOG_TSDB=off            关闭整个子系统
 *   OPENLOG_TSDB_RETENTION_DAYS 保留天数
 *   OPENLOG_TSDB_INTERVAL       抓取间隔
 *
 * 为什么配置放独立文件而不是塞进 settings：抓取目标与告警规则是**基础设施配置**
 * （跟 Prometheus 的 yaml 同级），不是用户在界面上随手改的偏好设置。
 * 混进 settings 会让「改个主题色」和「加一个抓取目标」走同一条保存路径，
 * 前者永远不需要校验后者需要的语法。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createTsdbStore } from './store.js';
import { createScraper, normalizeScrapeConfigs, DEFAULT_SCRAPE_INTERVAL_MS } from './scrape.js';
import { createRuleEngine, normalizeRuleGroups } from './rules.js';
import {
  systemStatsToSamples, containersToSamples, tsdbStatsToSamples,
  scraperStatsToSamples, mergeSamples,
} from './self-metrics.js';

/** 默认配置 */
export const DEFAULT_TSDB_CONFIG = {
  enabled: true,
  retentionDays: 7,
  scrapeInterval: '15s',
  scrapeConfigs: [],
  ruleGroups: [],
  inhibitRules: [],
  routes: [{ groupBy: ['alertname'] }],
  silences: [],
};

/** 时长字符串 → 毫秒，非法返回 null */
function parseDuration(s) {
  const str = String(s ?? '').trim();
  if (/^\d+$/.test(str)) return Number(str);
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(str);
  if (!m) return null;
  const n = Number(m[1]);
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]];
}

/**
 * 读配置：文件 → 环境变量覆盖 → 默认值。
 * 文件读不出来时报错但不阻塞启动 —— 监控子系统挂了不该让主服务起不来。
 *
 * @param {string} dataDir
 * @param {object} [env]
 */
export function loadTsdbConfig(dataDir, env = process.env) {
  const file = path.join(dataDir, 'tsdb.json');
  let fromFile = {};
  const errors = [];
  try {
    if (fs.existsSync(file)) {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    errors.push(`读取 ${file} 失败: ${String(err?.message || err)}`);
    fromFile = {};
  }

  const cfg = { ...DEFAULT_TSDB_CONFIG, ...(fromFile && typeof fromFile === 'object' ? fromFile : {}) };

  if (String(env.OPENLOG_TSDB || '').toLowerCase() === 'off') cfg.enabled = false;
  if (env.OPENLOG_TSDB_RETENTION_DAYS) {
    const n = Number(env.OPENLOG_TSDB_RETENTION_DAYS);
    if (Number.isFinite(n) && n > 0) cfg.retentionDays = n;
    else errors.push(`OPENLOG_TSDB_RETENTION_DAYS 非法: ${env.OPENLOG_TSDB_RETENTION_DAYS}`);
  }
  if (env.OPENLOG_TSDB_INTERVAL) {
    const ms = parseDuration(env.OPENLOG_TSDB_INTERVAL);
    if (ms) cfg.scrapeInterval = env.OPENLOG_TSDB_INTERVAL;
    else errors.push(`OPENLOG_TSDB_INTERVAL 非法: ${env.OPENLOG_TSDB_INTERVAL}`);
  }

  // 校验抓取配置与规则，错误只报告不抛出
  const scrape = normalizeScrapeConfigs(cfg);
  errors.push(...scrape.errors);
  const rules = normalizeRuleGroups(cfg);
  errors.push(...rules.errors);

  return {
    config: cfg,
    configPath: file,
    scrapeConfigs: scrape.configs,
    ruleGroups: rules.groups,
    errors,
  };
}

/**
 * 创建 TSDB 子系统。
 *
 * @param {object} deps
 * @param {string} deps.dataDir 数据目录（配置文件与后续扩展用）
 * @param {() => object} deps.getDb 适配层
 * @param {() => string} deps.getDbType
 * @param {() => object} [deps.getSystemStats] 返回系统指标（monitor/stats 的形状）
 * @param {() => Array} [deps.getContainers] 返回容器列表
 * @param {() => number} [deps.now]
 * @param {object} [deps.env]
 * @param {(msg:string) => void} [deps.log]
 */
export function createTsdbSubsystem(deps = {}) {
  const dataDir = deps.dataDir || path.join(process.cwd(), 'data');
  const now = deps.now || (() => Date.now());
  const log = deps.log || ((m) => console.log(`[TSDB] ${m}`));
  const getSystemStats = deps.getSystemStats || (() => null);
  const getContainers = deps.getContainers || (() => []);

  const loaded = loadTsdbConfig(dataDir, deps.env || process.env);
  const config = loaded.config;

  const store = createTsdbStore({ getDb: deps.getDb, getDbType: deps.getDbType, now });

  /** 抓取目标：按 targets + metricsPath 展开成 {job, url, instance, extraLabels} */
  function buildTargets() {
    const out = [];
    for (const sc of loaded.scrapeConfigs) {
      for (const t of sc.targets) {
        const base = t.replace(/\/+$/, '');
        const p = sc.metricsPath.startsWith('/') ? sc.metricsPath : `/${sc.metricsPath}`;
        out.push({
          job: sc.job,
          url: base + p,
          extraLabels: sc.labels || {},
          timeoutMs: sc.timeoutMs || undefined,
          auth: sc.auth || null,
        });
      }
    }
    return out;
  }

  const intervalMs = parseDuration(config.scrapeInterval) || DEFAULT_SCRAPE_INTERVAL_MS;
  const scraper = createScraper({
    store,
    getTargets: buildTargets,
    now,
    intervalMs,
    onEvent: (e) => {
      if (e.type === 'write-error') log(`写入失败: ${e.error}`);
      else if (e.type === 'round-error') log(`抓取轮次失败: ${e.error}`);
    },
  });

  const ruleEngine = createRuleEngine({ store, now });

  let ruleTimer = null;
  let retentionTimer = null;
  let selfTimer = null;
  let started = false;

  /** 自身指标：系统 + 容器 + TSDB 自身 + 抓取器 */
  async function collectSelfMetrics() {
    const ts = now();
    const groups = [];
    try {
      // getSystemStats 可以返回 Promise：真实实现要触发一次 systeminformation
      // 采集（带 3 秒缓存），同步接口拿不到新鲜数据。
      // 之前这里是同步取值，而缓存只由 /metrics 端点填充 —— 自采集循环独立
      // 运行，缓存永远是 null，于是系统指标一条都没写进库。
      const sys = await getSystemStats();
      if (sys) groups.push(systemStatsToSamples(sys, { timestamp: ts }));
    } catch { /* 系统指标取不到不该让 /metrics 失败 */ }

    try {
      const cs = getContainers();
      if (Array.isArray(cs) && cs.length >= 0) groups.push(containersToSamples(cs, ts));
    } catch { /* 同上 */ }

    try {
      groups.push(tsdbStatsToSamples(await store.stats(), ts));
    } catch { /* 同上 */ }

    try {
      groups.push(scraperStatsToSamples(scraper.stats(), ts));
    } catch { /* 同上 */ }

    return mergeSamples(...groups);
  }

  /** 求值全部规则 */
  async function evaluateRules() {
    if (!loaded.ruleGroups.length) return { alerts: [], fired: [], resolved: [], errors: [] };
    return ruleEngine.evaluateAll(loaded.ruleGroups);
  }

  /**
   * 内置自采集：把自身指标**直接写进时序库**，不走 HTTP。
   *
   * 为什么必须有这一步：`/metrics` 只是把数据导出来给外部抓。
   * 没有这个循环的话，零配置部署的 OpenLog 时序库永远是空的 ——
   * 用户打开 PromQL 查什么都查不到，会以为整个功能坏了。
   *
   * 为什么不抓自己的 HTTP 端点：多一次往返、多一次鉴权、还要用户配 token。
   * 数据本来就在内存里，直接写更简单也更快。
   */
  async function collectSelfIntoStore() {
    const ts = now();
    const samples = await collectSelfMetrics();
    if (!samples.length) return { written: 0 };
    // 时间戳统一成这一轮的 now，避免同一次采集里各指标时间不一致
    for (const s of samples) s.timestamp = ts;
    return store.writeSamples(samples, { timestamp: ts });
  }

  /** 清理过期数据 */
  async function prune() {
    const ms = Number(config.retentionDays) * 86_400_000;
    if (!Number.isFinite(ms) || ms <= 0) return { deleted: 0 };
    const r = await store.pruneSamples(ms);
    if (r.deleted > 0) {
      const orphans = await store.pruneOrphanSeries();
      log(`清理 ${r.deleted} 个采样点、${orphans.deleted} 条空序列`);
    }
    return r;
  }

  return {
    enabled: config.enabled !== false,
    config,
    configPath: loaded.configPath,
    configErrors: loaded.errors,
    store,
    scraper,
    ruleEngine,
    intervalMs,
    collectSelfMetrics,
    collectSelfIntoStore,
    evaluateRules,
    prune,
    getRuleConfig: () => ({
      ruleGroups: loaded.ruleGroups,
      inhibitRules: config.inhibitRules || [],
      silences: config.silences || [],
      routes: config.routes || [{ groupBy: ['alertname'] }],
    }),

    async start() {
      if (started || !this.enabled) return;
      started = true;
      // 建表失败不阻塞启动，但要说清楚
      const ok = await store.ensureSchema();
      if (!ok) {
        log('建表失败，TSDB 相关接口将返回不可用');
        return;
      }

      if (buildTargets().length > 0) {
        scraper.start();
        log(`抓取已启动：${buildTargets().length} 个目标，间隔 ${intervalMs}ms`);
      } else {
        log('没有配置抓取目标（scrapeConfigs 为空），仅采集自身指标');
      }

      // 内置自采集：不管有没有配外部 target，都把自己写进时序库。
      // 不写的话零配置部署的实例库里永远没数据，PromQL 查什么都是空的。
      const selfTick = async () => {
        try {
          const r = await collectSelfIntoStore();
          if (r.error) log(`自身指标写入失败: ${r.error}`);
        } catch (err) {
          log(`自身指标采集失败: ${String(err?.message || err)}`);
        }
        selfTimer = setTimeout(selfTick, intervalMs);
        if (selfTimer.unref) selfTimer.unref();
      };
      selfTick();
      log(`自身指标采集已启动（间隔 ${intervalMs}ms）`);

      if (loaded.ruleGroups.length > 0) {
        const ruleInterval = 15_000;
        const tick = async () => {
          try { await evaluateRules(); } catch (err) { log(`规则求值失败: ${String(err?.message || err)}`); }
          ruleTimer = setTimeout(tick, ruleInterval);
          if (ruleTimer.unref) ruleTimer.unref();
        };
        tick();
        log(`规则已启动：${loaded.ruleGroups.length} 个组`);
      }

      // 每小时清理一次过期数据
      const pruneTick = async () => {
        try { await prune(); } catch (err) { log(`清理失败: ${String(err?.message || err)}`); }
        retentionTimer = setTimeout(pruneTick, 3_600_000);
        if (retentionTimer.unref) retentionTimer.unref();
      };
      retentionTimer = setTimeout(pruneTick, 60_000);
      if (retentionTimer.unref) retentionTimer.unref();

      if (loaded.errors.length) {
        for (const e of loaded.errors) log(`配置问题: ${e}`);
      }
    },

    stop() {
      started = false;
      scraper.stop();
      if (ruleTimer) { clearTimeout(ruleTimer); ruleTimer = null; }
      if (retentionTimer) { clearTimeout(retentionTimer); retentionTimer = null; }
      if (selfTimer) { clearTimeout(selfTimer); selfTimer = null; }
    },
  };
}