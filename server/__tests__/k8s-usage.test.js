/**
 * routes/k8s-usage.js 测试（契约见 /tmp/hami-k8s-contract.md）
 *
 * 只 mock 三类「不属于本层」的依赖：
 *   store / kubeconfig / client —— settings 与 apiserver 的边界
 *   hami-metrics（A1）          —— 并行实现中，签名见契约，这里按契约造数据
 *
 * `resources.js`（归一化）与 `hami.js`（vGPU 解析）**用真实实现**：
 * 本路由的合并逻辑高度依赖它们产出的形状（register 注解 → 物理卡、Pod 四段注解 → 分配），
 * 把它们也 mock 掉就等于只测自己的 if 语句，真机上的形状差异一个都测不出来。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

// ── 共享可变状态（vi.mock 工厂会被提升，不能引用普通模块级变量）──────────
const h = vi.hoisted(() => ({
  settings: { k8sClusters: [] },
  nodesResponse: null,
  podsResponse: null,
  failNodes: false,
  failPods: false,
  metrics: { available: true, scrapedAt: '', devices: [] },
  metricsThrows: false,
  storeCalls: [],
  getJsonCalls: [],
  clientCalls: 0,
  metricsCalls: [],
}));

// ── 模块替换 ─────────────────────────────────────────────────────

vi.mock('../k8s/store.js', () => ({
  getClusterRecord: vi.fn((settings, id) => {
    h.storeCalls.push(id);
    const list = Array.isArray(settings?.k8sClusters) ? settings.k8sClusters : [];
    return list.find((record) => record.id === id) || null;
  }),
  // 指标层只该看到脱敏视图：这里刻意把 kubeconfig 留在视图之外
  toView: vi.fn((record) => ({
    id: record.id,
    name: record.name,
    context: record.context || '',
    server: record.server || '',
    enabled: record.enabled !== false,
    authType: 'cert',
    hasKubeconfig: Boolean(record.kubeconfig),
  })),
}));

vi.mock('../k8s/kubeconfig.js', () => ({
  parseKubeconfig: vi.fn((text) => {
    if (typeof text !== 'string' || !text.includes('server')) {
      throw new Error('文件里缺少 server 字段');
    }
    return {
      server: 'https://127.0.0.1:6443',
      namespace: 'default',
      authType: 'token',
      token: 'TOKEN-VALUE',
      insecureSkipTlsVerify: false,
      contextName: 'default',
    };
  }),
}));

vi.mock('../k8s/client.js', () => ({
  createK8sClient: vi.fn(() => {
    h.clientCalls += 1;
    return {
      request: vi.fn(),
      getText: vi.fn(),
      getJson: vi.fn(async (path) => {
        h.getJsonCalls.push(path);
        if (path === '/api/v1/nodes') {
          if (h.failNodes) throw new Error('dial tcp 127.0.0.1:6443: connect: connection refused');
          return h.nodesResponse;
        }
        if (path === '/api/v1/pods') {
          if (h.failPods) throw new Error('context deadline exceeded');
          return h.podsResponse;
        }
        throw new Error(`未预期的请求路径: ${path}`);
      }),
    };
  }),
}));

// A1 的模块此刻可能还没落盘 —— vitest 对不存在的路径也能挂 mock，这里按契约给假实现
vi.mock('../k8s/hami-metrics.js', () => ({
  fetchSchedulerMetrics: vi.fn(async (input) => {
    h.metricsCalls.push(input);
    if (h.metricsThrows) throw new Error('Prometheus 查询超时（10s）');
    return h.metrics;
  }),
  parseSchedulerMetrics: vi.fn(() => ({})),
}));

import { createK8sUsageRouter } from '../routes/k8s-usage.js';

// ── 测试夹具：真机 243 的注解形状 ────────────────────────────────
// 节点物理卡清单在注解 hami.io/node-nvidia-register（JSON 数组）里；
// Pod 的分配在注解 hami.io/vgpu-devices-allocated（四段：uuid,type,mem,cores）。

function register(items) {
  return JSON.stringify(items.map(([id, type, devmem, count], index) => ({
    id,
    type,
    devmem,
    devcore: 100,
    count,
    index,
    health: true,
  })));
}

function nodeItem(name, hami) {
  return {
    metadata: {
      name,
      labels: { 'kubernetes.io/role': 'node' },
      creationTimestamp: '2026-11-01T00:00:00Z',
      ...(hami ? { annotations: { 'hami.io/node-nvidia-register': hami } } : {}),
    },
    status: {
      capacity: { cpu: '32', memory: '131072000Ki', pods: '110' },
      allocatable: { cpu: '32', memory: '131072000Ki', pods: '110', 'nvidia.com/gpu': '2' },
      nodeInfo: { kubeletVersion: 'v1.33.13+k3s1', architecture: 'arm64' },
      addresses: [{ type: 'InternalIP', address: '10.0.0.11' }],
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  };
}

function podItem(namespace, name, node, allocations) {
  const devices = allocations.map(([uuid, type, mem, cores]) => `${uuid},${type},${mem},${cores}`).join(':;');
  return {
    metadata: {
      namespace,
      name,
      creationTimestamp: '2026-11-20T00:00:00Z',
      annotations: {
        'hami.io/vgpu-devices-allocated': `${devices}:;`,
        'hami.io/vgpu-node': node,
      },
    },
    spec: { nodeName: node, containers: [{ name: 'main' }] },
    status: { phase: 'Running', podIP: '10.244.0.7' },
  };
}

/** 一张 RTX 4090（24576MiB / 100 核）+ 一张 RTX 5090（32768MiB / 100 核）的节点 */
const NODE_A = nodeItem('node-a', register([
  ['GPU-4090-0001', 'NVIDIA GeForce RTX 4090', 24576, 4],
  ['GPU-5090-0002', 'NVIDIA GeForce RTX 5090', 32768, 6],
]));

