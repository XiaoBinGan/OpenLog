/**
 * PromQL 词法分析。
 *
 * 支持 Prometheus 的查询子集，不是完整实现 —— 目标见 engine.js 顶部的清单。
 *
 * 手写词法而不是正则：PromQL 里 `{`、`[`、`(` 都可能紧贴标识符或数字，
 * 正则很难在不看上下文的情况下切对，而词法分析器天然是线性扫一遍。
 *
 * 与 Prometheus 对齐的两个细节：
 *   · 时长的单位后缀可以组合，`1h30m` = 5400s；
 *   · 标识符允许冒号（记录规则名 `job:errors:rate5m`），但冒号不能开头。
 */

/** 时长单位 → 毫秒 */
const DURATION_UNITS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000, // Prometheus 里 y 固定 365 天
};

/** 关键字集合（词法层不区分关键字与标识符，由语法层判定） */
export const KEYWORDS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
  'offset', 'bool', 'and', 'or', 'unless', 'inf', 'nan',
]);

/**
 * 把时长字符串（`5m`、`1h30m`、`90s`）解析成毫秒。
 * @returns {number|null} 非法返回 null
 */
export function parseDuration(str) {
  const s = String(str ?? '').trim();
  if (s === '') return null;
  let i = 0;
  let total = 0;
  let matched = false;
  while (i < s.length) {
    const numStart = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i += 1;
    if (i === numStart) return null;
    const num = Number(s.slice(numStart, i));
    if (!Number.isFinite(num) || num < 0) return null;

    // 单位：优先匹配两字符的 ms
    let unit = null;
    for (const u of ['ms', 's', 'm', 'h', 'd', 'w', 'y']) {
      if (s.startsWith(u, i)) { unit = u; break; }
    }
    if (!unit) return null;
    i += unit.length;
    total += num * DURATION_UNITS[unit];
    matched = true;
  }
  return matched ? total : null;
}

/** 毫秒转回 Prometheus 时长写法（用于错误信息与回显） */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '0s';
  if (n === 0) return '0s';
  const parts = [];
  let rest = n;
  const units = [
    ['y', DURATION_UNITS.y], ['w', DURATION_UNITS.w], ['d', DURATION_UNITS.d],
    ['h', DURATION_UNITS.h], ['m', DURATION_UNITS.m], ['s', DURATION_UNITS.s],
  ];
  for (const [suffix, size] of units) {
    if (rest >= size) {
      const q = Math.floor(rest / size);
      parts.push(`${q}${suffix}`);
      rest -= q * size;
    }
  }
  if (rest > 0) parts.push(`${rest}ms`);
  return parts.join('') || '0s';
}

/** token 类型 */
export const T = {
  IDENT: 'ident',
  NUMBER: 'number',
  STRING: 'string',
  DURATION: 'duration',
  LBRACE: '{', RBRACE: '}',
  LPAREN: '(', RPAREN: ')',
  LBRACKET: '[', RBRACKET: ']',
  COMMA: ',',
  COLON: ':',
  OP: 'op',
  EOF: 'eof',
};

/** 双字符运算符优先匹配 */
const TWO_CHAR_OPS = new Set(['!=', '=~', '!~', '==', '>=', '<=']);

/**
 * 词法分析。
 *
 * @param {string} input
 * @returns {{tokens: Array<{type:string, value:string, pos:number}>, error: {message:string, pos:number}|null}}
 */
