/**
 * HAMi vGPU 解析层（增量 ④ / H1）
 *
 * 职责：把 HAMi 写在 Kubernetes 对象上的 GPU 数据解析成前端能直接渲染的结构，
 * 数据来源是 **已归一化** 的 node / pod（`normalizeNodes` / `normalizePods` 的输出），
 * 同时也容忍传原始 k8s 对象（`status.capacity` / `metadata.annotations`）——
 * 这样集成方拿到的对象是哪种形状都不影响解析。
 *
 * 真机（243：k3s v1.33.13 + HAMi）实测推翻了两条旧假设，本文件以真机 payload 为准：
 *   1) Pod 注解是**四段**：`GPU-86d1…,NVIDIA,5888,0:;` → `<uuid>,<type>,<memMiB>,<cores>`。
 *      旧实现把第二段当显存，于是 `NVIDIA` 触发「显存不是数字」的误报、显存显示 0、
 *      算力错位成 5888。现按「第二段能否当数字」自适应布局（见 resolveDeviceLayout）。
 *   2) 节点容量**不在** `nvidia.com/gpumem|gpucores` 上（真机这两个字段不存在），
 *      而在注解 `hami.io/node-nvidia-register` 的 JSON 数组里：
 *      `[{ id, type, devmem, devcore, count, health, index }]`，
 *      每项是一张**物理卡**，`count` 是这张卡被切成的 vGPU 槽位数。
 * 契约与真机原文见 /tmp/hami-real-format.md。
 *
 * 设计约束（与 resources.js 一致）：
 * - **纯函数、零 IO、确定性**：同样输入必得同样输出；返回值全是新对象（深拷贝），
 *   调用方 mutate 不会污染入参，也不会污染下一次调用。
 * - **绝不抛异常**：HAMi 各版本的注解格式有差异（四段带 type / 三段 / 两段、分隔符
 *   `:;` / `;` / `:`、末尾空项、字段缺失、单位混写、register 不是合法 JSON），
 *   坏数据只降级成 0 / 跳过 / warning。
 * - 数字口径：缺失、空串、`NaN`、负数、大于 10^9（≈1 PiB 显存，只能是坏数据）
 *   一律按 0 处理；只有「能解析且落在 [0, 10^9]」的值才计入。
 *
 * 三个导出：
 *   readNodeGpu(node)          → 单节点 GPU 容量 + 物理卡清单（devices）
 *   readPodVgpu(pod)           → 单 Pod 的 vGPU 分配
 *   summarizeVgpu({nodes,pods}) → overview 用的 gpu 汇总段
 */

/** HAMi 在节点 capacity / allocatable 上的三个扩展资源名（真机上只有第一个存在）。 */
const GPU_RESOURCES = ['nvidia.com/gpu', 'nvidia.com/gpumem', 'nvidia.com/gpucores'];

/** 节点上写物理卡清单的注解（JSON 数组字符串）；真机容量的唯一来源。 */
const REGISTER_ANNOTATION = 'hami.io/node-nvidia-register';

/** Pod 上声明 vGPU 分配的注解；不同 HAMi 版本写法不同，前面的优先。 */
const DEVICE_ANNOTATIONS = ['hami.io/vgpu-devices-allocated', 'hami.io/vgpu-devices-assigned'];

/** Pod 上的节点名注解：`vgpu-node` 是真机（243）唯一可用的那个，值是纯节点名。 */
const NODE_NAME_ANNOTATION = 'hami.io/vgpu-node';

/** 旧版本的节点注解：`<node>,<idx>,<type>`（243 上不存在，仅作兜底）。 */
const NODE_ANNOTATION = 'hami.io/vgpu-node-allocated';

/** 单值上限：10^9 MiB ≈ 1 PiB，超过必然是坏数据（也挡住 `Number` 溢出与科学计数法误值）。 */
const MAX_RESOURCE_VALUE = 1e9;

/** 契约要求 warnings 最多 5 条。 */
const MAX_WARNINGS = 5;

/** 设备记录分隔符：`;`（多版本写法）、`:`（HAMi 原生多卡写法）。两者都要认。 */
const DEVICE_SEPARATOR = /[;:]/;

/** 严格数字形态：用来区分「显存/算力」与「设备型号」。空串不算数字。 */
const NUMERIC_FIELD = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

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

