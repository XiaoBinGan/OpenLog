/**
 * WS 握手回归（Lead 验收时发现的真问题）
 *
 * 现象：改完子协议鉴权后，用 `['openlog.v1','token.<正确>']` 连仍被 401。
 * 原因：index.js 里有两道闸门 —— wss 的 verifyClient（认子协议）和
 * `server.on('upgrade')` 里的 isUpgradeAuthorized（还在只认 ?token=）。
 * 两道口径不一致 → 子协议永远过不去。
 *
 * 这里锁住：两处必须共用 evaluateUpgradeRequest，且不许再有「只读 query」的判定。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('WS 升级鉴权：两道闸门必须同口径', () => {
  const index = read('server/index.js');

  it('isUpgradeAuthorized 用 evaluateUpgradeRequest（不是自己解析 query）', () => {
    const start = index.indexOf('function isUpgradeAuthorized');
    expect(start).toBeGreaterThan(0);
    // 函数体到下一个顶层 `server.on(` / 下一个顶层 function 为止
    const rest = index.slice(start + 10);
    const endCandidates = [rest.indexOf('\nserver.on('), rest.indexOf('\nfunction ')].filter((i) => i > 0);
    const end = endCandidates.length ? Math.min(...endCandidates) : rest.length;
    const fn = rest.slice(0, end);
    expect(fn).toContain('evaluateUpgradeRequest(');
    // 不许自己从 URL 取 token —— 那正是漏掉子协议的老写法
    expect(fn).not.toContain("searchParams.get('token')");
  });

  it('wss 构造里同时挂了 verifyClient 与 handleProtocols', () => {
    expect(index).toContain('verifyClient: createVerifyClient(');
    expect(index).toContain('handleProtocols: createHandleProtocols()');
  });

  it('前端 8 处 WebSocket 都带了子协议（少一处就 401）', () => {
    const files = [
      'client/src/components/AIShellTerminal.tsx',
      'client/src/components/ShellTerminal.tsx',
      'client/src/components/Layout.tsx',
      'client/src/contexts/WebSocketContext.tsx',
      'client/src/pages/Dashboard.tsx',
      'client/src/pages/Docker.tsx',
      'client/src/pages/Logs.tsx',
    ];
    for (const f of files) {
      const src = read(f);
      const calls = src.match(/new WebSocket\(/g) || [];
      const withProto = src.match(/new WebSocket\([^)]*\), wsProtocols\(\)\)/g) || [];
      expect(calls.length, `${f} 有 ${calls.length} 处 new WebSocket`).toBeGreaterThan(0);
      expect(withProto.length, `${f} 只有 ${withProto.length}/${calls.length} 处带子协议`).toBe(calls.length);
    }
  });

  it('auth.ts 的 withWsToken 不再往 URL 拼 token', () => {
    const auth = read('client/src/api/auth.ts');
    const body = auth.slice(auth.indexOf('export function withWsToken'));
    expect(body).not.toMatch(/['"`]\?token=/);
    expect(auth).toContain('export function wsProtocols');
  });
});
