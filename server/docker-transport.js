import { ensureDockerBridge, DEFAULT_REMOTE_DOCKER_SOCKET } from './docker-ssh-bridge.js';

/**
 * Docker 传输解析 —— 唯一的「docker 源 → dockerode 连接配置」入口。
 *
 * 之前这段逻辑在 index.js 和 routes/docker.js 里复制了 10+ 遍，任何一处漏改
 * 就会出现「某一个接口连不上」的诡异 bug。收敛到这里之后：
 *  - socket / tcp / ssh(via) 三种形态都在这里判定
 *  - 上层只要调 resolveDockerTransport(source)，不再各自拼字段
 *
 * 兼容性：
 *  - 传入已解析的 plain 配置（只有 socketPath 或 host/port 的对象）时幂等，
 *    原样返回 —— 所以 ping 这类「config 来自请求体」的调用点不受影响。
 *  - 传入 undefined → {} → getDocker 缺省 localhost:2375（与历史行为一致）。
 */

export const DEFAULT_DOCKER_PORT = 2375;

/** 源是否走「通过 SSH 服务器」模式 */
export function isSshDockerSource(source) {
  return !!source && !!source.via && !!source.via.serverId;
}

/** 传输形态（不建立任何连接，纯判断） */
export function transportKind(source) {
  if (isSshDockerSource(source)) return 'ssh';
  if (source && source.socketPath) return 'socket';
  return 'tcp';
}

/**
 * 解析 docker 源为 dockerode 能用的配置。
 * @param {object} source - docker 源（或已是解析结果的 plain 配置）
 * @returns {Promise<{socketPath?: string, host?: string, port?: number, tls?: boolean, ca?: string, cert?: string, key?: string}>}
 */
export async function resolveDockerTransport(source) {
  if (!source) return {};

  if (isSshDockerSource(source)) {
    const { serverId, socketPath: remoteSocketPath } = source.via;
    const localSocketPath = await ensureDockerBridge(serverId, remoteSocketPath || DEFAULT_REMOTE_DOCKER_SOCKET);
    return { socketPath: localSocketPath };
  }

  if (source.socketPath) {
    return { socketPath: source.socketPath };
  }

  return {
    host: source.host || 'localhost',
    port: source.port || DEFAULT_DOCKER_PORT,
    tls: source.tls,
    ca: source.ca,
    cert: source.cert,
    key: source.key,
  };
}

/**
 * 同步版解析：只处理 socket/tcp，SSH 源给出明确报错。
 * 用于「必须在同步代码里拿到配置」的场合；凡是 async 上下文一律用
 * resolveDockerTransport，避免 SSH 源在这里静默退化成 localhost:2375。
 */
export function resolveDockerTransportSync(source) {
  if (isSshDockerSource(source)) {
    throw new Error(`Docker 源「${source.name || source.id || ''}」走 SSH 桥，需要异步解析（resolveDockerTransport）`);
  }
  return {
    socketPath: source?.socketPath || undefined,
    host: source?.socketPath ? undefined : (source?.host || 'localhost'),
    port: source?.socketPath ? undefined : (source?.port || DEFAULT_DOCKER_PORT),
    tls: source?.tls,
    ca: source?.ca,
    cert: source?.cert,
    key: source?.key,
  };
}