export function tokenize(input) {
  const src = String(input ?? '');
  const tokens = [];
  let i = 0;

  const push = (type, value, pos) => tokens.push({ type, value, pos });

  while (i < src.length) {
    const ch = src[i];

    // 空白
    if (/\s/.test(ch)) { i += 1; continue; }

    // 注释（PromQL 支持 # 到行尾）
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }

    // 字符串：双引号、单引号、反引号
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      let val = '';
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\' && quote !== '`' && i + 1 < src.length) {
          const esc = src[i + 1];
          if (esc === 'n') val += '\n';
          else if (esc === 't') val += '\t';
          else if (esc === 'r') val += '\r';
          else if (esc === '\\') val += '\\';
          else if (esc === quote) val += quote;
          else val += `\\${esc}`;
          i += 2;
          continue;
        }
        if (c === quote) { i += 1; closed = true; break; }
        val += c;
        i += 1;
      }
      if (!closed) return { tokens, error: { message: '字符串未闭合', pos: start } };
      push(T.STRING, val, start);
      continue;
    }

    // 数字：可能是整数、小数、科学计数，也可能是时长
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i;
      // 科学计数要把 e+/- 吃掉
      while (i < src.length && /[0-9.]/.test(src[i])) i += 1;
      if (/[eE]/.test(src[i] ?? '') && /[0-9+-]/.test(src[i + 1] ?? '')) {
        i += 2;
        while (i < src.length && /[0-9]/.test(src[i])) i += 1;
      }
      const numText = src.slice(start, i);

      // 后面紧跟时长单位 → 这是一个时长 token。
      // 必须把连续的 `<num><unit>` 段整段吃成一个 token：Prometheus 里
      // `1h30m` 是**一个**时长（5400s），拆成两个会让 `[1h30m]` 变成语法错误。
      if (i < src.length && /[a-z]/.test(src[i])) {
        let unit = null;
        for (const u of ['ms', 's', 'm', 'h', 'd', 'w', 'y']) {
          if (src.startsWith(u, i)) { unit = u; break; }
        }
        if (!unit) {
          return { tokens, error: { message: `非法时长单位: ${src.slice(i, i + 4)}`, pos: start } };
        }
        let combined = numText + unit;
        let j = i + unit.length;
        // 后续段落：<num><unit> 紧接，继续吃
        while (j < src.length && /[0-9.]/.test(src[j])) {
          const segStart = j;
          while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
          const segNum = src.slice(segStart, j);
          let segUnit = null;
          for (const u of ['ms', 's', 'm', 'h', 'd', 'w', 'y']) {
            if (src.startsWith(u, j)) { segUnit = u; break; }
          }
          if (!segUnit) {
            return { tokens, error: { message: `非法时长: ${combined}${segNum}`, pos: start } };
          }
          combined += segNum + segUnit;
          j += segUnit.length;
        }
        const ms = parseDuration(combined);
        if (ms === null) {
          return { tokens, error: { message: `非法时长: ${combined}`, pos: start } };
        }
        push(T.DURATION, String(ms), start);
        i = j;
        continue;
      }

      push(T.NUMBER, numText, start);
      continue;
    }

    // 标识符（含冒号）。冒号可以出现在名字里（记录规则 `job:errors:rate5m`），
    // 但**单独或数字开头的 `:` 不是标识符** —— 它是分隔符，要单独成 token。
    // 否则 `x[5m:1m]` 里 `:1m` 会被当成一个标识符，报错信息变成
    // 「期望 ]，实际是 :1m」，完全看不出真正原因是「子查询不支持」。
    if (/[A-Za-z_]/.test(ch) || (ch === ':' && /[A-Za-z_:]/.test(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_:]/.test(src[i])) i += 1;
      push(T.IDENT, src.slice(start, i), start);
      continue;
    }

    // 单/双字符运算符
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push(T.OP, two, i);
      i += 2;
      continue;
    }
    if ('+-*/%^=<>'.includes(ch)) {
      push(T.OP, ch, i);
      i += 1;
      continue;
    }

    // 标点
    if (ch === '{') { push(T.LBRACE, ch, i); i += 1; continue; }
    if (ch === '}') { push(T.RBRACE, ch, i); i += 1; continue; }
    if (ch === '(') { push(T.LPAREN, ch, i); i += 1; continue; }
    if (ch === ')') { push(T.RPAREN, ch, i); i += 1; continue; }
    if (ch === '[') { push(T.LBRACKET, ch, i); i += 1; continue; }
    if (ch === ']') { push(T.RBRACKET, ch, i); i += 1; continue; }
    if (ch === ',') { push(T.COMMA, ch, i); i += 1; continue; }
    // 单独的冒号（不成标识符时）：分隔符 token
    if (ch === ':') { push(T.COLON, ch, i); i += 1; continue; }
    if (ch === '@') {
      // @ 修饰符（@ start() / @ end() / @ <unix>）—— 暂不支持，直接报错更诚实
      return { tokens, error: { message: '@ 修饰符暂不支持', pos: i } };
    }

    return { tokens, error: { message: `无法识别的字符: ${ch}`, pos: i } };
  }

  push(T.EOF, '', src.length);
  return { tokens, error: null };
}