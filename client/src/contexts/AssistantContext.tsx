import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';

export interface AssistantMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  streaming?: boolean;
}

export interface AssistantConversation {
  id: string;
  title: string;
  messages: AssistantMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface AssistantTip {
  id: string;
  preview: string;
  tab?: 'ops' | 'docs';
  ts: number;
}

export interface MemoryFile {
  name: string;
  path: string;
  content: string;
  updatedAt: number;
}

// 所有会话数据的 shape
export interface AssistantStore {
  opsConvs: AssistantConversation[];
  opsActiveId: string | null;
  docConvs: AssistantConversation[];
  docActiveId: string | null;
}

interface AssistantContextValue {
  // 运维助手
  opsConvs: AssistantConversation[];
  opsActiveId: string | null;
  opsMessages: AssistantMessage[];
  setOpsMessages: (msgs: AssistantMessage[] | ((p: AssistantMessage[]) => AssistantMessage[])) => void;
  createOpsConv: () => string;
  switchOpsConv: (id: string) => void;
  deleteOpsConv: (id: string) => void;
  renameOpsConv: (id: string, title: string) => void;
  // 文档助手
  docConvs: AssistantConversation[];
  docActiveId: string | null;
  docMessages: AssistantMessage[];
  setDocMessages: (msgs: AssistantMessage[] | ((p: AssistantMessage[]) => AssistantMessage[])) => void;
  createDocConv: () => string;
  switchDocConv: (id: string) => void;
  deleteDocConv: (id: string) => void;
  renameDocConv: (id: string, title: string) => void;
  // 知识库
  memoryFiles: MemoryFile[];
  reloadMemory: () => Promise<void>;
  deleteMemory: (name: string) => Promise<void>;
  saveMemory: (name: string, content: string) => Promise<void>;
  // 页面状态
  isOnAssistantPage: boolean;
  isOnDevAssistantPage: boolean;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

const STORAGE_KEY = 'openlog_assistant_v2';

function genId() { return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

function makeConv(title: string): AssistantConversation {
  return { id: genId(), title, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
}

const DEFAULT_STORE: AssistantStore = (() => {
  const ops = makeConv('运维对话 1');
  const docs = makeConv('文档对话 1');
  return { opsConvs: [ops], opsActiveId: ops.id, docConvs: [docs], docActiveId: docs.id };
})();

function loadStore(): AssistantStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STORE;
    const parsed = JSON.parse(raw) as Partial<AssistantStore>;
    if (!Array.isArray(parsed.opsConvs) || !parsed.opsConvs.length) {
      const ops = makeConv('运维对话 1');
      parsed.opsConvs = [ops];
      parsed.opsActiveId = ops.id;
    }
    if (!Array.isArray(parsed.docConvs) || !parsed.docConvs.length) {
      const docs = makeConv('文档对话 1');
      parsed.docConvs = [docs];
      parsed.docActiveId = docs.id;
    }
    return {
      opsConvs: parsed.opsConvs,
      opsActiveId: parsed.opsActiveId ?? null,
      docConvs: parsed.docConvs,
      docActiveId: parsed.docActiveId ?? null,
    };
  } catch {
    return DEFAULT_STORE;
  }
}

function persist(s: AssistantStore) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

// 在 streaming 结束时发送 Tip
function dispatchTip(tab: 'ops' | 'docs', isOnPage: boolean) {
  return (prevMsgs: AssistantMessage[], nextMsgs: AssistantMessage[]) => {
    const prevLast = prevMsgs[prevMsgs.length - 1];
    const nextLast = nextMsgs[nextMsgs.length - 1];
    if (
      prevLast?.streaming === true &&
      nextLast?.streaming === false &&
      nextLast?.role === 'assistant' &&
      nextLast?.content &&
      !isOnPage
    ) {
      window.dispatchEvent(new CustomEvent('assistant-tip', {
        detail: { id: `${tab}-${Date.now()}`, preview: nextLast.content.slice(0, 80), tab, ts: Date.now() } as AssistantTip,
      }));
    }
  };
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [store, setStore] = useState<AssistantStore>(loadStore);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  const location = useLocation();

  const isOnAssistantPage = location.pathname === '/assistant';
  const isOnDevAssistantPage = location.pathname === '/dev-assistant';

  useEffect(() => { persist(store); }, [store]);

  // 知识库
  const reloadMemory = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/memory');
      if (res.ok) setMemoryFiles((await res.json()).files || []);
    } catch {}
  }, []);
  useEffect(() => { reloadMemory(); }, [reloadMemory]);

  const deleteMemory = useCallback(async (name: string) => {
    try { await fetch(`/api/assistant/memory/${encodeURIComponent(name)}`, { method: 'DELETE' }); await reloadMemory(); } catch {}
  }, [reloadMemory]);

  const saveMemory = useCallback(async (name: string, content: string) => {
    try {
      await fetch('/api/assistant/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) });
      await reloadMemory();
    } catch {}
  }, [reloadMemory]);

  // 运维助手消息
  const opsMessages: AssistantMessage[] = (() => {
    const c = store.opsConvs.find(x => x.id === store.opsActiveId);
    return c?.messages ?? [];
  })();

  const setOpsMessages = useCallback((
    updater: AssistantMessage[] | ((p: AssistantMessage[]) => AssistantMessage[])
  ) => {
    setStore(s => {
      const nextConvs = s.opsConvs.map(c =>
        c.id === s.opsActiveId
          ? { ...c, messages: typeof updater === 'function' ? updater(c.messages) : updater, updatedAt: Date.now() }
          : c
      );
      const prevConv = s.opsConvs.find(c => c.id === s.opsActiveId);
      const nextConv = nextConvs.find(c => c.id === s.opsActiveId);
      if (prevConv && nextConv) dispatchTip('ops', isOnAssistantPage)(prevConv.messages, nextConv.messages);
      return { ...s, opsConvs: nextConvs };
    });
  }, [isOnAssistantPage]);

  const createOpsConv = useCallback(() => {
    const c = makeConv(`运维对话 ${store.opsConvs.length + 1}`);
    setStore(s => ({ ...s, opsConvs: [c, ...s.opsConvs], opsActiveId: c.id }));
    return c.id;
  }, [store.opsConvs.length]);

  const switchOpsConv = useCallback((id: string) => { setStore(s => ({ ...s, opsActiveId: id })); }, []);
  const deleteOpsConv = useCallback((id: string) => {
    setStore(s => {
      const convs = s.opsConvs.filter(c => c.id !== id);
      if (convs.length === 0) {
        const nc = makeConv('运维对话 1');
        return { ...s, opsConvs: [nc], opsActiveId: nc.id };
      }
      return { ...s, opsConvs: convs, opsActiveId: s.opsActiveId === id ? convs[0].id : s.opsActiveId };
    });
  }, []);

  const renameOpsConv = useCallback((id: string, title: string) => {
    setStore(s => ({ ...s, opsConvs: s.opsConvs.map(c => c.id === id ? { ...c, title } : c) }));
  }, []);

  // 文档助手消息
  const docMessages: AssistantMessage[] = (() => {
    const c = store.docConvs.find(x => x.id === store.docActiveId);
    return c?.messages ?? [];
  })();

  const setDocMessages = useCallback((
    updater: AssistantMessage[] | ((p: AssistantMessage[]) => AssistantMessage[])
  ) => {
    setStore(s => {
      const nextConvs = s.docConvs.map(c =>
        c.id === s.docActiveId
          ? { ...c, messages: typeof updater === 'function' ? updater(c.messages) : updater, updatedAt: Date.now() }
          : c
      );
      const prevConv = s.docConvs.find(c => c.id === s.docActiveId);
      const nextConv = nextConvs.find(c => c.id === s.docActiveId);
      if (prevConv && nextConv) dispatchTip('docs', isOnDevAssistantPage)(prevConv.messages, nextConv.messages);
      return { ...s, docConvs: nextConvs };
    });
  }, [isOnDevAssistantPage]);

  const createDocConv = useCallback(() => {
    const c = makeConv(`文档对话 ${store.docConvs.length + 1}`);
    setStore(s => ({ ...s, docConvs: [c, ...s.docConvs], docActiveId: c.id }));
    return c.id;
  }, [store.docConvs.length]);

  const switchDocConv = useCallback((id: string) => { setStore(s => ({ ...s, docActiveId: id })); }, []);
  const deleteDocConv = useCallback((id: string) => {
    setStore(s => {
      const convs = s.docConvs.filter(c => c.id !== id);
      if (convs.length === 0) {
        const nc = makeConv('文档对话 1');
        return { ...s, docConvs: [nc], docActiveId: nc.id };
      }
      return { ...s, docConvs: convs, docActiveId: s.docActiveId === id ? convs[0].id : s.docActiveId };
    });
  }, []);

  const renameDocConv = useCallback((id: string, title: string) => {
    setStore(s => ({ ...s, docConvs: s.docConvs.map(c => c.id === id ? { ...c, title } : c) }));
  }, []);

  return (
    <AssistantContext.Provider value={{
      opsConvs: store.opsConvs,
      opsActiveId: store.opsActiveId,
      opsMessages,
      setOpsMessages,
      createOpsConv,
      switchOpsConv,
      deleteOpsConv,
      renameOpsConv,
      docConvs: store.docConvs,
      docActiveId: store.docActiveId,
      docMessages,
      setDocMessages,
      createDocConv,
      switchDocConv,
      deleteDocConv,
      renameDocConv,
      memoryFiles,
      reloadMemory,
      deleteMemory,
      saveMemory,
      isOnAssistantPage,
      isOnDevAssistantPage,
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
