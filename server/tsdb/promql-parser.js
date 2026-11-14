/**
 * PromQL 语法分析 —— 递归下降 + 优先级爬升。
 *
 * 支持的语法范围（这是「够用」的取舍，不是完整 PromQL）：
 *
 *   向量选择器   metric{a="1",b=~"x.*"} 、 {__name__=~"node_.*"}
 *   区间         metric[5m]  （用于 _over_time / rate 类函数）
 *   offset       metric offset 5m    /    metric[5m] offset 1h
 *   数字/字符串  `1`、`1.5`、`"str"`
 *   函数调用     rate(x[5m])、histogram_quantile(0.9, x)、label_replace(...)
 *   聚合         sum(x) / sum by (a,b) (x) / sum without (c) (x) / topk(3, x)
 *   二元运算     + - * / % ^ atan2  == != > < >= <=  and or unless
 *   向量匹配     on(...) / ignoring(...) / group_left(...) / group_right(...)
 *   bool 修饰    a > bool 0
 *   一元负号     -x
 *   括号         (x)
 *
 * **不支持的**（解析时给出明确报错，而不是静默忽略）：
 *   @ start()/end()/unix 修饰符 —— 见 lexer，词法层就拒绝
 *   subquery   `x[5m:1m]` —— 需要记录规则与嵌套求值，本轮不做
 *
 * 设计原则：**宁可明确报错，不可静默降级**。一个被悄悄忽略的 `offset 5m`
 * 会让用户看到完全错误的数据，比报错难查得多。
 */

import { tokenize, T } from './promql-lexer.js';

/** 二元运算符优先级，数字越大绑定越紧 */
const BINARY_PRECEDENCE = {
  or: 1,
  and: 2, unless: 2,
  '==': 3, '!=': 3, '>': 3, '<': 3, '>=': 3, '<=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5, atan2: 5,
  '^': 6,
};

/** 右结合的运算符 */
const RIGHT_ASSOC = new Set(['^']);

/** 返回向量而非标量的聚合函数 */
export const AGGREGATORS = new Set([
  'sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count',
  'count_values', 'bottomk', 'topk', 'quantile',
]);

/** 需要第一个参数是标量的聚合 */
export const PARAM_AGGREGATORS = new Set(['count_values', 'bottomk', 'topk', 'quantile']);

/**
 * 已知函数及其参数个数。
 * 不在表里的名字按「未知函数」报错 —— 静默当成指标名会让人以为查询成功。
 */
export const FUNCTIONS = {
  // 区间向量函数
  rate: { args: [1, 1], range: true },
  irate: { args: [1, 1], range: true },
  increase: { args: [1, 1], range: true },
  delta: { args: [1, 1], range: true },
  idelta: { args: [1, 1], range: true },
  deriv: { args: [1, 1], range: true },
  changes: { args: [1, 1], range: true },
  resets: { args: [1, 1], range: true },
  predict_linear: { args: [2, 2], range: true },
  holt_winters: { args: [3, 3], range: true },
  avg_over_time: { args: [1, 1], range: true },
  min_over_time: { args: [1, 1], range: true },
  max_over_time: { args: [1, 1], range: true },
  sum_over_time: { args: [1, 1], range: true },
  count_over_time: { args: [1, 1], range: true },
  quantile_over_time: { args: [2, 2], range: true },
  stddev_over_time: { args: [1, 1], range: true },
  stdvar_over_time: { args: [1, 1], range: true },
  last_over_time: { args: [1, 1], range: true },
  present_over_time: { args: [1, 1], range: true },

  // 数学
  abs: { args: [1, 1] }, ceil: { args: [1, 1] }, floor: { args: [1, 1] },
  exp: { args: [1, 1] }, ln: { args: [1, 1] }, log2: { args: [1, 1] }, log10: { args: [1, 1] },
  sqrt: { args: [1, 1] }, sgn: { args: [1, 1] }, round: { args: [1, 2] },
  clamp: { args: [3, 3] }, clamp_max: { args: [2, 2] }, clamp_min: { args: [2, 2] },
  deg: { args: [1, 1] }, rad: { args: [1, 1] },

  // 时间
  time: { args: [0, 0] }, timestamp: { args: [1, 1] }, minute: { args: [1, 1] },
  hour: { args: [1, 1] }, day_of_month: { args: [1, 1] }, day_of_week: { args: [1, 1] },
  day_of_year: { args: [1, 1] }, month: { args: [1, 1] }, year: { args: [1, 1] },
  days_in_month: { args: [1, 1] },

  // 向量/标量互转
  vector: { args: [1, 1] }, scalar: { args: [1, 1] },

  // 标签
  label_replace: { args: [5, 5] }, label_join: { args: [4, Infinity] },

  // 排序
  sort: { args: [1, 1] }, sort_desc: { args: [1, 1] }, sort_by_label: { args: [2, Infinity] },

  // 缺失
  absent: { args: [1, 1] }, absent_over_time: { args: [1, 1], range: true },

  // 直方图
  histogram_quantile: { args: [2, 2] },

  // 三角函数
  acos: { args: [1, 1] }, asin: { args: [1, 1] }, atan: { args: [1, 1] },
  cos: { args: [1, 1] }, sin: { args: [1, 1] }, tan: { args: [1, 1] },
};

