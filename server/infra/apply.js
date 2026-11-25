/**
 * AI Infra 变更执行器（A5）—— 把"渲染好的对象"安全地落到集群，并证明它真的生效。
 *
 * 定位：本模块是**控制面里唯一会写字的一层**。它自己不连集群，所有集群访问都从
 * 参数注入，因此在单测里可以完全脱离真机跑完整状态机（含超时与回滚）。
 *
 * 一次 apply 的状态机（顺序固定，任一步失败即停并回滚）：
 *
 *   guard ──fails──▶ rejected（零 API 调用，allowed:false）
 *     │ ok
 *     ▼
 *   dry-run ──fails──▶ rejected（把 k8s 的原话包成中文错误返回；集群未被修改）
 *     │ ok（顺带做 diff：无实质差异 ⇒ action=noop，后面不再发任何写请求）
 *     ▼
 *   snapshot（读到的旧对象存进 snapshot，回滚的唯一依据）
 *     ▼
 *   apply（create 走 POST 集合路径，update 走 PATCH merge-patch）
 *     ▼
 *   rollout（轮询 deployment.status，直到 observedGeneration/updated/available 都到位）
 *     ▼
 *   allocation（读新 Pod 的 hami.io/vgpu-devices-allocated，"改了但没生效"在这里被抓）
 *     ▼
 *   endpoint（可选探针，仅 2xx 算过）
 *     │
 *     └─任一步失败──▶ rollback（有旧快照就 PATCH 回去，没有就 DELETE 新建对象）
 *
 * 三条硬约束（来自 /tmp/infra-contract.md）：
 *  1. 命名空间白名单在这里**再查一遍**（`inference` / `infra-test`），不依赖 A2 是否查过；
 *  2. 新能力默认关闭：`OPENLOG_K8S_INFRA=1` 才执行（与 `OPENLOG_K8S_WRITE` 正交）；
 *  3. 可回滚：apply 之前一定先落 snapshot，回滚本身失败要给出可操作的错误。
 *
 * 注入的 client 契约（A5 只声明，不实现；真机版由集成层提供）：
 *
 *   client.getJson(path, opts?)                  → Promise<object|null>
 *   client.postJson(path, body, opts?)           → Promise<object>   创建
 *   client.patchJson(path, body, opts?)          → Promise<object>   更新（默认 merge-patch）
 *   client.deleteJson(path, opts?)               → Promise<object>   删除
 *
 *   path 里的 query 由本模块拼好（`?dryRun=All&fieldManager=openlog-infra`），
 *   opts.contentType 由本模块给出（`application/merge-patch+json` / `application/json`），
 *   opts.dryRun 为 true 时表示"服务端干跑，集群不得变更"。
 *   非 2xx 必须 throw，且 error.status 是 HTTP 状态码（回滚靠它识别 404）。
 *
 * 其余注入点：`guard`（A2 的 checkGuard 结果）、`now`（毫秒时钟）、`opts.sleep`
 * （测试传假 sleep，禁止真睡）、`opts.fetchImpl`（端点探针）、`opts.verifyAllocation`
 * （配额校验，默认实现见 defaultVerifyAllocation）。
 */

import { errorMessage } from '../errors.js';
import { readPodVgpu } from '../k8s/hami.js';

/** 命名空间白名单：只允许这两个，其余（含 kube-system / default）代码级拒绝。 */
export const ALLOWED_NAMESPACES = Object.freeze(['inference', 'infra-test']);

/** 步骤名（前端逐步展示的顺序；rollback 只在失败时出现）。 */
export const STEP_NAMES = Object.freeze({
  GUARD: 'guard',
  DRY_RUN: 'dry-run',
  SNAPSHOT: 'snapshot',
  APPLY: 'apply',
  ROLLOUT: 'rollout',
  ALLOCATION: 'allocation',
  ENDPOINT: 'endpoint',
  ROLLBACK: 'rollback',
});

/** 正常路径的步骤顺序（前端拿它渲染"还没走到"的灰条）。 */
export const STEP_SEQUENCE = Object.freeze([
  STEP_NAMES.GUARD,
  STEP_NAMES.DRY_RUN,
  STEP_NAMES.SNAPSHOT,
  STEP_NAMES.APPLY,
  STEP_NAMES.ROLLOUT,
  STEP_NAMES.ALLOCATION,
  STEP_NAMES.ENDPOINT,
]);

/** 滚动等待默认超时（与契约一致：120s）。 */
export const DEFAULT_ROLLOUT_TIMEOUT_MS = 120_000;
/** 滚动轮询间隔默认值。 */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** 端点探针默认重试次数与间隔。 */
export const DEFAULT_PROBE_ATTEMPTS = 3;
export const DEFAULT_PROBE_INTERVAL_MS = 1_000;
/** 单次探针的请求超时。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** HAMi 写在新 Pod 上的分配注解（"配额到底拿没拿到"的唯一事实来源）。 */
export const VGPU_ANNOTATION = 'hami.io/vgpu-devices-allocated';

/** 服务端生成、比较 diff 时必须忽略的 metadata 字段。 */
const SERVER_MANAGED_METADATA = new Set([
  'resourceVersion',
  'uid',
  'creationTimestamp',
  'generation',
  'managedFields',
  'selfLink',
  'ownerReferences',
  'finalizers',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
]);

/** kubectl apply 留下的最后应用记录，属于服务端产物。 */
const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';

/** DNS-1123 label/subdomain 形状（对象名比 label 宽，长度单独校验）。 */
const DNS1123_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** kind → 资源复数名（未知 kind 走小写 + s 兜底，A1 渲染只用到下面这些）。 */
const KIND_RESOURCES = new Map([
  ['Deployment', 'deployments'],
  ['StatefulSet', 'statefulsets'],
  ['DaemonSet', 'daemonsets'],
  ['ReplicaSet', 'replicasets'],
  ['Pod', 'pods'],
  ['Service', 'services'],
  ['ConfigMap', 'configmaps'],
  ['Secret', 'secrets'],
  ['ServiceAccount', 'serviceaccounts'],
  ['PersistentVolumeClaim', 'persistentvolumeclaims'],
  ['Ingress', 'ingresses'],
  ['NetworkPolicy', 'networkpolicies'],
  ['PodDisruptionBudget', 'poddisruptionbudgets'],
  ['HorizontalPodAutoscaler', 'horizontalpodautoscalers'],
  ['Job', 'jobs'],
  ['CronJob', 'cronjobs'],
]);

