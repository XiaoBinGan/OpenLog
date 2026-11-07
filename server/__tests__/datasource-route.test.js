/**
 * 数据源路由：密码不出后端 + 探测结果写回 + 降级不 500
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createDatasourceRouter } from '../routes/datasource.js';
import { createDatasourceStore } from '../datasource/store.js';

/** 内存版 store（用真 store 实现 + 假 db，保证加密/打码路径也是真的） */
function memDb() {
  const rows = new Map();
  return {
    async exec() {},
    async run(sql, ...p) {
      if (/^INSERT/i.test(sql.trim())) {
        const [id, kind, collection, label, dialect, host, port, user, pw, dbn, base, enabled, created] = p;
        rows.set(id, {
          id, kind, collection, label, dialect, host, port, db_user: user,
          db_password: pw, db_name: dbn, base_url: base, enabled,
          last_probe_ms: null, last_status: null, last_error: null, last_probe_at: null, created_at: created,
        });
        return { changes: 1 };
      }
      if (/^UPDATE monitor_datasource SET kind/i.test(sql.trim())) {
        const [kind, collection, label, dialect, host, port, user, pw, dbn, base, enabled, id] = p;
        const r = rows.get(id);
        if (r) Object.assign(r, { kind, collection, label, dialect, host, port, db_user: user, db_password: pw, db_name: dbn, base_url: base, enabled });
        return { changes: r ? 1 : 0 };
      }
      if (/^UPDATE monitor_datasource SET last_probe_ms/i.test(sql.trim())) {
        const [ms, status, error, at, id] = p;
        const r = rows.get(id);
        if (r) Object.assign(r, { last_probe_ms: ms, last_status: status, last_error: error, last_probe_at: at });
        return { changes: r ? 1 : 0 };
      }
      if (/^DELETE/i.test(sql.trim())) {
        const [id] = p;
        return { changes: rows.delete(id) ? 1 : 0 };
      }
      return { changes: 0 };
    },
    async get(sql, id) { return rows.get(id) || null; },
    async all() { return [...rows.values()]; },
  };
}

async function startApp(deps) {
  const app = express();
  app.use(express.json());
  app.use(createDatasourceRouter(deps));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

describe('PUT /api/monitor/datasources/:id —— 密码纪律', () => {
  it('保存时收明文，读回来只有打码，且加密后落库', async () => {
    const db = memDb();
    const store = createDatasourceStore({
      db, dbType: 'sqlite',
      encrypt: (s) => `enc(${s})`,
      decrypt: (s) => String(s).replace(/^enc\((.*)\)$/, '$1'),
      maskSecret: (s) => (s ? s.slice(0, 2) + '***' + s.slice(-2) : ''),
    });
    await store.ensureSchema();
    const { base, close } = await startApp({ store, enabled: () => true });
    try {
      const put = await fetch(`${base}/api/monitor/datasources/db%3Ax`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'db', label: 'pg', dialect: 'postgres', host: 'h', port: 5432, user: 'u', password: 'SuperSecret99', database: 'app' }),
      });
      const body = await put.json();
      expect(body.ok).toBe(true);
      // 返回体里绝不能出现明文
      expect(JSON.stringify(body)).not.toContain('SuperSecret99');
      expect(body.item.passwordMasked).toBe('Su***99');
      expect(body.item.hasPassword).toBe(true);
      // 库里存的是密文
      const row = await db.get('select', 'db:x');
      expect(row.db_password).toBe('enc(SuperSecret99)');

      // 列表同样不含明文
      const list = await (await fetch(`${base}/api/monitor/datasources`)).json();
      expect(JSON.stringify(list)).not.toContain('SuperSecret99');
    } finally { await close(); }
  });

  it('不传 password 时保留原密码（编辑其它字段不该清空密码）', async () => {
    const db = memDb();
    const store = createDatasourceStore({ db, dbType: 'sqlite', encrypt: (s) => `enc(${s})`, decrypt: (s) => String(s).replace(/^enc\((.*)\)$/, '$1') });
    const { base, close } = await startApp({ store, enabled: () => true });
    try {
      await fetch(`${base}/api/monitor/datasources/a`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'db', label: 'x', password: 'pw1', host: 'h' }),
      });
      await fetch(`${base}/api/monitor/datasources/a`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'db', label: '改名', host: 'h2' }),
      });
      const row = await db.get('select', 'a');
      expect(row.db_password).toBe('enc(pw1)');
      expect(row.label).toBe('改名');
      expect(row.host).toBe('h2');
    } finally { await close(); }
  });
});

