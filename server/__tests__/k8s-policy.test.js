/**
 * routes/k8s-policy.js 测试（A7）
 *
 * 只验证本模块的语义：取数优先级（Deployment args → ConfigMap → default）、
 * 两种参数写法、非法值降级、演示模式不连集群、404、读取失败降级（unknown + 200）、
 * 以及纯解析函数（parseSchedulerArgs / parseOvercommit / normalizePolicyValue）的边界。
 *
 * 不 mock 模块：路由支持注入 `createClient`，用假客户端就能把「kube-apiserver 返回什么」
 * 写清楚，比 vi.mock 更能覆盖真实分支（包括默认客户端路径下的「缺 kubeconfig」降级）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import {
  createK8sPolicyRouter,
  parseSchedulerArgs,
  parseSchedulerConfigMap,
  parseOvercommit,
  normalizePolicyValue,
} from '../routes/k8s-policy.js';

const POLICY_PATH = '/api/k8s/clusters/c-1/policy';
const DEPLOY_PATH = '/apis/apps/v1/namespaces/kube-system/deployments/hami-scheduler';
const CM_DEVICE_PATH = '/api/v1/namespaces/kube-system/configmaps/hami-scheduler-device';
const CM_CONFIG_PATH = '/api/v1/namespaces/kube-system/configmaps/hami-scheduler-config';

// ── 可变的测试状态 ──────────────────────────────────────────────────
const h = {
  settings: { k8sClusters: [] },
  /** path → 对象（正常返回）或 Error（抛错） */
  responses: {},
  /** 记录被请求过的 path，用于断言「演示模式不连集群」 */
  calls: [],
  /** 记录客户端工厂被调用的次数（演示模式必须为 0） */
  clientCreates: [],
  settingsThrows: false,
  clientThrows: false,
};

function resetState() {
  h.settings = { k8sClusters: [] };
  h.responses = {};
  h.calls = [];
  h.clientCreates = [];
  h.settingsThrows = false;
  h.clientThrows = false;
  delete process.env.OPENLOG_DEMO;
}

/** 假客户端：未登记的 path 一律 404（等价于 kube-apiserver 的资源不存在） */
function fakeClient() {
  return {
    async getJson(path) {
      h.calls.push(path);
      const hit = h.responses[path];
      if (hit === undefined) {
        const err = new Error(`Kubernetes API 资源不存在（HTTP 404）：${path}`);
        err.status = 404;
        throw err;
      }
      if (hit instanceof Error) throw hit;
      return hit;
    },
  };
}

function seedCluster(overrides = {}) {
  h.settings = {
    k8sClusters: [{
      id: 'c-1',
      name: 'k3s 测试集群',
      kubeconfig: 'apiVersion: v1\nclusters:\n- cluster:\n    server: https://127.0.0.1:6443\n  name: k3s\n',
      context: 'k3s',
      enabled: true,
      ...overrides,
    }],
  };
}

/** 构造 hami-scheduler Deployment（args 可省略） */
function deployment(args) {
  return {
    metadata: { name: 'hami-scheduler', namespace: 'kube-system' },
    spec: { template: { spec: { containers: [{ name: 'hami-scheduler', args }] } } },
  };
}

/** 构造 ConfigMap */
function configMap(name, data) {
  return { metadata: { name, namespace: 'kube-system' }, data };
}

// ── 服务 ─────────────────────────────────────────────────────────

const router = createK8sPolicyRouter({
  ensureSettings: () => {
    if (h.settingsThrows) throw new Error('settings 读取失败');
    return h.settings;
  },
  createClient: (record) => {
    if (h.clientThrows) throw new Error('kubeconfig 解析失败：缺少 server 字段');
    // 演示模式断言用：工厂一旦被调用就说明路由去连集群了
    h.clientCreates.push(record?.id);
    return fakeClient();
  },
});

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(resetState);
afterEach(() => { delete process.env.OPENLOG_DEMO; });

async function get(path) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body, text };
}

/** 一个「两个来源都读失败」的标准场景（Deployment 403 + 两个 ConfigMap 403） */
function denyAll() {
  const deny = () => Object.assign(new Error('Kubernetes API 权限不足，缺少对 deployments 的 GET 权限（HTTP 403）'), { status: 403 });
  h.responses[DEPLOY_PATH] = deny();
  h.responses[CM_DEVICE_PATH] = deny();
  h.responses[CM_CONFIG_PATH] = deny();
}

