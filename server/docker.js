import Docker from 'dockerode';
import path from 'path';

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
        lines.push({ timestamp: currentTimestamp, line: parts[2] });
      } else if (currentTimestamp) {
        lines.push({ timestamp: currentTimestamp, line: data.trim() });
      } else {
        lines.push({ timestamp: new Date().toISOString(), line: data.trim() });
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
