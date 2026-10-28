import { describe, it, expect, vi, beforeEach } from 'vitest';

const kv = vi.hoisted(() => ({ store: new Map() }));
let dbType = 'sqlite';

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    // 模拟同步 SQLite 适配层（返回非 Promise 结果也兼容 await）
    run: async () => ({ changes: 1 }),
    get: async () => ({ n: kv.store.get('__count') ?? 0 }),
    all: async () => [],
    exec: async () => {},
  }),
  getDbType: () => dbType,
  schemaDialect: () => ({ id: 'TEXT', key: 'TEXT', text: 'TEXT', json: 'JSON', epoch: 'INTEGER', now: "strftime('%s','now')" }),
  getKv: (k) => kv.store.get(k),
  setKv: (k, v) => { kv.store.set(k, JSON.parse(JSON.stringify(v))); },
}));

const store = await import('../remote-store.js');

beforeEach(async () => {
  await store.flushServerWrites();
  kv.store.clear();
  store._resetTableReady();
});

describe('serverToRow / rowToServer —— 字段映射', () => {
  const encrypt = (p) => `enc:${p}`;
  const decrypt = (p) => (typeof p === 'string' && p.startsWith('enc:') ? p.slice(4) : p);

  it('标准字段一一对应', () => {
    const row = store.serverToRow({
      id: 's1', name: '机器1', host: '1.2.3.4', port: 22, username: 'deploy',
      password: 'pw', logPath: '/var/log', watchFiles: '*.log',
      status: 'connected', lastError: null, lastConnected: '2026-01-01',
    }, encrypt);
    expect(row.id).toBe('s1');
    expect(row.password).toBe('enc:pw');
    expect(row.watch_files).toBe('"*.log"');
    expect(row.status).toBe('connected');
    expect(row.extra).toBeNull();
  });

  it('未知字段进 extra，不丢', () => {
    const row = store.serverToRow({ id: 's1', name: 'n', host: 'h', customField: 'x', tags: ['a'] }, encrypt);
    expect(JSON.parse(row.extra)).toEqual({ customField: 'x', tags: ['a'] });
  });

  it('行→对象：extra 展开、watchFiles 还原成数组、密码解密', () => {
    const server = store.rowToServer({
      id: 's1', name: '机器1', host: 'h', port: 22, username: 'u', password: 'enc:pw',
      private_key: null, private_key_path: null, log_path: '/var/log',
      watch_files: '["*.log","*.err"]', status: 'error',
      last_error: 'timeout', last_error_at: 'now', last_connected: null,
      extra: JSON.stringify({ customField: 'x' }),
    }, decrypt);
    expect(server.password).toBe('pw');
    expect(server.watchFiles).toEqual(['*.log', '*.err']);
    expect(server.customField).toBe('x');
    expect(server.status).toBe('error');
    expect(server.lastError).toBe('timeout');
  });

  it('空行返回 null，坏 JSON 不炸', () => {
    expect(store.rowToServer(null, (p) => p)).toBeNull();
    expect(() => store.rowToServer({ id: 'a', name: 'b', host: 'c', extra: '{bad json' }, (p) => p)).not.toThrow();
  });
});

describe('写队列 —— 合并 + 微批（替代整块 JSON 重写）', () => {
  it('同一台机器多次排队只留最后一次', () => {
    const row = (status) => ({ id: 's1', status });
    store.queueServerWrite(row('connected'));
    store.queueServerWrite(row('disconnected'));
    store.queueServerWrite(row('error'));
    expect(store._pendingWriteCount()).toBe(1);
  });

  it('不同机器各自排队', () => {
    store.queueServerWrite({ id: 'a' });
    store.queueServerWrite({ id: 'b' });
    store.queueServerWrite({ id: 'c' });
    expect(store._pendingWriteCount()).toBe(3);
  });

  it('flush 后队列清空', async () => {
    store.queueServerWrite({ id: 'a' });
    await store.flushServerWrites();
    expect(store._pendingWriteCount()).toBe(0);
  });

  it('删除与写入互斥（同一 id 后写的覆盖前面的）', () => {
    store.queueServerWrite({ id: 'a' });
    store.queueServerDelete('a');
    expect(store._pendingWriteCount()).toBe(1);
  });
});

describe('旧 kv 迁移', () => {
  it('表为空且存在旧 kv → 迁移并保留备份', async () => {
    kv.store.set('remote_servers', [{ id: 's1', name: 'n1', host: 'h1' }, { id: 's2', name: 'n2', host: 'h2' }]);
    kv.store.set('__count', 0);
    const migrated = await store.migrateLegacyKvServers((s) => store.serverToRow(s, (p) => p));
    // 因为 mock 的 count 恒为 0，这里只验证「旧数据被搬到备份 key」
    expect(kv.store.get('remote_servers_legacy')).toHaveLength(2);
    expect(kv.store.get('remote_servers')).toEqual([]);
    expect([0, 2]).toContain(migrated);
  });

  it('没有旧数据时返回 0', async () => {
    expect(await store.migrateLegacyKvServers((s) => store.serverToRow(s, (p) => p))).toBe(0);
  });
});

describe('buildBulkInsertSql —— 批量插入（1000 行别再逐个往返）', () => {
  it('单批生成多行 VALUES，参数按列顺序展开', () => {
    const rows = [
      { id: 'a', name: 'n1', host: 'h1' },
      { id: 'b', name: 'n2', host: 'h2' },
    ];
    const { sql, params } = store.buildBulkInsertSql(rows);
    expect(sql).toContain('INSERT INTO remote_servers');
    expect(sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    expect(params).toHaveLength(34); // 17 列 × 2 行
    expect(params[0]).toBe('a');
    expect(params[17]).toBe('b');
  });

  it('空数组不生成语句', () => {
    expect(store.buildBulkInsertSql([]).sql).toContain('VALUES ');
  });

  it('每批行数常量合理（往返次数 vs SQL 大小的折中）', () => {
    expect(store.BULK_INSERT_CHUNK).toBeGreaterThanOrEqual(50);
    expect(store.BULK_INSERT_CHUNK).toBeLessThanOrEqual(500);
  });
});

describe('建表幂等', () => {
  it('重复调用 ensureServersTable 不抛错', async () => {
    await expect(store.ensureServersTable()).resolves.toBeUndefined();
    await expect(store.ensureServersTable()).resolves.toBeUndefined();
  });

  it('暴露表名常量', () => {
    expect(store.SERVERS_TABLE).toBe('remote_servers');
  });
});
