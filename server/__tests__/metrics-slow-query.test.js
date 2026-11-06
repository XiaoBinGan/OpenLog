/**
 * server/__tests__/metrics-slow-query.test.js
 *
 * #9 slowquery：`server/metrics/slow-query.js` 的单元测试。
 * 重点不是「能跑」，而是「参数值绝不进指纹」—— 这条错了就是一个新的泄密面，
 * 所以除了逐形态断言，还有专门的安全断言（指纹里一个数字/一个明文 token 都不能有）。
 */
import { describe, it, expect } from 'vitest';
import { fingerprintSql, createSlowQueryLog, shouldRecord } from '../metrics/slow-query.js';

const MINUTE = 60_000;
const AT = 1_700_000_000_000; // 固定时刻，方便断言分钟桶
/** 限频计数 key 的格式（与 shouldRecord 内部一致：分钟桶|指纹） */
const key = (nowMs, fp) => `${Math.floor(nowMs / MINUTE)}|${fp}`;

describe('fingerprintSql —— 真实形态指纹化', () => {
  /** 每条都是线上真实会出现的写法（PG / SQLite / mysql2 / DB-API 混着来） */
  const cases = [
    {
      name: '基础 where 等值（数字 + 字符串字面量）',
      sql: "SELECT * FROM users WHERE id = 12 AND name = 'alice'",
      want: 'select * from users where id = ? and name = ?',
    },
    {
      name: 'PG 位置参数 $1/$2',
      sql: 'SELECT * FROM orders WHERE user_id = $1 AND status = $2',
      want: 'select * from orders where user_id = ? and status = ?',
    },
    {
      name: 'SQLite / better-sqlite3 的 ? 占位符',
      sql: 'SELECT * FROM t WHERE a = ? AND b = ?',
      want: 'select * from t where a = ? and b = ?',
    },
    {
      name: 'DB-API %s 占位符',
      sql: 'SELECT * FROM t WHERE name = %s AND age > %s',
      want: 'select * from t where name = ? and age > ?',
    },
    {
      name: 'IN 数字列表收敛',
      sql: 'select * from t where id in (1, 2, 3, 4)',
      want: 'select * from t where id in (?)',
    },
    {
      name: 'IN 字符串列表收敛',
      sql: "SELECT * FROM t WHERE email IN ('a@x.com', 'b@y.com')",
      want: 'select * from t where email in (?)',
    },
    {
      name: '多组 VALUES 收敛成一组',
      sql: "INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y'), (3, 'z')",
      want: 'insert into t (a, b) values (?)',
    },
    {
      name: '参数化 INSERT ... VALUES ($1,$2) RETURNING',
      sql: 'insert into t (a, b) values ($1, $2) returning id',
      want: 'insert into t (a, b) values (?) returning id',
    },
    {
      name: '双引号标识符保留（列名不是值）',
      sql: 'SELECT "userId", "name" FROM "Users" WHERE "userId" = 42',
      want: 'select "userId", "name" from "Users" where "userId" = ?',
    },
    {
      name: '双引号里的值形态（uuid / 数字）仍然脱敏',
      sql: 'SELECT * FROM t WHERE uid = "550e8400-e29b-41d4-a716-446655440000" AND n = "12345"',
      want: 'select * from t where uid = ? and n = ?',
    },
    {
      name: 'hex/blob 字面量 X\'AB\' / x\'ff\'',
      sql: "SELECT X'DEADBEEF' AS h, x'00ff' AS h2 FROM t",
      want: 'select ? as h, ? as h2 from t',
    },
    {
      name: 'MySQL 0x1F / 0b1011 十六进制与二进制字面量',
      sql: 'select * from t where a = 0x1F and b = 0b1011',
      want: 'select * from t where a = ? and b = ?',
    },
    {
      name: "PG E'...' 转义字符串",
      sql: "select * from t where note = E'it\\'s ok'",
      want: 'select * from t where note = ?',
    },
    {
      name: "引号内的转义：'' 与 \\'",
      sql: "select * from t where a = 'a''b' and b = 'it\\'s'",
      want: 'select * from t where a = ? and b = ?',
    },
    {
      name: '负数 / 小数 / 科学计数',
      sql: 'select * from t where delta > -1.5e-3 and ratio < .25 and n = +7',
      want: 'select * from t where delta > ? and ratio < ? and n = ?',
    },
    {
      name: 'interval 字面量与 limit/offset',
      sql: "SELECT * FROM logs WHERE created_at > now() - interval '7 days' ORDER BY id DESC LIMIT 50 OFFSET 100",
      want: 'select * from logs where created_at > now() - interval ? order by id desc limit ? offset ?',
    },
    {
      name: 'PG dollar-quoted 字符串',
      sql: "select * from t where body = $tag$ raw 'text' here $tag$",
      want: 'select * from t where body = ?',
    },
    {
      name: '聚合 + group by / having',
      sql: 'select count(*) from t where x = 1 group by t2 having count(*) > 5',
      want: 'select count(*) from t where x = ? group by t2 having count(*) > ?',
    },
    {
      name: '别名里的数字不算字面量（t2 / col1）',
      sql: 'delete from t where id = 7 and alias2 = t2',
      want: 'delete from t where id = ? and alias2 = t2',
    },
    {
      name: '布尔字面量保留（不泄密，且对排查有用）',
      sql: 'select * from t where flag = true and gone = false',
      want: 'select * from t where flag = true and gone = false',
    },
    {
      name: '操作符两侧空白差异不影响指纹',
      sql: 'select * from t where a=1 and b   >=   2',
      want: 'select * from t where a = ? and b >= ?',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(fingerprintSql(c.sql)).toBe(c.want);
    });
  }
});

