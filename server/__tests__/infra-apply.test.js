import { test, expect, vi } from 'vitest';
import {
  ALLOWED_NAMESPACES,
  STEP_NAMES,
  applyService,
  buildObjectPath,
  defaultVerifyAllocation,
  diffObjects,
  evaluateRollout,
  rollbackService,
} from '../infra/apply.js';

// 全部用例都跑在假集群上：没有 kubectl / docker / ssh，也没有任何真实网络与真实 sleep。
const NS = 'inference';
const ENABLED = { OPENLOG_K8S_INFRA: '1' };

// ───────────────────────────── 夹具 ─────────────────────────────

/** 渲染结果：Deployment（镜像可换，用来构造"有差异"的场景）。 */
function deploymentWithImage(image = 'vllm/vllm-openai:v0.6.3') {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'qwen', namespace: NS, labels: { app: 'qwen', 'app.kubernetes.io/managed-by': 'openlog' } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'qwen' } },
      template: {
        metadata: { labels: { app: 'qwen' } },
        spec: {
          containers: [{
            name: 'engine',
            image,
            ports: [{ name: 'http', containerPort: 8000 }],
            resources: {
              limits: { 'nvidia.com/gpumem': 8192, 'nvidia.com/gpucores': 30 },
            },
          }],
        },
      },
    },
  };
}

function renderedService() {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'qwen', namespace: NS, labels: { app: 'qwen' } },
    spec: { selector: { app: 'qwen' }, ports: [{ name: 'http', port: 8000, targetPort: 8000 }] },
  };
}

