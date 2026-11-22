/**
 * server/demo/fixtures-observability.js —— 演示模式下「日志页 + TSDB 只读面板」的假数据
 *
 * 与 server/demo/fixtures.js 同一套约定（契约见 /tmp/demo-contract.md），
 * 但只负责两张最容易在演示时全空的页面：
 *
 *   · 日志页：`GET /api/logs` 读的是 index.js 的内存环形缓冲 —— 刚起进程时它
 *     只有启动那两行；`GET /api/logs/history` 读库，没开持久化就是 0 行。
 *   · TSDB 面板：`/api/v1/targets|rules|alerts|alert_groups|series|labels` 与
 *     `/api/tsdb/status` 都挂在真实的时序库/抓取器/规则引擎上，演示机上全空。
 *
 * 三条硬约束（与 fixtures.js 相同，破坏任何一条都会让演示数据变成负资产）：
 *
 * 1. **形状照抄真实路由**：每一项字段都是从 `routes/logs.js`、`routes/prometheus.js`
 *    的真实响应里逐字段抄下来的（记录行的字段来自 `db/index.js#insertLogRecord`），
 *    包括那些看起来多余的空值（`lastError: ''`、`error: null`）—— 前端按字段存在
 *    与否分支，少一个字段就换渲染路径。
 * 2. **纯函数 + 常量表**：不 import 任何模块、不读文件、不联网、不读环境变量。
 *    时间锚点在这里重新声明一份（值与 fixtures.js 的 DEMO_NOW 相同）：两个 fixture
 *    文件互不依赖，任何一个出问题都不会把另一个带崩。
 * 3. **确定性**：固定时间锚点 + 固定种子（LCG）在**模块加载时**一次性生成常量表，
 *    之后每次调用只是过滤/切片/深拷贝。同一参数多次调用 deepEqual —— 否则
 *    「刷新一次数值就变」会被一眼看穿，前端 diff 与测试断言也全部失效。
 */

// ─── 时间基准 ──────────────────────────────────────────────────────────────

/** 时间锚点（与 fixtures.js 的 DEMO_NOW 对齐：演示数据应该讲同一个故事） */
export const DEMO_OBS_NOW = '2026-06-08T09:48:37.000Z';

const NOW_MS = Date.parse(DEMO_OBS_NOW);
const SECOND = 1000;
const MINUTE = 60_000;

/** NOW 之前 msAgo 毫秒的 ISO 时间（不允许「未来」数据） */
const iso = (msAgo) => new Date(NOW_MS - Math.max(0, msAgo)).toISOString();

/** 深拷贝：调用方 mutate 返回值不会污染常量表 */
const clone = (value) => JSON.parse(JSON.stringify(value));

const pad2 = (n) => String(n).padStart(2, '0');

