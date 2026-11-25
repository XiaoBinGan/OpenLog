# 推理服务基准真机对拍（infra-bench-verify）

给**已经跑起来的**推理服务压一轮「并发 × 上下文」矩阵，把实测 TTFT / 吞吐 / 错误率交给
`recommendQuota()` 反推配额，再和服务**实际申请的**配额逐项对拍，回答一个问题：

> 这个服务现在申请的显存和算力，和它实际跑出来的负载相比，是**亏了**还是**浪费了**？

一句话边界：**只压测、只出报告，不动集群**。

| 项 | 值 |
|---|---|
| 脚本 | `scripts/infra-bench-verify.mjs` |
| 复用的引擎 | `server/infra/bench.js` 的 `runBenchmark()` / `recommendQuota()` / `normalizeLimits()` / `buildEndpoint()` |
| 压测面 | OpenAI 兼容 `/v1/chat/completions`（流式 SSE） |
| 写文件 | 只有 `--out` 指定的那份 JSON |
| 集群访问 | **零**（不连 apiserver、不读 kubeconfig、不碰 HAMi） |
| 同类能力 | HTTP 侧的同一份实现：`POST /api/infra/bench`；上位门禁见 `server/infra/gate.js`（不过基准不许上线） |

---

## 1. 这个脚本干什么、不干什么

### 干什么

| # | 做的事 | 落点 |
|---|---|---|
| 1 | 按矩阵逐个组合压测：并发档位 × 输入 token 档位，**组合之间串行**，组合内部才放并发 | `runBenchmark()` |
| 2 | 统计每个组合的 TTFT p50 / p95 / max、tokens/s、错误率、请求数 | `bench.results[]` |
| 3 | 把实测结果反推成一套能直接填进 `ModelService.resources` 的配额 | `recommendQuota()` |
| 4 | 和实际申请值逐项对拍，给出偏差（`+2048 MiB` / `-20%`）与判定 | 本脚本 |
| 5 | 安全阀中止时，仍然输出已完成组合的结论（不吞数据、不假装成功） | 本脚本 |
| 6 | `--dry-run` 打印将要执行的矩阵与目标，一个请求都不发 | 本脚本 |

### 不干什么（越界即返工）

| 不做 | 为什么 |
|---|---|
| 不启动 Pod、不建 Deployment、不改 `resources` | 控制面不做数据面的事；改配额是 `apply` 的活，且改配额必须重建 Pod |
| 不写网关 ConfigMap、不动 HPA | 同上，各自有归属模块 |
| 不重复实现压测逻辑（并发、百分位、token 估算、安全阀） | 两套实现必然漂移，报告就没人信了 |
| 不替你判断「能不能上线」 | 那是 `gate.js` 的门禁；这里只出数 |
| 不猜数据 | 没实测显存就 `memoryMiB: null` + `confidence: estimated`，不拿 0 或权重估冒充实测 |
| 不在演示模式下跑 | 演示实例后面没有真引擎，压它没有意义 |

---

## 2. 怎么跑

### 2.1 参数表

必填两项：`--url`、`--model`。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--url URL` | — | OpenAI 兼容端点。写 `http://host:8000` 或完整 `http://host:8000/v1/chat/completions` 都行，`buildEndpoint()` 会补齐；**别只写到 `/v1`**（会被补成 `/v1/v1/chat/completions`，脚本直接拒绝） |
| `--model NAME` | — | 服务里的模型名，引擎按它路由，写错一定 404 |
| `--api-key K` | 无 | Bearer token；**不会**写进 `--out` 的 JSON（只留 `apiKey: "***"`） |
| `--concurrency LIST` | `1,4,8` | 并发档位，逗号分隔。上限 8（见 §4.1），超了直接拒绝 |
| `--tokens LIST` | `512,4096` | 输入 token 档位，逗号分隔。必须 ≥1 |
| `--matrix` | 关 | 额外并入 bench 默认矩阵（`1,4,8` × `512,4096`），与显式档位合并去重 |
| `--rounds N` | 4 | 每个 worker 跑几轮；只影响请求数，不改变组合结构 |
| `--max-requests-per-cell N` | 20 | 单组合请求数上限（安全阀，来自 `DEFAULT_LIMITS`） |
| `--applied-mem MiB` | 未给 | 服务**实际申请**的显存（`resources.memoryMiB`，`0..65536`，`0` = 整卡独占） |
| `--applied-cores PP` | 未给 | 服务**实际申请**的算力（`resources.coresPercent`，`0..100`，`0` = 不限算力） |
| `--peak-mem-mib MiB` | 未给 | 手工提供实测显存峰值。给了才是 `confidence: measured` |
| `--memory-headroom R` | 1.25 | 显存余量系数（KV cache 增长 + 碎片 + 引擎 workspace） |
| `--cores-per-concurrency N` | 10 | 「每 N% 算力承载 1 路并发」的线性假设（§5.3 明确它的可信度） |
| `--max-total-ms MS` | 120000 | 整轮墙钟上限，到点收手，剩下的组合不跑 |
| `--max-p95-ttft-ms MS` | 30000 | p95 TTFT 超阈值立即中止（服务已经排队了，再加压只会更糟） |
| `--max-error-rate R` | 0.2 | 错误率超阈值立即中止（0–1） |
| `--out FILE` | 无 | 结果落 JSON；目录不存在会自动建 |
| `--dry-run` | 关 | 只打印计划，**不发任何请求**（连探活都不发） |
| `--skip-preflight` | 关 | 跳过探活。端点对 `GET` 反应异常（比如网关直接 reset）但 `POST` 正常时用 |
| `--help` | — | 打印帮助 |

