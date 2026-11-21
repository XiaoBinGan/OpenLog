/**
 * server/demo/fixtures.js —— 演示模式的假数据（纯数据 + 纯函数）
 *
 * 契约见 /tmp/demo-contract.md。三条硬约束：
 *
 * 1. **形状必须与现有路由的真实响应完全一致**。这些导出不是"随便编一份好看的
 *    JSON"：docker 的容器对象逐字段照抄 `server/docker.js#listContainers` 的返回，
 *    GPU 设备照抄 `gpu.js#buildRemoteGPUPayload`，K8s 资源照抄
 *    `k8s/resources.js#normalize*`，TSDB 照抄 `routes/prometheus.js` 的 Prometheus
 *    协议壳。字段名一个都不能改，否则前端在演示模式下会走另一条分支（甚至白屏），
 *    而那条分支平时没人跑，线上就永远发现不了。
 *
 * 2. **纯函数 + 常量表**：不联网、不读文件、不 import 任何其它模块。
 *    演示模式存在的意义是"没有任何真实依赖时页面不空"，如果它自己还要 IO，
 *    那就成了新的故障点。
 *
 * 3. **确定性**：同一函数多次调用 deepEqual。所以时间字段全部从 DEMO_NOW 派生，
 *    而不是 Date.now() —— 「刷新一次数值就变」是最容易被一眼看穿的假数据，
 *    也会让路由缓存、前端 diff、测试断言全部失效。
 *
 * 数据视角：GPU 推理集群运维 —— 一台 4×RTX 4090 跑 vLLM 主服务，一台 4×T4 跑
 * 批量/低优先级任务，一台双卡 T4 掉线（保留最后一次采集值）。容器里既有推理
 * 服务也有 redis / postgres 这类依赖，并且**故意留有故障**：一个 OOM 退出
 * （137）、一个 CrashLoop 重启中、一个 K8s Pod 调度不上去 —— 演示模式的价值
 * 一半在于"空页面不空"，另一半在于"故障页能看出故障长什么样"。
 */

// ─── 时间基准 ──────────────────────────────────────────────────────────────

/**
 * 所有时间字段的锚点（固定值，不用 Date.now()）。
 * 取值贴近仓库里出现过的运维现场时间，方便对着日志读。
 */
export const DEMO_NOW = '2026-06-08T09:48:37.000Z';

const NOW_MS = Date.parse(DEMO_NOW);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const GiB = 1024 ** 3;

/** NOW 之前 msAgo 毫秒的 ISO 时间（负值按 0 处理，不允许"未来"数据） */
const iso = (msAgo) => new Date(NOW_MS - Math.max(0, msAgo)).toISOString();

/** 深拷贝：每次调用返回全新对象，调用方 mutate 不会污染常量表 */
const clone = (value) => JSON.parse(JSON.stringify(value));

// ─── 远程服务器 ────────────────────────────────────────────────────────────

/**
 * 形状与 `remote.getServers()` 一致（GET /api/remote/servers → `{ servers }`）。
 *
 * 三台机器共 10 张卡：4×4090（在线）+ 4×T4（在线）+ 2×T4（离线）。
 * 离线那台保留最后一次采集到的卡片数值 —— 真实运维里监控页断线前就是停在
 * 那个时候的，直接清零反而更假。
 */
const SERVERS = [
  {
    id: 'srv-4090-a',
    name: '4090×4',
    host: '10.20.30.11',
    port: 22,
    username: 'ops',
    logPath: '/data/logs',
    watchFiles: '*.log',
    lastConnected: iso(2 * MINUTE),
    status: 'connected',
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    retryCount: 0,
  },
  {
    id: 'srv-t4-4',
    name: '4卡T4',
    host: '10.20.30.21',
    port: 22,
    username: 'ops',
    logPath: '/data/logs',
    watchFiles: '*.log',
    lastConnected: iso(6 * MINUTE),
    status: 'connected',
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    retryCount: 0,
  },
  {
    id: 'srv-t4-2',
    name: '双卡T4',
    host: '10.20.30.31',
    port: 22,
    username: 'ops',
    logPath: '/data/logs',
    watchFiles: '*.log',
    lastConnected: iso(2 * DAY + 3 * HOUR),
    status: 'disconnected',
    lastError: 'ssh connect timeout （10.20.30.31:22）',
    lastErrorAt: iso(2 * DAY + 3 * HOUR),
    nextRetryAt: iso(-4 * MINUTE),
    retryCount: 7,
  },
];

const SERVER_BY_ID = new Map(SERVERS.map((s) => [s.id, s]));
const DEFAULT_SERVER_ID = 'srv-4090-a';

/** 取服务器；未知 id 回落到第一台（演示模式不 404，页面不该因为参数怪而空白） */
function resolveServer(serverId) {
  return SERVER_BY_ID.get(String(serverId || '')) || SERVER_BY_ID.get(DEFAULT_SERVER_ID);
}

/** GET /api/remote/servers */
export function demoRemoteServers() {
  return { servers: clone(SERVERS) };
}

// ─── GPU ──────────────────────────────────────────────────────────────────

/**
 * 单卡形状与 `/api/gpu/remote-server/:serverId` 的 devices 元素一致：
 * `{ index, name, util, memUsed, memTotal, temp, processes[{gpuId,pid,name,usedMemory}] }`。
 * 单位：显存 MiB，温度 ℃，util %（nvidia-smi 的原始量纲）。
 */
const GPU_DEVICES = {
  'srv-4090-a': [
    {
      index: 0,
      name: 'NVIDIA GeForce RTX 4090',
      util: 78,
      memUsed: 21450,
      memTotal: 24564,
      temp: 71,
      processes: [
        { gpuId: '0', pid: 12043, name: 'python3', usedMemory: 21080 },
        { gpuId: '0', pid: 12091, name: 'VLLM::EngineCore', usedMemory: 312 },
      ],
    },
    {
      index: 1,
      name: 'NVIDIA GeForce RTX 4090',
      util: 88,
      memUsed: 22100,
      memTotal: 24564,
      temp: 76,
      processes: [
        { gpuId: '1', pid: 12044, name: 'python3', usedMemory: 21700 },
        { gpuId: '1', pid: 12092, name: 'VLLM::EngineCore', usedMemory: 344 },
      ],
    },
    {
      index: 2,
      name: 'NVIDIA GeForce RTX 4090',
      util: 61,
      memUsed: 18240,
      memTotal: 24564,
      temp: 68,
      processes: [{ gpuId: '2', pid: 12045, name: 'python3', usedMemory: 17960 }],
    },
    {
      index: 3,
      name: 'NVIDIA GeForce RTX 4090',
      util: 34,
      memUsed: 9420,
      memTotal: 24564,
      temp: 57,
      processes: [{ gpuId: '3', pid: 12046, name: 'python3', usedMemory: 9210 }],
    },
  ],
  'srv-t4-4': [
    {
      index: 0,
      name: 'Tesla T4',
      util: 52,
      memUsed: 12300,
      memTotal: 15360,
      temp: 61,
      processes: [{ gpuId: '0', pid: 2871, name: 'python3', usedMemory: 12060 }],
    },
    {
      index: 1,
      name: 'Tesla T4',
      util: 74,
      memUsed: 14080,
      memTotal: 15360,
      temp: 72,
      processes: [{ gpuId: '1', pid: 2872, name: 'python3', usedMemory: 13820 }],
    },
    {
      index: 2,
      name: 'Tesla T4',
      util: 46,
      memUsed: 10240,
      memTotal: 15360,
      temp: 58,
      processes: [{ gpuId: '2', pid: 2873, name: 'python3', usedMemory: 10010 }],
    },
    {
      index: 3,
      name: 'Tesla T4',
      util: 39,
      memUsed: 8640,
      memTotal: 15360,
      temp: 55,
      processes: [{ gpuId: '3', pid: 2874, name: 'python3', usedMemory: 8380 }],
    },
  ],
  // 掉线机器的最后一次采集值（util/mem 保留，页面标 offline 即可）
  'srv-t4-2': [
    {
      index: 0,
      name: 'Tesla T4',
      util: 63,
      memUsed: 9840,
      memTotal: 15360,
      temp: 66,
      processes: [{ gpuId: '0', pid: 1640, name: 'python3', usedMemory: 9560 }],
    },
    {
      index: 1,
      name: 'Tesla T4',
      util: 47,
      memUsed: 8420,
      memTotal: 15360,
      temp: 59,
      processes: [{ gpuId: '1', pid: 1641, name: 'python3', usedMemory: 8180 }],
    },
  ],
};