describe('fingerprintSql —— 安全：参数值绝不进指纹', () => {
  it('token 与 id 都被抹掉', () => {
    const fp = fingerprintSql("select * from users where token='SECRET123' and id=42");
    expect(fp).toBe('select * from users where token = ? and id = ?');
    expect(fp).not.toContain('SECRET123');
    expect(fp).not.toContain('secret');
    expect(fp).not.toContain('42');
    expect(fp).not.toMatch(/\d/); // 任何数字都不该留下
  });

  it('INSERT 里的密码与邮箱不留痕', () => {
    const fp = fingerprintSql("insert into users (name, pw, email) values ('bob', 'hunter2', 'bob@x.com')");
    expect(fp).toBe('insert into users (name, pw, email) values (?)');
    for (const secret of ['bob', 'hunter2', 'bob@x.com']) expect(fp).not.toContain(secret);
  });

  it('注释里写的密钥也一并丢弃', () => {
    const fp = fingerprintSql("select * from t -- token='SECRET9'\nwhere id = 1");
    expect(fp).toBe('select * from t where id = ?');
    expect(fp).not.toContain('SECRET9');
  });

  it('未闭合的引号按字面量吃掉，不原样吐出内容', () => {
    const fp = fingerprintSql("select * from t where s = 'never closed SECRET7");
    expect(fp).not.toContain('SECRET7');
    expect(fp).toBe('select * from t where s = ?');
  });
});

describe('fingerprintSql —— 结构归一', () => {
  it('多语句只留第一条', () => {
    expect(fingerprintSql('select * from a where id = 1; delete from b where id = 2'))
      .toBe('select * from a where id = ?');
    expect(fingerprintSql('select * from a;')).toBe('select * from a');
    expect(fingerprintSql('select 1; drop table users')).toBe('select ?');
  });

  it('空白/换行/制表符折叠成单空格', () => {
    expect(fingerprintSql('SELECT\n  *\n  FROM\t t\n WHERE  id=1')) .toBe('select * from t where id = ?');
  });

  it('大小写不同但结构相同的两条 SQL 指纹相同', () => {
    const a = fingerprintSql('SELECT * FROM T WHERE A = $1');
    const b = fingerprintSql('select * from t where a = 1');
    expect(a).toBe('select * from t where a = ?');
    expect(a).toBe(b);
  });

  it('大小写 + 空白 + 占位符风格都不同，指纹仍相同', () => {
    expect(fingerprintSql("SELECT  * FROM users WHERE name = %s AND id = $9 LIMIT 10"))
      .toBe(fingerprintSql("select * from users where name = ? and id = ? limit ?"));
  });

  it('IN 列表元素个数不影响指纹', () => {
    const one = fingerprintSql('select * from t where id in (1)');
    const many = fingerprintSql('select * from t where id in (1,2,3,4,5,6,7,8)');
    expect(one).toBe('select * from t where id in (?)');
    expect(many).toBe('select * from t where id in (?)');
  });

  it('超长 SQL 截断到 500 字符并以 … 结尾', () => {
    const cols = Array.from({ length: 400 }, (_, i) => `very_long_column_name_${i}`).join(', ');
    const fp = fingerprintSql(`select ${cols} from t where id = 1`);
    expect(fp.length).toBe(500);
    expect(fp.endsWith('…')).toBe(true);
  });

  it('空/非字符串输入返回空串（不抛）', () => {
    expect(fingerprintSql('')).toBe('');
    expect(fingerprintSql('   \n\t ')).toBe('');
    expect(fingerprintSql(undefined)).toBe('');
    expect(fingerprintSql(null)).toBe('');
    expect(fingerprintSql(42)).toBe('');
  });
});

