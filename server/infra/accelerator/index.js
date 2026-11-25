/**
 * 加速卡适配层入口（把「某一家 GPU 的差异」关进一个可插拔适配器）
 *
 * 上层（A1 渲染器 / A4 容量预检 / A5 执行器 / A6 实测采集）**只**认这两个入口：
 *
 *   import { getAdapter, renderAcceleratorResources } from '../infra/accelerator/index.js';
 *
 * 于是它们代码里不出现任何 `nvidia.com/` 之类字面量：换一家 GPU = 换 adapter，
 * 不是改渲染器。四家适配器实现同一套接口：
 *
 *   {
 *     vendor,                                       // 'nvidia' | 'amd' | 'ascend' | 'generic'
 *     capabilities: { canShare, canLimitCores, memUnitMiB, wholeCardResource },
 *     detectFromNode(node),                         // → boolean（这台节点是不是这家的卡）
 *     readCapacity(node),                           // → { devices[], totalMemMiB, totalCores, … }
 *     readAllocation(pod),                          // → { devices[], totalMemMiB, totalCores, nodeName }
 *     renderResources({accelerators, memoryMiB, coresPercent}),  // → k8s resources 片段
 *     probeCommand(),                               // → 'nvidia-smi' | 'rocm-smi' | 'npu-smi' | ''
 *     peakFlops(modelName, dtype),                  // → TFLOPS 或 null
 *   }
 *
 * 统一口径（四家一致，A4 才能用一个公式算容量）：
 *   · `cores` = 百分比点，一张整卡 100 点（`canLimitCores: false` 的厂商这个数字**只是分母**，
 *     不能拿去下发配额）；
 *   · `memMiB` = MiB，整卡模式没有上报时为 0（未知，不是没有显存）；
 *   · `readCapacity().devices` 一条 = 一张可调度的卡（整卡厂商是占位 ID，不能按 ID 匹配）；
 *   · `renderResources` 的返回值一律是**字符串**值（k8s Quantity 的序列化形态）。
 *
 * 纯函数层：不连集群、不读磁盘、不抛异常 —— 唯一的例外是 `renderResources` 的参数校验
 * （矛盾组合会抛带 `code: 'ACCELERATOR_INVALID'` 的 Error，错误信息直接可以给用户看）。
 */
import nvidiaAdapter from './nvidia.js';
import amdAdapter from './amd.js';
import ascendAdapter from './ascend.js';
import genericAdapter from './generic.js';
import { asText, invalid } from './generic.js';

/** 四家适配器（键就是 `vendor` 字符串）。 */
export const ADAPTERS = Object.freeze({
  nvidia: nvidiaAdapter,
  amd: amdAdapter,
  ascend: ascendAdapter,
  generic: genericAdapter,
});

/**
 * 探测顺序：先具体后兜底。
 * generic 放最后 —— 它的证据最弱（任意 `*.com/gpu` 资源键），不能抢在具体厂商前面。
 */
export const DETECT_ORDER = Object.freeze(['nvidia', 'amd', 'ascend', 'generic']);

/**
 * 厂商名别名 → 规范名。容忍用户/配置里的写法差异（`NVIDIA`、`rocm`、`huawei`…），
 * 但**不**做模糊匹配：认不出就是 generic，不猜。
 */
const VENDOR_ALIASES = new Map([
  ['nvidia', 'nvidia'],
  ['nv', 'nvidia'],
  ['nvidia.com', 'nvidia'],
  ['geforce', 'nvidia'],
  ['cuda', 'nvidia'],
  ['amd', 'amd'],
  ['rocm', 'amd'],
  ['amd.com', 'amd'],
  ['instinct', 'amd'],
  ['ascend', 'ascend'],
  ['huawei', 'ascend'],
  ['npu', 'ascend'],
  ['huawei.com', 'ascend'],
  ['generic', 'generic'],
  ['unknown', 'generic'],
  ['other', 'generic'],
  ['', 'generic'],
]);

/**
 * 取适配器。**任何输入都不抛**：认不出的厂商名一律回落到 generic（兜底适配器）。
 *
 * @param {unknown} vendor 例如 `'nvidia'` / `'AMD'` / `'huawei'` / `null`
 * @returns {typeof nvidiaAdapter} 适配器对象（四家同一套接口）
 */
export function getAdapter(vendor) {
  const key = typeof vendor === 'string' ? vendor.trim().toLowerCase() : '';
  const canonical = VENDOR_ALIASES.get(key);
  return canonical === undefined ? genericAdapter : ADAPTERS[canonical];
}

/**
 * 探测节点属于哪一家。
 *
 * 顺序：nvidia → amd → ascend → generic。混合节点（同时带多家资源键，例如迁移期的
 * 双插件节点）按这个顺序取第一个 —— 顺序本身是确定性的，不依赖对象键的顺序。
 * 一条证据都没有（普通 CPU 节点 / 空对象 / null）→ `null`。
 *
 * @param {unknown} node 归一化 node 或原始 k8s node 对象
 * @returns {'nvidia'|'amd'|'ascend'|'generic'|null}
 */
export function detectAccelerator(node) {
  if (!node || typeof node !== 'object') return null;
  for (const vendor of DETECT_ORDER) {
    if (ADAPTERS[vendor].detectFromNode(node)) return vendor;
  }
  return null;
}

/**
 * 渲染 k8s resources 片段（上层唯一该用的渲染入口）。
 *
 * 与 `getAdapter(vendor).renderResources(...)` 等价，多一层「厂商名归一化 + 未知厂商回落
 * generic」；`resourceKey` 只对 generic 有意义（兜底适配器没有固定资源键），
 * 但四家都接受这个额外字段，透传即可。
 *
 * @param {{vendor?:unknown, accelerators?:unknown, memoryMiB?:unknown,
 *   coresPercent?:unknown, resourceKey?:string}} [request]
 * @returns {Record<string,string>} 例如 `{'nvidia.com/gpu':'1','nvidia.com/gpumem':'24576'}`
 * @throws {Error & {code:'ACCELERATOR_INVALID'}} 组合不合法（信息可直接给用户看）
 */
export function renderAcceleratorResources({
  vendor,
  accelerators,
  memoryMiB,
  coresPercent,
  resourceKey,
} = {}) {
  const adapter = getAdapter(vendor);
  const isVendorMissing = vendor === null || vendor === undefined || asText(vendor).trim() === '';
  if (isVendorMissing && adapter === genericAdapter && Number(accelerators) > 0) {
    // 缺厂商 vs 缺资源键是两件事，提示要能指导操作（generic 自己也会校验，这里先给更明确的）
    throw invalid('没有指定加速卡厂商：请先用 detectAccelerator(node) 探测，'
      + '或显式传 vendor；未知厂商需要同时传 resourceKey（readCapacity(node).resourceKey）');
  }
  return adapter.renderResources({ accelerators, memoryMiB, coresPercent, resourceKey });
}

export default getAdapter;
