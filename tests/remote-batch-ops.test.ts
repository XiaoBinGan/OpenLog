import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 批量连接/断开 + 状态真实性 的回归守卫。
 *
 * 真实事故（用户报告）：
 *   1. 重新进入页面显示"已连接"的绿色状态，但打开文件列表报
 *      `GET .../files 500 {"error":"服务器未连接"}` —— 因为 status 是持久化在数据库
 *      里的旧值，而进程重启后内存连接池是空的；
 *   2. 只能一台台点连接，没有全选/批量。
 *
 * 修复：状态以连接池实况为准（liveStatus）+ 数据路径按需重连 + 批量接口。
 * 这里做源码级守卫（前端没有 DOM 测试环境，后端行为由接口测试覆盖）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('服务器状态必须是「连接池实况」而不是持久化的旧值', () => {
  const remote = read('server/remote.js');

  it('存在 liveStatus 并检查 isConnected()', () => {
    expect(remote).toContain('export function liveStatus(');
    expect(remote).toMatch(/liveStatus[\s\S]{0,600}isConnected\(\)/);
  });

  it('getServers() 用 liveStatus 而不是直接返回 s.status', () => {
    const start = remote.indexOf('export function getServers()');
    const end = remote.indexOf('export function getServersWithEncryptedPasswords()');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = remote.slice(start, end);
    expect(body).toContain('liveStatus(s)');
    // 不能出现裸的 `status: s.status`
    expect(body).not.toMatch(/status:\s*s\.status,/);
  });

  it('持久化的 connected 在池里没有连接时降级为 disconnected', () => {
    const start = remote.indexOf('export function liveStatus(');
    const body = remote.slice(start, start + 700);
    expect(body).toMatch(/s\.status === 'connected'\)\s*return 'disconnected'/);
  });
});

describe('数据路径必须按需重连（避免 500 服务器未连接）', () => {
  const remote = read('server/remote.js');

  it('读目录/读文件/执行命令等不再直接抛「服务器未连接」', () => {
    const fns = ['listRemoteFiles', 'readRemoteFile', 'execRemoteCommand', 'getRemoteSystemStats', 'searchRemoteLogs'];
    for (const fn of fns) {
      const idx = remote.indexOf(`export async function ${fn}(`);
      expect(idx, `找不到 ${fn}`).toBeGreaterThan(-1);
      const body = remote.slice(idx, idx + 1200);
      expect(body, `${fn} 应使用 ensureSshConnection 按需重连`).toContain('await ensureSshConnection(id)');
    }
  });

  it('剩余直接读池的地方只应出现在连接管理内部（ensure/evict/disconnect）', () => {
    const lines = remote.split('\n');
    let currentFn = '';
    const offenders = [];
    lines.forEach((line) => {
      const m = line.match(/^(?:export )?(?:async )?function (\w+)/);
      if (m) currentFn = m[1];
      if (!line.includes('sshConnections.get(id)')) return;
      // 这几个函数本身就是连接生命周期管理；cancelChunkedUpload 只做上传会话清理，
      // 连接可能已经断开（拿不到就跳过），直接读池是正确行为。
      const allowed = ['ensureSshConnection', 'disconnectServer', 'connectServer', 'evictIdleConnections', 'cancelChunkedUpload'];
      if (!allowed.includes(currentFn)) offenders.push(`${currentFn}:${line.trim()}`);
    });
    expect(offenders, `这些函数仍在直接读连接池: ${offenders.join(' | ')}`).toEqual([]);
  });
});

describe('批量接口', () => {
  const routes = read('server/routes/remote.js');

  it('提供 batch/connect 与 batch/disconnect', () => {
    expect(routes).toContain("router.post('/api/remote/servers/batch/connect'");
    expect(routes).toContain("router.post('/api/remote/servers/batch/disconnect'");
  });

  it('批量路由注册在 :id 路由之前（否则 batch 会被当成 id）', () => {
    const batchIdx = routes.indexOf("'/api/remote/servers/batch/connect'");
    const idIdx = routes.indexOf("'/api/remote/servers/:id/connect'");
    expect(batchIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(-1);
    expect(batchIdx, 'batch 必须在 :id 之前注册').toBeLessThan(idIdx);
  });

  it('批量接口限并发（1000 台同时握手会打满）', () => {
    expect(routes).toContain('BATCH_CONNECT_CONCURRENCY');
    expect(routes).toMatch(/mapLimit\([\s\S]{0,200}BATCH_CONNECT_CONCURRENCY/);
  });

  it('ids 去重并拒绝空参数', () => {
    expect(routes).toContain('function normalizeIds(');
    expect(routes).toMatch(/"new Set\("|new Set\(rawList/);
    expect(routes).toMatch(/ids\.length === 0\)\s*return res\.status\(400\)/);
  });
});

describe('前端多选与批量操作', () => {
  const page = read('client/src/pages/Remote.tsx');

  it('卡片有勾选框且不触发选中服务器', () => {
    expect(page).toContain('selected={selectedIds.has(server.id)}');
    expect(page).toMatch(/onToggleSelect=\{\(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\);/);
  });

  it('支持全选 / 一键重连 / 一键断开', () => {
    expect(page).toContain('全选');
    expect(page).toContain("runBatch('connect')");
    expect(page).toContain("runBatch('disconnect')");
    expect(page).toContain('toggleSelectAll');
  });

  it('支持「全部重连(N)」一键连上所有未连接', () => {
    expect(page).toContain('runBatchConnectAll');
    expect(page).toContain('disconnectedCount');
  });

  it('批量操作调用后端批量接口并刷新', () => {
    expect(page).toMatch(/\/api\/remote\/servers\/batch\/\$\{action\}/);
    expect(page).toContain('await refreshServers()');
  });

  it('全选只作用于当前筛选结果（不会误伤被搜索过滤掉的）', () => {
    const start = page.indexOf('const runBatch = async');
    const body = page.slice(start, start + 1200);
    expect(body).toContain('filteredServers.some');
  });
});