/** 日志行自带的 `06-08 09:47:12` 时间前缀 */
function stamp(msAgo) {
  const d = new Date(NOW_MS - Math.max(0, msAgo));
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** 确定性伪随机（线性同余）：同 seed 永远同一串数 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// ─── 日志页：GET /api/logs ────────────────────────────────────────────────
//
// 真实响应：`{ logs: [{ id, timestamp, level, message, source, metadata? }], total }`
// （`routes/logs.js#GET /api/logs`，元素由 index.js 的 saveLog() 写入，timestamp 是 ISO）。
// 真实缓冲是 `unshift` 写入的，所以数组**新 → 旧**，这里保持一致。

/**
 * 模板表：按 source × level 分桶。
 * 占位符由 buildContext() 填充，只允许出现 ctx 里有的键（见 render()）。
 */
const LOG_TEMPLATES = {
  vllm: {
    INFO: [
      'Engine 000: Avg prompt throughput: {tps} tokens/s, Avg generation throughput: {gtps} tokens/s, Running: {reqs} reqs, Waiting: {wait} reqs, GPU KV cache usage: {pct}%',
      'Received request {req}: prompt_tokens={n}, max_tokens=512, temperature=0.7',
      'Finished request {req} in {ms}ms (prefill {pms}ms, decode {dms}ms)',
      'GPU blocks: {blocks} active / 4096 total, preemption count: 0',
      'Engine 001: Avg prompt throughput: {tps} tokens/s, Avg generation throughput: {gtps} tokens/s, Running: {reqs} reqs, Waiting: 0 reqs',
      'Model loader: sharding weights across {gpus} GPUs (tensor_parallel_size={gpus}), dtype=float16',
    ],
    WARN: [
      'Scheduler: preemption on seq {n}, recomputing {blocks} blocks (swap space {pct}% used)',
      'GPU KV cache usage {pct}% above high watermark 90%, throttling new requests',
      'Request {req} exceeded max_model_len (input {n} tokens), truncating prompt',
      'Slow decode detected: {ms}ms/token on GPU {gpu}, possible thermal throttling',
    ],
    ERROR: [
      'CUDA out of memory: tried to allocate {gib} GiB (GPU {gpu}; {gib2} GiB already allocated)',
      'Worker {gpu} died unexpectedly (exit code 1), aborting {reqs} in-flight requests',
      'EngineCore failed to start: NCCL error on GPU {gpu} (unhandled cuda error)',
    ],
  },
  sglang: {
    INFO: [
      'Router: cache hit rate {pct}% ({n} hits / {n2} requests), radix tree nodes={blocks}',
      'Prefill batch {req}: {n} tokens, {ms}ms, throughput {tps} tokens/s',
      'Decode step {n}: batch size {reqs}, {ms}ms, kv pool usage {pct}%',
      'Health check ok: sglang-router v0.4.5, worker 0/1 healthy',
      'Added request {req} to radix cache (prefix length {n})',
    ],
    WARN: [
      'Radix cache eviction: {blocks} nodes dropped, kv pool usage {pct}%',
      'Request {req} waited {ms}ms in queue (pending {reqs}), consider raising --max-running-requests',
      'Worker 1 heartbeat delayed {ms}ms, still forwarding traffic',
    ],
    ERROR: [
      'Detokenizer crashed: aborted {reqs} requests, restarting worker {gpu}',
      'Failed to bind port {port}: address already in use (previous router still alive)',
    ],
  },
  redis: {
    INFO: [
      'Accepted 127.0.0.1:{port}',
      'DB saved on disk (rdb_changes_since_last_save={n})',
      '{n} changes in {secs} seconds. Saving...',
      'Background saving terminated with success',
      'Client id={n} closed connection from 127.0.0.1:{port}, duration {secs}s',
    ],
    WARN: [
      'WARNING Memory overcommit must be enabled! Without it, a background save or replication may fail under low memory condition.',
      'Client id={n} addr=127.0.0.1:{port} closed idle connection after {secs}s (timeout=300)',
      'Keyspace hit rate dropped to {pct}% over the last {secs}s window',
    ],
    ERROR: [
      'MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on disk: write error',
      'Background saving error: fork: Cannot allocate memory',
    ],
  },
  openlog: {
    INFO: [
      'GET /api/logs 200 {ms}ms',
      '采集完成 servers=3 gpus=10 containers=8（耗时 {ms}ms）',
      'TSDB 写入 {n} 条序列 / {n2} 个样本，flush ok',
      'GET /api/v1/query_range 200 {ms}ms query=openlog_gpu_utilization_percent',
      '健康巡检通过：docker 源 2 个，k8s 集群 1 个',
    ],
    WARN: [
      'SSH 重连失败 srv-t4-2（第 {n} 次），{secs} 分钟后重试',
      '容器 openlog-pg 重启次数 {n} 超过阈值，已加入巡检队列',
      '采样延迟 {ms}ms 超过阈值 500ms（stats-scheduler 队列积压 {reqs}）',
    ],
    ERROR: [
      '采集失败 srv-t4-2: ssh connect timeout (10.20.30.31:22)',
      '写库失败：SQLITE_BUSY (database is locked)，已回滚本批 {n} 条记录',
      '通知发送失败 webhook 503 receiver=ops-webhook，将在下个周期重试',
    ],
  },
};

/** 来源权重：推理服务占多数（运维视角里 vllm/sglang 才是主角） */
const SOURCE_CYCLE = ['vllm', 'vllm', 'sglang', 'vllm', 'redis', 'openlog', 'sglang', 'vllm'];

const LOG_COUNT = 200;
/** 相邻两行间隔 45s：200 行覆盖约 2.5 小时，和「刚跑了一上午」对得上 */
const LOG_STEP_MS = 45 * SECOND;

/** 逐行占位符取值（全部来自同一个 LCG，调用顺序固定） */
function buildContext(rng, msAgo) {
  const int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const dec = (min, max, digits = 1) => Number((min + rng() * (max - min)).toFixed(digits));
  const hex = (len) => {
    let s = '';
    for (let i = 0; i < len; i += 1) s += '0123456789abcdef'[Math.floor(rng() * 16)];
    return s;
  };
  const pms = int(20, 400);
  return {
    t: stamp(msAgo),
    req: `chatcmpl-${hex(8)}`,
    id: hex(6),
    tps: dec(120, 2400),
    gtps: dec(60, 900),
    reqs: int(1, 8),
    wait: int(0, 3),
    pct: dec(12, 96),
    gpu: int(0, 3),
    gpus: 4,
    ms: int(4, 2200),
    pms,
    dms: int(4, 1200),
    gib: dec(1, 23, 2),
    gib2: dec(1, 22, 2),
    blocks: int(40, 3800),
    port: int(30000, 65000),
    secs: int(2, 60),
    n: int(0, 999),
    n2: int(1000, 99999),
  };
}

/** 占位符替换：只认 ctx 里存在的键，未知键原样保留（写错模板时肉眼可见） */
function render(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in ctx ? String(ctx[key]) : m));
}

