/**
 * server/demo/fixtures-assistant.js —— 演示模式的「助手侧」假数据（纯数据 + 纯函数）
 *
 * 与 `server/demo/fixtures.js` / `fixtures-runtime.js` / `fixtures-observability.js`
 * 同一套约定，负责最后剩下的一批空白面板：
 *
 *   demoMachines()      ← `db/index.js#listMachines`（machines 表的行）
 *   demoAlertConfigs()  ← `db/index.js#listAlertConfigs`（alert_configs 表的行）
 *   demoMemoryFiles()   ← `routes/assistant-memory.js#GET /api/assistant/memory` 的元素
 *   demoChatReply()     ← `POST /api/chat` 在演示模式下的固定回复（纯文本）
 *   demoChatChunks()    ← 同一段回复按固定长度切片（**确定性**，同一问题同一字节流）
 *   demoChatStream()    ← 把切片包成 openai 形状的 chunk 流，交给
 *                         `llm-stream.js#pipeChatStreamToSSE` 复用现有的 SSE 管线
 *
 * 三条硬约束（照抄 fixtures.js）：
 * 1. **形状与真实实现逐字段对齐**，每个导出上面都写了「照哪个文件抄的」；
 * 2. **纯函数 + 常量表**：不联网、不读文件、不 import 任何其它模块
 *    （并行开发，互相 import 只会把「一边改坏另一边」的风险做出来）；
 * 3. **确定性**：时间全部从 DEMO_ASSISTANT_NOW 派生（不是 Date.now()），
 *    同一函数调两次 deepEqual —— 前端 30 秒轮询不能看到列表自己乱跳。
 *
 * 演示里没有真机、没有模型：这些数据唯一的作用是让面板不空白，并且**能被一眼
 * 认出来是演示**（`demo: true` 标记 + 助手回复里的「演示模式」字样与 `[demo]` 尾标）。
 */

// ─── 时间基准 ──────────────────────────────────────────────────────────────

/**
 * 时间锚点，与 `server/demo/fixtures.js#DEMO_NOW` 取同一个值。
 * 刻意复制常量而不是 import：值本身是契约（各面板时间轴要对得上），
 * 改成「谁 import 谁」会让并行开发互相踩。
 */
export const DEMO_ASSISTANT_NOW = '2026-06-08T09:48:37.000Z';

const NOW_MS = Date.parse(DEMO_ASSISTANT_NOW);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** NOW 之前 msAgo 毫秒的 epoch **秒**（machines / alert_configs 的时间列都是秒） */
const epochSec = (msAgo) => Math.floor((NOW_MS - Math.max(0, msAgo)) / 1000);

/** NOW 之前 msAgo 毫秒的 epoch **毫秒**（记忆文件用 stat.mtimeMs，是毫秒） */
const epochMs = (msAgo) => NOW_MS - Math.max(0, msAgo);

/** 深拷贝：调用方 mutate 不会污染常量表 */
const clone = (value) => JSON.parse(JSON.stringify(value));

// ─── 日志机器（对应 GET /api/machines）─────────────────────────────────────

/**
 * 形状照 `db/index.js#listMachines`：`SELECT * FROM machines` 的行，
 * 列见 `machines` 建表语句 —— id / type / name / host / port / ssh_user /
 * log_path / created_at / updated_at（时间列是 epoch 秒）。
 *
 * `id` 刻意用**演示远程服务器的 id**（`srv-4090-a` 等，见 fixtures.js#SERVERS）：
 * 设置页的告警面板是「/api/remote/servers 拿机器 + /api/alerts 拿规则，
 * 用 machine_id 对上的」，两边 id 一致，演示里的告警规则才会挂到对应机器上，
 * 而不是列出一堆对不上号的孤儿配置。
 *
 * 三台机器与 fixtures.js#SERVERS 同名同 IP 同登录用户：
 *   4090×4（在线）/ 4卡T4（在线）/ 双卡T4（离线，SSH 2 天没连上）。
 */
