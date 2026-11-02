import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { apiFetch, apiJson } from '../api/client';

export interface AssistantMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  streaming?: boolean;
  toolCalls?: {
    tool: string;
    args: any;
    status: string;
    result: any;
    /** 该步骤耗时（毫秒），后端 tool_result 里带 */
    durationMs?: number;
    /** 流式输出（remote_exec 等）：后端 tool_progress 推来的片段 */
    liveOutput?: string;
  }[];
}

/** 会话级上下文覆盖（齿轮面板改的），留空项表示沿用设置页/默认值 */
export interface ContextSettings {
  windowTokens?: number;
  budgetTokens?: number;
  maxOutputTokens?: number;
  autoCompact?: boolean;
  compactAt?: number;
  warnAt?: number;
  maxRounds?: number;
  maxWallMs?: number;
  toolResultChars?: number;
}

/** 最近一次请求的上下文用量（后端 SSE context_usage 推来，用于底部用量条） */
export interface ContextUsage {
  used: number;
  budget: number;
  window: number;
  percent: number;
  breakdown?: { system: number; tools: number; messages: number };
  rounds?: number;
  compacted?: number;
  /** true = 后端没有真实 usage，用估算值（前端显示 ~ 号） */
  estimated?: boolean;
  providerUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
  at: number;
}

export interface AssistantConversation {
  id: string;
  title: string;
  messages: AssistantMessage[];
  createdAt: number;
  updatedAt: number;
  /** 本会话的上下文覆盖（随会话保存，切回来还在） */
  contextSettings?: ContextSettings;
  /** 本会话最近一次的上下文用量（会话列表可显示百分比） */
  contextUsage?: ContextUsage;
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
  /** 当前会话的上下文覆盖 + 最近用量 */
  opsContextSettings: ContextSettings;
  opsContextUsage: ContextUsage | null;
  setOpsContextSettings: (patch: ContextSettings | null) => void;
  setOpsContextUsage: (usage: ContextUsage | null) => void;
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

/**
 * 历史消息清洗：把上次刷新/中断时残留的「运行中」状态收尾。
 *
 * 真实 bug：旧版本对话存进 localStorage 时，如果最后一个工具调用没等到
 * tool_result（关页面、断网、SSE 事件被 chunk 切断），刷新后 chip 会永远转圈。
 * 本地没有正在跑的请求，所以任何 persisted 的 running 一律视为已中断。
 */
function sanitizeMessages(messages: AssistantMessage[] | undefined): AssistantMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const hasRunningTools = Array.isArray(m.toolCalls) && m.toolCalls.some(tc => tc.status === 'running');
    if (!m.streaming && !hasRunningTools) return m;
    return {
      ...m,
      streaming: false,
      ...(hasRunningTools
        ? { toolCalls: (m.toolCalls || []).map(tc => (tc.status === 'running' ? { ...tc, status: 'aborted' } : tc)) }
        : {}),
    };
  });
}

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
      opsConvs: parsed.opsConvs.map(c => ({ ...c, messages: sanitizeMessages(c.messages) })),
      opsActiveId: parsed.opsActiveId ?? null,
      docConvs: parsed.docConvs.map(c => ({ ...c, messages: sanitizeMessages(c.messages) })),
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

  useEffect(() => { persist(store); }, [store]);

  // 知识库
  const reloadMemory = useCallback(async () => {
    try {
      const data = await apiFetch<{ files?: MemoryFile[] }>('/api/assistant/memory');
      setMemoryFiles(data.files || []);
    } catch {}
  }, []);
  useEffect(() => { reloadMemory(); }, [reloadMemory]);

  const deleteMemory = useCallback(async (name: string) => {
    try { await apiFetch(`/api/assistant/memory/${encodeURIComponent(name)}`, { method: 'DELETE' }); await reloadMemory(); } catch {}
  }, [reloadMemory]);

  const saveMemory = useCallback(async (name: string, content: string) => {
    try {
      await apiJson('/api/assistant/memory', 'POST', { name, content });
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

  // ── 上下文设置/用量（会话级）──────────────────────────────────────
  const activeOpsConv = store.opsConvs.find(c => c.id === store.opsActiveId);
  const opsContextSettings: ContextSettings = activeOpsConv?.contextSettings || {};
  const opsContextUsage: ContextUsage | null = activeOpsConv?.contextUsage || null;

  const setOpsContextSettings = useCallback((patch: ContextSettings | null) => {
    setStore(s => ({
      ...s,
      opsConvs: s.opsConvs.map(c => {
        if (c.id !== s.opsActiveId) return c;
        if (patch === null) {
          const { contextSettings: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, contextSettings: { ...(c.contextSettings || {}), ...patch } };
      }),
    }));
  }, []);

  const setOpsContextUsage = useCallback((usage: ContextUsage | null) => {
    setStore(s => ({
      ...s,
      opsConvs: s.opsConvs.map(c => (c.id === s.opsActiveId ? { ...c, contextUsage: usage || undefined } : c)),
    }));
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
      if (prevConv && nextConv) dispatchTip('docs', false)(prevConv.messages, nextConv.messages);
      return { ...s, docConvs: nextConvs };
    });
  }, []);

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
      opsContextSettings,
      opsContextUsage,
      setOpsContextSettings,
      setOpsContextUsage,
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
