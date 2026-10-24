import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import http from 'http';
import fs from 'fs';

// ── 假 SSH：forwardOutStreamLocal 返回一条连到「假 dockerd」的 duplex ──
// 这样能在没有真实 SSH 服务器的前提下，端到端验证整条桥的水管。
const holder = vi.hoisted(() => ({
  mode: 'ok',            // ok | channel-fail | unsupported | ssh-down
  dockerdPort: 0,
  isConnected: true,
  channelsOpened: 0,
  conn: null,
  sockets: [],           // 假通道创建的 net.Socket，teardown 时统一销毁
}));

vi.mock('../remote.js', () => ({
  ensureSshConnection: vi.fn(async () => {
    if (holder.mode === 'ssh-down') throw new Error('connect ECONNREFUSED 10.0.0.1:22');
    return {
      isConnected: () => holder.isConnected,
      getConnection: () => holder.conn,
      forwardOutStreamLocal: async () => {
        if (holder.mode === 'unsupported') {
          throw new Error('(SSH) Channel open failure: Unknown channel type');
        }
        if (holder.mode === 'channel-fail') {
          throw new Error('(SSH) Channel open failure: open failed');
        }
        holder.channelsOpened++;
        // 立即挂 no-op error 监听：连接失败时不能变成 unhandled 'error'
        const s = net.connect(holder.dockerdPort);
        s.on('error', () => { /* 假通道：吞掉连接失败 */ });
        holder.sockets.push(s);
        return s;
      },
    };
  }),
}));

const {
  ensureDockerBridge, closeDockerBridge, closeAllDockerBridges,
  describeChannelFailure, getBridgeStatus, bridgeStats, _internals,
} = await import('../docker-ssh-bridge.js');

const IS_WIN = process.platform === 'win32';

/**
 * 桥的「存在」判定：POSIX 是文件系统 socket 文件，Windows 是命名管道。
 * 命名管道没有文件实体，只能用「能不能连上」来判断。
 */
