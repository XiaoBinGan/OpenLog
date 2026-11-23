/**
 * server/k8s/hami.js 单测（增量 ④ / H1）
 *
 * 覆盖点对应 /tmp/hami-contract.md：
 * - 节点：capacity 优先 / 退 allocatable / 全缺 → hasGpu=false、坏数字（非数、负数、>10^9）
 * - Pod：多版本注解形态（`;` / `:;` / 冒号分隔 / 带空格 / 末尾空项）、
 *   兜底注解 `vgpu-devices-assigned`、nodeName 两个来源
 * - 汇总：正常集群累计、无 HAMi 全空、只有节点、只有 Pod（数据不一致）、
 *   无 nodeName 归 null 不进节点、多设备只算 1 个 podCount、warnings 截断
 * - 纯函数：确定性、深拷贝（调用方 mutate 不污染）、非数组入参不抛异常
 * - 归一化层：normalizeNodes 带出 allocatable、normalizePods 带出 annotations（本文件断言）
 */
import { describe, it, expect } from 'vitest';
import { readNodeGpu, readPodVgpu, summarizeVgpu } from '../k8s/hami.js';
import { normalizeNodes, normalizePods } from '../k8s/resources.js';

/** HAMi 三件套资源名（测试里反复用到，收成一处置）。 */
const GPU = 'nvidia.com/gpu';
const GPUMEM = 'nvidia.com/gpumem';
const GPUCORES = 'nvidia.com/gpucores';

const DEVICES_ALLOCATED = 'hami.io/vgpu-devices-allocated';
const DEVICES_ASSIGNED = 'hami.io/vgpu-devices-assigned';
const NODE_ALLOCATED = 'hami.io/vgpu-node-allocated';

/** 4 卡 / 96 GiB / 400 算力点的节点（原始 k8s 形状，capacity 与 allocatable 都有）。 */
function gpuNode(name = 'node1', overrides = {}) {
  const resources = { [GPU]: '4', [GPUMEM]: '98304', [GPUCORES]: '400' };
  return {
    metadata: { name, labels: { 'node-role.kubernetes.io/worker': '' } },
    status: {
      capacity: { cpu: '32', memory: '131842000Ki', pods: '110', ...resources },
      allocatable: { cpu: '32', memory: '131842000Ki', pods: '110', ...resources },
    },
    ...overrides,
  };
}

/** 没有 HAMi 的普通节点。 */
function plainNode(name = 'plain-node') {
  return {
    metadata: { name },
    status: {
      capacity: { cpu: '8', memory: '16332160Ki', pods: '110' },
      allocatable: { cpu: '8', memory: '16332160Ki', pods: '110' },
    },
  };
}

/** 原始 k8s Pod 形状；annotations 传给 metadata.annotations。 */
function rawPod(name, annotations, nodeName = 'node1') {
  return {
    metadata: { name, namespace: 'inference', annotations },
    spec: { nodeName },
    status: { phase: 'Running' },
  };
}

/** 已归一化 Pod 形状（normalizePods 的输出）。 */
function normPod(name, annotations, node = 'node1') {
  return { namespace: 'inference', name, node, phase: 'Running', annotations };
}

describe('readNodeGpu', () => {
  it('capacity 优先：4 卡 / 98304 MiB / 400 算力', () => {
    expect(readNodeGpu(gpuNode())).toEqual({
      hasGpu: true,
      count: 4,
      memMiB: 98304,
      cores: 400,
      // 没有 hami.io/node-nvidia-register 注解 → 没有物理卡明细、没有槽位（未上报）
      slots: 0,
      source: 'capacity',
      devices: [],
    });
  });

  it('capacity 没有 GPU 字段时退 allocatable（归一化节点只有 allocatable）', () => {
    const normalized = normalizeNodes([gpuNode()])[0];

    expect(normalized.capacity).toBeUndefined();
    expect(readNodeGpu(normalized)).toMatchObject({
      hasGpu: true,
      count: 4,
      memMiB: 98304,
      cores: 400,
      source: 'allocatable',
    });
  });

  it('完全没有 GPU 字段 → hasGpu=false、source=none，不抛异常', () => {
    const empty = {
      hasGpu: false,
      count: 0,
      memMiB: 0,
      cores: 0,
      slots: 0,
      source: 'none',
      devices: [],
    };
    expect(readNodeGpu(plainNode())).toEqual(empty);
    expect(readNodeGpu({})).toEqual(empty);
    expect(readNodeGpu(null)).toEqual(empty);
    expect(readNodeGpu(undefined).hasGpu).toBe(false);
  });

  it('数字字段是字符串也要认（"4" / "98304" / "400"）', () => {
    const gpu = readNodeGpu({ name: 'n', allocatable: { [GPU]: '4', [GPUMEM]: '98304', [GPUCORES]: '400' } });
    expect(gpu.count).toBe(4);
    expect(gpu.memMiB).toBe(98304);
    expect(gpu.cores).toBe(400);
  });

  it('非数字 / 空串字段按 0，其余字段仍生效', () => {
    const gpu = readNodeGpu({ name: 'n', allocatable: { [GPU]: '2', [GPUMEM]: 'abc', [GPUCORES]: '' } });

    expect(gpu).toMatchObject({ hasGpu: true, count: 2, memMiB: 0, cores: 0 });
  });

  it('负数与超上限（>10^9）都按 0，且全部为 0 时 hasGpu=false', () => {
    const negative = readNodeGpu({
      name: 'n',
      allocatable: { [GPU]: '-1', [GPUMEM]: '-4096', [GPUCORES]: '-100' },
    });
    expect(negative).toMatchObject({ hasGpu: false, count: 0, memMiB: 0, cores: 0 });

    const oversized = readNodeGpu({
      name: 'n',
      allocatable: { [GPU]: '2000000000', [GPUMEM]: '1e12', [GPUCORES]: '400' },
    });
    expect(oversized).toMatchObject({ hasGpu: true, count: 0, memMiB: 0, cores: 400 });
  });

  it('只有 gpumem / gpucores、没有 gpu 计数的节点也算有 GPU 资源', () => {
    const gpu = readNodeGpu({ name: 'n', allocatable: { [GPUMEM]: '24576', [GPUCORES]: '100' } });

    expect(gpu).toMatchObject({ hasGpu: true, count: 0, memMiB: 24576, cores: 100 });
  });
});

