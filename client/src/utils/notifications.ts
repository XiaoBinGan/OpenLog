/**
 * client/src/utils/notifications.ts —— 通知中心的数据逻辑（纯函数，可单测）
 *
 * 需求（用户原话）：
 *   「提示放到列表中，列表默认隐藏在最右边；顶上加个铃铛和小红点代表有未处理的内容；
 *     点击铃铛可以列表消失在右侧；现在的提示框默认弹出 2 秒没操作就进提示列表中去；
 *     支持全选忽略；支持全选删除」
 *
 * 这里只放「不依赖 React」的部分：合并去重、上限裁剪、未读数、忽略抑制。
 */

export type NotificationType = 'success' | 'error' | 'info' | 'warning';

export interface NotificationItem {
  id: string;
  type: NotificationType;
  message: string;
  description?: string;
  ts: number;
  /** 未处理（决定小红点）；点开列表/处理后置 true */
  read: boolean;
  /** 点这条通知要跳转到哪（如 /docker?sourceId=..&containerId=..&openLog=1） */
  nav?: string;
  /** 同类合并键（同一容器/同一类告警只留一条） */
  group?: string;
  // ── 导出用的结构化信息（告警来源）─────────────────────────────────
  /** Docker 源/机器 ID（local 或远程服务器 id） */
  sourceId?: string;
  /** 机器/来源显示名（如「本机 Docker」「4090服务器」） */
  sourceName?: string;
  /** 机器 IP（导出时「机器」列用它，比机器名更能定位） */
  sourceHost?: string;
  /** 容器名 */
  containerName?: string;
  /** 容器 ID（短 ID 即可） */
  containerId?: string;
  /** 级别：ERROR/WARNING/FATAL/CRITICAL 等 */
  level?: string;
  /** 错误/异常类型：OOM、异常退出、段错误、日志异常、巡检异常… */
  errorType?: string;
  /** 报错原始内容（多行也保留，导出时按格式处理） */
  errorContent?: string;
}

/** 最多保留多少条（避免 localStorage 无限膨胀） */
export const MAX_NOTIFICATIONS = 200;

/** 忽略某类告警后，同 group 在此时长内不再进列表（避免反复弹） */
export const IGNORE_SUPPRESS_MS = 10 * 60 * 1000;

