/**
 * routes/k8s-usage.js —— HAMi vGPU **实测**使用率端点（A2，契约见 /tmp/hami-k8s-contract.md）
 *
 *   GET /api/k8s/clusters/:id/usage
 *   → { available, scrapedAt, nodes: [{ name, devices: [{ uuid, type, allocMemMiB,
 *        allocCores, usedMemMiB, utilPercent, measured, pods: [{ ns, name, memMiB, cores }] }] }],
 *       reason? }
 *
 * 挂载方式（A10 负责）：路径写全（`/api/k8s/...`），不要再套 `/api` 前缀 ——
 *   app.use(createK8sUsageRouter({ ensureSettings }));
 *
 * 数据来源分三块，缺一不可但**降级策略不同**：
 *   1. `store.getClusterRecord`  → settings.k8sClusters 里按 id 找集群（找不到 404）
 *   2. `client.getJson`          → /api/v1/nodes + /api/v1/pods（连不上 502）
 *      `resources.normalize*`    → 原始 items 压成扁平形状
 *      `hami.summarizeVgpu`      → 每节点每物理卡的**分配**（allocMemMiB / allocCores）
 *   3. `hami-metrics.fetchSchedulerMetrics` → 每张卡的**实测**（util / 显存占用）
 *
 * 关键口径（H2 / A5 面板直接依赖，改动前先读这三条）：
 *
 * - **分配与实测各自独立**：实测不可用（A1 模块缺失 / Prometheus 打不通 / 没装 HAMi
 *   指标插件）时返回 `available:false` + `reason`，但 `nodes[].devices[]` 里的
 *   `allocMemMiB` / `allocCores` / `pods` **照常返回** —— 面板要能显示「谁占了卡」，
 *   只是不显示实测曲线。整体 200，绝不为「指标拿不到」返回 5xx。
 * - **utilPercent = 该设备上所有容器的 utilization 之和**，clamp 到 0..100。
 *   量纲：契约里的 `containerUtil` 对应 `hami_container_device_utilization_ratio`，是
 *   **0..1 的比例**（A1 的 `extractHamiDevices` 就是这么给的，同一条记录还带 `utilPercent = ratio × 100`）。
 *   所以取值顺序是「有 `utilPercent` 就用它，否则 `containerUtil × 100`」——
 *   直接拿 ratio 当百分比会让 85% 的卡显示成 0.85%，这是最容易被忽略也最容易被用户当成 bug 的量纲错。
 * - **`usedMemMiB` 按同一设备取最大值**：契约里 `memUsedBytes` 是**设备级**指标。
 *   若上游某天改成按容器给值（同一 UUID 多条），取最大值只会低估、不会虚报两倍；
 *   而 util 是「多容器求和」，两者口径不同是刻意的。
 * - **A1 的主键是 node + deviceUUID**（同一 UUID 出现在两台节点上不合并），本层照抄这个主键，
 *   查不到再退回裸 UUID —— 免得把两台机器上同名的卡合成一条、显存翻倍。
 * - **没实测 ≠ 没有分配**：设备有分配但指标里没有该 UUID 时，`measured:false`、
 *   `usedMemMiB:0`、`utilPercent:0`，分配字段保持真实值。反过来，指标里有、register
 *   清单里没有的 UUID（换过卡 / 禁用了）**不出现在** nodes[] 里 —— 指标本身不带节点归属，
 *   凭空挂到某台节点上比丢掉更危险。
 *
 * 只读约束：本文件没有任何写操作、不写 cookie、不碰 session、不改 settings。
 * 鉴权由 index.js 的全局 authMiddleware 覆盖 /api，这里不重复处理。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
// 命名空间导入的理由同 routes/k8s.js：这些模块由多个 agent 并行实现，
// 具名导入一旦某个导出缺失会在 ESM 链接阶段直接抛 SyntaxError，把整条 /api/k8s 带崩。
import * as k8sStore from '../k8s/store.js';
import * as k8sKubeconfig from '../k8s/kubeconfig.js';
import * as k8sClientModule from '../k8s/client.js';
import * as k8sResources from '../k8s/resources.js';
import * as k8sHami from '../k8s/hami.js';

// GPU 实测数据（nvidia-smi）：HAMi v2 的 metrics 只有「分配」，没有容器级 util，
// 所以「实测」这一半必须从 nvidia-smi 拿（详见 server/k8s/gpu-usage.js 文件头）。
let gpuUsageModule = null;
try {
  gpuUsageModule = await import('../k8s/gpu-usage.js');
} catch (err) {
  console.warn(`[K8s] GPU 实测模块未加载（/usage 将只返回分配数据）：${errorMessage(err)}`);
}
import { isDemoMode } from '../demo/mode.js';

/** 路由前缀：index.js 直接 `app.use(createK8sUsageRouter(...))` 挂在根上，所以每条路径写全 */
const PREFIX = '/api/k8s';

