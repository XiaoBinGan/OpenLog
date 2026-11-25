/**
 * server/__tests__/infra-capacity.test.js —— 容量预检（A4）行为锁定
 *
 * 这里测的不是"函数能跑"，而是**判定口径**。HAMi 真机上最容易踩的坑按重要性排：
 *
 *   1. 跨卡拼显存：两张卡各剩 4 GiB，要 8 GiB 的副本**放不下**。任何把
 *      "节点剩余显存合计" 拿去和单副本需求比的实现都会在这里挂掉。
 *   2. 边界含等号：剩余 8000 放 8000 是能放的，差 1 MiB 就不能放。
 *   3. 整卡模式（memoryMiB=0）要求那张卡**完全空闲**，剩 24564-100 也不行。
 *   4. 显存够但算力/槽位不够照样放不下（HAMi 三个维度是 AND 关系）。
 *   5. 多副本要**逐副本扣减**：24564 的卡放 8000 的副本只放得下 3 个。
 *
 * 所有节点/分配都是本地 fixture，adapter 一律 mock —— 不碰集群。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  planPlacement,
  planPlacementAsync,
  normalizeDemand,
  formatMiB,
  SINGLE_CARD_RULE,
  DEFAULT_DEVICE_SLOTS,
} from '../infra/capacity.js';

// ─── fixture 构造器 ──────────────────────────────────────────────────────

const RTX4090 = 'NVIDIA GeForce RTX 4090';
const RTX5090 = 'NVIDIA GeForce RTX 5090';
const A100 = 'NVIDIA A100-SXM4-80GB';

/** 一张 4090：24564 MiB / 100% 算力 / 10 槽 */
const card = (id, totalMemMiB = 24564, extra = {}) => ({
  id,
  type: RTX4090,
  totalMemMiB,
  totalCores: 100,
  totalSlots: DEFAULT_DEVICE_SLOTS,
  ...extra,
});

const node = (name, devices, extra = {}) => ({ name, devices, ...extra });

/** 已分配记录（HAMi NodeStatus 里的 allocation 形状） */
const alloc = (nodeName, deviceId, memoryMiB, coresPercent = 0, extra = {}) => ({
  node: nodeName,
  deviceId,
  memoryMiB,
  coresPercent,
  ...extra,
});

/** 服务：默认 1 副本 / 单卡 / 8000 MiB / 50% 算力 */
const service = (over = {}) => ({
  name: 'qwen2.5-7b',
  replicas: 1,
  resources: { accelerators: 1, memoryMiB: 8000, coresPercent: 50 },
  ...over,
});

const mockedAdapter = (impl) => ({ readCapacity: vi.fn(impl ?? (() => null)) });

// ─── 口径基础 ────────────────────────────────────────────────────────────

describe('formatMiB / normalizeDemand', () => {
  it('formatMiB 用 GiB 显示大于 1024 的值，小值保留 MiB', () => {
    expect(formatMiB(8000)).toBe('7.8 GiB');
    expect(formatMiB(1024)).toBe('1.0 GiB');
    expect(formatMiB(512)).toBe('512 MiB');
    expect(formatMiB(0)).toBe('0 MiB');
    expect(formatMiB(NaN)).toBe('未知');
  });

  it('memoryMiB=0 是整卡，coresPercent=0 是不限算力（两者语义相反）', () => {
    const whole = normalizeDemand(service({ resources: { accelerators: 1, memoryMiB: 0, coresPercent: 0 } }));
    expect(whole.wholeCard).toBe(true);
    expect(whole.memoryMiB).toBe(0);
    expect(whole.coresPercent).toBe(0);
    expect(whole.cardsPerReplica).toBe(1);

    const limited = normalizeDemand(service());
    expect(limited.wholeCard).toBe(false);
    expect(limited.coresPercent).toBe(50);
  });

  it('脏值兜底：replicas=0/NaN → 1，accelerators 缺失 → 1，policy 只认 spread', () => {
    expect(normalizeDemand({ replicas: 0 }).replicas).toBe(1);
    expect(normalizeDemand({ replicas: NaN }).replicas).toBe(1);
    expect(normalizeDemand({ replicas: 999 }).replicas).toBe(64);
    expect(normalizeDemand({ resources: { memoryMiB: 100 } }).cardsPerReplica).toBe(1);
    expect(normalizeDemand({ resources: { memoryMiB: 100 }, placement: { policy: 'spread' } }).policy).toBe('spread');
    expect(normalizeDemand({ resources: { memoryMiB: 100 }, placement: { policy: 'whatever' } }).policy).toBe('binpack');
    expect(normalizeDemand({ resources: { memoryMiB: 100, coresPercent: 500 } }).coresPercent).toBe(100);
  });
});

