/**
 * Docker 页面共享类型。
 *
 * 从 pages/Docker.tsx 原样搬出（字段一个没动），拆分后父页面与各子区块
 * 共用同一份定义，避免出现两套「看起来一样」的 interface 漂移。
 */

export interface ContainerInfo {
  id: string;
  shortId: string;
  names: string[];
  image: string;
  command: string;
  created: string;
  state: string;
  status: string;
  exitCode?: number | null;
  exitType?: 'normal' | 'oom' | 'segfault' | 'terminated' | 'error' | null;
  ports: any[];
  labels: any;
}

export interface ContainerSource {
  sourceId: string;
  sourceName: string;
  host?: string;
  containers: ContainerInfo[];
  error?: string;
}

/** 一条链路证据：为什么认为这两台容器有上下游关系 */
export interface LinkEvidence {
  kind: 'compose_depends_on' | 'docker_link' | 'env_alias' | 'env_published_port' | 'env_container_ip' | string;
  confidence: 'high' | 'medium' | string;
  /** 人能读的一句话，例如「OPENLOG_DATABASE_URL 指向 127.0.0.1:5432，该端口由它发布」 */
  detail: string;
  value: string;
}

export interface LinkedContainer {
  id: string;
  names?: string[];
  shortId?: string;
  image?: string;
  state?: string;
  status?: string;
  direction: 'upstream' | 'downstream';
  confidence: 'high' | 'medium' | string;
  evidence: LinkEvidence;
  allEvidence?: LinkEvidence[];
  recentLogs?: string[];
  keyEvents?: Array<{ type?: string; text?: string }>;
  sharedNetworks?: string[];
}

export interface TraceResult {
  target: any;
  upstream: LinkedContainer[];
  downstream: LinkedContainer[];
  networkPeers: LinkedContainer[];
  serviceName: string;
  totalUpstream?: number;
  totalDownstream?: number;
  totalPeers?: number;
  /** 同网但已退出的容器数：解释「这台机器上还躺着一堆旧容器」，不算活着邻居 */
  stoppedPeerCount?: number;
  /** 参与推断的容器数（inspect 成功的） */
  inspected?: number;
  /** 推断过程中的降级说明，例如「N 台容器 inspect 失败」 */
  unavailable?: string[];
}

/** 容器 + 所属源。父页面 flatMap 时附加 `_sourceId` / `_sourceName`。 */
export type ContainerRowItem = ContainerInfo & {
  _sourceId: string;
  _sourceName: string;
};

export interface LiveLogLine {
  timestamp: string;
  line: string;
  level: string;
  content: string;
}

export interface TermLine { cmd: string; output: string; time: number; }
