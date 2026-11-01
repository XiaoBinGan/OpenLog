import { describe, it, expect } from 'vitest';
import { dedupeDisks, summarizeDisks } from '../disk-utils.js';

const GB = 1024 ** 3;

// T4 上的真实形状：容器里 df 把 /dev/sda3 列了 6 次（bind mount 的单文件挂载），
// 外加一条 overlay 指向同一块盘。
const T4_SHAPE = [
  { name: 'overlay', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
];

describe('dedupeDisks', () => {
  it('把同一块盘的重复条目收敛成一条（不再算出 476.9%）', () => {
    const out = dedupeDisks(T4_SHAPE);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('/dev/sda3'); // 真实设备优先于 overlay
    expect(out[0].total).toBe(436 * GB);
    expect(out[0].used).toBe(346 * GB);
    expect(out[0].usePercent).toBeCloseTo(79.4, 1);
  });

  it('汇总后的百分比不会超过 100%，且与 df 的 Use% 一致', () => {
    const { percent } = summarizeDisks(T4_SHAPE);
    expect(percent).toBeGreaterThan(70);
    expect(percent).toBeLessThanOrEqual(100);
    // df 的 Use% = used/(used+avail)（扣掉 root 保留块），比 used/total 略高
    expect(percent).toBeCloseTo(79.4, 1);
  });

  it('拿不到 usePercent 时退回 used/total', () => {
    const { percent } = summarizeDisks([{ name: '/dev/sda1', used: 30 * GB, total: 100 * GB }]);
    expect(percent).toBeCloseTo(30, 5);
  });

  it('多块盘按容量加权平均 usePercent', () => {
    const { percent } = summarizeDisks([
      { name: '/dev/sda1', used: 90 * GB, total: 100 * GB, usePercent: 90 },
      { name: '/dev/sdb1', used: 10 * GB, total: 100 * GB, usePercent: 10 },
    ]);
    expect(percent).toBeCloseTo(50, 5);
  });

  it('保留容量不同的多块真实磁盘', () => {
    const out = dedupeDisks([
      { name: '/dev/sda1', used: 100 * GB, total: 200 * GB },
      { name: '/dev/sdb1', used: 300 * GB, total: 400 * GB },
    ]);
    expect(out).toHaveLength(2);
    const { used, total, percent } = summarizeDisks(out);
    expect(used).toBe(400 * GB);
    expect(total).toBe(600 * GB);
    expect(percent).toBeCloseTo((400 / 600) * 100, 1);
  });

  it('丢掉落容量为 0 的伪文件系统（tmpfs / proc）', () => {
    const out = dedupeDisks([
      { name: 'tmpfs', used: 0, total: 0, usePercent: 0 },
      { name: 'overlay', used: 10 * GB, total: 0, usePercent: 0 },
      { name: '/dev/sda3', used: 100 * GB, total: 200 * GB },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('/dev/sda3');
  });

  it('同一设备名保留已用量更大的那条', () => {
    const out = dedupeDisks([
      { name: '/dev/sda3', used: 10 * GB, total: 200 * GB },
      { name: '/dev/sda3', used: 50 * GB, total: 200 * GB },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].used).toBe(50 * GB);
  });

  it('usePercent 缺失时按 used/total 计算，并夹在 0~100', () => {
    const out = dedupeDisks([{ name: '/dev/sda3', used: 90 * GB, total: 100 * GB }]);
    expect(out[0].usePercent).toBeCloseTo(90, 5);

    const clamped = dedupeDisks([{ name: '/dev/sda3', used: 120 * GB, total: 100 * GB }]);
    expect(clamped[0].usePercent).toBe(100);
  });

  it('空输入 / 非数组输入都安全返回空数组', () => {
    expect(dedupeDisks([])).toEqual([]);
    expect(dedupeDisks(null)).toEqual([]);
    expect(dedupeDisks(undefined)).toEqual([]);
    expect(summarizeDisks(null)).toEqual({ used: 0, total: 0, percent: 0 });
  });

  it('无设备名时按 total+used 去重（远程 df 解析可能拿不到设备名）', () => {
    const out = dedupeDisks([
      { used: 100 * GB, total: 200 * GB },
      { used: 100 * GB, total: 200 * GB },
    ]);
    expect(out).toHaveLength(1);
  });

  it('两块同容量但用量不同的真实磁盘不会被错误合并', () => {
    const out = dedupeDisks([
      { name: '/dev/sda1', used: 10 * GB, total: 500 * GB },
      { name: '/dev/sdb1', used: 300 * GB, total: 500 * GB },
    ]);
    expect(out).toHaveLength(2);
    expect(summarizeDisks(out).percent).toBeCloseTo(((10 + 300) / (500 + 500)) * 100, 5);
  });
});
