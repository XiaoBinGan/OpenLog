/**
 * AI Infra 能力层 A1-②：把「模型服务的意图」渲染成 k8s 对象
 *
 * 输入是 model.js 规范化过的 ModelService；输出永远是**同一命名空间内的两个对象**：
 *
 *   objects: [ Deployment, Service ]     // 顺序固定，同输入必得同输出
 *   routes:  [ { port, upstream } ]      // expose 存在时才有，给网关（nginx stream）用
 *
 * 三条硬约束：
 * 1. **只生成命名空间内对象**：Deployment / Service。ClusterRole、Namespace、CRD 一律不生成；
 *    输入里夹带的 `kind` / `objects` / `rules` 会被 model.js 的白名单重建丢掉，
 *    渲染末尾还有一道 assertNamespacedObjects 兜底（防未来改动把集群级对象带出去）。
 * 2. **加速卡资源由 A3 注入**：本文件不写死 `nvidia.com/*`。默认实现从
 *    `server/infra/accelerator/index.js`（A3）取，也可用
 *    `renderModelService(svc, { renderResources })` 或 `setResourceRenderer(fn)` 注入。
 * 3. **纯函数 + 确定性**：不联网、不读盘、不改入参；同样输入返回结构完全相同的深拷贝。
 *
 * HAMi 与整卡两种模式由 `resources.memoryMiB` 区分：
 *   memoryMiB > 0  → 走 HAMi vGPU（会挂 hami-scheduler，资源里带显存/算力配额）
 *   memoryMiB === 0 → 整卡独占（不挂 hami-scheduler，只申请整卡）
 * 本文件只负责把 `schedulerName` 和 `renderResources(svc)` 的结果放进去，
 * 具体资源键名（nvidia.com/gpumem 等）属于 A3 的职责。
 */

import { createRequire } from 'node:module';
import { validateModelService, serviceKey, DEFAULT_ACCELERATOR_VENDOR } from './model.js';

/** 允许渲染出的对象类型（白名单）。集群级对象必须由运维手工管理。 */
export const ALLOWED_KINDS = Object.freeze(['Deployment', 'Service']);

/** 型号亲和用的节点标签键（A3 的探测脚本/节点打标与本键对齐）。 */
export const ACCELERATOR_MODEL_LABEL = 'openlog.io/accelerator-model';

/** 渲染器版本，写进对象注解，方便 A5 判断「这份清单是谁渲染的」。 */
export const RENDERER_VERSION = 'openlog-infra/v1';

/** HAMi 的调度器名：只有 memoryMiB > 0（vGPU 切片）时才挂。 */
export const HAMI_SCHEDULER_NAME = 'hami-scheduler';

/** 网关端口的默认分配区间：30000..30999，按服务名做稳定哈希，避免多次渲染端口漂移。 */
export const DEFAULT_GATEWAY_PORT_BASE = 30000;
export const DEFAULT_GATEWAY_PORT_RANGE = 1000;

/** 声明式 apply 的清单版本。 */
export const SNAPSHOT_VERSION = 1;

/**
 * 归属标签：必须与 A2（server/infra/guard.js）的 `MANAGED_BY_KEY` / `MANAGED_BY_VALUE` 一致。
 * 值漂移会让护栏把自己的对象当成「别人的对象」而拒绝修改，所以渲染时就打上，
 * 并且由单测跨模块断言两边相等（见 infra-render.test.js）。
 */
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';

/** 归属标签的键（A2 的 isManaged 优先读 `labels.managedBy`）。 */
export const MANAGED_BY_KEY = 'managedBy';

/** 归属标签的值。 */
export const MANAGED_BY_VALUE = 'openlog-infra';

/** A3 的加速卡抽象层入口（相对本文件；A3 并行实现中，缺失时给可操作的中文错误）。 */
const ACCELERATOR_MODULE_SPECIFIER = './accelerator/index.js';

const requireFromModule = createRequire(import.meta.url);

/** 注入的渲染函数（测试 / A5 用），null 表示用默认实现。 */
let injectedRenderer = null;

/** 注入的加速卡模块（测试用，避免真的去 require A3 的文件）。 */
let injectedAcceleratorModule = null;

/** 已加载的加速卡模块缓存：specifier → module。 */
const acceleratorModuleCache = new Map();

