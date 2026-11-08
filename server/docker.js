import Docker from 'dockerode';
import { errorMessage } from './errors.js';
import path from 'path';
import fs from 'fs';
import { resolveDockerTransport } from './docker-transport.js';
import { buildNode, analyzeTopology } from './docker-topology.js';
import { parseProcNetTcp, mapConnectionsToEdges, buildPortOwnerMap } from './docker-live-conns.js';
import { parseLogLevel } from './log-level.js';
import { isSelfLogLine, detectSelfContainerId } from './container-log-watch.js';

// ─── 工具函数 ──────────────────────────────────────────

// 去重规范化：去掉时间戳，只保留错误模式
function normalizeForDedup(line) {
  // 去掉常见的日期时间前缀：Mon Jun 8 09:48:37 UTC 2026 -
  return (line || '')
    .replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\w+\s+\d{4}\s*-\s*/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*\s*-?\s*/i, '')
    // 去掉请求 ID 等动态值
    .replace(/req_[a-f0-9]+/gi, 'req_XXX')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
    .trim();
}

export { normalizeForDedup };

/**
 * 解析日志行中的等级。
 *
 * 曾经只认 `[ERROR] xxx` 一种前缀，导致 `ERROR xxx`、JSON 日志、vLLM 的
 * `(APIServer pid=1) ERROR:` 等真实格式全被判成 INFO —— 巡检和实时告警都不触发。
 * 现在统一走 log-level.js 的多格式解析器。
 */
function parseLogLine(line) {
  return parseLogLevel(line);
}

// ─── 容器内文件日志扫描 ──────────────────────────────────

// 获取容器的挂载信息（需要在 listContainers 之后单独 inspect）
async function getContainerMounts(docker, containerId) {
  try {
    const c = docker.getContainer(containerId);
    const info = await c.inspect();
    return (info.Mounts || []).map(m => ({
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      mode: m.Mode || 'rw',
    }));
  } catch {
    return [];
  }
}

// 从宿主机路径扫描日志文件中的错误行
// hostExec: 远程命令执行回调，为空表示本地直接读
async function scanContainerFileLogs(docker, containerId, logPaths, sinceCheckpoint, hostExec = null) {
  const results = [];
  if (!logPaths || logPaths.length === 0) return results;

  const mounts = await getContainerMounts(docker, containerId);
  if (mounts.length === 0) return results;

  // 匹配：容器内路径是否命中配置的 logPaths
  const matchedMounts = mounts.filter(m =>
    logPaths.some(lp => {
      // 支持精确匹配和前缀匹配（如 /app/logs 匹配 /app/logs/xxx）
      const dest = m.destination.replace(/\/+$/, '');
      const cfg = lp.replace(/\/+$/, '');
      return dest === cfg || dest.startsWith(cfg + '/') || cfg.startsWith(dest + '/') || dest === cfg;
    })
  );

  for (const mount of matchedMounts) {
    try {
      let fileList = [];

      if (hostExec) {
        // 远程：通过 SSH 执行 find/tail
        const sinceArg = sinceCheckpoint
          ? `-newermt "${new Date(sinceCheckpoint).toISOString().slice(0, 19).replace('T', ' ')}"`
          : '-mmin -5'; // 默认最近 5 分钟

        const cmd = `find "${mount.source}" -maxdepth 2 -name "*.log" ${sinceArg} 2>/dev/null | head -20`;
        const res = await hostExec(cmd);
        if (res && res.stdout) {
          fileList = res.stdout.trim().split('\n').filter(Boolean);
        }
      } else {
        // 本地：直接读文件系统
        try {
          const dirEntries = fs.readdirSync(mount.source, { withFileTypes: true });
          fileList = dirEntries
            .filter(e => e.isFile() && e.name.endsWith('.log'))
            .map(e => path.join(mount.source, e.name));

          // 按修改时间过滤
          if (sinceCheckpoint) {
            const sinceMs = new Date(sinceCheckpoint).getTime();
            fileList = fileList.filter(f => {
              try { return fs.statSync(f).mtimeMs > sinceMs; } catch { return false; }
            });
          } else {
            // 默认最近 5 分钟
            const cutoff = Date.now() - 5 * 60 * 1000;
            fileList = fileList.filter(f => {
              try { return fs.statSync(f).mtimeMs > cutoff; } catch { return false; }
            });
          }
        } catch { /* dir missing */ }
      }

      // 对每个文件，grep 错误行
      for (const f of fileList) {
        try {
          let content = '';
          if (hostExec) {
            const res = await hostExec(`grep -iE "error|fail|exception|fatal|traceback|panic|timeout|refused" "${f}" 2>/dev/null | tail -20`);
            content = res?.stdout || '';
          } else {
            try {
              content = fs.readFileSync(f, 'utf8');
              // 本地读，取最后 200 行再 grep
              const lines = content.split('\n').slice(-200);
              content = lines.filter(l => /error|fail|exception|fatal|traceback|panic|timeout|refused/i.test(l)).slice(-20).join('\n');
            } catch { content = ''; }
          }

          if (content.trim()) {
            const fileName = path.basename(f);
            const lines = content.split('\n').filter(Boolean);
            for (const line of lines) {
              const parsed = parseLogLine(line.trim());
              results.push({
                timestamp: new Date().toISOString(),
                line: line.trim(),
                level: /error|fail|exception|fatal|timeout|refused/i.test(line) ? 'ERROR' : 'WARN',
                content: parsed.content,
                source: fileName,
              });
            }
          }
        } catch { /* single file fail */ }
      }
    } catch { /* mount fail */ }
  }

  return results;
}

// Docker 连接池（每个 sourceId 一个实例）
export const dockerInstances = new Map();

