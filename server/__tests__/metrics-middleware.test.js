/**
 * #6 middleware 单测：server/metrics/api-middleware.js
 *
 * 用真实 express + http.createServer + 原生 fetch（项目没装 supertest，
 * 惯例同 docker-containers-meta.test.js）。
 * registry 一律用 stub，绝不 import ./registry.js / ./route-pattern.js ——
 * 那两个模块由其他人并行编写，此刻可能还不存在。真实接线由 Lead 做。
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createApiMetricsMiddleware } from '../metrics/api-middleware.js';

/** 假 registry：只把 record 的入参收集起来，断言用 */
function makeRegistry() {
  const calls = [];
  return {
    calls,
    record(route, method, statusCode, durationMs) {
      calls.push({ route, method, statusCode, durationMs });
    },
    dropped: 0,
  };
}

async function startApp(build) {
  const app = express();
  build(app);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

/** res 的 'finish' 事件与客户端拿到响应之间有调度间隙，轮询等它落地 */
async function waitUntil(fn, ms = 800) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe('createApiMetricsMiddleware', () => {
  it('200 正常响应 → 记录 1 次，route/method/status/duration 都正确', async () => {
    const reg = makeRegistry();
    const mw = createApiMetricsMiddleware({ registry: reg });
    const { base, close } = await startApp((app) => {
      app.use(mw);
      const r = express.Router();
      r.get('/x', (req, res) => res.json({ ok: true }));
      app.use('/api', r);
    });
    try {
      const res = await fetch(`${base}/api/x`);
      expect(res.status).toBe(200);
      await res.json();
      await waitUntil(() => reg.calls.length > 0);

      expect(reg.calls.length).toBe(1);
      const rec = reg.calls[0];
      expect(rec.route).toBe('/api/x'); // router 挂载前缀 + req.route.path
      expect(rec.method).toBe('GET');
      expect(rec.statusCode).toBe(200);
      expect(rec.durationMs).toBeGreaterThanOrEqual(0);
      expect(rec.durationMs).toBe(Math.round(rec.durationMs * 10) / 10); // 保留 1 位小数
      expect(mw.dropped).toBe(0);
    } finally {
      await close();
    }
  });

  it('500 响应也记录（不只是成功请求）', async () => {
    const reg = makeRegistry();
    const { base, close } = await startApp((app) => {
      app.use(createApiMetricsMiddleware({ registry: reg }));
      app.get('/api/boom', (req, res) => res.status(500).json({ error: 'boom' }));
    });
    try {
      const res = await fetch(`${base}/api/boom`);
      expect(res.status).toBe(500);
      await res.text();
      await waitUntil(() => reg.calls.length > 0);

      expect(reg.calls.length).toBe(1);
      expect(reg.calls[0].statusCode).toBe(500);
      expect(reg.calls[0].route).toBe('/api/boom');
    } finally {
      await close();
    }
  });

  it('401 / 429 也记录 —— 埋点确实在鉴权与限流之前', async () => {
    const reg = makeRegistry();
    const { base, close } = await startApp((app) => {
      app.use(createApiMetricsMiddleware({ registry: reg }));
      // 模拟真实 index.js 的顺序：埋点 → 限流 → 鉴权（这两层直接短路响应）
      app.use((req, res, next) => {
        if (req.path === '/api/busy') return res.status(429).json({ error: 'Too Many Requests' });
        if (req.path === '/api/secret') return res.status(401).json({ error: 'Unauthorized' });
        next();
      });
      app.get('/api/secret', (req, res) => res.json({ ok: true })); // 永远不会被走到
      app.get('/api/busy', (req, res) => res.json({ ok: true }));
    });
    try {
      const r401 = await fetch(`${base}/api/secret`);
      expect(r401.status).toBe(401);
      await r401.text();
      const r429 = await fetch(`${base}/api/busy`);
      expect(r429.status).toBe(429);
      await r429.text();
      await waitUntil(() => reg.calls.length >= 2);

      expect(reg.calls.length).toBe(2);
      expect(reg.calls.map((c) => c.statusCode).sort()).toEqual([401, 429]);
      // 未匹配到 route 时用 req.path 兜底（normalize 默认原样返回）
      expect(reg.calls.map((c) => c.route).sort()).toEqual(['/api/busy', '/api/secret']);
    } finally {
      await close();
    }
  });

  it('query string 绝不进记录（route 不含 ?token=...，字段也不多出任何东西）', async () => {
    const reg = makeRegistry();
    const { base, close } = await startApp((app) => {
      app.use(createApiMetricsMiddleware({ registry: reg }));
      const r = express.Router();
      r.get('/x', (req, res) => res.json({ ok: true }));
      app.use('/api', r);
    });
    try {
      const res = await fetch(`${base}/api/x?a=1&token=secret`);
      expect(res.status).toBe(200);
      await res.json();
      await waitUntil(() => reg.calls.length > 0);

      const rec = reg.calls[0];
      expect(rec.route).toBe('/api/x');
      expect(rec.route).not.toContain('?');
      expect(rec.route).not.toContain('token');
      // 记录对象只有这 4 个字段：没有 query / header / body 的容身之处
      expect(Object.keys(rec)).toEqual(['route', 'method', 'statusCode', 'durationMs']);
      expect(JSON.stringify(rec)).not.toContain('secret');
    } finally {
      await close();
    }
  });

  it('OPENLOG_METRICS=off 时 0 条记录（vi.stubEnv 后恢复）', async () => {
    const reg = makeRegistry();
    const mw = createApiMetricsMiddleware({ registry: reg });
    const { base, close } = await startApp((app) => {
      app.use(mw);
      app.get('/api/x', (req, res) => res.json({ ok: true }));
    });
    vi.stubEnv('OPENLOG_METRICS', 'off');
    try {
      const res = await fetch(`${base}/api/x`);
      expect(res.status).toBe(200);
      await res.json();
      await tick(120);
      expect(reg.calls.length).toBe(0);
      expect(mw.dropped).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await close();
    }
    // 恢复后同一中间件立刻重新开始记录
    const { base: base2, close: close2 } = await startApp((app) => {
      app.use(mw);
      app.get('/api/x', (req, res) => res.json({ ok: true }));
    });
    try {
      const res2 = await fetch(`${base2}/api/x`);
      await res2.json();
      await waitUntil(() => reg.calls.length > 0);
      expect(reg.calls.length).toBe(1);
    } finally {
      await close2();
    }
  });

  it('registry.record 抛异常 → 响应仍然 200，dropped 计数 +1', async () => {
    const reg = {
      dropped: 0,
      record() { throw new Error('registry 炸了'); },
    };
    const mw = createApiMetricsMiddleware({ registry: reg });
    const { base, close } = await startApp((app) => {
      app.use(mw);
      app.get('/api/x', (req, res) => res.json({ ok: true }));
    });
    try {
      const res = await fetch(`${base}/api/x`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true }); // 业务响应完全没被影响
      await waitUntil(() => mw.dropped > 0);
      expect(mw.dropped).toBe(1);
      expect(reg.dropped).toBe(0); // 只计在中间件自己身上
    } finally {
      await close();
    }
  });

  it('注入 shouldSkip 时静态资源被跳过（默认 null，需 Lead 传 shouldSkipPath）', async () => {
    const reg = makeRegistry();
    const { base, close } = await startApp((app) => {
      app.use(createApiMetricsMiddleware({
        registry: reg,
        shouldSkip: (p) => p.startsWith('/assets/'),
      }));
      app.get('/assets/app.js', (req, res) => res.type('application/javascript').send('//bundle'));
      app.get('/api/x', (req, res) => res.json({ ok: true }));
    });
    try {
      const staticRes = await fetch(`${base}/assets/app.js`);
      expect(staticRes.status).toBe(200);
      await staticRes.text();
      await tick();
      expect(reg.calls.length).toBe(0); // 静态资源不记

      const apiRes = await fetch(`${base}/api/x`);
      await apiRes.json();
      await waitUntil(() => reg.calls.length > 0);
      expect(reg.calls.length).toBe(1);
      expect(reg.calls[0].route).toBe('/api/x');
    } finally {
      await close();
    }
  });

  it('不传 shouldSkip 时静态路径不会被自动跳过（所以要靠注入，而不是写死）', async () => {
    const reg = makeRegistry();
    const { base, close } = await startApp((app) => {
      app.use(createApiMetricsMiddleware({ registry: reg }));
      app.get('/assets/app.js', (req, res) => res.type('application/javascript').send('//bundle'));
    });
    try {
      const res = await fetch(`${base}/assets/app.js`);
      expect(res.status).toBe(200);
      await res.text();
      await waitUntil(() => reg.calls.length > 0);
      expect(reg.calls.length).toBe(1);
      expect(reg.calls[0].route).toBe('/assets/app.js');
    } finally {
      await close();
    }
  });
});