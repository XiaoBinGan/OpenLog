/**
 * routes/monitor.js — 系统监控路由
 *
 * 从 server/index.js 抽出。`monitorHistory` 由 index.js 的监控定时器写入，
 * 这里只读取，因此通过工厂函数显式注入，而不是重新引入隐式全局耦合。
 *
 * 修复记录：原实现里 GPU 查询写的是 `const { execSync } = require('child_process')`，
 * 但本包是 `"type": "module"`，ESM 中没有 `require` —— 该行必然抛 ReferenceError，
 * 又被外层 try/catch 静默吞掉，导致本地 nvidia-smi 分支从未生效过
 * （/api/monitor/stats 永远返回 gpus: []）。这里改用顶层 ESM import，
 * 并用 execFileSync + 参数数组，不经 shell。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import { execFileSync } from 'child_process';
import * as si from 'systeminformation';
import { queryHostGpu } from '../gpu-host-ssh.js';
import { dedupeDisks } from '../disk-utils.js';
import { evaluateCapacityAlerts, normalizeThresholds } from '../capacity-alerts.js';

const NO_CACHE_HEADERS = (res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
};

const QUERY_GPUS = 'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,'
  + 'memory.total,temperature.gpu --format=csv,noheader,nounits';

/** 本机 nvidia-smi。不在 PATH 或无 GPU 时返回 []。 */
function readLocalGpus() {
  try {
    const out = execFileSync('nvidia-smi', [
      '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map((line) => {
      const [idx, name, util, memUsed, memTotal, temp] = line.split(',').map((s) => s.trim());
      return {
        index: parseInt(idx) || 0,
        name: name || '',
        util: parseFloat(util) || 0,
        memUsed: parseFloat(memUsed) || 0,
        memTotal: parseFloat(memTotal) || 1,
        temp: parseFloat(temp) || 0,
      };
    });
  } catch {
    return [];
  }
}

export default function createMonitorRouter({ monitorHistory, ensureSettings }) {
  const router = express.Router();

  router.get('/api/monitor/stats', async (req, res) => {
    NO_CACHE_HEADERS(res);
    try {
      const [cpu, mem, disks, network, processes] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.networkStats(),
        si.processes(),
      ]);

      let gpus = readLocalGpus();

      // 容器内 nvidia-smi 不可用，SSH 到宿主机查询。
      // 凭据来自环境变量；未配置时 queryHostGpu() 返回 []（不再有硬编码后备值）。
      if (gpus.length === 0 && process.env.NODE_ENV === 'production') {
        const viaSsh = await queryHostGpu();
        if (viaSsh.length > 0) gpus = viaSsh;
      }

      const memoryPercent = mem.total > 0 ? (mem.used / mem.total) * 100 : 0;
      const diskList = dedupeDisks(disks.map((d) => ({ name: d.fs, used: d.used, total: d.size, usePercent: d.use })));

      // 容量告警：服务端**无条件如实报告**，不在这里记「提醒过没有」。
      // 抑制重复弹窗是浏览器本地状态（localStorage），由前端负责 ——
      // 这样刷新页面、开新标签页都不会出现「关过了又弹」或「明明超标却不弹」。
      const settings = typeof ensureSettings === 'function' ? (ensureSettings() || {}) : {};
      const thresholds = normalizeThresholds({
        memoryPercent: settings.capacityAlertMemoryPercent,
        diskPercent: settings.capacityAlertDiskPercent,
      });
      const capacityAlerts = settings.capacityAlertEnabled === false
        ? []
        : evaluateCapacityAlerts({ memoryPercent, disks: diskList }, thresholds);

      res.json({
        cpu: { load: cpu.currentLoad || 0, cores: cpu.cpus.map((c) => c.load) },
        memory: {
          used: mem.used || 0,
          total: mem.total || 1,
          free: mem.free || 0,
          percent: Math.round(memoryPercent * 10) / 10,
        },
        // 容器里同一块盘会被 bind mount 重复列出（T4 上 /dev/sda3 出现过 6 次），
        // 不去重的话前端把 6 条加起来会显示 476.9%。这里统一收敛成"一块盘一条"。
        disk: diskList,
        network: network.map((n) => ({ iface: n.iface, rx: n.rx_sec, tx: n.tx_sec })),
        processes: processes.list.slice(0, 10).map((p) => ({ pid: p.pid, name: p.name, cpu: p.cpu, mem: p.mem })),
        gpus,
        // 容量告警（内存 > 阈值、任一磁盘 > 阈值）。没有告警时是空数组，不是 undefined。
        capacityAlerts,
        capacityThresholds: thresholds,
        capacitySnoozeMinutes: Number(settings.capacityAlertSnoozeMinutes) > 0
          ? Number(settings.capacityAlertSnoozeMinutes)
          : 60,
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get('/api/monitor/history', (req, res) => {
    NO_CACHE_HEADERS(res);
    // limit 必须是「正整数」才算数。原来直接 `parseInt(limit)`：
    // 传 `?limit=abc` → NaN → `slice(0, NaN)` = []，用户会以为历史记录丢了。
    // 非法值退回默认 100，而不是返回空列表；上限 5000 防一次性拉爆。
    const raw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 100;
    const result = monitorHistory.slice(0, limit);
    res.json(result);
  });

  return router;
}
