/**
 * routes/k8s.js — 只读 Kubernetes 集群监控 HTTP 端点（契约见 /tmp/k8s-contract.md）
 *
 * 挂载方式：路径写全（`/api/k8s/...`），index.js 直接 `app.use(createK8sRouter({ ensureSettings, saveSettings }))`，
 * 不要再套 `/api` 前缀（与 server/routes/db-monitor.js、server/routes/settings.js 同一惯例）。
 *
 * 本文件只做「HTTP 语义 + 编排」，四块领域逻辑全部在 ../k8s/ 下，由其它 agent 并行实现：
 *   kubeconfig.js  parseKubeconfig()          —— 文本 → 解析结果（支持 mTLS / token）
 *   client.js      createK8sClient(resolved)  —— 直连 kube-apiserver（不依赖 kubectl）
 *   resources.js   normalize* / summarize()   —— CRD 原始 items → 契约里的视图结构
 *   store.js       list/get/upsert/delete/toView —— settings.k8sClusters 的增删改查
 *   hami.js        readNodeGpu/readPodVgpu/summarizeVgpu —— HAMi vGPU 解析（契约见 /tmp/hami-contract.md）
 *
 * 之所以用 `import * as`（而非具名导入）：四个模块正在被并行实现，具名导入一旦某个导出缺失
 * 会在 **ESM 链接阶段**直接抛 SyntaxError，整条 /api/k8s 全挂；命名空间导入则只有真正调用到
 * 该函数时才失败，可被下面的 try/catch 降级成 500，不至于把路由整个带崩。
 *
 * 注入（index.js）：
 *   ensureSettings —— 读取当前生效配置（settings.k8sClusters 存在这里）
 *   saveSettings   —— 持久化；A4 的 upsertCluster/deleteCluster 返回 `{ record, settings }`，
 *                     这里把「新的 settings」交回给 saveSettings，路由自己不写文件
 *
 * 状态码约定（契约）：400 = 入参/kubeconfig 解析失败，404 = 集群 id 不存在，
 * 502 = 连不上 kube-apiserver（网络/证书/权限由 client 抛错统一归到这里）。
 * 鉴权由 index.js 的全局 authMiddleware 覆盖 /api，这里不再处理。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import * as k8sStore from '../k8s/store.js';
import * as k8sKubeconfig from '../k8s/kubeconfig.js';
import * as k8sClientModule from '../k8s/client.js';
import * as k8sResources from '../k8s/resources.js';
// HAMi vGPU 解析（H1 并行实现，契约见 /tmp/hami-contract.md）。
// 同样用命名空间导入：它的导出还在被并行实现，调用可能抛 not implemented，
// 具名导入一旦某个函数缺失会直接把整条 /api/k8s 带崩。
import * as k8sHami from '../k8s/hami.js';
import { isDemoMode, DEMO_DISABLED } from '../demo/mode.js';
import * as demoFixtures from '../demo/fixtures.js';

// ─── 演示模式（OPENLOG_DEMO=1）────────────────────────────────────────
// 数据只来自 server/demo/fixtures.js（命名空间导入，导出缺失不会在链接阶段崩整条路由）。
// 关闭演示模式时下面的分支都不会进，原有 kube-apiserver / store 逻辑保持原样。

/** 给模拟响应打上 demo:true 标记（契约：演示数据必须可识别） */
function demoJson(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return { demo: true, ...payload };
  return { demo: true, data: payload };
}

/** 取一份演示数据；fixture 缺失/抛错时返回 undefined，让端点降级而非 500 */
function demoValue(name, ...args) {
  const fn = demoFixtures[name];
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch (err) {
    console.warn(`[demo] ${name} 调用失败:`, errorMessage(err));
    return undefined;
  }
}

/** 演示集群列表（数组，形状同 GET /api/k8s/clusters 的 clusters[]） */
function demoClusters() {
  const data = demoValue('demoK8sClusters');
  return Array.isArray(data) ? data : (data?.clusters || []);
}

/** 路由前缀：index.js 里 `app.use(createK8sRouter(...))` 直接挂根，所以每条路径都写全 */
const PREFIX = '/api/k8s';

/** 日志行数默认值与上下界（契约：`?tail=200`，夹在 1..2000） */
const LOG_TAIL_DEFAULT = 200;
const LOG_TAIL_MIN = 1;
const LOG_TAIL_MAX = 2000;

/**
 * overview 并发拉取的六类资源。
 *
 * 全部走 cluster-scope 列表接口（不带 namespace），一次拿全集群：
 * RBAC 由 deploy/k8s/rbac.yaml 授予只读 ClusterRole，不需要按 namespace 逐个循环，
 * 也就不存在「namespace 太多导致 N 次串行请求」的放大问题。
 */
const OVERVIEW_ENDPOINTS = [
  { key: 'nodes', label: '节点', path: '/api/v1/nodes' },
  { key: 'pods', label: 'Pod', path: '/api/v1/pods' },
  { key: 'deployments', label: 'Deployment', path: '/apis/apps/v1/deployments' },
  { key: 'statefulsets', label: 'StatefulSet', path: '/apis/apps/v1/statefulsets' },
  { key: 'daemonsets', label: 'DaemonSet', path: '/apis/apps/v1/daemonsets' },
  { key: 'events', label: '事件', path: '/api/v1/events' },
];

