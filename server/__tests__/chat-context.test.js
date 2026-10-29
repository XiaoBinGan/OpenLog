import { describe, it, expect } from 'vitest';

const {
  estimateTokens, messageTokens, messagesTokens, summarizeToolResult,
  compactMessages, isContextOverflowError,
  stripToolCallBlocks, isOnlyToolCallText,
} = await import('../routes/chat-context.js');

describe('estimateTokens —— 粗估（只用于预算判断）', () => {
  it('中文按 1 token/字', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('英文/代码按 ~3.5 字符 1 token', () => {
    const t = estimateTokens('const x = 12345;');
    expect(t).toBeGreaterThan(2);
    expect(t).toBeLessThan(10);
  });

  it('空值返回 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('混合文本落在合理区间（不做精确 tokenizer）', () => {
    const t = estimateTokens('读取文件 /workspace/a.js 完成');
    expect(t).toBeGreaterThan(5);
    expect(t).toBeLessThan(40);
  });
});

describe('summarizeToolResult —— 旧工具结果压成一行', () => {
  it('保留工具名与关键字段', () => {
    const out = summarizeToolResult('remote_read_file', JSON.stringify({
      filePath: '/app/server/index.js', bytes: 75468, content: 'x'.repeat(5000),
    }));
    expect(out).toContain('remote_read_file');
    expect(out).toContain('/app/server/index.js');
    expect(out).toContain('75468');
    expect(out.length).toBeLessThan(600); // 大段内容被丢掉
  });

  it('错误信息保留（模型需要知道哪一步失败了）', () => {
    const out = summarizeToolResult('remote_grep', JSON.stringify({ error: '服务器未连接' }));
    expect(out).toContain('服务器未连接');
  });

  it('命中行数 / 替换次数 / 截断标志', () => {
    expect(summarizeToolResult('remote_grep', JSON.stringify({ matchCount: 12 }))).toContain('命中 12 行');
    expect(summarizeToolResult('remote_edit_file', JSON.stringify({ replacements: 2 }))).toContain('替换 2 处');
    expect(summarizeToolResult('remote_read_file', JSON.stringify({ truncated: true }))).toContain('已截断');
  });

  it('非 JSON 内容也能压缩（不丢工具名）', () => {
    const out = summarizeToolResult('docker_logs', 'plain text log output '.repeat(100));
    expect(out).toContain('docker_logs');
    expect(out).toContain('历史结果已压缩');
  });
});

/** 造一个长会话：N 轮 assistant(tool_calls) + tool 结果 */
function makeHistory(turns, { resultChars = 4000 } = {}) {
  const messages = [{ role: 'user', content: '帮我排查一下这些服务器的问题，需要逐个检查。' }];
  for (let i = 0; i < turns; i++) {
    const id = `call_${i}`;
    messages.push({
      role: 'assistant',
      content: `第 ${i + 1} 步：先看下文件。`,
      tool_calls: [{ id, type: 'function', function: { name: 'remote_read_file', arguments: JSON.stringify({ filePath: `/app/file${i}.js` }) } }],
    });
    messages.push({
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify({ filePath: `/app/file${i}.js`, bytes: resultChars, content: 'y'.repeat(resultChars) }),
    });
  }
  return messages;
}

