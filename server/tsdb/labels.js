/**
 * 时序标签 —— 规范化与指纹。
 *
 * Prometheus 的数据模型是「指标名 + 一组标签 → 一条时间序列」。
 * 这里负责把外部输入（抓取到的文本、内部采集的结构体）收敛成**稳定可比较**的形状，
 * 因为指纹是 series 表的主键：同一序列每轮抓取必须算出同一个指纹，
 * 否则存储会在几小时内膨胀成成千上万条重复序列。
 *
 * 三条硬规则（都是踩过的坑）：
 *   1. **标签名和值都必须是字符串**，数字 200 和字符串 "200" 必须归一成同一个 ——
 *      否则 `http_status="200"` 与 `http_status=200` 会变成两条序列。
 *   2. **标签顺序无关**，一律按键排序后序列化 —— 抓取文本里的顺序不保证稳定。
 *   3. **空值标签直接丢弃**，不写成 `k=""` —— Prometheus 语义里
 *      值为空字符串的标签等价于标签不存在，保留会让 `foo{a=""}` 与 `foo` 变成两条。
 */

/** 指标名合法性：Prometheus 允许 [a-zA-Z_:][a-zA-Z0-9_:]* */
const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
/** 标签名合法性：不允许冒号（冒号保留给记录规则） */
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** 指标名是否合法 */
export function isValidMetricName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/** 标签名是否合法（`__name__` 是保留的，单独处理） */
export function isValidLabelName(name) {
  return typeof name === 'string' && LABEL_RE.test(name) && name !== '__name__';
}

/**
 * 规范化标签集合。
 *
 * @param {Record<string, unknown>} raw
 * @param {{ strict?: boolean }} [opts]
 *   strict=true 时非法名直接抛错（用于内部 API 入参校验）；
 *   strict=false（默认）时静默丢弃非法项（用于抓取文本，一条坏标签不该让整批丢弃）
 * @returns {Record<string, string>} 按键排序的新对象
 */
export function normalizeLabels(raw, opts = {}) {
  const strict = opts.strict === true;
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    const val = raw[key];
    // null / undefined / 空串一律视为「该标签不存在」
    if (val === null || val === undefined || val === '') continue;
    if (!isValidLabelName(key)) {
      if (strict) throw new Error(`非法标签名: ${key}`);
      continue;
    }
    out[key] = String(val);
  }
  // 按键排序，保证序列化稳定（对象插入顺序在不同来源下不一致）
  const sorted = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key];
  return sorted;
}

/**
 * 标签集合的稳定字符串形式，例如 `method="GET",route="/api/x"`。
 * 指纹与展示都用它，保证「同一序列只有一种写法」。
 */
export function labelsToString(labels) {
  const norm = normalizeLabels(labels);
  const parts = Object.keys(norm).map((k) => `${k}="${escapeLabelValue(norm[k])}"`);
  return parts.join(',');
}

/** 转义标签值：反斜杠、双引号、换行。与 Prometheus 文本格式一致 */
export function escapeLabelValue(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * FNV-1a 32 位哈希，用于生成短指纹。
 *
 * 为什么不用 crypto：这儿只做去重键，不是安全边界。抓取热路径上每条序列都要算，
 * 同步的 crypto.createHash 在这个调用量下会成为可见开销。
 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    // 乘 16777619 并保持 32 位
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 序列指纹 = hash(指标名 + 标签串)。
 *
 * 为什么不直接用 `name{labels}` 当主键：标签值可能很长（URL、错误信息），
 * 直接当主键会让 series 表和每个索引都变胖；固定 8 字节让它恒定。
 *
 * 冲突概率：32 位哈希在 10 万条序列下碰撞概率约 1.2%（生日问题），
 * 对监控数据这个量级偏高，所以再拼一段长度与首尾字符做二次区分。
 */
export function seriesFingerprint(name, labels) {
  const norm = normalizeLabels(labels);
  const body = `${name}\u0000${labelsToString(norm)}`;
  return `${fnv1a32(body)}-${body.length.toString(16)}`;
}

/** 从原始输入构造一条序列描述（含指纹） */
export function makeSeries(name, labels) {
  if (!isValidMetricName(name)) throw new Error(`非法指标名: ${name}`);
  const norm = normalizeLabels(labels);
  return {
    fingerprint: seriesFingerprint(name, norm),
    name,
    labels: norm,
  };
}

/**
 * 判断序列是否匹配一组标签选择器（matchers）。
 *
 * matcher 形状：`{ name, op: '=' | '!=' | '=~' | '!~', value }`
 * 与 Prometheus 语义对齐的关键点：**空值匹配器不会匹配「标签不存在」的序列**，
 * 但 `label!="x"` 会（因为不存在等价于空串，空串 != x 成立）。
 */
export function matchesLabels(seriesLabels, matchers) {
  if (!Array.isArray(matchers) || matchers.length === 0) return true;
  const labels = seriesLabels || {};
  for (const m of matchers) {
    if (!m || !m.name) continue;
    const has = Object.prototype.hasOwnProperty.call(labels, m.name);
    const actual = has ? String(labels[m.name]) : '';
    const want = String(m.value ?? '');
    switch (m.op || '=') {
      case '=':
        if (!has || actual !== want) return false;
        break;
      case '!=':
        // 不存在等价于空串：`label!="x"` 对没有该标签的序列成立
        if (actual === want) return false;
        break;
      case '=~':
        if (!has || !safeRegex(want).test(actual)) return false;
        break;
      case '!~':
        if (has && safeRegex(want).test(actual)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * 编译正则，失败时退回「永不匹配」而不是抛错。
 * 为什么：抓取配置里的正则可能来自用户输入，一条坏正则不该让整个查询 500。
 */
function safeRegex(pattern) {
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch {
    return { test: () => false };
  }
}