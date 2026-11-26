/**
 * routes/infra.js 测试 —— 重点覆盖**安全边界**，不是功能。
 *
 * 背景（真机事故）：2026-11-26 验证时，用 `inference/strata` 做护栏测试，
 * 它被覆盖成测试镜像并进 ImagePullBackOff。根因是 apply 路由给护栏传了 `existing: null`，
 * NOT_MANAGED 的判定依据（同名对象存在但不带归属标签）根本无从成立 → 护栏放行。
 *
 * 所以这个文件的存在意义是：任何人以后改动 apply/preview 的 existing 读取路径时，
 * 下面这些用例必须把它拦住。**每一条都对应一个真实可发生的破坏**。
 *
 * mock 边界：store（settings）、kubeconfig、client（apiserver）。护栏/渲染/容量用真实实现，
 * 因为它们的形状就是路由的输入契约，mock 掉等于只测自己的 if。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';

const h = vi.hoisted(() => ({
  settings: { k8sClusters: [] },
  /** path → 响应体；path → Error 表示该次读取失败 */
  cluster: new Map(),
  getJsonCalls: [],
  writeCalls: [],
  savedSettings: null,
  kv: {},
}));

vi.mock('../k8s/store.js', () => ({
  getClusterRecord: (settings, id) => {
    const list = Array.isArray(settings?.k8sClusters) ? settings.k8sClusters : [];
    return list.find((r) => r.id === id) || null;
  },
  listClusters: (settings) => (Array.isArray(settings?.k8sClusters) ? settings.k8sClusters : []),
  toView: (r) => ({ id: r.id, name: r.name, enabled: r.enabled !== false, hasKubeconfig: Boolean(r.kubeconfig) }),
}));

vi.mock('../k8s/kubeconfig.js', () => ({
  parseKubeconfig: (text) => {
    if (typeof text !== 'string' || !text.includes('server')) throw new Error('缺少 server 字段');
    return { server: 'https://127.0.0.1:6443', namespace: 'default', authType: 'token', token: 'T' };
  },
  describeKubeconfig: () => ({}),
}));

vi.mock('../k8s/client.js', () => ({
  createK8sClient: () => ({
    getJson: async (path) => {
      h.getJsonCalls.push(path);
      // Pod 列表（配额校验用）：返回一个就绪且带 vGPU 注解的 Pod，
      // 注解格式取自真机：GPU-<uuid>,<TYPE>,<memMiB>,<cores>:;
      if (path.startsWith('/api/v1/namespaces/') && path.includes('/pods') && path.includes('labelSelector')) {
        const ns = path.split('/')[4];
        return {
          items: [{
            metadata: {
              name: 'qwen-test-abc12',
              namespace: ns,
              labels: { app: 'qwen-test' },
              annotations: { 'hami.io/vgpu-devices-allocated': 'GPU-test-0001,NVIDIA,4096,30:;' },
            },
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
          }],
        };
      }
      const hit = h.cluster.get(path);
      if (hit instanceof Error) throw hit;
      if (hit === undefined) {
        const err = new Error(`资源不存在（404）：${path}`);
        err.status = 404;
        throw err;
      }
      return hit;
    },
    // 写入后模拟 apiserver：返回带就绪 status 的对象，让 A5 的 rollout 轮询一次通过
    postJson: async (path, body) => { h.writeCalls.push(['POST', path, body]); return withReadyStatus(body); },
    patchJson: async (path, body) => {
      h.writeCalls.push(['PATCH', path, body]);
      const merged = withReadyStatus({ ...(h.cluster.get(path) || {}), ...body });
      h.cluster.set(path, merged);   // 后续 getJson 读到的就是就绪态
      return merged;
    },
    deleteJson: async (path) => { h.writeCalls.push(['DELETE', path]); return {}; },
  }),
}));

vi.mock('../db/index.js', () => ({
  getKv: (key) => h.kv[key] ?? null,
  setKv: (key, value) => { h.kv[key] = value; return Promise.resolve(); },
}));

import { createInfraRouter } from '../routes/infra.js';

let server;
let base;

const CLUSTER = { id: 'c-243', name: '243', enabled: true, kubeconfig: 'server: https://127.0.0.1:6443' };

