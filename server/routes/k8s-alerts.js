/**
 * routes/k8s-alerts.js —— Warning 事件聚合摘要（A3，契约见 /tmp/hami-k8s-contract.md）
 *
 * 只干两件事，且都只围绕「Warning 事件」这一块数据：
 *   GET  /api/k8s/clusters/:id/warning-digest?window=1h
 *        → { window, since, byReason: [{ reason, count, lastSeen, objects }], total, newEvents }
 *   POST /api/k8s/clusters/:id/warning-digest/ack   body { reason }
 *        → { ok: true, ackedAt }
 *
 * 三条硬约束（契约）：
 *   1. **只读**：除了 ack 的本地内存状态，不向集群写任何东西，只打一次 `GET /api/v1/events`；
 *   2. **演示模式（OPENLOG_DEMO=1）不连集群**：不读 kubeconfig、不建 client、不发请求，
 *      直接回一份 fixture 风格的空摘要 + `demo: true`；
 *   3. 状态码：集群 id 不存在 → 404，连不上 kube-apiserver（含 kubeconfig 解析失败）→ 502，
 *      ack 缺 body / reason → 400。
 *
 * 与 routes/k8s.js 的关系：本文件是**独立路由模块**，不动 k8s.js 的 9 个只读端点，
 * 由 A10 在 server/index.js 里 `app.use(createK8sAlertsRouter({ ensureSettings }))` 挂到根上
 * （路径自己写全 `/api/k8s/...`，与 db-monitor.js / settings.js 同一惯例）。
 *
 * 为什么用命名空间导入（`import * as`）：k8s/store.js、k8s/kubeconfig.js、k8s/client.js
 * 是与本文件并行开发的模块；具名导入一旦某个导出缺失，会在 **ESM 链接阶段**直接 SyntaxError，
 * 把整条 /api/k8s 路由带崩。命名空间导入只在实际调用到缺失函数时才失败，
 * 可被这里的 try/catch 降级成 502。
 *
 * 关于 ack 状态：ack 不是集群操作，只是「这个 reason 我已经看过了」的本地标记，
 * 因此**存内存 Map**（键 `clusterId + '\0' + reason`，值是 ack 时刻的毫秒数），进程重启即丢失。
 * 这样设计是刻意的：告警摘要本身可以从 `/api/v1/events` 随时重算，
 * 把已读状态持久化到配置文件反而会引入「谁改的、什么时候改的」这类与原需求无关的问题。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import * as k8sStore from '../k8s/store.js';
import * as k8sKubeconfig from '../k8s/kubeconfig.js';
import * as k8sClientModule from '../k8s/client.js';
import * as k8sResources from '../k8s/resources.js';
import * as demoFixtures from '../demo/fixtures.js';
import { isDemoMode } from '../demo/mode.js';

/** 路由前缀：index.js 直接 `app.use(router)` 挂根，所以每条路径都写全 */
const PREFIX = '/api/k8s';

/** 事件列表接口（只读，集群级，不需要 namespace） */
const EVENTS_PATH = '/api/v1/events';

/** 默认窗口：1 小时（kube-apiserver 的事件默认 TTL 就是 1h，再长也拿不到更早的） */
export const DEFAULT_WINDOW = '1h';

/** 窗口单位 → 毫秒 */
const WINDOW_UNITS = Object.freeze({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 });

/** 窗口上限：再往外要没有意义（事件已被 apiserver 清理），也防止 since 算成几年前的字符串 */
const WINDOW_MAX_MS = 30 * WINDOW_UNITS.d;

/** 摘要里最多返回多少个 reason 分组（契约：20） */
const MAX_GROUPS = 20;

/** 每个分组最多带几个示例对象（足够前端点进去定位，又不至于把响应撑大） */
const MAX_OBJECTS = 5;

/** 事件没填 reason 时的占位（真实集群上见过，不能让分组 key 变成空串） */
const UNKNOWN_REASON = 'Unknown';

/** reason 最大长度：防止 ack 接口被塞超长字符串撑内存 */
const MAX_REASON_LENGTH = 200;

/** ack 复合键的分隔符：用 NUL 而不是 '+'，避免 reason 里本身带分隔符时键冲突 */
const ACK_KEY_SEP = '\u0000';

