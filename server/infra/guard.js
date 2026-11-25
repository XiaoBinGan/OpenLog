/**
 * server/infra/guard.js —— AI Infra 护栏（A2）
 *
 * 这是「不会误删生产」的最后一道**代码级**防线。它可以被绕过（前端能改、
 * API 能直接调），但任何走 OpenLog 的变更都必须先过这里：A5 的执行器在
 * 落笔前调用 `checkGuard`，A7 的 diff 预览调用 `renderDiff` / `summarizeImpact`。
 *
 * 三条设计原则：
 *   1. **纯函数、零依赖**：不 import k8s 客户端、不读文件、不读环境变量本身
 *      （开关由调用方以 `env` 传入）。这样它可以在前端、单测、干跑里安全复用。
 *   2. **两种输入都支持**：既接受 A1 的「用户意图」ModelService，也接受
 *      A1 渲染出来的 k8s 对象数组（Deployment/Service/...）。护栏不能假设
 *      调用方一定在渲染前还是渲染后调用 —— 前后各过一遍才是纵深防御。
 *   3. **错误信息即操作指南**：每条 violation 都带 `code`（前端直接展示/分支）
 *      与中文 `message`（告诉用户下一步该怎么做），而不是一句「不允许」。
 *
 * 与既有 `OPENLOG_K8S_WRITE` 正交：那个开关管「能不能写 k8s」，
 * `OPENLOG_K8S_INFRA` 管「能不能用 AI Infra 这条新能力」，默认关闭。
 *
 * @module server/infra/guard
 */

// ─── 常量 ────────────────────────────────────────────────────────────────

/** 归属标签名：只有带这个标签的对象才允许被 OpenLog 修改/删除 */
export const MANAGED_BY_KEY = 'managedBy';

/** 归属标签值 */
export const MANAGED_BY_VALUE = 'openlog-infra';

/** 白名单命名空间（铁律 2）。新增命名空间必须改这里 + 改测试，不给运行时开口子。 */
export const ALLOWED_NAMESPACES = Object.freeze(['inference', 'infra-test']);

/**
 * 永远禁止的命名空间。
 * 这些即使「名字合法」也不能碰：`kube-system` 里有 CNI/CoreDNS/kube-proxy，
 * `default` 在很多集群上是别人手工塞东西的地方。
 */
export const FORBIDDEN_NAMESPACES = Object.freeze([
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'default',
]);

/** 默认上限；可被 settings 覆盖（settings.limits.* 或 settings.max*） */
export const DEFAULT_LIMITS = Object.freeze({
  /** 单 Pod 显存配额上限（MiB），默认 64 GiB */
  memoryMiB: 65536,
  /** 每副本加速卡数上限 */
  accelerators: 8,
  /** 副本数上限 */
  replicas: 8,
  /** 一次变更的倍数上限（超过需要 force） */
  changeFactor: 4,
});

/** diff 行数上限（超出截断并标注） */
export const DIFF_MAX_LINES = 200;

/**
 * 中断时长估算（秒）。保守取值：宁可高估让用户有心理准备，也不要低估。
 * 单副本重建没有任何副本承接流量 —— 模型加载动辄几十秒，取 60 秒是保守值。
 */
export const DOWNTIME_ESTIMATE = Object.freeze({
  /** 单副本重建：没有冗余，必须等新 Pod Ready */
  singleReplicaSec: 60,
  /** 多副本滚动：靠就绪探针逐个替换，只有连接抖动 */
  rollingSec: 5,
  /** 不重建 Pod（只改副本数/网关） */
  noneSec: 0,
});

/**
 * 违规码全表。前端按 code 做分支/着色，**不要**去 match message 文本。
 */
export const VIOLATION_CODES = Object.freeze({
  /** 命名空间不在白名单（含 kube-system/default 等系统命名空间） */
  NAMESPACE_FORBIDDEN: 'NAMESPACE_FORBIDDEN',
  /** 新能力未启用（OPENLOG_K8S_INFRA !== '1'） */
  INFRA_DISABLED: 'INFRA_DISABLED',
  /** 目标已存在且不属于本系统管理（缺 managedBy 标签），禁止改/删 */
  NOT_MANAGED: 'NOT_MANAGED',
  /** 显存配额超限 */
  MEMORY_LIMIT_EXCEEDED: 'MEMORY_LIMIT_EXCEEDED',
  /** 加速卡数超限 */
  ACCELERATOR_LIMIT_EXCEEDED: 'ACCELERATOR_LIMIT_EXCEEDED',
  /** 副本数超限 */
  REPLICAS_LIMIT_EXCEEDED: 'REPLICAS_LIMIT_EXCEEDED',
  /** 单次变更幅度过大（> changeFactor 倍），需 force 才放行 */
  BIG_CHANGE: 'BIG_CHANGE',
  /** 请求本身缺字段/形状不对，护栏无法判断安全性 */
  INVALID_SERVICE: 'INVALID_SERVICE',
});

/** 允许通过 `force: true` 显式覆盖的违规码（白名单，别扩大） */
const FORCIBLE_CODES = new Set([VIOLATION_CODES.BIG_CHANGE]);

/** 只影响渲染 diff 的记账字段：每次保存都会变，展示出来只是噪音 */
const BOOKKEEPING_FIELDS = new Set(['createdAt', 'updatedAt', 'version', 'revision']);

/**
 * 请求控制字段：描述「这次怎么提交」，不是「期望状态」。
 * 混进 diff 会让用户看到 `force: true` 这种与对象无关的行。
 */