/** 节点上写物理卡清单的注解（HAMi 真机容量的唯一来源），归一化层不透传，需要从原始 items 补 */
const REGISTER_ANNOTATION = 'hami.io/node-nvidia-register';

/** 字节 → MiB */
const BYTES_PER_MIB = 1024 * 1024;

/** 演示模式固定文案（契约字面量，不要改写） */
const DEMO_REASON = '演示模式未接入 HAMi 指标';

/** 演示 fixtures 的惰性引用（避免每次请求都 import） */
let demoFixtures = null;

/** 实测不可用但上游没给原因时的兜底文案 */
const UNAVAILABLE_REASON = 'HAMi 指标不可用';

/** util 上限：百分比口径 */
const MAX_PERCENT = 100;

// ─── 小工具 ───────────────────────────────────────────────────────────

/** 字符串兜底：null/undefined → ''，其余转字符串（k8s 的注解值可能是 number） */
function asLabel(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** 非负有限数字兜底：NaN/Infinity/负数/非法值 → 0（前端拿到的永远是数字，不会出现 null 运算） */
function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** util 百分比 clamp 到 0..100，保留两位小数（0.30000000000000004 这类浮点噪声不该上前端） */
function clampPercent(value) {
  return Number(Math.min(MAX_PERCENT, Math.max(0, asCount(value))).toFixed(2));
}

/** 普通对象判定（排除 null / 数组 / 原始值） */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 带 HTTP 状态码的错误 */
function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/** 统一错误出口：`err.statusCode` 优先，否则用兜底（默认 502 = 上游不可达） */
function sendError(res, err, fallbackStatus = 502) {
  const status = Number(err?.statusCode) || fallbackStatus;
  res.status(status).json({ error: errorMessage(err) });
}

/** list 型响应里取 items：结构不符按空数组处理，不让上层拿到 undefined */
function itemsOf(data) {
  if (!isPlainObject(data)) return [];
  return Array.isArray(data.items) ? data.items : [];
}

/**
 * kubeconfig → 客户端。解析失败 400（配置问题），建不出客户端 502（上游问题）。
 * 与 routes/k8s.js 的 connectCluster 同口径，错误文案也都是中文。
 */
function connectCluster(record) {
  const text = typeof record?.kubeconfig === 'string' ? record.kubeconfig : '';
  if (text.trim() === '') throw httpError('kubeconfig 不能为空', 400);

  let resolved;
  try {
    resolved = k8sKubeconfig.parseKubeconfig(text, record?.context || undefined);
    if (!isPlainObject(resolved)) throw new Error('kubeconfig 解析结果为空');
  } catch (err) {
    throw httpError(`kubeconfig 解析失败：${errorMessage(err)}`, 400);
  }

  let client;
  try {
    client = k8sClientModule.createK8sClient(resolved);
  } catch (err) {
    throw httpError(`创建 Kubernetes 客户端失败：${errorMessage(err)}`, 502);
  }
  if (!client || typeof client.getJson !== 'function') {
    throw httpError('Kubernetes 客户端不可用（缺少 getJson）', 502);
  }
  return { resolved, client };
}

/**
 * record → 交给指标层的 cluster 摘要。
 * **只给脱敏视图**：kubeconfig 明文（含 token / 客户端证书）不进指标模块，
 * 那边出任何日志/异常都不会把凭证明文带出来。
 *
 * 例外是「指标端口」：A1 的 `fetchSchedulerMetrics` 会读 `cluster.metricsPort` /
 * `cluster.hamiMetricsPort` 覆盖默认的 31993，而 `toView` 只输出固定字段会把它吃掉 ——
 * 这里显式补回（纯数字端口，不含任何敏感信息）。
 */
function clusterSummary(record) {
  let summary = {
    id: asLabel(record?.id),
    name: asLabel(record?.name),
    context: asLabel(record?.context),
    server: asLabel(record?.server),
    enabled: record?.enabled !== false,
  };
  try {
    const view = k8sStore.toView(record);
    if (isPlainObject(view)) summary = view;
  } catch { /* 回退到上面本地构造 */ }

  for (const key of ['metricsPort', 'hamiMetricsPort']) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') summary[key] = value;
  }
  return summary;
}