// ─── 单卡放不放 ──────────────────────────────────────────────────────────

describe('单卡语义', () => {
  it('单卡刚好放下：剩余 8000 放 8000（边界含等号）', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const allocations = [alloc('gpu-1', 'gpu0', 16564, 50)];

    const r = planPlacement({ service: service(), nodes, allocations });

    expect(r.fits).toBe(true);
    expect(r.best).toBe('gpu-1');
    expect(r.candidates[0]).toMatchObject({
      node: 'gpu-1', eligible: true, fits: true, freeMemMiB: 8000, freeCores: 50, freeSlots: 9,
    });
    expect(r.reasons.join('\n')).toContain('放得下');
    expect(r.plan).toEqual([{ replica: 1, node: 'gpu-1', cards: ['gpu0'], memoryMiB: 8000 }]);
  });

  it('差 1 MiB 放不下（8001 要 8001，剩 8000），且 reasons 带出两个具体数字', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const allocations = [alloc('gpu-1', 'gpu0', 16564, 50)];
    const svc = service({ resources: { accelerators: 1, memoryMiB: 8001, coresPercent: 50 } });

    const r = planPlacement({ service: svc, nodes, allocations });
    const text = r.reasons.join('\n');

    expect(r.fits).toBe(false);
    expect(r.best).toBeNull();
    expect(text).toContain('8001 MiB');
    expect(text).toContain('8000 MiB');
    expect(r.candidates[0].fits).toBe(false);
    expect(r.candidates[0].maxFreeMemMiB).toBe(8000);
    // 结论不能只有一句 false：必须解释"为什么"
    expect(r.reasons.length).toBeGreaterThan(2);
  });

  it('跨卡拼不成：两卡各剩 4 GiB，要 7.8 GiB → 放不下，并说明合计够但单卡不够', () => {
    const nodes = [node('混合卡节点', [
      card('rtx4090', 24564, { type: RTX4090 }),
      card('rtx5090', 32760, { type: RTX5090 }),
    ])];
    const allocations = [
      alloc('混合卡节点', 'rtx4090', 20468, 50),
      alloc('混合卡节点', 'rtx5090', 28664, 50),
    ];

    const r = planPlacement({ service: service(), nodes, allocations });
    const candidate = r.candidates[0];

    // 合计 8192 ≥ 8000 —— 这正是"看着够"的陷阱
    expect(candidate.freeMemMiB).toBe(8192);
    // 但单卡最多只有 4096
    expect(candidate.maxFreeMemMiB).toBe(4096);
    expect(r.fits).toBe(false);
    expect(r.best).toBeNull();

    const fragments = r.fragments.join('\n');
    expect(fragments).toContain('4090 剩 4.0 GiB');
    expect(fragments).toContain('5090 剩 4.0 GiB');
    expect(fragments).toContain('单卡都放不下');
    expect(fragments).toContain('不能跨卡拼显存');
    // 硬约束必须在全局结论里出现
    expect(r.reasons.join('\n')).toContain('单卡语义');
  });

  it('两卡各 4000、需求 8000 的极端情形同样放不下（总和正好差一点）', () => {
    const nodes = [node('n1', [card('g0', 8192), card('g1', 8192)])];
    const allocations = [
      alloc('n1', 'g0', 4192),
      alloc('n1', 'g1', 4192),
    ];
    const r = planPlacement({ service: service(), nodes, allocations });
    expect(r.candidates[0].freeMemMiB).toBe(8000);
    expect(r.fits).toBe(false);
    expect(r.reasons.join('\n')).toContain('显存不足');
  });
});

