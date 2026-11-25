/**
 * NVIDIA 加速卡适配器（HAMi vGPU 语义）
 *
 * 资源键：`nvidia.com/gpu`（= vGPU 槽位数）、`nvidia.com/gpumem`（MiB）、
 * `nvidia.com/gpucores`（百分比点）。
 *
 * 容量与分配**不在这里重新解析**：真机（243，k3s + HAMi）的格式已经钉死在
 * `server/k8s/hami.js` 里 ——
 *   · 节点 `hami.io/node-nvidia-register`（JSON 数组：id/type/devmem/devcore/count/health）
 *   · Pod `hami.io/vgpu-devices-allocated`（四段 `uuid,TYPE,memMiB,cores`，兼容三段/两段）
 * 那里已经处理了真机四段、老版本三段、两段、`;`/`:` 分隔、末尾空项、坏 JSON 降级。
 * 再抄一份只会有两个后果：两份实现迟早不一致；真机再变格式要改两处。
 * 所以本文件只做「适配器接口 ↔ hami.js 结果」的转译，外加 hami.js 不管的两件事：
 *   1) 纯 device plugin 集群（没有 HAMi 注解，只有 `nvidia.com/gpu`）的整卡语义；
 *   2) `renderResources` / `probeCommand` / `peakFlops`。
 */
import { readNodeGpu, readPodVgpu } from '../../k8s/hami.js';
import {
  asText,
  coerceAmount,
  coerceCount,
  emptyAllocation,
  emptyCapacity,
  invalid,
  matchPeak,
  nodeAnnotations,
  nodeLabels,
  podAnnotations,
  podNodeName,
  podResources,
  readCount,
  wholeCardDevices,
} from './generic.js';

/** 整卡资源键（k8s 扩展资源名）。 */
const GPU = 'nvidia.com/gpu';
/** 显存配额资源键（MiB）。 */
const GPUMEM = 'nvidia.com/gpumem';
/** 算力配额资源键（百分比点，一张整卡 = 100）。 */
const GPUCORES = 'nvidia.com/gpucores';

/** HAMi 写在 Pod 上的节点名注解（真机只有这个，比 legacy 可靠）。 */
const VGPU_NODE = 'hami.io/vgpu-node';
/** 老版本 HAMi 的节点名注解：`<node>,<index>,<type>`。 */
const VGPU_NODE_LEGACY = 'hami.io/vgpu-node-allocated';

/** 型号 → 峰值算力（fp16/bf16 稠密 TFLOPS，fp8 只列有意义的型号）。 */
const PEAKS = [
  { aliases: ['rtx 5090', '5090'], fp16: 209.5, fp8: 419 },
  { aliases: ['rtx 5080', '5080'], fp16: 112.6, fp8: 225 },
  { aliases: ['rtx 4090', '4090'], fp16: 165.2, fp8: 330.3 },
  { aliases: ['rtx 4080', '4080'], fp16: 97.5, fp8: 195 },
  { aliases: ['rtx 3090', '3090'], fp16: 71, fp8: null },
  { aliases: ['rtx 3080', '3080'], fp16: 59.5, fp8: null },
  { aliases: ['h200'], fp16: 989, fp8: 1979 },
  { aliases: ['h100'], fp16: 989, fp8: 1979 },
  { aliases: ['a100'], fp16: 312, fp8: null },
  { aliases: ['l40s'], fp16: 362, fp8: 733 },
  { aliases: ['l4'], fp16: 121, fp8: 242 },
  { aliases: ['t4'], fp16: 65, fp8: null },
  { aliases: ['v100'], fp16: 125, fp8: null },
  { aliases: ['h20'], fp16: 148, fp8: 296 },
  { aliases: ['a6000'], fp16: 154.8, fp8: null },
  { aliases: ['a5000'], fp16: 54.5, fp8: null },
];

/** 厂商名。 */
export const vendor = 'nvidia';

/**
 * 能力声明（HAMi 语义下 NVIDIA 能做 vGPU 切分）。
 * 注意与 `readCapacity().canShare` 的区别：这里是「该厂商在 HAMi 下能做什么」，
 * 那里是「这台节点实际上报了什么」（纯 device plugin 集群不能切分）。
 */
export const capabilities = Object.freeze({
  canShare: true,
  canLimitCores: true,
  memUnitMiB: 1,
  wholeCardResource: GPU,
});

/**
 * 节点是否装了 NVIDIA 卡。
 *
 * 证据优先级（任一条成立即可）：资源键、`hami.io/node-nvidia-register` 注解、
 * 设备插件标签（`nvidia.com/gpu.present: "true"` / `nvidia.com/gpu.product`）。
 * 只看 `allocatable` 会漏掉「卡已分完 → allocatable 是 0 但节点确实是 GPU 节点」的情况，
 * 所以注解与标签也要看。
 *
 * @param {unknown} node
 * @returns {boolean}
 */
