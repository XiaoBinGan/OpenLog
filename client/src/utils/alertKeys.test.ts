/**
 * client/src/utils/alertKeys.test.ts
 *
 * 用户反馈：「已经报过错的容器，在没点清除的时候不该再弹新的弹窗」。
 * 这些 key 决定 toast 合并（同 group 只保留一条），所以必须稳定：
 * 同一个容器 -> 同一个键；不同容器 -> 不同键。
 */
import { describe, it, expect } from 'vitest';
import { containerToastGroup, analysisToastKey } from './alertKeys';

describe('containerToastGroup —— 每个容器一个告警键', () => {
  it('同一来源 + 同一容器 => 同键（退出 / 巡检 / 日志告警会合并成一条）', () => {
    const a = containerToastGroup('src1', 'abc123', 'api');
    const b = containerToastGroup('src1', 'abc123', 'api');
    expect(a).toBe(b);
  });

  it('不同容器不合并', () => {
    expect(containerToastGroup('src1', 'abc', 'api'))
      .not.toBe(containerToastGroup('src1', 'def', 'web'));
  });

  it('不同来源不合并（两台机器有同名容器）', () => {
    expect(containerToastGroup('src1', 'abc', 'api'))
      .not.toBe(containerToastGroup('src2', 'abc', 'api'));
  });

  it('没有 containerId 时退回容器名，仍然稳定', () => {
    expect(containerToastGroup('src1', undefined, 'api'))
      .toBe(containerToastGroup('src1', undefined, 'api'));
    expect(containerToastGroup('src1', undefined, 'api'))
      .not.toBe(containerToastGroup('src1', undefined, 'web'));
  });

  it('什么都没有也不崩（unknown）', () => {
    expect(containerToastGroup()).toBe('container--unknown');
  });
});

describe('analysisToastKey —— AI 分析 toast 去重键', () => {
  it('同一来源同一日志源 => 同键（pending 更新成 done，不新弹）', () => {
    const k1 = analysisToastKey({ sourceId: 's1', log: { source: 'a.log' } });
    const k2 = analysisToastKey({ sourceId: 's1', log: { source: 'a.log' } });
    expect(k1).toBe(k2);
  });

  it('容器名优先于日志文件', () => {
    const k1 = analysisToastKey({ sourceId: 's1', log: { containerName: 'api', source: 'a.log' } });
    const k2 = analysisToastKey({ sourceId: 's1', log: { containerName: 'api', source: 'b.log' } });
    expect(k1).toBe(k2);
    expect(k1).toContain('api');
  });

  it('不同来源不合并', () => {
    expect(analysisToastKey({ sourceId: 's1', log: { source: 'a.log' } }))
      .not.toBe(analysisToastKey({ sourceId: 's2', log: { source: 'a.log' } }));
  });

  it('空输入不崩', () => {
    expect(() => analysisToastKey(null)).not.toThrow();
    expect(() => analysisToastKey(undefined)).not.toThrow();
    expect(analysisToastKey(null)).toBe('::default');
  });
});