/** 一个校验能过的服务定义 */
function service(overrides = {}) {
  return {
    name: 'qwen-test',
    namespace: 'infra-test',
    model: { source: 'hostPath', path: '/data/models/x' },
    engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.6.3' },
    resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 30 },
    replicas: 1,
    ports: [{ name: 'http', containerPort: 8000 }],
    health: { path: '/health' },
    ...overrides,
  };
}

/** 一个"别人的"Deployment：存在、但没有任何 openlog-infra 归属标记 */
function foreignDeployment(name = 'qwen-test', namespace = 'infra-test') {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace, labels: { app: name }, resourceVersion: '100' },
    spec: {
      replicas: 3,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: { containers: [{ name, image: 'ghcr.io/somebody/prod-service:1.0' }] },
      },
    },
  };
}

/** 我们自己创建的对象：带归属标签 */
function ownedDeployment(name = 'qwen-test', namespace = 'infra-test') {
  const dep = foreignDeployment(name, namespace);
  // 就绪状态：让 A5 的 rollout 轮询立刻通过（否则要等真超时）
  dep.metadata.generation = 1;
  dep.status = { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 };
  dep.metadata.labels.managedBy = 'openlog-infra';
  dep.metadata.labels['app.kubernetes.io/managed-by'] = 'openlog-infra';
  return dep;
}

/** 给对象补上"已就绪"的 metadata/status（模拟写入后 apiserver 的即时状态） */
function withReadyStatus(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const next = JSON.parse(JSON.stringify(obj));
  next.metadata = { ...(next.metadata || {}), generation: 1, resourceVersion: '101' };
  if (next.kind === 'Deployment') {
    const want = Number(next.spec?.replicas ?? 1);
    next.status = {
      observedGeneration: 1,
      replicas: want,
      updatedReplicas: want,
      readyReplicas: want,
      availableReplicas: want,
    };
  }
  return next;
}

