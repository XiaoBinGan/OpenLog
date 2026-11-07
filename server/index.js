// .env 必须在其它 import 之前加载：ESM 会先求值所有 import，
// remote.js / docker.js 等在模块初始化阶段就会读 process.env
// （例如 OPENLOG_SECRET_KEY 决定 SSH 密码的加密密钥）。
// 旧写法在 import 之后才 dotenv.config()，那些模块拿到的是空值，
// 于是回退到源码内置密钥 —— .env 里的 OPENLOG_SECRET_KEY 形同虚设。
import 'dotenv/config';
import express from 'express';
import { errorMessage, isTransientNetworkError } from './errors.js';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import * as si from 'systeminformation';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as remote from './remote.js';
import { runAgent, classifyCommand, MAX_STEPS, MAX_STEPS_CAP, MAX_WALL_MS, MAX_WALL_CAP_MS } from './ai-shell.js';
import * as docker from './docker.js';
import { ContainerLogWatcher, detectSelfContainerId } from './container-log-watch.js';
import { parseLogLevel } from './log-level.js';
import { warnIfUnconfigured as warnIfHostGpuUnconfigured } from './gpu-host-ssh.js';
import { dedupeDisks } from './disk-utils.js';
import { applyPatrolResults } from './patrol-cache.js';
import gpuRouter from './routes/gpu.js';
import skillsRouter from './routes/skills.js';
import createMonitorRouter from './routes/monitor.js';
import createLogsRouter from './routes/logs.js';
import createAnalysisRouter from './routes/analysis.js';
import assistantMemoryRouter from './routes/assistant-memory.js';
import createModelsRouter from './routes/models.js';
import createDbRouter from './routes/db-info.js';
import createRemoteRouter from './routes/remote.js';
import { createStatsScheduler } from './stats-scheduler.js';
import { mapLimit } from './concurrency.js';
import createSettingsRouter, { SENSITIVE_KEYS } from './routes/settings.js';
import createDockerRouter from './routes/docker.js';
import createChatRouter from './routes/chat.js';
import { AGENT_TOOLS, AGENT_TOOL_NAMES, executeAgentTool } from './agent-tools.js';
import createAuthRouter from './routes/auth.js';
import { isLoopbackAddress } from './security/loopback.js';
import { migrateWatchSourceFields } from './settings-migrations.js';
import { initDb, getDb, getDbType, getDbInfo, getRawDb, getSqlitePath, getKv, setKv, insertLogRecord, getAlertConfig, closeDb, pruneOldRecords, checkpoint, ensureBuiltinSkills, isDbReady, setSlowQuerySink } from './db/index.js';
import { BUILTIN_SKILLS } from './default-skills.js';
import { resolveDockerTransport } from './docker-transport.js';
import { getRemoteMfu } from './gpu-mfu.js';
// ── 监控体系（接口指标 / 数据库采样 / 慢查询 / 依赖拨测 / 接口清单）──
// 全部可用 OPENLOG_METRICS=off 关闭；关掉时中间件与采样器直接旁路，面板显示「未启用」。
import { createRegistry } from './metrics/registry.js';
import { createApiMetricsMiddleware } from './metrics/api-middleware.js';
import { normalizeRoutePath, shouldSkipPath } from './metrics/route-pattern.js';
import { createApiStore } from './metrics/api-store.js';
import { createDbSampler } from './metrics/db-sampler.js';
import { createSlowQueryLog } from './metrics/slow-query.js';
import { createProbes } from './dependency-probe.js';
import { buildOpenApi, collectRoutes, renderDocsHtml } from './openapi.js';
import createDbMonitorRouter from './routes/db-monitor.js';
import createApiMonitorRouter from './routes/api-monitor.js';
import createOpenApiRouter from './routes/openapi.js';
import { createVerifyClient, createHandleProtocols, evaluateUpgradeRequest } from './ws-auth.js';
import { startMonitoring, stopMonitoring } from './monitoring.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 鉴权 ──────────────────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, '..', 'data', '.auth_token');
const AUTH_TOKEN = loadOrCreateToken();

function loadOrCreateToken() {
  if (process.env.OPENLOG_TOKEN) return process.env.OPENLOG_TOKEN;
  try {
    if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch {}
  return token;
}

// 生产模式鉴权提示：只提示令牌位置，不打印令牌本身。
// 远端浏览器访问时，前端会自动弹出「需要访问令牌」入口，输入这里的令牌即可。
if (process.env.NODE_ENV === 'production' && !process.env.OPENLOG_TOKEN) {
  console.log(`[Auth] 生产模式已启用鉴权；访问令牌在 ${TOKEN_FILE}（浏览器首次访问需输入）`);
}

// 判断是否为回环地址（仅开发模式下用于免鉴权）

// 时间安全比较 token：先用 SHA-256 对齐长度，再 timingSafeEqual
function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  if (!candidate || !expected) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function authMiddleware(req, res, next) {
  // 仅非生产环境允许回环地址免鉴权；生产环境始终要求有效 token
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (process.env.NODE_ENV !== 'production' && isLoopbackAddress(ip)) return next();
  const auth = req.headers.authorization;
  // 只接受 Authorization 头。不接受 ?token= —— query string 会进入浏览器历史、
  // Referer、代理与访问日志，等于把长期凭据写进各处日志。
  // WebSocket 升级请求无法自定义头，其 query token 在 upgrade 处理里单独校验。
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (tokenMatches(token, AUTH_TOKEN)) return next();
  res.status(401).json({ error: 'Unauthorized — 需要有效的访问令牌' });
}

// ─── Settings 敏感字段加密（文件落盘用）────────────────────
// 生产环境应从 OPENLOG_SECRET_KEY 读取；未设置时回退到源码内置派生（并给出唯一告警）
const SETTINGS_LEGACY_ENC_KEY = crypto.scryptSync('openlog-settings-salt-v2', 'openlog-settings', 32);
const SETTINGS_ENC_KEY = process.env.OPENLOG_SECRET_KEY
  ? crypto.scryptSync(process.env.OPENLOG_SECRET_KEY, 'openlog-settings-salt-v2', 32)
  : SETTINGS_LEGACY_ENC_KEY;
if (!process.env.OPENLOG_SECRET_KEY) {
  console.warn('⚠️  [安全] 未设置 OPENLOG_SECRET_KEY，正在使用源码内置的默认密钥加密存储的凭据（SSH 密码 / API Key）。请设置 OPENLOG_SECRET_KEY 环境变量。');
}

function encryptField(value) {
  if (!value) return value;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', SETTINGS_ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptField(value) {
  if (!value) return value;
  // 非加密格式直接返回（兼容旧数据）
  if (!value.includes(':')) return value;
  try {
    const [ivHex, authTagHex, cipherHex] = value.split(':');
    if (!ivHex || !authTagHex || !cipherHex) return value;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SETTINGS_ENC_KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch { return value; }
}

// Settings 持久化文件（在项目根目录，可用 OPENLOG_SETTINGS_PATH 覆盖以便测试隔离）
const SETTINGS_FILE = process.env.OPENLOG_SETTINGS_PATH
  || path.join(__dirname, '..', 'settings.json');

// 从 SQLite 加载 settings（数据库未初始化时回退到文件）
function loadSettings() {
  let db;
  try { db = getDb(); } catch {}

  // 优先从 DB 加载
  if (db) {
    try {
      const stored = getKv('app_settings');
      if (stored) {
        const migrated = migrateWatchSourceFields(stored);
        if (migrated !== stored) {
          // 只有确实改动了才写回，避免每次启动都无谓地写库
          try {
            setKv('app_settings', migrated);
            console.log('[Settings] 已迁移 watchSources 旧字段名（logPath→path, watchFiles→pattern）');
          } catch (e) {
            console.warn('[Settings] watchSources 迁移写回失败（不影响本次运行）:', errorMessage(e));
          }
        }
        return migrated;
      }
    } catch (e) {
      console.warn('[Settings] 从 DB 加载失败:', errorMessage(e));
    }
  }

  // 回退到文件
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const fileSettings = migrateWatchSourceFields(JSON.parse(raw));
      // 解密敏感字段
      for (const key of SENSITIVE_KEYS) {
        if (fileSettings[key]) fileSettings[key] = decryptField(fileSettings[key]);
      }
      // 自动迁移到 DB
      if (db) {
        try {
          setKv('app_settings', fileSettings);
          console.log('[Settings] 已迁移到 SQLite');
        } catch (e) {}
      }
      return fileSettings;
    }
  } catch (e2) {}
  return null;
}

// 保存 settings 到 SQLite
function saveSettings(data) {
  let db;
  try { db = getDb(); } catch {}

  if (db) {
    try {
      setKv('app_settings', data);
      // 刷新内存缓存，确保后续 ensureSettings() 返回最新值
      settings = { ...defaultSettings, ...data };
      return true;
    } catch (e) {
      console.warn('[Settings] 保存到 DB 失败:', errorMessage(e));
    }
  }

  // 回退到文件
  try {
    const fileData = { ...data };
    // 加密敏感字段
    for (const key of SENSITIVE_KEYS) {
      if (fileData[key]) fileData[key] = encryptField(fileData[key]);
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fileData, null, 2), 'utf8');
    // 刷新内存缓存
    settings = { ...defaultSettings, ...data };
    return true;
  } catch (e2) {
    console.error('[Settings] 保存到文件失败:', errorMessage(e2));
    return false;
  }
}

/** 监控运行时句柄（定时器/采样器），shutdown 时要停掉 */
let monitoringHandle = null;

/**
 * 启动监控体系。整体包在 try/catch 里 —— 监控是可选能力，
 * 任何一步失败都不能影响主服务启动（这是契约里写死的铁律）。
 */
async function startMonitoringSafe() {
  try {
    // 慢查询埋点：把 db 适配层每次调用的耗时交给 slowQueryLog 判阈值。
    // 必须在这里接上，否则「慢查询」面板永远是空的（一开始就漏了这一步，
    // 面板显示 0 条会让人以为「从来不慢」，实际是根本没人上报）。
    setSlowQuerySink((entry) => {
      // 指标表自身的写入不算业务慢查询：那是监控自己在干活，报出来只是噪音
      if (/api_metrics_minute|db_metric_sample|slow_query_log/i.test(entry.sql)) return;
      slowQueryLog.record({ sql: entry.sql, ms: entry.ms, source: entry.source });
    });

    monitoringHandle = await startMonitoring({
      registry: apiRegistry,
      createApiStore,
      createDbSampler,
      createProbes,
      slowQueryLog,
      db: () => { try { return getDb(); } catch { return null; } },
      dbType: () => { try { return getDbType(); } catch { return null; } },
      rawDb: () => { try { return getRawDb(); } catch { return null; } },
      sqlitePath: () => { try { return getSqlitePath(); } catch { return null; } },
      dbInfo: () => { try { return getDbInfo(); } catch { return null; } },
      enabled: metricsEnabled,
      selfUrl: `http://127.0.0.1:${PORT}`,
      probeTargets: buildProbeTargets(),
      fetchImpl: probeFetch,
    });
    apiStore = monitoringHandle.store;
    dbSampler = monitoringHandle.sampler;
    probes = monitoringHandle.probes;
    Object.assign(metricsState, monitoringHandle.state);
  } catch (err) {
    console.warn('[Metrics] 监控启动失败（不影响主服务）:', errorMessage(err));
  }
}