export function getDocker(sourceId, config = {}) {
  let docker;

  // 已存在的连接直接复用
  if (dockerInstances.has(sourceId)) {
    return dockerInstances.get(sourceId);
  }

  // Unix Socket 模式（macOS Docker Desktop / Linux 本地）
  if (config.socketPath) {
    docker = new Docker({ socketPath: config.socketPath });
    dockerInstances.set(sourceId, docker);
    return docker;
  }

  // TCP 模式（远程 Docker Server）
  const host = config.host || 'localhost';
  const port = config.port || 2375;
  const protocol = config.tls ? 'https' : 'http';

  docker = new Docker({
    host: `${protocol}://${host}`,
    port,
    ca:    config.ca   ? Buffer.from(config.ca,   'base64') : undefined,
    cert:  config.cert ? Buffer.from(config.cert,  'base64') : undefined,
    key:   config.key  ? Buffer.from(config.key,   'base64') : undefined,
  });
  dockerInstances.set(sourceId, docker);
  return docker;
}

/**
 * 解析传输并取得 dockerode 客户端。
 * SSH(via) 源会先建好本地桥再连；socket/tcp 源直接构造。
 * 幂等：传已解析的 plain 配置也可以（resolveDockerTransport 原样返回）。
 */
async function getDockerFor(sourceId, sourceOrConfig = {}) {
  return getDocker(sourceId, await resolveDockerTransport(sourceOrConfig));
}

/** 清空全部 dockerode 实例缓存（桥重建后调用，连接会按需重建） */
export function clearDockerInstances() {
  dockerInstances.clear();
}

export function resetDockerInstance(sourceId) {
  dockerInstances.delete(sourceId);
}

// ============================================================
// 通用工具
// ============================================================

function parseContainerId(id) {
  return id.replace(/[^a-f0-9]/g, '').slice(0, 12);
}

// 解析容器退出码和异常类型
// Docker: 0=正常, 1=错误, 137=OOM(SIGKILL), 139=Segfault, 143=SIGTERM
function parseExitInfo(status, state) {
  const match = status?.match(/Exited \((\d+)\)/);
  if (!match) return { exitCode: null, exitType: null };
  const code = parseInt(match[1]);
  if (code === 0) return { exitCode: 0, exitType: 'normal' };
  if (code === 137) return { exitCode: 137, exitType: 'oom' };
  if (code === 139) return { exitCode: 139, exitType: 'segfault' };
  if (code === 143) return { exitCode: 143, exitType: 'terminated' };
  return { exitCode: code, exitType: 'error' };
}


// 从容器 logs 提取关键事件（启动、错误、异常）
function extractKeyEvents(logs, maxEvents = 20) {
  const events = [];
  const important = ['error', 'fail', 'exception', 'timeout', 'refused', 'panic', 'crash', 'kill', 'restart', 'stop'];
  for (const line of logs) {
    const lower = (line.line || '').toLowerCase();
    if (important.some(k => lower.includes(k))) {
      events.push({
        timestamp: line.timestamp,
        level: 'ERROR',
        line: line.line,
        spanId: line.spanId
      });
      if (events.length >= maxEvents) break;
    }
  }
  return events;
}

// ============================================================
// 核心 API
// ============================================================

// 测试 Docker 连接
export async function pingDocker(sourceId, config = {}) {
  try {
    const docker = await getDockerFor(sourceId, config);
    const info = await docker.info();
    return {
      success: true,
      name: info.Name,
      containers: info.Containers,
      running: info.ContainersRunning,
      images: info.Images,
      version: info.ServerVersion,
      os: info.OperatingSystem,
      arch: info.Architecture,
      cpus: info.NCPU,
      memory: info.MemTotal
    };
  } catch (err) {
    return { success: false, error: errorMessage(err) };
  }
}

// 获取容器列表
/**
 * 读取单个容器的 inspect 原始信息（诊断要用的真实事实来源）。
 * 失败返回 null，不抛 —— 调用方自己决定怎么降级。
 */
export async function inspectContainer(sourceId, containerId, config = {}) {
  try {
    const docker = await getDockerFor(sourceId, config);
    return await docker.getContainer(containerId).inspect();
  } catch {
    return null;
  }
}