/**
 * 与 `gpu.getGPUSummary()` 逐字段一致（路由直接把它塞进 `summary`）。
 * 不能自己发明 summary 字段：前端 GPU 页读的是 `summary.total/utilAvg/...`，
 * 而 API 的 `summary` 是 `count/totalMemory/...` —— 两边本来就是分开算的，
 * 这里只复刻 **API 侧** 那一份。
 */
function summarizeDevices(devices) {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const normalized = devices.map((d) => ({
    vendor: 'NVIDIA',
    name: d.name,
    memoryTotal: d.memTotal,
    memoryUsed: d.memUsed,
    utilization: d.util,
    temperature: d.temp,
    processes: clone(d.processes || []),
  }));
  const totalMemory = normalized.reduce((s, d) => s + d.memoryTotal, 0);
  const usedMemory = normalized.reduce((s, d) => s + d.memoryUsed, 0);
  const avgUtilization = normalized.reduce((s, d) => s + d.utilization, 0) / normalized.length;
  const vendors = normalized.reduce((acc, d) => {
    acc[d.vendor] = (acc[d.vendor] || 0) + 1;
    return acc;
  }, {});
  const processes = normalized.flatMap((d) => d.processes);

  return {
    count: normalized.length,
    totalMemory,
    usedMemory,
    freeMemory: totalMemory - usedMemory,
    avgUtilization: Math.round(avgUtilization),
    maxTemperature: Math.max(...normalized.map((d) => d.temperature)),
    vendors,
    devices: normalized,
    processCount: processes.length,
    processes,
  };
}

/**
 * `/api/gpu/...` 的 `{ devices, summary }`（remote-server 形状）。
 * @param {{serverId?: string}} [opts]
 */
export function demoGpuPayload(opts = {}) {
  const { serverId } = opts || {};
  const server = resolveServer(serverId);
  // 掉线机器的 GPU 采集必然失败：真实路由是 500，前端按 error 渲染，
  // 这里给「空设备 + null summary」这一等价形态，不假装它有 4 张卡在跑。
  if (server.status !== 'connected') return { devices: [], summary: null };
  const devices = clone(GPU_DEVICES[server.id] || []);
  return { devices, summary: summarizeDevices(devices) };
}

/** 三台机器 10 张卡的汇总（与 `getGPUSummary()` 同形；无卡时返回 null） */
export function demoGpuSummary() {
  return summarizeDevices(SERVERS.flatMap((s) => GPU_DEVICES[s.id] || []));
}

// ─── MFU（模型算力利用率）──────────────────────────────────────────────────

/**
 * 形状与 `gpu-mfu.js#sampleServerMfu()` 一致：
 * `{ available, engines[], gpuMfu{index: {mfu, engine, model, windowSec}}, reason }`。
 *
 * 数值按 `buildMfuResult()` 的 tokens × 激活参数量公式自洽：
 *   mfu% = (2 × paramsB × 1e9 × tokensPerSec / gpuCount) / (peakTflops × 1e12) × 100
 *   4090：2×27e9×5240.8/4 / 165.2e12 = 42.83%
 *   T4  ：2×27e9×1128.6/4 / 65e12   = 23.44%
 * 所以这里写的 tokensPerSec 和 mfu 不是随手挑的两个数，改一个就得改另一个。
 */
const MFU_BY_SERVER = {
  'srv-4090-a': {
    available: true,
    engines: [
      {
        available: true,
        engine: 'vllm',
        model: 'Qwen/Qwen3.6-27B',
        mfu: 42.83,
        gpuIndexes: [0, 1, 2, 3],
        peakTflops: 165.2,
        paramsB: 27,
        tokensPerSec: 5240.8,
        windowSec: 10.2,
        method: 'tokens_x_active_params',
        sampleCount: 2,
        endpoint: 'http://127.0.0.1:8000/metrics',
        sampledAt: iso(30_000),
      },
    ],
    gpuMfu: {
      0: { mfu: 42.83, engine: 'vllm', model: 'Qwen/Qwen3.6-27B', windowSec: 10.2 },
      1: { mfu: 42.83, engine: 'vllm', model: 'Qwen/Qwen3.6-27B', windowSec: 10.2 },
      2: { mfu: 42.83, engine: 'vllm', model: 'Qwen/Qwen3.6-27B', windowSec: 10.2 },
      3: { mfu: 42.83, engine: 'vllm', model: 'Qwen/Qwen3.6-27B', windowSec: 10.2 },
    },
    reason: null,
  },
  'srv-t4-4': {
    available: true,
    engines: [
      {
        available: true,
        engine: 'vllm',
        model: 'Qwen/Qwen3.6-27B',
        mfu: 23.44,
        gpuIndexes: [0, 1, 2, 3],
        peakTflops: 65,
        paramsB: 27,
        tokensPerSec: 1128.6,
        windowSec: 10.1,
        method: 'tokens_x_active_params',
        sampleCount: 2,
        endpoint: 'http://127.0.0.1:8000/metrics',
        sampledAt: iso(45_000),
      },
    ],
    gpuMfu: {
      0: { mfu: 23.44, engine: 'vllm', model: 'Qwen/Qwen3.6-27B', windowSec: 10.1 },
      1: { mfu: 23.44, engine: 'vllm', model: 'Qwen/Qwen3.6-27B', windowSec: 10.1 },
      2: { mfu: 23.44, engine: 'vllm', model: 'Qwen/Qwen3.6-27B', windowSec: 10.1 },
      3: { mfu: 23.44, engine: 'vllm', model: 'Qwen/Qwen3.6-27B', windowSec: 10.1 },
    },
    reason: null,
  },
};

/** `/api/remote/servers/:id/mfu` */
export function demoMfu(serverId) {
  const server = resolveServer(serverId);
  const payload = MFU_BY_SERVER[server.id];
  if (!payload) {
    // 与真实实现同文案：getRemoteMfu 在 SSH 不可达时给的就是这一句
    return { available: false, engines: [], gpuMfu: {}, reason: 'MFU 采集失败：服务器未连接' };
  }
  return clone(payload);
}

// ─── 远程系统状态 ──────────────────────────────────────────────────────────

/**
 * 形状与 `remote.getRemoteSystemStats()` 一致：
 * `{ cpu:{load,cores[]}, memory:{used,total,free}, disk[], network[], processes[], gpus[] }`。
 * 单位照真实实现：memory 是 **字节**，disk 是字节 + usePercent。
 * 掉线机器返回 `{ offline: true }` —— 路由 catch 到「服务器未连接」时就是这么回的。
 */
