/**
 * 加速卡适配层 —— 兜底适配器（generic）＋ 四家共用的纯工具
 *
 * 背景：上层（A1 渲染器、A4 容量预检、A6 实测采集）只允许通过
 * `server/infra/accelerator/index.js` 的 `getAdapter(vendor)` / `renderAcceleratorResources(...)`
 * 访问厂商差异，任何 `nvidia.com/` 之类的资源键字面量都不该出现在它们里头（否则「换一家 GPU」
 * 就又要改一遍上层）。契约把这一层限定在 5 个文件内，所以四家都要用的纯函数收在本文件，
 * 而不是再开第六个文件。
 *
 * 统一口径（四家一致，否则 A4 没法用一个公式算容量）：
 * - `cores` = **百分比点**，一张整卡记 100 点（HAMi 的 devcore 口径）。它表示「占了多少比例的
 *   算力」，不是厂商真实 FLOPS；真实峰值看 `peakFlops()`。
 * - `memMiB` = MiB。整卡模式下没有显存上报，记 0（= 未知，不是「没有显存」）。
 * - 非数字 / 负数 / 大于 1e9 的数量一律按 0 处理（1e9 MiB ≈ 1 PiB，只能是坏数据）。
 * - 所有解析都不信任输入形状：归一化 node（只有 `allocatable`）与原始 k8s 对象
 *   （`status.allocatable` + `metadata.annotations`）都要能工作 —— 两种都会被上层传进来。
 *
 * 纯函数：零 IO、不抛异常（只有显式校验函数 `coerceAmount` / `coerceCount` / `invalid` 会抛）。
 */

/** 单值上限：1e9 MiB ≈ 1 PiB，超过必然是坏数据（也挡住科学计数法误值）。 */
export const MAX_QUANTITY = 1e9;

/** 一张整卡的算力点数（HAMi devcore=100；只做占用比例的分母，不表示真实算力）。 */
export const WHOLE_CARD_CORES = 100;

/** 普通对象判定：null / 数组 / 原始值都不算。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 映射兜底：非对象一律当空映射（不抛异常）。 */
export function asBag(value) {
  return isPlainObject(value) ? value : {};
}

/** 字符串兜底：null/undefined → ''，其余转字符串（k8s 数量字段可能是 number）。 */
export function asText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** 该字段是否「写了」（null/undefined/空串/纯空白都算没写）。 */
function isPresent(value) {
  return asText(value).trim() !== '';
}

/** 数组兜底：非数组当空列表。 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 读一个数量（k8s 扩展资源值 / HAMi 注解字段）。
 * 坏值不抛异常：非数字、负数、超过 `MAX_QUANTITY` 一律按 0。
 * @param {unknown} raw
 * @returns {number} 落在 [0, MAX_QUANTITY] 的有限数字
 */
export function readQuantity(raw) {
  if (raw === null || raw === undefined) return 0;
  const text = asText(raw).trim();
  if (text === '') return 0;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > MAX_QUANTITY) return 0;
  return value;
}

/**
 * 读一个整数数量（卡数、MiB 这类）。
 * @param {unknown} raw
 * @returns {number} 非负整数，坏值 0
 */
export function readCount(raw) {
  return Math.floor(readQuantity(raw));
}

/**
 * 节点名：归一化 node 在 `name`，原始 k8s 对象在 `metadata.name`。
 * @param {unknown} node
 * @returns {string}
 */
export function nodeName(node) {
  return asText(node?.name).trim() || asText(node?.metadata?.name).trim();
}

/**
 * 节点标签：归一化对象可能带 `labels`，原始对象在 `metadata.labels`。
 * @param {unknown} node
 * @returns {Record<string, string>}
 */
export function nodeLabels(node) {
  const own = asBag(node?.labels);
  return Object.keys(own).length > 0 ? own : asBag(node?.metadata?.labels);
}

/**
 * 节点注解（`hami.io/node-nvidia-register` 就在这里）。
 * @param {unknown} node
 * @returns {Record<string, string>}
 */
export function nodeAnnotations(node) {
  const own = asBag(node?.annotations);
  return Object.keys(own).length > 0 ? own : asBag(node?.metadata?.annotations);
}

