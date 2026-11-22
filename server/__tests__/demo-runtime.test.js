/**
 * demo-runtime.test.js —— 演示模式的「运行态面板」（监控 + 分析历史）
 *
 * 覆盖的端点（都在 server/routes/{monitor,analysis}.js）：
 *   读：GET /api/monitor/stats、GET /api/monitor/history、
 *       GET /api/analysis/status、GET /api/analysis/history、GET /api/analysis/history/brief
 *   写：POST  /api/analysis/trigger、DELETE /api/analysis/history/:id、DELETE /api/analysis/history
 *
 * 这个文件要证明三件事，少一件演示模式就不算做对：
 *   1. **演示模式下真实依赖一次都不碰**。`collectSystemStats()` 的真实依赖是
 *      systeminformation（si.currentLoad / mem / fsSize / networkStats / processes）、
 *      本机 nvidia-smi（execFileSync）和宿主机 SSH（queryHostGpu）。这三组全部打桩，
 *      演示分支跑完断言调用次数为 0 —— 否则「演示模式」在别人机器上依然会去连
 *      2375 端口、跑 nvidia-smi、读真机器的 /proc。
 *   2. **形状没被演示数据带歪**。monitor/history 的元素是数字（`cpu`），不是
 *      stats 的 `{load,cores}` —— 前端 `dataKey="cpu"` 直接画数字，形状错了会在
 *      真实数据回来时白屏，而那条路径平时没人跑。
 *   3. **关掉开关完全回到原行为**：真实依赖被调用、响应里没有 `demo` 字段、
 *      写操作真的会写（enqueueAnalysis 被调用、数组真的被删）。演示模式的
 *      每一条 guard 都必须是「只多不少」——关闭时行为与改动前逐字节一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';

// ─── 真实依赖打桩（演示模式下应保持 0 次调用）─────────────────────────────

const siMock = {
  currentLoad: vi.fn(),
  mem: vi.fn(),
  fsSize: vi.fn(),
  networkStats: vi.fn(),
  processes: vi.fn(),
  time: vi.fn(),
};
vi.mock('systeminformation', () => ({ default: siMock, ...siMock }));

const gpuHostSshMock = { queryHostGpu: vi.fn(async () => []) };
vi.mock('../gpu-host-ssh.js', () => gpuHostSshMock);

const execFileSyncMock = vi.fn(() => {
  throw new Error('nvidia-smi not found');
});
vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  default: { execFileSync: execFileSyncMock },
}));

const { default: createMonitorRouter } = await import('../routes/monitor.js');
const { default: createAnalysisRouter } = await import('../routes/analysis.js');
const { DEMO_NOW } = await import('../demo/fixtures-runtime.js');

// ─── 测试脚手架 ────────────────────────────────────────────────────────────

/** 与 index.js 的挂载方式一致：两个工厂 + 各自的注入依赖 */
async function startApp({
  monitorHistory = [],
  analysisHistory = [],
  queues = new Map(),
  enqueueAnalysis = vi.fn(),
  ensureSettings = () => ({}),
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(createMonitorRouter({ monitorHistory, ensureSettings }));
  app.use(createAnalysisRouter({ analysisQueues: queues, analysisHistory, enqueueAnalysis }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, init) => {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };

  return { base, call, close: () => new Promise((r) => server.close(r)) };
}

/** 一条真实的日志分析记录（形状照 index.js#runAnalysis 里 addAnalysisRecord 的入参） */
const REAL_LOG_RECORD = {
  id: 'real-1',
  timestamp: '2026-01-02T03:04:05.000Z',
  sourceId: 'real-src',
  sourceName: '真实日志',
  log: { id: 'log-1', timestamp: '2026-01-02T03:04:00.000Z', level: 'ERROR', message: '真实错误', source: '/tmp/real.log' },
  analysis: '## 根因分析\n真实结论',
  status: 'done',
  model: 'real-model',
};

/** 一条真实的巡检记录（形状照 routes/docker.js 的 addAnalysisRecord 入参，带 type/summary） */
const REAL_PATROL_RECORD = {
  id: 'real-2',
  timestamp: '2026-01-02T03:10:00.000Z',
  type: 'patrol',
  sourceName: '容器巡检 · 3 个容器',
  analysis: '巡检结论',
  summary: '巡检摘要',
  status: 'done',
  model: 'real-model',
};

/** 演示模式下必须 0 调用的真实依赖 */
function expectNoRealDependencies() {
  for (const [name, fn] of Object.entries(siMock)) {
    expect(fn, `systeminformation.${name} 不应被调用`).not.toHaveBeenCalled();
  }
  expect(execFileSyncMock, 'nvidia-smi 不应被调用').not.toHaveBeenCalled();
  expect(gpuHostSshMock.queryHostGpu, '宿主机 SSH 不应被调用').not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const fn of Object.values(siMock)) fn.mockReset();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(() => { throw new Error('nvidia-smi not found'); });
  gpuHostSshMock.queryHostGpu.mockReset();
  gpuHostSshMock.queryHostGpu.mockResolvedValue([]);

  // 真实分支（开关关掉时）用得到的桩数据
  siMock.currentLoad.mockResolvedValue({ currentLoad: 12.5, cpus: [{ load: 10 }, { load: 15 }] });
  siMock.mem.mockResolvedValue({ used: 2e9, total: 8e9, free: 6e9 });
  siMock.fsSize.mockResolvedValue([{ fs: '/dev/sda3', used: 1e9, size: 4e9, use: 25 }]);
  siMock.networkStats.mockResolvedValue([{ iface: 'eth0', rx_sec: 1000, tx_sec: 500 }]);
  siMock.processes.mockResolvedValue({ list: [{ pid: 1, name: 'realp', cpu: 1, mem: 2 }], all: 99 });
  siMock.time.mockReturnValue({ uptime: 86400 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 演示模式：读端点 ─────────────────────────────────────────────────────

describe('演示模式 · GET /api/monitor/stats', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('返回这台演示机器的快照，带 demo 标记，且不碰任何真实依赖', async () => {
    const { call, close } = await startApp();
    try {
      const r = await call('/api/monitor/stats');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);

      // 64 核 / 128 GiB / 2 块盘 / eth0 / 8 个进程 / 4×4090 / 无容量告警
      expect(r.body.cpu.cores).toHaveLength(64);
      expect(typeof r.body.cpu.load).toBe('number');
      expect(r.body.memory.total).toBe(128 * 1024 ** 3);
      expect(r.body.memory.used).toBeLessThan(r.body.memory.total);
      expect(r.body.memory.percent).toBeGreaterThan(0);
      expect(r.body.disk).toHaveLength(2);
      for (const d of r.body.disk) {
        expect(Object.keys(d).sort()).toEqual(['name', 'total', 'usePercent', 'used']);
        expect(d.used).toBeLessThan(d.total);
      }
      expect(r.body.network).toHaveLength(1);
      expect(r.body.network[0]).toMatchObject({ iface: 'eth0' });
      expect(r.body.processes).toHaveLength(8);
      expect(r.body.gpus).toHaveLength(4);
      // 本机 nvidia-smi 分支只有 5 个字段，没有 processes（那是远程分支的形状）
      for (const g of r.body.gpus) {
        expect(Object.keys(g).sort()).toEqual(['index', 'memTotal', 'memUsed', 'name', 'temp', 'util']);
        expect(g.name).toBe('NVIDIA GeForce RTX 4090');
        expect(g.memUsed).toBeLessThanOrEqual(g.memTotal);
      }
      expect(r.body.capacityAlerts).toEqual([]);
      expect(r.body.capacityThresholds).toEqual({ memoryPercent: 90, diskPercent: 80 });
      expect(r.body.capacitySnoozeMinutes).toBe(60);
      expect(r.body.processCount).toBeGreaterThan(r.body.processes.length);
      expect(typeof r.body.uptime).toBe('number');

      expectNoRealDependencies();
    } finally { await close(); }
  });

  it('是确定性的：两次调用 deepEqual', async () => {
    const { call, close } = await startApp();
    try {
      const a = await call('/api/monitor/stats');
      const b = await call('/api/monitor/stats');
      expect(a.body).toEqual(b.body);
    } finally { await close(); }
  });
});

describe('演示模式 · GET /api/monitor/history', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('返回 60 点确定性曲线，元素是折线图简化形状（cpu 是数字）', async () => {
    const { call, close } = await startApp({ monitorHistory: [{ should: 'not-be-used' }] });
    try {
      const r = await call('/api/monitor/history');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body).toHaveLength(60);

      const point = r.body[0];
      // 数组响应体挂不了 demo 标记 → 逐条带（同 /api/logs/files 的处理方式）
      expect(point.demo).toBe(true);
      expect(Object.keys(point).sort()).toEqual(
        ['cpu', 'demo', 'disk', 'gpuUtil', 'memory', 'network', 'timestamp'],
      );
      expect(typeof point.cpu).toBe('number');
      expect(typeof point.memory).toBe('number');
      expect(typeof point.disk).toBe('number');
      expect(typeof point.network).toBe('number');
      expect(typeof point.gpuUtil).toBe('number');
      // 时间来自固定锚点，不是 Date.now()
      expect(point.timestamp <= DEMO_NOW).toBe(true);
      // 最新一点在最后，且不晚于锚点
      expect(r.body[59].timestamp).toBe(DEMO_NOW);

      expectNoRealDependencies();
    } finally { await close(); }
  });

  it('limit 生效，且非法 limit 不返回空', async () => {
    const { call, close } = await startApp();
    try {
      const few = await call('/api/monitor/history?limit=12');
      expect(few.body).toHaveLength(12);
      const bad = await call('/api/monitor/history?limit=abc');
      expect(bad.status).toBe(200);
      expect(bad.body).toHaveLength(60);
    } finally { await close(); }
  });

  it('两次调用 deepEqual', async () => {
    const { call, close } = await startApp();
    try {
      const a = await call('/api/monitor/history?limit=30');
      const b = await call('/api/monitor/history?limit=30');
      expect(a.body).toEqual(b.body);
    } finally { await close(); }
  });
});

