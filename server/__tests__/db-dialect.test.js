import { describe, it, expect } from 'vitest';

const {
  normalizeParams, toPgPlaceholders, schemaDialect, buildSchemaSql, resolveDbConfig,
} = await import('../db/index.js');

describe('normalizeParams —— 两种调用风格都吃', () => {
  it('展开形式', () => {
    expect(normalizeParams(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('数组形式', () => {
    expect(normalizeParams([['a', 'b']])).toEqual(['a', 'b']);
  });
  it('空参数', () => {
    expect(normalizeParams([])).toEqual([]);
  });
  it('单参数且是数组里的数组（边界）不误拆', () => {
    // 只有一个参数本来就是数组时，按「数组形式」展开是期望行为
    expect(normalizeParams([[1, 2]])).toEqual([1, 2]);
  });
});

describe('toPgPlaceholders —— ? → $n（跳过字符串与注释）', () => {
  it('基础转换', () => {
    expect(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
  });

  it('ORDER BY / LIMIT / OFFSET', () => {
    expect(toPgPlaceholders('SELECT * FROM log ORDER BY ts DESC LIMIT ? OFFSET ?'))
      .toBe('SELECT * FROM log ORDER BY ts DESC LIMIT $1 OFFSET $2');
  });

  it('字符串字面量里的 ? 不能改', () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE note = 'a?b' AND k = ?"))
      .toBe("SELECT * FROM t WHERE note = 'a?b' AND k = $1");
  });

  it('双引号标识符里的 ? 不能改', () => {
    expect(toPgPlaceholders('SELECT "col?" FROM t WHERE id = ?')).toBe('SELECT "col?" FROM t WHERE id = $1');
  });

  it("转义的 '' 不会破坏状态机", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE s = 'it''s ? ok' AND id = ?"))
      .toBe("SELECT * FROM t WHERE s = 'it''s ? ok' AND id = $1");
  });

  it('行注释里的 ? 忽略', () => {
    expect(toPgPlaceholders('SELECT 1 -- 这里有个 ? 注释\nWHERE id = ?')).toBe('SELECT 1 -- 这里有个 ? 注释\nWHERE id = $1');
  });

  it('没有占位符时原样返回', () => {
    expect(toPgPlaceholders('CREATE TABLE t (id TEXT)')).toBe('CREATE TABLE t (id TEXT)');
  });

  it('占位符序号连续递增（含 INSERT 多列）', () => {
    const sql = 'INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)';
    expect(toPgPlaceholders(sql)).toBe('INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, $3)');
  });

  it('ON CONFLICT 语句', () => {
    const sql = `INSERT INTO machines (id, name) VALUES (?, ?)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name`;
    expect(toPgPlaceholders(sql)).toContain('VALUES ($1, $2)');
    expect(toPgPlaceholders(sql)).toContain('ON CONFLICT(id) DO UPDATE');
  });
});

describe('schemaDialect —— 三种方言的类型/默认值', () => {
  it('SQLite：秒级时间戳用 INTEGER + strftime', () => {
    const d = schemaDialect('sqlite');
    expect(d.epoch).toBe('INTEGER');
    expect(d.now).toContain('strftime');
  });

  it('PostgreSQL：BIGINT + EXTRACT(EPOCH…)（INTEGER 32 位会在 2038 溢出）', () => {
    const d = schemaDialect('postgres');
    expect(d.epoch).toBe('BIGINT');
    expect(d.now).toContain('EXTRACT(EPOCH FROM now())');
    expect(d.json).toBe('JSONB');
  });

  it('MySQL：主键/键列用 VARCHAR（TEXT 不能做 PK）+ UNIX_TIMESTAMP', () => {
    const d = schemaDialect('mysql');
    expect(d.id).toContain('VARCHAR');
    expect(d.key).toContain('VARCHAR');
    expect(d.now).toBe('UNIX_TIMESTAMP()');
  });
});

describe('buildSchemaSql —— 方言化 DDL', () => {
  it('生成全部 6 张表', () => {
    const sqls = buildSchemaSql('sqlite');
    expect(sqls).toHaveLength(6);
    const joined = sqls.join('\n');
    for (const table of ['machines', 'log_records', 'analysis_records', 'alert_configs', 'kv_store', 'skills']) {
      expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('PostgreSQL 版本不含 SQLite 专属函数', () => {
    const joined = buildSchemaSql('postgres').join('\n');
    expect(joined).not.toContain('strftime');
    expect(joined).toContain('EXTRACT(EPOCH FROM now())');
    expect(joined).toContain('JSONB');
  });

  it('SQLite 版本不含 PG 专属函数', () => {
    const joined = buildSchemaSql('sqlite').join('\n');
    expect(joined).not.toContain('EXTRACT(EPOCH');
    expect(joined).toContain("strftime('%s', 'now')");
  });

  it('MySQL 版本不用 TEXT 做 kv 主键', () => {
    const joined = buildSchemaSql('mysql').join('\n');
    expect(joined).toContain('key VARCHAR(191) PRIMARY KEY');
    expect(joined).not.toContain('key TEXT PRIMARY KEY');
  });
});

describe('resolveDbConfig —— 环境变量解析（不静默回退的前提）', () => {
  it('完全没配置 → 不显式，走 SQLite', () => {
    const c = resolveDbConfig({});
    expect(c.explicit).toBe(false);
    expect(c.type).toBeUndefined();
  });

  it('OPENLOG_DB_TYPE=postgres', () => {
    const c = resolveDbConfig({ OPENLOG_DB_TYPE: 'postgres' });
    expect(c.type).toBe('postgres');
    expect(c.explicit).toBe(true);
  });

  it('pg / postgresql 别名都认', () => {
    expect(resolveDbConfig({ OPENLOG_DB_TYPE: 'pg' }).type).toBe('postgres');
    expect(resolveDbConfig({ OPENLOG_DB_TYPE: 'postgresql' }).type).toBe('postgres');
  });

  it('DATABASE_URL 的 scheme 决定类型', () => {
    const c = resolveDbConfig({ OPENLOG_DATABASE_URL: 'postgres://u:p@h:5432/openlog' });
    expect(c.type).toBe('postgres');
    expect(c.connectionString).toBe('postgres://u:p@h:5432/openlog');
    expect(c.explicit).toBe(true);
  });

  it('mysql:// URL', () => {
    const c = resolveDbConfig({ DATABASE_URL: 'mysql://u:p@h:3306/db' });
    expect(c.type).toBe('mysql');
  });

  it('分字段配置也能识别出 postgres', () => {
    const c = resolveDbConfig({ OPENLOG_PG_HOST: '10.0.0.5', OPENLOG_PG_DATABASE: 'openlog', OPENLOG_PG_POOL_MAX: '20' });
    expect(c.type).toBe('postgres');
    expect(c.postgresConfig.host).toBe('10.0.0.5');
    expect(c.postgresConfig.max).toBe(20);
  });

  it('显式 sqlite 不与 URL 冲突时优先 sqlite', () => {
    const c = resolveDbConfig({ OPENLOG_DB_TYPE: 'sqlite' });
    expect(c.type).toBe('sqlite');
    expect(c.explicit).toBe(true);
  });

  it('端口字符串转数字', () => {
    const c = resolveDbConfig({ OPENLOG_PG_HOST: 'h', OPENLOG_PG_PORT: '6543' });
    expect(c.postgresConfig.port).toBe(6543);
  });
});
