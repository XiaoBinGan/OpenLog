/**
 * server/infra/accelerator/* 单测（A3：加速卡抽象层）
 *
 * 覆盖点对应 /tmp/infra-contract.md 的 A3 契约：
 * - 探测：四家 detect（真有 / 没有 / 混合节点按 nvidia→amd→ascend→generic 取第一个）
 * - 容量：nvidia register JSON（真机 243 原文）、纯 device plugin 资源口径、坏 JSON 降级、
 *   amd / ascend / generic 的整卡计数
 * - 分配：nvidia 注解四段 / 三段 / 两段自适应、坏注解、资源口径回退、nodeName 三个来源；
 *   amd / ascend / generic 的整卡数
 * - 渲染：三家产物逐字段断言（值必须是字符串）、矛盾组合抛错、0 卡返回空片段
 * - 峰值：命中 / 未命中 / dtype 口径 / 非字符串输入
 * - 入口：getAdapter 认别名、未知厂商回落 generic 且不抛；renderAcceleratorResources 透传
 *
 * 断言用的都是**真实格式**的样本（真机 payload 见 /tmp/hami-real-format.md），不造理想格式。
 */
import { describe, it, expect } from 'vitest';
import {
  ADAPTERS,
  DETECT_ORDER,
  detectAccelerator,
  getAdapter,
  renderAcceleratorResources,
} from '../infra/accelerator/index.js';
import { readCapacity as nvidiaCapacity } from '../infra/accelerator/nvidia.js';
import {
  coerceAmount,
  coerceCount,
  emptyAllocation,
  emptyCapacity,
  invalid,
  nodeResource,
  nodeResourceKeys,
  podResources,
  readCount,
  readQuantity,
  spreadTotal,
  wholeCardDevices,
} from '../infra/accelerator/generic.js';

/** 真机（243）节点注解：两张卡，5090 32607 MiB / 4090 49140 MiB，各切 10 槽。 */
const REGISTER_243 = JSON.stringify([
  {
    id: 'GPU-6b12533d-bcfb-25b6-bafe-5a8d5bd85d07',
    index: 1,
    count: 10,
    devmem: 32607,
    devcore: 100,
    type: 'NVIDIA GeForce RTX 5090',
    mode: 'hami-core',
    health: true,
  },
  {
    id: 'GPU-86d14e75-1e54-3aed-e483-6652a4c30653',
    count: 10,
    devmem: 49140,
    devcore: 100,
    type: 'NVIDIA GeForce RTX 4090',
    mode: 'hami-core',
    health: true,
  },
]);

/** 真机（243）Pod 注解原文：四段 `<uuid>,<type>,<memMiB>,<cores>`。 */
const ALLOCATED_243 = 'GPU-86d14e75-1e54-3aed-e483-6652a4c30653,NVIDIA,5888,0:;';

/** 原始 k8s 形状的 NVIDIA 节点（capacity + allocatable + register 注解）。 */
function rawNvidiaNode(overrides = {}) {
  const resources = {
    cpu: '64',
    memory: '263168000Ki',
    pods: '110',
    'nvidia.com/gpu': '20',
  };
  return {
    metadata: {
      name: 'node1',
      labels: { 'nvidia.com/gpu.present': 'true', 'nvidia.com/gpu.product': 'NVIDIA-GeForce-RTX-4090' },
      annotations: { 'hami.io/node-nvidia-register': REGISTER_243 },
    },
    status: { capacity: { ...resources }, allocatable: { ...resources } },
    ...overrides,
  };
}

/** 归一化形状的节点（normalizeNodes 只带 name + allocatable）。 */
function normalizedNode(name, allocatable) {
  return { name, ready: true, roles: [], allocatable };
}

/** 原始 k8s 形状的 Pod。 */
function rawPod({ name = 'vllm-0', namespace = 'inference', nodeName = 'node1', annotations, limits, requests } = {}) {
  return {
    metadata: { name, namespace, annotations },
    spec: {
      nodeName,
      containers: [{ name: 'main', resources: { ...(limits ? { limits } : {}), ...(requests ? { requests } : {}) } }],
    },
    status: { phase: 'Running' },
  };
}

describe('getAdapter —— 厂商名归一化，任何输入都不抛', () => {
  it('四家规范名各自拿到自己的适配器', () => {
    expect(getAdapter('nvidia').vendor).toBe('nvidia');
    expect(getAdapter('amd').vendor).toBe('amd');
    expect(getAdapter('ascend').vendor).toBe('ascend');
    expect(getAdapter('generic').vendor).toBe('generic');
  });

  it('大小写与别名都能认（NVIDIA / rocm / huawei / nv）', () => {
    expect(getAdapter('NVIDIA').vendor).toBe('nvidia');
    expect(getAdapter(' rocm ').vendor).toBe('amd');
    expect(getAdapter('huawei').vendor).toBe('ascend');
    expect(getAdapter('nv').vendor).toBe('nvidia');
  });

  it('未知厂商回落 generic，且不抛异常', () => {
    for (const vendor of ['xxx', 'intel', '????', '', null, undefined, 42, {}, []]) {
      expect(() => getAdapter(vendor)).not.toThrow();
      expect(getAdapter(vendor).vendor).toBe('generic');
    }
  });

  it('四家适配器都实现了同一套接口（缺一个方法上层就会炸）', () => {
    const members = [
      'vendor',
      'capabilities',
      'detectFromNode',
      'readCapacity',
      'readAllocation',
      'renderResources',
      'probeCommand',
      'peakFlops',
    ];
    for (const vendor of DETECT_ORDER) {
      for (const member of members) expect(ADAPTERS[vendor]).toHaveProperty(member);
      expect(ADAPTERS[vendor].capabilities).toMatchObject({
        canShare: expect.any(Boolean),
        canLimitCores: expect.any(Boolean),
        memUnitMiB: expect.any(Number),
      });
    }
  });

  it('探测顺序固定：generic 一定在最后（它的证据最弱）', () => {
    expect(DETECT_ORDER).toEqual(['nvidia', 'amd', 'ascend', 'generic']);
  });
});

