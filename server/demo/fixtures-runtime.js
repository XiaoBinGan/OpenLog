/**
 * server/demo/fixtures-runtime.js —— 演示模式的「运行态」假数据（纯数据 + 纯函数）
 *
 * 与 `server/demo/fixtures.js` 同一套约定，只是负责另一半面板：本机监控
 * （/api/monitor/*）与日志分析历史（/api/analysis/*）。三条硬约束照抄：
 *
 * 1. **形状与真实实现逐字段对齐**（每个导出上面都写了「照哪个文件抄的」）：
 *    - `demoLocalStats()`    ← `routes/monitor.js#collectSystemStats` 的 return
 *    - `demoMonitorHistory()`← `index.js#startMonitor` 写进 monitorHistory 的元素
 *    - `demoAnalysisHistory()` / `demoAnalysisBrief()` / `demoAnalysisStatus()`
 *                            ← `index.js#runAnalysis` / `routes/docker.js` 的
 *                              `addAnalysisRecord({...})` 调用点 / `routes/analysis.js`
 * 2. **纯函数 + 常量表**：不联网、不读文件、不 import 任何其它模块（包括 fixtures.js ——
 *    两个文件并行开发，互相 import 只会把「一边改坏另一边」的风险做出来）。
 * 3. **确定性**：时间全部从 DEMO_NOW 派生（不是 Date.now()），噪声用固定种子的
 *    线性同余。同一函数调两次必须 deepEqual —— 否则前端 30 秒轮询会看到曲线自己乱抖，
 *    测试也没法断言。
 *
 * 数据视角：这台「本机」就是演示里的主力机 —— 64 核 / 128 GiB / 两块 NVMe /
 * eth0 / 4×RTX 4090，跑着 vLLM 推理 + 一整套依赖（redis / postgres / nginx）。
 * 四张卡的数值与 fixtures.js 里 `srv-4090-a` 一致，所以「本机」和「远程 4090×4」
 * 在演示里看到的是同一台机器的两张皮，不会出现两页数据互相打架。
 */

// ─── 时间基准 ──────────────────────────────────────────────────────────────

/**
 * 时间锚点，与 `server/demo/fixtures.js#DEMO_NOW` **取同一个值**。
 * 这里刻意复制常量而不是 import：两个文件独立演进，值本身是契约的一部分
 * （两个面板的时间轴要对得上），改成"谁 import 谁"反而会让并行开发互相踩。
 */
export const DEMO_NOW = '2026-06-08T09:48:37.000Z';

const NOW_MS = Date.parse(DEMO_NOW);
const SECOND = 1000;
const GiB = 1024 ** 3;

/** NOW 之前 msAgo 毫秒的 ISO 时间（不允许"未来"数据） */
const iso = (msAgo) => new Date(NOW_MS - Math.max(0, msAgo)).toISOString();

/** 深拷贝：调用方 mutate 不会污染常量表 */
const clone = (value) => JSON.parse(JSON.stringify(value));

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/** 确定性伪随机（线性同余，与 fixtures.js 同款）：同 seed 永远同一串值 */
function seededNoise(seed, count) {
  let state = (seed >>> 0) || 1;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out.push(state / 4294967296);
  }
  return out;
}

/** 带轻微噪声的正弦序列（柱状面板要"像真的在动"，但不能随机） */
function waveSeries({ seed, count, base, amp, noise, min = 0, max = Infinity }) {
  const raw = seededNoise(seed, count);
  return raw.map((n, i) => {
    const wave = Math.sin((i / count) * Math.PI * 2) * amp;
    const jitter = (n - 0.5) * 2 * noise;
    return Math.min(max, Math.max(min, base + wave + jitter));
  });
}

// ─── 本机监控快照（/api/monitor/stats）────────────────────────────────────

/**
 * 64 个核心的负载。
 *
 * 真实机器上不会 64 核同负载：vLLM 的 8 个 TP worker + 2 个预处理进程压在
 * 前 16 核上（80~95%），postgres / redis / 日志写入压在中段（20~50%），
 * 后 24 核基本空闲。这样前端的热力条/cpu.cores 才有"真的在跑东西"的样子。
 */
