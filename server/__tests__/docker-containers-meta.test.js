/**
 * 回归测试：via(SSH) docker 源在「远程设备」模式下被 host 过滤掉的问题
 *
 * 客户端 Docker.tsx 在远程设备模式下按 host 过滤源（只显示属于该设备的源）。
 * via 源自身没有 host 字段，服务端必须在 /api/docker/containers 里回传
 * 「从远程服务器解析出的 host」+「serverId」，否则该源在设备模式下会被
 * 整体过滤 → UI 显示「所有 Docker 连接均失败」。
 *
 * 真实暴露路径：用户在设置页配好 via 源、设备选择器选中该机器后，
 * Docker 页显示「0 个容器」+「所有 Docker 连接均失败」，而接口单独
 * 查询是好的。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';

// ── 模块替换 ─────────────────────────────────────────────────────
vi.mock('../docker.js', () => ({
  listContainers: vi.fn(async () => [{ id: 'c1', name: 'a', state: 'running' }]),
}));

vi.mock('../remote.js', () => ({
  getServers: vi.fn(() => [
    { id: 'srv-1', name: '4090*4', host: '192.168.1.222', port: 40022 },
    { id: 'srv-2', name: '旧机器', host: '203.0.113.10', port: 40022 },
  ]),
}));

vi.mock('../docker-ssh-bridge.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureDockerBridge: vi.fn(async () => '/tmp/openlog-test-bridge.sock'),
  };
});

import createDockerRouter from '../routes/docker.js';

// ── 可变设置，供各测试单独配置 ───────────────────────────────────
let testSettings = {
  dockerSources: [
    { id: 'via-src', name: '4090*4 (SSH)', via: { serverId: 'srv-1', socketPath: '/var/run/docker.sock' }, enabled: true },
    { id: 'tcp-src', name: '4090服务器', host: '203.0.113.10', port: 2375, enabled: true },
    { id: 'off-src', name: '禁用', host: '1.2.3.4', enabled: false },
  ],
};

const router = createDockerRouter({
  ensureSettings: () => testSettings,
  broadcast: () => {},
  addAnalysisRecord: () => {},
  buildHostExecMap: () => ({}),
  stripThinking: (s) => s,
  getLastPatrolResults: () => ({}),
  setLastPatrolResults: () => {},
});

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

async function fetchSources() {
  // refresh=1 绕过 3 秒短缓存：这些用例会切换设置，必须拿到最新结果
  const res = await fetch(`${base}/api/docker/containers?refresh=1`);
  expect(res.status).toBe(200);
  return (await res.json()).sources;
}

describe('容器列表回传的设备定位元数据', () => {
  it('via 源必须回传解析后的 host + serverId（否则远程设备模式下被过滤 → UI 全失败）', async () => {
    const sources = await fetchSources();
    const via = sources.find((s) => s.sourceId === 'via-src');
    expect(via).toBeDefined();
    expect(via.host).toBe('192.168.1.222'); // 从 getServers 按 serverId 解析
    expect(via.serverId).toBe('srv-1');
    expect(via.containers.length).toBe(1);
    expect(via.error).toBeUndefined();
  });

  it('legacy TCP 源保持原 host 语义，serverId 为空串', async () => {
    const sources = await fetchSources();
    const tcp = sources.find((s) => s.sourceId === 'tcp-src');
    expect(tcp.host).toBe('203.0.113.10');
    expect(tcp.serverId).toBe('');
  });

  it('禁用的源不出现在列表里', async () => {
    const sources = await fetchSources();
    expect(sources.find((s) => s.sourceId === 'off-src')).toBeUndefined();
  });

  it('getServers 找不到对应服务器时 host 回落为空串（不产生 undefined）', async () => {
    testSettings = {
      dockerSources: [
        { id: 'orphan', name: '孤儿', via: { serverId: 'no-such-srv' }, enabled: true },
      ],
    };
    const sources = await fetchSources();
    const orphan = sources.find((s) => s.sourceId === 'orphan');
    expect(orphan.host).toBe('');
    expect(orphan.serverId).toBe('no-such-srv');
  });
});