// ══════════════════════════════════════════════════════════════════
// 纯函数：parseSchedulerArgs
// ══════════════════════════════════════════════════════════════════

describe('parseSchedulerArgs（纯函数）', () => {
  it('等号写法：三项全部解析出来，raw 保留原始键值', () => {
    const out = parseSchedulerArgs([
      '--leader-elect=true',
      '--node-scheduler-policy=binpack',
      '--device-scheduler-policy=spread',
      '--overcommit=false',
    ]);
    expect(out.nodeSchedulerPolicy).toBe('binpack');
    expect(out.deviceSchedulerPolicy).toBe('spread');
    expect(out.overcommit).toBe(false);
    expect(out.raw).toEqual([
      { key: 'node-scheduler-policy', value: 'binpack' },
      { key: 'device-scheduler-policy', value: 'spread' },
      { key: 'overcommit', value: 'false' },
    ]);
  });

  it('空格写法：值取自下一项，且不会把下一个参数当值', () => {
    const out = parseSchedulerArgs([
      '--node-scheduler-policy', 'spread',
      '--device-scheduler-policy', 'binpack',
      '--overcommit', '1',
      '--v', '2',
    ]);
    expect(out.nodeSchedulerPolicy).toBe('spread');
    expect(out.deviceSchedulerPolicy).toBe('binpack');
    expect(out.overcommit).toBe(true);
    expect(out.raw).toHaveLength(3);
  });

  it('缺参数：认不出的 args 一律忽略，四个值全 null', () => {
    const out = parseSchedulerArgs(['--logtostderr=true', '--v=2', '--scheduler-name=hami-scheduler']);
    expect(out).toEqual({
      nodeSchedulerPolicy: null,
      deviceSchedulerPolicy: null,
      overcommit: null,
      resourceStrategy: null,
      raw: [],
    });
  });

  it('大小写与下划线写法：NODE_SCHEDULER_POLICY=BINPACK 归一化为 binpack', () => {
    const out = parseSchedulerArgs([
      '--NODE_SCHEDULER_POLICY=BINPACK',
      '--Device_Scheduler_Policy=Spread',
      '--OverCommit=TRUE',
    ]);
    expect(out.nodeSchedulerPolicy).toBe('binpack');
    expect(out.deviceSchedulerPolicy).toBe('spread');
    expect(out.overcommit).toBe(true);
  });

  it('空白：首尾空白、等号两侧空白、空值都按预期处理', () => {
    const out = parseSchedulerArgs([
      '  --node-scheduler-policy =  binpack  ',
      '   --device-scheduler-policy   ',
      '   ',
      null,
      undefined,
      42,
    ]);
    expect(out.nodeSchedulerPolicy).toBe('binpack');
    // 空格写法取到 '   ' → 归一化后为空 → null
    expect(out.deviceSchedulerPolicy).toBeNull();
    expect(out.overcommit).toBeNull();
  });

  it('非法值与缺值：不认识的值保持 null，不给前端脏字符串', () => {
    const out = parseSchedulerArgs([
      '--node-scheduler-policy=random-pick',
      '--device-scheduler-policy',
      '--overcommit=maybe',
      '--resource-strategy=node',
    ]);
    expect(out.nodeSchedulerPolicy).toBeNull();
    expect(out.deviceSchedulerPolicy).toBeNull();
    expect(out.overcommit).toBeNull();
    expect(out.resourceStrategy).toBe('node');
  });
});

