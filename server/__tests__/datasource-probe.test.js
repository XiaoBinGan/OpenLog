/**
 * Swagger/OpenAPI 探测 + 外部数据库采样测试
 *
 * 这两件事都必须能证明「拿到的数字来自对方，不是我们编的」：
 *   - 文档探测：只有真解析出对方的 spec 才算成功，返回 HTML 页面就老实说拿不到清单
 *   - 外部库采样：权限不足要如实进 unavailable，不能用 0 冒充
 */
import { describe, it, expect, vi } from 'vitest';
import { probeApiDocs, summarizeSpec, SPEC_PATHS } from '../datasource/api-probe.js';
import { probeExternalDb, explainConnectError, QUERIES } from '../datasource/db-probe.js';

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const specV3 = {
  openapi: '3.0.3',
  info: { title: 'Pet API', version: '1.2.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/pets': { get: {}, post: {} },
    '/pets/{id}': { get: {}, delete: {} },
  },
};

describe('summarizeSpec', () => {
  it('v3：标题/版本/basePath/接口清单', () => {
    const s = summarizeSpec(specV3);
    expect(s).toMatchObject({ title: 'Pet API', version: '1.2.0', specVersion: '3.0.3', basePath: '/v1' });
    expect(s.endpoints).toEqual([
      { method: 'GET', path: '/pets' },
      { method: 'POST', path: '/pets' },
      { method: 'DELETE', path: '/pets/{id}' },
      { method: 'GET', path: '/pets/{id}' },
    ]);
  });

  it('v2：swagger 2.0 + basePath', () => {
    const s = summarizeSpec({ swagger: '2.0', info: { title: 'Old', version: '0.1' }, basePath: '/api', paths: { '/x': { get: {} } } });
    expect(s).toMatchObject({ specVersion: '2.0', basePath: '/api' });
    expect(s.endpoints).toEqual([{ method: 'GET', path: '/x' }]);
  });

  it('脏数据不崩：null / 空对象 / paths 不是对象', () => {
    expect(summarizeSpec(null).endpoints).toEqual([]);
    expect(summarizeSpec({}).endpoints).toEqual([]);
    expect(summarizeSpec({ paths: 'nope' }).endpoints).toEqual([]);
    expect(summarizeSpec({ paths: { '/a': null } }).endpoints).toEqual([]);
  });

  it('只认 HTTP 方法，parameters/summary 不会被当成接口', () => {
    const s = summarizeSpec({ paths: { '/a': { get: {}, parameters: [], summary: 'x' } } });
    expect(s.endpoints).toEqual([{ method: 'GET', path: '/a' }]);
  });

  it('servers[0].url 是绝对地址时只取 path 部分', () => {
    expect(summarizeSpec({ servers: [{ url: 'http://h:8080/api/v2' }], paths: {} }).basePath).toBe('/api/v2');
    expect(summarizeSpec({ servers: [{ url: '/' }], paths: {} }).basePath).toBe('');
  });
});