const CONTROL_FIELDS = new Set(['force', 'forceReason', 'op', 'action', 'reason']);

/** k8s 服务端管理的易变字段：diff / impact 判断时必须剥掉，否则永远「有变化」 */
const VOLATILE_META_FIELDS = new Set([
  'resourceVersion',
  'uid',
  'creationTimestamp',
  'generation',
  'managedFields',
  'selfLink',
]);

// ─── 小工具 ──────────────────────────────────────────────────────────────

/**
 * 判断是否为有限数字（排除 NaN / Infinity / 数字字符串）。
 * @param {unknown} v
 * @returns {boolean}
 */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 转成 k8s 尖括号数量：'16Gi' → 16384（MiB），512 → 512。
 * 解析不出来返回 null，让调用方走「未知」分支而不是当成 0（0 在语义上是"不限制"）。
 * @param {unknown} q
 * @returns {number|null} MiB
 */
export function parseMemoryMiB(q) {
  if (isNum(q)) return q;
  if (typeof q !== 'string') return null;
  const m = /^([\d.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/i.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  const factor = {
    '': 1 / (1024 * 1024), // 纯字节
    k: 1 / 1024,
    m: 1,
    g: 1024,
    t: 1024 * 1024,
    ki: 1 / 1024,
    mi: 1,
    gi: 1024,
    ti: 1024 * 1024,
  }[unit];
  if (!Number.isFinite(factor)) return null;
  return Math.round(n * factor);
}

/**
 * 深度排序对象键，保证同一份数据两次 stringify 结果一致（diff 的前提）。
 * @param {unknown} value
 * @returns {unknown}
 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * 稳定序列化：键序固定，便于比较。
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const key of Object.keys(v).sort()) out[key] = walk(v[key]);
    return out;
  };
  return JSON.stringify(walk(value) ?? null);
}

/**
 * 剥掉 k8s 服务端写入的易变元数据与 status（不改变「用户要什么」的语义）。
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function stripVolatile(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = { ...obj };
  delete clone.status;
  if (clone.metadata && typeof clone.metadata === 'object') {
    const meta = { ...clone.metadata };
    for (const key of VOLATILE_META_FIELDS) delete meta[key];
    if (meta.annotations && typeof meta.annotations === 'object') {
      const ann = { ...meta.annotations };
      // kubectl 的 last-applied 是历史记录，与「期望状态」无关
      delete ann['kubectl.kubernetes.io/last-applied-configuration'];
      meta.annotations = ann;
    }
    clone.metadata = meta;
  }
  return clone;
}

/**
 * 把任意输入摊平成 k8s 对象列表。
 * 支持：单对象 / 对象数组 / `{ objects: [...] }` / ModelService 意图。
 * @param {unknown} input
 * @returns {Record<string, any>[]}
 */
function asObjectList(input) {
  if (!input || typeof input !== 'object') return [];
  if (Array.isArray(input)) return input.filter((o) => o && typeof o === 'object');
  if (Array.isArray(input.objects)) return input.objects.filter((o) => o && typeof o === 'object');
  return [input];
}

/**
 * 判定「这是用户意图」还是「渲染后的 k8s 对象」。
 * 有 kind 的是 k8s 对象；有 engine/resources/replicas 但没 kind 的是意图。
 * @param {Record<string, any>} obj
 * @returns {boolean}
 */
function isIntent(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.kind) return false;
  return Boolean(obj.engine || obj.resources || obj.replicas !== undefined || obj.model);
}

/**
 * 从对象列表里挑「工作负载」：副本/镜像/资源都挂在它身上。
 * @param {Record<string, any>[]} objects
 * @returns {Record<string, any>|null}
 */
function pickWorkload(objects) {
  const kinds = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job'];
  return objects.find((o) => kinds.includes(o.kind)) || null;
}

/**
 * 解析 GPU 显存配额。
 * HAMi / nvidia device plugin 的约定不一致：
 *   - `nvidia.com/gpumem: "4096"` 直接就是 **MiB 整数**（不能按字节解析，否则 4096 会变成 0.004）
 *   - `nvidia.com/gpu.memory: "8192Mi"` 是 k8s quantity
 * 两种都要能吃。
 * @param {unknown} raw
 * @returns {number|null} MiB
 */
function parseGpuMemoryMiB(raw) {
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  return parseMemoryMiB(raw);
}

/**
 * 从渲染后的容器资源里读「加速卡数 / 显存配额 / 算力配额」。
 *
 * 关键取舍：**只有 GPU 专属键才算显存**。
 * 容器里的 `memory` 是宿主机内存（加载模型时经常给到 64Gi 以上），
 * 把它当成显存配额会让护栏把正常对象全判成超限 —— 那是误伤，不是保护。
 * 同理 `nvidia.com/gpumem-percentage` 是百分比，不是 MiB。
 * @param {Record<string, any>} container
 * @returns {{ accelerators: number, memoryMiB: number|null, coresPercent: number|null }}
 */
function readContainerResources(container) {
  const limits = container?.resources?.limits || {};
  const requests = container?.resources?.requests || {};
  const merged = { ...requests, ...limits };
  let accelerators = 0;
  let memoryMiB = null;
  let coresPercent = null;

  for (const [key, raw] of Object.entries(merged)) {
    const isAcceleratorKey = /gpu|ascend|nvidia|hami|cambricon|mlu/i.test(key);
    const isQuantityKey = /mem|core|percentage/i.test(key);
    if (isAcceleratorKey && !isQuantityKey) {
      const n = Number(raw);
      if (Number.isFinite(n)) accelerators += n;
      continue;
    }
    if (/percentage/i.test(key)) continue;
    if (/gpumem|gpu[-_.]memory|vgpu.*mem/i.test(key)) {
      memoryMiB = parseGpuMemoryMiB(raw);
      continue;
    }
    if (/gpucores|gpu[-_.]cores/i.test(key)) {
      const n = Number(raw);
      if (Number.isFinite(n)) coresPercent = n;
    }
  }

  return { accelerators, memoryMiB, coresPercent };
}

/**
 * 归一化成可比较的视图。两种输入（意图 / 渲染对象）走同一套字段名。
 * @param {unknown} input
 * @returns {{
 *   present: boolean, namespace: string, name: string, replicas: number|null,
 *   image: string|null, memoryMiB: number|null, accelerators: number|null,
 *   coresPercent: number|null, podHash: string|null, fullHash: string|null,
 *   managed: boolean, namespaces: string[]
 * }}
 */
function makeView(input) {
  const empty = {
    present: false,
    namespace: '',
    name: '',
    replicas: null,
    image: null,
    memoryMiB: null,
    accelerators: null,
    coresPercent: null,
    podHash: null,
    fullHash: null,
    managed: false,
    namespaces: [],
  };
  const objects = asObjectList(input);
  if (!objects.length) return empty;

  const intent = objects.find(isIntent) || null;
  const workload = pickWorkload(objects);
  const namespaces = [];
  for (const obj of objects) {
    const ns = obj.metadata?.namespace || obj.namespace;
    if (typeof ns === 'string' && ns && !namespaces.includes(ns)) namespaces.push(ns);
  }

  if (intent) {
    const res = intent.resources || {};
    const memoryMiB = isNum(res.memoryMiB) ? res.memoryMiB : parseMemoryMiB(res.memoryMiB);
    const podSpec = {
      engine: intent.engine ?? null,
      model: intent.model ?? null,
      resources: intent.resources ?? null,
      placement: intent.placement ?? null,
      ports: intent.ports ?? null,
      health: intent.health ?? null,
    };
    const bookkeeping = {};
    for (const [key, val] of Object.entries(intent)) {
      if (!BOOKKEEPING_FIELDS.has(key)) bookkeeping[key] = val;
    }
    return {
      present: true,
      namespace: typeof intent.namespace === 'string' ? intent.namespace : '',
      name: typeof intent.name === 'string' ? intent.name : '',
      replicas: isNum(intent.replicas) ? intent.replicas : null,
      image: intent.engine?.image ?? null,
      memoryMiB: memoryMiB ?? null,
      accelerators: isNum(res.accelerators) ? res.accelerators : null,
      coresPercent: isNum(res.coresPercent) ? res.coresPercent : null,
      podHash: stableStringify(podSpec),
      fullHash: stableStringify(bookkeeping),
      managed: isManaged(intent),
      namespaces,
    };
  }

  const primary = workload || objects[0];
  const containers = primary?.spec?.template?.spec?.containers || primary?.spec?.containers || [];
  const first = Array.isArray(containers) ? containers[0] : null;
  const { accelerators, memoryMiB, coresPercent } = readContainerResources(first);
  const replicas = isNum(primary?.spec?.replicas) ? primary.spec.replicas : null;
  // 渲染对象走 podTemplate 整体哈希：镜像/资源/亲和/env 任何改动都会重建 Pod
  const podSpec = workload ? workload.spec?.template ?? null : primary?.spec ?? null;

  return {
    present: true,
    namespace: typeof primary?.metadata?.namespace === 'string' ? primary.metadata.namespace : (namespaces[0] || ''),
    name: typeof primary?.metadata?.name === 'string' ? primary.metadata.name : '',
    replicas,
    image: first?.image ?? null,
    memoryMiB: memoryMiB ?? null,
    accelerators: containers.length ? accelerators : null,
    coresPercent: coresPercent ?? null,
    podHash: podSpec ? stableStringify(stripVolatile({ spec: podSpec })) : null,
    fullHash: stableStringify(objects.map(stripVolatile)),
    managed: objects.every((o) => isManaged(o)),
    namespaces,
  };
}

/**
 * 判断对象是否由 OpenLog 基础设施管理。
 * 支持三种形态：k8s 对象 `metadata.labels.managedBy`、意图上的 `labels.managedBy`、
 * 以及直接挂在顶层的 `managedBy`（便于测试与干跑）。
 * @param {Record<string, any>} obj
 * @returns {boolean}
 */
export function isManaged(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const labels = obj.metadata?.labels || obj.labels || {};
  const value = obj[MANAGED_BY_KEY] ?? labels[MANAGED_BY_KEY] ?? labels['app.kubernetes.io/managed-by'];
  return value === MANAGED_BY_VALUE;
}

/**
 * 给渲染后的 k8s 对象补上归属标签。
 *
 * A1 的 `renderModelService` 与 A5 的快照回滚都应该走这里，而不是各处手写
 * `metadata.labels.managedBy` —— 标签格式一旦漂移，护栏就会把自己的对象当成
 * 「别人的对象」而拒绝修改。
 *
 * @template {Record<string, any>} T
 * @param {T} obj k8s 对象（或对象数组）
 * @returns {T} 新对象，不修改入参
 */
export function markManaged(obj) {
  if (Array.isArray(obj)) return obj.map((item) => markManaged(item));
  if (!obj || typeof obj !== 'object') return obj;
  const metadata = { ...(obj.metadata || {}) };
  metadata.labels = { ...(metadata.labels || {}), [MANAGED_BY_KEY]: MANAGED_BY_VALUE };
  return { ...obj, metadata };
}

/**
 * 合并 settings 里的上限覆盖。
 * 支持 `settings.limits.memoryMiB` 与 `settings.maxMemoryMiB` 两种写法，
 * 只为兼容前端表单/A5 的既有形态，值非法时静默回落到默认值（护栏不能因配置写错而放开）。
 * @param {Record<string, any>} settings
 * @returns {{ memoryMiB: number, accelerators: number, replicas: number, changeFactor: number }}
 */
export function resolveLimits(settings = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const nested = s.limits && typeof s.limits === 'object' ? s.limits : {};
  const pick = (...values) => values.find(isNum);
  return {
    memoryMiB: pick(s.maxMemoryMiB, nested.memoryMiB, nested.maxMemoryMiB) ?? DEFAULT_LIMITS.memoryMiB,
    accelerators: pick(s.maxAccelerators, nested.accelerators, nested.maxAccelerators) ?? DEFAULT_LIMITS.accelerators,
    replicas: pick(s.maxReplicas, nested.replicas, nested.maxReplicas) ?? DEFAULT_LIMITS.replicas,
    changeFactor: pick(s.changeFactor, nested.changeFactor) ?? DEFAULT_LIMITS.changeFactor,
  };
}

/**
 * 解析本次变更的意图：delete 还是 apply。
 * @param {{ service?: any, op?: string, action?: string }} args
 * @returns {'apply'|'delete'}
 */
function resolveOp({ service, op, action }) {
  const raw = String(op || action || service?.op || service?.action || 'apply').toLowerCase();
  return raw === 'delete' || raw === 'remove' || raw === 'destroy' ? 'delete' : 'apply';
}

/**
 * 构造一条违规。
 * @param {string} code
 * @param {string} message
 * @param {string} [field]
 * @returns {{ code: string, message: string, field?: string }}
 */
function violation(code, message, field) {
  const v = { code, message };
  if (field) v.field = field;
  return v;
}

/**
 * 倍数是否超过阈值。两侧都必须 > 0 才有比例语义：
 * 0 表示「不限制」，从 0 改成具体值（或反之）按「幅度过大」处理。
 * @param {number|null} from
 * @param {number|null} to
 * @param {number} factor
 * @returns {boolean}
 */
function exceedsFactor(from, to, factor) {
  if (!isNum(from) || !isNum(to)) return false;
  if (from === to) return false;
  if (from === 0 || to === 0) return true;
  return Math.max(from, to) / Math.min(from, to) > factor;
}

// ─── diff ────────────────────────────────────────────────────────────────

/**
 * 把输入渲染成用于 diff 的文本行。
 * 意图 → 稳定 JSON；k8s 对象 → 带 `# kind/ns/name` 头 + 稳定 JSON；字符串 → 原样。
 * @param {unknown} input
 * @param {Record<string, any>} [options]
 * @returns {string[]}
 */
function toRenderLines(input, options = {}) {
  const skipFields = options.skipFields || BOOKKEEPING_FIELDS;
  if (input === null || input === undefined) return [];
  if (typeof input === 'string') return input.split('\n');
  // 已经是文本行（例如视图 diff 的中间产物）—— 直接用，别再拆一遍
  if (Array.isArray(input) && input.every((line) => typeof line === 'string')) return input.slice();

  const objects = asObjectList(input);
  if (!objects.length) return [];

  const lines = [];
  objects.forEach((obj, index) => {
    const clean = { ...stripVolatile(obj) };
    if (!obj.kind) {
      for (const key of Object.keys(clean)) {
        if (skipFields.has(key) || CONTROL_FIELDS.has(key)) delete clean[key];
      }
    }
    const kind = obj.kind || 'ModelService';
    const ns = obj.metadata?.namespace || obj.namespace || '';
    const name = obj.metadata?.name || obj.name || '';
    if (index > 0) lines.push('');
    lines.push(`# ${[kind, ns, name].filter(Boolean).join('/')}`);
    lines.push(...JSON.stringify(sortDeep(clean), null, 2).split('\n'));
  });
  return lines;
}

/**
 * 行级 LCS diff。返回操作序列：eq / '-'（只在 before）/ '+'（只在 after）。
 * 超大规模（> 4e6 格）退化为整块替换，避免护栏本身变成 CPU 炸弹。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{ t: 'eq'|'-'|'+', v: string }[]}
 */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4000000) {
    return [...a.map((v) => ({ t: '-', v })), ...b.map((v) => ({ t: '+', v }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', v: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', v: a[i] });
      i += 1;
    } else {
      ops.push({ t: '+', v: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ t: '-', v: a[i++] });
  while (j < m) ops.push({ t: '+', v: b[j++] });
  return ops;
}

/**
 * 生成 unified diff 风格的文本。
 *
 * - 只输出**变化的行**（不含上下文），空 diff 返回 `''`（前端据此决定是否显示预览块）。
 * - 行数上限默认 200，超出后截断并追加一行中文标注（不会静默丢内容）。
 * - 记账字段（createdAt/updatedAt/version）与 k8s 易变元数据会被剥掉，
 *   否则每次保存都会显示「有变化」。
 *
 * @param {unknown} before 渲染后的 k8s 对象（或数组）或归一化后的定义
 * @param {unknown} after  同上
 * @param {{ maxLines?: number, skipFields?: Set<string> }} [options]
 * @returns {string} diff 文本；无变化时为空字符串
 *
 * @example
 * renderDiff(
 *   { namespace: 'inference', name: 'qwen', replicas: 1, resources: { memoryMiB: 1024 } },
 *   { namespace: 'inference', name: 'qwen', replicas: 2, resources: { memoryMiB: 1024 } },
 * );
 * // --- before
 * // +++ after
 * // @@ -6,1 +6,1 @@
 * // -  "replicas": 1,
 * // +  "replicas": 2,
 */
export function renderDiff(before, after, options = {}) {
  const maxLines = isNum(options.maxLines) && options.maxLines > 0 ? Math.floor(options.maxLines) : DIFF_MAX_LINES;
  const a = toRenderLines(before, options);
  const b = toRenderLines(after, options);
  if (!a.length && !b.length) return '';
  if (stableStringify(a) === stableStringify(b)) return '';

  const ops = lcsOps(a, b);
  const body = [];
  let beforeLine = 1;
  let afterLine = 1;
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].t === 'eq') {
      beforeLine += 1;
      afterLine += 1;
      idx += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (idx < ops.length && ops[idx].t !== 'eq') {
      if (ops[idx].t === '-') removed.push(ops[idx].v);
      else added.push(ops[idx].v);
      idx += 1;
    }
    body.push(`@@ -${beforeLine},${removed.length} +${afterLine},${added.length} @@`);
    for (const line of removed) body.push(`-${line}`);
    for (const line of added) body.push(`+${line}`);
    beforeLine += removed.length;
    afterLine += added.length;
  }

  const total = body.length;
  const truncated = total > maxLines;
  const shown = truncated ? body.slice(0, maxLines) : body;
  const out = ['--- before', '+++ after', ...shown];
  if (truncated) out.push(`... [diff 已截断：共 ${total} 行，仅显示前 ${maxLines} 行]`);
  return out.join('\n');
}