/** 生成 200 条日志（模块加载时跑一次，之后只读） */
function buildLogEntries() {
  const rng = lcg(20260608);
  const out = [];
  for (let i = 0; i < LOG_COUNT; i += 1) {
    const msAgo = i * LOG_STEP_MS + 12 * SECOND;
    // 等级权重：INFO 约 76%、WARN 约 17%、ERROR 约 7% —— ERROR 必须是少数
    const r = rng();
    const level = r < 0.76 ? 'INFO' : (r < 0.93 ? 'WARN' : 'ERROR');
    const source = SOURCE_CYCLE[i % SOURCE_CYCLE.length];
    const pool = LOG_TEMPLATES[source][level];
    const ctx = buildContext(rng, msAgo);
    const template = pool[Math.floor(rng() * pool.length) % pool.length];

    const head = level === 'INFO' ? '' : `${level} `;
    const entry = {
      // 真实实现 id 用 uuidv4；演示模式必须确定性，所以用序号
      id: `demo-log-${String(i + 1).padStart(4, '0')}`,
      timestamp: iso(msAgo),
      level,
      message: `${ctx.t} ${head}[${source}] ${render(template, ctx)}`,
      source,
    };
    // 请求类日志带 metadata（真实写入是 JSON 字符串，前端自己 parse）
    if (template.includes('{req}')) {
      entry.metadata = JSON.stringify({
        request_id: ctx.req,
        model: source === 'vllm' ? 'Qwen2.5-27B-Instruct' : 'Qwen2.5-7B-Instruct',
        gpu: ctx.gpu,
      });
    }
    out.push(entry);
  }
  return out;
}

/** 常量表：新 → 旧 */
const LOG_ENTRIES = buildLogEntries();

/** 各等级条数（测试与文档用；也方便一眼核对比例） */
export const DEMO_LOG_LEVEL_COUNTS = LOG_ENTRIES.reduce((acc, l) => {
  acc[l.level] = (acc[l.level] || 0) + 1;
  return acc;
}, {});

/**
 * `GET /api/logs` 的演示数据。
 *
 * 过滤/分页语义与真实路由**逐行对齐**（顺序也一样：level → source → search →
 * 取 total → slice(offset, offset+limit)），差别只是数据源从内存缓冲换成常量表。
 * 特别是：
 *   · `total` 是**过滤后、切片前**的条数（真实实现 `total = result.length` 在 slice 之前）；
 *   · level/source 用严格相等（`?level=error` 小写匹配不到，和真实一致）；
 *   · limit/offset 走 `parseInt`：传垃圾值得到 NaN → `slice(NaN, NaN)` → 空数组，
 *     与真实路由的 `slice(parseInt(offset), parseInt(offset)+parseInt(limit))` 同结果。
 *
 * @param {{limit?:number|string, offset?:number|string, level?:string, source?:string, search?:string}} [opts]
 * @returns {{logs:Array<object>, total:number}}
 */
