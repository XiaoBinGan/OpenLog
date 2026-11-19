/**
 * Pod 日志抽屉（GET /api/k8s/clusters/:id/pods/:ns/:pod/logs?tail=200）。
 *
 * 为什么做成抽屉而不是新页面：看日志是「对照着 Pod 列表排查」的动作，
 * 跳走会丢掉过滤条件。抽屉自己持有一份 logs/loading/error，
 * 切换 Pod 时由父页面换 key（组件重挂载）保证不会串台。
 */

import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Copy, Loader, RefreshCw, ScrollText, X } from 'lucide-react';
import { apiFetch } from '../../api/client';
import type { K8sLogTarget, K8sLogsResponse } from './types';
import { LOG_TAIL, errorText, podLogsPath } from './utils';

interface LogDrawerProps {
  clusterId: string;
  target: K8sLogTarget;
  onClose: () => void;
}

function LogDrawer({ clusterId, target, onClose }: LogDrawerProps) {
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<K8sLogsResponse>(podLogsPath(clusterId, target, LOG_TAIL));
      setLogs(typeof data?.logs === 'string' ? data.logs : '');
      setFetchedAt(Date.now());
    } catch (e) {
      setError(errorText(e));
      setLogs('');
    } finally {
      setLoading(false);
    }
  }, [clusterId, target]);

  useEffect(() => {
    void load();
  }, [load]);

  // Esc 关闭
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const copy = useCallback(() => {
    if (!logs) return;
    void (async () => {
      try {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(logs);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      } catch {
        // 剪贴板被浏览器拒绝时静默失败：用户仍然可以手动选中复制
      }
    })();
  }, [logs]);

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-2xl glass border-l border-dark-800/80 shadow-2xl flex flex-col">
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-dark-800/60">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ScrollText className="w-4 h-4 text-accent-400 flex-shrink-0" />
              <h2 className="text-sm font-semibold text-dark-100 truncate" title={target.pod}>
                {target.pod}
              </h2>
            </div>
            <p className="text-[11px] text-dark-500 mt-0.5">
              {target.namespace} · 最近 {LOG_TAIL} 行
              {fetchedAt ? ` · ${new Date(fetchedAt).toLocaleTimeString()}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={copy}
              disabled={!logs}
              title="复制日志"
              className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-800 transition-colors disabled:opacity-40"
            >
              <Copy className="w-4 h-4" />
            </button>
            <button
              onClick={() => void load()}
              disabled={loading}
              title="重新拉取"
              className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-800 transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              title="关闭"
              className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {copied && <div className="px-4 py-1 text-[11px] text-emerald-400 border-b border-dark-800/60">已复制到剪贴板</div>}

        <div className="flex-1 min-h-0 overflow-auto p-4 bg-dark-950/40">
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <CircleAlert className="w-3.5 h-3.5 mt-px flex-shrink-0" />
              <div className="min-w-0">
                <div className="break-words">{error}</div>
                <button onClick={() => void load()} className="mt-2 text-xs text-red-200 underline">
                  重新拉取
                </button>
              </div>
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 text-xs text-dark-500">
              <Loader className="w-4 h-4 animate-spin text-accent-400" />
              正在读取日志…
            </div>
          ) : logs.trim() ? (
            <pre className="text-xs font-mono leading-relaxed text-dark-300 whitespace-pre-wrap break-all">
              {logs}
            </pre>
          ) : (
            <div className="text-xs text-dark-500">这个 Pod 最近没有日志输出</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default LogDrawer;