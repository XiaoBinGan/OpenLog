/**
 * 容量告警弹窗抑制逻辑的单测。
 *
 * 三条需求对应三组断言：
 *   持续展示   → 没有任何"自动消失"路径（本模块只算"该不该显示"，不含计时器）
 *   1 小时不弹 → isSnoozed / visibleAlerts
 *   未处理继续弹 → 到点后重新可见 + pruneSnoozes 保证"恢复即遗忘"
 */
import { describe, it, expect } from 'vitest';
import {
  readSnoozes,
  writeSnoozes,
  isSnoozed,
  visibleAlerts,
  snoozeAlerts,
  pruneSnoozes,
  snoozeRemainingMinutes,
  hasCritical,
  DEFAULT_SNOOZE_MINUTES,
  type CapacityAlert,
} from './capacityAlert';

const mem = (percent = 96): CapacityAlert => ({
  key: 'memory', kind: 'memory', name: '内存', percent,
  threshold: 90, level: percent >= 95 ? 'critical' : 'warning',
  title: '内存使用率过高', detail: `当前 ${percent}%`,
});
const disk = (name = '/data', percent = 85): CapacityAlert => ({
  key: `disk:${name}`, kind: 'disk', name, percent,
  threshold: 80, level: percent >= 90 ? 'critical' : 'warning',
  title: `磁盘 ${name} 空间不足`, detail: `当前 ${percent}%`,
});

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe('readSnoozes —— 脏数据必须丢掉（否则告警永远不弹）', () => {
  it('正常 JSON', () => {
    expect(readSnoozes('{"memory":1700000000000}', T0 + MIN)).toEqual({ memory: T0 });
  });

  it('空/null/非法 JSON → 空表', () => {
    expect(readSnoozes(null)).toEqual({});
    expect(readSnoozes('')).toEqual({});
    expect(readSnoozes('not json')).toEqual({});
    expect(readSnoozes('[]')).toEqual({});
    expect(readSnoozes('"str"')).toEqual({});
  });

  it('**未来时间戳丢弃**（时钟回拨或被手改，宁可多弹一次）', () => {
    const future = T0 + 10 * 24 * 60 * MIN;
    expect(readSnoozes(JSON.stringify({ memory: future }), T0)).toEqual({});
  });

  it('微小超前（60 秒内）容忍，视为刚关闭', () => {
    expect(readSnoozes(JSON.stringify({ memory: T0 + 5000 }), T0)).toEqual({ memory: T0 + 5000 });
  });

  it('非数字值丢弃', () => {
    expect(readSnoozes('{"memory":"abc","disk:/":"NaN"}', T0)).toEqual({});
    expect(readSnoozes('{"memory":-5}', T0)).toEqual({});
    expect(readSnoozes('{"memory":0}', T0)).toEqual({});
  });

  it('部分脏部分干净 → 只留干净的', () => {
    const raw = JSON.stringify({ memory: T0, 'disk:/': 'bad' });
    expect(readSnoozes(raw, T0 + MIN)).toEqual({ memory: T0 });
  });

  it('writeSnoozes 与 readSnoozes 往返一致', () => {
    const map = { memory: T0, 'disk:/data': T0 + 1000 };
    expect(readSnoozes(writeSnoozes(map), T0 + 2 * MIN)).toEqual(map);
  });
});

describe('isSnoozed —— 1 小时窗口', () => {
  it('刚关闭 → 抑制中', () => {
    expect(isSnoozed('memory', { memory: T0 }, T0)).toBe(true);
  });

  it('59 分钟 → 仍抑制', () => {
    expect(isSnoozed('memory', { memory: T0 }, T0 + 59 * MIN)).toBe(true);
  });

  it('**61 分钟 → 解除抑制（未处理继续弹）**', () => {
    expect(isSnoozed('memory', { memory: T0 }, T0 + 61 * MIN)).toBe(false);
  });

  it('恰好 60 分钟 → 解除（边界取"已到期"）', () => {
    expect(isSnoozed('memory', { memory: T0 }, T0 + 60 * MIN)).toBe(false);
  });

  it('没关闭过 → 不抑制', () => {
    expect(isSnoozed('memory', {}, T0)).toBe(false);
  });

  it('**按 key 独立**：关掉磁盘不压住内存', () => {
    const snoozes = { 'disk:/data': T0 };
    expect(isSnoozed('disk:/data', snoozes, T0 + MIN)).toBe(true);
    expect(isSnoozed('memory', snoozes, T0 + MIN)).toBe(false);
  });

  it('自定义窗口生效', () => {
    expect(isSnoozed('memory', { memory: T0 }, T0 + 10 * MIN, 5)).toBe(false);
    expect(isSnoozed('memory', { memory: T0 }, T0 + 3 * MIN, 5)).toBe(true);
  });

  it('窗口值非法 → 退回默认 60 分钟', () => {
    expect(isSnoozed('memory', { memory: T0 }, T0 + 30 * MIN, 0)).toBe(true);
    expect(isSnoozed('memory', { memory: T0 }, T0 + 30 * MIN, NaN as unknown as number)).toBe(true);
  });
});