/** 读一个「卡序号」（register 的 index）：没有 / 不是非负整数 → null（0 是合法序号）。 */
function readIndex(raw) {
  const text = asText(raw).trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** health 归一化：只有明确写 false 才算不健康（缺字段当作健康，不制造告警）。 */
function readHealth(raw) {
  return asText(raw).trim().toLowerCase() !== 'false';
}

/**
 * 解析节点注解 `hami.io/node-nvidia-register`（JSON 数组）→ 物理卡清单。
 *
 * 真机原文（243）：
 *   [{"id":"GPU-6b12…","index":1,"count":10,"devmem":32607,"devcore":100,
 *     "type":"NVIDIA GeForce RTX 5090",…},
 *    {"id":"GPU-86d1…","count":10,"devmem":49140,"devcore":100,
 *     "type":"NVIDIA GeForce RTX 4090",…}]
 *
 * 坏数据一律降级：不是合法 JSON / 不是数组 / 空数组 / 没有一张卡能解析 → 返回 null
 * （调用方退回 `nvidia.com/*` 口径），坏 JSON 额外记一条 warning。
 *
 * @returns {{id:string,type:string,memMiB:number,cores:number,slots:number,
 *   health:boolean,index:number|null}[]|null}
 */
function parseRegister(raw, where, sink) {
  const text = asText(raw).trim();
  if (text === '') return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    sink.push(`${where} 的 ${REGISTER_ANNOTATION} 不是合法 JSON，已降级为 ${GPU_RESOURCES[0]} 口径`);
    return null;
  }
  if (!Array.isArray(parsed)) {
    sink.push(`${where} 的 ${REGISTER_ANNOTATION} 不是 JSON 数组，已降级为 ${GPU_RESOURCES[0]} 口径`);
    return null;
  }

  const devices = [];
  const seen = new Set();

  parsed.forEach((entry, position) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      sink.push(`${where} 的 ${REGISTER_ANNOTATION} 第 ${position + 1} 项不是对象，已跳过`);
      return;
    }

    const id = asText(entry.id).trim();
    if (id === '') {
      sink.push(`${where} 的 ${REGISTER_ANNOTATION} 第 ${position + 1} 项缺少设备 id，已跳过`);
      return;
    }
    // 同一张卡写两遍会让 Σ 容量翻倍（比丢一张卡更容易骗过人），只认第一条
    if (seen.has(id)) {
      sink.push(`${where} 的 ${REGISTER_ANNOTATION} 设备 ${id} 重复登记，已跳过后一条`);
      return;
    }
    seen.add(id);

    const label = (field) => `${where} 的 ${REGISTER_ANNOTATION} 设备 ${id} 的 ${field}`;
    devices.push({
      id,
      type: asText(entry.type).trim(),
      memMiB: readQuantity(entry.devmem, label('devmem'), sink),
      cores: readQuantity(entry.devcore, label('devcore'), sink),
      slots: readQuantity(entry.count, label('count'), sink),
      health: readHealth(entry.health),
      index: readIndex(entry.index),
    });
  });

  return devices.length > 0 ? devices : null;
}

/**
 * 内部：节点 GPU 容量，带 warnings。
 *
 * 取值顺序（真机优先）：
 *   1. 注解 `hami.io/node-nvidia-register` → 物理卡清单（count=卡数，memMiB=Σdevmem，
 *      cores=Σdevcore，slots=Σcount）
 *   2. capacity 里的 `nvidia.com/gpu|gpumem|gpucores`（老集群 / register 坏掉时）
 *   3. allocatable 里的同一组（RBAC 只给 allocatable 或发行版裁剪了 capacity 时）
 * @returns {{name:string, warnings:string[], gpu:{hasGpu:boolean,count:number,memMiB:number,
 *   cores:number,slots:number,source:string,devices:object[]}}}
 */
