/**
 * client/src/utils/conversationStorage.ts —— 会话持久化的体积控制
 *
 * 现状问题：
 *   1. 运维助手确实会把会话写进 localStorage（openlog_assistant_v2），但**没有体积上限** ——
 *      toolCalls.result 存的是完整工具返回（remote_exec 输出、文件内容、几条 Docker 日志），
 *      几十轮之后轻松超过 localStorage 的 5MB 配额。`setItem` 抛 QuotaExceededError 后被
 *      `catch {}` 吞掉 → **整个会话从此不再保存**，用户刷新全丢而且毫无提示。
 *   2. AI Shell 的任务记录（turns/steps/output）完全只在内存里，刷新即丢。
 *
 * 这里做两件事（纯函数，方便单测）：
 *   - compactMessagesForStorage：按预算裁剪消息（丢最老、截断工具结果、丢流式中间态）
 *   - compactTurnsForStorage：AI Shell 的 turns 裁剪（每步输出只留头尾）
 *   - saveJsonSafe：写入超限时逐级降级（先裁剪再写），返回是否成功
 */

export interface StorageMessageLike {
  role: string;
  content: string;
  ts?: number;
  streaming?: boolean;
  toolCalls?: Array<{ tool: string; args?: any; status?: string; result?: any; durationMs?: number; liveOutput?: string }>;
}

export interface StorageTurnLike {
  id: string;
  text: string;
  status: string;
  final?: string;
  error?: string;
  steps?: Array<{ step: number; command?: string; output: string; status: string; exitCode?: number; thought?: string; modelPreview?: string }>;
}

/** 一条工具结果在存储里最多保留多少字符 */
export const TOOL_RESULT_STORE_CHARS = 1500;
/** AI Shell 单步输出在存储里最多保留多少字符（保留头尾） */
export const STEP_OUTPUT_STORE_CHARS = 1200;

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length * 2;
  }
}