/**
 * Pod 注解（`hami.io/vgpu-*`）。
 * @param {unknown} pod
 * @returns {Record<string, string>}
 */
export function podAnnotations(pod) {
  const own = asBag(pod?.annotations);
  return Object.keys(own).length > 0 ? own : asBag(pod?.metadata?.annotations);
}

/**
 * Pod 所在节点：`node` / `nodeName` / `spec.nodeName` 三种形状都认。
 * 没调度（Pending）返回 `null`，不伪造节点名。
 * @param {unknown} pod
 * @returns {string|null}
 */
export function podNodeName(pod) {
  const direct = asText(pod?.node).trim()
    || asText(pod?.nodeName).trim()
    || asText(pod?.spec?.nodeName).trim();
  return direct === '' ? null : direct;
}

/** 节点的 capacity 映射（原始 k8s 在 status.capacity）。 */
function nodeCapacity(node) {
  const own = asBag(node?.capacity);
  return Object.keys(own).length > 0 ? own : asBag(node?.status?.capacity);
}

/** 节点的 allocatable 映射（原始 k8s 在 status.allocatable）。 */
function nodeAllocatable(node) {
  const own = asBag(node?.allocatable);
  return Object.keys(own).length > 0 ? own : asBag(node?.status?.allocatable);
}

/**
 * 读节点上某个扩展资源的数量。
 *
 * 顺序与 `server/k8s/hami.js` 一致：capacity 优先，缺了再退 allocatable。
 * （扩展资源没有系统预留，两者通常相等；优先 capacity 是为了「容量预检看总量」，
 * 而不是看调度器剩下的零头。）
 *
 * @param {unknown} node
 * @param {string} key 例如 `nvidia.com/gpu`
 * @returns {{value:number, from:'capacity'|'allocatable'|'none'}}
 */
export function nodeResource(node, key) {
  const capacity = nodeCapacity(node);
  if (isPresent(capacity[key])) return { value: readQuantity(capacity[key]), from: 'capacity' };
  const allocatable = nodeAllocatable(node);
  if (isPresent(allocatable[key])) return { value: readQuantity(allocatable[key]), from: 'allocatable' };
  return { value: 0, from: 'none' };
}

/**
 * 节点上出现过的所有扩展资源键（capacity ∪ allocatable，保持出现顺序）。
 * @param {unknown} node
 * @returns {string[]}
 */