### 2.2 退出码

脚本不靠颜色或「有没有输出」表达成败，退出码是契约的一部分：

| 退出码 | 含义 | 典型原因 |
|---|---|---|
| `0` | 跑完，至少拿到一个有效组合 | 正常 |
| `1` | 脚本自身失败 | `--out` 写不进去、bench 抛异常 |
| `2` | 参数非法 | 并发 > 8、`--tokens 0`、缺 `--url`/`--model`、`--applied-mem 131072`、`/v1/v1/` 路径 |
| `3` | 服务不可达 | `ECONNREFUSED` / `ENOTFOUND` / 探活超时 / 整轮全是 network 错误 |
| `4` | 被安全阀中止 | 错误率、p95 TTFT、总时长、吞吐任一越界；**报告照常输出** |

### 2.3 三个典型场景

**场景 A：新模型上线前定配额（第一次，没有历史数据）**

先干跑确认矩阵，再压一轮，最后看推荐值：

```bash
node scripts/infra-bench-verify.mjs --dry-run \
  --url http://10.0.0.12:8000/v1/chat/completions --model qwen3-32b

node scripts/infra-bench-verify.mjs \
  --url http://10.0.0.12:8000/v1/chat/completions --model qwen3-32b \
  --concurrency 1,4,8 --tokens 512,4096 \
  --peak-mem-mib 14336 \
  --out bench/new-model.json
```

这里给的是**推荐值**（服务此刻还没配额可言）：直接拿去填 `ModelService.resources`，
然后走 `POST /api/infra/services/:id/preview` 看 diff。`--peak-mem-mib` 的来源优先是引擎
`/metrics`（vLLM: `vllm:gpu_cache_usage_perc` / SGLang: `sglang:token_usage`）或 `nvidia-smi`，
拿不到就别填 —— `estimated` 的显存建议不能直接上线。

**场景 B：改配额前后对比（同一台机器、同一个上下文）**

```bash
# 改之前
node scripts/infra-bench-verify.mjs --url http://10.0.0.12:8000/v1/chat/completions \
  --model qwen3-32b --applied-mem 8192 --applied-cores 40 --out bench/before.json

# 改配额、等 Pod Ready 后（改配额必然重建 Pod，会断流，见 docs/INFRA.md §4.2）
node scripts/infra-bench-verify.mjs --url http://10.0.0.12:8000/v1/chat/completions \
  --model qwen3-32b --applied-mem 12288 --applied-cores 60 --out bench/after.json
```

比的是两份 JSON 的同名字段：`bench.results[].ttftMs.p95`、`tokensPerSec`、`errorKinds`。
**只有矩阵完全相同时两份报告才可比** —— 并发档位或 `--rounds` 变了就别直接比数字。

**场景 C：定期回归（看它有没有变差）**

```bash
node scripts/infra-bench-verify.mjs \
  --url http://10.0.0.12:8000/v1/chat/completions --model qwen3-32b \
  --applied-mem 12288 --applied-cores 60 \
  --max-p95-ttft-ms 3000 --max-total-ms 90000 \
  --out bench/regression-$(date +%Y%m%d).json
```