export async function listContainers(sourceId, config = {}) {
  try {
    const docker = await getDockerFor(sourceId, config);
    const containers = await docker.listContainers({ all: true });
    return containers.map(c => {
      // 解析网络信息。
      // 注意：Docker /containers/json 返回的字段是 NetworkSettings.Networks，
      // 没有顶层 c.Networks —— 之前读错字段，导致 networks 恒为空，
      // 「同网」与「按网络推断上下游」整段失效（生产 86 个容器实测 0 命中）。
      const netMap = (c.NetworkSettings && c.NetworkSettings.Networks) || c.Networks || {};
      const networks = Object.keys(netMap);
      const networkAliases = [];
      for (const net of Object.values(netMap)) {
        for (const a of (net && net.Aliases) || []) networkAliases.push(a);
      }
      // 提取关键 labels
      const labels = c.Labels || {};
      const envVars = Object.entries(labels)
        .filter(([k]) => k.startsWith('env.') || k.startsWith('ENV.'))
        .map(([k, v]) => `${k.replace(/^(env\.|ENV\.)/, '')}=${v}`)
        .slice(0, 20);

      return {
        id: c.Id,
        shortId: c.Id.slice(0, 12),
        names: c.Names.map(n => n.replace(/^\//, '')),
        image: c.Image,
        imageId: c.ImageId?.slice(0, 12),
        command: c.Command,
        created: new Date(c.Created * 1000).toISOString(),
        state: c.State,
        status: c.Status,
        ...parseExitInfo(c.Status, c.State),
        ports: c.Ports.map(p => ({
          ip: p.IP || '0.0.0.0',
          privatePort: p.PrivatePort,
          publicPort: p.PublicPort,
          type: p.Type
        })),
        labels,
        envVars,
        networks,
        networkAliases,
        platform: c.Platform,
        // 上下游数量不在这里算：它需要每台容器的 inspect（env / 端口映射 / 网络别名），
        // 列表接口挨个 inspect 会拖慢整页。真正的链路在 /api/docker/trace 里按需算，
        // 这里给 null 明确表示「没算」，而不是给 0 冒充「没有上下游」。
        upstreamCount: null,
        downstreamCount: null
      };
    });
  } catch (err) {
    throw new Error(`无法获取容器列表: ${errorMessage(err)}`);
  }
}

// 读取容器日志
export async function getContainerLogs(sourceId, containerId, config = {}) {
  try {
    const docker = await getDockerFor(sourceId, config);
    const container = docker.getContainer(containerId);

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: 500,
      timestamps: true
    });

    // Docker logs 返回 Buffer，格式：[4字节头][数据][4字节头][数据]...
    const lines = [];
    const raw = Buffer.isBuffer(logs) ? logs : Buffer.from(logs);
    let i = 0;
    let currentTimestamp = null;

    while (i < raw.length) {
      // 8 字节头：前4字节是 stream 类型，后4字节是 size（大端序）
      if (i + 8 > raw.length) break;
      const size = raw.readUInt32BE(i + 4);
      if (size <= 0 || i + 8 + size > raw.length) break;

      const data = raw.slice(i + 8, i + 8 + size).toString('utf8');
      const parts = data.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*(.*)/);

      if (parts) {
        currentTimestamp = parts[1];
        const parsed = parseLogLine(parts[2]);
        lines.push({ timestamp: currentTimestamp, line: parts[2], level: parsed.level, content: parsed.content });
      } else if (currentTimestamp) {
        const rawLine = data.trim();
        const parsed = parseLogLine(rawLine);
        lines.push({ timestamp: currentTimestamp, line: rawLine, level: parsed.level, content: parsed.content });
      } else {
        const rawLine = data.trim();
        const parsed = parseLogLine(rawLine);
        lines.push({ timestamp: new Date().toISOString(), line: rawLine, level: parsed.level, content: parsed.content });
      }

      i += 8 + size;
    }

    return lines;
  } catch (err) {
    throw new Error(`读取日志失败: ${errorMessage(err)}`);
  }
}

// 批量读取多容器日志（联合会诊用）
export async function batchGetLogs(sources) {
  const results = [];
  for (const src of sources) {
    try {
      const logs = await getContainerLogs(src.sourceId, src.containerId, src.config || {});
      results.push({
        sourceId: src.sourceId,
        containerId: src.containerId,
        containerName: src.containerName || src.containerId,
        logs,
        success: true
      });
    } catch (err) {
      results.push({
        sourceId: src.sourceId,
        containerId: src.containerId,
        containerName: src.containerName || src.containerId,
        logs: [],
        success: false,
        error: errorMessage(err)
      });
    }
  }
  return results;
}

/**
 * 增量读取容器日志（实时错误监听用）。
 * 与 getContainerLogs 的区别：带 `since`（unix 秒），只取新日志；不解析、直接返回原始 Buffer，
 * 解析交给 container-log-watch.js（那里需要按行做等级识别与去重）。
 *
 * @param {string} sourceId
 * @param {object} sourceConfig Docker 源配置
 * @param {string} containerId
 * @param {number} sinceUnixSec 只取该时间之后的日志
 */
export async function getContainerLogsSince(sourceId, sourceConfig, containerId, sinceUnixSec) {
  const docker = await getDockerFor(sourceId, sourceConfig);
  const container = docker.getContainer(containerId);
  const result = await container.logs({
    stdout: true,
    stderr: true,
    timestamps: true,
    since: Math.max(0, Math.floor(Number(sinceUnixSec) || 0)),
    tail: 200,
  });
  return Buffer.isBuffer(result) ? result : Buffer.from(result);
}

/**
 * 列出「正在运行的容器」，按 Docker 源分组（实时错误监听用）。
 *
 * 与 listContainers 的区别：只请求运行中的容器（`all: false`），且只取监听需要的
 * 三个字段。实时监听每 5s 跑一次，不能每次都把 70 个容器的完整元数据搬一遍
 * （通过 SSH 桥接时那是实打实的流量）。
 *
 * @param {Array} sources 设置里的 dockerSources
 * @returns {Promise<Array<{sourceId:string, sourceName:string, config:object, containers:Array}>>}
 */
