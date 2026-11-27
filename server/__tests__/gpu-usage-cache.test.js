/**
 * collectNodeGpuUsageCached 的 TTL / 单飞 / 超时降级。
 *
 * 为什么值得单独测：这一层包在 preview 的请求路径上。
 *   · 没 TTL → 拖一次配额滑块能打出十几条 SSH（同机 0.28s、跨网 0.45s，肉眼可见卡）；
 *   · 没单飞 → 两个面板同时打开就是两条远端命令；
 *   · 没超时降级 → 节点不可达时 preview 跟着一起 hang（/usage 之前就是 5 秒）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectNodeGpuUsageCached,
  _resetGpuUsageCache,
} from '../k8s/gpu-usage.js';

const node = (name, ip) => ({ name, internalIP: ip });
const server = { id: 's1', host: '10.0.0.9' };
const devices = [{ uuid: 'GPU-a', index: 0, memUsed: 1000, memTotal: 8192, util: 30 }];

beforeEach(() => {
  _resetGpuUsageCache();
});

describe('collectNodeGpuUsageCached', () => {
  it('首次采集后 TTL 内命中缓存，不再发远端命令', async () => {
    const getRemoteGPUs = vi.fn(async () => devices);
    const opts = {
      nodes: [node('node1', '10.0.0.9')],
      servers: [server],
      deps: { getRemoteGPUs },
      ttlMs: 3000,
      timeoutMs: 1000,
    };

    const first = await collectNodeGpuUsageCached(opts);
    expect(getRemoteGPUs).toHaveBeenCalledTimes(1);
    expect(first.timedOut).toBe(false);
    expect(first.usage.get('node1')?.get('GPU-a')?.memUsed).toBe(1000);

    const second = await collectNodeGpuUsageCached(opts);
    expect(getRemoteGPUs).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toContain('node1');
  });

  it('并发两次只发一条远端命令（单飞）', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const getRemoteGPUs = vi.fn(async () => {
      await gate;
      return devices;
    });
    const opts = {
      nodes: [node('node1', '10.0.0.9')],
      servers: [server],
      deps: { getRemoteGPUs },
      ttlMs: 3000,
      timeoutMs: 1000,
    };

    const p1 = collectNodeGpuUsageCached(opts);
    const p2 = collectNodeGpuUsageCached(opts);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(getRemoteGPUs).toHaveBeenCalledTimes(1);
    expect(r1.usage.get('node1')).toBeTruthy();
    expect(r2.usage.get('node1')).toBeTruthy();
  });

  it('超时 → timedOut:true 且立即返回，不阻塞请求路径', async () => {
    const getRemoteGPUs = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return devices;
    });

    const started = Date.now();
    const result = await collectNodeGpuUsageCached({
      nodes: [node('node1', '10.0.0.9')],
      servers: [server],
      deps: { getRemoteGPUs },
      ttlMs: 3000,
      timeoutMs: 30,
    });
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(result.usage.size).toBe(0);
    expect(elapsed).toBeLessThan(120);
  });

  it('取不到服务器凭据（节点 IP 不匹配）→ 空 Map，不抛', async () => {
    const result = await collectNodeGpuUsageCached({
      nodes: [node('node9', '10.9.9.9')],
      servers: [server],
      deps: { getRemoteGPUs: vi.fn(async () => devices) },
      ttlMs: 3000,
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(false);
    expect(result.usage.size).toBe(0);
  });
});
