import { describe, it, expect } from 'vitest';
import { dedupeDisks, summarizeDisks } from './diskUsage';

const GB = 1024 ** 3;

// T4 真实形状：同一块盘被重复列了 6 次 + 一条 overlay
const duplicated = [
  { name: 'overlay', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
  { name: '/dev/sda3', used: 346 * GB, total: 436 * GB, usePercent: 79.4 },
];

describe('summarizeDisks', () => {
  it('同一块盘的重复条目只算一次，不会出现 476.9%', () => {
    const s = summarizeDisks(duplicated);
    expect(s.disks).toHaveLength(1);
    expect(s.percent).toBeCloseTo((346 / 436) * 100, 1);
    expect(s.percent).toBeLessThanOrEqual(100);
  });

  it('多块真实磁盘按容量加权汇总', () => {
    const s = summarizeDisks([
      { name: '/dev/sda1', used: 100 * GB, total: 200 * GB },
      { name: '/dev/sdb1', used: 300 * GB, total: 400 * GB },
    ]);
    expect(s.disks).toHaveLength(2);
    expect(s.used).toBe(400 * GB);
    expect(s.total).toBe(600 * GB);
    expect(s.percent).toBeCloseTo((400 / 600) * 100, 1);
  });

  it('忽略总容量为 0 的条目（tmpfs / 挂载失败的盘）', () => {
    const s = summarizeDisks([
      { name: 'tmpfs', used: 0, total: 0 },
      { name: '/dev/sda3', used: 80 * GB, total: 100 * GB },
    ]);
    expect(s.disks).toHaveLength(1);
    expect(s.percent).toBeCloseTo(80, 5);
  });

  it('没有数据时返回 0 而不是 NaN', () => {
    expect(summarizeDisks(null)).toEqual({ disks: [], used: 0, total: 0, percent: 0 });
    expect(summarizeDisks([]).percent).toBe(0);
  });

  it('已用超过容量时夹到 100%', () => {
    const s = summarizeDisks([{ name: '/dev/sda3', used: 200 * GB, total: 100 * GB }]);
    expect(s.percent).toBe(100);
  });
});

describe('dedupeDisks', () => {
  it('同设备名保留已用量更大的那条', () => {
    const out = dedupeDisks([
      { name: '/dev/sda3', used: 10 * GB, total: 200 * GB },
      { name: '/dev/sda3', used: 50 * GB, total: 200 * GB },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].used).toBe(50 * GB);
  });

  it('总容量相同但名字不同（macOS APFS / overlay）也只留一条', () => {
    const out = dedupeDisks([
      { name: '/', used: 100 * GB, total: 500 * GB },
      { name: '/System/Volumes/Data', used: 300 * GB, total: 500 * GB },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].used).toBe(300 * GB);
  });
});