describe('演示模式 · GET /api/analysis/*', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('GET /api/analysis/history → { records, total }，记录形状照 addAnalysisRecord', async () => {
    const { call, close } = await startApp({ analysisHistory: [REAL_LOG_RECORD] });
    try {
      const r = await call('/api/analysis/history');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(r.body.total).toBe(6);
      expect(r.body.records).toHaveLength(6);
      // 演示数据没有污染注入的真实数组
      expect(r.body.records[0].id).not.toBe(REAL_LOG_RECORD.id);

      const hasLog = r.body.records.filter((x) => x.log);
      const hasSummary = r.body.records.filter((x) => x.type);
      expect(hasLog.length).toBeGreaterThan(0);
      expect(hasSummary.length).toBeGreaterThan(0);
      for (const rec of r.body.records) {
        expect(Object.keys(rec)).toEqual(expect.arrayContaining(['id', 'timestamp', 'sourceName', 'analysis', 'status', 'model']));
        expect(['done', 'error']).toContain(rec.status);
      }
      // 贴近 GPU 推理运维：OOM / 首 token / 掉卡 这些真实故障
      const text = JSON.stringify(r.body.records);
      expect(text).toContain('CUDA out of memory');
      expect(text).toContain('TTFT');

      expectNoRealDependencies();
    } finally { await close(); }
  });

  it('过滤与分页语义与真实实现一致（total 是过滤后、分页前）', async () => {
    const { call, close } = await startApp();
    try {
      const errs = await call('/api/analysis/history?status=error');
      expect(errs.body.total).toBe(1);
      expect(errs.body.records).toHaveLength(1);
      expect(errs.body.records[0].status).toBe('error');

      const bySource = await call('/api/analysis/history?sourceId=log-vllm-engine');
      expect(bySource.body.total).toBe(2);
      for (const rec of bySource.body.records) expect(rec.sourceId).toBe('log-vllm-engine');

      const paged = await call('/api/analysis/history?limit=2&offset=1');
      expect(paged.body.total).toBe(6);
      expect(paged.body.records).toHaveLength(2);
    } finally { await close(); }
  });

  it('GET /api/analysis/history/brief → 字段严格是 7 个，summary 截 120 字', async () => {
    const { call, close } = await startApp({ analysisHistory: [REAL_PATROL_RECORD] });
    try {
      const r = await call('/api/analysis/history/brief');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(r.body.records.length).toBeGreaterThan(0);
      for (const rec of r.body.records) {
        expect(Object.keys(rec).sort()).toEqual(
          ['id', 'model', 'sourceName', 'status', 'summary', 'timestamp', 'type'],
        );
        expect(rec.summary.length).toBeLessThanOrEqual(120);
        expect(typeof rec.type).toBe('string');
      }
      // 与 history 自洽：同一 id 的 type/summary 能从 history 的记录推出来
      const full = await call('/api/analysis/history');
      const byId = new Map(full.body.records.map((x) => [x.id, x]));
      for (const rec of r.body.records) {
        const origin = byId.get(rec.id);
        expect(origin).toBeTruthy();
        expect(rec.type).toBe(origin.type || 'log');
        expect(rec.summary).toBe((origin.summary || origin.log?.message || '').slice(0, 120));
      }
      expectNoRealDependencies();
    } finally { await close(); }
  });

  it('GET /api/analysis/status → 演示队列非空', async () => {
    const { call, close } = await startApp();
    try {
      const r = await call('/api/analysis/status');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(Object.keys(r.body.queues).length).toBeGreaterThan(0);
      expect(r.body.totalPending).toBeGreaterThan(0);
    } finally { await close(); }
  });
});