describe('POST /:id/probe —— 探测结果写回', () => {
  it('服务类：调 probeDocs 并把状态记到库里', async () => {
    const db = memDb();
    const store = createDatasourceStore({ db, dbType: 'sqlite' });
    const probeDocs = vi.fn(async () => ({ ok: true, ms: 12, found: '/openapi.json', summary: { title: 'T', endpoints: [{ method: 'GET', path: '/a' }] }, attempts: [] }));
    const { base, close } = await startApp({ store, enabled: () => true, probeDocs });
    try {
      await fetch(`${base}/api/monitor/datasources/s1`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'service', label: 'svc', baseUrl: 'http://h:1' }),
      });
      const r = await (await fetch(`${base}/api/monitor/datasources/s1/probe`, { method: 'POST' })).json();
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('service');
      expect(probeDocs).toHaveBeenCalled();
      const row = await db.get('select', 's1');
      expect(row.last_status).toBe('ok');
      expect(row.last_probe_ms).toBe(12);
    } finally { await close(); }
  });

  it('数据库类：把密码解密后交给 probeDb（否则根本连不上）', async () => {
    const db = memDb();
    const store = createDatasourceStore({ db, dbType: 'sqlite', encrypt: (s) => `enc(${s})`, decrypt: (s) => String(s).replace(/^enc\((.*)\)$/, '$1') });
    let seen = null;
    const probeDb = vi.fn(async (args) => { seen = args; return { ok: true, ms: 5, version: 'PG', unavailable: [], tables: [] }; });
    const { base, close } = await startApp({ store, enabled: () => true, probeDb });
    try {
      await fetch(`${base}/api/monitor/datasources/d1`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'db', label: 'pg', dialect: 'postgres', host: 'h', port: 5432, user: 'u', password: 'pw-xyz', database: 'app' }),
      });
      await fetch(`${base}/api/monitor/datasources/d1/probe`, { method: 'POST' });
      expect(seen.password).toBe('pw-xyz');
      expect(seen).toMatchObject({ dialect: 'postgres', host: 'h', port: 5432, user: 'u', database: 'app' });
    } finally { await close(); }
  });

  it('探测抛错 → 200 + ok:false，并把失败原因写回（前端能显示「上次失败」）', async () => {
    const db = memDb();
    const store = createDatasourceStore({ db, dbType: 'sqlite' });
    const probeDb = vi.fn(async () => { throw new Error('boom'); });
    const { base, close } = await startApp({ store, enabled: () => true, probeDb });
    try {
      await fetch(`${base}/api/monitor/datasources/d2`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'db', label: 'pg', dialect: 'postgres', host: 'h' }),
      });
      const r = await fetch(`${base}/api/monitor/datasources/d2/probe`, { method: 'POST' });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(false);
      const row = await db.get('select', 'd2');
      expect(row.last_status).toBe('fail');
      expect(row.last_error).toContain('boom');
    } finally { await close(); }
  });
});

describe('discover —— 容器扫描', () => {
  it('按源传各自的 Docker 配置（本机 socket vs 远程 TCP）', async () => {
    const store = createDatasourceStore({ db: memDb(), dbType: 'sqlite' });
    const seen = [];
    const listContainers = vi.fn(async (id, cfg) => { seen.push([id, cfg]); return []; });
    const { base, close } = await startApp({
      store, enabled: () => true,
      listContainers,
      inspectContainer: vi.fn(async () => null),
      getDockerConfig: async (id) => (id === 'local' ? { socketPath: '/var/run/docker.sock' } : { host: '10.0.0.9', port: 2375 }),
      dockerSources: () => [{ id: 'r1', label: '远程一' }],
      hostHintFor: () => '10.0.0.9',
    });
    try {
      const r = await (await fetch(`${base}/api/monitor/datasources/discover`)).json();
      expect(r.available).toBe(true);
      expect(listContainers).toHaveBeenCalledTimes(2);
      expect(seen).toEqual([
        ['local', { socketPath: '/var/run/docker.sock' }],
        ['r1', { host: '10.0.0.9', port: 2375 }],
      ]);
    } finally { await close(); }
  });

  it('某个源挂了不影响其它源，错误进 errors[]', async () => {
    const store = createDatasourceStore({ db: memDb(), dbType: 'sqlite' });
    const { base, close } = await startApp({
      store, enabled: () => true,
      listContainers: async (id) => { if (id === 'local') throw new Error('ECONNREFUSED'); return [{ id: 'abc123456789', state: 'running', image: 'x:1', names: ['x'], ports: [] }]; },
      inspectContainer: async () => null,
      getDockerConfig: () => ({}),
      dockerSources: () => [{ id: 'r1', label: '远程一' }],
    });
    try {
      const r = await (await fetch(`${base}/api/monitor/datasources/discover`)).json();
      expect(r.errors.join(' ')).toContain('ECONNREFUSED');
      expect(r.available).toBe(true);
    } finally { await close(); }
  });
});

describe('store 未接线', () => {
  it('全部端点返回 available:false 而不是 500', async () => {
    const { base, close } = await startApp({ enabled: () => true });
    try {
      const r = await fetch(`${base}/api/monitor/datasources`);
      expect(r.status).toBe(200);
      const b = await r.json();
      expect(b.available).toBe(false);
      expect(b.reason).toContain('未接入');
    } finally { await close(); }
  });
});
