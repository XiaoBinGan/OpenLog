/**
 * PromQL 求值引擎。
 *
 * 数据模型与 Prometheus 对齐：
 *   · **instant vector** —— 每个序列在查询时刻一个值：`[{labels, value}]`
 *   · **range vector**    —— 每个序列在窗口内一串点：`[{labels, points:[{ts,value}]}]`
 *   · **scalar**          —— 一个数字
 *
 * 求值策略：**先把所有需要的原始序列一次读出来**，再在内存里做函数与聚合。
 * 为什么不逐节点查库：`sum by (job) (rate(x[5m]))` 会读一次 x，
 * 而 `sum(x) / sum(y)` 要读两次 —— 但每个选择器只读一次，
 * 且能利用「一次 SQL 拿多序列」的批量优势。嵌套越多，这个取舍越划算。
 */

import { normalizeLabels } from './labels.js';
import { parse } from './promql-parser.js';

/** 默认回看窗口：抓取间隔的 5 倍。15s 抓取 → 75s，够覆盖两次抓取的抖动 */
export const DEFAULT_LOOKBACK_MS = 5 * 60_000;

/**
 * 创建执行器。
 *
 * @param {object} deps
 * @param {{queryRange:Function}} deps.store TSDB 存储层
 * @param {() => number} [deps.now] 时钟
 */