/**
 * ack 本地状态：`${clusterId}\0${reason}` → ack 时刻（毫秒）。
 * 模块级而不是工厂级：A10 可能在不同位置挂载同一个 router 实例，
 * 已读状态应该按「集群 + reason」全局一致（契约原文：键 clusterId+reason）。
 */
const alertAcks = new Map();

/**
 * 清空 ack 状态。测试用的隔离钩子，也可在运维侧「重置已读」时调用。
 * @returns {void}
 */
export function resetAlertAcks() {
  alertAcks.clear();
}

/**
 * 拼 ack 复合键（导出便于排查线上「为什么这条不显示为已读」）。
 * @param {string} clusterId
 * @param {string} reason
 * @returns {string}
 */
export function ackKeyOf(clusterId, reason) {
  return `${String(clusterId ?? '')}${ACK_KEY_SEP}${String(reason ?? '')}`;
}

// ─── 小工具 ───────────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只保留字符串（数字/布尔转字符串，对象/null 一律空串），避免 `[object Object]` 混进响应 */
function str(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function trimStr(value) {
  return str(value).trim();
}

/** express 4 里同名查询参数重复会变成数组，这里统一取第一个 */
function queryString(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return trimStr(value);
}

/** 事件累计次数：`events[].count` 缺失/为 0/为负 → 按 1 条算（它至少出现过一次） */
function asCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.trunc(n);
}

/**
 * 任意时间表示 → 毫秒时间戳；解析不了返回 null，**绝不抛**。
 * 兼容：Date / 毫秒数 / 数字字符串 / ISO 与 RFC3339 文本。
 */
function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t;
}

/** 带 HTTP 状态码的入参错误（400） */
function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/** 上游不可达（502）：连不上 / 证书不对 / kubeconfig 坏掉都归这里 */
function upstreamError(message) {
  const err = new Error(message);
  err.statusCode = 502;
  return err;
}

/** 统一错误出口：`err.statusCode` 优先，否则用兜底状态（本文件兜底 502） */
function sendError(res, err, fallbackStatus = 502) {
  const status = Number(err?.statusCode) || fallbackStatus;
  res.status(status).json({ error: errorMessage(err) });
}

/**
 * 解析 `?window=1h` 这类时间窗口。
 *
 * 规则（摘要接口是只读监控，宁可回默认窗口也不要 400 把面板打空）：
 *   `90s` / `30m` / `1h` / `7d` → 对应毫秒；纯数字（`3600`）按秒算；
 *   缺省、非法、0、负数、超大 → 夹到 1h 或 30d 上限。
 *
 * @param {unknown} raw 原始查询参数（可能是数组）
 * @returns {{window: string, ms: number}}
 */
export function parseWindow(raw) {
  const fallback = { window: DEFAULT_WINDOW, ms: WINDOW_UNITS.h };
  const text = queryString(raw).toLowerCase();
  if (text === '') return fallback;

  const match = text.match(/^(\d+)\s*(s|m|h|d)?$/);
  if (!match) return fallback;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || 's';
  if (!Number.isFinite(amount) || amount <= 0) return fallback;

  const wantedMs = amount * WINDOW_UNITS[unit];
  const ms = Math.min(wantedMs, WINDOW_MAX_MS);
  // 被夹到上限时标签同步改写，否则会出现「window=90d，since 却是 30 天前」的自相矛盾响应
  const label = ms === wantedMs ? `${amount}${unit}` : `${Math.round(ms / WINDOW_UNITS.d)}d`;
  return { window: label, ms };
}

// ─── 事件字段读取：同时吃「归一化后」与「k8s 原始」两种形状 ──────────────
//
// 正常链路是 k8sResources.normalizeEvents(items) 先归一化；但
//   ① 归一化模块是并行开发的，可能缺失/抛错（此时 eventsOf 会把原始 items 交进来）；
//   ② 真实集群里事件字段缺失、类型不对的情况很常见（坏事件不该让整份摘要 500）。
// 所以这里每个字段都要能自己从两种形状里取值。