describe('detectAccelerator —— 真有 / 没有 / 混合', () => {
  it('NVIDIA：register 注解 + nvidia.com/gpu 都算', () => {
    expect(detectAccelerator(rawNvidiaNode())).toBe('nvidia');
    expect(detectAccelerator(normalizedNode('n1', { 'nvidia.com/gpu': '4' }))).toBe('nvidia');
    expect(detectAccelerator(normalizedNode('n1', { 'nvidia.com/gpumem': '24576' }))).toBe('nvidia');
  });

  it('NVIDIA：allocatable 全是 0 但注解/标签还在，仍然认得出（卡被分完的节点）', () => {
    expect(detectAccelerator(normalizedNode('n1', { 'nvidia.com/gpu': '0' }))).toBeNull();
    expect(detectAccelerator({
      name: 'n1',
      allocatable: { 'nvidia.com/gpu': '0' },
      annotations: { 'hami.io/node-nvidia-register': REGISTER_243 },
    })).toBe('nvidia');
    expect(detectAccelerator({
      metadata: { name: 'n1', labels: { 'nvidia.com/gpu.product': 'NVIDIA-A100-SXM4-80GB' } },
      status: { allocatable: {} },
    })).toBe('nvidia');
  });

  it('AMD：资源键与设备插件标签都算', () => {
    expect(detectAccelerator(normalizedNode('n2', { 'amd.com/gpu': '2' }))).toBe('amd');
    expect(detectAccelerator({
      metadata: { name: 'n2', labels: { 'amd.com/gpu.product': 'Instinct MI300X' } },
      status: { allocatable: {} },
    })).toBe('amd');
  });

  it('昇腾：整卡键与 -memory 键都算', () => {
    expect(detectAccelerator(normalizedNode('n3', { 'huawei.com/Ascend910': '2' }))).toBe('ascend');
    expect(detectAccelerator(normalizedNode('n3', { 'huawei.com/Ascend910-memory': '65536' }))).toBe('ascend');
    expect(detectAccelerator(normalizedNode('n3', { 'huawei.com/Ascend310P': '1' }))).toBe('ascend');
  });

  it('未知厂商：任意 *.com/gpu → generic', () => {
    expect(detectAccelerator(normalizedNode('n4', { 'example.com/gpu': '4' }))).toBe('generic');
  });

  it('混合节点按 nvidia → amd → ascend → generic 取第一个（顺序确定，不看键顺序）', () => {
    expect(detectAccelerator(normalizedNode('mix', {
      'amd.com/gpu': '1',
      'nvidia.com/gpu': '1',
    }))).toBe('nvidia');

    expect(detectAccelerator(normalizedNode('mix', {
      'huawei.com/Ascend910': '1',
      'amd.com/gpu': '1',
    }))).toBe('amd');

    expect(detectAccelerator(normalizedNode('mix', {
      'example.com/gpu': '1',
      'huawei.com/Ascend910': '1',
    }))).toBe('ascend');
  });

  it('没有卡的节点 / 空输入 / 垃圾输入 → null，且不抛', () => {
    expect(detectAccelerator(normalizedNode('cpu', { cpu: '32', memory: '131842000Ki' }))).toBeNull();
    expect(detectAccelerator({ metadata: { name: 'cpu' }, status: {} })).toBeNull();
    expect(detectAccelerator(normalizedNode('n', { 'nvidia.com/gpu': '0', 'amd.com/gpu': '0' }))).toBeNull();
    for (const bad of [null, undefined, 0, 'node', [], { allocatable: null }]) {
      expect(() => detectAccelerator(bad)).not.toThrow();
      expect(detectAccelerator(bad)).toBeNull();
    }
  });
});