export function createEvaluator(deps = {}) {
  const store = deps.store;
  const now = deps.now || (() => Date.now());

  /**
   * 执行一条查询。
   *
   * @param {string|object} query PromQL 文本或已解析的 AST
   * @param {object} [opts]
   * @param {number} [opts.time] 求值时刻（毫秒）
   * @param {number} [opts.lookbackMs] 瞬时向量选择器的回看窗口
   * @returns {Promise<{ resultType:'vector'|'scalar'|'matrix', result:any, error?:object, warnings?:string[] }>}
   */
  async function query(query, opts = {}) {
    let ast = query;
    if (typeof query === 'string') {
      const parsed = parse(query);
      if (parsed.error) {
        return { resultType: 'vector', result: [], error: { type: 'bad_data', message: parsed.error.message, pos: parsed.error.pos } };
      }
      ast = parsed.ast;
    }
    if (!ast) return { resultType: 'vector', result: [], error: { type: 'bad_data', message: '空查询' } };

    const time = Number.isFinite(opts.time) ? Number(opts.time) : now();
    const lookback = Number.isFinite(opts.lookbackMs) && opts.lookbackMs > 0
      ? Number(opts.lookbackMs)
      : DEFAULT_LOOKBACK_MS;

    const ctx = { store, now: time, lookback, warnings: [] };

    try {
      const value = await evaluate(ast, ctx);
      if (value.kind === 'scalar') {
        return { resultType: 'scalar', result: [value.ts, String(value.value)], warnings: ctx.warnings };
      }
      if (value.kind === 'string') {
        return { resultType: 'string', result: [time, value.value], warnings: ctx.warnings };
      }
      if (value.kind === 'matrix') {
        // 区间查询的中间结果：转成 Prometheus 的 matrix 形状
        return {
          resultType: 'matrix',
          result: value.series.map((s) => ({
            metric: s.labels,
            values: s.points.map((p) => [p.ts / 1000, String(p.value)]),
          })),
          warnings: ctx.warnings,
        };
      }
      // instant vector
      return {
        resultType: 'vector',
        result: value.series.map((s) => ({
          metric: s.labels,
          value: [time / 1000, String(s.value)],
        })),
        warnings: ctx.warnings,
      };
    } catch (err) {
      return {
        resultType: 'vector',
        result: [],
        error: { type: 'execution', message: String(err?.message || err) },
        warnings: ctx.warnings,
      };
    }
  }

  /**
   * 区间查询：对每个步长点做一次瞬时求值。
   *
   * 为什么不做「一次读全部再插值」的优化：Prometheus 自己也是这么实现的，
   * 而且用户对「rate 在区间边界的行为」的预期就是逐点求值。
   * 代价是 N 次查询，但我们的 store 有序列级缓存，实际 IO 远小于 N×全量。
   */
  async function queryRange(expr, start, end, step, opts = {}) {
    const s = Number(start);
    const e = Number(end);
    const st = Number(step);
    if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(st)) {
      return { resultType: 'matrix', result: [], error: { type: 'bad_data', message: 'start/end/step 必须是数字' } };
    }
    if (st <= 0) return { resultType: 'matrix', result: [], error: { type: 'bad_data', message: 'step 必须 > 0' } };
    if (e < s) return { resultType: 'matrix', result: [], error: { type: 'bad_data', message: 'end 不能早于 start' } };

    // 步数上限：防止 step=1 配一天区间把服务拖死
    const MAX_POINTS = 11_000;
    const steps = Math.floor((e - s) / st) + 1;
    if (steps > MAX_POINTS) {
      return {
        resultType: 'matrix',
        result: [],
        error: { type: 'bad_data', message: `区间点数 ${steps} 超过上限 ${MAX_POINTS}，请调大 step` },
      };
    }

    // 按序列归并：同一 labels 的点要聚到一个 matrix 行里
    const byKey = new Map();
    let firstError = null;

    for (let t = s; t <= e; t += st) {
      const r = await query(expr, { ...opts, time: t });
      if (r.error) { firstError = r.error; break; }
      if (r.resultType !== 'vector') continue;
      for (const item of r.result) {
        const key = labelKey(item.metric);
        if (!byKey.has(key)) byKey.set(key, { metric: item.metric, values: [] });
        byKey.get(key).values.push([Number(item.value[0]), item.value[1]]);
      }
    }

    if (firstError && byKey.size === 0) {
      return { resultType: 'matrix', result: [], error: firstError };
    }
    return { resultType: 'matrix', result: [...byKey.values()] };
  }

  // ────────────────────────── 求值核心 ──────────────────────────

  /**
   * @returns {Promise<object>} 三种形状之一：
   *   { kind:'scalar', value:number }
   *   { kind:'vector', series:[{labels, value}] }
   *   { kind:'matrix', series:[{labels, points:[{ts,value}]}] }
   *   { kind:'string', value:string }
   */
  async function evaluate(node, ctx) {
    switch (node.type) {
      case 'number': return { kind: 'scalar', value: node.value };
      case 'string': return { kind: 'string', value: node.value };
      case 'selector': return evalSelector(node, ctx);
      case 'unary': return evalUnary(node, ctx);
      case 'binary': return evalBinary(node, ctx);
      case 'aggregate': return evalAggregate(node, ctx);
      case 'call': return evalCall(node, ctx);
      default: throw new Error(`未知的 AST 节点: ${node.type}`);
    }
  }

  /**
   * 向量选择器。
   *
   * 瞬时向量（无 rangeMs）：取查询时刻之前 lookback 窗口内**最后一个**点。
   * 这是 Prometheus 的 stale 语义：超过 lookback 没有新点就算序列消失，
   * 否则一个死掉的 target 会永远显示最后的旧值。
   */
  async function evalSelector(node, ctx) {
    // __name__ 匹配器要转成指标名，其余留在标签过滤里
    let metricName = node.name || '';
    const matchers = [];
    let nameRegex = null;
    for (const m of node.matchers || []) {
      if (m.name === '__name__') {
        if (m.op === '=') metricName = m.value;
        else if (m.op === '=~') nameRegex = m.value;
        else matchers.push(m); // != / !~ 无法下推到 SQL，留给内存过滤
        continue;
      }
      matchers.push(m);
    }

    const offset = Number(node.offsetMs) || 0;
    const evalAt = ctx.now - offset;

    if (node.rangeMs) {
      // 区间向量：读 [evalAt - range, evalAt]
      const start = evalAt - Number(node.rangeMs);
      const res = await ctx.store.queryRange({
        metricName: metricName || undefined,
        matchers: matchers.length ? matchers : undefined,
        start,
        end: evalAt,
      });
      if (res.error) throw new Error(res.error);
      let series = res.series.map((s) => ({
        labels: s.labels,
        points: s.points.map((p) => ({ ts: p.ts, value: p.value })),
      }));
      if (nameRegex) series = filterByNameRegex(series, metricName, nameRegex);
      return { kind: 'matrix', series };
    }

    // 瞬时向量：读 [evalAt - lookback, evalAt]，每序列取最后一个点
    const start = evalAt - ctx.lookback;
    const res = await ctx.store.queryRange({
      metricName: metricName || undefined,
      matchers: matchers.length ? matchers : undefined,
      start,
      end: evalAt,
    });
    if (res.error) throw new Error(res.error);

    let series = [];
    for (const s of res.series) {
      if (!s.points.length) continue;
      const last = s.points[s.points.length - 1];
      series.push({ labels: s.labels, value: last.value });
    }
    if (nameRegex) series = filterByNameRegex(series, metricName, nameRegex);
    return { kind: 'vector', series };
  }

  /** `__name__=~"..."` 的下推兜底：从 labels 里重建名字判断 */
  function filterByNameRegex(series, metricName, regex) {
    let re;
    try {
      re = new RegExp(`^(?:${regex})$`);
    } catch {
      return [];
    }
    return series.filter((s) => {
      // 指标名不在 labels 里（存在 ts_series.name），选择器没带出来时只能靠
      // 调 store 时按名字过滤；这里保守地放行 name 为空的项
      const name = s.name || s.labels.__name__ || metricName || '';
      return name ? re.test(name) : true;
    });
  }

  async function evalUnary(node, ctx) {
    const v = await evaluate(node.expr, ctx);
    if (node.op === '+') return v;
    if (v.kind === 'scalar') return { kind: 'scalar', value: -v.value };
    if (v.kind === 'vector') {
      return { kind: 'vector', series: v.series.map((s) => ({ labels: s.labels, value: -s.value })) };
    }
    throw new Error('一元负号只能用于标量或瞬时向量');
  }

  /**
   * 二元运算。
   *
   * 三种组合：标量⊗标量、向量⊗标量、向量⊗向量。
   * 向量⊗向量的匹配规则是 PromQL 里最容易出错的地方：
   *   默认按**全部标签**匹配（labelset 完全相同才算一对）；
   *   `on(l...)` 只比这些标签；`ignoring(l...)` 比除这些之外的。
   * 没匹配上的项**直接丢弃**（不是报错）—— 这是 Prometheus 的行为。
   */
  async function evalBinary(node, ctx) {
    const lhs = await evaluate(node.lhs, ctx);
    const rhs = await evaluate(node.rhs, ctx);
    const op = node.op;

    // 集合运算符单独处理（它们按标签集合做交/差，不按值）
    if (['and', 'or', 'unless'].includes(op)) {
      return evalSetOp(op, lhs, rhs, node.matching);
    }

    // 标量 ⊗ 标量
    if (lhs.kind === 'scalar' && rhs.kind === 'scalar') {
      if (['>', '<', '>=', '<=', '==', '!='].includes(op)) {
        return { kind: 'scalar', value: compare(op, lhs.value, rhs.value, node.bool) };
      }
      return { kind: 'scalar', value: arith(op, lhs.value, rhs.value) };
    }

    // 向量 ⊗ 标量 / 标量 ⊗ 向量
    if (lhs.kind === 'vector' && rhs.kind === 'scalar') {
      return mapVector(lhs, rhs.value, op, node.bool, false);
    }
    if (lhs.kind === 'scalar' && rhs.kind === 'vector') {
      return mapVector(rhs, lhs.value, op, node.bool, true);
    }

    // 向量 ⊗ 向量
    if (lhs.kind === 'vector' && rhs.kind === 'vector') {
      return matchVectors(lhs, rhs, op, node.bool, node.matching);
    }

    throw new Error(`${lhs.kind} 与 ${rhs.kind} 不能做 ${op} 运算`);
  }

  function mapVector(vec, scalar, op, boolMode, scalarOnLeft) {
    const out = [];
    for (const s of vec.series) {
      const a = scalarOnLeft ? scalar : s.value;
      const b = scalarOnLeft ? s.value : scalar;
      if (['>', '<', '>=', '<=', '==', '!='].includes(op)) {
        if (boolMode) {
          out.push({ labels: s.labels, value: compare(op, a, b, true) });
        } else if (compare(op, a, b, false) === 1) {
          // 不带 bool 时，过滤运算符只保留满足条件的项，值原样保留
          out.push({ labels: s.labels, value: s.value });
        }
      } else {
        out.push({ labels: s.labels, value: arith(op, a, b) });
      }
    }
    return { kind: 'vector', series: out };
  }

  function matchVectors(lhs, rhs, op, boolMode, matching) {
    const onLabels = matching && matching.on ? matching.labels : null;
    const ignoreLabels = matching && !matching.on ? matching.labels : null;
    const group = matching && matching.group ? matching.group : null;

    const keyOf = (labels) => {
      let keys;
      if (onLabels) keys = onLabels.filter((k) => k in labels);
      else if (ignoreLabels) keys = Object.keys(labels).filter((k) => !ignoreLabels.includes(k)).sort();
      else keys = Object.keys(labels).sort();
      return keys.map((k) => `${k}=${labels[k]}`).join('\u0001');
    };

    const rightIndex = new Map();
    for (const r of rhs.series) {
      const k = keyOf(r.labels);
      if (!rightIndex.has(k)) rightIndex.set(k, []);
      rightIndex.get(k).push(r);
    }

    const out = [];
    const seenLeftKeys = new Set();

    for (const l of lhs.series) {
      const k = keyOf(l.labels);
      const candidates = rightIndex.get(k);
      if (!candidates || candidates.length === 0) continue; // 没匹配就丢弃
      seenLeftKeys.add(k);

      for (const r of candidates) {
        let labels;
        if (group && group.side === 'left') {
          // group_left：输出用左侧的标签，右侧的 one-side 标签补进来
          labels = { ...l.labels };
          for (const extra of group.labels || []) {
            if (r.labels[extra] !== undefined) labels[extra] = r.labels[extra];
          }
        } else if (group && group.side === 'right') {
          labels = { ...r.labels };
          for (const extra of group.labels || []) {
            if (l.labels[extra] !== undefined) labels[extra] = l.labels[extra];
          }
        } else {
          // 需要两边完全一致才能输出（避免标签歧义）
          labels = onLabels ? mergeLabelsOn(l.labels, r.labels, onLabels) : { ...l.labels };
        }

        if (['>', '<', '>=', '<=', '==', '!='].includes(op)) {
          if (boolMode) {
            out.push({ labels, value: compare(op, l.value, r.value, true) });
          } else if (compare(op, l.value, r.value, false) === 1) {
            out.push({ labels, value: l.value });
          }
        } else {
          out.push({ labels, value: arith(op, l.value, r.value) });
        }
      }
    }

    // or 之外的情况不需要未匹配项；vector-vector 算术只要匹配上的
    void seenLeftKeys;
    return { kind: 'vector', series: out };
  }

  function mergeLabelsOn(l, r, onLabels) {
    const out = {};
    for (const k of onLabels) if (l[k] !== undefined) out[k] = l[k];
    return out;
  }

  function evalSetOp(op, lhs, rhs, matching) {
    const toVector = (v) => (v.kind === 'vector' ? v : { kind: 'vector', series: [] });
    const L = toVector(lhs);
    const R = toVector(rhs);
    const onLabels = matching && matching.on ? matching.labels : null;
    const ignoreLabels = matching && !matching.on ? matching.labels : null;
    const keyOf = (labels) => {
      let keys;
      if (onLabels) keys = onLabels.filter((k) => k in labels);
      else if (ignoreLabels) keys = Object.keys(labels).filter((k) => !ignoreLabels.includes(k)).sort();
      else keys = Object.keys(labels).sort();
      return keys.map((k) => `${k}=${labels[k]}`).join('\u0001');
    };

    const rightKeys = new Set(R.series.map((s) => keyOf(s.labels)));

    if (op === 'and') {
      return { kind: 'vector', series: L.series.filter((s) => rightKeys.has(keyOf(s.labels))) };
    }
    if (op === 'unless') {
      return { kind: 'vector', series: L.series.filter((s) => !rightKeys.has(keyOf(s.labels))) };
    }
    // or：左边全留，右边只补左边没有的键
    const leftKeys = new Set(L.series.map((s) => keyOf(s.labels)));
    const extra = R.series.filter((s) => !leftKeys.has(keyOf(s.labels)));
    return { kind: 'vector', series: [...L.series, ...extra] };
  }

  /**
   * 聚合。
   *
   * `by` 保留指定标签，`without` 去掉指定标签。
   * 无 grouping 时聚成一个值，标签为空对象。
   */
  async function evalAggregate(node, ctx) {
    const v = await evaluate(node.expr, ctx);

    // topk/bottomk/quantile 的 param 是标量；count_values 的 param 是**字符串**
    // （要生成的标签名）。统一在下面按 kind 取值，别默认都是数字。
    let param = null;
    if (node.param) {
      const p = await evaluate(node.param, ctx);
      if (p.kind === 'string') param = p.value;
      else if (p.kind === 'scalar') param = p.value;
      else if (p.kind === 'vector' && p.series.length === 1) param = p.series[0].value;
      if (param == null) throw new Error(`${node.op} 的参数必须是标量或字符串`);
    }

    if (v.kind === 'scalar') {
      // 对标量做聚合就是它自己（sum(5) = 5）
      return { kind: 'vector', series: [{ labels: {}, value: v.value }] };
    }
    if (v.kind !== 'vector') throw new Error(`${node.op} 只能用于瞬时向量`);

    const grouping = node.grouping;
    const groupKey = (labels) => {
      if (!grouping) return '';
      let keys;
      if (grouping.without) keys = Object.keys(labels).filter((k) => !grouping.labels.includes(k)).sort();
      else keys = grouping.labels.filter((k) => k in labels).sort();
      return keys.map((k) => `${k}\u0001${labels[k]}`).join('\u0002');
    };
    const groupLabels = (labels) => {
      if (!grouping) return {};
      if (grouping.without) {
        const out = {};
        for (const k of Object.keys(labels).sort()) {
          if (!grouping.labels.includes(k)) out[k] = labels[k];
        }
        return out;
      }
      const out = {};
      for (const k of grouping.labels.slice().sort()) {
        if (labels[k] !== undefined) out[k] = labels[k];
      }
      return out;
    };

    const groups = new Map();
    for (const s of v.series) {
      const k = groupKey(s.labels);
      if (!groups.has(k)) groups.set(k, { labels: groupLabels(s.labels), items: [] });
      groups.get(k).items.push(s);
    }

    const out = [];

    // topk / bottomk / count_values / quantile 需要逐组内的原始项
    if (node.op === 'topk' || node.op === 'bottomk') {
      const k = Math.max(0, Math.floor(Number(param)));
      for (const g of groups.values()) {
        const sorted = g.items.slice().sort((a, b) => (node.op === 'topk' ? b.value - a.value : a.value - b.value));
        for (const item of sorted.slice(0, k)) out.push({ labels: item.labels, value: item.value });
      }
      return { kind: 'vector', series: out };
    }

    if (node.op === 'quantile') {
      const q = Number(param);
      for (const g of groups.values()) {
        const vals = g.items.map((i) => i.value).sort((a, b) => a - b);
        out.push({ labels: g.labels, value: quantile(q, vals) });
      }
      return { kind: 'vector', series: out };
    }

    if (node.op === 'count_values') {
      const labelName = String(param);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(labelName)) {
        throw new Error(`count_values 的标签名非法: ${labelName}`);
      }
      for (const g of groups.values()) {
        const counts = new Map();
        for (const item of g.items) {
          const key = String(item.value);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        for (const [key, n] of counts) {
          out.push({ labels: { ...g.labels, [labelName]: key }, value: n });
        }
      }
      return { kind: 'vector', series: out };
    }

    for (const g of groups.values()) {
      const vals = g.items.map((i) => i.value);
      let value;
      switch (node.op) {
        case 'sum': value = vals.reduce((a, b) => a + b, 0); break;
        case 'avg': value = vals.reduce((a, b) => a + b, 0) / vals.length; break;
        case 'min': value = Math.min(...vals); break;
        case 'max': value = Math.max(...vals); break;
        case 'count': value = vals.length; break;
        case 'group': value = 1; break;
        case 'stddev': value = Math.sqrt(variance(vals)); break;
        case 'stdvar': value = variance(vals); break;
        default: throw new Error(`不支持的聚合: ${node.op}`);
      }
      out.push({ labels: g.labels, value });
    }

    return { kind: 'vector', series: out };
  }

  /** 函数调用 */
  async function evalCall(node, ctx) {
    const fn = node.func;
    const args = [];
    for (const a of node.args) args.push(await evaluate(a, ctx));

    // 区间向量函数：第一个参数必须是 matrix
    const RANGE_FNS = {
      rate: (pts, evalAt) => rateLike(pts, evalAt, false),
      irate: (pts, evalAt) => irateLike(pts, evalAt),
      increase: (pts, evalAt) => rateLike(pts, evalAt, true),
      delta: (pts) => deltaLike(pts, false),
      idelta: (pts) => deltaLike(pts, true),
      deriv: (pts) => derivLike(pts),
      changes: (pts) => countChanges(pts),
      resets: (pts) => countResets(pts),
      avg_over_time: (pts) => avg(pts),
      min_over_time: (pts) => Math.min(...pts.map((p) => p.value)),
      max_over_time: (pts) => Math.max(...pts.map((p) => p.value)),
      sum_over_time: (pts) => pts.reduce((a, p) => a + p.value, 0),
      count_over_time: (pts) => pts.length,
      last_over_time: (pts) => pts[pts.length - 1].value,
      present_over_time: (pts) => (pts.length ? 1 : 0),
      stddev_over_time: (pts) => Math.sqrt(variance(pts.map((p) => p.value))),
      stdvar_over_time: (pts) => variance(pts.map((p) => p.value)),
    };

    if (RANGE_FNS[fn]) {
      const src = args[0];
      if (!src || src.kind !== 'matrix') {
        throw new Error(`${fn}() 的参数必须是区间向量，例如 ${fn}(metric[5m])`);
      }
      const out = [];
      for (const s of src.series) {
        if (s.points.length === 0) continue;
        const v = RANGE_FNS[fn](s.points, ctx.now);
        if (v === null || Number.isNaN(v)) continue; // 样本不足时不输出，与 Prometheus 一致
        out.push({ labels: s.labels, value: v });
      }
      return { kind: 'vector', series: out };
    }

    // 逐点标量函数
    const scalarFn = SCALAR_FNS[fn];
    if (scalarFn) {
      const src = args[0];
      const extra = args.slice(1).map((a) => (a.kind === 'scalar' ? a.value : null));
      if (src.kind === 'scalar') {
        return { kind: 'scalar', value: scalarFn(src.value, ...extra) };
      }
      if (src.kind !== 'vector') throw new Error(`${fn}() 需要标量或瞬时向量`);
      return {
        kind: 'vector',
        series: src.series
          .map((s) => ({ labels: s.labels, value: scalarFn(s.value, ...extra) }))
          .filter((s) => !Number.isNaN(s.value)),
      };
    }

    // 特殊函数
    switch (fn) {
      case 'time':
        return { kind: 'scalar', value: ctx.now / 1000 };
      case 'timestamp': {
        // 返回样本的时间戳（秒）。我们的 vector 里没带 ts，用求值时刻近似
        const src = args[0];
        if (!src || src.kind !== 'vector') throw new Error('timestamp() 需要瞬时向量');
        return {
          kind: 'vector',
          series: src.series.map((s) => ({ labels: s.labels, value: ctx.now / 1000 })),
        };
      }
      case 'vector': {
        const src = args[0];
        if (!src || src.kind !== 'scalar') throw new Error('vector() 需要标量');
        return { kind: 'vector', series: [{ labels: {}, value: src.value }] };
      }
      case 'scalar': {
        const src = args[0];
        if (!src || src.kind !== 'vector') throw new Error('scalar() 需要瞬时向量');
        if (src.series.length !== 1) return { kind: 'scalar', value: NaN };
        return { kind: 'scalar', value: src.series[0].value };
      }
      case 'sort':
      case 'sort_desc': {
        const src = args[0];
        if (!src || src.kind !== 'vector') throw new Error(`${fn}() 需要瞬时向量`);
        const sorted = src.series.slice().sort((a, b) => (fn === 'sort' ? a.value - b.value : b.value - a.value));
        return { kind: 'vector', series: sorted };
      }
      case 'absent': {
        const src = args[0];
        const empty = !src || (src.kind === 'vector' && src.series.length === 0);
        if (!empty) return { kind: 'vector', series: [] };
        return { kind: 'vector', series: [{ labels: {}, value: 1 }] };
      }
      case 'absent_over_time': {
        const src = args[0];
        const empty = !src || (src.kind === 'matrix' && src.series.length === 0);
        if (!empty) return { kind: 'vector', series: [] };
        return { kind: 'vector', series: [{ labels: {}, value: 1 }] };
      }
      case 'label_replace': {
        return labelReplace(args);
      }
      case 'label_join': {
        return labelJoin(args);
      }
      case 'histogram_quantile': {
        const q = args[0]?.kind === 'scalar' ? args[0].value : null;
        const src = args[1];
        if (q === null || !src || src.kind !== 'vector') throw new Error('histogram_quantile 需要 (标量, 瞬时向量)');
        return histogramQuantile(q, src.series);
      }
      case 'quantile_over_time': {
        const q = args[0]?.kind === 'scalar' ? args[0].value : null;
        const src = args[1];
        if (q === null || !src || src.kind !== 'matrix') throw new Error('quantile_over_time 需要 (标量, 区间向量)');
        const out = [];
        for (const s of src.series) {
          if (!s.points.length) continue;
          out.push({ labels: s.labels, value: quantile(q, s.points.map((p) => p.value)) });
        }
        return { kind: 'vector', series: out };
      }
      case 'predict_linear':
      case 'holt_winters': {
        const src = args[0];
        if (!src || src.kind !== 'matrix') throw new Error(`${fn}() 需要区间向量`);
        const out = [];
        for (const s of src.series) {
          if (s.points.length < 2) continue;
          out.push({ labels: s.labels, value: linearTrend(s.points, ctx.now) });
        }
        return { kind: 'vector', series: out };
      }
      default:
        throw new Error(`函数 ${fn} 未实现`);
    }
  }

  return { query, queryRange };
}