/** 事件时间：lastSeen（归一化）→ lastTimestamp / eventTime / series → creationTimestamp */
function readEventTimeMs(event) {
  if (!isPlainObject(event)) return null;
  const candidates = [
    event.lastSeen,
    event.lastTimestamp,
    event.eventTime,
    event.series?.lastObservedTime,
    event.metadata?.creationTimestamp,
    event.firstTimestamp,
  ];
  for (const candidate of candidates) {
    const ms = toMs(candidate);
    if (ms !== null) return ms;
  }
  return null;
}

/** reason：顶层 reason 优先；原始对象里也读 involvedObject.reason；都没有 → Unknown */
function readEventReason(event) {
  const direct = trimStr(event?.reason);
  if (direct) return direct;
  const involved = trimStr(event?.involvedObject?.reason);
  return involved || UNKNOWN_REASON;
}

/** 对象引用：归一化后的 `Kind/namespace/name`，其次从 involvedObject 拼，再次事件名 */
function readEventObject(event) {
  const direct = trimStr(event?.object);
  if (direct) return direct;

  const involved = event?.involvedObject;
  if (isPlainObject(involved)) {
    const parts = [trimStr(involved.kind), trimStr(involved.namespace), trimStr(involved.name)].filter(Boolean);
    if (parts.length > 0) return parts.join('/');
  }
  return trimStr(event?.metadata?.name);
}

/** 只有 Warning 进摘要；没填 type 的事件按 Normal 处理（与 resources.normalizeEvents 同口径） */
function isWarningEvent(event) {
  const type = trimStr(event?.type) || 'Normal';
  return type.toLowerCase() === 'warning';
}

/**
 * ack 入参收敛成 `Map<reason, 毫秒>`。
 *
 * 接受三种形状（调用方/测试都方便）：
 *   Map<reason, Date|string|number>
 *   普通对象 `{ BackOff: '2026-06-08T09:00:00Z' }`
 *   数组 `[{ reason, ackedAt }]`
 * 解析不了的值直接丢掉 —— 一条坏 ack 记录不该让整份摘要变空。
 */
function normalizeAcks(acks) {
  const map = new Map();
  const put = (reason, value) => {
    const key = trimStr(reason);
    if (key === '') return;
    const ms = toMs(value);
    if (ms !== null) map.set(key, ms);
  };

  if (acks instanceof Map) {
    for (const [reason, value] of acks) put(reason, value);
    return map;
  }
  if (Array.isArray(acks)) {
    for (const item of acks) {
      if (!isPlainObject(item)) continue;
      put(item.reason, item.ackedAt ?? item.at ?? item.time);
    }
    return map;
  }
  if (isPlainObject(acks)) {
    for (const [reason, value] of Object.entries(acks)) put(reason, value);
  }
  return map;
}

/** 分组排序：count 降序 → lastSeen 降序（无时间的排最后）→ reason 字典序（保证结果稳定） */
function compareGroups(a, b) {
  if (b.count !== a.count) return b.count - a.count;
  if (a.lastSeenMs !== b.lastSeenMs) {
    if (a.lastSeenMs === null) return 1;
    if (b.lastSeenMs === null) return -1;
    return b.lastSeenMs - a.lastSeenMs;
  }
  if (a.reason === b.reason) return 0;
  return a.reason < b.reason ? -1 : 1;
}

/** 示例对象：按最近出现时间倒序，最多 MAX_OBJECTS 个 */
function pickObjects(objects) {
  return [...objects.entries()]
    .sort((a, b) => {
      const ta = a[1];
      const tb = b[1];
      if (ta === tb) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    })
    .slice(0, MAX_OBJECTS)
    .map(([ref]) => ref);
}