function parseNodeGpu(node) {
  const warnings = [];
  // 归一化节点的名字在 name，原始 k8s 对象在 metadata.name
  const name = asText(node?.name).trim() || asText(node?.metadata?.name).trim();
  const where = name ? `节点 ${name}` : '节点';

  const annotations = pickBag(node?.annotations, node?.metadata?.annotations);
  const devices = parseRegister(annotations[REGISTER_ANNOTATION], where, warnings);

  if (devices) {
    let memMiB = 0;
    let cores = 0;
    let slots = 0;
    for (const device of devices) {
      memMiB += device.memMiB;
      cores += device.cores;
      slots += device.slots;
    }
    return {
      name,
      warnings,
      gpu: { hasGpu: true, count: devices.length, memMiB, cores, slots, source: 'register', devices },
    };
  }

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
      gpu: { hasGpu: false, count: 0, memMiB: 0, cores: 0, slots: 0, source, devices: [] },
    };
  }

  const bag = source === 'capacity' ? capacity : allocatable;
  const label = (key) => `${where} 的 ${key}（${source}）`;

  const count = readQuantity(bag[GPU_RESOURCES[0]], label(GPU_RESOURCES[0]), warnings);
  const memMiB = readQuantity(bag[GPU_RESOURCES[1]], label(GPU_RESOURCES[1]), warnings);
  const cores = readQuantity(bag[GPU_RESOURCES[2]], label(GPU_RESOURCES[2]), warnings);

  // gpu 计数为 0 但显存/算力有值的节点（部分版本只报后两者）也算「有 GPU 资源」
  const hasGpu = count > 0 || memMiB > 0 || cores > 0;

  return { name, warnings, gpu: { hasGpu, count, memMiB, cores, slots: 0, source, devices: [] } };
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
 * Pod 归属节点：
 *   1. `hami.io/vgpu-node` —— 真机（243）唯一可用的节点注解，值是纯节点名
 *   2. Pod 自己的调度结果（`node` / `nodeName` / `spec.nodeName`）
 *   3. `hami.io/vgpu-node-allocated`（旧版本，`node1,0,NVIDIA` → `node1`）
 * 都没有 → null（不伪造节点名，也不把 Pod 算进任何节点）。
 */
function resolveNodeName(pod, annotations) {
  const fromAnnotation = asText(annotations[NODE_NAME_ANNOTATION]).trim();
  if (fromAnnotation) return fromAnnotation;

  const fromPod = asText(pod?.node).trim()
    || asText(pod?.nodeName).trim()
    || asText(pod?.spec?.nodeName).trim();
  if (fromPod) return fromPod;

  const legacy = asText(annotations[NODE_ANNOTATION]).trim();
  if (legacy === '') return null;
  const first = legacy.split(',')[0].trim();
  return first || null;
}

/** 第二段能否当数字（决定这条记录是「带型号」还是「老三段」）。 */
function isNumericField(text) {
  return NUMERIC_FIELD.test(text);
}

/**
 * 型号名（`NVIDIA` / `Tesla T4` / `A100`）几乎总带大写字母；全小写的第二段更像
 * 写坏的显存值，宁可按老口径当显存（→0 + warning），也不要凭空造一个型号出来。
 */
function looksLikeDeviceType(text) {
  return /[A-Z]/.test(text);
}

/**
 * 判定一条设备记录的字段布局 —— 真机与历史格式都要认。
 *
 *   4 段 `<uuid>,<type>,<mem>,<cores>`   243 真机（第二段是型号）
 *   3 段 `<uuid>,<mem>,<cores>`          老 mock / 老 HAMi（第二段是数字）
 *   2 段 `<uuid>,<type>`                 只有型号（无分配数字）
 *   2 段 `<uuid>,<mem>`                  残缺记录：显存有、算力缺
 *
 * 判定方式：第二段能当数字 → 老格式（无 type，数字从第 2 段起）；
 * 否则整体右移一位，第 2 段是 type。三段且第二段非数字属于未记录的脏数据，
 * 只有第二段长得像型号名（带大写）时才按带 type 解释，否则仍按老口径，
 * 免得把「显存写坏了」误判成「型号叫 abc」。
 *
 * @returns {{typeIndex:number,memIndex:number,coresIndex:number}}
 */
function resolveDeviceLayout(fields) {
  const second = fields.length > 1 ? fields[1] : '';
  const typed = !isNumericField(second)
    && (fields.length >= 4 || fields.length === 2 || looksLikeDeviceType(second));
  if (typed) return { typeIndex: 1, memIndex: 2, coresIndex: 3 };
  return { typeIndex: -1, memIndex: 1, coresIndex: 2 };
}

