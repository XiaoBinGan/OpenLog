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
router.get('/api/gpu/remote-server/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    // 获取 GPU 基本状态
    const result = await remote.execRemoteCommand(serverId, 'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>&1');
    if (result.error) throw new Error(result.error);
    const lines = (result.stdout || '').trim().split('\n').filter(l => l.trim());

    // 获取进程信息
    const procResult = await remote.execRemoteCommand(serverId, 'nvidia-smi --query-compute-apps=pid,gpu_index,process_name,used_memory --format=csv,noheader,nounits 2>&1');
    const procLines = (procResult.stdout || '').trim().split('\n').filter(l => l.trim());
    const processesByGpu = {};
    for (const pline of procLines) {
      const pparts = pline.split(',').map(s => s.trim());
      const gpuIdx = parseInt(pparts[1]) || 0;
      if (!processesByGpu[gpuIdx]) processesByGpu[gpuIdx] = [];
      processesByGpu[gpuIdx].push({
        pid: parseInt(pparts[0]) || 0,
        name: pparts[2] || 'unknown',
        usedMemory: parseInt(pparts[3]) || 0,
      });
    }

    const devices = lines.map(line => {
      const parts = line.split(',').map(s => s.trim());
      const idx = parseInt(parts[0]) || 0;
      return {
        index: idx,
        name: parts[1] || 'Unknown',
        util: parseFloat(parts[2]) || 0,
        memUsed: parseInt(parts[3]) || 0,
        memTotal: parseInt(parts[4]) || 0,
        temp: parseFloat(parts[5]) || 0,
        processes: processesByGpu[idx] || [],
      };
    });
    const summary = gpu.getGPUSummary(devices);
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
