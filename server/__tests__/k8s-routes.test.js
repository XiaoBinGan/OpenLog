/**
 * routes/k8s.js 路由层测试（契约见 /tmp/k8s-contract.md）
 *
 * 四个领域模块（store / kubeconfig / client / resources）由其它 agent 并行实现，
 * 因此这里全部 `vi.mock` 成确定的假实现 —— 本测试只验证**路由语义**：
 * 路径、状态码（400/404/502）、响应结构、saveSettings 调用、overview 的部分失败降级、
 * 以及 logs 的 tail 边界。真实 kubeconfig 解析与 HTTP 客户端行为由各自的测试覆盖。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';

// ── 可变测试状态 ──────────────────────────────────────────────────
// vi.mock 的工厂是提升的，不能引用普通模块级变量；用 vi.hoisted 建一个共享盒子。
const h = vi.hoisted(() => ({
  settings: { k8sClusters: [] },
  sequence: 0,
  responses: {},
  failPaths: new Set(),
  failAll: false,
  failLogs: false,
  failVersion: false,
    versionObject: false,
  summarizeThrows: false,
  hamiThrows: false,
  logRequests: [],
  parseCalls: [],
  upsertInputs: [],
  saved: [],
}));

// ── 模块替换 ─────────────────────────────────────────────────────

vi.mock('../k8s/store.js', () => ({
  // 契约：store.listClusters() 直接返回视图（不含 kubeconfig 明文），路由层不再二次 toView。
  listClusters: vi.fn((settings) => (settings.k8sClusters || []).map((r) => ({
    id: r.id,
    name: r.name,
    context: r.context || '',
    server: r.server || '',
    enabled: r.enabled !== false,
    authType: r.authType === 'token' ? 'token' : 'cert',
    hasKubeconfig: Boolean(r.kubeconfig),
    updatedAt: r.updatedAt,
  }))),
  getClusterRecord: vi.fn((settings, id) => (settings.k8sClusters || []).find((c) => c.id === id) || null),
  upsertCluster: vi.fn((settings, input) => {
    h.upsertInputs.push({ ...input });
    const list = Array.isArray(settings.k8sClusters) ? settings.k8sClusters : (settings.k8sClusters = []);
    const id = input.id || `cluster-${++h.sequence}`;
    const record = { ...input, id, updatedAt: '2026-11-18T00:00:00.000Z' };
    const index = list.findIndex((c) => c.id === id);
    if (index >= 0) list[index] = record;
    else list.push(record);
    // A4 的约定：返回 { record, settings }
    return { record, settings: { ...settings, k8sClusters: list } };
  }),
  deleteCluster: vi.fn((settings, id) => {
    settings.k8sClusters = (settings.k8sClusters || []).filter((c) => c.id !== id);
    return { settings };
  }),
  // 摘要视图：绝不含 kubeconfig 明文
  toView: vi.fn((record) => ({
    id: record.id,
    name: record.name,
    context: record.context || '',
    server: record.server || '',
    enabled: record.enabled !== false,
    authType: record.authType === 'token' ? 'token' : 'cert',
    hasKubeconfig: Boolean(record.kubeconfig),
    updatedAt: record.updatedAt,
  })),
}));

vi.mock('../k8s/kubeconfig.js', () => ({
  parseKubeconfig: vi.fn((text, contextName) => {
    h.parseCalls.push({ text, contextName });
    if (typeof text !== 'string' || !text.includes('server')) {
      throw new Error('缺少 server 字段');
    }
    return {
      server: 'https://127.0.0.1:6443',
      namespace: 'default',
      authType: 'cert',
      cert: 'CERT-PEM',
      key: 'KEY-PEM',
      ca: 'CA-PEM',
      insecureSkipTlsVerify: false,
      contextName: contextName || 'default',
    };
  }),
  describeKubeconfig: vi.fn(() => ({ server: 'https://127.0.0.1:6443', authType: 'cert' })),
}));

vi.mock('../k8s/client.js', () => ({
  createK8sClient: vi.fn(() => ({
    request: vi.fn(),
    getJson: vi.fn(async (path) => {
      if (h.failAll) throw new Error('connect ECONNREFUSED 127.0.0.1:6443');
      if (h.failPaths.has(path)) throw new Error(`dial tcp 127.0.0.1:6443: connect: connection refused`);
      const data = h.responses[path];
      if (data === undefined) throw new Error(`未预期的请求路径: ${path}`);
      return data;
    }),
    getText: vi.fn(async (path, opts) => {
      h.logRequests.push({ path, opts });
      if (h.failLogs) throw new Error('dial tcp 127.0.0.1:6443: i/o timeout');
      return 'line-1\nline-2\n';
    }),
    apiServerVersion: vi.fn(async () => {
      if (h.failVersion) throw new Error('版本接口超时');
      // 真实 kube-apiserver 的 /version 是对象（{ version, gitVersion }）；也有实现直接给字符串
      if (h.versionObject) return { version: '1.31', gitVersion: 'v1.31.4+k3s1', platform: 'linux/arm64' };
      return 'v1.33.2+k3s1';
    }),
  })),
}));

vi.mock('../k8s/resources.js', () => ({
  normalizeNodes: vi.fn((items) => (items || []).map((item) => ({
    name: item?.metadata?.name || '',
    ready: Array.isArray(item?.status?.conditions)
      && item.status.conditions.some((c) => c.type === 'Ready' && c.status === 'True'),
    roles: [],
    version: item?.status?.nodeInfo?.kubeletVersion || '',
    os: 'linux',
    arch: 'arm64',
    internalIP: '',
    cpu: '4',
    memory: '8Gi',
    pods: '110',
    created: '',
    conditions: [],
  }))),
  normalizePods: vi.fn((items) => (items || []).map((item) => ({
    namespace: item?.metadata?.namespace || '',
    name: item?.metadata?.name || '',
    phase: item?.status?.phase || '',
    ready: '1/1',
    restarts: 0,
    node: '',
    ip: '',
    created: '',
    oom: false,
    crashLoop: false,
    containers: [],
  }))),
  normalizeWorkloads: vi.fn((kind, items) => (items || []).map((item) => ({
    namespace: item?.metadata?.namespace || '',
    name: item?.metadata?.name || '',
    kind,
    desired: 2,
    ready: item?.status?.readyReplicas ?? 0,
    upToDate: 2,
    available: item?.status?.availableReplicas ?? 0,
    created: '',
  }))),
  normalizeEvents: vi.fn((items) => (items || []).map((item) => ({
    namespace: item?.metadata?.namespace || '',
    type: item?.type || '',
    reason: item?.reason || '',
    object: 'Pod/web-0',
    message: item?.message || '',
    count: 1,
    lastSeen: '',
  }))),
  summarize: vi.fn((parts) => {
    if (h.summarizeThrows) throw new Error('summarize 挂了');
    return {
      nodes: parts.nodes.length,
      nodesReady: parts.nodes.filter((n) => n.ready).length,
      pods: parts.pods.length,
      podsRunning: parts.pods.filter((p) => p.phase === 'Running').length,
      // 故意给哨兵值 0：用它区分「真的调用了 summarize」还是「回退到了本地汇总」
      podsUnhealthy: 0,
      workloads: parts.workloads.length,
      workloadsUnready: 0,
      warningEvents: parts.events.filter((e) => e.type === 'Warning').length,
    };
  }),
}));

/**
 * HAMi vGPU 解析层（H1 并行实现，现在还是「调用即抛 not implemented」的占位）。
 *
 * 这里按 /tmp/hami-contract.md 的签名写一份最小实现：路由层只依赖
 * 「readPodVgpu 读 pod.annotations、readNodeGpu 读 node.capacity/allocatable」这件事，
 * 用它验证路由把**补齐后的对象**交给了解析层，以及 gpu 段 / Pod 的 vgpu 字段形状。
 * 真实解析（异常注解、单位、边界）由 H1 的 k8s-hami.test.js 覆盖。
 */