const MACHINES = [
  {
    id: 'srv-4090-a',
    type: 'ssh',
    name: '4090×4',
    host: '10.20.30.11',
    port: 22,
    ssh_user: 'ops',
    log_path: '/data/logs',
    created_at: epochSec(30 * DAY + 5 * MINUTE),
    updated_at: epochSec(2 * MINUTE),
  },
  {
    id: 'srv-t4-4',
    type: 'ssh',
    name: '4卡T4',
    host: '10.20.30.21',
    port: 22,
    ssh_user: 'ops',
    log_path: '/data/logs',
    created_at: epochSec(30 * DAY + 3 * MINUTE),
    updated_at: epochSec(6 * MINUTE),
  },
  {
    id: 'srv-t4-2',
    type: 'ssh',
    name: '双卡T4',
    host: '10.20.30.31',
    port: 22,
    ssh_user: 'ops',
    log_path: '/data/logs',
    created_at: epochSec(30 * DAY + 1 * MINUTE),
    // 离线机器保留最后一次成功采集的时间（与 fixtures.js 的 lastConnected 一致）
    updated_at: epochSec(2 * DAY + 3 * HOUR),
  },
];

/** 对应 `GET /api/machines` 的 `machines` 数组 */
export function demoMachines() {
  return clone(MACHINES);
}

// ─── 告警配置（对应 GET / api/alerts）──────────────────────────────────────

/**
 * 形状照 `db/index.js#listAlertConfigs`：`SELECT * FROM alert_configs` 的行，
 * 列见建表语句 —— id / machine_id / enabled / patterns / severity_filter /
 * cooldown_minutes / webhook_url / created_at / updated_at。
 *
 * `enabled` 用 1/0 而不是 true/false：默认库是 sqlite，INTEGER 列查出来就是 1/0，
 * 前端按真值判断（`!!cfg.enabled`）两种都能跑，但形状要跟真实返回一致。
 *
 * patterns 是逗号分隔的日志匹配串（真实配置就是这么存的一整串），
 * 内容取自 GPU 推理集群最常炸的几类：Python OOM、CUDA OOM、Xid 硬件错误。
 */
const ALERT_CONFIGS = [
  {
    id: 'alert-4090-a',
    machine_id: 'srv-4090-a',
    enabled: 1,
    patterns: 'OutOfMemoryError,CUDA out of memory,Xid',
    severity_filter: 'ERROR',
    cooldown_minutes: 5,
    webhook_url: '',
    created_at: epochSec(21 * DAY),
    updated_at: epochSec(3 * HOUR),
  },
  {
    id: 'alert-t4-4',
    machine_id: 'srv-t4-4',
    enabled: 1,
    patterns: 'CUDA out of memory,Xid,CUDA error: an illegal memory access',
    severity_filter: 'ERROR',
    cooldown_minutes: 10,
    webhook_url: 'https://hooks.example.internal/openlog/t4',
    created_at: epochSec(21 * DAY),
    updated_at: epochSec(5 * HOUR),
  },
  {
    // 离线机器：规则停用，避免一直告警（真实运维里断线机器通常先关规则再排查）
    id: 'alert-t4-2',
    machine_id: 'srv-t4-2',
    enabled: 0,
    patterns: 'OutOfMemoryError,Killed process,Connection refused',
    severity_filter: 'WARN',
    cooldown_minutes: 15,
    webhook_url: '',
    created_at: epochSec(21 * DAY),
    updated_at: epochSec(2 * DAY + 3 * HOUR),
  },
];

/** 对应 `GET /api/alerts` 的 `configs` 数组（与机器一一对应） */
export function demoAlertConfigs() {
  return clone(ALERT_CONFIGS);
}

// ─── 助手知识库文件（对应 GET / api/assistant/memory）──────────────────────

