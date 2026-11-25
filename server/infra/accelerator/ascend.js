/**
 * 华为昇腾（Ascend）加速卡适配器
 *
 * 事实基础（不推测）：
 *   · HAMi 的 Ascend 设备插件注册的扩展资源是 `huawei.com/Ascend910`（值是**整卡张数**）；
 *     装了切分版本时还会多一个 `huawei.com/Ascend910-memory`（MiB 显存配额）；
 *   · 型号写进资源键名里（`Ascend910` / `Ascend910B` / `Ascend310P` 是不同代际的产品），
 *     k8s 里**没有**类似 `nvidia.com/gpucores` 的算力配额资源 → `canLimitCores: false`；
 *   · `canShare` 取决于该集群到底有没有装 `-memory` 资源：只有它存在时才能按显存切分，
 *     否则只能整卡。这是**按节点实际上报**判定的，不是按厂商能力猜的；
 *   · 探测命令 `npu-smi`（昇腾官方工具，`rocm-smi`/`nvidia-smi` 在昇腾机器上不存在）。
 *
 * 上层影响：没有 `-memory` 资源的集群里，`readAllocation` 只能数整卡张数，
 * 此时设备 ID 是占位值（不可与节点设备做 UUID 匹配），核对占用按张数。
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
  nodeResourceKeys,
  podNodeName,
  podResources,
  readCount,
  wholeCardDevices,
} from './generic.js';

/** 整卡资源键（HAMi Ascend 插件注册的那个）。 */
const GPU = 'huawei.com/Ascend910';
/** 显存配额资源键（只有装了切分版本的集群才有）。 */
const MEMORY = 'huawei.com/Ascend910-memory';

/**
 * 昇腾资源键的通用形态：`huawei.com/Ascend910`、`huawei.com/Ascend910B`、
 * `huawei.com/Ascend310P`、以及它们的 `-memory` 变体。
 * 型号在键名里，所以「有没有昇腾卡」必须按前缀判，不能只认 910 这一个键。
 */
const ASCEND_KEY_RE = /^huawei\.com\/ascend/i;
/** 显存配额键（`...-memory`）。 */
const ASCEND_MEMORY_RE = /^huawei\.com\/ascend[^/]*-memory$/i;
/** 算力配额键（`...-cores`，部分 HAMi 版本会注册；本适配器只把它当分母，不下发）。 */
const ASCEND_CORES_RE = /^huawei\.com\/ascend[^/]*-cores$/i;

/** 型号 → 峰值算力（fp16/bf16 稠密 TFLOPS）。只收录公开规格里查得到的。 */
const PEAKS = [
  { aliases: ['ascend910b', '910b'], fp16: 376 },
  { aliases: ['ascend310p', '310p'], fp16: 70 },
];

/** 厂商名。 */
export const vendor = 'ascend';

/** 能力声明：能否切分按节点实际上报，算力配额不支持。 */
export const capabilities = Object.freeze({
  canShare: true,
  canLimitCores: false,
  memUnitMiB: 1,
  wholeCardResource: GPU,
});

/** 节点上出现过的昇腾整卡资源键（排除 `-memory` / `-cores` 配额键）。 */
function gpuKeysOf(node) {
  return nodeResourceKeys(node).filter((key) => ASCEND_KEY_RE.test(key)
    && !ASCEND_MEMORY_RE.test(key)
    && !ASCEND_CORES_RE.test(key));
}

/** 节点上出现过的昇腾显存资源键（`...-memory`）。 */
function memoryKeysOf(node) {
  return nodeResourceKeys(node).filter((key) => ASCEND_MEMORY_RE.test(key));
}

/** 节点上出现过的昇腾算力资源键（`...-cores`）。 */
function coresKeysOf(node) {
  return nodeResourceKeys(node).filter((key) => ASCEND_CORES_RE.test(key));
}