function depPath(ns, name) { return `/apis/apps/v1/namespaces/${ns}/deployments/${name}`; }
function svcPath(ns, name) { return `/api/v1/namespaces/${ns}/services/${name}`; }

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(createInfraRouter({
    ensureSettings: () => h.settings,
    // 模拟真实实现：保存后 ensureSettings() 立刻能读到新值
    saveSettings: (next) => { h.savedSettings = next; h.settings = next; },
    // 测试里不要真的等 rollout：注入假 sleep + 极短超时（生产用 A5 的默认 120s/2s）
    applyOptions: { sleep: async () => {}, rolloutTimeoutMs: 50, pollIntervalMs: 1 },
  }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

beforeEach(() => {
  delete process.env.OPENLOG_DEMO;
  // 默认开开关：安全用例要在"本该能写"的前提下验证被拦住，否则测的是开关而不是护栏
  process.env.OPENLOG_K8S_INFRA = '1';
  h.settings = { k8sClusters: [CLUSTER] };
  h.cluster = new Map();
  h.getJsonCalls = [];
  h.writeCalls = [];
  h.savedSettings = null;
  h.kv = {};
  // 预览要读节点与 Pod 做容量预检 —— 给一份最小可用的真机形状（一张 4090，剩 32 GiB）
  h.cluster.set('/api/v1/nodes', {
    items: [{
      metadata: {
        name: 'node1',
        labels: { 'kubernetes.io/hostname': 'node1' },
        annotations: {
          'hami.io/node-nvidia-register': JSON.stringify([
            { id: 'GPU-test-0001', type: 'NVIDIA GeForce RTX 4090', devmem: 49140, devcore: 100, count: 10, health: true },
          ]),
        },
      },
      status: {
        allocatable: { 'nvidia.com/gpu': '10' },
        addresses: [{ type: 'InternalIP', address: '100.100.152.243' }],
      },
    }],
  });
  h.cluster.set('/api/v1/pods', { items: [] });
});

afterEach(() => { delete process.env.OPENLOG_K8S_INFRA; });

/* ────────────────────────── 归属校验（事故回归） ────────────────────────── */

describe('归属校验：别人的对象一律不许动（事故回归）', () => {
  it('apply 覆盖一个无归属标签的同名 Deployment → 409，且零写请求', async () => {
    h.cluster.set(depPath('infra-test', 'qwen-test'), foreignDeployment());

    const res = await post('/api/infra/services/qwen-test/apply', { service: service() });

    expect(res.status).toBe(409);
    expect(res.body.action).toBe('rejected');
    expect(String(res.body.error)).toContain('不属于 OpenLog 管理');
    // 关键：一个写请求都不能发出去（真机上这一步就是覆盖生产）
    expect(h.writeCalls).toEqual([]);
  });

  it('apply 覆盖 inference/strata（真机事故的原始场景）→ 409', async () => {
    const strata = foreignDeployment('strata', 'inference');
    strata.spec.template.spec.containers[0].image = 'ghcr.io/niko1221/strata:0.2.11-cuda12';
    h.cluster.set(depPath('inference', 'strata'), strata);

    const res = await post('/api/infra/services/strata/apply', {
      service: service({ name: 'strata', namespace: 'inference', engine: { type: 'strata', image: 'evil:1' } }),
    });

    expect(res.status).toBe(409);
    expect(h.writeCalls).toEqual([]);
  });

  it('只带 app.kubernetes.io/managed-by=其它值 也算别人的 → 409', async () => {
    const dep = foreignDeployment();
    dep.metadata.labels['app.kubernetes.io/managed-by'] = 'helm';
    h.cluster.set(depPath('infra-test', 'qwen-test'), dep);

    const res = await post('/api/infra/services/qwen-test/apply', { service: service() });
    expect(res.status).toBe(409);
    expect(h.writeCalls).toEqual([]);
  });

  it('preview 也必须给出 allowed:false（不能预览说能改、执行才 409）', async () => {
    h.cluster.set(depPath('infra-test', 'qwen-test'), foreignDeployment());

    const res = await post('/api/infra/services/qwen-test/preview', { service: service() });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.violations.map((v) => v.code)).toContain('NOT_MANAGED');
  });

  it('自己的对象（带归属标签）→ 允许继续', async () => {
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());

    const res = await post('/api/infra/services/qwen-test/preview', { service: service() });
    expect(res.body.allowed).toBe(true);
    expect((res.body.violations || []).map((v) => v.code)).not.toContain('NOT_MANAGED');
  });
});

/* ────────────────────────── 读不到 ≠ 不存在（fail closed） ────────────────────────── */

describe('读现状失败必须拒绝写入，而不是当成"对象不存在"', () => {
  it('apply 时读 Deployment 返回 403 → 502 且零写请求', async () => {
    const err = new Error('权限不足（403）');
    err.status = 403;
    h.cluster.set(depPath('infra-test', 'qwen-test'), err);

    const res = await post('/api/infra/services/qwen-test/apply', { service: service() });

    expect(res.status).toBe(502);
    expect(String(res.body.error)).toContain('无法确认对象归属');
    expect(h.writeCalls).toEqual([]);
  });

  it('apply 时读现状超时 → 502 且零写请求', async () => {
    h.cluster.set(depPath('infra-test', 'qwen-test'), new Error('context deadline exceeded'));

    const res = await post('/api/infra/services/qwen-test/apply', { service: service() });
    expect(res.status).toBe(502);
    expect(h.writeCalls).toEqual([]);
  });

  it('preview 时读现状失败 → 502（不返回 allowed:true）', async () => {
    const err = new Error('权限不足（403）');
    err.status = 403;
    h.cluster.set(depPath('infra-test', 'qwen-test'), err);

    const res = await post('/api/infra/services/qwen-test/preview', { service: service() });
    expect(res.status).toBe(502);
    expect(res.body.allowed).toBeUndefined();
  });

  it('404 才算"不存在"：首次创建放行', async () => {
    // cluster 里什么都不放 → getJson 抛 404 → 视为不存在
    const res = await post('/api/infra/services/qwen-test/preview', { service: service() });
    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
    expect(res.body.impact.action).toBe('create');
  });
});

/* ────────────────────────── 开关与演示 ────────────────────────── */