/** kind → 常见 apiVersion（对象没写 apiVersion 时的兜底，避免拼出错误路径）。 */
const KIND_API_VERSIONS = new Map([
  ['Deployment', 'apps/v1'],
  ['StatefulSet', 'apps/v1'],
  ['DaemonSet', 'apps/v1'],
  ['ReplicaSet', 'apps/v1'],
  ['Pod', 'v1'],
  ['Service', 'v1'],
  ['ConfigMap', 'v1'],
  ['Secret', 'v1'],
  ['ServiceAccount', 'v1'],
  ['PersistentVolumeClaim', 'v1'],
  ['Ingress', 'networking.k8s.io/v1'],
  ['NetworkPolicy', 'networking.k8s.io/v1'],
  ['PodDisruptionBudget', 'policy/v1'],
  ['HorizontalPodAutoscaler', 'autoscaling/v2'],
  ['Job', 'batch/v1'],
  ['CronJob', 'batch/v1'],
]);

/** 集群级对象：不接受（本执行器只写命名空间内的东西）。 */
const CLUSTER_SCOPED_KINDS = new Set([
  'Namespace',
  'Node',
  'PersistentVolume',
  'StorageClass',
  'ClusterRole',
  'ClusterRoleBinding',
  'Role',
  'RoleBinding',
  'CustomResourceDefinition',
  'PriorityClass',
  'IngressClass',
  'APIService',
  'MutatingWebhookConfiguration',
  'ValidatingWebhookConfiguration',
]);

/** 内部：一个步骤失败。step 字段让上层知道停在哪一步。 */
class StepError extends Error {
  constructor(message, step) {
    super(message);
    this.name = 'StepError';
    this.step = step ?? null;
  }
}

/** 默认 sleep：只在生产环境用；测试必须注入假 sleep（禁止真睡）。 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 严格的对象字面量判断（null / 数组都不算）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 把任意值写成适合塞进 detail 的短文本。 */
function preview(value) {
  if (value === undefined) return '缺失';
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  } catch {
    return String(value);
  }
}

/**
 * 把集群返回的错误整理成一句人能看懂的说明。
 *
 * k8s 的重点信息不在 `message` 里，而在响应体 `Status.message`（例如
 * `admission webhook "vgpu.hami.io" denied the request: ...`）。真机 client 会把
 * body 挂到 `err.body`，这里统一把它拼进结果，避免"干跑失败但看不出为什么"。
 *
 * @param {unknown} err 任意抛出物
 * @returns {string} 非空的中文错误说明（必要时带"集群返回："）
 */
export function describeK8sError(err) {
  const message = errorMessage(err);
  const raw = typeof err?.body === 'string' ? err.body : '';
  if (!raw.trim()) return message;
  let reason = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.message === 'string') reason = parsed.message;
  } catch {
    // 非 JSON（HTML 错误页等）：原样带出来
  }
  const clipped = reason.trim().slice(0, 600);
  if (!clipped || message.includes(clipped)) return message;
  return `${message}｜集群返回：${clipped}`;
}

/** 404 判定：注入的 client 可能用 status / statusCode / response.statusCode。 */
export function isNotFoundError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.statusCode;
  if (status === 404) return true;
  return /HTTP 404/.test(errorMessage(err));
}

/** apiVersion → API 基础路径（core 走 /api，其余走 /apis/<group>）。 */
function apiBasePath(apiVersion) {
  const text = String(apiVersion ?? '').trim();
  const slash = text.indexOf('/');
  if (slash === -1) return `/api/${text}`;
  return `/apis/${text.slice(0, slash)}/${text.slice(slash + 1)}`;
}

/** kind → 资源复数名。 */
function resourceNameFor(kind) {
  const mapped = KIND_RESOURCES.get(kind);
  if (mapped) return mapped;
  return `${String(kind).toLowerCase()}s`;
}

/** 对象没写 apiVersion 时按 kind 兜底推断。 */
export function inferApiVersion(kind) {
  return KIND_API_VERSIONS.get(kind) ?? null;
}

/**
 * 拼集合路径（POST 创建用）：`/apis/apps/v1/namespaces/inference/deployments`
 *
 * @param {object} obj k8s 对象（需要 kind + metadata.name/namespace）
 * @returns {string}
 * @throws {Error} 缺 kind / name / namespace / apiVersion 时抛中文错误
 */
export function buildCollectionPath(obj) {
  if (!isPlainObject(obj)) throw new Error('buildCollectionPath：需要一个 k8s 对象');
  const kind = typeof obj.kind === 'string' ? obj.kind : '';
  if (!kind) throw new Error('buildCollectionPath：对象缺少 kind');
  const meta = isPlainObject(obj.metadata) ? obj.metadata : {};
  const name = typeof meta.name === 'string' ? meta.name : '';
  const namespace = typeof meta.namespace === 'string' ? meta.namespace : '';
  if (!name) throw new Error(`buildCollectionPath：${kind} 缺少 metadata.name`);
  if (!namespace) throw new Error(`buildCollectionPath：${kind}/${name} 缺少 metadata.namespace`);
  const apiVersion = typeof obj.apiVersion === 'string' && obj.apiVersion
    ? obj.apiVersion
    : inferApiVersion(kind);
  if (!apiVersion) throw new Error(`buildCollectionPath：${kind}/${name} 缺少 apiVersion，且无法按 kind 推断`);
  return `${apiBasePath(apiVersion)}/namespaces/${namespace}/${resourceNameFor(kind)}`;
}

/**
 * 拼单个对象路径（GET / PATCH / DELETE 用）。
 *
 * @param {object} obj k8s 对象
 * @returns {string} 例：`/apis/apps/v1/namespaces/inference/deployments/qwen`
 */
export function buildObjectPath(obj) {
  const collection = buildCollectionPath(obj);
  return `${collection}/${obj.metadata.name}`;
}

/**
 * 去掉服务端产物，只留"用户声明的样子"。
 *
 * 不这么做的话，第二次 apply 永远算"有差异"（resourceVersion 变了），幂等就废了。
 *
 * @param {object|null} obj 集群里读到的对象
 * @returns {object|null}
 */
