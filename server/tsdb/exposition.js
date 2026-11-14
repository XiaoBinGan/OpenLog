/**
 * Prometheus 文本暴露格式（exposition format）—— 解析与生成。
 *
 * 这是 Prometheus 生态的事实标准：任何 `/metrics` 端点都吐这个格式，
 * Prometheus server 抓它、Grafana 展示它、无数 exporter 实现它。
 * OpenLog 要「能融入」而不是「只能替代」，必须先把这一层做对。
 *
 * 格式规范（0.0.4）：
 *   # HELP <name> <说明>
 *   # TYPE <name> counter|gauge|histogram|summary|untyped
 *   <name>{<label>="<value>",...} <value> [<timestamp_ms>]
 *   <name>_bucket{le="0.5"} <count>        ← histogram
 *   <name>_sum <value> / <name>_count <n>
 *   <name>{quantile="0.99"} <value>        ← summary
 *
 * 设计取舍：
 *   · 解析器是**纯函数**，输入文本输出样本数组，不做任何 IO —— 好测。
 *   · 遇到坏行**跳过并记录**而不是整体失败。真实世界的 /metrics 里
 *     偶尔有不合规的实现，一行坏掉不该让整台机器的数据全丢。
 *   · 不做「指标名合法性」的强校验（只在生成侧保证），因为有些 exporter
 *     会导出 `foo.bar` 这种非标准名，丢掉它等于丢掉数据。
 */

/** 允许的 TYPE 取值 */
export const METRIC_TYPES = ['counter', 'gauge', 'histogram', 'summary', 'untyped'];

// 标签值转义与 labels.js 共用一份实现：两边不一致会让生成的文本解析回来变形
import { escapeLabelValue } from './labels.js';

const TYPE_SET = new Set(METRIC_TYPES);

/**
 * 解析 Prometheus 文本格式。
 *
 * @param {string} text 原始文本
 * @returns {{ samples: Array<{name:string, labels:Object, value:number, timestamp:number|null, type:string, help:string}>,
 *             errors: Array<{line:number, text:string, reason:string}>,
 *             help: Object, types: Object }}
 */
export function parseExposition(text) {
  const samples = [];
  const errors = [];
  const help = {};
  const types = {};

  if (typeof text !== 'string' || text.length === 0) {
    return { samples, errors, help, types };
  }

  // 当前 # HELP / # TYPE 作用的指标名。
  // 为什么需要：样本行本身不带类型，必须从上面的元数据行继承。
  let curType = 'untyped';
  let curHelp = '';

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '') continue;

    // ── 元数据行 ──
    if (line.startsWith('#')) {
      const meta = line.slice(1).trim();
      if (meta.startsWith('HELP ')) {
        const rest = meta.slice(5);
        const sp = rest.indexOf(' ');
        const name = sp < 0 ? rest : rest.slice(0, sp);
        const doc = sp < 0 ? '' : rest.slice(sp + 1);
        if (name) {
          help[name] = unescapeHelp(doc);
          curHelp = help[name];
        }
        continue;
      }
      if (meta.startsWith('TYPE ')) {
        const rest = meta.slice(5).trim();
        const sp = rest.indexOf(' ');
        const name = sp < 0 ? rest : rest.slice(0, sp);
        const type = sp < 0 ? '' : rest.slice(sp + 1).trim();
        if (name && TYPE_SET.has(type)) {
          types[name] = type;
          curType = type;
        } else if (name) {
          // 未知 TYPE 不致命：按 untyped 处理，保留数据
          types[name] = 'untyped';
          curType = 'untyped';
          errors.push({ line: i + 1, text: line.slice(0, 120), reason: `未知 TYPE: ${type}` });
        }
        continue;
      }
      // 其它 `#` 开头（含 EOF）忽略
      continue;
    }

    // ── 样本行 ──
    const parsed = parseSampleLine(line);
    if (!parsed) {
      errors.push({ line: i + 1, text: line.slice(0, 120), reason: '无法解析的样本行' });
      // 坏行不重置 curType：Prometheus 的实际行为是继续沿用上一个 TYPE
      continue;
    }

    // 样本行的指标名可能带 _bucket/_sum/_count 后缀（histogram）或裸名（summary 的 quantile）
    const baseName = baseMetricName(parsed.name);
    const type = types[baseName] || curType || 'untyped';
    const doc = help[baseName] || curHelp || '';

    samples.push({
      name: parsed.name,
      labels: parsed.labels,
      value: parsed.value,
      timestamp: parsed.timestamp,
      type,
      help: doc,
    });
  }

  return { samples, errors, help, types };
}

/**
 * histogram 的子样本名要还原到基名，才能查回它的 TYPE。
 * `http_request_duration_seconds_bucket` → `http_request_duration_seconds`
 */