vi.mock('../k8s/hami.js', async (importOriginal) => {
  // 委托真实解析层：以前的 mock 自带一份「三段注解 + nvidia.com/gpumem」的假实现，
  // 结果真机改成四段 + node-nvidia-register 之后，测试仍在用假逻辑自证（等于没测）。
  // 现在只保留故障注入（h.hamiThrows），解析与汇总都走真实实现。
  const actual = await importOriginal();
  return {
    ...actual,
    readNodeGpu: vi.fn((node) => {
      if (h.hamiThrows) throw new Error('not implemented');
      return actual.readNodeGpu(node);
    }),
    readPodVgpu: vi.fn((pod) => {
      if (h.hamiThrows) throw new Error('not implemented');
      return actual.readPodVgpu(pod);
    }),
    summarizeVgpu: vi.fn((parts) => {
      if (h.hamiThrows) throw new Error('not implemented');
      return actual.summarizeVgpu(parts);
    }),
  };
});

import createK8sRouter from '../routes/k8s.js';
import * as k8sHami from '../k8s/hami.js';

// ── 假集群数据 ────────────────────────────────────────────────────

const VALID_KUBECONFIG = [
  'apiVersion: v1',
  'clusters:',
  '- cluster:',
  '    server: https://127.0.0.1:6443',
  '  name: k3s',
  'contexts:',
  '- context: {cluster: k3s, user: k3s-admin, namespace: default}',
  '  name: k3s',
  'current-context: k3s',
  'users:',
  '- name: k3s-admin',
  '  user: {token: fake}',
].join('\n');