describe('probeApiDocs', () => {
  it('第一个地址就命中 → 不再往下试（省请求）', async () => {
    const fetchImpl = vi.fn(async (url) => jsonRes(specV3));
    const r = await probeApiDocs({ baseUrl: 'http://h:8080/', fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.found).toBe('/openapi.json');
    expect(r.summary.endpoints).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // baseUrl 结尾斜杠被规范化
    expect(fetchImpl.mock.calls[0][0]).toBe('http://h:8080/openapi.json');
  });

  it('一路 404 → 穷举后 ok:false，attempts 里能看到每个地址的真实状态码', async () => {
    const fetchImpl = vi.fn(async () => jsonRes('not found', 404));
    const r = await probeApiDocs({ baseUrl: 'http://h:1', fetchImpl, paths: ['/a', '/b'] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有找到');
    expect(r.attempts).toEqual([{ path: '/a', status: 404 }, { path: '/b', status: 404 }]);
  });

  it('文档地址返回 HTML（Swagger UI 页面）→ ok:true 但明确说拿不到清单', async () => {
    const fetchImpl = async () => jsonRes('<!doctype html><html>swagger ui</html>');
    const r = await probeApiDocs({ baseUrl: 'http://h', fetchImpl, paths: ['/docs'] });
    expect(r.ok).toBe(true);
    expect(r.found).toBe('/docs');
    expect(r.summary).toBe(null);
    expect(r.error).toContain('不是 JSON');
  });

  it('401/403 不算找到，继续试下一个', async () => {
    const fetchImpl = vi.fn(async (url) => (url.endsWith('/openapi.json') ? jsonRes({ error: 'auth' }, 401) : jsonRes(specV3)));
    const r = await probeApiDocs({ baseUrl: 'http://h', fetchImpl, paths: ['/openapi.json', '/v3/api-docs'] });
    expect(r.found).toBe('/v3/api-docs');
  });

  it('网络异常 → ok:false，error 说「连不上」而不是「没找到」', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const r = await probeApiDocs({ baseUrl: 'http://h', fetchImpl, paths: ['/a'] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('连不上');
    expect(r.attempts[0].error).toContain('ECONNREFUSED');
  });

  it('超时被识别成 timeout（用 AbortError 模拟）', async () => {
    const fetchImpl = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const r = await probeApiDocs({ baseUrl: 'http://h', fetchImpl, paths: ['/a'] });
    expect(r.attempts[0].error).toBe('timeout');
  });

  it('baseUrl 为空 → 直接失败，不发请求', async () => {
    const fetchImpl = vi.fn();
    const r = await probeApiDocs({ baseUrl: '', fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('默认探测列表包含常见文档地址', () => {
    for (const p of ['/openapi.json', '/swagger.json', '/v3/api-docs', '/swagger-ui.html']) {
      expect(SPEC_PATHS).toContain(p);
    }
  });
});

describe('probeExternalDb —— 外部数据库采样', () => {
  const fakeClient = (answers) => ({
    query: vi.fn(async (sql) => {
      for (const [needle, rows] of Object.entries(answers)) if (sql.includes(needle)) return rows;
      return [];
    }),
    close: vi.fn(async () => {}),
  });

  it('postgres 正常：版本/大小/连接数/表体积/锁等待都有值', async () => {
    const client = fakeClient({
      'version()': [{ v: 'PostgreSQL 16.3' }],
      pg_database_size: [{ bytes: '8421376' }],
      pg_stat_activity: [{ total: '7', active: '2' }],
      pg_class: [
        { relname: 'log_records', bytes: '4096000', live_tup: '1200', dead_tup: '30' },
      ],
      pg_locks: [{ waiting: '1' }],
    });
    const r = await probeExternalDb({ dialect: 'postgres', host: 'h', user: 'u', password: 'p', database: 'd', connect: () => client });
    expect(r.ok).toBe(true);
    expect(r.version).toContain('PostgreSQL');
    expect(r.sizeBytes).toBe(8421376);
    expect(r.conns).toEqual({ total: 7, active: 2 });
    expect(r.tables[0]).toEqual({ relname: 'log_records', bytes: 4096000, liveTup: 1200, deadTup: 30 });
    expect(r.waitingLocks).toBe(1);
    expect(r.unavailable).toEqual([]);
    expect(client.close).toHaveBeenCalled();
  });

  it('权限不足的单项降级：其它项照常返回，unavailable 说人话', async () => {
    const client = {
      query: vi.fn(async (sql) => {
        if (sql.includes('pg_stat_activity')) { const e = new Error('permission denied for relation pg_stat_activity'); throw e; }
        if (sql.includes('version()')) return [{ v: 'PG 16' }];
        return [];
      }),
      close: async () => {},
    };
    const r = await probeExternalDb({ dialect: 'postgres', host: 'h', connect: () => client });
    expect(r.ok).toBe(true);
    expect(r.version).toBe('PG 16');
    expect(r.conns).toBeUndefined();
    expect(r.unavailable[0]).toContain('权限不足');
  });

  it('连不上时给出可执行的原因（拒绝/超时/认证/库不存在）', async () => {
    const cases = [
      ['connect ECONNREFUSED 127.0.0.1:5432', '连接被拒绝'],
      ['Connection terminated due to connection timeout', '连接超时'],
      ['password authentication failed for user "x"', '认证失败'],
      ['database "nope" does not exist', '库不存在'],
    ];
    for (const [msg, expectText] of cases) {
      const r = await probeExternalDb({ dialect: 'postgres', host: 'h', connect: () => { throw new Error(msg); } });
      expect(r.ok).toBe(false);
      expect(r.error, msg).toContain(expectText);
    }
  });

  it('不支持的方言 → 如实说，不发请求', async () => {
    const r = await probeExternalDb({ dialect: 'redis', host: 'h' });
    expect(r.ok).toBe(false);
    expect(r.unavailable[0]).toContain('只支持 postgres / mysql');
  });

  it('mysql 走 information_schema，字段名映射正确', async () => {
    // 注意 needle 要能区分：mysql 的表体积 SQL 里也含 data_length，所以用 table_name 区分
    const client = {
      query: vi.fn(async (sql) => {
        if (sql.includes('VERSION()')) return [{ v: '8.0.36' }];
        if (sql.includes('table_name')) return [{ relname: 't1', bytes: 2048, live_tup: 10, dead_tup: 0 }];
        if (sql.includes('processlist')) return [{ total: '3', active: '1' }];
        if (sql.includes('data_length')) return [{ bytes: 1024 }];
        return [];
      }),
      close: async () => {},
    };
    const r = await probeExternalDb({ dialect: 'mysql', host: 'h', connect: () => client });
    expect(r.ok).toBe(true);
    expect(r.version).toBe('8.0.36');
    expect(r.tables[0]).toMatchObject({ relname: 't1', bytes: 2048 });
    // mysql 没有锁等待查询，所以不应出现该字段
    expect(r.waitingLocks).toBeUndefined();
  });

  it('缺 host → 不进网络', async () => {
    const connect = vi.fn();
    const r = await probeExternalDb({ dialect: 'postgres', host: '', connect });
    expect(r.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it('所有 SQL 都是只读（不许出现 DDL/DML）', () => {
    for (const [, q] of Object.entries(QUERIES)) {
      for (const sql of Object.values(q)) {
        if (!sql) continue;
        expect(sql).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i);
      }
    }
  });
});

describe('explainConnectError', () => {
  it('驱动错误码也能翻译', () => {
    expect(explainConnectError({ code: '28P01', message: 'x' })).toContain('认证失败');
    expect(explainConnectError({ code: '3D000', message: 'x' })).toContain('库不存在');
  });
});
