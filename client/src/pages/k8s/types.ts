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