// ─── 多副本 ──────────────────────────────────────────────────────────────

describe('多副本滚动扣减', () => {
  it('24564 的卡放 3 个 8000 副本：放得下，剩 564 MiB', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    // 算力不设限，单看显存能放几个：24564 / 8000 = 3（余 564）
    const r = planPlacement({
      service: service({ replicas: 3, resources: { accelerators: 1, memoryMiB: 8000, coresPercent: 0 } }),
      nodes,
    });

    expect(r.fits).toBe(true);
    expect(r.plan.map((p) => p.cards[0])).toEqual(['gpu0', 'gpu0', 'gpu0']);
    expect(r.candidates[0].remainingMiB).toBe(24564 - 3 * 8000);
    expect(r.candidates[0].freeMemMiB).toBe(24564); // 原始剩余，未被模拟污染
  });

  it('第 4 个副本放不下：unplaced 指向 replica 4，候选说明只能装 3 个', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const r = planPlacement({
      service: service({ replicas: 4, resources: { accelerators: 1, memoryMiB: 8000, coresPercent: 0 } }),
      nodes,
    });

    expect(r.fits).toBe(false);
    expect(r.plan).toHaveLength(3);
    expect(r.unplaced.replica).toBe(4);
    expect(r.candidates[0].placedReplicas).toBe(3);
    expect(r.candidates[0].reasons.join()).toContain('3/4');
  });

  it('同样的两节点两副本：binpack 全塞进第一个节点，spread 才跨节点', () => {
    const nodes = [node('a', [card('a0')]), node('b', [card('b0')])];
    const svc = service({ replicas: 2, resources: { accelerators: 1, memoryMiB: 8000, coresPercent: 0 } });

    const binpack = planPlacement({ service: svc, nodes });
    const spread = planPlacement({ service: svc, nodes, policy: 'spread' });

    expect(binpack.fits).toBe(true);
    expect(binpack.plan.map((p) => p.node)).toEqual(['a', 'a']);
    expect(binpack.best).toBe('a');

    expect(spread.fits).toBe(true);
    expect(spread.plan.map((p) => p.node)).toEqual(['a', 'b']);
    expect(spread.best).toBe(spread.plan[0].node);
    expect(spread.candidates.every((c) => c.fits === true)).toBe(true);
  });

  it('binpack 与 spread 落点不同：binpack 先塞小卡，spread 先摊大卡', () => {
    const nodes = [
      node('n-small', [card('s0', 24564)]),
      node('n-mid', [card('m0', 24564)]),
      node('n-large', [card('l0', 49152)]),
    ];
    const allocations = [
      alloc('n-small', 's0', 15564), // 剩 9000
      alloc('n-mid', 'm0', 12564), // 剩 12000
      alloc('n-large', 'l0', 25152), // 剩 24000
    ];
    const svc = service({ replicas: 2, resources: { accelerators: 1, memoryMiB: 8000, coresPercent: 0 } });

    const binpack = planPlacement({ service: svc, nodes, allocations, policy: 'binpack' });
    const spread = planPlacement({ service: svc, nodes, allocations, policy: 'spread' });

    // binpack：先 9000（扣完剩 1000，最紧），小卡塞满后再去 12000
    expect(binpack.plan.map((p) => p.node)).toEqual(['n-small', 'n-mid']);
    // spread：先 24000，第二个副本在剩下最大的卡上 → 还是 n-large
    expect(spread.plan.map((p) => p.node)).toEqual(['n-large', 'n-large']);
    expect(binpack.plan[0].node).not.toBe(spread.plan[0].node);
    // 两种策略都装得下，只是落点不同
    expect(binpack.fits).toBe(true);
    expect(spread.fits).toBe(true);
  });
});

// ─── 整卡模式 ────────────────────────────────────────────────────────────

