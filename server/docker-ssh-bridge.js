import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { errorMessage } from './errors.js';
import { ensureSshConnection } from './remote.js';

/**
 * Docker-over-SSH 桥接层。
 *
 * 把远端 docker.sock 通过一条**已建立的 SSH 连接**桥成本地 socket，
 * dockerode 直接连这个本地 socket —— 对 dockerode 完全透明，因此现有
 * 24 条路由、事件监听、日志巡检一行都不用改。
 *
 * 为什么需要它：远端要暴露 2375 才能被裸 TCP 连接，而 2375 是**无鉴权**的
 * Docker API（等价 root），且开启它要重启 dockerd → 所有容器重启。
 * SSH 通道不需要远端改任何配置、不新增端口。
 *
 * 生命周期规则：
 *  - 桥**不自己管理 SSH 连接**，只搭 remote.js 连接池的便车
 *    （node-ssh 的 forwardOutStreamLocal）。断连/重连逻辑只有一份。
 *  - SSH 连接断开后旧桥自动失效，下次使用时惰性重建。
 *  - POSIX：本地 socket 放在 mkdtemp 私有目录并 chmod 600，防止本机其它进程
 *    通过它拿到 Docker 控制权（那等价 root）。
 *  - Windows：Node 不支持监听文件系统 unix socket（EACCES），改用命名管道
 *    `\\.\pipe\...`；管道名带「用户名+进程号」作用域，默认 ACL 仅当前用户与
 *    管理员可连。
 */

export const DEFAULT_REMOTE_DOCKER_SOCKET = '/var/run/docker.sock';

/**
 * Windows 上 Node 的 net 服务器**不能**监听文件系统里的 unix socket 路径
 * （listen 直接 EACCES），只能用命名管道 `\\.\pipe\...`。dockerode 只把
 * socketPath 透传给 http.request，命名管道同样可用，所以桥对上层透明。
 */
const IS_WIN = process.platform === 'win32';

/** 桥的本地 socket 目录：0700 私有目录，进程退出即随系统清理（仅 POSIX） */
const BRIDGE_DIR = IS_WIN ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'openlog-docker-bridge-'));

/** key: `${serverId}::${remoteSocketPath}` → handle */
const bridges = new Map();

/**
 * 单飞：同一 key 的并发建桥请求共享同一次构建。
 * buildBridge 在 listen 之后才注册进 bridges，若不加这层，两个并发调用
 * （例如设置保存触发的事件监听器建桥 + 用户测试连接建桥）会同时
 * listen 同一个 socket 路径 → EADDRINUSE。
 */
const building = new Map(); // key → Promise<localSocketPath>

/** 诊断计数（测试与排查用） */
export const bridgeStats = { built: 0, reused: 0, channelsOpened: 0, channelFailures: 0, closed: 0 };

function bridgeKey(serverId, remoteSocketPath) {
  return `${serverId}::${remoteSocketPath}`;
}

