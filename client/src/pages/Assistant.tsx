import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Trash2, Square, Loader, Sparkles, Terminal } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  streaming?: boolean;
}

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
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
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
    const userMsg: Message = { role: 'user', content, ts: Date.now() };
    const assistantMsg: Message = { role: 'assistant', content: '', ts: Date.now(), streaming: true };
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setLoading(true);

    abortRef.current = new AbortController();

    try {
      const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));

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

        // Update streaming message
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

  const stopGeneration = () => {
    abortRef.current?.abort();
  };

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

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] animate-fade-in">
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
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-dark-400 hover:text-red-400 hover:bg-red-500/10 border border-dark-800 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            清空对话
          </button>
        )}
      </div>

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-dark-500">
            <div className="w-16 h-16 rounded-2xl bg-accent-500/10 flex items-center justify-center mb-4">
              <Terminal className="w-8 h-8 text-accent-500/40" />
            </div>
            <p className="text-sm font-medium text-dark-400 mb-1">运维助手已就绪</p>
            <p className="text-xs text-dark-600 mb-6">支持日志分析、故障排查、性能调优等</p>
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
  );
}

function renderMarkdown(text: string): string {
  // Escape HTML first
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br/>');

  return `<p>${html}</p>`;
}
