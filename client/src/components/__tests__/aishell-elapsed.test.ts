// @vitest-environment jsdom
/**
 * 心跳文案：长命令「执行中（已运行 32s）」的唯一来源。
 *
 * 为什么单独测：它错了不会报错，只会显示成「已运行 0s」或「NaN」——
 * 而这段文案的作用正是让人相信命令还在跑（243 上 du 全盘实测 31.9s）。
 */
import { describe, expect, it } from 'vitest';
import { elapsedText } from '../../utils/elapsed';

describe('elapsedText —— 心跳文案', () => {
  it('没有心跳 / 不足 1 秒 → 空串（避免每步闪一下）', () => {
    expect(elapsedText(undefined)).toBe('');
    expect(elapsedText(0)).toBe('');
    expect(elapsedText(999)).toBe('');
    expect(elapsedText(Number.NaN)).toBe('');
    expect(elapsedText(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('秒级', () => {
    expect(elapsedText(1000)).toBe('（已运行 1s）');
    expect(elapsedText(32400)).toBe('（已运行 32s）');
  });

  it('分钟级', () => {
    expect(elapsedText(65000)).toBe('（已运行 1m5s）');
    expect(elapsedText(600000)).toBe('（已运行 10m0s）');
  });
});