describe('readPodVgpu', () => {
  it('返回契约签名（键与顺序固定，H2 可依赖）', () => {
    expect(Object.keys(readPodVgpu(rawPod('p', {})))).toEqual([
      'hasVgpu',
      'devices',
      'totalMemMiB',
      'totalCores',
      'nodeName',
      'raw',
    ]);
  });

  it('多设备 + `:;` 分隔 + 末尾空项', () => {
    const vgpu = readPodVgpu(
      rawPod('vllm', { [DEVICES_ALLOCATED]: 'GPU-3f2a-0001,12288,40:;GPU-9b1c-0002,4096,10:;' }),
    );

    expect(vgpu.hasVgpu).toBe(true);
    expect(vgpu.devices).toEqual([
      { id: 'GPU-3f2a-0001', memMiB: 12288, cores: 40 },
      { id: 'GPU-9b1c-0002', memMiB: 4096, cores: 10 },
    ]);
    expect(vgpu.totalMemMiB).toBe(16384);
    expect(vgpu.totalCores).toBe(50);
    expect(vgpu.nodeName).toBe('node1');
    expect(vgpu.raw).toBe('GPU-3f2a-0001,12288,40:;GPU-9b1c-0002,4096,10:;');
  });

  it('单设备 + `;` 分隔 + 末尾空项', () => {
    const vgpu = readPodVgpu(rawPod('sglang', { [DEVICES_ALLOCATED]: 'GPU-3f2a-0001,12288,40;' }));

    expect(vgpu.devices).toEqual([{ id: 'GPU-3f2a-0001', memMiB: 12288, cores: 40 }]);
    expect(vgpu.totalMemMiB).toBe(12288);
    expect(vgpu.totalCores).toBe(40);
  });

  it('HAMi 原生冒号分隔也要认', () => {
    const vgpu = readPodVgpu(
      rawPod('native', { [DEVICES_ALLOCATED]: 'GPU-a,4096,30:GPU-b,2048,20' }),
    );

    expect(vgpu.devices).toHaveLength(2);
    expect(vgpu.totalMemMiB).toBe(6144);
    expect(vgpu.totalCores).toBe(50);
  });

  it('注解里有空格（条目首尾、字段首尾、空项）都能解析', () => {
    const vgpu = readPodVgpu(
      rawPod('spaced', { [DEVICES_ALLOCATED]: '  GPU-a , 4096 , 20 ; ; GPU-b,1024,5  ' }),
    );

    expect(vgpu.devices).toEqual([
      { id: 'GPU-a', memMiB: 4096, cores: 20 },
      { id: 'GPU-b', memMiB: 1024, cores: 5 },
    ]);
  });

  it('allocated 缺失时退 vgpu-devices-assigned', () => {
    const vgpu = readPodVgpu(rawPod('fallback', { [DEVICES_ASSIGNED]: 'GPU-c,2048,10' }));

    expect(vgpu.hasVgpu).toBe(true);
    expect(vgpu.devices).toEqual([{ id: 'GPU-c', memMiB: 2048, cores: 10 }]);
  });

  it('allocated 是空串时落到 assigned（空串不等于“有注解”）', () => {
    const vgpu = readPodVgpu(
      rawPod('both', { [DEVICES_ALLOCATED]: '   ', [DEVICES_ASSIGNED]: 'GPU-c,2048,10' }),
    );

    expect(vgpu.hasVgpu).toBe(true);
    expect(vgpu.devices).toHaveLength(1);
  });

  it('无注解 / 空注解 → hasVgpu=false、空设备、raw=null、nodeName 仍取 Pod 自己的 node', () => {
    const bare = readPodVgpu(rawPod('idle', {}));
    expect(bare).toEqual({
      hasVgpu: false,
      devices: [],
      totalMemMiB: 0,
      totalCores: 0,
      nodeName: 'node1',
      raw: null,
    });

    const empty = readPodVgpu(rawPod('idle', { [DEVICES_ALLOCATED]: '' }));
    expect(empty.hasVgpu).toBe(false);
    expect(empty.raw).toBeNull();
  });

  it('nodeName 回退到 hami.io/vgpu-node-allocated 的第一段', () => {
    const vgpu = readPodVgpu({
      namespace: 'inference',
      name: 'pending',
      phase: 'Pending',
      node: '',
      annotations: { [DEVICES_ALLOCATED]: 'GPU-a,4096,30', [NODE_ALLOCATED]: 'node2,0,NVIDIA' },
    });

    expect(vgpu.nodeName).toBe('node2');
  });

  it('Pod 没有 nodeName 也没有 node-allocated 注解 → nodeName=null', () => {
    const vgpu = readPodVgpu(normPod('unknown-node', { [DEVICES_ALLOCATED]: 'GPU-a,4096,30' }, ''));

    expect(vgpu.nodeName).toBeNull();
    expect(vgpu.devices).toHaveLength(1);
  });

  it('坏注解 `garbage`：hasVgpu 仍为 true（注解存在），设备为空', () => {
    const vgpu = readPodVgpu(rawPod('bad', { [DEVICES_ALLOCATED]: 'garbage' }));

    expect(vgpu.hasVgpu).toBe(true);
    expect(vgpu.devices).toEqual([]);
    expect(vgpu.totalMemMiB).toBe(0);
    expect(vgpu.totalCores).toBe(0);
    expect(vgpu.raw).toBe('garbage');
  });

  it('显存字段非数字：设备保留、显存按 0、算力照常', () => {
    const vgpu = readPodVgpu(rawPod('half', { [DEVICES_ALLOCATED]: 'GPU-x,abc,10' }));

    expect(vgpu.devices).toEqual([{ id: 'GPU-x', memMiB: 0, cores: 10 }]);
    expect(vgpu.totalMemMiB).toBe(0);
    expect(vgpu.totalCores).toBe(10);
  });

  it('缺算力字段：设备保留、算力按 0', () => {
    const vgpu = readPodVgpu(rawPod('nocores', { [DEVICES_ALLOCATED]: 'GPU-y,4096' }));

    expect(vgpu.devices).toEqual([{ id: 'GPU-y', memMiB: 4096, cores: 0 }]);
  });

  it('负数与超大值都按 0，不抛异常', () => {
    const vgpu = readPodVgpu(
      rawPod('weird', { [DEVICES_ALLOCATED]: 'GPU-z,-4096,9999999999999' }),
    );

    expect(vgpu.devices).toEqual([{ id: 'GPU-z', memMiB: 0, cores: 0 }]);
    expect(vgpu.totalMemMiB).toBe(0);
    expect(vgpu.totalCores).toBe(0);
  });

  it('缺设备 ID 的记录跳过，合法记录照常', () => {
    const vgpu = readPodVgpu(rawPod('mixed', { [DEVICES_ALLOCATED]: ',4096,10;GPU-ok,1024,5' }));

    expect(vgpu.devices).toEqual([{ id: 'GPU-ok', memMiB: 1024, cores: 5 }]);
  });

  it('null / undefined / 非对象入参不抛异常', () => {
    for (const input of [null, undefined, 'oops', 42, []]) {
      expect(readPodVgpu(input)).toMatchObject({ hasVgpu: false, devices: [], nodeName: null });
    }
  });
});

