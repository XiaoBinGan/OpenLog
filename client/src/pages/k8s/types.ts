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
  /**
   * 归属工作负载（服务端能确定时才下发，与 k8s 的 ownerReferences.kind 同形）。
   *
   * 注意：Pod 的直接 owner 通常是 ReplicaSet（`deploy-<hash>`），从 RS 名反推
   * Deployment 名并不可靠，所以服务端只在能确定时给这一对字段。**没有就是没有**，
   * 前端不猜 —— 缺省时 Pod 操作列只有「删除」（独立 Pod 本来也没有可重启的工作负载）。
   */
  ownerKind?: K8sWorkloadKind | null;
  ownerName?: string | null;
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

/* ============================================================
 * HAMi 使用率实际值（GET /api/k8s/clusters/:id/usage）
 *
 * 这一段的字段全部来自「集群里真的能读到什么」：节点侧读
 * hami.io/node-nvidia-register 拿型号/容量/槽位，调度器侧读
 * hami_container_device_utilization_ratio 之类指标拿实际用量。
 * 指标抓不到（没部署 vgpu-monitor / /metrics 不可达）时整段
 * available:false + reason，页面显示原因而不是一排 0。
 * ============================================================ */

/** 一张物理卡：分配值（来自节点注解）+ 实际值（来自调度器指标）。 */
export interface K8sUsageDevice {
  /** 物理卡 UUID（与 overview 里 vGPU 设备的 id 同源，可直接对应）。 */
  uuid: string;
  /** 型号，例如 NVIDIA-GeForce-RTX-4090；读不到是空串。 */
  type: string;
  /** 已分配给 Pod 的显存（MiB）。 */
  allocMemMiB: number;
  /** 已分配的算力（百分比，0..100 的整数或小数）。 */
  allocCores: number;
  /** 实际用掉的显存（MiB）；没采到是 0，必须配合 measured 一起看。 */
  usedMemMiB: number;
  /** 实际利用率（百分之数值，0..100，**不是** 0..1 的比例）。 */
  utilPercent: number;
  /**
   * 这条卡到底有没有采到实测数据。
   * `0%` 与「没采到」在面板上是两件事，不能只靠数值区分。
   */
  measured?: boolean;
  /** 占用这张卡的 Pod 名（`ns/name` 形式）。 */
  pods: string[];
  /**
   * 卡的总显存（MiB）。面板要拿它算「已分配 / 总量」和「实测 / 总量」两条比例；
   * 服务端目前只下发分配与实测的绝对值，这两个字段缺席时面板按「—」渲染。
   */
  totalMemMiB?: number | null;
  /** 同上，历史命名（面板两种都接受）。 */
  memMiB?: number | null;
}

/** 一个节点上的全部物理卡。 */
export interface K8sUsageNode {
  name: string;
  devices: K8sUsageDevice[];
}

/** GET /api/k8s/clusters/:id/usage */
export interface K8sUsageResponse {
  /** 指标是否真的抓到了（false 时 nodes 可能为空/只有分配值）。 */
  available: boolean;
  /** 本次抓取时间（ISO 字符串）。 */
  scrapedAt: string | null;
  nodes: K8sUsageNode[];
  /** available:false 的原因；available:true 时通常没有。 */
  reason?: string;
  /** 演示模式标记（fixture 数据，不来自真集群）。 */
  demo?: boolean;
}

/* ============================================================
 * 调度策略与超卖（GET /api/k8s/clusters/:id/policy）
 *
 * 形状以服务端实际下发为准：三个值是**平铺的标量**（不是 {value,source} 对象），
 * 来源只有一个共用的字符串 `source`；读不到就是 null + source:'default'（配 defaults/note）
 * 或 source:'unknown'（配 reason）。页面据此显示「默认值」或「未知」，
 * 绝不在前端猜 —— 拿默认值当实测值是这类卡片最容易犯的错。
 * ============================================================ */

/** 调度策略值：null = 服务端没读到（面板显示「—」，source 会说明原因）。 */
export type K8sSchedulerPolicyValue = 'binpack' | 'spread' | null;

/** 这一组值的来源。三行共用同一个 source。 */
export type K8sPolicySource = 'args' | 'configmap' | 'default' | 'unknown';

/** `raw` 里的一条生效参数（`--node-scheduler-policy=spread` → key/value）。 */
export interface K8sPolicyRawEntry {
  key: string;
  value: string;
}

/** HAMi 的默认基线：读不到配置时面板展示它，并明确标成「默认值」。 */
export interface K8sPolicyDefaults {
  nodeSchedulerPolicy: 'binpack' | 'spread';
  deviceSchedulerPolicy: 'binpack' | 'spread';
  overcommit: boolean;
}

/** GET /api/k8s/clusters/:id/policy */
export interface K8sPolicyResponse {
  nodeSchedulerPolicy: K8sSchedulerPolicyValue;
  deviceSchedulerPolicy: K8sSchedulerPolicyValue;
  /** 显存超卖：true = 开启（HAMi 默认开），false = 关闭，null = 没读到。 */
  overcommit: boolean | null;
  /** 资源策略（不在这张三行卡片里，保留给后续展示）。 */
  resourceStrategy?: string | null;
  source: K8sPolicySource;
  raw: K8sPolicyRawEntry[];
  defaults: K8sPolicyDefaults;
  /** source:'default' / 'unknown' 时的说明文案（「为什么是 binpack」）。 */
  note?: string;
  /** source:'unknown' 时的失败原因。 */
  reason?: string;
  /** 演示模式标记（fixture 数据，不来自真集群）。 */
  demo?: boolean;
}

/* ============================================================
 * Pod 写操作（POST .../scale|restart、DELETE .../pods/:ns/:name）
 *
 * 写操作默认关闭（OPENLOG_K8S_WRITE=1 才生效），未开启时服务端一律 403，
 * 演示模式下 409 —— 前端据此把按钮锁成「只读」而报错。
 * ============================================================ */

/** Pod 所属工作负载的引用 —— 只有 Deployment / StatefulSet 才有「重启」「扩缩容」语义。 */
export interface K8sPodWorkloadRef {
  /** 与写操作路由的 `:kind` 段一致（小写复数）。 */
  kind: 'deployments' | 'statefulsets';
  name: string;
}

/** 写操作成功响应；失败时是 403/409 + { error, readOnly? }。 */
export interface K8sPodOpResponse {
  ok?: boolean;
  /** 审计记录 id（服务端落库后返回，便于事后追溯这次操作）。 */
  auditId?: string;
  error?: string;
  /** true = 服务端处于只读（没开 OPENLOG_K8S_WRITE=1）。 */
  readOnly?: boolean;
}
