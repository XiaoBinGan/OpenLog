/**
 * HAMi 指标抓取层（A1）
 *
 * 职责：把 hami-scheduler 暴露的 **Prometheus 文本格式** 解析成结构化数据，
 * 并从中抽出 GPU 使用率/显存三条关键序列，供 `/api/k8s/clusters/:id/usage`（A2）使用。
 *
 * 数据链路：
 *   kubeconfig → client.getJson（找 Pod）→ Pod.status.podIP:31993/metrics（node:http）
 *   → parseSchedulerMetrics（原始映射）→ extractHamiDevices（每设备一行）
 *
 * 三条设计约束（与 server/k8s/hami.js 一致）：
 * 1. **纯函数优先**：`parseSchedulerMetrics` / `pickKeySeries` / `extractHamiDevices`
 *    零 IO、零全局状态，同样输入必得同样输出（包括排序）。
 * 2. **绝不抛异常**：`fetchSchedulerMetrics` 把 Pod 查询失败、DNS/连接/超时/HTTP 非 2xx/
 *    空响应体全部降级成 `{ available:false, reason:'中文原因' }`，调用方永远拿到对象。
 * 3. **可注入**：HTTP 走 `httpGet`（默认 node:http 实现），单测注入假函数即可不发网络请求。
 *
 * 指标口径（HAMi v2.x，[文档] hamiapps/hami）：
 *   hami_container_device_utilization_ratio{container,device_uuid,node}  0..1 的比值
 *   hami_container_device_memory_bytes{container,device_uuid,node}       已用字节
 *   hami_host_gpu_utilization_ratio{device_uuid,node}                    整卡利用率 0..1
 */

import http from 'node:http';
import { errorMessage } from '../errors.js';

/** hami-scheduler 指标默认端口（HAMi chart 的 metrics service 端口）。 */
export const DEFAULT_METRICS_PORT = 9395;   // 243 实测：HAMi chart 的 metrics 端口是 9395

/** 找 scheduler Pod 的标签选择器（HAMi chart 的 Deployment 标签）。 */
// 243 实测：官方 chart 打的是 app.kubernetes.io/component=hami-scheduler（不是 app=hami-scheduler）
export const SCHEDULER_LABEL_SELECTOR = 'app.kubernetes.io/component=hami-scheduler';

/** hami-scheduler 部署所在的命名空间。 */
export const SCHEDULER_NAMESPACE = 'kube-system';

/** 抓取超时：10s（与 k8s client 的默认超时保持一致）。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** 三条关键序列的指标名（导出给 A2 做常量比对，避免手写字符串）。 */
export const METRIC_CONTAINER_UTIL = 'hami_container_device_utilization_ratio';
export const METRIC_CONTAINER_MEMORY = 'hami_container_device_memory_bytes';
export const METRIC_HOST_UTIL = 'hami_host_gpu_utilization_ratio';

/** Prometheus 指标名：`[a-zA-Z_:][a-zA-Z0-9_:]*`（冒号是 recording rule 专用，但要接受）。 */
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;

/** 标签名：`[a-zA-Z_][a-zA-Z0-9_]*`。 */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/;

/** 合法数值字面量（允许前后符号与科学计数法）；NaN / ±Inf 单独处理。 */
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/* ────────────────────────────── 解析：文本 → 原始映射 ────────────────────────────── */

/** 标签集合 → 稳定签名（排过序，用于重复样本去重）。 */
function labelSignature(labels) {
  const keys = Object.keys(labels).sort();
  const body = keys.map((k) => `${k}=${JSON.stringify(labels[k])}`).join(',');
  return `{${body}}`;
}

/**
 * 解析 `{a="b",c="d"}` 片段。
 *
 * 按 Prometheus 的转义规则处理 `\\` `\"` `\n`：
 * 只有这三者 + 兼容 `\t` 会被还原，其它 `\x` 一律保留 x 本身（宽容，不报错）。
 *
 * @param {string} line 整行
 * @param {number} start 指向 `{` 的下标
 * @returns {{ labels: Record<string,string>, end: number } | null} 失败（未闭合/缺 `=`/缺引号）返回 null
 */