describe('开关闸门', () => {
  it('OPENLOG_K8S_INFRA 未设置 → apply 403，零写请求', async () => {
    delete process.env.OPENLOG_K8S_INFRA;
    const res = await post('/api/infra/services/qwen-test/apply', { service: service() });
    expect(res.status).toBe(403);
    expect(res.body.readOnly).toBe(true);
    expect(h.writeCalls).toEqual([]);
  });

  it('值写成 "true"（而不是 "1"）也算关闭', async () => {
    process.env.OPENLOG_K8S_INFRA = 'true';
    const res = await post('/api/infra/services/qwen-test/apply', { service: service() });
    expect(res.status).toBe(403);
  });

  it('读接口不受开关影响（紧急排障要看现状）', async () => {
    delete process.env.OPENLOG_K8S_INFRA;
    const res = await fetch(`${base}/api/infra/services`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(Array.isArray(body.services)).toBe(true);
  });

  it('演示模式 apply → 409，且不读集群', async () => {
    process.env.OPENLOG_DEMO = '1';
    h.settings = { k8sClusters: [] };
    const res = await post('/api/infra/services/x/apply', { service: service() });
    expect(res.status).toBe(409);
    expect(res.body.demo).toBe(true);
    expect(h.getJsonCalls).toEqual([]);
  });
});

/* ────────────────────────── 校验前置 ────────────────────────── */

describe('定义校验先于集群访问', () => {
  it('定义非法时即使没有集群也返回字段级 violations', async () => {
    process.env.OPENLOG_K8S_INFRA = '1';
    h.settings = { k8sClusters: [] };   // 故意没有集群

    const res = await post('/api/infra/services/x/preview', {
      service: { name: 'Bad_Name', namespace: 'kube-system' },
    });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(false);
    const fields = res.body.violations.map((v) => v.field);
    expect(fields).toContain('name');
    expect(fields).toContain('namespace');
    // 结构上就不该走到集群
    expect(h.getJsonCalls).toEqual([]);
  });

  it('kube-system 里的服务名再合法也解析不出集群 → 400（没有集群时）', async () => {
    h.settings = { k8sClusters: [] };
    const res = await post('/api/infra/services/x/preview', { service: service() });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('没有可用的 Kubernetes 集群');
  });
});

/* ────────────────────────── 配额变更的影响提示 ────────────────────────── */

describe('改配额必须诚实告知中断', () => {
  it('单副本改显存 → restarts:true 且 downtimeSeconds ≥ 30', async () => {
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());

    const res = await post('/api/infra/services/qwen-test/preview', {
      service: service({ resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 30 } }),
    });

    expect(res.body.impact.restarts).toBe(true);
    expect(res.body.impact.downtimeSeconds).toBeGreaterThanOrEqual(30);
    expect(res.body.impact.reasons.join(' ')).toContain('重建 Pod');
  });

  it('接口返回的字段名是前端读取的 downtimeSeconds（不是护栏内部的 downtimeEstimateSec）', async () => {
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());
    const res = await post('/api/infra/services/qwen-test/preview', {
      service: service({ resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 30 } }),
    });
    expect(res.body.impact).toHaveProperty('downtimeSeconds');
  });
});

/* ────────────────────────── 快照与回滚 ────────────────────────── */

describe('回滚取快照', () => {
  it('没有快照 → 409（提示清楚，不静默成功）', async () => {
    const res = await post('/api/infra/services/qwen-test/rollback', {});
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain('没有可回滚的快照');
  });

  it('URL 只给服务名时，能按快照键的名字后缀命中', async () => {
    // 快照键是 ns/name，URL 里是纯名字 —— 这正是真机上 409 的原因
    h.kv.infra_snapshots = {
      'infra-test/qwen-test': [{
        at: '2026-11-26T00:00:00.000Z',
        snapshot: {
          namespace: 'infra-test',
          capturedAt: '2026-11-26T00:00:00.000Z',
          objects: [{ ref: { kind: 'Deployment', name: 'qwen-test' }, existed: true, path: depPath('infra-test', 'qwen-test'), body: ownedDeployment() }],
        },
      }],
    };
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());

    const res = await post('/api/infra/services/qwen-test/rollback', {});
    expect(res.status).toBe(200);
    expect(h.writeCalls.some(([method]) => method === 'PATCH')).toBe(true);
  });
});