const STATS_BY_SERVER = {
  'srv-4090-a': {
    cpu: { load: 37.4, cores: [] },
    memory: {
      used: Math.round(176.4 * GiB),
      total: 256 * GiB,
      free: 256 * GiB - Math.round(176.4 * GiB),
    },
    disk: [
      { name: '/', device: '/dev/nvme0n1p2', used: 96_214_231_040, total: 131_000_000_000, usePercent: 73 },
      { name: '/data', device: '/dev/nvme1n1', used: 5_606_131_302_400, total: 7_600_000_000_000, usePercent: 74 },
    ],
    network: [{ iface: 'ens1f0', rx: 812_441_337_221, tx: 96_338_004_118 }],
    processes: [
      { pid: 12043, name: 'python3', cpu: 812.4, mem: 12.4 },
      { pid: 12044, name: 'python3', cpu: 798.1, mem: 12.2 },
      { pid: 12091, name: 'VLLM::EngineCore', cpu: 341.2, mem: 3.1 },
      { pid: 2208, name: 'sglang-router', cpu: 96.7, mem: 1.8 },
      { pid: 908, name: 'dockerd', cpu: 34.5, mem: 0.9 },
      { pid: 1721, name: 'postgres', cpu: 21.8, mem: 2.4 },
    ],
  },
  'srv-t4-4': {
    cpu: { load: 24.1, cores: [] },
    memory: {
      used: Math.round(41.2 * GiB),
      total: 64 * GiB,
      free: 64 * GiB - Math.round(41.2 * GiB),
    },
    disk: [
      { name: '/', device: '/dev/sda2', used: 38_402_193_408, total: 53_600_000_000, usePercent: 72 },
      { name: '/data', device: '/dev/sdb1', used: 1_204_510_556_160, total: 2_000_000_000_000, usePercent: 60 },
    ],
    network: [{ iface: 'eno1', rx: 158_204_113_006, tx: 21_884_509_771 }],
    processes: [
      { pid: 2871, name: 'python3', cpu: 402.6, mem: 9.1 },
      { pid: 2872, name: 'python3', cpu: 388.9, mem: 9.4 },
      { pid: 2873, name: 'VLLM::EngineCore', cpu: 120.3, mem: 2.2 },
      { pid: 904, name: 'dockerd', cpu: 18.2, mem: 0.7 },
    ],
  },
};

/** `/api/remote/servers/:id/stats` */
export function demoRemoteStats(serverId) {
  const server = resolveServer(serverId);
  if (server.status !== 'connected') return { offline: true };
  const base = STATS_BY_SERVER[server.id];
  if (!base) return { offline: true };
  return clone({ ...base, gpus: GPU_DEVICES[server.id] || [] });
}

// ─── Docker ───────────────────────────────────────────────────────────────

/** 64 位容器 id（短 id 一律由 `id.slice(0, 12)` 派生，避免两处写不一致） */
const CID = {
  vllm: '9f2c1a4b7d3e5f608a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f',
  router: '4a7b1c9d2e5f80316c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d',
  redis: '1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c',
  postgres: '7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6',
  canary: '2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c',
  bench: '6e8a0c2b4d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c',
  embedding: '3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c',
  t4vllm: '8b0d2f4a6c1e3b5d7f9a0c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d2f4a6c1e3b5d',
};

const SOURCE_A = { sourceId: 'srv-4090-a', sourceName: '4090×4 · docker', host: '10.20.30.11', serverId: 'srv-4090-a' };
const SOURCE_B = { sourceId: 'srv-t4-4', sourceName: '4卡T4 · docker', host: '10.20.30.21', serverId: 'srv-t4-4' };

/** labels 里 `env.` / `ENV.` 前缀的键会被 listContainers 展开成 "K=V"（最多 20 条） */
function envFromLabels(labels) {
  return Object.entries(labels || {})
    .filter(([k]) => k.startsWith('env.') || k.startsWith('ENV.'))
    .map(([k, v]) => `${k.replace(/^(env\.|ENV\.)/, '')}=${v}`)
    .slice(0, 20);
}

/**
 * 构造一个与 `docker.js#listContainers()` 输出逐字段同形的容器对象。
 * exitCode / exitType 由 `parseExitInfo(status, state)` 从 status 字符串推出，
 * 这里直接给出同样的结果（Exited (137) → { 137, 'oom' }）。
 */
function makeContainer(spec) {
  return {
    id: spec.id,
    shortId: spec.id.slice(0, 12),
    names: spec.names,
    image: spec.image,
    imageId: spec.imageId,
    command: spec.command,
    created: iso(spec.createdAgo),
    state: spec.state,
    status: spec.status,
    exitCode: spec.exitCode ?? null,
    exitType: spec.exitType ?? null,
    ports: spec.ports || [],
    labels: spec.labels || {},
    envVars: envFromLabels(spec.labels),
    networks: spec.networks || ['bridge'],
    networkAliases: [],
    platform: 'linux',
    // 列表接口不算上下游（要逐个 inspect 太慢），真实值就是 null 而不是 0
    upstreamCount: null,
    downstreamCount: null,
  };
}

const CONTAINERS_A = [
  makeContainer({
    id: CID.vllm,
    names: ['vllm-qwen27b'],
    image: 'vllm/vllm-openai:v0.8.5',
    imageId: 'sha256:9f2c1',
    command: '--model Qwen/Qwen3.6-27B --tensor-parallel-size 4 --max-model-len 32768 --gpu-memory-utilization 0.92 --port 8000',
    createdAgo: 3 * DAY + 4 * HOUR,
    state: 'running',
    status: 'Up 3 hours',
    ports: [
      { ip: '0.0.0.0', privatePort: 8000, publicPort: 8000, type: 'tcp' },
      { ip: '0.0.0.0', privatePort: 8001, publicPort: 8001, type: 'tcp' },
    ],
    labels: {
      'com.docker.compose.project': 'inference',
      'com.docker.compose.service': 'vllm-qwen27b',
      'env.MODEL_NAME': 'Qwen/Qwen3.6-27B',
      'env.TENSOR_PARALLEL_SIZE': '4',
    },
    networks: ['inference-net'],
  }),
  makeContainer({
    id: CID.router,
    names: ['sglang-router'],
    image: 'lmsysorg/sglang:v0.4.6.post4',
    imageId: 'sha256:3c7ad',
    command: 'python3 -m sglang_router.launch_router --pd-disaggregation --prefill http://127.0.0.1:8000 --port 30000',
    createdAgo: 3 * DAY + 3 * HOUR,
    state: 'running',
    status: 'Up 3 hours',
    ports: [{ ip: '0.0.0.0', privatePort: 30000, publicPort: 30000, type: 'tcp' }],
    labels: {
      'com.docker.compose.project': 'inference',
      'com.docker.compose.service': 'router',
      'env.ROUTER_PORT': '30000',
    },
    networks: ['inference-net'],
  }),
  makeContainer({
    id: CID.redis,
    names: ['redis-cache'],
    image: 'redis:7.4-alpine',
    imageId: 'sha256:6f1d2',
    command: 'redis-server --appendonly yes --maxmemory 4gb --maxmemory-policy allkeys-lru',
    createdAgo: 12 * DAY,
    state: 'running',
    status: 'Up 9 days',
    ports: [{ ip: '127.0.0.1', privatePort: 6379, publicPort: 16379, type: 'tcp' }],
    labels: {
      'com.docker.compose.project': 'inference',
      'com.docker.compose.service': 'redis',
    },
    networks: ['inference-net'],
  }),
  makeContainer({
    id: CID.postgres,
    names: ['postgres-metadata'],
    image: 'postgres:16-alpine',
    imageId: 'sha256:1a9bf',
    command: 'postgres -c max_connections=300 -c shared_buffers=2GB',
    createdAgo: 12 * DAY,
    state: 'running',
    status: 'Up 9 days',
    ports: [{ ip: '127.0.0.1', privatePort: 5432, publicPort: 15432, type: 'tcp' }],
    labels: {
      'com.docker.compose.project': 'inference',
      'com.docker.compose.service': 'postgres',
      'env.POSTGRES_DB': 'openlog_meta',
    },
    networks: ['inference-net'],
  }),
  makeContainer({
    id: CID.canary,
    names: ['vllm-qwen27b-canary'],
    image: 'vllm/vllm-openai:v0.9.0',
    imageId: 'sha256:be714',
    command: '--model Qwen/Qwen3.6-27B --tensor-parallel-size 4 --max-model-len 65536 --gpu-memory-utilization 0.95',
    createdAgo: 41 * MINUTE,
    state: 'restarting',
    status: 'Restarting (1) 15 seconds ago',
    ports: [{ ip: '0.0.0.0', privatePort: 8010, publicPort: 8010, type: 'tcp' }],
    labels: {
      'com.docker.compose.project': 'inference-canary',
      'com.docker.compose.service': 'vllm-canary',
      'env.MODEL_NAME': 'Qwen/Qwen3.6-27B',
      'env.VLLM_USE_V1': '1',
    },
    networks: ['inference-net'],
  }),
  makeContainer({
    id: CID.bench,
    names: ['vllm-bench-old'],
    image: 'vllm/vllm-openai:v0.8.5',
    imageId: 'sha256:9f2c1',
    command: '--model Qwen/Qwen3.6-27B --tensor-parallel-size 4 --max-model-len 131072 --gpu-memory-utilization 0.98',
    createdAgo: 2 * DAY + 6 * HOUR,
    state: 'exited',
    status: 'Exited (137) 3 hours ago',
    exitCode: 137,
    exitType: 'oom',
    labels: {
      'com.docker.compose.project': 'inference',
      'com.docker.compose.service': 'bench',
      'env.MODEL_NAME': 'Qwen/Qwen3.6-27B',
    },
    networks: ['inference-net'],
  }),
];