export function demoLogEntries(opts = {}) {
  const { level, source, search, limit = 100, offset = 0 } = opts || {};

  let result = LOG_ENTRIES;
  if (level) result = result.filter((log) => log.level === level);
  if (source) result = result.filter((log) => log.source === source);
  if (search) {
    const needle = String(search).toLowerCase();
    result = result.filter((log) => String(log.message).toLowerCase().includes(needle));
  }

  const total = result.length;
  const off = parseInt(offset);
  const lim = parseInt(limit);
  return { logs: clone(result.slice(off, off + lim)), total };
}

// ─── 日志页：GET /api/logs/history ────────────────────────────────────────
//
// 真实响应：`{ logs: rows, total: rows.length, source: 'database' }`，
// rows 来自 `db/index.js#listLogRecords` 的 `SELECT * FROM log_records`，字段：
//   id, machine_id, source_type, source_name, content, severity, timestamp,
//   parsed, created_at
// timestamp/created_at 是 **epoch 秒**（`insertLogRecord` 用 `/1000`），
// parsed 是 JSON **字符串**（写库时 `JSON.stringify`），severity 是小写。

/** 只有 WARN/ERROR 级别会被持久化（saveLog 的 logPersistenceLevels 默认值） */
const HISTORY_SOURCE_FILES = {
  vllm: 'vllm-qwen27b.log',
  sglang: 'sglang-router.log',
  redis: 'redis-server.log',
  openlog: 'openlog-server.log',
};

const HISTORY_MACHINES = {
  vllm: 'srv-4090-a',
  sglang: 'srv-t4-4',
  redis: 'srv-4090-a',
  openlog: 'srv-4090-a',
};

function buildHistoryRows() {
  const persisted = LOG_ENTRIES.filter((l) => l.level === 'WARN' || l.level === 'ERROR').slice(0, 24);
  return persisted.map((log, i) => {
    const tsSec = Math.floor(Date.parse(log.timestamp) / 1000);
    return {
      id: `demo-hlog-${String(i + 1).padStart(4, '0')}`,
      machine_id: HISTORY_MACHINES[log.source] || 'srv-4090-a',
      source_type: 'file',
      source_name: HISTORY_SOURCE_FILES[log.source] || 'openlog-server.log',
      content: log.message,
      severity: log.level.toLowerCase(),
      timestamp: tsSec,
      parsed: JSON.stringify(log),
      created_at: tsSec + 1,
    };
  });
}

const HISTORY_ROWS = buildHistoryRows();

/**
 * `GET /api/logs/history` 的演示数据。
 *
 * 语义对齐真实链路：SQL 先按 machine_id/severity 过滤、按 timestamp DESC 排序、
 * 再 LIMIT/OFFSET 切片；路由随后用 startDate/endDate 做时间范围过滤，
 * `total` 取**时间过滤之后**的条数（真实路由就是 `total: filtered.length`）。
 *
 * @param {{machine_id?:string, severity?:string, limit?:number|string, offset?:number|string,
 *          startDate?:string, endDate?:string}} [opts]
 * @returns {{logs:Array<object>, total:number, source:'database'}}
 */
export function demoLogHistory(opts = {}) {
  const { machine_id, severity, limit = 200, offset = 0, startDate, endDate } = opts || {};

  let rows = HISTORY_ROWS;
  if (machine_id) rows = rows.filter((r) => r.machine_id === String(machine_id));
  if (severity) rows = rows.filter((r) => r.severity === String(severity));
  rows = [...rows].sort((a, b) => b.timestamp - a.timestamp);

  const off = parseInt(offset);
  const lim = parseInt(limit);
  rows = rows.slice(off, off + lim);

  if (startDate) {
    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    rows = rows.filter((r) => r.timestamp >= startTs);
  }
  if (endDate) {
    const endTs = Math.floor(new Date(endDate).getTime() / 1000);
    rows = rows.filter((r) => r.timestamp <= endTs);
  }

  return { logs: clone(rows), total: rows.length, source: 'database' };
}

