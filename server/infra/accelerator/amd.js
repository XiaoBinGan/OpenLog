/**
 * AMD 加速卡适配器（ROCm / `amd.com/gpu` 整卡语义）
 *
 * 事实基础（不推测）：
 *   · k8s 里 AMD 的设备插件只报**一个**扩展资源 `amd.com/gpu`，值是**整卡张数**；
 *   · **没有** vGPU 切分能力 → 既没有 `gpumem`/`gpucores` 这类配额资源，
 *     也没有 HAMi 那套节点/Pod 注解（`hami.io/node-nvidia-register` 之类是 NVIDIA 插件的）；
 *   · 因此显存、单卡型号都不在 k8s API 里：`memMiB` 记 0（= 未知，不是没有显存），
 *     型号只能退到设备插件写的节点标签（`amd.com/gpu.product` 等，标准与否随发行版）；
 *   · 一张整卡的算力点数记 100（HAMi devcore 口径，只为容量预检有个统一分母，
 *     `canLimitCores: false` 表示这个点数不能拿来下发配额）。
 *
 * 上层影响：`readAllocation` 只能数「这个 Pod 占了几张整卡」，设备 ID 是不存在的，
 * 所以占位 ID（`amd.com/gpu#alloc-0`）**不要**拿去和节点设备做匹配，核对占用只能按张数。
 */
import {
  WHOLE_CARD_CORES,
  asText,
  coerceAmount,
  coerceCount,
  emptyAllocation,
  emptyCapacity,
  invalid,
  matchPeak,
  nodeLabels,
  nodeResource,
  podNodeName,
  podResources,
  readCount,
  wholeCardDevices,
} from './generic.js';

/** 唯一的扩展资源键（整卡张数）。 */
const GPU = 'amd.com/gpu';

/** 可能带型号的节点标签（AMD 设备插件各发行版写法不一，按优先级取第一个非空）。 */
const PRODUCT_LABELS = ['amd.com/gpu.product', 'amd.com/gpu.product-name', 'amd.com/gpu.family'];

/** 型号 → 峰值算力（fp16/bf16 稠密 TFLOPS）。只收录确实查得到的型号。 */
const PEAKS = [
  { aliases: ['mi300x', 'instinct mi300x'], fp16: 1307 },
  { aliases: ['mi250x', 'instinct mi250x'], fp16: 383 },
  { aliases: ['mi210', 'instinct mi210'], fp16: 181 },
  { aliases: ['mi100', 'instinct mi100'], fp16: 123 },
];

/** 厂商名。 */
export const vendor = 'amd';

/** 能力声明：整卡为主，不支持 vGPU 切分，也不支持算力配额。 */
export const capabilities = Object.freeze({
  canShare: false,
  canLimitCores: false,
  memUnitMiB: 0,
  wholeCardResource: GPU,
});

/**
 * 节点是否装了 AMD 卡。
 *
 * 证据：`amd.com/gpu` > 0，或设备插件标签（`amd.com/gpu.present: "true"`、型号标签）。
 * 只看资源键会漏掉「卡全被分完，allocatable 归 0」的节点。
 *
 * @param {unknown} node
 * @returns {boolean}
 */
export function detectFromNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (nodeResource(node, GPU).value > 0) return true;

  const labels = nodeLabels(node);
  if (asText(labels['amd.com/gpu.present']).trim().toLowerCase() === 'true') return true;
  return PRODUCT_LABELS.some((key) => asText(labels[key]).trim() !== '');
}

/** 从节点标签推断型号（取不到返回空串，不编名字）。 */
function productOf(node) {
  const labels = nodeLabels(node);
  for (const key of PRODUCT_LABELS) {
    const value = asText(labels[key]).trim();
    if (value !== '') return value;
  }
  return '';
}