describe('visibleAlerts —— 决定这一轮弹什么', () => {
  it('没关闭过 → 全部要弹', () => {
    const list = [mem(), disk()];
    expect(visibleAlerts(list, {}, T0)).toHaveLength(2);
  });

  it('关过的那条不弹，其它照弹', () => {
    const list = [mem(), disk()];
    const out = visibleAlerts(list, { memory: T0 }, T0 + 10 * MIN);
    expect(out.map((a) => a.key)).toEqual(['disk:/data']);
  });

  it('抑制到点 → 重新弹（未处理继续弹）', () => {
    const out = visibleAlerts([mem()], { memory: T0 }, T0 + 61 * MIN);
    expect(out.map((a) => a.key)).toEqual(['memory']);
  });

  it('空输入/undefined 不炸', () => {
    expect(visibleAlerts(undefined, {})).toEqual([]);
    expect(visibleAlerts([], {})).toEqual([]);
    expect(visibleAlerts([null as unknown as CapacityAlert], {})).toEqual([]);
  });
});

describe('snoozeAlerts', () => {
  it('给多条打同一时间戳，且不修改入参', () => {
    const before = { 'disk:/': T0 };
    const after = snoozeAlerts(['memory', 'disk:/data'], before, T0 + MIN);
    expect(after).toEqual({ 'disk:/': T0, memory: T0 + MIN, 'disk:/data': T0 + MIN });
    expect(before).toEqual({ 'disk:/': T0 });
  });

  it('空 key 忽略', () => {
    expect(snoozeAlerts(['', 'memory'], {}, T0)).toEqual({ memory: T0 });
  });
});

describe('pruneSnoozes —— 恢复即遗忘（否则新的故障不会提醒）', () => {
  it('仍超标的 key 保留', () => {
    expect(pruneSnoozes({ memory: T0, 'disk:/': T0 }, ['memory'])).toEqual({ memory: T0 });
  });

  it('**已恢复的 key 删除**：下次再超标要立刻弹', () => {
    const after = pruneSnoozes({ memory: T0 }, []);
    expect(after).toEqual({});
    // 再超标时不该被旧时间戳压住
    expect(isSnoozed('memory', after, T0 + MIN)).toBe(false);
  });

  it('空表安全', () => {
    expect(pruneSnoozes({}, ['memory'])).toEqual({});
  });
});

describe('snoozeRemainingMinutes', () => {
  it('刚关 → 60 分钟', () => {
    expect(snoozeRemainingMinutes('memory', { memory: T0 }, T0)).toBe(60);
  });

  it('过了一半 → 30 分钟', () => {
    expect(snoozeRemainingMinutes('memory', { memory: T0 }, T0 + 30 * MIN)).toBe(30);
  });

  it('到期 → 0', () => {
    expect(snoozeRemainingMinutes('memory', { memory: T0 }, T0 + 61 * MIN)).toBe(0);
  });

  it('没关闭过 → 0', () => {
    expect(snoozeRemainingMinutes('memory', {}, T0)).toBe(0);
  });
});

describe('hasCritical', () => {
  it('内存 96% / 磁盘 92% → critical', () => {
    expect(hasCritical([mem(96)])).toBe(true);
    expect(hasCritical([disk('/', 92)])).toBe(true);
  });

  it('内存 91%、磁盘 81% → 都不算 critical（是 warning）', () => {
    expect(hasCritical([mem(91), disk('/', 81)])).toBe(false);
  });

  it('空 → false', () => {
    expect(hasCritical([])).toBe(false);
    expect(hasCritical(undefined)).toBe(false);
  });
});

describe('默认窗口', () => {
  it('是 60 分钟（需求：一小时内不显示）', () => {
    expect(DEFAULT_SNOOZE_MINUTES).toBe(60);
  });
});