function parseLabelBlock(line, start) {
  const labels = {};
  let i = start + 1;

  while (i < line.length) {
    // 跳过分隔符与空白：`{ a="1" , b="2" }`
    while (i < line.length && (line[i] === ',' || line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= line.length) return null;
    if (line[i] === '}') return { labels, end: i + 1 };

    const nameMatch = LABEL_NAME_RE.exec(line.slice(i));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    i += name.length;

    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (line[i] !== '=') return null;
    i++;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (line[i] !== '"') return null;
    i++;

    let value = '';
    let closed = false;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\\') {
        const next = line[i + 1];
        if (next === undefined) return null;
        if (next === '"') { value += '"'; i += 2; continue; }
        if (next === '\\') { value += '\\'; i += 2; continue; }
        if (next === 'n') { value += '\n'; i += 2; continue; }
        if (next === 't') { value += '\t'; i += 2; continue; }
        // 未知转义：保留字符本身，绝不因此丢掉整行
        value += next;
        i += 2;
        continue;
      }
      if (ch === '"') { closed = true; i++; break; }
      value += ch;
      i++;
    }
    if (!closed) return null;

    labels[name] = value;
  }

  return null; // 没有闭合的 `}`
}

/**
 * 解析采样值。
 *
 * - `NaN` / `nan` → NaN
 * - `+Inf` / `Inf` / `inf` / `+inf` / `Infinity` → Infinity
 * - `-Inf` / `-inf` / `-Infinity` → -Infinity
 * - 其余必须是合法十进制/科学计数法字面量
 *
 * @returns {number | null} null 表示「这不是一个值」，调用方丢弃整行
 */
function parseSampleValue(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return null;

  const lower = s.toLowerCase();
  if (lower === 'nan') return NaN;
  if (lower === '+inf' || lower === 'inf' || lower === '+infinity' || lower === 'infinity') return Infinity;
  if (lower === '-inf' || lower === '-infinity') return -Infinity;

  if (!NUMBER_RE.test(s)) return null;
  const num = Number(s);
  return Number.isNaN(num) ? null : num;
}

/**
 * 解析一行样本：`name{labels} value [timestamp]`。
 *
 * 第三段（毫秒时间戳）故意忽略：抓取时刻统一由 `scrapedAt` 表达，
 * 混进样本里只会让下游多一个要过滤的字段。
 *
 * @returns {{ name: string, labels: Record<string,string>, value: number } | null}
 */
function parseSampleLine(line) {
  const nameMatch = METRIC_NAME_RE.exec(line);
  if (!nameMatch) return null;

  const name = nameMatch[0];
  let i = name.length;
  let labels = {};

  if (line[i] === '{') {
    const parsed = parseLabelBlock(line, i);
    if (!parsed) return null;
    labels = parsed.labels;
    i = parsed.end;
  }

  const rest = line.slice(i).trim();
  if (rest === '') return null;

  // 值之后可能跟时间戳（`1 1700000000000`），只取第一段
  const fields = rest.split(/\s+/);
  const value = parseSampleValue(fields[0]);
  if (value === null) return null;

  return { name, labels, value };
}

/**
 * 解析 Prometheus 暴露格式文本。
 *
 * 行为约定：
 * - `#` 开头的行（`# HELP` / `# TYPE` / `# EOF`）整行忽略，空行忽略；
 * - 坏行（没有值、名字非法、标签未闭合、缺引号）**静默跳过**，不影响其它行；
 * - **重复样本**（同名 + 同标签集合）按「后者覆盖前者」处理，数组里只留一条；
 *   真实 Prometheus 会拒绝这种文本，但 HAMi 在某些多副本场景下会有重复，
 *   保留两条会让下游把同一张卡的显存算两遍。
 *
 * @param {string} text `/metrics` 原始文本
 * @returns {Record<string, Array<{ labels: Record<string,string>, value: number }>>}
 *   指标名 → 样本数组；NaN 与 ±Inf 保留为对应 JS 数值（由下游决定怎么降级）
 */