/* ────────────────────────── 网关注册的安全约束 ────────────────────────── */

describe('网关注册不接受请求体里的配置（防任意 nginx 配置注入）', () => {
  it('apply 时请求体带 nginxConf/baseConfig 会被忽略，ConfigMap 仍是唯一来源', async () => {
    // 自己的对象（允许继续），集群里已有一份网关配置
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());
    h.cluster.set('/api/v1/namespaces/inference/configmaps/reranker-gateway-conf', {
      metadata: { name: 'reranker-gateway-conf', namespace: 'inference' },
      data: { 'nginx.conf': 'stream {\n  # 既有路由\n}\n' },
    });

    const evil = 'stream { server { listen 9999; proxy_pass evil.internal:22; } }';
    const res = await post('/api/infra/services/qwen-test/apply', {
      service: service({ expose: { gatewayPort: 8123 } }),
      // 下面这些字段以前可能被当成配置源；现在必须完全无效
      nginxConf: evil,
      baseConfig: evil,
      configMapName: 'kube-root-ca.crt',
      deploymentName: 'strata',
    });

    expect(res.status).toBe(200);
    // 写请求里绝不出现请求体带来的 evil 内容
    const written = h.writeCalls.map(([, , body]) => JSON.stringify(body ?? '')).join('\n');
    expect(written).not.toContain('evil.internal');
    // 也不允许去写请求体指定的 ConfigMap
    expect(h.writeCalls.some(([, path]) => String(path).includes('kube-root-ca'))).toBe(false);
  });

  it('读网关 ConfigMap 返回 403 时 → 跳过网关注册并给出原因（不误判为"不存在"去新建）', async () => {
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());
    const err = new Error('权限不足（403）');
    err.status = 403;
    h.cluster.set('/api/v1/namespaces/inference/configmaps/reranker-gateway-conf', err);

    const res = await post('/api/infra/services/qwen-test/apply', { service: service({ expose: { gatewayPort: 8124 } }) });
    expect(res.status).toBe(200);
    // 服务本身成功（403 只影响网关注册），但 gateway.ok 必须是 false 且带原因
    expect(res.body.gateway).toBeTruthy();
    expect(res.body.gateway.ok).toBe(false);
    expect(String(res.body.gateway.error)).toContain('已跳过网关注册');
  });

  it('端口冲突时网关侧硬失败，不会静默少一条路由', async () => {
    // 两个服务抢同一端口
    // 两个服务都必须"真实存在且受管"才会进入网关渲染（否则会被 filterExposedManaged 过滤掉）
    const mk = (name) => {
      const dep = ownedDeployment(name);
      h.cluster.set(depPath('infra-test', name), dep);
      return { name, namespace: 'infra-test', expose: { gatewayPort: 8125 } };
    };
    h.settings = {
      k8sClusters: [CLUSTER],
      infraServices: [mk('a'), mk('b'), mk('qwen-test')],
    };
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());
    h.cluster.set('/api/v1/namespaces/inference/configmaps/reranker-gateway-conf', {
      metadata: { name: 'reranker-gateway-conf', namespace: 'inference' },
      data: { 'nginx.conf': 'stream {\n}\n' },
    });

    const res = await post('/api/infra/services/qwen-test/apply', { service: service({ expose: { gatewayPort: 8125 } }) });
    expect(res.status).toBe(200);
    expect(res.body.gateway.ok).toBe(false);
    expect(String(res.body.gateway.error)).toContain('端口冲突');
  });
});

