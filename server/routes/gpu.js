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

const router = express.Router();

// ─── GPU 监控路由 ─────────────────────────────────────────────────────────

// 本地 GPU 缓存（避免每次请求都 SSH）
let gpuCache = { devices: [], summary: null, time: 0 };
const GPU_CACHE_TTL = 10000; // 10 秒缓存

// 获取 GPU 列表（本地）
router.get('/api/gpu/local', async (req, res) => {
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
router.get('/api/gpu/configs', (req, res) => {
  res.json({ configs: gpu.loadGPUConfigs() });
});

router.post('/api/gpu/configs', (req, res) => {
  try {
    const { configs } = req.body;
    gpu.saveGPUConfigs(configs);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;