export function detectFromNode(node) {
  if (!node || typeof node !== 'object') return false;

  const gpu = readNodeGpu(node);
  if (gpu.hasGpu) return true;

  const annotations = nodeAnnotations(node);
  if (asText(annotations['hami.io/node-nvidia-register']).trim() !== '') return true;

  const labels = nodeLabels(node);
  if (asText(labels['nvidia.com/gpu.present']).trim().toLowerCase() === 'true') return true;
  if (asText(labels['nvidia.com/gpu.product']).trim() !== '') return true;
  return false;
}

/**
 * 读节点容量。
 *
 * 两条路径：
 *   1. `hami.io/node-nvidia-register` 可解析 → 一张物理卡一条记录（`slots` = 该卡切出的槽位数）；
 *   2. 只有 `nvidia.com/gpu|gpumem|gpucores`（纯 device plugin / 老集群 / register 坏掉）
 *      → 按数量生成 N 条整卡记录，显存/算力按总量均摊（Σ 严格等于总量）。
 *
 * 附加字段（接口契约之外，A4 需要）：
 *   · `slots`：vGPU 槽位总数（register 为 Σcount；资源口径直接等于 `nvidia.com/gpu`）
 *   · `canShare`：该节点是否真的支持切分（有 gpumem/gpucores 或 register 才有）
 *   · `resourceKey`：整卡资源键（渲染时用）
 *   · `source`：`register` | `resource` | `none`
 *
 * @param {unknown} node
 * @returns {{devices:{id:string,type:string,memMiB:number,cores:number,slots:number,
 *   health:boolean}[],totalMemMiB:number,totalCores:number,slots:number,canShare:boolean,
 *   resourceKey:string,source:'register'|'resource'|'none'}}
 */
export function readCapacity(node) {
  const gpu = readNodeGpu(node);

  if (gpu.devices.length > 0) {
    return {
      devices: gpu.devices.map((device) => ({
        id: device.id,
        type: device.type,
        memMiB: device.memMiB,
        cores: device.cores,
        slots: device.slots,
        health: device.health,
      })),
      totalMemMiB: gpu.memMiB,
      totalCores: gpu.cores,
      slots: gpu.slots,
      canShare: true,
      resourceKey: GPU,
      source: 'register',
    };
  }

  const count = gpu.count;
  const mem = gpu.memMiB;
  const cores = gpu.cores;
  if (count === 0 && mem === 0 && cores === 0) return emptyCapacity(GPU);

  return {
    // 计数为 0 但显存/算力有值（部分版本只报后两者）：只有总量，给不出设备明细
    devices: count > 0
      ? wholeCardDevices({ count, idPrefix: `${GPU}#`, memTotalMiB: mem, coresTotal: cores })
      : [],
    totalMemMiB: mem,
    totalCores: cores,
    slots: count,
    // 只有 nvidia.com/gpu 的纯 device plugin 不能切分
    canShare: mem > 0 || cores > 0,
    resourceKey: GPU,
    source: 'resource',
  };
}

/** Pod 所在节点：先看 HAMi 注解，再看调度结果，最后退老注解。 */
function resolveNodeName(pod) {
  const annotations = podAnnotations(pod);
  const fromHami = asText(annotations[VGPU_NODE]).trim();
  if (fromHami !== '') return fromHami;

  const direct = podNodeName(pod);
  if (direct !== null) return direct;

  const legacy = asText(annotations[VGPU_NODE_LEGACY]).trim();
  if (legacy === '') return null;
  const first = legacy.split(',')[0].trim();
  return first === '' ? null : first;
}

/**
 * 读 Pod 占用的加速卡。
 *
 * 路径：
 *   1. `hami.io/vgpu-devices-allocated`（兜底 `-assigned`）→ 逐卡精确分配
 *      （四段 `uuid,TYPE,memMiB,cores` / 三段 / 两段自适应，解析在 hami.js）；
 *   2. 注解坏了或者压根没有（纯 device plugin）→ 从容器 `resources` 数整卡
 *      （`nvidia.com/gpu|gpumem|gpucores`，多容器求和）。
 *
 * 均摊说明：走资源口径时只有 Pod 级总量，设备级数字按张数均摊（Σ 严格等于总量）；
 * 占位 ID（`nvidia.com/gpu#alloc-0`）**不对应**节点上的真实 UUID，核对占用只能按张数。
 *
 * @param {unknown} pod
 * @returns {{devices:{id:string,type:string,memMiB:number,cores:number}[],
 *   totalMemMiB:number,totalCores:number,nodeName:string|null,
 *   source:'annotation'|'resource'|'none'}}
 */