export function parseSchedulerMetrics(text) {
  /** @type {Record<string, Array<{ labels: Record<string,string>, value: number }>>} */
  const out = {};
  /** 去重索引：签名 → 在 out[name] 里的下标 */
  const seen = new Map();

  if (typeof text !== 'string' || text === '') return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const sample = parseSampleLine(line);
    if (!sample) continue;

    const key = `${sample.name}${labelSignature(sample.labels)}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      out[prev.name][prev.index] = { labels: sample.labels, value: sample.value };
      continue;
    }

    if (!Array.isArray(out[sample.name])) out[sample.name] = [];
    out[sample.name].push({ labels: sample.labels, value: sample.value });
    seen.set(key, { name: sample.name, index: out[sample.name].length - 1 });
  }

  return out;
}

/* ────────────────────────────── 抽取：原始映射 → 设备行 ────────────────────────────── */

/** 取标签里第一个非空字符串值（HAMi 各版本标签名略有差异）。 */
function firstLabel(labels, names) {
  for (const name of names) {
    const v = labels[name];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

/** 设备 UUID：优先 device_uuid，其次 deviceUUID/uuid/device，最后退到 `node#index`。 */
function resolveDeviceUuid(labels) {
  const direct = firstLabel(labels, ['device_uuid', 'deviceUUID', 'uuid', 'device']);
  if (direct !== '') return direct;

  const index = firstLabel(labels, ['device_index', 'deviceIndex', 'index']);
  if (index === '') return '';
  const node = firstLabel(labels, ['node', 'node_name', 'nodename', 'hostname']);
  return `${node === '' ? '未知节点' : node}#${index}`;
}

/** 只接受「有限且非负」的数值；NaN / ±Inf / 负数 / 非数字一律 null。 */
function toFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 保留两位小数的百分比（0.3781 → 37.81）；null 原样透传。 */
function toPercent(ratio) {
  return ratio === null ? null : Number((ratio * 100).toFixed(2));
}

/** 设备主键：node + uuid（同一 uuid 在不同节点上不合并）。 */
function deviceKey(node, uuid) {
  return `${node}\u0000${uuid}`;
}

/** 从原始映射里挑出三条关键序列（A2 也可能要自己按标签再过滤）。 */
export function pickKeySeries(parsed) {
  const src = parsed && typeof parsed === 'object' ? parsed : {};
  const pick = (name) => {
    const series = src[name];
    if (!Array.isArray(series)) return [];
    return series.filter((s) => s && typeof s === 'object' && s.labels && typeof s.labels === 'object');
  };
  return {
    containerUtilization: pick(METRIC_CONTAINER_UTIL),
    containerMemory: pick(METRIC_CONTAINER_MEMORY),
    hostUtilization: pick(METRIC_HOST_UTIL),
  };
}

/**
 * 把原始映射归并成「一台设备一行」。
 *
 * 归并规则：
 * - 主键 = node + device_uuid；同一主键的多条序列取 **最大值**（同一张卡被多处上报时
 *   取最坏值，避免下游把利用率算低），缺失的维度保留 null 而不是 0；
 * - `containerUtil` / `memUsedBytes` / `hostUtil` 全部是「未知即 null」，
 *   这样前端能显示 `—` 而不是误导性的 0%；
 * - 输出按 node → deviceUUID 排序，保证同样输入必得同样顺序。
 *
 * @param {ReturnType<typeof parseSchedulerMetrics>} parsed
 * @returns {Array<{
 *   deviceUUID: string, node: string|null, container: string|null,
 *   containerUtil: number|null, utilPercent: number|null,
 *   memUsedBytes: number|null,
 *   hostUtil: number|null, hostUtilPercent: number|null
 * }>}
 */
export function extractHamiDevices(parsed) {
  const { containerUtilization, containerMemory, hostUtilization } = pickKeySeries(parsed);
  /** @type {Map<string, object>} */
  const map = new Map();

  const locate = (node, uuid) => {
    const direct = map.get(deviceKey(node, uuid));
    if (direct) return direct;
    // 主机级指标可能没有 node 标签：只有「本次样本也没 node」时才按 uuid 兜底命中，
    // 否则会把两个节点上同名的设备错误合并成一条。
    if (node !== '') return null;
    for (const entry of map.values()) {
      if (entry.deviceUUID === uuid) return entry;
    }
    return null;
  };

  const ensure = (node, uuid, container) => {
    const existing = locate(node, uuid);
    if (existing) {
      if (!existing.container && container) existing.container = container;
      return existing;
    }
    const entry = {
      deviceUUID: uuid,
      node: node === '' ? null : node,
      container: container === '' ? null : container,
      containerUtil: null,
      memUsedBytes: null,
      hostUtil: null,
    };
    map.set(deviceKey(node, uuid), entry);
    return entry;
  };

  const describe = (sample) => {
    const labels = sample.labels;
    return {
      node: firstLabel(labels, ['node', 'node_name', 'nodename', 'hostname']),
      uuid: resolveDeviceUuid(labels),
      container: firstLabel(labels, ['container', 'container_name', 'pod']),
    };
  };

  for (const sample of containerUtilization) {
    const { node, uuid, container } = describe(sample);
    if (uuid === '') continue;
    const ratio = toFiniteNonNegative(sample.value);
    const entry = ensure(node, uuid, container);
    if (ratio !== null && (entry.containerUtil === null || ratio > entry.containerUtil)) {
      entry.containerUtil = ratio;
      if (container) entry.container = container;
    }
  }

  for (const sample of containerMemory) {
    const { node, uuid, container } = describe(sample);
    if (uuid === '') continue;
    const bytes = toFiniteNonNegative(sample.value);
    const entry = ensure(node, uuid, container);
    if (bytes !== null && (entry.memUsedBytes === null || bytes > entry.memUsedBytes)) {
      entry.memUsedBytes = bytes;
    }
  }

  for (const sample of hostUtilization) {
    const { node, uuid } = describe(sample);
    if (uuid === '') continue;
    const ratio = toFiniteNonNegative(sample.value);
    const entry = ensure(node, uuid, '');
    if (ratio !== null && (entry.hostUtil === null || ratio > entry.hostUtil)) {
      entry.hostUtil = ratio;
    }
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...map.values()]
    .map((entry) => ({
      deviceUUID: entry.deviceUUID,
      node: entry.node,
      container: entry.container,
      containerUtil: entry.containerUtil,
      utilPercent: toPercent(entry.containerUtil),
      memUsedBytes: entry.memUsedBytes,
      hostUtil: entry.hostUtil,
      hostUtilPercent: toPercent(entry.hostUtil),
    }))
    .sort((a, b) => cmp(a.node ?? '', b.node ?? '') || cmp(a.deviceUUID, b.deviceUUID));
}

/* ────────────────────────────── 抓取：Pod → /metrics ────────────────────────────── */

/** 端口归一化：非法值静默退回默认端口（配置错误不该让整个面板变红）。 */
function resolveMetricsPort(value) {
  const num = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof num === 'number' && Number.isInteger(num) && num > 0 && num <= 65535) return num;
  return DEFAULT_METRICS_PORT;
}