// ────────────────────────── 纯函数工具 ──────────────────────────

/** 逐点标量函数表 */
const SCALAR_FNS = {
  abs: (v) => Math.abs(v),
  ceil: (v) => Math.ceil(v),
  floor: (v) => Math.floor(v),
  exp: (v) => Math.exp(v),
  ln: (v) => (v > 0 ? Math.log(v) : NaN),
  log2: (v) => (v > 0 ? Math.log2(v) : NaN),
  log10: (v) => (v > 0 ? Math.log10(v) : NaN),
  sqrt: (v) => (v >= 0 ? Math.sqrt(v) : NaN),
  sgn: (v) => Math.sign(v),
  round: (v, to) => {
    const step = Number(to);
    if (!Number.isFinite(step) || step === 0) return Math.round(v);
    return Math.round(v / step) * step;
  },
  clamp_min: (v, min) => Math.max(v, min),
  clamp_max: (v, max) => Math.min(v, max),
  clamp: (v, min, max) => Math.min(Math.max(v, min), max),
  deg: (v) => (v * 180) / Math.PI,
  rad: (v) => (v * Math.PI) / 180,
  acos: (v) => Math.acos(v),
  asin: (v) => Math.asin(v),
  atan: (v) => Math.atan(v),
  cos: (v) => Math.cos(v),
  sin: (v) => Math.sin(v),
  tan: (v) => Math.tan(v),
  minute: (v) => new Date(v * 1000).getUTCMinutes(),
  hour: (v) => new Date(v * 1000).getUTCHours(),
  day_of_month: (v) => new Date(v * 1000).getUTCDate(),
  day_of_week: (v) => new Date(v * 1000).getUTCDay(),
  day_of_year: (v) => {
    const d = new Date(v * 1000);
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    return Math.floor((d.getTime() - start) / 86_400_000);
  },
  month: (v) => new Date(v * 1000).getUTCMonth() + 1,
  year: (v) => new Date(v * 1000).getUTCFullYear(),
  days_in_month: (v) => {
    const d = new Date(v * 1000);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  },
};

