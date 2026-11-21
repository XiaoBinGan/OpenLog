/**
 * server/__tests__/demo-fixtures.test.js —— 演示模式数据层测试
 *
 * 演示数据最容易出的两类事故，这里逐条盯住：
 *
 * 1. **形状漂移**：真实路由改了字段名/去掉了字段，演示数据没跟上 ——
 *    前端在演示模式下静默走另一条分支（或白屏），平时没人跑到，线上才发现。
 *    所以每个导出都断言"必填字段存在 + 类型正确 + 数量符合契约"。
 * 2. **不确定**：用了 Math.random()/Date.now()，于是同一个页面刷新两次数字就变。
 *    所以每个导出都断言两次调用 deepEqual。
 *
 * 另外还断言了数据自洽（GPU summary 与卡片一致、MFU 与 tokens/参数量/峰值算力
 * 的公式一致、K8s summary 与 pods 数组一致）—— 演示数据可以假，但不能自相矛盾。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { isDemoMode, DEMO_DISABLED, demoJson } from '../demo/mode.js';
import { parseLogLevel } from '../log-level.js';
import {
  DEMO_NOW,
  TSDB_POINTS,
  demoDockerSources,
  demoDockerLogs,
  demoDockerHealthCheck,
  demoGpuPayload,
  demoGpuSummary,
  demoRemoteServers,
  demoRemoteStats,
  demoMfu,
  demoLogFiles,
  demoLogTail,
  demoTsdbQuery,
  demoK8sClusters,
  demoK8sOverview,
  demoK8sPodsLogs,
} from '../demo/fixtures.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));

// ─── mode.js ──────────────────────────────────────────────────────────────

describe('mode.js —— 演示模式开关', () => {
  const original = process.env.OPENLOG_DEMO;

  afterEach(() => {
    if (original === undefined) delete process.env.OPENLOG_DEMO;
    else process.env.OPENLOG_DEMO = original;
  });

  it('默认关闭（环境变量未设置）', () => {
    delete process.env.OPENLOG_DEMO;
    expect(isDemoMode()).toBe(false);
  });

  it("OPENLOG_DEMO=1 时开启", () => {
    process.env.OPENLOG_DEMO = '1';
    expect(isDemoMode()).toBe(true);
  });

  it('只认字面量 "1"：true / yes / 0 都算关闭（误设环境变量不能悄悄变成假数据）', () => {
    for (const value of ['0', 'true', 'yes', 'on', '', ' 1']) {
      process.env.OPENLOG_DEMO = value;
      expect(isDemoMode()).toBe(false);
    }
    process.env.OPENLOG_DEMO = '1';
    expect(isDemoMode()).toBe(true);
  });

  it('DEMO_DISABLED 是写操作被禁用时的统一响应体', () => {
    expect(DEMO_DISABLED).toEqual({ demo: true, error: '演示模式：该操作已被禁用' });
    expect(DEMO_DISABLED.demo).toBe(true);
    expect(typeof DEMO_DISABLED.error).toBe('string');
  });

  it('demoJson 挂 demo:true 且保留原字段', () => {
    const payload = { devices: [1, 2], summary: { count: 2 } };
    const wrapped = demoJson(payload);
    expect(wrapped.demo).toBe(true);
    expect(wrapped.devices).toEqual([1, 2]);
    expect(wrapped.summary).toEqual({ count: 2 });
    // 不修改入参本身
    expect(payload).toEqual({ devices: [1, 2], summary: { count: 2 } });
  });

  it('demoJson 对空对象也只多出 demo 一个键', () => {
    expect(demoJson({})).toEqual({ demo: true });
    expect(Object.keys(demoJson({ sources: [] }))).toEqual(['demo', 'sources']);
  });

  it('demoJson 遇到数组响应（/api/logs/files 直接 res.json(files)）原样返回', () => {
    const files = demoLogFiles();
    expect(demoJson(files)).toEqual(files);
    expect(Array.isArray(demoJson(files))).toBe(true);
  });
});

// ─── Docker ──────────────────────────────────────────────────────────────

describe('demoDockerSources —— GET /api/docker/containers 的 sources[]', () => {
  const { sources } = demoDockerSources();
  const containers = sources.flatMap((s) => s.containers);

  it('两个 Docker 源，各自带 meta 字段', () => {
    expect(sources).toHaveLength(2);
    for (const s of sources) {
      expect(typeof s.sourceId).toBe('string');
      expect(s.sourceId).not.toBe('');
      expect(typeof s.sourceName).toBe('string');
      expect(typeof s.host).toBe('string');
      expect(typeof s.serverId).toBe('string');
      expect(Array.isArray(s.containers)).toBe(true);
    }
    expect(sources[0].host).toBe('10.20.30.11');
    expect(sources[1].serverId).toBe('srv-t4-4');
  });

  it('容器 8 个（契约 6~8）', () => {
    expect(containers).toHaveLength(8);
    expect(sources[0].containers).toHaveLength(6);
    expect(sources[1].containers).toHaveLength(2);
  });

  it('每个容器都有 docker.listContainers 的全部字段且类型正确', () => {
    for (const c of containers) {
      expect(c.id).toMatch(/^[0-9a-f]{64}$/);
      expect(c.shortId).toBe(c.id.slice(0, 12));
      expect(Array.isArray(c.names)).toBe(true);
      expect(c.names.length).toBeGreaterThan(0);
      expect(typeof c.names[0]).toBe('string');
      expect(typeof c.image).toBe('string');
      expect(typeof c.imageId).toBe('string');
      expect(typeof c.command).toBe('string');
      expect(isIso(c.created)).toBe(true);
      expect(['running', 'exited', 'restarting', 'paused', 'created']).toContain(c.state);
      expect(typeof c.status).toBe('string');
      expect(c.exitCode === null || typeof c.exitCode === 'number').toBe(true);
      expect(c.exitType === null || typeof c.exitType === 'string').toBe(true);
      expect(Array.isArray(c.ports)).toBe(true);
      for (const p of c.ports) {
        expect(typeof p.ip).toBe('string');
        expect(typeof p.privatePort).toBe('number');
        expect(typeof p.publicPort).toBe('number');
        expect(p.type).toBe('tcp');
      }
      expect(c.labels).toBeTypeOf('object');
      expect(Array.isArray(c.envVars)).toBe(true);
      for (const env of c.envVars) expect(env).toMatch(/^[A-Z0-9_]+=/);
      expect(Array.isArray(c.networks)).toBe(true);
      expect(Array.isArray(c.networkAliases)).toBe(true);
      expect(c.platform).toBe('linux');
      // 列表接口不计算上下游：真实值是 null，不是 0
      expect(c.upstreamCount).toBeNull();
      expect(c.downstreamCount).toBeNull();
    }
  });

  it('状态分布：6 running / 1 restarting / 1 exited(137 OOM)', () => {
    expect(containers.filter((c) => c.state === 'running')).toHaveLength(6);
    expect(containers.filter((c) => c.state === 'restarting')).toHaveLength(1);
    const exited = containers.filter((c) => c.state === 'exited');
    expect(exited).toHaveLength(1);
    expect(exited[0].exitCode).toBe(137);
    expect(exited[0].exitType).toBe('oom');
    expect(exited[0].status).toMatch(/^Exited \(137\)/);
    // 运行中的容器没有退出码
    for (const c of containers.filter((x) => x.state === 'running')) {
      expect(c.exitCode).toBeNull();
      expect(c.exitType).toBeNull();
      expect(c.status).toMatch(/^Up /);
    }
  });

  it('镜像像推理服务（vllm / sglang / redis / postgres）', () => {
    const images = containers.map((c) => c.image).join(' ');
    for (const keyword of ['vllm/vllm-openai', 'sglang', 'redis', 'postgres']) {
      expect(images).toContain(keyword);
    }
  });

  it('labels 里的 env.* 被展开成 envVars（与 listContainers 的规则一致）', () => {
    const vllm = containers.find((c) => c.names.includes('vllm-qwen27b'));
    expect(vllm.envVars).toContain('MODEL_NAME=Qwen/Qwen3.6-27B');
    expect(vllm.envVars.some((e) => e.startsWith('env.'))).toBe(false);
    expect(vllm.networks).toEqual(['inference-net']);
  });

  it('返回的是副本：调用方改写不会污染下一次调用', () => {
    const first = demoDockerSources();
    first.sources[0].containers[0].names.push('改坏了');
    first.sources[0].containers[0].labels.mutated = '1';
    const second = demoDockerSources();
    expect(second.sources[0].containers[0].names).toEqual(['vllm-qwen27b']);
    expect(second.sources[0].containers[0].labels.mutated).toBeUndefined();
  });
});

describe('demoDockerLogs —— GET /api/docker/containers/:sourceId/:containerId/logs', () => {
  it('返回 { logs, containerId, sourceId }，行形状与 getContainerLogs 一致', () => {
    const res = demoDockerLogs({ containerId: 'vllm-qwen27b', sourceId: 'srv-4090-a', tail: 20 });
    expect(res.containerId).toBe('vllm-qwen27b');
    expect(res.sourceId).toBe('srv-4090-a');
    expect(Array.isArray(res.logs)).toBe(true);
    expect(res.logs.length).toBeGreaterThan(0);
    for (const line of res.logs) {
      expect(isIso(line.timestamp)).toBe(true);
      expect(typeof line.line).toBe('string');
      expect(['INFO', 'WARN', 'WARNING', 'ERROR', 'DEBUG', 'FATAL']).toContain(line.level);
      expect(typeof line.content).toBe('string');
      // content 是剥掉级别前缀后的正文
      expect(line.content.startsWith(line.level)).toBe(false);
    }
  });

  it('时间戳升序，且都不晚于 DEMO_NOW', () => {
    const { logs } = demoDockerLogs({ containerId: 'vllm-qwen27b', tail: 50 });
    const times = logs.map((l) => Date.parse(l.timestamp));
    for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThan(times[i - 1]);
    for (const t of times) expect(t).toBeLessThanOrEqual(Date.parse(DEMO_NOW));
  });

  it('level / content 与真实解析器 parseLogLevel 的结果一致（不自己发明分级）', () => {
    const { sources } = demoDockerSources();
    for (const c of sources.flatMap((s) => s.containers)) {
      const { logs } = demoDockerLogs({ containerId: c.id, tail: 100 });
      for (const line of logs) {
        // 真实路由的 level 是 parseLogLevel(line) 算出来的，演示数据必须同口径
        expect(parseLogLevel(line.line).level).toBe(line.level);
        expect(line.content.length).toBeGreaterThan(0);
        // content 必须是 line 的子串（剥前缀，不是另写一段）
        expect(line.line).toContain(line.content);
      }
    }
  });

  it('日志里 INFO 为主，ERROR 是少数', () => {
    const { logs } = demoDockerLogs({ containerId: 'vllm-qwen27b', tail: 500 });
    const counts = logs.reduce((acc, l) => {
      acc[l.level] = (acc[l.level] || 0) + 1;
      return acc;
    }, {});
    expect(counts.INFO).toBeGreaterThan(counts.ERROR);
    expect(counts.ERROR).toBeGreaterThan(0);
    expect(counts.WARN).toBeGreaterThan(0);
  });

  it('tail 生效：取最后 N 行', () => {
    const all = demoDockerLogs({ containerId: 'vllm-qwen27b', tail: 500 });
    const five = demoDockerLogs({ containerId: 'vllm-qwen27b', tail: 5 });
    expect(five.logs).toHaveLength(5);
    expect(five.logs).toEqual(all.logs.slice(-5));
  });

  it('tail 非法/缺省时返回全部模板行', () => {
    const noOpts = demoDockerLogs({ containerId: 'vllm-qwen27b' });
    for (const tail of [0, -3, 'abc', null]) {
      expect(demoDockerLogs({ containerId: 'vllm-qwen27b', tail }).logs).toEqual(noOpts.logs);
    }
  });

  it('短 id 也能定位容器（前端两种 id 都在用）', () => {
    const byShort = demoDockerLogs({ containerId: '9f2c1a4b7d3e' });
    const byName = demoDockerLogs({ containerId: 'vllm-qwen27b' });
    expect(byShort.logs).toEqual(byName.logs);
  });

  it('未知容器回落而不是 404（演示模式不该因为参数怪就空白）', () => {
    const res = demoDockerLogs({ containerId: 'not-a-real-container' });
    expect(res.logs.length).toBeGreaterThan(0);
    expect(typeof res.containerId).toBe('string');
  });

  it('OOM 退出的容器，日志停在退出时刻（3 小时前）而不是刚刚', () => {
    const { logs } = demoDockerLogs({ containerId: 'vllm-bench-old', tail: 50 });
    const last = Date.parse(logs[logs.length - 1].timestamp);
    expect(Date.parse(DEMO_NOW) - last).toBeGreaterThan(3 * 3600_000 - 60_000);
    expect(logs.some((l) => /OutOfMemory|Killed|137/i.test(l.line))).toBe(true);
  });
});

describe('demoDockerHealthCheck —— GET /api/docker/health-check', () => {
  const report = demoDockerHealthCheck();

  it('顶层字段与 docker.healthCheck 一致', () => {
    expect(Object.keys(report).sort()).toEqual(
      ['ignoredStale', 'ignoredUnobserved', 'normalExited', 'problems', 'running', 'summary'],
    );
    expect(Array.isArray(report.running)).toBe(true);
    expect(Array.isArray(report.problems)).toBe(true);
    expect(Array.isArray(report.normalExited)).toBe(true);
    expect(Array.isArray(report.ignoredStale)).toBe(true);
    expect(Array.isArray(report.ignoredUnobserved)).toBe(true);
  });

  it('summary 计数与容器表一致（8 / 6 running / 1 exited / 1 OOM）', () => {
    const s = report.summary;
    for (const key of ['total', 'running', 'exited', 'oomKilled', 'errorExited', 'normalExited',
      'healthy', 'unhealthy', 'staleHours', 'ignoredStale', 'ignoredUnobserved', 'ignoredTotal']) {
      expect(typeof s[key]).toBe('number');
    }
    expect(s.total).toBe(8);
    expect(s.running).toBe(6);
    expect(s.exited).toBe(1);
    expect(s.oomKilled).toBe(1);
    expect(s.healthy).toBe(s.running + s.normalExited);
    expect(s.unhealthy).toBe(report.problems.length);
    expect(s.ignoredTotal).toBe(s.ignoredStale + s.ignoredUnobserved);
    expect(report.running).toHaveLength(6);
  });

  it('唯一的问题容器是 OOM 退出的那个，errors 是排障线索', () => {
    expect(report.problems).toHaveLength(1);
    const p = report.problems[0];
    expect(p.name).toBe('vllm-bench-old');
    expect(p.state).toBe('exited');
    expect(p.exitCode).toBe(137);
    expect(p.exitType).toBe('oom');
    expect(p.exitedAgoMs).toBe(3 * 3600_000);
    expect(p.logUnavailable).toBe(false);
    expect(p.logDriverUnreadable).toBe(false);
    expect(p.logNote).toBeNull();
    expect(p.errors.length).toBeGreaterThan(0);
    expect(p.errors.length).toBeLessThanOrEqual(10);
    for (const line of p.errors) expect(line).toMatch(/^\[.+Z\] /);
    expect(p.errors.join('\n')).toMatch(/OutOfMemory|Killed/i);
  });

  it('running 列表元素形状 { name, image, status, sourceName }', () => {
    for (const item of report.running) {
      expect(typeof item.name).toBe('string');
      expect(typeof item.image).toBe('string');
      expect(item.status).toMatch(/^Up /);
      expect(typeof item.sourceName).toBe('string');
    }
  });
});

// ─── GPU / 远程 ───────────────────────────────────────────────────────────

describe('demoGpuPayload / demoGpuSummary —— /api/gpu/... 的 devices + summary', () => {
  it('devices 形状与 buildRemoteGPUPayload 一致', () => {
    const { devices } = demoGpuPayload({ serverId: 'srv-4090-a' });
    expect(devices).toHaveLength(4);
    for (const d of devices) {
      expect(typeof d.index).toBe('number');
      expect(typeof d.name).toBe('string');
      expect(d.name).toContain('4090');
      expect(typeof d.util).toBe('number');
      expect(typeof d.memUsed).toBe('number');
      expect(typeof d.memTotal).toBe('number');
      expect(typeof d.temp).toBe('number');
      expect(Array.isArray(d.processes)).toBe(true);
      for (const p of d.processes) {
        expect(typeof p.gpuId).toBe('string');
        expect(typeof p.pid).toBe('number');
        expect(typeof p.name).toBe('string');
        expect(typeof p.usedMemory).toBe('number');
      }
    }
  });

  it('数值落在运维现场区间：4090 单卡 24G，利用率 30~92%，显存 8~22G，温度 45~78℃', () => {
    const { devices } = demoGpuPayload({ serverId: 'srv-4090-a' });
    for (const d of devices) {
      expect(d.memTotal).toBe(24564);
      expect(d.util).toBeGreaterThanOrEqual(30);
      expect(d.util).toBeLessThanOrEqual(92);
      expect(d.memUsed).toBeGreaterThanOrEqual(8 * 1024);
      expect(d.memUsed).toBeLessThanOrEqual(22 * 1024);
      expect(d.temp).toBeGreaterThanOrEqual(45);
      expect(d.temp).toBeLessThanOrEqual(78);
      expect(d.memUsed).toBeLessThan(d.memTotal);
    }
  });

  it('summary 与 getGPUSummary 同形且与卡片自洽', () => {
    const { devices, summary } = demoGpuPayload({ serverId: 'srv-4090-a' });
    expect(Object.keys(summary).sort()).toEqual([
      'avgUtilization', 'count', 'devices', 'freeMemory', 'maxTemperature',
      'processCount', 'processes', 'totalMemory', 'usedMemory', 'vendors',
    ]);
    expect(summary.count).toBe(4);
    expect(summary.vendors).toEqual({ NVIDIA: 4 });
    expect(summary.totalMemory).toBe(devices.reduce((s, d) => s + d.memTotal, 0));
    expect(summary.usedMemory).toBe(devices.reduce((s, d) => s + d.memUsed, 0));
    expect(summary.freeMemory).toBe(summary.totalMemory - summary.usedMemory);
    expect(summary.maxTemperature).toBe(Math.max(...devices.map((d) => d.temp)));
    expect(Number.isInteger(summary.avgUtilization)).toBe(true);
    expect(summary.devices).toHaveLength(4);
    for (const d of summary.devices) {
      expect(d.vendor).toBe('NVIDIA');
      expect(typeof d.memoryTotal).toBe('number');
      expect(typeof d.memoryUsed).toBe('number');
      expect(typeof d.utilization).toBe('number');
      expect(typeof d.temperature).toBe('number');
      expect(Array.isArray(d.processes)).toBe(true);
    }
    expect(summary.processCount).toBe(summary.processes.length);
  });

  it('T4 机器 4 张卡，单卡 15G', () => {
    const { devices, summary } = demoGpuPayload({ serverId: 'srv-t4-4' });
    expect(devices).toHaveLength(4);
    expect(devices.every((d) => d.name === 'Tesla T4')).toBe(true);
    expect(devices.every((d) => d.memTotal === 15360)).toBe(true);
    expect(summary.count).toBe(4);
  });

  it('掉线机器的 GPU 采集失败：空设备 + null summary（不假装在跑）', () => {
    expect(demoGpuPayload({ serverId: 'srv-t4-2' })).toEqual({ devices: [], summary: null });
  });

  it('未知 serverId 回落到第一台（演示模式不抛错）', () => {
    expect(demoGpuPayload({ serverId: 'nope' }).devices).toHaveLength(4);
    expect(demoGpuPayload().devices).toHaveLength(4);
  });

  it('demoGpuSummary 汇总 3 台机共 10 张卡', () => {
    const summary = demoGpuSummary();
    expect(summary.count).toBe(10);
    expect(summary.devices).toHaveLength(10);
    expect(summary.vendors).toEqual({ NVIDIA: 10 });
    expect(summary.totalMemory).toBe(4 * 24564 + 6 * 15360);
    expect(summary.usedMemory).toBeLessThan(summary.totalMemory);
    expect(summary.freeMemory).toBe(summary.totalMemory - summary.usedMemory);
  });
});

describe('demoRemoteServers —— GET /api/remote/servers', () => {
  const { servers } = demoRemoteServers();

  it('三台机器，字段与 remote.getServers() 一致', () => {
    expect(servers).toHaveLength(3);
    for (const s of servers) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.name).toBe('string');
      expect(typeof s.host).toBe('string');
      expect(typeof s.port).toBe('number');
      expect(typeof s.username).toBe('string');
      expect(typeof s.logPath).toBe('string');
      expect(typeof s.watchFiles).toBe('string');
      expect(isIso(s.lastConnected)).toBe(true);
      expect(['connected', 'disconnected', 'error']).toContain(s.status);
      expect(s.lastError === null || typeof s.lastError === 'string').toBe(true);
      expect(s.lastErrorAt === null || isIso(s.lastErrorAt)).toBe(true);
      expect(s.nextRetryAt === null || isIso(s.nextRetryAt)).toBe(true);
      expect(typeof s.retryCount).toBe('number');
    }
  });

  it('2 台在线 1 台离线，且离线那台带重试状态', () => {
    expect(servers.filter((s) => s.status === 'connected')).toHaveLength(2);
    const offline = servers.find((s) => s.status === 'disconnected');
    expect(offline).toBeTruthy();
    expect(offline.retryCount).toBeGreaterThan(0);
    expect(offline.lastError).toContain('timeout');
  });

  it('机器名与契约一致（4090×4 / 4卡T4 / 双卡T4）', () => {
    expect(servers.map((s) => s.name)).toEqual(['4090×4', '4卡T4', '双卡T4']);
  });
});

describe('demoRemoteStats —— GET /api/remote/servers/:id/stats', () => {
  const stats = demoRemoteStats('srv-4090-a');

  it('顶层字段与 getRemoteSystemStats 一致', () => {
    expect(Object.keys(stats).sort()).toEqual(
      ['cpu', 'disk', 'gpus', 'memory', 'network', 'processes'],
    );
    expect(typeof stats.cpu.load).toBe('number');
    expect(Array.isArray(stats.cpu.cores)).toBe(true);
    expect(stats.memory.used).toBeLessThan(stats.memory.total);
    expect(stats.memory.free).toBe(stats.memory.total - stats.memory.used);
  });

  it('磁盘/网卡/进程元素字段与真实解析结果一致', () => {
    for (const d of stats.disk) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.device).toBe('string');
      expect(typeof d.used).toBe('number');
      expect(typeof d.total).toBe('number');
      expect(typeof d.usePercent).toBe('number');
      expect(d.usePercent).toBeGreaterThan(0);
      expect(d.usePercent).toBeLessThanOrEqual(100);
    }
    for (const n of stats.network) {
      expect(typeof n.iface).toBe('string');
      expect(typeof n.rx).toBe('number');
      expect(typeof n.tx).toBe('number');
    }
    for (const p of stats.processes) {
      expect(typeof p.pid).toBe('number');
      expect(typeof p.name).toBe('string');
      expect(typeof p.cpu).toBe('number');
      expect(typeof p.mem).toBe('number');
    }
  });

  it('gpus 与 /api/gpu 的卡片形状同源', () => {
    expect(stats.gpus).toHaveLength(4);
    for (const g of stats.gpus) {
      expect(typeof g.index).toBe('number');
      expect(typeof g.util).toBe('number');
      expect(typeof g.memUsed).toBe('number');
      expect(typeof g.memTotal).toBe('number');
      expect(typeof g.temp).toBe('number');
      expect(Array.isArray(g.processes)).toBe(true);
    }
    expect(stats.gpus).toEqual(demoGpuPayload({ serverId: 'srv-4090-a' }).devices);
  });

  it('T4 机器 4 张卡，网络/磁盘字段齐全', () => {
    const t4 = demoRemoteStats('srv-t4-4');
    expect(t4.gpus).toHaveLength(4);
    expect(t4.disk.length).toBeGreaterThan(0);
    expect(t4.network[0].iface).toBe('eno1');
  });

  it('掉线机器返回 { offline: true }（路由 catch「服务器未连接」时就是这个形状）', () => {
    expect(demoRemoteStats('srv-t4-2')).toEqual({ offline: true });
  });
});

describe('demoMfu —— GET /api/remote/servers/:id/mfu', () => {
  const mfu = demoMfu('srv-4090-a');

  it('顶层形状与 getRemoteMfu 一致', () => {
    expect(mfu.available).toBe(true);
    expect(Array.isArray(mfu.engines)).toBe(true);
    expect(mfu.engines).toHaveLength(1);
    expect(mfu.gpuMfu).toBeTypeOf('object');
    expect(mfu.reason).toBeNull();
  });

  it('引擎条目字段与 buildMfuResult 一致（vLLM）', () => {
    const e = mfu.engines[0];
    expect(e.engine).toBe('vllm');
    expect(e.available).toBe(true);
    expect(typeof e.model).toBe('string');
    expect(typeof e.mfu).toBe('number');
    expect(Array.isArray(e.gpuIndexes)).toBe(true);
    expect(e.gpuIndexes).toEqual([0, 1, 2, 3]);
    expect(typeof e.peakTflops).toBe('number');
    expect(typeof e.paramsB).toBe('number');
    expect(typeof e.tokensPerSec).toBe('number');
    expect(typeof e.windowSec).toBe('number');
    expect(e.method).toBe('tokens_x_active_params');
    expect(e.sampleCount).toBe(2);
    expect(e.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
    expect(isIso(e.sampledAt)).toBe(true);
  });

  it('MFU 落在 20~60%，tokens/s 在数百~数千量级', () => {
    for (const serverId of ['srv-4090-a', 'srv-t4-4']) {
      const e = demoMfu(serverId).engines[0];
      expect(e.mfu).toBeGreaterThanOrEqual(20);
      expect(e.mfu).toBeLessThanOrEqual(60);
      expect(e.tokensPerSec).toBeGreaterThan(100);
      expect(e.tokensPerSec).toBeLessThan(10_000);
    }
  });

  it('mfu 与 tokensPerSec / paramsB / peakTflops / 卡数自洽（能被复算出来）', () => {
    for (const serverId of ['srv-4090-a', 'srv-t4-4']) {
      const e = demoMfu(serverId).engines[0];
      const gpuCount = Math.max(1, e.gpuIndexes.length);
      const computed = ((2 * e.paramsB * 1e9 * e.tokensPerSec) / gpuCount) / (e.peakTflops * 1e12) * 100;
      expect(Math.abs(computed - e.mfu)).toBeLessThan(0.05);
    }
  });

  it('gpuMfu 按卡索引给出 {mfu, engine, model, windowSec}', () => {
    const keys = Object.keys(mfu.gpuMfu).sort();
    expect(keys).toEqual(['0', '1', '2', '3']);
    for (const key of keys) {
      const entry = mfu.gpuMfu[key];
      expect(typeof entry.mfu).toBe('number');
      expect(entry.engine).toBe('vllm');
      expect(typeof entry.model).toBe('string');
      expect(typeof entry.windowSec).toBe('number');
      expect(entry.mfu).toBe(mfu.engines[0].mfu);
    }
  });

  it('掉线机器：available=false、空引擎、原因文案与真实实现同款', () => {
    const offline = demoMfu('srv-t4-2');
    expect(offline.available).toBe(false);
    expect(offline.engines).toEqual([]);
    expect(offline.gpuMfu).toEqual({});
    expect(offline.reason).toContain('服务器未连接');
  });
});

// ─── 日志文件 / tail ──────────────────────────────────────────────────────

describe('demoLogFiles —— GET /api/logs/files（裸数组）', () => {
  const files = demoLogFiles();

  it('响应体就是数组（真实实现 res.json(files)，没有包裹对象）', () => {
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('元素形状 { name, path, size }', () => {
    for (const f of files) {
      expect(typeof f.name).toBe('string');
      expect(f.name.endsWith('.log')).toBe(true);
      expect(typeof f.path).toBe('string');
      expect(f.path.endsWith(f.name)).toBe(true);
      expect(typeof f.size).toBe('number');
      expect(f.size).toBeGreaterThan(0);
    }
  });
});

describe('demoLogTail —— 读日志文件最后 N 行（remote.readRemoteFile 形状）', () => {
  const res = demoLogTail({ file: '/data/logs/vllm-qwen27b.log', lines: 6 });

  it('返回 { logs, fileInfo, totalLines }，行形状与 parseRemoteLogLine 一致', () => {
    expect(Array.isArray(res.logs)).toBe(true);
    expect(res.logs).toHaveLength(6);
    for (const line of res.logs) {
      expect(typeof line.id).toBe('string');
      expect(line.id).not.toBe('');
      expect(isIso(line.timestamp)).toBe(true);
      expect(['INFO', 'WARN', 'WARNING', 'ERROR', 'DEBUG', 'FATAL']).toContain(line.level);
      expect(typeof line.message).toBe('string');
      expect(line.source).toBe('vllm-qwen27b.log');
      expect(typeof line.metadata).toBe('string');
      const meta = JSON.parse(line.metadata);
      expect(meta.remote).toBe(true);
      expect(typeof meta.path).toBe('string');
      expect(typeof meta.raw).toBe('string');
    }
  });

  it('fileInfo / totalLines 与文件表对得上', () => {
    expect(typeof res.fileInfo.size).toBe('number');
    expect(res.fileInfo.size).toBeGreaterThan(0);
    expect(typeof res.fileInfo.modified).toBe('string');
    expect(res.totalLines).toBeGreaterThanOrEqual(res.logs.length);
  });

  it('lines 缺省/非法时返回全文模板', () => {
    const full = demoLogTail({ file: '/data/logs/vllm-qwen27b.log' });
    for (const lines of [0, -1, 'x', null]) {
      expect(demoLogTail({ file: '/data/logs/vllm-qwen27b.log', lines }).logs).toEqual(full.logs);
    }
    expect(full.logs.length).toBe(full.totalLines);
  });

  it('未知文件回落通用模板，不抛错', () => {
    const unknown = demoLogTail({ file: '/var/log/nginx/access.log', lines: 3 });
    expect(unknown.logs).toHaveLength(3);
    expect(unknown.logs[0].source).toBe('access.log');
    expect(unknown.fileInfo.size).toBe(0);
  });

  it('缺省参数也能返回数据（演示模式页面不该空白）', () => {
    const res = demoLogTail();
    expect(res.logs.length).toBeGreaterThan(0);
    expect(typeof res.logs[0].source).toBe('string');
  });
});

// ─── TSDB ────────────────────────────────────────────────────────────────

describe('demoTsdbQuery —— TSDB 查询（Prometheus matrix 协议）', () => {
  it('返回 Prometheus 协议壳，前端 TsdbSection 直接读 data.result', () => {
    const res = demoTsdbQuery({ query: 'openlog_gpu_utilization_percent' });
    expect(res.status).toBe('success');
    expect(res.data.resultType).toBe('matrix');
    expect(Array.isArray(res.data.result)).toBe(true);
    expect(res.data.result).toHaveLength(1);
    const series = res.data.result[0];
    expect(series.metric.__name__).toBe('openlog_gpu_utilization_percent');
    expect(typeof series.metric.job).toBe('string');
    expect(typeof series.metric.instance).toBe('string');
  });

  it('1 小时 60 个点，值为字符串、时间戳递增', () => {
    const [series] = demoTsdbQuery({ query: 'openlog_cpu_usage_percent' }).data.result;
    expect(series.values).toHaveLength(TSDB_POINTS);
    expect(TSDB_POINTS).toBe(60);
    let prev = -Infinity;
    for (const [ts, value] of series.values) {
      expect(typeof ts).toBe('number');
      expect(typeof value).toBe('string');
      const num = Number(value);
      expect(Number.isFinite(num)).toBe(true);
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num).toBeLessThanOrEqual(100);
      expect(ts).toBeGreaterThan(prev);
      prev = ts;
    }
    const [first] = series.values[0];
    const [last] = series.values[series.values.length - 1];
    expect(last - first).toBe((TSDB_POINTS - 1) * 60);
  });

  it('按查询关键词选序列（cpu / memory / gpu / disk / containers）', () => {
    const name = (q) => demoTsdbQuery({ query: q }).data.result[0].metric.__name__;
    expect(name('openlog_cpu_usage_percent')).toBe('openlog_cpu_usage_percent');
    expect(name('openlog_memory_usage_percent')).toBe('openlog_memory_usage_percent');
    expect(name('openlog_gpu_utilization_percent')).toBe('openlog_gpu_utilization_percent');
    expect(name('openlog_disk_usage_percent')).toBe('openlog_disk_usage_percent');
    expect(name('openlog_docker_containers_total')).toBe('openlog_docker_containers_total');
    // 认不出的 PromQL 回落到 CPU，不返回空结果让图变空白
    expect(name('sum(rate(openlog_api_requests_5xx_total[5m]))')).toBe('openlog_cpu_usage_percent');
    expect(name('')).toBe('openlog_cpu_usage_percent');
  });

  it('容器数量是整数 gauge（无噪声）', () => {
    const values = demoTsdbQuery({ query: 'openlog_docker_containers_total' }).data.result[0].values;
    expect(values.every(([, v]) => v === '8')).toBe(true);
  });

  it('默认参数可用（POST body 为空）', () => {
    expect(demoTsdbQuery().data.result[0].values).toHaveLength(60);
    expect(demoTsdbQuery({}).status).toBe('success');
  });
});

// ─── Kubernetes ──────────────────────────────────────────────────────────

describe('demoK8sClusters —— GET /api/k8s/clusters', () => {
  const { clusters } = demoK8sClusters();

  it('一个集群，字段与 K8sClusterView 一致（不含 kubeconfig 明文）', () => {
    expect(clusters).toHaveLength(1);
    const c = clusters[0];
    expect(typeof c.id).toBe('string');
    expect(typeof c.name).toBe('string');
    expect(typeof c.context).toBe('string');
    expect(typeof c.server).toBe('string');
    expect(c.server.startsWith('https://')).toBe(true);
    expect(typeof c.enabled).toBe('boolean');
    expect(['cert', 'token']).toContain(c.authType);
    expect(c.hasKubeconfig).toBe(true);
    expect(c.kubeconfig).toBeUndefined();
  });
});

describe('demoK8sOverview —— GET /api/k8s/clusters/:id/overview', () => {
  const overview = demoK8sOverview('demo-k3s-infer');

  it('顶层字段与路由一致', () => {
    expect(Object.keys(overview).sort()).toEqual(
      ['cluster', 'events', 'nodes', 'pods', 'summary', 'warnings', 'workloads'],
    );
    expect(typeof overview.cluster.version).toBe('string');
    expect(overview.cluster.server).toBeTruthy();
    expect(overview.cluster.context).toBeTruthy();
    expect(overview.warnings).toEqual([]);
  });

  it('1 个节点，形状与 normalizeNodes 一致', () => {
    expect(overview.nodes).toHaveLength(1);
    const n = overview.nodes[0];
    expect(typeof n.name).toBe('string');
    expect(n.ready).toBe(true);
    expect(Array.isArray(n.roles)).toBe(true);
    expect(n.roles).toContain('control-plane');
    expect(typeof n.version).toBe('string');
    expect(typeof n.os).toBe('string');
    expect(n.arch).toBe('amd64');
    expect(typeof n.internalIP).toBe('string');
    expect(typeof n.cpu).toBe('string');
    expect(typeof n.memory).toBe('string');
    expect(typeof n.pods).toBe('string');
    expect(isIso(n.created)).toBe(true);
    expect(Array.isArray(n.conditions)).toBe(true);
    for (const cond of n.conditions) {
      expect(typeof cond.type).toBe('string');
      expect(['True', 'False', 'Unknown']).toContain(cond.status);
    }
  });

  it('8 个 Pod，形状与 normalizePods 一致', () => {
    expect(overview.pods).toHaveLength(8);
    for (const p of overview.pods) {
      expect(typeof p.namespace).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(typeof p.phase).toBe('string');
      expect(p.ready).toMatch(/^\d+\/\d+$/);
      expect(typeof p.restarts).toBe('number');
      expect(typeof p.node).toBe('string');
      expect(typeof p.ip).toBe('string');
      expect(isIso(p.created)).toBe(true);
      expect(typeof p.oom).toBe('boolean');
      expect(typeof p.crashLoop).toBe('boolean');
      expect(Array.isArray(p.containers)).toBe(true);
      for (const c of p.containers) {
        expect(typeof c.name).toBe('string');
        expect(typeof c.ready).toBe('boolean');
        expect(typeof c.restarts).toBe('number');
        expect(['running', 'waiting', 'terminated', 'unknown']).toContain(c.state);
        if (c.reason !== undefined) expect(typeof c.reason).toBe('string');
      }
    }
  });

  it('故障数据齐全：1 个 CrashLoopBackOff、1 个 Pending', () => {
    const crash = overview.pods.filter((p) => p.crashLoop);
    expect(crash).toHaveLength(1);
    expect(crash[0].containers[0].state).toBe('waiting');
    expect(crash[0].containers[0].reason).toBe('CrashLoopBackOff');
    expect(crash[0].restarts).toBeGreaterThan(0);
    expect(crash[0].ready).toBe('0/1');

    const pending = overview.pods.filter((p) => p.phase === 'Pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].ready).toBe('0/1');

    expect(overview.pods.filter((p) => p.phase === 'Running')).toHaveLength(7);
  });

  it('6 个工作负载，形状与 normalizeWorkloads 一致', () => {
    expect(overview.workloads).toHaveLength(6);
    const kinds = new Set(overview.workloads.map((w) => w.kind));
    expect(kinds).toEqual(new Set(['Deployment', 'StatefulSet', 'DaemonSet']));
    for (const w of overview.workloads) {
      expect(typeof w.namespace).toBe('string');
      expect(typeof w.name).toBe('string');
      for (const key of ['desired', 'ready', 'upToDate', 'available']) {
        expect(typeof w[key]).toBe('number');
      }
      expect(isIso(w.created)).toBe(true);
    }
    expect(overview.workloads.filter((w) => w.ready < w.desired)).toHaveLength(1);
  });

  it('3 条 Warning 事件，形状与 normalizeEvents 一致', () => {
    expect(overview.events).toHaveLength(3);
    for (const e of overview.events) {
      expect(e.type).toBe('Warning');
      expect(typeof e.namespace).toBe('string');
      expect(typeof e.reason).toBe('string');
      expect(e.object).toContain('/');
      expect(typeof e.message).toBe('string');
      expect(typeof e.count).toBe('number');
      expect(isIso(e.lastSeen)).toBe(true);
    }
    expect(overview.events.map((e) => e.reason)).toContain('BackOff');
    expect(overview.events.map((e) => e.reason)).toContain('FailedScheduling');
  });

  it('summary 与数组自洽（k8sResources.summarize 口径）', () => {
    const { summary, pods, nodes, workloads, events } = overview;
    expect(summary.nodes).toBe(nodes.length);
    expect(summary.nodesReady).toBe(1);
    expect(summary.pods).toBe(pods.length);
    expect(summary.podsRunning).toBe(pods.filter((p) => p.phase === 'Running').length);
    expect(summary.podsUnhealthy).toBe(2);
    expect(summary.workloads).toBe(workloads.length);
    expect(summary.workloadsUnready).toBe(workloads.filter((w) => w.ready < w.desired).length);
    expect(summary.warningEvents).toBe(events.filter((e) => e.type === 'Warning').length);
  });
});

describe('demoK8sPodsLogs —— GET /api/k8s/clusters/:id/pods/:ns/:pod/logs', () => {
  it('返回 { logs: string }（kubelet 原始文本，不是行数组）', () => {
    const res = demoK8sPodsLogs({ ns: 'inference', pod: 'vllm-qwen27b-1' });
    expect(Object.keys(res)).toEqual(['logs']);
    expect(typeof res.logs).toBe('string');
    expect(res.logs.split('\n').length).toBeGreaterThan(3);
    expect(res.logs).toContain('vllm-qwen27b-1');
    expect(res.logs).toContain('inference');
  });

  it('CrashLoop 的 Pod 日志里能看出起不来的原因', () => {
    const res = demoK8sPodsLogs({ ns: 'inference', pod: 'vllm-canary-0' });
    expect(res.logs).toMatch(/OutOfMemory|failed to start/i);
  });

  it('缺省参数也能返回日志', () => {
    expect(demoK8sPodsLogs().logs.length).toBeGreaterThan(0);
  });
});

// ─── 确定性 ──────────────────────────────────────────────────────────────

describe('确定性：同一函数多次调用 deepEqual', () => {
  const cases = [
    ['demoDockerSources', () => demoDockerSources()],
    ['demoDockerLogs', () => demoDockerLogs({ containerId: 'vllm-qwen27b', sourceId: 'srv-4090-a', tail: 20 })],
    ['demoDockerLogs（缺省参数）', () => demoDockerLogs()],
    ['demoDockerHealthCheck', () => demoDockerHealthCheck()],
    ['demoGpuPayload', () => demoGpuPayload({ serverId: 'srv-t4-4' })],
    ['demoGpuSummary', () => demoGpuSummary()],
    ['demoRemoteServers', () => demoRemoteServers()],
    ['demoRemoteStats', () => demoRemoteStats('srv-4090-a')],
    ['demoMfu', () => demoMfu('srv-4090-a')],
    ['demoLogFiles', () => demoLogFiles()],
    ['demoLogTail', () => demoLogTail({ file: '/data/logs/vllm-qwen27b.log', lines: 10 })],
    ['demoTsdbQuery', () => demoTsdbQuery({ query: 'openlog_gpu_utilization_percent' })],
    ['demoK8sClusters', () => demoK8sClusters()],
    ['demoK8sOverview', () => demoK8sOverview('demo-k3s-infer')],
    ['demoK8sPodsLogs', () => demoK8sPodsLogs({ ns: 'inference', pod: 'vllm-qwen27b-0' })],
  ];

  for (const [name, run] of cases) {
    it(name, () => {
      expect(run()).toEqual(run());
      expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
    });
  }

  it('时间基准只有一个：DEMO_NOW 可解析且所有时间字段都不晚于它', () => {
    expect(isIso(DEMO_NOW)).toBe(true);
    const limit = Date.parse(DEMO_NOW);
    const { sources } = demoDockerSources();
    for (const c of sources.flatMap((s) => s.containers)) {
      expect(Date.parse(c.created)).toBeLessThanOrEqual(limit);
    }
    for (const s of demoRemoteServers().servers) {
      expect(Date.parse(s.lastConnected)).toBeLessThanOrEqual(limit);
    }
    const tail = demoLogTail({ file: '/data/logs/vllm-qwen27b.log' });
    for (const line of tail.logs) expect(Date.parse(line.timestamp)).toBeLessThanOrEqual(limit);
  });
});
