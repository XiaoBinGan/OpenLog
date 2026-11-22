/**
 * HAMi vGPU 解析层（增量 ④ / H1）
 *
 * 职责：把 HAMi 写在 Kubernetes 对象上的 GPU 数据解析成前端能直接渲染的结构，
 * 数据来源是 **已归一化** 的 node / pod（`normalizeNodes` / `normalizePods` 的输出），
 * 同时也容忍传原始 k8s 对象（`status.capacity` / `metadata.annotations`）——
 * 这样集成方拿到的对象是哪种形状都不影响解析。
 *
 * 设计约束（与 resources.js 一致）：
 * - **纯函数、零 IO、确定性**：同样输入必得同样输出；返回值全是新对象（深拷贝），
 *   调用方 mutate 不会污染入参，也不会污染下一次调用。
 * - **绝不抛异常**：HAMi 各版本的注解格式有差异（分隔符 `:;` / `;` / `:`、
 *   末尾空项、字段缺失、单位混写），坏数据只降级成 0 / 跳过 / warning。
 * - 数字口径：缺失、空串、`NaN`、负数、大于 10^9（≈1 PiB 显存，只能是坏数据）
 *   一律按 0 处理；只有「能解析且落在 [0, 10^9]」的值才计入。
 *
 * 三个导出：
 *   readNodeGpu(node)          → 单节点 GPU 容量
 *   readPodVgpu(pod)           → 单 Pod 的 vGPU 分配
 *   summarizeVgpu({nodes,pods}) → overview 用的 gpu 汇总段
 */

/** HAMi 在节点 capacity / allocatable 上的三个扩展资源名。 */
const GPU_RESOURCES = ['nvidia.com/gpu', 'nvidia.com/gpumem', 'nvidia.com/gpucores'];

/** Pod 上声明 vGPU 分配的注解；不同 HAMi 版本写法不同，前面的优先。 */
const DEVICE_ANNOTATIONS = ['hami.io/vgpu-devices-allocated', 'hami.io/vgpu-devices-assigned'];

/** Pod 上记录「这个 Pod 落在哪台节点」的注解：`<node>,<idx>,<type>`。 */
const NODE_ANNOTATION = 'hami.io/vgpu-node-allocated';

/** 单值上限：10^9 MiB ≈ 1 PiB，超过必然是坏数据（也挡住 `Number` 溢出与科学计数法误值）。 */
const MAX_RESOURCE_VALUE = 1e9;

/** 契约要求 warnings 最多 5 条。 */
const MAX_WARNINGS = 5;

/** 设备记录分隔符：`;`（多版本写法）、`:`（HAMi 原生多卡写法）。两者都要认。 */
const DEVICE_SEPARATOR = /[;:]/;