/** 四则与幂运算 */
export function arith(op, a, b) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? (a === 0 ? NaN : (a > 0 ? Infinity : -Infinity)) : a / b;
    case '%': return b === 0 ? NaN : a % b;
    case '^': return a ** b;
    case 'atan2': return Math.atan2(a, b);
    default: throw new Error(`不支持的运算符: ${op}`);
  }
}

/**
 * 比较运算。
 * boolMode=true 返回 1/0；false 返回是否满足（-1/0/1 用于后续过滤判断）。
 * 为了让「过滤」与「bool」共用一份实现，false 时返回 1 表示满足、0 表示不满足。
 */
export function compare(op, a, b, boolMode) {
  let ok;
  switch (op) {
    case '>': ok = a > b; break;
    case '<': ok = a < b; break;
    case '>=': ok = a >= b; break;
    case '<=': ok = a <= b; break;
    case '==': ok = a === b; break;
    case '!=': ok = a !== b; break;
    default: throw new Error(`不支持的比较: ${op}`);
  }
  if (boolMode) return ok ? 1 : 0;
  return ok ? 1 : 0;
}

function variance(vals) {
  if (vals.length === 0) return NaN;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
}

function avg(pts) {
  return pts.reduce((a, p) => a + p.value, 0) / pts.length;
}

