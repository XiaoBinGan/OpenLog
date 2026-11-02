/**
 * server/__tests__/assistant-streaming.test.js
 *
 * 运维助手「正文流式输出」的回归测试。
 *
 * 背景：之前正文是「憋到整轮结束才一次性推给前端」，长回答时用户盯着
 * 「思考中…」几十秒才看到字 —— 和 AI Shell 的实时输出差距明显。
 * 现在原生 tool calling 模式下边收边推（文本协议模式仍必须攒完再解析）。
 *
 * 另外锁住一个安全边界：首轮的「假执行」话术（如「收到，工具连接正常」）
 * 不能被提前流出去，否则用户会先看到假话、再看到纠正提示。
 */
import { describe, it, expect, vi } from 'vitest';

const { createChatRunner } = await import('../routes/chat-runner.js');

/** 原样透传的思维过滤器 */
class PassthroughFilter {
  constructor() { this.buf = ''; }
  feed(c) { return c; }
  flush() { return ''; }
}

function streamOf(chunks) {
  return (async function* () {
    for (const c of chunks) yield { choices: [{ delta: c }] };
  })();
}

function createRes() {
  const writes = [];
  return {
    write(chunk) { writes.push(chunk); return true; },
    end() { this.ended = true; },
    setHeader() {},
    get events() {
      return writes.join('')
        .split('\n')
        .filter(l => l.startsWith('data: '))
        .map(l => l.slice(6))
        .filter(d => d !== '[DONE]')
        .map(d => { try { return JSON.parse(d); } catch { return null; } })
        .filter(Boolean);
    },
    get text() { return this.events.filter(e => e.content).map(e => e.content).join(''); },
    get contentEvents() { return this.events.filter(e => e.content); },
  };
}

function makeRunner(executeAssistantTool = vi.fn(async () => ({ ok: true }))) {
  const runner = createChatRunner({
    ensureSettings: () => ({ thinkingEnabled: false }),
    executeAssistantTool,
    pendingApprovals: new Map(),
    nextConfirmId: () => 1,
    ThinkingStreamFilter: PassthroughFilter,
  });
  return { runner, executeAssistantTool };
}

const tools = [{
  type: 'function',
  function: {
    name: 'remote_stat',
    description: '查看文件属性',
    parameters: { type: 'object', properties: { serverId: { type: 'string' }, path: { type: 'string' } }, required: ['serverId', 'path'] },
  },
}];

const baseArgs = (openai, res, extra = {}) => ({
  openai,
  baseUrl: 'http://127.0.0.1:8899/v1',
  model: 'test-model',
  messages: [{ role: 'user', content: '本机磁盘怎么样' }],
  tools,
  systemPrompt: '你是运维助手。',
  isLocalModel: true,
  res,
  ...extra,
});

/** 假 OpenAI：按次数回固定内容 */
function fakeOpenAI(handler) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: vi.fn(async (params) => { calls.push(params); return handler(params, calls.length); }),
      },
    },
  };
}

describe('正文流式输出', () => {
  it('原生模式长回答：拆成多个 content 事件，拼接后与原文一致', async () => {
    const answer = '磁盘使用率 42%，内存充足。建议关注 /var/log 的增长速度，必要时清理旧日志。';
    const pieces = answer.match(/.{1,5}/gs) || [answer];
    const openai = fakeOpenAI(() => streamOf([...pieces.map(content => ({ content }))]));
    const res = createRes();
    const { runner } = makeRunner();
    await runner.run(baseArgs(openai, res));

    expect(res.contentEvents.length).toBeGreaterThan(3);
    expect(res.text.trim()).toBe(answer.trim());
  });

  it('工具轮之后的长回答也流式输出，且工具事件顺序正确', async () => {
    let n = 0;
    const openai = fakeOpenAI((_params, count) => {
      n = count;
      if (count === 1) {
        return streamOf([{
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'remote_stat', arguments: JSON.stringify({ serverId: 's1', path: '/tmp/a' }) } }],
        }]);
      }
      return streamOf([
        { content: '文件存在，' },
        { content: '大小 12KB，' },
        { content: '最近没有修改。' },
      ]);
    });
    const res = createRes();
    const { runner, executeAssistantTool } = makeRunner();
    await runner.run(baseArgs(openai, res));

    expect(n).toBe(2);
    expect(executeAssistantTool).toHaveBeenCalledTimes(1);
    const types = res.events.map(e => e.type || 'content');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_result');
    expect(res.contentEvents.length).toBe(3);
    expect(res.text).toBe('文件存在，大小 12KB，最近没有修改。');
  });

  it('首轮「假执行」话术不会被提前流出去（先纠正、后正文）', async () => {
    let count = 0;
    const openai = fakeOpenAI((_params, c) => {
      count = c;
      // 第 1 轮：不调工具却说已执行；第 2 轮：真调工具；第 3 轮：正常回答
      if (c === 1) return streamOf([{ content: '收到，工具连接正常。' }, { content: '要查哪台机器？' }]);
      if (c === 2) {
        return streamOf([{
          tool_calls: [{ index: 0, id: 'c2', function: { name: 'remote_stat', arguments: JSON.stringify({ serverId: 's1', path: '/tmp/a' }) } }],
        }]);
      }
      return streamOf([{ content: '查完了，' }, { content: '一切正常。' }]);
    });
    const res = createRes();
    const { runner } = makeRunner();
    await runner.run(baseArgs(openai, res, { maxRounds: 5 }));

    const noticeIdx = res.events.findIndex(e => e.type === 'provider_notice' && /声称已执行/.test(e.message || ''));
    const firstContentIdx = res.events.findIndex(e => e.content);
    expect(count).toBeGreaterThanOrEqual(3);
    expect(noticeIdx).toBeGreaterThanOrEqual(0);
    expect(firstContentIdx).toBeGreaterThan(noticeIdx);
  });

  it('原生模式空正文时不产生 content 事件（纯工具轮）', async () => {
    const openai = fakeOpenAI((_params, c) => {
      if (c === 1) {
        return streamOf([{
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'remote_stat', arguments: JSON.stringify({ serverId: 's1', path: '/tmp/a' }) } }],
        }]);
      }
      return streamOf([{ content: '完成。' }]);
    });
    const res = createRes();
    const { runner } = makeRunner();
    await runner.run(baseArgs(openai, res));
    expect(res.text).toBe('完成。');
  });
});