/** A1 的 ModelService（执行器只读 namespace / replicas / resources）。 */
function modelService(overrides = {}) {
  return {
    id: 'svc-1',
    name: 'qwen',
    namespace: NS,
    model: { source: 'hostPath', path: '/models/Qwen2.5-7B' },
    engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.6.3' },
    resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 30 },
    replicas: 1,
    ports: [{ name: 'http', containerPort: 8000 }],
    health: { path: '/health' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

function readyStatus(overrides = {}) {
  return {
    observedGeneration: 1,
    replicas: 1,
    updatedReplicas: 1,
    availableReplicas: 1,
    readyReplicas: 1,
    conditions: [
      { type: 'Available', status: 'True' },
      { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
    ],
    ...overrides,
  };
}

function hamiPod(name, annotation, { phase = 'Running', created = '2026-01-01T00:00:00Z' } = {}) {
  const metadata = { name, namespace: NS, labels: { app: 'qwen' }, creationTimestamp: created };
  if (annotation !== null) metadata.annotations = { 'hami.io/vgpu-devices-allocated': annotation };
  return { metadata, status: { phase } };
}

function httpError(status, path, reason) {
  const err = new Error(`Kubernetes API 请求失败（HTTP ${status}）：${path}`);
  err.status = status;
  err.path = path;
  // 真机 client 会把响应体挂到 err.body（重点信息在 Status.message 里）
  if (reason) err.body = JSON.stringify({ kind: 'Status', code: status, message: reason });
  return err;
}

const DEP_PATH = buildObjectPath(deploymentWithImage());
const SVC_PATH = buildObjectPath(renderedService());

/**
 * 假集群：内存 store + 调用记录 + 假时钟/假 sleep + 可注入故障。
 *
 * - `world.status` 控制 Deployment 的 status（函数则每次现算），用来做滚动就绪/超时；
 * - `world.pods` 是 Pod 列表接口的返回；
 * - `world.faults.{read, dryRun, post, patch, delete}` 返回 Error 时抛出来；
 * - `world.clock.t` 是假时间，`sleep` 只推进它（绝不真睡）。
 */
function createWorld({ existing = [], pods = [], status, faults = {} } = {}) {
  const store = new Map(existing.map((obj) => [buildObjectPath(obj), obj]));
  const calls = { get: [], post: [], patch: [], delete: [] };
  let clockNow = 0;

  const client = {
    async getJson(path) {
      calls.get.push(path);
      const readError = faults.read?.(path);
      if (readError) throw readError;
      if (/\/pods(\?|$)/.test(path)) return { items: world.pods };
      const key = path.split('?')[0];
      const obj = store.get(key);
      if (!obj) throw httpError(404, path);
      if (obj.kind === 'Deployment') {
        const current = typeof world.status === 'function' ? world.status() : world.status;
        return current === undefined ? obj : { ...obj, status: current };
      }
      return obj;
    },
    async postJson(path, body, options = {}) {
      calls.post.push({ path, body, options });
      const failure = options.dryRun ? faults.dryRun?.(body, path) : faults.post?.(body, path);
      if (failure) throw failure;
      if (options.dryRun) return body;
      // 创建走集合路径，落库的 key 是"集合路径/对象名"（与 buildObjectPath 一致）
      const collectionPath = path.split('?')[0];
      store.set(`${collectionPath}/${body?.metadata?.name ?? ''}`, body);
      return body;
    },
    async patchJson(path, body, options = {}) {
      calls.patch.push({ path, body, options });
      const writes = calls.patch.filter((call) => !call.options.dryRun).length;
      const failure = options.dryRun
        ? faults.dryRun?.(body, path)
        : faults.patch?.(body, path, writes);
      if (failure) throw failure;
      if (options.dryRun) return body;
      const key = path.split('?')[0];
      const previous = store.get(key) ?? {};
      const merged = {
        ...previous,
        ...body,
        metadata: { ...(previous.metadata ?? {}), ...(body.metadata ?? {}) },
      };
      store.set(key, merged);
      return merged;
    },
    async deleteJson(path) {
      calls.delete.push({ path });
      const failure = faults.delete?.(path);
      if (failure) throw failure;
      const key = path.split('?')[0];
      if (!store.has(key)) throw httpError(404, path);
      store.delete(key);
      return { status: 'Success' };
    },
  };

  const clock = {
    now: () => clockNow,
    sleep: async (ms) => {
      clockNow += ms;
      world.sleepHook?.(ms);
    },
    advance: (ms) => {
      clockNow += ms;
    },
    get t() {
      return clockNow;
    },
  };

  const world = {
    store,
    calls,
    client,
    clock,
    pods,
    status: status ?? readyStatus(),
    faults,
    sleepHook: null,
    /** 真实写入（干跑不算）。 */
    realWrites() {
      const posted = calls.post.filter((call) => !call.options.dryRun).length;
      const patched = calls.patch.filter((call) => !call.options.dryRun).length;
      return posted + patched + calls.delete.length;
    },
    /** 任何 API 调用总数（含读）。 */
    apiCalls() {
      return calls.get.length + calls.post.length + calls.patch.length + calls.delete.length;
    },
  };
  return world;
}

function step(result, name) {
  const hit = result.steps.find((entry) => entry.name === name);
  if (!hit) throw new Error(`缺少步骤 ${name}，实际步骤：${result.steps.map((s) => s.name).join(',')}`);
  return hit;
}

function names(result) {
  return result.steps.map((entry) => entry.name);
}

// ───────────────────────────── ① 正常路径 ─────────────────────────────

test('happy path：护栏→干跑→快照→应用→滚动→配额→端点全绿', async () => {
  const world = createWorld({ pods: [hamiPod('qwen-7d9c', 'GPU-aaaa-1111,NVIDIA,8192,30:;')] });
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage(), renderedService()],
    client: world.client,
    guard: { allowed: true, violations: [], diff: '--- 无既有对象 ---' },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED, probeUrl: 'http://qwen.inference.svc:8000/health', fetchImpl },
  });

  expect(result.ok).toBe(true);
  expect(result.allowed).toBe(true);
  expect(result.action).toBe('create');
  expect(result.rollbackAvailable).toBe(true);
  expect(names(result)).toEqual([
    STEP_NAMES.GUARD,
    STEP_NAMES.DRY_RUN,
    STEP_NAMES.SNAPSHOT,
    STEP_NAMES.APPLY,
    STEP_NAMES.ROLLOUT,
    STEP_NAMES.ALLOCATION,
    STEP_NAMES.ENDPOINT,
  ]);

  // 每步都有结构化字段，前端能逐步渲染
  for (const entry of result.steps) {
    expect(typeof entry.name).toBe('string');
    expect(typeof entry.ok).toBe('boolean');
    expect(typeof entry.detail).toBe('string');
    expect(entry.detail.length).toBeGreaterThan(0);
    expect(typeof entry.ms).toBe('number');
    expect(entry.ms).toBeGreaterThanOrEqual(0);
  }

  // 干跑 2 次 + 真实写入 2 次；干跑的 path 带 dryRun=All，体不带 dryRun 的只有创建
  expect(world.calls.post.filter((call) => call.options.dryRun)).toHaveLength(2);
  expect(world.calls.post.filter((call) => call.options.dryRun).every((call) => call.path.includes('dryRun=All'))).toBe(true);
  expect(world.calls.post.filter((call) => !call.options.dryRun)).toHaveLength(2);
  expect(world.calls.patch).toHaveLength(0);

  // 快照记录的是"原本不存在"，回滚方式为删除
  expect(result.snapshot.objects).toHaveLength(2);
  expect(result.snapshot.objects.every((entry) => entry.existed === false)).toBe(true);
  expect(result.snapshot.objects.map((entry) => `${entry.ref.kind}/${entry.ref.name}`)).toEqual([
    'Deployment/qwen',
    'Service/qwen',
  ]);

  expect(step(result, STEP_NAMES.ALLOCATION).detail).toContain('vGPU 配额已生效');
  expect(step(result, STEP_NAMES.ALLOCATION).detail).toContain('qwen-7d9c');
  expect(step(result, STEP_NAMES.ENDPOINT).detail).toContain('HTTP 200');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][0]).toBe('http://qwen.inference.svc:8000/health');

  // 集群里已经有了这两个对象
  expect(world.store.has(DEP_PATH)).toBe(true);
  expect(world.store.has(SVC_PATH)).toBe(true);
});