async function bridgeAlive(sock) {
  if (!IS_WIN) return fs.existsSync(sock);
  return new Promise((resolve) => {
    const c = net.connect(sock, () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
  });
}

/** 最小可用的假 dockerd：实现 dockerode 需要的 /version 与 /_ping */
function startFakeDockerd() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/version')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Version: '19.03.15', ApiVersion: '1.40', Os: 'linux' }));
    } else if (req.url.startsWith('/_ping')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else {
      res.writeHead(404).end('{}');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

let dockerd;
beforeEach(async () => {
  holder.mode = 'ok';
  holder.isConnected = true;
  holder.channelsOpened = 0;
  holder.sockets = [];
  holder.conn = { once: () => {} };
  dockerd = await startFakeDockerd();
  holder.dockerdPort = dockerd.address().port;
});

afterEach(async () => {
  await closeAllDockerBridges();
  // 假通道的 socket 不属于桥的 channels（probe 等），这里统一销毁，
  // 否则它们会在测试环境拆除后异步报 ECONNREFUSED。
  for (const s of holder.sockets) { try { s.destroy(); } catch { /* 已销毁 */ } }
  holder.sockets = [];
  await new Promise((r) => dockerd.close(r));
});

describe('描述通道失败（分层报错）', () => {
  it('socket 不存在 / dockerd 没跑 → 明确提示检查 dockerd 与路径', () => {
    const msg = describeChannelFailure(new Error('(SSH) Channel open failure: open failed'), '/var/run/docker.sock');
    expect(msg).toContain('/var/run/docker.sock');
    expect(msg).toContain('dockerd');
    expect(msg).not.toMatch(/^\(SSH\)/); // 不能把裸 ssh2 信息直接抛给用户
  });

  it('远端 sshd 不支持 streamlocal → 指出需要 OpenSSH 6.7+', () => {
    const msg = describeChannelFailure(new Error('Channel open failure: Unknown channel type'), '/var/run/docker.sock');
    expect(msg).toContain('OpenSSH 6.7+');
  });

  it('未知错误也保证非空且带层名前缀', () => {
    const msg = describeChannelFailure(new Error(''), '/x.sock');
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain('SSH 通道');
  });
});

describe('桥的建立与复用', () => {
  it('建桥后返回可连的本地 socket，且能真正到达 dockerd', async () => {
    const sock = await ensureDockerBridge('srv-1');
    expect(await bridgeAlive(sock)).toBe(true);

    // 通过桥发一个真实的 docker API 请求
    const body = await new Promise((resolve, reject) => {
      const c = net.connect(sock, () => {
        c.write('GET /version HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      c.on('data', (d) => { buf += d.toString(); });
      c.on('end', () => resolve(buf));
      c.on('error', reject);
    });
    expect(body).toContain('19.03.15');
  });

  it.skipIf(IS_WIN)('本地 socket 权限为 600（防止本机其它用户拿到 Docker 控制权）', async () => {
    const sock = await ensureDockerBridge('srv-1');
    const mode = fs.statSync(sock).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(IS_WIN)('放在 0700 私有目录，而不是公共 /tmp 根下', async () => {
    const dirMode = fs.statSync(_internals.BRIDGE_DIR).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const sock = await ensureDockerBridge('srv-1');
    expect(sock.startsWith(_internals.BRIDGE_DIR)).toBe(true);
  });

  it.runIf(IS_WIN)('Windows 用命名管道桥（文件系统 unix socket 会 EACCES）', async () => {
    const sock = await ensureDockerBridge('srv-win');
    expect(sock.startsWith('\\\\.\\pipe\\openlog-docker-')).toBe(true);
    expect(await bridgeAlive(sock)).toBe(true);
  });

  it('同一个 (服务器, socket) 复用同一个桥', async () => {
    const a = await ensureDockerBridge('srv-1');
    const before = bridgeStats.built;
    const b = await ensureDockerBridge('srv-1');
    expect(b).toBe(a);
    expect(bridgeStats.built).toBe(before); // 没有重建
  });

  it('并发调用只建一次桥（否则会 EADDRINUSE 撞同一个 socket 路径）', async () => {
    const before = bridgeStats.built;
    const results = await Promise.all([
      ensureDockerBridge('srv-c'),
      ensureDockerBridge('srv-c'),
      ensureDockerBridge('srv-c'),
      ensureDockerBridge('srv-c'),
      ensureDockerBridge('srv-c'),
    ]);
    // 五个调用必须拿到同一个路径
    expect(new Set(results).size).toBe(1);
    // 而且只真正构建了一次
    expect(bridgeStats.built).toBe(before + 1);
    expect(await bridgeAlive(results[0])).toBe(true);
  });

  it('并发调用中若建桥失败，所有调用者都拿到同一个错误（不会漏出 EADDRINUSE）', async () => {
    holder.mode = 'channel-fail';
    const settled = await Promise.allSettled([
      ensureDockerBridge('srv-f'), ensureDockerBridge('srv-f'), ensureDockerBridge('srv-f'),
    ]);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    const msgs = new Set(settled.map((s) => s.reason.message));
    expect(msgs.size).toBe(1);                    // 同一个错误
    expect([...msgs][0]).toContain('dockerd');    // 是分层信息，不是 EADDRINUSE
    expect([...msgs][0]).not.toContain('EADDRINUSE');
  });

  it('不同远端 socket 路径 → 不同的桥', async () => {
    const a = await ensureDockerBridge('srv-1', '/var/run/docker.sock');
    const b = await ensureDockerBridge('srv-1', '/run/docker.sock');
    expect(a).not.toBe(b);
  });

  it('SSH 连接失效后桥必须重建（复用检查不能只看 handle 存在）', async () => {
    const a = await ensureDockerBridge('srv-r2');
    const before = bridgeStats.built;

    holder.isConnected = false;   // 模拟 SSH 断连
    const b = await ensureDockerBridge('srv-r2');

    // 本地 socket 路径是按 (serverId, 远端路径) 确定性生成的，
    // 所以「重建了」要靠构建计数判断，不能靠路径不同。
    expect(bridgeStats.built).toBe(before + 1);
    expect(await bridgeAlive(b)).toBe(true);

    // 重建后必须真的能用（不是留了个死 socket）
    holder.isConnected = true;
    const body = await new Promise((resolve, reject) => {
      const c = net.connect(b, () => {
        c.write('GET /version HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      c.on('data', (d) => { buf += d.toString(); });
      c.on('end', () => resolve(buf));
      c.on('error', reject);
    });
    expect(body).toContain('19.03.15');
    expect(a).toBe(b); // 路径确实相同（确定性命名），此处仅记录该事实
  });

  it('显式关闭后不再出现在状态里，socket 不再可连', async () => {
    const sock = await ensureDockerBridge('srv-1');
    await closeDockerBridge('srv-1');
    expect(getBridgeStatus().find((x) => x.serverId === 'srv-1')).toBeUndefined();
    expect(await bridgeAlive(sock)).toBe(false);
  });
});

describe('失败路径', () => {
  it('SSH 连不上 → 报 SSH 层错误，不回落到 localhost:2375', async () => {
    holder.mode = 'ssh-down';
    await expect(ensureDockerBridge('srv-x')).rejects.toThrow(/SSH 层/);
  });

  it('通道打不开（dockerd 没跑）→ 建桥即失败，且不留半成品', async () => {
    holder.mode = 'channel-fail';
    await expect(ensureDockerBridge('srv-y')).rejects.toThrow(/dockerd/);
    expect(getBridgeStatus().find((x) => x.serverId === 'srv-y')).toBeUndefined();
  });

  it('远端 sshd 太老不支持转发 → 明确提示 OpenSSH 版本要求', async () => {
    holder.mode = 'unsupported';
    await expect(ensureDockerBridge('srv-z')).rejects.toThrow(/OpenSSH 6\.7\+/);
  });

  it('建桥失败后可重试成功（上一次的失败没有污染状态）', async () => {
    holder.mode = 'channel-fail';
    await expect(ensureDockerBridge('srv-r')).rejects.toThrow();
    holder.mode = 'ok';
    const sock = await ensureDockerBridge('srv-r');
    expect(await bridgeAlive(sock)).toBe(true);
  });
});
