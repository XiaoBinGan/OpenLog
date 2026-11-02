/**
 * NotificationCenter — 顶部铃铛 + 右侧通知列表抽屉。
 *
 * 用户需求：
 *   「提示放到列表中，列表默认隐藏在最右边；顶上加个铃铛和小红点代表有未处理的内容；
 *     点击铃铛可以列表消失在右侧；图标就放到顶部磁盘的右侧，仅有图标即可不要文字；
 *     现在的提示框默认弹出 2 秒没操作就进提示列表中去；
 *     支持全选忽略；支持全选删除；
 *     点击对应的错误就跳转对应的容器列表中的容器查看」
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Bell, X, CheckCircle, AlertCircle, Info, AlertTriangle,
  BellOff, Trash2, CheckCheck,
} from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import { formatNotificationTime, type NotificationItem } from '../utils/notifications';

const ICON = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
} as const;

const TONE = {
  success: 'text-green-400',
  error: 'text-red-400',
  info: 'text-blue-400',
  warning: 'text-yellow-400',
} as const;

export default function NotificationCenter() {
  const {
    notifications, unread, markAllRead,
    ignoreNotifications, deleteNotifications, clearNotifications,
  } = useToast();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // 打开抽屉时：标记已读 + 选中态清空
  useEffect(() => {
    if (open) {
      markAllRead();
      setSelected(new Set());
    }
  }, [open, markAllRead]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const allSelected = notifications.length > 0 && selected.size === notifications.length;

  const toggleOne = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected(prev => (prev.size === notifications.length ? new Set() : new Set(notifications.map(n => n.id))));
  }, [notifications]);

  /** 点一条通知：有 nav 就跳转（例如直接打开对应容器的日志），然后收起抽屉 */
  const openItem = (n: NotificationItem) => {
    if (!n.nav) return;
    navigate(n.nav);
    setOpen(false);
  };

  const handleIgnore = () => {
    const ids = selected.size > 0 ? [...selected] : notifications.map(n => n.id);
    ignoreNotifications(ids);
    setSelected(new Set());
  };
  const handleDelete = () => {
    const ids = selected.size > 0 ? [...selected] : notifications.map(n => n.id);
    deleteNotifications(ids);
    setSelected(new Set());
  };

  return (
    <>
      {/* 铃铛按钮（放顶栏磁盘右侧，仅图标） */}
      <div className="relative">
        <button
          onClick={() => setOpen(v => !v)}
          title={unread > 0 ? `${unread} 条未处理通知` : '通知'}
          className={`relative p-1.5 rounded-lg transition-colors ${
            open ? 'bg-dark-800 text-accent-400' : 'text-dark-400 hover:text-dark-200 hover:bg-dark-800'
          }`}
        >
          <Bell className="w-4 h-4" />
          {unread > 0 && (
            // 只要一个小红点（用户要求「小红点代表有未处理的内容」），数量在抽屉标题里看
            <span
              className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-dark-950"
              aria-label={`${unread} 条未读`}
            />
          )}
        </button>
      </div>

      {/* 右侧抽屉 + 遮罩。
          portal 到 body：顶栏有 backdrop-blur（backdrop-filter 会成为 fixed 的包含块），
          不 portal 的话抽屉会被压缩成顶栏那么高。 */}
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[90] bg-black/40" onClick={() => setOpen(false)} />
          <div
            ref={panelRef}
            className="fixed right-0 top-0 bottom-0 z-[95] w-96 max-w-[92vw] flex flex-col bg-dark-900 border-l border-dark-800 shadow-2xl animate-slide-in"
          >
            {/* 头部 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-accent-400" />
                <span className="text-sm font-semibold text-dark-100">通知</span>
                <span className="text-xs text-dark-500">{notifications.length} 条</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-200 transition-colors"
                title="收起（Esc）"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 批量操作 */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-dark-800 flex-shrink-0 text-xs">
              <label className="flex items-center gap-1.5 text-dark-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={notifications.length === 0}
                  className="accent-accent-500"
                />
                全选{selected.size > 0 ? `（${selected.size}）` : ''}
              </label>
              <div className="flex-1" />
              <button
                onClick={handleIgnore}
                disabled={notifications.length === 0}
                title="忽略选中的通知（同类告警 10 分钟内不再提醒）"
                className="flex items-center gap-1 px-2 py-1 rounded border border-dark-700 text-dark-300 hover:text-yellow-300 hover:border-yellow-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <BellOff className="w-3 h-3" /> 忽略
              </button>
              <button
                onClick={handleDelete}
                disabled={notifications.length === 0}
                title="删除选中的通知"
                className="flex items-center gap-1 px-2 py-1 rounded border border-dark-700 text-dark-300 hover:text-red-300 hover:border-red-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Trash2 className="w-3 h-3" /> 删除
              </button>
              <button
                onClick={() => { clearNotifications(); setSelected(new Set()); }}
                disabled={notifications.length === 0}
                title="全部清空"
                className="p-1 rounded border border-dark-700 text-dark-400 hover:text-red-300 hover:border-red-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <CheckCheck className="w-3 h-3" />
              </button>
            </div>

            {/* 列表 */}
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-dark-600">
                  <Bell className="w-10 h-10 mb-3 opacity-20" />
                  <p className="text-sm">没有通知</p>
                  <p className="text-xs mt-1 text-dark-700">告警和提示会在这里汇总</p>
                </div>
              ) : (
                notifications.map(n => {
                  const Icon = ICON[n.type] || Info;
                  const isSel = selected.has(n.id);
                  return (
                    <div
                      key={n.id}
                      className={`flex items-start gap-2 px-3 py-2.5 border-b border-dark-800/60 transition-colors ${
                        isSel ? 'bg-accent-500/10' : 'hover:bg-dark-800/50'
                      } ${n.nav ? 'cursor-pointer' : ''}`}
                      onClick={() => openItem(n)}
                    >
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleOne(n.id)}
                        onClick={e => e.stopPropagation()}
                        className="mt-1 accent-accent-500 flex-shrink-0"
                      />
                      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${TONE[n.type] || TONE.info}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <div className="text-xs font-medium text-dark-200 break-words flex-1">{n.message}</div>
                          <span className="text-[10px] text-dark-600 flex-shrink-0 mt-0.5">{formatNotificationTime(n.ts)}</span>
                        </div>
                        {n.description && (
                          <div className="text-[11px] text-dark-500 font-mono break-all line-clamp-2 mt-0.5">{n.description}</div>
                        )}
                        {n.nav && (
                          <div className="text-[10px] text-accent-400/80 mt-1">点击查看该容器 →</div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* 底部说明 */}
            <div className="px-4 py-2 border-t border-dark-800 text-[10px] text-dark-600 flex-shrink-0">
              提示弹出 2 秒后自动收进这里；点带「查看该容器」的条目可直接跳到对应容器。
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