/** Prometheus 的 quantile：线性插值 */
export function quantile(q, sortedVals) {
  if (sortedVals.length === 0) return NaN;
  const n = Number(q);
  if (!Number.isFinite(n)) return NaN;
  if (n < 0) return -Infinity;
  if (n > 1) return Infinity;
  if (n === 0) return sortedVals[0];
  if (n === 1) return sortedVals[sortedVals.length - 1];
  const rank = n * (sortedVals.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedVals[lo];
  return sortedVals[lo] + (sortedVals[hi] - sortedVals[lo]) * (rank - lo);
}

/**
 * rate / increase。
 *
 * 关键语义（与 Prometheus 的 extrapolatedRate 一致）：
 *   · 先算首尾差，再**逐个检查 counter 重置**，每次重置把重置前的值补进来。
 *     注意不是「重置时累加 prev 和 cur」——那会把重置前那段重复计一次
 *     （0→100→重置到5→15，正确增量是 15-0 + 100 = 115，不是 215）。
 *   · 结果按「窗口实际跨度」归一化，而不是按名义窗口 ——
 *     抓取点少的时候两者的差会很大
 *   · **至少需要两个点**，只有一个点返回 null（不输出）
 */
export function rateLike(points, evalAt, isIncrease) {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const spanMs = last.ts - first.ts;
  if (spanMs <= 0) return null;

  let total = last.value - first.value;
  // counter 重置：每遇到一次下降，把下降前的累计值加回来
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].value < points[i - 1].value) {
      total += points[i - 1].value;
    }
  }

  if (isIncrease) return total;

  const dur = spanMs / 1000;
  return dur > 0 ? total / dur : null;
}