function baseMetricName(name) {
  for (const suffix of ['_bucket', '_sum', '_count', '_total']) {
    if (name.length > suffix.length && name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/**
 * 解析单行样本：`name{k="v",k2="v2"} 12.5 1700000000000`
 *
 * 手写而不是正则一把梭：标签值里可以出现 `}`、`,`、`"` 的转义形式，
 * 正则很难正确处理转义。逐字符扫描更可靠。
 *
 * @returns {{name:string, labels:Object<string,string>, value:number, timestamp:number|null}|null}
 */
export function parseSampleLine(line) {
  let i = 0;
  const n = line.length;

  // 1) 指标名（允许 . - 等非标准字符，宽容接受）
  while (i < n && !/[\s{]/.test(line[i])) i += 1;
  const name = line.slice(0, i);
  if (!name) return null;
  // 形如 `# something` 或纯空白
  if (/[#]/.test(name)) return null;

  const labels = {};

  // 2) 标签块（可选）
  if (line[i] === '{') {
    i += 1;
    const readLabelSet = () => {
      while (i < n) {
        // 跳过空白与逗号
        while (i < n && /[\s,]/.test(line[i])) i += 1;
        if (i >= n) return false;
        if (line[i] === '}') { i += 1; return true; }

        // 标签名
        const nameStart = i;
        while (i < n && line[i] !== '=' && line[i] !== '}' && !/\s/.test(line[i])) i += 1;
        const lname = line.slice(nameStart, i);
        while (i < n && /\s/.test(line[i])) i += 1;
        if (line[i] !== '=') {
          // 无等号的项：可能是 `{a,b}` 这种老式写法，跳过到下一个逗号
          while (i < n && line[i] !== ',' && line[i] !== '}') i += 1;
          continue;
        }
        i += 1; // '='
        while (i < n && /\s/.test(line[i])) i += 1;
        if (line[i] !== '"') {
          // 未加引号的值：宽容读到逗号或右括号
          const vs = i;
          while (i < n && line[i] !== ',' && line[i] !== '}') i += 1;
          if (lname) labels[lname] = line.slice(vs, i).trim();
          continue;
        }
        i += 1; // 开引号
        let val = '';
        while (i < n && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < n) {
            const esc = line[i + 1];
            if (esc === 'n') val += '\n';
            else if (esc === 't') val += '\t';
            else if (esc === '\\') val += '\\';
            else if (esc === '"') val += '"';
            else val += `\\${esc}`;
            i += 2;
            continue;
          }
          val += line[i];
          i += 1;
        }
        i += 1; // 闭引号
        if (lname) labels[lname] = val;
      }
      return false;
    };
    if (!readLabelSet()) {
      // 标签块没闭合
      return null;
    }
  }

  // 3) 数值与可选时间戳
  while (i < n && /\s/.test(line[i])) i += 1;
  const rest = line.slice(i).trim();
  if (!rest) return null;

  const parts = rest.split(/\s+/);
  const value = parseSampleValue(parts[0]);
  if (value === null) return null;

  let timestamp = null;
  if (parts.length > 1) {
    const ts = Number(parts[1]);
    if (Number.isFinite(ts)) timestamp = ts;
  }

  return { name, labels, value, timestamp };
}

/**
 * 解析样本值。规范要求的特殊值：
 *   NaN / +Inf / -Inf —— 必须认，否则算出来的除法结果会被当坏行丢掉。
 */
export function parseSampleValue(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (s === 'NaN') return NaN;
  if (s === '+Inf' || s === 'Inf' || s === '+inf') return Infinity;
  if (s === '-Inf' || s === '-inf') return -Infinity;
  const n = Number(s);
  return Number.isFinite(n) ? n : (Number.isNaN(n) ? null : n);
}

function unescapeHelp(s) {
  return String(s).replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
}

/**
 * 生成 Prometheus 文本格式。
 *
 * @param {Array<{name:string, labels?:Object, value:number, timestamp?:number|null,
 *                type?:string, help?:string}>} samples
 * @param {{ includeHelp?: boolean, includeType?: boolean }} [opts]
 * @returns {string}
 */
export function formatExposition(samples, opts = {}) {
  const includeHelp = opts.includeHelp !== false;
  const includeType = opts.includeType !== false;
  const list = Array.isArray(samples) ? samples : [];

  // 按指标名分组：HELP / TYPE 每个指标只输出一次，且要在它的样本之前
  const groups = new Map();
  for (const s of list) {
    if (!s || !s.name) continue;
    const base = baseMetricName(s.name);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(s);
  }

  const out = [];
  for (const [base, group] of groups) {
    const first = group[0];
    if (includeHelp && first.help) {
      out.push(`# HELP ${base} ${escapeHelp(first.help)}`);
    }
    if (includeType) {
      const type = TYPE_SET.has(first.type) ? first.type : 'untyped';
      out.push(`# TYPE ${base} ${type}`);
    }
    for (const s of group) {
      out.push(formatSample(s));
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

function escapeHelp(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** 单条样本渲染。数值必须按 Prometheus 的写法处理 NaN / Inf */
export function formatSample(sample) {
  const { name, labels, value, timestamp } = sample;
  let labelStr = '';
  const keys = Object.keys(labels || {}).sort();
  if (keys.length) {
    const parts = keys
      .filter((k) => labels[k] !== null && labels[k] !== undefined && labels[k] !== '')
      .map((k) => `${k}="${escapeLabelValue(labels[k])}"`);
    if (parts.length) labelStr = `{${parts.join(',')}}`;
  }
  const v = formatValue(value);
  const ts = Number.isFinite(timestamp) ? ` ${timestamp}` : '';
  return `${name}${labelStr} ${v}${ts}`;
}

/** 数值渲染：与 Prometheus 一致，NaN / +Inf / -Inf 用文本形式 */
export function formatValue(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(n);
}