export async function listRunningContainersBySource(sources) {
  const enabled = (sources || []).filter(s => s && s.enabled);
  const out = [];
  await Promise.all(enabled.map(async (src) => {
    try {
      const docker = await getDockerFor(src.id, src);
      const containers = await docker.listContainers({ all: false });
      const running = (containers || [])
        .filter(c => (c.State || '').toLowerCase() !== 'exited')
        .map(c => ({
          id: c.Id,
          shortId: c.Id.slice(0, 12),
          name: (c.Names || [])[0]?.replace(/^\//, '') || c.Id.slice(0, 12),
        }));
      if (running.length > 0) {
        out.push({ sourceId: src.id, sourceName: src.name || src.id, config: src, containers: running });
      }
    } catch { /* 单个源不可达时跳过，下一轮再试 */ }
  }));
  return out;
}

/**
 * 追踪上下游链路。
 *
 * 为什么要 inspect 全部容器：判断「谁在调用我」必须看别人 env 里有没有我的名字，
 * 判断「我在调用谁」必须看我 env 里的地址 —— 这些都是 inspect 才有、list 拿不到的信息。
 *
 * 为控制耗时：并发 8 路 inspect，且带 30s 短缓存（同一批容器连续点不同容器的链路时复用）。
 * inspect 失败的单台容器不参与推断，但会记进 unavailable，不假装「它没有上下游」。
 */
export async function traceContainerLinks(sourceId, containerId, config = {}) {
  const containers = await listContainers(sourceId, config);
  const target = containers.find(c => c.id === containerId);
  if (!target) throw new Error('容器不存在');

  const nodes = await buildTopologyNodes(sourceId, containers, config);
  const topo = analyzeTopology(nodes);
  const byId = new Map(containers.map(c => [c.id, c]));
  const unavailable = [];

  // 真实 TCP 连接：比 env 里的地址更确凿。env 说「配置上打算连谁」，
  // 连接表说「此刻真的连着」。生产上 OpenLog 跑 host 网络时，
  // 本进程的 /proc/net/tcp 就是宿主机连接表，能直接看到容器之间正在连的 TCP。
  try {
    const live = await readLiveConnections(nodes);
    if (live.error) unavailable.push(`live_conns: ${live.error}`);
    else if (live.edges && live.edges.size) applyLiveEdges(topo, live.edges, nodes);
    else unavailable.push('live_conns: 此刻没有可映射到容器的活跃连接（服务空闲，或服务不在 host 网络）');
  } catch (err) {
    unavailable.push(`live_conns: ${errorMessage(err)}`);
  }

  const bucket = topo.get(containerId) || { upstream: [], downstream: [], peers: [] };

  const missing = containers.length - nodes.length;
  if (missing > 0) unavailable.push(`topology_inspect: ${missing} 台容器 inspect 失败，未参与推断`);

  const decorate = async (edge, direction) => {
    const c = byId.get(edge.id);
    if (!c) return null;
    try {
      const logs = await getContainerLogs(sourceId, edge.id, config);
      return {
        ...c, direction,
        confidence: edge.confidence,
        evidence: edge.evidence,
        allEvidence: edge.allEvidence,
        recentLogs: logs.slice(-10),
        keyEvents: extractKeyEvents(logs),
      };
    } catch {
      return { ...c, direction, confidence: edge.confidence, evidence: edge.evidence, allEvidence: edge.allEvidence, recentLogs: [], keyEvents: [] };
    }
  };

  // 上下游都补齐日志；同网只给基本信息（可能几十个，补日志太贵）
  const [enrichedUp, enrichedDown] = await Promise.all([
    Promise.all(bucket.upstream.map(e => decorate(e, 'upstream'))),
    Promise.all(bucket.downstream.map(e => decorate(e, 'downstream'))),
  ]);
  const peers = bucket.peers.map(p => {
    const c = byId.get(p.id);
    return c ? { ...c, sharedNetworks: p.networks } : null;
  }).filter(Boolean);

  return {
    target,
    serviceName: getContainerName(target),
    upstream: enrichedUp.filter(Boolean),
    downstream: enrichedDown.filter(Boolean),
    // 同网 ≠ 上下游：同一 bridge 里互相可达是网络属性，不是调用关系，单独一栏展示
    networkPeers: peers,
    totalUpstream: enrichedUp.filter(Boolean).length,
    totalDownstream: enrichedDown.filter(Boolean).length,
    totalPeers: peers.length,
    inspected: nodes.length,
    unavailable,
  };
}

/**
 * 建拓扑节点：并发 inspect + 30s 缓存。
 * 缓存 key 用 sourceId + 容器 id 列表的指纹，容器增减或重启（id 不变但 created 变）时自动失效。
 */
/**
 * 读本进程的 /proc/net/tcp(6)，把连接映射成容器之间的边。
 *
 * 只在「本进程与容器共享网络命名空间」（host 网络部署）时能看到全部容器连接；
 * 其它部署方式下命中很少，这是**事实**，所以回一个 error 说明，不假装「没有依赖」。
 */
async function readLiveConnections(nodes) {
  let text = '';
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      text += fs.readFileSync(file, 'utf8') + '\n';
    } catch { /* 单文件读不到就跳过 */ }
  }
  if (!text.trim()) return { error: '读不到 /proc/net/tcp' };

  const conns = parseProcNetTcp(text, { establishedOnly: true });
  if (!conns.length) return { edges: new Map(), total: 0 };
  const ipToId = new Map();
  for (const n of nodes) for (const ip of n.containerIps || []) ipToId.set(ip, n.id);
  const edges = mapConnectionsToEdges(conns, ipToId, { portToId: buildPortOwnerMap(nodes) });
  return { edges, total: conns.length };
}

/** 把真实连接产生的边并入拓扑结果（标为最高置信度 live_tcp） */
function applyLiveEdges(topo, edges, nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const [fromId, targets] of edges) {
    const fromBucket = topo.get(fromId);
    if (!fromBucket) continue;
    for (const [toId, stat] of targets) {
      const toBucket = topo.get(toId);
      if (!toBucket) continue;
      const evidence = {
        kind: 'live_tcp',
        confidence: 'high',
        detail: `此刻有 ${stat.count} 条已建立的 TCP 连接`,
        value: String(stat.count),
      };
      if (!fromBucket.downstream.some(x => x.id === toId)) {
        fromBucket.downstream.push({ id: toId, direction: 'downstream', confidence: 'high', evidence, allEvidence: [evidence] });
      }
      if (!toBucket.upstream.some(x => x.id === fromId)) {
        toBucket.upstream.push({
          id: fromId, direction: 'upstream', confidence: 'high',
          evidence: { ...evidence, detail: `${byId.get(fromId)?.names?.[0] || fromId} 与它有 ${stat.count} 条已建立连接` },
          allEvidence: [evidence],
        });
      }
      // 同网列表里要剔除已经成为上下游的
      fromBucket.peers = fromBucket.peers.filter(p => p.id !== toId);
      toBucket.peers = toBucket.peers.filter(p => p.id !== fromId);
    }
  }
}

