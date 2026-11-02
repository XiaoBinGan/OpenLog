/**
 * client/src/utils/notifications.test.ts
 *
 * 通知中心（铃铛 + 右侧列表）的数据逻辑测试：
 *   - 同类合并（同一容器反复报错只留一条）
 *   - 上限裁剪、未读数、全选删除/忽略、忽略抑制
 */
import { describe, it, expect } from 'vitest';
import {
  mergeNotification, removeNotifications, markAllRead, unreadCount,
  recordIgnored, isSuppressed, pruneIgnored, formatNotificationTime,
  newNotificationId, MAX_NOTIFICATIONS, IGNORE_SUPPRESS_MS,
  type NotificationItem,
} from './notifications';

const item = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: newNotificationId(1000),
  type: 'error',
  message: '容器异常',
  ts: 1000,
  read: false,
  ...over,
});

describe('mergeNotification —— 合并与去重', () => {
  it('新通知插到最前面', () => {
    const a = item({ id: 'a', message: 'A' });
    const b = item({ id: 'b', message: 'B' });
    const out = mergeNotification([a], b);
    expect(out.map(n => n.id)).toEqual(['b', 'a']);
  });

  it('同 group 只留一条：更新内容并重新变成未读、置顶', () => {
    const old = item({ id: 'x', group: 'exit-abc', message: '旧消息', read: true, ts: 1 });
    const other = item({ id: 'y', message: '别的' });
    const incoming = item({ message: '新消息', group: 'exit-abc', ts: 99 });
    const out = mergeNotification([other, old], incoming);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('x');
    expect(out[0].message).toBe('新消息');
    expect(out[0].read).toBe(false);
    expect(out[0].ts).toBe(99);
  });

  it('超过上限裁剪到 MAX_NOTIFICATIONS', () => {
    const list = Array.from({ length: MAX_NOTIFICATIONS }, (_, i) => item({ id: `n${i}` }));
    const out = mergeNotification(list, item({ id: 'new' }));
    expect(out).toHaveLength(MAX_NOTIFICATIONS);
    expect(out[0].id).toBe('new');
    expect(out.some(n => n.id === `n${MAX_NOTIFICATIONS - 1}`)).toBe(false);
  });

  it('空列表/异常输入不崩', () => {
    expect(mergeNotification([], item({ id: 'a' }))).toHaveLength(1);
    expect(mergeNotification(null as any, item({ id: 'a' }))).toHaveLength(1);
  });
});

describe('删除 / 已读 / 未读数', () => {
  it('removeNotifications 按 id 删除（支持全选删除）', () => {
    const list = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    expect(removeNotifications(list, ['a', 'c']).map(n => n.id)).toEqual(['b']);
    expect(removeNotifications(list, [])).toBe(list);
  });

  it('markAllRead 全部置已读；没有未读时返回原数组', () => {
    const list = [item({ id: 'a' }), item({ id: 'b', read: true })];
    expect(markAllRead(list).every(n => n.read)).toBe(true);
    const allRead = [item({ id: 'a', read: true })];
    expect(markAllRead(allRead)).toBe(allRead);
  });

  it('unreadCount 只数未读（决定小红点）', () => {
    expect(unreadCount([])).toBe(0);
    expect(unreadCount([item({ id: 'a' }), item({ id: 'b', read: true }), item({ id: 'c' })])).toBe(2);
  });
});

describe('忽略抑制（同一容器反复报错不要一直进列表）', () => {
  it('记录忽略后同 group 在 TTL 内被抑制，过期后恢复', () => {
    const now = 1_000_000;
    const list = [item({ id: 'a', group: 'exit-1' }), item({ id: 'b' })];
    const ignored = recordIgnored({}, list, now);
    expect(isSuppressed(ignored, 'exit-1', now + 1)).toBe(true);
    expect(isSuppressed(ignored, 'exit-1', now + IGNORE_SUPPRESS_MS + 1)).toBe(false);
    // 没有 group 的通知不受影响
    expect(isSuppressed(ignored, undefined, now)).toBe(false);
  });

  it('pruneIgnored 清掉过期项', () => {
    const now = 1_000_000;
    const pruned = pruneIgnored({ a: now - 1, b: now + 1000 }, now);
    expect(Object.keys(pruned)).toEqual(['b']);
  });
});

describe('formatNotificationTime —— 列表里的时间', () => {
  it('今天只显示时分，更早显示日期', () => {
    const now = new Date('2026-11-03T10:00:00').getTime();
    expect(formatNotificationTime(new Date('2026-11-03T09:05:00').getTime(), now)).toBe('09:05');
    expect(formatNotificationTime(new Date('2026-11-01T08:07:00').getTime(), now)).toBe('11/1 08:07');
  });
});
