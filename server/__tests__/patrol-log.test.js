import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logPatrolSkipOnce, clearPatrolSkip, patrolSkipSeen } from '../docker.js';

/**
 * 背景：巡检间隔 10s，一台不可达的服务器会**每 10 秒**输出一行完全相同的
 * `[Patrol] 跳过 X: connect ETIMEDOUT ...`。实测 20 分钟刷了 200+ 行，
 * 把真正有用的日志淹没了 —— 诊断别的故障时根本翻不到。
 */
describe('巡检失败日志去重', () => {
  let spy;
  beforeEach(() => { patrolSkipSeen.clear(); spy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('同一个错误连续出现只记录一次', () => {
    for (let i = 0; i < 20; i++) logPatrolSkipOnce('4090服务器', 'connect ETIMEDOUT 203.0.113.10:2375');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('错误内容变化时重新记录（并带上此前的内容）', () => {
    logPatrolSkipOnce('A', 'err1');
    logPatrolSkipOnce('A', 'err1');
    logPatrolSkipOnce('A', 'err2');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1].join(' ')).toContain('err2');
    expect(spy.mock.calls[1].join(' ')).toContain('err1'); // 此前的内容
  });

  it('不同源各自独立去重', () => {
    logPatrolSkipOnce('A', 'same');
    logPatrolSkipOnce('B', 'same');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('恢复后再次失败会重新记录（clearPatrolSkip 清掉状态）', () => {
    spy.mockRestore();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logPatrolSkipOnce('A', 'err');
    logPatrolSkipOnce('A', 'err');
    expect(warn).toHaveBeenCalledTimes(1);

    clearPatrolSkip('A');                       // 巡检成功
    expect(log).toHaveBeenCalledTimes(1);       // 补一条恢复日志
    expect(log.mock.calls[0].join(' ')).toContain('已恢复');

    logPatrolSkipOnce('A', 'err');              // 又失败了
    expect(warn).toHaveBeenCalledTimes(2);

    log.mockRestore(); warn.mockRestore();
  });

  it('未失败过时 clear 不做任何事', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    clearPatrolSkip('从没失败过');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('本地临时端口变化不触发重新记录（去重按归一化签名，实测每 10s 刷屏的根因）', () => {
    logPatrolSkipOnce('A', 'connect ETIMEDOUT 1.2.3.4:2375 - Local (0.0.0.0:54981)');
    logPatrolSkipOnce('A', 'connect ETIMEDOUT 1.2.3.4:2375 - Local (0.0.0.0:12345)');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('同一台不可达机器的错误码振荡不触发重新记录', () => {
    logPatrolSkipOnce('A', 'SSH 层：无法建立连接：connect ETIMEDOUT 192.168.1.222:40022 - Local (0.0.0.0:1)');
    logPatrolSkipOnce('A', 'SSH 层：无法建立连接：connect ENETUNREACH 192.168.1.222:40022 - Local (0.0.0.0:2)');
    logPatrolSkipOnce('A', '无法获取容器列表: socket hang up');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('错误本质变化（不可达 → 权限不足）仍会重新记录', () => {
    logPatrolSkipOnce('A', 'connect ETIMEDOUT 1.2.3.4:2375');
    logPatrolSkipOnce('A', 'connect ETIMEDOUT 1.2.3.4:2375');
    logPatrolSkipOnce('A', 'EACCES: permission denied, unlink /tmp/x.sock');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1].join(' ')).toContain('permission denied');
  });

  it('static: 巡检 catch 用去重函数，而不是直接 console.warn', async () => {
    const fs = await import('fs');
    const { fileURLToPath } = await import('url');
    const src = fs.readFileSync(fileURLToPath(new URL('../docker.js', import.meta.url)), 'utf8');
    expect(src).toContain('logPatrolSkipOnce(src.name, errorMessage(err))');
    expect(src).not.toMatch(/console\.warn\(`\[Patrol\] 跳过 \$\{src\.name\}/);
  });
});