describe('nvidia.readCapacity —— register 优先，资源口径兜底', () => {
  it('真机 register：两张物理卡、槽位 20、显存 81747、算力 200', () => {
    const capacity = nvidiaCapacity(rawNvidiaNode());
    expect(capacity.source).toBe('register');
    expect(capacity.canShare).toBe(true);
    expect(capacity.resourceKey).toBe('nvidia.com/gpu');
    expect(capacity.devices).toHaveLength(2);
    expect(capacity.devices[0]).toEqual({
      id: 'GPU-6b12533d-bcfb-25b6-bafe-5a8d5bd85d07',
      type: 'NVIDIA GeForce RTX 5090',
      memMiB: 32607,
      cores: 100,
      slots: 10,
      health: true,
    });
    expect(capacity.devices[1].type).toBe('NVIDIA GeForce RTX 4090');
    expect(capacity.totalMemMiB).toBe(32607 + 49140);
    expect(capacity.totalCores).toBe(200);
    expect(capacity.slots).toBe(20);
  });

  it('纯 device plugin（无注解，只有 nvidia.com/gpu|gpumem|gpucores）：按数量生成整卡记录并均摊', () => {
    const capacity = nvidiaCapacity(normalizedNode('n1', {
      'nvidia.com/gpu': '2',
      'nvidia.com/gpumem': '49152',
      'nvidia.com/gpucores': '200',
    }));
    expect(capacity.source).toBe('resource');
    expect(capacity.devices).toHaveLength(2);
    expect(capacity.devices.map((d) => d.id)).toEqual(['nvidia.com/gpu#0', 'nvidia.com/gpu#1']);
    expect(capacity.devices.map((d) => d.memMiB)).toEqual([24576, 24576]);
    expect(capacity.devices.map((d) => d.cores)).toEqual([100, 100]);
    expect(capacity.totalMemMiB).toBe(49152);
    expect(capacity.totalCores).toBe(200);
    expect(capacity.slots).toBe(2);
  });

  it('均摊的余数不能丢（3 张卡分 100 MiB → 34/33/33，Σ = 100）', () => {
    const capacity = nvidiaCapacity(normalizedNode('n1', {
      'nvidia.com/gpu': '3',
      'nvidia.com/gpumem': '100',
    }));
    expect(capacity.devices.map((d) => d.memMiB)).toEqual([34, 33, 33]);
    expect(capacity.devices.reduce((sum, d) => sum + d.memMiB, 0)).toBe(capacity.totalMemMiB);
  });

  it('只有 nvidia.com/gpu（纯 DRA/device plugin）：整卡、不能切分、显存未知记 0', () => {
    const capacity = nvidiaCapacity(normalizedNode('n1', { 'nvidia.com/gpu': '2' }));
    expect(capacity.devices).toHaveLength(2);
    expect(capacity.devices[0].memMiB).toBe(0);
    expect(capacity.devices[0].cores).toBe(0);
    expect(capacity.canShare).toBe(false);
    expect(capacity.slots).toBe(2);
  });

  it('register 是坏 JSON / 不是数组 → 降级到 nvidia.com/*，不抛', () => {
    for (const register of ['{not json', '{"a":1}', '"just a string"', '[1,2,3]', '[]']) {
      const node = normalizedNode('n1', { 'nvidia.com/gpu': '1' });
      node.annotations = { 'hami.io/node-nvidia-register': register };
      expect(() => nvidiaCapacity(node)).not.toThrow();
      const capacity = nvidiaCapacity(node);
      expect(capacity.source).toBe('resource');
      expect(capacity.devices).toHaveLength(1);
    }
  });

  it('register 里重复登记同一张卡只算一次，缺 id / 坏数字降级为 0', () => {
    const capacity = nvidiaCapacity({
      name: 'n1',
      allocatable: { 'nvidia.com/gpu': '3' },
      annotations: {
        'hami.io/node-nvidia-register': JSON.stringify([
          { id: 'GPU-a', devmem: 'abc', devcore: -1, count: 4, type: 'NVIDIA GeForce RTX 4090' },
          { id: 'GPU-a', devmem: 24000, devcore: 100, count: 4, type: '重复' },
          { devmem: 24000, devcore: 100, count: 4, type: '没 id' },
        ]),
      },
    });
    expect(capacity.devices).toHaveLength(1);
    expect(capacity.devices[0]).toMatchObject({ id: 'GPU-a', memMiB: 0, cores: 0, slots: 4 });
    expect(capacity.totalMemMiB).toBe(0);
    expect(capacity.totalCores).toBe(0);
  });

  it('没有 GPU 的节点 → 空容量（形状完整，上层不用判空）', () => {
    expect(nvidiaCapacity(normalizedNode('cpu', { cpu: '32' }))).toEqual({
      devices: [],
      totalMemMiB: 0,
      totalCores: 0,
      slots: 0,
      canShare: false,
      resourceKey: 'nvidia.com/gpu',
      source: 'none',
    });
    expect(nvidiaCapacity(null).source).toBe('none');
  });

  it('纯函数：两次调用互不影响（调用方 mutate 不污染下一次）', () => {
    const node = rawNvidiaNode();
    const first = nvidiaCapacity(node);
    const second = nvidiaCapacity(node);
    expect(second).toEqual(first);
    first.devices[0].memMiB = -1;
    expect(nvidiaCapacity(node).devices[0].memMiB).toBe(32607);
  });
});

describe('nvidia.readAllocation —— 注解四段/三段/两段自适应，资源口径兜底', () => {
  const nvidia = getAdapter('nvidia');

  it('真机四段原文：type 单独占一段，不能把 NVIDIA 当显存', () => {
    const allocation = nvidia.readAllocation(rawPod({
      annotations: { 'hami.io/vgpu-devices-allocated': ALLOCATED_243, 'hami.io/vgpu-node': 'node1' },
    }));
    expect(allocation.devices).toEqual([{
      id: 'GPU-86d14e75-1e54-3aed-e483-6652a4c30653',
      type: 'NVIDIA',
      memMiB: 5888,
      cores: 0,
    }]);
    expect(allocation.totalMemMiB).toBe(5888);
    expect(allocation.totalCores).toBe(0);
    expect(allocation.nodeName).toBe('node1');
    expect(allocation.source).toBe('annotation');
  });

  it('三段（老格式）+ 多卡 + 末尾空项：两卡求和', () => {
    const allocation = nvidia.readAllocation(rawPod({
      annotations: { 'hami.io/vgpu-devices-allocated': 'GPU-a,12288,40:;GPU-b,4096,10' },
    }));
    expect(allocation.devices).toHaveLength(2);
    expect(allocation.devices[0]).toEqual({ id: 'GPU-a', type: '', memMiB: 12288, cores: 40 });
    expect(allocation.devices[1]).toEqual({ id: 'GPU-b', type: '', memMiB: 4096, cores: 10 });
    expect(allocation.totalMemMiB).toBe(16384);
    expect(allocation.totalCores).toBe(50);
  });

  it('两段（只有型号）：数字记 0，不把型号当显存', () => {
    const allocation = nvidia.readAllocation(rawPod({
      annotations: { 'hami.io/vgpu-devices-allocated': 'GPU-x,NVIDIA' },
    }));
    expect(allocation.devices).toEqual([{ id: 'GPU-x', type: 'NVIDIA', memMiB: 0, cores: 0 }]);
    expect(allocation.totalMemMiB).toBe(0);
  });

  it('坏注解：仍标记 annotation（HAMi 在管这块卡），但没有可信数字', () => {
    const allocation = nvidia.readAllocation(rawPod({
      annotations: { 'hami.io/vgpu-devices-allocated': 'garbage' },
    }));
    expect(allocation.devices).toEqual([]);
    expect(allocation.totalMemMiB).toBe(0);
    expect(allocation.source).toBe('annotation');
  });

  it('没有注解（纯 device plugin）：按容器 resources 数整卡', () => {
    const allocation = nvidia.readAllocation(rawPod({
      limits: { 'nvidia.com/gpu': '1', 'nvidia.com/gpumem': '12288', 'nvidia.com/gpucores': '40' },
    }));
    expect(allocation.source).toBe('resource');
    expect(allocation.devices).toEqual([
      { id: 'nvidia.com/gpu#alloc-0', type: '', memMiB: 12288, cores: 40, slots: 1, health: true },
    ]);
    expect(allocation.totalMemMiB).toBe(12288);
    expect(allocation.totalCores).toBe(40);
    expect(allocation.nodeName).toBe('node1');
  });

  it('多容器求和（主容器 + sidecar 各占 1 卡）', () => {
    const pod = {
      metadata: { name: 'multi', namespace: 'inference' },
      spec: {
        nodeName: 'node1',
        containers: [
          { name: 'a', resources: { limits: { 'nvidia.com/gpu': '1' } } },
          { name: 'b', resources: { requests: { 'nvidia.com/gpu': '1' } } },
        ],
      },
    };
    const allocation = nvidia.readAllocation(pod);
    expect(allocation.devices).toHaveLength(2);
    expect(allocation.totalMemMiB).toBe(0);
  });

  it('nodeName 三个来源：vgpu-node 注解 > spec.nodeName > 老注解第一段', () => {
    expect(nvidia.readAllocation(rawPod({
      nodeName: 'from-spec',
      annotations: { 'hami.io/vgpu-node': 'from-annotation' },
    })).nodeName).toBe('from-annotation');

    expect(nvidia.readAllocation(rawPod({ nodeName: 'from-spec' })).nodeName).toBe('from-spec');

    expect(nvidia.readAllocation(rawPod({
      nodeName: '',
      annotations: { 'hami.io/vgpu-node-allocated': 'node1,0,NVIDIA' },
    })).nodeName).toBe('node1');
  });

  it('没调度的 Pod（Pending）→ nodeName 为 null，不伪造节点', () => {
    const allocation = nvidia.readAllocation({
      metadata: { name: 'pending', namespace: 'inference' },
      spec: { containers: [{ name: 'main', resources: { limits: { 'nvidia.com/gpu': '1' } } }] },
    });
    expect(allocation.nodeName).toBeNull();
    expect(allocation.devices).toHaveLength(1);
  });

  it('完全没占卡的 Pod → 空分配 + source none', () => {
    expect(nvidia.readAllocation(rawPod())).toMatchObject({
      devices: [],
      totalMemMiB: 0,
      totalCores: 0,
      source: 'none',
    });
    expect(nvidia.readAllocation(null).source).toBe('none');
  });
});

