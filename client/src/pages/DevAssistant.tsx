import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send, Bot, User, Square, Loader, FileText, Upload,
  RefreshCw, Trash, BookOpen, X, CheckCircle, Clock,
  AlertCircle, Terminal, Plus, ChevronDown, MessageSquare,
} from 'lucide-react';
import { useAssistantContext } from '../contexts/AssistantContext';
import { docmind, DocDocument } from '../lib/docmind';

// 文档助手快捷提示
const DOC_QUICK_PROMPTS = [
  '这篇文档的核心内容是什么？',
  '文档中提到的关键技术方案是什么？',
  '文档的主要结论和建议有哪些？',
  '有哪些表格或分类需要特别注意？',
  '总结前 5 页的核心要点',
];

function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g,
    '<pre><code class="language-$1">' + '$2' + '</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/^\|(.+)\|$/gm, (_: string, cols: string) => {
    const cells = cols.split('|').map((c: string) => c.trim());
    return '<tr>' + cells.map((c: string) => `<td>${c}</td>`).join('') + '</tr>';
  });
  if (/<tr>.*<\/tr>/.test(html)) {
    html = html.replace(/(<tr>.*<\/tr>)+/g, '<table>$&</table>');
  }
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br/>');
  return `<p>${html}</p>`;
}