describe('parseOvercommit / normalizePolicyValue（纯函数）', () => {
  it('overcommit 布尔解析：true / false / 1 / 0', () => {
    expect(parseOvercommit('true')).toBe(true);
    expect(parseOvercommit('false')).toBe(false);
    expect(parseOvercommit('1')).toBe(true);
    expect(parseOvercommit('0')).toBe(false);
    expect(parseOvercommit(' TRUE ')).toBe(true);
    expect(parseOvercommit('Off')).toBe(false);
    expect(parseOvercommit('')).toBeNull();
    expect(parseOvercommit('2')).toBeNull();
    expect(parseOvercommit(true)).toBe(true);
    expect(parseOvercommit(0)).toBe(false);
  });

  it('策略值：大小写/空白/连字符变体都归一化为 binpack 或 spread', () => {
    expect(normalizePolicyValue('binpack')).toBe('binpack');
    expect(normalizePolicyValue('BinPack')).toBe('binpack');
    expect(normalizePolicyValue(' bin-packing ')).toBe('binpack');
    expect(normalizePolicyValue('SPREAD')).toBe('spread');
    expect(normalizePolicyValue('')).toBeNull();
    expect(normalizePolicyValue('random')).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// ConfigMap 解析
// ══════════════════════════════════════════════════════════════════

describe('parseSchedulerConfigMap（纯函数）', () => {
  it('key 直接同名：命中并归一化', () => {
    const out = parseSchedulerConfigMap(configMap('hami-scheduler-device', {
      'node-scheduler-policy': 'spread',
      'HAMI_DEVICE_SCHEDULER_POLICY': 'binpack',
      'overcommit': 'true',
      'unrelated': 'x',
    }));
    expect(out.nodeSchedulerPolicy).toBe('spread');
    expect(out.deviceSchedulerPolicy).toBe('binpack');
    expect(out.overcommit).toBe(true);
    expect(out.raw).toHaveLength(3);
  });

  it('key 是文件名时，从 value 文本的 YAML 行里取（HAMi device-config.yaml 形态）', () => {
    const out = parseSchedulerConfigMap(configMap('hami-scheduler-config', {
      'device-config.yaml': [
        'nodeSchedulerPolicy: binpack',
        'deviceSchedulerPolicy: spread',
        'overcommit: false',
      ].join('\n'),
    }));
    expect(out.nodeSchedulerPolicy).toBe('binpack');
    expect(out.deviceSchedulerPolicy).toBe('spread');
    expect(out.overcommit).toBe(false);
    expect(out.raw[0].key).toBe('device-config.yaml:nodeSchedulerPolicy');
  });

  it('非法 ConfigMap（值不认识 / data 缺失）一律 null', () => {
    expect(parseSchedulerConfigMap(configMap('x', { 'node-scheduler-policy': 'whatever' })).nodeSchedulerPolicy)
      .toBeNull();
    expect(parseSchedulerConfigMap(configMap('x', { 'overcommit': 'enabled-ish' })).overcommit).toBeNull();
    expect(parseSchedulerConfigMap(null)).toMatchObject({ nodeSchedulerPolicy: null });
    expect(parseSchedulerConfigMap({ data: null })).toMatchObject({ nodeSchedulerPolicy: null });
  });
});

// ══════════════════════════════════════════════════════════════════
// HTTP 语义
// ══════════════════════════════════════════════════════════════════

describe('GET /api/k8s/clusters/:id/policy', () => {
  it('Deployment args 命中 → source:args，响应形状完整', async () => {
    seedCluster();
    h.responses[DEPLOY_PATH] = deployment([
      '--node-scheduler-policy=spread',
      '--device-scheduler-policy', 'binpack',
      '--overcommit=true',
    ]);
    // ConfigMap 也放一份不同的值：args 必须优先
    h.responses[CM_DEVICE_PATH] = configMap('hami-scheduler-device', {
      'node-scheduler-policy': 'binpack',
      'device-scheduler-policy': 'spread',
    });

    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      nodeSchedulerPolicy: 'spread',
      deviceSchedulerPolicy: 'binpack',
      overcommit: true,
      source: 'args',
    });
    expect(body.defaults).toMatchObject({ nodeSchedulerPolicy: 'binpack', deviceSchedulerPolicy: 'binpack' });
    expect(Array.isArray(body.raw)).toBe(true);
    expect(body.demo).toBeUndefined();
    // 三项核心参数都来自 args 时不再去读 ConfigMap（省一次请求）
    expect(h.calls).not.toContain(CM_DEVICE_PATH);
    expect(h.clientCreates).toEqual(['c-1']);
  });

  it('ConfigMap 命中（Deployment 存在但 args 无相关参数）→ source:configmap', async () => {
    seedCluster();
    h.responses[DEPLOY_PATH] = deployment(['--leader-elect=true', '--v=4']);
    h.responses[CM_DEVICE_PATH] = configMap('hami-scheduler-device', {
      'node-scheduler-policy': 'spread',
      'overcommit': '0',
    });

    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      nodeSchedulerPolicy: 'spread',
      deviceSchedulerPolicy: null,
      overcommit: false,
      source: 'configmap',
    });
    expect(h.calls).toEqual([DEPLOY_PATH, CM_DEVICE_PATH]);
    expect(h.clientCreates).toEqual(['c-1']);
  });

  it('Deployment 不存在时回退到第二个 ConfigMap（hami-scheduler-config）', async () => {
    seedCluster();
    h.responses[CM_CONFIG_PATH] = configMap('hami-scheduler-config', { 'device-scheduler-policy': 'SPREAD' });

    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body.deviceSchedulerPolicy).toBe('spread');
    expect(body.source).toBe('configmap');
    expect(h.calls).toContain(CM_DEVICE_PATH);
    expect(h.calls).toContain(CM_CONFIG_PATH);
  });

  it('ConfigMap 值非法（与 args 都不命中）→ 全 null，source:default，带默认值说明', async () => {
    seedCluster();
    h.responses[DEPLOY_PATH] = deployment([]);
    h.responses[CM_DEVICE_PATH] = configMap('hami-scheduler-device', {
      'node-scheduler-policy': 'lottery',
      'overcommit': 'sometimes',
    });

    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      nodeSchedulerPolicy: null,
      deviceSchedulerPolicy: null,
      overcommit: null,
      resourceStrategy: null,
      source: 'default',
    });
    expect(body.note).toContain('binpack');
    expect(body.raw).toEqual([]);
  });

  it('两者都缺（Deployment 空 args + ConfigMap 空 data）→ source:default + 默认值说明', async () => {
    seedCluster();
    h.responses[DEPLOY_PATH] = deployment([]);
    h.responses[CM_DEVICE_PATH] = configMap('hami-scheduler-device', {});
    h.responses[CM_CONFIG_PATH] = configMap('hami-scheduler-config', {});

    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body.source).toBe('default');
    expect(body.overcommit).toBeNull();
    expect(body.defaults).toEqual({
      nodeSchedulerPolicy: 'binpack',
      deviceSchedulerPolicy: 'binpack',
      overcommit: false,
    });
    expect(body.note).toContain('binpack');
  });

  it('读取失败（Deployment + ConfigMap 全部 403）→ source:unknown + 200，不抛 500', async () => {
    seedCluster();
    denyAll();

    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body.source).toBe('unknown');
    expect(body.nodeSchedulerPolicy).toBeNull();
    expect(body.deviceSchedulerPolicy).toBeNull();
    expect(body.overcommit).toBeNull();
    expect(body.reason).toContain('403');
    // 读不到时也要给默认值说明，但文案要区分「没配」与「读不到」
    expect(body.note).toContain('binpack');
    expect(body.defaults.nodeSchedulerPolicy).toBe('binpack');
  });

  it('部分失败（Deployment 403、ConfigMap 命中）→ 仍是 200，source:configmap + reason', async () => {
    seedCluster();
    h.responses[DEPLOY_PATH] = Object.assign(new Error('连接失败'), { status: 403 });
    h.responses[CM_DEVICE_PATH] = configMap('hami-scheduler-device', { 'node-scheduler-policy': 'binpack' });

    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body.source).toBe('configmap');
    expect(body.nodeSchedulerPolicy).toBe('binpack');
    expect(body.reason).toContain('Deployment');
  });

  it('集群不存在 → 404（不建客户端、不读集群）', async () => {
    seedCluster();
    const { status, body } = await get('/api/k8s/clusters/not-exist/policy');
    expect(status).toBe(404);
    expect(body.error).toContain('Kubernetes 集群不存在');
    expect(h.calls).toEqual([]);
  });

  it('客户端创建失败（缺 kubeconfig，走默认客户端路径）→ unknown + 200', async () => {
    // 不注入 createClient：这里用真实路由实例无法替换工厂，故直接新建一个只走默认路径的路由
    const realRouter = createK8sPolicyRouter({
      ensureSettings: () => ({ k8sClusters: [{ id: 'no-kc', name: 'x', kubeconfig: '' }] }),
    });
    const app = express();
    app.use(realRouter);
    const local = http.createServer(app);
    await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${local.address().port}/api/k8s/clusters/no-kc/policy`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.source).toBe('unknown');
      expect(body.reason).toContain('kubeconfig');
      expect(body.nodeSchedulerPolicy).toBeNull();
    } finally {
      await new Promise((resolve) => local.close(resolve));
    }
  });

  it('settings 读取抛错 → unknown + 200（不是 500）', async () => {
    seedCluster();
    h.settingsThrows = true;
    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body.source).toBe('unknown');
    expect(body.reason).toContain('settings');
  });

  it('演示模式：不连集群、不调客户端工厂，返回 demo:true + 默认值说明', async () => {
    process.env.OPENLOG_DEMO = '1';
    seedCluster();

    const { status, body } = await get('/api/k8s/clusters/demo-k3s-infer/policy');
    expect(status).toBe(200);
    expect(body.demo).toBe(true);
    expect(body.source).toBe('default');
    expect(body.nodeSchedulerPolicy).toBeNull();
    expect(body.deviceSchedulerPolicy).toBeNull();
    expect(body.overcommit).toBeNull();
    expect(body.defaults.nodeSchedulerPolicy).toBe('binpack');
    expect(body.note).toContain('binpack');
    // 关键：一次集群访问、一次客户端工厂调用都没有
    expect(h.calls).toEqual([]);
    expect(h.clientCreates).toEqual([]);
  });

  it('演示模式：演示集群清单里没有的 id → 404 + demo:true', async () => {
    process.env.OPENLOG_DEMO = '1';
    seedCluster();
    const { status, body } = await get('/api/k8s/clusters/real-prod-243/policy');
    expect(status).toBe(404);
    expect(body.demo).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.clientCreates).toEqual([]);
  });

  it('containers[0] 是旁挂 sidecar 时，回退到名字含 scheduler 的容器读 args', async () => {
    seedCluster();
    h.responses[DEPLOY_PATH] = {
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'istio-proxy', args: ['--proxy-log-level=warn'] },
              { name: 'hami-scheduler', args: ['--device-scheduler-policy=spread', '--overcommit=false'] },
            ],
          },
        },
      },
    };

    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body.deviceSchedulerPolicy).toBe('spread');
    expect(body.overcommit).toBe(false);
    expect(body.source).toBe('args');
  });

  it('args 只给了一部分时，用 ConfigMap 补齐剩下字段（同级优先）', async () => {
    seedCluster();
    h.responses[DEPLOY_PATH] = deployment(['--node-scheduler-policy=binpack']);
    h.responses[CM_DEVICE_PATH] = configMap('hami-scheduler-device', {
      'node-scheduler-policy': 'spread',
      'device-scheduler-policy': 'spread',
      'overcommit': '1',
    });

    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    // node 来自 args（spread 不能覆盖它），device / overcommit 由 ConfigMap 补齐
    expect(body.nodeSchedulerPolicy).toBe('binpack');
    expect(body.deviceSchedulerPolicy).toBe('spread');
    expect(body.overcommit).toBe(true);
    expect(body.source).toBe('args');
    expect(body.raw).toEqual([
      { key: 'node-scheduler-policy', value: 'binpack' },
      { key: 'device-scheduler-policy', value: 'spread' },
      { key: 'overcommit', value: '1' },
    ]);
  });

  it('端到端：默认客户端连本地假 apiserver，读到 Deployment args 且 ConfigMap 404 不影响结果', async () => {
    const api = http.createServer((req, res) => {
      if (req.url === DEPLOY_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(deployment([
          '--node-scheduler-policy=spread',
          '--device-scheduler-policy=binpack',
          '--overcommit=0',
        ])));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'Status', code: 404 }));
    });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    const apiPort = api.address().port;
    const kubeconfig = [
      'apiVersion: v1',
      'kind: Config',
      'current-context: k3s',
      'clusters:',
      '- name: k3s',
      '  cluster:',
      `    server: http://127.0.0.1:${apiPort}`,
      'contexts:',
      '- name: k3s',
      '  context:',
      '    cluster: k3s',
      '    user: k3s',
      'users:',
      '- name: k3s',
      '  user:',
      '    token: test-token',
      '',
    ].join('\n');

    // 不注入 createClient：走真实的 kubeconfig 解析 + ../k8s/client.js
    const e2eRouter = createK8sPolicyRouter({
      ensureSettings: () => ({ k8sClusters: [{ id: 'e2e', name: 'e2e', kubeconfig, context: 'k3s' }] }),
    });
    const app = express();
    app.use(e2eRouter);
    const local = http.createServer(app);
    await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${local.address().port}/api/k8s/clusters/e2e/policy`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        nodeSchedulerPolicy: 'spread',
        deviceSchedulerPolicy: 'binpack',
        overcommit: false,
        source: 'args',
      });
    } finally {
      await new Promise((resolve) => local.close(resolve));
      await new Promise((resolve) => api.close(resolve));
    }
  });

  it('resourceStrategy 透出，并作为 ConfigMap 兜底字段', async () => {
    seedCluster();
    h.responses[DEPLOY_PATH] = deployment(['--resource-strategy=device']);
    const { status, body } = await get(POLICY_PATH);
    expect(status).toBe(200);
    expect(body.resourceStrategy).toBe('device');
    expect(body.source).toBe('args');
  });
});