/**
 * 纯函数：把事件列表聚合成 Warning 摘要。
 *
 * 口径（与 routes/k8s.js 的 overview 一致：只看 `type=Warning`）：
 *   - **分组**：按 `reason`，组内 `count` = Σ `event.count`（缺失按 1 条算），
 *     `lastSeen` = 组内最大时间（ISO，无有效时间为 null），
 *     `objects` = 该 reason 涉及的示例对象（`Kind/ns/name`，最多 5 个，最近的在前）；
 *   - **排序**：count 降序（同 count 按 lastSeen 倒序、再按 reason 字典序保证稳定），截断到 20 组；
 *   - **total**：窗口内**全部** Warning 的累计次数（不受 20 组截断影响，用于「本小时共 N 次告警」）；
 *   - **newEvents**：ack 之后出现的**事件条数**（不是 count 累计）—— 该 reason 没有 ack 记录时全算新，
 *     时间坏掉的事件无法证明「发生在 ack 之后」，不计入；
 *   - **窗口过滤**：`since` 之前的 Warning 丢弃；时间坏掉的事件保留（它确实在 API 响应里，
 *     丢掉会让「总次数」少算），但同样不计入 newEvents。
 *
 * @param {unknown} events 事件数组（归一化形状或 k8s 原始 items 都可以）
 * @param {{ since?: string|number|Date|null, acks?: Map|object|Array, window?: string }} [options]
 *        since  —— 窗口起点；不传则**不做窗口过滤**（pure：不读时钟）
 *        acks   —— 已读状态（Map<reason, 时刻> 优先，见 normalizeAcks）
 *        window —— 原样回填到结果的标签（如 '1h'），仅用于响应透传
 * @returns {{window?: string, since: string|null, byReason: Array<{reason:string,count:number,lastSeen:string|null,objects:string[]}>, total: number, newEvents: number}}
 */
export function summarizeWarnings(events, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const sinceMs = toMs(opts.since);
  const acks = normalizeAcks(opts.acks);
  const list = Array.isArray(events) ? events : [];

  /** reason → { reason, count, lastSeenMs, objects: Map<对象引用, 最近时间> } */
  const groups = new Map();
  let total = 0;
  let newEvents = 0;

  for (const event of list) {
    if (!isWarningEvent(event)) continue;

    const timeMs = readEventTimeMs(event);
    if (sinceMs !== null && timeMs !== null && timeMs < sinceMs) continue;

    const reason = readEventReason(event);
    const count = asCount(event?.count);
    total += count;

    let group = groups.get(reason);
    if (!group) {
      group = { reason, count: 0, lastSeenMs: null, objects: new Map() };
      groups.set(reason, group);
    }
    group.count += count;
    if (timeMs !== null && (group.lastSeenMs === null || timeMs > group.lastSeenMs)) {
      group.lastSeenMs = timeMs;
    }

    const objectRef = readEventObject(event);
    if (objectRef) {
      // 只关心每个对象「最近一次出现」的时间，用来给 objects 排序
      const prev = group.objects.get(objectRef);
      if (!group.objects.has(objectRef) || (timeMs !== null && (prev === null || timeMs > prev))) {
        group.objects.set(objectRef, timeMs);
      }
    }

    const ackedMs = acks.get(reason);
    if (timeMs !== null && (ackedMs === undefined || timeMs > ackedMs)) newEvents += 1;
  }

  const byReason = [...groups.values()]
    .sort(compareGroups)
    .slice(0, MAX_GROUPS)
    .map((group) => ({
      reason: group.reason,
      count: group.count,
      lastSeen: group.lastSeenMs === null ? null : new Date(group.lastSeenMs).toISOString(),
      objects: pickObjects(group.objects),
    }));

  const out = {};
  const windowLabel = trimStr(opts.window);
  if (windowLabel) out.window = windowLabel;
  out.since = sinceMs === null ? null : new Date(sinceMs).toISOString();
  out.byReason = byReason;
  out.total = total;
  out.newEvents = newEvents;
  return out;
}

// ─── 路由内部：集群 / 客户端 / 事件 ────────────────────────────────────

/** 演示集群列表（形状同 GET /api/k8s/clusters 的 clusters[]） */
/** 演示用的 Warning 事件（形状同 k8s 原始 Event，走同一套 summarizeWarnings） */
function DEMO_WARNINGS() {
  const at = (min) => new Date(Date.parse('2026-06-08T09:48:37.000Z') - min * 60_000).toISOString();
  return [
    { type: 'Warning', reason: 'FailedScheduling', count: 12, lastTimestamp: at(7), involvedObject: { kind: 'Pod', namespace: 'inference', name: 'vllm-llama70b-0' }, message: '0/2 nodes are available: 1 Insufficient nvidia.com/gpumem.' },
    { type: 'Warning', reason: 'BackOff', count: 7, lastTimestamp: at(4), involvedObject: { kind: 'Pod', namespace: 'inference', name: 'vllm-canary-0' }, message: 'Back-off restarting failed container main' },
    { type: 'Warning', reason: 'Unhealthy', count: 4, lastTimestamp: at(2), involvedObject: { kind: 'Pod', namespace: 'kube-system', name: 'metrics-server-xxx' }, message: 'Readiness probe failed: HTTP probe failed with statuscode: 500' },
  ];
}

