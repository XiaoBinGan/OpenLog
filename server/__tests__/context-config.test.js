import { describe, it, expect } from 'vitest';

/**
 * 上下文配置解析的回归测试。
 *
 * 起因（用户反馈）：上下文长度只由环境变量决定、配置里看不到，
 * 界面上也没有用量显示 —— 用户不知道该换会话还是换模型。
 */

const {
  resolveContextConfig, clampContextConfig, pickPersistableConfig,
  adaptContextToWindow,
  CONTEXT_DEFAULTS, CONTEXT_BOUNDS,
} = await import('../routes/context-config.js');

const { estimateTokens, messagesTokens, compactMessages } = await import('../routes/chat-context.js');

describe('resolveContextConfig —— 三级优先级', () => {
  it('无任何配置时用默认值', () => {
    const { config, warnings } = resolveContextConfig({}, {});
    expect(config.windowTokens).toBe(CONTEXT_DEFAULTS.windowTokens);
    expect(config.budgetTokens).toBe(CONTEXT_DEFAULTS.budgetTokens);
    expect(config.autoCompact).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('设置页全局配置生效', () => {
    const { config } = resolveContextConfig({ assistantContext: { budgetTokens: 96000, windowTokens: 131072 } }, {});
    expect(config.budgetTokens).toBe(96000);
    expect(config.windowTokens).toBe(131072);
  });

  it('会话级覆盖优先于全局配置', () => {
    const { config } = resolveContextConfig(
      { assistantContext: { budgetTokens: 96000, windowTokens: 131072 } },
      { budgetTokens: 20000 },
    );
    expect(config.budgetTokens).toBe(20000);
    expect(config.windowTokens).toBe(131072); // 未覆盖的沿用全局
  });

  it('返回每项来自哪一层（前端标注用）', () => {
    const { sources } = resolveContextConfig(
      { assistantContext: { budgetTokens: 96000 } },
      { windowTokens: 32768 },
    );
    expect(sources.budgetTokens).toBe('settings');
    expect(sources.windowTokens).toBe('session');
    expect(sources.autoCompact).toBe('default');
  });
});

describe('clampContextConfig —— 防呆夹紧', () => {
  it('预算不能超过 窗口-输出，否则请求会被模型拒绝', () => {
    const { config, warnings } = clampContextConfig({ windowTokens: 32768, budgetTokens: 100000, maxOutputTokens: 4096 });
    expect(config.budgetTokens).toBe(32768 - 4096);
    expect(warnings.join()).toMatch(/超过/);
  });

  it('窗口夹到合法区间', () => {
    expect(clampContextConfig({ windowTokens: 100 }).config.windowTokens).toBe(CONTEXT_BOUNDS.windowTokens.min);
    expect(clampContextConfig({ windowTokens: 9_999_999 }).config.windowTokens).toBe(CONTEXT_BOUNDS.windowTokens.max);
  });

  it('预警阈值必须早于压缩阈值，否则自动修正', () => {
    const { config, warnings } = clampContextConfig({ compactAt: 0.5, warnAt: 0.9 });
    expect(config.warnAt).toBeLessThan(config.compactAt);
    expect(warnings.join()).toMatch(/预警阈值/);
  });

  it('派生绝对值供前端直接展示', () => {
    const { config } = clampContextConfig({ budgetTokens: 40000, compactAt: 0.8, warnAt: 0.6 });
    expect(config.compactAtTokens).toBe(32000);
    expect(config.warnAtTokens).toBe(24000);
  });

  it('非数字/空值不会变成 NaN', () => {
    const { config } = clampContextConfig({ budgetTokens: 'abc', windowTokens: null, compactAt: '' });
    for (const v of Object.values(config)) expect(Number.isNaN(v)).toBe(false);
    expect(config.budgetTokens).toBeGreaterThan(0);
  });

  it('maxRounds / maxWallMs 也在夹紧范围内', () => {
    const { config } = clampContextConfig({ maxRounds: 9999, maxWallMs: 1 });
    expect(config.maxRounds).toBe(CONTEXT_BOUNDS.maxRounds.max);
    expect(config.maxWallMs).toBe(CONTEXT_BOUNDS.maxWallMs.min);
  });
});

describe('pickPersistableConfig', () => {
  it('只保留可持久化字段，丢掉派生值', () => {
    const { config } = resolveContextConfig({}, {});
    const kept = pickPersistableConfig(config);
    expect(kept.compactAtTokens).toBeUndefined();
    expect(kept.budgetTokens).toBe(config.budgetTokens);
    expect(Object.keys(kept).sort()).toEqual(Object.keys(CONTEXT_DEFAULTS).sort());
  });
});

describe('token 估算与压缩（用量条的数据基础）', () => {
  it('中文按字计、英文按 3.5 字符计', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefg')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('messagesTokens 累加所有消息', () => {
    const msgs = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: 'hello world' },
    ];
    expect(messagesTokens(msgs)).toBeGreaterThan(2);
  });

  it('纯文本对话（无 tool_calls）也必须能压缩', () => {
    // 真实 bug：旧实现只会在 assistant(tool_calls) 段上做「整段丢弃」，
    // 找不到就 break —— 于是最常见的一问一答长会话永远压不下去，
    // 用量一路涨到模型报上下文超限。
    const msgs = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: `问题 ${i}：` + '排查磁盘问题。'.repeat(60) });
      msgs.push({ role: 'assistant', content: `回答 ${i}：` + '先看 df -h。'.repeat(60) });
    }
    const before = messagesTokens(msgs);
    const out = compactMessages(msgs, { maxTokens: 2000 });
    expect(out.compressed).toBe(true);
    expect(out.dropped).toBeGreaterThan(0);
    expect(messagesTokens(out.messages)).toBeLessThan(before);
    // 保留的部分必须从 user 开始、以 assistant 结束（不拆散问答）
    expect(out.messages[0].role).toBe('user');
    expect(out.messages[out.messages.length - 1].role).toBe('assistant');
  });

  it('预算小于固定开销时也能压到目标附近（不再被 4000 下限卡住）', () => {
    const msgs = [];
    for (let i = 0; i < 10; i++) msgs.push({ role: 'user', content: 'x'.repeat(400) });
    const out = compactMessages(msgs, { maxTokens: 500 });
    expect(out.compressed).toBe(true);
    expect(messagesTokens(out.messages)).toBeLessThanOrEqual(1500); // 允许保留 4 条的余量
  });

  it('压缩后 token 一定下降，且不破坏 tool_calls 配对', () => {
    const msgs = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'remote_exec', arguments: '{}' } }] });
      msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(4000) });
    }
    const before = messagesTokens(msgs);
    const out = compactMessages(msgs, { maxTokens: 6000 });
    expect(out.compressed).toBe(true);
    expect(messagesTokens(out.messages)).toBeLessThan(before);
    // 每个 tool 消息都必须能找到对应的 assistant.tool_calls
    for (const m of out.messages) {
      if (m.role !== 'tool') continue;
      const parent = out.messages.find(x => x.role === 'assistant' && Array.isArray(x.tool_calls)
        && x.tool_calls.some(tc => tc.id === m.tool_call_id));
      expect(parent, `tool ${m.tool_call_id} 的父消息被丢了`).toBeTruthy();
    }
  });
});