/** 超时归一化：只接受正数毫秒。 */
function resolveTimeoutMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

/** 毫秒 → 人类可读秒数（10000 → "10s"），错误文案里用。 */
function formatSeconds(ms) {
  return `${Number((ms / 1000).toFixed(3))}s`;
}

/** `scrapedAt` 支持注入：Date / 毫秒数 / () => Date|string|number，默认取当前时间。 */
function resolveScrapedAt(now) {
  let value = now;
  if (typeof value === 'function') {
    try {
      value = value();
    } catch {
      value = undefined;
    }
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  return new Date().toISOString();
}

/** 拼 `/metrics` URL；IPv6 的 podIP 必须加方括号，否则 URL 解析会把冒号当端口分隔符。 */
/**
 * apiserver 代理路径：`pods/<name>:<port>/proxy/metrics`。
 *
 * 为什么优先走它：podIP 只在集群网络内可达。OpenLog 部署在集群外（开发机、
 * 另一台机器）时，`http://<podIP>:9395/metrics` 会 SYN 重试到超时 —— 实测
 * `/api/k8s/.../usage` 因此稳定多花 5 秒。apiserver 代理走的是 kubeconfig 那条
 * 连接，跨网可用，且不要求额外开放端口。
 */
function buildProxyPath(podName, port) {
  const name = String(podName || '').trim();
  if (!name) return '';
  return `/api/v1/namespaces/${SCHEDULER_NAMESPACE}/pods/${encodeURIComponent(name)}:${port}/proxy/metrics`;
}

function buildMetricsUrl(podIP, port) {
  const host = String(podIP).includes(':') ? `[${podIP}]` : String(podIP);
  return `http://${host}:${port}/metrics`;
}

/**
 * 默认 HTTP 实现：node:http GET，超时后 destroy 并 reject（带 code=ETIMEDOUT）。
 *
 * 返回形状与 k8s client 一致：`{ statusCode, headers, body }`。
 * 单测通过 `httpGet` 注入替换，这里永远不会被调用。
 */
function defaultHttpGet(url, options = {}) {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    let req;
    try {
      req = http.request(
        url,
        {
          method: 'GET',
          headers: { accept: 'text/plain, */*', ...(options.headers || {}) },
        },
        (res) => {
          const chunks = [];
          res.setEncoding('utf8');
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', (err) => finish(reject, err));
          res.on('end', () => finish(resolve, {
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: chunks.join(''),
          }));
        },
      );
    } catch (err) {
      finish(reject, err);
      return;
    }

    req.setTimeout(timeoutMs, () => {
      const err = new Error(`请求超时（${formatSeconds(timeoutMs)}）`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', (err) => finish(reject, err));
    req.end();
  });
}

/** 从 Pod 列表里挑一个可抓取的 scheduler Pod（优先 Running 且有 podIP）。 */
function pickSchedulerPod(list) {
  const items = list && Array.isArray(list.items) ? list.items : [];
  const candidates = items
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      name: firstLabel({ name: item.metadata?.name }, ['name']),
      phase: typeof item.status?.phase === 'string' ? item.status.phase : '',
      podIP: typeof item.status?.podIP === 'string' ? item.status.podIP.trim() : '',
      deletionTimestamp: item.metadata?.deletionTimestamp,
    }))
    // 正在删除的 Pod 不要：它的 podIP 随时会消失
    .filter((pod) => !pod.deletionTimestamp)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const ready = candidates.find((pod) => pod.phase === 'Running' && pod.podIP !== '');
  const withIp = candidates.find((pod) => pod.podIP !== '');
  return ready || withIp || candidates[0] || null;
}

