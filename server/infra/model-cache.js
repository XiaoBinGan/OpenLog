/**
 * AI Infra 能力层 B4：模型权重共享缓存（同一节点多副本共享一份只读权重）
 *
 * ── 为什么必须有这一层（真机踩过的坑）────────────────────────────────────
 * node1 曾因磁盘压力在几分钟内被 Evicted 掉几十个 Pod，节点被自动打上
 * `node.kubernetes.io/disk-pressure:NoSchedule` taint，此后**任何**新 Pod 都调不上去，
 * 排查方向全被带偏（大家一开始都在查显存和调度器）。
 * 根因很简单：模型权重动辄几十 GB（strata 的 Q2_0 是 67GB），而当时的部署方式是
 * 每个副本各自准备一份 —— 3 副本 × 67GB = 201GB，一块 200GB 的数据盘直接满。
 *
 * 所以本模块守的是一条硬规则：
 *
 *   **同一节点上的多个副本，必须挂同一个只读目录；绝不允许每 Pod 各拷一份。**
 *
 * k8s 里能表达「共享」的只有两种东西：
 *   · hostPath —— 只能在同一节点内共享（跨节点各有一份，磁盘照样翻倍）；
 *   · PVC ReadWriteMany —— 真共享（NFS / CephFS / S3-CSI 之类），跨节点也一份。
 * 本模块把「用户给的缓存配置 + 节点清单 + 已有缓存」翻译成这两者之一，
 * 并在退化（跨节点 hostPath、RWO PVC）时**明确告警 + 给出各占多少 GiB**，
 * 让用户在上线前就看到盘会不会爆，而不是等 kubelet 打完 taint 再去猜。
 *
 * ── 职责边界 ──────────────────────────────────────────────────────────
 * · **纯函数**：不连集群、不读盘、不读环境变量；节点/已有缓存全部由调用方注入。
 * · **不抛异常**：`validateModelCache` / `planModelCache` / `estimateDiskUsage` 一律把
 *   问题收集进 `errors[]` / `warnings[]`；只有 `renderCacheResources` 在拿到**畸形 plan**
 *   时抛错（它要直接产出可提交的 spec，脏数据不能带进 Deployment）。
 * · **不碰别人的文件**：不 import render.js（避免循环依赖），只借用 model.js 的白名单校验；
 *   render.js 要用这里的结果时，调 `renderCacheResources({ plan })` 拿到
 *   `{ volumes, volumeMounts }` 直接塞进 podSpec，见文件末尾的接线说明。
 * · **确定性**：同输入必得同输出（数组顺序、warning 顺序、四舍五入全部稳定）。
 *
 * ── 导出 ──────────────────────────────────────────────────────────────
 *   validateModelCache({ service, cache })   → { ok, errors[], value }
 *   planModelCache({ service, nodes, existingCaches, cache })
 *                                            → { strategy, volumes, volumeMounts, warnings, shared, … }
 *   estimateDiskUsage({ model, replicas, nodeCount })
 *                                            → { perPodMiB, totalMiB, savedMiB, assumption, … }
 *   renderCacheResources({ plan })           → { volumes, volumeMounts }
 *
 * ── 与 render.js 的接线（建议）────────────────────────────────────────
 * ```js
 * const plan = planModelCache({ service: svc, nodes, existingCaches });
 * const cache = renderCacheResources({ plan });
 * const deployment = renderDeployment(svc, { resources });
 * deployment.spec.template.spec.volumes = cache.volumes;            // ← 只在非空时写
 * deployment.spec.template.spec.containers[0].volumeMounts = cache.volumeMounts;
 * ```
 * 也就是说：**volumes 属于 podSpec，volumeMounts 属于 container**，两边不能写错层级
 * （写反了 k8s 会以 `spec.containers[0].volumeMounts[0].name: Not found` 拒掉）。
 */

import { validateModelService, serviceKey } from './model.js';

/** 缓存配置的形态枚举（用户意图层）。`none` = 不做共享挂载。 */
export const CACHE_MODES = Object.freeze(['hostPath', 'pvc', 'none']);

/**
 * 规划结果的策略枚举（决策层）。
 * · `hostPath`  节点本地目录，同节点共享、跨节点各一份；
 * · `pvc-rwx`   PVC 带 ReadWriteMany，跨节点真共享；
 * · `pvc-rwo`   PVC 只有 ReadWriteOnce（降级形态）：同节点多副本可共享，跨节点不行；
 * · `none`      没有可共享的目录，每个 Pod 各自准备权重（**最危险**，告警里会算盘）。
 */
export const CACHE_STRATEGIES = Object.freeze(['hostPath', 'pvc-rwx', 'pvc-rwo', 'none']);

/** 合法的 PVC accessModes（k8s 全集）。 */
export const ACCESS_MODES = Object.freeze(['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod']);

/** 唯一能跨节点共享的 accessMode。 */
export const SHARED_ACCESS_MODE = 'ReadWriteMany';

/** 缓存卷的名字（稳定，便于 diff 与排查）。 */
export const CACHE_VOLUME_NAME = 'model-cache';

/** PVC 形态的默认容器内挂载点（hostPath 形态默认「同路径挂同路径」，见 validate）。 */
export const CACHE_MOUNT_PATH = '/models';

/** 既没给 sizeMiB 也没给参数量/量化时的保守假设（MiB）。 */
export const DEFAULT_ASSUMED_SIZE_MIB = 8192;

/** 量化推断的索引/对齐余量系数（词表、safetensors header、对齐填充）。 */
export const DISK_OVERHEAD_FACTOR = 1.05;

/** 副本数上限：与 model.js 的护栏一致（DEFAULT_LIMITS.maxReplicas）。 */
export const MAX_REPLICAS = 8;

/** 缓存路径长度上限（与 model.js 的 pathMaxLength 对齐）。 */
export const MAX_CACHE_PATH_LENGTH = 1024;

/**
 * 拒绝的 hostPath 根：这些目录挂进容器等于把宿主机交出去，或者会把 kubelet
 * 自己的目录搅乱（`/var/lib/kubelet` 下是卷与 pod 的元数据）。
 */
export const FORBIDDEN_HOST_PATHS = Object.freeze([
  '/',
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/root',
  '/run',
  '/var/run',
  '/var/lib/kubelet',
  '/var/lib/docker',
]);

/**
 * 量化标记 → 每权重比特数。Q2_0 是 GGUF 的 2-bit 量化（strata 那个 67GB 的模型就是它）。
 * 键一律小写；`Q4_K_M` 之类带后缀的走前缀匹配（见 resolveBits）。
 */