/** 是否是「普通对象」（排除 null / 数组 / 原始值）。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 深拷贝（清单是纯数据：JSON 往返足够，且能顺带丢掉 undefined）。 */
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 注册加速卡资源渲染函数（全局覆盖默认实现）。
 *
 * @param {null|((svc: object) => { limits: object, requests?: object })} fn
 *   传 null 表示恢复默认（从 A3 的 accelerator/index.js 取）。
 * @returns {void}
 * @throws {Error} 传入非函数且非 null 时抛错（中文）
 */
export function setResourceRenderer(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== 'function') {
    throw new Error(`setResourceRenderer(fn) 需要函数或 null，收到 ${typeof fn}；函数签名应为 (svc) => ({ limits, requests })`);
  }
  injectedRenderer = typeof fn === 'function' ? fn : null;
}

/** 清掉注入的渲染函数，恢复默认实现（测试的 afterEach 用）。 */
export function resetResourceRenderer() {
  injectedRenderer = null;
}

/**
 * 当前生效的资源渲染函数：注入优先，否则用默认实现（A3）。
 *
 * @returns {(svc: object) => { limits: object, requests?: object }}
 */
export function getResourceRenderer() {
  return injectedRenderer ?? defaultRenderResources;
}

/**
 * 注入加速卡模块（测试用，等价于把 A3 的 index.js 挂上来）。
 *
 * @param {null|object} mod 模块对象（需含 renderAcceleratorResources 或 getAdapter）
 * @returns {void}
 */
export function setAcceleratorModule(mod) {
  injectedAcceleratorModule = mod ?? null;
  acceleratorModuleCache.clear();
}

/** 清掉注入的加速卡模块与模块缓存（测试的 afterEach 用）。 */
export function resetAcceleratorModule() {
  injectedAcceleratorModule = null;
  acceleratorModuleCache.clear();
}

/**
 * 加载加速卡模块（默认 A3 的 `server/infra/accelerator/index.js`）。
 *
 * 用 `createRequire` 同步加载：渲染是同步纯函数，不能 await。Node ≥22 支持 require(ESM)，
 * 但 A3 若使用了顶层 await 就会失败——此时错误信息会指出改用注入。
 *
 * @param {string} [specifier] 相对本文件的模块路径
 * @returns {object} 模块导出
 * @throws {Error} 模块不存在 / 加载失败时抛错（中文，含 code = INFRA_ACCELERATOR_UNAVAILABLE）
 */