const GIB = 1024 * 1024 * 1024;

function metricsOf(devices, extra = {}) {
  return { available: true, scrapedAt: '2026-11-24T01:30:00.000Z', devices, ...extra };
}

// ── 服务端 ───────────────────────────────────────────────────────

let server = null;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(createK8sUsageRouter({ ensureSettings: () => h.settings }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  delete process.env.OPENLOG_DEMO;
  h.settings = {
    k8sClusters: [
      { id: 'c-243', name: '243', context: '', enabled: true, kubeconfig: 'server: https://127.0.0.1:6443' },
    ],
  };
  h.nodesResponse = { items: [NODE_A] };
  h.podsResponse = { items: [] };
  h.failNodes = false;
  h.failPods = false;
  h.metrics = metricsOf([]);
  h.metricsThrows = false;
  h.storeCalls = [];
  h.getJsonCalls = [];
  h.clientCalls = 0;
  h.metricsCalls = [];
});

/** 发一个 GET，返回 { status, body, headers } */
async function get(path) {
  const res = await fetch(`${base}${path}`);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

// ── 用例 ─────────────────────────────────────────────────────────

describe('GET /api/k8s/clusters/:id/usage —— 分配 + 实测合并', () => {
  it('正常合并：每节点每物理卡返回分配、实测与 Pod 明细', async () => {
    h.podsResponse = {
      items: [podItem('default', 'web-0', 'node-a', [['GPU-4090-0001', 'NVIDIA', 5888, 30]])],
    };
    // A1 真机形状：deviceUUID + node + containerUtil(0..1 比例) + utilPercent(=比例×100)
    h.metrics = metricsOf([
      { deviceUUID: 'GPU-4090-0001', node: 'node-a', container: 'main', containerUtil: 0.42, utilPercent: 42, memUsedBytes: 3 * GIB },
      { deviceUUID: 'GPU-5090-0002', node: 'node-a', container: 'main', containerUtil: 0.125, utilPercent: 12.5, memUsedBytes: GIB },
    ]);

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.scrapedAt).toBe('2026-11-24T01:30:00.000Z');
    expect(body.reason).toBeUndefined();
    expect(body.nodes).toHaveLength(1);

    const [node] = body.nodes;
    expect(node.name).toBe('node-a');
    expect(node.devices).toHaveLength(2);

    expect(node.devices[0]).toMatchObject({
      uuid: 'GPU-4090-0001',
      type: 'NVIDIA GeForce RTX 4090',
      allocMemMiB: 5888,
      allocCores: 30,
      usedMemMiB: 3072,
      utilPercent: 42,
      measured: true,
      pods: [{ ns: 'default', name: 'web-0', memMiB: 5888, cores: 30 }],
    });
    // 面板要算「已分配/总量」，容量必须下发（A5 的 GpuUsagePanel 依赖它）
    expect(node.devices[0].totalMemMiB).toBeGreaterThan(0);

    // 没有 Pod 占用的卡：分配为 0，但实测照常返回
    expect(node.devices[1]).toMatchObject({
      uuid: 'GPU-5090-0002',
      type: 'NVIDIA GeForce RTX 5090',
      allocMemMiB: 0,
      allocCores: 0,
      usedMemMiB: 1024,
      utilPercent: 12.5,
      measured: true,
      pods: [],
    });
  });

  it('多 Pod 同卡：分配求和、每 Pod 一行明细、util 求和后 clamp 到 100', async () => {
    h.podsResponse = {
      items: [
        podItem('team-a', 'train-0', 'node-a', [['GPU-4090-0001', 'NVIDIA', 5888, 30]]),
        podItem('team-b', 'infer-1', 'node-a', [['GPU-4090-0001', 'NVIDIA', 4096, 20]]),
      ],
    };
    // 同一张卡上多个容器的利用率各自上报 → 求和 70 + 55 = 125 → clamp 100
    h.metrics = metricsOf([
      { deviceUUID: 'GPU-4090-0001', node: 'node-a', container: 'main', containerUtil: 0.7, utilPercent: 70, memUsedBytes: 8 * GIB },
      { deviceUUID: 'GPU-4090-0001', node: 'node-a', container: 'sidecar', containerUtil: 0.55, utilPercent: 55, memUsedBytes: 6 * GIB },
    ]);

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    const card = body.nodes[0].devices[0];
    expect(card.allocMemMiB).toBe(5888 + 4096);
    expect(card.allocCores).toBe(50);
    // util：两张多多上报的条目求和后被 clamp，不能出现 125
    expect(card.utilPercent).toBe(100);
    // memUsedBytes 是设备级指标，同一 UUID 多条时取最大值而不是求和（8GiB > 6GiB）
    expect(card.usedMemMiB).toBe(8 * 1024);

    // Pod 明细按 namespace/name 排序，两条都在
    expect(card.pods).toEqual([
      { ns: 'team-a', name: 'train-0', memMiB: 5888, cores: 30 },
      { ns: 'team-b', name: 'infer-1', memMiB: 4096, cores: 20 },
    ]);
  });

  it('metrics 不可用：available:false + reason，分配数据照常返回', async () => {
    h.podsResponse = {
      items: [podItem('default', 'web-0', 'node-a', [['GPU-4090-0001', 'NVIDIA', 5888, 30]])],
    };
    h.metrics = {
      available: false,
      scrapedAt: '',
      devices: [],
      reason: '集群未部署 hami-scheduler 指标采集（ServiceMonitor 缺失）',
    };

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.reason).toBe('集群未部署 hami-scheduler 指标采集（ServiceMonitor 缺失）');
    // 分配字段完全保留 —— 面板要能显示「谁占了卡」，只是没有实测曲线
    const card = body.nodes[0].devices[0];
    expect(card.allocMemMiB).toBe(5888);
    expect(card.allocCores).toBe(30);
    expect(card.pods).toHaveLength(1);
    // 实测字段归零并标记「未测到」
    expect(card.usedMemMiB).toBe(0);
    expect(card.utilPercent).toBe(0);
    expect(card.measured).toBe(false);
    // 上游没给 scrapedAt 也要有一个合法时间戳（前端按它显示「采集于」）
    expect(Number.isNaN(Date.parse(body.scrapedAt))).toBe(false);
  });

  it('指标层抛错：不返回 5xx，折成 available:false + 中文原因', async () => {
    h.metricsThrows = true;

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.reason).toContain('HAMi 指标抓取失败');
    expect(body.reason).toContain('Prometheus 查询超时');
    expect(body.nodes).toHaveLength(1);
  });

  it('指标字段缺失：available 为 true 但 devices 缺失时不崩，全部标未测到', async () => {
    h.metrics = { available: true };

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.reason).toBeUndefined();
    for (const card of body.nodes[0].devices) {
      expect(card.measured).toBe(false);
      expect(card.utilPercent).toBe(0);
    }
  });

  it('指标返回非对象（null）：折成不可用而不是抛 TypeError', async () => {
    h.metrics = null;

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.reason).toBe('HAMi 指标不可用');
    expect(body.nodes).toHaveLength(1);
  });

  it('设备无实测：只有部分卡有指标时，另一张卡 measured:false 且分配保留', async () => {
    h.podsResponse = {
      items: [
        podItem('default', 'web-0', 'node-a', [['GPU-4090-0001', 'NVIDIA', 5888, 30]]),
        podItem('default', 'web-1', 'node-a', [['GPU-5090-0002', 'NVIDIA', 2048, 10]]),
      ],
    };
    // 只上报了 4090 那张卡
    h.metrics = metricsOf([
      { deviceUUID: 'GPU-4090-0001', node: 'node-a', containerUtil: 0.33, utilPercent: 33, memUsedBytes: GIB },
    ]);

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    const [card4090, card5090] = body.nodes[0].devices;
    expect(card4090.measured).toBe(true);
    expect(card4090.utilPercent).toBe(33);
    expect(card4090.allocMemMiB).toBe(5888);

    expect(card5090.uuid).toBe('GPU-5090-0002');
    expect(card5090.measured).toBe(false);
    expect(card5090.utilPercent).toBe(0);
    // 没有实测 ≠ 没有分配
    expect(card5090.allocMemMiB).toBe(2048);
    expect(card5090.allocCores).toBe(10);
    expect(card5090.pods).toHaveLength(1);
  });

  it('util clamp：负值归 0，超 100 归 100，浮点噪声只留两位', async () => {
    h.metrics = metricsOf([
      // 负值按 0 计（不能把 -20% 当成「扣掉 20 个点」再和别的容器相加）
      { deviceUUID: 'GPU-4090-0001', node: 'node-a', utilPercent: -20, memUsedBytes: 0 },
      { deviceUUID: 'GPU-4090-0001', node: 'node-a', utilPercent: 15, memUsedBytes: 0 },
      // 浮点噪声：不该出现 42.300000000000004 这种尾巴
      { deviceUUID: 'GPU-5090-0002', node: 'node-a', utilPercent: 42.30000000000001, memUsedBytes: 0 },
    ]);

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    // -20 归 0 后与 15 求和 = 15；负号不能把别的容器的量吃掉
    expect(body.nodes[0].devices[0].utilPercent).toBe(15);
    expect(body.nodes[0].devices[1].utilPercent).toBe(42.3);
    expect(body.nodes[0].devices[0].measured).toBe(true);
  });

  it('量纲：只给 containerUtil（0..1 比例）时换算成百分比，85% 不能显示成 0.85%', async () => {
    h.metrics = metricsOf([
      // 老契约字段：只有 ratio，没有 utilPercent（A1 早期版本 / 第三方采集器）
      { deviceUUID: 'GPU-4090-0001', node: 'node-a', containerUtil: 0.85, memUsedBytes: GIB },
      // 采样抖动：ratio 略超 1（多容器累加后的计量误差）也要 clamp 到 100
      { deviceUUID: 'GPU-5090-0002', node: 'node-a', containerUtil: 1.04, memUsedBytes: GIB },
    ]);

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    expect(body.nodes[0].devices[0].utilPercent).toBe(85);
    expect(body.nodes[0].devices[1].utilPercent).toBe(100);
  });

  it('设备在位但样本全为 null：不冒充 0%，标成未测到', async () => {
    h.metrics = metricsOf([
      // A1 的「未知即 null」：设备出现在指标里，但没有任何利用率/显存样本
      { deviceUUID: 'GPU-4090-0001', node: 'node-a', containerUtil: null, utilPercent: null, memUsedBytes: null },
      // 同一批里另一张卡有数据：不能被前一条带坏
      { deviceUUID: 'GPU-5090-0002', node: 'node-a', containerUtil: 0.2, utilPercent: 20, memUsedBytes: GIB },
    ]);

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    const [card4090, card5090] = body.nodes[0].devices;
    expect(card4090.measured).toBe(false);
    expect(card4090.utilPercent).toBe(0);
    expect(card5090.measured).toBe(true);
    expect(card5090.utilPercent).toBe(20);
  });

  it('字段缺失不崩：没有 register 注解的节点、垃圾 Pod 注解都只降级', async () => {
    h.nodesResponse = {
      items: [
        NODE_A,
        // 没有 register 注解，只有 allocatable 里的 nvidia.com/gpu → 有 GPU 但没有物理卡明细
        nodeItem('node-b'),
        // 完全裸的节点（status 缺失）
        { metadata: { name: 'node-c' } },
      ],
    };
    const garbagePod = podItem('default', 'broken-0', 'node-a', []);
    garbagePod.metadata.annotations['hami.io/vgpu-devices-allocated'] = 'garbage';
    h.podsResponse = { items: [garbagePod, {}, { metadata: {} }] };

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    expect(body.available).toBe(true);
    const byName = Object.fromEntries(body.nodes.map((node) => [node.name, node]));
    // node-a：register 两张卡，坏 Pod 不产生任何 Pod 明细
    expect(byName['node-a'].devices).toHaveLength(2);
    expect(byName['node-a'].devices.flatMap((d) => d.pods)).toMatchObject([]);
    // node-b：有 GPU 资源但没有物理卡清单 → 节点出现、devices 为空数组
    expect(byName['node-b']).toBeDefined();
    expect(byName['node-b'].devices).toMatchObject([]);
    // node-c：没有 GPU → 不出现（不能被伪装成一张「0 容量卡」）
    expect(byName['node-c']).toBeUndefined();
  });

  it('集群没有任何 GPU：nodes 为空数组，仍是 200 + available', async () => {
    h.nodesResponse = { items: [{ metadata: { name: 'plain' }, status: { capacity: { cpu: '8' } } }] };
    h.podsResponse = { items: [] };
    h.metrics = metricsOf([]);

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.nodes).toEqual([]);
  });

  it('承接 A1 的 cluster 参数是脱敏视图（不含 kubeconfig 明文），但保留指标端口', async () => {
    // A1 支持 cluster.metricsPort 覆盖默认 31993，而 store.toView 只输出固定字段会把它吃掉
    h.settings.k8sClusters[0].metricsPort = 31994;

    await get('/api/k8s/clusters/c-243/usage');

    expect(h.metricsCalls).toHaveLength(1);
    const { cluster, client } = h.metricsCalls[0];
    expect(client).toBeTruthy();
    expect(cluster).toEqual({
      id: 'c-243',
      name: '243',
      context: '',
      server: '',
      enabled: true,
      authType: 'cert',
      hasKubeconfig: true,
      metricsPort: 31994,
    });
    expect(JSON.stringify(cluster)).not.toContain('kubeconfig');
    expect(JSON.stringify(cluster)).not.toContain('6443');
  });

  it('只读端点：不写 cookie，遥测响应不许缓存', async () => {
    const { status, headers } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(200);
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.get('cache-control')).toBe('no-store');
  });
});