// ─── 跨形态 diff ─────────────────────────────────────────────────────────

/**
 * 输入形态：渲染后的 k8s 对象 / 归一化的意图定义 / 空。
 * @param {unknown} input
 * @returns {'rendered'|'intent'|'empty'}
 */
function shapeOf(input) {
  const objects = asObjectList(input);
  if (!objects.length) return 'empty';
  if (objects.some((o) => o.kind)) return 'rendered';
  if (objects.some(isIntent)) return 'intent';
  return 'rendered';
}

/** 跨形态比较时关心的字段（护栏与用户都看得懂的维度） */
const VIEW_DIFF_FIELDS = ['namespace', 'name', 'replicas', 'image', 'memoryMiB', 'accelerators', 'coresPercent'];

/**
 * 把归一化视图摊成 diff 行。
 * @param {ReturnType<typeof makeView>} view
 * @returns {string[]}
 */
function viewToLines(view) {
  if (!view.present) return [];
  const fields = {};
  for (const key of VIEW_DIFF_FIELDS) fields[key] = view[key] ?? null;
  return [`# ModelService/${view.namespace || ''}/${view.name || ''}`, ...JSON.stringify(sortDeep(fields), null, 2).split('\n')];
}

/**
 * checkGuard 内部用：同形态直接 diff 原对象（信息最全）；
 * 跨形态（existing 是集群读回来的 k8s 对象、after 是表单里的 ModelService）
 * 退到归一化字段上比较 —— 否则两边 JSON 形状天然不同，diff 会「全部都变」。
 * @param {unknown} beforeInput
 * @param {unknown} afterInput
 * @param {ReturnType<typeof makeView>} beforeView
 * @param {ReturnType<typeof makeView>} afterView
 * @returns {string}
 */