describe('nvidia.renderResources —— 值必须是字符串，整卡不写配额', () => {
  const nvidia = getAdapter('nvidia');

  it('整卡（memoryMiB=0）只写 nvidia.com/gpu', () => {
    const resources = nvidia.renderResources({ accelerators: 1, memoryMiB: 0, coresPercent: 0 });
    expect(resources).toEqual({ 'nvidia.com/gpu': '1' });
    expect(typeof resources['nvidia.com/gpu']).toBe('string');
  });

  it('显存配额：追加 nvidia.com/gpumem', () => {
    expect(nvidia.renderResources({ accelerators: 2, memoryMiB: 24576 })).toEqual({
      'nvidia.com/gpu': '2',
      'nvidia.com/gpumem': '24576',
    });
  });

  it('显存 + 算力：追加 nvidia.com/gpucores', () => {
    expect(nvidia.renderResources({ accelerators: 1, memoryMiB: 24576, coresPercent: 40 })).toEqual({
      'nvidia.com/gpu': '1',
      'nvidia.com/gpumem': '24576',
      'nvidia.com/gpucores': '40',
    });
  });

  it('字符串数字入参也接受（表单值就是字符串）', () => {
    expect(nvidia.renderResources({ accelerators: '1', memoryMiB: '2048', coresPercent: '30' })).toEqual({
      'nvidia.com/gpu': '1',
      'nvidia.com/gpumem': '2048',
      'nvidia.com/gpucores': '30',
    });
  });

  it('不申请加速卡（0）→ 空片段', () => {
    expect(nvidia.renderResources({ accelerators: 0 })).toEqual({});
    expect(nvidia.renderResources()).toEqual({});
  });

  it('反例：算力配额没配显存（整卡语义）→ 抛 ACCELERATOR_INVALID', () => {
    expect(() => nvidia.renderResources({ accelerators: 1, memoryMiB: 0, coresPercent: 40 }))
      .toThrow(/显存配额/);
    try {
      nvidia.renderResources({ accelerators: 1, coresPercent: 40 });
    } catch (error) {
      expect(error.code).toBe('ACCELERATOR_INVALID');
    }
  });

  it('反例：非法数字 / 负数 / 小数卡数 / 超 100% 算力 全部抛错', () => {
    expect(() => nvidia.renderResources({ accelerators: 'abc' })).toThrow(/必须是数字/);
    expect(() => nvidia.renderResources({ accelerators: -1 })).toThrow(/不能为负数/);
    expect(() => nvidia.renderResources({ accelerators: 1.5 })).toThrow(/必须是整数/);
    expect(() => nvidia.renderResources({ accelerators: 1, memoryMiB: 8, coresPercent: 150 }))
      .toThrow(/0-100/);
    expect(() => nvidia.renderResources({ accelerators: 0, memoryMiB: 8192 })).toThrow(/accelerators/);
  });
});

