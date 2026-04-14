export interface Log {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'WARNING' | 'ERROR' | 'DEBUG' | 'TRACE' | 'FATAL';
  message: string;
  source?: string;
  metadata?: string;
}

// Remote server types
export interface RemoteServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  logPath: string;
  watchFiles: string;
  lastConnected: string | null;
  status: 'connected' | 'disconnected' | 'error';
}

export interface RemoteServerState extends RemoteServer {
  systemStats: Record<string, any> | null;
  files: RemoteFileList;
  selectedFile: string | null;
  fileContent: string;
  fileModified: boolean;
  logs: Log[];
  logsLoading: boolean;
  filesLoading: boolean;
  editingFilePath: string | null;
}

export interface RemoteServerConfig {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  logPath?: string;
  watchFiles?: string;
}

export interface RemoteFile {
  name: string;
  path: string;
  size: number;
  isLog: boolean;
  modified: string;
}

export interface RemoteDir {
  name: string;
  path: string;
}

export interface RemoteFileList {
  files: RemoteFile[];
  dirs: RemoteDir[];
  currentPath: string;
  error?: string;
}

export interface RemoteLogResult {
  logs: Log[];
  fileInfo?: {
    size: number;
    modified: string;
  };
  totalLines: number;
  error?: string;
}

export interface RemoteSearchResult {
  results: Array<{
    file: string;
    line: number;
    content: string;
  } & Log>;
  files: string[];
  total: number;
  error?: string;
}

export interface MonitorStats {
  cpu: {
    load: number;
    cores: number[];
  };
  memory: {
    used: number;
    total: number;
    free: number;
  };
  disk: {
    name: string;
    used: number;
    total: number;
    usePercent: number;
  }[];
  network: {
    iface: string;
    rx: number;
    tx: number;
  }[];
  processes: {
    pid: number;
    name: string;
    cpu: number;
    mem: number;
  }[];
}

export interface MonitorHistory {
  id: number;
  timestamp: string;
  cpu: number;
  memory: number;
  disk: number;
  network: number;
}

export interface WatchSource {
  id: string;
  name: string;
  path: string;
  pattern: string;
  enabled: boolean;
  autoAnalysis: boolean;
}

export interface DockerSource {
  id: string;
  name: string;
  /** TCP 模式：Docker Server 地址 */
  host: string;
  /** TCP 模式：端口，默认 2375 */
  port: number;
  /** TCP 模式：是否使用 TLS */
  tls: boolean;
  /** TLS 模式：CA 证书（base64） */
  ca?: string;
  /** TLS 模式：客户端证书（base64） */
  cert?: string;
  /** TLS 模式：客户端私钥（base64） */
  key?: string;
  /** ✅ macOS Docker Desktop 推荐：Unix Socket 路径（优先于 TCP） */
  socketPath?: string;
  enabled: boolean;
  autoAnalysis: boolean;
  projects: string[];
}

export interface Settings {
  openaiApiKey: string;
  openaiBaseUrl: string;
  model: string;
  logPath: string;
  watchFiles: string;
  refreshInterval: string;
  autoAnalysis: boolean;
  thinkingEnabled: boolean;
  watchSources: WatchSource[];
  dockerSources: DockerSource[];
}

export interface WebSocketMessage {
  type: 'log' | 'monitor' | 'ai_analysis' | 'docker_batch_analysis';
  data: any;
}
