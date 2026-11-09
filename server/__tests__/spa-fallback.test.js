/**
 * server/__tests__/spa-fallback.test.js
 *
 * 起因（真实事故）：用户浏览器缓存了旧的 index.html，里面引用旧的
 * `assets/index-<oldhash>.js`。发版后该文件已不存在，而 SPA fallback 用
 * `app.get('*')` 无差别返回 index.html —— 于是请求 JS 拿到的是 HTML（200），
 * 浏览器执行时抛 `Unexpected token '<'`，整页白屏。
 * 用户看到的就是「部署了但页面没变 / 打不开」。
 *
 * 这里锁死三条规则：
 *   1. 带 hash 的 /assets/* 不存在 → 404（不能返回 HTML）
 *   2. 任何带扩展名的路径不存在 → 404
 *   3. 真正的页面路由（/assistant、/remote…）→ index.html，且 no-cache
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// 复制生产环境那段路由逻辑（不改生产代码，只验证规则本身）
function buildApp(distDir) {
  const app = express();
  const isApiPath = (p) => p === '/api' || p.startsWith('/api/');
  app.use(express.static(distDir, {
    index: false,
    setHeaders: (res, filePath) => {
      if (/[\\/]assets[\\/]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  const looksLikeAsset = (p) => p.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(p);
  app.get('*', (req, res, next) => {
    if (isApiPath(req.path)) return next();
    if (looksLikeAsset(req.path)) {
      return res.status(404).type('text/plain').send(`Not found: ${req.path}`);
    }
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(distDir, 'index.html'));
  });
  return app;
}

let server;
let base;
let distDir;

beforeAll(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-'));
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/assets/index-NEWHASH.js"></script></body></html>');
  fs.writeFileSync(path.join(distDir, 'assets', 'index-NEWHASH.js'), 'export const ok = 1;\n');
  server = http.createServer(buildApp(distDir));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('静态资源与 SPA fallback', () => {
  it('存在的 hash chunk 正常返回 JS', async () => {
    const r = await fetch(`${base}/assets/index-NEWHASH.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(await r.text()).toContain('export const ok');
  });

  it('**不存在的 hash chunk 返回 404，绝不返回 HTML**', async () => {
    const r = await fetch(`${base}/assets/index-OLDHASH.js`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).not.toContain('html');
    const body = await r.text();
    // 关键：body 不能以 < 开头（那会让浏览器抛 Unexpected token '<'）
    expect(body.trimStart().startsWith('<')).toBe(false);
  });

  it('不存在的普通静态文件也返回 404', async () => {
    for (const p of ['/favicon.ico', '/style.css', '/manifest.json', '/assets/x.png']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
    }
  });

  it('真正的页面路由返回 index.html', async () => {
    for (const p of ['/assistant', '/remote', '/settings', '/monitor']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-type'), p).toContain('html');
      expect(await r.text(), p).toContain('index-NEWHASH.js');
    }
  });

  it('页面路由的 index.html 是 no-cache（否则用户永远停在旧 chunk 名单上）', async () => {
    const r = await fetch(`${base}/assistant`);
    const cc = r.headers.get('cache-control') || '';
    expect(cc).toContain('no-cache');
    expect(cc).not.toContain('immutable');
  });

  it('/assets/* 走 immutable 缓存（内容变则文件名变，可永久缓存）', async () => {
    const r = await fetch(`${base}/assets/index-NEWHASH.js`);
    const cc = r.headers.get('cache-control') || '';
    expect(cc).toContain('immutable');
    expect(cc).toContain('max-age=31536000');
  });

  it('API 路径不会被 SPA fallback 吞掉', async () => {
    const r = await fetch(`${base}/api/health`);
    const body = await r.text();
    // 关键：不能返回 index.html 的内容（那会让前端把 HTML 当 JSON 解析）
    expect(body).not.toContain('index-NEWHASH.js');
    expect(r.status).toBe(404); // 这个测试 app 没挂 API 路由 → express 默认 404
  });

  it('带点号的页面路径也算资源（避免 /v1.2 这种被当页面）', () => {
    const looksLikeAsset = (p) => p.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(p);
    expect(looksLikeAsset('/assets/index-abc.js')).toBe(true);
    expect(looksLikeAsset('/favicon.svg')).toBe(true);
    expect(looksLikeAsset('/logo.png')).toBe(true);
    expect(looksLikeAsset('/assistant')).toBe(false);
    expect(looksLikeAsset('/remote/2')).toBe(false);
  });
});