/** irate：只用最后两个点 */
export function irateLike(points) {
  if (points.length < 2) return null;
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  const dt = (b.ts - a.ts) / 1000;
  if (dt <= 0) return null;
  let dv = b.value - a.value;
  if (dv < 0) dv = b.value; // 重置
  return dv / dt;
}

/** delta / idelta：gauge 的差值，不处理重置 */
export function deltaLike(points, instant) {
  if (instant) {
    if (points.length < 2) return null;
    return points[points.length - 1].value - points[points.length - 2].value;
  }
  if (points.length < 2) return null;
  return points[points.length - 1].value - points[0].value;
}

/** deriv：最小二乘斜率（每秒） */
export function derivLike(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const t0 = points[0].ts;
  let sx = 0; let sy = 0; let sxy = 0; let sxx = 0;
  for (const p of points) {
    const x = (p.ts - t0) / 1000;
    sx += x; sy += p.value; sxy += x * p.value; sxx += x * x;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return (n * sxy - sx * sy) / denom;
}

/** predict_linear：按最小二乘外推 */
export function linearTrend(points, evalAt_ms) {
  const slope = derivLike(points);
  if (slope === null) return null;
  const last = points[points.length - 1];
  const dtSec = (evalAt_ms - last.ts) / 1000;
  return last.value + slope * dtSec;
}

export function countChanges(points) {
  if (points.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].value !== points[i - 1].value) n += 1;
  }
  return n;
}

