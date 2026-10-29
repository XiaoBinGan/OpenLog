import { describe, it, expect, vi } from 'vitest';

/**
 * 确认闸门回归测试：
 *   1. 只读命令（remote_exec + ls/cat/grep…）直接执行，不弹确认；
 *   2. 写命令仍需确认；
 *   3. 同一次任务里「完全相同」的写操作只确认一次。
 *
 * 用户反馈：「手动确认的次数有点多，凡是查询的不修改和删除的没必要反复确认」。
 */

const { createChatRunner } = await import('../routes/chat-runner.js');

class PassthroughFilter {
  feed(c) { return c; }
  flush() { return ''; }
}

function streamOf(chunks) {
  return (async function* () {
    for (const c of chunks) yield { choices: [{ delta: c }] };
  })();
}

/** 假 SSE 响应：把 tool_confirm 自动批准（模拟用户点「允许执行」） */
function createAutoApprovingRes(pendingApprovals, { approve = true } = {}) {
  const writes = [];
  const res = {
    ended: false,
    write(chunk) {
      writes.push(chunk);
      // 解析刚写出去的事件，遇到 tool_confirm 就立刻批准
      for (const line of String(chunk).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let m; try { m = JSON.parse(line.slice(6)); } catch { continue; }
        if (m.type === 'tool_confirm') {
          setImmediate(() => {
            const entry = pendingApprovals.get(m.confirmId);
            if (entry) {
              clearTimeout(entry.timer);
              pendingApprovals.delete(m.confirmId);
              entry.resolve(approve);
            }
          });
        }
      }
      return true;
    },
    end() { res.ended = true; },
    setHeader() {},
    get events() {
      return writes.join('').split('\n')
        .filter(l => l.startsWith('data: '))
        .map(l => l.slice(6))
        .filter(d => d !== '[DONE]')
        .map(d => { try { return JSON.parse(d); } catch { return null; } })
        .filter(Boolean);
    },
  };
  return res;
}

/** 让模型依次调用给定工具，最后输出结论 */
function scriptedOpenAI(toolCalls, finalText = '完成。') {
  let turn = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const isSummary = false; // 本测试不触发预算收尾
          if (isSummary) return streamOf([{ content: '总结' }]);
          const call = toolCalls[turn++];
          if (!call) return streamOf([{ content: finalText }]);
          return streamOf([{
            tool_calls: [{
              index: 0,
              id: `call_${turn}`,
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            }],
          }]);
        }),
      },
    },
  };
}

const toolDef = (name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});

function makeRunner(pendingApprovals, toolResult = { ok: true, output: 'x' }) {
  const executeAssistantTool = vi.fn(async () => toolResult);
  const runner = createChatRunner({
    ensureSettings: () => ({ thinkingEnabled: false }),
    executeAssistantTool,
    pendingApprovals,
    nextConfirmId: (() => { let i = 0; return () => ++i; })(),
    ThinkingStreamFilter: PassthroughFilter,
  });
  return { runner, executeAssistantTool };
}

const baseArgs = (openai, res, extra = {}) => ({
  openai,
  baseUrl: 'http://127.0.0.1:8899/v1',
  model: 'test-model',
  messages: [{ role: 'user', content: '查一下' }],
  tools: [toolDef('remote_exec'), toolDef('remote_edit_file')],
  systemPrompt: '你是运维助手。',
  isLocalModel: true,
  res,
  maxRounds: 10,
  ...extra,
});

describe('确认闸门：只读命令免确认', () => {
  it('只读命令直接执行，一次确认都不弹', async () => {
    const pending = new Map();
    const res = createAutoApprovingRes(pending);
    const { runner, executeAssistantTool } = makeRunner(pending);
    const openai = scriptedOpenAI([
      { name: 'remote_exec', args: { serverId: 's1', command: 'ls -la /app' } },
      { name: 'remote_exec', args: { serverId: 's1', command: 'grep -rn err /var/log 2>/dev/null | head -5' } },
      { name: 'remote_exec', args: { serverId: 's1', command: 'ps aux | head -20' } },
    ]);
    await runner.run(baseArgs(openai, res));

    expect(executeAssistantTool).toHaveBeenCalledTimes(3);
    const confirms = res.events.filter(e => e.type === 'tool_confirm');
    expect(confirms).toHaveLength(0);
  });

  it('写命令仍然要弹确认', async () => {
    const pending = new Map();
    const res = createAutoApprovingRes(pending);
    const { runner, executeAssistantTool } = makeRunner(pending);
    const openai = scriptedOpenAI([
      { name: 'remote_exec', args: { serverId: 's1', command: 'sed -i s/a/b/ /app/x.js' } },
    ]);
    await runner.run(baseArgs(openai, res));

    expect(res.events.filter(e => e.type === 'tool_confirm')).toHaveLength(1);
    expect(executeAssistantTool).toHaveBeenCalledTimes(1);
  });

  it('同一次任务里完全相同的写操作只确认一次', async () => {
    const pending = new Map();
    const res = createAutoApprovingRes(pending);
    const { runner, executeAssistantTool } = makeRunner(pending);
    const sameEdit = {
      name: 'remote_edit_file',
      args: { serverId: 's1', filePath: '/app/config.yml', oldString: 'a', newString: 'b' },
    };
    const openai = scriptedOpenAI([sameEdit, sameEdit]);
    await runner.run(baseArgs(openai, res));

    expect(executeAssistantTool).toHaveBeenCalledTimes(2);
    // 两次调用完全一致 → 只问一次
    expect(res.events.filter(e => e.type === 'tool_confirm')).toHaveLength(1);
  });

  it('不同的写操作还是要分别确认', async () => {
    const pending = new Map();
    const res = createAutoApprovingRes(pending);
    const { runner, executeAssistantTool } = makeRunner(pending);
    const openai = scriptedOpenAI([
      { name: 'remote_edit_file', args: { serverId: 's1', filePath: '/app/a.yml', oldString: 'a', newString: 'b' } },
      { name: 'remote_edit_file', args: { serverId: 's1', filePath: '/app/b.yml', oldString: 'a', newString: 'b' } },
    ]);
    await runner.run(baseArgs(openai, res));

    expect(executeAssistantTool).toHaveBeenCalledTimes(2);
    expect(res.events.filter(e => e.type === 'tool_confirm')).toHaveLength(2);
  });

  it('用户拒绝后不执行，且不记为已批准', async () => {
    const pending = new Map();
    const res = createAutoApprovingRes(pending, { approve: false });
    const { runner, executeAssistantTool } = makeRunner(pending);
    const sameEdit = { name: 'remote_edit_file', args: { serverId: 's1', filePath: '/app/a.yml', oldString: 'a', newString: 'b' } };
    const openai = scriptedOpenAI([sameEdit, sameEdit]);
    await runner.run(baseArgs(openai, res));

    // 两次都弹确认（第一次被拒 → 不应记住）
    expect(res.events.filter(e => e.type === 'tool_confirm')).toHaveLength(2);
    expect(executeAssistantTool).not.toHaveBeenCalled();
  });
});