// ─── TSDB：序列与标签 ─────────────────────────────────────────────────────
//
// `/api/v1/series|labels|label/:name/values` 的 data 都是**数组**（`ok(res, [...])`）。
// 序列对象 = 完整标签集（`{ __name__: s.name, ...s.labels }`），标签集合里
// 至少有 `__name__`、`host`、`gpu` —— 前端 GPU 面板按 `gpu` 拆图。

const TSDB_HOSTS = [
  { host: 'srv-4090-a', instance: '10.20.30.11:9100', gpuDevice: 'NVIDIA GeForce RTX 4090', gpus: [0, 1, 2, 3], help: '4090×4' },
  { host: 'srv-t4-4', instance: '10.20.30.21:9100', gpuDevice: 'Tesla T4', gpus: [0, 1, 2, 3], help: '4卡T4' },
  { host: 'srv-t4-2', instance: '10.20.30.31:9100', gpuDevice: 'Tesla T4', gpus: [0, 1], help: '双卡T4（离线，最后一次采集）' },
];

/** 指标名 → 说明（/metrics 的 HELP 与 /api/v1/labels 都靠这张表保持一致） */
const TSDB_METRICS = {
  openlog_cpu_usage_percent: { type: 'gauge', help: 'CPU utilization percent per host' },
  openlog_memory_usage_percent: { type: 'gauge', help: 'Memory utilization percent per host' },
  openlog_disk_usage_percent: { type: 'gauge', help: 'Filesystem usage percent per mountpoint' },
  openlog_gpu_utilization_percent: { type: 'gauge', help: 'GPU utilization percent per device' },
  openlog_gpu_memory_used_bytes: { type: 'gauge', help: 'GPU memory used in bytes per device' },
  openlog_docker_containers_total: { type: 'gauge', help: 'Running containers per host and state' },
  openlog_tsdb_samples_total: { type: 'counter', help: 'Total samples written into the TSDB' },
};

/** 构建序列表（模块加载时一次） */
function buildSeries() {
  const out = [];
  for (const h of TSDB_HOSTS) {
    out.push({
      __name__: 'openlog_cpu_usage_percent', host: h.host, job: 'node-exporter', instance: h.instance,
    });
    out.push({
      __name__: 'openlog_memory_usage_percent', host: h.host, job: 'node-exporter', instance: h.instance,
    });
    out.push({
      __name__: 'openlog_disk_usage_percent', host: h.host, mountpoint: '/data', job: 'node-exporter', instance: h.instance,
    });
    for (const gpu of h.gpus) {
      out.push({
        __name__: 'openlog_gpu_utilization_percent',
        host: h.host,
        gpu: String(gpu),
        device: h.gpuDevice,
        job: 'nvidia-dcgm',
        instance: h.instance.replace(':9100', ':9400'),
      });
      out.push({
        __name__: 'openlog_gpu_memory_used_bytes',
        host: h.host,
        gpu: String(gpu),
        device: h.gpuDevice,
        job: 'nvidia-dcgm',
        instance: h.instance.replace(':9100', ':9400'),
      });
    }
    for (const state of ['running', 'exited']) {
      out.push({
        __name__: 'openlog_docker_containers_total', host: h.host, state, job: 'openlog-self', instance: 'openlog-demo',
      });
    }
  }
  out.push({
    __name__: 'openlog_tsdb_samples_total', job: 'openlog-self', instance: 'openlog-demo',
  });
  return out;
}

const TSDB_SERIES = buildSeries();

/** 演示用 match[] → 指标名列表。null 表示「该选择器没指定指标名」（等价于全选） */
function filterSeries(metricNames) {
  if (!Array.isArray(metricNames) || metricNames.length === 0) return TSDB_SERIES;
  const wanted = new Set(metricNames.filter(Boolean));
  if (wanted.size === 0) return TSDB_SERIES; // 全是 null：选择器没限指标名
  return TSDB_SERIES.filter((s) => wanted.has(s.__name__));
}