/** JSON 序列化后的字节数（用于判断配额） */
export function jsonBytes(value: unknown): number {
  try {
    return byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/** 把长文本截成「头 + …（省略 N 字）… + 尾」 */
export function clipText(text: string, limit = STEP_OUTPUT_STORE_CHARS): string {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.6);
  const tail = Math.floor(limit * 0.3);
  return `${s.slice(0, head)}\n…（已省略 ${s.length - head - tail} 字）…\n${s.slice(-tail)}`;
}

/** 工具结果瘦身：保留 error/关键字段，长内容截断；流式中间态直接丢掉 */
export function slimToolResult(result: any): any {
  if (result == null) return result;
  if (typeof result === 'string') return clipText(result, TOOL_RESULT_STORE_CHARS);
  if (typeof result !== 'object') return result;
  if (Array.isArray(result)) {
    const kept = result.slice(0, 20);
    return kept.map(item => (typeof item === 'string' ? clipText(item, 300) : item));
  }
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') {
      out[key] = clipText(value, TOOL_RESULT_STORE_CHARS);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.length > 20 ? value.slice(0, 20) : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 压缩运维助手消息用于存储。
 *
 * @param messages
 * @param opts
 * @param opts.maxMessages 最多保留多少条（默认 80）
 * @param opts.maxBytes 目标字节上限（默认 1.5MB；localStorage 总配额约 5MB）
 * @returns {{ messages:StorageMessageLike[], bytes:number, trimmed:number }}
 */
export function compactMessagesForStorage(
  messages: StorageMessageLike[],
  opts: { maxMessages?: number; maxBytes?: number } = {},
): { messages: StorageMessageLike[]; bytes: number; trimmed: number } {
  const maxMessages = Math.max(1, opts.maxMessages ?? 80);
  const maxBytes = Math.max(1024, opts.maxBytes ?? 1_500_000);
  const list = Array.isArray(messages) ? messages : [];

  // 1) 先瘦身每条消息（工具结果截断、丢弃流式中间态）
  let slim = list.map((m) => {
    const next: StorageMessageLike = {
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
      ts: m.ts,
      streaming: false,
    };
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      next.toolCalls = m.toolCalls.map(tc => ({
        tool: tc.tool,
        args: tc.args,
        status: tc.status,
        result: slimToolResult(tc.result),
        durationMs: tc.durationMs,
      }));
    }
    return next;
  });

  let trimmed = 0;
  // 2) 超出条数上限 → 丢最老
  if (slim.length > maxMessages) {
    trimmed += slim.length - maxMessages;
    slim = slim.slice(-maxMessages);
  }
  // 3) 仍超字节 → 继续丢最老（至少保留最后 4 条，否则会话就断了）
  let bytes = jsonBytes(slim);
  while (bytes > maxBytes && slim.length > 4) {
    slim = slim.slice(1);
    trimmed += 1;
    bytes = jsonBytes(slim);
  }
  return { messages: slim, bytes, trimmed };
}

/**
 * 压缩 AI Shell 的 turns 用于存储。
 * 每步输出只留头尾、去掉模型流式预览；轮数超上限丢最老。
 */
export function compactTurnsForStorage(
  turns: StorageTurnLike[],
  opts: { maxTurns?: number; maxBytes?: number } = {},
): { turns: StorageTurnLike[]; bytes: number; trimmed: number } {
  const maxTurns = Math.max(1, opts.maxTurns ?? 10);
  const maxBytes = Math.max(1024, opts.maxBytes ?? 400_000);
  const list = Array.isArray(turns) ? turns : [];

  let slim: StorageTurnLike[] = list.map(t => ({
    id: t.id,
    text: t.text,
    status: t.status === 'running' ? 'cancelled' : t.status,
    final: t.final,
    error: t.error,
    steps: (t.steps || []).map(s => ({
      step: s.step,
      command: s.command,
      output: clipText(s.output || '', STEP_OUTPUT_STORE_CHARS),
      status: s.status,
      exitCode: s.exitCode,
      thought: s.thought,
    })),
  }));

  let trimmed = 0;
  if (slim.length > maxTurns) {
    trimmed += slim.length - maxTurns;
    slim = slim.slice(-maxTurns);
  }
  let bytes = jsonBytes(slim);
  while (bytes > maxBytes && slim.length > 1) {
    slim = slim.slice(1);
    trimmed += 1;
    bytes = jsonBytes(slim);
  }
  return { turns: slim, bytes, trimmed };
}

/**
 * 安全写入 localStorage：写不下就逐级裁剪重试，而不是静默失败。
 *
 * @returns {{ ok:boolean, bytes:number, compacted:boolean }}
 */
export function saveJsonSafe(
  key: string,
  value: unknown,
  opts: { shrink?: () => unknown; maxBytes?: number } = {},
): { ok: boolean; bytes: number; compacted: boolean } {
  const tryWrite = (val: unknown): { ok: boolean; bytes: number } => {
    try {
      const text = JSON.stringify(val);
      localStorage.setItem(key, text);
      return { ok: true, bytes: byteLength(text) };
    } catch {
      return { ok: false, bytes: 0 };
    }
  };

  const first = tryWrite(value);
  if (first.ok) return { ok: true, bytes: first.bytes, compacted: false };

  // 写不下：用调用方给的收缩函数再试一次（通常是丢掉最老的消息）
  if (opts.shrink) {
    const relaxed = opts.shrink();
    const second = tryWrite(relaxed);
    if (second.ok) return { ok: true, bytes: second.bytes, compacted: true };
  }

  // 最后兜底：清掉这个 key，避免留下半截脏数据（而且下一次写入还有机会成功）
  try { localStorage.removeItem(key); } catch { /* ignore */ }
  return { ok: false, bytes: 0, compacted: true };
}

/** 安全读取（损坏的 JSON 返回 fallback，不抛） */
export function loadJsonSafe<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}
