/**
 * server/__tests__/small-model-e2e.test.js
 *
 * 「16k 小模型抽风」端到端回归：
 * 用假模型驱动两个功能，**记录每次真实请求的 prompt 估算 token**，
 * 断言无论跑多少轮/多少步，请求体都不会超过模型窗口 ——
 * 只要超窗，本地引擎会静默截断，模型表现就是「抽风」。
 */
import { describe, it, expect, vi } from 'vitest';
import { estimateTokens } from '../routes/chat-context.js';

const { createChatRunner } = await import('../routes/chat-runner.js');
const { runAgent } = await import('../ai-shell.js');

const WINDOW = 16_384;

function streamingOf(chunks) {
  return (async function* () {
    for (const c of chunks) yield { choices: [{ delta: c }] };
  })();
}

/** 估算一次 chat.completions.create 请求的 prompt token */
function promptTokens(params) {
  let total = estimateTokens(JSON.stringify(params.tools || []));
  for (const m of params.messages || []) {
    total += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

describe('运维助手：16k 窗口下跑 8 轮工具调用也不超窗', () => {
  it('每次请求的 prompt 都 ≤ 模型窗口', async () => {
    const requests = [];
    const openai = {
      chat: {
        completions: {
          create: vi.fn(async (params) => {
            requests.push(promptTokens(params));
            const isSummary = String(params.messages?.[0]?.content || '').includes('阶段性总结');
            if (isSummary) return streamingOf([{ content: '阶段性总结。' }]);
            const toolTurns = requests.length;
            if (toolTurns <= 8) {
              return streamingOf([{
                tool_calls: [{
                  index: 0,
                  id: `c${toolTurns}`,
                  function: { name: 'remote_stat', arguments: JSON.stringify({ serverId: 's1', path: `/tmp/f${toolTurns}` }) },
                }],
              }]);
            }
            return streamingOf([{ content: '查完了，一切正常。' }]);
          }),
        },
      },
    };

    const big = { path: '/tmp/big.log', content: 'x'.repeat(8_000), bytes: 8_000 };
    const runner = createChatRunner({
      ensureSettings: () => ({ thinkingEnabled: false }),
      executeAssistantTool: vi.fn(async () => big),
      pendingApprovals: new Map(),
      nextConfirmId: () => 1,
      ThinkingStreamFilter: class { feed(c) { return c; } flush() { return ''; } },
    });

    const writes = [];
    const res = { write(c) { writes.push(c); return true; }, end() {}, setHeader() {} };

    await runner.run({
      openai,
      baseUrl: 'http://127.0.0.1:8899/v1',
      model: 'small-16k-model',
      messages: [{ role: 'user', content: '帮我逐个检查这些服务器上的文件' }],
      tools: [{
        type: 'function',
        function: {
          name: 'remote_stat',
          description: '查看文件属性',
          parameters: { type: 'object', properties: { serverId: { type: 'string' }, path: { type: 'string' } }, required: ['serverId', 'path'] },
        },
      }],
      systemPrompt: '你是运维助手。'.repeat(60),
      isLocalModel: true,
      res,
      maxRounds: 10,
      contextConfig: {
        windowTokens: WINDOW,
        budgetTokens: WINDOW,
        maxOutputTokens: 4096,
        autoCompact: true,
        compactAt: 0.85,
        warnAt: 0.7,
        maxRounds: 10,
        maxWallMs: 60_000,
        toolResultChars: 6_000,
      },
    });

    expect(requests.length).toBeGreaterThanOrEqual(8);
    const worst = Math.max(...requests);
    expect(worst).toBeLessThan(WINDOW);
    // 日志里应能看到压缩/裁剪事件（否则说明靠的是运气）
    const events = writes.join('').split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
    const parsed = events.map(d => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
    expect(parsed.some(e => e.type === 'context_compacted' || e.type === 'context_usage')).toBe(true);
  });
});

describe('AI Shell：16k 窗口下多步执行每步 prompt 都 ≤ 窗口', () => {
  function makeOpts(windowTokens, { steps = 6, skillSize = 0 } = {}) {
    const seen = [];
    let n = 0;
    return {
      seen,
      opts: {
        serverId: 's1',
        text: '把磁盘占用大的文件找出来',
        history: [],
        skillContent: 'x'.repeat(skillSize),
        skillName: skillSize ? '大技能' : '',
        autoRun: true,
        maxSteps: steps,
        windowTokens,
        signal: undefined,
        send: vi.fn(),
        callModel: vi.fn(async (messages) => {
          seen.push({ tokens: messages.reduce((s, m) => s + estimateTokens(String(m.content || '')), 0), count: messages.length });
          n += 1;
          if (n < steps) return { content: `THOUGHT: 继续查\nRUN: df -h /tmp/f${n}` };
          return { content: 'ANSWER: 磁盘没问题。' };
        }),
        execStream: vi.fn(async () => ({
          stdout: 'y'.repeat(40_000), // 故意给超大输出
          stderr: '',
          exitCode: 0,
          success: true,
        })),
        confirm: async () => true,
      },
    };
  }

  it('16k 小窗口也能跑长任务：步数上限 16（不再只给 4 步），并带上进度台账', async () => {
    const { opts } = makeOpts(WINDOW, { steps: 12 });
    const result = await runAgent(opts);
    // 小窗口上限 16；用户/默认要 12 步就按 12 给（旧实现会砍到 4）
    expect(opts.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'context_budget', maxSteps: 12 }));
    expect(result.steps).toBeGreaterThan(4);
  });

  it('每步请求的 messages token 都 ≤ 预算（即使单条命令输出 4 万字）', async () => {
    const { seen, opts } = makeOpts(WINDOW, { steps: 6 });
    await runAgent(opts);
    expect(seen.length).toBeGreaterThan(0);
    const budget = Math.max(...seen.map(s => s.tokens));
    expect(budget).toBeLessThan(WINDOW);
    // 单条命令输出被压到 1800 字符左右 → 每步增长有限
    expect(budget).toBeLessThan(6_000);
  });

  it('system 本身很大（超大技能）时会触发 context_trimmed', async () => {
    // 技能是中文长文档：约 2 万 token，远超 16k 窗口能容纳的范围 → 必须截断技能说明
    const bigSkill = '技能步骤：先检查磁盘占用，再定位大文件，最后给出清理建议。'.repeat(600);
    const { opts } = makeOpts(WINDOW, { steps: 4, skillSize: bigSkill.length });
    opts.skillContent = bigSkill;
    await runAgent(opts);
    expect(opts.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'context_trimmed' }));
  });

  it('大窗口模型不受影响（步数不缩、输出上限保持 6000 字符）', async () => {
    const { opts } = makeOpts(65_536, { steps: 6 });
    const result = await runAgent(opts);
    expect(result.steps).toBe(6);
    expect(opts.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'context_budget', maxSteps: expect.any(Number), observationLimit: 6000 }));
  });

  it('步数用尽时保存 resumeState，可以用来「继续」', async () => {
    const { opts } = makeOpts(65_536, { steps: 100 });
    const result = await runAgent(opts);
    expect(result.status).toBe('max_steps');
    expect(result.resumeState).toBeTruthy();
    expect(Array.isArray(result.resumeState.digest)).toBe(true);
    expect(result.resumeState.digest.length).toBeGreaterThan(0);
    expect(opts.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_paused' }));
  });

  it('继续任务：复用 resumeState，不从头再来', async () => {
    const { opts } = makeOpts(65_536, { steps: 100 });
    const first = await runAgent(opts);
    expect(first.resumeState).toBeTruthy();
    const doneSteps = first.steps;

    const seenMessages = [];
    const opts2 = makeOpts(65_536, { steps: 100 }).opts;
    opts2.resume = first.resumeState;
    opts2.callModel = async (messages) => {
      seenMessages.push(messages);
      return { content: 'ANSWER: 接着上次的进度，已经完成。' };
    };
    const second = await runAgent(opts2);
    expect(second.status).toBe('done');
    // 续跑的第一条 system 里必须带台账（进度没丢）
    expect(String(seenMessages[0][0].content)).toContain('已执行步骤');
    // 续跑的步数从上次接着数，不是从 0 开始
    expect(second.steps).toBeGreaterThan(doneSteps > 0 ? 1 : 0);
  });

  it('重复命令会被拦下并提醒模型换思路（防止原地打转）', async () => {
    const { opts } = makeOpts(65_536, { steps: 6 });
    // 模型永远给同一条命令
    opts.callModel = async () => ({ content: 'THOUGHT: 再看一次\nRUN: df -h' });
    const result = await runAgent(opts);
    // 只会真正执行一次，其余被拦
    expect(opts.execStream).toHaveBeenCalledTimes(1);
    expect(opts.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'progress', message: expect.stringContaining('重复命令') }));
    expect(result.status).toBe('max_steps');
  });
});

