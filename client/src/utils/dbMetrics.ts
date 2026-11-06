/**
 * client/src/utils/dbMetrics.ts —— 数据库监控快照的纯函数层
 *
 * 为什么从组件里抽出来：`GET /api/monitor/db` 的 payload 由三种方言（SQLite / PG / MySQL）
 * × 两种采样（light / heavy）拼出来，字段漂移有三类：缺字段（SQLite 没有 pg_stat_activity）、
 * 类型漂移（PG 的 bigint 经 JSON 变字符串）、部分失败（读不到的字段是 **null 而不是 0**，
 * 失败项记在 `unavailable[]`）。组件里逐条兜底会变成不可测的分支地狱，这里统一收敛成
 * 「脏数据 → 渲染安全结构」。全部无副作用，不依赖 DOM/网络/时钟。
 */

/** 连接池水位。任一字段读不到就是 null —— 0 会被读成「池子空着」，是假数据。 */
export interface DbPoolInfo {
  total: number | null;
  idle: number | null;
  waiting: number | null;
  max: number | null;
}

/** 单张表的体积/行数/死元组/索引命中率。 */
export interface DbTableStat {
  name: string;
  bytes: number | null;
  liveTup: number | null;
  deadTup: number | null;
  /** 0~1；分母为 0（这张表压根没被扫过）时是 null，不是 0 */
  indexHitRate: number | null;
}

/** `/api/monitor/db` 的规范化结果（字段齐全，取不到的给 null/[]）。 */
export interface DbSnapshot {
  enabled?: boolean;
  type?: string | null;
  pool?: DbPoolInfo | null;
  lastLight?: Record<string, any> | null;
  lastHeavy?: Record<string, any> | null;
  unavailable?: string[];
  tables?: DbTableStat[];
  probeMs?: number | null;
  storage?: { rows: number; approxBytes: number | null } | null;
}

const EMPTY_SNAPSHOT = (): DbSnapshot => ({
  enabled: undefined, type: null, pool: null, lastLight: null, lastHeavy: null,
  unavailable: [], tables: [], probeMs: null, storage: null,
});

/** 只认「普通对象」：数组/null/函数都不算，避免把数组当对象取值取到 '0' 这种鬼东西 */
function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 数值兜底：只接受有限数字与可解析的数字字符串，其它（null/NaN/Infinity/''/bool/对象）一律 null */
function toNumOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

/** 比率兜底到 0~1；上游若改成百分数（>1 且 <=100）按百分数折算，避免界面出现 9800% */
function toRateOrNull(v: unknown): number | null {
  const n = toNumOrNull(v);
  if (n === null) return null;
  if (n > 1 && n <= 100) return Math.round((n / 100) * 10_000) / 10_000;
  return Math.min(1, Math.max(0, n));
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
/** 整数不带小数点，小数保留一位（20.0 → 20，3.5 → 3.5） */
const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function normalizePool(raw: unknown): DbPoolInfo | null {
  if (!isPlainObject(raw)) return null;
  const pool: DbPoolInfo = {
    total: toNumOrNull(raw.total),
    idle: toNumOrNull(raw.idle),
    waiting: toNumOrNull(raw.waiting),
    max: toNumOrNull(raw.max),
  };
  // 四字段全空 = 上游根本没接线（sampler 给 null），别当成「池子全 0」
  if (pool.total === null && pool.idle === null && pool.waiting === null && pool.max === null) return null;
  return pool;
}

function normalizeTables(raw: unknown): DbTableStat[] {
  if (!Array.isArray(raw)) return [];
  const out: DbTableStat[] = [];
  for (const row of raw) {
    if (!isPlainObject(row)) continue;
    // 服务端 summarizeTables 给的是 relname；管理台/旧版本可能给 name/table
    const name = String(row.name ?? row.relname ?? row.table ?? '').trim();
    if (!name) continue; // 没有表名的行画出来只是一个空行，丢弃
    out.push({
      name,
      bytes: toNumOrNull(row.bytes ?? row.sizeBytes ?? row.size_bytes),
      liveTup: toNumOrNull(row.liveTup ?? row.live_tup),
      deadTup: toNumOrNull(row.deadTup ?? row.dead_tup),
      indexHitRate: toRateOrNull(row.indexHitRate ?? row.index_hit_rate),
    });
  }
  return out;
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
  return cleaned.filter((x, i) => cleaned.indexOf(x) === i); // 去重但保持原顺序
}

/**
 * 把 `/api/monitor/db` 的原始响应压成渲染安全的结构。
 * @param raw 接口原始响应（任何类型都可能进来：网络层错误体、旧版本字段、数组）
 * @returns 字段齐全的 DbSnapshot；enabled 只在确实是布尔时给值，其余 undefined（未知 ≠ 关闭）
 */
export function normalizeDbSnapshot(raw: unknown): DbSnapshot {
  if (!isPlainObject(raw)) return EMPTY_SNAPSHOT();

  const lastLight = isPlainObject(raw.lastLight) ? raw.lastLight : null;
  const lastHeavy = isPlainObject(raw.lastHeavy) ? raw.lastHeavy : null;
  // 契约把 tables 放顶层，sampler 的 heavy 快照里挂在 lastHeavy 下 —— 两处都认
  const tablesRaw = Array.isArray(raw.tables)
    ? raw.tables
    : lastHeavy && Array.isArray(lastHeavy.tables)
      ? lastHeavy.tables
      : [];
  const storageRaw = isPlainObject(raw.storage) ? raw.storage : null;
  const typeRaw = typeof raw.type === 'string' ? raw.type.trim() : '';

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    type: typeRaw || null,
    pool: normalizePool(raw.pool),
    lastLight,
    lastHeavy,
    unavailable: normalizeStringList(raw.unavailable),
    tables: normalizeTables(tablesRaw),
    // 顶层没有 probeMs 时退回 light 采样里的（light 每轮都探一次）
    probeMs: toNumOrNull(raw.probeMs ?? lastLight?.probeMs),
    storage: storageRaw
      ? { rows: toNumOrNull(storageRaw.rows) ?? 0, approxBytes: toNumOrNull(storageRaw.approxBytes) }
      : null,
  };
}