/**
 * 依赖拨测用的 fetch：给本机/LLM 的 HTTP 探测补上鉴权头。
 *
 * 为什么不在 createProbes 里做：那个模块是纯逻辑（IO 全注入、可单测），
 * 把「从哪拿 token」塞进去会污染它的可测性。token 的归属在这里。
 * 只对 http(s) 目标生效，exec 目标不受影响。
 */
function probeFetch(url, init = {}) {
  const headers = { ...(init.headers || {}) };
  try {
    if (/^https?:\/\//i.test(String(url))) {
      // 本机自检与内网引擎都可能要求鉴权；带上不会有害（对方的 /models 若不需要会忽略）
      headers.Authorization = `Bearer ${AUTH_TOKEN}`;
      const s = ensureSettings();
      if (s.openaiApiKey && String(url).startsWith(String(s.openaiBaseUrl || '').replace(/\/+$/, ''))) {
        headers.Authorization = `Bearer ${s.openaiApiKey}`;
      }
    }
  } catch { /* 设置读不到就只带内部 token */ }
  return fetch(url, { ...init, headers });
}

/**
 * 依赖拨测目标。
 *
 * **只放能真反映依赖健康的项，宁缺勿滥**：
 *   - LLM 引擎：挂了整个 AI 分析/助手全废，必须探（HTTP /models）
 *   - 自身 /api/health：算端到端可用性（probeSelf 单独做）
 *
 * 曾经想探 Docker 与 SSH，实测在容器里**两条都是永久误报**，所以拿掉了：
 *   - `docker` CLI 不存在（本项目用 dockerode 直连 socket，镜像里没装 CLI）→ spawn ENOENT
 *   - `ssh` CLI 无法用应用的凭据（密码在 node-ssh 里，CLI 要 sshpass/密钥，且远程禁密码登录）
 * 永久红灯比没有灯更糟 —— 用户会学会无视整个面板。
 * Docker 与 SSH 的真实连通性各自主页面就有明确展示（Docker 页的源报错、远程服务器卡片的状态）。
 */
function buildProbeTargets() {
  const targets = [];
  try {
    const s = ensureSettings();
    if (s.openaiBaseUrl) {
      targets.push({
        id: 'llm', kind: 'http',
        url: `${String(s.openaiBaseUrl).replace(/\/+$/, '')}/models`,
        timeoutMs: 3000,
      });
    }
  } catch { /* 设置读不到就跳过 */ }
  return targets;
}

// 初始化数据库（启动时调用）
async function initDatabase() {
  try {
    await initDb();
    console.log('[DB] 数据库初始化完成');
    ensureSettings();

    // 内置技能按 id 幂等补齐：新增的内置技能（如「应用部署与发布」）能进到已部署实例，
    // 而不是像以前那样因为「库里已有内置技能」被整体跳过。
    try {
      const { added, skipped } = await ensureBuiltinSkills(BUILTIN_SKILLS);
      if (added.length) console.log(`[Skills] 补入内置技能 ${added.length} 个: ${added.join('、')}`);
      else console.log(`[Skills] 内置技能齐全（${skipped} 个）`);
    } catch (err) {
      console.warn('[Skills] 内置技能补齐失败:', errorMessage(err));
    }

    await remote.loadServers();

    // ── 监控体系启动（失败只 warn，绝不影响主服务）──────────────────
    await startMonitoringSafe();
  } catch (err) {
    console.error('[DB] 初始化失败:', errorMessage(err));
    // 不退出进程（退出会让容器在 --restart 策略下无限重启、把真正的原因刷没），
    // 但把排查方向说清楚：API 层会用 503 明确告诉前端「数据库没就绪」。
    console.error('[DB] 排查方向: 1) OPENLOG_DB_TYPE/OPENLOG_DATABASE_URL 是否正确'
      + '（PG 密码必须与已有 openlog-pg 容器一致）2) 数据目录是否可写 3) 库服务是否在运行');
  }
}

const app = express();
const server = createServer(app);
/**
 * WebSocket 服务端。
 *
 * token 改走 `Sec-WebSocket-Protocol`（浏览器无法给 WS 设自定义头，以前只能用 `?token=`，
 * 那个位置会进反代日志/浏览器历史/Referer）：
 *   客户端发 `['openlog.v1', 'token.<token>']`，服务端只回显 `openlog.v1`。
 * `allowQueryFallback` 暂时保留 —— 老客户端（缓存里的旧 JS）仍然能用 `?token=` 连上，
 * 否则用户升级后刷新前会一直 401。灰度两版之后可以关掉。
 */
const wss = new WebSocketServer({
  noServer: true, // 关键：使用 noServer: true，避免自动处理升级
  verifyClient: createVerifyClient({ expectedToken: AUTH_TOKEN, allowQueryFallback: true }),
  handleProtocols: createHandleProtocols(), // 握手只回显 openlog.v1，绝不回 token 项
});

const PORT = process.env.PORT || 3011;
const HOST = process.env.HOST || '127.0.0.1';

// ─── 监控单例 ────────────────────────────────────────────────
// 为什么在模块顶层建：中间件要在 app.use 阶段就拿到 registry，不能等 initDatabase 之后。
// 为什么可关：OPENLOG_METRICS=off 时中间件直接旁路、采样器不启动，面板返回 {enabled:false}
// （用户反馈「监控不能变成负担」，所以开关必须是第一等公民）。
const METRICS_OFF = () => process.env.OPENLOG_METRICS === 'off';
const metricsEnabled = () => !METRICS_OFF();
/** 接口指标滑窗：1 小时（够看趋势，内存 ~13KB/路由 × 300 上限） */
const apiRegistry = createRegistry({ windowMs: 3_600_000 });
/** 埋点中间件：必须挂在限流/鉴权**之前**，否则 401/429 统计不到，错误率会失真 */
const apiMetricsMiddleware = createApiMetricsMiddleware({
  registry: apiRegistry,
  enabled: metricsEnabled,
  normalize: normalizeRoutePath,
  shouldSkip: shouldSkipPath,
});
/** 慢查询：阈值 200ms，环形缓冲 200 条（只存指纹，不存参数值） */
const slowQueryLog = createSlowQueryLog({ thresholdMs: 200, max: 200 });
/** 以下三个依赖 DB / 定时器，在 initDatabase() 成功后创建 */
let apiStore = null;
let dbSampler = null;
let probes = null;
/** 监控相关的定时器（shutdown 时必须清，否则进程不退） */
const metricsTimers = { flush: null, prune: null, probe: null };
const metricsState = { schemaReady: false, lastFlushAt: null, lastFlushRows: 0 };

// CORS 白名单：OPENLOG_ALLOWED_ORIGINS（逗号分隔）优先；未设置时仅允许 localhost/127.0.0.1 任意端口，
// 以及不带 Origin 头的请求（同源 / 非浏览器客户端）。
const ALLOWED_ORIGINS = (process.env.OPENLOG_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // 无 Origin 头
  if (ALLOWED_ORIGINS.length > 0) return ALLOWED_ORIGINS.includes(origin);
  try {
    // 注意：new URL('http://[::1]:3011').hostname 返回带方括号的 '[::1]'，
    // 只比较 '::1' 会让 IPv6 回环来源被误拒。
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1'
      || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 判断一个路径是否属于「必须返回 JSON」的后端命名空间（/api 与 /ws）。
 *
 * 两个用途：SPA 兜底放行，以及最后的 JSON 404。
 *
 * 必须写成 `p === '/api' || p.startsWith('/api/')` —— 只写 startsWith('/api/')
 * 会漏掉不带尾斜杠的 `/api` 与 `/ws`：它们匹配失败后掉进 SPA 兜底，
 * 返回一份 HTML 首页而不是 JSON。（实测确认过。）
 */
function isApiPath(p) {
  return p === '/api' || p.startsWith('/api/')
      || p === '/ws'  || p.startsWith('/ws/');
}

// Middleware
app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
}));
app.use(express.json({ limit: '10mb' }));

// 接口埋点：位置很关键 —— 必须在限流与鉴权之前，才能统计到 429/401；
// 但要在 express.json 之后（这里不改 body，只是习惯上把解析类中间件放前面）。
app.use(apiMetricsMiddleware);

// 生产模式：托管前端静态文件
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  // SPA fallback — 所有非 API 路由返回 index.html
  app.get('*', (req, res, next) => {
    if (isApiPath(req.path)) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// 简易 Rate Limiter（每 IP 每分钟 120 次）
const rateLimitMap = new Map();
app.use((req, res, next) => {
  const ip = (req.ip || req.connection?.remoteAddress || 'unknown').replace('::ffff:', '');
  // localhost 不限速（回环判定与鉴权旁路、发放令牌共用同一份）
  if (isLoopbackAddress(ip)) return next();
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + 60000; }
  record.count++;
  rateLimitMap.set(ip, record);
  if (record.count > 120) return res.status(429).json({ error: 'Too Many Requests' });
  next();
});

// 鉴权中间件（排除公开端点）
const PUBLIC_PATHS = ['/api/auth/token'];
app.use((req, res, next) => {
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
  authMiddleware(req, res, next);
});

// Token 获取端点（仅 localhost）
// Token 获取端点（仅 localhost）—— 已抽到 server/routes/auth.js
app.use(createAuthRouter({ authToken: AUTH_TOKEN }));

/**
 * 数据库就绪闸门。
 *
 * 背景：initDb() 失败（最常见是 PG 密码与 openlog-pg 容器不一致）时进程**不退出**，
 * 但 db 是 null。以前所有 DB 路由都会抛
 * `Cannot read properties of null (reading 'all' / 'run' / 'get')` ——
 * 前端只显示这句英文 TypeError（技能管理页尤其明显），用户根本看不出是数据库没连上。
 *
 * 这里统一挡掉：返回 503 + 中文原因。放行两个端点：
 *   /api/auth/token  —— 浏览器登录用，不依赖 DB
 *   /api/db/info     —— 健康检查/排障用，它自己会说明数据库状态
 */
const DB_FREE_PATHS = ['/api/auth/token', '/api/db/info', '/api/health'];

/**
 * 极轻健康检查：GET /api/health
 *
 * 用途只有一个 —— 给「端到端拨测」一个稳定的靶子（依赖拨测每 30s 打一次，
 * 要能算出可用性百分比）。所以这里**不查库、不查 Docker、不读盘**，
 * 只回进程自身的状态，保证它永远不会因为下游故障而 503（那会让 uptime 失真）。
 *
 * 注意：它不伪装数据库健康 —— 真实库状态看 `dbReady` 字段与 /api/db/info。
 */
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    dbReady: (() => { try { return isDbReady(); } catch { return false; } })(),
    metricsEnabled: metricsEnabled(),
    timestamp: new Date().toISOString(),
  });
});