// ─── 小工具 ───────────────────────────────────────────────────────────

/** 带 HTTP 状态码的入参错误：400 走这里，其余交给 sendError 的兜底状态 */
function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * 统一错误出口。`err.statusCode` 优先（validate 出来的 400），否则用调用方给的兜底状态。
 * 502 是这里的默认值：除了「入参不合法」和「id 不存在」，剩下的失败基本都是
 * 「连不上 / 证书不对 / 权限不足」这类上游不可达，client.js 抛什么原文就透出什么。
 */
function sendError(res, err, fallbackStatus = 502) {
  const status = Number(err?.statusCode) || fallbackStatus;
  res.status(status).json({ error: errorMessage(err) });
}

/** 容忍 store 同步/异步两种实现：`await Promise.resolve(x)` 对同步返回值无副作用 */
async function call(fn, ...args) {
  if (typeof fn !== 'function') return undefined;
  return await Promise.resolve(fn(...args));
}

/** 从 store 的返回值里取「新的 settings」（A4 约定返回 { record, settings }，也兼容只返回 settings） */
function settingsOf(result, fallback) {
  if (result && typeof result === 'object') {
    if (result.settings && typeof result.settings === 'object') return result.settings;
    if (Array.isArray(result.k8sClusters)) return result;
  }
  return fallback;
}

/**
 * record → K8sClusterView。
 * 首选 store 的 toView（脱敏/字段顺序由 A4 统一负责）；它缺失或抛错时用本地兜底，
 * 保证「列表能显示」—— 回退结果里绝不含 kubeconfig 明文。
 */
function clusterView(record) {
  if (!record || typeof record !== 'object') return record;
  try {
    const view = k8sStore.toView(record);
    if (view && typeof view === 'object') return view;
  } catch { /* 回退到本地构造 */ }

  const view = {
    id: String(record.id ?? ''),
    name: String(record.name ?? ''),
    context: String(record.context || record.contextName || ''),
    server: String(record.server || ''),
    enabled: record.enabled !== false,
    authType: record.authType === 'token' ? 'token' : 'cert',
    hasKubeconfig: typeof record.kubeconfig === 'string' && record.kubeconfig.trim() !== '',
  };
  if (record.updatedAt) view.updatedAt = String(record.updatedAt);
  return view;
}

/** 解析 kubeconfig；文本缺失或解析失败都折成 400（契约：解析失败 → 400） */
function parseStrict(text, context) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw badRequest('kubeconfig 不能为空');
  }
  try {
    const resolved = k8sKubeconfig.parseKubeconfig(text, context || undefined);
    if (!resolved || typeof resolved !== 'object') {
      throw new Error('kubeconfig 解析结果为空');
    }
    return resolved;
  } catch (err) {
    // client 侧的 401/403 已经带 statusCode 时不要被改写成 400；解析期不会有那种错误
    if (err?.statusCode === 400) throw err;
    throw badRequest(`kubeconfig 解析失败：${errorMessage(err)}`);
  }
}

/** 用已保存的配置建客户端；缺 kubeconfig / 建不出来都归到 400/502 */
function connectCluster(record) {
  const resolved = parseStrict(record?.kubeconfig, record?.context);
  let client;
  try {
    client = k8sClientModule.createK8sClient(resolved);
  } catch (err) {
    throw Object.assign(new Error(`创建 Kubernetes 客户端失败：${errorMessage(err)}`), { statusCode: 502 });
  }
  if (!client || typeof client.getJson !== 'function') {
    throw Object.assign(new Error('Kubernetes 客户端不可用'), { statusCode: 502 });
  }
  return { resolved, client };
}

/** list 型响应里取 items：结构不符时按空数组处理，不让上层拿到 undefined */
function itemsOf(data) {
  if (!data || typeof data !== 'object') return [];
  return Array.isArray(data.items) ? data.items : [];
}

/** normalize* 抛错时降级成空数组 + warning，避免单类资源把整个 overview 拖垮 */
function normalizeSafe(label, fn, warnings) {
  try {
    const out = fn();
    return Array.isArray(out) ? out : [];
  } catch (err) {
    warnings.push(`${label}解析失败：${errorMessage(err)}`);
    return [];
  }
}

/** summarize 缺失/抛错时的本地汇总（字段名与契约 summary 完全一致） */
function localSummary({ nodes = [], pods = [], workloads = [], events = [] } = {}) {
  const phase = (p) => String(p?.phase || '');
  return {
    nodes: nodes.length,
    nodesReady: nodes.filter((n) => n?.ready === true).length,
    pods: pods.length,
    podsRunning: pods.filter((p) => phase(p) === 'Running').length,
    podsUnhealthy: pods.filter((p) => phase(p) !== 'Running' || p?.oom === true || p?.crashLoop === true).length,
    workloads: workloads.length,
    workloadsUnready: workloads.filter((w) => Number(w?.ready) < Number(w?.desired)).length,
    warningEvents: events.filter((e) => String(e?.type || '').toLowerCase() === 'warning').length,
  };
}

