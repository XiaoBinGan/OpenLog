import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import {
  mergeNotification, removeNotifications, markAllRead as markAllReadPure,
  unreadCount as unreadCountPure, recordIgnored, pruneIgnored, isSuppressed,
  newNotificationId, type NotificationItem,
} from '../utils/notifications';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  action?: ToastAction;
  persistent?: boolean; // 兼容旧调用：现在所有提示 2s 后都会进通知列表
  group?: string;       // 同类去重：同 group 只保留一条
  description?: string; // 第二行详情（错误日志原文、影响范围等）
  /** 点这条通知跳转到哪（如 /docker?sourceId=..&containerId=..&openLog=1） */
  nav?: string;
}

interface ToastMsg {
  id: string;
  type: ToastType;
  message: string;
  description?: string;
  action?: ToastAction;
  persistent?: boolean;
  group?: string;
  nav?: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string, opts?: ToastOptions) => void;
  success: (message: string, opts?: ToastOptions) => void;
  error: (message: string, opts?: ToastOptions) => void;
  info: (message: string, opts?: ToastOptions) => void;
  warning: (message: string, opts?: ToastOptions) => void;
  // ── 通知中心（铃铛 + 右侧列表）──
  notifications: NotificationItem[];
  unread: number;
  markAllRead: () => void;
  /** 忽略选中：移除并抑制同 group 的重复提醒一段时间 */
  ignoreNotifications: (ids: string[]) => void;
  /** 删除选中：直接从列表移除 */
  deleteNotifications: (ids: string[]) => void;
  clearNotifications: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const iconMap = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const colorMap = {
  success: 'border-green-500/30 bg-green-500/10 text-green-400',
  error: 'border-red-500/30 bg-red-500/10 text-red-400',
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  warning: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400',
};

/** 提示在屏幕上停留多久（用户要求 2 秒后自动进通知列表） */
const TOAST_VISIBLE_MS = 2000;

const NOTIF_STORAGE_KEY = 'openlog_notifications_v1';
const IGNORED_STORAGE_KEY = 'openlog_notifications_ignored_v1';

