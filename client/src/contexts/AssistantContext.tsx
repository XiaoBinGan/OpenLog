import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';

export interface MemoryFile {
  name: string;          // 文件名（不含.md）
  path: string;         // 完整路径
  content: string;      // 内容
  updatedAt: number;    // 更新时间戳
}

export interface AssistantMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  streaming?: boolean;
}

interface ToastTip {
  id: string;
  preview: string;
  ts: number;
}

interface AssistantContextValue {
  messages: AssistantMessage[];
  setMessages: (msgs: AssistantMessage[] | ((prev: AssistantMessage[]) => AssistantMessage[])) => void;
  isOnAssistantPage: boolean;
  memoryFiles: MemoryFile[];
  reloadMemory: () => Promise<void>;
  deleteMemory: (name: string) => Promise<void>;
  saveMemory: (name: string, content: string) => Promise<void>;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

const STORAGE_KEY = 'openlog_assistant_messages';
const MEMORY_DIR = 'assistant_memory';

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessagesState] = useState<AssistantMessage[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  const [isOnAssistantPage, setIsOnAssistantPage] = useState(false);
  const location = useLocation();
  const pendingTipRef = useRef<ToastTip | null>(null);

  // 同步 localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  // 跟踪当前页面
  useEffect(() => {
    setIsOnAssistantPage(location.pathname === '/assistant');
  }, [location.pathname]);

  // 读取内存文件列表
  const reloadMemory = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/memory');
      if (res.ok) {
        const data = await res.json();
        setMemoryFiles(data.files || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { reloadMemory(); }, [reloadMemory]);

  // 删除内存文件
  const deleteMemory = useCallback(async (name: string) => {
    try {
      await fetch(`/api/assistant/memory/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await reloadMemory();
    } catch { /* ignore */ }
  }, [reloadMemory]);

  // 保存内存文件
  const saveMemory = useCallback(async (name: string, content: string) => {
    try {
      await fetch('/api/assistant/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      await reloadMemory();
    } catch { /* ignore */ }
  }, [reloadMemory]);

  // 封装的 setMessages：每当 AI 回答完成（streaming → false）且不在助手页面时，触发 Tip
  const setMessages = useCallback((updater: AssistantMessage[] | ((prev: AssistantMessage[]) => AssistantMessage[])) => {
    setMessagesState(prev => {
      const next = typeof updater === 'function' ? (updater as Function)(prev) : updater;

      // 检测 streaming 消息完成
      const prevLast = prev[prev.length - 1];
      const nextLast = next[next.length - 1];
      if (
        prevLast?.streaming === true &&
        nextLast?.streaming === false &&
        nextLast?.role === 'assistant' &&
        nextLast?.content &&
        !isOnAssistantPage
      ) {
        // 触发 Tip
        pendingTipRef.current = {
          id: `tip-${Date.now()}`,
          preview: nextLast.content.slice(0, 80),
          ts: Date.now(),
        };
        // 通过自定义事件广播（供 Layout/AIAnalysisToast 消费）
        window.dispatchEvent(new CustomEvent('assistant-tip', { detail: pendingTipRef.current }));
      }

      return next;
    });
  }, [isOnAssistantPage]);

  return (
    <AssistantContext.Provider value={{
      messages, setMessages, isOnAssistantPage,
      memoryFiles, reloadMemory, deleteMemory, saveMemory,
    }}>
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistantContext() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error('useAssistantContext must be used inside AssistantProvider');
  return ctx;
}

export { MEMORY_DIR };
