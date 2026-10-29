import { describe, it, expect, vi } from 'vitest';

/**
 * 长任务退出问题的回归测试。
 *
 * 真实事故：运维助手做长任务时「突然退出」——
 *  1. 硬编码 maxRounds=10，第 10 轮直接停；
 *  2. 每轮把最多 20KB 工具结果堆进上下文，十几轮后撞模型窗口报 400。
 *
 * 这里用假 OpenAI 客户端驱动 chat-runner，验证：
 *  - 轮数预算用尽时**先让模型做阶段性总结**再结束（不是一句「请简化问题重试」）；
 *  - 上下文超预算时自动压缩，而不是把 400 抛给用户；
 *  - 预算内正常多轮工具调用可以跑完（>10 轮）。
 */

const { createChatRunner } = await import('../routes/chat-runner.js');

/** 假 ThinkingStreamFilter：原样透传 */
class PassthroughFilter {
  constructor() { this.buf = ''; }
  feed(c) { return c; }
  flush() { return ''; }
}

/** 造一个只回固定内容的流式响应 */
function streamOf(chunks) {
  return (async function* () {
    for (const c of chunks) {
      yield { choices: [{ delta: c }] };
    }
  })();
}

/**
 * 假 OpenAI：前 N 次返回 tool_call，之后返回正文。
 * 记录每次请求的 messages，方便断言。
 */
function createFakeOpenAI({ toolRounds, finalText = '这是最终回答。', summaryText = '这是阶段性总结。' }) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: vi.fn(async (params) => {
          calls.push(params);
          // 判断是不是收尾总结请求（system 里带「阶段性总结」）
          const isSummary = String(params.messages?.[0]?.content || '').includes('阶段性总结');
          if (isSummary) return streamOf([{ content: summaryText }]);
          const turn = calls.filter(c => !String(c.messages?.[0]?.content || '').includes('阶段性总结')).length;
          if (turn <= toolRounds) {
            return streamOf([{
              tool_calls: [{
                index: 0,
                id: `call_${turn}`,
                function: { name: 'remote_stat', arguments: JSON.stringify({ serverId: 's1', path: `/tmp/f${turn}.txt` }) },
              }],
            }]);
          }
          return streamOf([{ content: finalText }]);
        }),
      },
    },
  };
}

/** 假 SSE 响应对象 */
function createRes() {
  const writes = [];
  return {
    writes,
    write(chunk) { writes.push(chunk); return true; },
    end() { this.ended = true; },
    setHeader() {},
    get events() {
      return writes
        .join('')
        .split('\n')
        .filter(l => l.startsWith('data: '))
        .map(l => l.slice(6))
        .filter(d => d !== '[DONE]')
        .map(d => { try { return JSON.parse(d); } catch { return null; } })
        .filter(Boolean);
    },
    get text() {
      return this.events.filter(e => e.content).map(e => e.content).join('');
    },
  };
}

function makeRunner(overrides = {}) {
  const toolResult = overrides.toolResult ?? { path: '/tmp/x', exists: true, raw: 'FILE size=1' };
  const executeAssistantTool = vi.fn(async () => toolResult);
  const runner = createChatRunner({
    ensureSettings: () => ({ thinkingEnabled: false }),
    executeAssistantTool,
    pendingApprovals: new Map(),
    nextConfirmId: () => Math.floor(Math.random() * 1000),
    ThinkingStreamFilter: PassthroughFilter,
  });
  return { runner, executeAssistantTool };
}

const baseArgs = (openai, res, extra = {}) => ({
  openai,
  baseUrl: 'http://127.0.0.1:8899/v1',
  model: 'test-model',
  messages: [{ role: 'user', content: '帮我逐个检查这些服务器上的文件' }],
  tools: [{
    type: 'function',
    function: {
      name: 'remote_stat',
      description: '查看文件属性',
      parameters: { type: 'object', properties: { serverId: { type: 'string' }, path: { type: 'string' } }, required: ['serverId', 'path'] },
    },
  }],
  systemPrompt: '你是运维助手。',
  isLocalModel: true,
  res,
  ...extra,
});

