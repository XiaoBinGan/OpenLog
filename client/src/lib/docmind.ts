// DocMind API 客户端 — 通过 Vite 代理连接 DocMind 后端（端口 8000）
const API_BASE = '/api/docmind';

export interface DocDocument {
  id: string;
  name: string;
  file_type: string;
  file_size: number;
  page_count: number;
  index_status: 'pending' | 'indexing' | 'ready' | 'error';
  index_tree: IndexNode | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface IndexNode {
  id: string;
  title: string;
  page_start: number;
  page_end: number;
  level: number;
  content_summary?: string;
  children: IndexNode[];
}

export interface DocConversation {
  id: string;
  title: string;
  document_id: string | null;
  messages: DocMessage[];
  created_at: string;
  updated_at: string;
}

export interface DocMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  references: DocReference[] | null;
  created_at: string;
}

export interface DocReference {
  page: number;
  reason: string;
  preview: string;
}

export interface ChatRequest {
  message: string;
  conversation_id?: string;
  document_id?: string;
  stream?: boolean;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Request failed' }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export const docmind = {
  // 文档管理
  async listDocuments(): Promise<{ documents: DocDocument[]; total: number }> {
    return request('/documents');
  },

  async uploadDocument(file: File, onProgress?: (p: number) => void): Promise<DocDocument> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(new Error(`Upload failed: ${xhr.status}`));
      });
      xhr.addEventListener('error', () => reject(new Error('Upload failed')));
      xhr.open('POST', `${API_BASE}/documents/upload`);
      const fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    });
  },

  async deleteDocument(id: string): Promise<void> {
    await request(`/documents/${id}`, { method: 'DELETE' });
  },

  async reindexDocument(id: string): Promise<void> {
    await request(`/documents/${id}/reindex`, { method: 'POST' });
  },

  // 对话管理
  async listConversations(documentId?: string): Promise<{ conversations: DocConversation[]; total: number }> {
    const params = documentId ? `?document_id=${documentId}` : '';
    return request(`/conversations${params}`);
  },

  async deleteConversation(id: string): Promise<void> {
    await request(`/conversations/${id}`, { method: 'DELETE' });
  },

  // 流式聊天
  async chatStream(
    request_: ChatRequest,
    callbacks: {
      onChunk: (chunk: string) => void;
      onDone: (messageId: string, conversationId: string) => void;
      onStatus?: (status: string) => void;
    }
  ): Promise<void> {
    const { onChunk, onDone, onStatus } = callbacks;
    const res = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request_, stream: true }),
    });

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    let messageId = '';
    let conversationId = '';
    let doneReceived = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue; }
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (!data) continue;
          if (currentEvent === 'chunk') onChunk(data);
          else if (currentEvent === 'done') { messageId = data; doneReceived = true; onStatus?.('完成'); }
          else if (currentEvent === 'conversation_id') {
            conversationId = data;
            if (doneReceived) onDone(messageId, conversationId);
          }
        }
      }
    }

    const finalLines = buffer.split('\n');
    for (let i = 0; i < finalLines.length; i++) {
      if (finalLines[i].startsWith('event:')) { currentEvent = finalLines[i].slice(6).trim(); continue; }
      if (finalLines[i].startsWith('data:')) {
        const data = finalLines[i].slice(5).trim();
        if (!data) continue;
        if (currentEvent === 'chunk') onChunk(data);
        else if (currentEvent === 'done') { messageId = data; doneReceived = true; onStatus?.('完成'); }
        else if (currentEvent === 'conversation_id') { conversationId = data; if (doneReceived) onDone(messageId, conversationId); }
      }
    }
    onDone(messageId, conversationId);
  },
};
