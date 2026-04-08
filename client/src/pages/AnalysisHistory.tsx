import { useState, useEffect } from 'react';
import {
  History,
  Brain,
  Filter,
  Trash2,
  ChevronRight,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Search,
  Server
} from 'lucide-react';

interface AnalysisRecord {
  id: string;
  timestamp: string;
  sourceId: string;
  sourceName: string;
  log: { id: string; timestamp: string; level: string; message: string; source: string };
  analysis: string | null;
  status: 'done' | 'error';
  error?: string;
  model: string;
}

export default function AnalysisHistory() {
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ sourceId: string; status: string }>({ sourceId: '', status: '' });
  const [search, setSearch] = useState('');

  const loadHistory = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter.sourceId) params.set('sourceId', filter.sourceId);
      if (filter.status) params.set('status', filter.status);
      params.set('limit', '100');

      const res = await fetch(`/api/analysis/history?${params}`);
      const data = await res.json();
      let result = data.records || [];
      if (search) {
        const q = search.toLowerCase();
        result = result.filter((r: AnalysisRecord) =>
          r.log?.message?.toLowerCase().includes(q) ||
          r.analysis?.toLowerCase().includes(q) ||
          r.sourceName?.toLowerCase().includes(q)
        );
      }
      setRecords(result);
      setTotal(data.total);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
    setLoading(false);
  };

  useEffect(() => { loadHistory(); }, [filter]);

  const deleteRecord = async (id: string) => {
    await fetch(`/api/analysis/history/${id}`, { method: 'DELETE' });
    loadHistory();
  };

  const clearAll = async () => {
    if (!confirm('确认清空所有分析历史？')) return;
    await fetch('/api/analysis/history', { method: 'DELETE' });
    loadHistory();
  };

  const statusIcon = (status: string) => {
    if (status === 'done') return <CheckCircle className="w-4 h-4 text-green-400" />;
    return <XCircle className="w-4 h-4 text-red-400" />;
  };

  const statusBadge = (status: string) => {
    if (status === 'done') return 'bg-green-500/15 text-green-400 border-green-500/30';
    return 'bg-red-500/15 text-red-400 border-red-500/30';
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-purple-500/20">
            <History className="w-6 h-6 text-purple-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-dark-100">分析历史</h1>
            <p className="text-xs text-dark-500">共 {total} 条记录</p>
          </div>
        </div>
        {records.length > 0 && (
          <button
            onClick={clearAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            清空
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadHistory()}
            placeholder="搜索日志或分析内容..."
            className="w-full pl-9 pr-3 py-2 bg-dark-900 border border-dark-800 rounded-lg text-sm text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50"
          />
        </div>
        <select
          value={filter.status}
          onChange={e => setFilter({ ...filter, status: e.target.value })}
          className="px-3 py-2 bg-dark-900 border border-dark-800 rounded-lg text-sm text-dark-300 focus:outline-none focus:border-accent-500/50"
        >
          <option value="">全部状态</option>
          <option value="done">成功</option>
          <option value="error">失败</option>
        </select>
      </div>

      {/* Records list */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-dark-500">
          <div className="animate-spin w-5 h-5 border-2 border-accent-500 border-t-transparent rounded-full mr-3" />
          加载中...
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-dark-500">
          <Brain className="w-12 h-12 mb-4 opacity-30" />
          <p className="text-sm">暂无分析记录</p>
          <p className="text-xs mt-1 text-dark-600">ERROR 日志出现时自动触发分析后，记录会显示在这里</p>
        </div>
      ) : (
        <div className="space-y-2">
          {records.map((record) => (
            <div
              key={record.id}
              className="glass rounded-xl border border-dark-800 overflow-hidden transition-all duration-200 hover:border-dark-700"
            >
              {/* Record header */}
              <button
                onClick={() => setExpanded(expanded === record.id ? null : record.id)}
                className="w-full px-4 py-3 flex items-center gap-3 text-left"
              >
                {statusIcon(record.status)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-dark-200 truncate max-w-md">
                      {record.log?.message?.slice(0, 80)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-dark-500 flex items-center gap-1">
                      <Server className="w-3 h-3" />
                      {record.sourceName}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${statusBadge(record.status)}`}>
                      {record.status === 'done' ? '完成' : '失败'}
                    </span>
                    <span className="text-xs text-dark-600 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatTime(record.timestamp)}
                    </span>
                    {record.model && (
                      <span className="text-xs text-dark-600">{record.model}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={e => { e.stopPropagation(); deleteRecord(record.id); }}
                    className="p-1.5 rounded hover:bg-red-500/10 text-dark-600 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <ChevronRight className={`w-4 h-4 text-dark-500 transition-transform ${expanded === record.id ? 'rotate-90' : ''}`} />
                </div>
              </button>

              {/* Expanded content */}
              {expanded === record.id && (
                <div className="px-4 pb-4 border-t border-dark-800">
                  {/* Original log */}
                  <div className="mt-3 mb-3">
                    <p className="text-xs text-dark-500 mb-1">原始日志</p>
                    <pre className="px-3 py-2 bg-dark-900 rounded-lg text-xs text-dark-300 font-mono overflow-x-auto whitespace-pre-wrap">
                      {record.log?.message}
                    </pre>
                  </div>
                  {/* Analysis result */}
                  {record.status === 'done' && record.analysis ? (
                    <div>
                      <p className="text-xs text-dark-500 mb-1">AI 分析结果</p>
                      <div
                        className="px-3 py-3 bg-dark-900 rounded-lg text-sm text-dark-200 leading-relaxed prose-invert max-h-96 overflow-y-auto
                          [&_h2]:text-dark-100 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-1
                          [&_h3]:text-dark-200 [&_h3]:text-xs [&_h3]:font-semibold
                          [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
                          [&_li]:text-dark-300 [&_li]:text-xs [&_li]:ml-3"
                        dangerouslySetInnerHTML={{ __html: simpleMarkdown(record.analysis) }}
                      />
                    </div>
                  ) : record.error ? (
                    <div>
                      <p className="text-xs text-dark-500 mb-1">错误信息</p>
                      <pre className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 font-mono">
                        {record.error}
                      </pre>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
    .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');
}