/**
 * 内部：Pod 的 vGPU 分配，带 warnings。
 *
 * 注解值形态（全部要认）：
 *   `GPU-86d1…,NVIDIA,5888,0:;`                     243 真机：四段（带型号）
 *   `GPU-3f2a-...,12288,40:;GPU-9b1c-...,4096,10`   多卡 + `:;` 分隔 + 末项（老三段）
 *   `GPU-9b1c-...,4096,10`                          单卡
 *   `GPU-a,4096,30:GPU-b,2048,20`                   HAMi 原生冒号分隔
 *   `GPU-x, 4096 , 30`                              带空格
 *   `GPU-x,NVIDIA`                                  两段：只有型号
 *
 * 坏条目的确定行为：
 *   - 空项（`;;`、末尾 `:;` 造成的空串）：静默跳过，不产生 warning（这是正常写法）
 *   - 没有设备 ID、或只有 ID 一个字段（如 `garbage`）：整条跳过 + warning
 *   - 数字字段非数字/负数/超上限：该字段按 0 + warning，设备本身保留 ——
 *     「这张卡被这个 Pod 占了」这个事实比容量数字更重要，UI 仍能显示一行
 *   - 有显存但没有算力字段：按 0 + warning（老格式的残缺记录）
 *   - 整条注解一条设备都解析不出来：hasVgpu 仍为 true（注解存在说明 HAMi 在管这张卡），
 *     设备列表为空 + warning
 * @returns {{identity:{namespace:string,name:string,phase:string}, warnings:string[],
 *   vgpu:{hasVgpu:boolean,devices:{id:string,type:string|undefined,memMiB:number,cores:number}[],
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

    const layout = resolveDeviceLayout(fields);
    const type = layout.typeIndex >= 0 ? fields[layout.typeIndex] : '';
    const memRaw = layout.memIndex < fields.length ? fields[layout.memIndex] : undefined;
    const coresRaw = layout.coresIndex < fields.length ? fields[layout.coresIndex] : undefined;

    const memMiB = memRaw === undefined
      ? 0
      : readQuantity(memRaw, `${where} 的设备 ${id} 显存`, warnings);

    let cores = 0;
    if (coresRaw !== undefined) {
      cores = readQuantity(coresRaw, `${where} 的设备 ${id} 算力`, warnings);
    } else if (memRaw !== undefined) {
      warnings.push(`${where} 的设备 ${id} 缺少算力字段，按 0 处理`);
    }

    // type 没写就是 undefined（不是空串）：前端据「有没有这个键」决定要不要渲染型号段
    devices.push({ id, type: type === '' ? undefined : type, memMiB, cores });
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
 * 解析节点的 GPU 容量。
 *
 * 来源顺序：`hami.io/node-nvidia-register`（真机）→ capacity → allocatable。
 * 缺字段返回 `hasGpu=false`、`devices=[]`，不抛异常。
 * @param {unknown} node 归一化 node（含 `allocatable`），或原始 k8s node 对象
 * @returns {{hasGpu:boolean,count:number,memMiB:number,cores:number,slots:number,
 *   source:'register'|'capacity'|'allocatable'|'none',
 *   devices:{id:string,type:string,memMiB:number,cores:number,slots:number,
 *     health:boolean,index:number|null}[]}}
 */
export function readNodeGpu(node) {
  return parseNodeGpu(node).gpu;
}

/**
 * 解析 Pod 的 vGPU 分配。无注解返回 `hasVgpu=false`、空设备列表。
 * @param {unknown} pod 归一化 pod（含 `annotations`），或原始 k8s pod 对象
 * @returns {{hasVgpu:boolean,devices:{id:string,type:string|undefined,memMiB:number,cores:number}[],
 *   totalMemMiB:number,totalCores:number,nodeName:string|null,raw:string|null}}
 */
export function readPodVgpu(pod) {
  return parsePodVgpu(pod).vgpu;
}

/** 节点行里的物理卡累计表：按设备 UUID 建一次，Pod 循环里复用。 */
function deviceRowsOf(nodeRow, store) {
  let map = store.get(nodeRow);
  if (!map) {
    map = new Map();
    for (const device of nodeRow.devices) map.set(device.id, device);
    store.set(nodeRow, map);
  }
  return map;
}