export function loadAcceleratorModule(specifier = ACCELERATOR_MODULE_SPECIFIER) {
  if (specifier === ACCELERATOR_MODULE_SPECIFIER && injectedAcceleratorModule) return injectedAcceleratorModule;
  if (acceleratorModuleCache.has(specifier)) return acceleratorModuleCache.get(specifier);

  let mod;
  try {
    mod = requireFromModule(specifier);
  } catch (cause) {
    const error = new Error(
      `无法加载加速卡渲染模块 "${specifier}"：${cause?.message ?? cause}。`
      + '请确认 A3 的 server/infra/accelerator/index.js 已就绪（且没有顶层 await）；'
      + '也可以调用 renderModelService(svc, { renderResources }) 或 setResourceRenderer(fn) 注入渲染函数。',
    );
    error.code = 'INFRA_ACCELERATOR_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }

  acceleratorModuleCache.set(specifier, mod);
  return mod;
}

/**
 * 默认的资源渲染实现：把活交给 A3 的加速卡抽象层。
 *
 * 优先 `renderAcceleratorResources({ vendor, accelerators, memoryMiB, coresPercent })`，
 * 退而用 `getAdapter(vendor).renderResources(同参数)`（契约里两种形状都列了）。
 *
 * @param {object} svc 规范化后的模型服务
 * @returns {{ limits: object, requests?: object }} k8s resources 片段
 * @throws {Error} 模块缺失或没有可用的渲染入口时抛错（中文）
 */
export function defaultRenderResources(svc) {
  const resources = isPlainObject(svc?.resources) ? svc.resources : {};
  const vendor = typeof resources.vendor === 'string' && resources.vendor ? resources.vendor : DEFAULT_ACCELERATOR_VENDOR;
  // 混合形状：既带 svc 全量（A3 若按 `renderResources(svc)` 实现也能用），
  // 也把配额摊到顶层（契约里 `renderAcceleratorResources({ vendor, accelerators, ... })` 的形状）。
  const input = {
    ...svc,
    vendor,
    accelerators: resources.accelerators,
    memoryMiB: resources.memoryMiB,
    coresPercent: resources.coresPercent,
  };

  const mod = loadAcceleratorModule();
  if (typeof mod?.renderAcceleratorResources === 'function') {
    // A3 按契约返回**扁平 map**（{'nvidia.com/gpu':'1'}），这里必须归一成 {limits, requests}：
    // 本函数的契约是"返回可塞进 container.resources 的片段"，两种形状都归一到同一形状，
    // 调用方（renderDeployment / 测试 / 未来的回滚路径）就不用各写一套判断。
    return normalizeResourcesFragment(mod.renderAcceleratorResources(input));
  }
  if (typeof mod?.getAdapter === 'function') {
    const adapter = mod.getAdapter(vendor);
    if (adapter && typeof adapter.renderResources === 'function') {
      return normalizeResourcesFragment(adapter.renderResources(input));
    }
  }
  throw new Error(
    '加速卡模块缺少 renderAcceleratorResources() 或 getAdapter(vendor).renderResources()：'
    + '请按 /tmp/infra-contract.md 的 A3 接口补齐，或注入 renderResources。',
  );
}

/**
 * 把加速卡渲染结果归一成 k8s 的 `{ limits, requests }` 形状。
 *
 * A3 有两种返回形态：适配器层的扁平 map（`{ 'nvidia.com/gpu': '1' }`，见
 * `accelerator/generic.js` 的 `renderResources`）与聚合层的 `{ limits, requests }`。
 * 扩展资源在 k8s 里 requests 必须等于 limits，所以扁平 map 会被同时写进两边。
 *
 * @param {unknown} fragment 渲染函数的返回值
 * @returns {{ limits: object, requests: object }}
 * @throws {Error} 不是普通对象时抛错（中文）
 */
export function normalizeResourcesFragment(fragment) {
  if (!isPlainObject(fragment)) {
    throw new Error(`renderResources(svc) 必须返回 k8s resources 片段对象（{ limits, requests } 或扁平 map），收到 ${fragment === null ? 'null' : typeof fragment}`);
  }
  const hasLimits = isPlainObject(fragment.limits);
  const hasRequests = isPlainObject(fragment.requests);
  if (hasLimits || hasRequests) {
    const limits = hasLimits ? { ...fragment.limits } : {};
    const requests = hasRequests ? { ...fragment.requests } : { ...limits };
    return { limits, requests };
  }
  const flat = { ...fragment };
  return { limits: flat, requests: { ...flat } };
}

/** 容器环境变量：模型信息由意图直接推导，`engine.env` 可覆盖同名项；按变量名排序保证确定性。 */
function buildEnv(svc) {
  const bag = {
    MODEL_SOURCE: svc.model.source,
    MODEL_PATH: svc.model.path,
    OPENLOG_SERVICE_KEY: serviceKey(svc),
    OPENLOG_RENDERER: RENDERER_VERSION,
  };
  if (svc.model.format) bag.MODEL_FORMAT = svc.model.format;
  if (svc.model.quantization) bag.MODEL_QUANTIZATION = svc.model.quantization;
  if (svc.model.contextLength) bag.MODEL_CONTEXT_LENGTH = String(svc.model.contextLength);
  if (svc.engine.type) bag.ENGINE_TYPE = svc.engine.type;
  for (const [key, val] of Object.entries(svc.engine.env ?? {})) bag[key] = val;

  return Object.keys(bag)
    .sort()
    .map((name) => ({ name, value: String(bag[name]) }));
}

/** 按 key 排序的标签映射（确定性 + 便于 diff）。 */
function sortedMap(source) {
  const out = {};
  for (const key of Object.keys(source).sort()) out[key] = source[key];
  return out;
}

/**
 * 对象归属标签。`managedBy` 是 A2 护栏的识别键，`app.kubernetes.io/managed-by` 是通用惯例，
 * 两个都写，值统一为 `openlog-infra`。
 *
 * @param {string} name 服务名
 * @returns {Record<string, string>}
 */
function ownershipLabels(name) {
  return {
    app: name,
    [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
    'app.kubernetes.io/name': name,
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    'app.kubernetes.io/part-of': 'openlog-infra',
  };
}

/** 对象通用注解：谁渲染的、对应哪个服务。 */
function baseAnnotations(svc) {
  return {
    'openlog.io/service-key': serviceKey(svc),
    'openlog.io/renderer': RENDERER_VERSION,
  };
}

/**
 * 型号亲和 → nodeAffinity。
 *
 * `placement.acceleratorModel`（如 'NVIDIA GeForce RTX 4090'）渲染成
 * `nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions`，
 * key = `openlog.io/accelerator-model`，operator = `In`，values = [型号]。
 *
 * @param {object} svc 规范化后的模型服务
 * @returns {object|null} affinity 片段；没指定型号时返回 null（调用方不要写这个键）
 */
export function renderNodeAffinity(svc) {
  const model = svc?.placement?.acceleratorModel;
  if (typeof model !== 'string' || model.trim() === '') return null;
  return {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              {
                key: ACCELERATOR_MODEL_LABEL,
                operator: 'In',
                values: [model.trim()],
              },
            ],
          },
        ],
      },
    },
  };
}

