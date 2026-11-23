/**
 * Kubernetes 页面本地类型。
 *
 * 为什么在这里定义而不是 client/src/types.ts：那个文件由接线 agent（A8）统一维护，
 * 并行开发期两边同时改会产生冲突。这里逐字照抄 `/tmp/k8s-contract.md` 的「数据契约」，
 * 字段名一个都不改 —— 契约是前后端共用的事实来源，本地副本只是编译期形状。
 *
 * 契约里没有、但列表/抽屉需要的响应包装类型也一并放在这里（都是服务端的实时返回值）。
 */

/** 服务端返回的集群摘要（不含 kubeconfig 明文）。 */
export interface K8sClusterView {
  id: string;
  name: string;
  context: string;
  server: string;
  enabled: boolean;
  authType: 'cert' | 'token';
  hasKubeconfig: boolean;
  updatedAt?: string;
}

/**
 * POST / PUT /api/k8s/clusters 的请求体。
 * kubeconfig 在 PUT 时可以省略（契约：省略则沿用旧值），因此这里是可选的。
 */
export interface K8sClusterInput {
  name: string;
  kubeconfig?: string;
  context?: string;
}

/** 节点 condition（Ready / MemoryPressure / DiskPressure …）。 */
export interface K8sNodeCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

/** 节点。cpu / memory / pods 是 capacity 原文（如 "4"、"8123456Ki"、"110"）。 */
export interface K8sNode {
  name: string;
  ready: boolean;
  roles: string[];
  version: string;
  os: string;
  arch: string;
  internalIP: string;
  cpu: string;
  memory: string;
  pods: string;
  created: string;
  conditions: K8sNodeCondition[];
}

/** Pod 内单个容器状态。 */
export interface K8sContainer {
  name: string;
  ready: boolean;
  restarts: number;
  state: string;
  reason?: string;
}

/**
 * HAMi vGPU：单张卡上的分配（`hami.io/vgpu-devices-allocated` 里的一段）。
 * memMiB 是 MiB，cores 是算力点（100 = 整卡）。
 *
 * `type` 只有四段注解（真机格式 `<uuid>,<deviceType>,<memMiB>,<cores>`）才有；
 * 旧的三段/两段格式没有型号，此时**不要**渲染型号段（不是「未知」，是「没写」）。
 */
export interface K8sGpuDevice {
  id: string;
  memMiB: number;
  cores: number;
  /** 设备类型（真机里常是 `NVIDIA`；没有就是没有） */
  type?: string;
}

/**
 * 节点的**物理卡**（真机来自 `hami.io/node-nvidia-register` 的 JSON 数组）。
 *
 * 为什么需要它：HAMi 把一张卡切成多份，"4 张卡"其实可能是「2 张物理卡 × 10 槽位」，
 * 容量与型号只能从这个注解读到（节点上没有 `nvidia.com/gpumem|gpucores`）。
 * 服务端旧版本没有这个字段 → `devices` 缺席，前端退回按节点聚合的老展示。
 */
export interface K8sGpuNodeDevice {
  id: string;
  /** 型号名（如 `NVIDIA GeForce RTX 4090`）；缺失时只显示短 id */
  type?: string;
  /** 该卡显存（MiB） */
  memMiB: number;
  /** 该卡算力点（100 = 整卡） */
  cores: number;
  /** 该卡被切成多少个 vGPU 槽位（register 里的 count）；旧服务端没有 */
  slots?: number;
  allocatedMemMiB: number;
  allocatedCores: number;
  podCount: number;
  /** register 里的健康标记；缺失当作健康 */
  health?: boolean;
}

/**
 * Pod 上的 vGPU 分配摘要（契约里的 readPodVgpu）。
 * 没有 HAMi / 没有分配到卡时 hasVgpu=false，其余字段是空值 —— 表格显示「—」。
 */
export interface K8sPodVgpu {
  hasVgpu: boolean;
  devices: K8sGpuDevice[];
  totalMemMiB: number;
  totalCores: number;
  nodeName: string | null;
}

/** 单个节点的 GPU 容量与已分配（契约里的 summarizeVgpu().nodes[]）。 */
export interface K8sGpuNode {
  name: string;
  /**
   * 该节点 GPU 数。真机格式下是**物理卡数**（register 的条数）；
   * 只有 `nvidia.com/gpu` 的老集群里它等于 vGPU 槽位数。
   */
  count: number;
  /** 显存总量（MiB，真机 = Σdevmem） */
  memMiB: number;
  /** 算力总量（算力点，真机 = Σdevcore） */
  cores: number;
  allocatedMemMiB: number;
  allocatedCores: number;
  podCount: number;
  /**
   * 物理卡明细。**旧服务端没有这个字段**（只有 nvidia.com/gpu 时服务端给空数组/不写），
   * 前端据此决定「按物理卡分行」还是「按节点聚合」——字段存在才渲染。
   */
  devices?: K8sGpuNodeDevice[];
}