/** 网络层失败 → 中文原因（区分超时 / 拒绝连接 / DNS / 其它）。 */
function describeFetchError(err, url, timeoutMs) {
  const code = err && typeof err === 'object' ? err.code : '';
  const message = errorMessage(err);

  if (code === 'ETIMEDOUT' || /超时|timed?\s?out/i.test(message)) {
    return `HAMi 指标接口请求超时（${formatSeconds(timeoutMs)}）：${url}`;
  }
  if (code === 'ECONNREFUSED') {
    return `HAMi 指标接口连接被拒绝（端口未监听）：${url}`;
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `HAMi 指标接口网络不可达：${url}`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `HAMi 指标接口域名解析失败：${url}`;
  }
  return `HAMi 指标接口请求失败：${message}`;
}

/**
 * 抓取 hami-scheduler 的指标。
 *
 * 流程：
 *   1. `client.getJson('/api/v1/namespaces/kube-system/pods?labelSelector=app=hami-scheduler')`
 *   2. 取 `status.podIP` + 端口（`metricsPort` → `cluster.metricsPort` → 31993）
 *   3. `httpGet('http://<podIP>:<port>/metrics', { timeoutMs })`
 *   4. 解析文本 → 归并成 devices
 *
 * **任何失败都不抛**，返回 `{ available:false, scrapedAt, devices:[], reason:'中文原因' }`，
 * 这样路由层永远能直接 `res.json(...)`，前端只需判断 available。
 *
 * @param {object} options
 * @param {{ getJson?: Function }} options.client kube 客户端（server/k8s/client.js 的返回值）
 * @param {{ metricsPort?: number|string, hamiMetricsPort?: number|string }} [options.cluster]
 *   集群配置；`metricsPort` / `hamiMetricsPort` 可覆盖默认端口
 * @param {Function} [options.httpGet] 注入的 HTTP 实现（单测用）
 * @param {number|string} [options.metricsPort] 直接覆盖端口（优先级高于 cluster）
 * @param {number} [options.timeoutMs] 抓取超时，默认 10s
 * @param {Date|number|string|Function} [options.now] 注入当前时间（保证 scrapedAt 可测）
 * @returns {Promise<{
 *   available: boolean, scrapedAt: string,
 *   devices: ReturnType<typeof extractHamiDevices>,
 *   reason?: string, endpoint?: string, metricsPort?: number, podName?: string
 * }>}
 */