describe('整卡模式（memoryMiB = 0）', () => {
  it('卡上有残留分配就不算空闲：整卡放不下，并说明剩余 ≠ 总量', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const allocations = [alloc('gpu-1', 'gpu0', 100, 0)];
    const svc = service({ resources: { accelerators: 1, memoryMiB: 0, coresPercent: 0 } });

    const r = planPlacement({ service: svc, nodes, allocations });

    expect(r.fits).toBe(false);
    expect(r.candidates[0].freeMemMiB).toBe(24464);
    const text = r.reasons.join('\n');
    expect(text).toContain('整卡');
    expect(text).toContain('完全空闲');
    expect(text).toContain('24464 MiB');
  });

  it('完全空闲的卡可以整卡交付（两副本 → 两张卡）', () => {
    const nodes = [node('gpu-1', [card('gpu0'), card('gpu1')])];
    const svc = service({ replicas: 2, resources: { accelerators: 1, memoryMiB: 0, coresPercent: 0 } });

    const r = planPlacement({ service: svc, nodes });

    expect(r.fits).toBe(true);
    expect(r.plan).toHaveLength(2);
    expect(r.plan.flatMap((p) => p.cards)).toEqual(['gpu0', 'gpu1']);
    // 整卡默认要 100% 算力
    expect(r.candidates[0].devices.map((d) => d.freeCores)).toEqual([100, 100]);
  });

  it('整卡 + 第二个副本时卡已被自己占住（串行扣减生效）', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const svc = service({ replicas: 2, resources: { accelerators: 1, memoryMiB: 0, coresPercent: 0 } });

    const r = planPlacement({ service: svc, nodes });

    expect(r.fits).toBe(false);
    expect(r.plan).toHaveLength(1);
    expect(r.unplaced.replica).toBe(2);
  });
});

// ─── 算力 / 槽位 ─────────────────────────────────────────────────────────

describe('算力与槽位也是 AND 关系', () => {
  it('显存够但算力不足：放不下，原因里带算力数字', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const allocations = [alloc('gpu-1', 'gpu0', 4564, 70)]; // 剩 20000 MiB / 30%
    const r = planPlacement({ service: service(), nodes, allocations });

    expect(r.fits).toBe(false);
    expect(r.candidates[0].freeMemMiB).toBe(20000);
    expect(r.candidates[0].freeCores).toBe(30);
    const text = r.reasons.join('\n');
    expect(text).toContain('算力不足');
    expect(text).toContain('30%');
    expect(text).toContain('50%');
  });

  it('显存算力都够但槽位用光：放不下，提示清理旧容器', () => {
    const nodes = [node('gpu-1', [card('gpu0', 24564, { totalSlots: 2 })])];
    const allocations = [
      alloc('gpu-1', 'gpu0', 1000, 0),
      alloc('gpu-1', 'gpu0', 1000, 0),
    ];
    const svc = service({ resources: { accelerators: 1, memoryMiB: 8000, coresPercent: 0 } });

    const r = planPlacement({ service: svc, nodes, allocations });

    expect(r.fits).toBe(false);
    expect(r.candidates[0].freeSlots).toBe(0);
    expect(r.candidates[0].freeMemMiB).toBe(22564);
    expect(r.reasons.join('\n')).toContain('槽位已满');
    expect(r.fragments.join('\n')).toContain('可用槽位');
  });

  it('coresPercent=0 时算力不参与判定（0 = 不限制）', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const allocations = [alloc('gpu-1', 'gpu0', 16564, 100)]; // 算力已被占满
    const svc = service({ resources: { accelerators: 1, memoryMiB: 8000, coresPercent: 0 } });

    const r = planPlacement({ service: svc, nodes, allocations });

    expect(r.candidates[0].freeCores).toBe(0);
    expect(r.fits).toBe(true);
  });

  it('每副本 2 张卡：两卡都够才算放得下，只有 1 张卡时报卡数不足', () => {
    const oneCard = planPlacement({
      service: service({ resources: { accelerators: 2, memoryMiB: 8000, coresPercent: 0 } }),
      nodes: [node('single', [card('gpu0')])],
    });
    expect(oneCard.fits).toBe(false);
    expect(oneCard.reasons.join('\n')).toContain('卡数不足');

    const twoCards = planPlacement({
      service: service({ resources: { accelerators: 2, memoryMiB: 8000, coresPercent: 0 } }),
      nodes: [node('dual', [card('gpu0'), card('gpu1')])],
    });
    expect(twoCards.fits).toBe(true);
    expect(twoCards.plan[0].cards).toEqual(['gpu0', 'gpu1']);
  });
});