export function readAllocation(pod) {
  const vgpu = readPodVgpu(pod);
  const nodeName = vgpu.nodeName ?? resolveNodeName(pod);

  if (vgpu.devices.length > 0) {
    return {
      devices: vgpu.devices.map((device) => ({
        id: device.id,
        type: device.type ?? '',
        memMiB: device.memMiB,
        cores: device.cores,
      })),
      totalMemMiB: vgpu.totalMemMiB,
      totalCores: vgpu.totalCores,
      nodeName,
      source: 'annotation',
    };
  }

  const declared = podResources(pod);
  const count = readCount(declared[GPU]);
  const mem = readCount(declared[GPUMEM]);
  const cores = readCount(declared[GPUCORES]);

  if (count === 0 && mem === 0 && cores === 0) {
    // 注解在、但一条设备都解析不出来（坏注解）：仍然算「HAMi 在管这块卡」，只是没有可信数字
    return { ...emptyAllocation(nodeName), source: vgpu.hasVgpu ? 'annotation' : 'none' };
  }

  return {
    devices: wholeCardDevices({
      count,
      idPrefix: `${GPU}#alloc-`,
      memTotalMiB: mem,
      coresTotal: cores,
    }),
    totalMemMiB: mem,
    totalCores: cores,
    nodeName,
    source: 'resource',
  };
}

/**
 * 渲染 k8s resources 片段（值是字符串，与 k8s 的 Quantity 序列化一致）。
 *
 * 语义（与 `/tmp/infra-contract.md` 的 ModelService.resources 对齐）：
 *   · `accelerators` = 每副本要几张卡（HAMi 下是 vGPU 份额数，必填 ≥ 1）
 *   · `memoryMiB > 0` → 写 `nvidia.com/gpumem`（vGPU 显存配额，MiB）
 *   · `coresPercent > 0` → 写 `nvidia.com/gpucores`（百分比点，取整）
 *   · `memoryMiB === 0` → **整卡**：只写 `nvidia.com/gpu`，不写 gpumem/gpucores
 *
 * 矛盾组合直接抛（错误信息带字段名，A1/A2 可原样展示给用户），不静默丢字段：
 *   · `coresPercent > 0` 但 `memoryMiB === 0`：整卡语义下没地方挂算力配额；
 *   · `memoryMiB > 0` 但 `accelerators === 0`：没有卡就没有配额可挂；
 *   · `coresPercent > 100`：超出百分比点定义。
 *
 * @param {{accelerators?:unknown, memoryMiB?:unknown, coresPercent?:unknown}} [request]
 * @returns {Record<string,string>} 例如 `{'nvidia.com/gpu':'1','nvidia.com/gpumem':'24576'}`
 * @throws {Error & {code:'ACCELERATOR_INVALID'}} 参数不合法时
 */
export function renderResources({ accelerators, memoryMiB, coresPercent } = {}) {
  const count = coerceCount(accelerators, 'accelerators（加速卡数）');
  const mem = Math.trunc(coerceAmount(memoryMiB, 'memoryMiB（显存配额）'));
  const cores = Math.trunc(coerceAmount(coresPercent, 'coresPercent（算力百分比）'));

  if (cores > 100) {
    throw invalid(`coresPercent 必须在 0-100 之间（收到 ${cores}）：它是百分比点，100 = 整卡算力`);
  }
  if (mem > 0 && count === 0) {
    throw invalid('申请显存配额时必须同时申请加速卡：accelerators 至少为 1，memoryMiB 才有意义');
  }
  if (cores > 0 && mem === 0) {
    throw invalid('申请算力配额（coresPercent）时必须同时给显存配额（memoryMiB > 0）：'
      + 'memoryMiB=0 表示整卡，整卡不能再单独限算力');
  }
  if (count === 0) return {};

  const out = { [GPU]: String(count) };
  if (mem > 0) {
    out[GPUMEM] = String(mem);
    if (cores > 0) out[GPUCORES] = String(cores);
  }
  return out;
}

/**
 * 探测命令（本地/节点上跑一次就知道有没有卡）。
 * @returns {string}
 */
export function probeCommand() {
  return 'nvidia-smi';
}

/**
 * 型号峰值算力（fp16/bf16 稠密 TFLOPS；fp8 只有表里写了的型号才有值）。
 * @param {string} modelName 例如 `NVIDIA GeForce RTX 4090`、`A100-SXM4-80GB`
 * @param {string} [dtype='fp16'] 只认 fp16/bf16 与 fp8，其它 dtype 返回 null（不折算）
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
