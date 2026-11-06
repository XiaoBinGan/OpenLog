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
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Bell, X, CheckCircle, AlertCircle, Info, AlertTriangle,
  BellOff, Trash2, CheckCheck, Download, FileText, FileSpreadsheet, ChevronDown,
  Search, Filter,
} from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import {
  formatNotificationTime, filterNotifications, listNotificationSources, isFilterActive,
  EMPTY_NOTIFICATION_FILTER, type NotificationItem, type NotificationFilter,
} from '../utils/notifications';
import { toMarkdown, toXlsx, exportFileName } from '../utils/notifyExport';

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

/** 触发浏览器下载 */
function downloadBlob(name: string, data: string | Uint8Array, mime: string) {
  const part: BlobPart = typeof data === 'string' ? data : (data as unknown as BlobPart);
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

export default function NotificationCenter() {
  const {
    notifications, unread, markAllRead,
    ignoreNotifications, deleteNotifications, clearNotifications,
    error: toastError, warning: toastWarning,
  } = useToast();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>(EMPTY_NOTIFICATION_FILTER);
  const [searchOpen, setSearchOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // 打开抽屉：清空选中与筛选（每次打开都是完整列表）；关闭时才把「未读」清掉，
  // 这样「只看未读」筛选在打开期间才有意义，同时关掉抽屉后小红点也会消失。
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setFilter(EMPTY_NOTIFICATION_FILTER);
      setSearchOpen(false);
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      markAllRead();
    }
  }, [open, markAllRead]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /** 筛选后的列表（导出/全选/批量操作都以它为准） */
  const filteredNotifications = useMemo(
    () => filterNotifications(notifications, filter),
    [notifications, filter],
  );
  const sources = useMemo(() => listNotificationSources(notifications), [notifications]);
  const filterActive = isFilterActive(filter);
  const filteredUnread = filteredNotifications.filter(n => !n.read).length;

  const allSelected = filteredNotifications.length > 0 && selected.size === filteredNotifications.length;

  const toggleOne = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected(prev => (prev.size === filteredNotifications.length ? new Set() : new Set(filteredNotifications.map(n => n.id))));
  }, [filteredNotifications]);

  /** 点一条通知：有 nav 就跳转（例如直接打开对应容器的日志），然后收起抽屉 */
  const openItem = (n: NotificationItem) => {
    if (!n.nav) return;
    navigate(n.nav);
    setOpen(false);
  };

  const handleIgnore = () => {
    const ids = selected.size > 0 ? [...selected] : filteredNotifications.map(n => n.id);
    ignoreNotifications(ids);
    setSelected(new Set());
  };
  const handleDelete = () => {
    const ids = selected.size > 0 ? [...selected] : filteredNotifications.map(n => n.id);
    deleteNotifications(ids);
    setSelected(new Set());
  };

  /**
   * 导出：默认导出「筛选后的全部」；有勾选就只导选中的。
   * Markdown 给程序员直接贴 issue/发给同事；Excel 给需要筛选/统计的场景。
   */
  const handleExport = (format: 'md' | 'xlsx') => {
    const items = selected.size > 0
      ? filteredNotifications.filter(n => selected.has(n.id))
      : filteredNotifications;
    if (items.length === 0) {
      toastWarning('没有可导出的通知');
      return;
    }
    const name = exportFileName(format);
    try {
      if (format === 'md') {
        downloadBlob(name, toMarkdown(items), 'text/markdown;charset=utf-8');
      } else {
        const bytes = toXlsx(items);
        downloadBlob(name, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      }
      setExportOpen(false);
    } catch (e) {
      // 以前只 console.error → 用户看到的就是「点了没反应」。
      // 现在必须在界面上说清楚，否则根本不知道是失败了。
      const msg = e instanceof Error ? e.message : String(e);
      console.error('导出通知失败', e);
      toastError(`导出失败：${msg}`);
    }
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

            {/* 筛选 / 搜索：告警一多就得能快速定位（按级别/机器/未读/关键词） */}
            <div className="px-4 py-2 border-b border-dark-800 flex-shrink-0 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs">
                <div className="flex items-center gap-0.5 rounded bg-dark-800 p-0.5">
                  {([
                    ['all', '全部'],
                    ['error', '错误'],
                    ['warning', '警告'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => setFilter(f => ({ ...f, level: value }))}
                      className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                        (filter.level || 'all') === value ? 'bg-accent-500/20 text-accent-300' : 'text-dark-500 hover:text-dark-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setFilter(f => ({ ...f, unreadOnly: !f.unreadOnly }))}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] transition-colors ${
                    filter.unreadOnly
                      ? 'border-accent-500/40 bg-accent-500/10 text-accent-300'
                      : 'border-dark-700 text-dark-500 hover:text-dark-300'
                  }`}
                  title="只看未读"
                >
                  未读{filteredUnread > 0 ? ` ${filteredUnread}` : ''}
                </button>
                {sources.length > 0 && (
                  <select
                    value={filter.sourceId || ''}
                    onChange={e => setFilter(f => ({ ...f, sourceId: e.target.value }))}
                    className="min-w-0 flex-1 bg-dark-800 border border-dark-700 rounded px-1.5 py-0.5 text-[11px] text-dark-300 outline-none"
                    title="按机器筛选"
                  >
                    <option value="">全部机器</option>
                    {sources.map(s => (
                      <option key={s.sourceId} value={s.sourceId}>{s.sourceName}（{s.count}）</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => setSearchOpen(v => !v)}
                  className={`p-1 rounded border transition-colors ${searchOpen || filter.query
                    ? 'border-accent-500/40 bg-accent-500/10 text-accent-300'
                    : 'border-dark-700 text-dark-500 hover:text-dark-300'}`}
                  title="搜索（报错内容/容器名）"
                >
                  <Search className="w-3 h-3" />
                </button>
              </div>
              {searchOpen && (
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={filter.query || ''}
                    onChange={e => setFilter(f => ({ ...f, query: e.target.value }))}
                    placeholder="搜报错内容 / 容器名 / 机器名"
                    className="flex-1 min-w-0 bg-dark-800 border border-dark-700 rounded px-2 py-1 text-[11px] text-dark-200 placeholder:text-dark-600 outline-none focus:border-accent-500/50"
                  />
                  {filterActive && (
                    <button
                      onClick={() => { setFilter(EMPTY_NOTIFICATION_FILTER); setSearchOpen(false); }}
                      className="flex items-center gap-1 px-1.5 py-1 rounded border border-dark-700 text-[11px] text-dark-500 hover:text-dark-300"
                      title="清除筛选"
                    >
                      <Filter className="w-3 h-3" /> 清除
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 批量操作 */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-dark-800 flex-shrink-0 text-xs">
              <label className="flex items-center gap-1.5 text-dark-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={filteredNotifications.length === 0}
                  className="accent-accent-500"
                />
                全选{selected.size > 0 ? `（${selected.size}）` : ''}
              </label>
              <div className="flex-1" />
              <button
                onClick={handleIgnore}
                disabled={filteredNotifications.length === 0}
                title="忽略选中的通知（同类告警 10 分钟内不再提醒）"
                className="flex items-center gap-1 px-2 py-1 rounded border border-dark-700 text-dark-300 hover:text-yellow-300 hover:border-yellow-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <BellOff className="w-3 h-3" /> 忽略
              </button>
              <button
                onClick={handleDelete}
                disabled={filteredNotifications.length === 0}
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

              {/* 导出：Markdown / Excel（给程序员直接存档或贴 issue） */}
              <div className="relative">
                <button
                  onClick={() => setExportOpen(v => !v)}
                  disabled={filteredNotifications.length === 0}
                  title="导出通知（选中的就只导选中的，没选就导当前筛选结果）"
                  className={`flex items-center gap-1 px-2 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    exportOpen
                      ? 'border-accent-500/40 bg-accent-500/10 text-accent-300'
                      : 'border-dark-700 text-dark-300 hover:text-accent-300 hover:border-accent-500/40'
                  }`}
                >
                  <Download className="w-3 h-3" /> 导出
                  <ChevronDown className={`w-3 h-3 transition-transform ${exportOpen ? 'rotate-180' : ''}`} />
                </button>
                {exportOpen && (
                  <>
                    <div className="fixed inset-0 z-[96]" onClick={() => setExportOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-[97] w-56 bg-dark-900 border border-dark-700 rounded-lg shadow-2xl overflow-hidden">
                      <button
                        onClick={() => handleExport('md')}
                        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-dark-800 transition-colors"
                      >
                        <FileText className="w-4 h-4 mt-0.5 text-accent-400 flex-shrink-0" />
                        <span>
                          <span className="block text-dark-200">Markdown（.md）</span>
                          <span className="block text-[10px] text-dark-500 mt-0.5">概览表 + 逐条明细，报错内容保留原文</span>
                        </span>
                      </button>
                      <button
                        onClick={() => handleExport('xlsx')}
                        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-dark-800 transition-colors border-t border-dark-800"
                      >
                        <FileSpreadsheet className="w-4 h-4 mt-0.5 text-green-400 flex-shrink-0" />
                        <span>
                          <span className="block text-dark-200">Excel（.xlsx）</span>
                          <span className="block text-[10px] text-dark-500 mt-0.5">机器 / 容器 / 级别 / 报错内容 分列</span>
                        </span>
                      </button>
                      <div className="px-3 py-1.5 text-[10px] text-dark-600 border-t border-dark-800">
                        {selected.size > 0
                          ? `导出选中的 ${selected.size} 条`
                          : filterActive
                            ? `导出当前筛选的 ${filteredNotifications.length} 条（共 ${notifications.length} 条）`
                            : `导出全部 ${notifications.length} 条`}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* 列表 */}
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-dark-600">
                  <Bell className="w-10 h-10 mb-3 opacity-20" />
                  <p className="text-sm">没有通知</p>
                  <p className="text-xs mt-1 text-dark-700">告警和提示会在这里汇总</p>
                </div>
              ) : filteredNotifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-dark-600">
                  <Search className="w-8 h-8 mb-2 opacity-20" />
                  <p className="text-sm">没有匹配的通知</p>
                  <button
                    onClick={() => setFilter(EMPTY_NOTIFICATION_FILTER)}
                    className="text-xs mt-2 text-accent-400 hover:text-accent-300"
                  >
                    清除筛选条件
                  </button>
                </div>
              ) : (
                filteredNotifications.map(n => {
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
                        {(n.sourceName || n.containerName) && (
                          <div className="text-[10px] text-dark-600 mt-0.5 truncate">
                            {n.sourceName || n.sourceId || '未知机器'}
                            {n.containerName ? ` · ${n.containerName}` : ''}
                            {n.level ? ` · ${n.level}` : ''}
                          </div>
                        )}
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