function demoCoreLoads() {
  const noise = seededNoise(0x4090, 64);
  return noise.map((n, i) => {
    if (i < 16) return round1(84 + n * 11);          // 推理 worker
    if (i < 40) return round1(18 + n * 32);          // 依赖服务 / 日志
    return round1(n * 6);                            // 空闲核
  });
}

/**
 * 四张 4090 的即时状态。
 *
 * **只有 5 个字段**：`{ index, name, util, memUsed, memTotal, temp }`。
 * 这是 `readLocalGpus()` 解 `nvidia-smi --query-gpu` 的结果 —— 本机分支没有
 * `processes` 数组（那是 SSH/远程分支 `buildRemoteGPUPayload` 才有的），
 * 多给一个字段前端不会报错，但会让「本机 vs 远程」两条渲染路径悄悄分叉。
 * 单位照 nvidia-smi 原始量纲：显存 MiB、温度 ℃、util %。
 */
const LOCAL_GPUS = [
  { index: 0, name: 'NVIDIA GeForce RTX 4090', util: 78, memUsed: 21450, memTotal: 24564, temp: 71 },
  { index: 1, name: 'NVIDIA GeForce RTX 4090', util: 88, memUsed: 22100, memTotal: 24564, temp: 76 },
  { index: 2, name: 'NVIDIA GeForce RTX 4090', util: 61, memUsed: 18240, memTotal: 24564, temp: 68 },
  { index: 3, name: 'NVIDIA GeForce RTX 4090', util: 34, memUsed: 9420, memTotal: 24564, temp: 57 },
];

/** 8 个进程：vLLM 主/worker、依赖服务、日志代理。cpu/mem 都是百分比（si 的量纲） */
const LOCAL_PROCESSES = [
  { pid: 12043, name: 'python3', cpu: 312.4, mem: 18.7 },
  { pid: 12044, name: 'python3', cpu: 298.1, mem: 17.9 },
  { pid: 12045, name: 'VLLM::EngineCore', cpu: 96.3, mem: 4.2 },
  { pid: 12091, name: 'python3', cpu: 44.8, mem: 2.6 },
  { pid: 2210, name: 'postgres', cpu: 12.5, mem: 6.1 },
  { pid: 1884, name: 'redis-server', cpu: 3.2, mem: 0.8 },
  { pid: 940, name: 'nginx', cpu: 1.7, mem: 0.3 },
  { pid: 731, name: 'openlog', cpu: 8.9, mem: 1.4 },
];

/**
 * `GET /api/monitor/stats` 的完整响应体。
 *
 * 照 `routes/monitor.js#collectSystemStats` 的 return 逐字段抄：
 *   cpu{load,cores[]} / memory{used,total,free,percent} / disk[{name,used,total,usePercent}]
 *   / network[{iface,rx,tx}] / processes[{pid,name,cpu,mem}] / gpus[] / capacityAlerts[]
 *   / capacityThresholds{} / capacitySnoozeMinutes / processCount / uptime
 *
 * 这里**故意没有容量告警**：内存 47.8%、盘最大 63.7%，都没到阈值（90% / 80%）。
 * 演示要展示"健康态长什么样"，告警条留给真实的阈值设置页去演示。
 */
export function demoLocalStats() {
  const total = 128 * GiB;
  const used = 61.2 * GiB;
  return {
    cpu: { load: 37.6, cores: demoCoreLoads() },
    memory: {
      used: Math.round(used),
      total,
      free: Math.round(total - used),
      percent: round1((used / total) * 100),
    },
    // 两块盘：系统盘 / + 数据盘 /data（vLLM 权重与日志都在 /data）
    disk: [
      { name: '/dev/nvme0n1p2', used: 412_000_000_000, total: 1_000_000_000_000, usePercent: 41.2 },
      { name: '/dev/nvme1n1p1', used: 2_445_000_000_000, total: 3_840_000_000_000, usePercent: 63.7 },
    ],
    // rx/tx 是 si.networkStats() 的 rx_sec / tx_sec（字节/秒）
    network: [{ iface: 'eth0', rx: 12_582_912, tx: 3_145_728 }],
    processes: clone(LOCAL_PROCESSES),
    gpus: clone(LOCAL_GPUS),
    capacityAlerts: [],
    capacityThresholds: { memoryPercent: 90, diskPercent: 80 },
    capacitySnoozeMinutes: 60,
    // si.processes().all —— 系统进程总数，不是上面 8 条的条数
    processCount: 412,
    // si.time().uptime 是秒
    uptime: 1_036_800,
  };
}

