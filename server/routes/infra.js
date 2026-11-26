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
import { getKv, setKv } from '../db/index.js';
import * as k8sKubeconfig from '../k8s/kubeconfig.js';
import * as k8sClientModule from '../k8s/client.js';
import * as k8sResources from '../k8s/resources.js';
import * as k8sHami from '../k8s/hami.js';
import { isDemoMode } from '../demo/mode.js';

const PREFIX = '/api/infra';

/**
 * 网关注册的目标（写死，不从请求体取）。
 *
 * 三个字段都是"能影响别人"的参数：
 *   · namespace/configMapName —— 往哪写 nginx 配置
 *   · deploymentName         —— 给谁打 reload 注解（等于重启谁）
 * 让调用方传就等于开放了"任意 ConfigMap 写入 + 任意 Deployment 强制滚动"，
 * 所以固定成常量；换网关时改这里并走 code review。
 */
const GATEWAY = {
  namespace: 'inference',
  configMapName: 'reranker-gateway-conf',
  configMapKey: 'nginx.conf',
  deploymentName: 'reranker-gateway',
};

/** 服务定义存放位置：跟着 settings 走，导出/备份/迁移与其它配置一致。 */
const SERVICES_KEY = 'infraServices';

/* ────────────────────────── 惰性加载能力层模块 ────────────────────────── */

const modules = {
  model: null, render: null, guard: null, capacity: null, apply: null, bench: null, accelerator: null,
  gateway: null, audit: null, autoscale: null, modelCache: null, gate: null, footprint: null, modelSpec: null,
};

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
    gateway: '../infra/gateway.js',
    audit: '../infra/audit-store.js',
    autoscale: '../infra/autoscale.js',
    modelCache: '../infra/model-cache.js',
    gate: '../infra/gate.js',
    footprint: '../infra/footprint.js',
    modelSpec: '../infra/model-spec.js',
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
  return services.find((s) => s.id === key)
    || services.find((s) => `${s.namespace}/${s.name}` === key)
    // URL 里传的往往只是服务名（/services/verify-ok/apply），最后再按 name 匹配一次；
    // 同名跨命名空间极罕见，真出现时用 `ns/name` 或 id 精确指定。
    || services.find((s) => s.name === key)
    || null;
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

/**
 * 把 settings 里的集群记录变成可用的 client。
 *
 * 与 routes/k8s-usage.js、routes/k8s.js 的 connectCluster 同一口径（同一套中文错误文案）：
 * 先 parseKubeconfig 拿到 server/token/证书，再 createK8sClient。
 * 注意 kubeconfig.js 只导出 parseKubeconfig / describeKubeconfig —— 没有 resolveKubeconfig，
 * 这里若写错函数名会变成运行期 TypeError（不是编译期能发现的）。
 */