/** normalize* 抛错时降级成空数组，不让单类资源把整个端点拖成 500 */
function normalizeSafe(label, fn) {
  try {
    const out = fn();
    return Array.isArray(out) ? out : [];
  } catch (err) {
    console.warn(`[k8s-usage] ${label}归一化失败:`, errorMessage(err));
    return [];
  }
}

/**
 * 从原始 `/api/v1/nodes` items 补节点上的 HAMi 解析输入。
 *
 * `readNodeGpu` 读的是 `node.capacity|allocatable|annotations`，而 `normalizeNodes`
 * 只保留 cpu/memory/pods 三个固定列 + allocatable —— 真机（243）的物理卡清单与容量
 * **只在注解** `hami.io/node-nvidia-register` 里，不补这一层就永远解析不到设备。
 * 返回新数组（不改入参）；归一化层将来若带上了，也不覆盖。
 */
function withHamiNodeInputs(nodes, rawItems) {
  const byName = new Map();
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    const name = asLabel(item?.metadata?.name);
    if (!name) continue;
    const annotations = item?.metadata?.annotations;
    const status = item?.status;
    const hasRegister = isPlainObject(annotations) && asLabel(annotations[REGISTER_ANNOTATION]) !== '';
    if (!hasRegister && !isPlainObject(status)) continue;
    byName.set(name, {
      capacity: isPlainObject(status?.capacity) ? status.capacity : null,
      allocatable: isPlainObject(status?.allocatable) ? status.allocatable : null,
      annotations: isPlainObject(annotations) ? annotations : null,
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
      annotations: node?.annotations ?? extra.annotations ?? undefined,
    };
  });
}

/** 从原始 items 补 Pod 的 annotations（`normalizePods` 已经透了，这里只兜一层缺字段的实现） */
function withHamiPodInputs(pods, rawItems) {
  const byKey = new Map();
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    const metadata = item?.metadata;
    const name = asLabel(metadata?.name);
    if (!name) continue;
    if (!isPlainObject(metadata?.annotations)) continue;
    byKey.set(`${asLabel(metadata?.namespace)}/${name}`, metadata.annotations);
  }
  if (byKey.size === 0) return pods;

  return pods.map((pod) => {
    if (!pod || isPlainObject(pod.annotations)) return pod;
    const annotations = byKey.get(`${asLabel(pod?.namespace)}/${asLabel(pod?.name)}`);
    return annotations ? { ...pod, annotations } : pod;
  });
}

// ─── 指标层（A1：server/k8s/hami-metrics.js，并行实现）──────────────────
//
// 为什么用**动态 import** 而不是静态 import：A1 的文件此刻可能还没落盘。
// 静态 import 一个不存在的模块会在 ESM 链接阶段直接抛错，把本路由连带整个 /api 打挂；
// 动态 import + try/catch 让它「暂时不可用」，等 A1 落地后同一个进程无需改动即可生效。
// 导入失败**不缓存**失败结果（缓存成功结果），A1 文件出现后下一次请求就能读到。

let metricsModulePromise = null;

/** 加载指标模块；失败时抛出（调用方折成 available:false + reason） */
function loadMetricsModule() {
  if (!metricsModulePromise) {
    metricsModulePromise = import('../k8s/hami-metrics.js').catch((err) => {
      metricsModulePromise = null;
      throw err;
    });
  }
  return metricsModulePromise;
}

/**
 * 有限数字或 null：指标层的「未知」是 null（不是 0），必须原样保留 ——
 * 把 null 折成 0 会让「没采到」显示成「利用率为 0%」，运维就会以为卡闲着。
 */
function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/** 单条指标记录的利用率百分比：优先 `utilPercent`（A1 已换算），否则 `containerUtil`（0..1 比例）× 100 */
function percentOf(device) {
  const explicit = toFiniteOrNull(device.utilPercent);
  if (explicit !== null) return explicit;
  const ratio = toFiniteOrNull(device.containerUtil);
  return ratio === null ? null : ratio * 100;
}