/** 优先用 resources.summarize（A3 负责口径），不可用时回退本地实现 */
function computeSummary(parts) {
  try {
    const summary = k8sResources.summarize(parts);
    if (summary && typeof summary === 'object') return summary;
  } catch { /* 回退到本地汇总 */ }
  return localSummary(parts);
}

// ─── HAMi vGPU（契约见 /tmp/hami-contract.md）────────────────────────────
//
// 数据来源有三块，都在 k8s/hami.js 里解析：
//   节点  metadata.annotations 的 hami.io/node-nvidia-register（真机 243：物理卡清单 + 容量/型号）
//   节点  status.capacity|allocatable 的 nvidia.com/{gpu,gpumem,gpucores}（老集群 / register 坏掉时）
//   Pod   metadata.annotations 的 hami.io/vgpu-*（四段 / 三段 / 两段自适应）
//
// 这里的三个约定（前端的「无 HAMi 行为不变」全靠它们）：
//   1. **永远返回 gpu 段**：没有 HAMi 时是 hasHami:false + 空数组，前端据此不渲染卡片；
//   2. **解析层抛错只降级、不冒泡**：hami.js 与它并行开发（接入前调用即抛 not implemented），
//      真实集群也可能有坏注解 —— 这些都必须是「多一个空 gpu 段」，而不是 500；
//   3. **Pod 的 vgpu 字段按需挂**：只有真的读到分配时才给每个 Pod 加 `vgpu`，
//      否则响应与改动前逐字节一致（前端表格也就不出现那一列）。

/** 节点上写物理卡清单的注解（真机 243 的容量来源）；只有解析用，不回给前端。 */
const HAMI_REGISTER_ANNOTATION = 'hami.io/node-nvidia-register';