describe('错误语义：404 / 502 / 400', () => {
  it('集群不存在 → 404 + 中文原因', async () => {
    const { status, body } = await get('/api/k8s/clusters/nope/usage');

    expect(status).toBe(404);
    expect(body.error).toContain('Kubernetes 集群不存在');
    expect(body.error).toContain('nope');
    // 找不到集群时不该建客户端，更不该抓指标
    expect(h.clientCalls).toBe(0);
    expect(h.getJsonCalls).toEqual([]);
  });

  it('节点列表请求失败 → 502 + 中文原因（而不是 200 空态）', async () => {
    h.failNodes = true;

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(502);
    expect(body.error).toContain('无法读取节点列表');
    expect(body.error).toContain('connection refused');
  });

  it('Pod 列表请求失败 → 502 + 中文原因', async () => {
    h.failPods = true;

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(502);
    expect(body.error).toContain('无法读取 Pod 列表');
    expect(body.error).toContain('deadline exceeded');
  });

  it('kubeconfig 解析失败 → 400（配置问题不是上游不可达）', async () => {
    h.settings.k8sClusters[0].kubeconfig = 'apiVersion: v1\nkind: Config\n';

    const { status, body } = await get('/api/k8s/clusters/c-243/usage');

    expect(status).toBe(400);
    expect(body.error).toContain('kubeconfig 解析失败');
  });
});