describe('createSlowQueryLog —— 阈值与记录', () => {
  it('低于阈值不记录，等于/高于阈值记录', () => {
    const log = createSlowQueryLog({ thresholdMs: 200, now: () => AT });
    expect(log.record({ sql: 'select * from t where id = 1', ms: 199 })).toBe(false);
    expect(log.record({ sql: 'select * from t where id = 1', ms: 200 })).toBe(true);
    expect(log.record({ sql: 'select * from t where id = 1', ms: 999 })).toBe(true);
    expect(log.list()).toHaveLength(2);
  });

  it('默认阈值 200ms', () => {
    const log = createSlowQueryLog({ now: () => AT });
    expect(log.record({ sql: 'select 1', ms: 50 })).toBe(false);
    expect(log.record({ sql: 'select 1', ms: 201 })).toBe(true);
  });

  it('非法 ms / 空 SQL 不记录', () => {
    const log = createSlowQueryLog({ thresholdMs: 0, now: () => AT });
    expect(log.record({ sql: 'select 1', ms: Number.NaN })).toBe(false);
    expect(log.record({ sql: 'select 1', ms: 'abc' })).toBe(false);
    expect(log.record({ sql: '', ms: 900 })).toBe(false);
    expect(log.record({ sql: '   ', ms: 900 })).toBe(false);
    expect(log.record({})).toBe(false);
    expect(log.record()).toBe(false);
    expect(log.list()).toEqual([]);
  });

  it('record 落库字段齐全，sample 就是指纹（不含参数值）', () => {
    const log = createSlowQueryLog({ thresholdMs: 0, now: () => AT });
    expect(log.record({ sql: "select * from users where pw = 'hunter2'", ms: 900, source: 'remote.files' }))
      .toBe(true);
    const [row] = log.list(1);
    expect(row.fingerprint).toBe('select * from users where pw = ?');
    expect(row.sample).toBe(row.fingerprint);
    expect(row.ms).toBe(900);
    expect(row.source).toBe('remote.files');
    expect(row.ts_ms).toBe(AT);
    expect(JSON.stringify(row)).not.toContain('hunter2');
  });

  it('source 缺省为 null', () => {
    const log = createSlowQueryLog({ thresholdMs: 0, now: () => AT });
    log.record({ sql: 'select * from t where id = 1', ms: 500 });
    expect(log.list(1)[0].source).toBeNull();
  });

  it('list(limit) 生效，且按时间倒序', () => {
    let t = AT;
    const log = createSlowQueryLog({ thresholdMs: 0, now: () => t });
    for (const n of [1, 2, 3]) {
      t += 1000;
      log.record({ sql: `select * from t${n} where id = 1`, ms: 300 });
    }
    expect(log.list().map((r) => r.fingerprint)).toEqual([
      'select * from t3 where id = ?',
      'select * from t2 where id = ?',
      'select * from t1 where id = ?',
    ]);
    expect(log.list(2)).toHaveLength(2);
    expect(log.list(0)).toEqual([]);
    expect(log.list(99)).toHaveLength(3);
  });

  it('list 返回副本，外部修改不影响内部缓冲', () => {
    const log = createSlowQueryLog({ thresholdMs: 0, now: () => AT });
    log.record({ sql: 'select * from t where id = 1', ms: 300 });
    const rows = log.list();
    rows[0].fingerprint = 'tampered';
    expect(log.list()[0].fingerprint).toBe('select * from t where id = ?');
  });
});