describe('amd —— 整卡计数，不支持切分', () => {
  const amd = getAdapter('amd');

  it('capabilities：不能切分、不能限算力、无显存单位', () => {
    expect(amd.capabilities).toEqual({
      canShare: false,
      canLimitCores: false,
      memUnitMiB: 0,
      wholeCardResource: 'amd.com/gpu',
    });
  });

  it('readCapacity：按 amd.com/gpu 计数，型号取节点标签，显存未知记 0', () => {
    const capacity = amd.readCapacity({
      metadata: { name: 'mi300', labels: { 'amd.com/gpu.product': 'Instinct MI300X' } },
      status: { allocatable: { 'amd.com/gpu': '2' } },
    });
    expect(capacity.source).toBe('resource');
    expect(capacity.resourceKey).toBe('amd.com/gpu');
    expect(capacity.canShare).toBe(false);
    expect(capacity.devices).toEqual([
      { id: 'amd.com/gpu#0', type: 'Instinct MI300X', memMiB: 0, cores: 100, slots: 1, health: true },
      { id: 'amd.com/gpu#1', type: 'Instinct MI300X', memMiB: 0, cores: 100, slots: 1, health: true },
    ]);
    expect(capacity.totalMemMiB).toBe(0);
    expect(capacity.totalCores).toBe(200);
    expect(capacity.slots).toBe(2);
  });

  it('readCapacity：没有 AMD 卡 → 空容量', () => {
    expect(amd.readCapacity(normalizedNode('n', { cpu: '8' }))).toMatchObject({
      devices: [],
      totalCores: 0,
      source: 'none',
    });
  });

  it('readAllocation：只认整卡占用（limits 里的数量）', () => {
    const allocation = amd.readAllocation(rawPod({ limits: { 'amd.com/gpu': '1' } }));
    expect(allocation.devices).toEqual([
      { id: 'amd.com/gpu#alloc-0', type: '', memMiB: 0, cores: 100, slots: 1, health: true },
    ]);
    expect(allocation.totalCores).toBe(100);
    expect(allocation.nodeName).toBe('node1');
    expect(allocation.source).toBe('resource');
    expect(amd.readAllocation(rawPod()).source).toBe('none');
  });

  it('renderResources：只写 amd.com/gpu，值是字符串', () => {
    expect(amd.renderResources({ accelerators: 2, memoryMiB: 0, coresPercent: 0 }))
      .toEqual({ 'amd.com/gpu': '2' });
    expect(amd.renderResources({ accelerators: 0 })).toEqual({});
  });

  it('反例：想要显存/算力切分 → 抛错并说清怎么改', () => {
    expect(() => amd.renderResources({ accelerators: 1, memoryMiB: 8192 })).toThrow(/整卡/);
    expect(() => amd.renderResources({ accelerators: 1, coresPercent: 50 })).toThrow(/整卡/);
  });

  it('probeCommand / peakFlops', () => {
    expect(amd.probeCommand()).toBe('rocm-smi');
    expect(amd.peakFlops('AMD Instinct MI300X', 'fp16')).toBe(1307);
    expect(amd.peakFlops('MI250X')).toBe(383);
    expect(amd.peakFlops('Instinct MI210')).toBe(181);
    expect(amd.peakFlops('MI100')).toBe(123);
    expect(amd.peakFlops('MI300A')).toBeNull();
    expect(amd.peakFlops('MI300X', 'fp8')).toBeNull();
    expect(amd.peakFlops(null)).toBeNull();
  });
});

describe('ascend —— 计数 + 可选 -memory 切分', () => {
  const ascend = getAdapter('ascend');

  it('capabilities：不下发算力配额', () => {
    expect(ascend.capabilities).toEqual({
      canShare: true,
      canLimitCores: false,
      memUnitMiB: 1,
      wholeCardResource: 'huawei.com/Ascend910',
    });
  });

  it('readCapacity：只有 Ascend910 → 整卡、canShare=false', () => {
    const capacity = ascend.readCapacity(normalizedNode('asc', { 'huawei.com/Ascend910': '2' }));
    expect(capacity.resourceKey).toBe('huawei.com/Ascend910');
    expect(capacity.canShare).toBe(false);
    expect(capacity.devices).toEqual([
      { id: 'huawei.com/Ascend910#0', type: 'Ascend910', memMiB: 0, cores: 100, slots: 1, health: true },
      { id: 'huawei.com/Ascend910#1', type: 'Ascend910', memMiB: 0, cores: 100, slots: 1, health: true },
    ]);
    expect(capacity.totalCores).toBe(200);
    expect(capacity.totalMemMiB).toBe(0);
  });

  it('readCapacity：带 Ascend910-memory → 能切分，显存均摊', () => {
    const capacity = ascend.readCapacity(normalizedNode('asc', {
      'huawei.com/Ascend910': '2',
      'huawei.com/Ascend910-memory': '65536',
    }));
    expect(capacity.canShare).toBe(true);
    expect(capacity.totalMemMiB).toBe(65536);
    expect(capacity.devices.map((d) => d.memMiB)).toEqual([32768, 32768]);
  });

  it('readCapacity：-memory / -cores 是配额键，不能当成卡数（否则卡数会被算多）', () => {
    const capacity = ascend.readCapacity(normalizedNode('asc', {
      'huawei.com/Ascend910': '2',
      'huawei.com/Ascend910-memory': '65536',
      'huawei.com/Ascend910-cores': '200',
    }));
    expect(capacity.devices).toHaveLength(2);
    expect(capacity.slots).toBe(2);
    expect(capacity.totalCores).toBe(200);
    expect(capacity.canShare).toBe(true);
  });

  it('readCapacity：Ascend310P 的键也能认，型号来自键名', () => {
    const capacity = ascend.readCapacity(normalizedNode('asc', { 'huawei.com/Ascend310P': '1' }));
    expect(capacity.resourceKey).toBe('huawei.com/Ascend310P');
    expect(capacity.devices[0].type).toBe('Ascend310P');
  });

  it('readCapacity：没有昇腾卡 → 空容量', () => {
    expect(ascend.readCapacity(normalizedNode('n', { 'nvidia.com/gpu': '1' }))).toMatchObject({
      devices: [],
      source: 'none',
    });
  });

  it('readAllocation：整卡 + 显存配额分别求和', () => {
    const allocation = ascend.readAllocation(rawPod({
      limits: { 'huawei.com/Ascend910': '1', 'huawei.com/Ascend910-memory': '32768' },
    }));
    expect(allocation.devices).toEqual([
      { id: 'huawei.com/Ascend910#alloc-0', type: '', memMiB: 32768, cores: 100, slots: 1, health: true },
    ]);
    expect(allocation.totalMemMiB).toBe(32768);
    expect(allocation.totalCores).toBe(100);
    expect(allocation.nodeName).toBe('node1');
  });

  it('readAllocation：显存/算力配额都以资源值为准，缺算力时按整卡 100 点', () => {
    const withCores = ascend.readAllocation(rawPod({
      limits: {
        'huawei.com/Ascend910': '1',
        'huawei.com/Ascend910-memory': '32768',
        'huawei.com/Ascend910-cores': '60',
      },
    }));
    expect(withCores.totalCores).toBe(60);
    expect(withCores.totalMemMiB).toBe(32768);

    const withoutCores = ascend.readAllocation(rawPod({ limits: { 'huawei.com/Ascend910': '2' } }));
    expect(withoutCores.totalCores).toBe(200);
  });

  it('renderResources：整卡只写 Ascend910；带显存再追加 -memory', () => {
    expect(ascend.renderResources({ accelerators: 1 })).toEqual({ 'huawei.com/Ascend910': '1' });
    expect(ascend.renderResources({ accelerators: 1, memoryMiB: 32768 })).toEqual({
      'huawei.com/Ascend910': '1',
      'huawei.com/Ascend910-memory': '32768',
    });
    expect(ascend.renderResources({ accelerators: 0 })).toEqual({});
  });

  it('反例：昇腾没有算力配额资源 → 抛错而不是静默丢字段', () => {
    expect(() => ascend.renderResources({ accelerators: 1, memoryMiB: 32768, coresPercent: 50 }))
      .toThrow(/算力配额/);
  });

  it('probeCommand / peakFlops', () => {
    expect(ascend.probeCommand()).toBe('npu-smi');
    expect(ascend.peakFlops('Ascend910B', 'fp16')).toBe(376);
    expect(ascend.peakFlops('ascend 310p')).toBe(70);
    expect(ascend.peakFlops('Ascend910')).toBeNull();
    expect(ascend.peakFlops('Ascend910B4')).toBeNull();
  });
});

