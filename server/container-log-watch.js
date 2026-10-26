/**
 * container-log-watch.js — 容器日志「实时」错误监听。
 *
 * 背景（真实 bug）：容器打 ERROR 日志后前端没有弹框。原因是：
 *   1. 定时巡检默认关闭（containerPatrolEnabled=false），没人扫日志；
 *   2. 巡检间隔 5 分钟，且等级识别只认 `[ERROR]` 前缀，绝大多数真实日志判成 INFO。
 *
 * 这个模块负责「实时」那一半：按固定间隔增量 tail 运行中容器的日志，
 * 命中 ERROR/FATAL 就立刻回调广播，页面马上弹 toast。
 *
 * 实现选择：轮询 + `since` 增量，而不是对每个容器开 `follow` 长连接。
 *  - follow 流在 SSH 桥接的 docker.sock 上容易因为网络抖动堆积/泄漏；
 *  - 轮询每次只取「上次之后」的新行，成本与日志量无关；
 *  - 容器频繁重启/新建时，轮询天然自愈，不需要重连状态机。
 */

import { readFileSync } from 'node:fs';
import { parseLogLevel, matchAlertLine } from './log-level.js';
import { errorMessage } from './errors.js';

/** 默认轮询间隔（ms）。可在设置里改，最小 2s。 */
export const DEFAULT_INTERVAL_MS = 5000;
/** 同一个容器同一条错误签名，多久内不重复弹框 */
export const DEFAULT_SIGNATURE_COOLDOWN_MS = 60 * 1000;
/** 单轮单容器最多推几条（其余合并成计数） */
export const MAX_LINES_PER_CONTAINER_PER_TICK = 5;
/** 首次发现容器时回看的时间窗（ms）——只补最近几条，避免刷历史 */
export const FIRST_SEEN_LOOKBACK_MS = 5000;

/**
 * 自身日志前缀：OpenLog 自己的容器不要监听自己的告警输出，否则会自激放大。
 * 例：`[LogWatch] ⚠️ openlog [ERROR] ...` 会被当成新的 ERROR 再告警一次。
 */
export const SELF_LOG_PREFIXES = ['[LogWatch]', '[Patrol]', '[Alert]', '[Docker Events]'];

/** 该行是否来自 OpenLog 自己的日志 */
export function isSelfLogLine(line) {
  const text = String(line || '').trim();
  return SELF_LOG_PREFIXES.some(p => text.startsWith(p));
}

/** 检测当前进程所在容器 ID（用于跳过自身容器） */
export function detectSelfContainerId() {
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
    const m = cgroup.match(/(?:docker|containerd|kubepods)[^\n]*?\/([0-9a-f]{12,64})/);
    if (m) return m[1];
  } catch { /* 非 Linux / 无 cgroup 时忽略 */ }
  return null;
}

/** 去重签名：去掉时间戳/请求 ID 等动态部分 */
export function alertSignature(line) {
  return String(line || '')
    .replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\w+\s+\d{4}\s*-\s*/i, '')
    .replace(/^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[.,\d]*\S*\s*-?\s*/i, '')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, 'IP')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
    .replace(/req_[a-f0-9]+/gi, 'req_XXX')
    .replace(/\b\d{2,5}\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * 把 docker logs 的原始 Buffer（8 字节帧头）拆成行。
 * 与 docker.js 里 getContainerLogs 共用同一格式，但这里不复用那个函数：
 * 它固定 tail=500 且不带 since，实时监听需要增量参数。
 */
export function demuxDockerLogBuffer(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const out = [];
  let i = 0;
  let currentTimestamp = null;

  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    if (size <= 0 || i + 8 + size > buf.length) break;
    const data = buf.slice(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;

    const parts = data.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*([\s\S]*)$/);
    if (parts) {
      currentTimestamp = parts[1];
      out.push({ timestamp: currentTimestamp, line: parts[2].trim() });
      continue;
    }
    // 多行日志（堆栈）里后续行没有独立时间戳，沿用上一条的
    const line = data.trim();
    if (!line) continue;
    out.push({ timestamp: currentTimestamp || new Date().toISOString(), line });
  }
  return out;
}

/**
 * 处理一批日志行 → 需要告警的事件。
 *
 * 纯函数（除传入的 state 外无副作用），方便单测：
 * @param {Array<{timestamp:string, line:string}>} lines
 * @param {object} state 每个容器独占的状态：{ sigCooldown: Map<string, number> }
 * @param {object} [opts]
 * @param {string[]} [opts.levels] 命中哪些等级算异常
 * @param {number} [opts.now]
 * @param {number} [opts.cooldownMs]
 * @returns {{ events: Array, dropped: number }}
 */