/**
 * 渲染 Deployment。
 *
 * @param {object} svc 规范化后的模型服务
 * @param {{ resources?: object, renderResources?: Function }} [options]
 *   `resources` 可直接给已算好的片段（renderModelService 内部用），否则用注入/默认渲染函数
 * @returns {object} apps/v1 Deployment
 */
export function renderDeployment(svc, options = {}) {
  const renderer = typeof options.renderResources === 'function' ? options.renderResources : getResourceRenderer();
  const resources = isPlainObject(options.resources) ? options.resources : renderer(svc);
  const normalizedResources = normalizeResourcesFragment(resources);

  const labels = { app: svc.name };
  const primaryPortName = svc.ports[0].name;
  const initialDelay = svc.health.initialDelaySeconds;

  const container = {
    name: svc.name,
    image: svc.engine.image,
    imagePullPolicy: 'IfNotPresent',
    args: [...svc.engine.args],
    env: buildEnv(svc),
    ports: svc.ports.map((port) => ({ name: port.name, containerPort: port.containerPort, protocol: 'TCP' })),
    resources: normalizedResources,
    readinessProbe: {
      httpGet: { path: svc.health.path, port: primaryPortName },
      initialDelaySeconds: initialDelay,
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 3,
    },
    livenessProbe: {
      httpGet: { path: svc.health.path, port: primaryPortName },
      initialDelaySeconds: initialDelay + 30,
      periodSeconds: 20,
      timeoutSeconds: 5,
      failureThreshold: 3,
    },
  };

  const podSpec = {
    restartPolicy: 'Always',
    terminationGracePeriodSeconds: 30,
    containers: [container],
  };

  // HAMi 只在「切片」模式（显存限额 > 0）下参与调度；整卡模式交给默认调度器。
  if (svc.resources.memoryMiB > 0) podSpec.schedulerName = HAMI_SCHEDULER_NAME;

  const nodeSelector = svc.placement.nodeSelector ?? {};
  if (Object.keys(nodeSelector).length > 0) {
    // 按 key 排序，保证两次渲染的字段顺序一致（diff 更稳）。
    podSpec.nodeSelector = sortedMap(nodeSelector);
  }

  const affinity = renderNodeAffinity(svc);
  if (affinity) podSpec.affinity = affinity;

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: svc.name,
      namespace: svc.namespace,
      labels: ownershipLabels(svc.name),
      annotations: {
        ...baseAnnotations(svc),
        'openlog.io/model-source': svc.model.source,
        'openlog.io/model-path': svc.model.path,
        'openlog.io/accelerators': String(svc.resources.accelerators),
        'openlog.io/memory-mib': String(svc.resources.memoryMiB),
        'openlog.io/cores-percent': String(svc.resources.coresPercent),
      },
    },
    spec: {
      replicas: svc.replicas,
      // GPU 独占：滚动更新会同时占两份卡，容易把节点撑爆，所以先删后建。
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { ...labels } },
      template: {
        metadata: { labels: { ...labels } },
        spec: podSpec,
      },
    },
  };
}

