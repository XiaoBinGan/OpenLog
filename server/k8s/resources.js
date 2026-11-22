/**
 * Kubernetes 资源归一化（增量 ①）
 *
 * 职责：把 kube-apiserver 返回的原始 list 对象（/api/v1/nodes、/api/v1/pods 等）
 * 压成前端与 store 共用的扁平结构，见 /tmp/k8s-contract.md 的数据契约。
 *
 * 设计约束：
 * - **纯函数**：不联网、不读写磁盘、不抛异常。真实集群里 items 可能是 null、
 *   字段可能整块缺失（RBAC 只读部分字段时尤其常见），所以到处用可选链 + 默认值。
 * - 字段名一个都不能改，前端（A7）与类型（A8）直接依赖。
 * - 数字字段缺失一律按 0（工作负载语义），字符串字段缺失按 ''（未知）。
 */

/** 数组兜底：非数组（undefined/null/对象）统一当空列表。 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 字符串兜底：null/undefined → ''，其余转字符串。 */
function asString(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** 数字兜底：NaN/Infinity/非法值 → 0。 */
function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 可选字符串字段：只有真正存在且非空时才写进结果，避免序列化出 undefined。 */
function optionalString(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  return value;
}

/** 是否是「普通对象」（排除 null / 数组 / 原始值）。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 原始映射透传（`status.allocatable`、`metadata.annotations` 这类）。
 * 值统一转字符串、键顺序保持输入顺序；非对象输入 → 空映射（不抛异常）。
 * HAMi 的扩展资源（`nvidia.com/gpu` / `gpumem` / `gpucores`）与
 * `hami.io/vgpu-*` 注解都靠它带出去，解析在 server/k8s/hami.js。
 */
function asStringMap(value, skipKey) {
  const bag = isPlainObject(value) ? value : {};
  const out = {};
  for (const key of Object.keys(bag)) {
    if (skipKey !== undefined && key === skipKey) continue;
    out[key] = asString(bag[key]);
  }
  return out;
}

/**
 * `kubectl apply` 会把整份清单压进这个注解（实测常见几十 KB），
 * 概览与 Pod 列表都不用它，透传时直接丢掉，避免 payload 无谓膨胀。
 */
const BULKY_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';

/** 从 labels 推导节点角色。master 与 control-plane 都保留（k3s 两个标签都打）。 */
function deriveRoles(labels) {
  const out = new Set();
  const bag = labels && typeof labels === 'object' ? labels : {};

  const ROLE_PREFIX = 'node-role.kubernetes.io/';
  for (const key of Object.keys(bag)) {
    if (!key.startsWith(ROLE_PREFIX)) continue;
    const role = key.slice(ROLE_PREFIX.length).trim();
    // `node-role.kubernetes.io/` 这种空后缀没有语义，丢掉
    if (role) out.add(role);
  }

  // 旧式标签：kubernetes.io/role: master|node
  const legacy = asString(bag['kubernetes.io/role']).trim();
  if (legacy && legacy !== 'true' && legacy !== 'false') out.add(legacy);

  // 排序保证输出稳定（测试与 UI 都不受 label 插入顺序影响）
  return [...out].sort();
}

/** 节点 conditions 原样透传，去掉 undefined 的 reason/message。 */
function normalizeConditions(conditions) {
  return asArray(conditions).map((cond) => {
    const item = {
      type: asString(cond?.type),
      status: asString(cond?.status),
    };
    const reason = optionalString(cond?.reason);
    const message = optionalString(cond?.message);
    if (reason !== undefined) item.reason = reason;
    if (message !== undefined) item.message = message;
    return item;
  });
}

/** 按地址类型取节点地址（InternalIP 用于拓扑展示）。 */
function pickAddress(addresses, type) {
  for (const addr of asArray(addresses)) {
    if (addr?.type === type) return asString(addr?.address);
  }
  return '';
}

/**
 * 节点归一化。
 * @param {unknown} items kube-apiserver `items` 数组
 * @returns {{name:string,ready:boolean,roles:string[],version:string,os:string,arch:string,
 *   internalIP:string,cpu:string,memory:string,pods:string,created:string,
 *   allocatable:Record<string,string>,
 *   conditions:{type:string,status:string,reason?:string,message?:string}[]}[]}
 */
export function normalizeNodes(items) {
  return asArray(items).map((node) => {
    const metadata = node?.metadata ?? {};
    const status = node?.status ?? {};
    const info = status.nodeInfo ?? {};
    const capacity = status.capacity ?? {};
    const conditions = normalizeConditions(status.conditions);

    return {
      name: asString(metadata.name),
      ready: conditions.some((c) => c.type === 'Ready' && c.status === 'True'),
      roles: deriveRoles(metadata.labels),
      version: asString(info.kubeletVersion),
      // 优先 osImage（发行版镜像名），退回 operatingSystem
      os: asString(info.osImage) || asString(info.operatingSystem),
      arch: asString(info.architecture),
      internalIP: pickAddress(status.addresses, 'InternalIP'),
      // capacity 全部保留原文（"16982428Ki" 这类不能转数字，会丢精度/单位）
      cpu: asString(capacity.cpu),
      memory: asString(capacity.memory),
      pods: asString(capacity.pods),
      created: asString(metadata.creationTimestamp),
      // 扩展资源（含 HAMi 的 nvidia.com/*）原样透传：上面四个是固定列，
      // 而 GPU 这类资源名由设备插件决定，不能写死字段，只能整块带出去
      allocatable: asStringMap(status.allocatable),
      conditions,
    };
  });
}

/** 容器状态三选一：running / waiting / terminated，实际存在者优先。 */
const CONTAINER_STATE_KEYS = ['running', 'waiting', 'terminated'];

/** 某个 terminated 是否算 OOM：reason 命中或退出码 137（SIGKILL）。 */
function isOomTerminated(terminated) {
  if (!terminated || typeof terminated !== 'object') return false;
  return terminated.reason === 'OOMKilled' || Number(terminated.exitCode) === 137;
}

/** 单容器 OOM：当前状态或上一次状态命中即可。 */
function isOomContainer(status) {
  return isOomTerminated(status?.state?.terminated) || isOomTerminated(status?.lastState?.terminated);
}

/** 容器状态名 + 可选 reason（waiting.reason 优先，其次 terminated.reason）。 */
function resolveContainerState(state) {
  const bag = state && typeof state === 'object' ? state : {};
  for (const key of CONTAINER_STATE_KEYS) {
    const detail = bag[key];
    if (detail && typeof detail === 'object') {
      const reason = optionalString(detail.reason);
      return reason === undefined ? { state: key } : { state: key, reason };
    }
  }
  // 状态还没回填（刚调度的 Pod）时状态为空，用 unknown 而不是空串，UI 好判断
  return { state: 'unknown' };
}

/**
 * Pod 归一化。
 * @param {unknown} items
 * @returns {{namespace:string,name:string,phase:string,ready:string,restarts:number,node:string,
 *   ip:string,created:string,annotations:Record<string,string>,oom:boolean,crashLoop:boolean,
 *   containers:{name:string,ready:boolean,restarts:number,state:string,reason?:string}[]}[]}
 */
export function normalizePods(items) {
  return asArray(items).map((pod) => {
    const metadata = pod?.metadata ?? {};
    const spec = pod?.spec ?? {};
    const status = pod?.status ?? {};
    const specContainers = asArray(spec.containers);
    const statuses = asArray(status.containerStatuses);

    let readyCount = 0;
    let restarts = 0;
    let oom = false;
    let crashLoop = false;

    const containers = statuses.map((cs, index) => {
      const name = asString(cs?.name) || asString(specContainers[index]?.name);
      const isReady = cs?.ready === true;
      const restartCount = asNumber(cs?.restartCount);

      if (isReady) readyCount += 1;
      restarts += restartCount;
      if (isOomContainer(cs)) oom = true;
      if (cs?.state?.waiting?.reason === 'CrashLoopBackOff') crashLoop = true;

      return {
        name,
        ready: isReady,
        restarts: restartCount,
        ...resolveContainerState(cs?.state),
      };
    });

    // 总容器数以 spec 为准；status 还没回填时退回 containerStatuses 长度
    const total = specContainers.length || statuses.length;

    return {
      namespace: asString(metadata.namespace),
      name: asString(metadata.name),
      phase: asString(status.phase) || 'Unknown',
      ready: `${readyCount}/${total}`,
      restarts,
      node: asString(spec.nodeName),
      ip: asString(status.podIP),
      created: asString(metadata.creationTimestamp),
      // HAMi 的 vGPU 分配全在注解里（hami.io/vgpu-*），不透传就解析不到；
      // 只丢体积巨大的 last-applied-configuration，其余原样带出去
      annotations: asStringMap(metadata.annotations, BULKY_ANNOTATION),
      oom,
      crashLoop,
      containers,
    };
  });
}

/** 每种工作负载的字段映射（desired/ready/upToDate/available 四元组）。 */
const WORKLOAD_FIELDS = {
  Deployment: {
    desired: 'replicas',
    ready: 'readyReplicas',
    upToDate: 'updatedReplicas',
    available: 'availableReplicas',
  },
  StatefulSet: {
    desired: 'replicas',
    ready: 'readyReplicas',
    upToDate: 'currentReplicas',
    available: 'availableReplicas',
  },
  DaemonSet: {
    desired: 'desiredNumberScheduled',
    ready: 'numberReady',
    upToDate: 'updatedNumberScheduled',
    available: 'numberAvailable',
  },
};

/** kind 规范化：忽略大小写，未知 kind 原样保留（不抛错）。 */
function canonicalKind(kind) {
  const raw = asString(kind).trim();
  for (const known of Object.keys(WORKLOAD_FIELDS)) {
    if (known.toLowerCase() === raw.toLowerCase()) return known;
  }
  return raw;
}

/**
 * 工作负载归一化。未知 kind 走 Deployment 的字段映射（保守兜底，不抛错）。
 * @param {'Deployment'|'StatefulSet'|'DaemonSet'|string} kind
 * @param {unknown} items
 * @returns {{namespace:string,name:string,kind:string,desired:number,ready:number,
 *   upToDate:number,available:number,created:string}[]}
 */
export function normalizeWorkloads(kind, items) {
  // 容忍大小写差异（'deployment' / 'daemonset'），输出统一成契约里的大驼峰
  const canonical = canonicalKind(kind);
  const fields = WORKLOAD_FIELDS[canonical] ?? WORKLOAD_FIELDS.Deployment;

  return asArray(items).map((workload) => {
    const metadata = workload?.metadata ?? {};
    const status = workload?.status ?? {};

    return {
      namespace: asString(metadata.namespace),
      name: asString(metadata.name),
      kind: canonical,
      desired: asNumber(status[fields.desired]),
      ready: asNumber(status[fields.ready]),
      upToDate: asNumber(status[fields.upToDate]),
      available: asNumber(status[fields.available]),
      created: asString(metadata.creationTimestamp),
    };
  });
}

/** 事件时间：lastTimestamp → eventTime → firstTimestamp。 */
function eventLastSeen(event) {
  return asString(event?.lastTimestamp) || asString(event?.eventTime) || asString(event?.firstTimestamp);
}

/** 时间字符串 → 毫秒；解析失败返回 NaN（排到最后）。 */
function parseTime(value) {
  if (!value) return Number.NaN;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : Number.NaN;
}

/**
 * 事件归一化，按 lastSeen 倒序（最新在前）。
 * @param {unknown} items
 * @returns {{namespace:string,type:string,reason:string,object:string,message:string,
 *   count:number,lastSeen:string}[]}
 */
export function normalizeEvents(items) {
  const events = asArray(items).map((event) => {
    const involved = event?.involvedObject ?? {};
    const metadata = event?.metadata ?? {};

    // object 统一成 "Kind/namespace/name"，方便 UI 一键定位
    const objectKind = asString(involved.kind);
    const objectNamespace = asString(involved.namespace);
    const objectName = asString(involved.name);
    const object = [objectKind, objectNamespace, objectName].filter(Boolean).join('/');

    const rawCount = asNumber(event?.count);
    const count = rawCount > 0 ? Math.trunc(rawCount) : 1;

    return {
      namespace: asString(metadata.namespace) || objectNamespace,
      // 没填 type 的事件按 Normal 处理（Warning 统计才不会被误算）
      type: asString(event?.type) || 'Normal',
      reason: asString(event?.reason),
      object,
      message: asString(event?.message),
      count,
      lastSeen: eventLastSeen(event),
    };
  });

  return events.sort((a, b) => {
    const ta = parseTime(a.lastSeen);
    const tb = parseTime(b.lastSeen);
    const aValid = !Number.isNaN(ta);
    const bValid = !Number.isNaN(tb);
    if (aValid && bValid) return tb - ta;
    if (aValid) return -1; // 有时间的排前面
    if (bValid) return 1;
    return 0; // 都没时间：保持输入顺序（sort 在现代 V8 上是稳定的）
  });
}

/**
 * 概览汇总。
 * @param {{nodes?:unknown,pods?:unknown,workloads?:unknown,events?:unknown}|undefined} parts
 * @returns {{nodes:number,nodesReady:number,pods:number,podsRunning:number,
 *   podsUnhealthy:number,workloads:number,workloadsUnready:number,warningEvents:number}}
 */
export function summarize(parts) {
  const { nodes, pods, workloads, events } = parts ?? {};
  const nodeList = asArray(nodes);
  const podList = asArray(pods);
  const workloadList = asArray(workloads);
  const eventList = asArray(events);

  return {
    nodes: nodeList.length,
    nodesReady: nodeList.filter((n) => n?.ready === true).length,
    pods: podList.length,
    podsRunning: podList.filter((p) => p?.phase === 'Running').length,
    // 按 Pod 去重计数：一个 Pod 同时 OOM + Pending 只算 1
    podsUnhealthy: podList.filter(
      (p) => (p?.phase !== 'Running' && p?.phase !== 'Succeeded') || p?.oom === true || p?.crashLoop === true,
    ).length,
    workloads: workloadList.length,
    workloadsUnready: workloadList.filter((w) => asNumber(w?.ready) < asNumber(w?.desired)).length,
    warningEvents: eventList.filter((e) => e?.type === 'Warning').length,
  };
}