/** 节点声明的显存配额总量（MiB；没有该资源时 0）。 */
function nodeMemoryMiB(node) {
  return memoryKeysOf(node)
    .reduce((sum, key) => sum + readCount(nodeResource(node, key).value), 0);
}

/** 节点声明的算力配额总量（百分比点；没有该资源时 0）。 */
function nodeCores(node) {
  return coresKeysOf(node)
    .reduce((sum, key) => sum + readCount(nodeResource(node, key).value), 0);
}

/**
 * 节点是否装了昇腾卡。
 *
 * 证据：任意 `huawei.com/Ascend*` 资源键 > 0，或设备插件标签
 * （`huawei.com/Ascend910.present: "true"` 之类）；`-memory` 键出现也算有卡
 * （它是配额资源，只有装了切分版本才会出现）。
 * 只看整卡资源会漏掉「卡全被分完 → allocatable 归 0」的节点。
 *
 * @param {unknown} node
 * @returns {boolean}
 */
export function detectFromNode(node) {
  if (!node || typeof node !== 'object') return false;

  for (const key of nodeResourceKeys(node)) {
    if (!ASCEND_KEY_RE.test(key)) continue;
    // 配额键（-memory / -cores）出现即说明装了切分版本；整卡键看数量
    if (ASCEND_MEMORY_RE.test(key) || ASCEND_CORES_RE.test(key)) return true;
    if (nodeResource(node, key).value > 0) return true;
  }

  const labels = nodeLabels(node);
  return Object.entries(labels).some(([key, value]) => ASCEND_KEY_RE.test(key)
    && asText(value).trim().toLowerCase() === 'true');
}

/**
 * 读节点容量。
 *
 * 取值：所有 `huawei.com/Ascend*` 整卡资源键的数量之和（一个集群通常只有一种型号，
 * 求和是为了兼容 `Ascend910` 与 `Ascend310P` 混布的节点；`-memory` / `-cores`
 * 是配额键，**不参与**卡数，否则卡数会被算多）。
 * 显存取所有 `...-memory` 之和、算力取所有 `...-cores` 之和（都没有时按整卡 100 点计），
 * 设备级数字按张数均摊（Σ 严格等于总量）。
 *
 * @param {unknown} node
 * @returns {{devices:{id:string,type:string,memMiB:number,cores:number,slots:number,
 *   health:boolean}[],totalMemMiB:number,totalCores:number,slots:number,canShare:boolean,
 *   resourceKey:string,source:'resource'|'none'}}
 */
export function readCapacity(node) {
  const keys = gpuKeysOf(node);
  const count = keys.reduce((sum, key) => sum + readCount(nodeResource(node, key).value), 0);
  if (count === 0) return emptyCapacity(GPU);

  const mem = nodeMemoryMiB(node);
  // 算力：集群报了 `-cores` 就用它，否则按「一张整卡 100 点」计（与 NVIDIA 同口径）
  const coresFromResource = nodeCores(node);
  const coresTotal = coresFromResource > 0 ? coresFromResource : count * WHOLE_CARD_CORES;
  // 型号：资源键名去掉域前缀（`huawei.com/Ascend910` → `Ascend910`），取第一个有卡数的键
  const primary = keys.find((key) => nodeResource(node, key).value > 0) ?? GPU;

  return {
    devices: wholeCardDevices({
      count,
      idPrefix: `${primary}#`,
      type: primary.split('/').pop() ?? '',
      memTotalMiB: mem,
      coresTotal,
    }),
    totalMemMiB: mem,
    totalCores: coresTotal,
    slots: count,
    // 只有报了 `-memory`（或 `-cores`）资源的集群才有切分资源可用
    canShare: mem > 0 || memoryKeysOf(node).length > 0 || coresKeysOf(node).length > 0,
    resourceKey: primary,
    source: 'resource',
  };
}