app.use((req, res, next) => {
  if (!isApiPath(req.path)) return next();
  if (DB_FREE_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (!isDbReady()) {
    return res.status(503).json({
      error: '数据库未就绪：服务启动时数据库初始化失败。请检查 OPENLOG_DB_TYPE / OPENLOG_DATABASE_URL'
        + '（PostgreSQL 密码要与 openlog-pg 容器一致）或数据目录写权限，修正后重启容器。',
      dbReady: false,
    });
  }
  next();
});

// 默认 settings
// 环境变量只作为「首次启动、数据库尚无配置」时的默认值：ensureSettings() 用
// { ...defaultSettings, ...saved } 合并，已有配置不会被覆盖 —— 这正是
// docker-compose / .env.example 所承诺的语义（此前这些变量写了但服务端从不读取）。
const DEFAULT_LOG_PATH = process.env.LOG_PATH || path.join(os.homedir(), 'logs');
const defaultSettings = {
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1',
  model: process.env.MODEL || 'qwen3.5:9b',
  logPath: DEFAULT_LOG_PATH,
  watchFiles: '*.log',
  refreshInterval: '5000',
  autoAnalysis: true,
  thinkingEnabled: false,
  // 日志持久化配置
  logPersistence: false,                          // 是否持久化到数据库
  logPersistenceLevels: ['ERROR', 'FATAL', 'WARN'], // 持久化的日志等级
  logPersistenceMaxAge: 7,                        // 持久化日志保留天数
  watchSources: [
    {
      id: 'default',
      name: '默认服务',
      path: DEFAULT_LOG_PATH,
      pattern: '*.log',
      enabled: true,
      autoAnalysis: true
    }
  ],
  dockerSources: [
    {
      id: 'local',
      name: '本地 Docker',
      socketPath: '/var/run/docker.sock',
      host: 'localhost',
      port: 2375,
      tls: false,
      enabled: false,
      autoAnalysis: true,
      projects: []
    }
  ],
  // 容器异常退出通知
  dockerEventNotify: true,
  // 容器日志定时巡检（默认开启：容器打 ERROR 就要能看到，不能要求用户先去设置里打开）
  containerPatrolEnabled: true,
  containerPatrolInterval: '300000',  // ms，默认 5 分钟
  containerPatrolLevels: ['ERROR', 'FATAL', 'WARN'],
  // 容器日志实时错误提醒（增量 tail，命中 ERROR/FATAL 立即弹框）
  containerLogWatchEnabled: true,
  containerLogWatchInterval: 5000,    // ms，实时轮询间隔
  // 运维助手上下文配置（默认值与 server/routes/context-config.js 保持一致）
  // 为什么要落到设置里：原先只能靠环境变量，改一次要重启容器，界面上也看不到用量。
  assistantContext: {
    windowTokens: Number(process.env.OPENLOG_ASSISTANT_CONTEXT_WINDOW) || 65536,
    budgetTokens: Number(process.env.OPENLOG_ASSISTANT_CONTEXT_TOKENS) || 48000,
    maxOutputTokens: Number(process.env.OPENLOG_ASSISTANT_MAX_OUTPUT_TOKENS) || 4096,
    autoCompact: true,
    compactAt: 0.85,
    warnAt: 0.7,
    maxRounds: Number(process.env.OPENLOG_ASSISTANT_MAX_ROUNDS) || 30,
    maxWallMs: Number(process.env.OPENLOG_ASSISTANT_MAX_WALL_MS) || 10 * 60 * 1000,
    toolResultChars: Number(process.env.OPENLOG_ASSISTANT_TOOL_RESULT_CHARS) || 6000,
  },
};

// Settings - 懒加载，数据库初始化完成后加载
let settings = null;

function ensureSettings() {
  if (!settings) {
    const saved = loadSettings();
    if (saved) {
      // 合并默认值：新字段用默认值，已有字段保持不变
      settings = { ...defaultSettings, ...saved };
    } else {
      settings = defaultSettings;
    }
  }
  return settings;
}

// 🧠 过滤 <think/> 标签：非流式响应直接替换
function stripThinking(text) {
  if (ensureSettings().thinkingEnabled) return text;
  // 匹配 <think&gt;...</think&gt;（支持多行、贪婪匹配最外层）
  return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/g, '').trim();
}


// WebSocket connections
const wsClients = new Set();

// Logs storage
const logs = [];

// WebSocket 连接处理 - 仅处理来自 upgrade 的连接
// 注意：不要使用 wss.on('connection')，因为我们在 server.on('upgrade') 中处理

// Broadcast to all clients
function broadcast(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// ============================================================
// 多源日志监控
// ============================================================
const watchers = new Map(); // sourceId -> chokidar watcher

// 文件偏移量记录（每个文件的已读字节位置）
const fileOffsets = new Map(); // filePath -> lastReadBytes

function readLastLine(filePath, sourceId) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const lastPos = fileOffsets.get(filePath) ?? 0;

    // 文件被轮转（变小了），从头开始读
    if (size < lastPos) {
      fileOffsets.set(filePath, 0);
    }

    if (size === lastPos) return null; // 无新内容

    // 读取新增内容（从上次位置到文件末尾）
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(size - lastPos, 512 * 1024)); // 最多 512KB
    fs.readSync(fd, buf, 0, buf.length, lastPos);
    fs.closeSync(fd);
    fileOffsets.set(filePath, size);

    const content = buf.toString('utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    // 返回最后一行（以及所有新行用于记录）
    const lastLine = lines[lines.length - 1];
    return { lastLine, sourceId };
  } catch (err) {
    console.error(`[${sourceId}] Read error: ${errorMessage(err)}`);
    return null;
  }
}

function startLogWatcher() {
  // 关闭所有旧 watcher
  watchers.forEach(w => w.close());
  watchers.clear();
  fileOffsets.clear();

  const sources = ensureSettings().watchSources || [];

  if (sources.length === 0) {
    // 兼容旧配置
    const single = {
      id: 'default',
      name: '默认服务',
      path: ensureSettings().logPath || path.join(os.homedir(), 'logs'),
      pattern: ensureSettings().watchFiles || '*.log',
      enabled: true,
      autoAnalysis: ensureSettings().autoAnalysis ?? true
    };
    startSourceWatcher(single);
    return;
  }

  sources.forEach(source => {
    if (!source.enabled) {
      console.log(`[${source.id}] 跳过（已禁用）`);
      return;
    }
    startSourceWatcher(source);
  });
}

function startSourceWatcher(source) {
  const logDir = source.path;
  const pattern = source.pattern || '*.log';

  // 目录没配置时直接跳过，并说清楚原因。
  // 原实现不校验就往下走：existsSync(undefined) 返回 false，于是
  // mkdirSync(undefined) 抛出 "The path argument must be of type string"，
  // 用户看到的是一句和配置毫无关系的底层报错。（触发原因见 migrateWatchSourceFields）
  if (typeof logDir !== 'string' || logDir.trim() === '') {
    console.error(`[${source.id}] 跳过日志源「${source.name || source.id}」：未配置日志目录（path / logPath 均为空）`);
    return;
  }

  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      console.log(`[${source.id}] Created directory: ${logDir}`);
    } catch (err) {
      console.error(`[${source.id}] Failed to create directory: ${errorMessage(err)}`);
      return;
    }
  }

  try {
    const watcher = chokidar.watch(path.join(logDir, pattern), {
      persistent: true,
      ignoreInitial: false  // 初始也扫描（用于记录偏移量）
    });

    watcher.on('add', (filePath) => {
      console.log(`[${source.id}] 📄 监听: ${path.basename(filePath)}`);
      fileOffsets.set(filePath, 0);
    });

    watcher.on('change', (filePath) => {
      const result = readLastLine(filePath, source.id);
      if (!result || !result.lastLine) return;

      const logEntry = parseLogLine(result.lastLine, `${source.name}/${path.basename(filePath)}`);
      logEntry.sourceId = source.id;
      saveLog(logEntry, source);
      broadcast({ type: 'log', data: logEntry });
    });

    watcher.on('error', (err) => {
      console.error(`[${source.id}] Watcher error: ${errorMessage(err)}`);
    });

    watchers.set(source.id, watcher);
    console.log(`[${source.id}] 🚀 开始监听: ${logDir} (${pattern})`);
  } catch (err) {
    console.error(`[${source.id}] Failed to start watcher: ${errorMessage(err)}`);
  }
}

// 停止指定服务监控
function stopSourceWatcher(sourceId) {
  const w = watchers.get(sourceId);
  if (w) {
    w.close();
    watchers.delete(sourceId);
    console.log(`[${sourceId}] 已停止`);
  }
}

function parseLogLine(line, source) {
  const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
  const levelMatch = line.match(/\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/i);
  
  return {
    id: uuidv4(),
    timestamp: timestampMatch ? timestampMatch[1] : new Date().toISOString(),
    level: levelMatch ? levelMatch[1].toUpperCase() : 'INFO',
    message: line,
    source: source,
    metadata: JSON.stringify({ raw: line })
  };
}

// 多任务分析队列：每个服务（sourceId）独立队列
const analysisQueues = new Map(); // sourceId -> { running: bool, pending: [] }
const analysisDebounce = new Map(); // key -> timestamp
const DEBOUNCE_MS = 30_000;

// 分析历史记录（内存存储，最多 500 条）
const analysisHistory = [];
const MAX_ANALYSIS_HISTORY = 500;

/** 添加分析记录（自动去重相同类型+名称 5 秒内的重复条目） */
function addAnalysisRecord(record) {
  const existing = analysisHistory.find(r =>
    r.type === record.type &&
    r.sourceName === record.sourceName &&
    r.status === record.status &&
    Math.abs(new Date(r.timestamp).getTime() - new Date(record.timestamp || Date.now()).getTime()) < 5000
  );
  if (existing) return; // 跳过重复
  analysisHistory.unshift(record);
  if (analysisHistory.length > MAX_ANALYSIS_HISTORY) analysisHistory.pop();
}

function getQueue(sourceId) {
  if (!analysisQueues.has(sourceId)) {
    analysisQueues.set(sourceId, { running: false, pending: [] });
  }
  return analysisQueues.get(sourceId);
}