describe('summarizeVgpu', () => {
  /** 正常集群：1 节点 4 卡 / 96 GiB / 400 算力，3 个 Pod 共 4 设备分配。 */
  function cluster() {
    const nodes = [gpuNode('node1')];
    const pods = [
      rawPod('vllm-qwen27b', { [DEVICES_ALLOCATED]: 'GPU-3f2a,12288,40:;GPU-9b1c,4096,10' }),
      rawPod('sglang-router', { [DEVICES_ALLOCATED]: 'GPU-3f2a,12288,40;' }),
      rawPod('bge-embed', { [DEVICES_ALLOCATED]: 'GPU-9b1c,8192,25' }),
    ];
    return { nodes, pods };
  }

  it('正常集群：节点容量 + 分配累计 + totals', () => {
    const gpu = summarizeVgpu(cluster());

    expect(gpu.hasHami).toBe(true);
    expect(gpu.nodes).toEqual([
      {
        name: 'node1',
        count: 4,
        memMiB: 98304,
        cores: 400,
        slots: 0, // 没有 register 注解 → 槽位未上报
        allocatedMemMiB: 36864, // 12288+4096 + 12288 + 8192
        allocatedCores: 115, // 40+10 + 40 + 25
        podCount: 3,
        // 没有物理卡清单，但 Pod 确实占了 3 个 UUID → 按 UUID 补出三行（容量 0）
        devices: [
          {
            id: 'GPU-3f2a',
            type: '',
            memMiB: 0,
            cores: 0,
            slots: 0,
            health: true,
            allocatedMemMiB: 24576, // 12288 + 12288
            allocatedCores: 80, // 40 + 40
            podCount: 2,
          },
          {
            id: 'GPU-9b1c',
            type: '',
            memMiB: 0,
            cores: 0,
            slots: 0,
            health: true,
            allocatedMemMiB: 12288, // 4096 + 8192
            allocatedCores: 35, // 10 + 25
            podCount: 2,
          },
        ],
      },
    ]);
    expect(gpu.pods.map((p) => p.name)).toEqual(['vllm-qwen27b', 'sglang-router', 'bge-embed']);
    expect(gpu.pods[0]).toEqual({
      namespace: 'inference',
      name: 'vllm-qwen27b',
      nodeName: 'node1',
      devices: [
        { id: 'GPU-3f2a', memMiB: 12288, cores: 40 },
        { id: 'GPU-9b1c', memMiB: 4096, cores: 10 },
      ],
      totalMemMiB: 16384,
      totalCores: 50,
      phase: 'Running',
    });
    expect(gpu.totals).toEqual({
      gpuCount: 4,
      physicalCount: 0, // 没有 register 注解算不出物理卡数
      slots: 0,
      memMiB: 98304,
      cores: 400,
      allocatedMemMiB: 36864,
      allocatedCores: 115,
      podCount: 3,
    });
    expect(gpu.warnings).toEqual([]);
  });

  it('无 HAMi 集群：hasHami=false、nodes/pods 空数组、totals 全 0', () => {
    const gpu = summarizeVgpu({
      nodes: [plainNode('a'), plainNode('b')],
      pods: [rawPod('web', {}, 'a'), rawPod('api', {}, 'b')],
    });

    expect(gpu.hasHami).toBe(false);
    expect(gpu.nodes).toEqual([]);
    expect(gpu.pods).toEqual([]);
    expect(gpu.totals).toEqual({
      gpuCount: 0,
      physicalCount: 0,
      slots: 0,
      memMiB: 0,
      cores: 0,
      allocatedMemMiB: 0,
      allocatedCores: 0,
      podCount: 0,
    });
    expect(gpu.warnings).toEqual([]);
  });

  it('只有节点有 GPU 资源、没有 Pod 分配：节点在、分配为 0', () => {
    const gpu = summarizeVgpu({ nodes: [gpuNode('node1')], pods: [] });

    expect(gpu.hasHami).toBe(true);
    expect(gpu.nodes).toHaveLength(1);
    expect(gpu.nodes[0]).toMatchObject({ allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 });
    expect(gpu.totals).toMatchObject({ gpuCount: 4, allocatedMemMiB: 0, podCount: 0 });
  });

  it('只有 Pod 有注解、没有节点资源（数据不一致）→ hasHami=true 但不造节点', () => {
    const gpu = summarizeVgpu({
      nodes: [plainNode('node1')],
      pods: [rawPod('orphan', { [DEVICES_ALLOCATED]: 'GPU-a,4096,30' })],
    });

    expect(gpu.hasHami).toBe(true);
    expect(gpu.nodes).toEqual([]); // 节点没有 GPU 资源就不出卡片
    expect(gpu.pods).toHaveLength(1);
    expect(gpu.pods[0].nodeName).toBe('node1');
    expect(gpu.totals).toMatchObject({ gpuCount: 0, allocatedMemMiB: 4096, podCount: 1 });
  });

  it('Pod 没有 nodeName：归到 null、不进节点累计，但计入 totals', () => {
    const gpu = summarizeVgpu({
      nodes: [gpuNode('node1')],
      pods: [
        { namespace: 'inference', name: 'dangling', phase: 'Pending', node: '', annotations: { [DEVICES_ALLOCATED]: 'GPU-a,2048,10' } },
      ],
    });

    expect(gpu.pods[0].nodeName).toBeNull();
    expect(gpu.nodes[0]).toMatchObject({ allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 });
    expect(gpu.totals).toMatchObject({ allocatedMemMiB: 2048, allocatedCores: 10, podCount: 1 });
  });

  it('多设备 Pod 只给节点 +1 个 podCount，显存算力按设备累加', () => {
    const gpu = summarizeVgpu({
      nodes: [gpuNode('node1')],
      pods: [rawPod('multi', { [DEVICES_ALLOCATED]: 'GPU-a,1024,5;GPU-b,2048,15;GPU-c,4096,25' })],
    });

    expect(gpu.nodes[0]).toMatchObject({ podCount: 1, allocatedMemMiB: 7168, allocatedCores: 45 });
    expect(gpu.totals).toMatchObject({ podCount: 1 });
  });

  it('坏注解进 warnings（去重后最多 5 条），且不参与累计', () => {
    const pods = [
      rawPod('bad-1', { [DEVICES_ALLOCATED]: 'garbage' }),
      rawPod('bad-2', { [DEVICES_ALLOCATED]: 'GPU-x,abc,10' }),
      rawPod('bad-3', { [DEVICES_ALLOCATED]: 'GPU-y,-5,-5' }),
      rawPod('bad-4', { [DEVICES_ALLOCATED]: 'GPU-z,99999999999,1' }),
      rawPod('bad-5', { [DEVICES_ALLOCATED]: ',,,' }),
      rawPod('bad-6', { [DEVICES_ALLOCATED]: 'only-id' }),
      rawPod('bad-7', { [DEVICES_ALLOCATED]: 'GPU-w,1024' }),
      rawPod('bad-8', { [DEVICES_ALLOCATED]: ';:;;' }),
    ];

    const gpu = summarizeVgpu({ nodes: [gpuNode('node1')], pods });

    expect(gpu.warnings.length).toBeGreaterThan(0);
    expect(gpu.warnings.length).toBeLessThanOrEqual(5);
    for (const warning of gpu.warnings) {
      expect(typeof warning).toBe('string');
      expect(warning.length).toBeGreaterThan(0);
    }
    expect(gpu.warnings.join('\n')).toContain(DEVICES_ALLOCATED);
    // bad-7 有可解析的显存，仍是合法设备；其余坏条目贡献 0
    expect(gpu.totals.allocatedMemMiB).toBe(1024);
    expect(gpu.totals.podCount).toBeGreaterThanOrEqual(1);
  });

  it('节点 GPU 字段写坏时也有 warning，不抛异常', () => {
    const broken = {
      metadata: { name: 'node-x' },
      status: {
        capacity: { [GPU]: '4', [GPUMEM]: 'lol' },
        allocatable: {},
      },
    };
    const gpu = summarizeVgpu({ nodes: [broken], pods: [] });

    expect(gpu.hasHami).toBe(true);
    expect(gpu.nodes[0]).toMatchObject({ count: 4, memMiB: 0, cores: 0 });
    expect(gpu.warnings.join('\n')).toContain(GPUMEM);
  });

  it('确定性 + 深拷贝：相同输入结果相同，调用方 mutate 不污染入参', () => {
    const input = cluster();
    const snapshot = structuredClone(input);

    const first = summarizeVgpu(input);
    const second = summarizeVgpu(input);
    expect(first).toEqual(second);

    first.nodes[0].allocatedMemMiB = 999999;
    first.nodes[0].name = 'mutated';
    first.pods[0].devices[0].memMiB = 999999;
    first.pods[0].nodeName = 'mutated';
    first.totals.memMiB = 1;
    first.warnings.push('injected');

    expect(input).toEqual(snapshot); // 入参一个字节都没动
    expect(summarizeVgpu(input)).toEqual(second); // 下一次调用不受影响
  });

  it('空输入 / 缺参 / 非数组都不抛异常', () => {
    const zero = {
      gpuCount: 0,
      physicalCount: 0,
      slots: 0,
      memMiB: 0,
      cores: 0,
      allocatedMemMiB: 0,
      allocatedCores: 0,
      podCount: 0,
    };

    for (const input of [undefined, {}, { nodes: [], pods: [] }, { nodes: null, pods: 'x' }, { nodes: { items: [] } }]) {
      const gpu = summarizeVgpu(input);
      expect(gpu.hasHami).toBe(false);
      expect(gpu.nodes).toEqual([]);
      expect(gpu.pods).toEqual([]);
      expect(gpu.totals).toEqual(zero);
    }
  });
});