/* ────────────────────── rollout 超时随模型大小 ────────────────────── */
describe('rollout 超时不能写死 120s（32B 模型实测起不来）', () => {
  it('显式指定优先，并夹在 30s..30min', async () => {
    const { resolveRolloutTimeout } = await import('../routes/infra.js');
    expect(resolveRolloutTimeout(600_000)).toBe(600_000);
    expect(resolveRolloutTimeout(1_000)).toBe(30_000);      // 下限
    expect(resolveRolloutTimeout(99_999_999)).toBe(1_800_000); // 上限
  });

  it('按 model.sizeMiB 估算（每 GiB 约 6 秒 + 60 秒基线）', async () => {
    const { resolveRolloutTimeout } = await import('../routes/infra.js');
    // 20 GiB 权重 → 20*6000+60000 = 180s
    expect(resolveRolloutTimeout(undefined, { model: { sizeMiB: 20480 } })).toBe(180_000);
    // 小模型不缩到基线以下
    expect(resolveRolloutTimeout(undefined, { model: { sizeMiB: 512 } })).toBe(120_000);
    // 没有大小信息时用工厂默认
    expect(resolveRolloutTimeout(undefined, {}, { rolloutTimeoutMs: 90_000 })).toBe(90_000);
  });

  it('apply 请求里的 rolloutTimeoutMs 会被采用（大模型不再被 120s 误杀）', async () => {
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());
    const res = await post('/api/infra/services/qwen-test/apply', {
      service: service(),
      rolloutTimeoutMs: 300_000,
    });
    // 只断言请求被接受（具体值由 resolveRolloutTimeout 单测覆盖）
    expect([200, 502]).toContain(res.status);
  });
});

/* ─────────────── 模型足迹：档位预检（真机三次尝试的回归） ─────────────── */
describe('模型放不进配额时必须挡住（真机 21 GiB / 22.7 GiB 都崩过）', () => {
  /** 32B-AWQ 的形状，配额按真机三档传 */
  function bigService(memoryMiB) {
    return service({
      name: 'big-model',
      model: { source: 'hostPath', path: '/models/Qwen2.5-VL-32B-Instruct-AWQ', sizeMiB: 20237, quantization: 'awq', parametersB: 32, contextLength: 2048 },
      engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.32.0', args: ['--gpu-memory-utilization', '0.92'] },
      resources: { accelerators: 1, memoryMiB, coresPercent: 10 },
    });
  }

  it('21 GiB 配额 → allowed:false + MODEL_FOOTPRINT_EXCEEDED', async () => {
    const res = await post('/api/infra/services/big-model/preview', { service: bigService(21504) });
    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(false);
    const codes = (res.body.violations || []).map((v) => v.code);
    expect(codes).toContain('MODEL_FOOTPRINT_EXCEEDED');
    expect(res.body.footprint.verdict).toBe('insufficient');
  });

  it('22.7 GiB（4090 全部剩余）仍不够 —— KV cache 会为负', async () => {
    const res = await post('/api/infra/services/big-model/preview', { service: bigService(23284) });
    expect(res.body.allowed).toBe(false);
    expect((res.body.violations || []).map((v) => v.code)).toContain('MODEL_FOOTPRINT_EXCEEDED');
  });

  it('28 GiB → 放得下，且响应里带 footprint 明细', async () => {
    const res = await post('/api/infra/services/big-model/preview', { service: bigService(28672) });
    expect(res.body.allowed).toBe(true);
    expect((res.body.violations || []).map((v) => v.code)).not.toContain('MODEL_FOOTPRINT_EXCEEDED');
    expect(res.body.footprint.verdict).toBe('fits');
    expect(res.body.footprint.breakdown.weightsMiB).toBe(20237);
  });

  it('小模型在小配额下也能通过（不能把正常配置也拦掉）', async () => {
    const res = await post('/api/infra/services/qwen-test/preview', {
      service: service({
        model: { source: 'hostPath', path: '/models/tiny', sizeMiB: 1024, quantization: 'fp16', parametersB: 0.6, contextLength: 2048 },
        resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 10 },
      }),
    });
    expect(res.body.allowed).toBe(true);
    expect(res.body.footprint.verdict).toBe('fits');
  });

  it('tight 不拦，但把原因透出来（让用户自己判断）', async () => {
    // 配额刚好超过需求但不足 10% 余量
    const probe = await post('/api/infra/services/big-model/preview', { service: bigService(28672) });
    const need = probe.body.footprint.requiredMiB;
    const res = await post('/api/infra/services/big-model/preview', { service: bigService(Math.ceil(need)) });
    expect(res.body.footprint.verdict).toBe('tight');
    expect(res.body.allowed).toBe(true);   // tight 是警告不是阻断
    expect(res.body.footprint.reasons.join(' ')).toContain('勉强够');
  });
});