export function nodeResourceKeys(node) {
  const keys = [];
  const seen = new Set();
  for (const bag of [nodeCapacity(node), nodeAllocatable(node)]) {
    for (const key of Object.keys(bag)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * 汇总一个 Pod 声明的全部扩展资源（多容器求和）。
 *
 * 取值 priorities：`requests` 优先，缺失退 `limits`（扩展资源两者必须相等，
 * 但只写 limits 的清单确实存在）。同时兼容上层传「简化 Pod」（没 spec，只有扁平
 * `resources` 映射，例如容量预检的入参）。
 *
 * @param {unknown} pod
 * @returns {Record<string, number>} 资源键 → 数量（坏值已按 0 处理）
 */
export function podResources(pod) {
  const out = {};
  const spec = asBag(pod?.spec);
  const containers = [...asArray(spec.containers), ...asArray(spec.initContainers)];

  for (const container of containers) {
    const resources = asBag(container?.resources);
    const requests = asBag(resources.requests);
    const limits = asBag(resources.limits);
    for (const key of new Set([...Object.keys(requests), ...Object.keys(limits)])) {
      const raw = isPresent(requests[key]) ? requests[key] : limits[key];
      out[key] = Math.min(MAX_QUANTITY, (out[key] ?? 0) + readQuantity(raw));
    }
  }

  if (containers.length === 0) {
    for (const [key, value] of Object.entries(asBag(pod?.resources))) {
      if (isPlainObject(value)) continue; // `resources.requests` 这种嵌套键不是数量
      out[key] = readQuantity(value);
    }
  }

  return out;
}

/**
 * 把总量均摊到 N 张卡上，**整数**且 Σ 严格等于总量（余数从第一张起各 +1）。
 * 用于「只知道节点总量、不知道单卡明细」的厂商（AMD / 部分昇腾 / 兜底）。
 * @param {number} total
 * @param {number} count
 * @returns {number[]}
 */
export function spreadTotal(total, count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  const value = Math.max(0, Math.trunc(Number(total) || 0));
  if (n === 0) return [];
  const base = Math.floor(value / n);
  const remainder = value - base * n;
  return Array.from({ length: n }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * 生成 N 张「整卡」设备记录（没有 UUID 上报的厂商用）。
 *
 * `id` 是**占位 ID**（`<资源键>#0`、`#1`…），只保证同一次调用内唯一、稳定；
 * 它不与节点上的真实设备 ID 对应，所以整卡厂商**只能按张数**核对占用，不能按 ID 匹配。
 *
 * @param {{count:number, idPrefix?:string, type?:string, memTotalMiB?:number,
 *   coresTotal?:number, slots?:number}} options
 * @returns {{id:string,type:string,memMiB:number,cores:number,slots:number,health:boolean}[]}
 */
export function wholeCardDevices({
  count,
  idPrefix = '',
  type = '',
  memTotalMiB = 0,
  coresTotal = 0,
  slots = 1,
} = {}) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (n === 0) return [];
  const mem = spreadTotal(memTotalMiB, n);
  const cores = spreadTotal(coresTotal, n);
  const perCardSlots = Math.max(0, Math.trunc(Number(slots) || 0));
  return Array.from({ length: n }, (_, index) => ({
    id: `${idPrefix}${index}`,
    type,
    memMiB: mem[index],
    cores: cores[index],
    slots: perCardSlots,
    health: true,
  }));
}

/**
 * 空容量（节点没有该厂商的加速卡）：形状与正常结果一致，上层不用写 if。
 * @param {string} [resourceKey] 该厂商的整卡资源键（未知时传 ''）
 * @returns {{devices:object[],totalMemMiB:number,totalCores:number,slots:number,
 *   canShare:boolean,resourceKey:string,source:'none'}}
 */
export function emptyCapacity(resourceKey = '') {
  return {
    devices: [],
    totalMemMiB: 0,
    totalCores: 0,
    slots: 0,
    canShare: false,
    resourceKey,
    source: 'none',
  };
}

/**
 * 空分配（Pod 没有占用该厂商的加速卡）。
 * @param {string|null} [nodeName]
 * @returns {{devices:object[],totalMemMiB:number,totalCores:number,
 *   nodeName:string|null,source:'none'}}
 */
export function emptyAllocation(nodeName = null) {
  return { devices: [], totalMemMiB: 0, totalCores: 0, nodeName, source: 'none' };
}

/** dtype 归一化：只认确实有含义的桶，其它一律 null（不做静默折算，免得编数字）。 */
const DTYPE_BUCKETS = new Map([
  ['fp16', 'fp16'],
  ['bf16', 'fp16'],
  ['half', 'fp16'],
  ['float16', 'fp16'],
  ['bfloat16', 'fp16'],
  ['fp8', 'fp8'],
  ['e4m3', 'fp8'],
  ['e5m2', 'fp8'],
  ['fp8e4m3', 'fp8'],
  ['fp8e5m2', 'fp8'],
]);

/** 模型名归一化：小写、非字母数字压成单空格（`RTX 4090` → `rtx 4090`）。 */
function normalizeModel(text) {
  return asText(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** 正则转义（别名里有 `-`、`.` 之类时也要安全）。 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 别名是否作为**独立词**出现：`4090` 命中 `rtx 4090`，但不命中 `rtx 4090d`。 */
function hasAlias(haystack, alias) {
  return new RegExp(`(?:^| )${escapeRegex(alias)}(?: |$)`).test(haystack);
}

/**
 * 笔记本/移动版后缀：这些型号的同名 GPU 频率与功耗墙都不同，桌面表的数字会高估，
 * 所以直接判「未收录」，而不是拿桌面版的峰值凑数。
 */
const MOBILE_MARKER_RE = /(?:^| )(?:laptop|mobile|max q|maxq)(?: |$)/;

/**
 * 查峰值算力表（nvidia / amd / ascend 共用一套匹配规则）。
 *
 * 表项形如 `{ aliases: ['rtx 4090', '4090'], fp16: 165.2, fp8: 330.3 }`；
 * dtype 归一化到 `fp16`（含 bf16）/ `fp8`，其它 dtype 返回 null。
 * 命中型号但该 dtype 没收录 → null（**不**退回 fp16，避免把「不知道」当「等于 fp16」）。
 *
 * @param {{aliases:string[],fp16?:number|null,fp8?:number|null}[]} table
 * @param {string} modelName
 * @param {string} [dtype='fp16']
 * @returns {number|null} TFLOPS
 */
export function matchPeak(table, modelName, dtype = 'fp16') {
  if (typeof modelName !== 'string') return null;
  const haystack = normalizeModel(modelName);
  if (haystack === '') return null;
  if (MOBILE_MARKER_RE.test(haystack)) return null;

  const rawDtype = asText(dtype).trim().toLowerCase();
  const bucket = rawDtype === '' ? 'fp16' : DTYPE_BUCKETS.get(rawDtype);
  if (!bucket) return null;

  for (const entry of table) {
    if (!entry.aliases.some((alias) => hasAlias(haystack, alias))) continue;
    const value = entry[bucket];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  return null;
}

/**
 * 造一个「参数不合法」的 Error，带稳定 code 供上层分类成 400。
 * @param {string} message 中文、能指导操作
 * @returns {Error & {code:string}}
 */
export function invalid(message) {
  const error = new Error(message);
  error.code = 'ACCELERATOR_INVALID';
  return error;
}

/**
 * 校验并读取一个数量参数（渲染资源时用）：非数字 / 负数 / 超上限直接抛。
 * @param {unknown} raw
 * @param {string} label 字段名（错误信息里带上，便于定位表单字段）
 * @returns {number}
 */
export function coerceAmount(raw, label) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw invalid(`${label} 必须是数字（收到 "${asText(raw)}"）`);
  if (value < 0) throw invalid(`${label} 不能为负数（收到 ${value}）`);
  if (value > MAX_QUANTITY) throw invalid(`${label} 超出上限 ${MAX_QUANTITY}（收到 ${value}）`);
  return value;
}

/**
 * 校验并读取一个整数参数（加速卡数）：小数、非数字、负数都抛。
 * @param {unknown} raw
 * @param {string} label
 * @returns {number}
 */
export function coerceCount(raw, label) {
  const value = coerceAmount(raw, label);
  if (!Number.isInteger(value)) throw invalid(`${label} 必须是整数（收到 ${value}）`);
  return value;
}

// ─── 兜底适配器 ────────────────────────────────────────────────────────────

/** 任意设备插件的整卡资源键：`<domain>.com/gpu`（nvidia.com/gpu、amd.com/gpu…）。 */
const GPU_KEY_RE = /^[a-z0-9][a-z0-9.-]*\.com\/gpu$/i;

/** 设备插件爱用的节点标签：`<domain>.com/gpu.present: "true"`。 */
const GPU_LABEL_RE = /\.com\/gpu\.present$/i;

/** 在节点上找第一个「数量 > 0」的 `*.com/gpu` 资源键。 */
function findGpuKey(node) {
  for (const key of nodeResourceKeys(node)) {
    if (GPU_KEY_RE.test(key) && nodeResource(node, key).value > 0) return key;
  }
  return null;
}

/** 节点是否有 `*.com/gpu.present=true` 这种「装了 GPU」的标签。 */
function hasGpuLabel(node) {
  const labels = nodeLabels(node);
  return Object.keys(labels).some((key) => GPU_LABEL_RE.test(key)
    && asText(labels[key]).trim().toLowerCase() === 'true');
}

/** 兜底适配器的厂商名。 */
export const vendor = 'generic';

/** 兜底能力：只做整卡计数，不切分、不限算力、没有固定资源键。 */
export const capabilities = Object.freeze({
  canShare: false,
  canLimitCores: false,
  memUnitMiB: 0,
  wholeCardResource: null,
});

/**
 * 节点是否装了一块「未知厂商」的加速卡。
 * @param {unknown} node
 * @returns {boolean}
 */
export function detectFromNode(node) {
  if (!node || typeof node !== 'object') return false;
  return findGpuKey(node) !== null || hasGpuLabel(node);
}

/**
 * 读容量：只数张数（`*.com/gpu` 的值），显存/算力未知记 0。
 * @param {unknown} node
 * @returns {{devices:object[],totalMemMiB:number,totalCores:number,slots:number,
 *   canShare:boolean,resourceKey:string,source:'resource'|'none'}}
 */
export function readCapacity(node) {
  const key = findGpuKey(node);
  if (key === null) return emptyCapacity('');
  const count = readCount(nodeResource(node, key).value);
  const coresTotal = count * WHOLE_CARD_CORES;
  return {
    devices: wholeCardDevices({ count, idPrefix: `${key}#`, coresTotal }),
    totalMemMiB: 0,
    totalCores: coresTotal,
    slots: count,
    canShare: false,
    resourceKey: key,
    source: 'resource',
  };
}

/**
 * 读分配：只认整卡占用（Pod 声明的 `*.com/gpu` 数量）。
 * @param {unknown} pod
 * @returns {{devices:object[],totalMemMiB:number,totalCores:number,
 *   nodeName:string|null,source:'resource'|'none'}}
 */
export function readAllocation(pod) {
  const nodeNameOfPod = podNodeName(pod);
  const declared = podResources(pod);
  const key = Object.keys(declared).find((name) => GPU_KEY_RE.test(name) && declared[name] > 0);
  if (key === undefined) return emptyAllocation(nodeNameOfPod);

  const count = readCount(declared[key]);
  const coresTotal = count * WHOLE_CARD_CORES;
  return {
    devices: wholeCardDevices({ count, idPrefix: `${key}#alloc-`, coresTotal }),
    totalMemMiB: 0,
    totalCores: coresTotal,
    nodeName: nodeNameOfPod,
    source: 'resource',
  };
}

/**
 * 渲染资源片段。
 *
 * 兜底适配器**没有**固定的资源键（不同设备插件写法不同），所以要么显式给
 * `resourceKey`（通常是 `readCapacity(node).resourceKey`），要么报错 ——
 * 静默返回 `{}` 会让 Pod 不带 GPU 请求跑起来，最后在容器里报找不到设备，更难查。
 *
 * @param {{accelerators?:unknown, memoryMiB?:unknown, coresPercent?:unknown,
 *   resourceKey?:string}} [request]
 * @returns {Record<string,string>} k8s resources 片段（值一律字符串）
 */
export function renderResources({ accelerators, memoryMiB, coresPercent, resourceKey } = {}) {
  const count = coerceCount(accelerators, 'accelerators（加速卡数）');
  const mem = Math.trunc(coerceAmount(memoryMiB, 'memoryMiB（显存配额）'));
  const cores = coerceAmount(coresPercent, 'coresPercent（算力百分比）');

  if (mem > 0 || cores > 0) {
    throw invalid('兜底（generic）适配器只支持整卡计数，不能申请显存/算力配额：'
      + `请把 memoryMiB 与 coresPercent 设为 0（当前 memoryMiB=${mem}、coresPercent=${cores}）`);
  }
  if (count === 0) return {};

  const key = asText(resourceKey).trim();
  if (key === '') {
    throw invalid('兜底（generic）适配器没有固定的加速卡资源键：'
      + '请用 readCapacity(node).resourceKey 取到该集群的真实资源键后显式传入 resourceKey');
  }
  return { [key]: String(count) };
}

/**
 * 探测命令：未知厂商没有通用工具，返回空串（调用方据此跳过实测采集）。
 * @returns {string}
 */
export function probeCommand() {
  return '';
}

/**
 * 峰值算力：兜底适配器不认识型号，一律 null（不做推测）。
 * @param {string} _modelName
 * @param {string} [_dtype]
 * @returns {null}
 */
export function peakFlops(_modelName, _dtype) {
  return null;
}

/** 兜底适配器对象（与另外三家同一套接口）。 */
const adapter = Object.freeze({
  vendor,
  capabilities,
  detectFromNode,
  readCapacity,
  readAllocation,
  renderResources,
  probeCommand,
  peakFlops,
});

export default adapter;
