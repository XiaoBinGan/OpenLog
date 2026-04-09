import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';

export interface MemoryFile {
  name: string;
  path: string;
  content: string;
  updatedAt: number;
}

export interface AssistantMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  streaming?: boolean;
}

export interface AssistantTip {
  id: string;
  preview: string;
  tab?: 'ops' | 'docs';
  ts: number;
}

interface AssistantContextValue {
  // 运维助手消息（持久化到 localStorage）
  messages: AssistantMessage[];
  setMessages: (msgs: AssistantMessage[] | ((prev: AssistantMessage[]) => AssistantMessage[])) => void;
  // 文档助手消息（持久化到 localStorage）
  docMessages: AssistantMessage[];
  setDocMessages: (msgs: AssistantMessage[] | ((prev: AssistantMessage[]) => AssistantMessage[])) => void;
  // 当前活跃文档 ID（持久化）
  activeDocId: string | null;
  setActiveDocId: (id: string | null) => void;
  // 当前活跃对话 ID（持久化）
  activeConvId: string | null;
  setActiveConvId: (id: string | null) => void;
  // 页面状态
  isOnAssistantPage: boolean;  // /assistant 或 /dev-assistant
  // 知识库文件
  memoryFiles: MemoryFile[];
  reloadMemory: () => Promise<void>;
  deleteMemory: (name: string) => Promise<void>;
  saveMemory: (name: string, content: string) => Promise<void>;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

const STORAGE_KEY_MSGS = 'openlog_assistant_messages';
const STORAGE_KEY_DOC_MSGS = 'openlog_doc_messages';
const STORAGE_KEY_DOC_ID = 'openlog_active_doc_id';
const STORAGE_KEY_CONV_ID = 'openlog_active_conv_id';
const MEMORY_DIR = 'assistant_memory';

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  // 运维助手消息
  const [messages, setMessagesState] = useState<AssistantMessage[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_MSGS) || '[]'); }
    catch { return []; }
  });

  // 文档助手消息
  const [docMessages, setDocMessagesState] = useState<AssistantMessage[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_DOC_MSGS) || '[]'); }
    catch { return []; }
  });

  // 当前文档 ID
  const [activeDocId, setActiveDocId] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_KEY_DOC_ID);
  });

  // 当前对话 ID
  const [activeConvId, setActiveConvId] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_KEY_CONV_ID);
  });

  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  const location = useLocation();

  // 持久化：运维助手消息
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_MSGS, JSON.stringify(messages));
  }, [messages]);

  // 持久化：文档助手消息
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_DOC_MSGS, JSON.stringify(docMessages));
  }, [docMessages]);

  // 持久化：活跃文档
  useEffect(() => {
    if (activeDocId) localStorage.setItem(STORAGE_KEY_DOC_ID, activeDocId);
    else localStorage.removeItem(STORAGE_KEY_DOC_ID);
  }, [activeDocId]);

  // 持久化：活跃对话
  useEffect(() => {
    if (activeConvId) localStorage.setItem(STORAGE_KEY_CONV_ID, activeConvId);
    else localStorage.removeItem(STORAGE_KEY_CONV_ID);
  }, [activeConvId]);

  // 跟踪当前页面（/assistant 和 /dev-assistant 都算助手页面）
  const isOnAssistantPage = ['/assistant', '/dev-assistant'].includes(location.pathname);

  // 读取知识库文件
  const reloadMemory = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/memory');
      if (res.ok) setMemoryFiles((await res.json()).files || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { reloadMemory(); }, [reloadMemory]);

  const deleteMemory = useCallback(async (name: string) => {
    try {
      await fetch(`/api/assistant/memory/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await reloadMemory();
    } catch { /* ignore */ }
  }, [reloadMemory]);

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

  // 封装 setMessages：检测 streaming → false，触发 Tip（如果不在助手页面）
  const setMessages = useCallback((
    updater: AssistantMessage[] | ((prev: AssistantMessage[]) => AssistantMessage[])
  ) => {
    setMessagesState(prev => {
      const next = typeof updater === 'function' ? (updater as Function)(prev) : updater;
      const prevLast = prev[prev.length - 1];
      const nextLast = next[next.length - 1];
      if (
        prevLast?.streaming === true &&
        nextLast?.streaming === false &&
        nextLast?.role === 'assistant' &&
        nextLast?.content &&
        !isOnAssistantPage
      ) {
        const tip: AssistantTip = {
          id: `ops-tip-${Date.now()}`,
          preview: nextLast.content.slice(0, 80),
          tab: 'ops',
          ts: Date.now(),
        };
        window.dispatchEvent(new CustomEvent('assistant-tip', { detail: tip }));
      }
      return next;
    });
  }, [isOnAssistantPage]);

  // 封装 setDocMessages：检测 streaming → false，触发 Tip
  const setDocMessages = useCallback((
    updater: AssistantMessage[] | ((prev: AssistantMessage[]) => AssistantMessage[])
  ) => {
    setDocMessagesState(prev => {
      const next = typeof updater === 'function' ? (updater as Function)(prev) : updater;
      const prevLast = prev[prev.length - 1];
      const nextLast = next[next.length - 1];
      if (
        prevLast?.streaming === true &&
        nextLast?.streaming === false &&
        nextLast?.role === 'assistant' &&
        nextLast?.content &&
        !isOnAssistantPage
      ) {
        const tip: AssistantTip = {
          id: `doc-tip-${Date.now()}`,
          preview: nextLast.content.slice(0, 80),
          tab: 'docs',
          ts: Date.now(),
        };
        window.dispatchEvent(new CustomEvent('assistant-tip', { detail: tip }));
      }
      return next;
    });
  }, [isOnAssistantPage]);

  return (
    <AssistantContext.Provider value={{
      messages, setMessages,
      docMessages, setDocMessages,
      activeDocId, setActiveDocId,
      activeConvId, setActiveConvId,
      isOnAssistantPage,
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
