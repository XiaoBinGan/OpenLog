/**
 * 演示模式（OPENLOG_DEMO=1）在路由层的接线测试
 *
 * 契约见 /tmp/demo-contract.md。这里只验证路由层三件事：
 *   1. 演示模式下「读真实资源」的端点返回 fixture + `demo: true`，**且一次都没有碰真实依赖**
 *      （Docker / SSH / K8s apiserver / nvidia-smi / 磁盘 / TSDB 存储）—— 用 spy 断言 0 次；
 *   2. 演示模式下写操作（容器启停删、远程执行、K8s 增删改、设置写入、分析触发）一律 409 + DEMO_DISABLED；
 *   3. 关闭演示模式时行为不变：同一批读端点会真的走到真实依赖。
 *
 * 为什么 `vi.mock('../demo/fixtures.js')`：fixtures 由另一个 agent 并行实现，
 * 测试不能依赖它的真实数据（也不能因为它是空壳而失败）。同理 Docker / remote / GPU /
 * K8s / TSDB 全部 mock —— 这个文件永远不该建立真实连接。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';

// ─────────────────────────────────────────────────────────────
// 演示数据（形状与真实路由的响应一致，值是假的）
// ─────────────────────────────────────────────────────────────
const DEMO_CONTAINERS = [
  {
    id: 'c-1',
    name: 'vllm-4090',
    state: 'running',
    status: 'Up 3 hours',
    image: 'vllm/vllm-openai:latest',
    ports: '0.0.0.0:8000->8000/tcp',
  },
];
const DEMO_DOCKER_SOURCES = [
  { sourceId: 'demo-local', sourceName: '演示 Docker（4090×4）', host: '192.0.2.10', serverId: 'srv-4090', containers: DEMO_CONTAINERS },
];
const DEMO_DOCKER_LOGS = [
  { timestamp: '2026-11-22T00:00:01.000Z', level: 'INFO', content: 'INFO: Started server process [1]' },
  { timestamp: '2026-11-22T00:00:09.000Z', level: 'ERROR', content: 'CUDA out of memory: tried to allocate 2.00 GiB' },
];
const DEMO_HEALTH = {
  summary: { total: 7, running: 5, oomKilled: 1, errorExited: 1, normalExited: 0, ignoredStale: 0, ignoredUnobserved: 0, staleHours: 24 },
  problems: [{ name: 'embed-1', sourceName: '演示 Docker', exitCode: 137, exitType: 'oom', errors: ['CUDA out of memory'] }],
};
const DEMO_GPU = {
  devices: [
    { index: 0, name: 'NVIDIA GeForce RTX 4090', utilization: 62, memoryUsed: 18_000, memoryTotal: 24_000, temperature: 66 },
  ],
  summary: { count: 1, avgUtilization: 62, totalMemory: 24_000, usedMemory: 18_000 },
};
const DEMO_GPU_SUMMARY = { count: 4, avgUtilization: 55, totalMemory: 96_000, usedMemory: 60_000 };
const DEMO_SERVERS = [
  { id: 'srv-4090', name: '4090×4', host: '192.0.2.10', port: 22, username: 'root', status: 'connected' },
  { id: 'srv-t4', name: '4卡T4', host: '192.0.2.11', port: 22, username: 'root', status: 'disconnected' },
];
const demoStatsFor = (id) => ({
  cpu: { cores: 32, load: 37.5 },
  memory: { used: 61_000_000_000, total: 128_000_000_000 },
  disk: [{ name: '/', usePercent: 41 }],
  gpus: id === 'srv-4090'
    ? [{ index: 0, name: 'NVIDIA GeForce RTX 4090', utilization: 62, memoryUsed: 18_000, memoryTotal: 24_000, temperature: 66 }]
    : [],
});
const DEMO_MFU = { available: true, engine: 'vllm', mfu: 0.42, promptTokensPerSec: 1_820, generationTokensPerSec: 640 };
const DEMO_LOG_ROWS = [
  { timestamp: '2026-11-22T00:00:01.000Z', level: 'INFO', content: 'INFO 06-08 09:46:02 Engine 000: Avg prompt throughput: 897.6 tokens/s' },
  // 第二行用 Log 记录的 `message` 字段（与真实 fixture 一致），锁住「message → 文本」的兜底
  { timestamp: '2026-11-22T00:00:07.000Z', level: 'ERROR', message: 'ERROR 06-08 09:46:08 CUDA out of memory: tried to allocate 2.00 GiB' },
];
const DEMO_LOG_FILES = [
  { name: 'demo-app.log', path: '/var/log/openlog/demo-app.log', size: 20_480 },
];
const DEMO_TSDB = {
  resultType: 'matrix',
  result: [{ metric: { __name__: 'gpu_utilization', device: '0' }, values: [[1_763_760_000, '62']] }],
};
const DEMO_K8S_CLUSTERS = [
  { id: 'demo-k8s-1', name: '演示集群', server: 'https://demo-k8s.test:6443', context: 'demo', authType: 'cert', enabled: true, hasKubeconfig: true },
];
const DEMO_K8S_OVERVIEW = {
  cluster: { version: 'v1.30.2', server: 'https://demo-k8s.test:6443', context: 'demo' },
  nodes: [{ name: 'node-1', status: 'Ready' }],
  pods: [
    { namespace: 'llm', name: 'vllm-0', phase: 'Running' },
    { namespace: 'llm', name: 'sglang-0', phase: 'CrashLoopBackOff' },
  ],
  workloads: [{ kind: 'Deployment', namespace: 'llm', name: 'vllm' }],
  events: [
    { type: 'Warning', namespace: 'llm', reason: 'BackOff', message: 'Back-off restarting failed container' },
    { type: 'Normal', namespace: 'llm', reason: 'Pulled', message: 'Successfully pulled image' },
  ],
  summary: { nodes: 1, pods: 2, notRunningPods: 1, warnings: 1 },
  warnings: [],
};
const DEMO_POD_LOG = '2026-11-22T00:00:01Z INFO: vLLM engine started\n2026-11-22T00:00:06Z ERROR: CUDA error: out of memory\n';

vi.mock('../demo/fixtures.js', () => ({
  demoDockerSources: vi.fn(() => DEMO_DOCKER_SOURCES),
  demoDockerLogs: vi.fn(() => DEMO_DOCKER_LOGS),
  demoDockerHealthCheck: vi.fn(() => DEMO_HEALTH),
  demoGpuPayload: vi.fn(() => DEMO_GPU),
  demoGpuSummary: vi.fn(() => DEMO_GPU_SUMMARY),
  demoRemoteServers: vi.fn(() => DEMO_SERVERS),
  demoRemoteStats: vi.fn((serverId) => demoStatsFor(serverId)),
  demoMfu: vi.fn(() => DEMO_MFU),
  demoLogFiles: vi.fn(() => DEMO_LOG_FILES),
  demoLogTail: vi.fn(() => ({ logs: DEMO_LOG_ROWS, fileInfo: { size: 4821337, modified: '2026-11-22 00:00:00 +0000' }, totalLines: 42 })),
  demoTsdbQuery: vi.fn(() => DEMO_TSDB),
  demoK8sClusters: vi.fn(() => DEMO_K8S_CLUSTERS),
  demoK8sOverview: vi.fn(() => DEMO_K8S_OVERVIEW),
  demoK8sPodsLogs: vi.fn(() => DEMO_POD_LOG),
}));

// ─────────────────────────────────────────────────────────────
// 真实依赖（全部 mock：这个测试永远不该建立连接）
// ─────────────────────────────────────────────────────────────
vi.mock('../docker.js', () => ({
  listContainers: vi.fn(async () => DEMO_CONTAINERS),
  getContainerLogs: vi.fn(async () => DEMO_DOCKER_LOGS),
  healthCheck: vi.fn(async () => DEMO_HEALTH),
  inspectContainer: vi.fn(async () => ({})),
  getDocker: vi.fn(() => ({ getContainer: () => ({ inspect: async () => ({}) }) })),
  pingDocker: vi.fn(async () => ({ ok: true })),
  execInContainer: vi.fn(async () => ({ output: '' })),
  traceContainerLinks: vi.fn(async () => ({ links: [] })),
  patrolContainerLogs: vi.fn(async () => []),
  resetPatrolCheckpoints: vi.fn(),
  startContainer: vi.fn(async () => ({ ok: true })),
  stopContainer: vi.fn(async () => ({ ok: true })),
  restartContainer: vi.fn(async () => ({ ok: true })),
  pauseContainer: vi.fn(async () => ({ ok: true })),
  unpauseContainer: vi.fn(async () => ({ ok: true })),
  removeContainer: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../remote.js', () => ({
  getServers: vi.fn(() => DEMO_SERVERS),
  addServer: vi.fn(() => ({ id: 'srv-new' })),
  updateServer: vi.fn(() => ({ id: 'srv-4090' })),
  deleteServer: vi.fn(() => true),
  testConnection: vi.fn(async () => ({ ok: true })),
  execRemoteCommand: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
  execShellCommand: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
  getRemoteSystemStats: vi.fn(async (id) => demoStatsFor(id)),
  connectServer: vi.fn(async () => ({})),
  disconnectServer: vi.fn(async () => ({})),
  listRemoteFiles: vi.fn(async () => []),
  readRemoteFile: vi.fn(async () => ''),
  writeRemoteFile: vi.fn(async () => ({ ok: true })),
  remoteFileOp: vi.fn(async () => ({ ok: true })),
  uploadRemoteFile: vi.fn(async () => ({ ok: true })),
  initChunkedUpload: vi.fn(async () => ({ uploadId: 'u1' })),
  uploadChunk: vi.fn(async () => ({ ok: true })),
  completeChunkedUpload: vi.fn(async () => ({ ok: true })),
  cancelChunkedUpload: vi.fn(async () => ({ ok: true })),
  importServers: vi.fn(async () => ({ ok: true })),
  exportServers: vi.fn(() => ({ servers: [] })),
  searchRemote: vi.fn(async () => ({ results: [] })),
  searchRemoteLogs: vi.fn(async () => ({ results: [], files: [], total: 0 })),
  readRemoteFileRaw: vi.fn(async () => ({ content: '' })),
  getRemoteLogs: vi.fn(async () => ({ logs: [] })),
}));

vi.mock('../docker-ssh-bridge.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ensureDockerBridge: vi.fn(async () => '/tmp/openlog-demo-test-bridge.sock') };
});

vi.mock('../gpu.js', () => ({
  getLocalGPUs: vi.fn(async () => DEMO_GPU.devices),
  getRemoteGPUs: vi.fn(async () => DEMO_GPU.devices),
  getGPUs: vi.fn(async () => DEMO_GPU.devices),
  getGPUSummary: vi.fn(() => DEMO_GPU.summary),
  buildRemoteGPUPayload: vi.fn(() => DEMO_GPU),
  loadGPUConfigs: vi.fn(() => []),
  saveGPUConfigs: vi.fn(),
  maskGpuConfigs: vi.fn((c) => c),
  mergeGpuConfigs: vi.fn((incoming) => incoming),
}));

vi.mock('../gpu-mfu.js', () => ({
  getRemoteMfu: vi.fn(async () => DEMO_MFU),
}));

vi.mock('../k8s/store.js', () => ({
  listClusters: vi.fn(() => []),
  getClusterRecord: vi.fn(() => null),
  upsertCluster: vi.fn(() => ({ record: null, settings: {} })),
  deleteCluster: vi.fn(() => ({ settings: {} })),
  toView: vi.fn((r) => ({
    id: r.id, name: r.name, context: r.context || '', server: r.server || '',
    enabled: r.enabled !== false, authType: 'cert', hasKubeconfig: true,
  })),
}));

vi.mock('../k8s/client.js', () => ({
  createK8sClient: vi.fn(() => ({
    apiServerVersion: async () => ({ version: 'v1.30.2' }),
    getJson: async () => ({ items: [] }),
    getText: async () => '',
  })),
}));

// ─────────────────────────────────────────────────────────────
// 被测路由
// ─────────────────────────────────────────────────────────────
import * as dockerModule from '../docker.js';
import * as remoteModule from '../remote.js';
import * as gpuModule from '../gpu.js';
import * as gpuMfuModule from '../gpu-mfu.js';
import * as k8sStore from '../k8s/store.js';
import * as k8sClient from '../k8s/client.js';
import createDockerRouter from '../routes/docker.js';
import gpuRouter from '../routes/gpu.js';
import createRemoteRouter from '../routes/remote.js';
import createLogsRouter from '../routes/logs.js';
import createK8sRouter from '../routes/k8s.js';
import { createPrometheusRouter } from '../routes/prometheus.js';

// 真实模式下的 docker 源（演示模式下这份设置完全不该被用到）
const settings = {
  dockerSources: [{ id: 'real-src', name: '真实 Docker', host: '127.0.0.1', port: 2375, enabled: true }],
};

const statsScheduler = {
  ensure: vi.fn(async () => {}),
  snapshot: vi.fn(() => ({ servers: [], meta: { total: 0 } })),
  isFresh: vi.fn(() => false),
  get: vi.fn(() => null),
};

const tsdbStore = {
  queryRange: vi.fn(async () => []),
  listSeries: vi.fn(async () => []),
  labelValues: vi.fn(async () => []),
  listMetricNames: vi.fn(async () => []),
  stats: vi.fn(async () => ({ series: 0 })),
};

const logBuffer = [];

const app = express();
app.use(express.json());
app.use(createDockerRouter({
  ensureSettings: () => settings,
  broadcast: () => {},
  addAnalysisRecord: () => {},
  buildHostExecMap: () => new Map(),
  stripThinking: (s) => s,
  getLastPatrolResults: () => [],
  setLastPatrolResults: () => {},
}));
app.use(gpuRouter);
app.use(createRemoteRouter({
  ensureSettings: () => settings,
  stripThinking: (s) => s,
  statsScheduler,
}));
app.use(createLogsRouter({
  logs: logBuffer,
  ensureSettings: () => ({}),
  saveLog: () => {},
  broadcast: () => {},
}));
app.use(createK8sRouter({ ensureSettings: () => settings, saveSettings: () => {} }));
app.use(createPrometheusRouter({ store: tsdbStore, auth: (req, res, next) => next() }));

let server;
let base;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

/** 统一请求助手：返回 { status, body } */
async function api(pathname, init) {
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

function jsonPost(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
}

/** 断言「演示模式写操作被拒」：409 + DEMO_DISABLED 的中文原因 + demo 标记 */
function expectDemoDisabled(r) {
  expect(r.status).toBe(409);
  expect(r.body?.demo).toBe(true);
  expect(String(r.body?.error || '')).toContain('演示模式');
}

/** 每个真实依赖的 spy 调用总数（用 0 次断言「一次都没碰真实资源」） */
const realDependencySpies = () => [
  dockerModule.listContainers, dockerModule.getContainerLogs, dockerModule.healthCheck,
  dockerModule.inspectContainer, dockerModule.startContainer, dockerModule.stopContainer,
  dockerModule.restartContainer, dockerModule.removeContainer, dockerModule.execInContainer,
  dockerModule.pingDocker, dockerModule.patrolContainerLogs,
  remoteModule.getServers, remoteModule.getRemoteSystemStats, remoteModule.execRemoteCommand,
  remoteModule.execShellCommand, remoteModule.addServer, remoteModule.updateServer,
  remoteModule.deleteServer, remoteModule.testConnection,
  remoteModule.listRemoteFiles, remoteModule.readRemoteFile, remoteModule.readRemoteFileRaw,
  remoteModule.searchRemoteLogs,
  gpuModule.getLocalGPUs, gpuModule.getRemoteGPUs, gpuModule.getGPUs, gpuModule.getGPUSummary,
  gpuModule.buildRemoteGPUPayload, gpuModule.loadGPUConfigs, gpuModule.saveGPUConfigs,
  gpuMfuModule.getRemoteMfu,
  k8sStore.listClusters, k8sStore.getClusterRecord, k8sStore.upsertCluster, k8sStore.deleteCluster,
  k8sClient.createK8sClient,
  statsScheduler.ensure, statsScheduler.snapshot,
  tsdbStore.queryRange, tsdbStore.listSeries, tsdbStore.stats,
];

function expectNoRealDependencyCalls() {
  const called = realDependencySpies()
    .map((spy, i) => [i, spy?.mock?.calls?.length || 0])
    .filter(([, n]) => n > 0);
  expect(called, `演示模式下不该调用真实依赖（索引→次数）: ${JSON.stringify(called)}`).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  logBuffer.length = 0;
});

