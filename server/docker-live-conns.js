/**
 * server/docker-live-conns.js —— 从 /proc/net/tcp 读「真实存在的 TCP 连接」
 *
 * 为什么需要它：env 里的地址只说明「配置上打算连谁」，实际连没连是另一回事
 * （配了但没启用、连的是另一套环境、服务已经挂了都可能）。真实的连接表才是硬证据。
 *
 * 数据来源：容器内或宿主机 netns 的 /proc/net/tcp（+ tcp6）。
 * 格式（内核固定）：
 *   sl local_address rem_address st ...
 *   0: 00000000:1538 00000000:0000 0A ...
 * 地址是**小端**十六进制，端口也是十六进制；st=01 才是 ESTABLISHED。
 *
 * 只做纯解析 + 匹配，不碰网络不碰文件系统，方便单测。
 */

/** 小端十六进制 IPv4（8 字符）→ 点分十进制；IPv6（32 字符）→ 分组串 */
export function hexToIp(hex) {
  const h = String(hex || '');
  if (h.length === 8) {
    const bytes = [];
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
    return Number.isNaN(bytes[0]) ? null : bytes.join('.');
  }
  if (h.length === 32) {
    // IPv6：32 个 hex = 4 组 8 字符，每组也是小端；组内两两成字节后按 IPv6 常规表示压缩
    const words = [];
    for (let i = 0; i < 32; i += 8) {
      const word = h.slice(i, i + 8);
      const bytes = [];
      for (let j = 6; j >= 0; j -= 2) bytes.push(word.slice(j, j + 2));
      // 4 字节 → 两个 16 位组，去掉前导零（与 /proc/net/tcp6 的显示习惯一致）
      words.push(parseInt(bytes[0] + bytes[1], 16).toString(16));
      words.push(parseInt(bytes[2] + bytes[3], 16).toString(16));
    }
    return words.join(':').toLowerCase();
  }
  return null;
}

/** 端口是十六进制；非法返回 null（不返回 0，0 是合法端口） */
export function hexToPort(hex) {
  const n = parseInt(String(hex || ''), 16);
  return Number.isFinite(n) && n >= 0 && n <= 65535 ? n : null;
}

/**
 * 解析 /proc/net/tcp(6) 文本。
 *
 * @param {string} text
 * @param {{ establishedOnly?: boolean }} [opts] 默认只保留 ESTABLISHED（01）
 * @returns {Array<{localIp:string,localPort:number,remoteIp:string,remotePort:number,state:string}>}
 */
export function parseProcNetTcp(text, { establishedOnly = true } = {}) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    // 至少要有 sl / local / remote / st 四段
    if (parts.length < 4) continue;
    if (!/^\d+:$/.test(parts[0])) continue; // 跳过表头与脏行
    const state = parts[3];
    if (establishedOnly && state !== '01') continue;
    const [lh, lp] = parts[1].split(':');
    const [rh, rp] = parts[2].split(':');
    const localIp = hexToIp(lh); const remoteIp = hexToIp(rh);
    const localPort = hexToPort(lp); const remotePort = hexToPort(rp);
    if (localIp === null || remoteIp === null || localPort === null || remotePort === null) continue;
    out.push({ localIp, localPort, remoteIp, remotePort, state });
  }
  return out;
}

/** 回环/通配地址：连接两端都在本机时，不能用来判断「谁连了谁」 */
const LOOPBACK = new Set(['127.0.0.1', '0.0.0.0', '::', '::1', '0:0:0:0:0:0:0:0', '0:0:0:0:0:0:0:1']);

/**
 * 把连接表映射成「容器 A → 容器 B」的边。
 *
 * @param {Array} conns                parseProcNetTcp 的结果
 * @param {Map<string,string>} ipToId  容器 IP → 容器 id
 * @param {object} [opts]
 * @param {Map<string,string>} [opts.portToId]  发布/监听端口 → 容器 id（回环连接靠它）
 * @param {Set<string>} [opts.hostIps]          宿主机自身的 IP（host 网络容器都挂在这些 IP 上）
 * @param {Set<string>} [opts.hostIds]          host 网络容器 id 集合（它们的连接出现在宿主机连接表里）
 * @returns {Map<string, Map<string, {count:number, sample:object}>>} fromId → toId → 统计
 */
