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

export interface TraceResult {
  target: any;
  upstream: any[];
  downstream: any[];
  networkPeers: any[];
  serviceName: string;
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