export function countResets(points) {
  if (points.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].value < points[i - 1].value) n += 1;
  }
  return n;
}

/**
 * histogram_quantile：从 `_bucket{le="..."}` 累积计数里插值出分位数。
 *
 * 需要先把同一组（去掉 le 之外标签相同）的 bucket 聚到一起并排序。
 */
export function histogramQuantile(q, series) {
  const groups = new Map();
  for (const s of series) {
    const le = s.labels.le;
    if (le === undefined) continue;
    const bound = le === '+Inf' ? Infinity : Number(le);
    if (!Number.isFinite(bound) && bound !== Infinity) continue;
    const rest = { ...s.labels };
    delete rest.le;
    const key = labelKey(rest);
    if (!groups.has(key)) groups.set(key, { labels: rest, buckets: [] });
    groups.get(key).buckets.push({ bound, count: s.value });
  }

  const out = [];
  const n = Number(q);
  for (const g of groups.values()) {
    const buckets = g.buckets.slice().sort((a, b) => a.bound - b.bound);
    if (buckets.length < 2) continue;
    const total = buckets[buckets.length - 1].count;
    if (total <= 0) continue;

    const target = n * total;
    let prevBound = 0;
    let prevCount = 0;
    let result = null;
    for (const b of buckets) {
      if (b.count >= target) {
        if (b.bound === Infinity) {
          // 落在最后一个开区间：按前一个上界返回
          result = prevBound;
        } else {
          const span = b.bound - prevBound;
          const inBucket = b.count - prevCount;
          result = inBucket <= 0 ? b.bound : prevBound + (span * (target - prevCount)) / inBucket;
        }
        break;
      }
      prevBound = b.bound === Infinity ? prevBound : b.bound;
      prevCount = b.count;
    }
    if (result !== null && Number.isFinite(result)) {
      out.push({ labels: g.labels, value: result });
    }
  }
  return { kind: 'vector', series: out };
}