// ═════════════════════════════════════════════════════════════
// 1) 演示模式：读接口 → fixture + demo:true，真实依赖 0 次调用
// ═════════════════════════════════════════════════════════════
describe('演示模式 · 读接口返回 fixture 且不碰真实依赖', () => {
  beforeEach(() => { vi.stubEnv('OPENLOG_DEMO', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('GET /api/docker/containers → 演示 sources[]', async () => {
    const r = await api('/api/docker/containers');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.sources).toEqual(DEMO_DOCKER_SOURCES);
    expect(dockerModule.listContainers).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/docker/containers/:sourceId/:containerId/logs → 演示日志（sourceId 白名单走演示源）', async () => {
    const r = await api('/api/docker/containers/demo-local/c-1/logs?tail=50');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.containerId).toBe('c-1');
    expect(r.body.sourceId).toBe('demo-local');
    expect(r.body.logs).toEqual(DEMO_DOCKER_LOGS);
    expect(dockerModule.getContainerLogs).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/docker/health-check → 演示健康报告', async () => {
    const r = await api('/api/docker/health-check');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.summary.oomKilled).toBe(1);
    expect(dockerModule.healthCheck).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/gpu/local → 演示设备 + summary', async () => {
    const r = await api('/api/gpu/local');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.devices).toEqual(DEMO_GPU.devices);
    expect(r.body.summary).toEqual(DEMO_GPU.summary);
    expect(gpuModule.getLocalGPUs).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/gpu/remote-server/:serverId → 演示设备（不发 nvidia-smi）', async () => {
    const r = await api('/api/gpu/remote-server/srv-4090');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.devices.length).toBeGreaterThan(0);
    expect(remoteModule.execRemoteCommand).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/gpu/remote 与 POST /api/gpu/query → 演示设备（不建 SSH、不查本机）', async () => {
    const remoteRes = await api('/api/gpu/remote?host=192.0.2.10&sshUser=root');
    expect(remoteRes.status).toBe(200);
    expect(remoteRes.body.demo).toBe(true);
    expect(gpuModule.getRemoteGPUs).not.toHaveBeenCalled();

    const queryRes = await api('/api/gpu/query', jsonPost({ remote: true, host: '192.0.2.10', sshUser: 'root' }));
    expect(queryRes.status).toBe(200);
    expect(queryRes.body.demo).toBe(true);
    expect(gpuModule.getGPUs).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/remote/servers → 演示服务器清单', async () => {
    const r = await api('/api/remote/servers');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.servers).toEqual(DEMO_SERVERS);
    expect(remoteModule.getServers).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/remote/servers/stats（批量快照）→ 演示快照，不触发采集器', async () => {
    const r = await api('/api/remote/servers/stats?refresh=1');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.servers.map((s) => s.serverId)).toEqual(DEMO_SERVERS.map((s) => s.id));
    expect(r.body.meta.total).toBe(DEMO_SERVERS.length);
    expect(statsScheduler.ensure).not.toHaveBeenCalled();
    expect(statsScheduler.snapshot).not.toHaveBeenCalled();

    // ?fields=gpu 瘦身分支：只回显卡相关字段（算力监控页走这条）
    const slim = await api('/api/remote/servers/stats?fields=gpu');
    expect(slim.status).toBe(200);
    expect(slim.body.demo).toBe(true);
    expect(slim.body.servers[0].gpus.length).toBeGreaterThan(0);
    expectNoRealDependencyCalls();
  });

  it('GET /api/remote/servers/:id/stats 与 /mfu → 演示 stats / MFU', async () => {
    const stats = await api('/api/remote/servers/srv-4090/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.demo).toBe(true);
    expect(stats.body.gpus.length).toBeGreaterThan(0);
    expect(remoteModule.getRemoteSystemStats).not.toHaveBeenCalled();

    const mfu = await api('/api/remote/servers/srv-4090/mfu');
    expect(mfu.status).toBe(200);
    expect(mfu.body.demo).toBe(true);
    expect(mfu.body.mfu).toBe(DEMO_MFU.mfu);
    expect(gpuMfuModule.getRemoteMfu).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/logs/files → 演示文件列表（数组形状不变，逐项带 demo:true）', async () => {
    const existsSpy = vi.spyOn(fs, 'existsSync');
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    try {
      const r = await api('/api/logs/files');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body).toHaveLength(DEMO_LOG_FILES.length);
      expect(r.body[0]).toMatchObject({ name: 'demo-app.log', demo: true });
      expect(existsSpy).not.toHaveBeenCalled();
      expect(readdirSpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  it('GET /api/v1/query 与 /api/v1/query_range → 演示时序数据（不查存储）', async () => {
    const instant = await api('/api/v1/query?query=gpu_utilization');
    expect(instant.status).toBe(200);
    expect(instant.body.demo).toBe(true);
    expect(instant.body.status).toBe('success');
    expect(instant.body.data).toEqual(DEMO_TSDB);
    expect(tsdbStore.queryRange).not.toHaveBeenCalled();

    const range = await api('/api/v1/query_range?query=gpu_utilization&start=1&end=3600&step=60');
    expect(range.status).toBe(200);
    expect(range.body.demo).toBe(true);
    expect(range.body.status).toBe('success');
    expect(tsdbStore.queryRange).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/k8s/clusters → 演示集群（只改响应，不写 settings）', async () => {
    const r = await api('/api/k8s/clusters');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.clusters).toEqual(DEMO_K8S_CLUSTERS);
    expect(k8sStore.listClusters).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/k8s/clusters/:id/overview|pods|events|pods/:ns/:pod/logs → 演示数据（不建 K8s client）', async () => {
    const overview = await api('/api/k8s/clusters/demo-k8s-1/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.demo).toBe(true);
    expect(overview.body.pods).toHaveLength(2);

    const pods = await api('/api/k8s/clusters/demo-k8s-1/pods?namespace=llm');
    expect(pods.status).toBe(200);
    expect(pods.body.demo).toBe(true);
    expect(pods.body.pods.map((p) => p.name)).toEqual(['vllm-0', 'sglang-0']);

    const events = await api('/api/k8s/clusters/demo-k8s-1/events?type=Warning');
    expect(events.status).toBe(200);
    expect(events.body.events.every((e) => e.type === 'Warning')).toBe(true);

    const logs = await api('/api/k8s/clusters/demo-k8s-1/pods/llm/vllm-0/logs?tail=100');
    expect(logs.status).toBe(200);
    expect(logs.body.demo).toBe(true);
    expect(logs.body.logs).toBe(DEMO_POD_LOG);

    expect(k8sClient.createK8sClient).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('GET /api/docker/containers/:sid/:cid|trace、POST /api/docker/logs/batch → 演示数据（连不上真实 Docker）', async () => {
    const detail = await api('/api/docker/containers/demo-local/c-1');
    expect(detail.status).toBe(200);
    expect(detail.body.demo).toBe(true);
    expect(detail.body.containerId).toBe('c-1');

    const trace = await api('/api/docker/trace/demo-local/c-1');
    expect(trace.status).toBe(200);
    expect(trace.body.demo).toBe(true);
    expect(trace.body.upstream).toEqual([]);

    const batch = await api('/api/docker/logs/batch', jsonPost({ containers: [{ sourceId: 'demo-local', containerId: 'c-1', name: 'vllm-4090' }], tail: 50 }));
    expect(batch.status).toBe(200);
    expect(batch.body.demo).toBe(true);
    expect(batch.body.results[0]).toMatchObject({ sourceId: 'demo-local', containerId: 'c-1', ok: true });
    expect(batch.body.results[0].logs).toEqual(DEMO_DOCKER_LOGS);

    expect(dockerModule.getDocker).not.toHaveBeenCalled();
    expect(dockerModule.traceContainerLinks).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('远程文件浏览 / 日志 tail / 搜索 / 读文件 → 演示数据（不建 SSH）', async () => {
    const files = await api('/api/remote/servers/srv-4090/files?path=/data/logs');
    expect(files.status).toBe(200);
    expect(files.body.demo).toBe(true);
    expect(files.body.files[0]).toMatchObject({ name: 'demo-app.log', isLog: true });

    const tail = await api('/api/remote/servers/srv-4090/logs?file=/data/logs/demo-app.log&lines=50');
    expect(tail.status).toBe(200);
    expect(tail.body.demo).toBe(true);
    expect(tail.body.logs).toEqual(DEMO_LOG_ROWS);
    // fixture 的 totalLines/fileInfo 要原样透传（前端用它显示「共 N 行」与文件大小）
    expect(tail.body.totalLines).toBe(42);
    expect(tail.body.fileInfo.size).toBe(4821337);

    const search = await api('/api/remote/servers/srv-4090/search?q=cuda');
    expect(search.status).toBe(200);
    expect(search.body.demo).toBe(true);
    expect(search.body.results).toHaveLength(1);
    expect(search.body.total).toBe(1);

    const read = await api('/api/remote/servers/srv-4090/file/read?path=/data/logs/demo-app.log');
    expect(read.status).toBe(200);
    expect(read.body.demo).toBe(true);
    expect(read.body.content).toContain('CUDA out of memory');

    expect(remoteModule.listRemoteFiles).not.toHaveBeenCalled();
    expect(remoteModule.readRemoteFile).not.toHaveBeenCalled();
    expect(remoteModule.readRemoteFileRaw).not.toHaveBeenCalled();
    expect(remoteModule.searchRemoteLogs).not.toHaveBeenCalled();
    expectNoRealDependencyCalls();
  });

  it('演示模式下不存在的演示集群/源仍然 404（不要用假数据兜住拼错的 id）', async () => {
    const cluster = await api('/api/k8s/clusters/nope/overview');
    expect(cluster.status).toBe(404);
    const source = await api('/api/docker/containers/nope/c-1/logs');
    expect(source.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════
// 2) 演示模式：写操作 → 409 + DEMO_DISABLED
// ═════════════════════════════════════════════════════════════
describe('演示模式 · 写操作一律 409 + DEMO_DISABLED', () => {
  beforeEach(() => { vi.stubEnv('OPENLOG_DEMO', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('容器 start/stop/restart/remove、exec、连接测试全部拒绝', async () => {
    expectDemoDisabled(await api('/api/docker/demo-local/c-1/stop', jsonPost()));
    expectDemoDisabled(await api('/api/docker/demo-local/c-1/start', jsonPost()));
    expectDemoDisabled(await api('/api/docker/demo-local/c-1/restart', jsonPost()));
    expectDemoDisabled(await api('/api/docker/demo-local/c-1', { method: 'DELETE' }));
    expectDemoDisabled(await api('/api/docker/demo-local/c-1/exec', jsonPost({ command: 'ls' })));
    expectDemoDisabled(await api('/api/docker/ping', jsonPost({ sourceId: 'demo-local' })));

    expect(dockerModule.stopContainer).not.toHaveBeenCalled();
    expect(dockerModule.startContainer).not.toHaveBeenCalled();
    expect(dockerModule.restartContainer).not.toHaveBeenCalled();
    expect(dockerModule.removeContainer).not.toHaveBeenCalled();
    expect(dockerModule.execInContainer).not.toHaveBeenCalled();
    expect(dockerModule.pingDocker).not.toHaveBeenCalled();
  });

  it('分析/巡检触发全部拒绝（不读真实日志、不调 LLM）', async () => {
    expectDemoDisabled(await api('/api/docker/analyze/batch', jsonPost({ containers: [{ sourceId: 'demo-local', containerId: 'c-1' }] })));
    expectDemoDisabled(await api('/api/docker/health-check/analyze', jsonPost()));
    expectDemoDisabled(await api('/api/docker/patrol/now', jsonPost()));
    expectDemoDisabled(await api('/api/docker/patrol/reset', jsonPost()));
    expectDemoDisabled(await api('/api/docker/patrol/analyze', jsonPost()));
    expectDemoDisabled(await api('/api/docker/container/demo-local/c-1/analyze', jsonPost()));
    expectDemoDisabled(await api('/api/docker/container/demo-local/c-1/diagnose', jsonPost()));
    expect(dockerModule.patrolContainerLogs).not.toHaveBeenCalled();
    expect(dockerModule.inspectContainer).not.toHaveBeenCalled();
  });

  it('GPU 配置写入被拒（不落盘）', async () => {
    expectDemoDisabled(await api('/api/gpu/configs', jsonPost({ configs: [{ id: 'g1' }] })));
    expect(gpuModule.saveGPUConfigs).not.toHaveBeenCalled();
  });

  it('远程服务器增删改 / 连接 / 执行 / AI Shell 全部拒绝（不建 SSH）', async () => {
    expectDemoDisabled(await api('/api/remote/servers', jsonPost({ name: 'x', host: '192.0.2.9', username: 'root' })));
    expectDemoDisabled(await api('/api/remote/servers/srv-4090', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    expectDemoDisabled(await api('/api/remote/servers/srv-4090', { method: 'DELETE' }));
    expectDemoDisabled(await api('/api/remote/test', jsonPost({ host: '192.0.2.9', username: 'root' })));
    expectDemoDisabled(await api('/api/remote/servers/srv-4090/exec', jsonPost({ command: 'uptime' })));
    expectDemoDisabled(await api('/api/remote/servers/srv-4090/shell', jsonPost({ command: 'uptime' })));
    expectDemoDisabled(await api('/api/remote/srv-4090/aishell', jsonPost({ prompt: '看看显卡' })));

    expect(remoteModule.addServer).not.toHaveBeenCalled();
    expect(remoteModule.updateServer).not.toHaveBeenCalled();
    expect(remoteModule.deleteServer).not.toHaveBeenCalled();
    expect(remoteModule.testConnection).not.toHaveBeenCalled();
    expect(remoteModule.execRemoteCommand).not.toHaveBeenCalled();
    expect(remoteModule.execShellCommand).not.toHaveBeenCalled();
  });

  it('K8s 集群增删改 / 连通性测试拒绝（不连 apiserver、不写 settings）', async () => {
    expectDemoDisabled(await api('/api/k8s/clusters', jsonPost({ name: 'x', kubeconfig: 'apiVersion: v1' })));
    expectDemoDisabled(await api('/api/k8s/clusters/demo-k8s-1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    expectDemoDisabled(await api('/api/k8s/clusters/demo-k8s-1', { method: 'DELETE' }));
    expectDemoDisabled(await api('/api/k8s/clusters/demo-k8s-1/test', jsonPost()));

    expect(k8sStore.upsertCluster).not.toHaveBeenCalled();
    expect(k8sStore.deleteCluster).not.toHaveBeenCalled();
    expect(k8sClient.createK8sClient).not.toHaveBeenCalled();
  });

  it('日志清空 / 分析 / 修复 / 生成样例 与 TSDB 测试通知拒绝', async () => {
    logBuffer.push({ id: 'l1', level: 'INFO', message: 'keep me' });
    expectDemoDisabled(await api('/api/logs', { method: 'DELETE' }));
    expect(logBuffer).toHaveLength(1); // 演示模式下缓冲不能被清空

    expectDemoDisabled(await api('/api/logs/analyze', jsonPost({ logs: [] })));
    expectDemoDisabled(await api('/api/logs/fix', jsonPost({ logs: [], error: 'x' })));
    expectDemoDisabled(await api('/api/logs/generate-sample', jsonPost()));
    expectDemoDisabled(await api('/api/tsdb/test-notify', jsonPost()));
  });
});

// ═════════════════════════════════════════════════════════════
// 3) 关闭演示模式：走真实分支（spy 被调用），响应不带 demo 标记
// ═════════════════════════════════════════════════════════════
describe('关闭演示模式 · 行为与之前一致（真实依赖被调用）', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });

  it('GET /api/docker/containers → 调 docker.listContainers，响应无 demo 标记', async () => {
    expect(process.env.OPENLOG_DEMO).toBeUndefined();
    const r = await api('/api/docker/containers?refresh=1');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBeUndefined();
    expect(r.body.sources).toHaveLength(1);
    expect(r.body.sources[0].sourceId).toBe('real-src');
    expect(dockerModule.listContainers).toHaveBeenCalledTimes(1);
  });

  it('GET /api/remote/servers → 调 remote.getServers', async () => {
    const r = await api('/api/remote/servers');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBeUndefined();
    expect(remoteModule.getServers).toHaveBeenCalled();
  });

  it('GET /api/gpu/local → 调 gpu.getLocalGPUs + getGPUSummary', async () => {
    const r = await api('/api/gpu/local');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBeUndefined();
    expect(gpuModule.getLocalGPUs).toHaveBeenCalled();
    expect(gpuModule.getGPUSummary).toHaveBeenCalled();
  });

  it('GET /api/k8s/clusters → 调 store.listClusters', async () => {
    const r = await api('/api/k8s/clusters');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBeUndefined();
    expect(k8sStore.listClusters).toHaveBeenCalled();
  });

  it('GET /api/logs/files → 读真实日志目录（fs 被调用）', async () => {
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    try {
      const r = await api('/api/logs/files');
      expect(r.status).toBe(200);
      expect(existsSpy).toHaveBeenCalled();
      expect(readdirSpy).toHaveBeenCalled();
    } finally {
      readdirSpy.mockRestore();
      existsSpy.mockRestore();
    }
  });

  it('POST /api/docker/:sourceId/:containerId/stop → 真的下发容器操作（不是 409）', async () => {
    const r = await api('/api/docker/real-src/c-1/stop', jsonPost());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(dockerModule.stopContainer).toHaveBeenCalledTimes(1);
  });
});