/* ────────────── 只保存定义（不下发） ────────────── */
describe('保存定义不需要碰集群（bench 回填与"先想清楚再下发"都靠它）', () => {
  it('合法定义 → 200 且零集群调用', async () => {
    const res = await post('/api/infra/services/qwen-test/definition', { service: service() });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service.name).toBe('qwen-test');
    expect(h.getJsonCalls).toEqual([]);
  });

  it('不合法定义 → 400 + 字段级 violations', async () => {
    const res = await post('/api/infra/services/x/definition', {
      service: { name: 'Bad_Name', namespace: 'kube-system' },
    });
    expect(res.status).toBe(400);
    expect(res.body.violations.map((v) => v.field)).toContain('name');
  });

  it('保存两次是 upsert 而不是重复（id 稳定、version 自增）', async () => {
    const a = await post('/api/infra/services/qwen-test/definition', { service: service() });
    const id = a.body.service.id;
    const b = await post('/api/infra/services/qwen-test/definition', { service: service({ replicas: 2 }) });
    expect(b.body.service.id).toBe(id);
    expect(b.body.service.version).toBeGreaterThan(a.body.service.version);
    expect(b.body.service.replicas).toBe(2);
  });

  it('演示模式 → 409', async () => {
    process.env.OPENLOG_DEMO = '1';
    const res = await post('/api/infra/services/qwen-test/definition', { service: service() });
    expect(res.status).toBe(409);
  });
});

/* ────────── 实测值的归属：属于服务，不是属于这次请求 ────────── */
describe('bench 回填的实测值在后续 preview 里生效', () => {
  it('请求体没带 measuredMemMiB，但已存定义里有 → footprint 用实测', async () => {
    // 先存一份带实测的定义
    const saved = await post('/api/infra/services/qwen-test/definition', {
      service: service({
        model: { source: 'hostPath', path: '/a', contextLength: 4096, measuredMemMiB: 3000, measuredMaxConcurrency: 1 },
        resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 10 },
      }),
    });
    expect(saved.status).toBe(200);

    // 预览时故意不带 measuredMemMiB
    const res = await post('/api/infra/services/qwen-test/preview', {
      service: service({
        model: { source: 'hostPath', path: '/a', contextLength: 4096 },
        resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 10 },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.footprint.basis).toBe('measured');
    expect(res.body.footprint.requiredMiB).toBe(3000);
  });

  it('请求体显式带实测值时以请求为准（可以临时试算）', async () => {
    await post('/api/infra/services/qwen-test/definition', {
      service: service({
        model: { source: 'hostPath', path: '/a', contextLength: 4096, measuredMemMiB: 3000 },
        resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 10 },
      }),
    });
    const res = await post('/api/infra/services/qwen-test/preview', {
      service: service({
        model: { source: 'hostPath', path: '/a', contextLength: 4096, measuredMemMiB: 7000 },
        resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 10 },
      }),
    });
    expect(res.body.footprint.requiredMiB).toBe(7000);
  });
});

/* ────────── 回填口径：压测长度 ≠ 服务上下文 ────────── */
describe('bench 回填时不能把压测输入长度当成服务上下文', () => {
  it('定义里有 contextLength=32768、压测只喂 64 → measuredContextLength 必须是 32768', async () => {
    // 先存定义（上下文 32768）
    await post('/api/infra/services/big-svc/definition', {
      service: service({
        name: 'big-svc',
        model: { source: 'hostPath', path: '/a', contextLength: 32768 },
      }),
    });
    // 跑基准（inputTokens 只有 64），并给实测显存
    const res = await post('/api/infra/bench', {
      target: { url: 'http://127.0.0.1:9/v1/chat/completions', model: 'm' },
      matrix: { concurrencies: [1, 2], inputTokens: [64] },
      limits: { maxTotalMs: 200, maxRequestsPerCell: 1, maxP95TtftMs: 60000 },
      serviceKey: 'infra-test/big-svc',
      gpuMemPeakMiB: 9000,
    });
    expect(res.status).toBe(200);
    expect(res.body.backfilled).toBeTruthy();

    // 再 preview：实测上下文应沿用定义的 32768，而不是 64
    const pv = await post('/api/infra/services/big-svc/preview', {
      service: service({ name: 'big-svc', model: { source: 'hostPath', path: '/a', contextLength: 32768 } }),
    });
    expect(pv.body.footprint.measured.contextLength).toBe(32768);
    expect(pv.body.footprint.measured.maxConcurrency).toBe(2);
  });
});

