/**
 * metrics/slow-query.js —— SQL 指纹化 + 慢查询内存环形缓冲（#9 slowquery）
 *
 * 为什么要指纹化：慢查询要落库（`slow_query_log` 表），但 SQL 文本里塞满参数值 ——
 * token、密码、用户输入全在字面量里。原样入库等于新开一个泄密面，所以入库的只能是
 * 「结构」：字符串/数字/参数占位符/IN 列表/VALUES 全部收成 `?`，参数值一个都不留。
 *
 * 为什么结果要小写化：`SELECT * FROM t WHERE id=1` 与 `select * from t where id=2`
 * 是同一条 SQL 的两种写法。大小写不统一会让同一结构分裂成多条指纹，聚合统计直接失真，
 * 所以关键字/未加引号的标识符统一小写；双引号里的内容（PG 大小写敏感的真实列名）保留原样。
 *
 * 为什么结果要截断到 500 字符：指纹进了内存缓冲还要进表，一条恶意拼接的超长 SQL
 * （几百个 union / 大堆列名）能撑爆缓冲和表。截断是最便宜的防御。
 *
 * 为什么用逐字符扫描而不是一堆正则 replace：字面量里可能出现 `--`、`;`、`'`、`/*`，
 * 正则链的先后顺序一旦错位就会把字符串内容当成语法处理 —— 那既会污染指纹，也可能漏掉
 * 需要脱敏的值。扫描器按 SQL 的词法优先级一次走完，语义确定。
 */

const MAX_RESULT = 500; // 指纹长度上限（超了截断 + '…'）
const MAX_INPUT = 4096; // 扫描窗口上限：结果只要 500，没必要为超长输入做无界计算
const DEFAULT_RATE_LIMIT = 5; // 同一指纹每分钟最多记 5 条（契约 4.6）
const COUNTS_HARD_LIMIT = 4096; // 限频计数表的硬上限，超了按分钟清一遍

const IDENT_RE = /[A-Za-z0-9_$]/;

/** @param {string|undefined} ch @returns {boolean} 是否是标识符字符 */
function isIdentChar(ch) {
  return ch !== undefined && ch !== '' && IDENT_RE.test(ch);
}

/** @param {string|undefined} ch @returns {boolean} */
function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/**
 * 跳过单引号字符串。同时支持标准 SQL 的 `''` 与 MySQL/PG 的 `\'` 转义。
 * @param {string} src @param {number} start 指向开头的引号
 * @returns {number} 闭引号之后的下标（未闭合则返回字符串末尾）
 */
function skipQuoted(src, start) {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; } // \' 和 \\ 都要连吃下一个字符
    if (ch === "'") {
      if (src[i + 1] === "'") { i += 2; continue; } // '' 是转义，不是结束
      return i + 1;
    }
    i += 1;
  }
  return i;
}

/** 吃掉一个数字字面量：整数/小数/科学计数/带符号 @returns {number} 结束下标 */
function skipNumber(src, start) {
  const n = src.length;
  let i = start;
  if (src[i] === '-' || src[i] === '+') i += 1;
  while (i < n && isDigit(src[i])) i += 1;
  if (src[i] === '.') {
    i += 1;
    while (i < n && isDigit(src[i])) i += 1;
  }
  if (src[i] === 'e' || src[i] === 'E') {
    let k = i + 1;
    if (src[k] === '-' || src[k] === '+') k += 1;
    if (isDigit(src[k])) {
      i = k + 1;
      while (i < n && isDigit(src[i])) i += 1;
    }
  }
  return i;
}

/**
 * 双引号里是「列名」还是「值」。
 * PG 的 `"col"` 是标识符，必须保留（否则 `where "userId" = ?` 和 `where x = ?` 会撞在一起）；
 * 但 `"12345"` / `"<uuid>"` 这种明显是值被包成了双引号，仍然要脱敏。
 */
function looksLikeValue(inner) {
  if (/^-?\d+(?:\.\d+)?$/.test(inner)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inner)) return true;
  return false;
}

/**
 * SQL 指纹化：去掉所有字面量/参数/IN 列表，只留结构。
 * @param {string} sql 原始 SQL
 * @returns {string} 指纹（不含任何参数值，长度 ≤ 500）
 */