/**
 * 读 Pod 占用：整卡张数 +（可选）显存配额，多容器求和。
 *
 * @param {unknown} pod
 * @returns {{devices:{id:string,type:string,memMiB:number,cores:number}[],
 *   totalMemMiB:number,totalCores:number,nodeName:string|null,
 *   source:'resource'|'none'}}
 */
export function readAllocation(pod) {
  const nodeName = podNodeName(pod);
  const declared = podResources(pod);
  const keys = Object.keys(declared);
  const gpuKey = keys.find((key) => ASCEND_KEY_RE.test(key)
    && !ASCEND_MEMORY_RE.test(key)
    && !ASCEND_CORES_RE.test(key));
  const memoryKeys = keys.filter((key) => ASCEND_MEMORY_RE.test(key));
  const coresKeys = keys.filter((key) => ASCEND_CORES_RE.test(key));

  const count = gpuKey === undefined ? 0 : readCount(declared[gpuKey]);
  const mem = memoryKeys.reduce((sum, key) => sum + readCount(declared[key]), 0);
  const coresFromResource = coresKeys.reduce((sum, key) => sum + readCount(declared[key]), 0);
  if (count === 0 && mem === 0 && coresFromResource === 0) return emptyAllocation(nodeName);

  const coresTotal = coresFromResource > 0 ? coresFromResource : count * WHOLE_CARD_CORES;
  return {
    devices: wholeCardDevices({
      count,
      idPrefix: `${gpuKey ?? GPU}#alloc-`,
      memTotalMiB: mem,
      coresTotal,
    }),
    totalMemMiB: mem,
    totalCores: coresTotal,
    nodeName,
    source: 'resource',
  };
}

/**
 * 渲染 k8s resources 片段。
 *
 * 语义：
 *   · `accelerators` = 整卡张数（必填 ≥ 1 才有意义）
 *   · `memoryMiB > 0` → 追加 `huawei.com/Ascend910-memory`（切分集群）；
 *     `memoryMiB === 0` → 整卡，只写 `huawei.com/Ascend910`
 *   · `coresPercent` **必须为 0**：本层不约定昇腾的算力配额资源名（部分 HAMi 版本
 *     会注册 `...-cores`，语义未在本适配器锁定），写了不存在的资源会让 Pod 永远 Pending，
 *     所以直接抛而不是静默丢字段；真要用需在这里显式打开并同步 `capabilities.canLimitCores`
 *
 * @param {{accelerators?:unknown, memoryMiB?:unknown, coresPercent?:unknown}} [request]
 * @returns {Record<string,string>} 例如 `{'huawei.com/Ascend910':'1','huawei.com/Ascend910-memory':'32768'}`
 * @throws {Error & {code:'ACCELERATOR_INVALID'}} 想限算力 / 显存配额没有卡时
 */
export function renderResources({ accelerators, memoryMiB, coresPercent } = {}) {
  const count = coerceCount(accelerators, 'accelerators（加速卡数）');
  const mem = Math.trunc(coerceAmount(memoryMiB, 'memoryMiB（显存配额）'));
  const cores = coerceAmount(coresPercent, 'coresPercent（算力百分比）');

  if (cores > 0) {
    throw invalid('本适配器不下发昇腾算力配额（不猜 -cores 资源的语义）：'
      + `请把 coresPercent 设为 0（当前 ${cores}）；确实需要限算力请先确认集群有 ...-cores 资源`);
  }
  if (mem > 0 && count === 0) {
    throw invalid('申请显存配额时必须同时申请加速卡：accelerators 至少为 1，memoryMiB 才有意义');
  }
  if (count === 0) return {};

  const out = { [GPU]: String(count) };
  if (mem > 0) out[MEMORY] = String(mem);
  return out;
}

/**
 * 探测命令。
 * @returns {string}
 */
export function probeCommand() {
  return 'npu-smi';
}

/**
 * 型号峰值算力（fp16/bf16 稠密 TFLOPS）。
 * @param {string} modelName 例如 `Ascend910B`、`Ascend310P`
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