/**
 * `GET /api/v1/series?match[]=...` 的演示数据。
 *
 * 只按**指标名**过滤：演示序列表是固定常量，没有采样点可用来做标签匹配，
 * 硬凑标签匹配只会让「选择器里写错 host 却还能返回数据」这种假象出现。
 *
 * @param {{metricNames?: Array<string|null>}} [opts]
 * @returns {Array<object>} 标签集数组（含 `__name__`）
 */
export function demoTsdbSeries(opts = {}) {
  const { metricNames } = opts || {};
  return clone(filterSeries(metricNames));
}

/**
 * `GET /api/v1/labels` 的演示数据 → 排序后的标签名数组。
 *
 * @param {{metricNames?: Array<string|null>}} [opts]
 * @returns {string[]}
 */
export function demoTsdbLabels(opts = {}) {
  const { metricNames } = opts || {};
  const names = new Set(['__name__']);
  for (const s of filterSeries(metricNames)) for (const k of Object.keys(s)) names.add(k);
  return [...names].sort();
}

/**
 * `GET /api/v1/label/:name/values` 的演示数据 → 排序后的标签值数组。
 *
 * 未知标签名返回空数组（真实存储在标签不存在时也是空数组）。
 *
 * @param {string} name
 * @returns {string[]}
 */
export function demoTsdbLabelValues(name) {
  const key = String(name || '');
  const values = new Set();
  for (const s of TSDB_SERIES) {
    if (s[key] !== undefined) values.add(String(s[key]));
  }
  return [...values].sort();
}

// ─── TSDB：抓取目标 / 规则 / 告警 / 分组 ───────────────────────────────────

/**
 * `GET /api/v1/targets` 的演示数据。
 * 形状照抄路由里的 map：`{ labels: {job, instance}, scrapeUrl, health,
 * lastScrape, lastDurationMs, lastError, samplesCount }`，外加恒空的 droppedTargets。
 * 有一台 down（双卡T4 掉线），演示时「目标挂了」长什么样也看得见。
 */
export function demoTsdbTargets() {
  const activeTargets = TSDB_HOSTS.map((h, i) => {
    const down = h.host === 'srv-t4-2';
    return {
      labels: { job: 'node-exporter', instance: h.instance },
      scrapeUrl: `http://${h.instance}/metrics`,
      health: down ? 'down' : 'up',
      lastScrape: iso(down ? 2 * 24 * 60 * MINUTE + 3 * 60 * MINUTE : 15 * SECOND + i * SECOND),
      lastDurationMs: down ? 0 : 12 + i * 7,
      lastError: down ? 'dial tcp 10.20.30.31:9100: i/o timeout' : '',
      samplesCount: down ? 0 : 148 + i * 11,
    };
  });
  return { activeTargets, droppedTargets: [] };
}

/** 单条告警的公共形状（alerting rule 的 alerts[] 与 /api/v1/alerts 同形） */
function alertObject({ name, severity, labels, annotations, state, activeAtMsAgo, value }) {
  return {
    labels: { alertname: name, severity, ...labels },
    annotations,
    state,
    activeAt: iso(activeAtMsAgo),
    value: String(value),
  };
}

const ALERT_GPU_HOT = alertObject({
  name: 'GPUHighUtilization',
  severity: 'warning',
  labels: { host: 'srv-4090-a', gpu: '1' },
  annotations: {
    summary: 'GPU 1 on srv-4090-a utilization above 85%',
    description: 'openlog_gpu_utilization_percent{host="srv-4090-a",gpu="1"} = 91.4 for 6m',
  },
  state: 'firing',
  activeAtMsAgo: 6 * MINUTE + 12 * SECOND,
  value: 91.4,
});

const ALERT_SCRAPE_DOWN = alertObject({
  name: 'ScrapeTargetDown',
  severity: 'critical',
  labels: { host: 'srv-t4-2', instance: '10.20.30.31:9100' },
  annotations: {
    summary: 'Node exporter target srv-t4-2 is down',
    description: 'scrape failed: dial tcp 10.20.30.31:9100: i/o timeout (last success 2d 3h ago)',
  },
  state: 'firing',
  activeAtMsAgo: 2 * 24 * 60 * MINUTE + 3 * 60 * MINUTE,
  value: 0,
});