/**
 * 连接池用量：ratio 给进度条，label 给一行文字。
 * max<=0/null 视为「上限未知」：total/max 会变 Infinity/NaN，ratio 给 null（界面显示「—」），
 * 既不用 100% 冒充「池子满了」，也不显示「3/0」吓人。waiting>0 时 label 必带「N 个等待」，
 * 这是池子打满的唯一可靠信号。
 * @param pool normalizeDbSnapshot().pool（可为 null）
 * @returns ratio 0~1 或 null；label 人类可读摘要（永不空串）
 */
export function poolUsage(pool?: DbPoolInfo | null): { ratio: number | null; label: string } {
  const total = pool?.total ?? null;
  const rawMax = pool?.max ?? null;
  const waiting = pool?.waiting ?? null;
  const max = rawMax !== null && rawMax > 0 ? rawMax : null;
  const ratio = max !== null && total !== null ? clamp01(total / max) : null;

  const parts: string[] = [];
  if (ratio !== null) parts.push(`${(ratio * 100).toFixed(1)}%`);
  if (total !== null && max !== null) parts.push(`${fmtNum(total)}/${fmtNum(max)}`);
  else if (total !== null) parts.push(`${fmtNum(total)} 个连接`);
  if (waiting !== null && waiting > 0) parts.push(`${fmtNum(waiting)} 个等待`);

  if (parts.length === 0) return { ratio: null, label: '连接池信息不可用' };
  return { ratio, label: parts.join(' · ') };
}

/**
 * 连接池健康档位。waiting>0 直接 bad：有请求排队说明连接全被占着，哪怕 total/max 还没到
 * 100%（pool 上限通常留余量），业务上已经在等超时了。
 * @param ratio poolUsage().ratio（null = 未知）
 * @param waiting 等待连接数（null = 未知）
 * @returns 'ok' | 'warn' | 'bad'
 */
export function poolLevel(ratio: number | null, waiting: number | null): 'ok' | 'warn' | 'bad' {
  if (waiting !== null && waiting > 0) return 'bad';
  if (ratio === null) return 'ok'; // 未知不当故障，交给 unavailable 警示条解释
  if (ratio >= 0.9) return 'bad';
  if (ratio >= 0.7) return 'warn';
  return 'ok';
}

/**
 * 按体积降序取前 N 张表。bytes 为 null 的排最后（读不到体积不等于没体积，
 * 不能因为 null 就把它顶到榜首或直接丢掉）。
 * @param tables normalizeDbSnapshot().tables
 * @param limit 条数上限（默认 10；显式 0/负数给空数组，NaN 等非法值回退默认）
 * @returns 排序后的新数组（不改入参）
 */