function demoClusters() {
  const fn = demoFixtures.demoK8sClusters;
  if (typeof fn !== 'function') return [];
  try {
    const data = fn();
    return Array.isArray(data) ? data : (Array.isArray(data?.clusters) ? data.clusters : []);
  } catch (err) {
    console.warn('[demo] demoK8sClusters 调用失败:', errorMessage(err));
    return [];
  }
}

/** 取某个集群的 ack 状态（`Map<reason, 毫秒>`）：只挑出本集群的键 */
function acksForCluster(clusterId) {
  const prefix = `${String(clusterId ?? '')}${ACK_KEY_SEP}`;
  const out = new Map();
  for (const [key, at] of alertAcks) {
    if (!key.startsWith(prefix)) continue;
    const ms = toMs(at);
    if (ms === null) continue;
    out.set(key.slice(prefix.length), ms);
  }
  return out;
}

/**
 * 建一个连集群的客户端。
 *
 * 与 routes/k8s.js 的差别：k8s.js 把 kubeconfig 解析失败归到 400（那里是「新增集群」的入参校验），
 * 本文件是纯读摘要 —— 存的 kubeconfig 坏掉属于「这个集群连不上」，按契约统一 502。
 *
 * @param {object} record 集群原始记录（含 kubeconfig 明文）
 * @param {Function} createClient 客户端工厂（测试可注入假实现）
 * @returns {{client: object, resolved: object}}
 */
function connectCluster(record, createClient) {
  const text = typeof record?.kubeconfig === 'string' ? record.kubeconfig : '';
  if (text.trim() === '') throw upstreamError('该集群没有可用的 kubeconfig，无法读取事件');

  let resolved;
  try {
    resolved = k8sKubeconfig.parseKubeconfig(text, trimStr(record?.context) || undefined);
  } catch (err) {
    throw upstreamError(`kubeconfig 解析失败，无法连接集群：${errorMessage(err)}`);
  }

  let client;
  try {
    client = createClient(resolved, record);
  } catch (err) {
    throw upstreamError(`创建 Kubernetes 客户端失败：${errorMessage(err)}`);
  }
  if (!client || typeof client.getJson !== 'function') {
    throw upstreamError('Kubernetes 客户端不可用（缺少 getJson）');
  }
  return { client, resolved };
}

/**
 * 把 `/api/v1/events` 的响应变成事件数组。
 * 优先用 resources.normalizeEvents（与 overview 同口径）；它缺失/抛错时退回原始 items ——
 * summarizeWarnings 自己就能读原始形状，所以降级不影响聚合结果。
 */
function eventsOf(data) {
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data?.items)) items = data.items;
  else return [];

  try {
    const normalized = k8sResources.normalizeEvents(items);
    if (Array.isArray(normalized) && normalized.length === items.length) return normalized;
  } catch (err) {
    console.warn('[k8s-alerts] 事件归一化失败，改用原始 items:', errorMessage(err));
  }
  return items;
}

/** 时钟：测试可注入固定值，生产走 Date.now() */
function resolveClock(now) {
  if (typeof now === 'function') {
    return () => {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    };
  }
  const fixed = Number(now);
  if (Number.isFinite(fixed)) return () => fixed;
  return () => Date.now();
}

// ─── 工厂 ─────────────────────────────────────────────────────────────

/**
 * 创建 Warning 摘要路由。
 *
 * @param {object} deps
 * @param {Function} deps.ensureSettings 读取当前生效配置（settings.k8sClusters 在里面）
 * @param {Function} [deps.createClient] 客户端工厂，默认 `createK8sClient(resolved)`；测试注入假实现
 * @param {Function|number} [deps.now]   时钟（毫秒），默认 Date.now；测试用它固定窗口与 ack 时间
 * @returns {import('express').Router}
 */
