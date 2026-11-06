/**
 * #1 migration —— 补列迁移必须幂等，且不许在数据库服务端日志里制造 ERROR。
 * 旧代码是「盲 ALTER + catch 空块」：列已存在时 PostgreSQL 会往服务端日志写
 * `ERROR: column "content" of relation "skills" already exists`（每次启动两条，
 * 被 LogWatch 采成告警）。现在必须走「探测 → 差集 → 只补缺的」。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mod = await import('../db/index.js');
const {
  missingColumns, columnProbeSql, columnNamesFromProbe,
  addColumnSql, skillsColumnSpecs, planAddColumnSql, ensureColumns,
} = mod;

const SRC = readFileSync(new URL('../db/index.js', import.meta.url), 'utf8');

/** 静默 logger（用来断言「只记一次」） */
function makeLogger() {
  return { warn: vi.fn() };
}

/** 假适配层：SQLite 同步、PG/MySQL 异步，两种形态都要能吃下 */
function fakeConn({ rows = [], probeThrows = null, alterThrowsOn = null }) {
  const execSql = [];
  return {
    execSql,
    all: vi.fn(() => {
      if (probeThrows) throw probeThrows;
      return rows;
    }),
    exec: vi.fn((sql) => {
      if (alterThrowsOn && sql.includes(alterThrowsOn)) throw new Error('boom: ' + sql);
      execSql.push(sql);
    }),
  };
}

// ─── 纯函数：差集 ────────────────────────────────────────────────────────────

describe('missingColumns —— 探测到的列 vs 期望的列', () => {
  it('列已存在 → 不缺失（不生成任何 ALTER）', () => {
    expect(missingColumns(['id', 'content', 'is_default'], ['content', 'is_default'])).toEqual([]);
  });

  it('列缺失 → 返回缺失项', () => {
    expect(missingColumns(['id', 'name'], ['content', 'is_default'])).toEqual(['content', 'is_default']);
  });

  it('部分缺失 → 只返回缺的那一列', () => {
    expect(missingColumns(['id', 'content'], ['content', 'is_default'])).toEqual(['is_default']);
  });

  it('大小写不敏感（PG/MySQL 折叠小写，SQLite 标识符本身不敏感）', () => {
    expect(missingColumns(['CONTENT', 'Is_Default'], ['content', 'is_default'])).toEqual([]);
    expect(missingColumns(['content'], ['Content'])).toEqual([]);
  });

  it('wanted 自身去重，保持顺序', () => {
    expect(missingColumns([], ['b', 'a', 'b'])).toEqual(['b', 'a']);
  });

  it('脏输入不炸（null / 非数组 / 空字符串）', () => {
    expect(missingColumns(null, undefined)).toEqual([]);
    expect(missingColumns('content', ['content'])).toEqual(['content']);
    expect(missingColumns([null, '', undefined], [null, '', 'content'])).toEqual(['content']);
  });
});

// ─── 纯函数：探测 SQL ───────────────────────────────────────────────────────

describe('columnProbeSql —— 三种方言的探测语句', () => {
  it('PostgreSQL：information_schema.columns + table_name=skills', () => {
    const sql = columnProbeSql('postgres');
    expect(sql).toContain('information_schema.columns');
    expect(sql).toContain('column_name');
    expect(sql).toMatch(/table_name\s*=\s*'skills'/);
    // 限定当前 schema，避免把别的 schema 的同名表当成「已存在」
    expect(sql).toContain('current_schema()');
  });

  it('MySQL：information_schema.columns + DATABASE() 限定当前库（该库是全局的）', () => {
    const sql = columnProbeSql('mysql');
    expect(sql).toContain('information_schema.columns');
    expect(sql).toMatch(/table_schema\s*=\s*DATABASE\(\)/);
    expect(sql).toMatch(/table_name\s*=\s*'skills'/);
  });

  it('SQLite：PRAGMA table_info；未知方言回退到它', () => {
    expect(columnProbeSql('sqlite')).toBe('PRAGMA table_info(skills)');
    expect(columnProbeSql('oracle-ish')).toBe('PRAGMA table_info(skills)');
  });

  it('表名可覆盖，单引号会转义（不拼坏 SQL）', () => {
    expect(columnProbeSql('sqlite', 'other')).toBe('PRAGMA table_info(other)');
    expect(columnProbeSql('postgres', "o'k")).toContain("table_name = 'o''k'");
  });
});

// ─── 纯函数：探测结果归一化 ─────────────────────────────────────────────────