export async function fetchSchedulerMetrics(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const scrapedAt = resolveScrapedAt(opts.now);
  const cluster = opts.cluster && typeof opts.cluster === 'object' ? opts.cluster : {};
  const metricsPort = resolveMetricsPort(
    opts.metricsPort ?? cluster.hamiMetricsPort ?? cluster.metricsPort,
  );
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const httpGet = typeof opts.httpGet === 'function' ? opts.httpGet : defaultHttpGet;

  /** 统一失败形状：devices 恒为数组，调用方不必再判空。 */
  const unavailable = (reason) => ({ available: false, scrapedAt, devices: [], reason, metricsPort });

  const client = opts.client;
  if (!client || typeof client.getJson !== 'function') {
    return unavailable('未提供 Kubernetes 客户端，无法查询 hami-scheduler Pod');
  }

  // ① 找 scheduler Pod
  let list;
  try {
    list = await client.getJson(`/api/v1/namespaces/${SCHEDULER_NAMESPACE}/pods`, {
      query: { labelSelector: SCHEDULER_LABEL_SELECTOR },
    });
  } catch (err) {
    return unavailable(`查询 hami-scheduler Pod 失败：${errorMessage(err)}`);
  }

  const pod = pickSchedulerPod(list);
  if (!pod) {
    return unavailable(
      `未找到 hami-scheduler Pod：${SCHEDULER_NAMESPACE} 下没有 ${SCHEDULER_LABEL_SELECTOR} 的 Pod`,
    );
  }
  if (!pod.podIP) {
    return unavailable(`hami-scheduler Pod ${pod.name || '（未知名称）'} 尚未分配 podIP（可能未就绪）`);
  }

  // ② 抓 /metrics：apiserver 代理优先（跨网可用），podIP 直连兜底
  const proxyPath = buildProxyPath(pod.name, metricsPort);
  let endpoint = buildMetricsUrl(pod.podIP, metricsPort);
  let transport = 'podip';
  let proxyError = '';
  let body = '';

  if (proxyPath && typeof client.getText === 'function') {
    try {
      body = await client.getText(proxyPath, { timeoutMs });
      transport = 'apiserver';
      endpoint = `apiserver:${proxyPath}`;
    } catch (err) {
      // 代理被 RBAC 拒绝（pods/proxy 没权限）或 apiserver 不转发时，退回直连
      proxyError = errorMessage(err);
    }
  }

  if (!body) {
    let res;
    try {
      res = await httpGet(endpoint, { timeoutMs, headers: { accept: 'text/plain, */*' } });
    } catch (err) {
      const reason = describeFetchError(err, endpoint, timeoutMs);
      return unavailable(proxyError ? `${reason}（apiserver 代理也不可用：${proxyError}）` : reason);
    }

    // httpGet 允许直接返回字符串（测试里最省事的写法），也允许返回 { statusCode, body }
    const statusCode = typeof res === 'string'
      ? 200
      : Number(res && typeof res === 'object' ? res.statusCode ?? 200 : 0);
    body = typeof res === 'string'
      ? res
      : typeof res?.body === 'string' ? res.body : '';

    if (!(statusCode >= 200 && statusCode < 300)) {
      return unavailable(`HAMi 指标接口返回 HTTP ${statusCode}：${endpoint}`);
    }
  }
  // ③ 解析 + 归并
  let devices;
  let parsed;
  try {
    parsed = parseSchedulerMetrics(body);
    devices = extractHamiDevices(parsed);
  } catch (err) {
    return unavailable(`解析 HAMi 指标失败：${errorMessage(err)}`);
  }

  // 只有空白 / 只有注释（`# EOF`）等同于空内容：接口通了但没暴露任何指标
  if (Object.keys(parsed).length === 0) {
    return unavailable(`HAMi 指标接口返回空内容（${endpoint}），可能该版本未开启指标暴露`);
  }

  return {
    available: true,
    scrapedAt,
    devices,
    endpoint,
    metricsPort,
    podName: pod.name,
    // 走的是 apiserver 代理还是 podIP 直连：跨网排障第一眼看这个
    transport,
    ...(proxyError ? { proxyError } : {}),
    // 显式 opt-in 才附带原始映射：A2 需要按标签自行聚合时用（默认不返回，避免响应体膨胀）
    ...(opts.includeParsed === true ? { parsed } : {}),
  };
}

export { buildProxyPath };

export default { parseSchedulerMetrics, fetchSchedulerMetrics, extractHamiDevices, pickKeySeries, buildProxyPath };