// ─── 监控历史（/api/monitor/history）──────────────────────────────────────

/** 演示历史点数：Monitor 页要 60 点，Dashboard 要 30 点，这里一次给够 */
export const DEMO_HISTORY_POINTS = 60;
/** 相邻两点的间隔（30 秒 → 60 点覆盖最近 30 分钟） */
const HISTORY_STEP_MS = 30 * SECOND;

/** 曲线基线：与 demoLocalStats() 的当前值对齐，最后一点就是"现在" */
const HISTORY_SERIES = {
  cpu: { seed: 61, base: 37.6, amp: 6.4, noise: 1.7 },
  memory: { seed: 128, base: 47.8, amp: 1.1, noise: 0.35 },
  disk: { seed: 412, base: 41.2, amp: 0.05, noise: 0.03 },
  network: { seed: 4090, base: 15_728_640, amp: 5_242_880, noise: 1_048_576 },
  gpuUtil: { seed: 8837, base: 65.3, amp: 8.6, noise: 3.1 },
};

/**
 * `GET /api/monitor/history` 的响应体（数组，最新的在前）。
 *
 * ⚠️ 元素形状**不是** stats 的形状，照抄的是 `index.js#startMonitor` 写进
 * monitorHistory 的那份「折线图专用简化版」：
 *   `{ timestamp, cpu: number, memory: number(百分比), disk: number(第一块盘 usePercent),
 *      network: number(rx+tx 字节/秒), gpuUtil: number }`
 * 依据三处：`index.js:1128-1146` 的写入点、`client/src/types.ts:143` 的
 * `MonitorHistory` 接口、`client/src/pages/{Monitor,Dashboard}.tsx` 的
 * `dataKey="cpu" / "network"` —— 前端把 cpu 当数字直接画，给对象会白屏。
 * 契约描述里写的"与 stats 同形"是笔误，这里按真实实现走。
 *
 * 唯一的额外字段是 `demo: true`：数组响应体承载不了标记（`demoJson()` 对数组原样
 * 返回），所以逐条挂上 —— 与 `routes/logs.js` 的 `/api/logs/files` 同一处理方式。
 *
 * @param {number} [limit] 取最近多少点（非法值按 100 处理，上限 60 = 演示点总数）
 * @returns {Array<object>}
 */
export function demoMonitorHistory(limit) {
  const raw = Number(limit);
  const want = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), DEMO_HISTORY_POINTS) : 100;
  const take = Math.min(want, DEMO_HISTORY_POINTS);

  const series = Object.fromEntries(
    Object.entries(HISTORY_SERIES).map(([key, cfg]) => [
      key,
      waveSeries({ ...cfg, count: DEMO_HISTORY_POINTS, min: 0, max: key === 'network' ? Infinity : 100 }),
    ]),
  );

  const points = [];
  for (let i = 0; i < DEMO_HISTORY_POINTS; i += 1) {
    // 第 0 个点最旧、最后一个点是"现在"，与 monitorHistory.unshift 后的顺序一致
    const ageMs = (DEMO_HISTORY_POINTS - 1 - i) * HISTORY_STEP_MS;
    points.push({
      timestamp: iso(ageMs),
      cpu: round1(series.cpu[i]),
      memory: round1(series.memory[i]),
      disk: round2(series.disk[i]),
      network: Math.round(series.network[i]),
      gpuUtil: round1(series.gpuUtil[i]),
      demo: true,
    });
  }
  return points.slice(-take);
}

// ─── 分析历史（/api/analysis/*）──────────────────────────────────────────

