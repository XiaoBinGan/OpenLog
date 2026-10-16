import { errorMessage } from './errors.js';

/**
 * 给已建立的 SSH 连接挂上 error 守卫。
 *
 * 不做这件事的后果：**任何一台远端服务器网络抖动，整个 OpenLog 进程就退出。**
 *
 * 根因在 node-ssh 里（`node_modules/node-ssh/lib/cjs/index.js:189`）：
 *
 *     connection.on('ready', () => {
 *       connection.removeListener('error', reject);   // ← 连接成功后，唯一的 error 监听者被移除
 *       resolve();
 *     });
 *
 * 于是 `ssh.connect()` resolve 之后，底层 ssh2 Client 上**一个 error 监听者都没有**。
 * 一旦那个 socket 出错（空闲读超时、连接被重置、对端重启），
 * `ssh2/lib/client.js:801` 的 socket error 分支会执行 `this.emit('error', err)`。
 * EventEmitter 对没有任何监听者的 'error' 事件是**直接 throw**，
 * 于是升级成 uncaughtException，被 `server/index.js` 的全局处理器接走并
 * `shutdown('uncaughtException', 1)` —— 整个监控面板下线。
 *
 * 实测复现（真实 ssh2 + node-ssh + 本地 SSH 服务），完全确定性：
 *
 *     ssh.connection.listenerCount('error') === 0
 *     → emit('error', ETIMEDOUT) → uncaughtException
 *     → 线上日志：`[UncaughtException] Error: read ETIMEDOUT { level: 'client-socket' }`
 *
 * 真实事故日志（本次测试中发现）：
 *     ✅ 4090服务器 重连成功
 *     [UncaughtException] Error: read ETIMEDOUT  { errno: -60, syscall: 'read', level: 'client-socket' }
 *     [Shutdown] 收到 uncaughtException，开始优雅退出...
 *
 * @param {object} ssh           NodeSSH 实例
 * @param {string} label         用于日志的标识（服务器名或用途）
 * @param {(err: Error) => void} [onError] 额外的清理回调（例如从连接表摘除）
 */
export function guardSshConnection(ssh, label, onError) {
  const conn = ssh && ssh.connection;
  // 连接可能已经断开（connect 失败路径），此时没有 connection 可挂
  if (!conn || typeof conn.on !== 'function') return false;

  // 幂等：重复挂会重复触发清理逻辑
  if (conn.__openlogGuarded) return true;
  conn.__openlogGuarded = true;

  conn.on('error', (err) => {
    // 先把连接标记为不可用，再做别的 —— 避免清理过程中再次抛错
    console.error(`[SSH] ${label} 连接错误:`, errorMessage(err));
    try {
      if (typeof onError === 'function') onError(err);
    } catch (e) {
      console.error(`[SSH] ${label} 连接错误清理失败:`, errorMessage(e));
    }
  });

  return true;
}

export default guardSshConnection;