const ALERT_GPU_MEM = alertObject({
  name: 'GPUMemoryNearlyFull',
  severity: 'warning',
  labels: { host: 'srv-4090-a', gpu: '0' },
  annotations: {
    summary: 'GPU 0 on srv-4090-a memory usage above 90%',
    description: 'openlog_gpu_memory_used_bytes{host="srv-4090-a",gpu="0"} = 22.4GiB / 24GiB',
  },
  state: 'pending',
  activeAtMsAgo: 90 * SECOND,
  value: 0.912,
});

/**
 * `GET /api/v1/rules` 的演示数据。
 * 形状照抄路由：groups[] → { name, file, interval, lastEvaluation, rules[] }，
 * rules 分 alerting（带 alerts[]、state）与 recording（seriesCount）。
 * query 字段真实实现里恒为 `''`（快照里没存表达式），这里也留空 —— 但会附上
 * 足以看懂的告警名/标签。
 */
export function demoTsdbRules() {
  const alerting = (rule) => ({
    name: rule.name,
    type: 'alerting',
    health: 'ok',
    query: '',
    state: rule.state,
    alerts: rule.state === 'inactive' ? [] : [clone(rule)],
  });

  return {
    groups: [
      {
        name: 'gpu-inference',
        file: 'openlog-rules',
        interval: '30s',
        lastEvaluation: iso(8 * SECOND),
        rules: [
          {
            name: 'openlog:gpu_utilization:avg1m',
            type: 'recording',
            health: 'ok',
            seriesCount: 10,
          },
          alerting(ALERT_GPU_HOT),
          alerting(ALERT_GPU_MEM),
          {
            name: 'GPUKVcacheEviction',
            type: 'alerting',
            health: 'ok',
            query: '',
            state: 'inactive',
            alerts: [],
          },
        ],
      },
      {
        name: 'node-health',
        file: 'openlog-rules',
        interval: '30s',
        lastEvaluation: iso(8 * SECOND),
        rules: [
          {
            name: 'openlog:node_cpu:rate5m',
            type: 'recording',
            health: 'ok',
            seriesCount: 3,
          },
          alerting(ALERT_SCRAPE_DOWN),
          {
            name: 'DiskFillingUp',
            type: 'alerting',
            health: 'err',
            query: '',
            state: 'inactive',
            alerts: [],
          },
        ],
      },
    ],
  };
}

/**
 * `GET /api/v1/alerts` 的演示数据。
 * 只回 firing/pending 的告警（真实实现就是 `engine.firing()`，pending 也会被
 * 抑制/静默规则放行后出现在这里；这里给 2 firing + 1 pending）。
 */
export function demoTsdbAlerts() {
  return { alerts: [clone(ALERT_GPU_HOT), clone(ALERT_SCRAPE_DOWN), clone(ALERT_GPU_MEM)] };
}

/**
 * `GET /api/v1/alert_groups` 的演示数据。
 * 形状照抄 `groupAlerts()` 的输出：groups[] → { labels: groupBy, alerts[] }，
 * 组内告警只有 labels/annotations/value（没有 state/activeAt）。
 * 路由默认按 `['alertname']` 分组，演示数据按 `['alertname','severity']` 分，
 * 两种口径下组数一致（每条告警名唯一）。
 */
export function demoTsdbAlertGroups() {
  const groups = new Map();
  for (const a of [ALERT_GPU_HOT, ALERT_SCRAPE_DOWN, ALERT_GPU_MEM]) {
    const { alertname, severity } = a.labels;
    const key = `${alertname}\u0001${severity}`;
    if (!groups.has(key)) groups.set(key, { labels: { alertname, severity }, alerts: [] });
    groups.get(key).alerts.push({
      labels: clone(a.labels),
      annotations: clone(a.annotations),
      value: a.value,
    });
  }
  return { groups: [...groups.values()] };
}

// ─── TSDB：状态与自身暴露 ─────────────────────────────────────────────────