// ─── 亲和 / 空集群 ───────────────────────────────────────────────────────

describe('适用性过滤', () => {
  it('型号亲和只考虑匹配的卡：5090 节点显存更大也不参与', () => {
    const nodes = [
      node('node-4090', [card('rtx4090', 24564, { type: RTX4090 })], { acceleratorModel: RTX4090 }),
      node('node-5090', [card('rtx5090', 32760, { type: RTX5090 })], { acceleratorModel: RTX5090 }),
    ];
    const svc = service({ placement: { acceleratorModel: RTX4090 } });

    const r = planPlacement({ service: svc, nodes });

    const byNode = Object.fromEntries(r.candidates.map((c) => [c.node, c]));
    expect(byNode['node-4090'].eligible).toBe(true);
    expect(byNode['node-4090'].fits).toBe(true);
    expect(byNode['node-5090'].eligible).toBe(false);
    expect(byNode['node-5090'].reasons.join()).toContain('型号亲和');
    expect(r.best).toBe('node-4090');
    expect(r.reasons.join('\n')).toContain('型号亲和');
  });

  it('型号亲和匹配但卡被占满：结论是显存不足，而不是"集群里没卡"', () => {
    const nodes = [node('node-4090', [card('rtx4090')], { acceleratorModel: RTX4090 })];
    const allocations = [alloc('node-4090', 'rtx4090', 20000, 20)];
    const r = planPlacement({ service: service({ placement: { acceleratorModel: RTX4090 } }), nodes, allocations });

    expect(r.candidates[0].eligible).toBe(true);
    expect(r.fits).toBe(false);
    expect(r.reasons.join('\n')).toContain('显存不足');
  });

  it('型号亲和一张都不匹配：可用卡数为 0，fragments 直接说清', () => {
    const nodes = [node('node-4090', [card('rtx4090')])];
    const r = planPlacement({ service: service({ placement: { acceleratorModel: A100 } }), nodes });

    expect(r.fits).toBe(false);
    expect(r.best).toBeNull();
    expect(r.fragments.join('\n')).toContain('适用性过滤');
    expect(r.reasons.join('\n')).toContain('A100');
  });

  it('nodeSelector 不匹配的节点也会给出一条可读原因', () => {
    const nodes = [node('n1', [card('gpu0')], { labels: { 'gpu-role': 'training' } })];
    const svc = service({ placement: { nodeSelector: { 'gpu-role': 'inference' } } });

    const r = planPlacement({ service: svc, nodes });

    expect(r.fits).toBe(false);
    expect(r.candidates[0].eligible).toBe(false);
    expect(r.candidates[0].reasons.join()).toContain('gpu-role=inference');
  });

  it('空集群：fits=false、best=null、候选为空，但仍给出可读结论', () => {
    const r = planPlacement({ service: service(), nodes: [] });

    expect(r.fits).toBe(false);
    expect(r.best).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.plan).toEqual([]);
    expect(r.reasons.join('\n')).toContain('没有任何节点');
    expect(r.fragments).toHaveLength(1);
  });

  it('节点存在但没有加速卡：给出"没有可用加速卡"而不是静默 false', () => {
    const r = planPlacement({ service: service(), nodes: [node('cpu-only', [])] });

    expect(r.fits).toBe(false);
    expect(r.candidates[0].reasons.join()).toContain('没有可用加速卡');
  });
});

// ─── 脏数据 ──────────────────────────────────────────────────────────────