export function stripServerFields(obj) {
  if (!isPlainObject(obj)) return obj ?? null;
  const copy = { ...obj };
  delete copy.status;
  const meta = isPlainObject(copy.metadata) ? { ...copy.metadata } : {};
  for (const key of SERVER_MANAGED_METADATA) delete meta[key];
  if (isPlainObject(meta.annotations)) {
    const annotations = { ...meta.annotations };
    delete annotations[LAST_APPLIED_ANNOTATION];
    meta.annotations = annotations;
  }
  copy.metadata = meta;
  return copy;
}

/** 递归比较：desired 里出现的每个叶子都必须在 current 里等于它（current 多出来的键忽略）。 */
function collectMismatches(desired, current, path, out) {
  if (out.length >= 20) return;

  if (Array.isArray(desired)) {
    if (!Array.isArray(current)) {
      out.push({ path, want: `数组(${desired.length})`, got: preview(current) });
      return;
    }
    if (desired.length !== current.length) {
      out.push({ path: `${path}.length`, want: String(desired.length), got: String(current.length) });
      return;
    }
    desired.forEach((item, index) => collectMismatches(item, current[index], `${path}[${index}]`, out));
    return;
  }

  if (isPlainObject(desired)) {
    if (!isPlainObject(current)) {
      out.push({ path, want: '对象', got: preview(current) });
      return;
    }
    for (const key of Object.keys(desired)) {
      collectMismatches(desired[key], current[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }

  if (!Object.is(desired, current)) {
    out.push({ path, want: preview(desired), got: preview(current) });
  }
}

/**
 * 判断"期望对象"与"集群现状"是否等价 —— 幂等的核心。
 *
 * 语义：desired 是权威的，只要求 desired 的每个字段在 current 里一致；
 * current 多出来的字段（服务端默认值、HAMi 注入的注解、status 等）不算差异。
 *
 * @param {object|null} current 集群里读到的对象（可为 null = 不存在）
 * @param {object} desired 渲染出来的对象
 * @returns {{same:boolean, mismatches:{path:string,want:string,got:string}[]}}
 */
export function diffObjects(current, desired) {
  if (!isPlainObject(current)) return { same: false, mismatches: [{ path: '(对象)', want: '存在', got: '缺失' }] };
  const mismatches = [];
  collectMismatches(desired, stripServerFields(current), '', mismatches);
  return { same: mismatches.length === 0, mismatches };
}

/**
 * 默认的配额校验：读 Pod 的 `hami.io/vgpu-devices-allocated`，确认拿到的份额不少于申请值。
 *
 * 为什么这是独立一步：改完 Deployment 之后，Pod 可能因为调度失败、HAMi 版本不认
 * `nvidia.com/gpumem`、或注解被旧 ReplicaSet 的 Pod 顶着，而 controller 照样报
 * "Available"。这种"改了但没生效"只有读注解能发现。
 *
 * 判定口径（默认 at-least）：
 *  - `accelerators` 张卡：注解里至少这么多条设备记录；
 *  - 每张卡的显存 ≥ `memoryMiB`、算力 ≥ `coresPercent`（0 表示该维度不限，跳过）；
 *  - 注解整条缺失且期望值非 0 → 失败（这就是"没生效"）。
 *
 * @param {object} pod 原始 v1.Pod（读 metadata.annotations）
 * @param {{memoryMiB?:number, coresPercent?:number, accelerators?:number, mode?:'at-least'|'exact'}} expected
 * @returns {{ok:boolean, reason?:string, summary:string, actual:{memoryMiB:number,coresPercent:number,cards:number}}}
 */
export function defaultVerifyAllocation(pod, expected = {}) {
  const wantCards = Math.max(0, Number(expected?.accelerators ?? 0) || 0);
  const wantMem = Math.max(0, Number(expected?.memoryMiB ?? 0) || 0);
  const wantCores = Math.max(0, Number(expected?.coresPercent ?? 0) || 0);
  const mode = expected?.mode === 'exact' ? 'exact' : 'at-least';
  const raw = pod?.metadata?.annotations?.[VGPU_ANNOTATION];
  const summary = typeof raw === 'string' && raw.trim() ? raw.trim() : '未声明 vGPU 配额';

  if (wantMem === 0 && wantCores === 0 && wantCards === 0) {
    // 整卡 / 不限：没有配额要求，注解有无都不影响结论
    return { ok: true, summary, actual: { memoryMiB: 0, coresPercent: 0, cards: 0 } };
  }

  const vgpu = readPodVgpu(pod);
  const devices = Array.isArray(vgpu?.devices) ? vgpu.devices : [];
  const actual = {
    memoryMiB: Number(vgpu?.totalMemMiB ?? 0),
    coresPercent: Number(vgpu?.totalCores ?? 0),
    cards: devices.length,
  };

  if (!vgpu?.hasVgpu) {
    return {
      ok: false,
      reason: `Pod 上没有 ${VGPU_ANNOTATION} 注解（期望 ${wantCards || 1} 卡 / 显存 ${wantMem}MiB / 算力 ${wantCores}%），说明 vGPU 配额没有被真正分配`,
      summary,
      actual,
    };
  }

  const wantDeviceCount = wantCards || 1;
  if (devices.length < wantDeviceCount) {
    return {
      ok: false,
      reason: `只分配到 ${devices.length} 张卡，期望 ${wantDeviceCount} 张（注解：${summary}）`,
      summary,
      actual,
    };
  }

  const compare = (got, want) => (mode === 'exact' ? got === want : got >= want);
  for (const device of devices) {
    const mem = Number(device?.memMiB ?? 0);
    const cores = Number(device?.cores ?? 0);
    if (wantMem > 0 && !compare(mem, wantMem)) {
      return {
        ok: false,
        reason: `设备 ${device?.id ?? '(未知)'} 的显存 ${mem}MiB ${mode === 'exact' ? '不等于' : '低于'}申请的 ${wantMem}MiB`,
        summary,
        actual,
      };
    }
    if (wantCores > 0 && !compare(cores, wantCores)) {
      return {
        ok: false,
        reason: `设备 ${device?.id ?? '(未知)'} 的算力 ${cores}% ${mode === 'exact' ? '不等于' : '低于'}申请的 ${wantCores}%`,
        summary,
        actual,
      };
    }
  }

  return { ok: true, summary, actual };
}

/**
 * 判断一次 Deployment 是否滚完（纯函数，便于单测）。
 *
 * @param {object} deployment 原始 apps/v1 Deployment
 * @param {number} [wantReplicas] 期望副本数（缺省用 spec.replicas）
 * @returns {{ready:boolean, reason:string}}
 */
export function evaluateRollout(deployment, wantReplicas) {
  if (!isPlainObject(deployment)) return { ready: false, reason: '读不到 Deployment 对象' };
  const meta = isPlainObject(deployment.metadata) ? deployment.metadata : {};
  const spec = isPlainObject(deployment.spec) ? deployment.spec : {};
  const status = isPlainObject(deployment.status) ? deployment.status : {};
  const desired = Math.max(1, Number(wantReplicas ?? spec.replicas ?? 1) || 1);
  const generation = Number(meta.generation ?? 0) || 0;
  const observed = Number(status.observedGeneration ?? 0) || 0;
  if (observed < generation) {
    return { ready: false, reason: `尚未观察到最新 generation（observed ${observed} < ${generation}）` };
  }
  const updated = Number(status.updatedReplicas ?? 0) || 0;
  if (updated < desired) return { ready: false, reason: `已更新副本 ${updated}/${desired}` };
  const total = Number(status.replicas ?? 0) || 0;
  if (total > desired) return { ready: false, reason: `旧副本未退出（总副本 ${total} > ${desired}）` };
  const available = Number(status.availableReplicas ?? 0) || 0;
  if (available < desired) return { ready: false, reason: `可用副本 ${available}/${desired}` };
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const progressing = conditions.find((item) => item?.type === 'Progressing');
  if (progressing && progressing.status === 'False') {
    return { ready: false, reason: `Progressing=False：${progressing.message ?? '滚动失败'}` };
  }
  return { ready: true, reason: '' };
}

/** 从 Deployment 的 selector 推 labelSelector；没有 selector 时退回 `app=<name>`。 */
function labelSelectorFor(deployment) {
  const matchLabels = deployment?.spec?.selector?.matchLabels;
  if (isPlainObject(matchLabels)) {
    const parts = Object.entries(matchLabels).map(([key, value]) => `${key}=${value}`);
    if (parts.length > 0) return parts.join(',');
  }
  const name = deployment?.metadata?.name;
  return name ? `app=${name}` : '';
}

/**
 * 步骤记录器：每步一条 { name, ok, detail, ms }，失败抛 StepError。
 *
 * onStep 是给前端做"逐步点亮"用的旁路回调：它在步骤落账之后同步触发，
 * 自己抛错只影响它自己（不会让变更流程失败），因此可以直接接 SSE/WebSocket 推送。
 */
function createStepRunner(clock, onStep) {
  const steps = [];
  const notify = (entry) => {
    if (typeof onStep !== 'function') return;
    try {
      onStep(entry, steps);
    } catch {
      // 观察者崩了不影响执行器（控制面不能因为推送失败就把变更搞挂）
    }
  };
  async function step(name, fn) {
    const started = clock();
    try {
      const detail = await fn();
      const text = typeof detail === 'string' && detail ? detail : '完成';
      const entry = { name, ok: true, detail: text, ms: Math.max(0, clock() - started) };
      steps.push(entry);
      notify(entry);
    } catch (err) {
      const text = err instanceof StepError ? err.message : errorMessage(err);
      const entry = { name, ok: false, detail: text, ms: Math.max(0, clock() - started) };
      steps.push(entry);
      notify(entry);
      throw new StepError(text, name);
    }
  }
  return { steps, step };
}

/** 注入 client → 统一 IO 门面；写方法缺失时报出可操作的错误（而不是 TypeError）。 */
function createClientIo(client) {
  if (!client || typeof client.getJson !== 'function') {
    throw new Error('注入的 Kubernetes 客户端缺少 getJson：无法读取现有对象与运行状态，请检查 infra client 注入');
  }
  const writer = (name) => {
    const fn = client[name];
    if (typeof fn !== 'function') {
      throw new Error(
        `注入的 Kubernetes 客户端缺少 ${name}：AI Infra 变更需要可写客户端（getJson/postJson/patchJson/deleteJson），`
        + '请确认 OPENLOG_K8S_WRITE 已启用且 infra 写客户端已注入',
      );
    }
    return (path, body, options) => fn.call(client, path, body, options);
  };
  return {
    read: (path) => client.getJson(path),
    create: (path, body, options) => writer('postJson')(path, body, options),
    update: (path, body, options) => writer('patchJson')(path, body, options),
    remove: (path, options) => writer('deleteJson')(path, undefined, options),
  };
}

/** 本地预检：开关、白名单、对象形状。返回 null 表示通过。 */
function checkLocalPreconditions({ service, objects, env }) {
  if (env && String(env.OPENLOG_K8S_INFRA ?? '') !== '1') {
    return 'AI Infra 变更能力未启用：请设置 OPENLOG_K8S_INFRA=1（与 OPENLOG_K8S_WRITE 正交）后重启服务';
  }
  if (!isPlainObject(service)) {
    return '缺少 service：变更执行器需要 A1 的 ModelService 描述（至少含 name / namespace）';
  }
  const namespace = typeof service.namespace === 'string' ? service.namespace : '';
  if (!ALLOWED_NAMESPACES.includes(namespace)) {
    return `命名空间 ${namespace || '(未设置)'} 不在白名单内：只允许 ${ALLOWED_NAMESPACES.join(' / ')}`;
  }
  if (!Array.isArray(objects) || objects.length === 0) {
    return 'objects 为空：没有可应用的 k8s 对象，拒绝向集群发起任何请求';
  }

  const seen = new Set();
  for (const obj of objects) {
    if (!isPlainObject(obj)) return 'objects 中存在非对象元素：每个元素必须是 k8s 清单对象';
    const kind = typeof obj.kind === 'string' ? obj.kind : '';
    if (!kind) return '对象缺少 kind：无法确定 API 路径';
    if (CLUSTER_SCOPED_KINDS.has(kind)) {
      return `${kind} 属于集群级对象，本执行器只管理命名空间内对象（${ALLOWED_NAMESPACES.join(' / ')}）`;
    }
    const meta = isPlainObject(obj.metadata) ? obj.metadata : {};
    const name = typeof meta.name === 'string' ? meta.name : '';
    if (!name) return `${kind} 对象缺少 metadata.name`;
    if (name.length > 253 || !DNS1123_NAME.test(name)) {
      return `${kind} 的 metadata.name 不是合法 DNS 名称：${name}`;
    }
    const objectNamespace = typeof meta.namespace === 'string' ? meta.namespace : '';
    if (!ALLOWED_NAMESPACES.includes(objectNamespace)) {
      return `${kind}/${name} 的命名空间 ${objectNamespace || '(未设置)'} 不在白名单内（二次防御，与 A2 无关）：`
        + `只允许 ${ALLOWED_NAMESPACES.join(' / ')}`;
    }
    if (objectNamespace !== namespace) {
      return `${kind}/${name} 的命名空间 ${objectNamespace} 与 service.namespace（${namespace}）不一致`;
    }
    const key = `${kind}/${name}`;
    if (seen.has(key)) return `同一次 apply 里出现重复对象：${key}`;
    seen.add(key);
    if (typeof obj.apiVersion !== 'string' && !inferApiVersion(kind)) {
      return `${kind}/${name} 缺少 apiVersion`;
    }
  }
  return null;
}

/** 读取每个对象在集群里的现状，算好"要不要改"。 */
async function buildPlan({ objects, io }) {
  const plan = [];
  for (const obj of objects) {
    const objectPath = buildObjectPath(obj);
    const collectionPath = buildCollectionPath(obj);
    let current = null;
    try {
      current = await io.read(objectPath);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    const exists = isPlainObject(current);
    const comparison = exists ? diffObjects(current, obj) : { same: false, mismatches: [] };
    plan.push({
      obj,
      kind: obj.kind,
      name: obj.metadata.name,
      namespace: obj.metadata.namespace,
      objectPath,
      collectionPath,
      exists,
      current: exists ? current : null,
      same: comparison.same,
      mismatches: comparison.mismatches,
    });
  }
  return plan;
}

/** 发一次真实写入（或服务端干跑）。create 走集合路径，update 走对象路径。 */
async function pushObject(io, item, { dryRun }) {
  const query = dryRun ? '?dryRun=All&fieldManager=openlog-infra' : '?fieldManager=openlog-infra';
  if (item.exists) {
    return io.update(`${item.objectPath}${query}`, item.obj, {
      contentType: 'application/merge-patch+json',
      dryRun,
    });
  }
  return io.create(`${item.collectionPath}${query}`, item.obj, {
    contentType: 'application/json',
    dryRun,
  });
}

/** 轮询 deployment.status 直到就绪或超时（超时抛 StepError，触发上层回滚）。 */
async function waitForRollout({ io, deployment, wantReplicas, clock, sleep, timeoutMs, intervalMs }) {
  const started = clock();
  const stepMs = Math.max(1, intervalMs);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / stepMs)) + 1;
  let lastReason = '尚未开始轮询';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let deploymentNow;
    try {
      deploymentNow = await io.read(deployment.objectPath);
    } catch (err) {
      throw new StepError(`读取 Deployment 状态失败（${deployment.kind}/${deployment.name}）：${describeK8sError(err)}`, STEP_NAMES.ROLLOUT);
    }
    const verdict = evaluateRollout(deploymentNow, wantReplicas);
    if (verdict.ready) {
      const status = isPlainObject(deploymentNow?.status) ? deploymentNow.status : {};
      return `滚动完成（第 ${attempt} 次轮询：available ${status.availableReplicas ?? 0}/${wantReplicas}，updated ${status.updatedReplicas ?? 0}/${wantReplicas}）`;
    }
    lastReason = verdict.reason;
    if (clock() - started >= timeoutMs || attempt === maxAttempts) break;
    await sleep(intervalMs);
  }

  throw new StepError(`滚动超时：${timeoutMs}ms 内未就绪（最后一次：${lastReason}）`, STEP_NAMES.ROLLOUT);
}

/** 列出与 Deployment selector 匹配的 Pod（新的在前，取前 replicas 个）。 */
async function listCandidatePods({ io, deployment, replicas }) {
  const namespace = deployment.namespace;
  const selector = labelSelectorFor(deployment.obj);
  const query = selector ? `?labelSelector=${encodeURIComponent(selector)}` : '';
  let data;
  try {
    data = await io.read(`/api/v1/namespaces/${namespace}/pods${query}`);
  } catch (err) {
    throw new StepError(`读取 Pod 列表失败（${namespace}/${selector || '全部'}）：${describeK8sError(err)}`, STEP_NAMES.ALLOCATION);
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  const wanted = Math.max(1, replicas);
  const candidates = items
    .filter((pod) => isPlainObject(pod))
    .filter((pod) => pod?.metadata?.deletionTimestamp === undefined)
    .filter((pod) => {
      const phase = pod?.status?.phase;
      // 测试与真机：没写 phase 的按 Running 处理，Failed/Pending 的不算
      return phase === undefined || phase === null || phase === 'Running';
    })
    .sort((left, right) => String(right?.metadata?.creationTimestamp ?? '')
      .localeCompare(String(left?.metadata?.creationTimestamp ?? '')))
    .slice(0, wanted);
  return { candidates, selector, namespace };
}

/** 配额校验步骤：任何一张新 Pod 拿不到申请的份额都算失败。 */
async function verifyAllocationStep({ io, deployment, service, replicas, verifyAllocation, mode }) {
  const { candidates, selector } = await listCandidatePods({ io, deployment, replicas });
  if (candidates.length === 0) {
    throw new StepError(
      `没有找到运行中的 Pod（selector ${selector || '(空)'}），无法确认 vGPU 配额是否生效；`
      + '通常是镜像拉取失败或调度不上，请先 kubectl get pods 看事件',
      STEP_NAMES.ALLOCATION,
    );
  }

  const expected = {
    memoryMiB: Number(service?.resources?.memoryMiB ?? 0) || 0,
    coresPercent: Number(service?.resources?.coresPercent ?? 0) || 0,
    accelerators: Number(service?.resources?.accelerators ?? 0) || 0,
    mode,
  };

  const notes = [];
  for (const pod of candidates) {
    let verdict;
    try {
      verdict = await verifyAllocation(pod, expected);
    } catch (err) {
      throw new StepError(`配额校验函数执行失败：${errorMessage(err)}`, STEP_NAMES.ALLOCATION);
    }
    if (verdict === true || verdict?.ok === true) {
      const summary = verdict?.summary ?? verdict?.actual?.summary ?? '';
      notes.push(summary ? `${pod.metadata.name}（${summary}）` : pod.metadata.name);
      continue;
    }
    const reason = verdict?.reason ?? '校验未通过（未给出原因）';
    throw new StepError(
      `vGPU 配额没有真正生效：Pod ${pod.metadata.name} —— ${reason}`,
      STEP_NAMES.ALLOCATION,
    );
  }

  return `vGPU 配额已生效（${candidates.length} 个 Pod）：${notes.join('；')}`;
}

/** 端点探针：只有 2xx 算过。 */
async function probeEndpoint({ url, fetchImpl, attempts, intervalMs, timeoutMs, sleep }) {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let status = null;
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
      const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal });
      status = Number(response?.status ?? 0);
      if (response?.ok === true || (status >= 200 && status < 300)) {
        return `端点探针通过：GET ${url} → HTTP ${status}`;
      }
      failures.push(`HTTP ${status || '未知'}`);
    } catch (err) {
      failures.push(errorMessage(err));
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new StepError(
    `端点探针失败：GET ${url} 未返回 2xx（共 ${attempts} 次：${failures.join(' / ')}）`,
    STEP_NAMES.ENDPOINT,
  );
}