export function createK8sAlertsRouter({ ensureSettings, createClient, now } = {}) {
  if (typeof ensureSettings !== 'function') {
    throw new TypeError('createK8sAlertsRouter 需要注入 ensureSettings');
  }

  const clock = resolveClock(now);
  const factory = typeof createClient === 'function'
    ? createClient
    : (resolved) => k8sClientModule.createK8sClient(resolved);

  const router = express.Router();

  /**
   * `:id` 校验只写一次（与 routes/k8s.js 同构）：
   * 两条路由都要「先找到集群再干活」，逐条重复 find 迟早漏掉一条，
   * 把 undefined 带进下游（读不到 kubeconfig → 莫名其妙的 502）。
   */
  router.param('id', (req, res, next, id) => {
    const clusterId = trimStr(id);
    if (!clusterId) {
      res.status(404).json({ error: '缺少集群 id' });
      return;
    }
    if (isDemoMode()) {
      // 演示模式：没有真实 settings，白名单换成演示集群，否则前端拿着演示 id 会被这里 404
      const hit = demoClusters().find((cluster) => trimStr(cluster?.id) === clusterId);
      if (!hit) {
        res.status(404).json({ demo: true, error: `Kubernetes 集群不存在: ${clusterId}` });
        return;
      }
      req.k8sCluster = hit;
      next();
      return;
    }
    let record;
    try {
      record = k8sStore.getClusterRecord(ensureSettings(), clusterId);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
      return;
    }
    if (!record) {
      res.status(404).json({ error: `Kubernetes 集群不存在: ${clusterId}` });
      return;
    }
    req.k8sCluster = record;
    next();
  });

  // ── Warning 摘要 ──────────────────────────────────────────────────
  router.get(`${PREFIX}/clusters/:id/warning-digest`, async (req, res) => {
    const { window: label, ms } = parseWindow(req.query.window);
    const sinceMs = clock() - ms;
    const clusterId = trimStr(req.k8sCluster?.id);

    // 演示模式：不建 client、不读 kubeconfig、不发任何请求；给一份「空但有形状」的摘要。
    // 形状与真实响应逐字段一致（byReason 空数组），前端不需要为演示模式写第二条分支。
    if (isDemoMode()) {
      // 演示模式给一组固定事件，跑同一套聚合（形状与真实响应逐字段一致）
      const summary = summarizeWarnings(DEMO_WARNINGS(), {
        window: label,
        since: sinceMs,
        acks: acksForCluster(clusterId),
      });
      return res.json({ demo: true, ...summary });
    }

    try {
      const { client } = connectCluster(req.k8sCluster, factory);
      // 只读：整个路由生命周期里对集群的唯一一次请求就是这条 LIST
      const data = await Promise.resolve().then(() => client.getJson(EVENTS_PATH));
      const summary = summarizeWarnings(eventsOf(data), {
        window: label,
        since: sinceMs,
        acks: acksForCluster(clusterId),
      });
      res.json(summary);
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  // ── 确认（本地已读）────────────────────────────────────────────────
  router.post(`${PREFIX}/clusters/:id/warning-digest/ack`, (req, res) => {
    const body = isPlainObject(req.body) ? req.body : null;
    const reason = trimStr(body?.reason);

    if (reason === '') {
      // 契约：无 body → 400（`{}` / `{ reason: '' }` 同样是「没告诉我要 ack 哪一组」）
      sendError(res, badRequest('缺少 reason（需要 body { reason }）'), 400);
      return;
    }
    if (reason.length > MAX_REASON_LENGTH) {
      sendError(res, badRequest(`reason 过长（最多 ${MAX_REASON_LENGTH} 字符）`), 400);
      return;
    }

    const ackedAtMs = clock();
    // 唯一的状态写入：本地 Map（不落盘、不写集群、不动 settings）
    alertAcks.set(ackKeyOf(trimStr(req.k8sCluster?.id), reason), ackedAtMs);

    const payload = { ok: true, ackedAt: new Date(ackedAtMs).toISOString() };
    // 演示模式也允许 ack：它只改内存，不触达任何集群，前端「标记已读」在演示里同样能点
    res.json(isDemoMode() ? { demo: true, ...payload } : payload);
  });

  return router;
}

export default createK8sAlertsRouter;
