import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send, Bot, User, Trash2, Square, Loader, Sparkles, FileText, Upload,
  RefreshCw, Trash, BookOpen, Plus, X, ChevronRight, CheckCircle, Clock,
  AlertCircle, MessageSquare, Terminal, Eye, EyeOff, Save, Code2, Zap,
} from 'lucide-react';
import { useAssistantContext } from '../contexts/AssistantContext';
import { docmind, DocDocument, DocConversation, DocMessage } from '../lib/docmind';

// 文档助手：选择文档 → 对话（基于文档内容回答）
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
  const map = {
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
  // === 文档助手状态 ===
  const [docs, setDocs] = useState<DocDocument[]>([]);
  const [convs, setConvs] = useState<DocConversation[]>([]);
  const [activeConv, setActiveConv] = useState<DocConversation | null>(null);
  const [currentDocId, setCurrentDocId] = useState<string | null>(null);
  const [docMessages, setDocMessages] = useState<DocMessage[]>([]);
  const [docInput, setDocInput] = useState('');
  const [docStreaming, setDocStreaming] = useState(false);
  const [docLoading, setDocLoading] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [showDocList, setShowDocList] = useState(false);
  const [docPanelOpen, setDocPanelOpen] = useState(true);

  // === 运维助手状态（复用 AssistantContext） ===
  const { messages: opsMessages, setMessages: setOpsMessages } = useAssistantContext();
  const [opsInput, setOpsInput] = useState('');
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsStreamContent, setOpsStreamContent] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // === 通用 ===
  const [activeTab, setActiveTab] = useState<'docs' | 'ops'>('docs');
  const docMsgsEndRef = useRef<HTMLDivElement>(null);
  const opsMsgsEndRef = useRef<HTMLDivElement>(null);

  // 加载文档
  const loadDocs = useCallback(async () => {
    try {
      const r = await docmind.listDocuments();
      setDocs(r.documents);
    } catch (e) { console.error('loadDocs failed', e); }
  }, []);

  // 加载对话
  const loadConvs = useCallback(async () => {
    try {
      const r = await docmind.listConversations(currentDocId || undefined);
      setConvs(r.conversations);
    } catch (e) { console.error('loadConvs failed', e); }
  }, [currentDocId]);

  useEffect(() => { loadDocs(); loadConvs(); }, [loadDocs, loadConvs]);

  // 切换文档
  useEffect(() => {
    if (currentDocId) loadConvs();
  }, [currentDocId, loadConvs]);

  // 切换对话
  useEffect(() => {
    if (activeConv) setDocMessages(activeConv.messages);
    else setDocMessages([]);
  }, [activeConv]);

  // 文档滚动
  useEffect(() => { docMsgsEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [docMessages, streamContent]);
  // 运维滚动
  useEffect(() => { opsMsgsEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [opsMessages, opsStreamContent]);

  // 上传
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

  const selectedDoc = docs.find(d => d.id === currentDocId);

  // 文档对话
  const sendDocMessage = async (text?: string) => {
    const content = text || docInput.trim();
    if (!content || docStreaming) return;

    setDocInput('');
    const userMsg: DocMessage = { id: `tmp-${Date.now()}`, role: 'user', content, references: null, created_at: new Date().toISOString() };
    setDocMessages(prev => [...prev, userMsg]);
    setDocStreaming(true);
    setStreamContent('');
    setDocLoading(true);

    try {
      const tmpStreamContent = '';
      await docmind.chatStream(
        { message: content, conversation_id: activeConv?.id, document_id: currentDocId || undefined },
        {
          onChunk: chunk => {
            // 实时更新到最后一个 assistant 消息
            setDocMessages(prev => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
              }
              return [...prev, { id: `stream-${Date.now()}`, role: 'assistant', content: chunk, references: null, created_at: new Date().toISOString() }];
            });
          },
          onDone: (_msgId, convId) => {
            if (!activeConv && convId) {
              setActiveConv({
                id: convId, title: content.slice(0, 50) + '...', document_id: currentDocId || null,
                messages: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
              });
              loadConvs();
            }
            // 触发 Tip 通知
            const last = docMessages[docMessages.length];
            const tip = { id: `doc-tip-${Date.now()}`, preview: content.slice(0, 30), convId };
            window.dispatchEvent(new CustomEvent('assistant-tip', { detail: tip }));
          },
          onStatus: s => { if (s === '完成') setDocStreaming(false); },
        }
      );
      setDocStreaming(false);
      loadConvs();
    } catch (e) {
      console.error('doc chat error', e);
      setDocMessages(prev => [...prev.slice(0, -1), userMsg,
        { id: `err-${Date.now()}`, role: 'assistant', content: `❌ ${e}`, references: null, created_at: new Date().toISOString() }
      ]);
      setDocStreaming(false);
    }
    setDocLoading(false);
  };

  // 运维对话
  const sendOpsMessage = async (text?: string) => {
    const content = text || opsInput.trim();
    if (!content || opsLoading) return;

    setOpsInput('');
    const userMsg = { role: 'user' as const, content, ts: Date.now() };
    const assistantMsg = { role: 'assistant' as const, content: '', ts: Date.now() + 1, streaming: true };
    setOpsMessages(prev => [...prev, userMsg, assistantMsg]);
    setOpsLoading(true);
    setOpsStreamContent('');

    abortRef.current = new AbortController();
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
        signal: abortRef.current.signal,
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
      // Tip
      const tip = { id: `ops-tip-${Date.now()}`, preview: content.slice(0, 30), convId: 'ops' };
      window.dispatchEvent(new CustomEvent('assistant-tip', { detail: tip }));
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setOpsMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: `❌ ${err.message}`, streaming: false } : m
        ));
      }
    }
    setOpsLoading(false);
    setOpsStreamContent('');
    abortRef.current = null;
  };

  const stopOps = () => { abortRef.current?.abort(); };

  const clearOps = () => { if (opsMessages.length > 0) setOpsMessages([]); };

  return (
    <div className="flex h-[calc(100vh-8rem)] animate-fade-in gap-4">
      {/* 左侧文档列表 */}
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

        {/* 文档列表 */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-dark-800">
          <span className="text-xs text-dark-500 font-medium">文档 ({docs.length})</span>
          <button onClick={loadDocs} className="p-1 rounded hover:bg-dark-800 text-dark-600 hover:text-dark-400 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-dark-800">
          {docs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center px-4">
              <FileText className="w-8 h-8 text-dark-700 mb-2" />
              <p className="text-xs text-dark-600">暂无文档</p>
            </div>
          ) : docs.map(doc => (
            <div key={doc.id} className="group">
              <div
                className={`flex items-start gap-2 px-4 py-3 cursor-pointer transition-colors ${
                  currentDocId === doc.id ? 'bg-accent-500/10' : 'hover:bg-dark-800/50'
                }`}
                onClick={() => {
                  setCurrentDocId(doc.id === currentDocId ? null : doc.id);
                  setActiveConv(null);
                  setDocMessages([]);
                }}
              >
                <FileText className="w-4 h-4 text-accent-400/60 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className={`text-xs truncate ${currentDocId === doc.id ? 'text-accent-400' : 'text-dark-300'}`}>
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

      {/* 右侧对话区 */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Tab 切换 */}
        <div className="flex items-center gap-1 mb-4 bg-dark-900 border border-dark-800 rounded-xl p-1 w-fit">
          <button
            onClick={() => setActiveTab('docs')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'docs'
                ? 'bg-accent-500/20 text-accent-400'
                : 'text-dark-500 hover:text-dark-300'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            文档助手
          </button>
          <button
            onClick={() => setActiveTab('ops')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'ops'
                ? 'bg-accent-500/20 text-accent-400'
                : 'text-dark-500 hover:text-dark-300'
            }`}
          >
            <Terminal className="w-4 h-4" />
            运维助手
          </button>
        </div>

        {/* 当前文档指示器 */}
        {activeTab === 'docs' && selectedDoc && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-accent-500/10 border border-accent-500/20 rounded-lg w-fit">
            <FileText className="w-4 h-4 text-accent-400" />
            <span className="text-xs text-accent-400">{selectedDoc.name}</span>
            <button onClick={() => { setCurrentDocId(null); setActiveConv(null); setDocMessages([]); }}
              className="p-0.5 rounded hover:bg-dark-800 text-dark-600 hover:text-dark-400">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* 对话区域 */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* === 文档助手 === */}
          {activeTab === 'docs' && (
            <>
              {docMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-dark-500">
                  <div className="w-16 h-16 rounded-2xl bg-accent-500/10 flex items-center justify-center mb-4">
                    <BookOpen className="w-8 h-8 text-accent-500/40" />
                  </div>
                  <p className="text-sm font-medium text-dark-400 mb-1">
                    {currentDocId ? '文档已选定，开始提问' : '选择左侧文档开始对话'}
                  </p>
                  <p className="text-xs text-dark-600 mb-6">基于文档内容，AI 精准回答</p>
                  <div className="flex flex-wrap justify-center gap-2 max-w-md">
                    {(currentDocId ? DOC_QUICK_PROMPTS : DOC_QUICK_PROMPTS.slice(0, 2)).map((q, i) => (
                      <button key={i} onClick={() => sendDocMessage(q)}
                        className="px-3 py-1.5 rounded-lg bg-dark-900 border border-dark-800 text-xs text-dark-400 hover:text-dark-200 hover:border-dark-700 transition-all">
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-4 pb-4">
                  {docMessages.map((msg, i) => (
                    <div key={msg.id || i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                      {msg.role === 'assistant' && (
                        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent-500/20 flex items-center justify-center mt-0.5">
                          <Bot className="w-4 h-4 text-accent-400" />
                        </div>
                      )}
                      <div className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        msg.role === 'user'
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
                            {msg.references.map((ref, j) => (
                              <span key={j} className="px-1.5 py-0.5 rounded bg-accent-500/10 text-accent-400 text-xs">
                                P{ref.page}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {msg.role === 'user' && (
                        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-dark-700 flex items-center justify-center mt-0.5">
                          <User className="w-4 h-4 text-dark-400" />
                        </div>
                      )}
                    </div>
                  ))}
                  <div ref={docMsgsEndRef} />
                </div>
              )}
            </>
          )}

          {/* === 运维助手 === */}
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
                    <div key={msg.ts} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                      {msg.role === 'assistant' && (
                        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent-500/20 flex items-center justify-center mt-0.5">
                          <Bot className="w-4 h-4 text-accent-400" />
                        </div>
                      )}
                      <div className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-accent-500/20 text-dark-100 rounded-br-md'
                          : 'bg-dark-900 border border-dark-800 text-dark-200 rounded-bl-md'
                      }`}>
                        {msg.content ? (
                          <div
                            className="prose-invert [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono
                              [&_pre]:bg-dark-800 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:mt-2 [&_pre]:overflow-x-auto
                              [&_strong]:text-dark-100 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4
                              [&_li]:text-xs [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1_h2_h3]:font-bold [&_h1_h2_h3]:mt-3 [&_h1_h2_h3]:mb-1
                              [&_p]:my-1"
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                          />
                        ) : (
                          <div className="flex items-center gap-2 text-dark-500">
                            <Loader className="w-4 h-4 animate-spin" /> 思考中...
                          </div>
                        )}
                      </div>
                      {msg.role === 'user' && (
                        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-dark-700 flex items-center justify-center mt-0.5">
                          <User className="w-4 h-4 text-dark-400" />
                        </div>
                      )}
                    </div>
                  ))}
                  <div ref={opsMsgsEndRef} />
                </div>
              )}
            </>
          )}
        </div>

        {/* 输入框 */}
        <div className="flex-shrink-0 pt-3 border-t border-dark-800">
          {/* 快捷提示 */}
          {activeTab === 'docs' && !selectedDoc && (
            <p className="text-xs text-dark-600 mb-2">⚠️ 请先在左侧选择一个文档</p>
          )}
          <div className="flex items-end gap-2">
            <div className="flex-1 relative">
              <textarea
                value={activeTab === 'docs' ? docInput : opsInput}
                onChange={e => activeTab === 'docs' ? setDocInput(e.target.value) : setOpsInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    activeTab === 'docs' ? sendDocMessage() : sendOpsMessage();
                  }
                }}
                placeholder={activeTab === 'docs'
                  ? selectedDoc ? '基于文档内容提问...' : '先选择文档...'
                  : '输入运维问题...'}
                rows={1}
                className="w-full px-4 py-3 pr-12 bg-dark-900 border border-dark-800 rounded-xl text-sm text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50 resize-none"
                style={{ minHeight: '48px', maxHeight: '120px' }}
                onInput={e => {
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
                }}
                disabled={activeTab === 'docs' && !selectedDoc}
              />
            </div>
            {activeTab === 'ops' && opsLoading ? (
              <button onClick={stopOps}
                className="flex-shrink-0 w-12 h-12 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors flex items-center justify-center">
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={activeTab === 'docs' ? () => sendDocMessage() : () => sendOpsMessage()}
                disabled={(activeTab === 'docs' && !selectedDoc) || (activeTab === 'docs' ? !docInput.trim() : !opsInput.trim())}
                className="flex-shrink-0 w-12 h-12 rounded-xl bg-accent-500 text-white hover:bg-accent-600 transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
          {activeTab === 'ops' && opsMessages.length > 0 && (
            <button onClick={clearOps}
              className="flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg text-xs text-dark-500 hover:text-red-400 hover:bg-red-500/10 border border-dark-800 transition-colors">
              <Trash2 className="w-3.5 h-3.5" /> 清空对话
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