describe('columnNamesFromProbe —— 三种方言的行形状都归一成列名数组', () => {
  it('SQLite PRAGMA：{ name }', () => {
    expect(columnNamesFromProbe('sqlite', [{ cid: 0, name: 'id', type: 'TEXT' }, { cid: 1, name: 'content' }]))
      .toEqual(['id', 'content']);
  });

  it('PostgreSQL：{ column_name }', () => {
    expect(columnNamesFromProbe('postgres', [{ column_name: 'content' }, { column_name: 'is_default' }]))
      .toEqual(['content', 'is_default']);
  });

  it('MySQL：{ COLUMN_NAME }（大小写不固定）', () => {
    expect(columnNamesFromProbe('mysql', [{ COLUMN_NAME: 'content' }, { column_name: 'is_default' }]))
      .toEqual(['content', 'is_default']);
  });

  it('脏行跳过，不抛', () => {
    expect(columnNamesFromProbe('postgres', [null, {}, { column_name: '' }, { column_name: 'ok' }])).toEqual(['ok']);
    expect(columnNamesFromProbe('postgres', null)).toEqual([]);
  });
});

// ─── 纯函数：ALTER 生成 ────────────────────────────────────────────────────

describe('planAddColumnSql —— 只对缺失的列生成 ALTER', () => {
  const specs = skillsColumnSpecs('postgres');

  it('列已存在 → 空数组（零语句，零 ERROR）', () => {
    expect(planAddColumnSql('postgres', 'skills', specs, ['id', 'name', 'content', 'is_default'])).toEqual([]);
  });

  it('列全缺 → 两条 ALTER', () => {
    const sqls = planAddColumnSql('postgres', 'skills', specs, ['id', 'name', 'command']);
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toBe('ALTER TABLE skills ADD COLUMN content TEXT DEFAULT \'\'');
    expect(sqls[1]).toBe('ALTER TABLE skills ADD COLUMN is_default INTEGER DEFAULT 0');
  });

  it('只缺一列 → 只生成一条', () => {
    expect(planAddColumnSql('postgres', 'skills', specs, ['id', 'content']))
      .toEqual(['ALTER TABLE skills ADD COLUMN is_default INTEGER DEFAULT 0']);
  });

  it('方言化类型：MySQL 用 LONGTEXT 且不带字符串字面量 DEFAULT', () => {
    const mysqlSqls = planAddColumnSql('mysql', 'skills', skillsColumnSpecs('mysql'), []);
    expect(mysqlSqls[0]).toContain('ADD COLUMN content LONGTEXT');
    expect(mysqlSqls[0]).not.toContain("DEFAULT ''");
    // 其余方言保留默认值，老库新列不会留 NULL
    expect(planAddColumnSql('sqlite', 'skills', skillsColumnSpecs('sqlite'), [])[0])
      .toContain("content TEXT DEFAULT ''");
  });

  it('addColumnSql 是唯一的 ALTER 拼装点', () => {
    expect(addColumnSql('t', 'c', 'TEXT')).toBe('ALTER TABLE t ADD COLUMN c TEXT');
  });
});

// ─── 运行时：ensureColumns ─────────────────────────────────────────────────

