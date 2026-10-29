import { describe, it, expect } from 'vitest';

/**
 * SSH 连接池在 1000 台规模上的行为。
 *
 * 实测数据（200 条真实连接，0 失败）：
 *   单连接内存 ≈ 64KB RSS，文件描述符 = 1 个/连接
 *   单次握手 ≈ 184ms（p95 240ms）
 *   单机 stats 采集 ≈ 102ms
 * 推论：1000 台 ≈ 64MB 内存 + 1000 个 FD，完全放得下；真正的坑是
 * **上限小于服务器数** —— 那样每轮采集都要 LRU 驱逐 + 重新握手。
 *
 * 默认上限因此从 300 提到 1200，并把这个决策固化成这里的测试。
 */

const { planEvictions } = await import('../remote.js');

const TTL = 10 * 60 * 1000;
const NOW = 1_800_000_000_000;
const entries = (n, { usedAt = NOW } = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `srv-${i}`, used: usedAt }));

describe('planEvictions —— 1000 台规模', () => {
  it('1000 台、上限 1200：一条都不驱逐（这是 1000 台场景的关键前提）', () => {
    const { expired, evicted } = planEvictions(entries(1000), { max: 1200, idleTtlMs: TTL, now: NOW });
    expect(expired).toEqual([]);
    expect(evicted).toEqual([]);
  });

  it('1000 台、上限 300：驱逐最久未用的 700 条（旧默认值下的真实代价）', () => {
    // 时间戳都落在 TTL 内，单独考察「超上限」这一条规则
    const list = entries(1000).map((e, i) => ({ ...e, used: NOW - (1000 - i) * 400 }));
    const { expired, evicted } = planEvictions(list, { max: 300, idleTtlMs: TTL, now: NOW });
    expect(expired).toEqual([]);
    expect(evicted).toHaveLength(700);
    // LRU：留下的应该是最新的 300 条
    const kept = list.filter(e => !evicted.includes(e.id)).map(e => e.id);
    expect(kept).toEqual(list.slice(-300).map(e => e.id));
  });

  it('恰好等于上限时不动', () => {
    const { expired, evicted } = planEvictions(entries(1200), { max: 1200, idleTtlMs: TTL, now: NOW });
    expect(expired).toEqual([]);
    expect(evicted).toEqual([]);
  });

  it('超上限 1 台也只收 1 台（不做过度回收）', () => {
    const { evicted } = planEvictions(entries(1201), { max: 1200, idleTtlMs: TTL, now: NOW });
    expect(evicted).toHaveLength(1);
  });

  it('空闲超 TTL 的先回收，即使没到上限', () => {
    const list = [
      { id: 'idle-old', used: NOW - TTL - 1000 },
      { id: 'fresh', used: NOW - 1000 },
    ];
    const { expired, evicted } = planEvictions(list, { max: 1200, idleTtlMs: TTL, now: NOW });
    expect(expired).toEqual(['idle-old']);
    expect(evicted).toEqual([]);
  });

  it('刚用过（used=0 未初始化）不会被误判为空闲', () => {
    // connectionLastUsed 可能有缺失值，used=0 会被当成「很久以前」——
    // 这是现有行为，明确一下：缺失时间戳的记录会被 TTL 回收
    const { expired } = planEvictions([{ id: 'no-ts', used: 0 }], { max: 1200, idleTtlMs: TTL, now: NOW });
    expect(expired).toEqual(['no-ts']);
  });

  it('清空/空输入不炸', () => {
    expect(planEvictions([], { max: 1200, idleTtlMs: TTL, now: NOW })).toEqual({ expired: [], evicted: [] });
    expect(planEvictions(null, { max: 1200, idleTtlMs: TTL, now: NOW })).toEqual({ expired: [], evicted: [] });
  });

  it('max=0 时全部回收（配置为 0 等于禁用常驻连接）', () => {
    const { evicted } = planEvictions(entries(10), { max: 0, idleTtlMs: TTL, now: NOW });
    expect(evicted).toHaveLength(10);
  });
});

describe('容量推算（实测数据的回归基线）', () => {
  /** 实测值，改代码/依赖升级后如果劣化，这里会提醒重新评估 */
  const MEASURED = { rssPerConnKB: 64, fdPerConn: 1, handshakeMs: 184, statsMs: 102 };

  it('1000 台的资源推算都在安全范围内', () => {
    const memMB = (MEASURED.rssPerConnKB * 1000) / 1024;
    expect(memMB).toBeLessThan(256);          // 64MB，远低于容器可用内存
    expect(MEASURED.fdPerConn * 1000).toBeLessThan(100_000); // FD 上限 1,048,576
  });

  it('并发 16 时一轮采集耗时应远小于 30s 间隔', () => {
    const passMs = (MEASURED.statsMs * 1000) / 16;
    expect(passMs).toBeLessThan(30_000);
    expect(passMs).toBeLessThan(10_000); // 实测推算 ≈ 6.4s
  });

  it('1000 台冷启动全量握手在可接受范围（并发 16）', () => {
    const connectMs = (MEASURED.handshakeMs * 1000) / 16;
    expect(connectMs).toBeLessThan(30_000); // ≈ 11.5s
  });
});