function StatusBadge({ status }: { status: DocDocument['index_status'] }) {
  const map: Record<string, { icon: React.ReactNode; label: string; cls: string }> = {
    ready: { icon: <CheckCircle className="w-3.5 h-3.5" />, label: '就绪', cls: 'text-green-400 bg-green-500/10 border-green-500/20' },
    indexing: { icon: <Clock className="w-3.5 h-3.5 animate-spin" />, label: '索引中', cls: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' },
    error: { icon: <AlertCircle className="w-3.5 h-3.5" />, label: '错误', cls: 'text-red-400 bg-red-500/10 border-red-500/20' },
    pending: { icon: <Clock className="w-3.5 h-3.5" />, label: '等待', cls: 'text-dark-500 bg-dark-800 border-dark-700' },
  };
  const s = map[status] || map.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${s.cls}`}>
      {s.icon} {s.label}
    </span>
  );
}

export default function DevAssistant() {
  // === Context 状态（localStorage 持久化）===
  const {
    docMessages, setDocMessages,
    activeDocId, setActiveDocId,
    activeConvId, setActiveConvId,
    messages: opsMessages, setMessages: setOpsMessages,
  } = useAssistantContext();

  // === 本地 UI 状态（不需持久化）===
  const [docs, setDocs] = useState<DocDocument[]>([]);
  const [docInput, setDocInput] = useState('');
  const [docStreaming, setDocStreaming] = useState(false);
  const [opsInput, setOpsInput] = useState('');
  const [opsLoading, setOpsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'docs' | 'ops'>('docs');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [convMenuOpen, setConvMenuOpen] = useState(false);

  const opsAbortRef = useRef<AbortController | null>(null);
  const docMsgsEndRef = useRef<HTMLDivElement>(null);
  const opsMsgsEndRef = useRef<HTMLDivElement>(null);

  const selectedDoc = docs.find(d => d.id === activeDocId);

  // 加载文档列表
  const loadDocs = useCallback(async () => {
    try {
      const r = await docmind.listDocuments();
      setDocs(r.documents);
    } catch (e) { console.error('loadDocs failed', e); }
  }, []);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  // 滚动到底部
  useEffect(() => {
    if (activeTab === 'docs') docMsgsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    else opsMsgsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [docMessages, opsMessages, activeTab]);

  // 上传文档
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadProgress(0);
    for (const file of Array.from(files)) {
      try {
        await docmind.uploadDocument(file, p => setUploadProgress(p));
      } catch (e) { console.error('upload failed', e); }
    }
    setUploading(false);
    loadDocs();
  };

  // 发送文档助手消息
  const sendDocMessage = async (text?: string) => {
    const content = text || docInput.trim();
    if (!content || docStreaming || !activeDocId) return;

    setDocInput('');
    const userMsg = { role: 'user' as const, content, ts: Date.now(), streaming: false };
    const assistantMsg = { role: 'assistant' as const, content: '', ts: Date.now() + 1, streaming: true };

    setDocMessages(prev => [...prev, userMsg, assistantMsg]);
    setDocStreaming(true);

    try {
      let acc = '';
      await docmind.chatStream(
        { message: content, conversation_id: activeConvId || undefined, document_id: activeDocId },
        {
          onChunk: chunk => {
            acc += chunk;
            setDocMessages(prev => prev.map((m, i) =>
              i === prev.length - 1 ? { ...m, content: acc } : m
            ));
          },
          onDone: (_msgId, convId) => {
            if (convId && convId !== activeConvId) setActiveConvId(convId);
            setDocStreaming(false);
          },
          onStatus: s => { if (s === '完成') setDocStreaming(false); },
        }
      );
    } catch (e: any) {
      setDocMessages(prev => [
        ...prev.slice(0, -1),
        { ...assistantMsg, content: `❌ ${e.message || e}`, streaming: false },
      ]);
      setDocStreaming(false);
    }
  };

  // 发送运维助手消息
  const sendOpsMessage = async (text?: string) => {
    const content = text || opsInput.trim();
    if (!content || opsLoading) return;

    setOpsInput('');
    const userMsg = { role: 'user' as const, content, ts: Date.now(), streaming: false };
    const assistantMsg = { role: 'assistant' as const, content: '', ts: Date.now() + 1, streaming: true };

    setOpsMessages(prev => [...prev, userMsg, assistantMsg]);
    setOpsLoading(true);

    opsAbortRef.current = new AbortController();
    try {
      const history = [
        { role: 'system', content: '你是专业的运维助手，擅长日志分析、故障排查、性能调优、系统架构诊断。回答简洁专业，使用 Markdown 格式。' },
        ...opsMessages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content },
      ];
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ messages: history }),
        signal: opsAbortRef.current.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No reader');
      const decoder = new TextDecoder();
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) acc += parsed.content;
            } catch {}
          }
        }
        setOpsMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: acc } : m
        ));
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setOpsMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: `❌ ${err.message}`, streaming: false } : m
        ));
      }
    }
    setOpsLoading(false);
    opsAbortRef.current = null;
  };

  const stopOps = () => opsAbortRef.current?.abort();
  const clearOps = () => { if (opsMessages.length > 0) setOpsMessages([]); };
  const clearDoc = () => { if (docMessages.length > 0) { setDocMessages([]); setActiveConvId(null); } };

  const MsgBubble = ({ msg, isUser }: { msg: any; isUser: boolean }) => (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : ''}`}>
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent-500/20 flex items-center justify-center mt-0.5">
          <Bot className="w-4 h-4 text-accent-400" />
        </div>
      )}
      <div className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
        isUser
          ? 'bg-accent-500/20 text-dark-100 rounded-br-md'
          : 'bg-dark-900 border border-dark-800 text-dark-200 rounded-bl-md'
      }`}>
        {msg.content ? (
          <div
            className="prose-invert [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono
              [&_pre]:bg-dark-800 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:mt-2 [&_pre]:overflow-x-auto
              [&_strong]:text-dark-100 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4
              [&_li]:text-xs [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1_h2_h3]:font-bold [&_h1_h2_h3]:mt-3 [&_h1_h2_h3]:mb-1
              [&_table]:w-full [&_table]:text-xs [&_th]:p-2 [&_td]:p-2 [&_th]:border-b [&_th]:border-dark-700 [&_p]:my-1"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        ) : (
          <div className="flex items-center gap-2 text-dark-500">
            <Loader className="w-4 h-4 animate-spin" /> 思考中...
          </div>
        )}
        {msg.references && msg.references.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            <span className="text-xs text-dark-600">引用：</span>
            {(msg.references as any[]).map((ref: any, j: number) => (
              <span key={j} className="px-1.5 py-0.5 rounded bg-accent-500/10 text-accent-400 text-xs">P{ref.page}</span>
            ))}
          </div>
        )}
      </div>
      {isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-dark-700 flex items-center justify-center mt-0.5">
          <User className="w-4 h-4 text-dark-400" />
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-[calc(100vh-8rem)] animate-fade-in gap-4">
      {/* === 左侧：文档列表 === */}
      <div className="w-72 flex-shrink-0 flex flex-col bg-dark-900 border border-dark-800 rounded-xl overflow-hidden">

        {/* 上传区 */}
        <div
          className={`m-3 p-4 border-2 border-dashed rounded-xl text-center transition-all cursor-pointer ${
            dragOver ? 'border-accent-500 bg-accent-500/5' : 'border-dark-700 hover:border-dark-600'
          }`}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); handleUpload(e.dataTransfer.files); }}
          onClick={() => document.getElementById('doc-upload-input')?.click()}
        >
          <input id="doc-upload-input" type="file" accept=".pdf,.docx,.txt,.md" multiple className="hidden"
            onChange={e => handleUpload(e.target.files)} />
          {uploading ? (
            <div className="flex flex-col items-center gap-2">
              <Loader className="w-6 h-6 text-accent-400 animate-spin" />
              <span className="text-xs text-dark-500">{Math.round(uploadProgress)}%</span>
            </div>
          ) : (
            <>
              <Upload className="w-6 h-6 mx-auto mb-2 text-dark-600" />
              <p className="text-xs text-dark-500">拖拽上传 / 点击选择</p>
              <p className="text-xs text-dark-700 mt-1">PDF · DOCX · MD · TXT</p>
            </>
          )}
        </div>

        {/* 文档列表标题 */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-dark-800">
          <span className="text-xs text-dark-500 font-medium">文档 ({docs.length})</span>
          <button onClick={loadDocs} className="p-1 rounded hover:bg-dark-800 text-dark-600 hover:text-dark-400 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 文档列表 */}
        <div className="flex-1 overflow-y-auto divide-y divide-dark-800">
          {docs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center px-4">
              <FileText className="w-8 h-8 text-dark-700 mb-2" />
              <p className="text-xs text-dark-600">暂无文档</p>
              <p className="text-xs text-dark-700 mt-1">上传 PDF/DOCX/MD 开始</p>
            </div>
          ) : docs.map(doc => (
            <div key={doc.id} className="group">
              <div
                className={`flex items-start gap-2 px-4 py-3 cursor-pointer transition-colors ${
                  activeDocId === doc.id ? 'bg-accent-500/10' : 'hover:bg-dark-800/50'
                }`}
                onClick={() => {
                  setActiveDocId(doc.id === activeDocId ? null : doc.id);
                  setActiveConvId(null);
                  if (doc.id !== activeDocId) setDocMessages([]);
                }}
              >
                <FileText className="w-4 h-4 text-accent-400/60 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className={`text-xs truncate ${activeDocId === doc.id ? 'text-accent-400' : 'text-dark-300'}`}>
                    {doc.name}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <StatusBadge status={doc.index_status} />
                    <span className="text-xs text-dark-700">{doc.page_count || '-'} 页</span>
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); docmind.deleteDocument(doc.id).then(loadDocs); }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/20 text-dark-600 hover:text-red-400 transition-all"
                >
                  <Trash className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* === 右侧：对话区 === */}
      <div className="flex flex-col flex-1 min-w-0">

        {/* Tab 切换 + 当前文档指示 */}
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center gap-1 bg-dark-900 border border-dark-800 rounded-xl p-1">
            <button
              onClick={() => setActiveTab('docs')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'docs' ? 'bg-accent-500/20 text-accent-400' : 'text-dark-500 hover:text-dark-300'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              文档助手
            </button>
            <button
              onClick={() => setActiveTab('ops')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'ops' ? 'bg-accent-500/20 text-accent-400' : 'text-dark-500 hover:text-dark-300'
              }`}
            >
              <Terminal className="w-4 h-4" />
              运维助手
            </button>
          </div>

          {/* 当前文档指示器 */}
          {activeTab === 'docs' && selectedDoc && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-accent-500/10 border border-accent-500/20 rounded-lg">
              <FileText className="w-4 h-4 text-accent-400" />
              <span className="text-xs text-accent-400 max-w-48 truncate">{selectedDoc.name}</span>
              <button onClick={() => { setActiveDocId(null); setActiveConvId(null); setDocMessages([]); }}
                className="p-0.5 rounded hover:bg-dark-800 text-dark-600 hover:text-dark-400">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* 当前 Tab 消息区 */}
        <div className="flex-1 overflow-y-auto min-h-0">

          {/* ===== 文档助手 ===== */}
          {activeTab === 'docs' && (
            <>
              {docMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-dark-500">
                  <div className="w-16 h-16 rounded-2xl bg-accent-500/10 flex items-center justify-center mb-4">
                    <BookOpen className="w-8 h-8 text-accent-500/40" />
                  </div>
                  <p className="text-sm font-medium text-dark-400 mb-1">
                    {activeDocId ? '文档已选定，开始提问' : '选择左侧文档开始对话'}
                  </p>
                  <p className="text-xs text-dark-600 mb-6">基于文档内容，AI 精准回答</p>
                  {activeDocId && (
                    <div className="flex flex-wrap justify-center gap-2 max-w-md">
                      {DOC_QUICK_PROMPTS.map((q, i) => (
                        <button key={i} onClick={() => sendDocMessage(q)}
                          className="px-3 py-1.5 rounded-lg bg-dark-900 border border-dark-800 text-xs text-dark-400 hover:text-dark-200 hover:border-dark-700 transition-all">
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4 pb-4">
                  {docMessages.map((msg, i) => (
                    <MsgBubble key={msg.ts || i} msg={msg} isUser={msg.role === 'user'} />
                  ))}
                  <div ref={docMsgsEndRef} />
                </div>
              )}
            </>
          )}

          {/* ===== 运维助手 ===== */}
          {activeTab === 'ops' && (
            <>
              {opsMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-dark-500">
                  <div className="w-16 h-16 rounded-2xl bg-accent-500/10 flex items-center justify-center mb-4">
                    <Terminal className="w-8 h-8 text-accent-500/40" />
                  </div>
                  <p className="text-sm font-medium text-dark-400 mb-1">运维助手已就绪</p>
                  <p className="text-xs text-dark-600 mb-6">日志分析、故障排查、性能调优</p>
                  <div className="flex flex-wrap justify-center gap-2 max-w-md">
                    {OPS_QUICK_PROMPTS.map((q, i) => (
                      <button key={i} onClick={() => sendOpsMessage(q)}
                        className="px-3 py-1.5 rounded-lg bg-dark-900 border border-dark-800 text-xs text-dark-400 hover:text-dark-200 hover:border-dark-700 transition-all">
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-4 pb-4">
                  {opsMessages.map((msg, i) => (
                    <MsgBubble key={msg.ts || i} msg={msg} isUser={msg.role === 'user'} />
                  ))}
                  <div ref={opsMsgsEndRef} />
                </div>
              )}
            </>
          )}
        </div>

        {/* 输入区 */}
        <div className="flex-shrink-0 pt-3 border-t border-dark-800">
          {activeTab === 'docs' && !activeDocId && (
            <p className="text-xs text-dark-600 mb-2">⚠️ 请先在左侧选择一个文档</p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={activeTab === 'docs' ? docInput : opsInput}
              onChange={e => activeTab === 'docs' ? setDocInput(e.target.value) : setOpsInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  activeTab === 'docs' ? sendDocMessage() : sendOpsMessage();
                }
              }}
              placeholder={
                activeTab === 'docs'
                  ? activeDocId ? '基于文档内容提问...' : '先选择文档...'
                  : '输入运维问题...'
              }
              rows={1}
              className="w-full px-4 py-3 bg-dark-900 border border-dark-800 rounded-xl text-sm text-dark-200 placeholder-dark-600
                focus:outline-none focus:border-accent-500/50 resize-none"
              style={{ minHeight: '48px', maxHeight: '120px' }}
              onInput={e => {
                const el = e.currentTarget as HTMLTextAreaElement;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 120) + 'px';
              }}
              disabled={activeTab === 'docs' && !activeDocId}
            />

            {activeTab === 'ops' && opsLoading ? (
              <button onClick={stopOps}
                className="flex-shrink-0 w-12 h-12 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors flex items-center justify-center">
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={activeTab === 'docs' ? () => sendDocMessage() : () => sendOpsMessage()}
                disabled={
                  (activeTab === 'docs' && (!activeDocId || !docInput.trim())) ||
                  (activeTab === 'ops' && !opsInput.trim())
                }
                className="flex-shrink-0 w-12 h-12 rounded-xl bg-accent-500 text-white hover:bg-accent-600 transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* 清空按钮 */}
          {activeTab === 'ops' && opsMessages.length > 0 && (
            <button onClick={clearOps}
              className="flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg text-xs text-dark-500 hover:text-red-400 hover:bg-red-500/10 border border-dark-800 transition-colors">
              <Trash className="w-3.5 h-3.5" /> 清空对话
            </button>
          )}
          {activeTab === 'docs' && docMessages.length > 0 && (
            <button onClick={clearDoc}
              className="flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg text-xs text-dark-500 hover:text-red-400 hover:bg-red-500/10 border border-dark-800 transition-colors">
              <Trash className="w-3.5 h-3.5" /> 清空对话
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const OPS_QUICK_PROMPTS = [
  '如何排查 CPU 飙高问题？',
  'MySQL 连接数满了怎么处理？',
  'Nginx 502 Bad Gateway 常见原因',
  'Docker 容器 OOM Killed 怎么排查？',
  'Linux 磁盘 IO 高怎么定位？',
  'Redis 内存占用过高怎么优化？',
];