describe('adaptContextToWindow —— 按模型窗口自适应预算', () => {
  const base = () => clampContextConfig({ windowTokens: 65_536, budgetTokens: 48_000 }).config;

  it('模型窗口更小 → 窗口按模型修正，预算压到窗口 70%', () => {
    const out = adaptContextToWindow(base(), 32_768);
    expect(out.adjusted).toBe(true);
    expect(out.config.windowTokens).toBe(32_768);
    expect(out.config.budgetTokens).toBe(Math.floor(32_768 * 0.7));
    expect(out.reason).toContain('32768');
  });

  it('模型窗口更大 → 只放大窗口，预算不动（不擅自加）', () => {
    const out = adaptContextToWindow(base(), 131_072);
    expect(out.adjusted).toBe(true);
    expect(out.config.windowTokens).toBe(131_072);
    expect(out.config.budgetTokens).toBe(48_000);
  });

  it('窗口相同 → 不调整', () => {
    const out = adaptContextToWindow(base(), 65_536);
    expect(out.adjusted).toBe(false);
  });

  it('探测不到（null/太小/非法）→ 原样返回', () => {
    expect(adaptContextToWindow(base(), null).adjusted).toBe(false);
    expect(adaptContextToWindow(base(), 1000).adjusted).toBe(false);
    expect(adaptContextToWindow(base(), 'abc').adjusted).toBe(false);
    expect(adaptContextToWindow(null, 65_536).adjusted).toBe(false);
  });

  it('调整后重算 compactAt/warnAt 绝对值', () => {
    const out = adaptContextToWindow(base(), 16_384);
    expect(out.config.compactAtTokens).toBe(Math.floor(out.config.budgetTokens * out.config.compactAt));
    expect(out.config.warnAtTokens).toBe(Math.floor(out.config.budgetTokens * out.config.warnAt));
  });
});
