/**
 * 会话持久化的体积控制测试。
 *
 * 背景：运维助手会话存 localStorage 但没有体积上限，工具结果（remote_exec 输出、
 * 文件内容、Docker 日志）几十轮就把 5MB 配额撑爆；setItem 抛异常被静默 catch，
 * 等于会话从此不再保存 —— 用户刷新全丢。AI Shell 则完全没持久化。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  compactMessagesForStorage, compactTurnsForStorage, clipText, slimToolResult,
  saveJsonSafe, loadJsonSafe, jsonBytes,
  TOOL_RESULT_STORE_CHARS, STEP_OUTPUT_STORE_CHARS,
} from './conversationStorage';

/** vitest 跑在 node 环境，没有 localStorage —— 用可模拟配额的 shim 代替 */
class FakeStorage {
  private map = new Map<string, string>();
  /** >0 时 setItem 抛配额错误（模拟 5MB 写满） */
  failNext = 0;
  setItem(k: string, v: string) {
    if (this.failNext > 0) { this.failNext -= 1; throw new Error('QuotaExceededError'); }
    this.map.set(k, v);
  }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

let store: FakeStorage;

const bigText = (n: number) => 'x'.repeat(n);

beforeEach(() => {
  store = new FakeStorage();
  (globalThis as any).localStorage = store;
});

describe('clipText —— 长文本保留头尾', () => {
  it('短文本原样返回', () => {
    expect(clipText('abc', 100)).toBe('abc');
  });
  it('长文本截断并标注省略字数', () => {
    const out = clipText(bigText(10_000), 1000);
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain('已省略');
  });
});

describe('slimToolResult —— 工具结果瘦身', () => {
  it('长字符串被截断', () => {
    const out = slimToolResult({ stdout: bigText(50_000), exitCode: 0 });
    expect(String(out.stdout).length).toBeLessThanOrEqual(TOOL_RESULT_STORE_CHARS + 100);
    expect(out.exitCode).toBe(0); // 关键字段保留
  });

  it('error 字段保留可读（排查要看）', () => {
    const out = slimToolResult({ error: 'permission denied' });
    expect(out.error).toBe('permission denied');
  });

  it('数组过多元素被裁剪', () => {
    const out = slimToolResult(Array.from({ length: 100 }, (_, i) => i));
    expect(out.length).toBe(20);
  });

  it('嵌套对象/基本类型不崩', () => {
    expect(slimToolResult(null)).toBeNull();
    expect(slimToolResult(42)).toBe(42);
    expect(slimToolResult({ nested: { a: 1 } }).nested).toEqual({ a: 1 });
  });
});

describe('compactMessagesForStorage —— 运维助手会话', () => {
  const msgs = (n: number, size = 100) => Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `${i}:` + bigText(size),
    ts: i,
  }));

  it('超出条数上限时丢最老、保留最近', () => {
    const out = compactMessagesForStorage(msgs(120), { maxMessages: 40 });
    expect(out.messages.length).toBe(40);
    expect(out.trimmed).toBe(80);
    // 保留的是最后的（最新的）
    expect(String(out.messages[out.messages.length - 1].content)).toContain('119:');
  });

  it('工具结果被截断，不是整条消息被删', () => {
    const messages = [{
      role: 'assistant',
      content: '查一下',
      ts: 1,
      toolCalls: [{ tool: 'remote_exec', args: { command: 'df -h' }, status: 'done', result: { stdout: bigText(80_000) } }],
    }];
    const out = compactMessagesForStorage(messages);
    const result = out.messages[0].toolCalls![0].result;
    expect(String(result.stdout).length).toBeLessThan(2000);
    expect(out.messages[0].content).toBe('查一下');
  });

  it('流式中间态被清掉（避免刷新后永远转圈）', () => {
    const messages = [{ role: 'assistant', content: 'a', ts: 1, streaming: true }];
    const out = compactMessagesForStorage(messages);
    expect(out.messages[0].streaming).toBe(false);
  });

  it('liveOutput 不落盘（体积杀手）', () => {
    const messages = [{
      role: 'assistant', content: '', ts: 1,
      toolCalls: [{ tool: 'remote_exec', args: {}, status: 'done', result: {}, liveOutput: bigText(500_000) }],
    }];
    const out = compactMessagesForStorage(messages);
    expect(out.messages[0].toolCalls![0]).not.toHaveProperty('liveOutput');
  });

  it('按字节上限裁剪，但至少保留最后 4 条', () => {
    const out = compactMessagesForStorage(msgs(30, 100_000), { maxBytes: 10_000 });
    expect(out.messages.length).toBeGreaterThanOrEqual(4);
    expect(out.bytes).toBeLessThanOrEqual(jsonBytes(out.messages));
  });

  it('空数组不崩', () => {
    expect(compactMessagesForStorage([]).messages).toEqual([]);
    expect(compactMessagesForStorage(null as any).messages).toEqual([]);
  });
});

describe('compactTurnsForStorage —— AI Shell 会话', () => {
  const turns = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    text: `任务 ${i}`,
    status: 'done',
    steps: [{ step: 1, command: 'df -h', output: bigText(50_000), status: 'done', exitCode: 0 }],
  }));

  it('轮数超上限丢最老', () => {
    const out = compactTurnsForStorage(turns(30), { maxTurns: 5 });
    expect(out.turns.length).toBe(5);
    expect(out.turns[4].id).toBe('t29');
  });

  it('每步输出被截断', () => {
    const out = compactTurnsForStorage(turns(1), { maxTurns: 5 });
    const output = out.turns[0].steps![0].output;
    expect(output.length).toBeLessThanOrEqual(STEP_OUTPUT_STORE_CHARS + 100);
  });

  it('运行中的轮次落盘时标记为 cancelled（刷新不会一直转圈）', () => {
    const out = compactTurnsForStorage([{ id: 'a', text: 'x', status: 'running' }]);
    expect(out.turns[0].status).toBe('cancelled');
  });
});

describe('saveJsonSafe —— 写不下时降级而不是静默丢失', () => {
  it('正常写入返回 ok', () => {
    const r = saveJsonSafe('k1', { a: 1 });
    expect(r.ok).toBe(true);
    expect(loadJsonSafe('k1', null)).toEqual({ a: 1 });
  });

  it('第一次写失败会调用 shrink 再试', () => {
    store.failNext = 1; // 第一次 setItem 抛配额错误
    const r = saveJsonSafe('k2', { big: bigText(100) }, { shrink: () => ({ big: 'small' }) });
    expect(r.ok).toBe(true);
    expect(r.compacted).toBe(true);
    expect(loadJsonSafe('k2', null)).toEqual({ big: 'small' });
  });

  it('两次都失败时清掉脏 key 并返回失败（不会留半截数据）', () => {
    store.failNext = 99;
    const r = saveJsonSafe('k3', { a: 1 });
    expect(r.ok).toBe(false);
    expect(localStorage.getItem('k3')).toBeNull();
  });

  it('loadJsonSafe 对坏数据返回 fallback', () => {
    localStorage.setItem('bad', '{not json');
    expect(loadJsonSafe('bad', { fallback: true })).toEqual({ fallback: true });
  });
});