describe('generic —— 兜底：只数整卡，不猜任何东西', () => {
  const generic = getAdapter('generic');

  it('capabilities 全 false，没有固定资源键', () => {
    expect(generic.capabilities).toEqual({
      canShare: false,
      canLimitCores: false,
      memUnitMiB: 0,
      wholeCardResource: null,
    });
  });

  it('detectFromNode：任意 *.com/gpu 或 gpu.present 标签', () => {
    expect(generic.detectFromNode(normalizedNode('n', { 'example.com/gpu': '4' }))).toBe(true);
    expect(generic.detectFromNode(normalizedNode('n', { 'nvidia.com/gpu': '1' }))).toBe(true);
    expect(generic.detectFromNode({
      metadata: { labels: { 'example.com/gpu.present': 'true' } },
      status: { allocatable: {} },
    })).toBe(true);
    expect(generic.detectFromNode(normalizedNode('n', { cpu: '8' }))).toBe(false);
    expect(generic.detectFromNode(null)).toBe(false);
  });

  it('readCapacity：只数张数，显存未知、算力按整卡 100 点', () => {
    const capacity = generic.readCapacity(normalizedNode('n', { 'example.com/gpu': '2' }));
    expect(capacity.resourceKey).toBe('example.com/gpu');
    expect(capacity.devices).toHaveLength(2);
    expect(capacity.devices[0]).toMatchObject({ id: 'example.com/gpu#0', memMiB: 0, cores: 100 });
    expect(capacity.totalCores).toBe(200);
    expect(capacity.totalMemMiB).toBe(0);
    expect(capacity.canShare).toBe(false);
  });

  it('readAllocation：只认整卡占用', () => {
    const allocation = generic.readAllocation({
      spec: { nodeName: 'node9', containers: [{ name: 'a', resources: { limits: { 'example.com/gpu': '1' } } }] },
    });
    expect(allocation.devices).toHaveLength(1);
    expect(allocation.devices[0].id).toBe('example.com/gpu#alloc-0');
    expect(allocation.nodeName).toBe('node9');
    expect(generic.readAllocation(null).source).toBe('none');
  });

  it('renderResources：必须显式给 resourceKey（否则 Pod 会不带 GPU 请求跑起来）', () => {
    expect(generic.renderResources({ accelerators: 2, resourceKey: 'example.com/gpu' }))
      .toEqual({ 'example.com/gpu': '2' });
    expect(() => generic.renderResources({ accelerators: 2 })).toThrow(/resourceKey/);
  });

  it('反例：兜底适配器不接受配额（它不知道单位）', () => {
    expect(() => generic.renderResources({ accelerators: 1, memoryMiB: 1024, resourceKey: 'x.com/gpu' }))
      .toThrow(/整卡/);
  });

  it('probeCommand 空串、peakFlops 恒 null', () => {
    expect(generic.probeCommand()).toBe('');
    expect(generic.peakFlops('NVIDIA GeForce RTX 4090')).toBeNull();
    expect(generic.peakFlops(undefined, undefined)).toBeNull();
  });
});