/**
 * 执行一次变更：护栏 → 干跑 → 快照 → 应用 → 滚动 → 配额 → 端点（失败自动回滚）。
 *
 * @param {object} params
 * @param {object} params.service A1 的 ModelService（本模块只读 resources / replicas / namespace）
 * @param {object[]} params.objects A1 render 出来的 k8s 对象数组
 * @param {object} params.client 注入的集群客户端（见文件头契约）
 * @param {{allowed:boolean, violations?:string[], diff?:string}|boolean} params.guard A2 的 checkGuard 结果
 * @param {() => number} [params.now] 毫秒时钟（测试注入假时钟）
 * @param {object} [params.opts]
 * @param {number} [params.opts.rolloutTimeoutMs=120000] 滚动超时
 * @param {number} [params.opts.pollIntervalMs=2000] 滚动轮询间隔
 * @param {string} [params.opts.probeUrl] 端点探针地址（不配则跳过该步）
 * @param {Function} [params.opts.fetchImpl] 探针用的 fetch
 * @param {number} [params.opts.probeAttempts=3] 探针重试次数
 * @param {number} [params.opts.probeIntervalMs=1000] 探针重试间隔
 * @param {number} [params.opts.probeTimeoutMs=5000] 单次探针超时
 * @param {Function} [params.opts.sleep] 注入 sleep（测试用假 sleep，禁止真睡）
 * @param {Function} [params.opts.verifyAllocation] 注入配额校验（签名同 defaultVerifyAllocation）
 * @param {'at-least'|'exact'} [params.opts.allocationMode='at-least'] 配额比较口径
 * @param {(entry:object, steps:object[]) => void} [params.opts.onStep] 每步落账时的旁路回调（前端逐步展示/SSE 推送）
 * @param {object} [params.opts.env] 环境变量表（默认 process.env，用来校验 OPENLOG_K8S_INFRA）
 * @returns {Promise<{ok:boolean, allowed:boolean, action:'create'|'patch'|'noop'|'rejected',
 *   steps:{name:string,ok:boolean,detail:string,ms:number}[], snapshot:object,
 *   rollbackAvailable:boolean, rollback:object|null, error?:string, errorStep?:string|null}>}
 *
 *   action 语义：
 *     'create'   —— 计划新建（全部对象在集群里都不存在）
 *     'patch'    —— 计划更新（至少一个对象已存在）
 *     'noop'     —— 与集群现状无实质差异，一次写请求都没发
 *     'rejected' —— 没走到写入就被拦下（护栏/白名单/开关/干跑/注入缺失），集群未被修改
 *   rollbackAvailable：现在还能不能撤销这次变更（成功变更后为 true；回滚成功后为 false；
 *   回滚失败时仍为 true，表示人工还有干预空间）。
 */