回归跑的关键是**把默认阈值收紧**（默认 30s 是「不允许继续压」的红线，不是「合格线」；
合格线一般 3s 量级，见 §4.2），并且退出码要进 CI：`4` 表示这次不仅没通过，还被中止了。

---

## 3. 怎么读报告

### 3.1 每个指标是什么

| 指标 | 定义 | 怎么算 | 什么算好 |
|---|---|---|---|
| **TTFT p50** | 首 token 延迟的中位数 | 请求发出 → 第一个非空响应 chunk 到达（nearest-rank 百分位，不插值） | 交互式场景 p50 ≤ 500ms 体感正常；批处理可以放宽到 2–3s |
| **TTFT p95** | 首 token 延迟的 95 分位 | 同上 | 交互式 ≤ 1.5s 可用、≤ 3s 是底线；**p95 突然抬头就是排队开始**，不是噪声 |
| **TTFT max** | 最差一次 | 同上 | 只用来发现长尾（一次 45s 往往意味着显存不足开始 swap 或引擎 GC） |
| **成功/请求** | 有效样本数 / 实际发出请求数 | 只有成功请求进 TTFT 统计 | 两者相等最好；缺口说明超时、HTTP 非 2xx 或空响应 |
| **tokens/s** | 组合内所有成功请求的 completion tokens ÷ 该组合墙钟 | `usage.completion_tokens` 优先，没有就按 delta 内容估算 | 看**曲线形状**而不是绝对值：并发涨、吞吐不涨 = 已经饱和，多出来的并发只是排队 |
| **错误率** | 失败数 ÷ 已完成数（累计口径） | 含 `http` / `timeout` / `network` / `empty` 四类 | `0%`；出现 4xx 先查 `--model` 与 `--url`，5xx 查引擎日志 |
| **wallMs** | 组合墙钟 | 首个请求发出 → 最后一个返回 | 和 `requests × 单请求延迟 / 并发` 对得上才是正常的线性扩展 |

> 非流式响应（`stream:false`）的「TTFT」实际是**整体延迟**。本套压测一律用
> `stream: true` + `stream_options.include_usage`，所以 TTFT 是真首包时间；但如果你把
> `--url` 指到只支持非流式的端点，报告里的 p95 请按「整条响应」理解。

### 3.2 `measured` vs `estimated`

`recommendQuota()` 的置信度只看一件事：**有没有实测显存峰值**。

| confidence | 触发条件 | 显存建议 | 能怎么用 |
|---|---|---|---|
| `measured` | 给了 `--peak-mem-mib`（或注入了 `readGpuMem`） | `ceil(峰值 × 1.25 / 512) × 512` MiB | 可以当作申请值填写，仍需按 §5.3 复核 |
| `estimated` | 没有实测显存 | `memoryMiB: null` | **只能当参考**：显存自己按「权重 + KV cache」估，算力建议可以用来判断量级 |

`coresPercent` 永远是「按实测吞吐曲线推的」，所以它本身不受这一项影响；但**整个结论的
可信度由最弱的一环决定** —— 显存是 `estimated` 时，「可回收」的结论不能直接执行。

`bench.results[].ok` 是另一个独立开关：`ok:false` 的组合（全失败 / p95 超阀）**不参与**
配额推导，只在表里显示。

### 3.3 三张表怎么串起来看

1. **组合结果表**：先确认「有没有人真的跑通了」。全部 `不合格` → 后面两段没有意义。
2. **对拍表**：看偏差方向。`+` 是「申请小于实际需要」，`-` 是「申请大于实际需要」。
3. **判定段**：一句人话 + 一项一行。判定的三个状态：

| 状态 | 条件 | 含义 | 下一步 |
|---|---|---|---|
| 需要扩容 | 推荐 > 申请 | 高峰期会撞 `OOMKilled`（显存）或排队（算力） | 改 `resources` → `preview` 看 diff → 排窗口 `apply`（改配额必重建 Pod） |
| 可回收 | 推荐 < 申请 × 0.6 | 空转占卡，同一张卡上别的服务因此调度不上来 | 先按**业务峰值**再压一轮，别用单次基准一键缩；缩完必须复测 p95 |
| 基本匹配 | 其它 | 偏差在一个安全区间里 | 不动 |

偏差一律写成「推荐 − 申请」，单位跟着字段走：显存是 `MiB`、算力是 `pp`（百分点）。

---

## 4. 阈值怎么定

### 4.1 默认值从哪来

默认值**不是**这个脚本编的，全部来自 `server/infra/bench.js` 的 `DEFAULT_LIMITS`，
和 `POST /api/infra/bench` 用的是同一份数字（前后端不搞两套）：