/**
 * 解析 PromQL。
 *
 * @param {string} input
 * @returns {{ ast: object|null, error: {message:string, pos?:number}|null }}
 */
export function parse(input) {
  const { tokens, error } = tokenize(input);
  if (error) return { ast: null, error };

  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const at = (type) => tokens[i] && tokens[i].type === type;
  const atValue = (val) => tokens[i] && tokens[i].value === val;

  const fail = (message, pos) => {
    const p = pos ?? (tokens[i] ? tokens[i].pos : 0);
    const err = new Error(message);
    err.pos = p;
    throw err;
  };

  const expect = (type, what) => {
    if (!at(type)) fail(`期望 ${what}，实际是 ${describe(peek())}`);
    return next();
  };

  // ── 表达式：优先级爬升 ──
  function parseExpr(minPrec = 0) {
    let lhs = parseUnary();

    for (;;) {
      const tok = peek();
      if (!tok || tok.type === T.EOF) break;
      const op = tok.value;
      const prec = BINARY_PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      next();

      const node = {
        type: 'binary',
        op,
        lhs,
        rhs: null,
        bool: false,
        matching: null,
      };

      // bool 修饰（只对比较运算符有意义）
      if (atValue('bool')) {
        if (!['==', '!=', '>', '<', '>=', '<='].includes(op)) {
          fail(`bool 修饰只能用于比较运算符，不能用于 ${op}`);
        }
        next();
        node.bool = true;
      }

      // 向量匹配修饰：on(...) / ignoring(...) / group_left / group_right
      if (atValue('on') || atValue('ignoring')) {
        const mode = next().value;
        const labels = parseLabelList();
        node.matching = { on: mode === 'on', labels, group: null };
        if (atValue('group_left') || atValue('group_right')) {
          const g = next().value;
          // group_left 后可跟标签列表
          const glabels = at(T.LPAREN) ? parseLabelList() : [];
          node.matching.group = { side: g === 'group_left' ? 'left' : 'right', labels: glabels };
        }
      }

      const nextMin = RIGHT_ASSOC.has(op) ? prec : prec + 1;
      node.rhs = parseExpr(nextMin);
      lhs = node;
    }

    return lhs;
  }

  function parseUnary() {
    if (atValue('-') || atValue('+')) {
      const op = next().value;
      return { type: 'unary', op, expr: parseUnary() };
    }
    return parsePostfix(parsePrimary());
  }

  /** offset 与区间后缀 */
  function parsePostfix(node) {
    let out = node;

    // 区间：metric[5m]
    if (at(T.LBRACKET)) {
      const openTok = next();
      // 子查询 x[5m:1m] 不支持 —— 明确报错
      if (at(T.DURATION)) {
        const dur = Number(next().value);
        if (atValue(':')) fail('子查询 ([5m:1m]) 暂不支持', openTok.pos);
        expect(T.RBRACKET, ']');
        if (out.type !== 'selector') {
          fail('区间只能用于向量选择器', openTok.pos);
        }
        out = { ...out, rangeMs: dur };
      } else {
        fail('区间内必须是时长，例如 [5m]', peek() ? peek().pos : 0);
      }
    }

    // offset
    if (atValue('offset')) {
      const offTok = next();
      let sign = 1;
      if (atValue('-')) { next(); sign = -1; }
      const d = peek();
      if (!d || d.type !== T.DURATION) {
        fail('offset 后必须是时长，例如 offset 5m', offTok.pos);
      }
      next();
      if (out.type !== 'selector') fail('offset 只能用于向量选择器', offTok.pos);
      out = { ...out, offsetMs: sign * Number(d.value) };
    }

    return out;
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) fail('表达式意外结束');

    // 数字
    if (tok.type === T.NUMBER) {
      next();
      const v = Number(tok.value);
      if (!Number.isFinite(v)) fail(`非法数字: ${tok.value}`, tok.pos);
      return { type: 'number', value: v };
    }

    // 字符串（多用于 label_replace 等函数的参数）
    if (tok.type === T.STRING) {
      next();
      return { type: 'string', value: tok.value };
    }

    // 括号
    if (tok.type === T.LPAREN) {
      next();
      const inner = parseExpr(0);
      expect(T.RPAREN, ')');
      return inner;
    }

    // 标签选择器开头 `{`
    if (tok.type === T.LBRACE) {
      return parseSelector('');
    }

    // 标识符：可能是聚合、函数、或指标名
    if (tok.type === T.IDENT) {
      const name = tok.value;
      const nameTok = tok;
      next();

      // 聚合：sum / topk ...，可带 by/without
      if (AGGREGATORS.has(name)) {
        // 无参形式 `sum(x)` 或带参 `topk(5, x)`
        let grouping = null;
        // 聚合也可以写成 `sum by (a) (x)` 或 `sum(x) by (a)`
        if (atValue('by') || atValue('without')) {
          const mode = next().value;
          grouping = { without: mode === 'without', labels: parseLabelList() };
        }
        if (!at(T.LPAREN)) {
          fail(`聚合函数 ${name} 后缺少 (`, nameTok.pos);
        }
        next();
        const args = parseCallArgs();
        // 后置的 by/without（Prometheus 也接受这种写法）
        if (!grouping && (atValue('by') || atValue('without'))) {
          const mode = next().value;
          grouping = { without: mode === 'without', labels: parseLabelList() };
        }
        if (args.length !== (PARAM_AGGREGATORS.has(name) ? 2 : 1)) {
          fail(`${name} 需要 ${PARAM_AGGREGATORS.has(name) ? 2 : 1} 个参数，实际 ${args.length}`, nameTok.pos);
        }
        return {
          type: 'aggregate',
          op: name,
          param: PARAM_AGGREGATORS.has(name) ? args[0] : null,
          expr: PARAM_AGGREGATORS.has(name) ? args[1] : args[0],
          grouping,
        };
      }

      // 函数调用
      if (at(T.LPAREN) && FUNCTIONS[name]) {
        const openTok = next();
        const args = parseCallArgs();
        const spec = FUNCTIONS[name];
        if (args.length < spec.args[0] || args.length > spec.args[1]) {
          fail(`${name} 参数个数应为 ${spec.args[0]}~spec.args[1]}，实际 ${args.length}`, openTok.pos);
        }
        return { type: 'call', func: name, args, range: Boolean(spec.range) };
      }

      // 未知函数：`foo(...)` 且 foo 不是已知函数也不是指标名
      if (at(T.LPAREN) && !FUNCTIONS[name]) {
        fail(`未知函数: ${name}`, nameTok.pos);
      }

      // 普通指标名，可能紧跟标签块
      if (at(T.LBRACE)) {
        return parseSelector(name);
      }
      return {
        type: 'selector',
        name,
        matchers: [],
        rangeMs: null,
        offsetMs: 0,
      };
    }

    fail(`无法解析的 token: ${describe(tok)}`, tok.pos);
    return null;
  }

  /** 解析标签选择器（name 可为空，表示只有 {__name__=~...}） */
  function parseSelector(name) {
    expect(T.LBRACE, '{');
    const matchers = [];
    let first = true;
    while (!at(T.RBRACE)) {
      if (!first) expect(T.COMMA, ',');
      first = false;
      const kTok = expect(T.IDENT, '标签名');
      let op = '=';
      const opTok = peek();
      if (opTok && [T.OP, '='].includes(opTok.type) || (opTok && opTok.value === '=')) {
        op = next().value;
      } else if (!opTok || !['=', '!=', '=~', '!~'].includes(opTok.value)) {
        fail(`标签匹配需要运算符，实际是 ${describe(opTok)}`, kTok.pos);
      }
      const vTok = expect(T.STRING, '标签值（必须是带引号的字符串）');
      if (!['=', '!=', '=~', '!~'].includes(op)) {
        fail(`不支持的标签运算符: ${op}`, opTok ? opTok.pos : kTok.pos);
      }
      matchers.push({ name: kTok.value, op, value: vTok.value });
      if (at(T.COMMA) && tokens[i + 1] && tokens[i + 1].type === T.RBRACE) next();
    }
    expect(T.RBRACE, '}');

    if (!name && matchers.length === 0) {
      fail('空选择器 {} 至少要有一个标签匹配器');
    }
    return {
      type: 'selector',
      name: name || '',
      matchers,
      rangeMs: null,
      offsetMs: 0,
    };
  }

  /** `( a, b, c )` —— 左括号已消费 */
  function parseCallArgs() {
    const args = [];
    if (at(T.RPAREN)) {
      next();
      return args;
    }
    for (;;) {
      args.push(parseExpr(0));
      if (at(T.COMMA)) { next(); continue; }
      break;
    }
    expect(T.RPAREN, ')');
    return args;
  }

  /** `( a, b )` 的标签名列表 */
  function parseLabelList() {
    expect(T.LPAREN, '(');
    const labels = [];
    if (at(T.RPAREN)) { next(); return labels; }
    for (;;) {
      const t = expect(T.IDENT, '标签名');
      labels.push(t.value);
      if (at(T.COMMA)) { next(); continue; }
      break;
    }
    expect(T.RPAREN, ')');
    return labels;
  }

  try {
    const ast = parseExpr(0);
    if (!at(T.EOF)) {
      fail(`多余的 token: ${describe(peek())}`);
    }
    return { ast, error: null };
  } catch (err) {
    return { ast: null, error: { message: err.message, pos: err.pos ?? 0 } };
  }
}

