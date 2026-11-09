/**
 * 视觉能力界面文案的单测。
 *
 * 重点：unknown 不能被说成 no —— 超时/限流/模型答非所问都会是 unknown，
 * 直接拦住用户比不拦更烦人。
 */
import { describe, it, expect } from 'vitest';
import { describeVision, shouldHint, shouldRefetch } from './visionSupport';

describe('describeVision', () => {
  it('yes → 不提示', () => {
    const h = describeVision({ supported: 'yes', model: 'qwen-vl' });
    expect(h.level).toBe('none');
    expect(h.text).toBe('');
  });

  it('no → block，文案说清「会被拒绝」并给出出路', () => {
    const h = describeVision({ supported: 'no', model: 'qwen2.5:7b' });
    expect(h.level).toBe('block');
    expect(h.text).toContain('qwen2.5:7b');
    expect(h.text).toContain('不支持图片');
    expect(h.text).toContain('设置');
  });

  it('**unknown → warn，且不说成「不支持」**', () => {
    const h = describeVision({ supported: 'unknown', model: 'm', reason: '探测超时' });
    expect(h.level).toBe('warn');
    expect(h.text).toContain('无法确认');
    expect(h.text).toContain('探测超时');
    expect(h.text).not.toContain('不支持图片输入');
  });

  it('unknown 没有 reason 时也能给出可读文案', () => {
    const h = describeVision({ supported: 'unknown' });
    expect(h.level).toBe('warn');
    expect(h.text.length).toBeGreaterThan(0);
  });

  it('没有模型名时用「当前模型」兜底', () => {
    expect(describeVision({ supported: 'no' }).text).toContain('当前模型');
  });

  it('空结果 → 不提示（没探测过不该打扰用户）', () => {
    expect(describeVision(null).level).toBe('none');
    expect(describeVision(undefined).level).toBe('none');
    expect(describeVision({}).level).toBe('warn'); // 有对象但无 supported：按 unknown 处理
  });

  it('未知的 supported 值按 unknown 处理（后端加新状态时不至于瞎提示）', () => {
    const h = describeVision({ supported: 'maybe', model: 'm' });
    expect(h.level).toBe('warn');
  });
});

describe('shouldHint', () => {
  it('没选图不提示', () => {
    expect(shouldHint(0)).toBe(false);
  });

  it('选了图才提示', () => {
    expect(shouldHint(1)).toBe(true);
    expect(shouldHint(6)).toBe(true);
  });

  it('非法输入当 0', () => {
    expect(shouldHint(Number.NaN)).toBe(false);
    expect(shouldHint(undefined as unknown as number)).toBe(false);
  });
});

describe('shouldRefetch', () => {
  it('没有上次结果 → 要探', () => {
    expect(shouldRefetch(null, 'm')).toBe(true);
  });

  it('模型没变 → 不重探（用缓存）', () => {
    expect(shouldRefetch({ supported: 'yes', model: 'm' }, 'm')).toBe(false);
  });

  it('换了模型 → 重探', () => {
    expect(shouldRefetch({ supported: 'yes', model: 'old' }, 'new')).toBe(true);
  });

  it('换了 baseUrl → 重探', () => {
    expect(shouldRefetch({ supported: 'yes', model: 'm', baseUrl: 'http://a/v1' } as any, 'm', 'http://b/v1')).toBe(true);
  });

  it('上次没记录模型 → 重探（避免把别的模型结论套过来）', () => {
    expect(shouldRefetch({ supported: 'no' }, 'm')).toBe(true);
  });
});
