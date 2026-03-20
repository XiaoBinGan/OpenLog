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

export interface Settings {
  openaiApiKey: string;
  openaiBaseUrl: string;
  model: string;
  logPath: string;
  watchFiles: string;
  refreshInterval: string;
}

export interface WebSocketMessage {
  type: 'log' | 'monitor';
  data: any;
}