const topologyCache = new Map(); // key -> { at, nodes }
const TOPOLOGY_TTL_MS = 30_000;

async function buildTopologyNodes(sourceId, containers, config) {
  const fingerprint = `${sourceId}:${containers.length}:${containers.map(c => c.id).sort().join(',').length}`;
  const hit = topologyCache.get(fingerprint);
  const now = Date.now();
  if (hit && now - hit.at < TOPOLOGY_TTL_MS && hit.count === containers.length) return hit.nodes;

  const nodes = [];
  const CONCURRENCY = 8;
  let cursor = 0;
  const worker = async () => {
    while (cursor < containers.length) {
      const c = containers[cursor];
      cursor += 1;
      try {
        const inspect = await getDockerFor(sourceId, config).then(d => d.getContainer(c.id).inspect());
        if (inspect) nodes.push(buildNode(c, inspect));
      } catch { /* 单台失败不影响其它 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, containers.length) }, worker));

  const entry = { at: now, nodes, count: containers.length };
  topologyCache.set(fingerprint, entry);
  // 简单淘汰：超过 20 个 source 指纹就清最旧的
  if (topologyCache.size > 20) {
    const oldest = [...topologyCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) topologyCache.delete(oldest[0]);
  }
  return nodes;
}

// ─── 容器操作 ───────────────────────────────────────────────
function getContainerName(c) {
  return Array.isArray(c.names) ? c.names[0] : (c.name || c.shortId);
}

export async function startContainer(sourceId, containerId, config = {}) {
  const docker = await getDockerFor(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.start();
  return { ok: true, message: '容器已启动' };
}

export async function stopContainer(sourceId, containerId, config = {}) {
  const docker = await getDockerFor(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.stop({ t: 10 });
  return { ok: true, message: '容器已停止' };
}

export async function restartContainer(sourceId, containerId, config = {}) {
  const docker = await getDockerFor(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.restart({ t: 10 });
  return { ok: true, message: '容器已重启' };
}

export async function pauseContainer(sourceId, containerId, config = {}) {
  const docker = await getDockerFor(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.pause();
  return { ok: true, message: '容器已暂停' };
}

export async function unpauseContainer(sourceId, containerId, config = {}) {
  const docker = await getDockerFor(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.unpause();
  return { ok: true, message: '容器已恢复' };
}

export async function removeContainer(sourceId, containerId, config = {}) {
  const docker = await getDockerFor(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.remove({ force: true });
  return { ok: true, message: '容器已删除' };
}

/**
 * 把命令字符串切成 argv，尊重引号与反斜杠转义。
 *
 * 为什么不用 `cmd.split(' ')`：`cat "/var/log/my app.log"` 会被切成
 * `cat` + `"/var/log/my` + `app.log"`，引号原样传给容器里的程序，直接失败。
 * shell 语义做不了（也不该做，见 security/shell-command-policy.js），
 * 所以只做一个「够用的引号感知切分」。
 */
export function tokenizeCommand(cmd) {
  const input = String(cmd ?? '');
  const argv = [];
  let current = '';
  let quote = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < input.length) { current += input[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (ch === '\\' && i + 1 < input.length) { current += input[++i]; hasToken = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (hasToken || current) { argv.push(current); current = ''; hasToken = false; }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken || current) argv.push(current);
  return argv;
}

/**
 * Docker exec / attach 流的解复用器。
 *
 * 非 TTY 的 exec 输出是「多路复用帧」：
 *   [0]=stream(1=stdout,2=stderr) [1..3]=0 [4..7]=payload 长度(BE) [8..]=payload
 * 直接把 chunk toString() 会让头部字节混进输出（真实看到的就是
 * `\u0001\u0000\u0000\u0000\u0000\u0000\u0000]assistant_memory`）。
 *
 * 帧可能跨 chunk 切断，所以这里保留残余字节等下一块。
 */
export function createExecDemuxer() {
  let buffer = Buffer.alloc(0);
  let multiplexed = null; // null=还没判断, true/false=是否带帧头

  const looksMultiplexed = (buf) => buf.length >= 8
    && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0
    && buf.readUInt32BE(4) <= 32 * 1024 * 1024;

  return {
    /** 喂一块数据，返回已解析的文本 */
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!buf.length) return '';
      if (multiplexed === null) {
        buffer = Buffer.concat([buffer, buf]);
        if (buffer.length < 8) return '';
        multiplexed = looksMultiplexed(buffer);
      } else {
        buffer = Buffer.concat([buffer, buf]);
      }
      // 纯 TTY 输出：没有帧头，原样返回
      if (!multiplexed) {
        const out = buffer.toString('utf8');
        buffer = Buffer.alloc(0);
        return out;
      }
      let out = '';
      while (buffer.length >= 8) {
        const size = buffer.readUInt32BE(4);
        if (size > 32 * 1024 * 1024) { // 帧头错乱，退化成纯文本，避免死循环
          multiplexed = false;
          out += buffer.toString('utf8');
          buffer = Buffer.alloc(0);
          return out;
        }
        if (buffer.length < 8 + size) break;
        out += buffer.slice(8, 8 + size).toString('utf8');
        buffer = buffer.slice(8 + size);
      }
      return out;
    },
    /** 流结束：把残留当纯文本吐出（避免丢最后一段） */
    flush() {
      if (!buffer.length) return '';
      const rest = multiplexed === false ? buffer.toString('utf8') : '';
      buffer = Buffer.alloc(0);
      return rest;
    },
    /** 测试/调试：当前残留字节数 */
    pending() {
      return buffer.length;
    },
  };
}

/** 容器内执行命令时输出上限，防止一条 `cat 大文件` 把内存和前端打爆 */
const MAX_EXEC_OUTPUT = 256 * 1024;

export async function execInContainer(sourceId, containerId, cmd, config = {}) {
  const docker = await getDockerFor(sourceId, config);
  const container = docker.getContainer(containerId);
  // cmd: string（按 shell 引号规则切 argv）或已是数组
  const command = Array.isArray(cmd) ? cmd : tokenizeCommand(cmd);
  if (!command.length) throw new Error('命令为空');
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const demux = createExecDemuxer();
  return new Promise((resolve, reject) => {
    let output = '';
    let truncated = false;
    stream.on('data', chunk => {
      if (truncated) return;
      output += demux.push(chunk);
      if (output.length > MAX_EXEC_OUTPUT) {
        output = output.slice(0, MAX_EXEC_OUTPUT);
        truncated = true;
      }
    });
    stream.on('end', async () => {
      output += demux.flush();
      let exitCode = 0;
      try {
        const info = await exec.inspect();
        exitCode = info?.ExitCode ?? 0;
      } catch { /* inspect 失败不影响输出 */ }
      resolve({ output, exitCode, truncated });
    });
    stream.on('error', reject);
  });
}

// ─── 批量分析（多容器联合会诊）────────────────────────────
export async function batchAnalyze(sources, apiKey, baseUrl, model) {
  const logsData = await batchGetLogs(sources);
  const combined = logsData.map(d => ({
    container: d.containerName,
    logs: d.logs.slice(-100).map(l => `[${l.timestamp}] ${l.line}`).join('\n'),
    success: d.success,
    error: d.error
  }));

  const prompt = `你是运维工程师，正在进行多容器日志联合会诊。

## 容器日志（按容器分组）：
${combined.map(d => `### ${d.container}${d.success ? '' : ' ⚠️ ' + d.error}`)
    .join('\n\n')}

## 分析任务：
1. 找出每个容器最近的关键错误
2. 判断这些错误是否有因果关系（上游错误是否导致下游故障）
3. 给出整体诊断结论和修复建议

请用 Markdown 回复，语言与日志一致。`;

  // 调用 LLM（流式返回由调用方处理）
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: apiKey || 'ollama', baseURL: baseUrl });
  const response = await openai.chat.completions.create({
    model: model || 'qwen2.5:7b',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    timeout: 120_000
  });

  return {
    analysis: response.choices[0].message.content,
    containers: combined.map(d => ({ name: d.container, success: d.success }))
  };
}

// ─── Docker 容器健康诊断 ────────────────────────────────
export async function healthCheck(sources) {
  if (!sources || sources.length === 0) throw new Error('未配置 Docker 源');

  const allContainers = [];
  const sourceMap = {};

  for (const src of sources) {
    if (!src.enabled) continue;
    try {
      const containers = await listContainers(src.id, src);
      for (const c of containers) {
        c._sourceId = src.id;
        c._sourceName = src.name;
      }
      allContainers.push(...containers);
      sourceMap[src.id] = src;
    } catch (err) {
      console.warn(`[healthCheck] 跳过 ${src.name}:`, errorMessage(err));
    }
  }

  // 分类统计
  const running = allContainers.filter(c => c.state === 'running');
  const exited = allContainers.filter(c => c.state === 'exited');
  const oomKilled = exited.filter(c => c.exitType === 'oom');
  const errorExited = exited.filter(c => c.exitType === 'error' || c.exitType === 'segfault');
  const normalExited = exited.filter(c => c.exitType === 'normal');

  // 为异常容器拉取最近日志（last 50 lines, filter errors）
  const problemContainers = [...oomKilled, ...errorExited];
  const problemDetails = [];

  for (const c of problemContainers) {
    try {
      const config = sourceMap[c._sourceId];
      const logResult = await getContainerLogs(c._sourceId, c.id, config, { tail: 50 });
      const errorLines = (logResult.logs || [])
        .filter(l => /error|fatal|panic|exception|traceback|killed|oom/i.test(l.line || ''))
        .map(l => `[${l.timestamp || ''}] ${l.line}`);
      problemDetails.push({
        name: c.names[0] || c.shortId,
        image: c.image,
        state: c.state,
        exitCode: c.exitCode,
        exitType: c.exitType,
        status: c.status,
        errors: errorLines.slice(-10),
        sourceName: c._sourceName,
      });
    } catch (err) {
      problemDetails.push({
        name: c.names[0] || c.shortId,
        image: c.image,
        state: c.state,
        exitCode: c.exitCode,
        exitType: c.exitType,
        status: c.status,
        errors: [`无法获取日志: ${errorMessage(err)}`],
        sourceName: c._sourceName,
      });
    }
  }

  return {
    summary: {
      total: allContainers.length,
      running: running.length,
      exited: exited.length,
      oomKilled: oomKilled.length,
      errorExited: errorExited.length,
      normalExited: normalExited.length,
      healthy: running.length + normalExited.length,
      unhealthy: oomKilled.length + errorExited.length,
    },
    running: running.map(c => ({ name: c.names[0] || c.shortId, image: c.image, status: c.status, sourceName: c._sourceName })),
    problems: problemDetails,
    normalExited: normalExited.map(c => ({ name: c.names[0] || c.shortId, image: c.image, exitCode: c.exitCode, sourceName: c._sourceName })),
  };
}

// ─── Docker Events 监听（容器异常退出推送）─────────────────
const eventWatchers = new Map(); // sourceId -> { stream, docker }

function exitTypeLabel(type) {
  switch (type) {
    case 'oom': return '💀 OOM (内存溢出)';
    case 'segfault': return '🔥 Segfault (段错误)';
    case 'terminated': return '🛑 SIGTERM 终止';
    case 'error': return '❌ 异常退出';
    case 'normal': return '';
    default: return `⚠️ 退出码 ${type}`;
  }
}

// 开始监听 Docker 事件（die 事件 → 异常退出通知）
export async function startEventWatcher(sourceId, config, onEvent) {
  stopEventWatcher(sourceId);
  if (!config.enabled) return;

  try {
    const docker = await getDockerFor(sourceId, config);
    const stream = await docker.getEvents({
      filters: JSON.stringify({ type: ['container'], event: ['die'] })
    });

    eventWatchers.set(sourceId, { stream, docker });
    console.log(`[Docker Events] 开始监听 ${config.name || sourceId} 容器退出事件`);

    let buf = '';
    stream.on('data', async (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // 保留不完整的最后一行

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const actor = event.Actor?.Attributes || {};
          const status = actor.exitCode ? `Exited (${actor.exitCode})` : '';
          const exitInfo = parseExitInfo(status, 'exited');

          // 只关注异常退出
          if (!exitInfo.exitCode || exitInfo.exitType === 'normal') continue;

          const containerName = actor.name || event.Actor?.ID?.slice(0, 12) || 'unknown';
          const image = actor.image || '';
          const label = exitTypeLabel(exitInfo.exitType);

          // 拉一下最近日志用于上下文
          let recentErrors = [];
          try {
            const logs = await getContainerLogs(sourceId, event.Actor?.ID, config);
            recentErrors = (logs || [])
              .filter(l => /error|fatal|panic|exception|kill|oom/i.test(l.line || ''))
              .slice(-5)
              .map(l => l.line);
          } catch (_) { /* 忽略 */ }

          onEvent({
            type: 'container_exited',
            sourceId,
            sourceName: config.name,
            containerId: event.Actor?.ID,
            containerName,
            image,
            exitCode: exitInfo.exitCode,
            exitType: exitInfo.exitType,
            label,
            timestamp: new Date(parseInt(event.time) * 1000).toISOString(),
            recentErrors
          });
        } catch (_) { /* 忽略解析失败的事件 */ }
      }
    });

    stream.on('error', err => {
      console.error(`[Docker Events] ${config.name}:`, errorMessage(err));
      eventWatchers.delete(sourceId);
    });

    stream.on('end', () => {
      console.log(`[Docker Events] ${config.name} 事件流结束`);
      eventWatchers.delete(sourceId);
    });
  } catch (err) {
    console.error(`[Docker Events] ${config.name} 启动失败:`, errorMessage(err));
    // 不支持 events 的 Docker 版本静默跳过
    if (!err.message.includes('400')) {
      console.warn(`[Docker Events] ${config.name}: ${errorMessage(err)}`);
    }
  }
}

export function stopEventWatcher(sourceId) {
  const w = eventWatchers.get(sourceId);
  if (w) {
    try { w.stream.destroy(); } catch (_) {}
    eventWatchers.delete(sourceId);
    console.log(`[Docker Events] 已停止 ${sourceId}`);
  }
}

export function stopAllEventWatchers() {
  for (const [id] of eventWatchers) stopEventWatcher(id);
}

// ─── 容器日志定时巡检 ────────────────────────────────────
// 巡检所有已启用 Docker 源的容器日志，按配置等级过滤异常行
// 1. 扫描容器 stdout/stderr（docker logs）
// 2. 扫描容器内文件日志（通过挂载点读取 host 上的日志文件）
// 增量巡检：记录每个容器上次检查的日志时间戳
// hostExecForSource: (src) => (cmd) => { stdout, stderr } | null
let _patrolCheckpoints = new Map(); // key: "sourceId:containerId" → { timestamp, lineCount }
let _reportedPatterns = new Map(); // key: "sourceId:containerId" → Set<normalizedPattern>

export function resetPatrolCheckpoints() {
  _patrolCheckpoints.clear();
  _reportedPatterns.clear();
}

/** 检测容器重启：当前最后一条日志时间小于 checkpoint 时间 → 时间倒流 = 重启过 */
function getPatrolSince(key, currentLogs) {
  const cp = _patrolCheckpoints.get(key);
  if (!cp) {
    _reportedPatterns.delete(key); // 首次扫描，清空历史
    return null;
  }
  if (currentLogs.length === 0) return cp.timestamp;
  const lastTs = currentLogs[currentLogs.length - 1].timestamp;
  // 时间倒流 = 容器重启，checkpoint 和 reported patterns 都失效
  if (lastTs < cp.timestamp) {
    _reportedPatterns.delete(key);
    return null;
  }
  return cp.timestamp;
}

function updatePatrolCheckpoint(key, allLogs) {
  if (allLogs.length === 0) return;
  _patrolCheckpoints.set(key, {
    timestamp: allLogs[allLogs.length - 1].timestamp,
    lineCount: allLogs.length,
  });
}

export async function patrolContainerLogs(sources, levels, hostExecForSource = null) {
  const results = [];
  const effectiveLevels = (levels && levels.length > 0) ? levels : ['ERROR', 'FATAL'];

  // 所有源并行巡检
  await Promise.all(sources.map(async (src) => {
    if (!src.enabled) return;
    const srcExec = hostExecForSource ? hostExecForSource(src) : null;
    try {
      const docker = await getDockerFor(src.id, src);
      const containers = await listContainers(src.id, src);
      // ?? OpenLog ??????????????? [ERROR]????????
      const selfId = detectSelfContainerId();
      const runningContainers = containers.filter(c => c.state === 'running'
        && !(selfId && c.id && c.id.startsWith(selfId.slice(0, 12))));
      const logPaths = (src.logPaths && src.logPaths.length > 0) ? src.logPaths : null;

      // 这一轮连上了：如果之前一直在报错，补一条恢复日志
      clearPatrolSkip(src.name);

      // 每个容器并行扫描
      await Promise.all(runningContainers.map(async (c) => {
        try {
          const key = `${src.id}:${c.id}`;

          // 并行：stdout/stderr + 文件日志
          const [stdLogs, fileLogs] = await Promise.all([
            getContainerLogs(src.id, c.id, src)
              .then(logs => logs || [])
              .catch(() => []),
            logPaths
              ? scanContainerFileLogs(docker, c.id, logPaths,
                  _patrolCheckpoints.get(key)?.timestamp || null, srcExec)
              : Promise.resolve([]),
          ]);

          // 检测重启：时间倒流则重置 checkpoint
          const since = getPatrolSince(key, stdLogs);

          // stdout/stderr 增量过滤
          const newStdLogs = since
            ? stdLogs.filter(l => l.timestamp > since)
            : stdLogs.slice(-100);

          // 合并所有新日志
          const allNew = [...newStdLogs, ...fileLogs];
          if (allNew.length === 0) return;

          // 更新检查点
          updatePatrolCheckpoint(key, stdLogs);

          // 按等级过滤（自身告警日志不参与，避免自激放大）
          const matchedLines = allNew.filter(l => {
            if (isSelfLogLine(l.content || l.line)) return false;
            const lvl = (l.level || 'INFO').toUpperCase();
            return effectiveLevels.includes(lvl);
          });

          if (matchedLines.length > 0) {
            // 去重（忽略时间戳和动态值）
            const deduped = [];
            const seen = new Set();
            for (let i = matchedLines.length - 1; i >= 0; i--) {
              const raw = matchedLines[i].content || matchedLines[i].line || '';
              const sig = normalizeForDedup(raw);
              if (!seen.has(sig)) {
                seen.add(sig);
                deduped.unshift(matchedLines[i]);
              }
            }

            // 过滤已报告过的错误模式
            let reported = _reportedPatterns.get(key);
            if (!reported) {
              reported = new Set();
              _reportedPatterns.set(key, reported);
            }
            const newErrors = deduped.filter(l => {
              const sig = normalizeForDedup(l.content || l.line || '');
              if (reported.has(sig)) return false;
              reported.add(sig);
              return true;
            });

            // 只上报新错误
            if (newErrors.length > 0) {
              results.push({
                sourceId: src.id,
                sourceName: src.name,
                containerId: c.shortId,
                containerName: c.names?.[0] || c.shortId,
                image: c.image,
                state: c.state,
                totalNewLines: allNew.length,
                matchCount: matchedLines.length,
                uniqueCount: newErrors.length,
                totalUnique: reported.size, // 该容器所有已发现的不同错误类型数
                lines: newErrors.slice(-30).map(l => ({
                  timestamp: l.timestamp,
                  line: l.line,
                  level: l.level,
                  content: l.content,
                  source: l.source,
                })),
              });
            }
          }
        } catch (_) { /* 单个容器跳过 */ }
      }));
    } catch (err) {
      // 同样的失败别每轮都刷一遍。
      // 巡检间隔 10s，一台不可达的服务器会持续产出完全相同的错误行 ——
      // 实测 20 分钟内刷了 200+ 行「connect ETIMEDOUT 203.0.113.10:2375」，
      // 把真正有用的日志淹没了（诊断别的故障时根本翻不到）。
      // 每个源只在「错误内容变化」时记录，并在恢复时补一条恢复日志。
      logPatrolSkipOnce(src.name, errorMessage(err));
    }
  }));

  return results;
}

/**
 * 按 (源名 → 上次错误) 去重巡检失败日志。
 * 错误内容变化、或从失败恢复时才会输出，避免以巡检间隔刷屏。
 */
export const patrolSkipSeen = new Map();

/**
 * 把失败文本归一化成「可用于去重的签名」。
 *
 * 直接拿原文比较会导致去重形同虚设：错误文本里带着每次都变的部分 ——
 *   1. 本地临时端口：`- Local (0.0.0.0:54981)` 每次连接都换一个；
 *   2. 同一台不可达的机器会在 ENETUNREACH / ETIMEDOUT / socket hang up /
 *      握手超时 之间来回振荡（实测每 10s 就换一种）。
 * 结果就是「同一次故障」被当成「连续变化」刷屏（见 [Patrol] 跳过 4090*4）。
 *
 * 归一化规则：可达性类错误全部归为一个签名；「远端 docker.sock 无响应」
 * （SSH 通但通道没回应，通常是 dockerd 没跑）单独一类；其它错误保留正文
 * —— 这类变化（权限、dockerd 状态）才值得重新记录。
 */
export function patrolErrorSignature(message) {
  const normalized = String(message)
    .replace(/- Local \([\d.:]+\)/g, '')
    .replace(/:\d{2,5}\b/g, ':<port>')
    .replace(/\s+/g, ' ')
    .trim();
  if (/No response from server/i.test(normalized)) return 'no-response（远端 docker.sock 无响应，dockerd 未在运行？）';
  if (/ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|handshake/i.test(normalized)) {
    return 'unreachable';
  }
  return normalized;
}

export function logPatrolSkipOnce(sourceName, message) {
  const sig = patrolErrorSignature(message);
  const prev = patrolSkipSeen.get(sourceName);
  if (prev && prev.sig === sig) return; // 同类错误，静默
  patrolSkipSeen.set(sourceName, { sig, message });
  if (prev === undefined) {
    console.warn(`[Patrol] 跳过 ${sourceName}:`, message);
  } else {
    console.warn(`[Patrol] 跳过 ${sourceName}:`, message, '（错误内容已变化，此前为：' + prev.message + '）');
  }
}

/** 巡检成功时调用，用于在恢复后补一条日志并清掉去重状态。 */
export function clearPatrolSkip(sourceName) {
  const prev = patrolSkipSeen.get(sourceName);
  if (prev === undefined) return;
  patrolSkipSeen.delete(sourceName);
  console.log(`[Patrol] ${sourceName} 已恢复（此前错误：${prev.message}）`);
}