function processQueue(sourceId) {
  const q = getQueue(sourceId);
  if (q.running || q.pending.length === 0) return;
  q.running = true;

  const { log, source } = q.pending.shift();
  runAnalysis(log, source).finally(() => {
    q.running = false;
    processQueue(sourceId); // 继续处理下一个
  });
}

function saveLog(log, source = null) {
  logs.unshift(log);

  // Keep only last 10000 logs
  if (logs.length > 10000) {
    logs.pop();
  }

  // 🚀 日志持久化到数据库（可选）
  const settings = ensureSettings();
  if (settings.logPersistence) {
    const levels = settings.logPersistenceLevels || ['ERROR', 'FATAL', 'WARN'];
    if (levels.includes(log.level)) {
      try {
        insertLogRecord({
          id: log.id || uuidv4(),
          machine_id: source?.id || 'default',
          source_type: 'file',
          source_name: source?.name || log.source || 'unknown',
          content: log.message || log.raw || '',
          severity: (log.level || 'info').toLowerCase(),
          timestamp: log.timestamp ? Math.floor(new Date(log.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000),
          parsed: log,
        })?.catch?.((err) => console.warn('[DB] 日志持久化失败:', errorMessage(err)));
      } catch (err) {
        console.warn('[DB] 日志持久化失败:', errorMessage(err));
      }
    }
  }

  // 🚀 主动分析：ERROR/FATAL 日志出现时加入分析队列
  const autoAnalysisEnabled = settings.autoAnalysis && (source?.autoAnalysis ?? true);
  if ((log.level === 'ERROR' || log.level === 'FATAL') && autoAnalysisEnabled) {
    enqueueAnalysis(log, source);
  }
}

function enqueueAnalysis(log, source) {
  const sourceId = source?.id || 'default';
  const q = getQueue(sourceId);

  // 防抖：同类错误 30s 内不重复
  const key = `${sourceId}:${log.message.slice(0, 120)}`;
  const now = Date.now();
  if (analysisDebounce.has(key)) {
    const last = analysisDebounce.get(key);
    if (now - last < DEBOUNCE_MS) {
      console.log(`[${sourceId}] ⏭️ 防抖跳过: ${log.message.slice(0, 60)}`);
      return;
    }
  }
  analysisDebounce.set(key, now);

  q.pending.push({ log, source });
  console.log(`[${sourceId}] 📋 加入分析队列 (待处理: ${q.pending.length})`);
  processQueue(sourceId);
}

async function runAnalysis(errorLog, source) {
  const sourceId = source?.id || 'default';
  console.log(`[${sourceId}] 🤖 开始分析: ${errorLog.message.slice(0, 80)}`);

  const apiKey = ensureSettings().openaiApiKey;
  const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';
  const model = ensureSettings().model;
  const isLocalModel = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0');

  if (!apiKey && !isLocalModel) {
    broadcast({
      type: 'ai_analysis',
      status: 'skipped',
      message: '未配置 LLM，无法自动分析。请在设置页面配置 API Key。',
      log: errorLog,
      sourceId
    });
    return;
  }
  if (!model) {
    broadcast({
      type: 'ai_analysis',
      status: 'skipped',
      message: '未配置 LLM 模型，无法自动分析。',
      log: errorLog,
      sourceId
    });
    return;
  }

  // 通知前端：分析开始
  console.log(`[${sourceId}] 📡 调用 LLM: ${model}`);
  broadcast({ type: 'ai_analysis', status: 'pending', log: errorLog, sourceId });

  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: apiKey || 'ollama', baseURL: baseUrl });

    const prompt = `你是一个专业的运维工程师。请分析以下错误日志，找出根因并给出简洁的修复建议。

错误日志：
[${errorLog.timestamp}] [${errorLog.level}] ${errorLog.message}
来源: ${errorLog.source}

请用以下格式回复（Markdown）：
## 🔍 根因分析
[一句话说明最可能的根因]

## 💡 修复建议
1. [具体可操作的修复步骤]
2. [...]

回复语言与日志一致（中文日志用中文）。`;

    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      timeout: 60_000
    });

    const analysis = stripThinking(response.choices[0].message.content);
    console.log(`[${sourceId}] ✅ 分析完成`);

    // 存入历史
    const record = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      sourceId,
      sourceName: source?.name || sourceId,
      log: errorLog,
      analysis,
      status: 'done',
      model
    };
    addAnalysisRecord(record);

    broadcast({
      type: 'ai_analysis',
      status: 'done',
      log: errorLog,
      sourceId,
      analysis,
      recordId: record.id
    });
  } catch (err) {
    console.error(`[${sourceId}] 分析失败: ${errorMessage(err)}`);

    // 存入历史
    const record = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      sourceId,
      sourceName: source?.name || sourceId,
      log: errorLog,
      analysis: null,
      status: 'error',
      error: errorMessage(err),
      model
    };
    addAnalysisRecord(record);

    broadcast({
      type: 'ai_analysis',
      status: 'error',
      message: `分析失败: ${errorMessage(err)}`,
      log: errorLog,
      sourceId,
      recordId: record.id
    });
  }
}

// System monitoring
let monitorInterval = null;
const monitorHistory = [];

function startMonitor() {
  const interval = parseInt(ensureSettings().refreshInterval || '5000');
  
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }
  
  monitorInterval = setInterval(async () => {
    try {
      const [cpu, mem, disks, network] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.networkStats()
      ]);
      
      const stats = {
        timestamp: new Date().toISOString(),
        cpu: cpu.currentLoad || 0,
        memory: mem.total > 0 ? (mem.used / mem.total) * 100 : 0,
        disk: disks.map(d => ({
          name: d.mount,
          used: d.used,
          total: d.size,
          usePercent: d.use
        })),
        network: network[0] ? network[0].rx_sec + network[0].tx_sec : 0,
        gpuUtil: 0, // populated separately if nvidia-smi available
      };
      
      monitorHistory.unshift(stats);
      
      // Keep only last 1000 entries
      if (monitorHistory.length > 1000) {
        monitorHistory.pop();
      }
      
      broadcast({ type: 'monitor', data: stats });
    } catch (err) {
      console.error('Monitor error:', err);
    }
  }, interval);
}

// ─── Docker 事件监听（容器异常退出推送）─────────────────
let dockerEventStarted = false;

function startDockerEventWatch() {
  const enabled = ensureSettings().dockerEventNotify !== false;
  const sources = ensureSettings().dockerSources || [];

  if (!enabled || dockerEventStarted) return;
  dockerEventStarted = true;

  for (const src of sources) {
    docker.startEventWatcher(src.id, src, (event) => {
      broadcast(event);
    });
  }
}

function restartDockerEventWatch() {
  docker.stopAllEventWatchers();
  dockerEventStarted = false;
  startDockerEventWatch();
}

// ─── 容器日志定时巡检 ────────────────────────────────────
let patrolTimer = null;
let lastPatrolResults = [];
// routes/docker.js 与本文件的巡检定时器共同读写这一份结果，故以访问器暴露
function getLastPatrolResults() { return lastPatrolResults; }
function setLastPatrolResults(v) { lastPatrolResults = v; }

// ─── 告警 Webhook 冷却状态 ───────────────────────────────
const alertCooldowns = new Map(); // key: "machineId_containerName_errorSig", value: timestamp

function startContainerPatrol() {
  if (patrolTimer) clearInterval(patrolTimer);

  const enabled = ensureSettings().containerPatrolEnabled;
  if (!enabled) return;

  const interval = parseInt(ensureSettings().containerPatrolInterval || '300000');
  const levels = ensureSettings().containerPatrolLevels || ['ERROR', 'FATAL'];
  const sources = ensureSettings().dockerSources || [];

  // 立即执行一次
  runPatrol(sources, levels);

  patrolTimer = setInterval(() => {
    runPatrol(sources, levels);
  }, interval);

  console.log(`[Patrol] 容器日志巡检已启动 (间隔: ${interval / 1000}s, 等级: ${levels.join(',')})`);
}

// 为远程 Docker 源构建 hostExec 回调
function buildHostExecMap() {
  const remoteServers = remote.getServers();
  const map = new Map();
  for (const rs of remoteServers) {
    if (rs.status === 'connected' || rs.status === 'online') { // 'online' 是历史值，实际状态为 'connected'
      map.set(rs.host, async (cmd) => {
        try {
          return await remote.execShellCommand(rs.id, cmd, 10000);
        } catch { return { stdout: '', stderr: 'ssh failed' }; }
      });
    }
  }
  return map;
}

async function runPatrol(sources, levels) {
  try {
    const hostExecMap = buildHostExecMap();
    const hostExecForSource = (src) => hostExecMap.get(src.host) || null;

    const results = await docker.patrolContainerLogs(sources, levels, hostExecForSource);
    // 巡检成功就整体覆盖缓存（空结果也覆盖）——否则问题修好后旧异常会一直留在
    // 缓存里，/api/docker/patrol/last、健康诊断、通知列表会报已经不存在的异常。
    // 巡检失败走 catch，opts.succeeded=false 时保留旧数据。
    lastPatrolResults = applyPatrolResults(lastPatrolResults, results);
    for (const result of results) {
      processAlertForResult(result);
    }
    if (results.length > 0) {
      broadcast({ type: 'container_patrol', data: { results, timestamp: new Date().toISOString() } });
    }
  } catch (err) {
    console.error('[Patrol] 巡检异常:', errorMessage(err));
  }
}

// ─── 告警 Webhook 发送逻辑 ─────────────────────────────────

/** 规范化错误签名用于冷却键 */
export function normalizeAlertSig(line) {
  return (line || '')
    .replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\w+\s+\d{4}\s*-\s*/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*\s*-?\s*/i, '')
    .replace(/req_[a-f0-9]+/gi, 'req_XXX')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
    .trim()
    .slice(0, 120);
}

/** 匹配关键词 patterns（逗号分隔，如 "ERROR,FATAL,Exception"）*/
export function matchAlertPatterns(content, patterns) {
  if (!patterns) return true;
  const keywords = patterns.split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
  if (keywords.length === 0) return true;
  const upperContent = (content || '').toUpperCase();
  return keywords.some(kw => upperContent.includes(kw));
}

/** 匹配 severity_filter（逗号分隔，如 "ERROR,FATAL"）*/
export function matchesSeverityFilter(lineLevel, severityFilter) {
  if (!severityFilter) return true;
  const levels = severityFilter.split(',').map(l => l.trim().toUpperCase()).filter(Boolean);
  if (levels.length === 0) return true;
  const lvl = (lineLevel || 'INFO').toUpperCase();
  return levels.includes(lvl);
}