function diffForGuard(beforeInput, afterInput, beforeView, afterView) {
  const beforeShape = shapeOf(beforeInput);
  const afterShape = shapeOf(afterInput);
  if (beforeShape === 'empty' || afterShape === 'empty' || beforeShape === afterShape) {
    return renderDiff(beforeInput, afterInput);
  }
  return renderDiff(viewToLines(beforeView), viewToLines(afterView));
}

// ─── impact ──────────────────────────────────────────────────────────────

/**
 * 单项变更的原因描述（中文，面向用户，不含内部术语）。
 * @param {string} field
 * @param {unknown} from
 * @param {unknown} to
 * @returns {string}
 */
function describeChange(field, from, to) {
  return `${field}：${from ?? '未设置'} → ${to ?? '未设置'}`;
}

/**
 * 估算变更影响。**这是产品必须对用户说清楚的事实**：
 *
 * - k8s 里 Pod 的 `resources`（以及镜像、亲和、端口）不可原地修改，
 *   改配额 = 必须重建 Pod。单副本重建期间没有冗余副本承接流量，
 *   所以中断时长要给保守值（≥ 30 秒，这里取 60）。
 * - 只改 `replicas` 是扩缩容，已运行的 Pod 不会被重建 → `restarts: false`。
 * - 多副本改配额可以滚动替换 → 中断很低（这里估 5 秒连接抖动）。
 *
 * @param {unknown} before 变更前（渲染后的对象或归一化定义）；创建时传 null/undefined
 * @param {unknown} after  变更后；删除时传 null/undefined
 * @returns {{
 *   action: 'create'|'update'|'delete'|'noop',
 *   restarts: boolean,
 *   downtimeEstimateSec: number,
 *   reasons: string[]
 * }}
 *
 * @example
 * summarizeImpact(
 *   { namespace: 'inference', name: 'qwen', replicas: 1, resources: { memoryMiB: 1024 } },
 *   { namespace: 'inference', name: 'qwen', replicas: 1, resources: { memoryMiB: 2048 } },
 * );
 * // { action: 'update', restarts: true, downtimeEstimateSec: 60, reasons: [...] }
 */
