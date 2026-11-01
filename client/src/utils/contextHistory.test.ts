import { describe, it, expect } from 'vitest';
import { estimateTextTokens, trimHistoryToBudget } from './contextUsage';

describe('estimateTextTokens', () => {
  it('与后端一致的启发式：中文按字、英文按 3.5 字符', () => {
    expect(estimateTextTokens('你好世界')).toBe(4);
    expect(estimateTextTokens('abcdefg')).toBe(2);
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens(undefined as any)).toBe(0);
  });

  it('中英混合', () => {
    // 4 个中文 + 14 个英文 → 4 + 4 = 8
    // 4 个中文(4) + 1 个空格 + 14 个英文 → 15/3.5≈4.3 → ceil(4+4.3)=9
    expect(estimateTextTokens('你好世界 abcdefghijklmn')).toBe(9);
  });
});

describe('trimHistoryToBudget', () => {
  const msg = (role: string, content: string) => ({ role, content });
  const tokensOf = (m: { content: string }) => estimateTextTokens(m.content) + 4;

  it('预算充足时全部保留', () => {
    const items = [msg('user', 'hi'), msg('assistant', 'hello')];
    const { kept, droppedCount } = trimHistoryToBudget(items, tokensOf, 10_000);
    expect(kept).toHaveLength(2);
    expect(droppedCount).toBe(0);
  });

  it('超预算时从最早开始丢，保留最近的消息', () => {
    // 每条 500 个中文字 ≈ 500 token，预算 1200 → 只留最近 2 条
    const items = Array.from({ length: 10 }, (_, i) => msg('user', '字'.repeat(500)));
    const { kept, droppedCount } = trimHistoryToBudget(items, tokensOf, 1200);
    expect(kept.length).toBeLessThan(items.length);
    expect(droppedCount).toBe(items.length - kept.length);
    // 保留的必须是靠后的
    expect(kept[kept.length - 1]).toBe(items[items.length - 1]);
  });

  it('第一条是 tool 消息时继续丢（避免父 assistant 被丢导致 400）', () => {
    const items = [
      msg('assistant', 'a'),
      msg('tool', 't'),
      msg('user', 'b'),
      msg('assistant', 'c'),
    ];
    // 预算只够最后两条 → 边界正好落在 tool 上，必须再把 tool 丢掉
    const { kept } = trimHistoryToBudget(items, tokensOf, 10);
    expect(kept[0].role).not.toBe('tool');
    if (kept.length) expect(kept[0].role).toBe('user');
  });

  it('空列表不崩', () => {
    expect(trimHistoryToBudget([], tokensOf, 1000).kept).toHaveLength(0);
  });

  it('预算为 0 时仍保留最后一条（当前问题不能被丢掉）', () => {
    const r = trimHistoryToBudget([msg('user', 'hi')], tokensOf, 0);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].content).toBe('hi');
  });

  it('单条超预算时至少保留最后一条（不能把当前问题也丢了）', () => {
    const items = [msg('user', '字'.repeat(5000))];
    const { kept } = trimHistoryToBudget(items, tokensOf, 100);
    expect(kept).toHaveLength(1);
  });
});
