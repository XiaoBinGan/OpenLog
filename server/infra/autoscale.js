/**
 * server/infra/autoscale.js —— AI Infra 能力层 B3：HPA 弹性（渲染与约束）
 *
 * 立场（与 README 的「不做替代 k8s 的调度器」一致）：
 * 本文件**不实现扩缩逻辑**。扩缩的决策权在 k8s 的 HPA 控制器手里，这里只做两件事：
 *   1. 把「弹性策略」渲染成一份 `autoscaling/v2` 的 HorizontalPodAutoscaler；
 *   2. 在落笔前把**必然会失败**的配置挡住，并说清怎么改。
 *
 * 两个本项目特有的约束（本文件存在的理由）：
 *
 * ① **扩副本会吃 vGPU 配额**。HAMi 是单卡语义：一个副本的显存必须由同一张卡提供。
 *    所以 `maxReplicas × resources.memoryMiB` 一旦超过单卡可容纳的量，第 N+1 个副本
 *    会永远 Pending（HAMi 报 `CardInsufficientMemory`），而 HPA 会一直重试 ——
 *    用户看到的是「扩了但没起来」，比直接报错更难查。`autoscaleBudget()` 把这条
 *    算术提前算给他看，`validateAutoscale()` 传入 capacity 时直接报成字段级错误。
 *
 * ② **抖动**。GPU 模型加载动辄几十秒到几分钟，扩缩过频 = 反复重建 Pod = 反复冷启动。
 *    所以：冷却窗口（默认 300s）内一律不动；**缩容保守**（一次最多减 1 个副本），
 *    扩容可以一次到目标（冷启动的代价远大于多开几个副本）。
 *    这两条既写进 `evaluateScaleDecision()` 的判定，也写进渲染出的
 *    `spec.behavior.scaleDown.policies`（`type: Pods, value: 1`），
 *    让**集群侧**也守住同一条规则 —— 不能只靠 OpenLog 自己的调用方守规矩。
 *
 * 边界：
 * - 纯函数：不联网、不读盘、不读环境变量、不改入参；同一输入必得同一输出（键序稳定）。
 * - 只生成**同一命名空间内**的一个 HPA 对象，`targetRef` 固定指向 `Deployment/<name>`
 *   （A1 渲染出来的就是 Deployment，见 render.js）。
 * - 错误信息一律中文且可操作：说清「字段 / 允许什么 / 收到什么 / 怎么改」。
 *
 * @module server/infra/autoscale
 */

// ─── 常量 ────────────────────────────────────────────────────────────────

/**
 * 副本数上限 8。**必须与 `server/infra/guard.js` 的 `DEFAULT_LIMITS.replicas` 一致**：
 * 护栏放行的上限比 HPA 允许的上限低，会出现「HPA 扩到 8、护栏拒绝保存」的死锁。
 * 单测里有跨模块断言（infra-autoscale.test.js）。
 */
export const MAX_REPLICAS_LIMIT = 8;

/** `minReplicas` 默认值：至少留 1 个副本承接流量。 */
export const DEFAULT_MIN_REPLICAS = 1;

/** 冷却窗口默认 300s（5 分钟）：大于模型冷启动的常见耗时，小于运维的耐心。 */
export const DEFAULT_COOLDOWN_SECONDS = 300;

/** 冷却窗口上限 3600s：k8s 的 `stabilizationWindowSeconds` 最大就是 3600。 */
export const MAX_COOLDOWN_SECONDS = 3600;

/** 一次最多声明多少个指标（k8s 没有硬限制，但超过这个数说明策略没想清楚）。 */
export const MAX_METRICS = 8;

/** 自定义指标名（Prometheus/OpenMetrics 风格）：小写字母开头，最长 63。 */
export const METRIC_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,62}$/;

/** `type: Resource` 只允许这两个内置资源指标（k8s 也只支持它们走 HPA 的 Resource 分支）。 */
export const RESOURCE_METRIC_NAMES = Object.freeze(['cpu', 'memory']);

/** 指标类型白名单。别的类型（External/Object/ContainerResource）一律不渲染。 */
export const AUTOSCALE_METRIC_TYPES = Object.freeze(['Resource', 'Pods']);

/** HPA 的 apiVersion / kind（autoscaling/v2 才有 `behavior`，v1 没有）。 */
export const HPA_API_VERSION = 'autoscaling/v2';
export const HPA_KIND = 'HorizontalPodAutoscaler';

/** scaleTargetRef 固定指向 A1 渲染出来的 Deployment。 */
export const SCALE_TARGET_API_VERSION = 'apps/v1';
export const SCALE_TARGET_KIND = 'Deployment';

/** 缩容步长：一次最多减 1 个副本（避免雪崩）。扩容不限步长。 */
export const SCALE_DOWN_MAX_STEP = 1;

/** 未指定目标利用率时的默认值（CPU 70% 是业界最常见的起点）。 */
export const DEFAULT_UTILIZATION_PERCENT = 70;

/** 渲染器版本，写进注解，方便 A5 判断这份清单是谁渲染的（与 render.js 同口径）。 */
export const RENDERER_VERSION = 'openlog-infra/v1';