function loadNotifs(): NotificationItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIF_STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(n => n && typeof n.id === 'string') : [];
  } catch { return []; }
}
function loadIgnored(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(IGNORED_STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  /** toasts 的镜像：addToast 里需要同步判断「同 group 是否已存在」 */
  const toastsRef = useRef<ToastMsg[]>([]);
  useEffect(() => { toastsRef.current = toasts; }, [toasts]);
  const [notifications, setNotifications] = useState<NotificationItem[]>(() => loadNotifs());
  // 忽略抑制：group -> 到期时间戳
  const ignoredRef = useRef<Record<string, number>>(pruneIgnored(loadIgnored(), Date.now()));
  /** 每条 toast 的自动收起定时器（按 toast id 存） */
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 助手页底部是输入区 + 上下文用量条，toast 需要上移才不会压住它们
  const routeLocation = useLocation();
  const onAssistantPage = routeLocation.pathname === '/assistant';

  // 落盘：刷新页面后通知还在
  useEffect(() => {
    try { localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(notifications.slice(0, 200))); } catch { /* ignore */ }
  }, [notifications]);

  /** 把一条 toast 收进右侧通知列表 */
  const pushToNotifications = useCallback((msg: ToastMsg, ts: number) => {
    setNotifications(prev => mergeNotification(prev, {
      id: newNotificationId(ts),
      type: msg.type,
      message: msg.message,
      description: msg.description,
      ts,
      read: false,
      nav: msg.nav,
      group: msg.group,
    }));
  }, []);

  /** 立刻移除 toast（并取消它的自动收起定时器） */
  const dropToast = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t) { clearTimeout(t); timersRef.current.delete(id); }
    toastsRef.current = toastsRef.current.filter(x => x.id !== id);
    setToasts(prev => prev.filter(x => x.id !== id));
  }, []);

  const addToast = useCallback((type: ToastType, message: string, opts?: ToastOptions) => {
    const group = opts?.group;
    const now = Date.now();
    // 刚被「忽略」过的同类告警：抑制期内不再弹、也不进列表
    if (isSuppressed(ignoredRef.current, group, now)) return;

    const description = opts?.description;
    const action = opts?.action;
    const nav = opts?.nav;
    const persistent = false; // 统一 2s 后进列表

    // 同 group 合并：复用旧卡片，重置计时
    const existing = group ? toastsRef.current.find(t => t.group === group) : undefined;
    const id = existing
      ? existing.id
      : `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (existing) {
      setToasts(prev => prev.map(t => (t.id !== id ? t : {
        ...t, type, message, description: description ?? t.description, action: action || t.action, nav: nav || t.nav,
      })));
      toastsRef.current = toastsRef.current.map(t => (t.id !== id ? t : {
        ...t, type, message, description: description ?? t.description, action: action || t.action, nav: nav || t.nav,
      }));
    } else {
      const created: ToastMsg = { id, type, message, description, action, persistent, group, nav };
      toastsRef.current = [...toastsRef.current, created];
      setToasts(prev => [...prev, created]);
    }

    // 重置「2 秒后进列表」的计时（同 group 合并时也重新计时）
    const prevTimer = timersRef.current.get(id);
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      toastsRef.current = toastsRef.current.filter(t => t.id !== id);
      setToasts(prev => prev.filter(t => t.id !== id));
      pushToNotifications({
        id, type, message, description, action, persistent, group, nav,
      }, Date.now());
    }, TOAST_VISIBLE_MS);
    timersRef.current.set(id, timer);
  }, [pushToNotifications]);

  // 卸载时清掉定时器
  useEffect(() => () => {
    for (const t of timersRef.current.values()) clearTimeout(t);
    timersRef.current.clear();
  }, []);

  const success = useCallback((msg: string, opts?: ToastOptions) => addToast('success', msg, opts), [addToast]);
  const error = useCallback((msg: string, opts?: ToastOptions) => addToast('error', msg, opts), [addToast]);
  const info = useCallback((msg: string, opts?: ToastOptions) => addToast('info', msg, opts), [addToast]);
  const warning = useCallback((msg: string, opts?: ToastOptions) => addToast('warning', msg, opts), [addToast]);

  // ── 通知列表操作 ──
  const markAllRead = useCallback(() => {
    setNotifications(prev => markAllReadPure(prev));
  }, []);

  const ignoreNotifications = useCallback((ids: string[]) => {
    setNotifications(prev => {
      const picked = prev.filter(n => ids.includes(n.id));
      ignoredRef.current = pruneIgnored(
        recordIgnored(ignoredRef.current, picked, Date.now()),
        Date.now(),
      );
      try { localStorage.setItem(IGNORED_STORAGE_KEY, JSON.stringify(ignoredRef.current)); } catch { /* ignore */ }
      return removeNotifications(prev, ids);
    });
  }, []);

  const deleteNotifications = useCallback((ids: string[]) => {
    setNotifications(prev => removeNotifications(prev, ids));
  }, []);

  const clearNotifications = useCallback(() => setNotifications([]), []);

  const unread = unreadCountPure(notifications);

  return (
    <ToastContext.Provider value={{
      toast: addToast, success, error, info, warning,
      notifications, unread, markAllRead, ignoreNotifications, deleteNotifications, clearNotifications,
    }}>
      {children}
      {/* Toast 容器：只负责「刚发生 2 秒内」的闪现，之后进右侧通知列表 */}
      <div className={`pointer-events-none fixed z-[9999] flex gap-2 ${onAssistantPage ? 'bottom-6 left-6 flex-col' : 'bottom-6 right-6 flex-col-reverse'}`}>
        {toasts.map(t => {
          const Icon = iconMap[t.type];
          return (
            <div
              key={t.id}
              className={`flex items-start gap-2.5 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-xl animate-slide-in pointer-events-auto group max-w-md ${colorMap[t.type]}`}
            >
              <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium break-words">{t.message}</div>
                {t.description && (
                  <div className="text-xs opacity-75 mt-0.5 font-mono break-all line-clamp-3">{t.description}</div>
                )}
              </div>
              {t.action && (
                <button
                  onClick={() => {
                    t.action!.onClick();
                    dropToast(t.id);
                  }}
                  className="ml-1 mt-0.5 px-2.5 py-1 text-xs rounded-lg border border-current/30 hover:bg-white/10 transition-colors font-medium whitespace-nowrap flex-shrink-0"
                >
                  {t.action.label}
                </button>
              )}
              {/* 手动关掉 = 已看过，不再进通知列表 */}
              <button
                onClick={() => dropToast(t.id)}
                className="ml-1 mt-0.5 p-0.5 rounded hover:bg-white/10 transition-colors flex-shrink-0 opacity-60 group-hover:opacity-100"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