describe('AI Shell：步数/时长上限可调（前端下拉）', () => {
  function optsFor(extra = {}) {
    let n = 0;
    const sent = [];
    return {
      sent,
      opts: {
        serverId: 's1', text: '一直查', history: [], autoRun: true,
        windowTokens: 65_536,
        send: (e) => sent.push(e),
        callModel: async () => {
          n += 1;
          return { content: `RUN: echo step-${n}` }; // 每条命令都不同，避免被重复拦截
        },
        execStream: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, success: true }),
        confirm: async () => true,
        ...extra,
      },
    };
  }

  it('默认 24 步', async () => {
    const { sent, opts } = optsFor();
    const r = await runAgent(opts);
    expect(r.steps).toBe(24);
    expect(sent.find(e => e.type === 'context_budget')?.maxSteps).toBe(24);
  });

  it('前端传 maxSteps=40 → 真跑 40 步', async () => {
    const { sent, opts } = optsFor({ maxSteps: 40 });
    const r = await runAgent(opts);
    expect(r.steps).toBe(40);
    expect(sent.find(e => e.type === 'context_budget')?.maxSteps).toBe(40);
  });

  it('超过硬上限 64 会被夹到 64（防止跑飞）', async () => {
    const { sent, opts } = optsFor({ maxSteps: 1000 });
    await runAgent(opts);
    expect(sent.find(e => e.type === 'context_budget')?.maxSteps).toBe(64);
  });

  it('传非法值（0 / 负数 / NaN）回落默认 24', async () => {
    for (const bad of [0, -5, NaN, null, undefined, 'abc']) {
      const { sent, opts } = optsFor({ maxSteps: bad });
      await runAgent(opts);
      expect(sent.find(e => e.type === 'context_budget')?.maxSteps).toBe(24);
    }
  });

  it('时长上限：默认 20 分钟，调大后按调大的值算', async () => {
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => (fake += 1000); // 每次调用只前进 1 秒
    try {
      const { sent, opts } = optsFor({ maxSteps: 3, maxWallMs: 60 * 60 * 1000 });
      const r = await runAgent(opts);
      expect(r.steps).toBe(3);
      // 走完 3 步是「步数用尽」暂停（reason=steps），不是被时长掐断
      expect(sent.some(e => e.type === 'agent_paused' && e.reason === 'time')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('时长上限：超过后暂停并保存进度（提示里是配置的分钟数）', async () => {
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => (fake += 61 * 60 * 1000); // 直接越过 60 分钟硬上限
    try {
      const { sent, opts } = optsFor({ maxSteps: 10, maxWallMs: 30 * 60 * 1000 });
      const r = await runAgent(opts);
      expect(sent.some(e => e.type === 'agent_paused')).toBe(true);
      expect(r.status).toBe('max_steps');
      expect(r.answer).toContain('继续');
      expect(r.resumeState).toBeTruthy();
    } finally {
      Date.now = realNow;
    }
  });
});
