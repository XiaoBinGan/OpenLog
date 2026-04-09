import { useState, useRef, useEffect } from 'react';
import {
  Send, Bot, User, Trash2, Square, Loader, Sparkles, Terminal,
  BookOpen, Plus, X, ChevronDown, ChevronUp, FileText, Eye, EyeOff, Save
} from 'lucide-react';
import { useAssistantContext } from '../contexts/AssistantContext';

const QUICK_PROMPTS = [
  '如何排查 CPU 飙高问题？',
  'MySQL 连接数满了怎么处理？',
  'Nginx 502 Bad Gateway 常见原因',
  'Docker 容器 OOM Killed 怎么排查？',
  '分析这条日志：Connection reset by peer',
  'Linux 磁盘 IO 高怎么定位？',
  'Redis 内存占用过高怎么优化？',
  'Kubernetes Pod CrashLoopBackOff 排查',
];

export default function Assistant() {
  const { messages, setMessages, memoryFiles, reloadMemory, deleteMemory, saveMemory } = useAssistantContext();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => { scrollToBottom(); }, [messages]);

  const sendMessage = async (text?: string) => {
    const content = text || input.trim();
    if (!content || loading) return;

    setInput('');
    const userMsg = { role: 'user' as const, content, ts: Date.now() };
    const assistantMsg = { role: 'assistant' as const, content: '', ts: Date.now(), streaming: true };
    // 用封装的 setMessages，自动处理 Tip 逻辑
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setLoading(true);

    abortRef.current = new AbortController();

    try {
      // 构建历史消息（含系统提示：注入内存文件内容）
      const memoryContext = memoryFiles.length > 0
        ? `\n\n## 📚 运维知识库（内存文件）\n` +
          memoryFiles.map(f => `### ${f.name}\n${f.content}`).join('\n\n')
        : '';
      const systemPrompt = `你是一个专业的运维助手，擅长日志分析、故障排查、性能调优、系统架构诊断。` +
        (memoryContext ? `\n${memoryContext}` : '');
      const history = [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content },
      ];

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ messages: history }),
        signal: abortRef.current.signal
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '请求失败' }));
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: `❌ ${err.error || '请求失败'}`, streaming: false } : m
        ));
        setLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No reader');

      const decoder = new TextDecoder();
      let accumulated = '';

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
              if (parsed.error) {
                accumulated = `❌ ${parsed.error}`;
              } else if (parsed.content) {
                accumulated += parsed.content;
              }
            } catch {}
          }
        }

        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: accumulated } : m
        ));
      }

      setMessages(prev => prev.map((m, i) =>
        i === prev.length - 1 ? { ...m, streaming: false } : m
      ));
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: m.content || '已停止生成', streaming: false } : m
        ));
      } else {
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: `❌ ${err.message}`, streaming: false } : m
        ));
      }
    }

    setLoading(false);
    abortRef.current = null;
  };

  const stopGeneration = () => { abortRef.current?.abort(); };

  const clearChat = () => {
    if (messages.length === 0) return;
    setMessages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const openEdit = (fileName: string, content: string) => {
    setEditingFile(fileName);
    setEditContent(content);
    setShowNewForm(false);
    setNewFileName('');
  };

  const closeEdit = () => {
    setEditingFile(null);
    setEditContent('');
  };

  const handleSaveEdit = async () => {
    if (!editingFile) return;
    await saveMemory(editingFile, editContent);
    closeEdit();
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;
    await saveMemory(newFileName.trim(), `# ${newFileName.trim()}\n\n`);
    setNewFileName('');
    setShowNewForm(false);
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] animate-fade-in gap-4">
      {/* 左侧：聊天区 */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-accent-500/20">
              <Sparkles className="w-5 h-5 text-accent-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-dark-100">运维助手</h1>
              <p className="text-xs text-dark-500">AI 驱动的技术支持与问题诊断</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-dark-400 hover:text-red-400 hover:bg-red-500/10 border border-dark-800 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                清空对话
              </button>
            )}
            <button
              onClick={() => setMemoryPanelOpen(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                memoryPanelOpen
                  ? 'text-accent-400 bg-accent-500/10 border-accent-500/30'
                  : 'text-dark-400 hover:text-accent-400 hover:bg-accent-500/10 border-dark-800'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              知识库
              {memoryFiles.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-accent-500/20 text-accent-400 text-xs">
                  {memoryFiles.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-dark-500">
              <div className="w-16 h-16 rounded-2xl bg-accent-500/10 flex items-center justify-center mb-4">
                <Terminal className="w-8 h-8 text-accent-500/40" />
              </div>
              <p className="text-sm font-medium text-dark-400 mb-1">运维助手已就绪</p>
              <p className="text-xs text-dark-600 mb-6">
                {memoryFiles.length > 0
                  ? `📚 已加载 ${memoryFiles.length} 个知识库文件`
                  : '支持日志分析、故障排查、性能调优等'}
              </p>
              <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                {QUICK_PROMPTS.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(q)}
                    className="px-3 py-1.5 rounded-lg bg-dark-900 border border-dark-800 text-xs text-dark-400 hover:text-dark-200 hover:border-dark-700 transition-all"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4 pb-4">
              {memoryFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {memoryFiles.map(f => (
                    <button
                      key={f.name}
                      onClick={() => openEdit(f.name, f.content)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-accent-500/10 border border-accent-500/20 text-xs text-accent-400 hover:bg-accent-500/20 transition-colors"
                    >
                      <BookOpen className="w-3 h-3" />
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={msg.ts} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  {msg.role === 'assistant' && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent-500/20 flex items-center justify-center mt-0.5">
                      <Bot className="w-4 h-4 text-accent-400" />
                    </div>
                  )}
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-accent-500/20 text-dark-100 rounded-br-md'
                        : 'bg-dark-900 border border-dark-800 text-dark-200 rounded-bl-md'
                    }`}
                  >
                    {msg.content ? (
                      <div
                        className="prose-invert
                          [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono
                          [&_pre]:bg-dark-800 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:mt-2 [&_pre]:mb-2 [&_pre]:overflow-x-auto
                          [&_pre_code]:bg-transparent [&_pre_code]:p-0
                          [&_strong]:text-dark-100
                          [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-1
                          [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:space-y-1
                          [&_li]:text-xs
                          [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1_h2_h3]:font-bold [&_h1_h2_h3]:mt-3 [&_h1_h2_h3]:mb-1
                          [&_table]:w-full [&_table]:text-xs [&_th]:text-left [&_th]:p-2 [&_td]:p-2 [&_th]:border-b [&_th]:border-dark-700
                          [&_p]:my-1"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                      />
                    ) : msg.streaming ? (
                      <div className="flex items-center gap-2 text-dark-500">
                        <Loader className="w-4 h-4 animate-spin" />
                        思考中...
                      </div>
                    ) : null}
                  </div>
                  {msg.role === 'user' && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-dark-700 flex items-center justify-center mt-0.5">
                      <User className="w-4 h-4 text-dark-400" />
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="flex-shrink-0 pt-3 border-t border-dark-800">
          <div className="flex items-end gap-2">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入问题，Shift+Enter 换行..."
                rows={1}
                className="w-full px-4 py-3 pr-12 bg-dark-900 border border-dark-800 rounded-xl text-sm text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50 resize-none"
                style={{ minHeight: '48px', maxHeight: '120px' }}
                onInput={e => {
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
                }}
              />
            </div>
            {loading ? (
              <button
                onClick={stopGeneration}
                className="flex-shrink-0 w-12 h-12 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors flex items-center justify-center"
              >
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim()}
                className="flex-shrink-0 w-12 h-12 rounded-xl bg-accent-500 text-white hover:bg-accent-600 transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 右侧：知识库面板 */}
      {memoryPanelOpen && (
        <div className="w-80 flex-shrink-0 flex flex-col bg-dark-900 border border-dark-800 rounded-xl overflow-hidden animate-scale-in">
          {/* 面板头部 */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-accent-400" />
              <span className="text-sm font-semibold text-dark-100">知识库</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setShowNewForm(v => !v); setEditingFile(null); setEditContent(''); }}
                className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-400 hover:text-accent-400 transition-colors"
                title="新建文件"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                onClick={() => setMemoryPanelOpen(false)}
                className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-200 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 新建文件表单 */}
          {showNewForm && (
            <div className="px-4 py-3 border-b border-dark-800 bg-dark-950/50">
              <input
                autoFocus
                value={newFileName}
                onChange={e => setNewFileName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateFile(); if (e.key === 'Escape') setShowNewForm(false); }}
                placeholder="文件名（如：Docker 运维指南）"
                className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50 mb-2"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreateFile}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-accent-500 text-white text-xs font-medium hover:bg-accent-600 transition-colors"
                >
                  创建
                </button>
                <button
                  onClick={() => setShowNewForm(false)}
                  className="px-3 py-1.5 rounded-lg bg-dark-800 text-dark-400 text-xs hover:bg-dark-700 transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 编辑已有文件 */}
          {editingFile && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between px-4 py-2 border-b border-dark-800 bg-accent-500/5">
                <span className="text-xs text-accent-400 font-medium flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5" />
                  {editingFile}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleSaveEdit}
                    className="p-1 rounded hover:bg-accent-500/20 text-accent-400 transition-colors"
                    title="保存"
                  >
                    <Save className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={closeEdit}
                    className="p-1 rounded hover:bg-dark-800 text-dark-500 transition-colors"
                    title="关闭"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <textarea
                autoFocus
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                className="flex-1 w-full px-4 py-3 bg-dark-950 text-xs text-dark-200 font-mono leading-relaxed placeholder-dark-600 resize-none focus:outline-none"
                style={{ minHeight: '200px' }}
                placeholder="# 文件名&#10;&#10;在此编写 Markdown 内容..."
              />
            </div>
          )}

          {/* 文件列表 */}
          {!editingFile && (
            <div className="flex-1 overflow-y-auto">
              {memoryFiles.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full px-6 py-8 text-center">
                  <BookOpen className="w-10 h-10 text-dark-700 mb-3" />
                  <p className="text-sm text-dark-500 mb-1">暂无知识库文件</p>
                  <p className="text-xs text-dark-600">点击右上角 + 添加运维知识</p>
                </div>
              ) : (
                <div className="divide-y divide-dark-800">
                  {memoryFiles.map(file => (
                    <div key={file.name} className="group">
                      <div className="flex items-center gap-2 px-4 py-3 hover:bg-dark-800/50 transition-colors">
                        <FileText className="w-4 h-4 text-accent-400/60 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <button
                            onClick={() => openEdit(file.name, file.content)}
                            className="text-sm text-dark-200 hover:text-accent-400 transition-colors text-left truncate block w-full"
                          >
                            {file.name}
                          </button>
                          <div className="text-xs text-dark-600 mt-0.5">
                            {new Date(file.updatedAt).toLocaleString('zh-CN')}
                          </div>
                        </div>
                        <button
                          onClick={() => deleteMemory(file.name)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/20 text-dark-500 hover:text-red-400 transition-all flex-shrink-0"
                          title="删除"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 代码块
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g,
    '<pre><code class="language-$1">' + '$2' + '</code></pre>');

  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 粗体
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 列表
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // 表格
  html = html.replace(/^\|(.+)\|$/gm, (line, cols) => {
    const cells = cols.split('|').map((c: string) => c.trim());
    return '<tr>' + cells.map((c: string) => `<td>${c}</td>`).join('') + '</tr>';
  });
  if (/<tr>.*<\/tr>/.test(html)) {
    html = html.replace(/(<tr>.*<\/tr>)+/g, '<table>$&</table>');
  }

  // 段落换行
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br/>');

  return `<p>${html}</p>`;
}