/** 数字兜底：NaN/Infinity/非法值 → 0（前端拿到的永远是数字，不会出现 null 运算） */
function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 字符串兜底：null/undefined → '' */
function asLabel(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** 空 gpu 段（没有 HAMi / 解析层不可用）。字段与契约里的 summarizeVgpu 返回完全一致。 */
function emptyGpuSegment(warnings = []) {
  return {
    hasHami: false,
    nodes: [],
    pods: [],
    totals: { gpuCount: 0, memMiB: 0, cores: 0, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 },
    warnings,
  };
}

/** 没有 vGPU 分配的 Pod 用它占位（hasVgpu:false），前端据此显示「—」 */
function emptyVgpu() {
  return { hasVgpu: false, devices: [], totalMemMiB: 0, totalCores: 0, nodeName: null };
}

/**
 * Pod 侧设备行收敛。`type`（真机四段注解里的型号）**只在解析层真的给了才写** ——
 * 旧格式没有型号，写个空串上去会让前端以为「型号读到了但是空的」。
 */
function normalizePodDevices(devices) {
  return (Array.isArray(devices) ? devices : [])
    .filter((device) => device && typeof device === 'object')
    .map((device) => {
      const row = {
        id: asLabel(device.id),
        memMiB: asCount(device.memMiB),
        cores: asCount(device.cores),
      };
      if (typeof device.type === 'string' && device.type !== '') row.type = device.type;
      return row;
    });
}

/**
 * 节点物理卡明细收敛（真机 `hami.io/node-nvidia-register`）。
 * 解析层没给 devices（老集群只有 nvidia.com/gpu）→ 返回 null，调用方就不写这个键，
 * 前端据此退回「按节点聚合」的旧展示。
 */
function normalizeNodeDevices(devices) {
  if (!Array.isArray(devices)) return null;
  return devices
    .filter((device) => device && typeof device === 'object')
    .map((device) => ({
      id: asLabel(device.id),
      type: asLabel(device.type),
      memMiB: asCount(device.memMiB),
      cores: asCount(device.cores),
      slots: asCount(device.slots),
      health: device.health !== false,
      allocatedMemMiB: asCount(device.allocatedMemMiB),
      allocatedCores: asCount(device.allocatedCores),
      podCount: asCount(device.podCount),
    }));
}

/** totals 收敛：`physicalCount` / `slots` 是真机才有的字段，没有就不写（前端退回「N 张卡」）。 */
function normalizeTotals(totals) {
  const bag = totals && typeof totals === 'object' ? totals : {};
  const row = {
    gpuCount: asCount(bag.gpuCount),
    memMiB: asCount(bag.memMiB),
    cores: asCount(bag.cores),
    allocatedMemMiB: asCount(bag.allocatedMemMiB),
    allocatedCores: asCount(bag.allocatedCores),
    podCount: asCount(bag.podCount),
  };
  if (Number.isFinite(bag.physicalCount)) row.physicalCount = asCount(bag.physicalCount);
  if (Number.isFinite(bag.slots)) row.slots = asCount(bag.slots);
  return row;
}

/**
 * 把 summarizeVgpu 的结果收敛成固定形状。
 *
 * 为什么在这里再补一遍默认值：解析层是并行开发的，字段哪天少一个（或返回 NaN），
 * 前端就会渲染出 `NaN GiB`；这一层把「数字一定有限、数组一定是数组」钉死，
 * 前端只负责排版。真机才有的字段（`slots` / `devices` / `physicalCount`）**有才写**，
 * 所以老集群的响应与改动前逐字节一致。
 */
function normalizeGpuSegment(summary) {
  const nodes = Array.isArray(summary?.nodes) ? summary.nodes : [];
  const pods = Array.isArray(summary?.pods) ? summary.pods : [];
  const totals = summary?.totals && typeof summary.totals === 'object' ? summary.totals : {};
  const warnings = Array.isArray(summary?.warnings) ? summary.warnings : [];

  return {
    hasHami: summary?.hasHami === true,
    nodes: nodes
      .filter((node) => node && typeof node === 'object')
      .map((node) => {
        const row = {
          name: asLabel(node.name),
          count: asCount(node.count),
          memMiB: asCount(node.memMiB),
          cores: asCount(node.cores),
          allocatedMemMiB: asCount(node.allocatedMemMiB),
          allocatedCores: asCount(node.allocatedCores),
          podCount: asCount(node.podCount),
        };
        // 真机字段：解析层给了才写（旧版本一个都不写，响应的键集合与改动前一致）
        if (Number.isFinite(node.slots)) row.slots = asCount(node.slots);
        const devices = normalizeNodeDevices(node.devices);
        if (devices !== null) row.devices = devices;
        return row;
      }),
    pods: pods
      .filter((pod) => pod && typeof pod === 'object')
      .map((pod) => ({
        namespace: asLabel(pod.namespace),
        name: asLabel(pod.name),
        nodeName: pod.nodeName === null || pod.nodeName === undefined ? null : asLabel(pod.nodeName),
        devices: normalizePodDevices(pod.devices),
        totalMemMiB: asCount(pod.totalMemMiB),
        totalCores: asCount(pod.totalCores),
        phase: asLabel(pod.phase),
      })),
    totals: normalizeTotals(totals),
    // 契约：最多 5 条（异常注解可能几百条，全带上会把响应撑爆）
    warnings: warnings.slice(0, 5).map((item) => asLabel(item)),
  };
}

/**
 * 汇总 GPU 段。summarizeVgpu 缺失/抛错（占位实现）→ 空段 + 一条 warning，
 * 让「解析层没接上」在页面上可见，但绝不拖垮整条 overview。
 */
function summarizeVgpuSafe(parts) {
  try {
    const summary = k8sHami.summarizeVgpu(parts);
    if (summary && typeof summary === 'object') return normalizeGpuSegment(summary);
    return emptyGpuSegment();
  } catch (err) {
    return emptyGpuSegment([`vGPU 数据解析失败：${errorMessage(err)}`]);
  }
}

/** 单个 Pod 的 vGPU 分配；没有分配 / 解析层不可用 → null。 */
function readPodVgpuSafe(pod) {
  try {
    const vgpu = k8sHami.readPodVgpu(pod);
    if (!vgpu || typeof vgpu !== 'object' || vgpu.hasVgpu !== true) return null;
    return {
      hasVgpu: true,
      devices: normalizePodDevices(vgpu.devices),
      totalMemMiB: asCount(vgpu.totalMemMiB),
      totalCores: asCount(vgpu.totalCores),
      nodeName: vgpu.nodeName === null || vgpu.nodeName === undefined ? null : asLabel(vgpu.nodeName),
    };
  } catch {
    // 解析层尚未接入时抛 not implemented，真实集群的异常注解也可能让它抛错。
    // 单个 Pod 解析不了就当它没有 vGPU —— 空警告已经由 summarizeVgpuSafe 那条兜住了。
    return null;
  }
}

/**
 * 给 Pod 列表挂 `vgpu` 字段。
 *
 * @param {object[]} pods     要返回给前端的 Pod（归一化形状，不含注解）
 * @param {object[]} parsePods 解析用的副本（可以带 annotations），与 pods 同序
 *
 * 只有至少一个 Pod 真的读到分配时才挂字段：否则返回原数组，
 * 「没有 HAMi 的集群」响应与改动前完全一致（前端也就不会出现空的 vGPU 列）。
 */
function withVgpuField(pods, parsePods = pods) {
  const parsed = pods.map((pod, index) => readPodVgpuSafe(parsePods[index] ?? pod));
  if (!parsed.some((vgpu) => vgpu !== null)) return pods;
  return pods.map((pod, index) => ({ ...pod, vgpu: parsed[index] ?? emptyVgpu() }));
}

/**
 * 从原始 items 补节点上的 GPU 资源映射。
 *
 * readNodeGpu 读的是 `node.capacity` / `node.allocatable`。归一化层（resources.js，H1 负责）
 * 目前只保留了 cpu/memory/pods 三个字符串字段，所以这里从原始 `/api/v1/nodes` 响应里
 * 按名字兜一层；已经带了的（H1 补上之后）不覆盖。返回的是**副本**，
 * 原始映射只用于解析，不随 overview 回给前端。
 */
function gpuNodesOf(nodes, rawItems) {
  const byName = new Map();
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    const name = asLabel(item?.metadata?.name);
    if (!name) continue;
    const status = item?.status;
    const annotations = item?.metadata?.annotations;
    // 真机（243）的容量与物理卡清单只在注解 `hami.io/node-nvidia-register` 里，
    // 节点上没有 nvidia.com/gpumem|gpucores —— 不给注释就没法解析，所以两者有其一就收
    const hasRegister = Boolean(
      annotations && typeof annotations === 'object' && annotations[HAMI_REGISTER_ANNOTATION],
    );
    if (!hasRegister && (!status || (!status.capacity && !status.allocatable))) continue;
    byName.set(name, {
      capacity: status?.capacity ?? null,
      allocatable: status?.allocatable ?? null,
      annotations: annotations ?? null,
    });
  }
  if (byName.size === 0) return nodes;
  return nodes.map((node) => {
    const extra = byName.get(asLabel(node?.name));
    if (!extra) return node;
    return {
      ...node,
      capacity: node?.capacity ?? extra.capacity ?? undefined,
      allocatable: node?.allocatable ?? extra.allocatable ?? undefined,
      // 只补解析用的注解（归一化层目前不保留 metadata.annotations）
      annotations: node?.annotations ?? extra.annotations ?? undefined,
    };
  });
}