test('happy path（更新）：既有对象走 merge-patch，快照保存旧镜像', async () => {
  const oldDeployment = deploymentWithImage('vllm/vllm-openai:v0.5.0');
  const world = createWorld({
    existing: [oldDeployment, renderedService()],
    pods: [hamiPod('qwen-new', 'GPU-aaaa-1111,NVIDIA,8192,30:;')],
  });

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage('vllm/vllm-openai:v0.6.3'), renderedService()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.ok).toBe(true);
  expect(result.action).toBe('patch');
  expect(result.rollbackAvailable).toBe(true);

  const patched = world.calls.patch.filter((call) => !call.options.dryRun);
  expect(patched).toHaveLength(1);
  expect(patched[0].path).toContain('/deployments/qwen');
  expect(patched[0].options.contentType).toBe('application/merge-patch+json');
  expect(patched[0].body.spec.template.spec.containers[0].image).toBe('vllm/vllm-openai:v0.6.3');

  const deploymentSnapshot = result.snapshot.objects.find((entry) => entry.ref.kind === 'Deployment');
  expect(deploymentSnapshot.existed).toBe(true);
  expect(deploymentSnapshot.body.spec.template.spec.containers[0].image).toBe('vllm/vllm-openai:v0.5.0');

  const serviceSnapshot = result.snapshot.objects.find((entry) => entry.ref.kind === 'Service');
  expect(serviceSnapshot.existed).toBe(true);
});

// ───────────────────────────── ② 护栏 / 白名单 / 开关 ─────────────────────────────

test('guard 拒绝：返回 allowed:false 且一个 API 调用都不发', async () => {
  const world = createWorld();
  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage()],
    client: world.client,
    guard: { allowed: false, violations: ['资源上限超限：显存 8192MiB > 单服务上限 4096MiB'] },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.ok).toBe(false);
  expect(result.allowed).toBe(false);
  expect(result.action).toBe('rejected');
  expect(result.error).toContain('护栏未通过');
  expect(result.error).toContain('显存 8192MiB');
  expect(result.rollbackAvailable).toBe(false);
  expect(names(result)).toEqual([STEP_NAMES.GUARD]);
  expect(world.apiCalls()).toBe(0);
});

test('guard 缺失（上游没给结论）按拒绝处理，同样零 API 调用', async () => {
  const world = createWorld();
  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage()],
    client: world.client,
    guard: undefined,
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.allowed).toBe(false);
  expect(result.error).toContain('护栏未通过');
  expect(world.apiCalls()).toBe(0);
});