/**
 * 形状照 `routes/assistant-memory.js#GET /api/assistant/memory` 的元素：
 * `{ name, path, content, updatedAt }`
 *   name      —— 去掉 `.md` 后缀的文件名
 *   path      —— 服务端绝对路径（真实实现是 `path.join(ASSISTANT_MEMORY_DIR, f)`）
 *   content   —— 文件全文（前端直接展示，所以给真实的 Markdown，不要占位符）
 *   updatedAt —— `stat.mtimeMs`，**毫秒**
 *
 * path 用一个不对应任何真实目录的固定前缀：演示实例不该泄露宿主机路径布局，
 * 也不该让前端「点开路径」时有任何东西可读。
 */
export const DEMO_MEMORY_DIR = '/srv/openlog/assistant_memory';

const MEMORY_FILES = [
  {
    name: '集群巡检结论-2026-06-07',
    path: `${DEMO_MEMORY_DIR}/集群巡检结论-2026-06-07.md`,
    content: `# 集群巡检结论（2026-06-07）

## 结论
- 4090×4：4/4 卡在线，最高温 76℃，显存最紧的是 GPU0（22.1 / 24 GiB）
- 4卡T4：4/4 卡在线，MFU 0.31（vLLM 引擎，prompt 1.4k tok/s、生成 320 tok/s）
- 双卡T4：SSH 连续 2 天未连通，重试 7 次，疑似下架或网络隔离

## 待办
1. vllm-qwen27b 的 --gpu-memory-utilization 从 0.95 降到 0.90
2. hami-scheduler 节点锁超时 5m → 10m（大模型加载动辄 6~8 分钟）
3. 双卡T4 若确认下架，从告警面板摘掉对应规则
`,
    updatedAt: epochMs(14 * HOUR + 12 * MINUTE),
  },
  {
    name: 'GPU-OOM-排查手册',
    path: `${DEMO_MEMORY_DIR}/GPU-OOM-排查手册.md`,
    content: `# GPU OOM 排查手册（vLLM / SGLang）

## 症状
- 容器退出码 137（OOMKilled），日志末尾 \`CUDA out of memory. Tried to allocate X GiB\`
- 显存峰值贴着卡容量：常见 23.4 / 24 GiB

## 排查顺序
1. \`nvidia-smi --query-compute-apps=pid,used_memory --format=csv\` 看是否多进程抢卡
2. 看 \`--gpu-memory-utilization\`（vLLM 默认 0.9，很多部署被改成 0.95）
3. 看 \`--max-model-len\` 与并发：KV cache 随 序列长度 × 并发 线性涨
4. \`--enable-prefix-caching\` 打开后峰值会更高，OOM 频繁时先关

## 处置
- 优先降 utilization，再降 max-model-len，最后才换卡/加卡
- 改完用同一批压测请求复现，不要用单条请求验证（单条永远不 OOM）
`,
    updatedAt: epochMs(2 * DAY + 6 * HOUR),
  },
  {
    name: '值班交接-0608',
    path: `${DEMO_MEMORY_DIR}/值班交接-0608.md`,
    content: `# 值班交接（06-08 09:00）

- 夜班没收到 P1；4090×4 有两轮 FailedScheduling 告警，自行恢复
- reranker-perf/msrk-5 早上 09:41 又 Pending 一次，节点锁（hami-scheduler）问题
- 白天计划：调整 vllm-qwen27b 显存参数 → 灰度到 4卡T4 → 观察 2 小时
- 提示：双卡T4 不要直接 ssh，先 ping，那台机器上还有旧版驱动
`,
    updatedAt: epochMs(41 * MINUTE),
  },
];