describe('peakFlops —— 查表命中/未命中（dtype 口径明确）', () => {
  const nvidia = getAdapter('nvidia');

  it('fp16 表：消费卡与数据中心卡都对得上', () => {
    const cases = [
      ['NVIDIA GeForce RTX 4090', 165.2],
      ['NVIDIA GeForce RTX 5090', 209.5],
      ['Tesla T4', 65],
      ['A100-SXM4-80GB', 312],
      ['NVIDIA H100 80GB HBM3', 989],
      ['L40S', 362],
      ['H20', 148],
      ['RTX A6000', 154.8],
      ['RTX A5000', 54.5],
      ['L4', 121],
      ['Tesla V100-SXM2-32GB', 125],
      ['RTX 3080', 59.5],
      ['RTX 3090', 71],
      ['RTX 4080', 97.5],
      ['RTX 5080', 112.6],
    ];
    for (const [name, expected] of cases) expect(nvidia.peakFlops(name, 'fp16')).toBe(expected);
  });

  it('bf16 与 fp16 同表；fp8 只对表里写了的型号有值', () => {
    expect(nvidia.peakFlops('RTX 4090', 'bf16')).toBe(165.2);
    expect(nvidia.peakFlops('RTX 4090', 'fp8')).toBe(330.3);
    expect(nvidia.peakFlops('A100', 'fp8')).toBeNull();
    expect(nvidia.peakFlops('RTX 4090')).toBe(165.2);
  });

  it('未收录的型号 / dtype / 输入一律 null（宁缺勿造）', () => {
    expect(nvidia.peakFlops('NVIDIA RTX 4090D')).toBeNull();
    expect(nvidia.peakFlops('RTX 5090 Laptop')).toBeNull();
    expect(nvidia.peakFlops('MI300X')).toBeNull();
    expect(nvidia.peakFlops('Ascend910B')).toBeNull();
    expect(nvidia.peakFlops('RTX 4090', 'fp32')).toBeNull();
    expect(nvidia.peakFlops('RTX 4090', 'int8')).toBeNull();
    expect(nvidia.peakFlops(4090)).toBeNull();
    expect(nvidia.peakFlops('')).toBeNull();
    expect(nvidia.peakFlops(null, 'fp16')).toBeNull();
  });
});

describe('renderAcceleratorResources —— 上层唯一入口', () => {
  it('按 vendor 分发，产物与直接调适配器一致', () => {
    expect(renderAcceleratorResources({ vendor: 'nvidia', accelerators: 1, memoryMiB: 24576, coresPercent: 40 }))
      .toEqual({ 'nvidia.com/gpu': '1', 'nvidia.com/gpumem': '24576', 'nvidia.com/gpucores': '40' });
    expect(renderAcceleratorResources({ vendor: 'amd', accelerators: 2 }))
      .toEqual({ 'amd.com/gpu': '2' });
    expect(renderAcceleratorResources({ vendor: 'ascend', accelerators: 1, memoryMiB: 32768 }))
      .toEqual({ 'huawei.com/Ascend910': '1', 'huawei.com/Ascend910-memory': '32768' });
  });

  it('厂商名走别名（AMD / rocm / huawei）', () => {
    expect(renderAcceleratorResources({ vendor: 'AMD', accelerators: 1 })).toEqual({ 'amd.com/gpu': '1' });
    expect(renderAcceleratorResources({ vendor: 'rocm', accelerators: 1 })).toEqual({ 'amd.com/gpu': '1' });
    expect(renderAcceleratorResources({ vendor: 'huawei', accelerators: 1 }))
      .toEqual({ 'huawei.com/Ascend910': '1' });
  });

  it('未知厂商：带 resourceKey 能渲染，不带则抛错', () => {
    expect(renderAcceleratorResources({ vendor: 'xxx', accelerators: 1, resourceKey: 'example.com/gpu' }))
      .toEqual({ 'example.com/gpu': '1' });
    expect(() => renderAcceleratorResources({ vendor: 'xxx', accelerators: 1 })).toThrow(/resourceKey/);
  });

  it('反例：完全没给厂商却要申请卡 → 抛「没有指定加速卡厂商」', () => {
    expect(() => renderAcceleratorResources({ accelerators: 1 })).toThrow(/没有指定加速卡厂商/);
    expect(() => renderAcceleratorResources({ vendor: null, accelerators: 2 })).toThrow(/没有指定加速卡厂商/);
  });

  it('0 卡对所有厂商都是空片段（上层不需要分支）', () => {
    for (const vendor of ['nvidia', 'amd', 'ascend', 'generic']) {
      expect(renderAcceleratorResources({ vendor, accelerators: 0 })).toEqual({});
    }
  });
});