test('命名空间越界：对象落在 kube-system 时二次防御拦下（不依赖 A2）', async () => {
  const world = createWorld();
  const rogue = deploymentWithImage();
  rogue.metadata.namespace = 'kube-system';

  const result = await applyService({
    service: modelService({ namespace: NS }),
    objects: [rogue],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.allowed).toBe(false);
  expect(result.error).toContain('不在白名单内');
  expect(result.error).toContain(ALLOWED_NAMESPACES.join(' / '));
  expect(world.apiCalls()).toBe(0);
});

test('service.namespace 本身不在白名单时拒绝（default 也不行）', async () => {
  const world = createWorld();
  const result = await applyService({
    service: modelService({ namespace: 'default' }),
    objects: [deploymentWithImage()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.allowed).toBe(false);
  expect(result.error).toContain('default');
  expect(result.error).toContain('白名单');
  expect(world.apiCalls()).toBe(0);
});

test('开关未开（OPENLOG_K8S_INFRA != 1）：拒绝且零 API 调用', async () => {
  const world = createWorld();
  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: {} },
  });

  expect(result.ok).toBe(false);
  expect(result.allowed).toBe(false);
  expect(result.error).toContain('OPENLOG_K8S_INFRA=1');
  expect(world.apiCalls()).toBe(0);
});

test('objects 为空：拒绝申请，不发任何请求', async () => {
  const world = createWorld();
  const result = await applyService({
    service: modelService(),
    objects: [],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.error).toContain('objects 为空');
  expect(world.apiCalls()).toBe(0);
});

// ───────────────────────────── ③ 干跑失败 ─────────────────────────────

test('服务端干跑失败：原样回传 k8s 报错，集群一个字节都不改', async () => {
  const world = createWorld({
    faults: {
      dryRun: () => httpError(422, '/apis/apps/v1', 'admission webhook "vgpu.hami.io" denied the request: 显存配额 8192MiB 超过节点剩余 4096MiB'),
    },
  });

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage(), renderedService()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.ok).toBe(false);
  expect(result.action).toBe('rejected');
  expect(result.error).toContain('服务端干跑失败');
  expect(result.error).toContain('admission webhook "vgpu.hami.io" denied the request');
  expect(result.error).toContain('超过节点剩余 4096MiB');
  expect(result.error).not.toContain('已自动回滚');
  expect(names(result)).toEqual([STEP_NAMES.GUARD, STEP_NAMES.DRY_RUN]);
  expect(step(result, STEP_NAMES.DRY_RUN).ok).toBe(false);
  expect(world.realWrites()).toBe(0);
  expect(world.store.size).toBe(0);
  expect(result.rollbackAvailable).toBe(false);
});

// ───────────────────────────── ④ 滚动超时 ─────────────────────────────

test('滚动超时：用注入的假 sleep/时钟判定，触发回滚并恢复旧对象', async () => {
  const oldDeployment = deploymentWithImage('vllm/vllm-openai:v0.5.0');
  const world = createWorld({
    existing: [oldDeployment, renderedService()],
    pods: [hamiPod('qwen-new', 'GPU-aaaa-1111,NVIDIA,8192,30:;')],
    status: readyStatus({ availableReplicas: 0, readyReplicas: 0 }),
  });
  let sleeps = 0;
  world.sleepHook = () => {
    sleeps += 1;
  };

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage('vllm/vllm-openai:v0.6.3'), renderedService()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: {
      sleep: world.clock.sleep,
      env: ENABLED,
      rolloutTimeoutMs: 10_000,
      pollIntervalMs: 1_000,
    },
  });

  expect(result.ok).toBe(false);
  expect(result.action).toBe('patch');
  expect(result.error).toContain('滚动超时');
  expect(result.error).toContain('可用副本 0/1');
  expect(result.error).toContain('已自动回滚');
  expect(step(result, STEP_NAMES.ROLLOUT).ok).toBe(false);
  expect(step(result, STEP_NAMES.ROLLBACK).ok).toBe(true);
  expect(names(result)).toContain(STEP_NAMES.ROLLBACK);

  // 全程假时间：10 次 sleep、推进 10000ms，没有任何真实等待
  expect(sleeps).toBe(10);
  expect(world.clock.t).toBe(10_000);

  // 回滚把旧镜像 PATCH 回去了
  expect(world.store.get(DEP_PATH).spec.template.spec.containers[0].image).toBe('vllm/vllm-openai:v0.5.0');
  expect(result.rollbackAvailable).toBe(false);
  expect(result.rollback.ok).toBe(true);
});

// ───────────────────────────── ⑤ 配额没生效 ─────────────────────────────