/**
 * 汇总成 overview 用的 gpu 段。
 *
 * 口径（H2 直接依赖）：
 * - `nodes`：只收「有 GPU 资源」的节点。`count` 在真机上 = **物理卡数**（register 条数），
 *   没有 register 的老集群退回 `nvidia.com/gpu`（那时的语义是槽位数）；`slots` 只有
 *   register 能给（= Σ 每卡 count），给不了就是 0（= 未上报，不是 0 个槽位）。
 * - `nodes[].devices`：物理卡明细，按设备 UUID 汇总 Pod 侧分配
 *   （`allocatedMemMiB` / `allocatedCores` / `podCount`）。register 里没有、但 Pod 确实
 *   占了的 UUID 也会追加一行（容量 0，说明「有分配但卡不在清单里」）。
 * - `pods`：只收「写了 vGPU 注解」的 Pod（含解析失败、设备为空的，前端可据此提示）；
 *   解析失败的 Pod 计入 pods[] 但**不**累加到节点（没有任何可信的占用数字）。
 * - 没有 nodeName 的 Pod（`null`）不进任何节点累计，但**计入 totals**（totals 是全局求和）。
 * - `totals.allocatedMemMiB` 与「各节点 allocatedMemMiB 之和」在有未归属 Pod 时**不相等**，
 *   这是刻意的：卡片要能显示「有分配但不知道在哪台节点」的量。
 * - `totals.physicalCount` = 只有 register 才算得出的物理卡数（老集群为 0）；
 *   `totals.slots` = Σ 节点 slots（老集群为 0）。`gpuCount` 保持原义（上报的 GPU 数）。
 * - `hasHami`：任一节点有 GPU 资源 **或** 任一 Pod 有 vGPU 注解 → true。全都没有 → false，
 *   此时 nodes/pods 都是空数组、totals 全 0、warnings 为空（UI 据此完全不渲染该卡片）。
 *
 * @param {{nodes?:unknown,pods?:unknown}|undefined} parts
 * @returns {{hasHami:boolean,
 *   nodes:{name:string,count:number,memMiB:number,cores:number,slots:number,
 *     allocatedMemMiB:number,allocatedCores:number,podCount:number,
 *     devices:{id:string,type:string,memMiB:number,cores:number,slots:number,health:boolean,
 *       allocatedMemMiB:number,allocatedCores:number,podCount:number}[]}[],
 *   pods:{namespace:string,name:string,nodeName:string|null,
 *     devices:{id:string,type:string|undefined,memMiB:number,cores:number}[],
 *     totalMemMiB:number,totalCores:number,phase:string}[],
 *   totals:{gpuCount:number,physicalCount:number,slots:number,memMiB:number,cores:number,
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
  /** 只有 register 才数得出来的物理卡数（老集群 = 0） */
  let physicalCount = 0;
  /** 节点行 → (设备 UUID → 累计行) */
  const deviceMaps = new WeakMap();

  for (const node of nodeList) {
    const { name, warnings, gpu } = parseNodeGpu(node);
    sink.push(...warnings);
    if (!gpu.hasGpu) continue;

    physicalCount += gpu.devices.length;

    const row = {
      name,
      count: gpu.count,
      memMiB: gpu.memMiB,
      cores: gpu.cores,
      slots: gpu.slots,
      allocatedMemMiB: 0,
      allocatedCores: 0,
      podCount: 0,
      devices: gpu.devices.map((device) => ({
        id: device.id,
        type: device.type,
        memMiB: device.memMiB,
        cores: device.cores,
        slots: device.slots,
        health: device.health,
        allocatedMemMiB: 0,
        allocatedCores: 0,
        podCount: 0,
      })),
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

    // 物理卡维度：按设备 UUID 汇总（真机上 Pod 注解里的 UUID 就是 register 的 id）
    const deviceRows = deviceRowsOf(row, deviceMaps);
    for (const device of vgpu.devices) {
      let target = deviceRows.get(device.id);
      if (!target) {
        // register 里没有这张卡（禁用了 / 被换过），也要留一行，否则这部分占用凭空消失
        target = {
          id: device.id,
          type: '',
          memMiB: 0,
          cores: 0,
          slots: 0,
          health: true,
          allocatedMemMiB: 0,
          allocatedCores: 0,
          podCount: 0,
        };
        deviceRows.set(device.id, target);
        row.devices.push(target);
      }
      // 型号以 register 为准；register 没写时用 Pod 注解里的（真机上是厂商名 `NVIDIA`）
      if (target.type === '' && device.type !== undefined && device.type !== '') target.type = device.type;
      target.allocatedMemMiB += device.memMiB;
      target.allocatedCores += device.cores;
      target.podCount += 1;
    }
  }

  // ── totals（全局求和）────────────────────────────────────────────────
  const totals = {
    gpuCount: 0,
    physicalCount,
    slots: 0,
    memMiB: 0,
    cores: 0,
    allocatedMemMiB: 0,
    allocatedCores: 0,
    podCount: 0,
  };
  for (const row of nodeRows) {
    totals.gpuCount += row.count;
    totals.slots += row.slots;
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