| 阈值 | 默认 | 为什么是这个值 |
|---|---|---|
| `maxConcurrency` | 8 | 与护栏的 `replicas 1..8`、HPA 的 `maxReplicas 8` 同一口径；再往上，单卡上排队损失会盖过吞吐收益 |
| `maxRequestsPerCell` | 20 | 一档组合最多 20 个请求，够算 p95（20 个样本时 p95 = 第 19 个），又不至于把服务压成压测机 |
| `maxTotalMs` | 120000 | 两分钟。超过这个时长还没测完，说明服务已经在排队，继续测只是拖累邻居 |
| `maxErrorRate` | 0.2 | 20% 已经远超「抖动」范畴；**累计口径、不设最小样本门槛**（第 1 个请求就 500 就是状态不对） |
| `maxP95TtftMs` | 30000 | 30s 是「排队已经很严重」的红线，不是合格线 |
| `maxTokensPerSec` | 100000 | 防跑飞：统计错、响应体异常大、把服务打满时及时刹车 |

矩阵默认 `1,4,8` × `512,4096` = 6 个组合、串行跑、单组合 ≤ 20 请求。

### 4.2 按业务调的方法

先定**业务合格线**，再决定安全阀。两者不是一个东西：

| 业务形态 | 合格 p95 TTFT | 建议 `--max-p95-ttft-ms` | 说明 |
|---|---|---|---|
| 在线对话（人等着看字） | ≤ 1500 ms | 3000 | 首字超过 2s 用户就开始怀疑卡了 |
| 在线补全 / 代码助手 | ≤ 800 ms | 2000 | 更敏感，通常在 4 并发以内就该见顶 |
| 批量摘要 / 离线打分 | ≤ 8000 ms | 20000 | 只关心总吞吐，TTFT 只要不爆就行 |
| 内部工具 / 低频 | ≤ 3000 ms | 10000 | 可以容忍排队 |

调法（每次只动一个）：

1. **先定 `--max-p95-ttft-ms`**：取业务合格线的 2 倍。它决定「什么时候停」，取太松会把服务压到
   邻居投诉，取太紧会在冷启动时误中止。
2. **再定 `--concurrency` 的上限**：从 `1,4` 开始，确认 p95 还在合格线内，再加 `8`。
   `8` 档的 p95 明显掉出合格线 → 这台机器的稳定并发就是 4，别硬拉。
3. **`--rounds` / `--max-requests-per-cell`**：只有当 p95 抖动很大（比如同一档两次跑差 2 倍）时才加，
   加样本是消抖，不是消问题。
4. **`--max-error-rate`** 一般不要动。调大它等于让「服务已经坏了」的结果混进配额推导。
5. 显存余量 `--memory-headroom`：默认 1.25 已经覆盖「KV cache + 碎片 + workspace」。**下调它是危险的**
   ——最优点出现在最长上下文档时，25% 就是唯一的安全垫（bench 会在备注里提醒这一点）。

---

## 5. 风险与限制（诚实版）

### 5.1 压测会占用 GPU，邻居会被拖慢

这是本脚本**最重要的一条**，不是免责声明：

- HAMi 的算力隔离实测**仅约 26% 有效** —— 也就是说你申请 20% 算力，并不能保证只用 20%；
  实际能把同一张卡的邻居拖慢到什么程度，取决于引擎 batch 形态，而非配额数字。
- 显存隔离相对硬（超了就是 OOM），**算力隔离是软的**。所以「我只申请 40% 算力，压一下没事」
  这个推论不成立。
- 同卡上还跑着别的服务时，你这一轮压测的 p95 里就混进了「邻居被自己拖慢」的反馈，数据会偏悲观；
  反过来邻居在跑批，你的 p95 也会偏乐观。

**做法**：

| 措施 | 具体怎么落 |
|---|---|
| 错峰 | 别在业务高峰跑。生产集群优先凌晨或维护窗口 |
| 限并发 | 默认 `maxConcurrency: 8` 是硬上限，本脚本不提供绕过开关。要更高并发请先在集群侧把隔离做实 |
| 自动中止 | **一定设** `--max-p95-ttft-ms`（业务合格线的 2 倍）。到点自动停，比人盯着终端靠谱 |
| 限总量 | `--max-total-ms` 收在 90–120s；`--max-requests-per-cell` 不超过 20 |
| 优先影子环境 | 有 `infra-test` 命名空间就先在那边压，再上 `inference` |