test('配额不匹配（改完但没生效）：触发回滚', async () => {
  const world = createWorld({
    existing: [deploymentWithImage('vllm/vllm-openai:v0.5.0'), renderedService()],
    // 注解里只有 4096MiB，申请的是 8192MiB —— 典型的"改了但配额没拿到"
    pods: [hamiPod('qwen-abc', 'GPU-aaaa-1111,NVIDIA,4096,30:;')],
  });

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage('vllm/vllm-openai:v0.6.3'), renderedService()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.ok).toBe(false);
  expect(step(result, STEP_NAMES.ALLOCATION).ok).toBe(false);
  expect(result.error).toContain('配额');
  expect(result.error).toContain('4096');
  expect(result.error).toContain('已自动回滚');
  expect(world.store.get(DEP_PATH).spec.template.spec.containers[0].image).toBe('vllm/vllm-openai:v0.5.0');
});

test('Pod 上没有 vGPU 注解（配额完全没分配）：回滚', async () => {
  const world = createWorld({
    existing: [deploymentWithImage('vllm/vllm-openai:v0.5.0'), renderedService()],
    pods: [hamiPod('qwen-abc', null)],
  });

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage('vllm/vllm-openai:v0.6.3'), renderedService()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.ok).toBe(false);
  expect(result.error).toContain('vgpu-devices-allocated');
});

test('没有运行中的 Pod 时配额校验失败并给出排查方向', async () => {
  const world = createWorld({ existing: [deploymentWithImage()], pods: [] });

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  // 对象无差异 → noop，但 Pod 不存在说明现状其实没跑起来，必须报错
  expect(result.ok).toBe(false);
  expect(result.error).toContain('没有找到运行中的 Pod');
  expect(result.error).toContain('kubectl get pods');
});

// ───────────────────────────── ⑥ 无旧快照 → 删除新建对象 ─────────────────────────────

test('无旧快照时失败：回滚删除本次新建的对象（按快照顺序）', async () => {
  const world = createWorld({ pods: [hamiPod('qwen-x', 'GPU-aaaa-1111,NVIDIA,4096,30:;')] });

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage(), renderedService()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.ok).toBe(false);
  expect(result.snapshot.objects.every((entry) => entry.existed === false)).toBe(true);
  expect(step(result, STEP_NAMES.ROLLBACK).ok).toBe(true);
  expect(world.calls.delete.map((call) => call.path)).toEqual([DEP_PATH, SVC_PATH]);
  expect(world.store.size).toBe(0);
  expect(result.rollbackAvailable).toBe(false);
  expect(world.store.has(DEP_PATH)).toBe(false);
});

// ───────────────────────────── ⑦ 端点验证 ─────────────────────────────

test('端点返回 500：重试到上限后回滚', async () => {
  const world = createWorld({
    existing: [deploymentWithImage('vllm/vllm-openai:v0.5.0')],
    pods: [hamiPod('qwen-new', 'GPU-aaaa-1111,NVIDIA,8192,30:;')],
  });
  const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }));

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage('vllm/vllm-openai:v0.6.3')],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: {
      sleep: world.clock.sleep,
      env: ENABLED,
      probeUrl: 'http://qwen.inference.svc:8000/health',
      fetchImpl,
      probeAttempts: 2,
      probeIntervalMs: 500,
    },
  });

  expect(result.ok).toBe(false);
  expect(step(result, STEP_NAMES.ENDPOINT).ok).toBe(false);
  expect(result.error).toContain('端点探针失败');
  expect(result.error).toContain('HTTP 500');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(world.clock.t).toBe(500);
  expect(result.rollback.ok).toBe(true);
  expect(world.store.get(DEP_PATH).spec.template.spec.containers[0].image).toBe('vllm/vllm-openai:v0.5.0');
});

test('未配置 probeUrl：跳过端点验证，不影响整体成功', async () => {
  const world = createWorld({ pods: [hamiPod('qwen-a', 'GPU-aaaa-1111,NVIDIA,8192,30:;')] });

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.ok).toBe(true);
  expect(step(result, STEP_NAMES.ENDPOINT).detail).toContain('跳过端点验证');
});

// ───────────────────────────── ⑧ 幂等 ─────────────────────────────