function describe(tok) {
  if (!tok) return '结束';
  if (tok.type === T.EOF) return '结束';
  return `"${tok.value}" (${tok.type})`;
}

/**
 * 从 AST 里收集所有向量选择器 —— 执行器需要先知道要读哪些序列。
 * @returns {Array<object>}
 */
export function collectSelectors(ast) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'selector') { out.push(node); return; }
    if (node.type === 'binary') { walk(node.lhs); walk(node.rhs); return; }
    if (node.type === 'unary') { walk(node.expr); return; }
    if (node.type === 'aggregate') { walk(node.expr); if (node.param) walk(node.param); return; }
    if (node.type === 'call') { for (const a of node.args || []) walk(a); }
  };
  walk(ast);
  return out;
}

/**
 * 查询需要的最长回看窗口（毫秒）。
 *
 * 为什么重要：抓取只需读「查询区间 + 这个回看量」的点。
 * 少读会让 rate 类函数在窗口左边界算出偏小的值。
 */
export function maxLookback(ast) {
  let max = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'selector') {
      const span = Math.abs(node.rangeMs || 0) + Math.abs(node.offsetMs || 0);
      // 区间函数要额外一点余量给边界的插值
      max = Math.max(max, span ? span * 1.1 : 0);
      return;
    }
    if (node.type === 'binary') { walk(node.lhs); walk(node.rhs); return; }
    if (node.type === 'unary') { walk(node.expr); return; }
    if (node.type === 'aggregate') { walk(node.expr); if (node.param) walk(node.param); return; }
    if (node.type === 'call') {
      for (const a of node.args || []) walk(a);
    }
  };
  walk(ast);
  return Math.ceil(max);
}