/**
 * 指标层结果的形状收敛。
 * `available` 只认严格的 `true`；`devices` 不是数组就按空数组（= 一张卡都没实测到），
 * 单条记录的坏字段（UUID 空、值非数字）直接跳过，不让一条脏数据毁掉整批。
 * `utilPercent` / `memUsedBytes` 双 null 的记录（设备在位但没有任何样本）**整条丢弃**，
 * 落到下游就是 `measured:false`。
 */
function normalizeMetrics(result) {
  const bag = isPlainObject(result) ? result : {};
  const devices = Array.isArray(bag.devices) ? bag.devices : [];

  const rows = [];
  for (const device of devices) {
    if (!isPlainObject(device)) continue;
    const deviceUUID = asLabel(device.deviceUUID).trim();
    if (deviceUUID === '') continue;

    const utilPercent = percentOf(device);
    const memUsedBytes = toFiniteOrNull(device.memUsedBytes);
    if (utilPercent === null && memUsedBytes === null) continue;

    rows.push({
      deviceUUID,
      node: asLabel(device.node).trim(),
      utilPercent,
      memUsedBytes,
    });
  }

  const available = bag.available === true;
  const out = {
    available,
    scrapedAt: asLabel(bag.scrapedAt).trim(),
    devices: rows,
  };
  const reason = asLabel(bag.reason).trim();
  if (reason !== '') out.reason = reason;
  return out;
}

/**
 * 拉实测指标。**永不 reject**：模块缺失 / 没导出 / 抓取抛错 / 超时都折成
 * `available:false` + 中文 reason，因为「指标拿不到」不是 5xx 的理由。
 */
async function readSchedulerMetrics({ client, cluster }) {
  let mod;
  try {
    mod = await loadMetricsModule();
  } catch (err) {
    return {
      available: false,
      scrapedAt: '',
      devices: [],
      reason: `HAMi 指标模块不可用：${errorMessage(err)}`,
    };
  }

  const fetchFn = mod?.fetchSchedulerMetrics;
  if (typeof fetchFn !== 'function') {
    return {
      available: false,
      scrapedAt: '',
      devices: [],
      reason: 'HAMi 指标模块未导出 fetchSchedulerMetrics',
    };
  }

  try {
    return normalizeMetrics(await Promise.resolve(fetchFn({ client, cluster })));
  } catch (err) {
    return {
      available: false,
      scrapedAt: '',
      devices: [],
      reason: `HAMi 指标抓取失败：${errorMessage(err)}`,
    };
  }
}

// ─── 合并（分配 + 实测）────────────────────────────────────────────────

/**
 * 把指标按「node + deviceUUID」（A1 的主键）与裸 UUID 各建一份索引：
 *   util = Σ 该设备上所有容器的利用率（clamp 在读取阶段做）
 *   mem  = max(memUsedBytes)（设备级指标；见文件头「关键口径」第三条）
 *
 * 为什么要两份：A1 明确按 node+uuid 分组（同一 UUID 出现在两台节点上不合并），
 * 所以查表要先按 `节点::UUID` 命中；落不到再从裸 UUID 那份兜一层（指标缺 node 标签时
 * A1 自己也是这么兜的）。两份索引各自累加，**不会**让同一条记录被加两次。
 */
function indexMetrics(metrics) {
  const byNodeUuid = new Map();
  const byUuid = new Map();

  const bump = (map, key, row) => {
    let hit = map.get(key);
    if (!hit) {
      hit = { utilPercent: null, memUsedBytes: null };
      map.set(key, hit);
    }
    if (row.utilPercent !== null) hit.utilPercent = (hit.utilPercent ?? 0) + row.utilPercent;
    if (row.memUsedBytes !== null) {
      hit.memUsedBytes = hit.memUsedBytes === null ? row.memUsedBytes : Math.max(hit.memUsedBytes, row.memUsedBytes);
    }
  };

  for (const row of Array.isArray(metrics?.devices) ? metrics.devices : []) {
    bump(byUuid, row.deviceUUID, row);
    if (row.node !== '') bump(byNodeUuid, `${row.node}\u0000${row.deviceUUID}`, row);
  }
  return { byNodeUuid, byUuid };
}

/** 查一张卡的实测：先精确命中节点维度，再退回裸 UUID */
function lookupMeasured(index, nodeName, uuid) {
  if (nodeName !== '') {
    const scoped = index.byNodeUuid.get(`${nodeName}\u0000${uuid}`);
    if (scoped) return scoped;
  }
  return index.byUuid.get(uuid);
}

