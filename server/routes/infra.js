/**
 * AI Infra 能力层路由（`/api/infra/*`）。
 *
 * 设计立场：这是**控制面**，不是数据面 —— 跑着的推理服务在 OpenLog 停掉之后必须继续跑，
 * 所以这里只做「定义 → 预检 → 干跑 → 执行 → 校验 → 回滚」，不参与任何请求转发。
 *
 * 开关：`OPENLOG_K8S_INFRA=1` 才允许写。**读接口不受开关影响**（不允许改也能看，
 * 否则运维在紧急情况下连现状都查不到）。与既有的 `OPENLOG_K8S_WRITE`（扩缩容/重启/删 Pod）
 * 正交：那个管运行时动作，这个管服务定义。
 *
 * 所有写操作必须串行经过：
 *   校验(A1) → 护栏(A2) → 容量预检(A4) → 渲染(A1) → 干跑+执行+校验+回滚(A5)
 * 任何一步不过就停，并把**可操作的中文原因**返回给前端。
 *
 * 依赖注入（便于测试与避免启动期循环依赖）：
 *   createInfraRouter({ ensureSettings, saveSettings, resolveCluster })
 */

import express from 'express';
import { errorMessage } from '../errors.js';
import * as k8sStore from '../k8s/store.js';
import * as k8sKubeconfig from '../k8s/kubeconfig.js';
import * as k8sClientModule from '../k8s/client.js';
import * as k8sResources from '../k8s/resources.js';
import * as k8sHami from '../k8s/hami.js';
import { isDemoMode } from '../demo/mode.js';

const PREFIX = '/api/infra';

/** 服务定义存放位置：跟着 settings 走，导出/备份/迁移与其它配置一致。 */
const SERVICES_KEY = 'infraServices';

/* ────────────────────────── 惰性加载能力层模块 ────────────────────────── */

const modules = { model: null, render: null, guard: null, capacity: null, apply: null, bench: null, accelerator: null };

/**
 * 惰性 + 容错加载：某个模块缺失时只有依赖它的端点降级（返回 503 + 说明），
 * 而不是让整个服务起不来。这与项目里 k8s 可选路由的处理方式保持一致。
 */
async function loadModule(name) {
  if (modules[name]) return modules[name];
  const specifiers = {
    model: '../infra/model.js',
    render: '../infra/render.js',
    guard: '../infra/guard.js',
    capacity: '../infra/capacity.js',
    apply: '../infra/apply.js',
    bench: '../infra/bench.js',
    accelerator: '../infra/accelerator/index.js',
  };
  try {
    modules[name] = await import(specifiers[name]);
    return modules[name];
  } catch (err) {
    console.warn(`[Infra] 模块 ${name} 未加载：${errorMessage(err)}`);
    return null;
  }
}

/** 写开关：只认字符串 '1'。undefined / '0' / 'true' 一律算关闭（与护栏层口径一致）。 */
export function isInfraEnabled(env = process.env) {
  return String(env?.OPENLOG_K8S_INFRA ?? '') === '1';
}

/* ────────────────────────── 存储 ────────────────────────── */

/** 读服务定义列表（settings 里的一段数组；脏数据一律丢弃而不是抛错）。 */
export function listServices(settings) {
  const raw = settings?.[SERVICES_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === 'object' && typeof item.name === 'string');
}

/** 按 id 或 `namespace/name` 找定义（前端新建草稿用后者当占位 id）。 */
export function findService(settings, idOrKey) {
  const key = String(idOrKey ?? '').trim();
  if (!key) return null;
  const services = listServices(settings);
  return services.find((s) => s.id === key) || services.find((s) => `${s.namespace}/${s.name}` === key) || null;
}