export function fingerprintSql(sql) {
  if (typeof sql !== 'string' || sql.length === 0) return '';
  const src = sql.length > MAX_INPUT ? sql.slice(0, MAX_INPUT) : sql;
  const n = src.length;

  const chunks = [];
  let pendingSpace = false;
  /** lower=false 时保留原样（双引号标识符） */
  const emit = (text, lower = true) => {
    if (pendingSpace && chunks.length) chunks.push(' ');
    pendingSpace = false;
    chunks.push(lower ? text.toLowerCase() : text);
  };
  const emitSpace = () => { if (chunks.length) pendingSpace = true; };

  let i = 0;
  while (i < n) {
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : '';

    // 只留第一条语句：`;` 之后可能是 DROP/GRANT，指纹化它没有统计价值
    if (ch === ';') break;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      emitSpace(); i += 1; continue;
    }
    // 行注释：运维常在注释里留 `-- token=xxx`，整段丢掉
    if (ch === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    // 块注释
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }
    // 单引号字符串 → ?
    if (ch === "'") { i = skipQuoted(src, i); emit('?'); continue; }
    // E'...' / X'ABCD' / B'1010' / N'...' 前缀式字面量 → ?（整个前缀+引号一起吃掉）
    if (src[i + 1] === "'" && !isIdentChar(prev) && 'eExXbBnN'.includes(ch)) {
      i = skipQuoted(src, i + 1); emit('?'); continue;
    }
    // 双引号：标识符保留，明显是值的脱敏
    if (ch === '"') {
      let j = i + 1;
      let inner = '';
      let closed = false;
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { inner += '"'; j += 2; continue; }
          closed = true; break;
        }
        inner += src[j]; j += 1;
      }
      if (!closed) { emit('?'); i = n; continue; } // 未闭合：宁可脱敏也不原样输出
      emit(looksLikeValue(inner) ? '?' : `"${inner}"`, false);
      i = j + 1;
      continue;
    }
    // $n 占位符（PG）与 $$...$$ / $tag$...$tag$ 字面量
    if (ch === '$') {
      if (isDigit(src[i + 1]) && !isIdentChar(prev)) {
        i += 1;
        while (i < n && isDigit(src[i])) i += 1;
        emit('?'); continue;
      }
      if (!isIdentChar(prev)) {
        let j = i + 1;
        while (j < n && (isIdentChar(src[j]) && src[j] !== '$')) j += 1;
        if (src[j] === '$') {
          const tag = src.slice(i, j + 1);
          const close = src.indexOf(tag, j + 1);
          i = close === -1 ? n : close + tag.length;
          emit('?'); continue;
        }
      }
      emit('$'); i += 1; continue;
    }
    // %s / %S（DB-API / printf 风格）
    if (ch === '%' && (src[i + 1] === 's' || src[i + 1] === 'S')) { i += 2; emit('?'); continue; }
    // 0x1F / 0b1011（MySQL/SQLite 的十六进制、二进制字面量）——不单独处理会让 1F 漏进指纹
    if (ch === '0' && !isIdentChar(prev) && (src[i + 1] === 'x' || src[i + 1] === 'X'
      || src[i + 1] === 'b' || src[i + 1] === 'B')) {
      const digitRe = (src[i + 1] === 'x' || src[i + 1] === 'X') ? /[0-9a-fA-F]/ : /[01]/;
      let j = i + 2;
      while (j < n && digitRe.test(src[j])) j += 1;
      if (j > i + 2) { i = j; emit('?'); continue; }
    }
    // 数字：整数/小数/科学计数/负数。前面紧跟标识符字符说明它是 `col1` 的一部分，不是字面量
    if ((isDigit(ch) || ((ch === '-' || ch === '+' || ch === '.') && isDigit(src[i + 1])))
      && !isIdentChar(prev) && prev !== '.') {
      i = skipNumber(src, i); emit('?'); continue;
    }
    // `?` 原样保留（本来就是占位符）
    emit(ch); i += 1;
  }

  let out = chunks.join('');
  // 比较运算符两侧的空白不参与指纹：`id=1` 和 `id = 1` 必须是同一条
  out = out.replace(/\s*(<>|!=|>=|<=|=|<|>)\s*/g, ' $1 ');
  // 逗号同理：`(a,b)` 和 `(a, b)` 必须是同一条
  out = out.replace(/\s*,\s*/g, ', ');
  out = out.replace(/\s+/g, ' ').trim();
  // VALUES 的多组值收成一组（INSERT 批量与单条走同一个指纹）
  out = out.replace(/values\s*\(\s*\?(?:\s*,\s*\?)*\s*\)(?:\s*,\s*\(\s*\?(?:\s*,\s*\?)*\s*\))*/g, 'values (?)');
  // IN 列表收敛：IN (1,2,3) / IN (?,?,?) → IN (?)，元素个数不该造成指纹分裂
  out = out.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?)');
  if (out.length > MAX_RESULT) out = `${out.slice(0, MAX_RESULT - 1)}…`;
  return out;
}

/** 分钟桶 key（契约第 2 节：wall clock / 60000） */
function minuteBucket(nowMs) {
  return String(Math.floor(nowMs / 60000));
}