export function topTables(tables: DbTableStat[] | undefined, limit = 10): DbTableStat[] {
  if (!Array.isArray(tables) || tables.length === 0) return [];
  // 显式 0 的语义是「一条都不要」，不能当成"没传"回退成 10（那样调用方想关掉列表也关不掉）
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;
  const valid = tables.filter((t) => isPlainObject(t) && typeof t.name === 'string' && t.name.trim() !== '');
  const sorted = valid.slice().sort((a, b) => {
    const ab = typeof a.bytes === 'number' && Number.isFinite(a.bytes) ? a.bytes : null;
    const bb = typeof b.bytes === 'number' && Number.isFinite(b.bytes) ? b.bytes : null;
    if (ab === null && bb === null) return a.name.localeCompare(b.name);
    if (ab === null) return 1;
    if (bb === null) return -1;
    if (bb !== ab) return bb - ab;
    return a.name.localeCompare(b.name);
  });
  return sorted.slice(0, max);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * 人类可读的体积（1024 进制，小数点后 1 位：1536 → '1.5 KB'）。
 * @param bytes 字节数；null/undefined/NaN/负数 一律 '—'（读不到 ≠ 0 字节）
 * @returns 带单位的字符串
 */
export function formatBytes(bytes: number | null | undefined): string {
  const n = bytes === null || bytes === undefined ? Number.NaN : Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/**
 * 索引命中率：0.98 → '98.0%'。null（分母为 0，没走过任何扫描）给 '—'，
 * 不能显示 0% —— 那会让「新表」看起来像「全表扫描」。
 * @param rate 0~1 的比率（越界值夹到 0~100%）
 * @returns 百分数字符串或 '—'
 */
export function formatIndexHit(rate: number | null | undefined): string {
  const n = rate === null || rate === undefined ? Number.NaN : Number(rate);
  return Number.isFinite(n) ? `${(clamp01(n) * 100).toFixed(1)}%` : '—';
}

/** unavailable 键 → 人话。值是「为什么看不到」，不是「值为 0」。 */
const UNAVAILABLE_TEXT: Record<string, string> = {
  pg_stat_activity: '权限不足，看不到其他会话', pg_locks: '读不到锁等待状态',
  pg_tables: '读不到表体积（pg_total_relation_size 被拒绝）', pg_session: '借不到采样连接（超时或被拒）',
  pool_info: '读不到连接池水位', sqlite_pragma: 'PRAGMA 读取失败', sqlite_wal: '读不到 WAL 文件大小',
  sqlite_quick_check: '完整性检查 quick_check 失败', mysql: 'MySQL 指标不支持（能力探测失败）', probe: '探针查询失败',
};

/**
 * 把 `unavailable[]` 翻成人话，拼成一条警示文案。
 * @param items 采样器/路由记下的失败项键，如 ['pg_stat_activity']
 * @returns 空数组/非数组 → ''；多条用「；」连接，重复键只出现一次
 */
export function unavailableReason(items: string[] | undefined): string {
  if (!Array.isArray(items)) return '';
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key.startsWith('dialect:')) {
      parts.push(`不支持的数据库方言（${key.slice('dialect:'.length) || '未知'}）`);
    } else if (/[\u4e00-\u9fa5]/.test(key)) {
      parts.push(key); // 路由层已经写好中文原因（如「sampler 未接入」），原样透出不套壳
    } else {
      parts.push(`${UNAVAILABLE_TEXT[key] ?? '该项指标无法采集'}（${key}）`);
    }
  }
  return parts.join('；');
}

/**
 * 探针延迟序列（画 sparkline 用）。
 *
 * 丢掉 probeMs 缺失/非数/负数的采样（采样失败会给 null，画进去曲线会骗人），
 * 按时间升序，只保留最近 limit 个点。
 * @param samples 采样数组 `{ tsMs, probeMs }`
 * @param limit 保留的最近点数（默认 60）
 * @returns 升序的 `{ t, v }`（t = epoch ms，v = 探针毫秒）
 */
export function buildProbeSeries(
  samples: Array<{ tsMs: number; probeMs?: number | null }>,
  limit = 60,
): Array<{ t: number; v: number }> {
  if (!Array.isArray(samples)) return [];
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 60;
  const points: Array<{ t: number; v: number }> = [];
  for (const s of samples) {
    if (!isPlainObject(s)) continue;
    const t = toNumOrNull(s.tsMs);
    const v = toNumOrNull(s.probeMs);
    if (t === null || v === null || v < 0) continue;
    points.push({ t, v });
  }
  points.sort((a, b) => a.t - b.t);
  return points.slice(-max);
}