/** summarizeVgpu 缺失/抛错时的空汇总（字段与契约一致） */
function emptySummary() {
  return { hasHami: false, nodes: [], pods: [], totals: {}, warnings: [] };
}

/** 汇总分配数据；解析层未接入或抛错 → 空汇总（调用方据此再决定 reason） */
function summarizeVgpuSafe(parts) {
  try {
    const summary = k8sHami.summarizeVgpu(parts);
    if (isPlainObject(summary)) return summary;
    return emptySummary();
  } catch (err) {
    console.warn('[k8s-usage] vGPU 分配解析失败:', errorMessage(err));
    return null;
  }
}

/** Pod 排序键：`namespace/name`，保证同一份数据每次输出顺序一致（测试与前端都不受 map 顺序影响） */
function podSortKey(pod) {
  return `${asLabel(pod?.namespace)}/${asLabel(pod?.name)}`;
}

/**
 * 组装响应。
 *
 * @param {{nodes: object[], pods: object[], rawNodes: unknown[], rawPods: unknown[],
 *   metrics: object}} input
 * @returns {{available:boolean, scrapedAt:string, nodes:object[], reason?:string}}
 */
export function buildUsage({ nodes, pods, rawNodes, rawPods, metrics, gpuUsage, nodeMfu } = {}) {
  const scrapedAt = asLabel(metrics?.scrapedAt).trim() || new Date().toISOString();
  const available = metrics?.available === true;
  const reason = asLabel(metrics?.reason).trim() || UNAVAILABLE_REASON;

  const summary = summarizeVgpuSafe({
    nodes: withHamiNodeInputs(Array.isArray(nodes) ? nodes : [], rawNodes),
    pods: withHamiPodInputs(Array.isArray(pods) ? pods : [], rawPods),
  });
  if (summary === null) {
    // 分配都算不出来时，实测数字没有归属（不知道是哪张卡），只能整体降级
    return { available: false, scrapedAt, reason: `vGPU 分配解析失败，无法归属实测数据：${reason}`, nodes: [] };
  }

  const measured = indexMetrics(metrics);

  // 节点 × 物理卡：分配数据来自 summarizeVgpu（register 清单 + Pod 注解累计）
  // 实测数据（nvidia-smi）由调用方采集后传入：buildUsage 保持同步纯函数，便于单测
  const nodeUsageMap = gpuUsage instanceof Map ? gpuUsage : new Map();
  const nodeMfuMap = nodeMfu instanceof Map ? nodeMfu : new Map();
  
  const nodeRows = (Array.isArray(summary.nodes) ? summary.nodes : [])
    .filter(isPlainObject)
    .map((node) => {
      const nodeName = asLabel(node.name);
      const nodeUsage = nodeUsageMap.get(nodeName) || null;
      return {
        name: nodeName,
        // MFU 是节点级（同一台机器上的引擎共享这些卡）；拿不到时 available:false
        mfu: nodeMfuMap.get(nodeName) || { available: false, percent: null, engines: [], perGpu: [], reason: null },
        devices: (Array.isArray(node.devices) ? node.devices : [])
          .filter(isPlainObject)
          .map((device) => {
            const uuid = asLabel(device.id).trim();
            // 优先 nvidia-smi 的实测（真实使用），HAMi metrics 仅作兜底
            const gpuHit = gpuUsageModule
              ? gpuUsageModule.lookupGpuUsage(nodeUsage, { uuid, index: device.index })
              : null;
            const hit = gpuHit
              ? {
                  utilPercent: gpuHit.util === null ? null : gpuHit.util,
                  memUsedBytes: gpuHit.memUsed === null ? null : gpuHit.memUsed * 1024 * 1024,
                }
              : lookupMeasured(measured, nodeName, uuid);
            const hasUtil = Boolean(hit) && hit.utilPercent !== null;
            const hasMem = Boolean(hit) && hit.memUsedBytes !== null;
            return {
              uuid,
              type: asLabel(device.type),
              // 卡容量（面板要算「已分配/总量」「实测/总量」两条比例，缺它只能显示 —）
              totalMemMiB: asCount(device.memMiB),
              allocMemMiB: asCount(device.allocatedMemMiB),
              allocCores: asCount(device.allocatedCores),
              // 没有实测 → 0 + measured:false（分配字段保持真实值，见文件头口径四）
              usedMemMiB: hasMem ? Math.round(hit.memUsedBytes / BYTES_PER_MIB) : 0,
              utilPercent: hasUtil ? clampPercent(hit.utilPercent) : 0,
              // 「这条卡到底有没有采到数」必须显式给出：0% 与「没采到」在面板上是两件事
              measured: hasUtil || hasMem,
              pods: [],
            };
          }),
      };
    });

  // 设备行索引：`节点名::设备UUID` → 行对象（Pod 归属用）
  const deviceIndex = new Map();
  for (const node of nodeRows) {
    for (const device of node.devices) {
      const key = `${node.name}::${device.uuid}`;
      // 同名节点/重复 UUID 只认第一条（确定性），与 summarizeVgpu 的口径一致
      if (!deviceIndex.has(key)) deviceIndex.set(key, device);
    }
  }

  // Pod 侧：从 summary.pods 里按 (nodeName, deviceId) 拆到每张卡上
  const podRows = (Array.isArray(summary.pods) ? summary.pods : [])
    .filter(isPlainObject)
    .slice()
    .sort((a, b) => (podSortKey(a) < podSortKey(b) ? -1 : podSortKey(a) > podSortKey(b) ? 1 : 0));

  for (const pod of podRows) {
    const nodeName = asLabel(pod.nodeName);
    if (nodeName === '') continue; // 没有节点归属的 Pod 不进任何节点（分配在 totals 里，不在本端点）
    for (const device of Array.isArray(pod.devices) ? pod.devices : []) {
      if (!isPlainObject(device)) continue;
      const row = deviceIndex.get(`${nodeName}::${asLabel(device.id).trim()}`);
      if (!row) continue; // register 里没有这张卡（summarizeVgpu 会补行，正常不该走到这里）
      row.pods.push({
        ns: asLabel(pod.namespace),
        name: asLabel(pod.name),
        memMiB: asCount(device.memMiB),
        cores: asCount(device.cores),
      });
    }
  }

  // 节点按名字排序：k8s list 顺序理论上稳定，但不能指望（多 apiserver 场景下会变）
  nodeRows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const payload = { available, scrapedAt, nodes: nodeRows };
  if (!available) payload.reason = reason;
  return payload;
}