export function connectCluster(record) {
  const text = typeof record?.kubeconfig === 'string' ? record.kubeconfig : '';
  if (text.trim() === '') {
    const err = new Error('集群缺少 kubeconfig：请先在「K8s 集群」里补上');
    err.status = 400;
    throw err;
  }
  let resolved;
  try {
    resolved = k8sKubeconfig.parseKubeconfig(text, record?.context || undefined);
    if (!resolved || typeof resolved !== 'object') throw new Error('kubeconfig 解析结果为空');
  } catch (err) {
    const wrapped = new Error(`kubeconfig 解析失败：${errorMessage(err)}`);
    wrapped.status = 400;
    throw wrapped;
  }
  try {
    const client = k8sClientModule.createK8sClient(resolved);
    if (!client || typeof client.getJson !== 'function') {
      throw new Error('客户端缺少 getJson');
    }
    return { client, resolved };
  } catch (err) {
    const wrapped = new Error(`创建 Kubernetes 客户端失败：${errorMessage(err)}`);
    wrapped.status = 502;
    throw wrapped;
  }
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


/* ────────────────────────── 快照存储 ────────────────────────── */

/**
 * 快照存 KV 而不是 settings：
 * settings 是整份配置（会被前端一次性读走、也会被导出/备份），塞进几十 KB 的 k8s 对象不合适。
 * 这里按 `namespace/name` 索引，每个服务保留最近 5 份，够回滚、又不会无限增长。
 */
const SNAPSHOT_KV_KEY = 'infra_snapshots';
const SNAPSHOT_KEEP = 5;

/** @returns {Record<string, Array<{at:string, snapshot:object}>>} */
function loadSnapshots() {
  try {
    const stored = getKv(SNAPSHOT_KV_KEY);
    return stored && typeof stored === 'object' ? stored : {};
  } catch {
    return {};
  }
}

export function saveSnapshot(key, snapshot, now = new Date()) {
  if (!snapshot || !Array.isArray(snapshot.objects)) return;
  const all = loadSnapshots();
  const list = Array.isArray(all[key]) ? all[key] : [];
  list.unshift({ at: now.toISOString(), snapshot });
  all[key] = list.slice(0, SNAPSHOT_KEEP);
  try {
    setKv(SNAPSHOT_KV_KEY, all);
  } catch (err) {
    console.warn(`[Infra] 快照写入失败（回滚将不可用）：${errorMessage(err)}`);
  }
}

/**
 * 取某服务的快照。
 *
 * @param {string} key           `namespace/name`
 * @param {number} [index]       0 = 最近一次（默认）；1 = 上上次…（列表是新的在前）
 * @returns {object|null}
 */
export function latestSnapshot(key, index = 0) {
  const list = loadSnapshots()[key];
  if (!Array.isArray(list) || list.length === 0) return null;
  const i = Math.trunc(Number(index) || 0);
  // 越界返回 null，**不夹到末位**：夹取会让"回滚到第 5 版"静默变成"回滚到最老一版"，
  // 用户以为回到了目标版本，实际不是。让调用方显式报 409 更安全。
  if (i < 0 || i >= list.length) return null;
  return list[i].snapshot;
}

/* ────────────────────────── 审计 ────────────────────────── */

let auditStore = null;

/**
 * 审计存储是惰性单例：模块缺失（还没落地）时返回 null，
 * 调用方据此跳过审计 —— **审计失败绝不能阻断运维**（真机上一次写审计失败不该让变更回滚）。
 */
async function getAuditStore() {
  if (auditStore) return auditStore;
  const [mod, db] = await Promise.all([loadModule('audit'), import('../db/index.js').catch(() => null)]);
  if (!mod?.createAuditStore || !db?.getKv || !db?.setKv) return null;
  auditStore = mod.createAuditStore({ getKv: db.getKv, setKv: db.setKv });
  return auditStore;
}

/** 记录一次变更（失败只 warn，不改变 HTTP 结果） */
async function recordAudit({ service, result, actor, forced, snapshotRef }) {
  try {
    const store = await getAuditStore();
    const mod = await loadModule('audit');
    if (!store || !mod?.recordApply) return null;
    return await mod.recordApply({ store, service, result, actor, forced, snapshotRef });
  } catch (err) {
    console.warn(`[Infra] 审计写入失败（变更本身已生效）：${errorMessage(err)}`);
    return null;
  }
}

/* ────────────────────────── 路由 ────────────────────────── */

/**
 * @param {{ ensureSettings: () => object, saveSettings?: (settings:object)=>void }} deps
 */
/**
 * 推导 rollout 超时。
 *
 * 为什么不能固定 120s：模型冷启动时间 ≈ 权重读取 + 显存拷贝，和参数量成正比。
 * 实测 32B-AWQ（18.5GB 权重）在 4090 上 120 秒起不来，而 0.5B 模型 10 秒内就绪。
 * 固定值要么误杀大模型（本次就是这样），要么让小模型白等。
 *
 * 规则：显式指定优先（夹到 30s..30min）；否则按 sizeMiB 估（每 GiB 约 6 秒，下限 120s，上限 20min）。
 */
/**
 * 读某服务实测显存峰值（给 bench 用）。
 *
 * 为什么读**进程级**而不是卡级：一张卡上可能跑着多个 vGPU 租户，
 * 卡级 memory.used 是所有人总和，拿来当"这个模型用了多少"会误导配额决策。
 * 所以按进程取最大值 —— 单模型服务下它就是该模型的实际占用。
 * 拿不到返回 null，bench 会降级成 confidence=estimated 并明确告警，不编数字。
 */
async function makeGpuMemReader(record, serviceKey) {
  if (!String(serviceKey || '').trim()) return undefined;
  try {
    const remoteModule = await import('../remote.js');
    const servers = typeof remoteModule.getServers === 'function' ? remoteModule.getServers() : [];
    const host = String(record?.server || '').replace(/^https?:\/\//, '').split(':')[0];
    const server = servers.find((x) => x && String(x.host || '').includes(host));
    if (!server) return undefined;
    return async () => {
      const r = await remoteModule.execRemoteCommand(
        server.id,
        'nvidia-smi --query-compute-apps=used_memory --format=csv,noheader,nounits | sort -rn | head -1',
      );
      const m = String(r?.stdout || '').match(/(\d+)/);
      return m ? Number(m[1]) : null;
    };
  } catch {
    return undefined;
  }
}

/**
 * 读模型规格（GGUF 头 / config.json），走已有的 SSH 通道。
 *
 * 为什么要读真机文件：KV cache 的大小取决于层数、KV 头数、head_dim、KV 精度，
 * 这些只有模型文件里有。经验表对"混合架构 + GQA + int8 KV"的模型会差 80 倍（实测）。
 *
 * 失败一律返回 null —— footprint 会安全退回经验值并明确告警，不影响预览。
 */
async function readModelSpecSafe(record, model) {
  const specMod = await loadModule('modelSpec');
  if (!specMod?.readModelSpec) return { spec: null, kvBudget: null, reason: '模型规格模块未就绪' };

  const modelPath = String(model?.specPath || model?.path || '').trim();
  if (!modelPath) return { spec: null, kvBudget: null, reason: '没有模型路径' };

  try {
    const remoteModule = await import('../remote.js');
    const servers = typeof remoteModule.getServers === 'function' ? remoteModule.getServers() : [];
    const host = String(record?.server || '').replace(/^https?:\/\//, '').split(':')[0];
    const server = servers.find((x) => x && String(x.host || '').includes(host));
    if (!server) {
      return { spec: null, kvBudget: null, reason: `没有与集群 server（${host}）匹配的 SSH 服务器，读不到模型元数据` };
    }
    const exec = async (cmd) => remoteModule.execRemoteCommand(server.id, cmd);
    const read = await specMod.readModelSpec({ path: modelPath, exec });
    if (!read.ok) return { spec: null, kvBudget: null, reason: read.reason };
    const kvBudget = specMod.preciseKvBudget({
      spec: read.spec,
      args: model?.engineArgs || [],
      contextLength: model?.contextLength,
      maxConcurrency: model?.maxConcurrency,
    });
    return { spec: read.spec, kvBudget: kvBudget.ok ? kvBudget : null, reason: kvBudget.ok ? null : kvBudget.reason, kind: read.kind };
  } catch (err) {
    return { spec: null, kvBudget: null, reason: `读取模型元数据失败：${errorMessage(err)}` };
  }
}

/**
 * 过滤出「可以进网关」的服务定义：
 *   · 有 expose（否则不该有路由）
 *   · 在集群里真的有对应 Deployment 且带 managedBy=openlog-infra
 *
 * 读不到集群就退回到"只保留当前这次 apply 的服务" —— 宁可少路由也不猜。
 */
async function filterExposedManaged(settings, client, rendered) {
  const candidates = listServices(settings).filter((s) => s && s.expose && s.expose.gatewayPort);
  const safe = [];
  for (const svc of candidates) {
    try {
      const dep = await client.getJson(
        `/apis/apps/v1/namespaces/${encodeURIComponent(svc.namespace)}/deployments/${encodeURIComponent(svc.name)}`,
      ).catch((err) => {
        if (err?.status === 404) return null;
        throw err;
      });
      const labels = dep?.metadata?.labels || {};
      const managed = labels.managedBy === 'openlog-infra'
        || labels['app.kubernetes.io/managed-by'] === 'openlog-infra';
      if (dep && managed) safe.push(svc);
    } catch {
      // 单个服务读失败就跳过它（不阻断其它路由）
    }
  }
  // 当前正在 apply 的这个必然存在（刚创建/更新完），确保它一定在内
  if (rendered?.routes?.length > 0 && !safe.some((s) => s.name === rendered.serviceName)) {
    // rendered 里没有服务名，保守起见不再追加 —— 保持"只信集群里查得到的"
  }
  return safe;
}

export function resolveRolloutTimeout(explicit, service, applyOptions = {}) {
  const base = Number(applyOptions?.rolloutTimeoutMs) || 120_000;
  const MIN = 30_000;
  const MAX = 30 * 60_000;
  const clamp = (v) => Math.min(MAX, Math.max(MIN, Math.round(v)));

  const asked = Number(explicit);
  if (Number.isFinite(asked) && asked > 0) return clamp(asked);

  const sizeMiB = Number(service?.model?.sizeMiB);
  if (Number.isFinite(sizeMiB) && sizeMiB > 0) {
    const estimated = Math.max(base, (sizeMiB / 1024) * 6000 + 60_000);
    return clamp(estimated);
  }
  return clamp(base);
}

export function createInfraRouter({ ensureSettings, saveSettings, applyOptions = {} } = {}) {
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

    let client;
    try {
      ({ client } = connectCluster(record));
    } catch (err) {
      res.status(err.status || 502).json({ error: errorMessage(err) });
      return;
    }
    let existing = null;
    let state = null;
    try {
      state = await readClusterState(client);
      const key = model.serviceKey(validation.value);
      const [ns, name] = key.split('/');
      const depPath = `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}`;
      // 只有 404 才算"不存在"；其它错误（403/超时/网络）必须显式失败 ——
      // 之前 catch(() => null) 把"读不到"当成"没有"，护栏于是看不见已有对象，
      // 这正是把生产 Deployment 覆盖掉的同源缺陷（apply 侧的 existing:null 也是它）。
      existing = await client.getJson(depPath).catch((err) => {
        if (err?.status === 404) return null;
        throw err;
      });
    } catch (err) {
      res.status(502).json({ error: `读取集群现状失败：${errorMessage(err)}` });
      return;
    }

    // 归属预检：和目标同名却属于别人的对象，预览阶段就要说"不行"，
    // 而不是等到 apply 才 409 —— 用户在预览里看到 allowed:true 就会以为能改。
    if (existing) {
      const labels = existing?.metadata?.labels || {};
      const owned = labels.managedBy === 'openlog-infra'
        || labels['app.kubernetes.io/managed-by'] === 'openlog-infra';
      if (!owned) {
        res.json({
          allowed: false,
          violations: [{
            code: 'NOT_MANAGED',
            field: 'name',
            message: `${validation.value.namespace}/${validation.value.name} 已存在且不属于 OpenLog 管理`
              + '（缺少 managedBy=openlog-infra 归属标签），拒绝覆盖。换一个服务名，或先人工确认接管。',
          }],
          diff: '',
          impact: { action: 'noop', restarts: false, downtimeSeconds: 0, reasons: ['归属校验未通过，未生成任何清单'] },
        });
        return;
      }
    }

    const rendered = render.renderModelService(validation.value, { gatewayIP: record.server || '' });

    // ① 弹性：服务声明了 autoscale 就一起渲染 HPA（扩副本会吃 vGPU 配额，所以先过预算校验）
    const autoscaleMod = await loadModule('autoscale');
    if (autoscaleMod && validation.value.autoscale && Number(validation.value.autoscale.maxReplicas) > 0) {
      try {
        rendered.objects.push(autoscaleMod.renderHpa({
          service: validation.value,
          autoscale: validation.value.autoscale,
        }));
        // 交给 HPA 管的服务不能再写死 Deployment.spec.replicas ——
        // 否则 apply 改回原值、HPA 再改回去，两个控制器互相拉扯 = 副本数抖动。
        // 删掉该字段后 k8s 保留当前值，replicas 的唯一来源就是 HPA。
        const depForHpa = rendered.objects.find((o) => o.kind === 'Deployment');
        if (depForHpa) {
          delete depForHpa.spec.replicas;
          depForHpa.metadata.annotations = {
            ...(depForHpa.metadata.annotations || {}),
            'openlog.io/replicas-managed-by': 'hpa',
          };
        }
      } catch (err) {
        res.status(400).json({ error: `自动伸缩配置无法渲染：${errorMessage(err)}` });
        return;
      }
    }

    // ② 模型缓存：绝不允许每个 Pod 各拷一份权重（真机 DiskPressure 就是这么来的）
    const cacheMod = await loadModule('modelCache');
    if (cacheMod) {
      try {
        const cachePlan = cacheMod.planModelCache({
          service: validation.value,
          nodes: [],
          existingCaches: [],
          cache: validation.value.cache,
        });
        const cacheRes = cacheMod.renderCacheResources({ plan: cachePlan });
        const dep = rendered.objects.find((o) => o.kind === 'Deployment');
        if (dep && cacheRes.volumes.length > 0) {
          dep.spec.template.spec.volumes = [...(dep.spec.template.spec.volumes || []), ...cacheRes.volumes];
          const container = dep.spec.template.spec.containers[0];
          container.volumeMounts = [...(container.volumeMounts || []), ...cacheRes.volumeMounts];
          dep.metadata.annotations = {
            ...(dep.metadata.annotations || {}),
            'openlog.io/model-cache-strategy': String(cachePlan.strategy || 'none'),
            'openlog.io/model-cache-shared': String(Boolean(cachePlan.shared)),
          };
        }
        rendered.cachePlan = cachePlan;
      } catch (err) {
        // 缓存计划失败不能挡住部署（模型仍可用 hostPath 直挂），但要让调用方看见原因
        rendered.cachePlan = { strategy: 'none', shared: false, warnings: [`模型缓存计划失败：${errorMessage(err)}`] };
      }
    }
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

    // 宿主路径预检：hostPath 不存在时 k8s 不会拒绝创建，而是让 Pod 卡在 ContainerCreating/FailedMount，
    // 最后表现为"rollout 超时"——排查成本高（真机 verify2 就是这么失败的）。
    // 这里能静态查的是"缓存挂载点与模型路径是否自洽"，真正存在性由下面的 hostPath 探测负责。
    const pathViolations = [];
    const plan2 = rendered.cachePlan;
    if (plan2 && plan2.strategy !== 'none') {
      const mountPath = String(plan2.mountPath || (plan2.volumeMounts?.[0]?.mountPath) || '');
      const modelPath = String(validation.value.model?.path || '');
      if (mountPath && modelPath && !modelPath.startsWith(`${mountPath}/`) && modelPath !== mountPath) {
        pathViolations.push({
          code: 'MODEL_PATH_OUTSIDE_CACHE',
          field: 'model.path',
          message: `模型路径 ${modelPath} 不在缓存挂载点 ${mountPath} 之下：容器里将看不到权重文件。`
            + `把 cache.hostPath 设成模型所在目录，或把 model.path 移到 ${mountPath} 内。`,
        });
      }
    }

    // 实测值属于「这个服务」而不是「这次请求」：
    // bench 回填后，哪怕前端的预览请求里没带 measuredMemMiB，也应该用已存定义里的实测值，
    // 否则用户会看到"压测回填了但还是按文件大小估算"的矛盾结论。
    const storedForMeasure = findService(
      ensureSettings(),
      `${validation.value.namespace}/${validation.value.name}`,
    );
    if (storedForMeasure?.model?.measuredMemMiB && !validation.value.model?.measuredMemMiB) {
      validation.value.model = {
        ...validation.value.model,
        measuredMemMiB: storedForMeasure.model.measuredMemMiB,
        measuredContextLength: storedForMeasure.model.measuredContextLength,
        measuredMaxConcurrency: storedForMeasure.model.measuredMaxConcurrency,
        measuredAt: storedForMeasure.model.measuredAt,
      };
    }

    // 模型足迹：容量预检只回答"配额放得进卡"，回答不了"模型放得进配额"。
    // 真机上就是因为缺这一步，21 GiB 配额下 AWQ 反量化 OOM、22.7 GiB 下 KV cache 为负。
    const footprintMod = await loadModule('footprint');
    const footprintViolations = [];
    let footprint = null;
    if (footprintMod?.estimateModelFootprint) {
      try {
        // 先尝试读真机模型元数据（精确 KV），读不到才用经验值
        const specInfo = await readModelSpecSafe(record, {
          ...validation.value.model,
          engineArgs: validation.value.engine?.args,
        });
        footprint = footprintMod.estimateModelFootprint({
          model: validation.value.model,
          engine: validation.value.engine,
          resources: validation.value.resources,
          replicas: validation.value.replicas,
          spec: specInfo.spec,
          kvBudget: specInfo.kvBudget,
          // 定义里存过实测值就用它（卸载型引擎下这是唯一可信的权重口径）
          measured: validation.value.model?.measuredMemMiB
            ? {
              memMiB: validation.value.model.measuredMemMiB,
              contextLength: validation.value.model.measuredContextLength,
              maxConcurrency: validation.value.model.measuredMaxConcurrency,
              at: validation.value.model.measuredAt,
            }
            : null,
        });
        if (specInfo.spec) footprint.specSource = specInfo.kind || 'model-file';
        if (specInfo.reason) footprint.warnings = [...(footprint.warnings || []), `模型元数据：${specInfo.reason}`];
        if (footprint.verdict === 'insufficient') {
          footprintViolations.push({
            code: 'MODEL_FOOTPRINT_EXCEEDED',
            field: 'resources.memoryMiB',
            message: footprint.reasons.join(' '),
          });
        }
      } catch (err) {
        footprint = { verdict: 'unknown', reasons: [`模型足迹估算失败：${errorMessage(err)}`], warnings: [] };
      }
    }

    // 自动伸缩预算：扩副本会吃 vGPU 配额，超了 HPA 会一直重试 Pending（不会自动止损），
    // 所以必须在预览阶段就算清楚，而不是等运行期发现。
    const autoscaleMod2 = await loadModule('autoscale');
    const autoscaleViolations = [];
    if (autoscaleMod2 && validation.value.autoscale && Number(validation.value.autoscale.maxReplicas) > 0) {
      const asCheck = autoscaleMod2.validateAutoscale({ service: validation.value, autoscale: validation.value.autoscale });
      if (!asCheck.ok) {
        for (const e of asCheck.errors) {
          autoscaleViolations.push({ code: 'INVALID_AUTOSCALE', field: e.field, message: e.message });
        }
      } else if (placement?.best) {
        const bestNode = (placement.candidates || []).find((c) => {
          const name = typeof c.node === 'string' ? c.node : c.node?.name;
          const bestName = typeof placement.best === 'string' ? placement.best : placement.best?.node || placement.best?.name;
          return name === bestName;
        });
        const perCard = {
          perCardMemMiB: Number(bestNode?.maxFreeMemMiB || bestNode?.freeMemMiB || 0),
          perCardCores: 100,
        };
        if (perCard.perCardMemMiB > 0) {
          const budget = autoscaleMod2.autoscaleBudget({
            service: validation.value,
            autoscale: asCheck.value,
            capacity: perCard,
          });
          if (budget && budget.allowed === false) {
            autoscaleViolations.push({ code: 'AUTOSCALE_BUDGET_EXCEEDED', field: 'autoscale.maxReplicas', message: budget.reason });
          }
        }
      }
    }

    res.json({
      allowed: guardResult.allowed
        && (placement ? placement.fits : true)
        && autoscaleViolations.length === 0
        && pathViolations.length === 0
        && footprintViolations.length === 0,
      violations: [
        ...(guardResult.violations || []),
        ...autoscaleViolations,
        ...pathViolations,
        ...footprintViolations,
        ...(placement && placement.fits === false
          ? placement.reasons.map((message) => ({ code: 'CAPACITY_INSUFFICIENT', message }))
          : []),
      ],
      diff: guardResult.diff || '',
      impact,
      objects: rendered.objects,
      routes: rendered.routes,
      placement,
      footprint,
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

    // 可选的门禁强制：`requireGate: true` 时，定义里必须有一条"通过"的门禁记录。
    // 为什么不默认强制：门禁是**取证工具**——运维在故障时可能就是要先上线止血。
    // 但既然 UI 会拦，服务端就必须也能拦，否则"前端禁用"只是样子货。
    if (req.body?.requireGate === true) {
      const gated = findService(ensureSettings(), `${validation.value.namespace}/${validation.value.name}`);
      const lastGate = gated?.lastGate || null;
      if (!lastGate) {
        res.status(409).json({
          ok: false,
          action: 'rejected',
          error: '要求门禁通过才能执行，但该服务还没有基准记录：请先跑一次 bench',
          code: 'GATE_MISSING',
        });
        return;
      }
      if (lastGate.pass !== true) {
        res.status(409).json({
          ok: false,
          action: 'rejected',
          error: `要求门禁通过才能执行，但最近一次基准未通过（${(lastGate.failures || []).join('、') || '未知项'}）`,
          code: 'GATE_FAILED',
          gate: lastGate,
        });
        return;
      }
    }

    let client;
    try {
      ({ client } = connectCluster(record));
    } catch (err) {
      res.status(err.status || 502).json({ error: errorMessage(err) });
      return;
    }

    // 必须先读现状再进护栏：NOT_MANAGED 的判定依据就是「同名对象存在但不带 openlog-infra 归属」。
    // 之前这里图省事传了 existing: null，结果护栏无法识别"这是别人的 Deployment"，
    // 真实集群上的 strata 被覆盖成测试镜像（靠 rollout 失败后的自动回滚才恢复）。
    // 这是一次真机事故，改成 fail closed：读不到现状就不允许写。
    let existingObjects = [];
    try {
      const key = model.serviceKey(validation.value);
      const [ns, name] = key.split('/');
      const paths = [
        `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}`,
        `/api/v1/namespaces/${encodeURIComponent(ns)}/services/${encodeURIComponent(name)}`,
      ];
      for (const path of paths) {
        const obj = await client.getJson(path).catch((err) => {
          if (err?.status === 404) return null;
          throw err;
        });
        if (obj) existingObjects.push(obj);
      }
    } catch (err) {
      res.status(502).json({ error: `读取集群现状失败，已拒绝写入（无法确认对象归属）：${errorMessage(err)}` });
      return;
    }

    // 归属硬校验：同名对象存在但不带 openlog-infra 归属 → 直接拒绝，连干跑都不做。
    // 这是真机事故的直接补丁：曾经因为 existing 传 null，护栏无法识别"别人的对象"，
    // 结果把 inference/strata 覆盖成测试镜像（靠 rollout 失败后的自动回滚才恢复）。
    const unmanaged = existingObjects.filter((obj) => {
      const labels = obj?.metadata?.labels || {};
      return labels.managedBy !== 'openlog-infra' && labels['app.kubernetes.io/managed-by'] !== 'openlog-infra';
    });
    if (unmanaged.length > 0) {
      const names = unmanaged.map((o) => `${o.kind || 'Object'}/${o.metadata?.name || '?'}`).join('、');
      res.status(409).json({
        ok: false,
        action: 'rejected',
        error: `${names} 已存在且不属于 OpenLog 管理（缺少 openlog-infra 归属标签），拒绝覆盖。`
          + '如需接管请先人工确认，或换一个服务名。',
        steps: [{
          name: 'guard',
          ok: false,
          detail: `归属校验未通过：${names} 缺少 managedBy=openlog-infra 标签`,
        }],
      });
      return;
    }

    const rendered = render.renderModelService(validation.value, { gatewayIP: record.server || '' });

    // ① 弹性：服务声明了 autoscale 就一起渲染 HPA（扩副本会吃 vGPU 配额，所以先过预算校验）
    const autoscaleMod = await loadModule('autoscale');
    if (autoscaleMod && validation.value.autoscale && Number(validation.value.autoscale.maxReplicas) > 0) {
      try {
        rendered.objects.push(autoscaleMod.renderHpa({
          service: validation.value,
          autoscale: validation.value.autoscale,
        }));
        // 交给 HPA 管的服务不能再写死 Deployment.spec.replicas ——
        // 否则 apply 改回原值、HPA 再改回去，两个控制器互相拉扯 = 副本数抖动。
        // 删掉该字段后 k8s 保留当前值，replicas 的唯一来源就是 HPA。
        const depForHpa = rendered.objects.find((o) => o.kind === 'Deployment');
        if (depForHpa) {
          delete depForHpa.spec.replicas;
          depForHpa.metadata.annotations = {
            ...(depForHpa.metadata.annotations || {}),
            'openlog.io/replicas-managed-by': 'hpa',
          };
        }
      } catch (err) {
        res.status(400).json({ error: `自动伸缩配置无法渲染：${errorMessage(err)}` });
        return;
      }
    }

    // ② 模型缓存：绝不允许每个 Pod 各拷一份权重（真机 DiskPressure 就是这么来的）
    const cacheMod = await loadModule('modelCache');
    if (cacheMod) {
      try {
        const cachePlan = cacheMod.planModelCache({
          service: validation.value,
          nodes: [],
          existingCaches: [],
          cache: validation.value.cache,
        });
        const cacheRes = cacheMod.renderCacheResources({ plan: cachePlan });
        const dep = rendered.objects.find((o) => o.kind === 'Deployment');
        if (dep && cacheRes.volumes.length > 0) {
          dep.spec.template.spec.volumes = [...(dep.spec.template.spec.volumes || []), ...cacheRes.volumes];
          const container = dep.spec.template.spec.containers[0];
          container.volumeMounts = [...(container.volumeMounts || []), ...cacheRes.volumeMounts];
          dep.metadata.annotations = {
            ...(dep.metadata.annotations || {}),
            'openlog.io/model-cache-strategy': String(cachePlan.strategy || 'none'),
            'openlog.io/model-cache-shared': String(Boolean(cachePlan.shared)),
          };
        }
        rendered.cachePlan = cachePlan;
      } catch (err) {
        // 缓存计划失败不能挡住部署（模型仍可用 hostPath 直挂），但要让调用方看见原因
        rendered.cachePlan = { strategy: 'none', shared: false, warnings: [`模型缓存计划失败：${errorMessage(err)}`] };
      }
    }
    const guardResult = guard.checkGuard({
      service: validation.value,
      existing: existingObjects.length > 0 ? existingObjects : null,
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
        opts: {
          ...applyOptions,
          // rollout 超时必须随模型大小可调：0.5B 几秒就绪，32B 冷启动要几分钟（实测 120s 不够）。
          // 优先级：请求显式指定 > 按模型权重估算 > 工厂默认。
          rolloutTimeoutMs: resolveRolloutTimeout(req.body?.rolloutTimeoutMs, validation.value, applyOptions),
          probeUrl: req.body?.probeUrl || null,
        },
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
        // 把本次变更前的快照存下来 —— 没有它，「回滚到上一版」这个按钮就是空的
        // （回滚接口读的就是 service.lastSnapshot；A5 已经在 apply 前抓过这份快照）。
        lastSnapshot: null, // 真快照存 KV（见 saveSnapshot），settings 里只留标记位
        history: appendHistory(current, {
          action: result.action || 'update',
          ok: true,
          version: Number(current.version || 0) + 1,
          note: `快照${result.rollbackAvailable ? '可回滚' : '不可回滚'}`,
        }),
      };
      if (result.snapshot) {
        saveSnapshot(`${validation.value.namespace}/${validation.value.name}`, result.snapshot);
      }
      if (typeof saveSettings === 'function') {
        saveSettings(upsertService(ensureSettings(), merged));
      }

      // 网关注册：服务起好后把路由写进 nginx 配置（hostNetwork 的 ConfigMap + reload 注解）。
      // 失败不回滚服务本身 —— 服务已经跑起来了，只是外部还访问不到；
      // 这类"半成功"必须让调用方看见（gateway 字段），不能吞掉。
      let gateway = null;
      const gatewayMod = await loadModule('gateway');
      if (gatewayMod && rendered.routes.length > 0) {
        try {
          // baseConfig 必须来自集群里的 ConfigMap，**绝不能**取请求体：
          // 它能原样并入 hostNetwork 网关的 nginx.conf，等于给调用方一个任意配置注入面
          // （改 listen/proxy_pass 就能改流量走向）。读不到 ≠ 不存在 → fail closed。
          const cmPath = `/api/v1/namespaces/${GATEWAY.namespace}/configmaps/${GATEWAY.configMapName}`;
          const cm = await client.getJson(cmPath).catch((err) => {
            if (err?.status === 404) return null;
            throw new Error(`读取网关配置失败（已跳过网关注册，服务本身正常）：${errorMessage(err)}`);
          });
          const currentConf = cm?.data?.[GATEWAY.configMapKey] || '';

          // 只把**真的在集群里存在且受 OpenLog 管**的服务送进网关渲染。
          // 为什么：settings 里可能有历史残留/草稿定义（expose 端口还在），
          // 一旦给不存在的服务生成 nginx 路由，网关会 [emerg] host not found in upstream → CrashLoop
          // （本项目踩过：一次 5916 条告警）。宁可少一条路由，也不能把网关弄挂。
          const all = await filterExposedManaged(ensureSettings(), client, rendered);
          const desired = gatewayMod.renderGatewayConfig({ services: all, baseConfig: currentConf });
          if (desired.conflicts.length > 0) {
            // 冲突必须当硬失败：跳过冲突端口等于"以为上线了，实际网关没这条路由"
            gateway = {
              ok: false,
              changed: false,
              conflicts: desired.conflicts,
              error: `网关端口冲突，已跳过网关注册：${desired.conflicts
                .map((c) => `${c.port} 被 ${c.owners.join(' / ')} 占用`).join('；')}。同一 listen 端口只能有一个 server 块。`,
            };
          } else {
            gateway = await gatewayMod.applyGatewayConfig({
              client,
              namespace: GATEWAY.namespace,
              configMapName: GATEWAY.configMapName,
              nginxConf: desired.nginxConf,
              // deploymentName 决定"给谁打 reload 注解" —— 必须写死成真实网关，
              // 否则它就是个"任意 Deployment 强制滚动"的原语（可用来 DoS 别的工作负载）
              opts: { deploymentName: GATEWAY.deploymentName, env: process.env },
            });
          }
        } catch (err) {
          gateway = { ok: false, error: `网关注册失败（服务本身已就绪，外部暂不可达）：${errorMessage(err)}`, changed: false };
        }
      }
      result.gateway = gateway;

      // 审计：这是"谁在什么时候改了什么"的唯一持久记录
      result.auditId = (await recordAudit({
        service: merged,
        result,
        actor: req.body?.actor || req.get?.('x-openlog-actor') || 'api',
        forced: guardResult.audit?.forced || [],
        snapshotRef: `${merged.namespace}/${merged.name}@${new Date().toISOString()}`,
      }))?.id || null;
    } else {
      // 被拒/失败也要留痕（尤其是 rejected：有人试图改不属于自己的对象）
      result.auditId = (await recordAudit({
        service: validation.value,
        result,
        actor: req.body?.actor || 'api',
        forced: guardResult.audit?.forced || [],
        snapshotRef: null,
      }))?.id || null;
    }

    res.json({
      ok: result?.ok === true,
      action: result?.action || null,
      steps: result?.steps || [],
      error: result?.error || null,
      auditId: result?.auditId || null,
      gateway: result?.gateway || null,
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
    const requested = String(req.params.id || '');
    const service = findService(ensureSettings(), requested);
    // version 的语义：往回第几份快照（默认 0 = 最近一次）。
    // 之前完全忽略这个参数 → 只能回退一步，传 version:3 也只会回到最近一版（"成功但没到目标"）。
    const backSteps = Number(req.body?.version ?? req.body?.stepsBack ?? 0);
    const idx = Number.isFinite(backSteps) && backSteps > 0 ? Math.trunc(backSteps) : 0;

    let snapshot = service ? latestSnapshot(`${service.namespace}/${service.name}`, idx) : null;
    if (!snapshot) {
      // 服务定义还没落库（或 URL 只给了名字）时，直接按快照键的 name 后缀匹配，
      // 避免"明明刚 apply 过却提示没有快照"。
      const all = loadSnapshots();
      const hit = Object.keys(all).find((k) => k === requested || k.endsWith(`/${requested}`));
      if (hit) snapshot = latestSnapshot(hit, idx);
    }
    if (!snapshot && idx > 0) {
      res.status(409).json({
        error: `没有第 ${idx + 1} 新的快照可回滚（该服务只保留了更少的变更记录，默认每服务 5 份）`,
        code: 'SNAPSHOT_OUT_OF_RANGE',
      });
      return;
    }
    if (!snapshot) snapshot = service?.lastSnapshot || null;
    if (!snapshot) {
      res.status(409).json({ error: '没有可回滚的快照（该服务还没有成功执行过，或快照已过期）' });
      return;
    }

    let client;
    try {
      ({ client } = connectCluster(record));
    } catch (err) {
      res.status(err.status || 502).json({ error: errorMessage(err) });
      return;
    }
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
        // 实测显存峰值：没有它，推荐配额只能是 null 或按权重猜（confidence=estimated）。
        // 两种来源：① 调用方直接给 gpuMemPeakMiB；② 用节点 GPU 探针读进程级显存。
        gpuMemPeakMiB: Number.isFinite(Number(req.body?.gpuMemPeakMiB)) ? Number(req.body.gpuMemPeakMiB) : undefined,
        readGpuMem: req.body?.gpuMemPeakMiB ? undefined : makeGpuMemReader(record, req.body?.serviceKey),
      });
        // 门禁：跑完立刻判定，并给出可贴进变更单的 markdown 报告。
        // 基线只在**通过**时更新 —— 否则下次回归对比的参照物就是坏数据。
        const gateMod = await loadModule('gate');
        let gate = null;
        let report = null;
        const serviceKey = String(req.body?.serviceKey || '');
        if (gateMod?.evaluateGate) {
          const service = findService(ensureSettings(), serviceKey) || req.body?.service || null;
          const baselines = ensureSettings()?.infra?.baselines || {};
          const baseline = service ? baselines[`${service.namespace}/${service.name}`] || null : null;
          gate = gateMod.evaluateGate({
            benchResult: result,
            baseline,
            thresholds: req.body?.thresholds || ensureSettings()?.infra?.gateThresholds || undefined,
            service,
          });
          report = gateMod.renderGateReport ? gateMod.renderGateReport({ service, benchResult: result, gate }) : null;
          if (gate?.pass && gateMod.buildBaseline && service && typeof saveSettings === 'function') {
            const settings = ensureSettings();
            saveSettings({
              ...settings,
              infra: {
                ...(settings.infra || {}),
                baselines: {
                  ...baselines,
                  [`${service.namespace}/${service.name}`]: gateMod.buildBaseline({ benchResult: result, service }),
                },
              },
            });
          }
        }
        // 回填实测显存：卸载型引擎（strata --expert-cache、llama.cpp mmap、vLLM --cpu-offload-gb）
        // 的文件大小与显存占用能差 4~5 倍，只有实测值能当权重口径。
        // 仅在拿到显存峰值且指定了服务时回填，避免污染无关服务。
        let backfilled = null;
        if (gateMod?.evaluateGate && serviceKey && typeof saveSettings === 'function') {
          const peak = Number(result?.summary?.recommended?.basis?.peakGpuMemMiB
            ?? result?.gate?.metrics?.memMiB
            ?? req.body?.gpuMemPeakMiB);
          if (Number.isFinite(peak) && peak > 0) {
            const existing = findService(ensureSettings(), serviceKey);
            if (existing && existing.model) {
              // 压测长度 ≠ 服务上下文：服务上下文由引擎启动参数决定（model.contextLength）
              const measuredCtxForBackfill = existing.model.contextLength
                || Number(req.body?.matrix?.inputTokens?.at(-1))
                || null;
              const nextService = {
                ...existing,
                model: {
                  ...existing.model,
                  measuredMemMiB: Math.round(peak),
                  // 注意：压测的 inputTokens 是"这次压测喂了多长"，不是服务实际运行时的上下文。
                  // 服务上下文以定义里的 model.contextLength 为准（引擎启动参数决定），
                  // 压测长度只用来判断"这次测量覆盖了多长的请求"。
          measuredContextLength: measuredCtxForBackfill,
                  measuredMaxConcurrency: Math.max(
                    1,
                    ...(Array.isArray(req.body?.matrix?.concurrencies) ? req.body.matrix.concurrencies : [1]),
                  ),
                  // 同时记下压测实际用到的长度区间，便于判断实测值覆盖范围
                  benchInputTokens: Array.isArray(req.body?.matrix?.inputTokens)
                    ? req.body.matrix.inputTokens.map(Number).filter(Number.isFinite)
                    : [],
                  measuredAt: new Date().toISOString(),
                },
              };
              saveSettings(upsertService(ensureSettings(), nextService));
              backfilled = { serviceKey, measuredMemMiB: Math.round(peak) };
            }
          }
        }
        // 把门禁结论存进定义：apply 时若要求强制门禁，就看这里
        if (gate && typeof saveSettings === 'function' && serviceKey) {
          const existingForGate = findService(ensureSettings(), serviceKey);
          if (existingForGate) {
            saveSettings(upsertService(ensureSettings(), {
              ...existingForGate,
              lastGate: {
                pass: gate.pass === true,
                score: gate.score ?? null,
                failures: (gate.failures || []).map((f) => f.metric),
                at: new Date().toISOString(),
              },
            }));
          }
        }
        res.json({ ...result, gate, report, backfilled });
    } catch (err) {
      res.status(500).json({ error: `基准失败：${errorMessage(err)}` });
    }
  });

  /* ── 只保存定义，不下发集群 ── */
  /**
   * 为什么需要它：bench 回填实测显存、以及"先把定义想清楚再下发"都要求定义能独立存在。
   * 这条路由**不碰集群**（不需要开关、不需要 kubeconfig），只做校验 + 落库。
   */
  router.post(`${PREFIX}/services/:id/definition`, async (req, res) => {
    if (isDemoMode()) {
      res.status(409).json({ error: '演示模式不保存定义', demo: true });
      return;
    }
    const model = await loadModule('model');
    if (!model) {
      res.status(503).json({ error: 'AI Infra 能力层未就绪（缺少 model 模块）' });
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
    if (typeof saveSettings !== 'function') {
      res.status(503).json({ error: '当前实例不支持保存定义（缺少 saveSettings）' });
      return;
    }
    const key = `${validation.value.namespace}/${validation.value.name}`;
    const current = findService(ensureSettings(), key) || {};
    const merged = {
      ...validation.value,
      id: current.id || validation.value.id || `svc-${Date.now().toString(36)}`,
      createdAt: current.createdAt || validation.value.createdAt || new Date().toISOString(),
    };
    // 从 upsert 的结果里读回，而不是再读一次 ensureSettings() ——
    // 后者依赖"保存后 settings 会立刻更新"，在注入式测试与某些存储实现下不成立。
    const nextSettings = upsertService(ensureSettings(), merged);
    saveSettings(nextSettings);
    const saved = findService(nextSettings, key) || merged;
    res.json({ ok: true, service: saved, note: '已保存定义（未下发集群）' });
  });

  /* ── 删除定义（只删记录，不动集群） ── */
  /**
   * 明确语义：删的是 settings 里的**定义**，不删集群里的工作负载。
   * 想下线服务请先 apply 一份 replicas=0，或走 k8s 侧操作 —— 避免"删了个定义，服务还在跑"
   * 这种更难排查的半状态。
   */
  router.delete(`${PREFIX}/services/:id`, async (req, res) => {
    if (isDemoMode()) {
      res.status(409).json({ error: '演示模式不修改定义', demo: true });
      return;
    }
    if (typeof saveSettings !== 'function') {
      res.status(503).json({ error: '当前实例不支持修改定义（缺少 saveSettings）' });
      return;
    }
    const requested = String(req.params.id || '').trim();
    const settings = ensureSettings();
    const all = listServices(settings);
    const target = findService(settings, requested);
    if (!target) {
      res.status(404).json({ error: `没有这个服务定义：${requested}` });
      return;
    }
    const remaining = all.filter((s) => s.id !== target.id && `${s.namespace}/${s.name}` !== `${target.namespace}/${target.name}`);
    saveSettings({ ...settings, infraServices: remaining });
    // 顺带清掉它的快照（否则回滚历史会指向一个不存在的服务）
    try {
      const snaps = loadSnapshots();
      const key = `${target.namespace}/${target.name}`;
      if (snaps[key]) {
        delete snaps[key];
        setKv(SNAPSHOT_KV_KEY, snaps);
      }
    } catch { /* 快照清理失败不影响删除本身 */ }
    res.json({ ok: true, removed: `${target.namespace}/${target.name}`, remaining: remaining.length, note: '只删除了定义记录，集群里的工作负载未受影响' });
  });

  /* ── 审计查询（读，不受开关限制） ── */
  router.get(`${PREFIX}/audit`, async (req, res) => {
    const mod = await loadModule('audit');
    const store = await getAuditStore();
    if (!mod || !store) {
      res.status(503).json({ error: '审计模块未就绪', items: [], total: 0 });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const filter = {
      limit,
      offset,
      actor: req.query.actor ? String(req.query.actor) : undefined,
      action: req.query.action ? String(req.query.action) : undefined,
      serviceKey: req.query.serviceKey ? String(req.query.serviceKey) : undefined,
    };
    const [page, stats] = [store.list(filter), store.stats()];
    res.json({ ...page, stats, demo: isDemoMode() });
  });

  /* ── 弹性预算（读，给表单实时提示"最多能扩到几副本"） ── */
  router.get(`${PREFIX}/clusters/:clusterId/autoscale-budget`, async (req, res) => {
    const record = await resolveCluster(req, res);
    if (!record) return;
    const autoscale = await loadModule('autoscale');
    const capacity = await loadModule('capacity');
    if (!autoscale) {
      res.status(503).json({ error: '弹性模块未就绪' });
      return;
    }
    // ?serviceKey=ns/name 指定服务定义；没有就按 query 里的 memoryMiB/coresPercent 临时算。
    // 之前把 :clusterId 当 serviceKey 用 —— 永远查不到，于是悄悄回落到临时值（结果看似正常）。
    const serviceKey = String(req.query.serviceKey || '');
    const service = serviceKey ? findService(ensureSettings(), serviceKey) : null;
    let perCard = { perCardMemMiB: 0, perCardCores: 100 };
    try {
      const { client } = connectCluster(record);
      const state = await readClusterState(client);
      // 口径必须与 preview 一致：用**单卡剩余余量**，不是"最大单卡容量"。
      // 用容量会让预算偏乐观（把已经分配给别人的显存也算成可用），HPA 扩出来的 Pod 会 Pending。
      const devices = (state.summary?.nodes || []).flatMap((n) => n.devices || []);
      if (devices.length > 0) {
        perCard = {
          perCardMemMiB: Math.max(...devices.map((d) => Math.max(0, (Number(d.memMiB) || 0) - (Number(d.allocatedMemMiB) || 0)))),
          perCardCores: Math.max(...devices.map((d) => Math.max(0, 100 - (Number(d.allocatedCores) || 0)))),
        };
      }
    } catch { /* 拿不到就用默认值，前端仍可显示上限 8 */ }
    const target = service || { resources: { memoryMiB: Number(req.query.memoryMiB) || 0, coresPercent: Number(req.query.coresPercent) || 0 } };
    res.json({ budget: autoscale.autoscaleBudget({ service: target, autoscale: req.query, capacity: perCard }), capacity: perCard });
  });

  /* ── 磁盘估算（读，避免又出现 DiskPressure → 整节点 Evicted） ── */
  router.post(`${PREFIX}/cache-estimate`, async (req, res) => {
    const cache = await loadModule('modelCache');
    if (!cache) {
      res.status(503).json({ error: '缓存模块未就绪' });
      return;
    }
    const { model, replicas, nodeCount } = req.body || {};
    if (!model || typeof model !== 'object') {
      res.status(400).json({ error: '缺少 model（需要 { path, format?, quantization?, sizeMiB? }）' });
      return;
    }
    try {
      const estimate = cache.estimateDiskUsage({ model, replicas: Number(replicas) || 1, nodeCount: Number(nodeCount) || 1 });
      const plan = cache.planModelCache({ service: req.body.service || { model }, nodes: req.body.nodes || [], existingCaches: [] });
      res.json({ estimate, plan });
    } catch (err) {
      res.status(400).json({ error: `估算失败：${errorMessage(err)}` });
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
