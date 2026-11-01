import { describe, it, expect } from 'vitest';
import {
  formatTokens, usageLevel, usagePercent, buildUsageAdvice,
  usageSummary, usageBreakdownText, formatDuration, USAGE_LEVEL_STYLES,
} from './contextUsage';

describe('formatTokens', () => {
  it('小于 1000 直接显示整数', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('千级保留一位小数，十万级取整', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(48_000)).toBe('48k');
    expect(formatTokens(123_456)).toBe('123k');
  });

  it('百万级用 M', () => {
    expect(formatTokens(1_234_567)).toBe('1.2M');
  });

  it('非法值不产生 NaN', () => {
    expect(formatTokens(undefined as any)).toBe('0');
    expect(formatTokens(null as any)).toBe('0');
  });
});

describe('usagePercent', () => {
  it('正常比例', () => {
    expect(usagePercent(12_000, 48_000)).toBe(25);
  });

  it('budget 为 0 或负数返回 0（不产生 Infinity/NaN）', () => {
    expect(usagePercent(100, 0)).toBe(0);
    expect(usagePercent(100, -5)).toBe(0);
  });

  it('超过 100% 也照实显示（悬浮时可能略超）', () => {
    expect(usagePercent(60_000, 48_000)).toBe(125);
  });
});

describe('usageLevel —— 阈值跟随配置', () => {
  it('默认阈值 70 / 85', () => {
    expect(usageLevel(50)).toBe('normal');
    expect(usageLevel(70)).toBe('warn');
    expect(usageLevel(85)).toBe('critical');
    expect(usageLevel(100)).toBe('over');
  });

  it('用户把阈值调低后颜色档位同步变化', () => {
    expect(usageLevel(60, { warnAt: 0.5, compactAt: 0.8 })).toBe('warn');
    expect(usageLevel(85, { warnAt: 0.5, compactAt: 0.8 })).toBe('critical');
  });

  it('每档都有对应样式（不会 key 缺失）', () => {
    for (const lvl of ['normal', 'warn', 'critical', 'over'] as const) {
      expect(USAGE_LEVEL_STYLES[lvl].bar).toBeTruthy();
      expect(USAGE_LEVEL_STYLES[lvl].text).toBeTruthy();
    }
  });
});

describe('buildUsageAdvice', () => {
  const cfg = { windowTokens: 65536, budgetTokens: 48000, warnAt: 0.7, compactAt: 0.85 };

  it('用量低时不提示', () => {
    const advice = buildUsageAdvice({ used: 5000, budget: 48000, window: 65536, percent: 10 }, cfg);
    expect(advice.show).toBe(false);
  });

  it('达到预警阈值提示开新会话', () => {
    const advice = buildUsageAdvice({ used: 36000, budget: 48000, window: 65536, percent: 75 }, cfg);
    expect(advice.show).toBe(true);
    expect(advice.level).toBe('warn');
    expect(advice.action).toBe('new_session');
    expect(advice.text).toContain('75%');
  });

  it('即将压缩时是 critical', () => {
    const advice = buildUsageAdvice({ used: 42000, budget: 48000, window: 65536, percent: 88 }, cfg);
    expect(advice.level).toBe('critical');
    expect(advice.text).toContain('压缩');
  });

  it('窗口太小时优先建议换模型（换会话解决不了）', () => {
    const advice = buildUsageAdvice(
      { used: 8000, budget: 8000, window: 8192, percent: 10 },
      { windowTokens: 8192, budgetTokens: 8000 },
    );
    expect(advice.show).toBe(true);
    expect(advice.action).toBe('switch_model');
    expect(advice.text).toContain('8.2k');
  });

  it('用户关掉提示后不再打扰', () => {
    const advice = buildUsageAdvice(
      { used: 46000, budget: 48000, window: 65536, percent: 96 },
      cfg,
      { dismissed: true },
    );
    expect(advice.show).toBe(false);
  });

  it('无用量数据时不崩', () => {
    expect(buildUsageAdvice(null, cfg).show).toBe(false);
    expect(buildUsageAdvice(undefined, undefined).show).toBe(false);
  });
});

describe('usageSummary / usageBreakdownText', () => {
  const usage = {
    used: 12_345, budget: 48_000, window: 65_536, percent: 25.7,
    breakdown: { system: 2100, tools: 800, messages: 9445 },
    rounds: 3, compacted: 1, estimated: true,
  };

  it('主文案含用量/预算/百分比', () => {
    expect(usageSummary(usage)).toBe('12.3k / 48k · 26%');
  });

  it('估算值带 ~ 前缀（用户能分辨真假）', () => {
    expect(usageSummary(usage, { estimatedPrefix: true })).toContain('~');
    expect(usageSummary({ ...usage, estimated: false }, { estimatedPrefix: true })).not.toContain('~');
  });

  it('明细含三段拆分与实测/估算标注', () => {
    const text = usageBreakdownText(usage);
    expect(text).toContain('系统提示 2.1k');
    expect(text).toContain('工具定义 800');
    expect(text).toContain('消息 9.4k');
    expect(text).toContain('估算值');
  });

  it('无数据时安全返回', () => {
    expect(usageSummary(null)).toBe('—');
    expect(usageBreakdownText(null)).toBe('');
  });
});

describe('formatDuration', () => {
  it('秒与分钟', () => {
    expect(formatDuration(30_000)).toBe('30 秒');
    expect(formatDuration(600_000)).toBe('10 分钟');
    expect(formatDuration(90_000)).toBe('1.5 分钟');
  });
});