test('幂等：同一 service 连续 apply 两次，第二次是 noop 且不发写请求', async () => {
  const serverSide = {
    ...deploymentWithImage(),
    metadata: {
      ...deploymentWithImage().metadata,
      resourceVersion: '88421',
      uid: '5f6e0d3a-0000-4000-8000-000000000001',
      creationTimestamp: '2026-01-01T00:00:00Z',
      generation: 1,
      managedFields: [{ manager: 'kube-controller-manager' }],
      annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"kind":"Deployment"}' },
    },
    status: readyStatus(),
  };
  const world = createWorld({
    existing: [serverSide, { ...renderedService(), metadata: { ...renderedService().metadata, resourceVersion: '1', uid: 'u-2' } }],
    pods: [hamiPod('qwen-a', 'GPU-aaaa-1111,NVIDIA,8192,30:;')],
  });

  const first = await applyService({
    service: modelService(),
    objects: [deploymentWithImage(), renderedService()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(first.ok).toBe(true);
  expect(first.action).toBe('noop');
  expect(first.rollbackAvailable).toBe(false);
  expect(first.snapshot.objects.every((entry) => entry.existed)).toBe(true);
  expect(step(first, STEP_NAMES.DRY_RUN).detail).toContain('跳过服务端干跑');
  expect(step(first, STEP_NAMES.APPLY).detail).toContain('跳过写入');
  expect(world.calls.post).toHaveLength(0);
  expect(world.calls.patch).toHaveLength(0);
  expect(world.calls.delete).toHaveLength(0);

  const before = world.calls.get.length;
  const second = await applyService({
    service: modelService(),
    objects: [deploymentWithImage(), renderedService()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(second.ok).toBe(true);
  expect(second.action).toBe('noop');
  expect(world.calls.post).toHaveLength(0);
  expect(world.calls.patch).toHaveLength(0);
  expect(world.calls.get.length - before).toBeGreaterThan(0); // 仍然只读校验收敛
});

// ───────────────────────────── ⑨ 回滚失败 ─────────────────────────────

test('回滚本身失败：ok:false、给出明确错误与需人工核对的对象', async () => {
  const world = createWorld({
    existing: [deploymentWithImage('vllm/vllm-openai:v0.5.0')],
    pods: [hamiPod('qwen-new', 'GPU-aaaa-1111,NVIDIA,4096,30:;')],
    faults: {
      // 第 1 次真实 PATCH 是 apply，第 2 次是回滚 → 让回滚失败
      patch: (_body, _path, writes) => (writes >= 2 ? httpError(503, '/apis/apps/v1/namespaces/inference/deployments/qwen') : null),
    },
  });

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage('vllm/vllm-openai:v0.6.3')],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.ok).toBe(false);
  expect(result.error).toContain('回滚失败');
  expect(result.error).toContain('Deployment/qwen');
  expect(step(result, STEP_NAMES.ROLLBACK).ok).toBe(false);
  expect(result.rollback.ok).toBe(false);
  expect(result.rollbackAvailable).toBe(true); // 还有救，要人工介入
  expect(result.rollback.steps[0].name).toBe('restore:Deployment/qwen');
  expect(result.rollback.steps[0].ok).toBe(false);
});

test('注入的 client 缺写方法：报可操作的错误而不是 TypeError', async () => {
  const readOnlyClient = {
    async getJson() {
      throw httpError(404, DEP_PATH);
    },
  };

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage()],
    client: readOnlyClient,
    guard: { allowed: true },
    now: () => 0,
    opts: { sleep: async () => {}, env: ENABLED },
  });

  expect(result.ok).toBe(false);
  expect(result.error).toContain('postJson');
  expect(result.error).toContain('OPENLOG_K8S_WRITE');
  expect(result.action).toBe('rejected');
});

// ───────────────────────────── ⑩ rollbackService 独立用例 ─────────────────────────────

test('rollbackService：快照为空时明确说明无需回滚（不猜、不乱删）', async () => {
  const world = createWorld();
  const result = await rollbackService({ snapshot: { objects: [] }, client: world.client, now: world.clock.now });

  expect(result.ok).toBe(true);
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0].detail).toContain('快照为空');
  expect(world.apiCalls()).toBe(0);
});

test('rollbackService：接受 A7 历史回滚传来的原始对象数组', async () => {
  const oldDeployment = deploymentWithImage('vllm/vllm-openai:v0.4.0');
  const world = createWorld({ existing: [deploymentWithImage('vllm/vllm-openai:v0.6.3')] });

  const result = await rollbackService({ snapshot: [oldDeployment], client: world.client, now: world.clock.now });

  expect(result.ok).toBe(true);
  expect(result.steps[0].name).toBe('restore:Deployment/qwen');
  expect(world.store.get(DEP_PATH).spec.template.spec.containers[0].image).toBe('vllm/vllm-openai:v0.4.0');
});