/**
 * 渲染 Service（ClusterIP，端口与容器端口一一映射，targetPort 用端口名）。
 *
 * @param {object} svc 规范化后的模型服务
 * @param {{ gatewayIP?: string|null }} [options] 网关出口 IP，写到注解供 A7/运维查看
 * @returns {object} v1 Service
 */
export function renderService(svc, options = {}) {
  const annotations = baseAnnotations(svc);
  const gatewayIP = typeof options.gatewayIP === 'string' ? options.gatewayIP.trim() : '';
  if (gatewayIP) annotations['openlog.io/gateway-ip'] = gatewayIP;

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: svc.name,
      namespace: svc.namespace,
      labels: ownershipLabels(svc.name),
      annotations,
    },
    spec: {
      type: 'ClusterIP',
      selector: { app: svc.name },
      ports: svc.ports.map((port) => ({
        name: port.name,
        port: port.containerPort,
        targetPort: port.name,
        protocol: 'TCP',
      })),
    },
  };
}

/**
 * 由服务名稳定推导网关端口（30000..30999）。同名服务永远得到同一个端口，
 * 避免「每次渲染端口都变」导致网关配置抖动。
 *
 * @param {string} name 服务名（DNS-1123 label）
 * @param {number} [base] 起始端口
 * @param {number} [range] 区间大小
 * @returns {number} 端口号
 */
export function deriveGatewayPort(name, base = DEFAULT_GATEWAY_PORT_BASE, range = DEFAULT_GATEWAY_PORT_RANGE) {
  const text = typeof name === 'string' ? name : '';
  const span = Number.isInteger(range) && range > 0 ? range : DEFAULT_GATEWAY_PORT_RANGE;
  const start = Number.isInteger(base) ? base : DEFAULT_GATEWAY_PORT_BASE;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % span;
  }
  return start + hash;
}

/**
 * 渲染网关路由：`expose` 存在（非 null）时输出一条 stream 路由。
 *
 * 上游固定用集群内 DNS：`<name>.<namespace>.svc.cluster.local:<主端口>`；
 * 端口取 `expose.gatewayPort`，缺省时按服务名稳定推导。
 *
 * @param {object} svc 规范化后的模型服务
 * @param {{ gatewayPortBase?: number }} [options]
 * @returns {Array<{port: number, upstream: string}>} 没有 expose 时返回 []
 */
export function renderRoutes(svc, options = {}) {
  if (!svc?.expose) return [];
  const primary = Array.isArray(svc.ports) ? svc.ports[0] : null;
  if (!primary) return [];

  const base = Number.isInteger(options.gatewayPortBase) ? options.gatewayPortBase : DEFAULT_GATEWAY_PORT_BASE;
  const gatewayPort = Number.isInteger(svc.expose.gatewayPort)
    ? svc.expose.gatewayPort
    : deriveGatewayPort(svc.name, base);

  return [
    {
      port: gatewayPort,
      upstream: `${svc.name}.${svc.namespace}.svc.cluster.local:${primary.containerPort}`,
    },
  ];
}

/**
 * 兜底断言：渲染结果只能是命名空间内的 Deployment / Service。
 *
 * @param {object[]} objects 渲染出的对象
 * @param {string} namespace 期望的命名空间
 * @returns {void}
 * @throws {Error} 出现非法类型或跨命名空间对象时抛错（中文）
 */
export function assertNamespacedObjects(objects, namespace) {
  for (const object of objects) {
    if (!ALLOWED_KINDS.includes(object?.kind)) {
      throw new Error(
        `渲染结果里出现不允许的对象类型 "${object?.kind}"：本模块只允许生成命名空间内的 ${ALLOWED_KINDS.join(' / ')}；`
        + 'ClusterRole / Namespace / CRD 等集群级对象必须由运维手工管理。',
      );
    }
    if (object?.metadata?.namespace !== namespace) {
      throw new Error(
        `渲染结果里出现跨命名空间对象 "${object?.kind}/${object?.metadata?.name}"（namespace=${object?.metadata?.namespace}）：`
        + `只允许 ${namespace}，命名空间白名单见 server/infra/model.js。`,
      );
    }
  }
}

