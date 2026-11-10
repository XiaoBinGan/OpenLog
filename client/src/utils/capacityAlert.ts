/**
 * capacityAlert.ts —— 容量告警弹窗的**抑制逻辑**（纯函数，可被 vitest 覆盖）。
 *
 * 需求原文：
 *   「内存使用超过 90% / 磁盘超过 80% 就报警，这种弹出框持续展示在屏幕上，
 *    除非手动点击关闭，一小时内不显示，未处理继续弹出」
 *
 * 这里要精确表达三件事：
 *   1. **持续展示**：弹窗没有自动关闭、没有倒计时、点遮罩也不关 —— 只有明确的
 *      「我知道了」按钮才关。所以本模块不提供任何 timeout / 自动消失逻辑。
 *   2. **关掉后 1 小时不弹**：按告警 key（memory / disk:<设备>）分别记关闭时间，
 *      不是全局静音。关掉「/data 满了」不该顺带压住「内存 96%」。
 *   3. **未处理继续弹**：1 小时到点后，只要仍然超标就重新弹。
 *
 * 为什么抑制状态存 localStorage：刷新页面不该让用户重新挨一遍弹窗，
 * 但也不能因为刷新就永远不再提醒 —— 时间戳能同时满足两头。
 * 服务端不持有这份状态（它无条件如实报告），避免多标签页/多用户互相影响。
 */

/** 一条告警的最小形状（与 server/capacity-alerts.js 对齐） */
export interface CapacityAlert {
  key: string;
  kind: 'memory' | 'disk';
  name: string;
  percent: number;
  threshold: number;
  level: 'critical' | 'warning';
  title: string;
  detail: string;
}

/** key → 关闭时间戳(ms) */
export type SnoozeMap = Record<string, number>;

export const DEFAULT_SNOOZE_MINUTES = 60;
const STORAGE_KEY = 'openlog_capacity_alert_snooze_v1';

/**
 * 从 localStorage 读抑制表。
 * 脏数据（非对象、时间戳是未来、值不是数字）一律丢弃 ——
 * 否则一条坏记录能让告警永远不弹，属于最危险的那种静默失效。
 */
export function readSnoozes(raw: string | null, now = Date.now()): SnoozeMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: SnoozeMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const n = Number(v);
    if (!k) continue;
    if (!Number.isFinite(n) || n <= 0) continue;
    // 时间戳在未来：时钟回拨或被手改过，不可信 → 丢掉（宁可多弹一次）
    if (n > now + 60_000) continue;
    out[k] = n;
  }
  return out;
}

export function writeSnoozes(map: SnoozeMap): string {
  return JSON.stringify(map);
}

/** 某条告警是否仍在抑制期（关闭后未满 1 小时） */
export function isSnoozed(
  key: string,
  snoozes: SnoozeMap,
  now = Date.now(),
  snoozeMinutes = DEFAULT_SNOOZE_MINUTES,
): boolean {
  const at = snoozes[key];
  if (!Number.isFinite(at)) return false;
  const windowMs = Math.max(1, Number(snoozeMinutes) || DEFAULT_SNOOZE_MINUTES) * 60_000;
  return now - at < windowMs;
}

/**
 * 从「服务端报上来的全部告警」里挑出**现在该弹的**。
 *
 * @param alerts 服务端当前仍超标的告警
 * @param snoozes 用户手动关闭记录
 * @returns 需要展示的告警（可能为空）
 */
export function visibleAlerts(
  alerts: CapacityAlert[] | undefined,
  snoozes: SnoozeMap,
  now = Date.now(),
  snoozeMinutes = DEFAULT_SNOOZE_MINUTES,
): CapacityAlert[] {
  const list = Array.isArray(alerts) ? alerts : [];
  return list.filter((a) => a && a.key && !isSnoozed(a.key, snoozes, now, snoozeMinutes));
}

/**
 * 用户点了「我知道了」：给这些告警打上当前时间戳。
 * 返回新的 map（不修改入参）。
 */
export function snoozeAlerts(
  alertKeys: string[],
  snoozes: SnoozeMap,
  now = Date.now(),
): SnoozeMap {
  const next: SnoozeMap = { ...snoozes };
  for (const k of Array.isArray(alertKeys) ? alertKeys : []) {
    if (k) next[k] = now;
  }
  return next;
}

/**
 * 清理抑制表：只保留「仍然超标」的 key。
 *
 * 为什么必须清：告警恢复了（比如磁盘清掉了），如果还留着那条关闭时间戳，
 * 下次再超标时会因为「1 小时内关过」而不弹 —— 那时用户其实没被告知过这次新的故障。
 * 恢复即遗忘，才能保证每次新发生的故障都一定会提醒。
 */
export function pruneSnoozes(snoozes: SnoozeMap, activeKeys: string[]): SnoozeMap {
  const active = new Set(Array.isArray(activeKeys) ? activeKeys : []);
  const next: SnoozeMap = {};
  for (const [k, v] of Object.entries(snoozes)) {
    if (active.has(k)) next[k] = v;
  }
  return next;
}

/** 剩余抑制时间（分钟，向上取整）；不在抑制期返回 0 */
export function snoozeRemainingMinutes(
  key: string,
  snoozes: SnoozeMap,
  now = Date.now(),
  snoozeMinutes = DEFAULT_SNOOZE_MINUTES,
): number {
  const at = snoozes[key];
  if (!Number.isFinite(at)) return 0;
  const windowMs = Math.max(1, Number(snoozeMinutes) || DEFAULT_SNOOZE_MINUTES) * 60_000;
  const left = windowMs - (now - at);
  return left > 0 ? Math.ceil(left / 60_000) : 0;
}

/** 本轮是否有 critical（内存 ≥95% 或磁盘 ≥90%） */
export function hasCritical(alerts: CapacityAlert[] | undefined): boolean {
  return (Array.isArray(alerts) ? alerts : []).some((a) => a?.level === 'critical');
}

/** localStorage 读写（jsdom / 隐私模式下可能抛错，一律静默降级） */
export function loadSnoozesFromStorage(now = Date.now()): SnoozeMap {
  try {
    if (typeof localStorage === 'undefined') return {};
    return readSnoozes(localStorage.getItem(STORAGE_KEY), now);
  } catch {
    return {};
  }
}

export function saveSnoozesToStorage(map: SnoozeMap): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, writeSnoozes(map));
  } catch {
    /* 存不了就退化成"本次会话内有效"，不影响弹窗本身 */
  }
}

export { STORAGE_KEY };
