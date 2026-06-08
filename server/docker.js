import Docker from 'dockerode';
import path from 'path';
import fs from 'fs';

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

// 解析日志行中的等级
function parseLogLine(line) {
  const match = line.match(/^\s*\[(FATAL|ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\]\s*/i);
  if (match) {
    const level = match[1].toUpperCase() === 'WARNING' ? 'WARN' : match[1].toUpperCase();
    return { level, content: line.substring(match[0].length) };
  }
  return { level: 'INFO', content: line };
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

function getDocker(sourceId, config = {}) {
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

// 从容器 labels 推断上下游关系
function inferUpstreamDownstream(containers, targetId) {
  const target = containers.find(c => c.id === targetId);
  if (!target) return { upstreams: [], downstreams: [] };

  const myService = target.labels?.['com.docker.compose.service']
    || target.labels?.['app']
    || target.names?.[0];

  const upstreams = [];
  const downstreams = [];

  for (const c of containers) {
    if (c.id === targetId) continue;
    const svc = c.labels?.['com.docker.compose.service'] || c.labels?.['app'] || c.names?.[0];

    // 检查 label 依赖（Swarm / Compose）
    const deps = c.labels?.['depends-on'] || c.labels?.['com.docker.compose.depends_on'] || '';
    if (deps.includes(myService)) upstreams.push(c);

    // 检查环境变量中的服务名
    const env = (c.labels?.env || '').toLowerCase();
    if (env.includes(myService?.toLowerCase() || '')) upstreams.push(c);

    // 下游：target 的环境变量里包含对方
    const targetEnv = (target.labels?.env || '').toLowerCase();
    if (targetEnv.includes(svc?.toLowerCase() || '')) downstreams.push(c);
  }

  // 网络共享推断
  const targetNets = new Set(target.networks || []);
  if (targetNets.size > 0) {
    for (const c of containers) {
      if (c.id === targetId) continue;
      const sharedNets = (c.networks || []).filter(n => targetNets.has(n));
      if (sharedNets.length > 0 && !upstreams.find(u => u.id === c.id) && !downstreams.find(d => d.id === c.id)) {
        downstreams.push(c);
      }
    }
  }

  return {
    upstreams: [...new Map(upstreams.map(c => [c.id, c])).values()],
    downstreams: [...new Map(downstreams.map(c => [c.id, c])).values()]
  };
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
    const docker = getDocker(sourceId, config);
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
    return { success: false, error: err.message };
  }
}

// 获取容器列表
export async function listContainers(sourceId, config = {}) {
  try {
    const docker = getDocker(sourceId, config);
    const containers = await docker.listContainers({ all: true });
    return containers.map(c => {
      // 解析网络信息
      const networks = [];
      for (const [netName, netInfo] of Object.entries(c.Networks || {})) {
        networks.push(netName);
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
        platform: c.Platform,
        // 上下游推断
        ...(() => {
          const { upstreams, downstreams } = inferUpstreamDownstream(
            containers.map(cc => ({
              ...cc,
              id: cc.Id,
              names: cc.Names.map(n => n.replace(/^\//, '')),
              networks: Object.keys(cc.Networks || {})
            })),
            c.Id
          );
          return {
            upstreamCount: upstreams.length,
            downstreamCount: downstreams.length,
            upstreamIds: upstreams.map(u => u.Id?.slice(0, 12)),
            downstreamIds: downstreams.map(d => d.Id?.slice(0, 12))
          };
        })()
      };
    });
  } catch (err) {
    throw new Error(`无法获取容器列表: ${err.message}`);
  }
}

// 读取容器日志
export async function getContainerLogs(sourceId, containerId, config = {}) {
  try {
    const docker = getDocker(sourceId, config);
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
    throw new Error(`读取日志失败: ${err.message}`);
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
        error: err.message
      });
    }
  }
  return results;
}

// 追踪上下游链路
export async function traceContainerLinks(sourceId, containerId, config = {}) {
  const containers = await listContainers(sourceId, config);
  const target = containers.find(c => c.id === containerId);
  if (!target) throw new Error('容器不存在');

  const { upstreams, downstreams } = inferUpstreamDownstream(containers, containerId);

  const enrich = async (c) => {
    try {
      const logs = await getContainerLogs(sourceId, c.id, config);
      return { ...c, recentLogs: logs.slice(-10), keyEvents: extractKeyEvents(logs) };
    } catch {
      return { ...c, recentLogs: [], keyEvents: [] };
    }
  };

  const enrichedUp = await Promise.all(upstreams.map(enrich));
  const enrichedDown = await Promise.all(downstreams.map(enrich));

  return {
    target,
    serviceName: target.name,
    upstream: enrichedUp,
    downstream: enrichedDown,
    totalUpstream: upstreams.length,
    totalDownstream: downstreams.length
  };
}

// ─── 容器操作 ───────────────────────────────────────────────
function getContainerName(c) {
  return Array.isArray(c.names) ? c.names[0] : (c.name || c.shortId);
}

export async function startContainer(sourceId, containerId, config = {}) {
  const docker = getDocker(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.start();
  return { ok: true, message: '容器已启动' };
}

export async function stopContainer(sourceId, containerId, config = {}) {
  const docker = getDocker(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.stop({ t: 10 });
  return { ok: true, message: '容器已停止' };
}

export async function restartContainer(sourceId, containerId, config = {}) {
  const docker = getDocker(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.restart({ t: 10 });
  return { ok: true, message: '容器已重启' };
}

export async function pauseContainer(sourceId, containerId, config = {}) {
  const docker = getDocker(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.pause();
  return { ok: true, message: '容器已暂停' };
}

export async function unpauseContainer(sourceId, containerId, config = {}) {
  const docker = getDocker(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.unpause();
  return { ok: true, message: '容器已恢复' };
}

export async function removeContainer(sourceId, containerId, config = {}) {
  const docker = getDocker(sourceId, config);
  const container = docker.getContainer(containerId);
  await container.remove({ force: true });
  return { ok: true, message: '容器已删除' };
}

export async function execInContainer(sourceId, containerId, cmd, config = {}) {
  const docker = getDocker(sourceId, config);
  const container = docker.getContainer(containerId);
  // cmd: string or string[]
  const command = Array.isArray(cmd) ? cmd : cmd.split(' ');
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve, reject) => {
    let output = '';
    stream.on('data', chunk => { output += chunk.toString(); });
    stream.on('end', () => resolve({ output, exitCode: 0 }));
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
      console.warn(`[healthCheck] 跳过 ${src.name}:`, err.message);
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
        errors: [`无法获取日志: ${err.message}`],
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
    const docker = getDocker(sourceId, config);
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
      console.error(`[Docker Events] ${config.name}:`, err.message);
      eventWatchers.delete(sourceId);
    });

    stream.on('end', () => {
      console.log(`[Docker Events] ${config.name} 事件流结束`);
      eventWatchers.delete(sourceId);
    });
  } catch (err) {
    console.error(`[Docker Events] ${config.name} 启动失败:`, err.message);
    // 不支持 events 的 Docker 版本静默跳过
    if (!err.message.includes('400')) {
      console.warn(`[Docker Events] ${config.name}: ${err.message}`);
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
      const docker = getDocker(src.id, src);
      const containers = await listContainers(src.id, src);
      const runningContainers = containers.filter(c => c.state === 'running');
      const logPaths = (src.logPaths && src.logPaths.length > 0) ? src.logPaths : null;

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

          // 按等级过滤
          const matchedLines = allNew.filter(l => {
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
      console.warn(`[Patrol] 跳过 ${src.name}:`, err.message);
    }
  }));

  return results;
}