const CONTAINERS_B = [
  makeContainer({
    id: CID.embedding,
    names: ['embedding-bge-m3'],
    image: 'michaelf34/infinity:0.0.76',
    imageId: 'sha256:5d02e',
    command: 'v2 --model-id BAAI/bge-m3 --port 8080 --batch-size 64',
    createdAgo: 5 * DAY + 2 * HOUR,
    state: 'running',
    status: 'Up 2 days',
    ports: [{ ip: '0.0.0.0', privatePort: 8080, publicPort: 8080, type: 'tcp' }],
    labels: {
      'com.docker.compose.project': 'inference',
      'com.docker.compose.service': 'embedding',
      'env.MODEL_ID': 'BAAI/bge-m3',
    },
    networks: ['inference-net'],
  }),
  makeContainer({
    id: CID.t4vllm,
    names: ['vllm-t4-qwen27b'],
    image: 'vllm/vllm-openai:v0.8.5',
    imageId: 'sha256:9f2c1',
    command: '--model Qwen/Qwen3.6-27B --tensor-parallel-size 4 --max-model-len 16384 --gpu-memory-utilization 0.90 --port 8000',
    createdAgo: 2 * DAY + 9 * HOUR,
    state: 'running',
    status: 'Up 2 days',
    ports: [{ ip: '0.0.0.0', privatePort: 8000, publicPort: 8000, type: 'tcp' }],
    labels: {
      'com.docker.compose.project': 'inference',
      'com.docker.compose.service': 'vllm-t4',
      'env.MODEL_NAME': 'Qwen/Qwen3.6-27B',
      'env.TENSOR_PARALLEL_SIZE': '4',
    },
    networks: ['inference-net'],
  }),
];

/**
 * GET /api/docker/containers → `{ sources: [{ sourceId, sourceName, host, serverId, containers }] }`
 * 失败源的真实形态是 `{ ...meta, error, containers: [] }`（这里三个源都正常，
 * 保留 error 字段的写法给 B 参考）。
 */
export function demoDockerSources() {
  return {
    sources: [
      { ...SOURCE_A, containers: clone(CONTAINERS_A) },
      { ...SOURCE_B, containers: clone(CONTAINERS_B) },
    ],
  };
}

// ─── 容器日志 ──────────────────────────────────────────────────────────────

/**
 * 每个容器的日志模板（[level, 正文]）。
 * level/content 与 `docker.js#getContainerLogs()` 算出来的一致：
 * `line` 是原始整行（带级别前缀），`content` 是去掉级别前缀后的正文。
 * 刻意混入少量 WARN 与个别 ERROR —— 全 INFO 的日志一眼假，全 ERROR 又看不出问题定位。
 */
