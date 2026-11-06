/**
 * #14 openapi-router 单测：server/routes/openapi.js
 *
 * 用真 express + `app.listen(0)` + 原生 fetch（项目没装 supertest），
 * spec 一律用假的 —— 本文件要验的是「路由层的协议行为」（状态码/头/错误处理/鉴权闸门），
 * 不是 #3 openapi 的路由栈反解逻辑（那份在 openapi.test.js 里）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createOpenApiRouter } from '../routes/openapi.js';

/** 假 spec：两条路由，够用来验证 path/方法反推与 JSON 往返 */
function makeSpec() {
  return {
    openapi: '3.0.3',
    info: { title: 'Test API', version: '9.9.9' },
    paths: {
      '/api/ping': { get: { summary: 'GET /api/ping' } },
      '/api/remote/servers/{id}/shell': {
        post: { summary: '高危接口：远程 shell' },
        parameters: [],
      },
    },
  };
}

/** 起一个真实监听端口的 app，返回 { base, close } */
async function startApp(build) {
  const app = express();
  build(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let running = null;
async function serve(build) {
  running = await startApp(build);
  return running;
}

afterEach(async () => {
  if (running) {
    await running.close();
    running = null;
  }
});

describe('createOpenApiRouter', () => {
  it('GET /api/openapi.json 返回 spec 对象 + json content-type', async () => {
    const spec = makeSpec();
    const { base } = await serve((app) => app.use(createOpenApiRouter({ spec: () => spec })));

    const res = await fetch(`${base}/api/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(body).toEqual(spec);
    expect(body.paths['/api/ping'].get).toBeTruthy();
  });

  it('GET /api/docs 返回注入的 HTML 内容', async () => {
    const { base } = await serve((app) => app.use(createOpenApiRouter({
      spec: makeSpec,
      renderDocsHtml: (spec) => `<html><body><h1>DOCS-OK</h1><p>${Object.keys(spec.paths).length} paths</p></body></html>`,
    })));

    const res = await fetch(`${base}/api/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('DOCS-OK');
    expect(html).toContain('2 paths');
  });

  it('GET /api/docs?format=json 等价于 openapi.json', async () => {
    const spec = makeSpec();
    const { base } = await serve((app) => app.use(createOpenApiRouter({
      spec: () => spec,
      renderDocsHtml: () => '<html>should-not-be-used</html>',
    })));

    const res = await fetch(`${base}/api/docs?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(spec);
  });

  it('spec() 抛错 → 500 + { error }，且不泄漏 stack', async () => {
    const { base } = await serve((app) => app.use(createOpenApiRouter({
      spec: () => { throw new Error('route stack exploded'); },
    })));

    // 三个读 spec 的端点行为一致：坏数据一律 500，不静默降级成空清单
    for (const path of ['/api/openapi.json', '/api/docs', '/api/docs?format=json', '/api/openapi/routes']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('route stack exploded');
      const raw = JSON.stringify(body);
      expect(raw).not.toContain('at Object');
      expect(raw).not.toMatch(/[A-Za-z]:\\|\/server\/|\bat .*\.js:\d+/);
      expect(Object.keys(body)).toEqual(['error']);
    }
  });

  it('注入 authGuard 后不带凭证 → 401，带凭证 → 200', async () => {
    const spec = makeSpec();
    const guard = (req, res, next) => {
      if (!req.headers['x-test']) return res.status(401).end();
      next();
    };
    const { base } = await serve((app) => app.use(createOpenApiRouter({ spec: () => spec, authGuard: guard })));

    for (const path of ['/api/openapi.json', '/api/docs', '/api/openapi/routes']) {
      const denied = await fetch(`${base}${path}`);
      expect(denied.status, path).toBe(401);
    }

    const ok = await fetch(`${base}/api/openapi.json`, { headers: { 'x-test': '1' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(spec);
  });

  it('GET /api/openapi/routes 返回 count 与 routes 数组', async () => {
    const { base } = await serve((app) => app.use(createOpenApiRouter({ spec: makeSpec })));

    const res = await fetch(`${base}/api/openapi/routes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(Array.isArray(body.routes)).toBe(true);
    expect(body.routes).toContainEqual({ method: 'GET', path: '/api/ping' });
    expect(body.routes).toContainEqual({ method: 'POST', path: '/api/remote/servers/{id}/shell' });
    // parameters 这类非方法键不许被当成路由
    expect(body.routes.length).toBe(body.count);
  });

  it('deps.collectRoutes 优先于 spec 反推', async () => {
    const { base } = await serve((app) => app.use(createOpenApiRouter({
      spec: makeSpec,
      collectRoutes: () => [{ method: 'get', path: '/api/ping' }, { method: 'delete', path: '/api/x' }],
    })));

    const body = await (await fetch(`${base}/api/openapi/routes`)).json();
    expect(body.count).toBe(2);
    expect(body.routes).toContainEqual({ method: 'DELETE', path: '/api/x' });
  });

  it('Cache-Control: no-store 存在（新路由立刻可见）', async () => {
    const { base } = await serve((app) => app.use(createOpenApiRouter({ spec: makeSpec })));

    for (const path of ['/api/openapi.json', '/api/docs', '/api/docs?format=json', '/api/openapi/routes']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('spec 每次请求重新求值（惰性）', async () => {
    let n = 0;
    const { base } = await serve((app) => app.use(createOpenApiRouter({
      spec: () => ({ openapi: '3.0.3', info: { title: 'T', version: String(++n) }, paths: {} }),
    })));

    expect((await (await fetch(`${base}/api/openapi.json`)).json()).info.version).toBe('1');
    expect((await (await fetch(`${base}/api/openapi.json`)).json()).info.version).toBe('2');
  });

  it('不传 renderDocsHtml 时用内置文档页（不会白屏）', async () => {
    const { base } = await serve((app) => app.use(createOpenApiRouter({ spec: makeSpec })));

    const res = await fetch(`${base}/api/docs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('/api/ping');
  });

  it('deps.spec 不是函数 → 创建期 TypeError', () => {
    expect(() => createOpenApiRouter({})).toThrow(TypeError);
    expect(() => createOpenApiRouter({ spec: {} })).toThrow(TypeError);
  });
});