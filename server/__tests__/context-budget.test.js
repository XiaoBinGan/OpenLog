/**
 * server/__tests__/context-budget.test.js
 *
 * 「16k 小模型抽风」问题的回归测试。
 *
 * 真实原因：两个功能都按「配置预算」（48k 默认）裁剪，而换到 16k 窗口的模型后
 * 请求体远超窗口。多数本地引擎对超长 prompt **不报错、直接静默截断**，
 * 模型看到半截对话就忘任务/重复/编命令 —— 用户描述为「抽风」。
 *
 * 这里锁住：
 *   1. planBudget：小窗口自动压输出/预算，且总和不超窗口；
 *   2. fitMessagesToBudget：超预算时丢最老消息，但不拆散 tool_calls 配对；
 *   3. fitAgentMessages：AI Shell 的文本协议压缩（先压命令输出，再丢老对话）；
 *   4. 接线：两处都调用了这些函数。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  planBudget, fitMessagesToBudget, fitAgentMessages, SAFETY_RATIO,
} = await import('../context-budget.js');
const { estimateTokens, messagesTokens } = await import('../routes/chat-context.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('planBudget —— 按窗口算安全预算', () => {
  it('16k 窗口：输出被压到 ≤30% 且 ≤2048，prompt+输出+安全余量 不超窗口', () => {
    const p = planBudget({ windowTokens: 16_384, maxOutputTokens: 4096 });
    expect(p.windowTokens).toBe(16_384);
    expect(p.outputTokens).toBeLessThanOrEqual(2048);
    expect(p.outputTokens).toBeLessThanOrEqual(Math.floor(16_384 * 0.3));
    expect(p.promptBudget + p.outputTokens + p.safetyTokens).toBeLessThanOrEqual(16_384);
    expect(p.promptBudget).toBeGreaterThan(10_000); // 仍要留出足够对话空间
    expect(p.warnings.length).toBeGreaterThan(0);
  });

  it('65k 窗口：预算大于 16k 模型的，输出可以给满', () => {
    const small = planBudget({ windowTokens: 16_384, maxOutputTokens: 4096 });
    const big = planBudget({ windowTokens: 65_536, maxOutputTokens: 4096 });
    expect(big.promptBudget).toBeGreaterThan(small.promptBudget);
    expect(big.outputTokens).toBe(4096);
    expect(big.promptBudget + big.outputTokens + big.safetyTokens).toBeLessThanOrEqual(65_536);
  });

  it('安全余量按比例（默认 6%）', () => {
    const p = planBudget({ windowTokens: 16_384 });
    expect(p.safetyTokens).toBe(Math.ceil(16_384 * SAFETY_RATIO));
  });

  it('固定开销（system+工具）过大时压输出、并给警告', () => {
    const p = planBudget({ windowTokens: 8_192, maxOutputTokens: 2048, fixedTokens: 5000 });
    expect(p.outputTokens).toBeLessThan(2048);
    expect(p.warnings.some(w => w.includes('系统提示'))).toBe(true);
  });

  it('历史预算永远小于 prompt 预算，且留出固定开销', () => {
    const p = planBudget({ windowTokens: 32_768, maxOutputTokens: 2048, fixedTokens: 3000 });
    expect(p.historyBudget).toBeLessThanOrEqual(p.promptBudget);
    expect(p.historyBudget).toBeLessThanOrEqual(Math.max(256, p.promptBudget - 3000));
  });

  it('异常输入不崩', () => {
    expect(() => planBudget({ windowTokens: undefined })).not.toThrow();
    expect(planBudget({ windowTokens: 100 }).windowTokens).toBeGreaterThanOrEqual(2048);
  });
});

describe('fitMessagesToBudget —— 超预算时丢最老，不拆 tool 配对', () => {
  const bigToolResult = (i) => JSON.stringify({ path: `/tmp/f${i}`, content: 'x'.repeat(3000) });

  function buildTurns(n) {
    const msgs = [];
    for (let i = 0; i < n; i++) {
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'remote_exec', arguments: '{"command":"df -h"}' } }],
      });
      msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: bigToolResult(i) });
    }
    msgs.push({ role: 'user', content: '最后的问题' });
    return msgs;
  }

  it('不超预算时原样返回', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    const out = fitMessagesToBudget(msgs, 10_000);
    expect(out.messages).toBe(msgs);
    expect(out.dropped).toBe(0);
  });

  it('严重超预算时丢弃最老的消息，token 降下来', () => {
    const msgs = buildTurns(12);
    const before = messagesTokens(msgs);
    const out = fitMessagesToBudget(msgs, 1000);
    expect(out.tokens).toBeLessThan(before);
    expect(out.messages.length).toBeLessThan(msgs.length);
    expect(out.tokens).toBeLessThanOrEqual(1100); // 基本压到预算内
  });

  it('每个保留的 tool 消息都有对应 assistant.tool_calls（否则上游 400）', () => {
    const msgs = buildTurns(10);
    const out = fitMessagesToBudget(msgs, 2500);
    const ids = new Set();
    for (const m of out.messages) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) ids.add(tc.id);
      }
    }
    for (const m of out.messages) {
      if (m.role === 'tool') expect(ids.has(m.tool_call_id), `孤立 tool ${m.tool_call_id}`).toBe(true);
    }
  });

  it('最后一条 user 消息永远保留（不能把用户当前问题丢了）', () => {
    const msgs = buildTurns(15);
    const out = fitMessagesToBudget(msgs, 1500);
    expect(out.messages.at(-1).content).toBe('最后的问题');
  });
});

describe('fitAgentMessages —— AI Shell 文本协议压缩', () => {
  function buildShell(n, outputSize = 3000) {
    const msgs = [{ role: 'system', content: '你是 AI Shell。'.repeat(100) }];
    msgs.push({ role: 'user', content: '帮我看磁盘为什么满' });
    for (let i = 0; i < n; i++) {
      msgs.push({ role: 'assistant', content: `RUN: df -h ${i}` });
      msgs.push({ role: 'user', content: `[命令输出]\n${'y'.repeat(outputSize)}` });
    }
    return msgs;
  }

  it('不超预算时原样返回', () => {
    const msgs = buildShell(1, 100);
    const out = fitAgentMessages(msgs, { promptBudget: 100_000 });
    expect(out.messages).toBe(msgs);
    expect(out.compressed).toBe(0);
    expect(out.dropped).toBe(0);
  });

  it('16k 窗口跑多步：先压缩较早命令输出，token 降下来', () => {
    const msgs = buildShell(6, 4000);
    const before = messagesTokens(msgs);
    const out = fitAgentMessages(msgs, { promptBudget: 4000 });
    expect(out.compressed).toBeGreaterThan(0);
    expect(out.tokens).toBeLessThan(before);
    expect(out.messages[0].role).toBe('system');
  });

  it('压完还超就丢最老对话，但保留原始任务和最后几步', () => {
    const msgs = buildShell(10, 6000);
    const out = fitAgentMessages(msgs, { promptBudget: 4000, tailKeep: 4 });
    expect(out.dropped).toBeGreaterThan(0);
    expect(out.messages[0].role).toBe('system');
    // 原始任务还在
    expect(out.messages.some(m => m.content === '帮我看磁盘为什么满')).toBe(true);
    // 最后几步还在
    expect(out.messages.slice(-4).some(m => String(m.content).includes('[命令输出]'))).toBe(true);
  });

  it('system 本身超大时不会死循环，返回 overBudget', () => {
    const msgs = [{ role: 'system', content: 'z'.repeat(80_000) }, { role: 'user', content: 'hi' }];
    const out = fitAgentMessages(msgs, { promptBudget: 1000 });
    expect(out.overBudget).toBe(true);
  });

  it('空输入不崩', () => {
    expect(() => fitAgentMessages([], { promptBudget: 1000 })).not.toThrow();
    expect(() => fitAgentMessages(null, {})).not.toThrow();
  });
});

describe('接线 —— 两个功能都真的用了预算控制', () => {
  const chat = read('server/routes/chat.js');
  const runner = read('server/routes/chat-runner.js');
  const shell = read('server/ai-shell.js');
  const index = read('server/index.js');
  const terminal = read('client/src/components/AIShellTerminal.tsx');

  it('运维助手：请求前按窗口再夹一次预算', () => {
    expect(chat).toContain("import { planBudget } from '../context-budget.js'");
    expect(chat).toContain('planBudget({');
  });

  it('运维助手：每轮请求前把消息硬压进窗口安全线', () => {
    expect(runner).toContain('fitMessagesToBudget');
    expect(runner).toContain("trigger: 'window'");
  });

  it('AI Shell：按窗口算预算、压单条输出、缩步数', () => {
    expect(shell).toContain('planBudget');
    expect(shell).toContain('fitAgentMessages');
    expect(shell).toContain('observationLimit');
    expect(shell).toContain('effectiveMaxSteps');
    expect(shell).toContain("type: 'context_budget'");
    expect(shell).toContain("type: 'context_trimmed'");
  });

  it('AI Shell：服务端探测模型窗口后传给 runAgent', () => {
    expect(index).toContain('probeModelWindow');
    expect(index).toContain('windowTokens,');
  });

  it('AI Shell 前端：显示模型窗口、裁剪时给提示', () => {
    expect(terminal).toContain("case 'context_budget'");
    expect(terminal).toContain("case 'context_trimmed'");
    expect(terminal).toContain('窗口 {Math.round(modelWindow / 1024)}k');
  });
});