/** 处理单个巡检结果的告警通知 */
async function processAlertForResult(result) {
  try {
    const config = await getAlertConfig(result.sourceId);
    if (!config || !config.enabled) return;

    if (!config.webhook_url) {
      return; // 未配置 webhook，静默跳过
    }

    const patterns = config.patterns || '';
    const severityFilter = config.severity_filter || '';
    const cooldownMinutes = config.cooldown_minutes || 5;

    // 按 patterns 和 severity_filter 过滤日志行
    const matchedLines = result.lines.filter(line => {
      const content = line.content || line.line || '';
      if (!matchAlertPatterns(content, patterns)) return false;
      if (!matchesSeverityFilter(line.level, severityFilter)) return false;
      return true;
    });

    if (matchedLines.length === 0) return;

    // 冷却时间控制
    const now = Date.now();
    const cooldownMs = cooldownMinutes * 60 * 1000;
    const newErrors = [];

    for (const line of matchedLines) {
      const errorSig = normalizeAlertSig(line.content || line.line || '');
      const cooldownKey = `${result.sourceId}_${result.containerName}_${errorSig}`;
      const lastSent = alertCooldowns.get(cooldownKey);
      if (lastSent && (now - lastSent) < cooldownMs) continue;
      alertCooldowns.set(cooldownKey, now);
      newErrors.push(line);
    }

    if (newErrors.length === 0) return;

    // 构建 webhook payload
    const payload = {
      text: `🔴 容器日志告警 — ${result.sourceName}/${result.containerName}`,
      server: result.sourceName,
      container: result.containerName,
      image: result.image,
      errors: newErrors.map(l => ({
        level: l.level,
        content: l.content || l.line,
        timestamp: l.timestamp,
      })),
      time: new Date().toISOString(),
    };

    // 发送 POST 到 webhook_url
    console.log(`[Alert] 发送 Webhook 到 ${config.webhook_url} (${newErrors.length}/${matchedLines.length} 条异常)`);
    const response = await fetch(config.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000), // 10s 超时
    });

    if (!response.ok) {
      console.error(`[Alert] Webhook 发送失败: HTTP ${response.status} ${response.statusText}`);
    } else {
      console.log(`[Alert] ✅ Webhook 发送成功 (${newErrors.length} 条通知到 ${result.sourceName}/${result.containerName})`);
    }
  } catch (err) {
    console.error(`[Alert] 处理告警异常 (${result.sourceName}/${result.containerName}):`, errorMessage(err));
  }
}

function restartContainerPatrol() {
  if (patrolTimer) clearInterval(patrolTimer);
  docker.resetPatrolCheckpoints();
  startContainerPatrol();
}

// ─── 容器日志实时错误监听 ────────────────────────────────
// 巡检是「每 5 分钟扫一次」，页面上看不到即时反馈。这里补上实时那一半：
// 按 5s 增量 tail 运行中容器的日志，命中 ERROR/FATAL 立刻广播 → 前端弹 toast。
let containerLogWatcher = null;

function createContainerLogWatcher() {
  // 跳过 OpenLog 自身容器：它自己的告警日志里带 [ERROR] 字样，监听自己会自激放大
  const selfId = detectSelfContainerId();
  return new ContainerLogWatcher({
    listRunningSources: async () => {
      const sources = await docker.listRunningContainersBySource(ensureSettings().dockerSources || []);
      if (!selfId) return sources;
      return sources.map(s => ({
        ...s,
        containers: s.containers.filter(c => !c.id.startsWith(selfId.slice(0, 12))),
      })).filter(s => s.containers.length > 0);
    },
    fetchLogs: (source, container, sinceSec) =>
      docker.getContainerLogsSince(source.sourceId, source.config, container.id, sinceSec),
    onAlert: (alert) => {
      broadcast({ type: 'container_log_alert', data: alert });
      console.log(`[LogWatch] ⚠️ ${alert.containerName} [${alert.level}] ${String(alert.content).slice(0, 120)}`);
    },
    onError: (msg) => console.warn(`[LogWatch] ${msg}`),
    intervalMs: Number(ensureSettings().containerLogWatchInterval) || 5000,
    // 实时提醒只看 ERROR/FATAL：WARN 太吵，交给定时巡检的等级配置
    levels: ensureSettings().containerLogWatchLevels || ['ERROR', 'FATAL'],
  });
}

function startContainerLogWatch() {
  stopContainerLogWatch();
  if (ensureSettings().containerLogWatchEnabled === false) {
    console.log('[LogWatch] 容器日志实时错误提醒已关闭');
    return;
  }
  containerLogWatcher = createContainerLogWatcher();
  containerLogWatcher.start();
  console.log(`[LogWatch] 容器日志实时错误提醒已启动 (间隔 ${containerLogWatcher.intervalMs / 1000}s)`);
}

function stopContainerLogWatch() {
  if (containerLogWatcher) {
    containerLogWatcher.stop();
    containerLogWatcher = null;
  }
}

function restartContainerLogWatch() {
  startContainerLogWatch();
}

// API Routes

// ─── 日志路由（已抽到 server/routes/logs.js）──────────────────────────────
// logs 是下方的实时日志缓冲，ensureSettings 是配置读取，均通过工厂注入
app.use(createLogsRouter({ logs, ensureSettings, saveLog, broadcast }));



// ─── 系统监控路由（已抽到 server/routes/monitor.js）────────────────────────
// monitorHistory 由下方 startMonitor() 的定时器写入，这里通过工厂注入
app.use(createMonitorRouter({ monitorHistory }));

// ─── 接口 / 数据库监控路由（依赖在 initDatabase 里创建的实例）──────────────
// 两个 router 内部都做了「依赖为 null → 返回可用性标记而不是 500」的降级，
// 所以数据库没就绪时它们只会说「不可用」，不会把整个服务拖垮。
//
// 为什么要 lazy：apiStore / dbSampler / probes 是 `initDatabase()` 之后才创建的，
// 如果在这里直接传值，工厂函数会把 null 捕进闭包，之后永远是 null。
// 用「首次请求时才建 router」的包装层，既保住 app.use 顺序，又拿到真实实例。
const lazyRouter = (factory, depsFn) => {
  let router = null;
  return (req, res, next) => {
    if (!router) {
      try { router = factory(depsFn()); } catch (err) {
        console.warn('[Metrics] 监控路由创建失败:', errorMessage(err));
        return res.json({ enabled: false, unavailable: ['监控路由创建失败'] });
      }
    }
    return router(req, res, next);
  };
};

app.use(lazyRouter(createDbMonitorRouter, () => ({
  sampler: dbSampler,
  store: apiStore,
  slowQueryLog,
  dbInfo: getDbInfo,
  db: (() => { try { return getDb(); } catch { return null; } })(),
  slowQueryThresholdMs: 200,
  enabled: metricsEnabled,
})));
// OpenAPI 文档：会暴露全部内部接口名（含 /api/remote/servers/:id/shell 这类高危接口），
// 因此必须留在鉴权之后，绝不放进 PUBLIC_PATHS。
app.use(createOpenApiRouter({
  spec: () => buildOpenApi(app, { title: 'OpenLog API', version: '1.0.0', serverUrl: '/' }),
  renderDocsHtml,
  collectRoutes: () => collectRoutes(app),
}));

// 接口指标 / 覆盖率 / 告警规则 / 依赖拨测 / 总览状态
app.use(lazyRouter(createApiMonitorRouter, () => ({
  registry: apiRegistry,
  store: apiStore,
  probes,
  collectRoutes: (a) => collectRoutes(a || app),
  app,
  enabled: metricsEnabled,
  dropped: apiMetricsMiddleware, // 埋点自身的丢弃计数挂在这个中间件实例上
  lastFlushAt: () => metricsState.lastFlushAt,
})));

// ============================================================
// 配置读写 —— 已抽到 server/routes/settings.js
// ============================================================
app.use(createSettingsRouter({
  ensureSettings, saveSettings, startLogWatcher,
  restartDockerEventWatch, restartContainerPatrol, restartContainerLogWatch, startMonitor,
}));

// ============================================================
// 自定义技能 (Skills) / 机器列表 / 告警配置 —— 已抽到 server/routes/skills.js
// ============================================================
app.use(skillsRouter);

// ============================================================
// 日志分析状态 API —— 已抽到 server/routes/analysis.js
// ============================================================
app.use(createAnalysisRouter({ analysisQueues, analysisHistory, enqueueAnalysis }));

// ============================================================
// 运维助手知识库 —— 已抽到 server/routes/assistant-memory.js
// ============================================================
app.use(assistantMemoryRouter);

// ============================================================
// 可用模型列表 —— 已抽到 server/routes/models.js
// ============================================================
app.use(createModelsRouter({ ensureSettings }));

// 数据库健康检查：GET /api/db/info（类型 / 连接池水位 / 探活延迟 / 存储占用）
app.use(createDbRouter());

// ============================================================
// LLM 助手聊天 API（流式 SSE）
// ============================================================

function buildAssistantContext() {
  if (lastPatrolResults.length > 0) {
    const lines = lastPatrolResults.slice(0, 3).map(r => `${r.containerName}: ${r.uniqueCount || r.matchCount}种异常`).join(', ');
    return `巡检: ${lines}`;
  }
  return '暂无。';
}


const DANGEROUS_TOOLS = new Set(['docker_start', 'docker_stop', 'docker_restart', 'docker_exec', 'remote_exec']);

/** 确保远程服务器已连接（agent 工具执行前调用） */
async function ensureRemoteConnected(serverId) {
  const s = remote.getServers().find(x => x.id === serverId);
  if (!s) throw new Error(`服务器 ${serverId} 未找到`);
  // ⚠️ 不能只看 status：状态可能是 'connected' 但连接池里的连接已被 LRU 回收 /
  // 被网络中断掉，此时 status 仍是 connected，工具却会报「服务器未连接」。
  // ensureSshConnection 会校验连接对象并（必要时）按需重连。
  await remote.ensureSshConnection(serverId);
}

/** 执行工具调用，返回结果对象
 *
 * @param {string} name 工具名
 * @param {object} args 工具参数
 * @param {{onOutput?: (stream:'stdout'|'stderr', chunk:string) => void}} [hooks]
 *   流式输出钩子：exec 类工具边跑边把输出推给前端（模型侧仍只拿最终结果）
 */