/** 对象兜底：null / undefined / 数组 / 原始值统一当空映射。 */
function asBag(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** 优先取 primary，空映射时退回 fallback（归一化对象 vs 原始 k8s 对象两种形状）。 */
function pickBag(primary, fallback) {
  const preferred = asBag(primary);
  return Object.keys(preferred).length > 0 ? preferred : asBag(fallback);
}

/** 字符串兜底：null/undefined → ''，其余转字符串（k8s 的数量字段可能是 number）。 */
function asText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** 该字段是否「写了」（null/undefined/空串/纯空白都算没写）。 */
function isPresent(value) {
  return asText(value).trim() !== '';
}

/**
 * 读一个数量字段。坏值不抛异常，记一条 warning 后按 0 计。
 * @returns {number} 落在 [0, MAX_RESOURCE_VALUE] 的有限数字
 */
function readQuantity(raw, label, sink) {
  const text = asText(raw).trim();
  if (text === '') return 0;

  const value = Number(text);
  if (!Number.isFinite(value)) {
    sink.push(`${label} 不是数字（"${text}"），按 0 处理`);
    return 0;
  }
  if (value < 0) {
    sink.push(`${label} 为负数（"${text}"），按 0 处理`);
    return 0;
  }
  if (value > MAX_RESOURCE_VALUE) {
    sink.push(`${label} 超出上限 ${MAX_RESOURCE_VALUE}（"${text}"），按 0 处理`);
    return 0;
  }
  return value;
}

/**
 * 内部：节点 GPU 容量，带 warnings。
 * capacity 优先（HAmi 把「物理总量」写这里），capacity 完全没有 GPU 字段时才退 allocatable
 * （RBAC 只给了 allocatable 或某些发行版裁剪了 capacity 的情况）。
 * @returns {{name:string, warnings:string[], gpu:{hasGpu:boolean,count:number,memMiB:number,cores:number,source:string}}}
 */
function parseNodeGpu(node) {
  const warnings = [];
  // 归一化节点的名字在 name，原始 k8s 对象在 metadata.name
  const name = asText(node?.name).trim() || asText(node?.metadata?.name).trim();
  const where = name ? `节点 ${name}` : '节点';

  const capacity = pickBag(node?.capacity, node?.status?.capacity);
  const allocatable = pickBag(node?.allocatable, node?.status?.allocatable);

  const capacityHasGpu = GPU_RESOURCES.some((key) => isPresent(capacity[key]));
  const allocatableHasGpu = GPU_RESOURCES.some((key) => isPresent(allocatable[key]));

  let source = 'none';
  if (capacityHasGpu) source = 'capacity';
  else if (allocatableHasGpu) source = 'allocatable';

  if (source === 'none') {
    // 没有 HAMi 的集群走的就是这条路：一片字段都没有，安静地返回空结果
    return {
      name,
      warnings,
      gpu: { hasGpu: false, count: 0, memMiB: 0, cores: 0, source },
    };
  }

  const bag = source === 'capacity' ? capacity : allocatable;
  const label = (key) => `${where} 的 ${key}（${source}）`;

  const count = readQuantity(bag[GPU_RESOURCES[0]], label(GPU_RESOURCES[0]), warnings);
  const memMiB = readQuantity(bag[GPU_RESOURCES[1]], label(GPU_RESOURCES[1]), warnings);
  const cores = readQuantity(bag[GPU_RESOURCES[2]], label(GPU_RESOURCES[2]), warnings);

  // gpu 计数为 0 但显存/算力有值的节点（部分版本只报后两者）也算「有 GPU 资源」
  const hasGpu = count > 0 || memMiB > 0 || cores > 0;

  return { name, warnings, gpu: { hasGpu, count, memMiB, cores, source } };
}

/** 从注解里挑出第一个「写了内容」的 vGPU 分配注解。 */
function pickDeviceAnnotation(annotations) {
  for (const key of DEVICE_ANNOTATIONS) {
    const value = asText(annotations[key]).trim();
    if (value !== '') return { key, value };
  }
  return null;
}

/**
 * Pod 归属节点：Pod 自己的调度结果优先（`node` / `nodeName` / `spec.nodeName`），
 * 其次是 HAMi 的 `hami.io/vgpu-node-allocated`（`node1,0,NVIDIA` → `node1`）。
 * 都没有 → null（不伪造节点名，也不把 Pod 算进任何节点）。
 */
function resolveNodeName(pod, annotations) {
  const fromPod = asText(pod?.node).trim()
    || asText(pod?.nodeName).trim()
    || asText(pod?.spec?.nodeName).trim();
  if (fromPod) return fromPod;

  const annotation = asText(annotations[NODE_ANNOTATION]).trim();
  if (annotation === '') return null;
  const first = annotation.split(',')[0].trim();
  return first || null;
}

/**
 * 内部：Pod 的 vGPU 分配，带 warnings。
 *
 * 注解值形态（全部要认）：
 *   `GPU-3f2a-...,12288,40:;GPU-9b1c-...,4096,10`   多卡 + `:;` 分隔 + 末项
 *   `GPU-9b1c-...,4096,10`                          单卡
 *   `GPU-a,4096,30:GPU-b,2048,20`                   HAMi 原生冒号分隔
 *   `GPU-x, 4096 , 30`                              带空格
 *
 * 坏条目的确定行为：
 *   - 空项（`;;`、末尾 `:;` 造成的空串）：静默跳过，不产生 warning（这是正常写法）
 *   - 没有设备 ID、或只有 ID 一个字段（如 `garbage`）：整条跳过 + warning
 *   - 数字字段缺失（`GPU-x`）/非数字（`GPU-x,abc,10`）/负数/超上限：该字段按 0 + warning，
 *     设备本身保留 —— 「这张卡被这个 Pod 占了」这个事实比容量数字更重要，UI 仍能显示一行
 *   - 整条注解一条设备都解析不出来：hasVgpu 仍为 true（注解存在说明 HAMi 在管这张卡），
 *     设备列表为空 + warning
 * @returns {{identity:{namespace:string,name:string,phase:string}, warnings:string[],
 *   vgpu:{hasVgpu:boolean,devices:{id:string,memMiB:number,cores:number}[],
 *     totalMemMiB:number,totalCores:number,nodeName:string|null,raw:string|null}}}
 */
function parsePodVgpu(pod) {
  const warnings = [];
  const annotations = pickBag(pod?.annotations, pod?.metadata?.annotations);

  const namespace = asText(pod?.namespace).trim() || asText(pod?.metadata?.namespace).trim();
  const name = asText(pod?.name).trim() || asText(pod?.metadata?.name).trim();
  const phase = asText(pod?.phase).trim() || asText(pod?.status?.phase).trim() || 'Unknown';
  const where = `Pod ${namespace ? `${namespace}/` : ''}${name || '(未命名)'}`;
  const nodeName = resolveNodeName(pod, annotations);

  const picked = pickDeviceAnnotation(annotations);
  if (!picked) {
    return {
      identity: { namespace, name, phase },
      warnings,
      vgpu: { hasVgpu: false, devices: [], totalMemMiB: 0, totalCores: 0, nodeName, raw: null },
    };
  }

  const { key, value } = picked;
  const devices = [];
  let totalMemMiB = 0;
  let totalCores = 0;

  for (const chunk of value.split(DEVICE_SEPARATOR)) {
    const entry = chunk.trim();
    if (entry === '') continue; // `:;` 与末尾分号留下的空项

    const fields = entry.split(',').map((field) => field.trim());
    const id = fields[0];

    if (id === '') {
      warnings.push(`${where} 的 ${key} 有一条记录缺少设备 ID（"${entry}"），已跳过`);
      continue;
    }
    if (fields.length < 2) {
      warnings.push(`${where} 的 ${key} 记录 "${entry}" 字段不足（至少需要 设备ID,显存MiB），已跳过`);
      continue;
    }

    const memMiB = readQuantity(fields[1], `${where} 的设备 ${id} 显存`, warnings);
    let cores = 0;
    if (fields.length >= 3) {
      cores = readQuantity(fields[2], `${where} 的设备 ${id} 算力`, warnings);
    } else {
      warnings.push(`${where} 的设备 ${id} 缺少算力字段，按 0 处理`);
    }

    // 第 4 个及以后的字段（部分版本带设备类型）不影响统计，忽略
    devices.push({ id, memMiB, cores });
    totalMemMiB += memMiB;
    totalCores += cores;
  }

  if (devices.length === 0) {
    warnings.push(`${where} 的 ${key} 没有解析出任何设备（原文 "${value}"）`);
  }

  return {
    identity: { namespace, name, phase },
    warnings,
    vgpu: { hasVgpu: true, devices, totalMemMiB, totalCores, nodeName, raw: value },
  };
}

/**
 * 解析节点的 GPU 容量（capacity 优先，缺失时退 allocatable）。
 * 缺字段返回 `hasGpu=false`，不抛异常。
 * @param {unknown} node 归一化 node（含 `allocatable`），或原始 k8s node 对象
 * @returns {{hasGpu:boolean,count:number,memMiB:number,cores:number,source:'capacity'|'allocatable'|'none'}}
 */
export function readNodeGpu(node) {
  return parseNodeGpu(node).gpu;
}

/**
 * 解析 Pod 的 vGPU 分配。无注解返回 `hasVgpu=false`、空设备列表。
 * @param {unknown} pod 归一化 pod（含 `annotations`），或原始 k8s pod 对象
 * @returns {{hasVgpu:boolean,devices:{id:string,memMiB:number,cores:number}[],
 *   totalMemMiB:number,totalCores:number,nodeName:string|null,raw:string|null}}
 */
export function readPodVgpu(pod) {
  return parsePodVgpu(pod).vgpu;
}

/**
 * 汇总成 overview 用的 gpu 段。
 *
 * 口径（H2 直接依赖）：
 * - `nodes`：只收「有 GPU 资源」的节点；`allocatedMemMiB` / `allocatedCores` / `podCount`
 *   由 Pod 侧累加得到（同一个多卡 Pod 只算 1 个 podCount）。
 * - `pods`：只收「写了 vGPU 注解」的 Pod（含解析失败、设备为空的，前端可据此提示）；
 *   解析失败的 Pod 计入 pods[] 但**不**累加到节点（没有任何可信的占用数字）。
 * - 没有 nodeName 的 Pod（`null`）不进任何节点累计，但**计入 totals**（totals 是全局求和）。
 * - `totals.allocatedMemMiB` 与「各节点 allocatedMemMiB 之和」在有未归属 Pod 时**不相等**，
 *   这是刻意的：卡片要能显示「有分配但不知道在哪台节点」的量。
 * - `hasHami`：任一节点有 GPU 资源 **或** 任一 Pod 有 vGPU 注解 → true。全都没有 → false，
 *   此时 nodes/pods 都是空数组、totals 全 0、warnings 为空（UI 据此完全不渲染该卡片）。
 *
 * @param {{nodes?:unknown,pods?:unknown}|undefined} parts
 * @returns {{hasHami:boolean,
 *   nodes:{name:string,count:number,memMiB:number,cores:number,
 *     allocatedMemMiB:number,allocatedCores:number,podCount:number}[],
 *   pods:{namespace:string,name:string,nodeName:string|null,
 *     devices:{id:string,memMiB:number,cores:number}[],
 *     totalMemMiB:number,totalCores:number,phase:string}[],
 *   totals:{gpuCount:number,memMiB:number,cores:number,
 *     allocatedMemMiB:number,allocatedCores:number,podCount:number},
 *   warnings:string[]}}
 */
export function summarizeVgpu(parts) {
  const { nodes, pods } = parts ?? {};
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const podList = Array.isArray(pods) ? pods : [];

  const sink = [];

  // ── 节点 ────────────────────────────────────────────────────────────
  const nodeRows = [];
  /** @type {Map<string, object>} 节点名 → 累计行；同名节点取第一个（确定性） */
  const nodeIndex = new Map();

  for (const node of nodeList) {
    const { name, warnings, gpu } = parseNodeGpu(node);
    sink.push(...warnings);
    if (!gpu.hasGpu) continue;

    const row = {
      name,
      count: gpu.count,
      memMiB: gpu.memMiB,
      cores: gpu.cores,
      allocatedMemMiB: 0,
      allocatedCores: 0,
      podCount: 0,
    };
    nodeRows.push(row);
    if (name !== '' && !nodeIndex.has(name)) nodeIndex.set(name, row);
  }

  // ── Pod ────────────────────────────────────────────────────────────
  const podRows = [];
  /** 真正参与了累计的 Pod（至少解析出一个设备） */
  const counted = [];

  for (const pod of podList) {
    const { identity, warnings, vgpu } = parsePodVgpu(pod);
    sink.push(...warnings);
    if (!vgpu.hasVgpu) continue;

    podRows.push({
      namespace: identity.namespace,
      name: identity.name,
      nodeName: vgpu.nodeName,
      devices: vgpu.devices,
      totalMemMiB: vgpu.totalMemMiB,
      totalCores: vgpu.totalCores,
      phase: identity.phase,
    });

    if (vgpu.devices.length === 0) continue; // 坏注解：不参与任何累计
    counted.push(vgpu);

    // 没有 nodeName 的 Pod 归到 null，不进节点累计
    const row = vgpu.nodeName === null ? undefined : nodeIndex.get(vgpu.nodeName);
    if (!row) continue;
    row.allocatedMemMiB += vgpu.totalMemMiB;
    row.allocatedCores += vgpu.totalCores;
    row.podCount += 1;
  }

  // ── totals（全局求和）────────────────────────────────────────────────
  const totals = { gpuCount: 0, memMiB: 0, cores: 0, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 };
  for (const row of nodeRows) {
    totals.gpuCount += row.count;
    totals.memMiB += row.memMiB;
    totals.cores += row.cores;
  }
  for (const vgpu of counted) {
    totals.allocatedMemMiB += vgpu.totalMemMiB;
    totals.allocatedCores += vgpu.totalCores;
    totals.podCount += 1;
  }

  return {
    hasHami: nodeRows.length > 0 || podRows.length > 0,
    nodes: nodeRows,
    pods: podRows,
    totals,
    // 去重（同一个坏写法被多个 Pod 命中时只提示一次）后截到 5 条
    warnings: [...new Set(sink)].slice(0, MAX_WARNINGS),
  };
}
