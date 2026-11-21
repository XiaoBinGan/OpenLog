/**
 * routes/gpu.js — GPU 监控路由
 *
 * 从 server/index.js 抽出。这 6 个路由只依赖 gpu / remote / gpu-host-ssh 三个模块，
 * 不引用 index.js 的任何内部状态，因此可以整体搬出而不需要注入上下文。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import * as gpu from '../gpu.js';
import * as remote from '../remote.js';
import { queryHostGpu } from '../gpu-host-ssh.js';
import { isDemoMode, DEMO_DISABLED } from '../demo/mode.js';
import * as demoFixtures from '../demo/fixtures.js';

const router = express.Router();

// ─── 演示模式（OPENLOG_DEMO=1）────────────────────────────────────────
// 数据只来自 server/demo/fixtures.js（命名空间导入，导出缺失不会在链接阶段崩整条路由）。
// 关闭演示模式时下面的分支都不会进，原有缓存/SSH 逻辑保持原样。

/** 给模拟响应打上 demo:true 标记（契约：演示数据必须可识别） */
function demoJson(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return { demo: true, ...payload };
  return { demo: true, data: payload };
}

/** 取一份演示数据；fixture 缺失/抛错时返回 undefined，让端点降级而非 500 */
function demoValue(name, ...args) {
  const fn = demoFixtures[name];
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch (err) {
    console.warn(`[demo] ${name} 调用失败:`, errorMessage(err));
    return undefined;
  }
}

/** 演示模式下的 GPU 负载：{ devices, summary } —— 与真实端点响应同形 */
function demoGpuDevices(serverId) {
  const data = demoValue('demoGpuPayload', serverId ? { serverId } : {});
  const devices = Array.isArray(data) ? data : (data?.devices || []);
  const summary = (data && !Array.isArray(data) && data.summary) || demoValue('demoGpuSummary') || null;
  return { devices, summary };
}

// ─── GPU 监控路由 ─────────────────────────────────────────────────────────

// 本地 GPU 缓存（避免每次请求都 SSH）
let gpuCache = { devices: [], summary: null, time: 0 };
const GPU_CACHE_TTL = 10000; // 10 秒缓存

// 获取 GPU 列表（本地）
router.get('/api/gpu/local', async (req, res) => {
  // 演示模式：不读本机 nvidia-smi、不走宿主机 SSH
  if (isDemoMode()) return res.json(demoJson(demoGpuDevices()));
  try {
    // 返回缓存（10 秒内）
    if (Date.now() - gpuCache.time < GPU_CACHE_TTL && gpuCache.devices.length > 0) {
      return res.json({ devices: gpuCache.devices, summary: gpuCache.summary });
    }
    let devices = await gpu.getLocalGPUs();
    // Docker容器内 nvidia-smi 不可用，尝试 SSH 到宿主机
    // 凭据来自环境变量；未配置时 queryHostGpu() 返回 []（不再有硬编码后备值）
    if (devices.length === 0 && process.env.NODE_ENV === 'production') {
      const viaSsh = await queryHostGpu();
      if (viaSsh.length > 0) devices = viaSsh;
    }
    const summary = gpu.getGPUSummary(devices);
    gpuCache = { devices, summary, time: Date.now() };
    res.json({ devices, summary });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 获取 GPU 列表（远程）— 通过已连接的远程服务器
// 注意：nvidia-smi 的 --query-compute-apps 不支持 gpu_index 字段，
// 必须查 gpu_uuid 再用 uuid→index 映射；解析/汇总逻辑见 gpu.js。
const REMOTE_GPU_QUERY = 'nvidia-smi --query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>&1';
const REMOTE_PROC_QUERY = 'nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>&1';

router.get('/api/gpu/remote-server/:serverId', async (req, res) => {
  // 演示模式：不向远程服务器发 nvidia-smi
  if (isDemoMode()) return res.json(demoJson(demoGpuDevices(req.params.serverId)));
  try {
    const { serverId } = req.params;

    const gpuResult = await remote.execRemoteCommand(serverId, REMOTE_GPU_QUERY);
    if (gpuResult?.error) throw new Error(gpuResult.error);

    // 进程查询失败（无进程 / nvidia-smi 版本差异）不应让整个接口失败
    let procStdout = '';
    try {
      const procResult = await remote.execRemoteCommand(serverId, REMOTE_PROC_QUERY);
      if (!procResult?.error) procStdout = procResult?.stdout || '';
    } catch { /* 进程信息可缺省 */ }

    const { devices, summary } = gpu.buildRemoteGPUPayload(gpuResult.stdout || '', procStdout);
    res.json({ devices, summary });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});
router.get('/api/gpu/remote', async (req, res) => {
  // 演示模式：不建 SSH 连接（保留 host/sshUser 的入参校验在下面真实分支里）
  if (isDemoMode()) return res.json(demoJson(demoGpuDevices(req.query?.serverId)));
  try {
    const { host, sshUser, sshPassword, sshKeyPath, sshPort } = req.query;
    if (!host || !sshUser) return res.status(400).json({ error: 'host and sshUser required' });
    const devices = await gpu.getRemoteGPUs(host, sshUser, sshPassword, sshKeyPath, parseInt(sshPort) || 22);
    const summary = gpu.getGPUSummary(devices);
    res.json({ devices, summary });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 通用 GPU 查询（自动本地/远程）
router.post('/api/gpu/query', async (req, res) => {
  // 演示模式：GPU 查询只回 fixture（POST 只是查询语义，不算写操作）
  if (isDemoMode()) return res.json(demoJson(demoGpuDevices(req.body?.serverId)));
  try {
    const { remote: isRemote, host, sshUser, sshPassword, sshKeyPath, sshPort } = req.body;
    const devices = await gpu.getGPUs({ remote: isRemote, host, sshUser, sshPassword, sshKeyPath, sshPort });
    const summary = gpu.getGPUSummary(devices);
    res.json({ devices, summary });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 保存 / 加载 GPU 配置
// 说明：同一份配置里除 GPU 静态信息外，也承载「MFU 指标源」。
// apiKey 属于凭据，GET 一律脱敏；POST 收到含 *** 的值视为「不修改」。
router.get('/api/gpu/configs', (req, res) => {
  res.json({ configs: gpu.maskGpuConfigs(gpu.loadGPUConfigs()) });
});

router.post('/api/gpu/configs', (req, res) => {
  // 演示模式：设置写入（GPU 配置 / MFU 指标源）一律禁用，绝不落盘
  if (isDemoMode()) return res.status(409).json(DEMO_DISABLED);
  try {
    const incoming = Array.isArray(req.body?.configs) ? req.body.configs : [];
    const merged = gpu.mergeGpuConfigs(incoming, gpu.loadGPUConfigs() || []);
    gpu.saveGPUConfigs(merged);
    res.json({ ok: true, configs: gpu.maskGpuConfigs(merged) });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;