const LOG_TEMPLATES = {
  'vllm-qwen27b': [
    ['INFO', '(APIServer pid=1) INFO 06-08 06:48:12 [api_server.py:1043] vLLM API server version 0.8.5'],
    ['INFO', '(APIServer pid=1) INFO 06-08 06:48:12 [utils.py:263] non-default args: {\'model\': \'Qwen/Qwen3.6-27B\', \'tensor_parallel_size\': 4}'],
    ['INFO', '(EngineCore pid=87) INFO 06-08 06:48:19 [core.py:396] Initializing a V1 LLM engine (v0.8.5) with config: model=\'Qwen/Qwen3.6-27B\', dtype=torch.bfloat16'],
    ['INFO', '(EngineCore pid=87) INFO 06-08 06:49:02 [core.py:577] init engine (profile, create kv cache, warmup model) took 43.21 s'],
    ['INFO', '(APIServer pid=1) INFO 06-08 06:49:03 [api_server.py:1287] Starting vLLM API server on http://0.0.0.0:8000'],
    ['INFO', '(APIServer pid=1) INFO 06-08 06:49:03 [launcher.py:31] Route: /v1/chat/completions, Methods: POST'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:41:07 [loggers.py:120] Engine 000: Avg prompt throughput: 918.4 tokens/s, Avg generation throughput: 210.2 tokens/s, Running: 12 reqs, Waiting: 3 reqs, GPU KV cache usage: 61.4%'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:42:11 [loggers.py:120] Engine 000: Avg prompt throughput: 884.1 tokens/s, Avg generation throughput: 205.6 tokens/s, Running: 11 reqs, Waiting: 0 reqs, GPU KV cache usage: 58.9%'],
    ['WARN', '(APIServer pid=1) WARN 06-08 09:42:44 [core.py:214] Sequence group 7f3c21aa preempted: KV cache 91.2% > watermark 90.0%'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:43:02 [loggers.py:120] Engine 000: Avg prompt throughput: 902.7 tokens/s, Avg generation throughput: 212.8 tokens/s, Running: 13 reqs, Waiting: 5 reqs, GPU KV cache usage: 88.1%'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:44:15 [loggers.py:120] Engine 000: Avg prompt throughput: 921.0 tokens/s, Avg generation throughput: 214.3 tokens/s, Running: 14 reqs, Waiting: 2 reqs, GPU KV cache usage: 74.6%'],
    ['WARN', '(APIServer pid=1) WARN 06-08 09:45:31 [engine.py:441] request aborted by client: req_8f21c4 (timeout after 300s)'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:46:02 [loggers.py:120] Engine 000: Avg prompt throughput: 897.6 tokens/s, Avg generation throughput: 209.4 tokens/s, Running: 12 reqs, Waiting: 1 reqs, GPU KV cache usage: 66.2%'],
    ['ERROR', '(APIServer pid=1) ERROR 06-08 09:46:38 [serving_chat.py:238] ValueError: prompt length 33128 exceeds max_model_len 32768, request rejected'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:47:20 [loggers.py:120] Engine 000: Avg prompt throughput: 905.2 tokens/s, Avg generation throughput: 211.7 tokens/s, Running: 12 reqs, Waiting: 0 reqs, GPU KV cache usage: 63.8%'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:48:07 [loggers.py:120] Engine 000: Avg prompt throughput: 912.8 tokens/s, Avg generation throughput: 213.1 tokens/s, Running: 12 reqs, Waiting: 0 reqs, GPU KV cache usage: 60.7%'],
  ],
  'sglang-router': [
    ['INFO', '2026-06-08 09:40:02 INFO router started on 0.0.0.0:30000, workers=2'],
    ['INFO', '2026-06-08 09:40:02 INFO policy=cache_aware, prefill=http://127.0.0.1:8000'],
    ['INFO', '2026-06-08 09:42:19 INFO routed 512 requests to worker 0 (p99 812ms)'],
    ['INFO', '2026-06-08 09:43:44 INFO routed 498 requests to worker 0 (p99 876ms)'],
    ['WARN', '2026-06-08 09:44:51 WARN worker 0 queue depth 24 > soft limit 16, shedding 3 requests'],
    ['INFO', '2026-06-08 09:45:10 INFO routed 531 requests to worker 0 (p99 903ms)'],
    ['ERROR', '2026-06-08 09:46:22 ERROR upstream worker 0 returned 503 for req 0a71c9, retrying on next worker'],
    ['INFO', '2026-06-08 09:47:35 INFO routed 505 requests to worker 0 (p99 848ms)'],
    ['INFO', '2026-06-08 09:48:21 INFO health check ok, 2/2 workers ready'],
  ],
  'redis-cache': [
    ['INFO', '1:M 08 Jun 2026 09:40:11.204 * Background saving started by pid 812'],
    ['INFO', '1:M 08 Jun 2026 09:40:11.851 * Background saving terminated with success'],
    ['INFO', '1:M 08 Jun 2026 09:43:02.119 * 100 changes in 300 seconds. Saving...'],
    ['INFO', '1:M 08 Jun 2026 09:43:02.640 * Background saving terminated with success'],
    ['WARN', '1:M 08 Jun 2026 09:45:37.008 # WARNING: maxmemory is close to the limit (3.71G / 4.00G)'],
    ['INFO', '1:M 08 Jun 2026 09:46:12.882 * DB saved on disk (rdb 142.3 MB)'],
    ['INFO', '1:M 08 Jun 2026 09:48:01.004 * 100 changes in 300 seconds. Saving...'],
  ],
  'postgres-metadata': [
    ['INFO', '2026-06-08 09:40:14.118 UTC [1] LOG:  database system is ready to accept connections'],
    ['INFO', '2026-06-08 09:41:02.204 UTC [88] LOG:  checkpoint starting: time'],
    ['INFO', '2026-06-08 09:41:07.913 UTC [88] LOG:  checkpoint complete: wrote 412 buffers (0.5%)'],
    ['WARN', '2026-06-08 09:43:38.401 UTC [141] WARNING:  there is no transaction in progress'],
    ['INFO', '2026-06-08 09:45:19.772 UTC [1] LOG:  automatic vacuum of table "openlog_meta.public.request_log": index scans: 1'],
    ['ERROR', '2026-06-08 09:46:44.209 UTC [162] ERROR:  canceling statement due to statement timeout'],
    ['INFO', '2026-06-08 09:47:51.318 UTC [88] LOG:  checkpoint starting: time'],
  ],
  'vllm-qwen27b-canary': [
    ['INFO', '(APIServer pid=1) INFO 06-08 09:47:56 [api_server.py:1043] vLLM API server version 0.9.0'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:47:57 [core.py:396] Initializing a V1 LLM engine (v0.9.0) with config: model=\'Qwen/Qwen3.6-27B\', gpu_memory_utilization=0.95'],
    ['WARN', '(EngineCore pid=91) WARN 06-08 09:48:02 [core.py:588] free memory on device cuda:0 (1.42 GiB) is less than desired GPU memory utilization'],
    ['ERROR', '(EngineCore pid=91) ERROR 06-08 09:48:09 [core.py:602] torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.25 GiB. GPU 0 has a total capacity of 23.99 GiB of which 612.00 MiB is free'],
    ['ERROR', '(EngineCore pid=91) ERROR 06-08 09:48:09 [core.py:602] EngineCore failed to start.'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:48:10 [launcher.py:118] Shutting down: engine core process exited with code 1'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:48:22 [api_server.py:1043] vLLM API server version 0.9.0'],
  ],
  'vllm-bench-old': [
    ['INFO', '(APIServer pid=1) INFO 06-08 06:12:03 [api_server.py:1043] vLLM API server version 0.8.5'],
    ['INFO', '(EngineCore pid=74) INFO 06-08 06:12:41 [core.py:577] init engine (profile, create kv cache, warmup model) took 38.44 s'],
    ['INFO', 'bench: running 2000 prompts, concurrency 128, input_len 4096, output_len 512'],
    ['INFO', '(APIServer pid=1) INFO 06-08 06:41:20 [loggers.py:120] Engine 000: Avg prompt throughput: 2104.7 tokens/s, Avg generation throughput: 611.2 tokens/s, Running: 128 reqs'],
    ['WARN', '(EngineCore pid=74) WARN 06-08 06:44:02 [core.py:214] KV cache usage 98.7%, preemption rate rising'],
    ['ERROR', '(EngineCore pid=74) ERROR 06-08 06:45:11 [core.py:602] torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 2 has a total capacity of 23.99 GiB of which 384.00 MiB is free'],
    ['ERROR', '(EngineCore pid=74) ERROR 06-08 06:45:11 [core.py:602] Killed'],
    ['ERROR', '(EngineCore pid=74) ERROR 06-08 06:45:11 [core.py:589] Traceback (most recent call last): File "/usr/local/lib/python3.12/site-packages/vllm/engine/core.py", line 589, in start_engine'],
    ['ERROR', '(EngineCore pid=74) ERROR 06-08 06:45:12 [core.py:604] EngineCore failed with exit code 1 (OOMKilled)'],
  ],
  'embedding-bge-m3': [
    ['INFO', '2026-06-08 09:40:33 INFO infinity_emb: ready to serve, model=BAAI/bge-m3, batch_size=64, device=cuda'],
    ['INFO', '2026-06-08 09:41:09 INFO served 512 embed requests in 12.4s (41.3 req/s)'],
    ['INFO', '2026-06-08 09:44:18 INFO served 640 embed requests in 14.1s (45.4 req/s)'],
    ['WARN', '2026-06-08 09:45:52 WARN batch 0 has 3 oversized inputs (truncated to 8192 tokens)'],
    ['INFO', '2026-06-08 09:47:26 INFO served 588 embed requests in 13.2s (44.5 req/s)'],
  ],
  'vllm-t4-qwen27b': [
    ['INFO', '(APIServer pid=1) INFO 06-07 06:31:02 [api_server.py:1043] vLLM API server version 0.8.5'],
    ['INFO', '(EngineCore pid=66) INFO 06-07 06:32:14 [core.py:577] init engine (profile, create kv cache, warmup model) took 71.02 s'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:41:44 [loggers.py:120] Engine 000: Avg prompt throughput: 906.1 tokens/s, Avg generation throughput: 222.5 tokens/s, Running: 6 reqs, GPU KV cache usage: 47.2%'],
    ['WARN', '(APIServer pid=1) WARN 06-08 09:43:08 [core.py:214] Sequence group c4b21e preempted: KV cache 93.4% > watermark 90.0%'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:45:02 [loggers.py:120] Engine 000: Avg prompt throughput: 898.4 tokens/s, Avg generation throughput: 219.8 tokens/s, Running: 5 reqs, GPU KV cache usage: 52.8%'],
    ['ERROR', '(APIServer pid=1) ERROR 06-08 09:46:59 [serving_chat.py:238] ValueError: prompt length 17012 exceeds max_model_len 16384, request rejected'],
    ['INFO', '(APIServer pid=1) INFO 06-08 09:48:30 [loggers.py:120] Engine 000: Avg prompt throughput: 902.9 tokens/s, Avg generation throughput: 221.1 tokens/s, Running: 6 reqs, GPU KV cache usage: 49.5%'],
  ],
};

const GENERIC_LOGS = [
  ['INFO', 'service started, listening on 0.0.0.0:8080'],
  ['INFO', 'healthcheck ok'],
  ['INFO', 'request handled in 42 ms'],
  ['WARN', 'WARN slow request 1840 ms exceeded soft deadline'],
  ['INFO', 'request handled in 55 ms'],
];

/** 容器名 → 模板（按中文/英文名兜底） */
function templateFor(container) {
  const name = container?.names?.[0] || '';
  return LOG_TEMPLATES[name] || GENERIC_LOGS;
}

const ALL_CONTAINERS = [
  ...CONTAINERS_A.map((c) => ({ container: c, source: SOURCE_A })),
  ...CONTAINERS_B.map((c) => ({ container: c, source: SOURCE_B })),
];

/** 按 id / 短 id / 名称定位容器（找不到就回落到第一个，演示模式不 404） */
function findContainer(containerId, sourceId) {
  const wanted = String(containerId || '');
  const pool = sourceId
    ? ALL_CONTAINERS.filter((e) => e.source.sourceId === String(sourceId))
    : ALL_CONTAINERS;
  const list = pool.length > 0 ? pool : ALL_CONTAINERS;
  const hit = list.find((e) => e.container.id === wanted
    || e.container.shortId === wanted
    || e.container.names.includes(wanted));
  return hit || list[0];
}

/**
 * 去掉行内的级别前缀，得到 `content` 字段。
 * 与 `log-level.js#parseLogLevel()` 的口径一致：level 之前的内容（PID、时间戳、
 * 括号前缀）全部剥掉，剩下的就是正文。
 */
function stripLevelPrefix(text, level) {
  const at = text.search(new RegExp(`\\b${level}\\b`));
  if (at < 0) return text;
  return text.slice(at + level.length).replace(/^[\s:|-]+/, '');
}

/**
 * GET /api/docker/containers/:sourceId/:containerId/logs → `{ logs, containerId, sourceId }`
 * logs 元素形状 `{ timestamp, line, level, content }`（timestamps:true 的解析结果）。
 *
 * @param {{containerId?: string, sourceId?: string, tail?: number|string}} [opts]
 */
export function demoDockerLogs(opts = {}) {
  const { containerId, sourceId, tail } = opts || {};
  const found = findContainer(containerId, sourceId);
  const template = templateFor(found.container);
  // 已退出的容器，最后一行日志必须停在退出那一刻（3 小时前），
  // 否则会出现"容器 3 小时前 OOM 死了，日志却是刚刚写的"这种自打脸的演示数据
  const endOffset = found.container.state === 'exited' ? 3 * HOUR + 12_000 : 12_000;

  const wanted = Number(tail);
  const count = Number.isFinite(wanted) && wanted > 0
    ? Math.min(Math.floor(wanted), template.length)
    : template.length;
  const picked = template.slice(template.length - count);

  // 时间戳递增、最后一行落在 endOffset 之前
  const logs = picked.map(([level, text], i) => ({
    timestamp: iso((picked.length - 1 - i) * 3000 + endOffset),
    line: text,
    level,
    content: stripLevelPrefix(text, level),
  }));

  return {
    logs,
    // 真实路由原样回显请求里的 containerId / sourceId（可能是短 id）
    containerId: String(containerId || found.container.id),
    sourceId: String(sourceId || found.source.id),
  };
}

// ─── 容器健康检查 ──────────────────────────────────────────────────────────

/**
 * GET /api/docker/health-check 的返回形状
 * （`docker.healthCheck()` + `diagnosis.mergePatrolProblems()`，后者此时无事可合并）。
 *
 * 只有 1 个真问题：`vllm-bench-old` OOM 退出（137）。
 * `vllm-qwen27b-canary` 在 restarting —— 真实 healthCheck 只统计 `state==='exited'`，
 * 重启中的容器不会被算成问题，所以它只出现在 `running` 之外的统计差里
 * （total 8 / running 6 / exited 1 / 其它 1），这也正是真实实现的口径。
 */
export function demoDockerHealthCheck() {
  const benchLogs = LOG_TEMPLATES['vllm-bench-old'];
  const errors = benchLogs
    .map(([level, text], i) => ({ level, text, at: iso((benchLogs.length - 1 - i) * 3000 + 3 * HOUR + 12_000) }))
    .filter(({ level, text }) => level === 'ERROR'
      || /error|fatal|panic|exception|traceback|killed|oom/i.test(text))
    .map(({ text, at }) => `[${at}] ${text}`)
    .slice(-10);

  return {
    summary: {
      total: 8,
      running: 6,
      exited: 1,
      oomKilled: 1,
      errorExited: 0,
      normalExited: 0,
      healthy: 6,
      unhealthy: 1,
      staleHours: 24,
      ignoredStale: 0,
      ignoredUnobserved: 0,
      ignoredTotal: 0,
    },
    running: [
      { name: 'vllm-qwen27b', image: 'vllm/vllm-openai:v0.8.5', status: 'Up 3 hours', sourceName: SOURCE_A.sourceName },
      { name: 'sglang-router', image: 'lmsysorg/sglang:v0.4.6.post4', status: 'Up 3 hours', sourceName: SOURCE_A.sourceName },
      { name: 'redis-cache', image: 'redis:7.4-alpine', status: 'Up 9 days', sourceName: SOURCE_A.sourceName },
      { name: 'postgres-metadata', image: 'postgres:16-alpine', status: 'Up 9 days', sourceName: SOURCE_A.sourceName },
      { name: 'embedding-bge-m3', image: 'michaelf34/infinity:0.0.76', status: 'Up 2 days', sourceName: SOURCE_B.sourceName },
      { name: 'vllm-t4-qwen27b', image: 'vllm/vllm-openai:v0.8.5', status: 'Up 2 days', sourceName: SOURCE_B.sourceName },
    ],
    problems: [
      {
        name: 'vllm-bench-old',
        image: 'vllm/vllm-openai:v0.8.5',
        state: 'exited',
        exitCode: 137,
        exitType: 'oom',
        status: 'Exited (137) 3 hours ago',
        exitedAgoMs: 3 * HOUR,
        sourceName: SOURCE_A.sourceName,
        errors,
        logUnavailable: false,
        logDriverUnreadable: false,
        logNote: null,
      },
    ],
    normalExited: [],
    ignoredStale: [],
    ignoredUnobserved: [],
  };
}

// ─── 本地日志文件与 tail ───────────────────────────────────────────────────

const LOG_FILES = [
  { name: 'vllm-qwen27b.log', path: '/data/logs/vllm-qwen27b.log', size: 4_821_337 },
  { name: 'sglang-router.log', path: '/data/logs/sglang-router.log', size: 1_204_004 },
  { name: 'openlog-server.log', path: '/data/logs/openlog-server.log', size: 892_110 },
  { name: 'agent-worker.log', path: '/data/logs/agent-worker.log', size: 337_412 },
  { name: 'gpu-health.log', path: '/data/logs/gpu-health.log', size: 96_233 },
];

/**
 * GET /api/logs/files → **数组**（真实实现 `res.json(files)`，没有包裹对象）。
 * 因此这个导出不能用 demoJson 包一层 —— 数组挂不了字段。
 */
export function demoLogFiles() {
  return clone(LOG_FILES);
}

/** 应用日志行（readRemoteFile 形状用），按文件给出，未命中用通用模板 */
const TAIL_TEMPLATES = {
  'vllm-qwen27b.log': LOG_TEMPLATES['vllm-qwen27b'],
  'sglang-router.log': LOG_TEMPLATES['sglang-router'],
  'agent-worker.log': [
    ['INFO', '2026-06-08 09:44:02 [worker] poll queue inference.dlq, 0 messages'],
    ['INFO', '2026-06-08 09:45:31 [worker] task 7ba2c1 finished in 1204 ms'],
    ['WARN', '2026-06-08 09:46:48 WARN [worker] task 91cf0e retried (attempt 2/3): upstream 502'],
    ['ERROR', '2026-06-08 09:47:12 ERROR [worker] task 91cf0e failed permanently: upstream 502 after 3 attempts'],
    ['INFO', '2026-06-08 09:48:05 [worker] heartbeat ok, inflight=1, uptime=6h12m'],
  ],
  'gpu-health.log': [
    ['INFO', '2026-06-08 09:41:00 gpu-health: srv-4090-a 4/4 cards ok, max_temp=76C'],
    ['INFO', '2026-06-08 09:42:00 gpu-health: srv-t4-4 4/4 cards ok, max_temp=72C'],
    ['WARN', '2026-06-08 09:43:00 WARN gpu-health: srv-t4-2 unreachable (ssh timeout), keeping last known state'],
    ['INFO', '2026-06-08 09:44:00 gpu-health: srv-4090-a 4/4 cards ok, max_temp=76C'],
  ],
};

/**
 * 「读某个日志文件的最后 N 行」。
 *
 * 对应的真实端点是 `GET /api/remote/servers/:id/logs?file=&lines=`（远程文件 tail）
 * —— 路由层 `remote.readRemoteFile()` 的返回形状：
 * `{ logs: [{id,timestamp,level,message,source,metadata}], fileInfo: {size, modified}, totalLines }`。
 * 契约里写的 `GET /api/logs/tail` 在当前代码里不存在，B 集成时按这个端点接
 * （或新增 `/api/logs/tail` 时套同一个形状）。
 *
 * @param {{file?: string, lines?: number|string}} [opts]
 */
export function demoLogTail(opts = {}) {
  const { file, lines } = opts || {};
  const fileName = String(file || 'vllm-qwen27b.log');
  const base = String(fileName).split('/').pop() || 'vllm-qwen27b.log';
  const template = TAIL_TEMPLATES[base] || GENERIC_LOGS;

  const wanted = Number(lines);
  const count = Number.isFinite(wanted) && wanted > 0
    ? Math.min(Math.floor(wanted), template.length)
    : template.length;
  const picked = template.slice(template.length - count);
  const fileEntry = LOG_FILES.find((f) => f.name === base);

  const logs = picked.map(([level, text], i) => ({
    // 真实实现里 id 带 Date.now()；演示模式必须确定性，所以用序号
    id: `demo-${base}-${i}`,
    timestamp: iso((picked.length - 1 - i) * 3000 + 9_000),
    level,
    message: text,
    source: base,
    metadata: JSON.stringify({ raw: text, remote: true, path: String(file || `/data/logs/${base}`) }),
  }));

  return {
    logs,
    fileInfo: {
      size: fileEntry ? fileEntry.size : 0,
      modified: iso(11_000).replace('T', ' ').replace('Z', ' +0000'),
    },
    totalLines: template.length,
  };
}

// ─── TSDB（时序库）────────────────────────────────────────────────────────

/**
 * TSDB 查询的返回形状严格按 Prometheus（`routes/prometheus.js` 的 `ok()` 包装）：
 * `{ status: 'success', data: { resultType: 'matrix', result: [{ metric, values: [[ts,"v"]] }] } }`
 * 前端 `TsdbSection.tsx` 直接读 `data.result` 画折线，数值是**字符串**。
 *
 * 契约里写的 `POST /api/tsdb/query` 在当前代码里不存在（TSDB 只暴露
 * `/api/v1/query` 与 `/api/v1/query_range`），B 集成到 `/api/v1/query_range`。
 */
const TSDB_SERIES = {
  cpu: { name: 'openlog_cpu_usage_percent', base: 41, amp: 9, noise: 1.8 },
  memory: { name: 'openlog_memory_usage_percent', base: 68.5, amp: 4.5, noise: 0.9 },
  gpu: { name: 'openlog_gpu_utilization_percent', base: 66, amp: 14, noise: 3.2 },
  disk: { name: 'openlog_disk_usage_percent', base: 74, amp: 1.2, noise: 0.2 },
  containers: { name: 'openlog_docker_containers_total', base: 8, amp: 0, noise: 0 },
};

/** 确定性伪随机（线性同余）：同 seed 永远同一串噪声 */
function seededNoise(seed, count) {
  let state = seed >>> 0;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out.push(state / 4294967296);
  }
  return out;
}

/** PromQL 文本 → 演示序列（认关键词，认不出就按 CPU 处理） */
function pickSeries(query) {
  const q = String(query || '').toLowerCase();
  if (/gpu/.test(q)) return { key: 'gpu', ...TSDB_SERIES.gpu };
  if (/memory|mem_|rss/.test(q)) return { key: 'memory', ...TSDB_SERIES.memory };
  if (/disk|filesystem|fs_/.test(q)) return { key: 'disk', ...TSDB_SERIES.disk };
  if (/container|docker/.test(q)) return { key: 'containers', ...TSDB_SERIES.containers };
  return { key: 'cpu', ...TSDB_SERIES.cpu };
}

export const TSDB_POINTS = 60;
const TSDB_STEP_SEC = 60;

/** `POST /api/tsdb/query`（等价于 GET /api/v1/query_range） */
export function demoTsdbQuery(opts = {}) {
  const { query } = opts || {};
  const series = pickSeries(query);
  const noise = seededNoise(series.base * 1000 + series.name.length, TSDB_POINTS);
  const endSec = Math.floor(NOW_MS / 1000);
  const round = (v) => Math.round(v * 100) / 100;

  const values = noise.map((n, i) => {
    const ts = endSec - (TSDB_POINTS - 1 - i) * TSDB_STEP_SEC;
    const wave = Math.sin((i / TSDB_POINTS) * Math.PI * 2) * series.amp;
    const value = series.noise === 0
      ? series.base
      : round(series.base + wave + (n - 0.5) * 2 * series.noise);
    return [ts, String(value)];
  });

  return {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [
        {
          metric: {
            __name__: series.name,
            instance: 'openlog-demo',
            job: 'openlog-self',
          },
          values,
        },
      ],
    },
  };
}

// ─── Kubernetes ───────────────────────────────────────────────────────────

/** GET /api/k8s/clusters → `{ clusters: K8sClusterView[] }`（不含 kubeconfig 明文） */
export function demoK8sClusters() {
  return {
    clusters: [
      {
        id: 'demo-k3s-infer',
        name: '推理集群（k3s）',
        context: 'demo-k3s',
        server: 'https://10.20.40.10:6443',
        enabled: true,
        authType: 'token',
        hasKubeconfig: true,
        updatedAt: iso(6 * DAY),
      },
    ],
  };
}

const K8S_CONTEXT = {
  version: 'v1.31.4+k3s1',
  server: 'https://10.20.40.10:6443',
  context: 'demo-k3s',
};

/** 1 节点（形状同 `k8sResources.normalizeNodes()`） */
const K8S_NODES = [
  {
    name: 'k3s-infer-node-1',
    ready: true,
    roles: ['control-plane', 'master'],
    version: 'v1.31.4+k3s1',
    os: 'Ubuntu 22.04.5 LTS',
    arch: 'amd64',
    internalIP: '10.20.40.10',
    cpu: '32',
    memory: '131842000Ki',
    pods: '110',
    created: '2026-03-02T04:12:31Z',
    conditions: [
      { type: 'Ready', status: 'True' },
      { type: 'MemoryPressure', status: 'False' },
      { type: 'DiskPressure', status: 'False' },
      { type: 'PIDPressure', status: 'False' },
    ],
  },
];

/** 8 个 Pod：1 个 CrashLoopBackOff、1 个 Pending，其余 Running */
const K8S_PODS = [
  {
    namespace: 'inference',
    name: 'vllm-qwen27b-0',
    phase: 'Running',
    ready: '1/1',
    restarts: 0,
    node: 'k3s-infer-node-1',
    ip: '10.42.1.14',
    created: iso(3 * DAY),
    oom: false,
    crashLoop: false,
    containers: [{ name: 'vllm', ready: true, restarts: 0, state: 'running' }],
  },
  {
    namespace: 'inference',
    name: 'vllm-qwen27b-1',
    phase: 'Running',
    ready: '1/1',
    restarts: 1,
    node: 'k3s-infer-node-1',
    ip: '10.42.1.15',
    created: iso(3 * DAY),
    oom: false,
    crashLoop: false,
    containers: [{ name: 'vllm', ready: true, restarts: 1, state: 'running' }],
  },
  {
    namespace: 'inference',
    name: 'sglang-router-7c9f5b6d4-x2qkz',
    phase: 'Running',
    ready: '1/1',
    restarts: 0,
    node: 'k3s-infer-node-1',
    ip: '10.42.1.21',
    created: iso(3 * DAY),
    oom: false,
    crashLoop: false,
    containers: [{ name: 'router', ready: true, restarts: 0, state: 'running' }],
  },
  {
    namespace: 'inference',
    name: 'embedding-bge-m3-5d8f7c9b6-h4t7m',
    phase: 'Running',
    ready: '1/1',
    restarts: 0,
    node: 'k3s-infer-node-1',
    ip: '10.42.1.22',
    created: iso(2 * DAY),
    oom: false,
    crashLoop: false,
    containers: [{ name: 'infinity', ready: true, restarts: 0, state: 'running' }],
  },
  {
    // 演示用故障 ①：CrashLoopBackOff（新版本 canary 起不来）
    namespace: 'inference',
    name: 'vllm-canary-0',
    phase: 'Running',
    ready: '0/1',
    restarts: 17,
    node: 'k3s-infer-node-1',
    ip: '10.42.1.31',
    created: iso(41 * MINUTE),
    oom: false,
    crashLoop: true,
    containers: [
      { name: 'vllm', ready: false, restarts: 17, state: 'waiting', reason: 'CrashLoopBackOff' },
    ],
  },
  {
    // 演示用故障 ②：Pending（节点 GPU 资源不足，调度不上去）
    namespace: 'inference',
    name: 'vllm-llama70b-0',
    phase: 'Pending',
    ready: '0/1',
    restarts: 0,
    node: '',
    ip: '',
    created: iso(18 * MINUTE),
    oom: false,
    crashLoop: false,
    containers: [
      { name: 'vllm', ready: false, restarts: 0, state: 'waiting', reason: 'ContainerCreating' },
    ],
  },
  {
    namespace: 'monitoring',
    name: 'prometheus-server-0',
    phase: 'Running',
    ready: '1/1',
    restarts: 0,
    node: 'k3s-infer-node-1',
    ip: '10.42.2.8',
    created: iso(21 * DAY),
    oom: false,
    crashLoop: false,
    containers: [{ name: 'prometheus', ready: true, restarts: 0, state: 'running' }],
  },
  {
    namespace: 'monitoring',
    name: 'grafana-6b9f8d7c5-w9r4n',
    phase: 'Running',
    ready: '1/1',
    restarts: 2,
    node: 'k3s-infer-node-1',
    ip: '10.42.2.9',
    created: iso(21 * DAY),
    oom: false,
    crashLoop: false,
    containers: [{ name: 'grafana', ready: true, restarts: 2, state: 'running' }],
  },
];

/** 6 个工作负载（Deployment / StatefulSet / DaemonSet），其中 1 个未就绪 */
const K8S_WORKLOADS = [
  {
    namespace: 'inference',
    name: 'vllm-qwen27b',
    kind: 'Deployment',
    desired: 2,
    ready: 2,
    upToDate: 2,
    available: 2,
    created: iso(3 * DAY),
  },
  {
    namespace: 'inference',
    name: 'vllm-canary',
    kind: 'Deployment',
    desired: 1,
    ready: 0,
    upToDate: 1,
    available: 0,
    created: iso(41 * MINUTE),
  },
  {
    namespace: 'inference',
    name: 'sglang-router',
    kind: 'Deployment',
    desired: 1,
    ready: 1,
    upToDate: 1,
    available: 1,
    created: iso(3 * DAY),
  },
  {
    namespace: 'inference',
    name: 'embedding-bge-m3',
    kind: 'Deployment',
    desired: 1,
    ready: 1,
    upToDate: 1,
    available: 1,
    created: iso(2 * DAY),
  },
  {
    namespace: 'monitoring',
    name: 'prometheus-server',
    kind: 'StatefulSet',
    desired: 1,
    ready: 1,
    upToDate: 1,
    available: 1,
    created: iso(21 * DAY),
  },
  {
    namespace: 'monitoring',
    name: 'node-exporter',
    kind: 'DaemonSet',
    desired: 1,
    ready: 1,
    upToDate: 1,
    available: 1,
    created: iso(21 * DAY),
  },
];

/** overview 只回 Warning 事件（与前端「Warning 事件」卡片同口径） */
const K8S_EVENTS = [
  {
    namespace: 'inference',
    type: 'Warning',
    reason: 'BackOff',
    object: 'Pod/inference/vllm-canary-0',
    message: 'Back-off restarting failed container vllm in pod vllm-canary-0_inference',
    count: 46,
    lastSeen: iso(2 * HOUR),
  },
  {
    namespace: 'inference',
    type: 'Warning',
    reason: 'FailedScheduling',
    object: 'Pod/inference/vllm-llama70b-0',
    message: '0/1 nodes are available: 1 Insufficient nvidia.com/gpu. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.',
    count: 12,
    lastSeen: iso(18 * MINUTE),
  },
  {
    namespace: 'monitoring',
    type: 'Warning',
    reason: 'Unhealthy',
    object: 'Pod/monitoring/grafana-6b9f8d7c5-w9r4n',
    message: 'Liveness probe failed: HTTP probe failed with statuscode: 503',
    count: 3,
    lastSeen: iso(35 * MINUTE),
  },
];

/** GET /api/k8s/clusters/:id/overview（cluster + nodes + pods + workloads + events + summary） */
export function demoK8sOverview(_clusterId) {
  const cluster = clone(K8S_CONTEXT);
  const nodes = clone(K8S_NODES);
  const pods = clone(K8S_PODS);
  const workloads = clone(K8S_WORKLOADS);
  const events = clone(K8S_EVENTS);
  const unhealthy = pods.filter(
    (p) => (p.phase !== 'Running' && p.phase !== 'Succeeded') || p.oom === true || p.crashLoop === true,
  ).length;

  return {
    cluster,
    nodes,
    pods,
    workloads,
    events,
    // 与 k8sResources.summarize() 逐字段一致
    summary: {
      nodes: nodes.length,
      nodesReady: nodes.filter((n) => n.ready === true).length,
      pods: pods.length,
      podsRunning: pods.filter((p) => p.phase === 'Running').length,
      podsUnhealthy: unhealthy,
      workloads: workloads.length,
      workloadsUnready: workloads.filter((w) => w.ready < w.desired).length,
      warningEvents: events.filter((e) => e.type === 'Warning').length,
    },
    warnings: [],
  };
}

/**
 * GET /api/k8s/clusters/:id/pods/:namespace/:pod/logs → `{ logs: string }`
 * （真实实现把 kubelet 返回的整段文本原样返回，不是行数组）
 */
export function demoK8sPodsLogs(opts = {}) {
  const { ns, pod } = opts || {};
  const namespace = String(ns || 'inference');
  const name = String(pod || 'vllm-qwen27b-1');
  const header = [
    `INFO 06-08 09:44:02 [api_server.py:1287] serving on http://0.0.0.0:8000 (pod ${name}, ns ${namespace})`,
    'INFO 06-08 09:44:03 [logger.py:120] Engine 000: Avg prompt throughput: 918.4 tokens/s, Avg generation throughput: 210.2 tokens/s, Running: 2 reqs',
    'INFO 06-08 09:45:11 [logger.py:120] Engine 000: Running: 3 reqs, Waiting: 0 reqs, GPU KV cache usage: 44.7%',
    'WARN 06-08 09:46:20 [core.py:214] Sequence group 4d8b1f preempted: KV cache 92.1% > watermark 90.0%',
    'INFO 06-08 09:47:02 [logger.py:120] Running: 2 reqs, Waiting: 0 reqs, GPU KV cache usage: 51.3%',
    'ERROR 06-08 09:47:41 [serving_chat.py:238] ValueError: prompt length 20480 exceeds max_model_len 16384, request rejected',
    'INFO 06-08 09:48:07 [logger.py:120] Running: 2 reqs, Waiting: 0 reqs, GPU KV cache usage: 49.8%',
  ];
  // CrashLoop 的 Pod 多给几行"起不来"的证据，演示排障才有东西可看
  const crash = /canary|crash/i.test(name)
    ? [
      'WARN 06-08 09:48:02 [core.py:588] free memory on device cuda:0 (1.42 GiB) is less than desired GPU memory utilization',
      'ERROR 06-08 09:48:09 [core.py:602] torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.25 GiB',
      'ERROR 06-08 09:48:09 [core.py:602] EngineCore failed to start.',
    ]
    : [];

  return { logs: [...header, ...crash].join('\n') };
}
