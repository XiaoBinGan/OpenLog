import { describe, it, expect, vi, beforeEach } from 'vitest';

// 桥接层单独测过了，这里只关心「源 → 配置」的解析规则，故 mock 掉建桥。
const holder = vi.hoisted(() => ({ bridgeCalls: [] }));

vi.mock('../docker-ssh-bridge.js', () => ({
  DEFAULT_REMOTE_DOCKER_SOCKET: '/var/run/docker.sock',
  ensureDockerBridge: vi.fn(async (serverId, remoteSocketPath) => {
    holder.bridgeCalls.push({ serverId, remoteSocketPath });
    return `/tmp/fake-bridge/${serverId}.sock`;
  }),
}));

const {
  resolveDockerTransport, resolveDockerTransportSync, transportKind, isSshDockerSource,
} = await import('../docker-transport.js');

beforeEach(() => { holder.bridgeCalls = []; });

describe('传输形态判断', () => {
  it('有 via.serverId → ssh', () => {
    expect(transportKind({ id: 'a', via: { serverId: 's1' } })).toBe('ssh');
    expect(isSshDockerSource({ via: { serverId: 's1' } })).toBe(true);
  });
  it('有 socketPath → socket', () => {
    expect(transportKind({ id: 'a', socketPath: '/var/run/docker.sock' })).toBe('socket');
  });
  it('只有 host/port → tcp', () => {
    expect(transportKind({ id: 'a', host: '10.0.0.1', port: 2375 })).toBe('tcp');
  });
  it('via 存在但 serverId 为空 → 不算 ssh（避免拿 undefined 去连）', () => {
    expect(isSshDockerSource({ via: {} })).toBe(false);
    expect(isSshDockerSource({ via: { socketPath: '/x.sock' } })).toBe(false);
  });
});

describe('socket / tcp 解析（必须与历史行为逐字节等价）', () => {
  it('socketPath 优先，且不再带 host/port', async () => {
    const c = await resolveDockerTransport({ socketPath: '/var/run/docker.sock', host: 'ignored', port: 9999 });
    expect(c).toEqual({ socketPath: '/var/run/docker.sock' });
  });

  it('tcp 源缺省 host=localhost / port=2375', async () => {
    const c = await resolveDockerTransport({ id: 'a' });
    expect(c.host).toBe('localhost');
    expect(c.port).toBe(2375);
  });

  it('tcp 源完整透传 host/port/tls/ca/cert/key', async () => {
    const c = await resolveDockerTransport({
      host: '10.0.0.1', port: 2376, tls: true, ca: 'CA', cert: 'CRT', key: 'KEY',
    });
    expect(c).toEqual({ host: '10.0.0.1', port: 2376, tls: true, ca: 'CA', cert: 'CRT', key: 'KEY' });
  });

  it('undefined → {}（保持 getDocker 的 localhost:2375 缺省）', async () => {
    expect(await resolveDockerTransport(undefined)).toEqual({});
  });

  it('幂等：已解析的配置再解析一次不变', async () => {
    const once = await resolveDockerTransport({ socketPath: '/x.sock' });
    expect(await resolveDockerTransport(once)).toEqual(once);
  });

  it('幂等：已解析的 tcp 配置再解析一次不变', async () => {
    const once = await resolveDockerTransport({ host: 'h', port: 1234, tls: true });
    expect(await resolveDockerTransport(once)).toEqual(once);
  });
});

describe('ssh (via) 解析', () => {
  it('建桥并返回本地 socket 路径', async () => {
    const c = await resolveDockerTransport({ id: 'a', via: { serverId: 'srv-1' } });
    expect(c.socketPath).toContain('srv-1');
    expect(holder.bridgeCalls).toEqual([{ serverId: 'srv-1', remoteSocketPath: '/var/run/docker.sock' }]);
  });

  it('自定义远端 socket 路径会透传（rootless/podman 场景）', async () => {
    await resolveDockerTransport({ id: 'a', via: { serverId: 'srv-2', socketPath: '/run/user/1000/docker.sock' } });
    expect(holder.bridgeCalls[0].remoteSocketPath).toBe('/run/user/1000/docker.sock');
  });

  it('ssh 源即使带了 host/port 也走桥（不能偷偷回落到 TCP）', async () => {
    const c = await resolveDockerTransport({ id: 'a', host: '1.2.3.4', port: 2375, via: { serverId: 'srv-3' } });
    expect(c.socketPath).toBeDefined();
    expect(c.host).toBeUndefined();
  });
});

describe('同步解析（SSH 源必须显式报错，不能静默退化）', () => {
  it('ssh 源同步解析抛错并说明原因', () => {
    expect(() => resolveDockerTransportSync({ id: 'a', name: '远端', via: { serverId: 's' } }))
      .toThrow(/SSH 桥/);
  });

  it('socket / tcp 同步解析与历史内联表达式一致', () => {
    expect(resolveDockerTransportSync({ socketPath: '/x.sock', host: 'h' }))
      .toEqual({ socketPath: '/x.sock', host: undefined, port: undefined, tls: undefined, ca: undefined, cert: undefined, key: undefined });
    expect(resolveDockerTransportSync({ host: 'h' }))
      .toEqual({ socketPath: undefined, host: 'h', port: 2375, tls: undefined, ca: undefined, cert: undefined, key: undefined });
    expect(resolveDockerTransportSync(undefined))
      .toEqual({ socketPath: undefined, host: 'localhost', port: 2375, tls: undefined, ca: undefined, cert: undefined, key: undefined });
  });
});