/** 对应 `GET /api/assistant/memory` 的 `files` 数组（按 updatedAt 新 → 旧） */
export function demoMemoryFiles() {
  return clone(MEMORY_FILES).sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── 助手固定回复（对应 POST / api/chat）──────────────────────────────────

/**
 * 演示模式下 `/api/chat` 的首帧提示。
 *
 * 前端 `Assistant.tsx` 已经处理 `provider_notice` 事件（真实链路里用于
 * 「引擎不支持 tools，已降级」这类提示），复用它可以做到**前端零改动**就能看到
 * 一条「这是演示数据」的提示条 —— 而不是让用户以为模型真答了。
 */
export const DEMO_CHAT_NOTICE = '演示模式：当前实例未连接真实集群（OPENLOG_DEMO=1），以下结论来自内置示例数据，未执行任何真实查询、命令或工具调用。';

/**
 * 演示模式下 `/api/chat` 的固定正文。
 *
 * 为什么写死而不是「假装调一下模型」：演示实例没有 API Key、没有集群，
 * 任何"看起来像模型输出"的随机内容都会让用户以为系统真的查过了。
 * 这里第一行就写明是演示，末尾再挂 `[demo]` 尾标，前后都能被识别。
 */
export const DEMO_CHAT_REPLY = `演示模式：当前实例未连接真实集群（OPENLOG_DEMO=1），以下为示例结论 —— 没有一条来自真实查询，请勿据此操作生产环境。

**1) \`reranker-perf/msrk-5\` 调度失败**
- 事件：\`Warning FailedScheduling\`（节点 \`gpu-node-01\`，已持续 6m12s）
- 直接原因：\`hami-scheduler\` 的节点锁被 \`vllm-qwen27b\` 的滚动更新占用，Pending 的 Pod 拿不到 GPU 分配
- 次要原因：节点显存碎片化，4 张卡各剩 1.8~2.2 GiB，单卡都放不下 reranker

**2) \`vllm-qwen27b\` 容器退出**
- 上次退出码 \`137\`（OOMKilled），重启 3 次，最近一次 09:41:07
- 显存峰值 \`23.4 / 24 GiB\`，\`--gpu-memory-utilization 0.95\` 留的余量不足
- 日志特征：\`CUDA out of memory. Tried to allocate 1.25 GiB\` 之后紧接 \`Killed\`

**3) 建议（按性价比排序）**
1. \`--gpu-memory-utilization\` 从 \`0.95\` 降到 \`0.90\`，或把 \`--max-model-len\` 从 32768 降到 24576 压缩 KV cache
2. 检查 \`hami-scheduler\` 的节点锁超时（默认 5m）是否短于大模型加载耗时，必要时调到 10m
3. \`双卡T4\`（10.20.30.31）SSH 已 2 天未连通、重试 7 次，先确认机器是否下架再谈参数

> 以上全部为演示数据 · 未连接任何真实服务器 · 未执行任何命令 [demo]`;

/** 固定正文（同一问题永远同一回复） */
export function demoChatReply() {
  return DEMO_CHAT_REPLY;
}

/**
 * 把固定正文切成等长片段，模拟"边生成边推"。
 *
 * 切片长度固定 + 文本固定 ⇒ 字节流完全确定，测试可以直接断言「两次请求文本相同」。
 * 按字符切而不是按行切：前端是逐段追加渲染的，行太长会显得一卡一卡。
 *
 * @param {number} [size] 每片最大字符数
 * @returns {string[]}
 */
export function demoChatChunks(size = 24) {
  const step = Math.max(1, Math.floor(size) || 1);
  const chunks = [];
  for (let i = 0; i < DEMO_CHAT_REPLY.length; i += step) {
    chunks.push(DEMO_CHAT_REPLY.slice(i, i + step));
  }
  return chunks;
}

/**
 * 演示回复的 openai 形状 chunk 流，交给 `llm-stream.js#pipeChatStreamToSSE` 转发。
 *
 * 复用现有管线的意义：帧格式（`{content}` / `data: [DONE]`）与心跳逻辑都在那一处，
 * 演示分支自己拼协议迟早会跟真实链路漂移，前端解析方式一改就两边不一致。
 *
 * @returns {AsyncGenerator<{choices: {delta: {content: string}}[]}>}
 */
export async function* demoChatStream() {
  for (const content of demoChatChunks()) {
    yield { choices: [{ delta: { content } }] };
  }
}