describe('共享工具（generic.js）—— 数字口径与形状兜底', () => {
  it('readQuantity / readCount：坏值一律 0（NaN、负数、超上限、空串、对象）', () => {
    expect(readQuantity('4096')).toBe(4096);
    expect(readQuantity(4096)).toBe(4096);
    expect(readQuantity('abc')).toBe(0);
    expect(readQuantity(-1)).toBe(0);
    expect(readQuantity(1e10)).toBe(0);
    expect(readQuantity('')).toBe(0);
    expect(readQuantity(null)).toBe(0);
    expect(readQuantity({})).toBe(0);
    expect(readCount('12.9')).toBe(12);
    expect(readCount('-3')).toBe(0);
  });

  it('nodeResource：capacity 优先，缺了退 allocatable，都没有 from=none', () => {
    const node = { capacity: { 'amd.com/gpu': '4' }, allocatable: { 'amd.com/gpu': '2' } };
    expect(nodeResource(node, 'amd.com/gpu')).toEqual({ value: 4, from: 'capacity' });
    expect(nodeResource({ allocatable: { 'amd.com/gpu': '2' } }, 'amd.com/gpu'))
      .toEqual({ value: 2, from: 'allocatable' });
    expect(nodeResource({}, 'amd.com/gpu')).toEqual({ value: 0, from: 'none' });
    // 原始 k8s 形状
    expect(nodeResource({ status: { capacity: { 'nvidia.com/gpu': '8' } } }, 'nvidia.com/gpu').value).toBe(8);
  });

  it('nodeResourceKeys：capacity ∪ allocatable 去重，顺序稳定', () => {
    const keys = nodeResourceKeys({
      capacity: { cpu: '8', 'amd.com/gpu': '1' },
      allocatable: { 'amd.com/gpu': '1', 'example.com/gpu': '2' },
    });
    expect(keys).toEqual(['cpu', 'amd.com/gpu', 'example.com/gpu']);
    expect(nodeResourceKeys(null)).toEqual([]);
  });

  it('podResources：多容器求和、requests 优先于 limits、坏值 0', () => {
    const pod = {
      spec: {
        containers: [
          { resources: { requests: { 'nvidia.com/gpu': '1' }, limits: { 'nvidia.com/gpu': '4' } } },
          { resources: { limits: { 'nvidia.com/gpu': '2', 'nvidia.com/gpumem': 'oops' } } },
        ],
      },
    };
    expect(podResources(pod)).toEqual({ 'nvidia.com/gpu': 3, 'nvidia.com/gpumem': 0 });
  });

  it('podResources：简化 Pod（扁平 resources 映射）也认；嵌套对象不当数量', () => {
    expect(podResources({ resources: { 'amd.com/gpu': '4', requests: { 'amd.com/gpu': '1' } } }))
      .toEqual({ 'amd.com/gpu': 4 });
    expect(podResources(null)).toEqual({});
  });

  it('spreadTotal：整数均摊且 Σ 不变，0 张返回空数组', () => {
    expect(spreadTotal(10, 3)).toEqual([4, 3, 3]);
    expect(spreadTotal(0, 2)).toEqual([0, 0]);
    expect(spreadTotal(100, 0)).toEqual([]);
    expect(spreadTotal(-5, 2)).toEqual([0, 0]);
  });

  it('wholeCardDevices：0 张不产设备；id 前缀 + 序号，health 默认 true', () => {
    expect(wholeCardDevices({ count: 0, idPrefix: 'x#' })).toEqual([]);
    expect(wholeCardDevices({ count: 1, idPrefix: 'x#', slots: 0 })).toEqual([
      { id: 'x#0', type: '', memMiB: 0, cores: 0, slots: 0, health: true },
    ]);
  });

  it('emptyCapacity / emptyAllocation：形状完整（上层不必判空）', () => {
    expect(emptyCapacity()).toEqual({
      devices: [],
      totalMemMiB: 0,
      totalCores: 0,
      slots: 0,
      canShare: false,
      resourceKey: '',
      source: 'none',
    });
    expect(emptyAllocation()).toEqual({
      devices: [],
      totalMemMiB: 0,
      totalCores: 0,
      nodeName: null,
      source: 'none',
    });
  });

  it('coerceAmount / coerceCount / invalid：反例统一抛 ACCELERATOR_INVALID', () => {
    expect(coerceAmount('', 'x')).toBe(0);
    expect(coerceAmount('12', 'x')).toBe(12);
    for (const bad of ['abc', -1, 1e10]) {
      expect(() => coerceAmount(bad, 'memoryMiB')).toThrow(/memoryMiB/);
    }
    expect(() => coerceCount(1.5, 'accelerators')).toThrow(/整数/);
    const error = invalid('测试用错误');
    expect(error.code).toBe('ACCELERATOR_INVALID');
    expect(error.message).toBe('测试用错误');
  });
});

describe('跨厂商不变量 —— A4 要能用一个公式算容量', () => {
  const samples = {
    nvidia: [
      rawNvidiaNode(),
      rawPod({ annotations: { 'hami.io/vgpu-devices-allocated': ALLOCATED_243, 'hami.io/vgpu-node': 'node1' } }),
    ],
    amd: [
      { metadata: { name: 'mi', labels: {} }, status: { allocatable: { 'amd.com/gpu': '2' } } },
      rawPod({ limits: { 'amd.com/gpu': '1' } }),
    ],
    ascend: [
      normalizedNode('asc', { 'huawei.com/Ascend910': '2' }),
      rawPod({ limits: { 'huawei.com/Ascend910': '1' } }),
    ],
    generic: [
      normalizedNode('gen', { 'example.com/gpu': '2' }),
      rawPod({ limits: { 'example.com/gpu': '1' } }),
    ],
  };

  it('容量/分配的形状与数值口径四家一致（devices 数组、非负数字、总量 = Σ 设备）', () => {
    for (const [vendor, [node, pod]] of Object.entries(samples)) {
      const adapter = getAdapter(vendor);
      const capacity = adapter.readCapacity(node);
      const allocation = adapter.readAllocation(pod);

      expect(Array.isArray(capacity.devices)).toBe(true);
      expect(Array.isArray(allocation.devices)).toBe(true);
      expect(capacity.devices.length).toBeGreaterThan(0);
      expect(allocation.devices.length).toBeGreaterThan(0);
      expect(capacity.totalMemMiB).toBe(capacity.devices.reduce((sum, d) => sum + d.memMiB, 0));
      expect(capacity.totalCores).toBe(capacity.devices.reduce((sum, d) => sum + d.cores, 0));
      expect(allocation.totalMemMiB).toBe(allocation.devices.reduce((sum, d) => sum + d.memMiB, 0));
      expect(allocation.totalCores).toBe(allocation.devices.reduce((sum, d) => sum + d.cores, 0));
      for (const device of [...capacity.devices, ...allocation.devices]) {
        expect(Number.isFinite(device.memMiB)).toBe(true);
        expect(Number.isFinite(device.cores)).toBe(true);
        expect(device.memMiB).toBeGreaterThanOrEqual(0);
        expect(device.cores).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('整卡厂商：一张卡 = 100 算力点（容量与分配同一口径，才能相减）', () => {
    for (const vendor of ['amd', 'ascend', 'generic']) {
      const [node] = samples[vendor];
      const capacity = getAdapter(vendor).readCapacity(node);
      expect(capacity.totalCores).toBe(capacity.devices.length * 100);
    }
  });

  it('探测 → 适配器 → 渲染 一条链跑通（上层只调这两个入口）', () => {
    const node = normalizedNode('n1', { 'nvidia.com/gpu': '2', 'nvidia.com/gpumem': '49152' });
    const vendor = detectAccelerator(node);
    expect(vendor).toBe('nvidia');
    const adapter = getAdapter(vendor);
    expect(adapter.readCapacity(node).slots).toBe(2);
    expect(renderAcceleratorResources({ vendor, accelerators: 1, memoryMiB: 8192 }))
      .toEqual({ 'nvidia.com/gpu': '1', 'nvidia.com/gpumem': '8192' });
  });
});