/**
 * 六条分析记录。字段照 `addAnalysisRecord({...})` 的两个真实调用点：
 *
 * - 日志分析（`index.js:1068-1085` / `1093-1110`）：
 *   `{ id, timestamp, sourceId, sourceName, log, analysis, status, model[, error] }`
 *   —— 没有 `type` / `summary`，摘要由 brief 端点回退到 `log.message`。
 * - 容器巡检 / 健康诊断（`routes/docker.js:586,732`）：
 *   `{ id, timestamp, type, sourceName, analysis, summary, status, model[, error] }`
 *   —— 没有 `sourceId` / `log`。
 *
 * 顺序即 `analysisHistory.unshift` 后的顺序（最新在前）。相邻记录的
 * type+sourceName+status 不同且时间跨度远大于 5 秒，不会被 addAnalysisRecord 的
 * 去重逻辑当成重复条目 —— 演示数据也要能通过真实去重规则。
 *
 * 内容贴近 GPU 推理运维现场：OOM(137)、首 token 变慢、GPU 利用率掉 0、
 * 显存碎片、CrashLoopBackOff、以及一条**失败**记录（模型 429 限流）。
 */
const ANALYSIS_RECORDS = [
  {
    id: 'demo-rec-5f1c8e42',
    timestamp: iso(3 * 60 * SECOND),
    sourceId: 'log-vllm-engine',
    sourceName: 'vLLM 推理服务日志',
    log: {
      id: 'demo-log-9f21',
      timestamp: iso(4 * 60 * SECOND),
      level: 'ERROR',
      message: 'CUDA out of memory. Tried to allocate 2.00 GiB (GPU 1; 23.62 GiB total capacity; '
        + '1.31 GiB already allocated; 21.87 GiB free; 1.44 GiB reserved in total by PyTorch)',
      source: '/data/logs/vllm-engine.log',
      metadata: JSON.stringify({ raw: 'EngineCore pid=12044 worker=gpu1' }),
    },
    analysis: [
      '## 🔍 根因分析',
      'GPU 1 上的 vLLM EngineCore 在扩容 KV cache 时申请 2 GiB 连续显存失败',
      '：`--gpu-memory-utilization 0.95` 把 21.9 GiB 预留给权重与 KV cache，',
      '并发涨到 32 时 block table 扩容需要新的连续段，而 PyTorch 的 1.44 GiB',
      'reserved 已碎片化，于是 OOM（不是真的把卡用满了）。',
      '',
      '## 💡 修复建议',
      '1. 把 `--gpu-memory-utilization` 从 0.95 降到 0.88，留 1.5 GiB 余量给碎片与 CUDA context。',
      '2. `--max-num-seqs` 从 64 降到 48，或开 `--enable-prefix-caching` 降低 block 波动。',
      '3. 设 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` 缓解碎片。',
      '4. 长期方案：按 24 GiB/卡 规划并发，或换 2×A100 40G 做 TP=2。',
    ].join('\n'),
    status: 'done',
    model: 'qwen2.5-14b-instruct',
  },
  {
    id: 'demo-rec-3a77b0d1',
    timestamp: iso(26 * 60 * SECOND),
    type: 'patrol',
    sourceName: '容器巡检 · 8 个容器',
    analysis: [
      '## 🔍 根因分析',
      '`vllm-4090-a` 处于 `exited(137)`：13:41 被内核 OOM killer 杀掉，',
      '同一时刻 `dmesg` 有 `Out of memory: Killed process 12043 (python3)`。',
      '宿主内存 128 GiB，但 `--swap-space 8` 加 8 个 EngineCore 后常驻 121 GiB，',
      '再叠加 postgres 的 shared_buffers 就会击穿。另外 `sglang-t4` 在 CrashLoopBackOff',
      '（重启 7 次），原因是 `--tp-size 2` 与单卡 T4 的配置不匹配。',
      '',
      '## 💡 修复建议',
      '1. 给 vLLM 容器加 `--memory=96g --memory-swap=96g`，别让一个容器吃掉整机内存。',
      '2. `--swap-space` 降到 2，KV cache 用显存不占宿主内存。',
      '3. sglang-t4 去掉 `--tp-size` 或改为 1，再看是否仍在 30 秒内重启。',
      '4. 给 exited(137) 配 `--restart on-failure:3`，避免手动拉起来之前服务长期缺 1/4 算力。',
    ].join('\n'),
    summary: '8 个容器：6 running / 1 exited(137) OOM / 1 restarting(CrashLoopBackOff)',
    status: 'done',
    model: 'qwen2.5-14b-instruct',
  },
  {
    id: 'demo-rec-7c40a9ef',
    timestamp: iso(72 * 60 * SECOND),
    sourceId: 'log-vllm-engine',
    sourceName: 'vLLM 推理服务日志',
    log: {
      id: 'demo-log-b7d3',
      timestamp: iso(74 * 60 * SECOND),
      level: 'WARN',
      message: 'Avg prompt throughput: 214.7 tokens/s, Avg generation throughput: 1182.4 tokens/s, '
        + 'Running: 48 reqs, Pending: 21 reqs, GPU KV cache usage: 96.4%, '
        + 'Preemption: 8, TTFT p99 = 2417 ms (baseline 320 ms)',
      source: '/data/logs/vllm-engine.log',
      metadata: JSON.stringify({ raw: 'metrics snapshot interval=10s' }),
    },
    analysis: [
      '## 🔍 根因分析',
      'TTFT p99 从 320 ms 涨到 2.4 s，但生成吞吐仍正常（1182 tokens/s）——',
      '瓶颈在 **prefill 排队**，不在 decode。`Pending: 21 reqs` + `GPU KV cache usage: 96.4%`',
      '+ `Preemption: 8` 说明 KV cache 已接近打满，调度器开始抢占，新请求必须等',
      '一整批 prefill 才能进 decode。触发点是 48 并发超过了 4090 单卡 24 GiB 在',
      '`max-model-len 8192` 下能撑的 block 数。',
      '',
      '## 💡 修复建议',
      '1. 短期：`--max-num-seqs 32`，把 KV cache 使用率压到 80% 以下，TTFT 立刻回落。',
      '2. 开 `--enable-chunked-prefill`，长 prompt 不再独占整批 prefill。',
      '3. 开 `--enable-prefix-caching`（系统提示词固定，命中率会很高）。',
      '4. 若长上下文是刚需：`--max-model-len 4096` + 按需扩到 TP=2。',
    ].join('\n'),
    status: 'done',
    model: 'qwen2.5-14b-instruct',
  },
  {
    id: 'demo-rec-1b95c6aa',
    timestamp: iso(185 * 60 * SECOND),
    type: 'health',
    sourceName: '健康诊断 · 2 个问题容器',
    analysis: [
      '## 🔍 根因分析',
      '1. `vllm-4090-a`：GPU 3 利用率长时间 0%，`nvidia-smi` 显示 `GPU has fallen off the bus`',
      '（Xid 79），进程还在但 CUDA context 已失效 —— 典型的供电/PCIe 接触问题，',
      '不是模型代码问题。',
      '2. `redis-cache`：`maxmemory-policy allkeys-lru` 未设置，内存涨到 6.1 GiB 后开始',
      '触发 `OOM command not allowed when used memory > maxmemory`。',
      '',
      '## 💡 修复建议',
      '1. GPU 3 需要重启宿主机（或 `nvidia-smi -r -i 3`）；若复现，换 PCIe 槽位并检查 12VHPWR。',
      '2. 重启后先跑 `nvidia-smi --query-gpu=index,memory.total --format=csv` 确认 4 张卡都在。',
      '3. redis 加 `--maxmemory 4gb --maxmemory-policy allkeys-lru`。',
      '4. 给 Xid 79 加告警：`nvidia-smi --query-gpu=index --format=csv` 少一张就推消息。',
    ].join('\n'),
    summary: '2 个问题容器：vllm-4090-a（Xid 79 掉卡）/ redis-cache（maxmemory 未设置）',
    status: 'done',
    model: 'qwen2.5-14b-instruct',
  },
  {
    id: 'demo-rec-8e2d4417',
    timestamp: iso(400 * 60 * SECOND),
    sourceId: 'log-sglang-batch',
    sourceName: '批量任务日志',
    log: {
      id: 'demo-log-4c8a',
      timestamp: iso(402 * 60 * SECOND),
      level: 'ERROR',
      message: 'torch.OutOfMemoryError: CUDA out of memory. '
        + 'Tried to allocate 512.00 MiB (GPU 0; 14.56 GiB total capacity; 13.94 GiB already allocated)',
      source: '/data/logs/sglang-batch.log',
      metadata: JSON.stringify({ raw: 'batch jid=20260608-0312' }),
    },
    analysis: [
      '## 🔍 根因分析',
      '批量任务与在线推理共用 T4 4 卡机的 GPU 0：在线侧常驻 13.9 GiB，批量任务再申请',
      '512 MiB 就失败。这是**资源争抢**，不是泄漏 —— 批量任务本应错峰或限卡。',
      '',
      '## 💡 修复建议',
      '1. 批量任务用 `CUDA_VISIBLE_DEVICES=2,3` 固定到空闲卡，别和在线服务抢 GPU 0。',
      '2. 或给批量任务加 `--batch-size 8`（原 32），把峰值显存压到 4 GiB 级。',
      '3. 更彻底：把批量任务挪到 K8s 的 `inference-batch` 命名空间，用 nvidia.com/gpu 配额隔离。',
    ].join('\n'),
    status: 'done',
    model: 'qwen2.5-7b-instruct',
  },
  {
    id: 'demo-rec-2d6f83bb',
    timestamp: iso(21 * 60 * 60 * SECOND),
    sourceId: 'log-sglang-batch',
    sourceName: '批量任务日志',
    log: {
      id: 'demo-log-e1b2',
      timestamp: iso(21 * 60 * 60 * SECOND + 4 * SECOND),
      level: 'ERROR',
      message: 'OpenAI API error: 429 Too Many Requests — rate limit exceeded for '
        + 'qwen2.5-14b-instruct (tokens per min: 240000)',
      source: '/data/logs/sglang-batch.log',
      metadata: JSON.stringify({ raw: 'retry 3/3 exhausted' }),
    },
    analysis: null,
    status: 'error',
    error: '分析模型返回 429：tokens per minute 超限（240000 TPM）',
    model: 'qwen2.5-14b-instruct',
  },
];

