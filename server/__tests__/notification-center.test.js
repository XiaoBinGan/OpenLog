/**
 * server/__tests__/notification-center.test.js
 *
 * 通知中心（铃铛 + 右侧列表）的接线保护。用户要求：
 *   1. 提示放到右侧列表里，默认隐藏
 *   2. 顶栏磁盘右侧放铃铛 + 小红点（仅有图标）
 *   3. 点铃铛收起/展开右侧列表
 *   4. 提示框弹出 2 秒没操作就进提示列表
 *   5. 支持全选忽略、全选删除
 *   6. 点错误通知直接跳到对应容器（不用手选服务器）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const toast = read('client/src/contexts/ToastContext.tsx');
const bell = read('client/src/components/NotificationCenter.tsx');
const statusBar = read('client/src/components/GlobalStatusBar.tsx');
const layout = read('client/src/components/Layout.tsx');

describe('ToastContext —— 2 秒后进通知列表', () => {
  it('提示只显示 2 秒', () => {
    expect(toast).toContain('TOAST_VISIBLE_MS = 2000');
  });

  it('有通知列表 + 未读数 + 忽略/删除/清空操作', () => {
    expect(toast).toContain('notifications');
    expect(toast).toContain('unread');
    expect(toast).toContain('ignoreNotifications');
    expect(toast).toContain('deleteNotifications');
    expect(toast).toContain('clearNotifications');
  });

  it('通知持久化到 localStorage（刷新不丢）', () => {
    expect(toast).toContain("openlog_notifications_v1");
    expect(toast).toContain('localStorage.setItem');
  });

  it('忽略后同类告警抑制一段时间（不反复弹）', () => {
    expect(toast).toContain('isSuppressed');
    expect(toast).toContain('recordIgnored');
  });

  it('手动关掉 / 点操作按钮的提示不再进列表', () => {
    expect(toast).toContain('dropToast');
  });
});

describe('NotificationCenter —— 铃铛与右侧列表', () => {
  it('铃铛有未读小红点，仅有图标没有文字', () => {
    expect(bell).toContain('<Bell');
    expect(bell).toContain('unread > 0');
    expect(bell).toContain('rounded-full bg-red-500');
    // 铃铛按钮本身只有图标（抽屉标题里可以有「通知」两个字；title 提示文本不算可见文字）
    const btnStart = bell.indexOf('onClick={() => setOpen');
    const btnEnd = bell.indexOf('</button>', btnStart);
    const btnSrc = bell.slice(btnStart, btnEnd);
    expect(btnSrc).not.toContain('>通知');
    expect(btnSrc).toContain('<Bell');
  });

  it('默认隐藏，点铃铛才展开右侧抽屉（Esc/遮罩可关）', () => {
    expect(bell).toContain('useState(false)');
    expect(bell).toContain("e.key === 'Escape'");
    expect(bell).toContain('fixed right-0');
  });

  it('全选 + 忽略 + 删除 + 清空', () => {
    expect(bell).toContain('全选');
    expect(bell).toContain('ignoreNotifications');
    expect(bell).toContain('deleteNotifications');
    expect(bell).toContain('clearNotifications');
    expect(bell).toContain('toggleAll');
  });

  it('点通知跳转（有 nav 才跳）', () => {
    expect(bell).toContain('navigate(n.nav)');
    expect(bell).toContain('openItem');
  });
});

describe('顶栏与告警接线', () => {
  it('铃铛放在全局状态栏（磁盘右侧）', () => {
    expect(statusBar).toContain("import NotificationCenter from './NotificationCenter'");
    // 磁盘那一行之后就是通知铃铛
    const diskIdx = statusBar.indexOf('磁盘:');
    const bellIdx = statusBar.indexOf('<NotificationCenter />');
    expect(diskIdx).toBeGreaterThan(-1);
    expect(bellIdx).toBeGreaterThan(diskIdx);
  });

  it('容器类告警带上「直达该容器」的 nav', () => {
    expect(layout).toContain('dockerContainerLink');
    expect(layout).toContain('nav: containerId ? dockerContainerLink(sourceId, containerId) : undefined');
    expect(layout).toContain('nav: link');
  });
});