export async function applyService({ service, objects, client, guard, now, opts = {} } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const env = opts.env ?? process.env;
  const rolloutTimeoutMs = Number(opts.rolloutTimeoutMs ?? DEFAULT_ROLLOUT_TIMEOUT_MS) || DEFAULT_ROLLOUT_TIMEOUT_MS;
  const pollIntervalMs = Math.max(1, Number(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS);
  const probeAttempts = Math.max(1, Number(opts.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS) || DEFAULT_PROBE_ATTEMPTS);
  const probeIntervalMs = Math.max(1, Number(opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS) || DEFAULT_PROBE_INTERVAL_MS);
  const probeTimeoutMs = Math.max(1, Number(opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS) || DEFAULT_PROBE_TIMEOUT_MS);
  const verifyAllocation = typeof opts.verifyAllocation === 'function'
    ? opts.verifyAllocation
    : defaultVerifyAllocation;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;

  const runner = createStepRunner(clock, opts.onStep);
  const { steps, step } = runner;

  const snapshot = {
    namespace: typeof service?.namespace === 'string' ? service.namespace : null,
    capturedAt: new Date(clock()).toISOString(),
    objects: [],
  };
  const plan = [];
  let action = 'noop';
  let allowed = true;
  let writeAttempted = false;
  let rollbackReport = null;

  const rollbackAvailable = () => {
    if (rollbackReport) return rollbackReport.ok ? false : snapshot.objects.length > 0;
    if (!writeAttempted || action === 'noop') return false;
    return snapshot.objects.length > 0;
  };
  const finish = (payload) => {
    const result = {
      ok: payload.ok,
      allowed,
      action,
      steps,
      snapshot,
      rollbackAvailable: rollbackAvailable(),
    };
    if (payload.error) result.error = payload.error;
    if (payload.errorStep !== undefined) result.errorStep = payload.errorStep;
    // 形状稳定：没回滚时是 null，前端不必判 undefined
    result.rollback = rollbackReport;
    return result;
  };

  let io;
  try {
    io = createClientIo(client);
  } catch (err) {
    return finish({ ok: false, action: 'rejected', error: errorMessage(err), errorStep: STEP_NAMES.GUARD });
  }

  try {
    // ① 护栏复核：A2 的结论 + 本层自己的白名单/开关/形状校验，任何不通过都零 API 调用。
    await step(STEP_NAMES.GUARD, async () => {
      const localProblem = checkLocalPreconditions({ service, objects, env });
      if (localProblem) {
        allowed = false;
        throw new StepError(localProblem, STEP_NAMES.GUARD);
      }
      const guardAllowed = guard === true || guard?.allowed === true;
      if (!guardAllowed) {
        allowed = false;
        const violations = Array.isArray(guard?.violations) ? guard.violations.filter(Boolean) : [];
        const detail = violations.length > 0
          ? `护栏未通过：${violations.join('；')}`
          : '护栏未通过：上游没有给出 allowed=true 的结论，按拒绝处理';
        throw new StepError(detail, STEP_NAMES.GUARD);
      }
      const diffHint = typeof guard?.diff === 'string' && guard.diff.trim() ? '，差异预览已生成' : '';
      return `护栏通过（命名空间 ${service.namespace}，${objects.length} 个对象${diffHint}）`;
    });

    // ② 服务端干跑（同时算 diff：无实质差异直接判定 noop，绝不发写请求）。
    await step(STEP_NAMES.DRY_RUN, async () => {
      let planned;
      try {
        planned = await buildPlan({ objects, io });
      } catch (err) {
        throw new StepError(`读取集群现状失败：${describeK8sError(err)}；请检查 kubeconfig 与读取权限`, STEP_NAMES.DRY_RUN);
      }
      plan.push(...planned);
      const pending = plan.filter((item) => !item.same);
      if (pending.length === 0) {
        action = 'noop';
        return `与集群现状一致，跳过服务端干跑（${plan.length} 个对象均无实质差异，不发写请求）`;
      }

      for (const item of pending) {
        try {
          await pushObject(io, item, { dryRun: true });
        } catch (err) {
          throw new StepError(
            `服务端干跑失败（${item.kind}/${item.name}）：${describeK8sError(err)}`,
            STEP_NAMES.DRY_RUN,
          );
        }
      }
      action = pending.some((item) => item.exists) ? 'patch' : 'create';
      const names = pending.map((item) => `${item.kind}/${item.name}`).join('、');
      return `服务端干跑通过：${pending.length}/${plan.length} 个对象需要变更（${names}）`;
    });

    // ③ 快照：回滚的唯一依据，必须在写之前落好。
    await step(STEP_NAMES.SNAPSHOT, async () => {
      for (const item of plan) {
        snapshot.objects.push({
          ref: {
            apiVersion: item.obj.apiVersion ?? inferApiVersion(item.kind),
            kind: item.kind,
            namespace: item.namespace,
            name: item.name,
          },
          existed: item.exists,
          body: item.current,
        });
      }
      const existing = snapshot.objects.filter((entry) => entry.existed).length;
      const created = snapshot.objects.length - existing;
      if (existing === 0) return `首次创建：${created} 个对象在集群里都不存在，回滚方式为删除`;
      return `已保存 ${existing} 个既有对象快照，${created} 个对象为新建（回滚时 PATCH 恢复 / DELETE 清理）`;
    });

    // ④ 应用：只有这里会真正改动集群。
    await step(STEP_NAMES.APPLY, async () => {
      if (action === 'noop') return '无实质差异，跳过写入';
      const pending = plan.filter((item) => !item.same);
      if (pending.length === 0) return '无实质差异，跳过写入';

      writeAttempted = true;
      const done = [];
      for (const item of pending) {
        try {
          await pushObject(io, item, { dryRun: false });
        } catch (err) {
          throw new StepError(`应用失败（${item.kind}/${item.name}）：${describeK8sError(err)}`, STEP_NAMES.APPLY);
        }
        done.push(`${item.kind}/${item.name}`);
      }
      return `${action === 'create' ? '新建' : '更新'} ${done.length} 个对象：${done.join('、')}`;
    });

    const deployment = plan.find((item) => item.kind === 'Deployment') ?? null;
    const wantReplicas = Math.max(1, Number(
      deployment?.obj?.spec?.replicas ?? service?.replicas ?? 1,
    ) || 1);

    // ⑤ 滚动等待。
    await step(STEP_NAMES.ROLLOUT, async () => {
      if (!deployment) return '没有 Deployment 对象，跳过滚动等待';
      return waitForRollout({
        io,
        deployment,
        wantReplicas,
        clock,
        sleep,
        timeoutMs: rolloutTimeoutMs,
        intervalMs: pollIntervalMs,
      });
    });

    // ⑥ 配额校验：读新 Pod 的注解，确认"改了真的生效了"。
    await step(STEP_NAMES.ALLOCATION, async () => {
      if (!deployment) return '没有 Deployment 对象，跳过 vGPU 配额校验';
      return verifyAllocationStep({
        io,
        deployment,
        service,
        replicas: wantReplicas,
        verifyAllocation,
        mode: opts.allocationMode === 'exact' ? 'exact' : 'at-least',
      });
    });

    // ⑦ 端点验证（可选）。
    await step(STEP_NAMES.ENDPOINT, async () => {
      const url = typeof opts.probeUrl === 'string' ? opts.probeUrl.trim() : '';
      if (!url) return '未配置探针地址（opts.probeUrl），跳过端点验证';
      if (typeof fetchImpl !== 'function') {
        throw new StepError('端点验证需要 fetchImpl：请注入 fetch 或去掉 opts.probeUrl', STEP_NAMES.ENDPOINT);
      }
      return probeEndpoint({
        url,
        fetchImpl,
        attempts: probeAttempts,
        intervalMs: probeIntervalMs,
        timeoutMs: probeTimeoutMs,
        sleep,
      });
    });

    return finish({ ok: true });
  } catch (err) {
    const failure = err instanceof StepError ? err : new StepError(errorMessage(err), null);
    const failedStep = failure.step ?? steps[steps.length - 1]?.name ?? null;
    let error = failure.message;
    // 写请求一次都没发出去（护栏/干跑/注入校验失败）→ 明确 rejected，前端据此区分"没动集群"
    if (!writeAttempted) action = 'rejected';

    if (writeAttempted) {
      const rollbackStarted = clock();
      let report;
      try {
        report = await rollbackService({ snapshot, client, now: clock, opts });
      } catch (rollbackErr) {
        report = { ok: false, steps: [], error: `回滚过程异常：${errorMessage(rollbackErr)}` };
      }
      rollbackReport = report;
      const restored = report.steps.filter((entry) => entry.ok).length;
      const detail = report.ok
        ? `已回滚到变更前状态（${restored} 个对象恢复/清理完成）`
        : `${report.error ?? '回滚未完成'}；集群可能处于中间状态，请人工核对：${snapshot.objects
          .map((entry) => `${entry.ref.kind}/${entry.ref.name}`)
          .join('、')}`;
      steps.push({
        name: STEP_NAMES.ROLLBACK,
        ok: report.ok === true,
        detail,
        ms: Math.max(0, clock() - rollbackStarted),
      });
      error = report.ok ? `${error}；已自动回滚` : `${error}；${report.error ?? '回滚未完成'}`;
    }

    return finish({ ok: false, error, errorStep: failedStep });
  }
}

/** 把各种快照写法归一成 [{ref, existed, body, path}]（兼容 A7 历史回滚传原始对象数组）。 */
function normalizeSnapshotEntries(snapshot) {
  if (!snapshot) return [];
  const list = Array.isArray(snapshot)
    ? snapshot
    : (Array.isArray(snapshot.objects) ? snapshot.objects : []);
  const entries = [];
  for (const raw of list) {
    if (!isPlainObject(raw)) continue;
    if (isPlainObject(raw.ref)) {
      const ref = {
        apiVersion: raw.ref.apiVersion ?? inferApiVersion(raw.ref.kind),
        kind: raw.ref.kind,
        namespace: raw.ref.namespace,
        name: raw.ref.name,
      };
      const body = raw.existed === false ? null : (isPlainObject(raw.body) ? raw.body : null);
      if (!ref.kind || !ref.name || !ref.namespace) continue;
      entries.push({
        ref,
        existed: isPlainObject(body),
        body,
        path: buildObjectPath({ apiVersion: ref.apiVersion, kind: ref.kind, metadata: { name: ref.name, namespace: ref.namespace } }),
      });
      continue;
    }
    if (typeof raw.kind === 'string' && isPlainObject(raw.metadata) && raw.metadata.name) {
      const ref = {
        apiVersion: raw.apiVersion ?? inferApiVersion(raw.kind),
        kind: raw.kind,
        namespace: raw.metadata.namespace,
        name: raw.metadata.name,
      };
      entries.push({ ref, existed: true, body: raw, path: buildObjectPath(raw) });
    }
  }
  return entries;
}

/**
 * 回滚：把 snapshot 按原顺序 apply 回去；快照里 marked 为"不存在"的对象直接删除。
 *
 * 语义（与 apply 对称）：
 *  - 每个对象单独 try：一个恢复失败不阻断其余对象（尽量把集群拉回已知状态），
 *    但整体 ok=false 并给出可操作错误（人工介入时需要知道核对哪几个对象）。
 *  - 删除时 404 视为已达成目标（对象本来就不在）。
 *  - 快照为空 → 没有可回滚的东西，返回 ok=true + 一条说明（不猜、不乱删）。
 *
 * @param {object} params
 * @param {object|object[]|null} params.snapshot applyService 返回的 snapshot（也接受 A7 的原始对象数组）
 * @param {object} params.client 注入的集群客户端
 * @param {() => number} [params.now] 毫秒时钟
 * @param {object} [params.opts] 与 applyService 同源（本函数只用 sleep，不需要）
 * @returns {Promise<{ok:boolean, steps:{name:string,ok:boolean,detail:string,ms:number}[], error?:string}>}
 */
export async function rollbackService({ snapshot, client, now, opts = {} } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const runner = createStepRunner(clock, opts.onStep);
  const { steps, step } = runner;

  let entries;
  try {
    entries = normalizeSnapshotEntries(snapshot);
  } catch (err) {
    return {
      ok: false,
      steps: [{ name: STEP_NAMES.ROLLBACK, ok: false, detail: `快照无法解析：${errorMessage(err)}`, ms: 0 }],
      error: `回滚失败：快照无法解析（${errorMessage(err)}），请人工核对集群现状`,
    };
  }

  if (entries.length === 0) {
    return {
      ok: true,
      steps: [{ name: STEP_NAMES.ROLLBACK, ok: true, detail: '快照为空：没有对象需要回滚', ms: 0 }],
    };
  }

  let io;
  try {
    io = createClientIo(client);
  } catch (err) {
    return {
      ok: false,
      steps: [{ name: STEP_NAMES.ROLLBACK, ok: false, detail: errorMessage(err), ms: 0 }],
      error: `回滚失败：${errorMessage(err)}`,
    };
  }

  const failures = [];
  for (const entry of entries) {
    const label = `${entry.ref.kind}/${entry.ref.name}`;
    const stepName = entry.existed ? `restore:${label}` : `delete:${label}`;
    try {
      await step(stepName, async () => {
        if (entry.existed) {
          try {
            await io.update(entry.path, entry.body, { contentType: 'application/merge-patch+json' });
          } catch (err) {
            failures.push(`${label} 无法恢复：${describeK8sError(err)}`);
            throw new StepError(`${label} 无法恢复：${describeK8sError(err)}`, stepName);
          }
          return `已恢复变更前配置：${label}`;
        }
        try {
          await io.remove(entry.path);
        } catch (err) {
          if (isNotFoundError(err)) return `对象已不存在，无需删除：${label}`;
          failures.push(`${label} 无法删除：${describeK8sError(err)}`);
          throw new StepError(`${label} 无法删除：${describeK8sError(err)}`, stepName);
        }
        return `已删除新建对象：${label}`;
      });
    } catch {
      // 失败已进 failures 与 steps，继续恢复下一个对象（回滚要尽力而为）
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      steps,
      error: `回滚失败：${failures.join('；')}；集群可能停在中间状态，请按上述对象人工核对后再重试`,
    };
  }
  return { ok: true, steps };
}