// ─── 工厂 ─────────────────────────────────────────────────────────────

/**
 * 创建 HAMi 实测使用率路由。
 *
 * @param {{ensureSettings: () => object}} deps
 *   ensureSettings —— 读取当前生效配置（settings.k8sClusters 存在这里），由 index.js 注入
 * @returns {import('express').Router}
 */
/**
 * 采集「节点 → 设备 UUID → 实测(util/memUsed)」。
 *
 * 远端节点：按 node.internalIP 匹配 settings 里的远程服务器 id，用 execRemoteCommand 跑 nvidia-smi。
 * 本机节点：容器内大概率没有 nvidia-smi，直接跳过（该节点的卡会标 measured:false）。
 * 任何失败都降级为空 Map —— /usage 的分配部分照常返回。
 */
async function collectNodeGpuUsageSafe(nodes) {
  if (!gpuUsageModule) return new Map();
  try {
    const remoteModule = await import('../remote.js');
    const gpuModule = await import('../gpu.js');
    const servers = typeof remoteModule.getServers === 'function' ? remoteModule.getServers() : [];
    const getRemoteGPUs = async (server) => {
      const r = await remoteModule.execRemoteCommand(server.id, REMOTE_GPU_QUERY);
      if (r?.error) throw new Error(r.error);
      return gpuModule.buildRemoteGPUPayload(r.stdout || '', '').devices;
    };
    // 带 TTL / 单飞 / 超时：节点不可达时这一帧不等，后台跑完写缓存
    if (typeof gpuUsageModule.collectNodeGpuUsageCached === 'function') {
      const sampled = await gpuUsageModule.collectNodeGpuUsageCached({
        nodes: Array.isArray(nodes) ? nodes : [],
        servers,
        deps: { getRemoteGPUs },
        timeoutMs: 1500,
        ttlMs: 3000,
      });
      return sampled.usage;
    }
    return await gpuUsageModule.collectNodeGpuUsage({
      nodes: Array.isArray(nodes) ? nodes : [],
      servers,
      deps: { getRemoteGPUs },
    });
  } catch (err) {
    console.warn(`[K8s] GPU 实测采集失败（/usage 只返回分配数据）：${errorMessage(err)}`);
    return new Map();
  }
}

const REMOTE_GPU_QUERY =
  'nvidia-smi --query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits';