/** upsert（按 id 或 ns/name 命中即替换，保留 version 自增与时间戳）。 */
export function upsertService(settings, service, now = new Date()) {
  const services = listServices(settings).slice();
  const key = `${service.namespace}/${service.name}`;
  const index = services.findIndex((s) => s.id === service.id || `${s.namespace}/${s.name}` === key);
  const stamp = now.toISOString();
  if (index >= 0) {
    const prev = services[index];
    services[index] = {
      ...service,
      id: prev.id || service.id,
      createdAt: prev.createdAt || service.createdAt || stamp,
      updatedAt: stamp,
      version: Number(prev.version || 0) + 1,
      history: prev.history || [],
    };
  } else {
    services.push({
      ...service,
      createdAt: service.createdAt || stamp,
      updatedAt: stamp,
      version: Number(service.version || 0) || 1,
      history: service.history || [],
    });
  }
  return { ...settings, [SERVICES_KEY]: services };
}

/** 追加一条变更历史（最多保留 50 条，避免 settings 无限膨胀）。 */
export function appendHistory(service, entry, now = new Date()) {
  const history = Array.isArray(service?.history) ? service.history.slice() : [];
  history.unshift({ at: now.toISOString(), ...entry });
  return history.slice(0, 50);
}

/* ────────────────────────── 集群连接 ────────────────────────── */

/** 把 settings 里的集群变成可用的 client（与其它 k8s 路由同一套解析路径）。 */
export function connectCluster(record) {
  const resolved = k8sKubeconfig.resolveKubeconfig(record);
  return { client: k8sClientModule.createK8sClient(resolved), resolved };
}

/** 读节点与 Pod 现状（容量预检 / 归属判定都要用）。 */
async function readClusterState(client) {
  const [nodesRaw, podsRaw] = await Promise.all([
    client.getJson('/api/v1/nodes'),
    client.getJson('/api/v1/pods'),
  ]);
  const nodes = k8sResources.normalizeNodes(nodesRaw?.items || []);
  const pods = k8sResources.normalizePods(podsRaw?.items || []);
  const summary = k8sHami.summarizeVgpu({
    nodes: withHami(nodeCandidates(nodes), nodesRaw?.items || []),
    pods: withHami(pods, podsRaw?.items || []),
  });
  return { nodes, pods, summary, rawNodes: nodesRaw?.items || [], rawPods: podsRaw?.items || [] };
}

function nodeCandidates(nodes) {
  return nodes.map((n) => ({
    name: n.name,
    labels: n.labels || {},
    addresses: n.addresses || [],
    internalIP: n.internalIP || '',
    allocatable: n.allocatable || {},
  }));
}

/** 把原始 annotations 挂回归一化对象（HAMi 解析依赖注解）。 */
function withHami(list, rawItems) {
  const byKey = new Map();
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    const ns = item?.metadata?.namespace || '';
    const name = item?.metadata?.name || '';
    byKey.set(`${ns}/${name}`, item?.metadata?.annotations || {});
    byKey.set(`/${name}`, item?.metadata?.annotations || {});
  }
  return (Array.isArray(list) ? list : []).map((entry) => {
    const annotations = byKey.get(`${entry.namespace || ''}/${entry.name || ''}`) || {};
    return { ...entry, annotations, status: { ...(entry.status || {}), annotations } };
  });
}

/** 节点 → 适配器能读的形状（附带 HAMi 注解）。 */
function nodesForCapacity(nodes, rawNodes) {
  return nodes.map((n) => {
    const raw = (Array.isArray(rawNodes) ? rawNodes : []).find((x) => x?.metadata?.name === n.name);
    return {
      name: n.name,
      labels: n.labels || {},
      internalIP: n.internalIP || '',
      metadata: { name: n.name, annotations: raw?.metadata?.annotations || {} },
      status: { allocatable: raw?.status?.allocatable || {}, capacity: raw?.status?.capacity || {} },
    };
  });
}

/* ────────────────────────── 路由 ────────────────────────── */

/**
 * @param {{ ensureSettings: () => object, saveSettings?: (settings:object)=>void }} deps
 */