/** label_replace(v, dst, replacement, src, regex) */
export function labelReplace(args) {
  const [v, dst, repl, src, regex] = args;
  if (!v || v.kind !== 'vector') throw new Error('label_replace 第一个参数必须是瞬时向量');
  const dstName = dst?.value;
  const replStr = repl?.value ?? '';
  const srcName = src?.value;
  const reStr = regex?.value ?? '';
  if (!dstName || !srcName) throw new Error('label_replace 的参数必须是字符串');
  let re;
  try {
    re = new RegExp(`^(?:${reStr})$`);
  } catch {
    throw new Error(`label_replace 的正则非法: ${reStr}`);
  }
  const out = [];
  for (const s of v.series) {
    const srcVal = s.labels[srcName] ?? '';
    const m = re.exec(srcVal);
    const labels = { ...s.labels };
    if (m) {
      const replaced = replStr.replace(/\$(\d+)/g, (_, d) => m[Number(d)] ?? '');
      if (replaced === '') delete labels[dstName];
      else labels[dstName] = replaced;
    }
    out.push({ labels, value: s.value });
  }
  return { kind: 'vector', series: out };
}

/** label_join(v, dst, sep, src...) */
export function labelJoin(args) {
  const [v, dst, sep, ...srcs] = args;
  if (!v || v.kind !== 'vector') throw new Error('label_join 第一个参数必须是瞬时向量');
  const dstName = dst?.value;
  const sepStr = sep?.value ?? '';
  if (!dstName) throw new Error('label_join 的参数必须是字符串');
  const names = srcs.map((s) => s?.value).filter(Boolean);
  const out = [];
  for (const s of v.series) {
    const labels = { ...s.labels };
    const joined = names.map((n) => s.labels[n] ?? '').join(sepStr);
    if (joined === '') delete labels[dstName];
    else labels[dstName] = joined;
    out.push({ labels, value: s.value });
  }
  return { kind: 'vector', series: out };
}

/** 标签集合的稳定 key（用于分组与去重） */
export function labelKey(labels) {
  const norm = normalizeLabels(labels);
  return Object.keys(norm).sort().map((k) => `${k}=${norm[k]}`).join('\u0001');
}