/**
 * 从原始 items 补 Pod 的 annotations（readPodVgpu 的输入）。
 * 与 gpuNodesOf 同理：归一化层没保留 annotations 时按 `namespace/name` 兜一层。
 */
function gpuPodsOf(pods, rawItems) {
  const byKey = new Map();
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    const metadata = item?.metadata;
    const name = asLabel(metadata?.name);
    if (!name) continue;
    if (!metadata?.annotations || typeof metadata.annotations !== 'object') continue;
    byKey.set(`${asLabel(metadata.namespace)}/${name}`, metadata.annotations);
  }
  if (byKey.size === 0) return pods;
  return pods.map((pod) => {
    const annotations = byKey.get(`${asLabel(pod?.namespace)}/${asLabel(pod?.name)}`);
    if (!annotations || pod?.annotations) return pod;
    return { ...pod, annotations };
  });
}

/**
 * 演示 fixture 里带着解析用的 HAMi 字段（`node.capacity/allocatable`、`pod.annotations`），
 * 真实响应里没有这两块（归一化形状），所以回给前端前去掉 —— 演示与真实同形，
 * 前端不可能在演示模式下走另一条分支。
 */
function stripHamiInputs(nodes) {  return nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    const { capacity: _capacity, allocatable: _allocatable, annotations: _annotations, ...rest } = node;
    return rest;
  });
}

function stripPodAnnotations(pods) {
  return pods.map((pod) => {
    if (!pod || typeof pod !== 'object') return pod;
    const { annotations: _annotations, ...rest } = pod;
    return rest;
  });
}

/** tail 参数：非法/缺省 → 200，越界夹到 1..2000（前端传 0 或 99999 都不该报错） */
function clampTail(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return LOG_TAIL_DEFAULT;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return LOG_TAIL_DEFAULT;
  return Math.min(LOG_TAIL_MAX, Math.max(LOG_TAIL_MIN, n));
}