/**
 * 演示模式的 /usage：用 fixtures 的演示集群现算「分配」，再叠一组确定性的「实测」。
 *
 * 演示时「GPU 分配 vs 实际使用」是主打能力，返回空卡片等于告诉对方"这功能没做"。
 * 实测值按卡容量取固定比例（不随机），保证每次演示数据一致。
 */
async function buildDemoUsage() {
  try {
    // 直接读 fixtures：不要依赖别的路由模块里的私有 helper
    const fixtures = demoFixtures ?? await import('../demo/fixtures.js');
    const overview = fixtures.demoK8sOverview?.('demo-k3s-infer') || {};
    const summary = k8sHami.summarizeVgpu({ nodes: overview.nodes || [], pods: overview.pods || [] });
    const ratios = [0.62, 0.41, 0.78, 0.33, 0.55];
    const nodes = (summary?.nodes || []).map((node) => ({
      name: node.name,
      devices: (node.devices || []).map((device, i) => {
        const ratio = ratios[i % ratios.length];
        const total = asCount(device.memMiB);
        return {
          uuid: asLabel(device.id),
          type: asLabel(device.type),
          totalMemMiB: total,
          allocMemMiB: asCount(device.allocatedMemMiB),
          allocCores: asCount(device.allocatedCores),
          usedMemMiB: Math.round(total * ratio),
          utilPercent: Math.round(ratio * 100),
          measured: true,
          pods: [],
        };
      }),
    }));
    return { available: true, scrapedAt: '2026-06-08T09:48:37.000Z', demo: true, nodes };
  } catch (err) {
    return { available: false, reason: `${DEMO_REASON}（演示数据构建失败：${errorMessage(err)}）`, nodes: [] };
  }
}


/**
 * 采集「节点 → MFU」。
 *
 * MFU 来自推理引擎的 /metrics（token 计数差分 ÷ 峰值算力），跟 HAMi 的分配是两个维度：
 *   · 分配（HAMi）：这张卡被切了多少给谁
 *   · MFU（引擎）：这块算力实际跑出了多少有效计算
 * 放在同一张卡片里，才能回答「分配 60%、MFU 只有 12% —— 是配额给小了还是模型没喂饱」。
 *
 * 与 GPU 实测一样按 node.internalIP 匹配远程服务器；拿不到就返回 available:false，
 * 不影响 /usage 的其它字段。
 */
/** MFU 采集在请求路径上的预算：超过就跳过，不让整页等它。 */
const MFU_BUDGET_MS = 1500;

/**
 * MFU 失败冷却：超时/不可达的服务器在这段时间内直接返回上次的原因，不再重试。
 * 没有它，每刷新一次页面就要重新等一轮超时（243 上 node2 经 Tailscale 不可达，
 * 每次白等 1.5s）。
 */
const MFU_COOLDOWN_MS = 60 * 1000;
const mfuCooldown = new Map();

async function collectNodeMfuSafe(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const out = new Map();
  let remoteModule;
  let mfuModule;
  try {
    remoteModule = await import('../remote.js');
    mfuModule = await import('../gpu-mfu.js');
  } catch (err) {
    console.warn(`[K8s] MFU 模块未加载（/usage 不返回 MFU）：${errorMessage(err)}`);
    return out;
  }
  if (typeof mfuModule.getRemoteMfu !== 'function') return out;
  const servers = typeof remoteModule.getServers === 'function' ? remoteModule.getServers() : [];

  await Promise.all(list.map(async (node) => {
    const ip = asLabel(node?.internalIP).trim();
    const name = asLabel(node?.name).trim();
    if (!ip || !name) return;
    const server = servers.find((s) => s && s.host === ip);
    if (!server) return;
    const cooled = mfuCooldown.get(server.id);
    if (cooled && Date.now() < cooled.until) {
      out.set(name, {
        available: false,
        percent: null,
        engines: [],
        perGpu: [],
        reason: cooled.reason,
      });
      return;
    }
    try {
      // MFU 是「锦上添花」的一半：冷采样要发现端点 + 隔 2s 取两次差分，
      // 243 实测一次十几秒。接口不能为它把关 —— 超过 MFU_BUDGET_MS 就跳过，
      // 在飞的那次继续跑，下次请求命中热采样窗口（一次 exec，不 sleep）。
      const timeoutReason = `MFU 采样超过 ${MFU_BUDGET_MS}ms，本次跳过（${MFU_COOLDOWN_MS / 1000}s 内不再重试）`;
      const res = await Promise.race([
        mfuModule.getRemoteMfu(server.id),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({
            available: false,
            engines: [],
            gpuMfu: {},
            reason: timeoutReason,
            __timedOut: true,
          }), MFU_BUDGET_MS);
          if (typeof timer?.unref === 'function') timer.unref();
        }),
      ]);
      if (res?.__timedOut) {
        mfuCooldown.set(server.id, { until: Date.now() + MFU_COOLDOWN_MS, reason: timeoutReason });
      }
      if (res && res.available === true) mfuCooldown.delete(server.id);
      if (!res) return;
      const perGpu = Object.entries(res.gpuMfu || {}).map(([index, item]) => ({
        index: Number(index),
        mfu: Number(item?.mfu) || 0,
      }));
      const values = perGpu.map((g) => g.mfu).filter((v) => v > 0);
      out.set(name, {
        available: res.available === true,
        percent: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 10 : null,
        engines: (res.engines || []).map((e) => e.name || e.engine || '').filter(Boolean).slice(0, 4),
        perGpu,
        reason: res.reason || null,
      });
    } catch { /* 单节点失败不影响其它节点 */ }
  }));

  return out;
}

