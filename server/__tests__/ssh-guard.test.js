import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { guardSshConnection } from '../ssh-guard.js';
import { isTransientNetworkError, TRANSIENT_NETWORK_CODES } from '../errors.js';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 造一个最小可用的假 NodeSSH 实例。 */
function fakeSsh() {
  const conn = new EventEmitter();
  return { connection: conn };
}

describe('guardSshConnection 存在的理由：node-ssh 在 ready 后移除了 error 监听者', () => {
  it('没有守卫时，connection 上的 error 事件会直接抛出（这就是崩溃机制）', () => {
    const ssh = fakeSsh();
    // EventEmitter 对无监听者的 'error' 是直接 throw
    expect(() => ssh.connection.emit('error', new Error('read ETIMEDOUT'))).toThrow('read ETIMEDOUT');
  });

  it('挂了守卫之后，同样的 error 事件不再抛出', () => {
    const ssh = fakeSsh();
    guardSshConnection(ssh, '测试', () => {});
    expect(() => ssh.connection.emit('error', new Error('read ETIMEDOUT'))).not.toThrow();
  });

  it('真实事故的错误对象被正确记录，且进程不会退出', () => {
    const ssh = fakeSsh();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    guardSshConnection(ssh, '服务器 4090服务器', () => {});

    const err = Object.assign(new Error('read ETIMEDOUT'), {
      code: 'ETIMEDOUT', errno: -60, syscall: 'read', level: 'client-socket',
    });
    expect(() => ssh.connection.emit('error', err)).not.toThrow();

    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('4090服务器');
    expect(logged).toContain('ETIMEDOUT');
    spy.mockRestore();
  });

  it('会调用 onError 回调，让调用方清理连接表', () => {
    const ssh = fakeSsh();
    const onError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    guardSshConnection(ssh, '测试', onError);
    const err = new Error('boom');
    ssh.connection.emit('error', err);
    expect(onError).toHaveBeenCalledWith(err);
    vi.restoreAllMocks();
  });

  it('onError 自己抛错也不会让进程崩', () => {
    const ssh = fakeSsh();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    guardSshConnection(ssh, '测试', () => { throw new Error('清理失败'); });
    expect(() => ssh.connection.emit('error', new Error('原始错误'))).not.toThrow();
    vi.restoreAllMocks();
  });

  it('幂等：重复挂载不会让 onError 被调用多次', () => {
    const ssh = fakeSsh();
    const onError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    guardSshConnection(ssh, '测试', onError);
    guardSshConnection(ssh, '测试', onError);
    ssh.connection.emit('error', new Error('x'));
    expect(onError).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('connection 不存在时安静返回 false，不抛错（connect 失败路径）', () => {
    for (const bad of [null, undefined, {}, { connection: null }, { connection: 42 }]) {
      expect(() => guardSshConnection(bad, '测试')).not.toThrow();
      expect(guardSshConnection(bad, '测试')).toBe(false);
    }
  });
});

describe('所有建 SSH 连接的地方都必须挂守卫', () => {
  // 只测 ssh-guard.js 本身不够：漏接一处就等于没修。
  const SITES = [
    { file: 'remote.js', what: 'testConnection + connectServer' },
    { file: 'gpu.js', what: 'getRemoteGPUs' },
  ];

  it.each(SITES)('$file：每个 ssh.connect() 之后都有 guardSshConnection', ({ file }) => {
    const src = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
    const connects = (src.match(/await ssh\.connect\(/g) || []).length;
    const guards = (src.match(/guardSshConnection\(/g) || []).length;

    expect(connects, `${file} 里应有 ssh.connect 调用`).toBeGreaterThan(0);
    expect(guards, `${file}: ${connects} 处 connect 但只有 ${guards} 处 guard`).toBe(connects);
  });

  it('每个 guardSshConnection( 调用都出现在对应 connect 之后', () => {
    for (const { file } of SITES) {
      const src = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
      const connectAt = src.indexOf('await ssh.connect(');
      const guardAt = src.indexOf('guardSshConnection(');
      expect(guardAt, `${file}: guard 应在 connect 之后`).toBeGreaterThan(connectAt);
    }
  });
});

describe('isTransientNetworkError：决定进程是否继续运行', () => {
  const mk = (code, level, syscall) => Object.assign(new Error('x'), { code, level, syscall });

  it('真实事故的那个错误被判定为可继续运行', () => {
    const err = Object.assign(new Error('read ETIMEDOUT'), {
      code: 'ETIMEDOUT', errno: -60, syscall: 'read', level: 'client-socket',
    });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('白名单内的网络码 + socket 来源 → true', () => {
    for (const code of TRANSIENT_NETWORK_CODES) {
      expect(isTransientNetworkError(mk(code, 'client-socket')), code).toBe(true);
      expect(isTransientNetworkError(mk(code, undefined, 'read')), code).toBe(true);
    }
  });

  it('非白名单的错误码 → false（仍然退出，不掩盖真 bug）', () => {
    for (const code of ['EACCES', 'ENOENT', 'ERR_ASSERTION', 'MODULE_NOT_FOUND', 'EADDRINUSE']) {
      expect(isTransientNetworkError(mk(code, 'client-socket')), code).toBe(false);
    }
  });

  it('没有 code 的普通异常 → false（必须退出）', () => {
    expect(isTransientNetworkError(new Error('普通 bug'))).toBe(false);
    expect(isTransientNetworkError(new TypeError('类型错误'))).toBe(false);
    expect(isTransientNetworkError(new ReferenceError('x is not defined'))).toBe(false);
  });

  it('有网络码但不来自 socket → false（应用逻辑自己抛的，不能掩盖）', () => {
    expect(isTransientNetworkError(mk('ECONNRESET', undefined, undefined))).toBe(false);
    expect(isTransientNetworkError({ code: 'ETIMEDOUT' })).toBe(false);
    expect(isTransientNetworkError({ code: 'ETIMEDOUT', level: 'weird' })).toBe(false);
  });

  it('畸形输入不抛错', () => {
    for (const bad of [null, undefined, 0, '', 'str', [], 42, true, Symbol('s')]) {
      expect(() => isTransientNetworkError(bad)).not.toThrow();
      expect(isTransientNetworkError(bad)).toBe(false);
    }
  });
});

describe('回归：index.js 的 uncaughtException 不再对所有错误一律退出', () => {
  it('对瞬时网络错误放行，其余仍然 shutdown(…,1)', () => {
    const src = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
    const at = src.indexOf("process.on('uncaughtException'");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 700);

    expect(body, '应调用 isTransientNetworkError').toContain('isTransientNetworkError');
    expect(body, '瞬时网络错误应 return（不退出）').toMatch(/isTransientNetworkError\(err\)[\s\S]*?return;/);
    expect(body, '其余路径仍应 shutdown').toContain("shutdown('uncaughtException', 1)");
  });
});