export function createInfraRouter({ ensureSettings, saveSettings } = {}) {
  if (typeof ensureSettings !== 'function') {
    throw new TypeError('createInfraRouter 需要注入 ensureSettings');
  }
  const router = express.Router();
  const enabled = () => isInfraEnabled(process.env);

  /** :clusterId → 集群记录（不存在 404，读不到 kubeconfig 400）。 */
  async function resolveCluster(req, res) {
    // clusterId 优先级：路径参数 → query → body → settings 里第一个启用的集群。
    // 单集群部署（最常见）下前端不必传，多集群时显式带 ?clusterId=。
    let clusterId = String(req.params.clusterId || req.query?.clusterId || req.body?.clusterId || '').trim();
    if (!clusterId) {
      try {
        const settings = ensureSettings();
        const clusters = k8sStore.listClusters(settings) || [];
        const first = clusters.find((c) => c.enabled !== false) || clusters[0];
        clusterId = first?.id || '';
      } catch { /* 落到下面统一报错 */ }
    }
    if (!clusterId) {
      res.status(400).json({ error: '没有可用的 Kubernetes 集群：请先在「K8s 集群」里接入一个集群，或显式传 clusterId' });
      return null;
    }
    let record;
    try {
      record = k8sStore.getClusterRecord(ensureSettings(), clusterId);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
      return null;
    }
    if (!record) {
      res.status(404).json({ error: `Kubernetes 集群不存在: ${clusterId}` });
      return null;
    }
    return record;
  }

  /* ── 列表（读，不受开关限制） ── */
  router.get(`${PREFIX}/services`, async (req, res) => {
    if (isDemoMode()) {
      const { demoInfraServices } = await import('../demo/fixtures.js').catch(() => ({ demoInfraServices: null }));
      res.json({
        demo: true,
        enabled: false,
        reason: '演示模式：AI Infra 写能力不会下发到任何集群',
        services: typeof demoInfraServices === 'function' ? demoInfraServices() : [],
      });
      return;
    }
    const record = await resolveCluster(req, res);
    if (!record) return;
    res.json({
      enabled: enabled(),
      reason: enabled() ? null : '写能力未启用（设置 OPENLOG_K8S_INFRA=1 后生效）；当前只读',
      services: listServices(ensureSettings()),
    });
  });

  /* ── 预览（干跑 + 护栏 + 容量，不写集群） ── */
  router.post(`${PREFIX}/services/:id/preview`, async (req, res) => {
    // 校验是纯函数、不依赖集群 —— 先校验再找集群，用户填错字段时能立刻看到字段级提示，
    // 而不是被"没有可用集群"这种无关错误挡住。
    const [model, render, guard, capacity] = await Promise.all([
      loadModule('model'), loadModule('render'), loadModule('guard'), loadModule('capacity'),
    ]);
    if (!model || !render || !guard) {
      res.status(503).json({ error: 'AI Infra 能力层未就绪（缺少 model/render/guard 模块）' });
      return;
    }

    const input = req.body?.service;
    const validation = model.validateModelService(input);
    if (!validation.ok) {
      res.json({
        allowed: false,
        violations: validation.errors.map((e) => ({ code: 'INVALID_SERVICE', field: e.field, message: e.message })),
        diff: '',
        impact: { action: 'noop', restarts: false, downtimeSeconds: 0, reasons: ['定义校验未通过，未生成任何清单'] },
      });
      return;
    }

    const record = await resolveCluster(req, res);
    if (!record) return;

    const { client } = connectCluster(record);
    let existing = null;
    let state = null;
    try {
      state = await readClusterState(client);
      const key = model.serviceKey(validation.value);
      const [ns, name] = key.split('/');
      const depPath = `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}`;
      existing = await client.getJson(depPath).catch(() => null);
    } catch (err) {
      res.status(502).json({ error: `读取集群现状失败：${errorMessage(err)}` });
      return;
    }

    const rendered = render.renderModelService(validation.value, { gatewayIP: record.server || '' });
    const guardResult = guard.checkGuard({
      service: validation.value,
      existing: existing ? [existing, ...(state ? [] : [])] : null,
      settings: ensureSettings(),
      env: process.env,
    });
    const rawImpact = guard.summarizeImpact(
      existing ? [existing] : null,
      rendered.objects,
    );

    // 容量预检：放不下就别让用户白等一次 rollout
    let placement = null;
    if (capacity && state) {
      const accelerator = await loadModule('accelerator');
      const adapter = accelerator?.getAdapter
        ? accelerator.getAdapter(validation.value.resources?.vendor || 'nvidia')
        : null;
      try {
        placement = capacity.planPlacement({
          service: validation.value,
          nodes: nodesForCapacity(state.nodes, state.rawNodes),
          allocations: allocationsFromSummary(state.summary),
          adapter,
        });
      } catch (err) {
        placement = { fits: true, reasons: [`容量预检跳过：${errorMessage(err)}`], warnings: [] };
      }
    }

    // 前端读的是 downtimeSeconds，护栏返回的是 downtimeEstimateSec —— 接线层负责映射，
    // 否则用户点提交前看到的是前端自带的乐观估算（30s/副本）而不是护栏算出的 60s/单副本。
    const impact = {
      action: rawImpact?.action || 'noop',
      restarts: rawImpact?.restarts === true,
      downtimeSeconds: Number(rawImpact?.downtimeEstimateSec ?? rawImpact?.downtimeSeconds ?? 0) || 0,
      reasons: Array.isArray(rawImpact?.reasons) ? rawImpact.reasons : [],
    };

    res.json({
      allowed: guardResult.allowed && (placement ? placement.fits : true),
      violations: [
        ...(guardResult.violations || []),
        ...(placement && placement.fits === false
          ? placement.reasons.map((message) => ({ code: 'CAPACITY_INSUFFICIENT', message }))
          : []),
      ],
      diff: guardResult.diff || '',
      impact,
      objects: rendered.objects,
      routes: rendered.routes,
      placement,
    });
  });

  /* ── 执行（真写；默认关闭） ── */
  router.post(`${PREFIX}/services/:id/apply`, async (req, res) => {
    if (isDemoMode()) {
      res.status(409).json({ error: '演示模式不会把变更下发到集群', demo: true });
      return;
    }
    if (!enabled()) {
      res.status(403).json({
        error: 'AI Infra 写能力未启用（设置 OPENLOG_K8S_INFRA=1 后生效）',
        readOnly: true,
      });
      return;
    }
    const record = await resolveCluster(req, res);
    if (!record) return;

    const [model, render, guard, applyMod] = await Promise.all([
      loadModule('model'), loadModule('render'), loadModule('guard'), loadModule('apply'),
    ]);
    if (!model || !render || !guard || !applyMod) {
      res.status(503).json({ error: 'AI Infra 能力层未就绪（缺少 model/render/guard/apply 模块）' });
      return;
    }

    const validation = model.validateModelService(req.body?.service);
    if (!validation.ok) {
      res.status(400).json({
        error: '服务定义校验未通过',
        violations: validation.errors.map((e) => ({ code: 'INVALID_SERVICE', field: e.field, message: e.message })),
      });
      return;
    }

    const { client } = connectCluster(record);
    const rendered = render.renderModelService(validation.value, { gatewayIP: record.server || '' });
    const guardResult = guard.checkGuard({
      service: validation.value,
      existing: null, // A5 内部会按需读取；这里传 null 表示"由执行器决定"
      settings: ensureSettings(),
      env: process.env,
      force: req.body?.force === true,
    });

    let result;
    try {
      result = await applyMod.applyService({
        service: validation.value,
        objects: rendered.objects,
        client,
        guard: guardResult,
        opts: { probeUrl: req.body?.probeUrl || null },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: `执行失败：${errorMessage(err)}` });
      return;
    }

    // 成功则落库 + 记历史
    if (result?.ok) {
      const current = findService(ensureSettings(), `${validation.value.namespace}/${validation.value.name}`) || {};
      const merged = {
        ...validation.value,
        id: current.id || validation.value.id || `svc-${Date.now().toString(36)}`,
        history: appendHistory(current, {
          action: result.action || 'update',
          ok: true,
          version: Number(current.version || 0) + 1,
          note: `快照${result.rollbackAvailable ? '可回滚' : '不可回滚'}`,
        }),
      };
      if (typeof saveSettings === 'function') {
        saveSettings(upsertService(ensureSettings(), merged));
      }
    }

    res.json({
      ok: result?.ok === true,
      action: result?.action || null,
      steps: result?.steps || [],
      error: result?.error || null,
      auditId: result?.auditId || null,
      snapshot: result?.snapshot ? { available: Boolean(result.rollbackAvailable) } : null,
      service: result?.ok ? findService(ensureSettings(), `${validation.value.namespace}/${validation.value.name}`) : null,
    });
  });

  /* ── 回滚 ── */
  router.post(`${PREFIX}/services/:id/rollback`, async (req, res) => {
    if (!enabled()) {
      res.status(403).json({ error: 'AI Infra 写能力未启用（设置 OPENLOG_K8S_INFRA=1 后生效）', readOnly: true });
      return;
    }
    const record = await resolveCluster(req, res);
    if (!record) return;
    const applyMod = await loadModule('apply');
    if (!applyMod) {
      res.status(503).json({ error: 'AI Infra 能力层未就绪（缺少 apply 模块）' });
      return;
    }

    // 前端只让回滚"上一版"：这里按版本号取历史快照（当前实现以定义里的 snapshot 为准）
    const service = findService(ensureSettings(), req.params.id);
    const snapshot = service?.lastSnapshot || null;
    if (!snapshot) {
      res.status(409).json({ error: '没有可回滚的快照（该服务还没有成功执行过，或快照已过期）' });
      return;
    }

    const { client } = connectCluster(record);
    try {
      const result = await applyMod.rollbackService({ snapshot, client });
      res.json({ ok: result?.ok === true, steps: result?.steps || [], error: result?.error || null });
    } catch (err) {
      res.status(500).json({ ok: false, error: `回滚失败：${errorMessage(err)}` });
    }
  });

  /* ── 基准 ── */
  router.post(`${PREFIX}/bench`, async (req, res) => {
    if (isDemoMode()) {
      res.status(409).json({ error: '演示模式不会对真实服务压测', demo: true });
      return;
    }
    const record = await resolveCluster(req, res);
    if (!record) return;
    const bench = await loadModule('bench');
    if (!bench) {
      res.status(503).json({ error: 'AI Infra 能力层未就绪（缺少 bench 模块）' });
      return;
    }
    const target = req.body?.target;
    if (!target?.url || !target?.model) {
      res.status(400).json({ error: '缺少压测目标（需要 target.url 与 target.model）' });
      return;
    }
    try {
      const result = await bench.runBenchmark({
        target,
        matrix: req.body?.matrix,
        limits: req.body?.limits,
        fetchImpl: globalThis.fetch,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `基准失败：${errorMessage(err)}` });
    }
  });

  return router;
}

/** 把 HAMi 汇总里的分配摊平成容量预检要的形状。 */
export function allocationsFromSummary(summary) {
  const out = [];
  for (const node of summary?.nodes || []) {
    for (const device of node.devices || []) {
      if (!device?.id) continue;
      out.push({
        node: node.name || '',
        deviceId: device.id,
        memoryMiB: Number(device.allocatedMemMiB) || 0,
        coresPercent: Number(device.allocatedCores) || 0,
      });
    }
  }
  return out;
}