export function summarizeImpact(before, after) {
  const prev = makeView(before);
  const next = makeView(after);
  const reasons = [];

  if (!prev.present && !next.present) {
    return { action: 'noop', restarts: false, downtimeEstimateSec: 0, reasons: ['变更前后都没有对象，没有需要执行的动作'] };
  }

  if (!next.present) {
    reasons.push(`将删除 ${prev.namespace || '?'}/${prev.name || '?'}（${prev.replicas ?? 1} 个副本）`);
    reasons.push('删除会终止现有 Pod，服务整体下线；这不是「重启」，可回滚窗口由执行器保存的快照决定');
    return { action: 'delete', restarts: false, downtimeEstimateSec: DOWNTIME_ESTIMATE.noneSec, reasons };
  }

  if (!prev.present) {
    reasons.push(`新建 ${next.namespace || '?'}/${next.name || '?'}，${next.replicas ?? 1} 个副本`);
    reasons.push('当前没有正在运行的副本，本次操作不产生「中断」（首次拉起仍需要等模型加载完成）');
    return { action: 'create', restarts: false, downtimeEstimateSec: DOWNTIME_ESTIMATE.noneSec, reasons };
  }

  if (prev.fullHash === next.fullHash) {
    return { action: 'noop', restarts: false, downtimeEstimateSec: 0, reasons: ['定义与现状一致，不会产生任何变更'] };
  }

  // ── 逐项判定 ──
  //
  // 只有「两侧都读到了值」才敢说这一项被改过：
  // existing 从集群读回来（渲染对象，可能没渲染 GPU 显存键）、after 来自表单（意图），
  // 一侧 null 一侧 4096 是「信息缺失」，不是「配额变了」——把它当变更会让
  // 产品对着一次纯扩缩容说「会重启」，那是错的。
  const changed = (from, to) => from !== null && to !== null && from !== to;
  const memChanged = changed(prev.memoryMiB, next.memoryMiB);
  const coresChanged = changed(prev.coresPercent, next.coresPercent);
  const accelChanged = changed(prev.accelerators, next.accelerators);
  const resourcesChanged = memChanged || coresChanged || accelChanged;
  const imageChanged = changed(prev.image, next.image);
  const replicasChanged = changed(prev.replicas, next.replicas);
  const podChanged = prev.podHash !== next.podHash;

  // resources 一定在 podTemplate 里，但这里仍然显式 OR 一次：
  // 即使上游传进来的定义形状不标准（比如只有 resources 没有完整 pod 模板），
  // 「改配额 ⇒ 重建 Pod」这条事实也不能被漏掉。
  const restarts = podChanged || resourcesChanged;

  if (resourcesChanged) {
    const parts = [];
    if (memChanged) parts.push(describeChange('显存配额 memoryMiB', prev.memoryMiB, next.memoryMiB));
    if (coresChanged) parts.push(describeChange('算力配额 coresPercent', prev.coresPercent, next.coresPercent));
    if (accelChanged) parts.push(describeChange('加速卡数 accelerators', prev.accelerators, next.accelerators));
    reasons.push(`资源配额变更（${parts.join('；')}）：k8s 中 Pod 的 resources 不支持原地修改，必须重建 Pod`);
  }
  if (imageChanged) {
    reasons.push(`镜像变更（${prev.image ?? '未设置'} → ${next.image ?? '未设置'}）：触发滚动更新，Pod 会被逐个替换`);
  }
  if (replicasChanged) {
    reasons.push(`副本数变更（${prev.replicas ?? '未设置'} → ${next.replicas ?? '未设置'}）：仅扩缩容，已运行的 Pod 不会被重建`);
  }
  if (!resourcesChanged && !imageChanged && !replicasChanged && podChanged) {
    reasons.push('Pod 模板有其它变更（启动参数 / 模型 / 亲和 / 端口 / 探针）：受影响的 Pod 会被重建');
  }
  if (!restarts && !replicasChanged) {
    reasons.push('本次只改动网关/暴露等非 Pod 字段，Pod 不受影响');
  }

  let downtimeEstimateSec = DOWNTIME_ESTIMATE.noneSec;
  if (restarts) {
    // 滚动替换要求「变更前后」都有 ≥2 副本；否则新 Pod Ready 之前没有冗余。
    const rollableReplicas = Math.min(prev.replicas ?? 1, next.replicas ?? 1);
    if (rollableReplicas >= 2) {
      downtimeEstimateSec = DOWNTIME_ESTIMATE.rollingSec;
      reasons.push(`${rollableReplicas} 个副本可滚动替换：新 Pod 就绪后再摘旧 Pod，预计只有 ${DOWNTIME_ESTIMATE.rollingSec} 秒连接抖动`);
    } else {
      downtimeEstimateSec = DOWNTIME_ESTIMATE.singleReplicaSec;
      reasons.push(
        `当前只有 ${rollableReplicas} 个副本，重建期间没有其它副本承接流量：预计中断约 ${DOWNTIME_ESTIMATE.singleReplicaSec} 秒（保守估计，模型越大加载越久）`,
      );
    }
  }

  return { action: 'update', restarts, downtimeEstimateSec, reasons };
}