async function executeAssistantTool(name, args, hooks = {}) {
  const settings = ensureSettings();
  const dockerSources = settings.dockerSources || [];

  // agent 工具（读写远程代码/配置）：统一走 agent-tools.js
  if (AGENT_TOOL_NAMES.has(name)) {
    return executeAgentTool(name, args, {
      ensureConnected: ensureRemoteConnected,
      // 有流式钩子就边跑边推，前端能像终端一样看到输出；没有就退回一次性执行
      exec: hooks.onOutput
        ? (serverId, command) => remote.execRemoteCommandStream(serverId, command, {
            onStdout: (chunk) => hooks.onOutput('stdout', chunk),
            onStderr: (chunk) => hooks.onOutput('stderr', chunk),
          })
        : (serverId, command) => remote.execRemoteCommand(serverId, command),
    });
  }

  // 辅助：根据 sourceId 获取 Docker 配置
  const getDockerConfig = async (sourceId) => {
    const src = sourceId ? dockerSources.find(s => s.id === sourceId) : dockerSources.find(s => s.enabled);
    if (!src) throw new Error('未找到可用的 Docker 源');
    return { sourceId: src.id, config: await resolveDockerTransport(src) };
  };

  try {
    switch (name) {
      // ── Docker ──
      case 'docker_list': {
        if (args.sourceId) {
          const { sourceId, config } = await getDockerConfig(args.sourceId);
          const containers = await docker.listContainers(sourceId, config);
          return { containers, sourceId, total: containers.length };
        }
        const all = [];
        for (const src of dockerSources.filter(s => s.enabled)) {
          try {
            const config = await resolveDockerTransport(src);
            const containers = await docker.listContainers(src.id, config);
            all.push({ sourceId: src.id, sourceName: src.name, containers });
          } catch (e) { all.push({ sourceId: src.id, sourceName: src.name, error: errorMessage(e), containers: [] }); }
        }
        return { sources: all, totalSources: all.length };
      }
      case 'docker_logs': {
        const dc = await getDockerConfig(args.sourceId);
        const logs = await docker.getContainerLogs(dc.sourceId, args.containerId, dc.config, { tail: args.tail || 200 });
        const logLines = (logs || []).slice(-(args.tail || 200));
        return { containerId: args.containerId, totalLines: logLines.length, logs: logLines };
      }
      case 'docker_inspect': {
        const dc = await getDockerConfig(args.sourceId);
        const containers = await docker.listContainers(dc.sourceId, dc.config);
        const c = containers.find(x => x.id === args.containerId || x.shortId === args.containerId || (x.names || []).some(n => n.includes(args.containerId)));
        if (!c) return { error: `容器 ${args.containerId} 未找到` };
        return { container: c };
      }
      case 'docker_start': {
        const dc = await getDockerConfig(args.sourceId);
        const r = await docker.startContainer(dc.sourceId, args.containerId, dc.config);
        return r;
      }
      case 'docker_stop': {
        const dc = await getDockerConfig(args.sourceId);
        const r = await docker.stopContainer(dc.sourceId, args.containerId, dc.config);
        return r;
      }
      case 'docker_restart': {
        const dc = await getDockerConfig(args.sourceId);
        const r = await docker.restartContainer(dc.sourceId, args.containerId, dc.config);
        return r;
      }
      case 'docker_exec': {
        const dc = await getDockerConfig(args.sourceId);
        const r = await docker.execInContainer(dc.sourceId, args.containerId, args.command, dc.config);
        return { output: r.output, exitCode: r.exitCode };
      }
      case 'docker_health_check': {
        const r = await docker.healthCheck(dockerSources);
        return r;
      }
      // ── 远程服务器 ──
      case 'remote_servers': {
        const servers = remote.getServers();
        return { servers, total: servers.length };
      }
      case 'remote_exec': {
        // 确保已连接
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        try { await remote.ensureSshConnection(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        // 前端在等结果时最想知道「命令跑出什么了」：有钩子就流式推
        if (hooks.onOutput) {
          const r = await remote.execRemoteCommandStream(args.serverId, args.command, {
            onStdout: (chunk) => hooks.onOutput('stdout', chunk),
            onStderr: (chunk) => hooks.onOutput('stderr', chunk),
          });
          return r;
        }
        const r = await remote.execRemoteCommand(args.serverId, args.command);
        return r;
      }
      case 'remote_system_stats': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        try { await remote.ensureSshConnection(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        const r = await remote.getRemoteSystemStats(args.serverId);
        return r;
      }
      case 'remote_list_files': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        try { await remote.ensureSshConnection(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        const r = await remote.listRemoteFiles(args.serverId, args.path || '');
        return r;
      }
      case 'remote_read_file': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        try { await remote.ensureSshConnection(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        const r = await remote.readRemoteFile(args.serverId, args.filePath, { lines: args.lines || 200 });
        return r;
      }
      case 'remote_search_logs': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        try { await remote.ensureSshConnection(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        const r = await remote.searchRemoteLogs(args.serverId, args.search);
        return r;
      }
      // ── 本地 ──
      case 'local_system_stats': {
        const [cpu, mem, disksData, network, processes] = await Promise.all([
          si.currentLoad(), si.mem(), si.fsSize(), si.networkStats(), si.processes()
        ]);
        let gpus = [];
        try {
          const { execSync } = await import('child_process');
          const out = execSync('nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null', { timeout: 3000 });
          gpus = out.toString().trim().split('\n').filter(Boolean).map(line => {
            const [idx, name, util, memUsed, memTotal, temp] = line.split(',').map(s => s.trim());
            return { index: parseInt(idx) || 0, name: name || '', util: parseFloat(util) || 0, memUsed: parseFloat(memUsed) || 0, memTotal: parseFloat(memTotal) || 1, temp: parseFloat(temp) || 0 };
          });
        } catch {}
        return {
          cpu: { load: cpu.currentLoad || 0 },
          memory: { used: mem.used || 0, total: mem.total || 1, free: mem.free || 0, usePercent: mem.total > 0 ? ((mem.used / mem.total) * 100).toFixed(1) : 0 },
          disk: dedupeDisks(disksData.map(d => ({ name: d.fs, used: d.used, total: d.size, usePercent: d.use }))),
          network: (network || []).slice(0, 3).map(n => ({ iface: n.iface, rx: n.rx_sec, tx: n.tx_sec })),
          processes: (processes?.list || []).slice(0, 10).map(p => ({ pid: p.pid, name: p.name, cpu: p.cpu, mem: p.mem })),
          gpus,
        };
      }
      case 'local_log_files': {
        const logPath = settings.logPath || path.join(os.homedir(), 'logs');
        let files = [];
        try {
          if (fs.existsSync(logPath)) {
            files = fs.readdirSync(logPath).filter(f => f.endsWith('.log')).map(f => ({
              name: f, path: path.join(logPath, f), size: fs.statSync(path.join(logPath, f)).size
            }));
          }
        } catch {}
        return { logPath, files, total: files.length };
      }
      case 'local_read_log': {
        const content = fs.readFileSync(args.filePath, 'utf8');
        const allLines = content.split('\n').filter(Boolean);
        const lines = allLines.slice(-(args.lines || 200));
        return { filePath: args.filePath, totalLines: allLines.length, returnedLines: lines.length, lines };
      }
      default:
        return { error: `未知工具: ${name}` };
    }
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// ============================================================
// 运维助手对话 —— 已抽到 server/routes/chat.js
// ============================================================
app.use(createChatRouter({ ensureSettings, buildAssistantContext, executeAssistantTool }));

// ========================================
// ============================================================
// Docker API Routes —— 已抽到 server/routes/docker.js
// ============================================================
app.use(createDockerRouter({
  ensureSettings, broadcast, addAnalysisRecord, buildHostExecMap, stripThinking,
  getLastPatrolResults, setLastPatrolResults,
}));

// ========================================
// Remote Server API Routes
// ========================================
// Remote Server API Routes —— 已抽到 server/routes/remote.js
// 命令安全策略与 docker /exec 共用 server/security/shell-command-policy.js
// ========================================
// 集中采集器：服务端限并发拉取所有已连接服务器的状态，前端只拿快照。
// 1000 台时这是「不再让浏览器扇出 2000 个请求」的关键。
const statsScheduler = createStatsScheduler({
  getServers: () => remote.getServers(),
  getStats: (id) => remote.getRemoteSystemStats(id),
  getMfu: (id) => getRemoteMfu(id),
  intervalMs: Number(process.env.OPENLOG_STATS_INTERVAL_MS) || 30_000,
  mfuIntervalMs: Number(process.env.OPENLOG_MFU_INTERVAL_MS) || 60_000,
  concurrency: Number(process.env.OPENLOG_STATS_CONCURRENCY) || 16,
});

app.use(createRemoteRouter({ ensureSettings, stripThinking, statsScheduler }));

// Shell 会话存储
const shellSessions = new Map();

// WebSocket 升级处理 - 为 Shell 终端
// 升级请求不经过 Express 中间件，必须在此处完成 token 鉴权
function isUpgradeAuthorized(request) {
  // 开发模式回环地址免鉴权（与 authMiddleware 口径一致）
  if (process.env.NODE_ENV !== 'production' && isLoopbackAddress(request.socket?.remoteAddress)) return true;
  // 与 wss 的 verifyClient 用**同一套**判定，避免两处口径不一致导致
  // 「子协议带 token 能过 verifyClient、却被这里 401 掉」。
  // 顺序：Sec-WebSocket-Protocol 优先，?token= 作为老客户端兼容期兜底。
  const verdict = evaluateUpgradeRequest(request, {
    expectedToken: AUTH_TOKEN,
    allowQueryFallback: true,
  });
  return verdict.ok === true;
}

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url.split('?')[0];

  // 所有 WebSocket 端点升级前必须校验 token，失败直接 401 并断开，绝不升级
  if (!isUpgradeAuthorized(request)) {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } catch {}
    socket.destroy();
    return;
  }

  // Shell WebSocket 端点: /ws/shell/:serverId
  if (pathname.startsWith('/ws/shell/')) {
    const serverId = pathname.split('/')[3];

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleShellWebSocket(ws, serverId);
    });
  } else if (pathname.startsWith('/ws/aishell/')) {
    // AI Shell WebSocket 端点: /ws/aishell/:serverId
    const serverId = pathname.split('/')[3];

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleAIShellWebSocket(ws, serverId);
    });
  } else if (pathname.startsWith('/ws/docker/logs/')) {
    // Docker 实时日志流端点: /ws/docker/logs/:sourceId/:containerId
    const parts = pathname.split('/');
    const sourceId = parts[4];
    const containerId = parts[5];
    if (!sourceId || !containerId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleDockerLogStream(ws, sourceId, containerId);
    });
  } else if (pathname === '/ws') {
    // 原有的主 WebSocket 连接
    wss.handleUpgrade(request, socket, head, (ws) => {
      wsClients.add(ws);
      console.log('Client connected to WebSocket');

      ws.on('close', () => {
        wsClients.delete(ws);
        console.log('Client disconnected from WebSocket');
      });
    });
  } else {
    // 其他路径则关闭 socket
    socket.destroy();
  }
});