/** 限频计数 key：不同分钟天然不共享计数 */
function rateKey(nowMs, fingerprint) {
  return `${minuteBucket(nowMs)}|${fingerprint}`;
}

/** counts 允许 Map 也允许普通对象/Record —— 测试可直接构造 */
function readCount(counts, key) {
  if (!counts) return 0;
  if (counts instanceof Map) {
    const v = counts.get(key);
    return Number.isFinite(v) ? v : 0;
  }
  const v = counts[key];
  return Number.isFinite(v) ? v : 0;
}

/** 计数表只增不减会随指纹种类无限长，超过硬上限就把非当前分钟的桶清掉 */
function pruneCounts(counts, nowMs) {
  if (!(counts instanceof Map) || counts.size <= COUNTS_HARD_LIMIT) return;
  const current = minuteBucket(nowMs);
  for (const key of counts.keys()) {
    if (key.slice(0, key.indexOf('|')) !== current) counts.delete(key);
  }
}

/**
 * 该不该记：按「指纹 + 分钟」限频（同一指纹同一分钟最多 N 条），挡住一个慢查询刷屏。
 * 纯函数：只读 state，不改它 —— 计数由调用方在真正记录后自己 +1，
 * 这样「被丢弃的条目」不会继续抬高计数（否则一次尖峰后本分钟会一直静默）。
 * @param {{counts?: Map<string, number>|Record<string, number>, limitPerMinute?: number}} state
 * @param {{fingerprint?: string, ms?: number, nowMs?: number}} input
 * @returns {boolean} 是否允许记录
 */
export function shouldRecord(state, { fingerprint, ms, nowMs } = {}) {
  if (!state || typeof state !== 'object') return false;
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return false;
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const limit = Number.isFinite(state.limitPerMinute) && state.limitPerMinute > 0
    ? state.limitPerMinute
    : DEFAULT_RATE_LIMIT;
  void ms; // 阈值判断在 record 里做；这里只管限频
  return readCount(state.counts, rateKey(at, fingerprint)) < limit;
}

/**
 * 统计窗口内慢查询（内存环形缓冲）。
 * @param {{thresholdMs?: number, max?: number, now?: () => number}} [opts]
 *   thresholdMs 慢查询阈值（默认 200ms）；max 环形缓冲上限（默认 200 条）；
 *   now 时钟注入，仅测试用。
 * @returns {{
 *   record: (input: {sql?: string, ms?: number, source?: string}) => boolean,
 *   list: (limit?: number) => Array<{ts_ms: number, fingerprint: string, ms: number, source: string|null, sample: string}>,
 *   reset: () => void,
 * }}
 */
export function createSlowQueryLog(opts = {}) {
  const thresholdMs = Number.isFinite(Number(opts.thresholdMs)) ? Number(opts.thresholdMs) : 200;
  const max = Math.max(1, Math.floor(Number(opts.max)) || 200);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const state = { counts: new Map() };
  /** 环形缓冲：满了从头部丢最老的 */
  const buffer = [];

  return {
    /**
     * 记录一条（低于阈值/被限频/没有结构可留 → 不记）
     * @param {{sql?: string, ms?: number, source?: string}} input
     * @returns {boolean} 是否真的记录
     */
    record({ sql, ms, source } = {}) {
      const elapsed = Number(ms);
      if (!Number.isFinite(elapsed) || elapsed < thresholdMs) return false;
      const fingerprint = fingerprintSql(sql);
      if (fingerprint.length === 0) return false;
      const nowMs = Number(now());
      if (!Number.isFinite(nowMs)) return false;
      if (!shouldRecord(state, { fingerprint, ms: elapsed, nowMs })) return false;
      const key = rateKey(nowMs, fingerprint);
      state.counts.set(key, readCount(state.counts, key) + 1);
      pruneCounts(state.counts, nowMs);
      // sample 存的就是指纹本身：它就是「截断后的 SQL」，且天然不含参数值
      buffer.push({ ts_ms: nowMs, fingerprint, ms: elapsed, source: source || null, sample: fingerprint });
      if (buffer.length > max) buffer.splice(0, buffer.length - max);
      return true;
    },
    /**
     * 按时间倒序列出（返回副本，外部改动不影响缓冲）
     * @param {number} [limit]
     */
    list(limit) {
      const want = limit === undefined ? buffer.length : Math.min(buffer.length, Math.max(0, Math.floor(Number(limit)) || 0));
      const out = [];
      for (let i = buffer.length - 1; i >= 0 && out.length < want; i -= 1) out.push({ ...buffer[i] });
      return out;
    },
    /** 清空缓冲与限频计数 */
    reset() {
      buffer.length = 0;
      state.counts.clear();
    },
  };
}