// ─── 主护栏 ──────────────────────────────────────────────────────────────

/**
 * 所有变更前的唯一入口。返回是否放行、违规明细、以及给人看的 diff。
 *
 * 检查顺序（也是前端展示顺序）：形状 → 命名空间 → 开关 → 归属 → 资源上限 → 变更幅度。
 * 前四项是**硬阻断**，`force` 无效；只有 `BIG_CHANGE` 可以被显式 force 覆盖并留审计标记。
 *
 * @param {object} args
 * @param {object} args.service   目标 ModelService（或 k8s 对象数组、或 `{ objects }`）
 * @param {object|null} [args.existing] 现状（同 key 的已存在对象）；不存在传 null。
 *   **必须传集群里读回来的对象**（A1 渲染形态，带 `metadata.labels.managedBy`），
 *   不要传数据库里那条 ModelService 记录 —— 记录上没有归属标签，护栏会把它当成
 *   「别人的对象」而拒绝修改（这是故意的：宁可拦错，不可放错）。
 * @param {object} [args.settings] 上限覆盖：`{ maxMemoryMiB, maxAccelerators, maxReplicas, changeFactor }`
 * @param {Record<string, string|undefined>} [args.env] 环境变量，用于判定 `OPENLOG_K8S_INFRA`
 * @param {'apply'|'delete'} [args.op] 操作类型，默认 apply
 * @param {boolean} [args.force] 显式确认大幅度变更（只对 BIG_CHANGE 生效）
 * @returns {{
 *   allowed: boolean,
 *   violations: { code: string, message: string, field?: string, overridden?: boolean }[],
 *   diff: string,
 *   audit: { forced: string[], note: string } | null,
 *   key: string,
 *   limits: { memoryMiB: number, accelerators: number, replicas: number, changeFactor: number }
 * }}
 *
 * @example
 * const r = checkGuard({
 *   service: { namespace: 'inference', name: 'qwen', replicas: 2, resources: { memoryMiB: 4096, accelerators: 1 } },
 *   existing: null,
 *   settings: {},
 *   env: { OPENLOG_K8S_INFRA: '1' },
 * });
 * // r.allowed === true, r.violations.length === 0, r.diff 以 '+' 行给出新建内容
 */