describe('归一化层透传（resources.js）', () => {
  it('normalizeNodes 带出 allocatable，readNodeGpu 能直接吃归一化节点', () => {
    const [node] = normalizeNodes([gpuNode('node1')]);

    expect(node.allocatable).toEqual({
      cpu: '32',
      memory: '131842000Ki',
      pods: '110',
      [GPU]: '4',
      [GPUMEM]: '98304',
      [GPUCORES]: '400',
    });
    expect(readNodeGpu(node)).toMatchObject({ hasGpu: true, count: 4, memMiB: 98304, cores: 400 });
  });

  it('normalizeNodes 没有 allocatable 时给空对象（既有字段一个不少）', () => {
    const [node] = normalizeNodes([{ metadata: { name: 'bare' } }]);

    expect(node.allocatable).toEqual({});
    expect(node).toMatchObject({ name: 'bare', cpu: '', memory: '', pods: '', conditions: [] });
  });

  it('normalizePods 带出 annotations，readPodVgpu 能直接吃归一化 Pod', () => {
    const [pod] = normalizePods([
      rawPod('vllm', { [DEVICES_ALLOCATED]: 'GPU-3f2a,12288,40', [NODE_ALLOCATED]: 'node1,0,NVIDIA' }),
    ]);

    expect(pod.annotations).toEqual({
      [DEVICES_ALLOCATED]: 'GPU-3f2a,12288,40',
      [NODE_ALLOCATED]: 'node1,0,NVIDIA',
    });
    expect(pod.node).toBe('node1');
    expect(readPodVgpu(pod)).toMatchObject({
      hasVgpu: true,
      totalMemMiB: 12288,
      totalCores: 40,
      nodeName: 'node1',
    });
  });

  it('normalizePods 丢掉体积巨大的 last-applied-configuration，其余注解保留', () => {
    const [pod] = normalizePods([
      rawPod('applied', {
        'kubectl.kubernetes.io/last-applied-configuration': '{"kind":"Pod"}'.repeat(50),
        'example.com/owner': 'team-a',
      }),
    ]);

    expect(pod.annotations).toEqual({ 'example.com/owner': 'team-a' });
  });

  it('端到端：原始 k8s 对象 → 归一化 → summarizeVgpu 数字与直接解析一致', () => {
    const raw = {
      nodes: [gpuNode('node1')],
      pods: [
        rawPod('vllm-qwen27b', { [DEVICES_ALLOCATED]: 'GPU-3f2a,12288,40:;GPU-9b1c,4096,10' }),
        rawPod('sglang-router', { [DEVICES_ALLOCATED]: 'GPU-3f2a,12288,40;' }),
      ],
    };

    const gpu = summarizeVgpu({
      nodes: normalizeNodes(raw.nodes),
      pods: normalizePods(raw.pods),
    });

    expect(gpu.hasHami).toBe(true);
    expect(gpu.nodes[0]).toMatchObject({
      name: 'node1',
      count: 4,
      memMiB: 98304,
      cores: 400,
      allocatedMemMiB: 28672, // 16384 + 12288
      allocatedCores: 90, // 50 + 40
      podCount: 2,
    });
    expect(gpu.totals).toEqual({
      gpuCount: 4,
      physicalCount: 0,
      slots: 0,
      memMiB: 98304,
      cores: 400,
      allocatedMemMiB: 28672,
      allocatedCores: 90,
      podCount: 2,
    });
  });

  it('端到端：普通集群（无 HAMi）经归一化后仍然是 hasHami=false', () => {
    const gpu = summarizeVgpu({
      nodes: normalizeNodes([plainNode('a'), plainNode('b')]),
      pods: normalizePods([rawPod('web', { 'example.com/owner': 'team-a' }, 'a')]),
    });

    expect(gpu.hasHami).toBe(false);
    expect(gpu.nodes).toEqual([]);
    expect(gpu.pods).toEqual([]);
  });
});