describe('ensureColumns —— 探测驱动，任何异常都不让启动失败', () => {
  it('列已存在 → 一条 ALTER 都不执行', async () => {
    const conn = fakeConn({ rows: [{ column_name: 'id' }, { column_name: 'content' }, { column_name: 'is_default' }] });
    const logger = makeLogger();
    const r = await ensureColumns({ db: conn, dbType: 'postgres', logger });
    expect(r.probed).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.added).toEqual([]);
    expect(conn.exec).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(conn.all).toHaveBeenCalledWith(columnProbeSql('postgres'));
  });

  it('列缺失 → 只对缺的列执行 ALTER', async () => {
    const conn = fakeConn({ rows: [{ column_name: 'id' }, { column_name: 'name' }] });
    const logger = makeLogger();
    const r = await ensureColumns({ db: conn, dbType: 'postgres', logger });
    expect(r.missing).toEqual(['content', 'is_default']);
    expect(r.added).toEqual(['content', 'is_default']);
    expect(conn.execSql).toEqual([
      'ALTER TABLE skills ADD COLUMN content TEXT DEFAULT \'\'',
      'ALTER TABLE skills ADD COLUMN is_default INTEGER DEFAULT 0',
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('SQLite PRAGMA 行形状也走同一条路', async () => {
    const conn = fakeConn({ rows: [{ cid: 0, name: 'id' }, { cid: 1, name: 'content' }] });
    const r = await ensureColumns({ db: conn, dbType: 'sqlite', logger: makeLogger() });
    expect(r.added).toEqual(['is_default']);
    expect(conn.execSql).toEqual(['ALTER TABLE skills ADD COLUMN is_default INTEGER DEFAULT 0']);
  });

  it('探测报错 → 不抛、按跳过处理、只记一次', async () => {
    const conn = fakeConn({ probeThrows: new Error('permission denied for information_schema') });
    const logger = makeLogger();
    const r = await ensureColumns({ db: conn, dbType: 'postgres', logger });
    expect(r).toMatchObject({ probed: false, skipped: 'probe-failed', added: [] });
    expect(r.error).toContain('permission denied');
    expect(conn.exec).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('跳过补列');
  });

  it('探测返回空（表不在当前 schema/库）→ 跳过，不盲 ALTER', async () => {
    const conn = fakeConn({ rows: [] });
    const logger = makeLogger();
    const r = await ensureColumns({ db: conn, dbType: 'mysql', logger });
    expect(r).toMatchObject({ probed: true, skipped: 'no-columns', added: [] });
    expect(conn.exec).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('单条 ALTER 失败 → 不抛，其余继续，只记一次', async () => {
    const conn = fakeConn({ rows: [{ column_name: 'id' }], alterThrowsOn: 'ADD COLUMN is_default' });
    const logger = makeLogger();
    const r = await ensureColumns({ db: conn, dbType: 'postgres', logger });
    expect(r.added).toEqual(['content']);      // 失败的那列不进 added
    expect(r.error).toContain('is_default');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('幂等：第二次启动时探测已包含新列 → 零 ALTER', async () => {
    const first = fakeConn({ rows: [{ column_name: 'id' }] });
    await ensureColumns({ db: first, dbType: 'postgres', logger: makeLogger() });
    expect(first.execSql).toHaveLength(2);
    // 第二次启动：第一次补上的列现在能被探测到
    const second = fakeConn({ rows: [{ column_name: 'id' }, { column_name: 'content' }, { column_name: 'is_default' }] });
    const logger = makeLogger();
    await ensureColumns({ db: second, dbType: 'postgres', logger });
    expect(second.exec).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('自定义 specs / 表名可用，默认是 skills 的两列', async () => {
    const conn = fakeConn({ rows: [{ name: 'id' }] });
    await ensureColumns({
      db: conn, dbType: 'sqlite', table: 'other',
      specs: [{ name: 'note', definition: 'TEXT' }], logger: makeLogger(),
    });
    expect(conn.all).toHaveBeenCalledWith('PRAGMA table_info(other)');
    expect(conn.execSql).toEqual(['ALTER TABLE other ADD COLUMN note TEXT']);
    expect(skillsColumnSpecs('sqlite').map(s => s.name)).toEqual(['content', 'is_default']);
  });
});

// ─── 源码断言：不许再出现「裸 ALTER + catch 空块」 ─────────────────────────

/** 取出某个顶层函数的函数体（先跳过参数表，避免把解构的 {} 当函数体） */
function extractBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `源码里找不到函数 ${name}`).toBeGreaterThan(-1);
  let i = src.indexOf('(', start);
  let paren = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') paren += 1;
    else if (src[i] === ')') { paren -= 1; if (paren === 0) break; }
  }
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`函数 ${name} 的花括号不闭合`);
}

describe('源码断言 —— server/db/index.js 必须走探测', () => {
  it('runMigrations 里不再出现 ALTER TABLE（补列只能走 ensureColumns）', () => {
    const body = extractBody(SRC, 'runMigrations');
    expect(body).not.toContain('ALTER TABLE');
    expect(body).toContain('ensureColumns');
  });

  it('旧写法「try { await db.exec(sql) } catch { 列已存在 }」已消失', () => {
    const blindAlter = /try\s*\{\s*await\s+db\.exec\(\s*sql\s*\)\s*;\s*\}\s*catch\s*\{\s*\/\*\s*列已存在\s*\*\/\s*\}/;
    expect(SRC).not.toMatch(blindAlter);
    // 也不许有「数组里塞 ALTER 字符串再统一 try」的变体
    expect(SRC).not.toMatch(/for\s*\(const\s+sql\s+of\s*\[[\s\S]{0,200}ALTER TABLE/);
  });

  it('全文件只有一处 ALTER 拼装点，且位于 addColumnSql 内', () => {
    expect(SRC.match(/ALTER TABLE/g) || []).toHaveLength(1);
    expect(extractBody(SRC, 'addColumnSql')).toContain('ALTER TABLE');
  });

  it('ensureColumns 内部先探测再决定：用到 columnProbeSql / missingColumns / planAddColumnSql', () => {
    const body = extractBody(SRC, 'ensureColumns');
    expect(body).toContain('columnProbeSql');
    expect(body).toContain('missingColumns');
    expect(body).toContain('planAddColumnSql');
    // 探测失败必须被兜住（try/catch），否则启动会被拖死
    expect(body).toMatch(/catch[\s\S]{0,120}skipped = 'probe-failed'/);
  });
});