/** 查询参数取单个字符串（express 4 里同名参数重复会变数组） */
function queryString(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

// ─── 工厂 ─────────────────────────────────────────────────────────────

export default function createK8sRouter({ ensureSettings, saveSettings } = {}) {
  if (typeof ensureSettings !== 'function') {
    throw new TypeError('createK8sRouter 需要注入 ensureSettings');
  }
  const router = express.Router();

  /**
   * :id 校验放在 router.param 里，只写一次。
   *
   * 与 routes/docker.js 的 sourceId 白名单同理：7 条路由都要「先找记录再干活」，
   * 逐条重复 `find()` 迟早会漏掉一条，把 undefined 带进下游（kubeconfig 读不到、
   * client 拿空配置去连默认地址）。这里一次性 404，并把记录挂到 req.k8sCluster。
   */
  router.param('id', (req, res, next, id) => {
    const clusterId = String(id ?? '').trim();
    if (!clusterId) {
      res.status(404).json({ error: '缺少集群 id' });
      return;
    }
    // 演示模式：settings 里没有真实集群，白名单改为校验演示集群 ——
    // 否则前端拿着 /api/k8s/clusters 返回的演示 id 请求 overview 会先被这里 404。
    if (isDemoMode()) {
      const hit = demoClusters().find((c) => String(c?.id ?? '') === clusterId);
      if (!hit) {
        res.status(404).json({ demo: true, error: `Kubernetes 集群不存在: ${clusterId}` });
        return;
      }
      req.k8sCluster = hit;
      next();
      return;
    }
    let record = null;
    try {
      record = k8sStore.getClusterRecord(ensureSettings(), clusterId);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
      return;
    }
    if (!record) {
      res.status(404).json({ error: `Kubernetes 集群不存在: ${clusterId}` });
      return;
    }
    req.k8sCluster = record;
    next();
  });

  // ── 集群配置 CRUD ──────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters`, async (req, res) => {
    // 演示模式：只替换响应，绝不把假集群写进 settings
    if (isDemoMode()) return res.json(demoJson({ clusters: demoClusters() }));
    try {
      // store.listClusters() 已经返回 K8sClusterView（见 store.js），这里不能再套 toView，
      // 否则对 view 再解析一次会把 server / authType / hasKubeconfig 全丢掉。
      const views = await call(k8sStore.listClusters, ensureSettings());
      res.json({ clusters: Array.isArray(views) ? views : [] });
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  router.post(`${PREFIX}/clusters`, async (req, res) => {
    // 演示模式：写操作（落 settings）一律禁用
    if (isDemoMode()) return res.status(409).json(DEMO_DISABLED);
    try {
      const body = req.body || {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) throw badRequest('集群名称不能为空');

      const kubeconfig = typeof body.kubeconfig === 'string' ? body.kubeconfig.trim() : '';
      if (!kubeconfig) throw badRequest('kubeconfig 不能为空');

      const context = queryString(body.context);
      // 先解析一遍再落库：解析失败必须止步于 400，不能把一个连不上的集群存进 settings
      const resolved = parseStrict(kubeconfig, context);

      const input = {
        name,
        kubeconfig,
        context: context || String(resolved.contextName || ''),
        enabled: body.enabled !== false && body.enabled !== 'false',
        // 这两个字段给 store 落库用（toView 的 server/authType 来源）；A4 若不认可忽略
        server: String(resolved.server || ''),
        authType: resolved.authType === 'token' ? 'token' : 'cert',
      };
      if (typeof body.id === 'string' && body.id.trim() !== '') input.id = body.id.trim();

      const result = await call(k8sStore.upsertCluster, ensureSettings(), input);
      const nextSettings = settingsOf(result, ensureSettings());
      const record = result && typeof result === 'object' && result.record ? result.record : null;

      if (typeof saveSettings === 'function') saveSettings(nextSettings);

      // 契约里创建返回「view」本身（不包一层），前端直接拿去替换列表项
      res.json(clusterView(record || { ...input, id: input.id || '' }));
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  router.put(`${PREFIX}/clusters/:id`, async (req, res) => {
    if (isDemoMode()) return res.status(409).json(DEMO_DISABLED);
    try {
      const existing = req.k8sCluster;
      const body = req.body || {};

      const name = body.name === undefined
        ? String(existing.name || '')
        : (typeof body.name === 'string' ? body.name.trim() : '');
      if (!name) throw badRequest('集群名称不能为空');

      // kubeconfig 省略（或空串）时沿用旧值 —— 前端编辑「改个名字」不必回传敏感文本
      const provided = typeof body.kubeconfig === 'string' ? body.kubeconfig.trim() : '';
      const kubeconfig = provided || String(existing.kubeconfig || '');
      if (!kubeconfig) throw badRequest('kubeconfig 不能为空');

      const context = body.context === undefined
        ? String(existing.context || '')
        : queryString(body.context);

      // 只有真的换了 kubeconfig 才重新解析；只改名时沿用旧记录的 server/authType
      const resolved = provided ? parseStrict(kubeconfig, context) : null;

      const input = {
        id: existing.id,
        name,
        kubeconfig,
        context: context || String(resolved?.contextName || existing.context || ''),
        enabled: body.enabled === undefined ? existing.enabled !== false : Boolean(body.enabled),
        server: String(resolved?.server || existing.server || ''),
        authType: (resolved?.authType || existing.authType) === 'token' ? 'token' : 'cert',
      };

      const result = await call(k8sStore.upsertCluster, ensureSettings(), input);
      const nextSettings = settingsOf(result, ensureSettings());
      const record = result && typeof result === 'object' && result.record ? result.record : null;

      if (typeof saveSettings === 'function') saveSettings(nextSettings);

      res.json(clusterView(record || { ...existing, ...input }));
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  router.delete(`${PREFIX}/clusters/:id`, async (req, res) => {
    if (isDemoMode()) return res.status(409).json(DEMO_DISABLED);
    try {
      const existing = req.k8sCluster;
      const result = await call(k8sStore.deleteCluster, ensureSettings(), existing.id);
      const nextSettings = settingsOf(result, ensureSettings());
      if (typeof saveSettings === 'function') saveSettings(nextSettings);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  // ── 连通性测试 ────────────────────────────────────────────────────

  router.post(`${PREFIX}/clusters/:id/test`, async (req, res) => {
    // 演示模式：连通性测试会真连 kube-apiserver，禁用
    if (isDemoMode()) return res.status(409).json(DEMO_DISABLED);
    try {
      const { client } = connectCluster(req.k8sCluster);

        // apiServerVersion() 返回的是对象（{ version, gitVersion, platform }），
        // 直接 String() 会得到 "[object Object]" —— 真实集群上实测踩到过。
        let version = '';
        if (typeof client.apiServerVersion === 'function') {
          const info = await Promise.resolve(client.apiServerVersion());
          // 兼容两种返回：字符串（部分实现直接给版本号）或对象（{ version, gitVersion }）
          version = typeof info === 'string'
            ? info
            : String((info && (info.gitVersion || info.version)) || '');
        }
      // 版本能读到不代表有节点读权限，再打一次 nodes 才算「真连上了且权限对」
      const nodeList = await Promise.resolve(client.getJson('/api/v1/nodes'));
      const nodes = itemsOf(nodeList);

      res.json({ ok: true, version: String(version ?? ''), nodes: nodes.length });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  // ── 概览 ──────────────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters/:id/overview`, async (req, res) => {
    // 演示模式：概览直接给 fixture（形状与真实响应一致：nodes/pods/workloads/events/summary），
    // GPU 段与 Pod 的 vgpu 字段按 fixture 里的 HAMi 注解/资源现算 —— 与真实路径同一套代码
    if (isDemoMode()) {
      const overview = demoValue('demoK8sOverview', req.params.id) || {};
      const demoNodes = Array.isArray(overview.nodes) ? overview.nodes : [];
      const demoPods = Array.isArray(overview.pods) ? overview.pods : [];
      const gpu = summarizeVgpuSafe({ nodes: demoNodes, pods: demoPods });
      return res.json(demoJson({
        ...overview,
        nodes: stripHamiInputs(demoNodes),
        pods: withVgpuField(stripPodAnnotations(demoPods), demoPods),
        gpu,
      }));
    }
    try {
      const { client, resolved } = connectCluster(req.k8sCluster);
      const warnings = [];

      /**
       * 六类资源 + 版本号并发拉取，用 allSettled 而不是 all：
       * 只读监控里「Deployment 列表被 RBAC 挡住」不该让整页白屏 —— 缺的那类给空数组，
       * 原因写进 warnings 让前端提示「该类资源不可用」，其余照常渲染。
       */
      const tasks = OVERVIEW_ENDPOINTS.map((endpoint) => Promise.resolve().then(() => client.getJson(endpoint.path)));
      tasks.push(Promise.resolve().then(() => (
        typeof client.apiServerVersion === 'function' ? client.apiServerVersion() : ''
      )));

      const settled = await Promise.allSettled(tasks);

      const raw = {};
      const failures = [];
      settled.slice(0, OVERVIEW_ENDPOINTS.length).forEach((result, index) => {
        const endpoint = OVERVIEW_ENDPOINTS[index];
        if (result.status === 'fulfilled') {
          raw[endpoint.key] = result.value;
        } else {
          raw[endpoint.key] = null;
          failures.push({ endpoint, reason: result.reason });
          warnings.push(`${endpoint.label}查询失败：${errorMessage(result.reason)}`);
        }
      });

      /**
       * 「部分失败」与「整体连不上」必须区分开：
       * 六类资源全挂在同一件事上（apiserver 不可达 / 证书不被接受 / token 失效），
       * 这时返回一份全空但 200 的概览，值班的人只会看到「0 节点 0 Pod 全部正常」，
       * 比报错更危险。所以只有**至少一类资源拿到数据**才走降级 200，全灭一律 502。
       */
      if (failures.length === OVERVIEW_ENDPOINTS.length) {
        const first = failures[0];
        throw Object.assign(
          new Error(`无法连接 Kubernetes API（${errorMessage(first.reason)}）`),
          { statusCode: 502 },
        );
      }

      const versionResult = settled[OVERVIEW_ENDPOINTS.length];
      let version = '';
        if (versionResult && versionResult.status === 'fulfilled') {
          // 同 /test：apiServerVersion() 可能是对象 { version, gitVersion } 或字符串
          const info = versionResult.value;
          version = typeof info === 'string'
            ? info
            : String((info && (info.gitVersion || info.version)) || '');
        }

      const nodes = normalizeSafe('节点', () => k8sResources.normalizeNodes(itemsOf(raw.nodes)), warnings);
      const pods = normalizeSafe('Pod', () => k8sResources.normalizePods(itemsOf(raw.pods)), warnings);
      const gpuNodes = gpuNodesOf(nodes, itemsOf(raw.nodes));
      const gpuPods = gpuPodsOf(pods, itemsOf(raw.pods));
      const gpu = summarizeVgpuSafe({ nodes: gpuNodes, pods: gpuPods });
      const workloads = [
        ...normalizeSafe('Deployment', () => k8sResources.normalizeWorkloads('Deployment', itemsOf(raw.deployments)), warnings),
        ...normalizeSafe('StatefulSet', () => k8sResources.normalizeWorkloads('StatefulSet', itemsOf(raw.statefulsets)), warnings),
        ...normalizeSafe('DaemonSet', () => k8sResources.normalizeWorkloads('DaemonSet', itemsOf(raw.daemonsets)), warnings),
      ];
      const allEvents = normalizeSafe('事件', () => k8sResources.normalizeEvents(itemsOf(raw.events)), warnings);
      // 契约：overview 只回 Warning 事件（与前端「Warning 事件」卡片同口径）。
      // Normal 事件（Scheduled/Pulled/Created/ApplyingManifest…）量大且没排障价值，
      // 实测本地 k3s 一次 overview 会带回 60+ 条，payload 从几 KB 涨到几十 KB。
      const events = allEvents.filter((e) => String(e?.type || '').toLowerCase() === 'warning');

      const parts = { nodes, pods, workloads, events };
      res.json({
        cluster: {
          version,
          server: String(resolved?.server || req.k8sCluster.server || ''),
          context: String(resolved?.contextName || req.k8sCluster.context || ''),
        },
        nodes,
        // 没有 HAMi 的集群这里与改动前逐字节一致（withVgpuField 读不到分配就返回原数组），
        // 有 HAMi 时每个 Pod 多一个 `vgpu` 字段（前端 Pod 表的 vGPU 列用它）
        pods: withVgpuField(pods, gpuPods),
        workloads,
        events,
        summary: computeSummary(parts),
        // HAMi vGPU 汇总：没有 HAMi 时是 hasHami:false + 空数据（前端不渲染该卡片）
        gpu,
        // 契约外的附加字段：某类资源拉取/解析失败的原因，前端可忽略
        warnings,
      });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  // ── Pod 列表 ──────────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters/:id/pods`, async (req, res) => {
    // 演示模式：Pod 列表从演示概览里取（同一份数据，避免两处不一致）
    if (isDemoMode()) {
      const overview = demoValue('demoK8sOverview', req.params.id) || {};
      const namespace = queryString(req.query.namespace);
      const all = Array.isArray(overview.pods) ? overview.pods : [];
      const pods = all.filter((p) => !namespace || String(p?.namespace ?? '') === namespace);
      // 解析用全量副本（注解在 fixture 里），返回给前端的只有归一化形状 + vgpu
      const podsWithVgpu = withVgpuField(stripPodAnnotations(pods), pods);
      return res.json(demoJson({ pods: podsWithVgpu }));
    }
    try {
      const { client } = connectCluster(req.k8sCluster);
      const namespace = queryString(req.query.namespace);
      // 指定 namespace 就走命名空间路径（RBAC 只给了单 namespace 权限时同样可用）
      const path = namespace
        ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
        : '/api/v1/pods';

      const data = await Promise.resolve(client.getJson(path));
      const rawItems = itemsOf(data);
      const pods = normalizeSafe('Pod', () => k8sResources.normalizePods(rawItems), []);
      // 每个 Pod 带 vgpu（HAMi 注解可能只在原始对象里，gpuPodsOf 兜一层）；
      // 没有 HAMi 时读不到任何分配，响应与改动前逐字节一致
      const gpuPods = gpuPodsOf(pods, rawItems);
      res.json({ pods: withVgpuField(pods, gpuPods) });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  // ── 事件列表 ──────────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters/:id/events`, async (req, res) => {
    // 演示模式：事件同样取自演示概览
    if (isDemoMode()) {
      const overview = demoValue('demoK8sOverview', req.params.id) || {};
      const namespace = queryString(req.query.namespace);
      const type = queryString(req.query.type).toLowerCase();
      const events = (Array.isArray(overview.events) ? overview.events : [])
        .filter((e) => !namespace || String(e?.namespace ?? '') === namespace)
        .filter((e) => !type || String(e?.type ?? '').toLowerCase() === type);
      return res.json(demoJson({ events }));
    }
    try {
      const { client } = connectCluster(req.k8sCluster);
      const namespace = queryString(req.query.namespace);
      const type = queryString(req.query.type);

      // 事件始终按集群整体拉取后再筛：events 的 fieldSelector 在各版本/各发行版行为不一致
      // （k3s 与上游对 involvedObject 的支持有差异），本地过滤才是稳定的口径。
      const data = await Promise.resolve(client.getJson('/api/v1/events'));
      let events = normalizeSafe('事件', () => k8sResources.normalizeEvents(itemsOf(data)), []);

      if (namespace) {
        events = events.filter((event) => String(event?.namespace ?? '') === namespace);
      }
      if (type) {
        const wanted = type.toLowerCase();
        events = events.filter((event) => String(event?.type ?? '').toLowerCase() === wanted);
      }

      res.json({ events });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  // ── Pod 日志 ──────────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters/:id/pods/:namespace/:pod/logs`, async (req, res) => {
    try {
      // 演示模式：Pod 日志来自 fixture（不连 apiserver，也不读 kubeconfig）
      if (isDemoMode()) {
        const namespace = String(req.params.namespace ?? '').trim();
        const pod = String(req.params.pod ?? '').trim();
        if (!namespace || !pod) throw badRequest('namespace 与 pod 不能为空');
        const data = demoValue('demoK8sPodsLogs', { ns: namespace, pod });
        const logs = typeof data === 'string' ? data : (data?.logs ?? '');
        return res.json(demoJson({ logs }));
      }
      const { client } = connectCluster(req.k8sCluster);
      const namespace = String(req.params.namespace ?? '').trim();
      const pod = String(req.params.pod ?? '').trim();
      if (!namespace || !pod) throw badRequest('namespace 与 pod 不能为空');

      const tail = clampTail(req.query.tail);
      const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log`;
      if (typeof client.getText !== 'function') {
        throw Object.assign(new Error('Kubernetes 客户端不支持读取日志'), { statusCode: 502 });
      }

      const text = await Promise.resolve(client.getText(path, { query: { tailLines: tail } }));
      res.json({ logs: typeof text === 'string' ? text : String(text ?? '') });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  return router;
}