// 处理 Shell WebSocket 连接
async function handleShellWebSocket(ws, serverId) {
  console.log(`Shell WebSocket connected for server: ${serverId}`);
  
  let shellSession = null;
  
  try {
    // 创建交互式 Shell 会话
    shellSession = await remote.createShellSession(serverId, ws);
    shellSessions.set(serverId, shellSession);
    
    ws.send(JSON.stringify({ 
      type: 'shell_ready', 
      message: 'Shell session started' 
    }));
    
    // 接收客户端输入
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'input' && shellSession) {
          // 发送按键到远程 Shell
          shellSession.send(msg.data);
        } else if (msg.type === 'resize' && shellSession) {
          // 调整终端大小
          shellSession.resize(msg.cols, msg.rows);
        }
      } catch (err) {
        console.error('Shell message error:', err);
      }
    });
    
    ws.on('close', () => {
      console.log(`Shell WebSocket closed for server: ${serverId}`);
      if (shellSession) {
        shellSession.close();
        shellSessions.delete(serverId);
      }
    });
    
  } catch (err) {
    console.error('Failed to create shell session:', err);
    ws.send(JSON.stringify({ 
      type: 'shell_error', 
      error: errorMessage(err) 
    }));
    ws.close();
  }
}

// AI Shell WebSocket 处理器
/**
 * AI Shell WebSocket：多步 agent 会话（见 server/ai-shell.js）。
 *
 * 客户端 → 服务端：
 *   { type:'agent_task', id, text, history, skillContent, skillName, autoRun, maxSteps }
 *   { type:'confirm', id, allow }    确认/拒绝一条 write|danger 命令
 *   { type:'cancel', id }            取消当前任务（含正在运行的命令）
 *   { type:'execute', id, command }  命令模式：直接执行（流式输出）
 *
 * 服务端 → 客户端：
 *   context_ready / step_start / thought / model_delta / command_ready /
 *   confirm_required / command_start / command_output / command_done /
 *   command_rejected / final / agent_done / cancelled / error
 */
async function handleAIShellWebSocket(ws, serverId) {
  console.log(`AI Shell WebSocket connected for server: ${serverId}`);

  ws.send(JSON.stringify({ type: 'aishell_ready', message: 'AI Shell session ready' }));

  let abortController = null;
  let pendingConfirm = null;
  /** 上次任务因步数/时长上限暂停时的进度状态：点「继续」从这里接着跑 */
  let lastResumeState = null;

  const send = (taskId, payload) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ ...payload, id: taskId }));
  };

  /** 流式执行：把 remote 的异常统一成结果对象 */
  const execStream = async (sid, command, options = {}) => {
    try {
      return await remote.execRemoteCommandStream(sid, command, options);
    } catch (err) {
      return { success: false, error: errorMessage(err), stdout: '', stderr: '', exitCode: -1 };
    }
  };

  /** 调用 LLM（流式，把增量推给前端作为「思考中」预览） */
  const callModel = async (messages, signal, taskId) => {
    const s = ensureSettings();
    const apiKey = s.openaiApiKey;
    const baseUrl = s.openaiBaseUrl || 'http://localhost:11434/v1';
    const model = s.model || 'qwen3.5:9b';
    const isLocalModel = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);

    if (!apiKey && !isLocalModel) {
      throw new Error('未配置 LLM API Key。请在设置页面配置。');
    }

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: apiKey || 'ollama', baseURL: baseUrl });
    const stream = await openai.chat.completions.create({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 1200,
      stream: true,
    }, { signal });

    let content = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        send(taskId, { type: 'model_delta', data: delta });
      }
    }
    return { content };
  };

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const taskId = msg.id || Date.now().toString(36);

    // ── 取消 ────────────────────────────────────────────────────────────
    if (msg.type === 'cancel') {
      abortController?.abort();
      if (pendingConfirm) { const resolve = pendingConfirm; pendingConfirm = null; resolve(false); }
      send(taskId, { type: 'cancelled' });
      return;
    }

    // ── 确认危险/写操作 ─────────────────────────────────────────────────
    if (msg.type === 'confirm') {
      if (pendingConfirm) {
        const resolve = pendingConfirm;
        pendingConfirm = null;
        resolve(Boolean(msg.allow));
      }
      return;
    }

    // ── 命令模式：直接执行（流式）──────────────────────────────────────
    if (msg.type === 'execute') {
      const command = String(msg.command || '').trim();
      if (!command) return;
      abortController?.abort();
      abortController = new AbortController();
      const { signal } = abortController;
      const risk = classifyCommand(command);
      send(taskId, { type: 'command_start', step: 1, command, risk: risk.risk });
      try {
        const result = await execStream(serverId, command, {
          timeoutMs: 300_000,
          signal,
          onStdout: (chunk) => send(taskId, { type: 'command_output', step: 1, stream: 'stdout', data: chunk }),
          onStderr: (chunk) => send(taskId, { type: 'command_output', step: 1, stream: 'stderr', data: chunk }),
        });
        if (signal.aborted) { send(taskId, { type: 'cancelled' }); return; }
        if (result?.error) send(taskId, { type: 'command_error', step: 1, error: result.error });
        send(taskId, { type: 'command_done', step: 1, exitCode: result?.exitCode ?? -1 });
      } catch (err) {
        send(taskId, { type: 'command_error', step: 1, error: errorMessage(err) });
        send(taskId, { type: 'command_done', step: 1, exitCode: -1 });
      }
      return;
    }

    // ── agent 任务（natural_language 走兼容路径；continue_task 接着上次进度跑）──
    if (msg.type === 'agent_task' || msg.type === 'natural_language' || msg.type === 'regenerate' || msg.type === 'continue_task') {
      abortController?.abort();
      abortController = new AbortController();
      const { signal } = abortController;
      const isContinue = msg.type === 'continue_task';
      const text = String(msg.text || msg.prompt || (isContinue ? '继续完成这个任务' : ''));
      if (!text.trim()) {
        send(taskId, { type: 'error', error: '缺少任务描述' });
        return;
      }
      // 继续任务：只认没有超时/取消的暂停状态（避免接着一个已经结束的任务跑）
      const resume = isContinue ? lastResumeState : null;
      if (isContinue && !resume) {
        send(taskId, { type: 'error', error: '这个任务已经结束，没有可继续的进度；请重新描述任务。' });
        send(taskId, { type: 'agent_done', status: 'error', steps: 0 });
        return;
      }
      if (!isContinue) lastResumeState = null;

      try {
        // 探测模型窗口：16k 小模型必须按窗口裁剪，否则超长 prompt 被引擎静默截断，
        // 模型就会「抽风」（忘任务、重复、乱造命令）—— 用户反馈过这个现象。
        let windowTokens;
        try {
          const s = ensureSettings();
          const lp = await import('./llm-provider.js');
          const baseUrl = lp.normalizeBaseUrl(s.openaiBaseUrl || 'http://localhost:11434/v1');
          const probed = await lp.probeModelWindowCached(baseUrl, s.openaiApiKey, s.model);
          // 探测不到（部分离线引擎不暴露窗口）→ 用用户在设置里配的窗口兜底
          const configured = Number(s.assistantContext?.windowTokens) || 0;
          windowTokens = probed || configured || undefined;
          if (windowTokens) console.log(`[AIShell] 模型窗口 ${windowTokens} tokens（${probed ? '探测' : '配置'}）`);
        } catch (e) {
          console.warn('[AIShell] 模型窗口探测失败，按保守窗口处理:', errorMessage(e));
        }

        const result = await runAgent({
          serverId,
          text,
          history: Array.isArray(msg.history) ? msg.history : [],
          skillContent: msg.skillContent || '',
          skillName: msg.skillName || '',
          autoRun: msg.autoRun !== false,
          // 步数/时长上限由前端可调（默认 24 步 / 20 分钟，硬上限 64 步 / 60 分钟）
          maxSteps: Math.min(Math.max(Number(msg.maxSteps) || MAX_STEPS, 1), MAX_STEPS_CAP),
          maxWallMs: Math.min(Math.max(Number(msg.maxWallMs) || MAX_WALL_MS, 60_000), MAX_WALL_CAP_MS),
          windowTokens,
          resume,
          signal,
          send: (payload) => send(taskId, payload),
          callModel: (messages, sig) => callModel(messages, sig, taskId),
          execStream,
          confirm: (state) => new Promise((resolve) => {
            pendingConfirm = resolve;
            send(taskId, { type: 'confirm_required', ...state });
          }),
        });
        // 保存进度状态：任务因步数/时长暂停时，前端点「继续」可以接着跑
        lastResumeState = result.status === 'max_steps' ? (result.resumeState || null) : null;
        send(taskId, {
          type: 'agent_done',
          status: result.status,
          steps: result.steps,
          canContinue: Boolean(lastResumeState),
          ...(result.answer ? { answer: result.answer } : {}),
        });
      } catch (err) {
        console.error('[AIShell] agent 执行失败:', errorMessage(err));
        send(taskId, { type: 'error', error: errorMessage(err) });
        send(taskId, { type: 'agent_done', status: 'error', steps: 0 });
      }
    }
  });

  ws.on('close', () => {
    abortController?.abort();
    if (pendingConfirm) { const resolve = pendingConfirm; pendingConfirm = null; resolve(false); }
    console.log(`AI Shell WebSocket closed for server: ${serverId}`);
  });

  ws.on('error', (err) => {
    console.error(`AI Shell WebSocket error for server ${serverId}:`, errorMessage(err));
  });
}