### 5.2 推荐配额的推导假设（必须真机对拍过才可信）

`coresPercent` 的推导是一条**线性假设**：

> 每 10% 算力 ≈ 1 路稳定并发（即 100% 算力 ≈ 10 路并发）。

它来自「100% 算力 ≈ 10 路稳定并发」的经验基线，`recommendQuota()` 的做法是：取实测峰值
吞吐的 90% 作为目标，找到第一个达到目标的并发档 `C*`，然后 `coresPercent = ceil(C* × 10 / 5) × 5`。

这条假设**在小模型 + 大 batch 时会偏保守**（4 路就吃满 100% 算力时，`C*` 自然变 4 → 40%），
在长上下文 / 大模型 + 显存受限时会偏乐观。所以：

- 第一次给某个引擎族（vLLM / SGLang / llama.cpp）定配额时，**必须**做一遍「按推荐值申请 → 再压一轮 →
  看 p95 是否仍在合格线」的闭环，也就是 §2.3 场景 B；
- 闭环里 p95 抬头 → 推荐值偏小，把 `--cores-per-concurrency` 调到 12~15 重跑；
- 闭环里显存富余（`nvidia-smi` 峰值远低于申请值）→ 可以往下收，但**收完必须再压一轮**。

没有做过这个闭环的配额，只能算「有个数」，不能算「对过」。

### 5.3 没有实测显存时，结论只能当参考

`confidence: estimated` 时：

- `memoryMiB` 是 `null`，报告里显式写「推荐值缺失」，**不会**用权重或经验值填一个看起来合理的数；
- 此时「需要扩容 / 可回收」的显存判定一律是「无法判定」，不会因为缺数据就给出一个方向；
- 想变成 `measured`：给 `--peak-mem-mib`（从引擎 `/metrics` 或 `nvidia-smi --query-gpu=memory.used` 读
  峰值），或接上引擎的显存读数注入 `runBenchmark({ readGpuMem })`。

### 5.4 其它已知限制

| 限制 | 影响 | 规避 |
|---|---|---|
| 一次只测一个端点 | 多副本 / 多节点不会被同时压到 | 需要看集群整体时按副本分别跑，或压网关地址让 k8s Service 负载均衡 |
| 矩阵是串行的 | 总时长 ≈ 各组合之和 | 用 `--max-total-ms` 截断；别为了「测全」把矩阵拉很宽 |
| token 数是估算的 | 输入长度有 ±几个 token 误差 | 同一脚本不同批次可比；跨工具比之前先对齐 tokenizer |
| 显存只在组合之间采样 | 尖峰可能被漏掉 | 关键服务同时看 `nvidia-smi` 峰值或引擎 `/metrics` |
| 请求超时不做取消 | 超时请求仍在服务端跑完 | 用 `--max-p95-ttft-ms` 提前收手，别靠超时兜底 |
| 依赖引擎的 `usage.completion_tokens` | 不给 usage 时按内容估算，吞吐会偏 | 开 `stream_options.include_usage`（脚本默认已开） |

### 5.5 引擎侧的两个坑（会直接让脚本「看起来跑不动」）

| 现象 | 根因 | 处理 |
|---|---|---|
| 一轮压测全是 `HTTP 400` | 输入超过 `--max-model-len`，或引擎不接受 `stream_options` | 降 `--tokens`；老版本引擎去掉 `include_usage`（改脚本 `target` 或直接调 bench） |
| 整轮 `network` 错误、`ECONNRESET` | 引擎 `max_num_seqs` 很小 + 并发 8，直接被拒或进程 OOM 重启 | 先降到并发 1、2 确认单路正常，再逐档加 |

---

## 6. 完整示例输出

### 6.1 `--dry-run`（真实输出）

