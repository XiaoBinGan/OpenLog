import { useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Send, Bot, User, Trash2, Square, Loader, Sparkles, Terminal,
  BookOpen, Plus, X, FileText, Save,
  MessageSquare, Pencil, Sidebar, History, ArrowRight,
} from 'lucide-react';
import { useAssistantContext } from '../contexts/AssistantContext';
import { marked } from 'marked';

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

// ── Markdown 渲染（带代码高亮简化版）──
function renderMarkdown(text: string): string {
  return marked.parse(text, { breaks: true }) as string;
}

// ── 对话列表项 ──
function ConvItem({ title, isActive, onSelect, onDelete }: {
  title: string; isActive: boolean; onSelect: () => void; onDelete: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
        isActive ? 'bg-accent-500/15 text-accent-400' : 'hover:bg-dark-800/60 text-dark-300 hover:text-dark-100'
      }`}
      onClick={onSelect}
    >
      <MessageSquare className="w-4 h-4 flex-shrink-0 opacity-60" />
      <span className="flex-1 text-sm truncate">{title}</span>
      <button
        onClick={e => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/20 text-dark-500 hover:text-red-400 transition-all flex-shrink-0"
      ><Trash2 className="w-3.5 h-3.5" /></button>
    </div>
  );
}

// ── 分析历史摘要（@ 提及列表项）──
interface HistoryBrief {
  id: string; timestamp: string; type: string; sourceName: string;
  summary: string; status: string;
}

// ── 主组件 ──
export default function Assistant() {
  const {
    opsConvs, opsActiveId, opsMessages, setOpsMessages,
    createOpsConv, switchOpsConv, deleteOpsConv, renameOpsConv,
    memoryFiles, reloadMemory, deleteMemory, saveMemory,
  } = useAssistantContext();

  const [searchParams, setSearchParams] = useSearchParams();
  const refParam = searchParams.get('ref');
  const skillParam = searchParams.get('skill');
  const cmdParam = searchParams.get('cmd');

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [editingConvTitle, setEditingConvTitle] = useState<string | null>(null);
  const [convTitleInput, setConvTitleInput] = useState('');

  // @ 提及状态
  const [atOpen, setAtOpen] = useState(false);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
  const [atFilter, setAtFilter] = useState('');
  const [atItems, setAtItems] = useState<HistoryBrief[]>([]);
  const [atIdx, setAtIdx] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const atRef = useRef<HTMLDivElement>(null);

  const activeConv = opsConvs.find(c => c.id === opsActiveId);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [opsMessages]);
  useEffect(() => { inputRef.current?.focus(); }, [opsActiveId]);

  // 加载分析历史摘要（@ 提及用）
  const loadBrief = useCallback(async () => {
    try {
      const res = await fetch('/api/analysis/history/brief');
      const data = await res.json();
      setAtItems(data.records || []);
    } catch {}
  }, []);

  // 来自分析历史的引用跳转
  useEffect(() => {
    if (!refParam) return;
    setSearchParams({}, { replace: true });
    (async () => {
      try {
        // 加载上下文
        await loadBrief();
        const res = await fetch('/api/analysis/history');
        const data = await res.json();
        const record = (data.records || []).find((r: any) => r.id === refParam);
        if (record) {
          const typeLabel = record.type === 'patrol' ? '巡检报告' : record.type === 'health' ? '健康诊断' : '日志分析';
          const analysis = (record.analysis || '').slice(0, 3000);
          const ctx = record.type !== 'log'
            ? `@${typeLabel} ${record.sourceName}\n\n分析上下文：\n${(record.summary || '').slice(0, 500)}\n\n分析结论：\n${analysis}\n\n`
            : `@日志 ${record.sourceName}\n\n日志内容：\n${(record.log?.message || '').slice(0, 500)}\n\n分析结论：\n${analysis}\n\n`;
          const msg = `${ctx}帮我深入分析，给出解决方案。`;
          sendMessage(msg);
        }
      } catch {}
    })();
  }, [refParam]);

  // 来自技能管理的快捷使用
  useEffect(() => {
    if (!skillParam || !cmdParam) return;
    setSearchParams({}, { replace: true });
    const msg = `[技能: ${skillParam}] ${cmdParam}`;
    setInput(msg);
    // 延迟自动发送（等待 input 状态同步）
    setTimeout(() => sendMessage(msg), 100);
  }, [skillParam, cmdParam]);

  // 输入变化处理 @
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setInput(v);
    const atMatch = v.match(/@([^\s]*)$/);
    if (atMatch) {
      setAtFilter(atMatch[1]);
      setAtIdx(0);
      if (!atOpen) { loadBrief(); setAtOpen(true); }
    } else {
      setAtOpen(false);
    }
  };

  // 选中 @ 条目
  const selectAtItem = (item: HistoryBrief) => {
    const typeLabel = item.type === 'patrol' ? '巡检' : item.type === 'health' ? '诊断' : '日志';
    const replacement = `@${typeLabel} ${item.sourceName} `;
    const newInput = input.replace(/@[^\s]*$/, replacement);
    setInput(newInput);
    setSelectedHistoryIds(prev => [...prev, item.id]);
    setAtOpen(false);
    inputRef.current?.focus();
  };

  // @ 键盘导航
  const handleAtKey = (e: React.KeyboardEvent) => {
    if (!atOpen) return;
    const filtered = atItems.filter(i =>
      (i.sourceName || '').toLowerCase().includes(atFilter.toLowerCase()) ||
      (i.type || '').toLowerCase().includes(atFilter.toLowerCase())
    );
    if (e.key === 'ArrowDown') { e.preventDefault(); setAtIdx(prev => Math.min(prev + 1, filtered.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setAtIdx(prev => Math.max(prev - 1, 0)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!(e.nativeEvent as any).isComposing) {
        if (filtered[atIdx]) selectAtItem(filtered[atIdx]);
      } else {
        setAtOpen(false);
      }
    }
    if (e.key === 'Escape') setAtOpen(false);
  };

  // 发送消息
  const sendMessage = async (text?: string) => {
    const content = text || input.trim();
    if (!content || loading) return;

    setInput('');
    setAtOpen(false);

    // @ 提及 -> 获取完整分析内容注入上下文
    const atIds = new Set(selectedHistoryIds);
    setSelectedHistoryIds([]);

    // 用已知的 atItems 精确移除 @ 提及文本
    let displayContent = content;
    for (const id of atIds) {
      const item = atItems.find(i => i.id === id);
      if (item) {
        const typeLabel = item.type === 'patrol' ? '巡检' : item.type === 'health' ? '诊断' : '日志';
        displayContent = displayContent.replace(`@${typeLabel} ${item.sourceName}`, '').trim();
      }
    }
    // 兜底：清除残留的 @ 提及标记
    displayContent = displayContent.replace(/@(?:巡检|诊断|日志)\s*/g, '').trim();

    // 获取完整记录上下文
    let contextBlock = '';
    if (atIds.size > 0) {
      try {
        const histRes = await fetch('/api/analysis/history');
        const histData = await histRes.json();
        const matched = (histData.records || []).filter((r: any) => atIds.has(r.id));
        if (matched.length > 0) {
          contextBlock = '\n\n---\n以下是从分析历史中引用的上下文：\n\n' +
            matched.map((r: any) => {
              const typeLabel = r.type === 'patrol' ? '🔍 巡检报告' : r.type === 'health' ? '🩺 健康诊断' : '📄 日志分析';
              const body = r.type !== 'log'
                ? `来源: ${r.sourceName}\n${r.summary || ''}\n\n分析结论:\n${r.analysis || '无'}`
                : `来源: ${r.sourceName}\n日志: ${r.log?.message || ''}\n\n分析:\n${r.analysis || '无'}`;
              return `### ${typeLabel}\n${body}`;
            }).join('\n\n---\n\n');
        }
      } catch {}
    }

    displayContent = displayContent + contextBlock;

    const userMsg = { role: 'user' as const, content: displayContent, ts: Date.now(), streaming: false };
    const assistantMsg = { role: 'assistant' as const, content: '', ts: Date.now() + 1, streaming: true, toolCalls: [] as any[] };
    setOpsMessages(prev => [...prev, userMsg, assistantMsg]);
    setLoading(true);
    abortRef.current = new AbortController();

    try {
      // 构建历史 — 包含工具调用信息（OpenAI 格式）
      const history: any[] = [];
      const recentMsgs = opsMessages.filter(m => !m.streaming).slice(-12);
      for (const m of recentMsgs) {
        if (m.role === 'assistant' && (m as any).toolCalls?.length > 0) {
          // Assistant 消息 + tool_calls
          const assistantMsg: any = { role: 'assistant', content: m.content || null };
          if ((m as any).reasoning_content) assistantMsg.reasoning_content = (m as any).reasoning_content;
          assistantMsg.tool_calls = (m as any).toolCalls
            .filter((tc: any) => tc.status === 'done')
            .map((tc: any) => ({
              id: `call_${tc.tool}_${Date.now()}`,
              type: 'function',
              function: { name: tc.tool, arguments: JSON.stringify(tc.args || {}) }
            }));
          history.push(assistantMsg);
          // 每个 tool_call 后跟 tool 消息
          for (const tc of (m as any).toolCalls.filter((t: any) => t.status === 'done')) {
            history.push({
              role: 'tool',
              tool_call_id: assistantMsg.tool_calls.find((t: any) => t.function.name === tc.tool)?.id || '',
              content: JSON.stringify(tc.result || {}).slice(0, 1000)
            });
          }
        } else {
          const msg: any = { role: m.role, content: m.content };
          if ((m as any).reasoning_content) msg.reasoning_content = (m as any).reasoning_content;
          history.push(msg);
        }
      }
      history.push({ role: 'user', content: displayContent });

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
              const p = JSON.parse(data);
              if (p.type === 'tool_start') {
                setOpsMessages(prev => prev.map((m, i) => i === prev.length - 1 ? {
                  ...m, toolCalls: [...(m.toolCalls || []), { tool: p.tool, args: p.args, status: 'running', result: null }]
                } : m));
              } else if (p.type === 'tool_result') {
                setOpsMessages(prev => prev.map((m, i) => i === prev.length - 1 ? {
                  ...m, toolCalls: (m.toolCalls || []).map((tc: any) =>
                    tc.tool === p.tool && tc.status === 'running' ? { ...tc, status: 'done', result: p.result } : tc
                  )
                } : m));
              } else if (p.content) {
                acc += p.content;
              } else if (p.reasoning_content) {
                setOpsMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, reasoning_content: p.reasoning_content } : m));
              }
            } catch {}
          }
        }
        setOpsMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, content: acc } : m));
      }
    } catch (e: any) {
      if (e.name !== 'AbortError')
        setOpsMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: `❌ ${e.message}`, streaming: false } : m));
    }
    setLoading(false);
    abortRef.current = null;
  };

  // 工具名 → 中文标签
  const toolLabel = (t: string) =>
    ({ docker_list: '列出容器', docker_logs: '读取日志', docker_inspect: '查看容器',
       docker_start: '启动容器', docker_stop: '停止容器', docker_restart: '重启容器',
       docker_exec: '执行命令', docker_health_check: '健康诊断',
       remote_servers: '远程服务器', remote_exec: '远程执行', remote_system_stats: '系统状态',
       remote_list_files: '文件列表', remote_read_file: '读取文件', remote_search_logs: '搜索日志',
       local_system_stats: '本机状态', local_log_files: '日志文件', local_read_log: '读取日志',
    } as Record<string, string>)[t] || t;

  const stopGeneration = () => abortRef.current?.abort();
  const clearChat = () => { if (opsMessages.length > 0) setOpsMessages([]); };
  const handleNewConv = () => { createOpsConv(); };

  const startRenameConv = (id: string, title: string) => { setEditingConvTitle(id); setConvTitleInput(title); };
  const commitRenameConv = () => {
    if (editingConvTitle && convTitleInput.trim()) renameOpsConv(editingConvTitle, convTitleInput.trim());
    setEditingConvTitle(null);
  };

  const openEdit = (fileName: string, content: string) => {
    setEditingFile(fileName); setEditContent(content); setShowNewForm(false); setNewFileName('');
  };
  const closeEdit = () => { setEditingFile(null); setEditContent(''); };

  const handleCreateFile = () => {
    if (!newFileName.trim()) return;
    saveMemory(newFileName.trim(), `# ${newFileName.trim()}\n\n`);
    setNewFileName(''); setShowNewForm(false);
  };
  const handleSaveEdit = () => {
    if (!editingFile) return;
    saveMemory(editingFile, editContent);
    closeEdit();
  };

  const filteredAt = atItems.filter(i =>
    !atFilter || (i.sourceName + i.type).toLowerCase().includes(atFilter.toLowerCase())
  );

  return (
    <div className="flex h-[calc(100vh-8rem)] animate-fade-in gap-4">
      {/* 左侧：对话列表 */}
      {sidebarOpen && (
        <div className="w-64 flex-shrink-0 flex flex-col bg-dark-900 border border-dark-800 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-accent-500/20"><Sparkles className="w-4 h-4 text-accent-400" /></div>
              <span className="text-sm font-semibold text-dark-100">运维助手</span>
            </div>
            <button onClick={handleNewConv} className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-accent-400 transition-colors" title="新建对话">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-dark-800/60">
            {opsConvs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center px-4">
                <MessageSquare className="w-8 h-8 text-dark-700 mb-2" />
                <p className="text-xs text-dark-600">暂无对话</p>
              </div>
            ) : opsConvs.map(conv => (
              <ConvItem key={conv.id} title={conv.title} isActive={conv.id === opsActiveId}
                onSelect={() => switchOpsConv(conv.id)}
                onDelete={() => opsConvs.length > 1 && deleteOpsConv(conv.id)} />
            ))}
          </div>
        </div>
      )}

      {/* 主区：聊天 */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* 顶栏 */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-3">
            {!sidebarOpen && (
              <button onClick={() => setSidebarOpen(true)} className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors">
                <Sidebar className="w-4 h-4" />
              </button>
            )}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-dark-900 border border-dark-800 rounded-lg">
              {editingConvTitle && editingConvTitle === activeConv?.id ? (
                <input value={convTitleInput} onChange={e => setConvTitleInput(e.target.value)}
                  onBlur={commitRenameConv} onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) commitRenameConv(); if (e.key === 'Escape') setEditingConvTitle(null); }}
                  autoFocus className="bg-transparent text-sm text-dark-200 outline-none w-48" />
              ) : (
                <>
                  <span className="text-sm text-dark-400 max-w-48 truncate">{activeConv?.title || '运维助手'}</span>
                  <span className="text-xs text-dark-600">{opsMessages.length} 条</span>
                  {activeConv && (
                    <button onClick={() => startRenameConv(activeConv.id, activeConv.title)}
                      className="p-0.5 rounded hover:bg-dark-700 text-dark-600 hover:text-dark-400 transition-colors">
                      <Pencil className="w-3 h-3" />
                    </button>
                  )}
                </>
              )}
            </div>
            <span className="text-xs text-dark-600 hidden sm:inline">
              输入 @ 可引用分析历史
            </span>
          </div>
          <div className="flex items-center gap-2">
            {opsMessages.length > 0 && (
              <button onClick={clearChat}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-dark-400 hover:text-red-400 hover:bg-red-500/10 border border-dark-800 transition-colors">
                <Trash2 className="w-3.5 h-3.5" /> 清空
              </button>
            )}
            {/* <button onClick={() => setMemoryPanelOpen(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                memoryPanelOpen ? 'text-accent-400 bg-accent-500/10 border-accent-500/30' : 'text-dark-400 hover:text-accent-400 hover:bg-accent-500/10 border-dark-800'
              }`}>
              <BookOpen className="w-3.5 h-3.5" /> 知识库
              {memoryFiles.length > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-accent-500/20 text-accent-400 text-xs">{memoryFiles.length}</span>}
            </button> */}
          </div>
        </div>

        {/* 消息区 */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {opsMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-dark-500">
              <div className="w-16 h-16 rounded-2xl bg-accent-500/10 flex items-center justify-center mb-4">
                <Terminal className="w-8 h-8 text-accent-500/40" />
              </div>
              <p className="text-sm font-medium text-dark-400 mb-1">怎么帮你？</p>
              <p className="text-xs text-dark-600 mb-2">能看日志、查容器、分析异常，输入 @ 还能引用历史报告</p>
              {memoryFiles.length > 0 && (
                <p className="text-xs text-accent-400/80 mb-4">📚 {memoryFiles.length} 个知识库已加载</p>
              )}
              <div className="flex flex-wrap justify-center gap-2 max-w-lg mt-2">
                {QUICK_PROMPTS.map((q, i) => (
                  <button key={i} onClick={() => sendMessage(q)}
                    className="px-3 py-1.5 rounded-lg bg-dark-900 border border-dark-800 text-xs text-dark-400 hover:text-dark-200 hover:border-dark-700 transition-all">
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
                    <button key={f.name} onClick={() => openEdit(f.name, f.content)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-accent-500/10 border border-accent-500/20 text-xs text-accent-400 hover:bg-accent-500/20 transition-colors">
                      <BookOpen className="w-3 h-3" /> {f.name}
                    </button>
                  ))}
                </div>
              )}
              {opsMessages.map((msg, i) => (
                <div key={msg.ts} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  {msg.role === 'assistant' && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent-500/20 flex items-center justify-center mt-0.5">
                      <Bot className="w-4 h-4 text-accent-400" />
                    </div>
                  )}
                  <div className={`max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === 'user' ? 'bg-accent-500/20 text-dark-100 rounded-br-md' : 'bg-dark-900 border border-dark-800 text-dark-200 rounded-bl-md'
                  }`}>
                    {/* 工具调用状态 */}
                    {(msg as any).toolCalls?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {(msg as any).toolCalls.map((tc: any, i: number) => (
                          <span key={i} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${
                            tc.status === 'running' ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20' :
                            tc.status === 'done' && tc.result?.error ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                            'bg-green-500/10 text-green-400 border border-green-500/20'
                          }`}>
                            {tc.status === 'running' && <Loader className="w-3 h-3 animate-spin" />}
                            {toolLabel(tc.tool)}
                          </span>
                        ))}
                      </div>
                    )}
                    {msg.content ? (
                      <div className="prose-invert [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono
                        [&_pre]:bg-dark-800 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:mt-2 [&_pre]:overflow-x-auto
                        [&_strong]:text-dark-100 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4
                        [&_li]:text-xs [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1_h2_h3]:font-bold [&_h1_h2_h3]:mt-2 [&_h1_h2_h3]:mb-1
                        [&_p]:my-1" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                    ) : msg.streaming ? (
                      <div className="flex items-center gap-2 text-dark-500"><Loader className="w-4 h-4 animate-spin" /> 思考中...</div>
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

        {/* 输入区 */}
        <div className="flex-shrink-0 pt-3 border-t border-dark-800 relative">
          <div className="flex items-end gap-2">
            <div className="relative flex-1">
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={e => { handleAtKey(e); if (e.key === 'Enter' && !e.shiftKey && !atOpen && !(e.nativeEvent as any).isComposing) { e.preventDefault(); sendMessage(); } }}
                placeholder="输入问题，Shift+Enter 换行，@ 引用分析历史..."
                rows={1}
                className="w-full px-4 py-3 bg-dark-900 border border-dark-800 rounded-xl text-sm text-dark-200 placeholder-dark-600
                  focus:outline-none focus:border-accent-500/50 resize-none"
                style={{ minHeight: '48px', maxHeight: '120px' }}
                onInput={e => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }}
              />
              {/* @ 提及下拉 */}
              {atOpen && filteredAt.length > 0 && (
                <div ref={atRef} className="absolute bottom-full left-0 mb-1 w-80 max-h-48 overflow-y-auto bg-dark-800 border border-dark-700 rounded-xl shadow-2xl z-50">
                  <div className="px-3 py-1.5 text-[10px] text-dark-500 uppercase tracking-wider border-b border-dark-700/50">分析历史</div>
                  {filteredAt.map((item, i) => {
                    const typeLabel = item.type === 'patrol' ? '🔍 巡检' : item.type === 'health' ? '🩺 诊断' : '📄 日志';
                    return (
                      <button key={item.id}
                        onClick={() => selectAtItem(item)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-dark-700 transition-colors ${
                          i === atIdx ? 'bg-dark-700/80' : ''
                        }`}>
                        <History className="w-3 h-3 text-dark-500 flex-shrink-0" />
                        <span className="text-dark-400 flex-shrink-0">{typeLabel}</span>
                        <span className="text-dark-200 truncate">{item.sourceName}</span>
                        <span className="text-dark-600 text-[10px] ml-auto">{new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {loading ? (
              <button onClick={stopGeneration}
                className="flex-shrink-0 w-12 h-12 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors flex items-center justify-center">
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button onClick={() => sendMessage()} disabled={!input.trim()}
                className="flex-shrink-0 w-12 h-12 rounded-xl bg-accent-500 text-white hover:bg-accent-600 transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed">
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 右侧：知识库 */}
      {memoryPanelOpen && (
        <div className="w-80 flex-shrink-0 flex flex-col bg-dark-900 border border-dark-800 rounded-xl overflow-hidden animate-scale-in">
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800">
            {/* <div className="flex items-center gap-2"><BookOpen className="w-4 h-4 text-accent-400" /><span className="text-sm font-semibold text-dark-100">知识库</span></div> */}
            <div className="flex items-center gap-1">
              <button onClick={() => { setShowNewForm(v => !v); setEditingFile(null); setEditContent(''); }}
                className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-400 hover:text-accent-400 transition-colors"><Plus className="w-4 h-4" /></button>
              <button onClick={() => setMemoryPanelOpen(false)} className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-200 transition-colors"><X className="w-4 h-4" /></button>
            </div>
          </div>
          {showNewForm && (
            <div className="px-4 py-3 border-b border-dark-800 bg-dark-950/50">
              <input autoFocus value={newFileName} onChange={e => setNewFileName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleCreateFile(); if (e.key === 'Escape') setShowNewForm(false); }}
                placeholder="文件名（如：Docker 运维指南）"
                className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50 mb-2" />
              <div className="flex gap-2">
                <button onClick={handleCreateFile} className="flex-1 px-3 py-1.5 rounded-lg bg-accent-500 text-white text-xs font-medium hover:bg-accent-600">创建</button>
                <button onClick={() => setShowNewForm(false)} className="px-3 py-1.5 rounded-lg bg-dark-800 text-dark-400 text-xs hover:bg-dark-700">取消</button>
              </div>
            </div>
          )}
          {editingFile ? (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between px-4 py-2 border-b border-dark-800 bg-accent-500/5">
                <span className="text-xs text-accent-400 font-medium flex items-center gap-1"><FileText className="w-3.5 h-3.5" /> {editingFile}</span>
                <div className="flex gap-1">
                  <button onClick={handleSaveEdit} className="p-1 rounded hover:bg-accent-500/20 text-accent-400"><Save className="w-3.5 h-3.5" /></button>
                  <button onClick={closeEdit} className="p-1 rounded hover:bg-dark-800 text-dark-500"><X className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <textarea autoFocus value={editContent} onChange={e => setEditContent(e.target.value)}
                className="flex-1 w-full px-4 py-3 bg-dark-950 text-xs text-dark-200 font-mono leading-relaxed resize-none focus:outline-none"
                style={{ minHeight: '200px' }} placeholder="# 文件名&#10;&#10;在此编写 Markdown 内容..." />
            </div>
          ) : (
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
                          <button onClick={() => openEdit(file.name, file.content)}
                            className="text-sm text-dark-200 hover:text-accent-400 transition-colors text-left truncate block w-full">{file.name}</button>
                          <div className="text-xs text-dark-600 mt-0.5">{new Date(file.updatedAt).toLocaleString('zh-CN')}</div>
                        </div>
                        <button onClick={() => deleteMemory(file.name)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/20 text-dark-500 hover:text-red-400 transition-all"><X className="w-3.5 h-3.5" /></button>
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