export function mapConnectionsToEdges(conns, ipToId, { portToId, hostIps, hostIds } = {}) {
  const edges = new Map();
  const add = (from, to, conn) => {
    if (!from || !to || from === to) return;
    if (!edges.has(from)) edges.set(from, new Map());
    const bucket = edges.get(from);
    const cur = bucket.get(to) || { count: 0, sample: conn };
    cur.count += 1;
    bucket.set(to, cur);
  };

  const hostIpSet = hostIps instanceof Set ? hostIps : new Set();
  const hostIdSet = hostIds instanceof Set ? hostIds : new Set();
  const resolve = (ip, port, isLocal) => {
    // 先按容器 IP 精确匹配
    const direct = ipToId.get(ip);
    if (direct) return direct;
    // 回环/宿主 IP + 端口 → 可能是 host 网络容器（它监听在宿主机端口上）
    if (portToId && (LOOPBACK.has(ip) || hostIpSet.has(ip))) {
      const byPort = portToId.get(port);
      if (byPort) return byPort;
    }
    return null;
  };

  for (const conn of conns || []) {
    // 两端都在本机的连接：local 是被连方（服务端），remote 是主动方（客户端）
    const serverSide = resolve(conn.localIp, conn.localPort, true);
    const clientSide = resolve(conn.remoteIp, conn.remotePort, false);
    if (serverSide && clientSide) {
      add(clientSide, serverSide, conn);
      continue;
    }
    // host 网络容器：连接两端可能有一端是「宿主机」，另一端是容器；
    // 此时方向只能靠端口判断，宁可放弃也不瞎猜
    if (serverSide && hostIdSet.size && (LOOPBACK.has(conn.remoteIp) || hostIpSet.has(conn.remoteIp))) {
      // 主动方是宿主 IP：不知道是哪个 host 容器发起的 → 跳过（不猜）
      continue;
    }
  }
  return edges;
}

/**
 * 端口的归属表：容器的发布端口 + 监听端口都算它的。
 * @param {Array} nodes buildNode() 的结果
 */
export function buildPortOwnerMap(nodes) {
  const map = new Map();
  for (const n of nodes) {
    for (const p of n.publishedPorts || []) {
      if (!map.has(p.hostPort)) map.set(p.hostPort, n.id);
    }
  }
  return map;
}

/** 明显不是容器地址的网段（宿主机网关 / 回环 / 公网）—— 用于判断「对端可能是 host 网络容器」 */
export function isLikelyHostSide(ip) {
  const s = String(ip || '');
  if (LOOPBACK.has(s)) return true;
  // docker 默认网桥的网关是 x.x.x.1；host 网络容器发起的连接，源地址会落在这里
  if (/^\d+\.\d+\.\d+\.1$/.test(s)) return true;
  return false;
}

/**
 * 单台容器自己的连接表 → 它主动连了谁。
 *
 * 为什么按「每台容器各自的 /proc/net/tcp」而不是宿主机连接表：
 * 在容器自己的 netns 里，local 端**必然是它自己**，方向不会有歧义。
 * 宿主机连接表里，host 网络容器发起连接的源地址是 docker 网关 IP（172.17.0.1），
 * 无法归到具体容器 —— 实测就卡在这里（86 容器映射出 0 条边）。
 *
 * @param {string} selfId                     这台容器自己的 id
 * @param {Array}  conns                      parseProcNetTcp(自己容器内 /proc/net/tcp) 的结果
 * @param {Map<string,string>} ipToId         容器 IP → id
 * @param {object} [opts]
 * @param {Map<string,string>} [opts.portToId] 发布端口 → id（对端是 host 容器时靠端口认）
 * @param {string|null} [opts.soleHostId]      宿主机上唯一的 host 网络容器 id（对端是宿主机侧时归给它）
 * @param {Set<string>} [opts.allIds]          所有容器 id（用于排除自连）
 * @returns {Map<string, {count:number, sample:object}>} 目标 id → 连接统计
 */
export function outboundFrom(selfId, conns, ipToId, { portToId, soleHostId, allIds } = {}) {
  const out = new Map();
  for (const conn of conns || []) {
    const remoteIp = conn.remoteIp;
    let target = ipToId instanceof Map ? ipToId.get(remoteIp) : null;
    // 对端是宿主机网段（host 网络容器 / 网关）：只有能唯一确定时才归，否则放弃
    if (!target && (LOOPBACK.has(remoteIp) || isLikelyHostSide(remoteIp))) {
      if (portToId && portToId.has(conn.remotePort)) target = portToId.get(conn.remotePort);
      else if (soleHostId) target = soleHostId;
    }
    if (!target) continue;
    if (target === selfId) continue; // 自己连自己（同容器内多进程）不算依赖
    if (allIds instanceof Set && !allIds.has(target)) continue;
    const cur = out.get(target) || { count: 0, sample: conn };
    cur.count += 1;
    out.set(target, cur);
  }
  return out;
}