```text
$ node scripts/infra-bench-verify.mjs --dry-run \
    --url http://10.0.0.12:8000/v1/chat/completions --model qwen3-32b \
    --applied-mem 14336 --applied-cores 80 --out result.json

== infra-bench-verify · DRY RUN（不发任何请求） ==

目标端点    http://10.0.0.12:8000/v1/chat/completions
模型名      qwen3-32b
鉴权        未给 --api-key（服务若开启鉴权会全 401）
安全阀      maxConcurrency=8 · maxRequestsPerCell=20 · maxTotalMs=120000ms · maxErrorRate=20% · maxP95TtftMs=30000ms · maxTokensPerSec=100000（默认值来自 bench 的 DEFAULT_LIMITS）
矩阵        3 档并发 × 2 档输入 = 6 个组合，串行执行
预计请求数  约 80 次（估算：每 worker 4 轮，单组合上限 20）
显存来源    未给 --peak-mem-mib → 推荐显存会是 null，confidence=estimated
实际申请    显存 14336 MiB · 算力 80%
结果落盘    /path/to/repo/result.json

将要执行的组合：

| # | 并发 | 输入 tokens | 预计请求数 |
|---|------|-------------|------------|
| 1 |    1 |         512 |          4 |
| 2 |    1 |        4096 |          4 |
| 3 |    4 |         512 |         16 |
| 4 |    4 |        4096 |         16 |
| 5 |    8 |         512 |         20 |
| 6 |    8 |        4096 |         20 |

真跑时去掉 --dry-run。压测会占用 GPU，同卡邻居会被拖慢（HAMi 算力隔离实测仅约 26% 有效）。
```

> 这里能看出「预计请求数」的规则：`clamp(并发 × 4, 1, 20)`。它是**估算**，真实值由 bench 内部决定
> （`--rounds` 与 `--max-requests-per-cell` 一起作用）。

### 6.2 一次完整对拍（结构示例）

下面这段来自本地假引擎（固定 40ms 首包、每个请求回报 130 completion tokens），
**数值本身没有参考意义**，只用来看结构与措辞：

```text
$ node scripts/infra-bench-verify.mjs \
    --url http://bench.local:8000/v1/chat/completions --model qwen3-32b \
    --concurrency 1,4 --tokens 512 \
    --applied-mem 8192 --applied-cores 40 --peak-mem-mib 14336 --out bench/out.json

探活：http://bench.local:8000/v1/chat/completions 回 HTTP 405（可达）
== infra-bench-verify · 真机对拍报告 ==

目标端点    http://bench.local:8000/v1/chat/completions
模型名      qwen3-32b
矩阵        2 个组合（并发 1,4 × 输入 512）
安全阀      maxConcurrency=8 · maxRequestsPerCell=20 · maxTotalMs=120000ms · maxErrorRate=20% · maxP95TtftMs=30000ms · maxTokensPerSec=100000

[1] 组合结果

| 并发 | 输入 tokens | 成功/请求 | TTFT p50 | TTFT p95 | tokens/s | 错误率 | 状态 |
|------|-------------|-----------|----------|----------|----------|--------|------|
|    1 |         512 |       4/4 |    41 ms |    44 ms |      859 |   0.0% | OK   |
|    4 |         512 |     16/16 |    42 ms |    43 ms |     3476 |   0.0% | OK   |

最优点：4 并发 / 512 tokens —— 3476 tokens/s，p95 TTFT 43 ms

[2] 推荐配额 vs 实际申请

| 项                | 实际申请 |    推荐值 | 偏差（推荐 − 申请） | 判定     |
|-------------------|----------|-----------|---------------------|----------|
| 显存 memoryMiB    | 8192 MiB | 17920 MiB |  +9728 MiB（+119%） | 需要扩容 |
| 算力 coresPercent |    40 pp |     40 pp |               ±0 pp | 基本匹配 |

置信度：confidence=measured（有实测显存峰值）

[3] 判定

  · 显存 memoryMiB：申请 8192 MiB → 推荐 17920 MiB，偏差 +9728 MiB（+119%） ｜ 需要扩容，否则高峰期会 OOM/排队（显存侧：KV cache 随并发线性涨，涨过申请值就是 OOMKilled）
  · 算力 coresPercent：申请 40 pp → 推荐 40 pp，偏差 ±0 pp ｜ 基本匹配，保持现值（偏差在可接受区间内）

汇总：显存 memoryMiB 需要扩容，否则高峰期会 OOM/排队（改 resources 后必须重建 Pod，按 docs/INFRA.md §4.2 排窗口）。

[4] bench 的推导备注

  · 最优点是 4 并发 / 512 tokens：3476.0 tokens/s，p95 TTFT 42.7ms。
  · 最优点出现在最长上下文档：KV cache 按最长上下文计的，显存余量 25% 之外不要再手动下调。
  · 显存峰值 14336MiB × 1.25 向上取整到 512MiB → 17920MiB。

退出码：0（0 正常完成 / 3 不可达 / 4 被中止）
结果已写入 bench/out.json
```

### 6.3 被安全阀中止（退出码 4，报告照出）