function defaultResponses() {
  return {
    '/api/v1/nodes': {
      items: [
        { metadata: { name: 'k3s-1' }, status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.33.2+k3s1' } } },
        { metadata: { name: 'k3s-2' }, status: { conditions: [{ type: 'Ready', status: 'False' }], nodeInfo: { kubeletVersion: 'v1.33.2+k3s1' } } },
      ],
    },
    '/api/v1/pods': {
      items: [
        { metadata: { namespace: 'default', name: 'web-0' }, status: { phase: 'Running' } },
        { metadata: { namespace: 'app', name: 'api-1' }, status: { phase: 'Running' } },
        { metadata: { namespace: 'batch', name: 'job-0' }, status: { phase: 'Pending' } },
      ],
    },
    '/apis/apps/v1/deployments': {
      items: [
        { metadata: { namespace: 'default', name: 'web' }, status: { readyReplicas: 2, availableReplicas: 2 } },
        { metadata: { namespace: 'app', name: 'api' }, status: { readyReplicas: 0, availableReplicas: 0 } },
      ],
    },
    '/apis/apps/v1/statefulsets': {
      items: [{ metadata: { namespace: 'default', name: 'db' }, status: { readyReplicas: 1, availableReplicas: 1 } }],
    },
    '/apis/apps/v1/daemonsets': {
      items: [{ metadata: { namespace: 'kube-system', name: 'svclb' }, status: { readyReplicas: 2, availableReplicas: 2 } }],
    },
    '/api/v1/events': {
      items: [
        { metadata: { namespace: 'default' }, type: 'Warning', reason: 'BackOff', message: 'Back-off restarting' },
        { metadata: { namespace: 'app' }, type: 'Normal', reason: 'Pulled', message: 'Pulled image' },
      ],
    },
    '/api/v1/namespaces/default/pods': {
      items: [{ metadata: { namespace: 'default', name: 'web-0' }, status: { phase: 'Running' } }],
    },
  };
}

function resetState() {
  h.settings = { k8sClusters: [] };
  h.sequence = 0;
  h.responses = defaultResponses();
  h.failPaths = new Set();
  h.failAll = false;
  h.failLogs = false;
  h.failVersion = false;
  h.versionObject = false;
  h.summarizeThrows = false;
  h.hamiThrows = false;
  h.logRequests = [];
  h.parseCalls = [];
  h.upsertInputs = [];
  h.saved = [];
}

// ── 服务 ─────────────────────────────────────────────────────────

const router = createK8sRouter({
  ensureSettings: () => h.settings,
  saveSettings: (next) => {
    h.saved.push(next);
    h.settings = next;
  },
});

let server;
let base;

beforeAll(async () => {
  const app = express();
  // index.js 里是全局中间件（app.use(express.json({ limit: '10mb' }))），测试里单独装上
  app.use(express.json());
  app.use(router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(resetState);

async function request(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, body: json, text };
}

/** 直接往假 settings 里塞一个集群，省得每条用例都先走一次 POST */
function seedCluster(overrides = {}) {
  const record = {
    id: 'c-1',
    name: 'k3s 测试集群',
    kubeconfig: VALID_KUBECONFIG,
    context: 'k3s',
    enabled: true,
    server: 'https://127.0.0.1:6443',
    authType: 'cert',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  };
  h.settings = { k8sClusters: [record] };
  return record;
}

// ═══ 列表 ═════════════════════════════════════════════════════════

describe('GET /api/k8s/clusters', () => {
  it('空配置返回空数组', async () => {
    const res = await request('GET', '/api/k8s/clusters');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clusters: [] });
  });

  it('返回视图摘要，且绝不回传 kubeconfig 明文', async () => {
    seedCluster({ kubeconfig: 'apiVersion: v1\nserver: https://10.0.0.1:6443\nSECRET-MARKER' });
    const res = await request('GET', '/api/k8s/clusters');
    expect(res.status).toBe(200);
    expect(res.body.clusters).toHaveLength(1);
    const [view] = res.body.clusters;
    expect(view.id).toBe('c-1');
    expect(view.name).toBe('k3s 测试集群');
    expect(view.server).toBe('https://127.0.0.1:6443');
    expect(view.authType).toBe('cert');
    expect(view.hasKubeconfig).toBe(true);
    expect(view.kubeconfig).toBeUndefined();
    expect(res.text).not.toContain('SECRET-MARKER');
  });
});

// ═══ 创建 ═════════════════════════════════════════════════════════

describe('POST /api/k8s/clusters', () => {
  it('成功创建并持久化（调用 saveSettings 一次）', async () => {
    const res = await request('POST', '/api/k8s/clusters', {
      name: '生产',
      kubeconfig: VALID_KUBECONFIG,
      context: 'k3s',
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('cluster-1');
    expect(res.body.name).toBe('生产');
    expect(res.body.context).toBe('k3s');
    expect(res.body.server).toBe('https://127.0.0.1:6443');
    expect(res.body.hasKubeconfig).toBe(true);
    expect(res.body).not.toHaveProperty('kubeconfig');

    // kubeconfig 被解析过一次，且解析结果里的 server/authType 一并交给 store
    expect(h.parseCalls).toHaveLength(1);
    expect(h.upsertInputs[0]).toMatchObject({
      name: '生产',
      context: 'k3s',
      enabled: true,
      server: 'https://127.0.0.1:6443',
      authType: 'cert',
    });

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].k8sClusters).toHaveLength(1);
    expect(h.saved[0].k8sClusters[0].kubeconfig).toBe(VALID_KUBECONFIG);
  });

  it('名称为空 → 400，且不落库、不持久化', async () => {
    const res = await request('POST', '/api/k8s/clusters', { name: '   ', kubeconfig: VALID_KUBECONFIG });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('名称');
    expect(h.saved).toHaveLength(0);
    expect(h.settings.k8sClusters).toHaveLength(0);
  });

  it('缺少 kubeconfig → 400', async () => {
    const res = await request('POST', '/api/k8s/clusters', { name: '空集群' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('kubeconfig');
    expect(h.saved).toHaveLength(0);
  });

  it('kubeconfig 解析失败 → 400，错误信息带上解析原因', async () => {
    const res = await request('POST', '/api/k8s/clusters', {
      name: '坏集群',
      kubeconfig: 'apiVersion: v1\nclusters: []\n', // 没有 server 字段
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('kubeconfig 解析失败');
    expect(res.body.error).toContain('server');
    expect(h.saved).toHaveLength(0);
    expect(h.upsertInputs).toHaveLength(0);
  });
});

// ═══ 更新 ═════════════════════════════════════════════════════════

describe('PUT /api/k8s/clusters/:id', () => {
  it('省略 kubeconfig 时沿用旧值，不重复解析', async () => {
    seedCluster();
    const res = await request('PUT', '/api/k8s/clusters/c-1', { name: '改名后' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('改名后');
    expect(res.body.hasKubeconfig).toBe(true);
    expect(h.parseCalls).toHaveLength(0);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].k8sClusters[0].kubeconfig).toBe(VALID_KUBECONFIG);
  });

  it('传新 kubeconfig 会重新解析并更新 server', async () => {
    seedCluster();
    // 用一段合法（含 server 字段）的新文本
    const next = VALID_KUBECONFIG.replace('127.0.0.1:6443', '10.1.2.3:6443');
    const res = await request('PUT', '/api/k8s/clusters/c-1', { kubeconfig: next });
    expect(res.status).toBe(200);
    expect(h.parseCalls).toHaveLength(1);
    expect(h.saved[0].k8sClusters[0].kubeconfig).toBe(next);
    // server 由解析结果提供（假实现固定返回 127.0.0.1:6443）
    expect(h.upsertInputs[0].server).toBe('https://127.0.0.1:6443');
  });

  it('新 kubeconfig 解析失败 → 400 且旧记录不受影响', async () => {
    seedCluster();
    const res = await request('PUT', '/api/k8s/clusters/c-1', { name: 'x', kubeconfig: 'not-a-kubeconfig' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('kubeconfig 解析失败');
    expect(h.saved).toHaveLength(0);
    expect(h.settings.k8sClusters[0].kubeconfig).toBe(VALID_KUBECONFIG);
  });

  it('id 不存在 → 404', async () => {
    seedCluster();
    const res = await request('PUT', '/api/k8s/clusters/nope', { name: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('不存在');
  });
});

// ═══ 删除 ═════════════════════════════════════════════════════════

describe('DELETE /api/k8s/clusters/:id', () => {
  it('删除成功返回 { ok: true } 并持久化', async () => {
    seedCluster();
    const res = await request('DELETE', '/api/k8s/clusters/c-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.saved).toHaveLength(1);
    expect(h.settings.k8sClusters).toHaveLength(0);

    const list = await request('GET', '/api/k8s/clusters');
    expect(list.body.clusters).toEqual([]);
  });

  it('id 不存在 → 404', async () => {
    const res = await request('DELETE', '/api/k8s/clusters/ghost');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('不存在');
    expect(h.saved).toHaveLength(0);
  });
});

// ═══ 连通性测试 ═══════════════════════════════════════════════════

describe('POST /api/k8s/clusters/:id/test', () => {
  it('连通时返回版本与节点数', async () => {
    seedCluster();
    const res = await request('POST', '/api/k8s/clusters/c-1/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 'v1.33.2+k3s1', nodes: 2 });
  });

  it('版本接口返回对象时取 gitVersion，不能出现 [object Object]', async () => {
    seedCluster();
    h.versionObject = true;
    const t = await request('POST', '/api/k8s/clusters/c-1/test');
    expect(t.status).toBe(200);
    expect(t.body.version).toBe('v1.31.4+k3s1');

    const ov = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.cluster.version).toBe('v1.31.4+k3s1');
    expect(JSON.stringify(ov.body)).not.toContain('[object Object]');
  });

  it('连不上 API → 502 + error（透出底层网络原因）', async () => {
    seedCluster();
    h.failAll = true;
    const res = await request('POST', '/api/k8s/clusters/c-1/test');
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('ECONNREFUSED');
  });

  it('没有可用 kubeconfig → 400（而不是 502）', async () => {
    seedCluster({ kubeconfig: '' });
    const res = await request('POST', '/api/k8s/clusters/c-1/test');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('kubeconfig');
  });

  it('id 不存在 → 404', async () => {
    const res = await request('POST', '/api/k8s/clusters/missing/test');
    expect(res.status).toBe(404);
  });
});

// ═══ 概览 ═════════════════════════════════════════════════════════

describe('GET /api/k8s/clusters/:id/overview', () => {
  it('正常路径：六类资源并发拉取并汇总', async () => {
    seedCluster();
    const res = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(res.status).toBe(200);

    expect(res.body.cluster).toEqual({
      version: 'v1.33.2+k3s1',
      server: 'https://127.0.0.1:6443',
      context: 'k3s',
    });
    expect(res.body.nodes).toHaveLength(2);
    expect(res.body.pods).toHaveLength(3);
    // Deployment ×2 + StatefulSet ×1 + DaemonSet ×1
    expect(res.body.workloads).toHaveLength(4);
    expect(res.body.workloads.map((w) => w.kind).sort())
      .toEqual(['DaemonSet', 'Deployment', 'Deployment', 'StatefulSet']);
      // 契约：overview 只回 Warning 事件（Normal 的 Scheduled/Pulled 不返回）
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].type).toBe('Warning');
    expect(res.body.warnings).toEqual([]);

    const summary = res.body.summary;
    expect(summary).toMatchObject({
      nodes: 2,
      nodesReady: 1,
      pods: 3,
      podsRunning: 2,
      // 哨兵：说明用的是 resources.summarize 而不是本地兜底
      podsUnhealthy: 0,
      workloads: 4,
      warningEvents: 1,
    });
  });

  it('部分失败：某类资源抛错时给空数组 + warning，其余照常返回', async () => {
    seedCluster();
    h.failPaths = new Set(['/api/v1/pods']);

    const res = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(res.status).toBe(200);
    expect(res.body.pods).toEqual([]);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toContain('Pod查询失败');
    expect(res.body.warnings[0]).toContain('connection refused');

    // 其它资源不受影响
    expect(res.body.nodes).toHaveLength(2);
    expect(res.body.workloads).toHaveLength(4);
      // 契约：overview 只回 Warning 事件（Normal 的 Scheduled/Pulled 不返回）
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].type).toBe('Warning');
    expect(res.body.summary.pods).toBe(0);
    expect(res.body.summary.nodes).toBe(2);
  });

  it('多类资源同时失败也只记录 warning，不影响整体 200', async () => {
    seedCluster();
    h.failPaths = new Set(['/api/v1/pods', '/api/v1/events']);
    const res = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(res.status).toBe(200);
    expect(res.body.pods).toEqual([]);
    expect(res.body.events).toEqual([]);
    expect(res.body.warnings).toHaveLength(2);
    expect(res.body.workloads).toHaveLength(4);
  });

  it('summarize 抛错时回退本地汇总', async () => {
    seedCluster();
    h.summarizeThrows = true;
    const res = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(res.status).toBe(200);
    // 本地汇总：3 个 Pod 里 1 个 Pending → podsUnhealthy = 1（哨兵值 0 说明没走本地实现）
    expect(res.body.summary).toMatchObject({
      nodes: 2,
      nodesReady: 1,
      pods: 3,
      podsRunning: 2,
      podsUnhealthy: 1,
      workloads: 4,
      // api(0/2) 与 db(1/2) 未就绪
      workloadsUnready: 2,
      warningEvents: 1,
    });
  });

  it('版本接口失败不影响概览（version 为空串）', async () => {
    seedCluster();
    h.failVersion = true;
    const res = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(res.status).toBe(200);
    expect(res.body.cluster.version).toBe('');
    expect(res.body.nodes).toHaveLength(2);
  });

  it('六类资源全部失败（连不上 apiserver）→ 502，而不是返回一份全空的 200', async () => {
    seedCluster();
    h.failAll = true;
    const res = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('无法连接 Kubernetes API');
    expect(res.body.error).toContain('ECONNREFUSED');
  });

  it('kubeconfig 损坏 → 400，id 不存在 → 404', async () => {
    seedCluster({ kubeconfig: 'garbage' });
    const bad = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('kubeconfig');

    const missing = await request('GET', '/api/k8s/clusters/unknown/overview');
    expect(missing.status).toBe(404);
  });
});

// ═══ Pod 列表 ═════════════════════════════════════════════════════

describe('GET /api/k8s/clusters/:id/pods', () => {
  it('不带 namespace 时走集群级 pods 路径', async () => {
    seedCluster();
    const res = await request('GET', '/api/k8s/clusters/c-1/pods');
    expect(res.status).toBe(200);
    expect(res.body.pods).toHaveLength(3);
  });

  it('带 namespace 时走命名空间路径', async () => {
    seedCluster();
    const res = await request('GET', '/api/k8s/clusters/c-1/pods?namespace=default');
    expect(res.status).toBe(200);
    expect(res.body.pods).toHaveLength(1);
    expect(res.body.pods[0].namespace).toBe('default');
  });
});

// ═══ 事件 ═════════════════════════════════════════════════════════

describe('GET /api/k8s/clusters/:id/events', () => {
  it('不带过滤返回全部事件', async () => {
    seedCluster();
    const res = await request('GET', '/api/k8s/clusters/c-1/events');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
  });

  it('type=Warning 与 namespace 过滤生效', async () => {
    seedCluster();
    const warning = await request('GET', '/api/k8s/clusters/c-1/events?type=Warning');
    expect(warning.body.events).toHaveLength(1);
    expect(warning.body.events[0].type).toBe('Warning');

    const byNs = await request('GET', '/api/k8s/clusters/c-1/events?namespace=app');
    expect(byNs.body.events).toHaveLength(1);
    expect(byNs.body.events[0].type).toBe('Normal');
  });
});

// ═══ Pod 日志 ═════════════════════════════════════════════════════

describe('GET /api/k8s/clusters/:id/pods/:namespace/:pod/logs', () => {
  const logPath = '/api/v1/namespaces/default/pods/web-0/log';

  it('默认 tail=200', async () => {
    seedCluster();
    const res = await request('GET', '/api/k8s/clusters/c-1/pods/default/web-0/logs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logs: 'line-1\nline-2\n' });
    expect(h.logRequests).toHaveLength(1);
    expect(h.logRequests[0].path).toBe(logPath);
    expect(h.logRequests[0].opts).toEqual({ query: { tailLines: 200 } });
  });

  it('tail=0 夹到 1；tail=9999 夹到 2000；tail 非法回落 200', async () => {
    seedCluster();

    const low = await request('GET', '/api/k8s/clusters/c-1/pods/default/web-0/logs?tail=0');
    expect(low.status).toBe(200);
    expect(h.logRequests.at(-1).opts).toEqual({ query: { tailLines: 1 } });

    const high = await request('GET', '/api/k8s/clusters/c-1/pods/default/web-0/logs?tail=9999');
    expect(high.status).toBe(200);
    expect(h.logRequests.at(-1).opts).toEqual({ query: { tailLines: 2000 } });

    const negative = await request('GET', '/api/k8s/clusters/c-1/pods/default/web-0/logs?tail=-50');
    expect(negative.status).toBe(200);
    expect(h.logRequests.at(-1).opts).toEqual({ query: { tailLines: 1 } });

    const junk = await request('GET', '/api/k8s/clusters/c-1/pods/default/web-0/logs?tail=abc');
    expect(junk.status).toBe(200);
    expect(h.logRequests.at(-1).opts).toEqual({ query: { tailLines: 200 } });
  });

  it('tail 边界值 1 与 2000 原样透传', async () => {
    seedCluster();
    await request('GET', '/api/k8s/clusters/c-1/pods/default/web-0/logs?tail=1');
    expect(h.logRequests.at(-1).opts).toEqual({ query: { tailLines: 1 } });
    await request('GET', '/api/k8s/clusters/c-1/pods/default/web-0/logs?tail=2000');
    expect(h.logRequests.at(-1).opts).toEqual({ query: { tailLines: 2000 } });
  });

  it('读取日志失败 → 502 + error', async () => {
    seedCluster();
    h.failLogs = true;
    const res = await request('GET', '/api/k8s/clusters/c-1/pods/default/web-0/logs?tail=100');
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('i/o timeout');
  });

  it('集群 id 不存在 → 404', async () => {
    const res = await request('GET', '/api/k8s/clusters/nope/pods/default/web-0/logs');
    expect(res.status).toBe(404);
  });
});
// ═══ HAMi vGPU ═════════════════════════════════════════════════════
//
// 契约见 /tmp/hami-contract.md。这里只钉路由层的三件事：
//   1. 没有 HAMi 时 `gpu` 段照样返回但为空，且 Pod 里**不出现** vgpu 字段（行为不变）；
//   2. 有 HAMi 时 overview.gpu / pods[].vgpu 的形状正确，且解析层拿到的是
//      「补齐了 capacity / annotations 的对象」（归一化层没保留这两个字段也能工作）；
//   3. 解析层抛错（H1 的占位实现）时降级成空段 + 一条 warning，绝不把 overview 打成 500。

/** 给假响应挂上 HAMi 数据：节点 2 卡 / 48 GiB / 200 算力点，web-0 占 12 GiB / 40% */
function seedHami() {
  const nodes = h.responses['/api/v1/nodes'].items;
  const gpuResources = {
    'nvidia.com/gpu': '2',
    'nvidia.com/gpumem': '49152',
    'nvidia.com/gpucores': '200',
  };
  nodes[0].status = {
    ...nodes[0].status,
    capacity: { cpu: '8', memory: '16Gi', pods: '110', ...gpuResources },
    allocatable: { cpu: '8', memory: '16Gi', pods: '110', ...gpuResources },
  };

  const pods = h.responses['/api/v1/pods'].items;
  pods[0].metadata = {
    ...pods[0].metadata,
    annotations: {
      'hami.io/vgpu-devices-allocated': 'GPU-aaaa-1111,12288,40:;',
      'hami.io/vgpu-node-allocated': 'k3s-1,0,NVIDIA-GeForce-RTX-4090',
    },
  };
}

describe('HAMi vGPU', () => {
  it('没有 HAMi：gpu 段照常返回但为空，Pod 不带 vgpu 字段', async () => {
    seedCluster();
    const res = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(res.status).toBe(200);

    expect(res.body.gpu).toMatchObject({
      hasHami: false,
      nodes: [],
      pods: [],
      totals: { gpuCount: 0, memMiB: 0, cores: 0, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 },
      warnings: [],
    });
    // 关键：没有 HAMi 时 Pod 形状与改动前一致（前端因此不会出现 vGPU 列）
    for (const pod of res.body.pods) {
      expect('vgpu' in pod).toBe(false);
    }
    // 解析用的原始映射不随响应透出
    expect(res.body.nodes[0].capacity).toBeUndefined();
    expect(res.body.nodes[0].allocatable).toBeUndefined();
  });

  it('节点有 GPU 资源、Pod 有注解：gpu 段汇总正确，Pod 带 vgpu', async () => {
    seedCluster();
    seedHami();

    const res = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(res.status).toBe(200);

    const gpu = res.body.gpu;
    expect(gpu.hasHami).toBe(true);
    expect(gpu.warnings).toEqual([]);
    expect(gpu.nodes).toMatchObject([
      {
        name: 'k3s-1',
        count: 2,
        memMiB: 49152,
        cores: 200,
        allocatedMemMiB: 12288,
        allocatedCores: 40,
        podCount: 1,
      },
    ]);
    expect(gpu.pods).toEqual([
      {
        namespace: 'default',
        name: 'web-0',
        nodeName: 'k3s-1',
        devices: [{ id: 'GPU-aaaa-1111', memMiB: 12288, cores: 40 }],
        totalMemMiB: 12288,
        totalCores: 40,
        phase: 'Running',
      },
    ]);
    expect(gpu.totals).toMatchObject({
      gpuCount: 2,
      memMiB: 49152,
      cores: 200,
      allocatedMemMiB: 12288,
      allocatedCores: 40,
      podCount: 1,
    });

    // 有 HAMi 时每个 Pod 都有 vgpu（没分配到的是 hasVgpu:false，前端显示「—」）
    const [web0, api1] = res.body.pods;
    expect(web0.vgpu).toEqual({
      hasVgpu: true,
      devices: [{ id: 'GPU-aaaa-1111', memMiB: 12288, cores: 40 }],
      totalMemMiB: 12288,
      totalCores: 40,
      nodeName: 'k3s-1',
    });
    expect(api1.vgpu).toEqual({
      hasVgpu: false,
      devices: [],
      totalMemMiB: 0,
      totalCores: 0,
      nodeName: null,
    });
  });

  it('解析层拿到的是补齐了 capacity / annotations 的对象（归一化没保留也能工作）', async () => {
    seedCluster();
    seedHami();
    await request('GET', '/api/k8s/clusters/c-1/overview');

    const call = k8sHami.summarizeVgpu.mock.calls.at(-1)[0];
    const node = call.nodes.find((item) => item.name === 'k3s-1');
    expect(node.capacity['nvidia.com/gpu']).toBe('2');
    expect(node.allocatable['nvidia.com/gpumem']).toBe('49152');
    const pod = call.pods.find((item) => item.name === 'web-0');
    expect(pod.annotations['hami.io/vgpu-devices-allocated']).toContain('GPU-aaaa-1111');
    // conditions 等归一化字段不能丢（补字段是浅合并）
    expect(Array.isArray(node.conditions)).toBe(true);
  });

  it('解析层抛错（占位实现）：空 gpu 段 + warning，overview 仍然 200', async () => {
    seedCluster();
    seedHami();
    h.hamiThrows = true;

    const res = await request('GET', '/api/k8s/clusters/c-1/overview');
    expect(res.status).toBe(200);
    expect(res.body.gpu.hasHami).toBe(false);
    expect(res.body.gpu.nodes).toMatchObject([]);
    expect(res.body.gpu.warnings).toHaveLength(1);
    expect(res.body.gpu.warnings[0]).toContain('not implemented');
    // 其余资源照常
    expect(res.body.nodes).toHaveLength(2);
    expect(res.body.pods).toHaveLength(3);
    expect(res.body.pods[0].vgpu).toBeUndefined();
  });

  it('GET /pods：有注解时每个 Pod 带 vgpu，无注解时没有该字段', async () => {
    seedCluster();
    const plain = await request('GET', '/api/k8s/clusters/c-1/pods');
    expect(plain.status).toBe(200);
    expect('vgpu' in plain.body.pods[0]).toBe(false);

    seedHami();
    const withGpu = await request('GET', '/api/k8s/clusters/c-1/pods');
    expect(withGpu.status).toBe(200);
    expect(withGpu.body.pods[0].vgpu).toMatchObject({ hasVgpu: true, totalMemMiB: 12288, totalCores: 40 });
    expect(withGpu.body.pods[1].vgpu).toMatchObject({ hasVgpu: false });
    // 注解本身不透出（只透 vgpu 摘要）
    expect(withGpu.body.pods[0].annotations).toBeUndefined();
  });
});

// ═══ 演示模式下的 HAMi 数据 ═════════════════════════════════════════
//
// 演示集群的数据必须自洽：节点 4 卡 / 96 GiB / 400 算力点，几个 Pod 的分配加起来小于总量，
// 且正好 1 个 Pod 因为「单卡显存凑不出来」Pending（助手回复讲的就是这件事）。
// 这里读的是**真实 fixtures.js**（这个文件没有 mock 它），解析用本文件顶部的 hami 替身。
describe('演示模式 · HAMi vGPU fixture', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));
  afterEach(() => vi.unstubAllEnvs());

  it('overview 带 GPU 段：4 卡 / 96 GiB / 400 点，分配量小于总量', async () => {
    const clusters = await request('GET', '/api/k8s/clusters');
    const id = clusters.body.clusters[0].id;
    const res = await request('GET', `/api/k8s/clusters/${encodeURIComponent(id)}/overview`);
    expect(res.status).toBe(200);
    expect(res.body.demo).toBe(true);

    const { gpu } = res.body;
    expect(gpu.hasHami).toBe(true);
    // 真机语义（243 实测）：gpuCount 是物理卡数，槽位数在 slots（nvidia.com/gpu = 40）
    expect(gpu.totals.gpuCount).toBe(4);
    expect(gpu.totals.physicalCount).toBe(4);
    expect(gpu.totals.slots).toBe(40);
    expect(gpu.totals.memMiB).toBe(96 * 1024);
    expect(gpu.totals.cores).toBe(400);
    // 自洽：已分配严格小于总量（否则「还剩多少」永远没得看）
    expect(gpu.totals.allocatedMemMiB).toBeGreaterThan(0);
    expect(gpu.totals.allocatedMemMiB).toBeLessThan(gpu.totals.memMiB);
    expect(gpu.totals.allocatedCores).toBeGreaterThan(0);
    expect(gpu.totals.allocatedCores).toBeLessThan(gpu.totals.cores);
    expect(gpu.nodes[0]).toMatchObject({ name: 'k3s-infer-node-1', count: 4, podCount: 5 });

    // 同卡共享：两个 Pod 落在同一张卡上（vGPU 的核心证据）
    const byDevice = new Map();
    for (const pod of gpu.pods) {
      for (const device of pod.devices) {
        byDevice.set(device.id, [...(byDevice.get(device.id) ?? []), pod.name]);
      }
    }
    expect([...byDevice.values()].some((names) => names.length > 1)).toBe(true);

    // 演示 fixture 的解析输入不随响应透出
    expect(res.body.nodes[0].capacity).toBeUndefined();
    expect(res.body.nodes[0].allocatable).toBeUndefined();
    expect(res.body.pods[0].annotations).toBeUndefined();
    // 有 HAMi 时 Pod 带 vgpu
    expect(res.body.pods[0].vgpu.hasVgpu).toBe(true);
  });

  it('正好 1 个 Pending Pod 拿不到 vGPU 分配（显存不足的呼应）', async () => {
    const clusters = await request('GET', '/api/k8s/clusters');
    const id = clusters.body.clusters[0].id;
    const res = await request('GET', `/api/k8s/clusters/${encodeURIComponent(id)}/overview`);

    const pending = res.body.pods.filter((pod) => pod.phase === 'Pending');
    expect(pending).toHaveLength(1);
    // 没被调度的 Pod 没有分配 —— 这正是「排不上」的证据
    expect(pending[0].vgpu).toMatchObject({ hasVgpu: false, totalMemMiB: 0, totalCores: 0 });
    expect(res.body.gpu.pods.some((pod) => pod.name === pending[0].name)).toBe(false);

    // 事件里能看到 Insufficient nvidia.com/*，与助手文案「显存不足」同源
    const scheduling = res.body.events.find((event) => event.reason === 'FailedScheduling');
    expect(scheduling).toBeTruthy();
    expect(scheduling.message).toContain('nvidia.com/gpumem');
  });

  it('GET /pods（演示）也带 vgpu 字段', async () => {
    const clusters = await request('GET', '/api/k8s/clusters');
    const id = clusters.body.clusters[0].id;
    const res = await request('GET', `/api/k8s/clusters/${encodeURIComponent(id)}/pods`);
    expect(res.status).toBe(200);
    expect(res.body.pods.some((pod) => pod.vgpu?.hasVgpu === true)).toBe(true);
    expect(res.body.pods[0].annotations).toBeUndefined();
  });
});
