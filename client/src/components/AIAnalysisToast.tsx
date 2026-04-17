import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, AlertTriangle, CheckCircle, XCircle, X, Loader, ChevronRight, Send, BookOpen } from 'lucide-react';

interface AIAnalysisToastProps {
  wsRef: React.RefObject<WebSocket | null>;
  onViewLogs: () => void;
}

interface ToastData {
  id: string;
  status: 'pending' | 'done' | 'error' | 'skipped';
  log?: any;
  analysis?: string;
  message?: string;
  ts: number;
  sourceId?: string;
}

interface AssistantTip {
  id: string;
  preview: string;
  tab?: 'ops' | 'docs';
  ts: number;
}

export default function AIAnalysisToast({ wsRef, onViewLogs }: AIAnalysisToastProps) {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [assistantTips, setAssistantTips] = useState<AssistantTip[]>([]);
  const prevToasts = useRef<Map<string, ToastData>>(new Map());
  const navigate = useNavigate();

  // 监听所有助手回答完成事件
  useEffect(() => {
    const handler = (e: CustomEvent<AssistantTip>) => {
      const tip = e.detail;
      setAssistantTips(prev => [tip, ...prev].slice(0, 5));
      setTimeout(() => {
        setAssistantTips(prev => prev.filter(t => t.id !== tip.id));
      }, 10000);
    };
    window.addEventListener('assistant-tip', handler as EventListener);
    return () => window.removeEventListener('assistant-tip', handler as EventListener);
  }, []);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type !== 'ai_analysis') return;
      const toast: ToastData = {
        id: `${Date.now()}-${Math.random()}`,
        status: data.status,
        log: data.log,
        analysis: data.analysis,
        message: data.message,
        ts: Date.now(),
      };
      setToasts(prev => [toast, ...prev].slice(0, 10));
      prevToasts.current.set(toast.id, toast);
      const ttl = toast.status === 'pending' ? 60_000 : 30_000;
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toast.id)), ttl);
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [wsRef]);

  const dismiss = (id: string) => setToasts(prev => prev.filter(t => t.id !== id));

  const goToAssistant = (tab?: string) => {
    if (tab === 'docs') navigate('/dev-assistant');
    else navigate('/assistant');
  };

  if (toasts.length === 0 && assistantTips.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md">
      {/* 助手回答完成通知 */}
      {assistantTips.map((tip) => (
        <div
          key={tip.id}
          className="glass rounded-xl border border-accent-500/60 shadow-2xl shadow-black/40 animate-scale-in overflow-hidden"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="p-1.5 rounded-lg bg-accent-500/20 flex-shrink-0">
              {tip.tab === 'docs'
                ? <BookOpen className="w-4 h-4 text-accent-400" />
                : <Send className="w-4 h-4 text-accent-400" />
              }
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-dark-100">
                  {tip.tab === 'docs' ? '📖 文档助手' : '💬 运维助手'}
                </span>
                <span className="text-xs text-dark-600">回答完成</span>
              </div>
              <div className="text-xs text-dark-400 truncate mt-0.5">{tip.preview}…</div>
            </div>
            <button
              onClick={() => goToAssistant(tip.tab)}
              className="flex-shrink-0 px-2.5 py-1 rounded-lg bg-accent-500/20 text-accent-400 text-xs font-medium hover:bg-accent-500/30 transition-colors"
            >
              去查看
            </button>
            <button
              onClick={() => setAssistantTips(prev => prev.filter(t => t.id !== tip.id))}
              className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-dark-200 transition-colors flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      {/* AI 分析通知（ERROR 日志分析结果） */}
      {toasts.map((toast) => {
        const borderColor =
          toast.status === 'pending' ? 'border-yellow-500/50' :
          toast.status === 'error' ? 'border-red-500/50' :
          toast.status === 'skipped' ? 'border-yellow-400/40' :
          'border-accent-500/60';
        const Icon = toast.status === 'pending' ? Loader
          : toast.status === 'error' ? XCircle
          : toast.status === 'skipped' ? AlertTriangle
          : Brain;
        const iconCls = toast.status === 'pending' ? 'text-yellow-400 animate-spin'
          : toast.status === 'error' ? 'text-red-400'
          : toast.status === 'skipped' ? 'text-yellow-400'
          : 'text-accent-400';

        return (
          <div
            key={toast.id}
            className={`glass rounded-xl border ${borderColor} shadow-2xl shadow-black/40 animate-scale-in overflow-hidden`}
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <Icon className={`w-4 h-4 flex-shrink-0 ${iconCls}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-dark-100">
                  {toast.status === 'pending' && `🤖 ${toast.log?.source?.split('/')[0] || 'AI'} 正在分析...`}
                  {toast.status === 'done' && `✅ ${toast.log?.source?.split('/')[0] || 'AI'} 分析完成`}
                  {toast.status === 'error' && `❌ 分析失败`}
                  {toast.status === 'skipped' && `⚠️ 跳过分析`}
                </div>
                {toast.log && (
                  <div className="text-xs text-dark-400 truncate mt-0.5 font-mono">
                    {toast.sourceId && toast.sourceId !== 'default' && (
                      <span className="text-accent-400 mr-1">[{toast.sourceId}] </span>
                    )}
                    {toast.log.message?.slice(0, 60)}...
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {toast.status === 'done' && (
                  <button onClick={onViewLogs} className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-400 hover:text-accent-400 transition-colors" title="查看日志">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                )}
                <button onClick={() => dismiss(toast.id)} className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-dark-200 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {toast.status === 'done' && toast.analysis && (
              <div className="px-4 pb-4">
                <button onClick={() => setExpanded(expanded === toast.id ? null : toast.id)} className="w-full text-left">
                  <div className="text-xs text-accent-400 mb-2 flex items-center justify-between">
                    <span>📋 AI 分析结果</span>
                    <span>{expanded === toast.id ? '▲ 收起' : '▼ 展开'}</span>
                  </div>
                </button>
                {expanded === toast.id && (
                  <div
                    className="text-sm text-dark-200 leading-relaxed max-h-64 overflow-y-auto
                      [&_h2]:text-dark-100 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-1
                      [&_h3]:text-dark-200 [&_h3]:text-xs [&_h3]:font-semibold
                      [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
                      [&_li]:text-dark-300 [&_li]:text-xs [&_li]:ml-3"
                    dangerouslySetInnerHTML={{ __html: toMarkdownHtml(toast.analysis) }}
                  />
                )}
              </div>
            )}
            {toast.message && (
              <div className="px-4 pb-3 text-xs text-dark-400">{toast.message}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function toMarkdownHtml(md: string): string {
  return md
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
    .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
    .replace(/\n\n+/g, '</p><p>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^(?!<[hupul])/gm, '')
    .replace(/^(.+)$/gm, (line) => line.startsWith('<') ? line : `<p>${line}</p>`);
}