export function collectAlerts(lines, state, opts = {}) {
  const levels = opts.levels || ['ERROR', 'FATAL'];
  const now = opts.now ?? Date.now();
  const cooldownMs = opts.cooldownMs ?? DEFAULT_SIGNATURE_COOLDOWN_MS;
  const cooldown = state.sigCooldown || (state.sigCooldown = new Map());

  const events = [];
  let dropped = 0;

  for (const { timestamp, line } of lines || []) {
    // ????????????????? ? ????? ? ?????????
    if (isSelfLogLine(line)) continue;
    const { level, content } = parseLogLevel(line);
    const wanted = levels.map(l => String(l).toUpperCase());
    if (!wanted.includes(level)) continue;

    const sig = alertSignature(content || line);
    const last = cooldown.get(sig);
    if (last !== undefined && now - last < cooldownMs) {
      dropped += 1;
      continue;
    }
    cooldown.set(sig, now);
    events.push({ level, line, content: content || line, signature: sig, timestamp });
  }

  // 顺带清理过期签名，防止 Map 无限增长
  if (cooldown.size > 500) {
    for (const [sig, ts] of cooldown) {
      if (now - ts > cooldownMs) cooldown.delete(sig);
    }
  }
  return { events, dropped };
}

/**
 * 实时监听器。
 *
 * 注入依赖、不直接 import docker/index，便于测试：
 *   listRunningSources: () => Promise<Array<{ sourceId, sourceName, config, containers: [{id, name}] }>>
 *   fetchLogs: (source, container, sinceUnixSec) => Promise<Buffer|string>
 *   onAlert: (alert) => void
 */
export class ContainerLogWatcher {
  constructor({ listRunningSources, fetchLogs, onAlert, onError, intervalMs = DEFAULT_INTERVAL_MS, levels = ['ERROR', 'FATAL'], cooldownMs = DEFAULT_SIGNATURE_COOLDOWN_MS }) {
    this.listRunningSources = listRunningSources;
    this.fetchLogs = fetchLogs;
    this.onAlert = onAlert || (() => {});
    this.onError = onError || (() => {});
    this.intervalMs = Math.max(2000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
    this.levels = levels;
    this.cooldownMs = cooldownMs;
    this.timer = null;
    this.running = false;
    /** key `${sourceId}:${containerId}` → { sinceMs, state } */
    this.checkpoints = new Map();
  }

  get isRunning() { return this.running; }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick().catch(err => this.onError(errorMessage(err)));
    this.timer = setInterval(() => {
      this.tick().catch(err => this.onError(errorMessage(err)));
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.checkpoints.clear();
  }

  /** 单轮扫描（测试里直接调用） */
  async tick() {
    if (!this.running) return;
    const now = Date.now();
    let sources;
    try {
      sources = await this.listRunningSources();
    } catch (err) {
      this.onError(errorMessage(err));
      return;
    }

    const activeKeys = new Set();

    for (const source of sources || []) {
      for (const container of source.containers || []) {
        const key = `${source.sourceId}:${container.id}`;
        activeKeys.add(key);
        let cp = this.checkpoints.get(key);
        if (!cp) {
          // 首次发现：只看最近几秒，避免把历史错误一次性弹出来
          cp = { sinceMs: now - FIRST_SEEN_LOOKBACK_MS, state: { sigCooldown: new Map() } };
          this.checkpoints.set(key, cp);
        }
        try {
          const sinceSec = Math.max(0, Math.floor(cp.sinceMs / 1000));
          const raw = await this.fetchLogs(source, container, sinceSec);
          const lines = demuxDockerLogBuffer(raw);
          if (lines.length > 0) {
            cp.sinceMs = now;
            const { events, dropped } = collectAlerts(lines, cp.state, {
              levels: this.levels,
              now,
              cooldownMs: this.cooldownMs,
            });
            if (events.length > 0 || dropped > 0) {
              const shown = events.slice(0, MAX_LINES_PER_CONTAINER_PER_TICK);
              for (const ev of shown) {
                this.onAlert({
                  sourceId: source.sourceId,
                  sourceName: source.sourceName,
                  containerId: container.shortId || container.id?.slice(0, 12),
                  containerName: container.name || container.shortId,
                  level: ev.level,
                  line: ev.line,
                  content: ev.content,
                  timestamp: ev.timestamp,
                  suppressed: events.length - shown.length + dropped,
                });
              }
            }
          }
        } catch (err) {
          this.onError(`${container.name || container.id}: ${errorMessage(err)}`);
        }
      }
    }

    // 清理已经不在运行的容器的检查点
    for (const key of this.checkpoints.keys()) {
      if (!activeKeys.has(key)) this.checkpoints.delete(key);
    }
  }
}

export default ContainerLogWatcher;