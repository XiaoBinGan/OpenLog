/**
 * server/datasource/store.js —— 外部数据源/服务登记表（持久化 + 密码加密）
 *
 * 为什么单独一张表而不是塞进 settings：settings 是「本实例自己的配置」，
 * 这里是「一堆别人的库/服务」，数量会变，还要单独试连、单独启用。
 *
 * 密码纪律：
 *   - 落库前用调用方注入的 encrypt 加密（与 settings 同一套 AES-256-GCM）
 *   - 读取时**默认不解密**，只有真的要连的时候才 decrypt
 *   - 任何返回给前端的形状都只带 passwordMasked，绝不带明文
 */

/** 登记表的建表语句（三方言） */
export function ddlForSourceTable(dbType) {
  if (dbType === 'postgres') {
    return [
      `CREATE TABLE IF NOT EXISTS monitor_datasource (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        collection TEXT NOT NULL DEFAULT 'local',
        label TEXT NOT NULL,
        dialect TEXT,
        host TEXT,
        port INTEGER,
        db_user TEXT,
        db_password TEXT,
        db_name TEXT,
        base_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_probe_ms INTEGER,
        last_status TEXT,
        last_error TEXT,
        last_probe_at BIGINT,
        created_at BIGINT NOT NULL
      )`,
    ];
  }
  if (dbType === 'mysql') {
    return [
      `CREATE TABLE IF NOT EXISTS monitor_datasource (
        id VARCHAR(64) PRIMARY KEY,
        kind VARCHAR(16) NOT NULL,
        collection VARCHAR(64) NOT NULL DEFAULT 'local',
        label VARCHAR(191) NOT NULL,
        dialect VARCHAR(32),
        host VARCHAR(191),
        port INT,
        db_user VARCHAR(191),
        db_password TEXT,
        db_name VARCHAR(191),
        base_url TEXT,
        enabled TINYINT NOT NULL DEFAULT 1,
        last_probe_ms INT,
        last_status VARCHAR(32),
        last_error TEXT,
        last_probe_at BIGINT,
        created_at BIGINT NOT NULL
      )`,
    ];
  }
  return [
    `CREATE TABLE IF NOT EXISTS monitor_datasource (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      collection TEXT NOT NULL DEFAULT 'local',
      label TEXT NOT NULL,
      dialect TEXT,
      host TEXT,
      port INTEGER,
      db_user TEXT,
      db_password TEXT,
      db_name TEXT,
      base_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_probe_ms INTEGER,
      last_status TEXT,
      last_error TEXT,
      last_probe_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
  ];
}

/**
 * @param {object} opts
 * @param {any} opts.db             server/db 适配层
 * @param {string} opts.dbType
 * @param {(s: string) => string} [opts.encrypt]
 * @param {(s: string) => string} [opts.decrypt]
 * @param {() => number} [opts.now]
 * @param {(s: string) => string} [opts.maskSecret]  给前端看的打码（默认只显示 ***）
 */
export function createDatasourceStore({
  db, getDb, dbType, getDbType, encrypt = (s) => s, decrypt = (s) => s, now = () => Date.now(), maskSecret,
}) {
  const mask = typeof maskSecret === 'function' ? maskSecret : (s) => (s ? '******' : '');
  /**
   * 惰性取连接：这个 store 在模块顶层就被创建，那时 initDb() 还没跑。
   * 传 `db` 对象（固定/测试）或 `getDb` 函数（生产，每次现取）都支持。
   */
  const conn = () => {
    try {
      if (typeof getDb === 'function') return getDb() || null;
      return db || null;
    } catch { return null; }
  };
  const type = () => {
    try { return typeof getDbType === 'function' ? getDbType() : dbType; } catch { return dbType; }
  };

  async function ensureSchema() {
    const db = conn();
    if (!db) return false;
    try {
      for (const sql of ddlForSourceTable(type())) await db.exec(sql);
      return true;
    } catch {
      return false;
    }
  }

  /** 行 → 对外形状（绝不含明文密码） */
  function toPublic(row) {
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      collection: row.collection,
      label: row.label,
      dialect: row.dialect || null,
      host: row.host || '',
      port: row.port == null ? null : Number(row.port),
      user: row.db_user || '',
      database: row.db_name || '',
      baseUrl: row.base_url || '',
      enabled: Number(row.enabled) === 1,
      hasPassword: Boolean(row.db_password),
      passwordMasked: row.db_password ? mask(safeDecrypt(row.db_password)) : '',
      lastProbeMs: row.last_probe_ms == null ? null : Number(row.last_probe_ms),
      lastStatus: row.last_status || null,
      lastError: row.last_error || null,
      lastProbeAt: row.last_probe_at == null ? null : Number(row.last_probe_at),
      createdAt: Number(row.created_at) || 0,
    };
  }

  function safeDecrypt(v) {
    try { return decrypt(v); } catch { return ''; }
  }

  async function list() {
    const db = conn();
    if (!db) return [];
    try {
      const rows = await db.all('SELECT * FROM monitor_datasource ORDER BY created_at ASC');
      return (Array.isArray(rows) ? rows : []).map(toPublic);
    } catch { return []; }
  }

  async function get(id) {
    const db = conn();
    if (!db) return null;
    try {
      const row = await db.get('SELECT * FROM monitor_datasource WHERE id = ?', id);
      return toPublic(row);
    } catch { return null; }
  }

  /** 取「真的能连」的凭据：这里是唯一解密入口，调用方必须是采集器 */
  async function getSecret(id) {
    const db = conn();
    if (!db) return null;
    try {
      const row = await db.get('SELECT * FROM monitor_datasource WHERE id = ?', id);
      if (!row) return null;
      return {
        id: row.id, kind: row.kind, dialect: row.dialect, host: row.host,
        port: row.port == null ? null : Number(row.port),
        user: row.db_user || '', password: row.db_password ? safeDecrypt(row.db_password) : '',
        database: row.db_name || '', baseUrl: row.base_url || '',
        enabled: Number(row.enabled) === 1,
      };
    } catch { return null; }
  }

  /**
   * 新增/更新。密码字段语义：
   *   undefined → 保持原值（编辑时没改密码）
   *   ''        → 清空
   *   其它      → 加密后写入
   */
  async function upsert(input) {
    const db = conn();
    if (!db) return { ok: false, error: '数据库未就绪' };
    const id = String(input?.id || '').trim();
    if (!id) return { ok: false, error: 'id 不能为空' };
    const kind = input.kind === 'service' ? 'service' : 'db';
    // 注意：SQLite 适配层是**同步**的（better-sqlite3），PG/MySQL 才是 Promise。
    // 直接 `db.get(...).catch()` 会在 SQLite 上抛 "Cannot read properties of undefined"。
    // 用 Promise.resolve 包一层，两种实现都能用。
    const existing = await Promise.resolve(db.get('SELECT * FROM monitor_datasource WHERE id = ?', id)).catch(() => null);
    const encrypted = input.password === undefined
      ? (existing?.db_password ?? null)
      : (input.password ? encrypt(String(input.password)) : null);
    const row = {
      id,
      kind,
      collection: String(input.collection || 'local').slice(0, 64),
      label: String(input.label || id).slice(0, 190),
      dialect: input.dialect ? String(input.dialect).slice(0, 32) : null,
      host: input.host ? String(input.host).slice(0, 190) : null,
      port: Number.isFinite(Number(input.port)) ? Number(input.port) : null,
      db_user: input.user ? String(input.user).slice(0, 190) : null,
      db_password: encrypted,
      db_name: input.database ? String(input.database).slice(0, 190) : null,
      base_url: input.baseUrl ? String(input.baseUrl).slice(0, 500) : null,
      enabled: input.enabled === false ? 0 : 1,
      last_probe_ms: existing?.last_probe_ms ?? null,
      last_status: existing?.last_status ?? null,
      last_error: existing?.last_error ?? null,
      last_probe_at: existing?.last_probe_at ?? null,
      created_at: existing?.created_at ?? now(),
    };
    try {
      if (existing) {
        await db.run(
          `UPDATE monitor_datasource SET kind=?, collection=?, label=?, dialect=?, host=?, port=?, db_user=?,
             db_password=?, db_name=?, base_url=?, enabled=? WHERE id=?`,
          row.kind, row.collection, row.label, row.dialect, row.host, row.port,
          row.db_user, row.db_password, row.db_name, row.base_url, row.enabled, row.id,
        );
      } else {
        await db.run(
          `INSERT INTO monitor_datasource (id, kind, collection, label, dialect, host, port, db_user,
             db_password, db_name, base_url, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id, row.kind, row.collection, row.label, row.dialect, row.host, row.port,
          row.db_user, row.db_password, row.db_name, row.base_url, row.enabled, row.created_at,
        );
      }
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async function remove(id) {
    const db = conn();
    if (!db) return false;
    try {
      await db.run('DELETE FROM monitor_datasource WHERE id = ?', String(id));
      return true;
    } catch { return false; }
  }

  /** 记录一次探测结果（成功/失败都记，界面要看「上次什么时候试过」） */
  async function recordProbe(id, { ok, ms = null, error = null }) {
    const db = conn();
    if (!db) return;
    try {
      await db.run(
        'UPDATE monitor_datasource SET last_probe_ms = ?, last_status = ?, last_error = ?, last_probe_at = ? WHERE id = ?',
        Number.isFinite(Number(ms)) ? Math.round(Number(ms)) : null,
        ok ? 'ok' : 'fail',
        ok ? null : String(error || '').slice(0, 500),
        now(),
        String(id),
      );
    } catch { /* 探测结果记不下来不影响功能 */ }
  }

  return { ensureSchema, list, get, getSecret, upsert, remove, recordProbe, toPublic };
}