```text
探活：http://bench.local:8000/v1/chat/completions 回 HTTP 405（可达）
== infra-bench-verify · 真机对拍报告 ==

目标端点    http://bench.local:8000/v1/chat/completions
模型名      m
矩阵        2 个组合（并发 1,4 × 输入 512）
安全阀      maxConcurrency=8 · maxRequestsPerCell=20 · maxTotalMs=120000ms · maxErrorRate=20% · maxP95TtftMs=30000ms · maxTokensPerSec=100000

!! 基准被安全阀中止
   原因：1 并发时错误率 100.0%（1/1）超过阈值 20.0%，已中止以免把无效数据算进推荐配额
   已完成的组合：1 个 —— 下面的结论只基于这些，样本不足时不要拿它定配额。

[1] 组合结果

| 并发 | 输入 tokens | 成功/请求 | TTFT p50 | TTFT p95 | tokens/s | 错误率 | 状态   |
|------|-------------|-----------|----------|----------|----------|--------|--------|
|    1 |         512 |       0/1 |        — |        — |     0.00 | 100.0% | 不合格 |

最优点：无（没有任何 ok 且有样本的组合）

[2] 推荐配额 vs 实际申请

| 项                | 实际申请 |   推荐值 | 偏差（推荐 − 申请） | 判定     |
|-------------------|----------|----------|---------------------|----------|
| 显存 memoryMiB    | 8192 MiB | 无法推导 |                   — | 无法判定 |
| 算力 coresPercent |    40 pp | 无法推导 |                   — | 无法判定 |

置信度：confidence=estimated（没有实测显存峰值，显存建议为空或只能按权重估）

[3] 判定

  · 显存 memoryMiB：申请 8192 MiB → 推荐值缺失，偏差 — ｜ 推荐显存推不出来：没有实测显存峰值（缺 --peak-mem-mib，也没有接引擎 /metrics）——推荐值只能是 null，别拿 0 顶上
  · 算力 coresPercent：申请 40 pp → 推荐值缺失，偏差 — ｜ 推荐算力推不出来：没有任何 ok 且有样本的组合，无法反推 coresPercent（先让基准至少跑通一个组合）

汇总：没有可对比的项：推荐值和实际申请值至少要各有一个，才能对拍。

[4] bench 的推导备注

  · 基准是中止结束的（errorRate），推荐配额只基于已完成的 1 个组合，样本不足时请谨慎采信。
  · 没有读到推理引擎的显存峰值（未注入 readGpuMem/gpuMemPeakMiB），显存建议留空：请按模型权重大小 + KV cache（上下文 × 并发 × 2 × 层数 × hidden）手工估算，或接上引擎 /metrics 后重跑。
  · 没有成功的样本，无法推导算力配额：至少需要一个 ok 的组合（能拿到 TTFT 与吞吐）才能反推 coresPercent。

退出码：4（0 正常完成 / 3 不可达 / 4 被中止）
```

对应的 stderr（`✗` 开头，不混进报告本体）：

```text
✗ 没有任何有效样本（1 个请求全部失败）：1 并发时错误率 100.0%（1/1）超过阈值 20.0%，已中止以免把无效数据算进推荐配额
  按 HTTP 状态自查：401 = --api-key 没给或不对；404 = --model 名不对或 --url 路径不对；400 = 上下文超过 --max-model-len 或请求体不被接受；5xx = 引擎侧崩了（看 Pod 日志）。
  下面的报告只用来定位问题，不能拿它定配额。
```

### 6.4 服务不可达（退出码 3）

```text
$ node scripts/infra-bench-verify.mjs --url http://127.0.0.1:45999/v1/chat/completions --model m
✗ 目标服务不可达：http://127.0.0.1:45999/v1/chat/completions
  错误码：ECONNREFUSED —— 端口上没有服务在监听（Pod 还没 Ready / 端口写错 / 网关没起）
  底层报错：connect ECONNREFUSED 127.0.0.1:45999
  常见原因：Pod 还没 Ready / --url 端口或路径写错 / 网关没起 / NetworkPolicy 挡了本机。
  自查：curl -sS -m 5 -X POST 'http://127.0.0.1:45999/v1/chat/completions' -H 'Content-Type: application/json' -d '{"model":"m","stream":false,"max_tokens":8,"messages":[{"role":"user","content":"ping"}]}'
  确认可达后重跑；若端点对 GET 反应异常但 POST 正常，加 --skip-preflight。
```

