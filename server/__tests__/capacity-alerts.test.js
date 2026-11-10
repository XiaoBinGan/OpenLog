/**
 * server/capacity-alerts.js —— 容量告警判定
 *
 * 需求：内存 > 90% 或任一磁盘 > 80% 就报警。
 * 边界必须精确：**> 90 才算**，正好 90 不算（"超过"不是"达到"）。
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeThresholds,
  alertKey,
  evaluateCapacityAlerts,
  DEFAULT_CAPACITY_THRESHOLDS,
} from '../capacity-alerts.js';

const disk = (name, pct) => ({ name, used: pct * 10, total: 1000, usePercent: pct });

describe('normalizeThresholds', () => {
  it('默认 90 / 80', () => {
    expect(normalizeThresholds()).toEqual({ memoryPercent: 90, diskPercent: 80 });
    expect(DEFAULT_CAPACITY_THRESHOLDS).toEqual({ memoryPercent: 90, diskPercent: 80 });
  });

  it('自定义值生效', () => {
    expect(normalizeThresholds({ memoryPercent: 85, diskPercent: 70 }))
      .toEqual({ memoryPercent: 85, diskPercent: 70 });
  });

  it('**非法值退回默认**（0/负数/NaN 会让告警永远触发或永不触发）', () => {
    expect(normalizeThresholds({ memoryPercent: 0 }).memoryPercent).toBe(90);
    expect(normalizeThresholds({ memoryPercent: -5 }).memoryPercent).toBe(90);
    expect(normalizeThresholds({ memoryPercent: NaN }).memoryPercent).toBe(90);
    expect(normalizeThresholds({ memoryPercent: 'abc' }).memoryPercent).toBe(90);
    expect(normalizeThresholds({ diskPercent: 0 }).diskPercent).toBe(80);
  });

  it('超过 100 夹到 100（等价"永不报警"，但至少不是 NaN）', () => {
    expect(normalizeThresholds({ memoryPercent: 150 }).memoryPercent).toBe(100);
  });

  it('字符串数字可用（设置存的是字符串）', () => {
    expect(normalizeThresholds({ memoryPercent: '92', diskPercent: '75' }))
      .toEqual({ memoryPercent: 92, diskPercent: 75 });
  });
});

describe('alertKey', () => {
  it('内存是固定 key', () => {
    expect(alertKey('memory')).toBe('memory');
    expect(alertKey('memory', 'ignored')).toBe('memory');
  });

  it('磁盘按设备区分（关掉 /data 不该压住 / 的提示）', () => {
    expect(alertKey('disk', '/data')).toBe('disk:/data');
    expect(alertKey('disk', '/')).toBe('disk:/');
    expect(alertKey('disk', '/')).not.toBe(alertKey('disk', '/data'));
  });
});

describe('evaluateCapacityAlerts —— 内存', () => {
  it('90% 正好不报（需求是"超过 90%"）', () => {
    expect(evaluateCapacityAlerts({ memoryPercent: 90, disks: [] })).toEqual([]);
  });

  it('90.1% 报 warning', () => {
    const out = evaluateCapacityAlerts({ memoryPercent: 90.1, disks: [] });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('memory');
    expect(out[0].level).toBe('warning');
    expect(out[0].percent).toBe(90.1);
    expect(out[0].threshold).toBe(90);
  });

  it('**95% 及以上升 critical**（接近 OOM）', () => {
    expect(evaluateCapacityAlerts({ memoryPercent: 95, disks: [] })[0].level).toBe('critical');
    expect(evaluateCapacityAlerts({ memoryPercent: 99.9, disks: [] })[0].level).toBe('critical');
  });

  it('94.9% 还是 warning', () => {
    expect(evaluateCapacityAlerts({ memoryPercent: 94.9, disks: [] })[0].level).toBe('warning');
  });

  it('正常值不报', () => {
    expect(evaluateCapacityAlerts({ memoryPercent: 45, disks: [] })).toEqual([]);
  });

  it('NaN / undefined 内存不报（别把取不到数据当故障）', () => {
    expect(evaluateCapacityAlerts({ memoryPercent: NaN, disks: [] })).toEqual([]);
    expect(evaluateCapacityAlerts({ disks: [] })).toEqual([]);
    expect(evaluateCapacityAlerts(null)).toEqual([]);
  });

  it('文案带上实际值与阈值', () => {
    const a = evaluateCapacityAlerts({ memoryPercent: 93.46, disks: [] })[0];
    expect(a.detail).toContain('93.5');
    expect(a.detail).toContain('90');
    expect(a.title).toContain('内存');
  });
});

describe('evaluateCapacityAlerts —— 磁盘', () => {
  it('80% 正好不报', () => {
    expect(evaluateCapacityAlerts({ memoryPercent: 10, disks: [disk('/', 80)] })).toEqual([]);
  });

  it('80.1% 报 warning', () => {
    const out = evaluateCapacityAlerts({ memoryPercent: 10, disks: [disk('/', 80.1)] });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('disk:/');
    expect(out[0].level).toBe('warning');
  });

  it('**90% 及以上升 critical**（写入随时失败）', () => {
    expect(evaluateCapacityAlerts({ memoryPercent: 10, disks: [disk('/data', 90)] })[0].level).toBe('critical');
  });

  it('多块盘各报一条，key 不同', () => {
    const out = evaluateCapacityAlerts({
      memoryPercent: 10,
      disks: [disk('/', 85), disk('/data', 92), disk('/boot', 20)],
    });
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.key).sort()).toEqual(['disk:/', 'disk:/data']);
  });

  it('**按超阈值幅度排序**（超得多的排前，用户先看最要紧的）', () => {
    const out = evaluateCapacityAlerts({
      memoryPercent: 91,          // 超 1
      disks: [disk('/data', 95)], // 超 15
    });
    expect(out[0].key).toBe('disk:/data');
    expect(out[1].key).toBe('memory');
  });

  it('磁盘用 usePercent，不自己拿 used/total 重算（df 口径已扣 reserved）', () => {
    // used/total = 70%，但 df 报 85% —— 要信 df 的 85%
    const out = evaluateCapacityAlerts({
      memoryPercent: 10,
      disks: [{ name: '/x', used: 700, total: 1000, usePercent: 85 }],
    });
    expect(out[0].percent).toBe(85);
  });

  it('没名字的盘用兜底文案，key 用下标兜底（避免两块无名盘共用一个 key）', () => {
    const out = evaluateCapacityAlerts({ memoryPercent: 10, disks: [disk('', 85)] });
    expect(out[0].name).toBe('未知磁盘');
    expect(out[0].key).toBe('disk:#0');
  });

  it('**两块无名盘产生两个不同 key**（关掉一条不该压住另一条）', () => {
    const out = evaluateCapacityAlerts({
      memoryPercent: 10,
      disks: [disk('', 85), disk('', 88)],
    });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((a) => a.key)).size).toBe(2);
  });

  it('usePercent 非法就跳过（别把 undefined 当 0% 也别当 100%）', () => {
    expect(evaluateCapacityAlerts({ memoryPercent: 10, disks: [{ name: '/x' }] })).toEqual([]);
    expect(evaluateCapacityAlerts({ memoryPercent: 10, disks: [{ name: '/x', usePercent: NaN }] })).toEqual([]);
  });

  it('disks 不是数组时不炸', () => {
    expect(evaluateCapacityAlerts({ memoryPercent: 10, disks: null })).toEqual([]);
    expect(evaluateCapacityAlerts({ memoryPercent: 10, disks: 'nope' })).toEqual([]);
  });
});

describe('evaluateCapacityAlerts —— 阈值可配', () => {
  it('自定义阈值生效（内存 70 / 磁盘 50）', () => {
    const out = evaluateCapacityAlerts(
      { memoryPercent: 75, disks: [disk('/', 60)] },
      { memoryPercent: 70, diskPercent: 50 },
    );
    expect(out).toHaveLength(2);
    expect(out.find((a) => a.kind === 'memory').threshold).toBe(70);
    expect(out.find((a) => a.kind === 'disk').threshold).toBe(50);
  });

  it('阈值放宽后原本告警的现在不报', () => {
    expect(evaluateCapacityAlerts(
      { memoryPercent: 92, disks: [] },
      { memoryPercent: 95 },
    )).toEqual([]);
  });
});

describe('综合', () => {
  it('内存 + 两块盘同时超标 → 三条，critical 混在其中', () => {
    const out = evaluateCapacityAlerts({
      memoryPercent: 97,
      disks: [disk('/', 83), disk('/data', 93)],
    });
    expect(out).toHaveLength(3);
    expect(out.filter((a) => a.level === 'critical')).toHaveLength(2);
    expect(new Set(out.map((a) => a.key)).size).toBe(3);
  });

  it('全部正常 → 空数组（不是 undefined）', () => {
    const out = evaluateCapacityAlerts({ memoryPercent: 30, disks: [disk('/', 40)] });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([]);
  });
});