// Docker 实时日志流 WebSocket 处理器
async function handleDockerLogStream(ws, sourceId, containerId) {
  console.log(`Docker log stream WebSocket connected for source: ${sourceId}, container: ${containerId}`);

  let logStream = null;

  try {
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = source ? await resolveDockerTransport(source) : {};

    const dockerInstance = docker.getDocker(sourceId, config);
    const container = dockerInstance.getContainer(containerId);

    // 获取实时日志流
    logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 100,
      timestamps: true,
    });

    // 通知客户端流已就绪
    ws.send(JSON.stringify({ type: 'stream_ready', sourceId, containerId }));

    // 解析 Docker 多路复用流格式：[8字节头][数据]...
    // 字节 0: stream type (1=stdout, 2=stderr)
    // 字节 4-7: 数据长度 (大端序)
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 8) {
        // 读取 8 字节头：stream type (1 byte) + 3 字节填充 + size (4 bytes)
        const size = buffer.readUInt32BE(4);
        if (size <= 0 || buffer.length < 8 + size) break;

        const data = buffer.slice(8, 8 + size).toString('utf8');
        buffer = buffer.slice(8 + size);

        // 解析时间戳
        const parts = data.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*(.*)/);
        let timestamp, line;
        if (parts) {
          timestamp = parts[1];
          line = parts[2];
        } else {
          timestamp = new Date().toISOString();
          line = data.trim();
        }

        // 解析日志等级（多格式：JSON / 时间戳前缀 / vLLM 包装前缀 / logfmt 等）
        let level = 'INFO';
        let content = line;
        {
          const parsed = parseLogLevel(line);
          level = parsed.level;
          content = parsed.content;
        }

        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'log',
            timestamp,
            line,
            level,
            content,
          }));
        }
      }
    };

    const onError = (err) => {
      console.error(`Docker log stream error for ${containerId}:`, errorMessage(err));
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream_error', error: errorMessage(err) }));
        ws.close();
      }
    };

    const onEnd = () => {
      console.log(`Docker log stream ended for ${containerId}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream_end' }));
        ws.close();
      }
    };

    logStream.on('data', onData);
    logStream.on('error', onError);
    logStream.on('end', onEnd);

    // 客户端断开时停止 stream
    ws.on('close', () => {
      console.log(`Docker log stream WebSocket closed for ${containerId}`);
      if (logStream) {
        logStream.removeListener('data', onData);
        logStream.removeListener('error', onError);
        logStream.removeListener('end', onEnd);
        logStream.destroy();
        logStream = null;
      }
    });

    ws.on('error', (err) => {
      console.error(`Docker log stream WS error for ${containerId}:`, errorMessage(err));
      if (logStream) {
        logStream.destroy();
        logStream = null;
      }
    });

    // 处理客户端消息（暂停/继续）
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'pause' && logStream) {
          logStream.pause();
        } else if (msg.type === 'resume' && logStream) {
          logStream.resume();
        }
      } catch {}
    });

  } catch (err) {
    console.error(`Failed to create Docker log stream for ${containerId}:`, errorMessage(err));
    ws.send(JSON.stringify({ type: 'stream_error', error: errorMessage(err) }));
    ws.close();
  }
}

// Start server
// 先初始化数据库
await initDatabase();

server.listen(PORT, HOST, async () => {
  const boundHost = server.address()?.address || HOST;
  console.log(`🚀 Give Me The Log server running on http://${boundHost}:${PORT}`);
  startLogWatcher();
  startMonitor();
  startDockerEventWatch();
  startContainerPatrol();
  startContainerLogWatch();
  startMaintenance();
  warnIfHostGpuUnconfigured();

  // 启动时自动重连之前在线的服务器
  try {
    const servers = remote.getServers();
    const toReconnect = servers.filter(s => s.status === 'connected' || s.status === 'error');
    if (toReconnect.length > 0) {
      console.log(`🔄 正在重连 ${toReconnect.length} 台之前配置过的服务器...`);
      // 限并发：1000 台同时建连会把事件循环和 1000 个 sshd 一起打满
      await mapLimit(toReconnect, Number(process.env.OPENLOG_STARTUP_CONNECT_CONCURRENCY) || 16, async (s) => {
        try {
          await remote.connectServer(s.id);
          console.log(`  ✅ ${s.name} 重连成功`);
        } catch (err) {
          console.log(`  ❌ ${s.name} 重连失败: ${errorMessage(err)}`);
        }
      });
    }
  } catch (err) {
    console.error('自动重连出错:', errorMessage(err));
  }

  // 后台自动重连：连不上的机器按 5s→5min 退避持续重试，
  // 恢复后自动回到 connected（以前只有进程重启才会再连一次）
  remote.startAutoReconnect();
  statsScheduler.start();
});


// ─── GPU 监控路由（已抽到 server/routes/gpu.js）───────────────────────────
app.use(gpuRouter);

/**
 * API 的 JSON 404 —— 必须注册在**所有**路由之后。
 *
 * 不注册的话，未匹配的 /api/* 会落到 Express 默认的 404 处理器，
 * 返回一份 HTML 错误页（`<title>Error</title>`）。前端的 apiFetch 会去
 * JSON.parse 这段 HTML，把「路径写错了」变成一句莫名其妙的解析错误。
 *
 * ⚠️ 位置很关键，踩过坑：最初把它放在 createRemoteRouter 之后，
 * 结果 /api/gpu/* 全部变成 404 —— 因为 GPU 路由是**单独挂在文件末尾**的
 * （上面这一行，甚至在 server.listen 之后）。教训是「最后一个路由」不能靠猜，
 * api.test.js 里有对应的回归测试。
 */
app.use((req, res, next) => {
  // 非 API 路径交回 Express 默认处理，保持原有行为不变
  if (!isApiPath(req.path)) return next();
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` });
});

// ========================================
// 周期性清理 + 优雅退出
// ========================================

// 以下 Map 的键基数没有上限，不显式清理会随进程运行时间单调增长：
//   analysisDebounce —— 键是 `${sourceId}:${消息前 120 字}`，日志内容天然不重复
//   rateLimitMap     —— 原先只有「同一 IP 在窗口过期后再次访问」才重置，换 IP 即残留
//   alertCooldowns   —— 键是 `${sourceId}_${容器名}_${错误签名}`
// （fileOffsets 在 startLogWatcher 里已有 clear()，watchers/shellSessions 在关闭路径删除，均非泄漏）
let maintenanceTimer = null;

function pruneEphemeralMaps() {
  const now = Date.now();
  let removed = 0;
  for (const [key, ts] of analysisDebounce) {
    if (now - ts > DEBOUNCE_MS) { analysisDebounce.delete(key); removed++; }
  }
  for (const [ip, record] of rateLimitMap) {
    if (now > record.resetAt) { rateLimitMap.delete(ip); removed++; }
  }
  // 冷却窗口由用户按分钟配置，这里用 24h 保守兜底
  for (const [key, ts] of alertCooldowns) {
    if (now - ts > 24 * 60 * 60 * 1000) { alertCooldowns.delete(key); removed++; }
  }
  if (removed > 0) {
    console.log(`[Maintenance] 清理 ${removed} 条过期状态 (debounce=${analysisDebounce.size} rateLimit=${rateLimitMap.size} cooldown=${alertCooldowns.size})`);
  }
}

function startMaintenance() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  const configured = Number(process.env.OPENLOG_MAINTENANCE_INTERVAL_MS);
  const interval = Number.isFinite(configured) && configured > 0 ? configured : 60_000;
  maintenanceTimer = setInterval(() => {
    pruneEphemeralMaps();
    runRetention().catch(err => console.error('[Maintenance] 保留策略执行失败:', errorMessage(err)));
  }, interval);
  // 不要因为这个定时器而阻止进程退出
  if (maintenanceTimer.unref) maintenanceTimer.unref();
  console.log(`[Maintenance] 过期状态清理已启动，间隔 ${interval}ms`);
}

// ─── 数据保留策略（每小时最多跑一次）──────────────────────────
let lastRetentionAt = 0;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 清理过期日志/分析记录 + WAL checkpoint。
 *
 * 这条以前完全缺失：`logPersistenceMaxAge` 只在手动端点里用到，没有任何定时任务。
 * 几千台机器开着日志持久化时，log_records 会无限增长，最后磁盘和查询一起崩，
 * 所以必须由后台定期按保留天数删旧数据。
 */
async function runRetention() {
  const now = Date.now();
  if (now - lastRetentionAt < RETENTION_INTERVAL_MS) return;
  lastRetentionAt = now;
  // 数据库没连上就别跑（否则 pruneOldRecords 会拿到 null db 抛错，每 60s 刷一条日志）
  if (!isDbReady()) return;
  const settings = ensureSettings();
  const logDays = Number(settings.logPersistenceMaxAge) || 7;
  if (!settings.logPersistence && logDays <= 0) return;
  const res = await pruneOldRecords({ logDays, analysisDays: Math.max(logDays * 4, 30) });
  await checkpoint();
  if (res.logs || res.analyses) {
    console.log(`[Retention] 清理过期记录：日志 ${res.logs} 条、分析 ${res.analyses} 条（保留 ${logDays} 天）`);
  }
  // 顺带回收空闲 SSH 连接（1000 台场景下不让连接池无限膨胀）
  const closed = remote.evictIdleConnections();
  if (closed > 0) console.log(`[Retention] 回收空闲 SSH 连接 ${closed} 条`);
}

let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return; // 重复信号（Ctrl-C 连按）不重入
  shuttingDown = true;
  console.log(`\n[Shutdown] 收到 ${reason}，开始优雅退出...`);

  // 兜底：任何一步挂住都不能让进程永远不退
  const force = setTimeout(() => {
    console.error('[Shutdown] 超时未退干净，强制退出');
    process.exit(exitCode || 1);
  }, 10_000);
  if (force.unref) force.unref();

  const step = async (name, fn) => {
    try { await fn(); } catch (err) { console.error(`[Shutdown] ${name} 失败: ${errorMessage(err)}`); }
  };

  await step('停止定时器', () => {
    if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
    if (patrolTimer) { clearInterval(patrolTimer); patrolTimer = null; }
    if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null; }
    // 监控的定时器与 DB 采样器：不清掉进程会退不出去（采样器用的是 setTimeout 链）
    try { stopMonitoring(monitoringHandle); } catch { /* 已停 */ }
    monitoringHandle = null;
  });

  // 先关连接再关服务：keep-alive 连接会把 server.close() 的 callback 无限拖住
  await step('关闭 HTTP 服务', () => new Promise((resolve) => {
    server.close(() => resolve());
    const finish = setTimeout(resolve, 3000);
    if (finish.unref) finish.unref();
    if (typeof server.closeAllConnections === 'function') {
      const kill = setTimeout(() => server.closeAllConnections(), 2000);
      if (kill.unref) kill.unref();
    }
  }));

  await step('关闭 WebSocket', () => {
    for (const client of wss.clients) {
      try { client.terminate(); } catch { /* 连接可能已断开 */ }
    }
    wss.close();
  });

  await step('关闭文件监听', async () => {
    for (const watcher of watchers.values()) {
      try { await watcher.close(); } catch { /* 已关闭 */ }
    }
    watchers.clear();
  });

  await step('关闭 Shell 会话', () => {
    for (const session of shellSessions.values()) {
      try { session.close(); } catch { /* 会话可能已结束 */ }
    }
    shellSessions.clear();
  });

  await step('断开 SSH 连接', async () => {
    const count = await remote.disconnectAll();
    if (count) console.log(`[Shutdown] 已断开 ${count} 个 SSH 连接`);
  });

  await step('关闭数据库', () => closeDb());

  clearTimeout(force);
  console.log('[Shutdown] 完成');
  process.exit(exitCode);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err);

  // 权衡：监控面板是常驻进程，网络抖动不该让它下线；但**只有**可判定为
  // socket 层瞬时的错误才继续运行，其余一律退出（Node 的默认建议：
  // 未捕获异常后进程状态未定义）。
  if (isTransientNetworkError(err)) {
    console.warn(`[UncaughtException] ${err.code} 属于瞬时网络错误，继续运行（不退出）`);
    return;
  }

  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  // 记录但不退出：单次异步失败不应让整个监控面板下线
  console.error('[UnhandledRejection]', reason);
});