export function createK8sUsageRouter({ ensureSettings } = {}) {
  if (typeof ensureSettings !== 'function') {
    throw new TypeError('createK8sUsageRouter 需要注入 ensureSettings');
  }
  const router = express.Router();

  /**
   * :id → req.k8sCluster（一次解析，一条路由也不会漏）。
   * 演示模式不读 settings：演示集群不在 settings 里，且契约要求演示路径不触达真实配置。
   */
  router.param('id', (req, res, next, id) => {
    const clusterId = String(id ?? '').trim();
    if (clusterId === '') {
      res.status(404).json({ error: '缺少集群 id' });
      return;
    }
    if (isDemoMode()) {
      req.k8sCluster = null;
      next();
      return;
    }

    let record;
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

  router.get(`${PREFIX}/clusters/:id/usage`, async (req, res) => {
    // 演示模式：不连集群、不读 kubeconfig、不抓指标，固定空态。
    // 响应体刻意只有契约里那三个字段（reason 文本已自证来源），不挂 demo 标记，
    // 免得前端把「指标未接入」误当成「演示数据 → 隐藏告警」。
    if (isDemoMode()) {
      res.json(await buildDemoUsage());
      return;
    }

    try {
      const { client } = connectCluster(req.k8sCluster);

      // 实测与列表并发：指标抓取自己会兜错，先发出去能省一个 RTT。
      const metricsTask = readSchedulerMetrics({ client, cluster: clusterSummary(req.k8sCluster) });

      const settled = await Promise.allSettled([
        Promise.resolve().then(() => client.getJson('/api/v1/nodes')),
        Promise.resolve().then(() => client.getJson('/api/v1/pods')),
      ]);

      // nodes / pods 缺一块就没法算分配：这类失败是「连不上 / 权限不足 / 超时」，一律 502。
      // 与指标不同 —— 指标拿不到只是 available:false，列表拿不到是真的什么都算不出来。
      if (settled[0].status === 'rejected') {
        throw httpError(`无法读取节点列表：${errorMessage(settled[0].reason)}`, 502);
      }
      if (settled[1].status === 'rejected') {
        throw httpError(`无法读取 Pod 列表：${errorMessage(settled[1].reason)}`, 502);
      }

      const rawNodes = itemsOf(settled[0].value);
      const rawPods = itemsOf(settled[1].value);
      const nodes = normalizeSafe('节点', () => k8sResources.normalizeNodes(rawNodes));
      const pods = normalizeSafe('Pod', () => k8sResources.normalizePods(rawPods));
      const metrics = await metricsTask;

      // 实测数据是实时遥测：中间任何一层代理都不许缓存
      res.set('cache-control', 'no-store');
      // 实测（nvidia-smi）与 MFU 在这里采集：两者各自带预算，且**并行** ——
      // 串行时最坏是两份预算相加（1.5 + 1.5），并行后整页只等最慢的那一份。
      const [gpuUsage, nodeMfu] = await Promise.all([
        collectNodeGpuUsageSafe(nodes),
        collectNodeMfuSafe(nodes),
      ]);
      res.json(buildUsage({ nodes, pods, rawNodes, rawPods, metrics, gpuUsage, nodeMfu }));
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  return router;
}

export default createK8sUsageRouter;