describe('演示模式（OPENLOG_DEMO=1）', () => {
  it('返回演示数据且完全不触达集群与 settings', async () => {
    process.env.OPENLOG_DEMO = '1';

    const { status, body } = await get('/api/k8s/clusters/anything/usage');

    expect(status).toBe(200);
    // 演示模式要给完整数据（「分配 vs 实际使用」是演示主打能力，空卡片等于没做）
    expect(body.demo).toBe(true);
    expect(body.available).toBe(true);
    expect(body.nodes.length).toBeGreaterThan(0);
    const firstDevice = body.nodes[0].devices[0];
    expect(firstDevice.measured).toBe(true);
    expect(firstDevice.totalMemMiB).toBeGreaterThan(0);
    expect(firstDevice.usedMemMiB).toBeGreaterThan(0);
    // 不读 settings、不建客户端、不请求 apiserver、不抓指标
    expect(h.storeCalls).toEqual([]);
    expect(h.clientCalls).toBe(0);
    expect(h.getJsonCalls).toEqual([]);
    expect(h.metricsCalls).toEqual([]);
  });
});

describe('工厂签名', () => {
  it('缺少 ensureSettings 注入时立刻抛 TypeError（挂载期就暴露）', () => {
    expect(() => createK8sUsageRouter()).toThrow(TypeError);
    expect(() => createK8sUsageRouter({})).toThrow(/ensureSettings/);
  });
});