/**
 * 真机格式（243：k3s v1.33.13 + HAMi）—— 全部断言内联真实 payload。
 *
 * 这一段存在的意义：解析层以前按「三段 `<uuid>,<mem>,<cores>`」假设写的，
 * 真机上是四段 `<uuid>,<type>,<mem>,<cores>`，于是 `NVIDIA` 被当成显存：
 * 显存显示 0、算力错位成 5888、还冒一条「显存不是数字」的误报警告。
 * 节点容量更是不在 `nvidia.com/gpumem|gpucores` 上（真机没有这两个字段），
 * 而在 `hami.io/node-nvidia-register` 的 JSON 里。契约见 /tmp/hami-real-format.md。
 */
describe('真机格式（243 实测 payload）', () => {
  const REGISTER = 'hami.io/node-nvidia-register';
  const NODE_NAME = 'hami.io/vgpu-node';

  /** 243 上真实的 4090 卡 UUID */
  const UUID_4090 = 'GPU-86d14e75-1e54-3aed-e483-6652a4c30653';
  /** 243 上真实的 5090 卡 UUID */
  const UUID_5090 = 'GPU-6b12533d-bcfb-25b6-bafe-5a8d5bd85d07';

  /** Pod 注解原文（243，逐字节） */
  const REAL_POD_ANNOTATION = 'GPU-86d14e75-1e54-3aed-e483-6652a4c30653,NVIDIA,5888,0:;';

  /** 节点 register 注解原文（243，逐字节；两个空格/换行都没有，方便比对） */
  const REAL_NODE_REGISTER = '[{"id":"GPU-6b12533d-bcfb-25b6-bafe-5a8d5bd85d07","index":1,"count":10,"devmem":32607,"devcore":100,"type":"NVIDIA GeForce RTX 5090","numa":1,"mode":"hami-core","health":true},{"id":"GPU-86d14e75-1e54-3aed-e483-6652a4c30653","count":10,"devmem":49140,"devcore":100,"type":"NVIDIA GeForce RTX 4090","mode":"hami-core","health":true}]';

  /** 243 的 GPU 节点：capacity 里只有 nvidia.com/gpu（= 槽位数 20），容量/型号全在 register 注解里。 */
  function realNode(overrides = {}) {
    const resources = { [GPU]: '20' };
    return {
      metadata: { name: 'k3s-gpu-1', annotations: { [REGISTER]: REAL_NODE_REGISTER } },
      status: {
        capacity: { cpu: '64', memory: '263000000Ki', pods: '110', ...resources },
        allocatable: { cpu: '64', memory: '263000000Ki', pods: '110', ...resources },
      },
      ...overrides,
    };
  }

  /** 243 的 Pod：注解是四段，节点名在 `hami.io/vgpu-node`。 */
  function realPod(name, annotation) {
    return {
      namespace: 'inference',
      name,
      phase: 'Running',
      node: 'k3s-gpu-1',
      annotations: { [DEVICES_ALLOCATED]: annotation, [NODE_NAME]: 'k3s-gpu-1' },
    };
  }

  describe('Pod 注解自适应（四段 / 三段 / 两段）', () => {
    it('四段原文：`GPU-86d1…,NVIDIA,5888,0` → type=NVIDIA、显存 5888、算力 0，且没有 warning', () => {
      const vgpu = readPodVgpu(realPod('qwen-vllm', REAL_POD_ANNOTATION));

      expect(vgpu.hasVgpu).toBe(true);
      expect(vgpu.devices).toEqual([{ id: UUID_4090, type: 'NVIDIA', memMiB: 5888, cores: 0 }]);
      expect(vgpu.totalMemMiB).toBe(5888);
      expect(vgpu.totalCores).toBe(0);
      expect(vgpu.nodeName).toBe('k3s-gpu-1');
      expect(vgpu.raw).toBe(REAL_POD_ANNOTATION);

      // 关键回归：以前这里会冒出「显存不是数字（"NVIDIA"）」+「算力 5888」
      expect(summarizeVgpu({ nodes: [], pods: [realPod('qwen-vllm', REAL_POD_ANNOTATION)] }).warnings)
        .toEqual([]);
    });

    it('四段多卡 + `:;` 分隔：每张卡各带自己的型号，不错位', () => {
      const vgpu = readPodVgpu(
        realPod('multi', `${UUID_5090},NVIDIA,1024,10:;${UUID_4090},NVIDIA,2048,20:;`),
      );

      expect(vgpu.devices).toEqual([
        { id: UUID_5090, type: 'NVIDIA', memMiB: 1024, cores: 10 },
        { id: UUID_4090, type: 'NVIDIA', memMiB: 2048, cores: 20 },
      ]);
      expect(vgpu.totalMemMiB).toBe(3072);
      expect(vgpu.totalCores).toBe(30);
    });

    it('四段但数字写坏：型号照旧识别，只有真正坏的数字按 0 + warning', () => {
      const vgpu = readPodVgpu(realPod('half', `${UUID_4090},NVIDIA,abc,10`));

      expect(vgpu.devices).toEqual([{ id: UUID_4090, type: 'NVIDIA', memMiB: 0, cores: 10 }]);
      expect(summarizeVgpu({ nodes: [], pods: [realPod('half', `${UUID_4090},NVIDIA,abc,10`)] }).warnings[0])
        .toContain('显存');
    });

    it('三段（老格式，第二段是数字）仍然正确：没有 type，不产生型号 field', () => {
      const vgpu = readPodVgpu(realPod('legacy', `${UUID_4090},12288,40:;`));

      expect(vgpu.devices).toEqual([{ id: UUID_4090, type: undefined, memMiB: 12288, cores: 40 }]);
      expect(vgpu.totalMemMiB).toBe(12288);
      expect(vgpu.totalCores).toBe(40);
      expect(summarizeVgpu({ nodes: [], pods: [realPod('legacy', `${UUID_4090},12288,40:;`)] }).warnings)
        .toEqual([]);
    });

    it('两段 `<uuid>,<type>`：只认型号，显存/算力 0，不报错', () => {
      const vgpu = readPodVgpu(realPod('type-only', `${UUID_4090},NVIDIA`));

      expect(vgpu.devices).toEqual([{ id: UUID_4090, type: 'NVIDIA', memMiB: 0, cores: 0 }]);
      expect(vgpu.totalMemMiB).toBe(0);
      expect(vgpu.totalCores).toBe(0);
      expect(summarizeVgpu({ nodes: [], pods: [realPod('type-only', `${UUID_4090},NVIDIA`)] }).warnings)
        .toEqual([]);
    });

    it('两段 `<uuid>,<mem>`（残缺记录）：显存仍按数字读，缺算力给一条 warning', () => {
      const vgpu = readPodVgpu(realPod('mem-only', `${UUID_4090},5888`));

      expect(vgpu.devices).toEqual([{ id: UUID_4090, type: undefined, memMiB: 5888, cores: 0 }]);
      expect(summarizeVgpu({ nodes: [], pods: [realPod('mem-only', `${UUID_4090},5888`)] }).warnings.join('\n'))
        .toContain('缺少算力字段');
    });

    it('三段 + 第二段是型号名：整体右移一位（`uuid,NVIDIA,5888`）', () => {
      const vgpu = readPodVgpu(realPod('shifted', `${UUID_4090},NVIDIA,5888`));

      expect(vgpu.devices).toEqual([{ id: UUID_4090, type: 'NVIDIA', memMiB: 5888, cores: 0 }]);
    });

    it('nodeName 优先 `hami.io/vgpu-node`（243 上只有这个，且比 vgpu-node-allocated 可信）', () => {
      const vgpu = readPodVgpu({
        namespace: 'inference',
        name: 'pending',
        phase: 'Pending',
        node: '',
        annotations: {
          [DEVICES_ALLOCATED]: REAL_POD_ANNOTATION,
          [NODE_NAME]: 'k3s-gpu-1',
          [NODE_ALLOCATED]: 'k3s-gpu-9,0,NVIDIA',
        },
      });

      expect(vgpu.nodeName).toBe('k3s-gpu-1');
    });
  });

  describe('节点 register 注解（物理卡清单 + 容量）', () => {
    it('register 原文：count=2 张物理卡 / 81747 MiB / 200 算力 / 20 槽位', () => {
      const gpu = readNodeGpu(realNode());

      expect(gpu).toMatchObject({
        hasGpu: true,
        count: 2,
        memMiB: 81747, // 32607 + 49140
        cores: 200, // 100 + 100
        slots: 20, // 10 + 10
        source: 'register',
      });
      // capacity 里的 nvidia.com/gpu 是 20（槽位数），不能被当成卡数
      expect(gpu.count).not.toBe(20);

      expect(gpu.devices).toEqual([
        {
          id: UUID_5090,
          type: 'NVIDIA GeForce RTX 5090',
          memMiB: 32607,
          cores: 100,
          slots: 10,
          health: true,
          index: 1,
        },
        {
          id: UUID_4090,
          type: 'NVIDIA GeForce RTX 4090',
          memMiB: 49140,
          cores: 100,
          slots: 10,
          health: true,
          index: null, // 真机上第二张卡没有 index 字段
        },
      ]);
    });

    it('归一化节点只带 annotations 也能读 register（不必是原始 k8s 对象）', () => {
      const node = {
        name: 'k3s-gpu-1',
        allocatable: { [GPU]: '20' },
        annotations: { [REGISTER]: REAL_NODE_REGISTER },
      };

      expect(readNodeGpu(node)).toMatchObject({
        count: 2,
        memMiB: 81747,
        cores: 200,
        slots: 20,
        source: 'register',
      });
    });

    it('没有 register、只有 nvidia.com/gpu:20 → devices 空、count=20、显存算力 0，不报错', () => {
      const node = {
        metadata: { name: 'plain-hami' },
        status: {
          capacity: { [GPU]: '20' },
          allocatable: { [GPU]: '20' },
        },
      };

      const gpu = readNodeGpu(node);
      expect(gpu).toMatchObject({
        hasGpu: true,
        count: 20,
        memMiB: 0,
        cores: 0,
        slots: 0,
        source: 'capacity',
      });
      expect(gpu.devices).toEqual([]);
      expect(summarizeVgpu({ nodes: [node], pods: [] }).warnings).toEqual([]);
    });

    it('坏 JSON：降级到 nvidia.com/*，只记一条 warning，不抛异常', () => {
      const node = {
        metadata: { name: 'broken-register', annotations: { [REGISTER]: '[{"id":' } },
        status: { capacity: { [GPU]: '4', [GPUMEM]: '98304' }, allocatable: {} },
      };

      expect(() => readNodeGpu(node)).not.toThrow();
      expect(readNodeGpu(node)).toMatchObject({
        hasGpu: true,
        count: 4,
        memMiB: 98304,
        cores: 0,
        slots: 0,
        source: 'capacity',
        devices: [],
      });

      const summary = summarizeVgpu({ nodes: [node], pods: [] });
      expect(summary.warnings).toHaveLength(1);
      expect(summary.warnings[0]).toContain(REGISTER);
      expect(summary.warnings[0]).toContain('不是合法 JSON');
    });

    it('register 不是 JSON 数组（对象/字符串）：同样降级 + 一条 warning', () => {
      for (const raw of ['{"id":"GPU-x"}', '"just-a-string"', '42']) {
        const node = {
          name: 'not-array',
          annotations: { [REGISTER]: raw },
          allocatable: { [GPU]: '1' },
        };

        expect(readNodeGpu(node)).toMatchObject({
          count: 1,
          source: 'allocatable',
          devices: [],
        });
        expect(summarizeVgpu({ nodes: [node], pods: [] }).warnings[0]).toContain('不是 JSON 数组');
      }
    });

    it('register 里有坏数字 / health:false：坏数字按 0 + warning，健康标记原样保留', () => {
      const register = '[{"id":"GPU-h1","count":10,"devmem":"abc","devcore":100,"type":"NVIDIA","health":false}]';
      const node = {
        metadata: { name: 'sick-gpu', annotations: { [REGISTER]: register } },
        status: { capacity: {}, allocatable: {} },
      };

      expect(readNodeGpu(node).devices[0]).toMatchObject({
        id: 'GPU-h1',
        type: 'NVIDIA',
        memMiB: 0,
        cores: 100,
        slots: 10,
        health: false,
      });
      expect(summarizeVgpu({ nodes: [node], pods: [] }).warnings.join('\n')).toContain('devmem');
    });

    it('register 同一张卡登记两遍：只认第一条（容量不许翻倍），并记一条 warning', () => {
      const card = `{"id":"${UUID_4090}","count":10,"devmem":49140,"devcore":100,"type":"NVIDIA GeForce RTX 4090","health":true}`;
      const node = {
        metadata: { name: 'dup-gpu', annotations: { [REGISTER]: `[${card},${card}]` } },
        status: { capacity: {}, allocatable: {} },
      };

      expect(readNodeGpu(node)).toMatchObject({
        count: 1,
        memMiB: 49140,
        cores: 100,
        slots: 10,
      });
      expect(summarizeVgpu({ nodes: [node], pods: [] }).warnings.join('\n')).toContain('重复登记');
    });
  });

  describe('真机集群汇总（按物理卡聚合）', () => {
    it('节点 + 两个 Pod：物理卡明细给出已分配与占卡 Pod 数，totals 带 physicalCount/slots', () => {
      const nodes = [realNode()];
      const pods = [
        realPod('qwen-vllm', REAL_POD_ANNOTATION), // 4090 上 5888 / 0
        realPod('bge-m3', `${UUID_4090},NVIDIA,23552,50:;`), // 4090 上 23552 / 50
      ];

      const gpu = summarizeVgpu({ nodes, pods });

      expect(gpu.hasHami).toBe(true);
      expect(gpu.nodes).toEqual([
        {
          name: 'k3s-gpu-1',
          count: 2,
          memMiB: 81747,
          cores: 200,
          slots: 20,
          allocatedMemMiB: 29440, // 5888 + 23552
          allocatedCores: 50, // 0 + 50
          podCount: 2,
          devices: [
            {
              id: UUID_5090,
              type: 'NVIDIA GeForce RTX 5090',
              memMiB: 32607,
              cores: 100,
              slots: 10,
              health: true,
              allocatedMemMiB: 0,
              allocatedCores: 0,
              podCount: 0,
            },
            {
              id: UUID_4090,
              type: 'NVIDIA GeForce RTX 4090',
              memMiB: 49140,
              cores: 100,
              slots: 10,
              health: true,
              allocatedMemMiB: 29440,
              allocatedCores: 50,
              podCount: 2,
            },
          ],
        },
      ]);

      expect(gpu.totals).toEqual({
        gpuCount: 2,
        physicalCount: 2,
        slots: 20,
        memMiB: 81747,
        cores: 200,
        allocatedMemMiB: 29440,
        allocatedCores: 50,
        podCount: 2,
      });
      expect(gpu.warnings).toEqual([]);
    });

    it('Pod 占了 register 里没有的 UUID：追加一行（容量 0、型号用 Pod 的），占用不丢', () => {
      const stray = 'GPU-ffffffff-0000-0000-0000-000000000000';
      const gpu = summarizeVgpu({
        nodes: [realNode()],
        pods: [realPod('stray', `${stray},NVIDIA,4096,10:;`)],
      });

      const devices = gpu.nodes[0].devices;
      expect(devices).toHaveLength(3);
      expect(devices[2]).toMatchObject({
        id: stray,
        type: 'NVIDIA',
        memMiB: 0,
        cores: 0,
        slots: 0,
        health: true,
        allocatedMemMiB: 4096,
        allocatedCores: 10,
        podCount: 1,
      });
      // 节点级累计与物理卡明细对得上
      expect(gpu.nodes[0].allocatedMemMiB).toBe(4096);
      expect(gpu.totals).toMatchObject({ allocatedMemMiB: 4096, allocatedCores: 10, podCount: 1 });
    });

    it('register 的型号优先于 Pod 注解里的厂商名（4090 不会被写成 NVIDIA）', () => {
      const gpu = summarizeVgpu({
        nodes: [realNode()],
        pods: [realPod('qwen-vllm', REAL_POD_ANNOTATION)],
      });

      expect(gpu.nodes[0].devices[1].type).toBe('NVIDIA GeForce RTX 4090');
    });

    it('归一化链路：normalizePods 透传真机四段注解，解析结果与原始对象一致', () => {
      const [pod] = normalizePods([
        {
          metadata: {
            name: 'qwen-vllm',
            namespace: 'inference',
            annotations: { [DEVICES_ALLOCATED]: REAL_POD_ANNOTATION, [NODE_NAME]: 'k3s-gpu-1' },
          },
          spec: { nodeName: 'k3s-gpu-1' },
          status: { phase: 'Running' },
        },
      ]);

      expect(readPodVgpu(pod)).toEqual({
        hasVgpu: true,
        devices: [{ id: UUID_4090, type: 'NVIDIA', memMiB: 5888, cores: 0 }],
        totalMemMiB: 5888,
        totalCores: 0,
        nodeName: 'k3s-gpu-1',
        raw: REAL_POD_ANNOTATION,
      });
    });

    it('归一化节点默认不带 annotations：register 读不到，于是退回 nvidia.com/gpu（路由层需补注解）', () => {
      const [node] = normalizeNodes([realNode()]);

      expect(node.annotations).toBeUndefined();
      expect(readNodeGpu(node)).toMatchObject({
        count: 20,
        memMiB: 0,
        cores: 0,
        slots: 0,
        devices: [],
        source: 'allocatable',
      });
    });
  });
});