/** 演示分析历史（副本，调用方随便改） */
function demoRecords() {
  return clone(ANALYSIS_RECORDS);
}

/**
 * `GET /api/analysis/history` → `{ records, total }`。
 *
 * 过滤/分页语义照 `routes/analysis.js:49-57` 逐条对齐：
 * `sourceId` / `status` 先过滤，`total` 是**过滤后、分页前**的条数，
 * `offset`/`limit` 用 `parseInt` 的默认值（0 / 50）兜底。
 *
 * @param {{sourceId?: string, status?: string, limit?: number|string, offset?: number|string}} [opts]
 * @returns {{records: Array<object>, total: number}}
 */
export function demoAnalysisHistory(opts = {}) {
  const { sourceId, status, limit = 50, offset = 0 } = opts || {};
  let records = demoRecords();
  if (sourceId) records = records.filter((r) => r.sourceId === sourceId);
  if (status) records = records.filter((r) => r.status === status);
  const total = records.length;
  const start = parseInt(offset, 10) || 0;
  const take = parseInt(limit, 10);
  const size = Number.isFinite(take) ? take : 50;
  return { records: records.slice(start, start + size), total };
}

/**
 * `GET /api/analysis/history/brief` → `{ records: [...] }`。
 *
 * 逐字段照 `routes/analysis.js:60-71` 的 map：`type` 缺省回落 `'log'`，
 * `summary` 回落 `log.message` 并截断到 120 字。这里重算而不是查表，
 * 是为了保证「brief 与 history 的同一 id 内容一致」这件事在演示数据上也成立。
 *
 * @returns {{records: Array<{id: string, timestamp: string, type: string, sourceName: string,
 *   summary: string, status: string, model: string}>}}
 */
export function demoAnalysisBrief() {
  const records = demoRecords().slice(0, 30).map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    type: r.type || 'log',
    sourceName: r.sourceName,
    summary: (r.summary || r.log?.message || '').slice(0, 120),
    status: r.status,
    model: r.model,
  }));
  return { records };
}

/**
 * `GET /api/analysis/status` → `{ queues, totalPending }`。
 *
 * 形状照 `routes/analysis.js:16-25`。演示里 3 个源，1 个在跑、2 个排队 ——
 * 空队列会让「分析队列」面板看起来像功能坏了。
 */
export function demoAnalysisStatus() {
  return {
    queues: {
      'log-vllm-engine': { pending: 2, running: true },
      'log-sglang-batch': { pending: 0, running: false },
      'log-nginx-access': { pending: 1, running: false },
    },
    totalPending: 3,
  };
}