export function checkGuard({ service, existing, settings, env, op, action, force } = {}) {
  const violations = [];
  const limits = resolveLimits(settings);
  const envMap = env && typeof env === 'object' ? env : {};
  const operation = resolveOp({ service, op, action });
  const forceRequested = force === true || service?.force === true || settings?.force === true;

  const prev = makeView(existing);
  const nextRaw = makeView(service);
  // 删除时调用方可能只传 existing（`{ existing, op: 'delete' }`）：
  // 这时用现状补齐目标，让命名空间/归属检查照常生效，而不是报「缺定义」。
  const next = !nextRaw.present && operation === 'delete' && prev.present ? prev : nextRaw;

  // 1) 形状：护栏无法判断安全性的请求必须直接拒绝（而不是「默认放行」）
  if (!next.present) {
    violations.push(
      violation(
        VIOLATION_CODES.INVALID_SERVICE,
        '变更请求里没有可识别的服务定义（缺少 name / namespace / resources）。请先通过 validateModelService 校验定义，再提交到护栏。',
        'service',
      ),
    );
  }
  if (next.present && !next.name) {
    violations.push(
      violation(VIOLATION_CODES.INVALID_SERVICE, '服务缺少 name，无法确定要创建或修改哪个对象。请补上符合 DNS-1123 的服务名。', 'name'),
    );
  }

  // 2) 命名空间白名单：意图与既有对象都要查（既防止写进系统命名空间，也防止误删）
  const namespaces = new Set();
  if (next.present && next.namespace) namespaces.add(next.namespace);
  for (const ns of next.namespaces) namespaces.add(ns);
  for (const ns of prev.namespaces) namespaces.add(ns);

  if (!namespaces.size && next.present) {
    violations.push(
      violation(VIOLATION_CODES.NAMESPACE_FORBIDDEN, '服务缺少 namespace，无法确认落点。请显式指定 inference 或 infra-test。', 'namespace'),
    );
  }
  for (const ns of namespaces) {
    if (ALLOWED_NAMESPACES.includes(ns)) continue;
    const isSystem = FORBIDDEN_NAMESPACES.includes(ns);
    violations.push(
      violation(
        VIOLATION_CODES.NAMESPACE_FORBIDDEN,
        isSystem
          ? `命名空间「${ns}」是系统命名空间，禁止在其中创建、修改或删除任何对象（哪怕名字合法）。请改用 inference 或 infra-test。`
          : `命名空间「${ns}」不在白名单内。只允许 inference（正式推理）或 infra-test（试跑）；请在定义里改 namespace 后重试。`,
        'namespace',
      ),
    );
  }

  // 3) 总开关：新能力默认关闭（铁律 4）
  if (String(envMap.OPENLOG_K8S_INFRA) !== '1') {
    violations.push(
      violation(
        VIOLATION_CODES.INFRA_DISABLED,
        "基础设施写入能力未启用（OPENLOG_K8S_INFRA 不等于 '1'）。这是默认关闭的保护：请由管理员在服务端环境变量设置 OPENLOG_K8S_INFRA=1 并重启 OpenLog，或改用只读视图。",
        'OPENLOG_K8S_INFRA',
      ),
    );
  }

  // 4) 归属：同 key 已存在但不是本系统创建 → 一律不许动
  const sameTarget = prev.present && next.present && prev.name === next.name && prev.namespace === next.namespace;
  const deleting = operation === 'delete';
  if (prev.present && !prev.managed) {
    violations.push(
      violation(
        VIOLATION_CODES.NOT_MANAGED,
        `「${prev.namespace || '?'}/${prev.name || '?'}」已存在，但不带 managedBy=${MANAGED_BY_VALUE} 标签，说明它不是本系统创建的对象。为避免误删生产，禁止${deleting ? '删除' : '修改'}它；请换一个 name，或让创建者补上标签后由人工迁移（若你传的 existing 是数据库记录而非集群对象，改传集群现状即可）。`,
        'managedBy',
      ),
    );
  }
  // 用户显式把归属标成别人：创建出来的对象会“看起来属于别的 operator”，
  // 之后清理逻辑就不敢删它 —— 这类污染必须在入口挡住。
  const declaredOwner = service?.labels?.[MANAGED_BY_KEY] ?? (Array.isArray(service) ? undefined : service?.[MANAGED_BY_KEY]);
  if (declaredOwner !== undefined && declaredOwner !== MANAGED_BY_VALUE) {
    violations.push(
      violation(
        VIOLATION_CODES.NOT_MANAGED,
        `定义里把 managedBy 标成了「${declaredOwner}」，不是 ${MANAGED_BY_VALUE}。冒用别人的归属标签会污染清理逻辑，请删掉该字段（系统会自动打标）。`,
        'managedBy',
      ),
    );
  }
  // 同 key 且未受管的场景已由上面那条 NOT_MANAGED 覆盖，这里不重复报，
  // 避免前端把同一个违规显示两遍。

  // 5) 资源上限（只在写操作时校验；删除不看配额）
  if (next.present && !deleting) {
    if (isNum(next.memoryMiB) && next.memoryMiB > limits.memoryMiB) {
      violations.push(
        violation(
          VIOLATION_CODES.MEMORY_LIMIT_EXCEEDED,
          `单 Pod 显存配额 ${next.memoryMiB} MiB 超过上限 ${limits.memoryMiB} MiB。请把 resources.memoryMiB 下调到 ${limits.memoryMiB} 以内，或由管理员上调 settings.maxMemoryMiB。`,
          'resources.memoryMiB',
        ),
      );
    }
    if (isNum(next.accelerators) && (next.accelerators > limits.accelerators || next.accelerators < 0)) {
      violations.push(
        violation(
          VIOLATION_CODES.ACCELERATOR_LIMIT_EXCEEDED,
          `每副本申请加速卡 ${next.accelerators} 张，超出允许范围 0..${limits.accelerators}。请下调 resources.accelerators，或拆成多个更小的副本后重试。`,
          'resources.accelerators',
        ),
      );
    }
    if (isNum(next.replicas) && (next.replicas > limits.replicas || next.replicas < 1)) {
      violations.push(
        violation(
          VIOLATION_CODES.REPLICAS_LIMIT_EXCEEDED,
          `副本数 ${next.replicas} 超出允许范围 1..${limits.replicas}。请调整 replicas；需要更高并发请换更大的 acceleratorModel 或先扩容集群。`,
          'replicas',
        ),
      );
    }
  }

  // 6) 变更幅度：一次跳太多（4 倍以上）要求显式 force + 审计
  if (sameTarget && !deleting) {
    if (exceedsFactor(prev.replicas, next.replicas, limits.changeFactor)) {
      violations.push(
        violation(
          VIOLATION_CODES.BIG_CHANGE,
          `副本数一次从 ${prev.replicas} 变到 ${next.replicas}（超过 ${limits.changeFactor} 倍）。请拆成多次小步扩缩容；确认无风险后可带 force: true 提交，该次操作会被审计标记。`,
          'replicas',
        ),
      );
    }
    if (exceedsFactor(prev.memoryMiB, next.memoryMiB, limits.changeFactor)) {
      violations.push(
        violation(
          VIOLATION_CODES.BIG_CHANGE,
          `显存配额一次从 ${prev.memoryMiB} MiB 变到 ${next.memoryMiB} MiB（超过 ${limits.changeFactor} 倍）。请分两次调整；确认无风险后可带 force: true 提交，该次操作会被审计标记。`,
          'resources.memoryMiB',
        ),
      );
    }
  }

  // 7) force 只覆盖 BIG_CHANGE，其余硬阻断一律不放行
  let audit = null;
  if (forceRequested) {
    const forcedCodes = [];
    for (const v of violations) {
      if (FORCIBLE_CODES.has(v.code)) {
        v.overridden = true;
        forcedCodes.push(v.code);
      }
    }
    if (forcedCodes.length) {
      audit = {
        forced: [...new Set(forcedCodes)],
        note: `已通过 force 显式确认大幅变更，审计日志必须保留本次操作（${forcedCodes.join(', ')}）`,
      };
    }
  }

  const allowed = violations.every((v) => v.overridden === true);
  const diff = diffForGuard(prev.present ? existing : null, deleting ? null : service, prev, next);

  return {
    allowed,
    violations,
    diff,
    audit,
    key: `${next.namespace || prev.namespace || '?'}/${next.name || prev.name || '?'}`,
    limits,
  };
}

export default { checkGuard, renderDiff, summarizeImpact };
