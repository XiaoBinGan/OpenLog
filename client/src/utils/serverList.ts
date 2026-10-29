/**
 * 服务器列表的筛选与窗口化（1000 台规模）。
 *
 * 为什么单独抽出来：Remote 页原先直接 `servers.map()` 渲染全部卡片。
 * 1000 台时每张卡片 ~60 行 JSX + 多个图标，浏览器一次挂载上千组件会明显卡顿；
 * 而且列表在 72px 宽的侧栏里，1000 条也没法用 —— 必须先搜索/筛选，再窗口化。
 * 抽成纯函数便于单测（前端没有 DOM 测试环境）。
 */

export const DEFAULT_VISIBLE_COUNT = 60;
export const LOAD_MORE_STEP = 120;

export type ServerStatusFilter = 'all' | 'connected' | 'error' | 'disconnected';

export interface FilterableServer {
  id: string;
  name?: string;
  host?: string;
  username?: string;
  status?: string;
}

/**
 * 按关键字 + 状态过滤。
 * @param servers 全量服务器
 * @param opts.search 关键字（匹配 name / host / username，大小写不敏感）
 * @param opts.status 状态筛选，all = 不过滤
 */
export function filterServers<T extends FilterableServer>(
  servers: T[],
  { search = '', status = 'all' as ServerStatusFilter } = {},
): T[] {
  const list = Array.isArray(servers) ? servers : [];
  const q = String(search || '').trim().toLowerCase();
  return list.filter((sv) => {
    if (status !== 'all' && sv.status !== status) return false;
    if (!q) return true;
    return [sv.name, sv.host, sv.username]
      .some(v => String(v ?? '').toLowerCase().includes(q));
  });
}

/**
 * 窗口化：只取前 visibleCount 条（滚动/加载更多时递增）。
 * @returns {{ visible: T[], remaining: number, hasMore: boolean }}
 */
export function windowServers<T>(servers: T[], visibleCount: number): { visible: T[]; remaining: number; hasMore: boolean } {
  const list = Array.isArray(servers) ? servers : [];
  const count = Math.max(0, Math.floor(Number(visibleCount) || 0));
  const visible = list.slice(0, count);
  const remaining = Math.max(0, list.length - visible.length);
  return { visible, remaining, hasMore: remaining > 0 };
}

/** 计数文案：(全部) 或 (筛选/总数) */
export function countLabel(total: number, filtered: number): string {
  return filtered === total ? `(${total})` : `(${filtered}/${total})`;
}