describe('compactMessages —— 上下文预算（长任务退出的根因）', () => {
  it('预算内不压缩', () => {
    const msgs = makeHistory(2, { resultChars: 100 });
    const r = compactMessages(msgs, { maxTokens: 50_000 });
    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it('超预算时把早期工具结果压成摘要（大幅降 tokens）', () => {
    const msgs = makeHistory(12, { resultChars: 4000 });
    const before = messagesTokens(msgs);
    const r = compactMessages(msgs, { maxTokens: 8_000, keepRecentTurns: 6 });
    expect(r.compressed).toBe(true);
    expect(r.tokens).toBeLessThan(before);
    expect(r.tokens).toBeLessThanOrEqual(8_000);
  });

  it('压缩后仍保持 tool_calls 与 tool 消息配对（否则上游 400）', () => {
    const msgs = makeHistory(12, { resultChars: 4000 });
    const r = compactMessages(msgs, { maxTokens: 8_000, keepRecentTurns: 6 });
    // 每个 assistant.tool_calls 后面必须紧跟对应的 tool 消息
    for (let i = 0; i < r.messages.length; i++) {
      const m = r.messages[i];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const next = r.messages[i + 1];
          const found = r.messages.slice(i + 1, i + 1 + m.tool_calls.length)
            .some(x => x.role === 'tool' && x.tool_call_id === tc.id);
          expect(found, `tool_call ${tc.id} 丢失配对`).toBe(true);
          if (next) expect(next.role === 'tool' || next.role === 'assistant').toBe(true);
        }
      }
    }
  });

  it('最近几轮保持完整内容（模型要能看见刚查到的结果）', () => {
    const msgs = makeHistory(10, { resultChars: 3000 });
    const r = compactMessages(msgs, { maxTokens: 12_000, keepRecentTurns: 4 });
    const lastTool = [...r.messages].reverse().find(m => m.role === 'tool');
    expect(String(lastTool.content).length).toBeGreaterThan(2000);
  });

  it('极端预算下会丢弃最早的整段（并报告 dropped）', () => {
    const msgs = makeHistory(30, { resultChars: 2000 });
    const r = compactMessages(msgs, { maxTokens: 2_000, keepRecentTurns: 2, keepChars: 200 });
    expect(r.compressed).toBe(true);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.tokens).toBeLessThanOrEqual(3_000);
  });

  it('空数组 / 单条消息不炸', () => {
    expect(compactMessages([], { maxTokens: 100 }).messages).toEqual([]);
    const one = [{ role: 'user', content: 'hi' }];
    expect(compactMessages(one, { maxTokens: 1 }).messages.length).toBe(1);
  });

  it('不修改入参（纯函数）', () => {
    const msgs = makeHistory(6, { resultChars: 2000 });
    const snapshot = JSON.stringify(msgs);
    compactMessages(msgs, { maxTokens: 2_000 });
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });
});

describe('isContextOverflowError —— 识别模型上下文超限', () => {
  it('识别 Strata 的真实报错文案', () => {
    const err = new Error('400 request exceeds the context window: prompt (65609 tokens) leaves no room to answer in the context (65536); requests are never truncated');
    err.status = 400;
    expect(isContextOverflowError(err)).toBe(true);
  });

  it('识别常见变体', () => {
    expect(isContextOverflowError({ message: 'maximum context length is 8192 tokens', status: 400 })).toBe(true);
    expect(isContextOverflowError({ message: "This model's maximum context length is 4096 tokens", status: 400 })).toBe(true);
    expect(isContextOverflowError({ message: 'prompt is too long', status: 400 })).toBe(true);
  });

  it('不误判普通错误', () => {
    expect(isContextOverflowError({ message: 'rate limit', status: 429 })).toBe(false);
    expect(isContextOverflowError({ message: 'invalid api key', status: 401 })).toBe(false);
    expect(isContextOverflowError({ message: 'tools is not supported', status: 400 })).toBe(false);
  });
});


describe('stripToolCallBlocks —— 剥掉正文里的工具调用 XML（真实问题）', () => {
  const sample = '<tool_call>\n<function=remote_grep>\n<parameter=path>\n/app/x.js\n</parameter>\n<parameter=pattern>\nexport function\n</parameter>\n</function>\n</tool_call>';

  it('单块剥离后为空', () => {
    expect(stripToolCallBlocks(sample)).toBe('');
  });

  it('多个块一起剥离', () => {
    expect(stripToolCallBlocks(sample + sample)).toBe('');
  });

  it('保留块外的真正回答', () => {
    const out = stripToolCallBlocks('先看一下文件。\n' + sample + '\n结论：没有导出。');
    expect(out).toContain('先看一下文件');
    expect(out).toContain('结论：没有导出');
    expect(out).not.toContain('<tool_call>');
  });

  it('被截断的未闭合块删到结尾', () => {
    expect(stripToolCallBlocks('正常文字\n<tool_call><function=remote_ls>\n<parameter=x>')).toContain('正常文字');
  });

  it('普通正文原样返回', () => {
    expect(stripToolCallBlocks('磁盘用了 42%，内存正常。')).toBe('磁盘用了 42%，内存正常。');
  });
});

describe('isOnlyToolCallText —— 判断是不是只有工具调用', () => {
  it('只有 XML → true', () => {
    expect(isOnlyToolCallText('<tool_call><function=remote_ls></function></tool_call>')).toBe(true);
  });
  it('带正文 → false', () => {
    expect(isOnlyToolCallText('先看看<tool_call><function=remote_ls></function></tool_call>')).toBe(false);
  });
  it('普通文本 → false', () => {
    expect(isOnlyToolCallText('一切正常')).toBe(false);
    expect(isOnlyToolCallText('')).toBe(false);
  });
});