/** 生成一个稳定 id（不依赖 crypto.randomUUID，兼容老浏览器） */
export function newNotificationId(now = Date.now()): string {
  return `nf-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 合并一条通知。
 * - 同 group 且列表里已有 → 更新那一条（置顶、未读、内容刷新），不新增；
 * - 否则插到最前；
 * - 最后裁剪到 max 条。
 */
export function mergeNotification(
  list: NotificationItem[],
  item: NotificationItem,
  max = MAX_NOTIFICATIONS,
): NotificationItem[] {
  const next = Array.isArray(list) ? [...list] : [];
  const sameGroup = item.group ? next.find(n => n.group === item.group) : undefined;
  const rest = sameGroup ? next.filter(n => n !== sameGroup) : next;
  const merged: NotificationItem = sameGroup
    ? { ...sameGroup, ...item, id: sameGroup.id, read: false, ts: item.ts }
    : item;
  return [merged, ...rest].slice(0, max);
}

/** 删除指定 id（返回新数组；id 不存在时原样返回） */
export function removeNotifications(list: NotificationItem[], ids: Iterable<string>): NotificationItem[] {
  const drop = new Set(ids);
  if (drop.size === 0) return list;
  return list.filter(n => !drop.has(n.id));
}

/** 全部置为已读（点开列表时用） */
export function markAllRead(list: NotificationItem[]): NotificationItem[] {
  if (!list.some(n => !n.read)) return list;
  return list.map(n => (n.read ? n : { ...n, read: true }));
}

/** 未读数（决定小红点） */
export function unreadCount(list: NotificationItem[]): number {
  return list.reduce((n, item) => n + (item.read ? 0 : 1), 0);
}

/** 忽略：记录 group 的抑制到期时间；没有 group 的通知无需记录 */
export function recordIgnored(
  ignored: Record<string, number>,
  items: NotificationItem[],
  now: number,
  ttlMs = IGNORE_SUPPRESS_MS,
): Record<string, number> {
  const next = { ...ignored };
  for (const it of items) {
    if (it.group) next[it.group] = now + ttlMs;
  }
  return next;
}

/** 某 group 当前是否被忽略抑制（到期自动失效） */
export function isSuppressed(
  ignored: Record<string, number>,
  group: string | undefined,
  now: number,
): boolean {
  if (!group) return false;
  const until = ignored[group];
  return typeof until === 'number' && until > now;
}

/** 清理已过期的抑制记录（定时/打开列表时顺手做） */
export function pruneIgnored(ignored: Record<string, number>, now: number): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, until] of Object.entries(ignored || {})) {
    if (typeof until === 'number' && until > now) next[k] = until;
  }
  return next;
}

/** 时间显示：今天显示 HH:MM，更早显示 M/D HH:MM */
export function formatNotificationTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const nd = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === nd.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// ─── 筛选 / 搜索 ───────────────────────────────────────────────────────────

/** 通知筛选条件 */
export interface NotificationFilter {
  /** 只看某一级别（'all' 表示不限） */
  level?: 'all' | 'error' | 'warning' | 'info' | 'success';
  /** 只看某一台机器（'' 表示不限；值为 sourceId） */
  sourceId?: string;
  /** 只看未读 */
  unreadOnly?: boolean;
  /** 关键词搜索（消息 / 描述 / 机器 / 容器 / 报错内容） */
  query?: string;
}

export const EMPTY_NOTIFICATION_FILTER: NotificationFilter = {
  level: 'all', sourceId: '', unreadOnly: false, query: '',
};

/** 筛选条件是否处于「非默认」状态（用于显示清除按钮） */
export function isFilterActive(filter: NotificationFilter): boolean {
  return Boolean(
    (filter.level && filter.level !== 'all') ||
    filter.sourceId ||
    filter.unreadOnly ||
    String(filter.query || '').trim(),
  );
}

/** 从通知列表里取出所有出现过的机器（用于筛选下拉） */
export function listNotificationSources(items: NotificationItem[]): Array<{ sourceId: string; sourceName: string; count: number }> {
  const map = new Map<string, { sourceId: string; sourceName: string; count: number }>();
  for (const n of items || []) {
    const id = n.sourceId || (n.sourceName ? `name:${n.sourceName}` : '');
    if (!id) continue;
    const name = n.sourceName || (id === 'local' ? '本机 Docker' : id);
    const hit = map.get(id);
    if (hit) hit.count += 1;
    else map.set(id, { sourceId: id, sourceName: name, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * 按条件筛选通知（纯函数）。
 *
 * 搜索覆盖标题、描述、机器名、容器名、报错内容 —— 排查时经常只记得半句报错
 * 或者只记得容器名，都要能搜到。
 */
export function filterNotifications(items: NotificationItem[], filter: NotificationFilter = {}): NotificationItem[] {
  const level = filter.level && filter.level !== 'all' ? filter.level : '';
  const sourceId = filter.sourceId || '';
  const unreadOnly = filter.unreadOnly === true;
  const query = String(filter.query || '').trim().toLowerCase();

  return (items || []).filter((n) => {
    if (level && n.type !== level) return false;
    if (sourceId) {
      const key = n.sourceId || (n.sourceName ? `name:${n.sourceName}` : '');
      if (key !== sourceId) return false;
    }
    if (unreadOnly && n.read) return false;
    if (query) {
      const haystack = [
        n.message, n.description, n.sourceName, n.sourceId,
        n.containerName, n.containerId, n.level, n.errorType, n.errorContent,
      ].filter(Boolean).join('\n').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}