describe('allocations 脏数据', () => {
  it('未知设备 id：忽略并 warning，不影响真卡的剩余计算', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const allocations = [
      alloc('gpu-1', 'gpu0', 1000, 10),
      alloc('gpu-1', 'ghost0', 20000, 80), // 卡已换过，残留记录
    ];

    const r = planPlacement({ service: service(), nodes, allocations });

    expect(r.candidates[0].freeMemMiB).toBe(23564); // 只扣 1000
    expect(r.fits).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('ghost0');
    expect(r.warnings[0]).toContain('已忽略');
    expect(r.warnings[0]).toContain('gpu0');
    expect(r.reasons.join('\n')).toContain('数据异常');
  });

  it('未知节点 / 超额分配：都进 warnings，剩余按 0 计算而不是负数', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const allocations = [
      alloc('gpu-9', 'gpu0', 8000), // 节点不存在
      alloc('gpu-1', 'gpu0', 30000), // 超额
    ];

    const r = planPlacement({ service: service(), nodes, allocations });

    expect(r.candidates[0].freeMemMiB).toBe(0);
    expect(r.fits).toBe(false);
    expect(r.warnings.join('\n')).toContain('不存在的节点');
    expect(r.warnings.join('\n')).toContain('超额分配');
  });

  it('纯函数：不修改传入的 nodes / allocations / service', () => {
    const nodes = [node('gpu-1', [card('gpu0')])];
    const allocations = [alloc('gpu-1', 'gpu0', 16564, 50)];
    const svc = service({ replicas: 2 });
    const snapshot = JSON.stringify({ nodes, allocations, svc });

    planPlacement({ service: svc, nodes, allocations });

    expect(JSON.stringify({ nodes, allocations, svc })).toBe(snapshot);
  });
});

// ─── adapter 注入 ────────────────────────────────────────────────────────

describe('adapter 注入（A3 并行实现，这里全 mock）', () => {
  it('节点没带 devices 时用 adapter 读到容量，并确认被调用过', () => {
    const adapter = mockedAdapter(() => ({
      devices: [{ id: 'gpu0', type: RTX4090, totalMemMiB: 24564 }],
    }));
    const nodes = [{ name: 'gpu-1' }];

    const r = planPlacement({ service: service(), nodes, allocations: [], adapter });

    expect(adapter.readCapacity).toHaveBeenCalledTimes(1);
    expect(adapter.readCapacity).toHaveBeenCalledWith(nodes[0]);
    expect(r.fits).toBe(true);
    expect(r.candidates[0].devices[0]).toMatchObject({ id: 'gpu0', totalMemMiB: 24564, freeSlots: 10 });
  });

  it('adapter 抛错时回退到 node.devices 并记 warning', () => {
    const adapter = mockedAdapter(() => { throw new Error('annotation nvidia.com/gpumem 缺失'); });
    const nodes = [node('gpu-1', [card('gpu0')])];

    const r = planPlacement({ service: service(), nodes, adapter });

    expect(r.fits).toBe(true);
    expect(r.warnings[0]).toContain('回退');
    expect(r.warnings[0]).toContain('annotation');
  });

  it('adapter 是异步的：同步版给警告，planPlacementAsync 能正常判定', async () => {
    const adapter = mockedAdapter(async () => ({
      devices: [{ id: 'gpu0', type: RTX4090, totalMemMiB: 12288 }],
    }));
    const nodes = [{ name: 'gpu-1' }];

    const sync = planPlacement({ service: service(), nodes, adapter });
    expect(sync.fits).toBe(false); // 节点本身没带 devices，同步版读不到容量 → 放不下
    expect(sync.warnings.join('\n')).toContain('planPlacementAsync');

    const asyncResult = await planPlacementAsync({ service: service(), nodes, adapter });
    expect(asyncResult.fits).toBe(true);
    expect(asyncResult.candidates[0].devices[0]).toMatchObject({ id: 'gpu0', totalMemMiB: 12288 });
    expect(asyncResult.warnings).toEqual([]);
  });
});