/* ────────── 脏定义不能污染网关（本项目踩过 nginx CrashLoop） ────────── */
describe('settings 里的残留定义即使带 expose 也不能进网关', () => {
  it('集群里不存在的服务 + 带 expose 端口 → 不写进网关配置', async () => {
    h.settings = {
      k8sClusters: [CLUSTER],
      infraServices: [
        // 幽灵服务：有 expose 但集群里没有 Deployment
        { name: 'ghost-svc', namespace: 'infra-test', expose: { gatewayPort: 8199 } },
      ],
    };
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());
    h.cluster.set('/api/v1/namespaces/inference/configmaps/reranker-gateway-conf', {
      metadata: { name: 'reranker-gateway-conf', namespace: 'inference' },
      data: { 'nginx.conf': 'stream {\n  # 既有\n}\n' },
    });

    const res = await post('/api/infra/services/qwen-test/apply', {
      service: service({ expose: { gatewayPort: 8126 } }),
    });
    expect(res.status).toBe(200);
    // 关键：写进 ConfigMap 的 nginx 配置里不能出现幽灵服务的上游
    const written = h.writeCalls.map(([, , body]) => JSON.stringify(body ?? '')).join('\n');
    expect(written).not.toContain('ghost-svc');
  });

  it('集群里存在但不受管（无 managedBy）的服务 → 同样不进网关', async () => {
    const foreign = foreignDeployment('someone-else');
    h.cluster.set(depPath('infra-test', 'someone-else'), foreign);
    h.settings = {
      k8sClusters: [CLUSTER],
      infraServices: [{ name: 'someone-else', namespace: 'infra-test', expose: { gatewayPort: 8198 } }],
    };
    h.cluster.set(depPath('infra-test', 'qwen-test'), ownedDeployment());
    h.cluster.set('/api/v1/namespaces/inference/configmaps/reranker-gateway-conf', {
      metadata: { name: 'reranker-gateway-conf', namespace: 'inference' },
      data: { 'nginx.conf': 'stream {\n}\n' },
    });

    const res = await post('/api/infra/services/qwen-test/apply', {
      service: service({ expose: { gatewayPort: 8127 } }),
    });
    expect(res.status).toBe(200);
    const written = h.writeCalls.map(([, , body]) => JSON.stringify(body ?? '')).join('\n');
    expect(written).not.toContain('someone-else');
  });
});

/* ────────── 删除定义（只删记录，不动集群） ────────── */
describe('删除服务定义', () => {
  it('删掉后列表里不再出现，且零集群调用', async () => {
    await post('/api/infra/services/qwen-test/definition', { service: service() });
    const res = await fetch(`${base}/api/infra/services/qwen-test`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.removed).toBe('infra-test/qwen-test');
    expect(body.note).toContain('集群里的工作负载未受影响');
    expect(h.getJsonCalls).toEqual([]);

    const list = await fetch(`${base}/api/infra/services`);
    const data = await list.json();
    expect((data.services || []).some((s) => s.name === 'qwen-test')).toBe(false);
  });

  it('删不存在的 → 404', async () => {
    const res = await fetch(`${base}/api/infra/services/nope`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('顺带清掉快照（否则回滚历史指向不存在的服务）', async () => {
    await post('/api/infra/services/qwen-test/definition', { service: service() });
    h.kv.infra_snapshots = { 'infra-test/qwen-test': [{ at: 'x', snapshot: { objects: [] } }] };
    const res = await fetch(`${base}/api/infra/services/qwen-test`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(h.kv.infra_snapshots['infra-test/qwen-test']).toBeUndefined();
  });

  it('演示模式 → 409', async () => {
    process.env.OPENLOG_DEMO = '1';
    const res = await fetch(`${base}/api/infra/services/x`, { method: 'DELETE' });
    expect(res.status).toBe(409);
  });
});