/** 归属标签：必须与 guard.js 的 `MANAGED_BY_KEY` / `MANAGED_BY_VALUE` 一致。 */
export const MANAGED_BY_KEY = 'managedBy';
export const MANAGED_BY_VALUE = 'openlog-infra';

/** k8s quantity（`5` / `100m` / `2Gi`）的保守子集：拒绝空格与科学计数法。 */
const QUANTITY_PATTERN = /^[0-9]+(\.[0-9]+)?(n|u|m|k|K|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

/** 时间戳小于这个量级时按「秒」解释（`Math.floor(Date.now()/1000)` ≈ 1.7e9）。 */
const SECOND_SCALE_THRESHOLD = 1e11;

// ─── 小工具 ──────────────────────────────────────────────────────────────

/** 是否是「普通对象」（排除 null / 数组 / 原始值）。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把任意值描述成人能读的中文类型名，用于错误文案。 */
function describeType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'object') return '对象';
  if (typeof value === 'string') return '字符串';
  return typeof value;
}

/** 把输入值放进错误文案（字符串加引号，其余原样），超长时截断。 */
function quote(value) {
  let text;
  if (typeof value === 'string') text = JSON.stringify(value);
  else if (value === undefined) text = 'undefined';
  else if (value === null) text = 'null';
  else if (typeof value === 'object') text = Array.isArray(value) ? '数组' : '对象';
  else text = String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 有限数字判定（排除 NaN / Infinity / 数字字符串）。 */
function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 整数归一：非有限值返回 fallback；否则截断。 */
function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

/** MiB → 人类可读（与 capacity.js 的 formatMiB 同口径，避免跨模块耦合）。 */
function formatMiB(mib) {
  const n = Number(mib);
  if (!Number.isFinite(n)) return '未知';
  if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} GiB`;
  return `${Math.round(n)} MiB`;
}

/**
 * 解析时间戳。支持：
 * - `Date` 实例
 * - 数字：小于 1e11 视为「秒级时间戳」，否则视为毫秒
 * - ISO 字符串（`2026-01-02T03:04:05Z`）
 *
 * 解析不出来返回 `null`（调用方按「没有冷却」处理，而不是当成 0 立即解除）。
 *
 * @param {unknown} value
 * @returns {number|null} 毫秒时间戳
 */
function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < SECOND_SCALE_THRESHOLD ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value.trim());
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** 把指标上下文摊成一句中文尾巴（挂在 reason 后面，让「为什么不动」有据可查）。 */
function describeMetrics(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) return '';
  const parts = metrics.slice(0, 4).map((item) => {
    if (!isPlainObject(item)) return String(item);
    const name = item.name ?? item.metric ?? item.metricName ?? '未知指标';
    const current = item.value ?? item.current ?? item.averageValue ?? null;
    const target = item.target ?? item.threshold ?? item.averageUtilization ?? null;
    if (current === null && target === null) return String(name);
    const unit = item.unit ?? (name === 'cpu' || name === 'memory' ? '%' : '');
    const shownCurrent = current === null ? '?' : `${current}${unit}`;
    const shownTarget = target === null ? '' : `（目标 ${target}${unit}）`;
    return `${name} ${shownCurrent}${shownTarget}`;
  });
  return `；指标：${parts.join('、')}`;
}

// ─── 服务侧读取 ──────────────────────────────────────────────────────────

/**
 * 从 ModelService 里读 HPA 需要的那几项（只读，不做校验）。
 *
 * @param {unknown} service
 * @returns {{ name: string, namespace: string, replicas: number|null,
 *   memoryMiB: number, coresPercent: number, accelerators: number }}
 */
function readServiceView(service) {
  const svc = isPlainObject(service) ? service : {};
  const res = isPlainObject(svc.resources) ? svc.resources : {};
  const memoryMiB = toInt(res.memoryMiB, 0);
  const coresPercent = toInt(res.coresPercent, 0);
  const accelerators = toInt(res.accelerators, 1);
  return {
    name: typeof svc.name === 'string' ? svc.name.trim() : '',
    namespace: typeof svc.namespace === 'string' ? svc.namespace.trim() : '',
    replicas: isNum(svc.replicas) ? Math.trunc(svc.replicas) : null,
    memoryMiB: memoryMiB > 0 ? memoryMiB : 0,
    coresPercent: coresPercent > 0 ? Math.min(coresPercent, 100) : 0,
    accelerators: accelerators >= 1 ? accelerators : 1,
  };
}

// ─── 指标归一化 ──────────────────────────────────────────────────────────

/**
 * 读取指标目标。兼容三种写法：
 *   `{ target: 70 }`                        → Utilization 70（Resource）/ AverageValue '70'（Pods）
 *   `{ target: '2Gi' }`                     → 一律按 AverageValue '2Gi'（字符串一定是 quantity）
 *   `{ target: { type, averageUtilization, averageValue } }` → k8s 原生形态
 *
 * @param {Record<string, any>} raw 原始指标
 * @param {Record<string, any>|null} block `raw.resource` 或 `raw.pods`
 * @param {'Utilization'|'AverageValue'} defaultType 该类型指标的默认目标语义
 * @returns {{ type: string, averageUtilization: unknown, averageValue: unknown }}
 */
function readTarget(raw, block, defaultType) {
  const explicitType = typeof raw.targetType === 'string' && raw.targetType ? raw.targetType : '';
  const direct = raw.target ?? block?.target ?? null;

  if (isPlainObject(direct)) {
    return {
      type: typeof direct.type === 'string' && direct.type ? direct.type : explicitType || defaultType,
      averageUtilization: direct.averageUtilization,
      averageValue: direct.averageValue,
    };
  }
  if (typeof direct === 'number') {
    const type = explicitType || defaultType;
    return type === 'Utilization'
      ? { type, averageUtilization: direct, averageValue: undefined }
      : { type, averageUtilization: undefined, averageValue: String(direct) };
  }
  if (typeof direct === 'string' && direct.trim() !== '') {
    // 字符串一定是 k8s quantity，因此只能表达 AverageValue
    return { type: explicitType || 'AverageValue', averageUtilization: undefined, averageValue: direct };
  }
  return {
    type: explicitType || defaultType,
    averageUtilization: raw.averageUtilization,
    averageValue: raw.averageValue,
  };
}

/**
 * 归一化单个指标。非法时把错误 push 进 `fail` 并返回 `null`（不抛异常）。
 *
 * @param {unknown} raw 原始指标
 * @param {number} index 在 metrics 数组里的下标（用于 field 名）
 * @param {(field: string, message: string) => void} fail
 * @param {Set<string>} seen 已出现的 `type:name`，用于查重
 * @returns {{ type: string, name: string, targetType: string,
 *   averageUtilization?: number, averageValue?: string }|null}
 */
function normalizeMetric(raw, index, fail, seen) {
  const field = `metrics[${index}]`;
  if (!isPlainObject(raw)) {
    fail(field, `${field} 必须是 { type, name, target } 对象（收到 ${describeType(raw)}），例如 { type: "Resource", name: "cpu", target: 70 }`);
    return null;
  }

  const resource = isPlainObject(raw.resource) ? raw.resource : null;
  const pods = isPlainObject(raw.pods) ? raw.pods : null;
  const rawType = raw.type ?? (resource ? 'Resource' : pods ? 'Pods' : '');
  if (typeof rawType !== 'string' || !AUTOSCALE_METRIC_TYPES.includes(rawType)) {
    fail(`${field}.type`, `${field}.type 只允许 ${AUTOSCALE_METRIC_TYPES.join(' / ')}（收到 ${quote(raw.type)}）；Object/External 等类型不在本项目白名单内`);
    return null;
  }

  const name = String(raw.name ?? resource?.name ?? pods?.metric?.name ?? '').trim();
  if (!name) {
    fail(`${field}.name`, `${field}.name 必填：Resource 填 ${RESOURCE_METRIC_NAMES.join(' / ')}，Pods 填自定义指标名（例如 vllm:num_requests_waiting 需写成 vllm_num_requests_waiting）`);
    return null;
  }

  const defaultTargetType = rawType === 'Resource' ? 'Utilization' : 'AverageValue';
  const target = readTarget(raw, resource || pods, defaultTargetType);
  const targetType = target.type || defaultTargetType;

  if (rawType === 'Resource') {
    if (!RESOURCE_METRIC_NAMES.includes(name)) {
      fail(`${field}.name`, `${field}.name 只允许 ${RESOURCE_METRIC_NAMES.join(' / ')}（收到 ${quote(name)}）；自定义指标请用 type: "Pods"`);
      return null;
    }
    if (targetType === 'Utilization') {
      const value = target.averageUtilization;
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        fail(`${field}.target`, `${field}.target 必须是 1..100 的整数百分比（收到 ${quote(value)}），例如 70 表示平均使用率超过 70% 时扩容`);
        return null;
      }
      const key = `${rawType}:${name}`;
      if (seen.has(key)) {
        fail(`${field}.name`, `指标重复：${rawType}/${name} 已经配置过一次，同一资源指标重复声明会让 HPA 的扩缩方向互相打架`);
        return null;
      }
      seen.add(key);
      return { type: rawType, name, targetType, averageUtilization: value };
    }
    if (targetType === 'AverageValue') {
      const value = target.averageValue === undefined || target.averageValue === null ? '' : String(target.averageValue).trim();
      if (!QUANTITY_PATTERN.test(value)) {
        fail(`${field}.target`, `${field}.target 是 AverageValue 时必须是 k8s quantity 字符串（如 "500m" / "2Gi"），收到 ${quote(target.averageValue)}`);
        return null;
      }
      const key = `${rawType}:${name}`;
      if (seen.has(key)) {
        fail(`${field}.name`, `指标重复：${rawType}/${name} 已经配置过一次`);
        return null;
      }
      seen.add(key);
      return { type: rawType, name, targetType, averageValue: value };
    }
    fail(`${field}.targetType`, `${field}.targetType 只允许 Utilization / AverageValue（收到 ${quote(targetType)}）`);
    return null;
  }

  // type === 'Pods'
  if (!METRIC_NAME_PATTERN.test(name)) {
    fail(
      `${field}.name`,
      `${field}.name 必须匹配 ${METRIC_NAME_PATTERN}（小写字母开头，只含小写字母/数字/下划线/点/中划线，最长 63；收到 ${quote(name)}）`,
    );
    return null;
  }
  if (targetType !== 'AverageValue' && targetType !== 'Value') {
    fail(`${field}.targetType`, `${field}.targetType 只允许 AverageValue / Value（收到 ${quote(targetType)}）`);
    return null;
  }
  const value = target.averageValue === undefined || target.averageValue === null ? '' : String(target.averageValue).trim();
  if (!QUANTITY_PATTERN.test(value)) {
    fail(`${field}.target`, `${field}.target 必须是 k8s quantity 字符串（例如 "5" 表示平均每个 Pod 排队 5 个请求），收到 ${quote(target.averageValue)}`);
    return null;
  }
  const key = `${rawType}:${name}`;
  if (seen.has(key)) {
    fail(`${field}.name`, `指标重复：${rawType}/${name} 已经配置过一次`);
    return null;
  }
  seen.add(key);
  return { type: rawType, name, targetType, averageValue: value };
}

// ─── 校验 ────────────────────────────────────────────────────────────────

/**
 * 校验弹性配置（**纯函数**，不抛异常，全部问题收集进 errors）。
 *
 * 除契约里的 `{ service, autoscale }` 外，还接受可选的 `capacity`
 * （形如 `{ perCardMemMiB, perCardCores }`）：给了就把 vGPU 预算一起算进 errors，
 * 这样「HPA 扩出来会 Pending」在保存阶段就被挡住，而不是等用户看到 Pending Pod。
 *
 * @param {object} args
 * @param {object} [args.service] 规范化后的 ModelService（至少要有 name / namespace）
 * @param {object} [args.autoscale] 弹性配置：`{ minReplicas, maxReplicas, cooldownSeconds, metrics }`
 * @param {{ perCardMemMiB?: number, perCardCores?: number }} [args.capacity] 节点单卡容量
 * @returns {{
 *   ok: boolean,
 *   errors: Array<{ field: string, message: string }>,
 *   value: { minReplicas: number, maxReplicas: number, cooldownSeconds: number, metrics: object[] } | null,
 *   budget: { maxReplicasByMemory: number|null, maxReplicasByCores: number|null, allowed: boolean, reason: string } | null
 * }}
 *
 * @example
 * validateAutoscale({
 *   service: { name: 'qwen3-8b', namespace: 'inference', resources: { memoryMiB: 8192, coresPercent: 0 } },
 *   autoscale: { maxReplicas: 4, metrics: [{ type: 'Resource', name: 'cpu', target: 70 }] },
 *   capacity: { perCardMemMiB: 24576, perCardCores: 100 },
 * });
 * // → { ok: true, errors: [], value: {...}, budget: { maxReplicasByMemory: 3, ... } }
 */
export function validateAutoscale({ service, autoscale, capacity } = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  const view = readServiceView(service);
  if (!isPlainObject(service)) {
    fail('service', `service 必须是规范化后的 ModelService 对象（收到 ${describeType(service)}）：请先跑 validateModelService() 拿到 value 再配置弹性`);
  } else {
    if (!view.name) {
      fail('service.name', 'service.name 必填：HPA 的 targetRef 依赖它指向 Deployment（DNS-1123 label，例如 qwen3-8b-instruct）');
    }
    if (!view.namespace) {
      fail('service.namespace', 'service.namespace 必填：HPA 必须落在 inference 或 infra-test 里，否则护栏无法判断归属');
    }
  }

  const value = {
    minReplicas: DEFAULT_MIN_REPLICAS,
    maxReplicas: 0,
    cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
    metrics: [],
  };

  if (!isPlainObject(autoscale)) {
    fail('autoscale', `autoscale 必须是 { minReplicas, maxReplicas, cooldownSeconds, metrics } 对象（收到 ${describeType(autoscale)}）`);
    return { ok: false, errors, value: null, budget: null };
  }

  // minReplicas：默认 1
  const rawMin = autoscale.minReplicas;
  if (rawMin === undefined || rawMin === null) {
    value.minReplicas = DEFAULT_MIN_REPLICAS;
  } else if (!Number.isInteger(rawMin) || rawMin < 1 || rawMin > MAX_REPLICAS_LIMIT) {
    fail('minReplicas', `minReplicas 必须是 1..${MAX_REPLICAS_LIMIT} 的整数（收到 ${quote(rawMin)}）；留 0 个副本等于服务不可用`);
  } else {
    value.minReplicas = rawMin;
  }

  // maxReplicas：必填（HPA 没有上限就没有意义），且不超过护栏上限
  const rawMax = autoscale.maxReplicas;
  if (rawMax === undefined || rawMax === null) {
    fail('maxReplicas', `maxReplicas 必填：1..${MAX_REPLICAS_LIMIT} 的整数（例如 4）。不填上限等于允许无限扩副本，会把节点显存和调度器一起打爆`);
  } else if (!Number.isInteger(rawMax)) {
    fail('maxReplicas', `maxReplicas 必须是 1..${MAX_REPLICAS_LIMIT} 的整数（收到 ${quote(rawMax)}）`);
  } else if (rawMax < 1) {
    fail('maxReplicas', `maxReplicas 至少为 1（收到 ${rawMax}）：0 个副本意味着 HPA 会把服务缩到不可用`);
  } else if (rawMax > MAX_REPLICAS_LIMIT) {
    fail(
      'maxReplicas',
      `maxReplicas 最大 ${MAX_REPLICAS_LIMIT}（与护栏 REPLICAS_LIMIT 一致，收到 ${rawMax}）。超过后护栏会拒绝保存；需要更高并发请换更大的卡或拆成多个服务`,
    );
  } else {
    value.maxReplicas = rawMax;
  }

  if (value.maxReplicas > 0 && value.minReplicas > value.maxReplicas) {
    fail(
      'minReplicas',
      `minReplicas(${value.minReplicas}) 不能大于 maxReplicas(${value.maxReplicas})：HPA 会立刻把副本拉到 min，而 k8s 又不允许超过 max，结果是永久 Pending`,
    );
  }

  // cooldownSeconds：默认 300，0 表示不做冷却（不建议：GPU 模型冷启动很贵）
  const rawCooldown = autoscale.cooldownSeconds;
  if (rawCooldown === undefined || rawCooldown === null) {
    value.cooldownSeconds = DEFAULT_COOLDOWN_SECONDS;
  } else if (!Number.isInteger(rawCooldown) || rawCooldown < 0 || rawCooldown > MAX_COOLDOWN_SECONDS) {
    fail('cooldownSeconds', `cooldownSeconds 必须是 0..${MAX_COOLDOWN_SECONDS} 的整数秒（收到 ${quote(rawCooldown)}）；k8s 的 stabilizationWindowSeconds 上限就是 3600`);
  } else {
    value.cooldownSeconds = rawCooldown;
  }

  // metrics：至少 1 个，白名单式重建
  const rawMetrics = autoscale.metrics;
  if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) {
    fail(
      'metrics',
      `metrics 至少需要 1 个指标（收到 ${Array.isArray(rawMetrics) ? '[]（空数组）' : describeType(rawMetrics)}）：HPA 没有指标就永远不会扩缩，例如 [{ type: "Resource", name: "cpu", target: 70 }]`,
    );
  } else if (rawMetrics.length > MAX_METRICS) {
    fail('metrics', `metrics 最多 ${MAX_METRICS} 个（收到 ${rawMetrics.length}）：指标越多扩缩越抖，请只保留真正相关的 1..2 个`);
  } else {
    const seen = new Set();
    rawMetrics.forEach((item, index) => {
      const metric = normalizeMetric(item, index, fail, seen);
      if (metric) value.metrics.push(metric);
    });
  }

  // 预算：只有真的给了容量才判定（没给容量时不能假装知道，也不能默认放行一个具体上限）
  const budget = autoscaleBudget({ service, autoscale, capacity });
  if (budget.allowed === false && value.maxReplicas > 0) {
    fail('maxReplicas', budget.reason);
  }

  return { ok: errors.length === 0, errors, value, budget };
}

// ─── 渲染 ────────────────────────────────────────────────────────────────

/**
 * 把归一化后的指标渲染成 k8s `autoscaling/v2` 的 metrics 条目。
 *
 * @param {{ type: string, name: string, targetType: string,
 *   averageUtilization?: number, averageValue?: string }} metric
 * @returns {Record<string, any>}
 */
function renderMetric(metric) {
  if (metric.type === 'Resource') {
    const target = metric.targetType === 'AverageValue'
      ? { type: 'AverageValue', averageValue: metric.averageValue }
      : { type: 'Utilization', averageUtilization: metric.averageUtilization };
    return { type: 'Resource', resource: { name: metric.name, target } };
  }
  return {
    type: 'Pods',
    pods: {
      metric: { name: metric.name },
      target: { type: metric.targetType, averageValue: metric.averageValue },
    },
  };
}

/**
 * 渲染 `autoscaling/v2` 的 HorizontalPodAutoscaler。
 *
 * 渲染出的对象里，两条本项目规则是**写死在 spec 里**的：
 * - `scaleDown.policies: [{ type: 'Pods', value: 1 }]` —— 一次最多缩 1 个副本（防雪崩）；
 * - `scaleDown.stabilizationWindowSeconds = cooldownSeconds` —— 冷却窗口内不做缩容决策。
 * 也就是说，即使有人绕过 OpenLog 直接改 HPA 的副本数，集群侧的行为也仍然保守。
 *
 * @param {object} args
 * @param {object} args.service 规范化后的 ModelService（用 name / namespace）
 * @param {object} args.autoscale 弹性配置
 * @returns {Record<string, any>} k8s HPA 对象（同一命名空间内，targetRef 指向 Deployment/<name>）
 * @throws {Error} 配置不合法时抛错（`code = 'INFRA_INVALID_AUTOSCALE'`，`errors` 带字段级明细）
 *
 * @example
 * renderHpa({
 *   service: { name: 'qwen3-8b', namespace: 'inference' },
 *   autoscale: { maxReplicas: 3, metrics: [{ type: 'Resource', name: 'cpu', target: 70 }] },
 * }).spec.scaleTargetRef;
 * // → { apiVersion: 'apps/v1', kind: 'Deployment', name: 'qwen3-8b' }
 */
export function renderHpa({ service, autoscale } = {}) {
  const validation = validateAutoscale({ service, autoscale });
  if (!validation.ok) {
    const detail = validation.errors
      .map((error) => (error.field ? `${error.field}: ${error.message}` : error.message))
      .join('；');
    const error = new Error(`弹性配置不合法，无法渲染 HPA：${detail}`);
    error.code = 'INFRA_INVALID_AUTOSCALE';
    error.errors = validation.errors;
    throw error;
  }

  const value = validation.value;
  const view = readServiceView(service);
  const name = view.name;
  const namespace = view.namespace;

  return {
    apiVersion: HPA_API_VERSION,
    kind: HPA_KIND,
    metadata: {
      name,
      namespace,
      labels: {
        app: name,
        [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
        'app.kubernetes.io/managed-by': MANAGED_BY_VALUE,
      },
      annotations: {
        'openlog.io/renderer-version': RENDERER_VERSION,
        'openlog.io/cooldown-seconds': String(value.cooldownSeconds),
        'openlog.io/scale-down-max-step': String(SCALE_DOWN_MAX_STEP),
        'openlog.io/replicas-limit': String(MAX_REPLICAS_LIMIT),
      },
    },
    spec: {
      scaleTargetRef: {
        apiVersion: SCALE_TARGET_API_VERSION,
        kind: SCALE_TARGET_KIND,
        name,
      },
      minReplicas: value.minReplicas,
      maxReplicas: value.maxReplicas,
      metrics: value.metrics.map(renderMetric),
      behavior: {
        // 扩容不设冷却：冷启动的代价远大于多开几个副本（多占显存由 autoscaleBudget 兜住）
        scaleUp: {
          stabilizationWindowSeconds: 0,
          selectPolicy: 'Max',
          policies: [{ type: 'Percent', value: 100, periodSeconds: 60 }],
        },
        // 缩容保守：冷却窗口 + 一次最多减 1 个副本
        scaleDown: {
          stabilizationWindowSeconds: value.cooldownSeconds,
          selectPolicy: 'Min',
          policies: [{ type: 'Pods', value: SCALE_DOWN_MAX_STEP, periodSeconds: 60 }],
        },
      },
    },
  };
}

// ─── 扩缩决策（解释「为什么不动」） ──────────────────────────────────────

/**
 * 归一化决策策略。
 *
 * @param {unknown} policy `{ minReplicas, maxReplicas, cooldownSeconds, scaleDownMaxStep }`
 * @returns {{ minReplicas: number, maxReplicas: number, cooldownSeconds: number, scaleDownMaxStep: number }}
 */
function normalizePolicy(policy) {
  const p = isPlainObject(policy) ? policy : {};
  const minReplicas = Number.isInteger(p.minReplicas) && p.minReplicas >= 1
    ? Math.min(p.minReplicas, MAX_REPLICAS_LIMIT)
    : DEFAULT_MIN_REPLICAS;
  const rawMax = Number.isInteger(p.maxReplicas) && p.maxReplicas >= 1 ? p.maxReplicas : MAX_REPLICAS_LIMIT;
  const maxReplicas = Math.max(minReplicas, Math.min(rawMax, MAX_REPLICAS_LIMIT));
  const cooldownSeconds = Number.isInteger(p.cooldownSeconds) && p.cooldownSeconds >= 0
    ? Math.min(p.cooldownSeconds, MAX_COOLDOWN_SECONDS)
    : DEFAULT_COOLDOWN_SECONDS;
  const rawStep = Number.isInteger(p.scaleDownMaxStep) && p.scaleDownMaxStep >= 1 ? p.scaleDownMaxStep : SCALE_DOWN_MAX_STEP;
  return { minReplicas, maxReplicas, cooldownSeconds, scaleDownMaxStep: Math.min(rawStep, maxReplicas) };
}

/**
 * 计算「这一次该不该动、动到几个」—— 并**用中文说清为什么**。
 *
 * 决策顺序（也是 reason 的措辞依据）：
 *   1. 入参不合法 → `hold`（不猜、不乱扩，把问题交回给调用方）；
 *   2. 目标 = clamp(desired, min, max)，已经等于当前 → `hold`；
 *   3. 在冷却窗口内 → `hold`，reason 里给出**剩余秒数**与解除时间；
 *   4. 目标 > 当前 → `up`，一次到目标（扩容不设步长）；
 *   5. 目标 < 当前 → `down`，**一次最多减 `scaleDownMaxStep`（默认 1）个**，
 *      剩下的差额留给下一个冷却窗口（避免雪崩）。
 *
 * @param {object} args
 * @param {number} [args.current] 当前副本数
 * @param {number} [args.desired] 指标算出来的目标副本数
 * @param {Array<{ name?: string, value?: number, target?: number }>} [args.metrics]
 *   指标上下文，只用于把 reason 说清楚（不影响判定）
 * @param {number|string|Date|null} [args.cooldownUntil] 冷却解除时间（毫秒/秒/ISO/Date）
 * @param {number|string|Date} [args.now] 当前时间（缺省 `Date.now()`；测试必须传，保证确定性）
 * @param {{ minReplicas?: number, maxReplicas?: number, cooldownSeconds?: number, scaleDownMaxStep?: number }} [args.policy]
 * @returns {{ action: 'up'|'down'|'hold', replicas: number, reason: string }}
 *
 * @example
 * evaluateScaleDecision({
 *   current: 3, desired: 5, cooldownUntil: 1_800_000_000_000, now: 1_800_000_000_000 - 180_000,
 * });
 * // → { action: 'hold', replicas: 3, reason: '冷却窗口内，暂不调整：还剩 180 秒…' }
 */
export function evaluateScaleDecision({
  current,
  desired,
  metrics,
  cooldownUntil,
  now,
  policy,
} = {}) {
  const p = normalizePolicy(policy);
  const metricNote = describeMetrics(metrics);

  const currentRaw = Number(current);
  if (current === null || current === undefined || !Number.isFinite(currentRaw)) {
    return {
      action: 'hold',
      replicas: p.minReplicas,
      reason: `当前副本数不合法（收到 ${quote(current)}），无法判断扩缩方向：请传入正整数，例如 current: 2`,
    };
  }
  const currentReplicas = Math.max(1, Math.trunc(currentRaw));

  const desiredRaw = Number(desired);
  if (desired === null || desired === undefined || !Number.isFinite(desiredRaw)) {
    return {
      action: 'hold',
      replicas: currentReplicas,
      reason: `目标副本数不合法（收到 ${quote(desired)}），保持 ${currentReplicas} 个副本：请先用指标算出整数目标，例如 desired: 4`,
    };
  }

  const asked = Math.trunc(desiredRaw);
  const target = Math.min(p.maxReplicas, Math.max(p.minReplicas, asked));
  const clampNote = asked === target
    ? ''
    : `（目标 ${asked} 已按允许范围 ${p.minReplicas}..${p.maxReplicas} 收敛到 ${target}）`;

  if (target === currentReplicas) {
    return {
      action: 'hold',
      replicas: currentReplicas,
      reason: `副本数已等于目标 ${target}，保持不动${clampNote}${metricNote}`,
    };
  }

  const nowMs = parseTimestamp(now) ?? Date.now();
  const cooldownMs = parseTimestamp(cooldownUntil);
  if (cooldownMs !== null && cooldownMs > nowMs) {
    const remainingSec = Math.ceil((cooldownMs - nowMs) / 1000);
    return {
      action: 'hold',
      replicas: currentReplicas,
      reason: `冷却窗口内，暂不调整：还剩 ${remainingSec} 秒（至 ${new Date(cooldownMs).toISOString()}，窗口 ${p.cooldownSeconds}s）。`
        + `GPU 模型加载需要几十秒到几分钟，扩缩过频等于反复重建 Pod。当前 ${currentReplicas} 个副本，目标 ${target} 个${clampNote}${metricNote}`,
    };
  }

  if (target > currentReplicas) {
    return {
      action: 'up',
      replicas: target,
      reason: `扩容：${currentReplicas} → ${target} 个副本（一次到目标，扩容不设步长：冷启动的代价远大于多开副本）${clampNote}${metricNote}`,
    };
  }

  const step = Math.min(currentReplicas - target, p.scaleDownMaxStep);
  const next = currentReplicas - step;
  return {
    action: 'down',
    replicas: next,
    reason: `缩容：${currentReplicas} → ${next} 个副本（目标 ${target}，保守起见一次最多减 ${p.scaleDownMaxStep} 个，避免雪崩；`
      + `剩余 ${currentReplicas - step - target} 个差额留到下一个冷却窗口再评估）${clampNote}${metricNote}`,
  };
}

// ─── vGPU 预算 ──────────────────────────────────────────────────────────

/**
 * 算「这张卡最多能放下几个副本」，并给出放不下的中文原因。
 *
 * 公式（与契约 B3 一致）：
 *   `maxReplicasByMemory = floor(perCardMemMiB / max(service.resources.memoryMiB, 1))`
 *   整卡模式（`memoryMiB === 0`，即不切分）视为 **1**：一个副本独占整张卡。
 *
 * 算力侧：`coresPercent === 0` 表示「不限算力」，此时算力不构成约束，
 * 直接返回请求的 `maxReplicas`（不假装有一个具体上限）。
 *
 * @param {object} args
 * @param {object} [args.service] ModelService（用 resources.memoryMiB / coresPercent）
 * @param {object} [args.autoscale] 弹性配置（用 maxReplicas；缺省回落到 service.replicas）
 * @param {{ perCardMemMiB?: number, perCardCores?: number }} [args.capacity]
 *   节点单卡容量。**必须由调用方注入**（容量预检 A4 才知道真机有几张多大的卡）；
 *   不传时判定为「未知」，`allowed: true` 并说明跳过检查。
 * @returns {{
 *   maxReplicasByMemory: number|null,
 *   maxReplicasByCores: number|null,
 *   allowed: boolean,
 *   reason: string
 * }}
 *
 * @example
 * autoscaleBudget({
 *   service: { resources: { memoryMiB: 8192, coresPercent: 0 } },
 *   autoscale: { maxReplicas: 4 },
 *   capacity: { perCardMemMiB: 24576, perCardCores: 100 },
 * });
 * // → { maxReplicasByMemory: 3, maxReplicasByCores: 4, allowed: false,
 * //     reason: 'maxReplicas=4 超出单卡预算：…' }
 */
export function autoscaleBudget({ service, autoscale, capacity } = {}) {
  const view = readServiceView(service);
  const conf = isPlainObject(autoscale) ? autoscale : {};
  const requestedMax = Number.isInteger(conf.maxReplicas) && conf.maxReplicas >= 1
    ? Math.min(conf.maxReplicas, MAX_REPLICAS_LIMIT)
    : Math.max(1, Math.min(view.replicas ?? 1, MAX_REPLICAS_LIMIT));

  const capMemMiB = Number(capacity?.perCardMemMiB ?? capacity?.perCardMemoryMiB ?? capacity?.memoryMiB);
  const capCores = Number(capacity?.perCardCores ?? capacity?.perCardCoresPercent ?? capacity?.cores);
  const hasMem = Number.isFinite(capMemMiB) && capMemMiB > 0;

  if (!hasMem) {
    return {
      maxReplicasByMemory: null,
      maxReplicasByCores: Number.isFinite(capCores) && capCores > 0 ? capCores : null,
      allowed: true,
      reason: `未提供节点单卡容量（capacity.perCardMemMiB），跳过 vGPU 显存预算检查：maxReplicas=${requestedMax} 是否放得下尚未验证，请在容量预检（A4）里带上真实卡容量后再保存`,
    };
  }

  const wholeCard = view.memoryMiB === 0;
  const perReplicaMemMiB = Math.max(view.memoryMiB, 1);
  const maxReplicasByMemory = wholeCard ? 1 : Math.floor(capMemMiB / perReplicaMemMiB);

  const perReplicaCores = view.coresPercent;
  const maxReplicasByCores = perReplicaCores > 0 && Number.isFinite(capCores) && capCores > 0
    ? Math.floor(capCores / perReplicaCores)
    : requestedMax;

  const limit = Math.min(maxReplicasByMemory, maxReplicasByCores);
  const allowed = requestedMax <= limit && limit >= 1;

  if (allowed) {
    return {
      maxReplicasByMemory,
      maxReplicasByCores,
      allowed: true,
      reason: `maxReplicas=${requestedMax} 在单卡预算内：单卡 ${formatMiB(capMemMiB)}${wholeCard ? '（整卡模式，每个副本独占一张卡）' : ` 按每副本 ${perReplicaMemMiB} MiB 切分`}可放 ${maxReplicasByMemory} 个副本，`
        + `算力侧可放 ${maxReplicasByCores} 个，取较小值 ${limit}`,
    };
  }

  const reasons = [];
  if (maxReplicasByMemory < requestedMax) {
    reasons.push(
      wholeCard
        ? `整卡模式（resources.memoryMiB=0）下每个副本独占一张卡，单卡只能放 1 个副本，HPA 扩出来的第 2 个 Pod 会一直 Pending（HAMi 报 CardInsufficientMemory）`
        : `单卡 ${formatMiB(capMemMiB)} 按每副本 ${perReplicaMemMiB} MiB 只能放 ${maxReplicasByMemory} 个副本`,
    );
  }
  if (maxReplicasByCores < requestedMax) {
    reasons.push(
      maxReplicasByCores < 1
        ? `每副本算力配额 ${perReplicaCores}% 已超过单卡可用算力 ${capCores}%，连 1 个副本都放不下`
        : `单卡算力 ${capCores}% 按每副本 ${perReplicaCores}% 只能放 ${maxReplicasByCores} 个副本`,
    );
  }

  return {
    maxReplicasByMemory,
    maxReplicasByCores,
    allowed: false,
    reason: `maxReplicas=${requestedMax} 超出单卡预算：${reasons.join('；')}。`
      + `请把 maxReplicas 下调到 ${Math.max(limit, 1)} 以内，或减小 resources.memoryMiB / 算力配额，或换更大显存的加速卡（HPA 不会因为 Pending 而自动止损，只会一直重试）`,
  };
}

export default {
  validateAutoscale,
  renderHpa,
  evaluateScaleDecision,
  autoscaleBudget,
};