/**
 * 渲染一个模型服务：Deployment + Service + 网关路由。
 *
 * @param {object} svc 模型服务（原始或已规范化的意图都行，内部会重新校验）
 * @param {{ gatewayIP?: string|null, renderResources?: Function, gatewayPortBase?: number }} [options]
 *   `renderResources` 覆盖默认的加速卡渲染（测试 / A5 注入用）
 * @returns {{ objects: object[], routes: Array<{port: number, upstream: string}> }}
 *   对象顺序固定：`[Deployment, Service]`
 * @throws {Error} 定义不合法（中文错误，带 `errors` 数组与 code=INFRA_INVALID_MODEL_SERVICE）
 */
export function renderModelService(svc, options = {}) {
  const validation = validateModelService(svc);
  if (!validation.ok) {
    const detail = validation.errors
      .map((error) => (error.field ? `${error.field}: ${error.message}` : error.message))
      .join('；');
    const error = new Error(`模型服务定义不合法，无法渲染：${detail}`);
    error.code = 'INFRA_INVALID_MODEL_SERVICE';
    error.errors = validation.errors;
    throw error;
  }

  const value = validation.value;
  const renderer = typeof options.renderResources === 'function' ? options.renderResources : getResourceRenderer();
  const resources = normalizeResourcesFragment(renderer(value));

  const objects = [
    renderDeployment(value, { resources }),
    renderService(value, { gatewayIP: options.gatewayIP ?? null }),
  ];
  assertNamespacedObjects(objects, value.namespace);

  return {
    objects,
    routes: renderRoutes(value, { gatewayPortBase: options.gatewayPortBase }),
  };
}

/** 快照里对象的排序：先按类型风险序（Deployment → Service），再按 namespace/name。 */
const KIND_ORDER = Object.freeze(['Deployment', 'Service']);

/** 快照条目比较函数（稳定排序，跨机器结果一致）。 */
function compareSnapshotEntries(a, b) {
  const orderA = KIND_ORDER.indexOf(a.kind);
  const orderB = KIND_ORDER.indexOf(b.kind);
  const rankA = orderA === -1 ? KIND_ORDER.length : orderA;
  const rankB = orderB === -1 ? KIND_ORDER.length : orderB;
  if (rankA !== rankB) return rankA - rankB;
  if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

/**
 * 把渲染出的对象打包成快照（A5 的回滚基线）。
 *
 * 快照里存的是**可直接再次 apply 的完整清单**（深拷贝，改快照不影响原对象），
 * 并按 (kind, namespace, name) 稳定排序，所以同一批对象两次打包 deepEqual。
 *
 * @param {object[]} objects 要纳入快照的 k8s 对象（空数组表示「这一代什么都没有」，
 *   A5 回滚到空快照 = 删除资源）
 * @param {{ createdAt?: string|null }} [options] `createdAt` 不传则固定为 null（保证确定性）
 * @returns {{ version: number, kind: string, createdAt: string|null, count: number, entries: object[] }}
 *   每个 entry：`{ kind, apiVersion, namespace, name, key, manifest }`
 */
export function buildSnapshot(objects, options = {}) {
  const createdAt = typeof options?.createdAt === 'string' ? options.createdAt : null;
  const list = (Array.isArray(objects) ? objects : []).filter(isPlainObject);

  const entries = list
    .map((object) => {
      const kind = typeof object.kind === 'string' ? object.kind : '';
      const apiVersion = typeof object.apiVersion === 'string' ? object.apiVersion : '';
      const namespace = typeof object.metadata?.namespace === 'string' ? object.metadata.namespace : '';
      const name = typeof object.metadata?.name === 'string' ? object.metadata.name : '';
      return {
        kind,
        apiVersion,
        namespace,
        name,
        key: `${namespace}/${name}`,
        manifest: deepClone(object),
      };
    })
    .sort(compareSnapshotEntries);

  return {
    version: SNAPSHOT_VERSION,
    kind: 'InfraSnapshot',
    createdAt,
    count: entries.length,
    entries,
  };
}

/**
 * 把快照还原成可 apply 的清单数组（A5 回滚时直接遍历）。
 *
 * @param {{entries?: Array<{manifest: object}>}} snapshot buildSnapshot 的产物
 * @returns {object[]} 深拷贝的清单数组（顺序与快照一致）
 */
export function snapshotToObjects(snapshot) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  return entries.filter((entry) => isPlainObject(entry?.manifest)).map((entry) => deepClone(entry.manifest));
}

export { validateModelService, serviceKey };