describe('长任务不再突然退出', () => {
  it('预算内可以跑超过 10 轮工具调用（旧实现第 10 轮就停）', async () => {
    const openai = createFakeOpenAI({ toolRounds: 14 });
    const res = createRes();
    const { runner, executeAssistantTool } = makeRunner();
    const result = await runner.run(baseArgs(openai, res, { maxRounds: 30 }));
    expect(executeAssistantTool).toHaveBeenCalledTimes(14);
    expect(res.text).toContain('这是最终回答');
    expect(result.exhausted).toBeUndefined();
  });

  it('轮数用尽时先做阶段性总结，而不是只回一句「请简化问题重试」', async () => {
    const openai = createFakeOpenAI({ toolRounds: 99 }); // 永远在调工具
    const res = createRes();
    const { runner } = makeRunner();
    const result = await runner.run(baseArgs(openai, res, { maxRounds: 3 }));

    expect(result.exhausted).toBe(true);
    expect(result.reason).toBe('rounds');
    // 收尾总结的正文出现了
    expect(res.text).toContain('这是阶段性总结');
    // 有 budget_exhausted 事件（前端据此提示可继续）
    expect(res.events.some(e => e.type === 'budget_exhausted')).toBe(true);
    // 不再出现旧的硬停文案
    expect(res.text).not.toContain('请简化问题重试');
  });

  it('上下文超预算时自动压缩并继续（不把 400 抛给用户）', async () => {
    const openai = createFakeOpenAI({ toolRounds: 6, finalText: '压缩后继续完成任务。' });
    const res = createRes();
    // 每轮返回超大工具结果，逼上下文超预算
    const big = { path: '/tmp/big.log', content: 'x'.repeat(30_000), bytes: 30_000 };
    const { runner } = makeRunner({ toolResult: big });
    const result = await runner.run(baseArgs(openai, res, {
      maxRounds: 20,
      contextBudget: 12_000,
      toolResultChars: 30_000,
    }));
    expect(result.exhausted).toBeUndefined();
    // 至少触发过一次压缩事件
    expect(res.events.some(e => e.type === 'context_compacted')).toBe(true);
    // 请求体最后一条的 messages 总量应受控（不是无限增长）
    const lastReq = openai.calls[openai.calls.length - 1];
    const totalChars = lastReq.messages.reduce((n, m) => n + String(m.content || '').length, 0);
    expect(totalChars).toBeLessThan(60_000);
  });

  it('模型上下文超限错误 → 深度压缩重试，而不是直接失败', async () => {
    let firstCall = true;
    const calls = [];
    const openai = {
      chat: {
        completions: {
          create: vi.fn(async (params) => {
            calls.push(params);
            const isSummary = String(params.messages?.[0]?.content || '').includes('阶段性总结');
            if (isSummary) return streamOf([{ content: '总结' }]);
            if (firstCall) {
              firstCall = false;
              const err = new Error('request exceeds the context window: prompt (65609 tokens) leaves no room to answer');
              err.status = 400;
              throw err;
            }
            return streamOf([{ content: '深度压缩后继续。' }]);
          }),
        },
      },
    };
    const res = createRes();
    const { runner } = makeRunner();
    const result = await runner.run(baseArgs(openai, res, { maxToolRounds: 5, maxRounds: 5 }));
    expect(result.exhausted).toBeUndefined();
    expect(res.events.some(e => e.type === 'context_compacted')).toBe(true);
    expect(res.text).toContain('深度压缩后继续');
  });

  it('预算用尽时收尾总结失败也不会静默退出（给明确提示）', async () => {
    const calls = [];
    const openai = {
      chat: {
        completions: {
          create: vi.fn(async (params) => {
            calls.push(params);
            const isSummary = String(params.messages?.[0]?.content || '').includes('阶段性总结');
            if (isSummary) throw new Error('模型也挂了');
            return streamOf([{
              tool_calls: [{ index: 0, id: `c${calls.length}`, function: { name: 'remote_stat', arguments: JSON.stringify({ serverId: 's1', path: '/tmp/x' }) } }],
            }]);
          }),
        },
      },
    };
    const res = createRes();
    const { runner } = makeRunner();
    await runner.run(baseArgs(openai, res, { maxRounds: 2 }));
    expect(res.events.some(e => e.type === 'budget_exhausted')).toBe(true);
    expect(res.text).toMatch(/阶段总结生成失败|继续/);
  });
});