export const QUANT_BITS_PER_WEIGHT = Object.freeze({
  fp32: 32,
  f32: 32,
  fp16: 16,
  f16: 16,
  bf16: 16,
  half: 16,
  fp8: 8.5,
  int8: 8.5,
  w8a8: 8.5,
  q8: 8.5,
  q8_0: 8.5,
  q6: 6.56,
  q6_k: 6.56,
  q5: 5.5,
  q5_0: 5.5,
  q5_k: 5.5,
  q4: 4.5,
  q4_0: 4.5,
  q4_k: 4.5,
  int4: 4.5,
  awq: 4.5,
  gptq: 4.5,
  w4a16: 4.5,
  q3: 3.44,
  q3_k: 3.44,
  q2: 2.56,
  q2_0: 2.56,
  q2_k: 2.56,
});

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const PVC_SIZE = /^\d+(\.\d+)?(Mi|Gi|Ti)$/;

const MAX_REPLICAS_LIMIT = 64;

/** mm 是否是「普通对象」。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把人能读的中文类型名塞进错误文案。 */
function describeType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'object') return '对象';
  if (typeof value === 'string') return '字符串';
  return typeof value;
}

/** 回显用户输入（字符串加引号，对象只给类型，超长截断）。 */
function quote(value) {
  let text;
  if (typeof value === 'string') text = JSON.stringify(value);
  else if (value === undefined) text = 'undefined';
  else if (value === null) text = 'null';
  else if (typeof value === 'object') text = Array.isArray(value) ? '数组' : '对象';
  else text = String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 深拷贝（只处理纯数据；plan/volumes 都是 JSON 可表达的结构）。 */
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 整数夹取：非法值回落到 fallback，随后夹到 [min, max]。 */
function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 归一化文件系统路径：折叠重复 `/`、去掉尾部 `/`（根路径 `/` 保持原样）。
 * 不解析 `..`（那属于校验失败，不能被「悄悄修正」）。
 *
 * @param {string} input 原始路径
 * @returns {string} 归一化后的路径
 */
function normalizeFsPath(input) {
  const text = String(input).trim();
  const collapsed = text.replace(/\/{2,}/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.replace(/\/+$/, '');
}

/** 是否是禁止挂载的宿主机目录（含其子目录）。 */
function isForbiddenHostPath(path) {
  return FORBIDDEN_HOST_PATHS.some((root) => path === root || (root !== '/' && path.startsWith(`${root}/`)));
}

/** `'512 MiB'` / `'7.8 GiB'`（告警文案统一口径，与 capacity.js 的 formatMiB 一致）。 */
function formatMiB(mib) {
  const n = Number(mib);
  if (!Number.isFinite(n)) return '未知';
  if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} GiB`;
  return `${Math.round(n)} MiB`;
}

/** 把 errors[] 压成一句中文（给 warnings 用）。 */
function formatErrors(errors) {
  return errors
    .map((error) => (error.field ? `${error.field}: ${error.message}` : error.message))
    .join('；');
}

// ---------------------------------------------------------------- 路径校验

/**
 * 校验一条「宿主机/容器内路径」并返回归一化结果。
 *
 * 三类拒绝：
 *  1. 空串 / 非字符串 / 超长 / 含空白；
 *  2. 相对路径（必须以 `/` 开头）——相对路径在 k8s 里会被当成相对工作目录，
 *     实际挂载点跟镜像 WORKDIR 有关，属于不可控；
 *  3. 含 `..`（目录穿越）：`/models/../../etc/shadow` 这种一旦被拼进去，
 *     容器就能读到宿主机的任意文件。
 *
 * @param {unknown} raw 原始路径
 * @param {string} field 错误归因字段（如 `cache.hostPath`）
 * @param {string} label 中文标签（如「缓存目录」）
 * @param {(field: string, message: string) => void} fail 错误收集器
 * @returns {string} 归一化后的路径；校验失败时返回 `''`
 */
function validatePath(raw, field, label, fail) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail(field, `${label}必填：必须是绝对路径（以 / 开头），例如 /models/Qwen3-8B（收到 ${quote(raw)}）`);
    return '';
  }
  const path = normalizeFsPath(raw);
  if (path.length > MAX_CACHE_PATH_LENGTH) {
    fail(field, `${label}最长 ${MAX_CACHE_PATH_LENGTH} 个字符（当前 ${path.length}），请缩短到 1024 以内`);
    return '';
  }
  if (!path.startsWith('/')) {
    fail(field, `${label}必须是绝对路径（以 / 开头，收到 ${quote(path)}）；相对路径会跟随镜像 WORKDIR，挂载点不可控`);
    return '';
  }
  if (path.includes('..')) {
    fail(field, `${label}不允许包含 ".."（目录穿越，会越出挂载根读到宿主机其他文件，收到 ${quote(path)}）`);
    return '';
  }
  if (/\s/.test(path)) {
    fail(field, `${label}不允许包含空白字符（收到 ${quote(path)}）`);
    return '';
  }
  return path;
}

// ---------------------------------------------------------------- 缓存配置

/** 从原始 service 里取内联的缓存配置（`service.cache` 或 `service.model.cache`）。 */
function inlineCacheConfig(service) {
  if (!isPlainObject(service)) return null;
  if (isPlainObject(service.cache)) return service.cache;
  if (isPlainObject(service.model) && isPlainObject(service.model.cache)) return service.model.cache;
  return null;
}

/**
 * 解析「用户想用哪种缓存形态」：`mode` 优先，其次 `strategy`，最后按字段猜测。
 *
 * @param {object} input 缓存配置对象
 * @returns {string} `hostPath` / `pvc` / `none`（非法值原样返回，交给调用方报错）
 */
function resolveMode(input) {
  if (typeof input.mode === 'string') return input.mode;
  if (typeof input.strategy === 'string') {
    // 允许直接写规划层的策略名，避免调用方两套词表。
    if (input.strategy === 'pvc-rwx' || input.strategy === 'pvc-rwo') return 'pvc';
    return input.strategy;
  }
  if (typeof input.hostPath === 'string') return 'hostPath';
  if (isPlainObject(input.pvc)) return 'pvc';
  return 'none';
}

/**
 * 校验缓存配置并规范化；同时校验 service（借用 model.js 的白名单校验）。
 *
 * 缺省行为（需要写进文档，否则调用方会以为「没配 = 不挂」）：
 * · `model.source === 'hostPath'` 且没给 cache → 自动按 hostPath 共享
 *   `model.path`（同路径挂同路径，`MODEL_PATH` 环境变量天然有效）；
 * · 其余来源且没给 cache → `mode: 'none'`（plan 会算「每 Pod 各一份」的盘并告警）。
 *
 * @param {object} input
 * @param {unknown} input.service 模型服务定义（原始或已规范化均可）
 * @param {unknown} [input.cache] 缓存配置：
 *   `{ mode: 'hostPath'|'pvc'|'none', hostPath, mountPath, readOnly, pvc: { claimName, accessModes, storageClassName, size, subPath, readOnly } }`
 * @returns {{ ok: boolean, errors: Array<{field: string, message: string}>, value: object }}
 *   `value`：`{ mode, hostPath, mountPath, readOnly, pvc, serviceKey, modelPath, source, namespace, replicas, nodeSelector, derived }`
 */
export function validateModelCache({ service, cache } = {}) {
  const errors = [];
  const fail = (field, message) => {
    errors.push({ field, message });
  };

  const value = {
    mode: 'none',
    hostPath: '',
    mountPath: '',
    readOnly: true,
    pvc: null,
    serviceKey: '',
    modelPath: '',
    source: '',
    namespace: '',
    replicas: 1,
    nodeSelector: {},
    derived: false,
  };

  const serviceValidation = validateModelService(service);
  if (!serviceValidation.ok) {
    for (const error of serviceValidation.errors) {
      fail(error.field ? `service.${error.field}` : 'service', error.message);
    }
  } else {
    const svc = serviceValidation.value;
    value.serviceKey = serviceKey(svc);
    value.modelPath = svc.model.path;
    value.source = svc.model.source;
    value.namespace = svc.namespace;
    value.replicas = svc.replicas;
    value.nodeSelector = { ...svc.placement.nodeSelector };
  }

  const explicit = cache !== undefined && cache !== null ? cache : inlineCacheConfig(service);
  let input = explicit;

  if (input === undefined || input === null || input === '') {
    if (serviceValidation.ok && serviceValidation.value.model.source === 'hostPath') {
      // 权重本来就在宿主机目录里：默认按「同路径只读挂载」共享，不额外要求用户配置。
      input = { mode: 'hostPath', hostPath: serviceValidation.value.model.path };
      value.derived = true;
    } else {
      input = { mode: 'none' };
      value.derived = true;
    }
  }

  if (!isPlainObject(input)) {
    fail('cache', `cache 必须是对象，例如 { mode: "hostPath", hostPath: "/models/Qwen3-8B" }（收到 ${describeType(input)}）`);
    return { ok: false, errors, value };
  }

  const mode = resolveMode(input);
  if (!CACHE_MODES.includes(mode)) {
    fail(
      'cache.mode',
      `cache.mode 只允许 ${CACHE_MODES.join(' / ')}，收到 ${quote(mode)}；`
      + 'hostPath = 节点本地目录（同节点共享），pvc = 持久卷（RWX 才能跨节点共享），none = 不挂共享目录',
    );
    return { ok: false, errors, value };
  }
  value.mode = mode;

  validateReadOnly(input.readOnly, value, fail);

  if (mode === 'hostPath') {
    const claim = isPlainObject(input.pvc) ? input.pvc.claimName : '';
    if (claim) {
      fail('cache.pvc', `cache.mode=hostPath 时不应同时给 cache.pvc（收到 claimName=${quote(claim)}）；二选一，或把 mode 改成 pvc`);
    }
    const hostPath = validatePath(input.hostPath, 'cache.hostPath', 'cache.hostPath（宿主机缓存目录）', fail);
    if (hostPath && isForbiddenHostPath(hostPath)) {
      fail(
        'cache.hostPath',
        `cache.hostPath 不允许挂宿主机系统目录（收到 ${quote(hostPath)}）：/ 与 /etc /proc /sys /dev /boot /root /run /var/lib/kubelet 等挂进容器等于交出宿主机；`
        + '请改成专用的模型目录，例如 /models 或 /data/models',
      );
    }
    if (!errors.some((error) => error.field === 'cache.hostPath') && hostPath) value.hostPath = hostPath;
  }

  if (mode === 'pvc') {
    if (typeof input.hostPath === 'string' && input.hostPath.trim() !== '') {
      fail('cache.hostPath', `cache.mode=pvc 时不应同时给 hostPath（收到 ${quote(input.hostPath)}）；二选一，或把 mode 改成 hostPath`);
    }
    value.pvc = validatePvc(input.pvc, fail);
  }

  if (mode === 'none') {
    const extra = [];
    if (typeof input.hostPath === 'string' && input.hostPath.trim() !== '') extra.push(`hostPath=${quote(input.hostPath)}`);
    if (isPlainObject(input.pvc)) extra.push('pvc');
    if (extra.length > 0) {
      fail(
        'cache.mode',
        `cache.mode=none 表示不挂共享目录，但又给了 ${extra.join(' 与 ')}：配置自相矛盾，请删掉这些字段或把 mode 改成对应形态`,
      );
    }
  }

  // 容器内挂载点：hostPath 默认「同路径挂同路径」，PVC 默认 /models。
  // mode=none 不挂任何东西，留空（render 出的数组也是空的，避免出现「有挂载点没卷」的半成品）。
  const defaultMount = mode === 'hostPath' ? value.hostPath : mode === 'pvc' ? CACHE_MOUNT_PATH : '';
  if (input.mountPath !== undefined && input.mountPath !== null && input.mountPath !== '') {
    const mountPath = validatePath(input.mountPath, 'cache.mountPath', 'cache.mountPath（容器内挂载点）', fail);
    if (mountPath) value.mountPath = mountPath;
  } else if (defaultMount) {
    value.mountPath = defaultMount;
  }

  if (value.mountPath && value.mountPath.startsWith('/proc')) {
    fail('cache.mountPath', `cache.mountPath 不允许挂到 /proc 下（收到 ${quote(value.mountPath)}），会盖掉容器自身的进程文件系统`);
  }

  return { ok: errors.length === 0, errors, value };
}

/** readOnly 必须是 true：共享目录一旦可写，多副本并发写同一份权重就会把模型写坏。 */
function validateReadOnly(raw, value, fail) {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'boolean') {
    fail('cache.readOnly', `cache.readOnly 必须是布尔值（收到 ${describeType(raw)}）；默认 true，共享目录必须只读挂载`);
    return;
  }
  if (raw === false) {
    fail(
      'cache.readOnly',
      'cache.readOnly 必须为 true：共享权重目录对推理副本只能只读挂载，否则多个副本并发写入会直接写坏权重；'
      + '需要预热/转换权重请用独立的 Job（跑完即退），不要放开推理 Pod 的写权限',
    );
    return;
  }
  value.readOnly = true;
}

/** PVC 配置校验：claimName 必填且是 DNS-1123 label；accessModes 必须非空且在枚举内。 */
function validatePvc(input, fail) {
  if (!isPlainObject(input)) {
    fail('cache.pvc', `cache.mode=pvc 时 cache.pvc 必填：需要 { claimName, accessModes: ["ReadWriteMany"] }（收到 ${describeType(input)}）`);
    return null;
  }
  const pvc = { claimName: '', accessModes: [], readOnly: true };

  const claimName = typeof input.claimName === 'string' ? input.claimName.trim() : '';
  if (!claimName) {
    fail('cache.pvc.claimName', `cache.pvc.claimName 必填：已存在的 PVC 名（DNS-1123 label，例如 model-cache-rwx，收到 ${quote(input.claimName)}）`);
  } else if (!DNS1123_LABEL.test(claimName) || claimName.length > 63) {
    fail('cache.pvc.claimName', `cache.pvc.claimName 只允许小写字母、数字和中划线，首尾是字母或数字，最长 63（收到 ${quote(claimName)}）`);
  } else {
    pvc.claimName = claimName;
  }

  if (input.accessModes === undefined || input.accessModes === null) {
    fail(
      'cache.pvc.accessModes',
      'cache.pvc.accessModes 必填：跨节点共享必须显式声明 "ReadWriteMany"（不写就当 ReadWriteOnce 处理，会被降级并告警）',
    );
  } else if (!Array.isArray(input.accessModes) || input.accessModes.length === 0) {
    fail('cache.pvc.accessModes', `cache.pvc.accessModes 必须是非空数组，例如 ["ReadWriteMany"]（收到 ${quote(input.accessModes)}）`);
  } else {
    input.accessModes.forEach((mode, index) => {
      if (typeof mode !== 'string' || !ACCESS_MODES.includes(mode)) {
        fail(
          `cache.pvc.accessModes[${index}]`,
          `cache.pvc.accessModes[${index}] 只允许 ${ACCESS_MODES.join(' / ')}（收到 ${quote(mode)}）；跨节点共享请用 ReadWriteMany`,
        );
        return;
      }
      if (!pvc.accessModes.includes(mode)) pvc.accessModes.push(mode);
    });
    pvc.accessModes.sort();
  }

  if (input.storageClassName !== undefined && input.storageClassName !== null && input.storageClassName !== '') {
    if (typeof input.storageClassName !== 'string' || input.storageClassName.trim() === '') {
      fail('cache.pvc.storageClassName', `cache.pvc.storageClassName 必须是非空字符串（收到 ${quote(input.storageClassName)}）`);
    } else {
      pvc.storageClassName = input.storageClassName.trim();
    }
  }

  if (input.size !== undefined && input.size !== null && input.size !== '') {
    if (typeof input.size !== 'string' || !PVC_SIZE.test(input.size.trim())) {
      fail('cache.pvc.size', `cache.pvc.size 必须是带单位的容量，例如 "200Gi"、"512Mi"（收到 ${quote(input.size)}）`);
    } else {
      pvc.size = input.size.trim();
    }
  }

  if (input.subPath !== undefined && input.subPath !== null && input.subPath !== '') {
    const subPath = typeof input.subPath === 'string' ? input.subPath.trim() : '';
    if (!subPath || subPath.startsWith('/') || subPath.includes('..')) {
      fail(
        'cache.pvc.subPath',
        `cache.pvc.subPath 必须是相对子目录、不含 ".."，例如 "Qwen3-8B"（收到 ${quote(input.subPath)}）`,
      );
    } else {
      pvc.subPath = subPath;
    }
  }

  if (input.readOnly !== undefined && input.readOnly !== null) {
    if (input.readOnly !== true) {
      fail('cache.pvc.readOnly', 'cache.pvc.readOnly 必须为 true（PV 以只读方式挂载，避免多副本并发写坏权重）');
    }
  }

  return pvc;
}

// ---------------------------------------------------------------- 节点归一

/**
 * 把各种形状的节点对象归一成 `{ name, labels }`。
 * 兼容 `'node1'`、`{ name }`、`{ nodeName }`、`{ metadata: { name, labels } }`、`{ labels }`。
 *
 * @param {unknown} nodes 节点清单
 * @returns {Array<{ name: string, labels: Record<string, string> }>} 名字升序、去重
 */
function normalizeNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byName = new Map();
  list.forEach((raw, index) => {
    let name = '';
    let labels = {};
    if (typeof raw === 'string') {
      name = raw.trim();
    } else if (isPlainObject(raw)) {
      name = String(raw.name ?? raw.nodeName ?? raw.metadata?.name ?? '').trim();
      const source = raw.labels ?? raw.metadata?.labels;
      if (isPlainObject(source)) {
        for (const key of Object.keys(source).sort()) labels[key] = String(source[key]);
      }
    }
    if (!name) name = `node-${index + 1}`;
    if (!byName.has(name)) byName.set(name, { name, labels });
  });
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 归并「已有缓存」记录：`{ node|nodeName, path, model, sizeMiB, readOnly }`。
 * 只用于告警（复用/路径不一致），不参与策略判定。
 *
 * @param {unknown} existingCaches 已有缓存的记录数组
 * @returns {Array<{ node: string, path: string, model: string, sizeMiB: number }>} 稳定排序
 */
function normalizeExistingCaches(existingCaches) {
  const list = Array.isArray(existingCaches) ? existingCaches : [];
  const out = [];
  for (const raw of list) {
    if (!isPlainObject(raw)) continue;
    const node = String(raw.node ?? raw.nodeName ?? raw.node_name ?? '').trim();
    const path = typeof raw.path === 'string' ? normalizeFsPath(raw.path) : '';
    if (!node || !path) continue;
    out.push({
      node,
      path,
      model: typeof raw.model === 'string' ? raw.model.trim() : '',
      sizeMiB: Number.isFinite(raw.sizeMiB) && raw.sizeMiB > 0 ? Math.round(raw.sizeMiB) : 0,
    });
  }
  return out.sort((a, b) => {
    if (a.node !== b.node) return a.node < b.node ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return 0;
  });
}

// ---------------------------------------------------------------- 磁盘估算

/** 量化标记 → 每权重比特数（支持 `Q4_K_M` 这类前缀写法）。 */
function resolveBits(quantization) {
  if (typeof quantization !== 'string') return null;
  const key = quantization.trim().toLowerCase().replace(/\s+/g, '');
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(QUANT_BITS_PER_WEIGHT, key)) {
    return { label: quantization.trim(), bits: QUANT_BITS_PER_WEIGHT[key] };
  }
  // 前缀匹配：q4_k_m → q4_k；fp16-fp8 → fp16（取最长的前缀）
  const candidates = Object.keys(QUANT_BITS_PER_WEIGHT)
    .filter((name) => key.startsWith(name))
    .sort((a, b) => b.length - a.length);
  if (candidates.length === 0) return null;
  const name = candidates[0];
  return { label: `${quantization.trim()}（按 ${name} 计）`, bits: QUANT_BITS_PER_WEIGHT[name] };
}

/** 参数量（B = 十亿）：`parametersB: 8` 或 `parameters: '8B' / '224B' / '1.5B'`。 */
function resolveParametersB(spec) {
  const direct = spec.parametersB ?? spec.paramsB;
  if (Number.isFinite(direct) && direct > 0) return direct;
  const text = typeof spec.parameters === 'string' ? spec.parameters.trim().toLowerCase() : '';
  const matched = /^([0-9]+(?:\.[0-9]+)?)\s*([btm])$/.exec(text);
  if (!matched) return 0;
  const count = Number(matched[1]);
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (matched[2] === 'b') return count;
  if (matched[2] === 't') return count * 1000;
  return count / 1000;
}

/**
 * 估算权重占盘：共享能省多少盘。
 *
 * 三种假设（按可信度降序，`assumption` 会写清用的是哪一种）：
 *  1. **给了 `model.sizeMiB`** → 直接采用（最可信，用户 `du -sh` 过的真值）；
 *  2. **给了参数量 + 量化** → `参数量 × 位宽 / 8`，再乘 `DISK_OVERHEAD_FACTOR`（索引/对齐）；
 *     误差约 ±10%（不含 KV cache、不含量化里的 outlier 通道、词表百万级也会被摊薄）；
 *  3. **都没给** → 保守假设 `DEFAULT_ASSUMED_SIZE_MIB`（8 GiB），误差可达数倍甚至数十倍，
 *     只用来给出「量级」而不是「精确容量」。
 *
 * `totalMiB` = 共享之后的实际占盘 = `perPodMiB × nodeCount`（每节点一份）；
 * `savedMiB` = 「每 Pod 各拷一份」`perPodMiB × replicas` 与共享后的差值。
 *
 * @param {object} input
 * @param {object} input.model 模型规格（`service.model`，或整条 service）：认
 *   `sizeMiB` / `parametersB` / `parameters` / `quantization` / `format`
 * @param {number} [input.replicas] 副本数（默认 1，夹到 1..64）
 * @param {number} [input.nodeCount] 落点节点数（默认 1，夹到 1..replicas）
 * @returns {{ perPodMiB: number, totalMiB: number, savedMiB: number, assumption: string,
 *   replicas: number, nodeCount: number, naiveMiB: number, source: string,
 *   bitsPerWeight?: number, parametersB?: number }}
 */
export function estimateDiskUsage({ model, replicas, nodeCount } = {}) {
  const notes = [];
  const replicasRaw = replicas;
  const replicasN = clampInt(replicasRaw, 1, MAX_REPLICAS_LIMIT, 1);
  if (replicasRaw !== undefined && replicasRaw !== null && replicasN !== replicasRaw) {
    notes.push(`replicas=${quote(replicasRaw)} 不合法（需 1..${MAX_REPLICAS_LIMIT} 整数），按 ${replicasN} 计算`);
  }
  const nodeCountRaw = nodeCount;
  const nodeCountN = clampInt(nodeCountRaw, 1, replicasN, 1);
  if (nodeCountRaw !== undefined && nodeCountRaw !== null && nodeCountN !== nodeCountRaw) {
    notes.push(`nodeCount=${quote(nodeCountRaw)} 不合法或被副本数限制（需 1..${replicasN} 整数），按 ${nodeCountN} 计算`);
  }

  const spec = !isPlainObject(model) ? {} : isPlainObject(model.model) ? model.model : model;
  if (!isPlainObject(model)) notes.push(`model 必须是对象（收到 ${describeType(model)}），已按未知规格处理`);

  let perPodMiB = 0;
  let source = 'default';
  let detail = '';
  let bits = null;
  let parametersB = 0;

  const sizeMiB = spec.sizeMiB;
  if (Number.isFinite(sizeMiB) && sizeMiB > 0) {
    perPodMiB = Math.round(sizeMiB);
    source = 'sizeMiB';
    detail = `采用 model.sizeMiB = ${perPodMiB} MiB（${formatMiB(perPodMiB)}，视为已实测的真值，不再加余量）`;
  } else {
    if (sizeMiB !== undefined && sizeMiB !== null) {
      notes.push(`model.sizeMiB=${quote(sizeMiB)} 不是正数，已忽略`);
    }
    bits = resolveBits(spec.quantization ?? spec.format);
    parametersB = resolveParametersB(spec);
    if (bits && parametersB > 0) {
      const rawMiB = (parametersB * 1e9 * (bits.bits / 8)) / (1024 * 1024);
      perPodMiB = Math.round(rawMiB * DISK_OVERHEAD_FACTOR);
      source = 'quantization';
      detail = `按参数量×位宽推断：${parametersB}B 参数 × ${bits.label}(${bits.bits} bit/权重) ≈ ${formatMiB(rawMiB)}`
        + `，再乘 ${Math.round((DISK_OVERHEAD_FACTOR - 1) * 100)}% 索引/对齐余量 = ${formatMiB(perPodMiB)}`;
      notes.push('量化推断误差约 ±10%（词表、量化 outlier 通道、引擎额外缓冲未计入），上线前用 du -sh 校准');
    } else {
      perPodMiB = DEFAULT_ASSUMED_SIZE_MIB;
      source = 'default';
      const missing = [];
      if (!bits) missing.push('量化标记（quantization）');
      if (parametersB <= 0) missing.push('参数量（parametersB 或 parameters: "8B"）');
      detail = `既没有 model.sizeMiB，也缺少${missing.join(' 与 ')}，只能按保守默认 ${formatMiB(DEFAULT_ASSUMED_SIZE_MIB)} 假设`;
      notes.push(`默认假设与真实权重（几十 GB 很常见）可能差数倍到数十倍，务必补 model.sizeMiB 或 parametersB+quantization`);
    }
  }

  const naiveMiB = perPodMiB * replicasN;
  const totalMiB = perPodMiB * nodeCountN;
  const savedMiB = Math.max(0, naiveMiB - totalMiB);

  const assumption = [
    detail,
    `共享口径：每节点只放一份（${nodeCountN} 个节点 × ${formatMiB(perPodMiB)}）= ${formatMiB(totalMiB)}；`
      + `若每 Pod 各拷一份则 ${replicasN} × ${formatMiB(perPodMiB)} = ${formatMiB(naiveMiB)}，共享节省 ${formatMiB(savedMiB)}`,
    ...notes,
  ].join('；');

  const result = {
    perPodMiB,
    totalMiB,
    savedMiB,
    assumption,
    replicas: replicasN,
    nodeCount: nodeCountN,
    naiveMiB,
    source,
  };
  if (bits) result.bitsPerWeight = bits.bits;
  if (parametersB > 0) result.parametersB = parametersB;
  return result;
}

// ---------------------------------------------------------------- 规划

/**
 * 规划缓存挂载：同节点多副本共享一份只读权重，跨节点只能在 RWX PVC 下真共享。
 *
 * 判定顺序（先排除，再选形态）：
 *  1. `service` 或缓存配置不合法 → `strategy: 'none'`（`ok: false`，warnings 带中文原因）；
 *  2. 节点清单为空 → 按**单节点**估算并告警（否则会把跨节点风险算漏）；
 *  3. `nodeSelector` 存在 → 只在标签匹配的节点上算共享；一个都不匹配就告警（缓存目录与
 *     Pod 会落在不同节点，hostPath 白占盘）；
 *  4. `mode: 'pvc'` 且 accessModes 含 `ReadWriteMany` → `strategy: 'pvc-rwx'`，`shared: true`；
 *  5. `mode: 'pvc'` 但没有 RWX → 降级 `strategy: 'pvc-rwo'`（同节点仍共享，跨节点各一份）并告警；
 *  6. `mode: 'hostPath'` → `strategy: 'hostPath'`，**节点数 = 1 才 `shared: true`**；
 *     节点数 > 1 时告警「跨节点无法共享 hostPath，每节点各占 N GiB」；
 *  7. `mode: 'none'` → `strategy: 'none'`，告警算出「每 Pod 各一份」会吃掉多少盘。
 *
 * @param {object} input
 * @param {object} input.service 模型服务（原始或规范化；内联 `service.cache` / `service.model.cache` 会被采用）
 * @param {Array<object|string>} [input.nodes] 节点清单：`'node1'` / `{ name, labels }` / k8s Node 对象
 * @param {Array<object>} [input.existingCaches] 已有缓存：`{ node, path, model, sizeMiB }`
 * @param {object} [input.cache] 缓存配置（显式覆盖 service 里内联的那份）
 * @returns {{ strategy: string, volumes: object[], volumeMounts: object[], warnings: string[],
 *   shared: boolean, ok: boolean, errors: Array<{field: string, message: string}>,
 *   nodeCount: number, replicas: number, nodes: string[], mountPath: string,
 *   estimate: object, reused: object[], requested: string, downgraded: boolean }}
 */
export function planModelCache({ service, nodes, existingCaches, cache } = {}) {
  const warnings = [];
  const validation = validateModelCache({ service, cache });
  const nodeList = normalizeNodes(nodes);
  const existing = normalizeExistingCaches(existingCaches);
  const value = validation.value;
  const requested = value.mode;

  if (!validation.ok) {
    warnings.push(`缓存配置不合法，已按「不共享」处理（避免带着错配置渲染出不可用的挂载）：${formatErrors(validation.errors)}`);
    return {
      strategy: 'none',
      volumes: [],
      volumeMounts: [],
      warnings,
      shared: false,
      ok: false,
      errors: validation.errors,
      requested,
      downgraded: false,
      nodeCount: Math.max(nodeList.length, 1),
      replicas: value.replicas || 1,
      nodes: nodeList.map((node) => node.name),
      mountPath: '',
      estimate: estimateDiskUsage({ model: {}, replicas: value.replicas || 1, nodeCount: 1 }),
      reused: [],
    };
  }

  // ── 节点与副本口径
  let selected = nodeList;
  if (nodeList.length === 0) {
    warnings.push(
      '未提供节点清单（nodes 为空）：已按**单节点**估算。若实际会调度到多个节点，'
      + 'hostPath 的「共享」不成立，每个节点都会各占一份权重（可用容量会被低估）。',
    );
  }

  const selectorKeys = Object.keys(value.nodeSelector ?? {}).sort();
  if (selectorKeys.length > 0 && nodeList.length > 0) {
    const matched = nodeList.filter((node) => selectorKeys.every((key) => node.labels[key] === value.nodeSelector[key]));
    if (matched.length === 0) {
      const want = selectorKeys.map((key) => `${key}=${value.nodeSelector[key]}`).join(',');
      const have = nodeList
        .map((node) => `${node.name}(${selectorKeys.map((key) => `${key}=${node.labels[key] ?? '无此标签'}`).join(',')})`)
        .join(' / ');
      warnings.push(
        `nodeSelector 与缓存节点不匹配：要求 ${want}，现有节点都没有匹配的标签（${have}）。`
        + `缓存目录与 Pod 可能落在不同节点，hostPath 会各占一份盘且 Pod 读不到缓存；请把缓存盘挂到实际调度的那批节点上。`,
      );
    } else {
      selected = matched;
      if (matched.length < nodeList.length) {
        warnings.push(
          `nodeSelector 只匹配 ${matched.length}/${nodeList.length} 个节点（${matched.map((node) => node.name).join(',')}）：`
          + '其余节点上的缓存目录不会被该服务用到，规划只按匹配节点算共享。',
        );
      }
    }
  }

  const nodeCount = Math.max(selected.length, 1);
  const replicas = clampInt(value.replicas, 1, MAX_REPLICAS, 1);

  const modelSpec = buildEstimateModelSpec(service, value);
  const estimate = estimateDiskUsage({ model: modelSpec, replicas, nodeCount });

  // ── 形态判定
  let strategy = 'none';
  if (value.mode === 'pvc') {
    const rwx = Array.isArray(value.pvc?.accessModes) && value.pvc.accessModes.includes(SHARED_ACCESS_MODE);
    strategy = rwx ? 'pvc-rwx' : 'pvc-rwo';
  } else if (value.mode === 'hostPath') {
    strategy = 'hostPath';
  }

  let shared = false;
  if (strategy === 'pvc-rwx') shared = true;
  else if (strategy === 'hostPath' || strategy === 'pvc-rwo') shared = nodeCount === 1;

  const volumes = [];
  const volumeMounts = [];
  const mountPath = value.mountPath || (strategy === 'hostPath' ? value.hostPath : CACHE_MOUNT_PATH);

  if (strategy === 'hostPath') {
    volumes.push({ name: CACHE_VOLUME_NAME, hostPath: { path: value.hostPath, type: 'Directory' } });
    volumeMounts.push({ name: CACHE_VOLUME_NAME, mountPath, readOnly: true });
    if (shared) {
      warnings.push(
        `同节点 ${replicas} 个副本共享宿主机目录 ${value.hostPath}（挂到容器 ${mountPath}）：只读挂载，Pod 不写入；`
        + `共享后只占 ${formatMiB(estimate.perPodMiB)}，比每 Pod 各拷一份省 ${formatMiB(estimate.savedMiB)}。`,
      );
    } else {
      warnings.push(
        `跨节点无法共享 hostPath，每节点各占 ${formatMiB(estimate.perPodMiB)}（${nodeCount} 个节点合计 `
        + `${formatMiB(estimate.totalMiB)}）；如需真共享请用 RWX PVC 或 NFS。`,
      );
      warnings.push(
        `${nodeCount} 个节点各自挂本地目录时，权重必须每个节点都预先放好（type=Directory 要求目录已存在），`
        + '否则 Pod 会以 ContainerCreating 卡住；只读挂载，Pod 不写入。',
      );
    }
    if (replicas > 1 && shared) {
      warnings.push(`注意：共享目录必须事先预热（${value.hostPath}），否则 N 个副本会同时抢着下载同一份权重，把节点带宽和磁盘打满。`);
    }
  } else if (strategy === 'pvc-rwx' || strategy === 'pvc-rwo') {
    volumes.push({
      name: CACHE_VOLUME_NAME,
      persistentVolumeClaim: { claimName: value.pvc.claimName, readOnly: true },
    });
    const mount = { name: CACHE_VOLUME_NAME, mountPath, readOnly: true };
    if (value.pvc.subPath) mount.subPath = value.pvc.subPath;
    volumeMounts.push(mount);

    if (strategy === 'pvc-rwx') {
      warnings.push(
        `PVC ${value.pvc.claimName} 声明了 ${SHARED_ACCESS_MODE}：${nodeCount} 个节点共享同一份权重（只读挂载，Pod 不写入），`
        + `总占盘 ${formatMiB(estimate.perPodMiB)}。`,
      );
      warnings.push(`RWX 后端（NFS/CephFS）的读带宽通常是瓶颈：${replicas} 个副本同时冷启加载会互相拖慢，建议先预热。`);
    } else {
      const modes = Array.isArray(value.pvc?.accessModes) && value.pvc.accessModes.length > 0
        ? value.pvc.accessModes.join('/')
        : '未声明';
      warnings.push(
        `PVC ${value.pvc.claimName} 的 accessModes 不含 ${SHARED_ACCESS_MODE}（收到 ${modes}），已降级为 pvc-rwo：`
        + `同节点多副本仍可共享，但跨节点无法共享，每节点各占 ${formatMiB(estimate.perPodMiB)}；`
        + '如需真共享请改用 ReadWriteMany 的 PVC 或 NFS。',
      );
      if (nodeCount === 1) {
        warnings.push(`只读挂载，Pod 不写入；单节点内 ${replicas} 个副本共享同一 PV，省 ${formatMiB(estimate.savedMiB)}。`);
      }
    }
  } else {
    warnings.push(
      `未配置共享缓存目录：${replicas} 个副本会各拷一份权重（每份约 ${formatMiB(estimate.perPodMiB)}，`
      + `合计 ${formatMiB(estimate.naiveMiB)}）。这正是「盘被权重吃满 → DiskPressure → 整节点 Pod 被 Evicted」的成因；`
      + '请给 cache.hostPath（同节点共享）或 ReadWriteMany 的 PVC。',
    );
  }

  // ── 容器内路径与 model.path 是否对得上（否则 MODEL_PATH 指向挂载外，等于没挂）
  if (volumeMounts.length > 0 && value.modelPath && !value.modelPath.startsWith(mountPath)) {
    warnings.push(
      `model.path=${value.modelPath} 不在缓存挂载点 ${mountPath} 之下：容器里的 MODEL_PATH 会指向未挂载的路径。`
      + `要么把 model.path 改成 ${mountPath}/<模型目录>，要么把 cache.mountPath 调成 ${value.modelPath} 的父目录。`,
    );
  }

  // ── 已有缓存复用提示（避免重复下载/重复占盘）
  const reused = [];
  for (const entry of existing) {
    const usedByService = selected.some((node) => node.name === entry.node);
    if (!usedByService) continue;
    if (strategy === 'hostPath' || strategy === 'pvc-rwo') {
      if (entry.path === value.hostPath || (entry.path === mountPath && strategy === 'hostPath')) {
        reused.push({ node: entry.node, path: entry.path, sizeMiB: entry.sizeMiB });
        warnings.push(
          `复用节点 ${entry.node} 上已有缓存 ${entry.path}${entry.sizeMiB ? `（${formatMiB(entry.sizeMiB)}）` : ''}：不需要重新下载。`,
        );
      } else {
        warnings.push(
          `节点 ${entry.node} 上已有缓存 ${entry.path}${entry.sizeMiB ? `（${formatMiB(entry.sizeMiB)}）` : ''}，`
          + `与配置的 ${value.hostPath || value.pvc?.claimName} 不一致：会重复占盘 ${formatMiB(estimate.perPodMiB)}，请确认是否要复用旧目录。`,
        );
      }
    }
  }

  if (!shared && estimate.savedMiB > 0 && strategy !== 'none') {
    warnings.push(
      `当前策略下共享只省 ${formatMiB(estimate.savedMiB)}（跨节点各自一份），`
      + `最坏情况占盘 ${formatMiB(estimate.totalMiB)}；节点磁盘余量请按这个数字留出 20% 至少。`,
    );
  }

  return {
    strategy,
    volumes,
    volumeMounts,
    warnings,
    shared,
    ok: true,
    errors: [],
    requested,
    downgraded: (requested === 'pvc' && strategy === 'pvc-rwo') || (requested === 'hostPath' && !shared && nodeCount > 1),
    nodeCount,
    replicas,
    nodes: selected.map((node) => node.name),
    mountPath,
    estimate,
    reused,
  };
}

/**
 * 组装 estimateDiskUsage 的 model 入参：
 * 规范化后的 model（source/path/format/quantization）与原始 model 里的
 * `sizeMiB` / `parametersB` / `parameters` 合并（后者被 model.js 的白名单丢弃了，只能从原始输入取）。
 *
 * @param {unknown} service 原始 service
 * @param {object} value validateModelCache 的 value
 * @returns {object} 估算用模型规格
 */
function buildEstimateModelSpec(service, value) {
  const rawModel = isPlainObject(service?.model) ? service.model : {};
  const spec = {
    source: value.source,
    path: value.modelPath,
  };
  if (typeof rawModel.quantization === 'string') spec.quantization = rawModel.quantization;
  else if (typeof rawModel.format === 'string') spec.format = rawModel.format;
  if (Number.isFinite(rawModel.sizeMiB)) spec.sizeMiB = rawModel.sizeMiB;
  if (Number.isFinite(rawModel.parametersB)) spec.parametersB = rawModel.parametersB;
  if (typeof rawModel.parameters === 'string') spec.parameters = rawModel.parameters;
  return spec;
}

// ---------------------------------------------------------------- 渲染

/** 造一个带 code 的中文错误（渲染层的畸形 plan 必须硬失败）。 */
function invalidPlan(message) {
  const error = new Error(message);
  error.code = 'INFRA_INVALID_CACHE_PLAN';
  return error;
}

/**
 * 把 plan 渲染成可直接塞进 Deployment spec 的 `{ volumes, volumeMounts }`。
 *
 * 这里对 plan 做**白名单重建**，理由与 model.js 一致：plan 也可能是从
 * 前端/数据库读回来的 JSON，谁都能往里加字段。只放行：
 *   · volume：`{ name, hostPath: { path, type } }` 或 `{ name, persistentVolumeClaim: { claimName, readOnly } }`；
 *   · volumeMount：`{ name, mountPath, readOnly, subPath? }`，且 `readOnly` 必须是 `true`。
 *
 * 层级提醒：`volumes` 写在 `spec.template.spec.volumes`，`volumeMounts` 写在
 * `spec.template.spec.containers[0].volumeMounts`。
 *
 * @param {object} input `{ plan }`（也接受直接传 plan 本身）
 * @returns {{ volumes: object[], volumeMounts: object[] }} 深拷贝的新数组；`strategy: 'none'` 时两者均为空
 * @throws {Error} plan 缺失/畸形、卷名非法、路径非法、挂载点与卷名对不上：
 *   错误信息中文，`code = 'INFRA_INVALID_CACHE_PLAN'`
 */
export function renderCacheResources(input = {}) {
  const plan = isPlainObject(input) && typeof input.strategy === 'string'
    ? input
    : isPlainObject(input) && isPlainObject(input.plan)
      ? input.plan
      : null;

  if (!plan) {
    throw invalidPlan(
      'renderCacheResources({ plan }) 需要一个规划结果：请先调用 planModelCache({ service, nodes }) 并把返回值传进来'
      + '（收到 ' + describeType(input) + '）。',
    );
  }

  const strategy = typeof plan.strategy === 'string' ? plan.strategy : '';
  if (!CACHE_STRATEGIES.includes(strategy)) {
    throw invalidPlan(
      `plan.strategy 只允许 ${CACHE_STRATEGIES.join(' / ')}（收到 ${quote(strategy)}）：这不像 planModelCache() 的返回值。`,
    );
  }
  if (strategy === 'none') return { volumes: [], volumeMounts: [] };

  const rawVolumes = Array.isArray(plan.volumes) ? plan.volumes : [];
  const rawMounts = Array.isArray(plan.volumeMounts) ? plan.volumeMounts : [];
  if (rawVolumes.length === 0) {
    throw invalidPlan(`plan.strategy=${strategy} 但 plan.volumes 是空的：没有卷可渲染，请检查 planModelCache 的返回是否被改写。`);
  }

  const volumes = [];
  for (const [index, raw] of rawVolumes.entries()) {
    const field = `plan.volumes[${index}]`;
    if (!isPlainObject(raw)) throw invalidPlan(`${field} 必须是对象（收到 ${describeType(raw)}）`);

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!DNS1123_LABEL.test(name)) {
      throw invalidPlan(`${field}.name 必须是 DNS-1123 label（小写字母/数字/中划线，收到 ${quote(raw.name)}）`);
    }

    if (isPlainObject(raw.hostPath)) {
      const path = typeof raw.hostPath.path === 'string' ? normalizeFsPath(raw.hostPath.path) : '';
      if (!path || !path.startsWith('/') || path.includes('..') || /\s/.test(path)) {
        throw invalidPlan(`${field}.hostPath.path 必须是绝对路径且不含 ".."（收到 ${quote(raw.hostPath.path)}）`);
      }
      if (isForbiddenHostPath(path)) {
        throw invalidPlan(`${field}.hostPath.path 是宿主机系统目录（${path}），不允许挂进容器；请改用专用模型目录。`);
      }
      const type = raw.hostPath.type === undefined ? 'Directory' : String(raw.hostPath.type);
      if (!['Directory', 'DirectoryOrCreate', 'File', 'FileOrCreate'].includes(type)) {
        throw invalidPlan(`${field}.hostPath.type 只允许 Directory / DirectoryOrCreate / File / FileOrCreate（收到 ${quote(type)}）`);
      }
      volumes.push({ name, hostPath: { path, type } });
      continue;
    }

    if (isPlainObject(raw.persistentVolumeClaim)) {
      const claimName = typeof raw.persistentVolumeClaim.claimName === 'string'
        ? raw.persistentVolumeClaim.claimName.trim()
        : '';
      if (!DNS1123_LABEL.test(claimName)) {
        throw invalidPlan(`${field}.persistentVolumeClaim.claimName 必须是 PVC 名（DNS-1123 label，收到 ${quote(claimName)}）`);
      }
      const readOnly = raw.persistentVolumeClaim.readOnly === undefined ? true : raw.persistentVolumeClaim.readOnly;
      if (readOnly !== true) {
        throw invalidPlan(`${field}.persistentVolumeClaim.readOnly 必须为 true：共享权重只能只读挂载`);
      }
      volumes.push({ name, persistentVolumeClaim: { claimName, readOnly: true } });
      continue;
    }

    throw invalidPlan(`${field} 必须含 hostPath 或 persistentVolumeClaim（收到 ${Object.keys(raw).join(',') || '空对象'}）`);
  }

  const volumeNames = new Set(volumes.map((volume) => volume.name));
  const volumeMounts = [];
  for (const [index, raw] of rawMounts.entries()) {
    const field = `plan.volumeMounts[${index}]`;
    if (!isPlainObject(raw)) throw invalidPlan(`${field} 必须是对象（收到 ${describeType(raw)}）`);

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!volumeNames.has(name)) {
      throw invalidPlan(`${field}.name=${quote(name)} 找不到对应的 volume：挂载名必须与 volumes 里的 name 完全一致。`);
    }

    const mountPath = typeof raw.mountPath === 'string' ? normalizeFsPath(raw.mountPath) : '';
    if (!mountPath || !mountPath.startsWith('/') || mountPath.includes('..') || /\s/.test(mountPath)) {
      throw invalidPlan(`${field}.mountPath 必须是绝对路径且不含 ".."（收到 ${quote(raw.mountPath)}）`);
    }

    const readOnly = raw.readOnly === undefined ? true : raw.readOnly;
    if (readOnly !== true) {
      throw invalidPlan(`${field}.readOnly 必须为 true：共享权重目录只能只读挂载，否则多副本并发写会写坏权重`);
    }

    const mount = { name, mountPath, readOnly: true };
    if (raw.subPath !== undefined && raw.subPath !== null && raw.subPath !== '') {
      const subPath = typeof raw.subPath === 'string' ? raw.subPath.trim() : '';
      if (!subPath || subPath.startsWith('/') || subPath.includes('..')) {
        throw invalidPlan(`${field}.subPath 必须是相对子目录且不含 ".."（收到 ${quote(raw.subPath)}）`);
      }
      mount.subPath = subPath;
    }
    volumeMounts.push(mount);
  }

  return deepClone({ volumes, volumeMounts });
}