/** 有 vGPU 分配的 Pod（契约里的 summarizeVgpu().pods[]）。 */
export interface K8sGpuPod {
  namespace: string;
  name: string;
  nodeName: string | null;
  devices: K8sGpuDevice[];
  totalMemMiB: number;
  totalCores: number;
  /** Pod phase（Running / Pending …），用于给行标色 */
  phase: string;
}

/** GPU 段的总计。 */
export interface K8sGpuTotals {
  gpuCount: number;
  memMiB: number;
  cores: number;
  allocatedMemMiB: number;
  allocatedCores: number;
  podCount: number;
  /**
   * 物理卡数（真机 = Σ 节点 register 的条数）。**旧服务端没有**：
   * 缺失时表头退回「N 张卡」，不会显示成「NaN 张物理卡」。
   */
  physicalCount?: number;
  /** vGPU 槽位数（真机 = Σ 每卡 count）。旧服务端没有。 */
  slots?: number;
}

/**
 * `GET /api/k8s/clusters/:id/overview` 的 `gpu` 段。
 *
 * **无 HAMi 的集群也会返回这一段**，只是 `hasHami === false` 且数据全空 ——
 * 前端据此决定「GPU 分配」卡片与 Pod 表的 vGPU 列要不要渲染（渲染条件只看 hasHami）。
 */
export interface K8sGpuOverview {
  hasHami: boolean;
  nodes: K8sGpuNode[];
  pods: K8sGpuPod[];
  totals: K8sGpuTotals;
  /** 解析失败/异常注解的说明（服务端最多给 5 条） */
  warnings?: string[];
}

/** Pod。ready 形如 "1/1"；restarts 是各容器 restartCount 之和。 */
export interface K8sPod {
  namespace: string;
  name: string;
  phase: string;
  ready: string;
  restarts: number;
  node: string;
  ip: string;
  created: string;
  oom: boolean;
  crashLoop: boolean;
  containers: K8sContainer[];
  /**
   * HAMi vGPU 分配。只有集群里存在 HAMi（overview.gpu.hasHami）时才由服务端下发；
   * 没有这个字段 = 集群没有 HAMi（表格不出现 vGPU 列）。
   */
  vgpu?: K8sPodVgpu | null;
}

/** 工作负载种类。 */
export type K8sWorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';

/** 工作负载（副本数）。 */
export interface K8sWorkload {
  namespace: string;
  name: string;
  kind: K8sWorkloadKind;
  desired: number;
  ready: number;
  upToDate: number;
  available: number;
  created: string;
}

/** 事件。 */
export interface K8sEvent {
  namespace: string;
  type: string;
  reason: string;
  object: string;
  message: string;
  count: number;
  lastSeen: string;
}

/** 概览里的集群元信息。 */
export interface K8sClusterInfo {
  version: string;
  server: string;
  context: string;
}

/** 概览统计。 */
export interface K8sSummary {
  nodes: number;
  nodesReady: number;
  pods: number;
  podsRunning: number;
  podsUnhealthy: number;
  workloads: number;
  workloadsUnready: number;
  warningEvents: number;
}

/** GET /api/k8s/clusters/:id/overview 的完整响应。 */
export interface K8sOverview {
  cluster: K8sClusterInfo;
  nodes: K8sNode[];
  pods: K8sPod[];
  workloads: K8sWorkload[];
  events: K8sEvent[];
  summary: K8sSummary;
  /**
   * HAMi vGPU 段。无 HAMi 的集群也有这一段（hasHami:false + 空数据），
   * 页面只在 hasHami === true 时渲染「GPU 分配」卡片。
   * 可选是因为演示/旧版服务端可能完全没有这个字段（ensureOverview 会兜成空段）。
   */
  gpu?: K8sGpuOverview | null;
}

/** GET /api/k8s/clusters */
export interface K8sClusterListResponse {
  clusters?: K8sClusterView[];
}

/** POST /api/k8s/clusters/:id/test */
export interface K8sTestResponse {
  ok?: boolean;
  version?: string;
  nodes?: number;
  error?: string;
}

/** GET /api/k8s/clusters/:id/pods */
export interface K8sPodsResponse {
  pods?: K8sPod[];
}

/** GET /api/k8s/clusters/:id/events */
export interface K8sEventsResponse {
  events?: K8sEvent[];
}

/** GET /api/k8s/clusters/:id/pods/:namespace/:pod/logs */
export interface K8sLogsResponse {
  logs?: string;
}

/** 日志抽屉的目标 Pod。 */
export interface K8sLogTarget {
  namespace: string;
  pod: string;
}

/** 集群列表里的「测试连接」结果（页面持有，避免每次重渲染丢状态）。 */
export interface K8sTestState {
  ok: boolean;
  text: string;
}

/** DELETE /api/k8s/clusters/:id */
export interface K8sOkResponse {
  ok?: boolean;
}