test('rollbackService：删除时对象已不存在（404）按已达成处理', async () => {
  const world = createWorld();
  const result = await rollbackService({
    snapshot: {
      objects: [{
        ref: { apiVersion: 'apps/v1', kind: 'Deployment', namespace: NS, name: 'qwen' },
        existed: false,
        body: null,
      }],
    },
    client: world.client,
    now: world.clock.now,
  });

  expect(result.ok).toBe(true);
  expect(result.steps[0].detail).toContain('无需删除');
});

// ───────────────────────────── ⑫ 其余注入点 ─────────────────────────────

test('真实写入（apply）阶段失败：同样回滚到快照', async () => {
  const world = createWorld({
    existing: [deploymentWithImage('vllm/vllm-openai:v0.5.0')],
    pods: [hamiPod('qwen-new', 'GPU-aaaa-1111,NVIDIA,8192,30:;')],
    faults: {
      // 干跑通过，真实 PATCH 才炸（典型：admission webhook 只在非干跑时生效）
      patch: (_body, _path, writes) => (writes === 1 ? httpError(409, DEP_PATH, 'Operation cannot be fulfilled on deployments.apps "qwen": the object has been modified') : null),
    },
  });

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage('vllm/vllm-openai:v0.6.3')],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED },
  });

  expect(result.ok).toBe(false);
  expect(result.action).toBe('patch');
  expect(step(result, STEP_NAMES.APPLY).ok).toBe(false);
  expect(result.error).toContain('应用失败（Deployment/qwen）');
  expect(result.error).toContain('the object has been modified');
  expect(result.error).toContain('已自动回滚');
  expect(result.rollback.ok).toBe(true);
  // 镜像没被改成新版本（应用失败 → 回滚把旧快照又写回来）
  expect(world.store.get(DEP_PATH).spec.template.spec.containers[0].image).toBe('vllm/vllm-openai:v0.5.0');
});

test('onStep 逐步回调：前端能实时点亮，且回调抛错不影响执行', async () => {
  const world = createWorld({ pods: [hamiPod('qwen-a', 'GPU-aaaa-1111,NVIDIA,8192,30:;')] });
  const seen = [];
  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: {
      sleep: world.clock.sleep,
      env: ENABLED,
      onStep: (entry) => {
        seen.push(`${entry.name}:${entry.ok}`);
        if (entry.name === STEP_NAMES.APPLY) throw new Error('SSE 推送失败');
      },
    },
  });

  expect(result.ok).toBe(true);
  expect(seen).toEqual([
    'guard:true',
    'dry-run:true',
    'snapshot:true',
    'apply:true',
    'rollout:true',
    'allocation:true',
    'endpoint:true',
  ]);
});

test('verifyAllocation 可注入：自定义校验被调用，结论直接决定成败', async () => {
  const world = createWorld({ pods: [hamiPod('qwen-a', 'whatever:;')] });
  const verifyAllocation = vi.fn(async () => ({
    ok: false,
    reason: '自定义校验：实测算力 12% 低于申请 30%',
    summary: 'GPU-a,NVIDIA,8192,12:;',
  }));

  const result = await applyService({
    service: modelService(),
    objects: [deploymentWithImage()],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED, verifyAllocation },
  });

  expect(verifyAllocation).toHaveBeenCalledTimes(1);
  const [pod, expected] = verifyAllocation.mock.calls[0];
  expect(pod.metadata.name).toBe('qwen-a');
  expect(expected).toMatchObject({ memoryMiB: 8192, coresPercent: 30, accelerators: 1, mode: 'at-least' });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('实测算力 12%');
  expect(step(result, STEP_NAMES.ALLOCATION).ok).toBe(false);
});

test('allocationMode=exact 会透传到校验（拿到更多也算不符合声明）', async () => {
  const world = createWorld({
    existing: [deploymentWithImage('vllm/vllm-openai:v0.5.0')],
    pods: [hamiPod('qwen-a', 'GPU-a,NVIDIA,16384,60:;')],
  });

  const result = await applyService({
    service: modelService({ resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 30 } }),
    objects: [deploymentWithImage('vllm/vllm-openai:v0.6.3')],
    client: world.client,
    guard: { allowed: true },
    now: world.clock.now,
    opts: { sleep: world.clock.sleep, env: ENABLED, allocationMode: 'exact' },
  });

  expect(result.ok).toBe(false);
  expect(result.error).toContain('不等于');
  expect(result.rollback.ok).toBe(true);
  expect(world.store.get(DEP_PATH).spec.template.spec.containers[0].image).toBe('vllm/vllm-openai:v0.5.0');
});

