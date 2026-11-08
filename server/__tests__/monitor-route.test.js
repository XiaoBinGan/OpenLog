/**
 * routes/monitor.js —— 系统监控接口（覆盖率 22% 时补的）
 *
 * 这里曾经有过真实事故：GPU 分支用 `require('child_process')` 但在 ESM 包中，
 * 必然抛 ReferenceError，又被外层 try/catch 静默吞掉 —— 结果 `/api/monitor/stats`
 * 的 gpus 永远是 []，看起来像「这台机器没显卡」。
 *
 * 所以测试重点：
 *   - 字段形状稳定（前端按这个渲染）
 *   - 磁盘去重（容器内同一块盘被 bind mount 重复列出，不去重会显示 476.9%）
 *   - GPU 为空时的降级路径不能把整个接口带崩
 *   - history 的 limit 参数要能限流
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

// systeminformation / nvidia-smi / 宿主机 SSH 全部打桩（真跑起来要读真机器）
const siMock = {
  currentLoad: vi.fn(),
  mem: vi.fn(),
  fsSize: vi.fn(),
  networkStats: vi.fn(),
  processes: vi.fn(),
};
vi.mock('systeminformation', () => ({ default: siMock, ...siMock }));

const gpuHostSshMock = { queryHostGpu: vi.fn(async () => []) };
vi.mock('../gpu-host-ssh.js', () => gpuHostSshMock);

// 本机开发环境可能真的有 nvidia-smi（Lead 的机器就有），
// 不打桩的话「GPU 为空」这条用例会被真实硬件破坏。
const execFileSyncMock = vi.fn(() => { throw new Error('nvidia-smi not found'); });
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock, default: { execFileSync: execFileSyncMock } }));

const { default: createMonitorRouter } = await import('../routes/monitor.js');

async function startApp({ monitorHistory = [], deps = {} } = {}) {
  const app = express();
  app.use(createMonitorRouter({ monitorHistory, ...deps }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

beforeEach(() => {
  siMock.currentLoad.mockResolvedValue({ currentLoad: 12.5, cpus: [{ load: 10 }, { load: 15 }] });
  siMock.mem.mockResolvedValue({ used: 2e9, total: 8e9, free: 6e9 });
  siMock.fsSize.mockResolvedValue([{ fs: '/dev/sda3', used: 1e9, size: 4e9, use: 25 }]);
  siMock.networkStats.mockResolvedValue([{ iface: 'eth0', rx_sec: 1000, tx_sec: 500 }]);
  siMock.processes.mockResolvedValue({ list: Array.from({ length: 15 }, (_, i) => ({ pid: i + 1, name: `p${i}`, cpu: i, mem: i })) });
  gpuHostSshMock.queryHostGpu.mockResolvedValue([]);
});

describe('GET /api/monitor/stats', () => {
  it('字段形状：cpu/memory/disk/network/processes/gpus', async () => {
    const { base, close } = await startApp();
    try {
      // 非 production → 不触发宿主机 SSH 兜底
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      const r = await fetch(`${base}/api/monitor/stats`);
      const b = await r.json();
      process.env.NODE_ENV = prev;
      expect(r.status).toBe(200);
      expect(b.cpu).toEqual({ load: 12.5, cores: [10, 15] });
      expect(b.memory).toEqual({ used: 2e9, total: 8e9, free: 6e9 });
      expect(b.disk[0]).toMatchObject({ name: '/dev/sda3', usePercent: 25 });
      expect(b.network[0]).toEqual({ iface: 'eth0', rx: 1000, tx: 500 });
      // 进程只取前 10 条
      expect(b.processes).toHaveLength(10);
      expect(Array.isArray(b.gpus)).toBe(true);
    } finally { await close(); }
  });

  it('禁止缓存头必须发出去（否则页面看到的是旧数据）', async () => {
    const { base, close } = await startApp();
    try {
      const r = await fetch(`${base}/api/monitor/stats`);
      expect(r.headers.get('cache-control')).toContain('no-store');
    } finally { await close(); }
  });

  it('同一块盘被 bind mount 重复列出时去重（否则前端相加会显示 476.9%）', async () => {
    siMock.fsSize.mockResolvedValue([
      { fs: '/dev/sda3', used: 1e9, size: 4e9, use: 25 },
      { fs: '/dev/sda3', used: 1e9, size: 4e9, use: 25 },
      { fs: '/dev/sda3', used: 1e9, size: 4e9, use: 25 },
    ]);
    const { base, close } = await startApp();
    try {
      const b = await (await fetch(`${base}/api/monitor/stats`)).json();
      expect(b.disk).toHaveLength(1);
    } finally { await close(); }
  });

  it('si 抛错 → 500 + error 字段（不是静默返回空对象）', async () => {
    siMock.mem.mockRejectedValue(new Error('mem boom'));
    const { base, close } = await startApp();
    try {
      const r = await fetch(`${base}/api/monitor/stats`);
      expect(r.status).toBe(500);
      const b = await r.json();
      expect(b.error).toContain('mem boom');
    } finally { await close(); }
  });

  it('生产模式下 nvidia-smi 不可用 → 回落宿主机 SSH 查询', async () => {
    gpuHostSshMock.queryHostGpu.mockResolvedValue([{ index: 0, name: 'RTX 4090', util: 30 }]);
    const { base, close } = await startApp();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const b = await (await fetch(`${base}/api/monitor/stats`)).json();
      expect(gpuHostSshMock.queryHostGpu).toHaveBeenCalled();
      expect(b.gpus[0].name).toBe('RTX 4090');
    } finally {
      process.env.NODE_ENV = prev;
      await close();
    }
  });

  it('宿主机 SSH 也拿不到 GPU → gpus 为空数组，接口仍 200', async () => {
    gpuHostSshMock.queryHostGpu.mockResolvedValue([]);
    const { base, close } = await startApp();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const r = await fetch(`${base}/api/monitor/stats`);
      expect(r.status).toBe(200);
      const b = await r.json();
      expect(b.gpus).toEqual([]);
    } finally {
      process.env.NODE_ENV = prev;
      await close();
    }
  });
});

describe('GET /api/monitor/history', () => {
  it('默认取 100 条，limit 可限流', async () => {
    const history = Array.from({ length: 200 }, (_, i) => ({ ts: i }));
    const { base, close } = await startApp({ monitorHistory: history });
    try {
      const all = await (await fetch(`${base}/api/monitor/history`)).json();
      expect(all).toHaveLength(100);
      const few = await (await fetch(`${base}/api/monitor/history?limit=3`)).json();
      expect(few).toHaveLength(3);
      expect(few[0]).toEqual({ ts: 0 });
    } finally { await close(); }
  });

  it('limit 非数字时按默认处理（不返回空、不 500）', async () => {
    const history = [{ ts: 1 }, { ts: 2 }];
    const { base, close } = await startApp({ monitorHistory: history });
    try {
      const r = await fetch(`${base}/api/monitor/history?limit=abc`);
      expect(r.status).toBe(200);
      expect(await r.json()).toHaveLength(2);
    } finally { await close(); }
  });

  it('空历史返回空数组', async () => {
    const { base, close } = await startApp({ monitorHistory: [] });
    try {
      const b = await (await fetch(`${base}/api/monitor/history`)).json();
      expect(b).toEqual([]);
    } finally { await close(); }
  });
});