/** 序列 → 数值（确定性：由标签串算出 base，再叠一点定点噪声） */
function sampleValue(series) {
  const key = `${series.__name__}|${series.host || ''}|${series.gpu || ''}|${series.state || ''}`;
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const jitter = ((h % 200) - 100) / 100; // -1.00 .. 0.99

  switch (series.__name__) {
    case 'openlog_cpu_usage_percent': return Number((41 + jitter * 9).toFixed(2));
    case 'openlog_memory_usage_percent': return Number((68.5 + jitter * 4.5).toFixed(2));
    case 'openlog_disk_usage_percent': return Number((74 + jitter * 1.2).toFixed(2));
    case 'openlog_gpu_utilization_percent': return Number((66 + jitter * 14).toFixed(2));
    case 'openlog_gpu_memory_used_bytes': return Math.round(19_800_000_000 + jitter * 2_400_000_000);
    case 'openlog_docker_containers_total': return series.state === 'running' ? 5 : 1;
    default: return Number((187_240 + jitter * 900).toFixed(0));
  }
}

/**
 * `GET /metrics` 的演示数据 —— 一段合法的 Prometheus 文本暴露格式。
 *
 * 用真实的 `parseExposition()` 能零错误解析回来（测试里就是这么断言的）：
 * 少写一个 `# TYPE` 或标签引号不配对，Grafana 面板就会静默空白。
 *
 * @returns {string}
 */
export function demoMetricsExposition() {
  const lines = [
    `# OPENLOG_DEMO=1 演示数据：未连接任何真实服务器（${DEMO_OBS_NOW}）`,
  ];
  let currentMetric = '';
  for (const s of TSDB_SERIES) {
    if (s.__name__ !== currentMetric) {
      currentMetric = s.__name__;
      const meta = TSDB_METRICS[currentMetric] || { type: 'gauge', help: currentMetric };
      lines.push(`# HELP ${currentMetric} ${meta.help}`);
      lines.push(`# TYPE ${currentMetric} ${meta.type}`);
    }
    const labelText = Object.entries(s)
      .filter(([k]) => k !== '__name__')
      .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',');
    const value = sampleValue(s);
    lines.push(`${currentMetric}{${labelText}} ${value}`);
  }
  // 抓取耗时直方图：/metrics 里最典型的 histogram 形状，前端可能按 le 画分位数
  lines.push('# HELP openlog_scrape_duration_seconds Scrape round duration in seconds');
  lines.push('# TYPE openlog_scrape_duration_seconds histogram');
  for (const [le, count] of [['0.01', 41], ['0.05', 138], ['0.1', 176], ['+Inf', 180]]) {
    lines.push(`openlog_scrape_duration_seconds_bucket{instance="openlog-demo",le="${le}"} ${count}`);
  }
  lines.push('openlog_scrape_duration_seconds_sum{instance="openlog-demo"} 1.874');
  lines.push('openlog_scrape_duration_seconds_count{instance="openlog-demo"} 180');
  return `${lines.join('\n')}\n`;
}

/**
 * `GET /api/tsdb/status` 的演示数据。
 *
 * 形状与真实实现一致：`{ storage, scraper, rules }`，三者都是「有就带」的可空段。
 * 字段名照抄 `tsdb/store.js#stats`、`tsdb/scrape.js#stats`、规则引擎快照。
 */
export function demoTsdbStatus() {
  const nowSec = Math.floor(NOW_MS / 1000);
  return {
    storage: {
      ready: true,
      error: null,
      dbType: 'sqlite',
      seriesCount: TSDB_SERIES.length,
      sampleCount: TSDB_SERIES.length * 60 * 6,
      oldestMs: (nowSec - 6 * 3600) * 1000,
      newestMs: nowSec * 1000,
      cachedSeries: TSDB_SERIES.length,
    },
    scraper: {
      rounds: 720,
      scrapes: 2158,
      failures: 96,
      samples: 1_294_080,
      lastRoundMs: (nowSec - 8) * 1000,
      lastError: 'dial tcp 10.20.30.31:9100: i/o timeout',
      running: true,
      stopped: false,
      targetCount: TSDB_HOSTS.length,
    },
    rules: {
      lastEvalMs: (nowSec - 8) * 1000,
      alertCount: 3,
      firingCount: 2,
    },
  };
}