`ENOTFOUND`（域名解析不到）、探活超时（`ABORT`）、以及 fetch 规范的禁用端口（
`BAD_PORT`，端口 1 / 7 / 9 这类会被 undici 直接拒绝）都会走同一条路径，错误码不同、退出码都是 3。

### 6.5 `--out` 的 JSON 形状

```json
{
  "tool": "infra-bench-verify",
  "version": 1,
  "generatedAt": "2026-11-26T05:59:00.000Z",
  "target": { "endpoint": "http://...", "url": "http://...", "model": "qwen3-32b", "apiKey": "***" },
  "matrix": { "concurrencies": [1, 4], "inputTokens": [512], "cells": [{ "concurrency": 1, "inputTokens": 512, "requests": 4 }] },
  "limits": { "maxConcurrency": 8, "maxRequestsPerCell": 20, "maxTotalMs": 120000, "maxErrorRate": 0.2, "maxP95TtftMs": 30000, "maxTokensPerSec": 100000 },
  "assumptions": { "rounds": 4, "requestsPerCell": null, "peakGpuMemMiB": 14336, "memoryHeadroom": 1.25, "coresPerConcurrency": 10 },
  "applied": { "memoryMiB": 8192, "coresPercent": 40 },
  "bench": { "ok": true, "aborted": false, "reason": null, "results": [], "summary": {} },
  "quota": {
    "recommended": { "memoryMiB": 17920, "coresPercent": 40, "confidence": "measured" },
    "recomputed": { "memoryMiB": 17920, "coresPercent": 40, "confidence": "measured" },
    "consistent": true,
    "comparisons": [],
    "verdict": "显存 memoryMiB 需要扩容，……"
  },
  "exitCode": 0
}
```

`quota.consistent` 是本脚本的自检：它用**同参数**再调一次 `recommendQuota()`，
和 `bench.summary.recommended` 比对。`false` 说明两侧参数不同源（比如改了
`--memory-headroom` 却只影响了一边），此时以 bench 内部结果为准，并检查参数。

---

## 附录 A：和周边模块的关系

| 模块 | 关系 |
|---|---|
| `server/infra/bench.js` | 唯一压测实现。本脚本只做参数校验、对拍、报告 |
| `server/routes/infra.js`（`POST /api/infra/bench`） | 同一份引擎的 HTTP 入口，供面板触发；本脚本是**真机对拍**用的 CLI |
| `server/infra/gate.js` | 基准门禁：拿本脚本的 `bench.results` 判「不许上线」。门禁阈值（3s / 1% / baseline×0.8）比这里的**中止线**严格 |
| `server/infra/model.js` | `resources.memoryMiB` / `coresPercent` 的合法区间来源，`--applied-*` 按它校验 |
| `docs/INFRA.md` | 改配额的中断估算（单副本 60s）、runbook、护栏与回滚 |

## 附录 B：已知问题（上游模块侧）

| 问题 | 现象 | 本脚本的处理 |
|---|---|---|
| `bench.js` 主循环第 880 行用裸 `now()` 而非归一后的 `clockNow()` | 不注入 `now` 直接调 `runBenchmark()` 会抛 `TypeError: now is not a function`；`POST /api/infra/bench` 与真机调用都会撞上（单测都注入了假时钟，所以测不出来） | 脚本显式注入 `now: monotonicNow`（语义同 bench 的 `defaultNow`）；修上游时应改成 `clockNow()` |
| `buildEndpoint()` 只认「以 `/completions` 结尾」 | `--url http://host:8000/v1` 会被补成 `/v1/v1/chat/completions`，整轮 404 | 脚本在开跑前就拒绝并给出两种正确写法 |
| `DEFAULT_ROUNDS` 未导出 | 请求数只能在文档里镜像一份常量 | 只用于 dry-run 的「预计请求数」，标注为估算 |

## 附录 C：最小验收

```bash
node --check scripts/infra-bench-verify.mjs
node scripts/infra-bench-verify.mjs --dry-run --url http://127.0.0.1:1/x --model m   # 打印计划、退出码 0、零请求
node scripts/infra-bench-verify.mjs --url http://127.0.0.1:45999/v1/chat/completions --model m   # 不可达、退出码 3
node scripts/infra-bench-verify.mjs --dry-run --url http://h:8000 --model m --concurrency 16     # 拒绝、退出码 2
```

压测本身不在这份清单里 —— 它会占 GPU，只能由人来决定什么时候跑（见 §5.1）。