// ─── 演示模式：写端点一律 409 ─────────────────────────────────────────────

describe('演示模式 · 写操作全部 409 DEMO_DISABLED', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('POST /api/analysis/trigger → 409，不排队、不写历史', async () => {
    const enqueueAnalysis = vi.fn();
    const analysisHistory = [];
    const { call, close } = await startApp({ analysisHistory, enqueueAnalysis });
    try {
      const r = await call('/api/analysis/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'CUDA out of memory', sourceId: 'x' }),
      });
      expect(r.status).toBe(409);
      expect(r.body.demo).toBe(true);
      expect(r.body.error).toContain('演示模式');
      expect(enqueueAnalysis).not.toHaveBeenCalled();
      expect(analysisHistory).toHaveLength(0);
    } finally { await close(); }
  });

  it('DELETE /api/analysis/history/:id → 409，真实记录不被删', async () => {
    const analysisHistory = [{ ...REAL_LOG_RECORD }];
    const { call, close } = await startApp({ analysisHistory });
    try {
      const r = await call(`/api/analysis/history/${REAL_LOG_RECORD.id}`, { method: 'DELETE' });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ demo: true, error: '演示模式：该操作已被禁用' });
      expect(analysisHistory).toHaveLength(1);
    } finally { await close(); }
  });

  it('DELETE /api/analysis/history → 409，历史不被清空', async () => {
    const analysisHistory = [{ ...REAL_LOG_RECORD }, { ...REAL_PATROL_RECORD }];
    const { call, close } = await startApp({ analysisHistory });
    try {
      const r = await call('/api/analysis/history', { method: 'DELETE' });
      expect(r.status).toBe(409);
      expect(r.body.demo).toBe(true);
      expect(analysisHistory).toHaveLength(2);
    } finally { await close(); }
  });
});

