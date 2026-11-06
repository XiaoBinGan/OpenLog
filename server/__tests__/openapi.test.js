import { describe, it, expect } from 'vitest';
import express from 'express';
import {
  expressPathToOpenApi,
  collectRoutes,
  buildOpenApi,
  renderDocsHtml,
} from '../openapi.js';

/**
 * 用真实 express 构造一个「脚手架级」app：
 * 中间件层 + 嵌套一层 router（app.use('/api', router)）+ router 内的中间件层
 * + 多方法路径 + router 内再嵌一层 router + 重复注册（去重）+ SPA 通配路由。
 */
function makeApp() {
  const app = express();
  app.use(express.json()); // 中间件层：无 route、无 handle.stack
  app.use((req, res, next) => next()); // 纯函数中间件层

  const router = express.Router();
  router.use((req, res, next) => next()); // router 内中间件层，也必须被忽略

  router.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

  router.route('/items')
    .get((req, res) => res.json([]))
    .post((req, res) => res.json({ ok: true }))
    .delete((req, res) => res.json({ ok: true }));

  const nested = express.Router();
  nested.get('/deep/:name', (req, res) => res.json({ name: req.params.name }));
  router.use('/sub', nested);

  // 同 method + path 注册两次：express 会产生两个 route 层，collectRoutes 必须去重
  router.get('/same', (req, res) => res.end('a'));
  router.get('/same', (req, res) => res.end('b'));

  app.use('/api', router);
  app.get('*', (req, res) => res.send('spa fallback'));
  return app;
}

const app = makeApp();

describe('expressPathToOpenApi', () => {
  it('把 :id 转成 {id}', () => {
    expect(expressPathToOpenApi('/api/users/:id')).toBe('/api/users/{id}');
  });

  it('支持多段参数', () => {
    expect(expressPathToOpenApi('/api/docker/:sourceId/:containerId/logs'))
      .toBe('/api/docker/{sourceId}/{containerId}/logs');
  });

  it('无参数的路径原样返回', () => {
    expect(expressPathToOpenApi('/api/logs')).toBe('/api/logs');
    expect(expressPathToOpenApi('/')).toBe('/');
  });

  it('通配 * 落成命名路径参数', () => {
    expect(expressPathToOpenApi('*')).toBe('/{path}');
    expect(expressPathToOpenApi('/api/*')).toBe('/api/{path}');
  });

  it('可选参数与带正则的参数降级成普通参数', () => {
    expect(expressPathToOpenApi('/a/:id?')).toBe('/a/{id}');
    expect(expressPathToOpenApi('/a/:id(\\d+)')).toBe('/a/{id}');
  });

  it('空字符串 / 非字符串不炸', () => {
    expect(expressPathToOpenApi('')).toBe('/');
    expect(expressPathToOpenApi(undefined)).toBe('/');
  });
});

describe('collectRoutes', () => {
  it('取到嵌套 router 里的路由，且 app.use("/api") 前缀被拼上', () => {
    const routes = collectRoutes(app);
    const paths = routes.map((r) => r.path);

    expect(routes).toContainEqual({ method: 'GET', path: '/api/users/{id}' });
    // 关键断言：前缀必须拼对，不能是 /users/{id}
    expect(paths).not.toContain('/users/{id}');
  });

  it('router 内再挂 router 的前缀也拼对', () => {
    expect(collectRoutes(app)).toContainEqual({ method: 'GET', path: '/api/sub/deep/{name}' });
  });

  it('忽略中间件层（cors / jsonParser / 鉴权 / 纯函数中间件）', () => {
    const routes = collectRoutes(app);
    // 只有 7 条真实路由：users + items×3 + sub/deep + same + SPA 通配
    expect(routes).toHaveLength(7);
    for (const r of routes) {
      expect(r.path.startsWith('/')).toBe(true);
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).toContain(r.method);
      expect(typeof r.method).toBe('string');
      expect(r.method).toBe(r.method.toUpperCase());
      // 中间件层没有 path，若被当成路由会出现 undefined / '' 路径
      expect(r.path).not.toBe('');
      expect(r.path).not.toContain('undefined');
    }
  });

  it('多方法路径拆成多条', () => {
    const items = collectRoutes(app).filter((r) => r.path === '/api/items');
    expect(items.map((r) => r.method).sort()).toEqual(['DELETE', 'GET', 'POST']);
  });

  it('去重：同 method + path 只留一条', () => {
    const same = collectRoutes(app).filter((r) => r.path === '/api/same');
    expect(same).toEqual([{ method: 'GET', path: '/api/same' }]);
  });

  it('排序：按 path 升序，同 path 内按 method 升序', () => {
    const routes = collectRoutes(app);
    const keyed = routes.map((r) => `${r.path}\u0000${r.method}`);
    const sorted = [...keyed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(keyed).toEqual(sorted);

    const items = routes.filter((r) => r.path === '/api/items').map((r) => r.method);
    expect(items).toEqual(['DELETE', 'GET', 'POST']); // 同 path 内 method 也是升序
  });

  it('没有路由的空 app 返回空数组', () => {
    expect(collectRoutes(express())).toEqual([]);
  });
});

describe('buildOpenApi', () => {
  const spec = buildOpenApi(app);

  it('是 OpenAPI 3.0.3 且有 info / servers / paths', () => {
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info).toMatchObject({ title: 'OpenLog API', version: '1.0.0' });
    expect(Array.isArray(spec.servers)).toBe(true);
    expect(spec.servers[0].url).toBeTruthy();
    expect(Object.keys(spec.paths)).toContain('/api/users/{id}');
  });

  it('每路径每方法给 summary 与 200 responses', () => {
    const op = spec.paths['/api/users/{id}'].get;
    expect(op.summary).toBe('GET /api/users/{id}');
    expect(op.responses['200']).toEqual({ description: 'OK' });
  });

  it('多方法路径下每个方法各一个 operation', () => {
    expect(Object.keys(spec.paths['/api/items']).sort()).toEqual(['delete', 'get', 'post']);
  });

  it('有全局 bearerAuth scheme 与 security', () => {
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
  });

  it('opts 能覆盖 title / version / serverUrl', () => {
    const custom = buildOpenApi(app, { title: 'T', version: '9.9.9', serverUrl: 'https://example.test' });
    expect(custom.info).toEqual({ title: 'T', version: '9.9.9' });
    expect(custom.servers[0].url).toBe('https://example.test');
  });
});

describe('renderDocsHtml', () => {
  const spec = buildOpenApi(app);
  const html = renderDocsHtml(spec);

  it('返回完整 HTML，含搜索框', () => {
    expect(typeof html).toBe('string');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('id="q"');
    expect(html).toContain('type="search"');
  });

  it('列出接口路径与方法徽章', () => {
    expect(html).toContain('/api/users/{id}');
    expect(html).toContain('/api/sub/deep/{name}');
    expect(html).toContain('class="m get"');
  });

  it('按 /api 第二段分组', () => {
    expect(html).toContain('id="g-users"');
    expect(html).toContain('id="g-items"');
    expect(html).toContain('id="g-sub"');
  });

  it('不含任何外部 http(s) 资源引用（离线可开）', () => {
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/swagger-ui|cdn\./i);
  });

  it('体积 < 30KB', () => {
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(30 * 1024);
  });

  it('空 spec 也能渲染', () => {
    const empty = renderDocsHtml({});
    expect(empty.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(empty).toContain('id="q"');
  });
});