// ───────────────────────────── ⑪ 纯函数反例 ─────────────────────────────

test('defaultVerifyAllocation：注解缺失 / 显存不足 / exact 口径都判失败', () => {
  const missing = defaultVerifyAllocation({ metadata: {} }, { memoryMiB: 8192, coresPercent: 30, accelerators: 1 });
  expect(missing.ok).toBe(false);
  expect(missing.reason).toContain('vgpu-devices-allocated');

  const short = defaultVerifyAllocation(
    { metadata: { annotations: { 'hami.io/vgpu-devices-allocated': 'GPU-a,NVIDIA,2048,30:;' } } },
    { memoryMiB: 8192, coresPercent: 30, accelerators: 1 },
  );
  expect(short.ok).toBe(false);
  expect(short.reason).toContain('2048MiB');

  const exactMismatch = defaultVerifyAllocation(
    { metadata: { annotations: { 'hami.io/vgpu-devices-allocated': 'GPU-a,NVIDIA,8192,30:;' } } },
    { memoryMiB: 4096, coresPercent: 30, accelerators: 1, mode: 'exact' },
  );
  expect(exactMismatch.ok).toBe(false);

  const wholeCard = defaultVerifyAllocation({ metadata: {} }, { memoryMiB: 0, coresPercent: 0, accelerators: 0 });
  expect(wholeCard.ok).toBe(true);

  const twoCards = defaultVerifyAllocation(
    { metadata: { annotations: { 'hami.io/vgpu-devices-allocated': 'GPU-a,NVIDIA,4096,15:GPU-b,NVIDIA,4096,15:;' } } },
    { memoryMiB: 4096, coresPercent: 15, accelerators: 2 },
  );
  expect(twoCards.ok).toBe(true);
  expect(twoCards.actual).toMatchObject({ memoryMiB: 8192, coresPercent: 30, cards: 2 });

  const tooFewCards = defaultVerifyAllocation(
    { metadata: { annotations: { 'hami.io/vgpu-devices-allocated': 'GPU-a,NVIDIA,4096,15:;' } } },
    { memoryMiB: 4096, coresPercent: 15, accelerators: 2 },
  );
  expect(tooFewCards.ok).toBe(false);
  expect(tooFewCards.reason).toContain('期望 2 张');
});

test('evaluateRollout：generation 落后 / 副本不足 / 旧副本未退 / Progressing=False 都不算就绪', () => {
  const base = {
    metadata: { generation: 2 },
    spec: { replicas: 2 },
    status: readyStatus({ observedGeneration: 2, replicas: 2, updatedReplicas: 2, availableReplicas: 2 }),
  };
  expect(evaluateRollout({ ...base, status: { ...base.status, observedGeneration: 1 } }).ready).toBe(false);
  expect(evaluateRollout({ ...base, status: { ...base.status, observedGeneration: 1 } }).reason).toContain('generation');

  expect(evaluateRollout({ ...base, status: { ...base.status, availableReplicas: 1 } }).ready).toBe(false);
  expect(evaluateRollout({ ...base, status: { ...base.status, replicas: 3 } }).ready).toBe(false);
  expect(evaluateRollout({
    ...base,
    status: {
      ...base.status,
      conditions: [{ type: 'Progressing', status: 'False', message: 'ProgressDeadlineExceeded' }],
    },
  }).ready).toBe(false);

  expect(evaluateRollout(base).ready).toBe(true);
  expect(evaluateRollout(null).ready).toBe(false);
});

test('diffObjects：忽略服务端字段，只看真正声明的差异', () => {
  const current = {
    ...deploymentWithImage(),
    metadata: {
      ...deploymentWithImage().metadata,
      resourceVersion: '1',
      uid: 'u-1',
      generation: 7,
      creationTimestamp: '2026-01-01T00:00:00Z',
      annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
    },
    status: { availableReplicas: 1 },
  };

  expect(diffObjects(current, deploymentWithImage())).toEqual({ same: true, mismatches: [] });
  expect(diffObjects(null, deploymentWithImage()).same).toBe(false);

  const changed = deploymentWithImage('other:latest');
  const diff = diffObjects(current, changed);
  expect(diff.same).toBe(false);
  expect(diff.mismatches[0].path).toContain('containers[0].image');
  expect(diffObjects(current, null).same).toBe(false);
});