function makeLocalSocketPath(serverId, remoteSocketPath) {
  const hash = crypto.createHash('sha1').update(remoteSocketPath).digest('hex').slice(0, 8);
  const safeId = String(serverId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'srv';
  if (IS_WIN) {
    // 命名管道在整个登录会话内全局可见，用「用户名 + pid」隔离不同用户/实例，
    // 避免两台 OpenLog 或两个用户共用同一个管道名互相抢连接。
    const scope = crypto.createHash('sha1')
      .update(`${os.userInfo().username}::${process.pid}`)
      .digest('hex').slice(0, 8);
    return `\\\\.\\pipe\\openlog-docker-${safeId.slice(0, 16)}-${hash}-${scope}`;
  }
  return path.join(BRIDGE_DIR, `${safeId}-${hash}.sock`);
}

/**
 * 把「打开 channel 失败」翻译成分层的、可操作的信息。
 *
 * 裸 ssh2 的错误（如 `(SSH) Channel open failure: open failed`）对使用者
 * 毫无指向性 —— 它既可能是 dockerd 没跑，也可能是 socket 路径写错，还可能
 * 是远端 sshd 太老不支持 streamlocal 转发。这里按原因分开说。
 */
export function describeChannelFailure(err, remoteSocketPath) {
  const msg = errorMessage(err);
  if (/unknown channel type|administratively prohibited|not supported/i.test(msg)) {
    return `远端 SSH 服务器不支持 direct-streamlocal 转发（需要 OpenSSH 6.7+）：${msg}`;
  }
  if (/channel open failure|open failed|no such file|connect failed/i.test(msg)) {
    return `无法连接远端 ${remoteSocketPath}：${msg}（远端 dockerd 是否在运行？socket 路径是否正确？）`;
  }
  return `Docker SSH 通道错误：${msg}`;
}

/**
 * 确保 (服务器, 远端socket) 的桥存在，返回本地 socket 路径。
 * 幂等：底层 SSH 连接仍是同一个活跃连接时直接复用。
 */
export async function ensureDockerBridge(serverId, remoteSocketPath = DEFAULT_REMOTE_DOCKER_SOCKET) {
  const key = bridgeKey(serverId, remoteSocketPath);
  const existing = bridges.get(key);
  if (existing && !existing.closed && existing.ssh && existing.ssh.isConnected()) {
    bridgeStats.reused++;
    return existing.localSocketPath;
  }
  if (existing) await closeDockerBridge(serverId, remoteSocketPath);

  // 并发保护：同 key 的建桥请求共享同一次构建（见 building 注释）
  const inFlight = building.get(key);
  if (inFlight) return inFlight;
  const p = buildBridge(key, serverId, remoteSocketPath)
    .finally(() => building.delete(key));
  building.set(key, p);
  return p;
}

async function buildBridge(key, serverId, remoteSocketPath) {
  let ssh;
  try {
    ssh = await ensureSshConnection(serverId);
  } catch (err) {
    // 分层：这一层是 SSH 本身不通，与 docker 无关
    throw new Error(`SSH 层：无法建立到服务器 ${serverId} 的连接：${errorMessage(err)}`);
  }

  const localSocketPath = makeLocalSocketPath(serverId, remoteSocketPath);
  // 命名管道不是文件：unlink 会 ENOENT（已被 catch），这里显式跳过更清晰
  if (!IS_WIN) { try { fs.unlinkSync(localSocketPath); } catch { /* 不存在即可 */ } }

  const channels = new Set();

  const server = net.createServer((local) => {
    // 每个 docker HTTP 连接 = 一条 SSH channel。
    // channel 打开失败只影响这一个请求，桥本身保持存活。
    ssh.forwardOutStreamLocal(remoteSocketPath).then((channel) => {
      bridgeStats.channelsOpened++;
      channels.add(channel);
      local.pipe(channel).pipe(local);
      const dropLocal = () => { try { local.destroy(); } catch { /* 已销毁 */ } };
      channel.on('error', dropLocal);
      channel.on('close', () => { channels.delete(channel); dropLocal(); });
      local.on('error', () => { try { channel.destroy(); } catch { /* 已销毁 */ } });
      local.on('close', () => { try { channel.destroy(); } catch { /* 已销毁 */ } });
    }).catch((err) => {
      bridgeStats.channelFailures++;
      console.warn(`[DockerBridge] ${serverId} 通道打开失败:`, describeChannelFailure(err, remoteSocketPath));
      local.destroy();
    });
  });

  const handle = {
    key, serverId, remoteSocketPath, localSocketPath, server, channels, ssh, closed: false,
  };

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(localSocketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // 本机其它用户不得通过这个 socket 访问 Docker（等价 root）
  // 命名管道无法 chmod：默认 ACL 只授予当前用户与管理员，等价效果见 README 说明
  if (!IS_WIN) { try { fs.chmodSync(localSocketPath, 0o600); } catch { /* 失败不致命，下面会验证 */ } }

  // 建桥时先探一次：把「dockerd 没跑 / 路径错 / sshd 不支持转发」在**第一次使用**
  // 就变成清晰报错，而不是让首个 docker 请求挂到超时。
  try {
    const probe = await ssh.forwardOutStreamLocal(remoteSocketPath);
    probe.end();
  } catch (err) {
    await teardown(handle);
    throw new Error(describeChannelFailure(err, remoteSocketPath));
  }

  // SSH 连接失效时自动关桥（下次使用惰性重建）
  const onSshGone = () => { void teardown(handle); };
  try {
    const conn = ssh.getConnection();
    if (conn) {
      conn.once('close', onSshGone);
      conn.once('end', onSshGone);
      conn.once('error', onSshGone);
    }
  } catch { /* ssh 已断开，无需挂监听 */ }

  bridges.set(key, handle);
  bridgeStats.built++;
  return localSocketPath;
}

/** 内部拆除：关本地 server、销毁所有 channel、删 socket 文件 */
async function teardown(handle) {
  if (handle.closed) return;
  handle.closed = true;
  bridges.delete(handle.key);

  for (const ch of handle.channels) {
    try { ch.destroy(); } catch { /* 已销毁 */ }
  }
  handle.channels.clear();

  await new Promise((resolve) => handle.server.close(() => resolve()));
  // 命名管道随 server.close() 自动消失，没有文件需要删
  if (!IS_WIN) { try { fs.unlinkSync(handle.localSocketPath); } catch { /* 已删除 */ } }
  bridgeStats.closed++;

  // 桥没了，dockerode 实例缓存的连接可能仍指向旧路径。
  // 动态 import 避免 docker.js ↔ 本模块的静态循环依赖。
  try {
    const docker = await import('./docker.js');
    docker.clearDockerInstances();
  } catch { /* 模块尚未加载或已卸载，忽略 */ }
}

export async function closeDockerBridge(serverId, remoteSocketPath = DEFAULT_REMOTE_DOCKER_SOCKET) {
  const handle = bridges.get(bridgeKey(serverId, remoteSocketPath));
  if (handle) await teardown(handle);
}

export async function closeAllDockerBridges() {
  for (const handle of [...bridges.values()]) await teardown(handle);
}

/** 供 UI/排查：当前所有桥的状态快照（不含任何凭据） */
export function getBridgeStatus() {
  return [...bridges.values()].map((h) => ({
    serverId: h.serverId,
    remoteSocketPath: h.remoteSocketPath,
    localSocketPath: h.localSocketPath,
    activeChannels: h.channels.size,
    sshConnected: !!(h.ssh && h.ssh.isConnected()),
  }));
}

/** 仅供测试：目录路径与字典重置 */
export const _internals = { BRIDGE_DIR, bridges };