// ─── 关闭开关：回到真实分支 ───────────────────────────────────────────────

describe('关闭 OPENLOG_DEMO 时走真实分支（行为与改动前一致）', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '0'));

  it('GET /api/monitor/stats 调用真实采集，响应无 demo 字段', async () => {
    const { call, close } = await startApp({ ensureSettings: () => ({ capacityAlertEnabled: false }) });
    try {
      const r = await call('/api/monitor/stats');
      expect(r.status).toBe(200);
      expect(r.body).not.toHaveProperty('demo');

      expect(siMock.currentLoad).toHaveBeenCalledTimes(1);
      expect(siMock.mem).toHaveBeenCalledTimes(1);
      expect(siMock.fsSize).toHaveBeenCalledTimes(1);
      expect(siMock.networkStats).toHaveBeenCalledTimes(1);
      expect(siMock.processes).toHaveBeenCalledTimes(1);
      expect(execFileSyncMock).toHaveBeenCalledTimes(1); // 本机 nvidia-smi 分支真的跑了
      // 形状来自桩数据而不是 fixture
      expect(r.body.cpu.load).toBe(12.5);
      expect(r.body.cpu.cores).toEqual([10, 15]);
      expect(r.body.processes).toEqual([{ pid: 1, name: 'realp', cpu: 1, mem: 2 }]);
      expect(r.body.disk).toEqual([{ name: '/dev/sda3', used: 1e9, total: 4e9, usePercent: 25 }]);
      expect(r.body.gpus).toEqual([]);
      expect(r.body.processCount).toBe(99);
    } finally { await close(); }
  });

  it('GET /api/monitor/history 返回注入的真实数组（不返回 fixture）', async () => {
    const monitorHistory = [{ ts: 3 }, { ts: 2 }, { ts: 1 }];
    const { call, close } = await startApp({ monitorHistory });
    try {
      const r = await call('/api/monitor/history');
      expect(r.body).toEqual([{ ts: 3 }, { ts: 2 }, { ts: 1 }]);
      const few = await call('/api/monitor/history?limit=1');
      expect(few.body).toEqual([{ ts: 3 }]);
    } finally { await close(); }
  });

  it('GET /api/analysis/history 与 brief 读注入的真实数组', async () => {
    const analysisHistory = [{ ...REAL_LOG_RECORD }, { ...REAL_PATROL_RECORD }];
    const { call, close } = await startApp({ analysisHistory });
    try {
      const full = await call('/api/analysis/history');
      expect(full.status).toBe(200);
      expect(full.body).not.toHaveProperty('demo');
      expect(full.body.total).toBe(2);
      expect(full.body.records.map((r) => r.id)).toEqual(['real-1', 'real-2']);

      const brief = await call('/api/analysis/history/brief');
      expect(brief.body).not.toHaveProperty('demo');
      expect(brief.body.records).toEqual([
        { id: 'real-1', timestamp: REAL_LOG_RECORD.timestamp, type: 'log', sourceName: '真实日志', summary: '真实错误', status: 'done', model: 'real-model' },
        { id: 'real-2', timestamp: REAL_PATROL_RECORD.timestamp, type: 'patrol', sourceName: '容器巡检 · 3 个容器', summary: '巡检摘要', status: 'done', model: 'real-model' },
      ]);

      const status = await call('/api/analysis/status');
      expect(status.body).not.toHaveProperty('demo');
      expect(status.body).toEqual({ queues: {}, totalPending: 0 });
    } finally { await close(); }
  });

  it('写操作真的生效：trigger 入队、DELETE 删记录', async () => {
    const enqueueAnalysis = vi.fn();
    const analysisHistory = [{ ...REAL_LOG_RECORD }];
    const { call, close } = await startApp({ analysisHistory, enqueueAnalysis });
    try {
      const trig = await call('/api/analysis/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '真实错误', sourceId: 'real-src', sourceName: '真实日志' }),
      });
      expect(trig.status).toBe(200);
      expect(trig.body.success).toBe(true);
      expect(enqueueAnalysis).toHaveBeenCalledTimes(1);
      expect(enqueueAnalysis.mock.calls[0][0].message).toBe('真实错误');

      // 缺 message 仍然是原来的 400（演示 guard 不应改变校验顺序）
      const bad = await call('/api/analysis/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);
      expect(enqueueAnalysis).toHaveBeenCalledTimes(1);

      const del = await call('/api/analysis/history/real-1', { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(del.body.success).toBe(true);
      expect(analysisHistory).toHaveLength(0);

      const missing = await call('/api/analysis/history/nope', { method: 'DELETE' });
      expect(missing.status).toBe(404);
    } finally { await close(); }
  });
});

// ─── fixture 自身：确定性 ─────────────────────────────────────────────────

describe('fixtures-runtime 自身是确定性纯函数', () => {
  it('同参数多次调用 deepEqual（含时间字段）', async () => {
    const fx = await import('../demo/fixtures-runtime.js');
    expect(fx.demoLocalStats()).toEqual(fx.demoLocalStats());
    expect(fx.demoMonitorHistory(30)).toEqual(fx.demoMonitorHistory(30));
    expect(fx.demoAnalysisHistory({ status: 'done' })).toEqual(fx.demoAnalysisHistory({ status: 'done' }));
    expect(fx.demoAnalysisBrief()).toEqual(fx.demoAnalysisBrief());
    expect(fx.demoAnalysisStatus()).toEqual(fx.demoAnalysisStatus());
  });

  it('返回的是副本：调用方改动不污染下一次调用', async () => {
    const fx = await import('../demo/fixtures-runtime.js');
    const first = fx.demoAnalysisHistory();
    first.records[0].sourceName = '被改坏了';
    first.records.length = 0;
    const second = fx.demoAnalysisHistory();
    expect(second.records).toHaveLength(6);
    expect(second.records[0].sourceName).not.toBe('被改坏了');
  });
});