/**
 * 读节点容量：按 `amd.com/gpu` 计数，一张卡一条整卡记录。
 *
 * 附加字段：`slots`（= 卡数，AMD 没有 vGPU 槽位概念，槽位就是整卡）、
 * `canShare`（恒 false）、`resourceKey`、`source`。
 *
 * @param {unknown} node
 * @returns {{devices:{id:string,type:string,memMiB:number,cores:number,slots:number,
 *   health:boolean}[],totalMemMiB:number,totalCores:number,slots:number,canShare:boolean,
 *   resourceKey:string,source:'resource'|'none'}}
 */
export function readCapacity(node) {
  const count = readCount(nodeResource(node, GPU).value);
  if (count === 0) return emptyCapacity(GPU);

  const coresTotal = count * WHOLE_CARD_CORES;
  return {
    devices: wholeCardDevices({
      count,
      idPrefix: `${GPU}#`,
      type: productOf(node),
      memTotalMiB: 0,
      coresTotal,
    }),
    totalMemMiB: 0,
    totalCores: coresTotal,
    slots: count,
    canShare: false,
    resourceKey: GPU,
    source: 'resource',
  };
}

/**
 * 读 Pod 占用：只认整卡（`resources` 里的 `amd.com/gpu` 数量，多容器求和）。
 *
 * @param {unknown} pod
 * @returns {{devices:{id:string,type:string,memMiB:number,cores:number}[],
 *   totalMemMiB:number,totalCores:number,nodeName:string|null,
 *   source:'resource'|'none'}}
 */
export function readAllocation(pod) {
  const nodeName = podNodeName(pod);
  const count = readCount(podResources(pod)[GPU]);
  if (count === 0) return emptyAllocation(nodeName);

  const coresTotal = count * WHOLE_CARD_CORES;
  return {
    devices: wholeCardDevices({ count, idPrefix: `${GPU}#alloc-`, coresTotal }),
    totalMemMiB: 0,
    totalCores: coresTotal,
    nodeName,
    source: 'resource',
  };
}

/**
 * 渲染 k8s resources 片段：只写整卡张数。
 *
 * AMD 没有 `gpumem`/`gpucores` 这类资源，写了 Pod 会永远 Pending（调度器找不到该资源），
 * 所以 `memoryMiB` / `coresPercent` 非 0 时**直接抛**，而不是静默丢掉用户的配额意图。
 *
 * @param {{accelerators?:unknown, memoryMiB?:unknown, coresPercent?:unknown}} [request]
 * @returns {Record<string,string>} 例如 `{'amd.com/gpu':'2'}`
 * @throws {Error & {code:'ACCELERATOR_INVALID'}} 想要切分/限算力时
 */
export function renderResources({ accelerators, memoryMiB, coresPercent } = {}) {
  const count = coerceCount(accelerators, 'accelerators（加速卡数）');
  const mem = Math.trunc(coerceAmount(memoryMiB, 'memoryMiB（显存配额）'));
  const cores = coerceAmount(coresPercent, 'coresPercent（算力百分比）');

  if (mem > 0 || cores > 0) {
    throw invalid('AMD 加速卡只支持整卡申请（没有 vGPU 切分资源）：请把 memoryMiB 与 '
      + `coresPercent 设为 0（当前 memoryMiB=${mem}、coresPercent=${cores}）`);
  }
  if (count === 0) return {};
  return { [GPU]: String(count) };
}

/**
 * 探测命令。
 * @returns {string}
 */
export function probeCommand() {
  return 'rocm-smi';
}

/**
 * 型号峰值算力（fp16/bf16 稠密 TFLOPS）。
 * AMD 这张表只有 fp16 口径，其它 dtype 返回 null（不做换算，免得编数字）。
 * @param {string} modelName 例如 `Instinct MI300X`
 * @param {string} [dtype='fp16']
 * @returns {number|null} TFLOPS
 */
export function peakFlops(modelName, dtype = 'fp16') {
  return matchPeak(PEAKS, modelName, dtype);
}

/** 适配器对象（与另外三家同一套接口）。 */
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