describe('createSlowQueryLog —— 环形缓冲与限频', () => {
  it('max=10 塞 20 条 → 只剩最新 10 条', () => {
    let t = AT;
    const log = createSlowQueryLog({ thresholdMs: 100, max: 10, now: () => t });
    for (let i = 0; i < 20; i += 1) {
      t += 1000;
      expect(log.record({ sql: `select * from t${i} where id = 1`, ms: 500 })).toBe(true);
    }
    const rows = log.list();
    expect(rows).toHaveLength(10);
    expect(rows[0].fingerprint).toBe('select * from t19 where id = ?');
    expect(rows[9].fingerprint).toBe('select * from t10 where id = ?');
  });

  it('同指纹同分钟：第 6 条被限频丢弃，下一分钟恢复', () => {
    let t = AT;
    const log = createSlowQueryLog({ thresholdMs: 100, now: () => t });
    const sql = 'select * from t where id = 1';
    for (let i = 0; i < 5; i += 1) expect(log.record({ sql, ms: 300 })).toBe(true);
    expect(log.record({ sql, ms: 300 })).toBe(false);
    expect(log.list()).toHaveLength(5);
    t += MINUTE;
    expect(log.record({ sql, ms: 300 })).toBe(true);
    expect(log.list()).toHaveLength(6);
  });

  it('限频按指纹隔离：不同指纹互不影响', () => {
    const log = createSlowQueryLog({ thresholdMs: 0, now: () => AT });
    for (let i = 0; i < 5; i += 1) log.record({ sql: 'select * from a where id = 1', ms: 300 });
    expect(log.record({ sql: 'select * from a where id = 1', ms: 300 })).toBe(false);
    expect(log.record({ sql: 'select * from b where id = 1', ms: 300 })).toBe(true);
  });

  it('reset 清空缓冲，也清空限频计数', () => {
    const log = createSlowQueryLog({ thresholdMs: 0, now: () => AT });
    const sql = 'select * from t where id = 1';
    for (let i = 0; i < 5; i += 1) log.record({ sql, ms: 300 });
    expect(log.record({ sql, ms: 300 })).toBe(false);
    log.reset();
    expect(log.list()).toEqual([]);
    expect(log.record({ sql, ms: 300 })).toBe(true);
  });
});

describe('shouldRecord —— 纯函数边界', () => {
  const FP = 'select * from t where id = ?';

  it('计数为 0 时允许', () => {
    expect(shouldRecord({ counts: new Map() }, { fingerprint: FP, ms: 500, nowMs: AT })).toBe(true);
    expect(shouldRecord({ counts: new Map([[key(AT, FP), 0]]) }, { fingerprint: FP, nowMs: AT })).toBe(true);
  });

  it('未达上限允许，达上限拒绝', () => {
    expect(shouldRecord({ counts: new Map([[key(AT, FP), 4]]) }, { fingerprint: FP, nowMs: AT })).toBe(true);
    expect(shouldRecord({ counts: new Map([[key(AT, FP), 5]]) }, { fingerprint: FP, nowMs: AT })).toBe(false);
    expect(shouldRecord({ counts: new Map([[key(AT, FP), 9]]) }, { fingerprint: FP, nowMs: AT })).toBe(false);
  });

  it('跨分钟：上一分钟满了，这一分钟仍允许', () => {
    const counts = new Map([[key(AT, FP), 5]]);
    expect(shouldRecord({ counts }, { fingerprint: FP, nowMs: AT + MINUTE })).toBe(true);
  });

  it('同一分钟内不同指纹互不影响', () => {
    const counts = new Map([[key(AT, FP), 5]]);
    expect(shouldRecord({ counts }, { fingerprint: 'select * from u where id = ?', nowMs: AT })).toBe(true);
  });

  it('counts 支持普通对象 / Record', () => {
    const counts = { [key(AT, FP)]: 3 };
    expect(shouldRecord({ counts }, { fingerprint: FP, nowMs: AT })).toBe(true);
    expect(shouldRecord({ counts: { [key(AT, FP)]: 5 } }, { fingerprint: FP, nowMs: AT })).toBe(false);
  });

  it('state.limitPerMinute 可覆盖默认的 5', () => {
    const counts = new Map([[key(AT, FP), 2]]);
    expect(shouldRecord({ counts, limitPerMinute: 2 }, { fingerprint: FP, nowMs: AT })).toBe(false);
    expect(shouldRecord({ counts, limitPerMinute: 3 }, { fingerprint: FP, nowMs: AT })).toBe(true);
  });

  it('不修改传入的 state（纯函数）', () => {
    const counts = new Map([[key(AT, FP), 1]]);
    const state = { counts };
    shouldRecord(state, { fingerprint: FP, ms: 500, nowMs: AT });
    expect(counts.get(key(AT, FP))).toBe(1);
    expect(counts.size).toBe(1);
    expect(state).toEqual({ counts });
  });

  it('边界输入返回 false', () => {
    expect(shouldRecord(undefined, { fingerprint: FP, nowMs: AT })).toBe(false);
    expect(shouldRecord({ counts: new Map() }, { fingerprint: '', nowMs: AT })).toBe(false);
    expect(shouldRecord({ counts: new Map() }, { nowMs: AT })).toBe(false);
    expect(shouldRecord({ counts: new Map() }, { fingerprint: FP, nowMs: Number.NaN })).toBe(true); // 回落 Date.now()
  });
});
