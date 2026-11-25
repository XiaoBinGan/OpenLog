# AI Infra 能力层：模型服务编排

把「我要一个 vLLM 服务，占一张 4090 的 8 GiB 显存、20% 算力」翻译成 k8s 对象，交给 HAMi +
kube-scheduler 落地。**OpenLog 是控制面，不是数据面**：跑起来的服务不依赖 OpenLog 存活；
OpenLog 挂掉，Pod 照跑，只是暂时改不动配置。

一切变更走同一条链：**定义 → 渲染 → 护栏 → diff → 干跑 → 执行 → 校验 → 可回滚**。
没有「点了直接改」。

---

## 0. 一页速查

| 项 | 值 |
|---|---|
| 总开关 | `OPENLOG_K8S_INFRA=1`（默认关；与 `OPENLOG_K8S_WRITE` 正交） |
| 命名空间白名单 | `inference`、`infra-test`；`kube-system` / `default` / `kube-public` / `kube-node-lease` 显式黑名单 |
| 归属标签 | `managedBy: openlog-infra`（不带这个标签的对象不读不写） |
| 渲染产物 | 只有 `Deployment` + `Service`（集群级对象一律不生成） |
| 网关端口 | `30000..30999`，按服务名稳定哈希；也可用 `expose.gatewayPort` 指定 |
| 服务端代码 | `server/infra/{model,render,guard,capacity,apply,bench}.js`、`server/infra/accelerator/` |
| HTTP 前缀 | `/api/infra/*`（服务端默认端口 `3011`） |
| UI 入口 | `/infra`：定义表单、diff 预览、步骤进度、历史与回滚 |
| 观察侧入口 | `/k8s?cluster=<集群 id>`：GPU 分配 / 实测 / MFU、事件、Pod 表 |
| 鉴权 | `Authorization: Bearer <token>`（`GET /api/auth/token`，仅 localhost） |
| 数据模型 | `ModelService`，字段见[附录 A](#附录-amodelservice-字段) |

三个状态回答「现在能不能动」：

| 状态 | 含义 | 表现 |
|---|---|---|
| 开关没开 | 整层能力关闭 | `/api/infra/*` 返回 `403`（护栏的 `INFRA_DISABLED`），UI 入口灰掉 |
| 预览不过 | 定义 / 护栏 / diff 有问题 | `preview` 返回 `allowed:false` + `violations[]`，集群一个字节没动 |
| 执行中 | 正在改集群 | `apply` 返回 `steps[]`；失败停在第一个 `ok:false` 的步骤，快照可用于回滚 |

---

## 1. 它能做什么

| # | 能力 | 内部实现 | HTTP | UI |
|---|---|---|---|---|
| 1 | 模型服务定义（校验 + 落库） | `validateModelService` | `GET/POST /api/infra/services`、`GET/PUT/DELETE /api/infra/services/:id` | `/infra` 表单 |
| 2 | 渲染清单 | `renderModelService` | 随 `preview` / `apply` 返回 | `/infra` 清单树 |
| 3 | 护栏 + diff + 影响估算 | `checkGuard`、`renderDiff`、`summarizeImpact` | `POST /api/infra/services/:id/preview` | diff 面板 + 「会断多久」 |
| 4 | 干跑 | apiserver server-side dry-run（`dryRun=All`） | `apply` 内部的 `dry-run` 步骤 | 步骤进度 |
| 5 | 执行 | `applyService` | `POST /api/infra/services/:id/apply` | 步骤进度条 |
| 6 | 校验 | `apply` 的 `rollout` + `allocation` + `endpoint` 三步 | 同上（`steps[]`）；服务视图的 `status.phase` / `status.readyReplicas` 随列表接口下发 | 步骤明细 + 每行状态徽标 |
| 7 | 回滚 | `rollbackService` + 快照（`buildSnapshot`） | `POST /api/infra/services/:id/rollback` | 历史页「回滚到 vN」 |
| 8 | 配额下发 | `renderAcceleratorResources` | 随渲染（`spec.containers[0].resources`） | 表单「显存 / 算力」 |
| 9 | 容量预检 | `planPlacement` | `POST /api/infra/capacity` | 暂无 UI 入口（只有接口；`reasons` 直接可读） |
| 10 | 基准与推荐 | `runBenchmark`、`recommendQuota` | `POST /api/infra/bench` | 暂无 UI 入口（面板暂不触发；结果经接口取） |
| 11 | 变更历史 | 快照 + 执行记录（落库见 §3.5） | `GET /api/infra/services/:id/history`，列表接口里也带 `history` | `/infra` 每行服务的历史区 + 「回滚到 vN」 |

> `:id` 既可以是服务 uuid，也可以是 `namespace/name`（前端新建草稿没有 uuid 时就这么传，
> 会做 URL 编码）。下面 runbook 里的 `SERVICE_ID` 两种写法都行。
>
> 路由文件是 `server/routes/infra.js`（挂根、路径写全，与 `/api/k8s/*` 同一套约定）。
> 面板已经在用的四条：`GET /api/infra/services`、`POST /api/infra/services/:id/preview`、
> `POST /api/infra/services/:id/apply`、`POST /api/infra/services/:id/rollback`；
> 定义 CRUD、容量预检、基准、历史单查是同一套约定下的接口，接线后按本表对齐路径。

### 1.1 模型服务定义（ModelService）

`ModelService` 是**用户的意图**，不是 k8s 对象：模型在哪（`model.source` + `path`）、用什么
引擎（`engine.type` + `image`）、要多少资源（`resources`）、几副本（`replicas`）、钉在哪个
型号的卡上（`placement.acceleratorModel`）、要不要走网关（`expose`）。

校验在任何集群操作之前完成，是**白名单式重建**：只从已知字段重新拼 `value`，输入里多出来的
任何字段（`kind`、`apiVersion`、`objects`、`rules`、`metadata`…）一律丢弃 —— 这是防「往定义里
塞一个 ClusterRole 让它跟着 apply 上去」的关键一环。

| 字段 | 规则 | 越界示例 |
|---|---|---|
| `name` | DNS-1123 label（小写字母/数字/`-`，≤63） | `My_Reranker` |
| `namespace` | 必须在 `inference` / `infra-test` | `default`、`kube-system` |
| `engine.image` | 非空（渲染固定 `imagePullPolicy: IfNotPresent`，节点上要有这个镜像） | 空串 |
| `engine.env` | `{ 变量名: 字符串 }`，变量名 POSIX 风格 | `{"MAX_LEN": 4096}`（数字） |
| `resources.accelerators` | `0..8` 的整数 | `16` |
| `resources.memoryMiB` | `0..65536`；`0` 是**整卡模式**（见 §1.8） | `131072` |
| `resources.coresPercent` | `0..100`；`0` 是**不限算力** | `120` |
| `resources.vendor` | `nvidia` / `amd` / `ascend` / `generic`，缺省 `nvidia` | `intel` |
| `replicas` | `1..8` | `0`、`12` |
| `ports[]` | ≤8 个，`containerPort` 在 `1..65535`，`name` 是 DNS-1123 且 ≤15 字符 | 端口 `70000` |
| `health.path` | 缺省 `/health`；`initialDelaySeconds` 在 `0..600` | `-1` |
| `model.path` | `hostPath` 时必须绝对路径，≤1024 字符 | `./models` |
| `id` | 只允许 `[A-Za-z0-9_-]`，≤128（会被拼进 URL，不能带 `/`） | `a/b` |
| `createdAt` / `updatedAt` | 必须是 ISO 时间字符串（渲染前会再校验一次） | `x`、`2026-01-01 00:00:00` |

错误一律中文且可操作：说清「字段 / 允许什么 / 收到什么 / 怎么改」。

### 1.2 渲染清单

一个 `ModelService` 渲染成**同一命名空间内的两个对象**，顺序固定、输出确定：

| 产物 | 关键点 |
|---|---|
| `Deployment` | `replicas: N`；`strategy: Recreate`（GPU 独占：滚动会同时占两份卡，容易把节点撑爆）；`imagePullPolicy: IfNotPresent`；`readinessProbe` 打 `health.path`（`initialDelaySeconds` = 定义值，周期 10s）；`livenessProbe` 在 `initialDelay + 30s` 后才开始（避免加载模型时被杀） |
| `Service` | `ClusterIP`；`port` = 容器端口，`targetPort` = 端口**名**（改名不改数字也不会断） |
| 网关路由 `routes[]` | 仅 `expose` 非空时有：`{ port, upstream }`，上游固定 `<name>.<namespace>.svc.cluster.local:<主端口>`。**只是渲染输出，不是 k8s 对象** —— 本层不写网关 ConfigMap（见 §2） |

决定调度形态的两个字段：

| 字段 | 效果 |
|---|---|
| `resources.memoryMiB > 0` | 挂 `schedulerName: hami-scheduler`，走 HAMi vGPU 切片 |
| `resources.memoryMiB === 0` | 整卡独占，不挂 HAMi 调度器，只申请整卡 |
| `placement.acceleratorModel` | 渲染成 `nodeAffinity`（必须匹配的节点标签键：`openlog.io/accelerator-model`） |
| `placement.nodeSelector` | 直接进 `pod.spec.nodeSelector`（钉在有 hostPath 数据的节点上） |

对象上的归属与来源信息：

| 位置 | 内容 |
|---|---|
| `metadata.labels['managedBy']` | `openlog-infra` —— **渲染时就打上**，不是执行器事后补 |
| `metadata.labels['app.kubernetes.io/managed-by']` | 同一个值（通用惯例那份），两个键由单测跨模块断言相等 |
| `metadata.annotations['openlog.io/service-key']` | `<namespace>/<name>` |
| `metadata.annotations['openlog.io/renderer']` | `openlog-infra/v1` |
| `metadata.annotations['openlog.io/{model-source,model-path,accelerators,memory-mib,cores-percent}']` | 本次渲染用的意图快照，便于事后核对 |
| 容器环境变量 | `MODEL_SOURCE`、`MODEL_PATH`、`MODEL_FORMAT`、`MODEL_QUANTIZATION`、`MODEL_CONTEXT_LENGTH`、`ENGINE_TYPE`、`OPENLOG_SERVICE_KEY`、`OPENLOG_RENDERER`，`engine.env` 可覆盖同名项 |

渲染末尾还有一道兜底断言：出现非 `Deployment` / `Service` 的对象、或跨命名空间的对象，直接抛错
（中文），防止未来改动把集群级对象带出去。

### 1.3 护栏、diff 与影响估算

`preview` 一次给出三样东西，都是**点提交之前**必须看到的：

```json
{ "allowed": false, "violations": [{ "code": "BIG_CHANGE", "field": "replicas", "message": "…" }],
  "diff": "--- before\n+++ after\n…", "impact": { "action": "update", "restarts": true, "downtimeSeconds": 60, "reasons": ["…"] } }
```

| 输出 | 说明 |
|---|---|
| `allowed` | 只认布尔 `true`；任何违规未覆盖就是 `false` |
| `violations[]` | `{ code, field?, message, overridden? }`；`code` 给机器分支，`message` 给人看且必须能指导操作 |
| `diff` | unified 文本 diff，最多 200 行（超出标注截断）；比较前剥掉 `resourceVersion` / `uid` / `managedFields` 等易变字段，否则永远「有变化」 |
| `impact` | `action`（create/update/delete/noop）、`restarts`（是否重建 Pod）、`downtimeSeconds`、`reasons[]` |

`impact` 的两个口径要注意：后端 `summarizeImpact` 给的字段名是 `downtimeEstimateSec`，面板读的是 `downtimeSeconds`，由接线层映射；面板自身的兜底估算按「每副本 30 秒」算，护栏按「单副本 60 秒」算 —— **以护栏的数为准**（它更保守，且知道副本能否滚动）。

**中断估算是产品必须说清楚的事实**，不是装饰：

| 情形 | `restarts` | `downtimeSeconds` |
|---|---|---|
| 改配额 / 镜像 / 启动参数 / 亲和 / 端口 / 探针，`replicas: 1` | `true` | **60**（没有副本承接流量，保守值） |
| 同上但变更前后都 ≥2 副本 | `true` | **5**（就绪探针逐个替换，只有连接抖动） |
| 只改 `replicas` | `false` | **0**（扩缩容不重建已有 Pod） |
| 只改网关 / 暴露 | `false` | **0** |
| 新建 / 删除 | `false` | `0`（新建仍要等模型加载；删除是整体下线，不可回滚） |

### 1.4 干跑

干跑不发对象，走 apiserver 的 server-side dry-run（`dryRun=All`）—— 由 apiserver 自己回答
「这份清单能不能被接受」，而不是我们猜。它抓得住：

- 字段拼错、类型不对、`immutable` 字段被改（**改配额属于这一类**）
- RBAC 不足（`forbidden`）、配额策略拒绝（`exceeded quota`）
- 命名空间内的同名对象冲突（`AlreadyExists`，通常意味着有人手工建过同名对象）

它抓不住：显存够不够、镜像在不在节点上、端口有没有被 docker 容器占着、网关端口会不会和既有
路由撞车。那些属于容量预检（§1.9）和 §5。

### 1.5 执行

`apply` 是一条有序状态机，步骤名固定（前端拿它渲染「还没走到」的灰条），任一步 `ok:false`
立刻停，**并自动回滚**：

| 序 | `step.name` | 做什么 | 失败含义 |
|---|---|---|---|
| 1 | `guard` | 白名单 / 开关 / 归属 / 上限 / 变更幅度（§3）再查一遍 | 被拦，**零 API 调用**，集群没动 |
| 2 | `dry-run` | `dryRun=All`；顺带做 diff，无实质差异 → `action: noop`，后面不再发写请求 | 清单被 apiserver 拒绝（返回 k8s 原话 + 中文包装） |
| 3 | `snapshot` | 读旧对象存进快照（回滚的唯一依据） | 存不下就别执行 |
| 4 | `apply` | create 走 `POST` 集合路径，update 走 `PATCH` merge-patch | 权限或上游错误 |
| 5 | `rollout` | 轮询 `deployment.status`，直到 `observedGeneration` / `updated` / `available` 都到位（默认 120s 超时、2s 轮询） | 排不上卡 / 起不来 / 镜像拉不到 |
| 6 | `allocation` | 读新 Pod 的 `hami.io/vgpu-devices-allocated`，核对「申请的显存 / 算力 / 卡数」 | **「改了但没生效」在这里被抓**：注解缺失或小于申请值 |
| 7 | `endpoint` | 可选探针（默认 3 次、间隔 1s、单次 5s，只认 2xx） | 起来了但服务不可用 |
| — | `rollback` | 任一步失败后追加：有旧快照就 `PATCH` 回去，没有就 `DELETE` 本次新建的对象 | 回滚失败会点名「集群可能处于中间状态，请人工核对哪些对象」 |

返回 `{ ok, allowed, action, steps[], snapshot, rollbackAvailable, error?, errorStep?, rollback? }`。

| 字段 | 说明 |
|---|---|
| `action` | `create` / `update` / `noop` / `rejected` |
| `steps[]` | 每项 `{ name, ok, detail, ms }`；`detail` 里带可操作信息 |
| `snapshot` | 变更前的对象与「当时是否存在」，回滚按它复原 |
| `rollbackAvailable` | 是否还值得调回滚（`noop` / 已成功回滚后为 `false`） |
| `errorStep` | 停在哪一步，与 `steps` 里最后一条对齐 |
| `rollback` | 自动回滚的报告（只在失败时出现） |

### 1.6 校验

`endpoint` 探针之外，持续观察都在观察侧完成 —— 这一层不重复实现一套监控：

| 看什么 | 接口 | 字段 |
|---|---|---|
| 分配 / 实测 / MFU | `GET /api/k8s/clusters/:id/usage` | `nodes[].devices[].{allocMemMiB,usedMemMiB,utilPercent,measured}`、`nodes[].mfu.percent` |
| 调度策略（binpack / spread、超卖比） | `GET /api/k8s/clusters/:id/policy` | `nodeSchedulerPolicy`、`overcommit`（各带 `source`） |
| Warning 聚合 | `GET /api/k8s/clusters/:id/warning-digest?window=1h` | 按 `reason` 分组、计数、最后发生时间 |
| Pod 状态 | `GET /api/k8s/clusters/:id/overview` | `pods[].{phase,ready,restarts,reason,message}` |

### 1.7 回滚

回滚恢复的是**快照里存下来的对象原样**，不是「重新渲染一遍旧定义」。两条入口，同一个实现：

| 入口 | 触发 | 行为 |
|---|---|---|
| 自动回滚 | `apply` 任一步失败 | 用本次 `snapshot` 调 `rollbackService`，把对象 PATCH 回变更前；本次新建的对象 DELETE |
| 手动回滚 | `POST /api/infra/services/:id/rollback {version}` | 取该版本的历史快照，走同一条 `rollbackService` |

行为细节（都写在 `steps` 里，`restore:<Kind>/<name>` 或 `delete:<Kind>/<name>`）：

- 每个对象**独立 try**：一个恢复失败不阻断其余对象（尽量把集群拉回已知状态），但整体 `ok:false`
  并点名「集群可能处于中间状态，请人工核对哪几个对象」
- 删除时 404 视为已达成目标（对象本来就不在）
- 快照为空 → `ok:true` + 一条说明，不猜、不乱删
- 回滚**不重新渲染、不重新过护栏**：快照是当初渲染并经护栏放行的对象，原样恢复；也因此
  **不会重新评估当前容量** —— 如果集群现在没地方放旧配额，回滚照样 PATCH，然后 Pod 起不来。
  回滚之后必须重新走一遍观察（§1.6）
- 回滚本身也留痕（`steps` 里追加的 `rollback` 步骤 + 历史一条 `action: rollback`）

### 1.8 配额下发

`resources` 经加速卡适配器翻译成 k8s 扩展资源（矩阵见 [INFRA-COMPAT.md](./INFRA-COMPAT.md)）：

| 意图 | 渲染成 |
|---|---|
| NVIDIA：`accelerators: 1, memoryMiB: 8192, coresPercent: 20` | `nvidia.com/gpu: "1"`、`nvidia.com/gpumem: "8192"`、`nvidia.com/gpucores: "20"` |
| NVIDIA：`accelerators: 1, memoryMiB: 0`（整卡） | 只有 `nvidia.com/gpu: "1"`，且不挂 `hami-scheduler` |
| AMD：`accelerators: 2, memoryMiB: 0, coresPercent: 0` | `amd.com/gpu: "2"`（只有整卡申请这一条路） |
| Ascend：`accelerators: 1, memoryMiB: 8192` | `huawei.com/Ascend910: "1"` + `huawei.com/Ascend910-memory: "8192"`（后者只有装了切分版插件的集群才有） |
| generic：`accelerators: 1` + 节点上的 `resourceKey` | `<domain>.com/gpu: "1"`（键从节点实际资源里取，不猜） |

以下组合**明确报错**而不是静默丢字段（错误带 `code: 'ACCELERATOR_INVALID'`，文案可直接展示）：

| 组合 | 为什么拒绝 |
|---|---|
| `memoryMiB: 0` + `coresPercent > 0` | 整卡语义下没有地方挂算力配额：整卡就是 100%，再限算力只会得到无法解释的行为 |
| `memoryMiB > 0` + `accelerators: 0` | 没有卡就没有配额可挂 |
| AMD 且 `memoryMiB > 0` 或 `coresPercent > 0` | AMD 只有整卡申请，没有切分资源 |
| Ascend 且 `coresPercent > 0` | 昇腾没有算力配额资源（不存在对应的扩展资源键） |
| 直接调 `renderAcceleratorResources` 且没给 `vendor` | 不知道用哪家的键。注意：走服务定义的渲染路径会先补默认 `nvidia`，这条只在直接调用适配器层时出现 |

`requests` 与 `limits` 写同一组值：HAMi 按 `limits` 分配 vGPU 份额，`requests` 低于 `limits`
只会让调度器低估占用。

### 1.9 容量预检

`planPlacement` 在**改集群之前**回答「放得下吗、为什么放不下、放完还剩什么」：

| 输出 | 含义 |
|---|---|
| `fits` | 全部副本是否都有落点 |
| `candidates[]` | 每个节点：是否合格（型号亲和）、剩余显存/算力/槽位、能放几个副本、放完剩多少 |
| `best` | 承载副本最多的节点（并列时取放完剩余最少的，即最紧凑） |
| `reasons[]` | 中文结论 + 逐条原因（差多少、为什么） |
| `fragments[]` | 碎片：放完剩下的「显存 + 算力」还能塞下什么规格 |
| `plan[]` / `unplaced` | 逐副本落点（`{replica, node, cards}`）/ 第一个放不下的副本及原因 |
| `warnings[]` | 数据异常（超额分配、采集失败等），不参与判定但要看见 |

预检的核心硬约束（用户最常踩的坑）写在返回的 `reasons` 里：

> HAMi 是单卡语义：一个副本的显存/算力必须由同一张卡提供，两张卡各剩一半也拼不成一个副本。

预检是估算，不是承诺：真正的裁决在 kube-scheduler / HAMi。预检说 `fits: true` 而 Pod 仍
`Pending`，看 §5.1。

### 1.10 基准与推荐

`runBenchmark` 给一个**已经跑起来的**服务跑「并发 × 上下文长度」矩阵，产出 TTFT、吞吐、
显存峰值，并反推可填回 `resources` 的推荐配额。

| 参数 | 默认 | 说明 |
|---|---|---|
| `matrix.concurrencies` | `[1, 4, 8]` | 每个并发档一个 cell |
| `matrix.inputTokens` | `[512, 4096]` | 上下文档 |
| `limits.maxConcurrency` | 8 | 单 cell 并发上限，矩阵写更大也会被夹到这一档 |
| `limits.maxRequestsPerCell` | 20 | 单 cell 请求上限（含失败），防止一档组合跑成压力测试 |
| `limits.maxTotalMs` | 120000 | 整轮墙钟上限，超过就收手 |
| `limits.maxErrorRate` | 0.2 | 错误率上限，超过立即中止 |
| `limits.maxP95TtftMs` | 30000 | p95 首 token 延迟上限 |
| `limits.maxTokensPerSec` | 100000 | 吞吐上限（防统计错误把数字跑飞） |

- 矩阵**串行**跑（一个组合跑完再下一个），每个组合内部才放并发
- 任一安全阀越界立刻中止，已拿到的结果原样返回（`aborted: true` + `reason`）
- 网络访问一律通过注入的 `fetchImpl`；没注入直接 `ok:false`，不存在「顺手打一下线上」的默认路径
- 输出：`results[]`（每格并发/输入长度/TTFT/吞吐/失败原因）、`summary.best`、
  `summary.recommended.{memoryMiB, coresPercent, confidence, basis, notes}`

推荐值只是**建议**：`confidence: measured` 表示读过显存峰值，`estimated` 表示峰值缺失、
只能按吞吐反推；换卡、换引擎版本、换量化都要重跑。

---

## 2. 它不能做什么

诚实清单。这些不是「以后再说」，是当前设计的边界：

| 不能做 | 为什么 | 该去哪做 |
|---|---|---|
| **不做训练** | 只编排推理服务（`vllm` / `sglang` / `llama.cpp` / `strata` / `tgi`）；没有 job 队列、checkpoint、分布式通信拓扑 | 训练任务用 k8s Job / Kubeflow，本层不接管 |
| **不替代 k8s 或 HAMi** | 不实现调度器、不实现 device-plugin、不改 kubelet；只生成标准对象 | 超卖、binpack、vGPU 隔离由 HAMi 提供 |
| **不能跨卡拼显存** | 一个副本的显存/算力必须来自**同一张卡**；两张 24 GiB 各剩一半拼不成 48 GiB | 需要跨卡 = 张量并行，属于引擎参数（`accelerators: N` + 引擎自己的 `tensor-parallel-size`） |
| **改配额必须重建 Pod** | 扩展资源在 Pod spec 里不可原地修改，`limits` 一变就等价于换 Pod | 没有绕过的办法，只能把中断安排进窗口（§4.2） |
| **单副本改配额必然中断** | `replicas: 1` 时唯一的副本被重建，没有第二个副本接流量（估算 60s） | 要降中断就先加副本再改配额（§4.2 可选步骤） |
| **不写网关配置** | `routes[]` 只把「该开哪个端口、转发给谁」算出来；把路由落进 nginx ConfigMap 并滚动网关，仍由运维或接线层完成。本层不碰 ConfigMap，也就不会把网关改坏 | 手工改 `reranker-gateway-conf`（§5.2 有兜底步骤） |
| **只生成 Deployment / Service** | 不生成 StatefulSet、Ingress、PVC、Namespace、CRD；集群级对象必须由运维手工管理 | 需要稳定 per-Pod 标识（StatefulSet）或 PVC 时，写 `deploy/` 里的清单手工 `kubectl apply` |
| **不会替你打节点标签** | 型号亲和依赖节点标签 `openlog.io/accelerator-model`；HAMi 依赖 `gpu=on` | 集群侧一次性配置（`kubectl label node`） |
| **无 GPU 硬件时无法验证别家卡** | AMD / Ascend 适配器只有 fixture 级验证，没在真卡上跑过 | 上真机前按 INFRA-COMPAT 的「新增一家卡」清单验一遍 |
| **不猜** | 型号认不出来、峰值算力表里没有、`nvidia-smi` 采不到 → 显式 `null` / `measured: false` / `reason`，不拿 0 冒充 | 看到 `—` 就是没数据，不是「利用率为 0」 |
| **不做跨集群编排** | 一次 apply 只对一个集群；多集群是多个独立定义 | 多集群各自定义，或用同一份模板分别 apply |
| **演示模式不写集群** | `OPENLOG_DEMO=1` 时写请求 `409`，永远不会落到真实集群 | 演示实例只用来点界面 |

---

## 3. 安全模型

从外到内六道闸门。任何一道不满足，集群一个字节都不会被改。

| 闸门 | 规则 | 被拦时的表现 |
|---|---|---|
| 开关 | `OPENLOG_K8S_INFRA === '1'` 才放行写路径（只认字面量 `'1'`） | `violations[]` 一条 `INFRA_DISABLED`，`allowed:false` |
| 演示模式 | `OPENLOG_DEMO=1` 优先于开关 | `409` |
| 命名空间白名单 | 只允许 `inference` / `infra-test`；系统命名空间即使「名字合法」也拒绝 | `NAMESPACE_FORBIDDEN` |
| 归属标签 | 只改 / 只删带 `managedBy: openlog-infra` 的对象 | `NOT_MANAGED` |
| 资源上限 | 显存 ≤ `maxMemoryMiB`（默认 65536）、加速卡 ≤ 8、副本 `1..8` | `MEMORY_LIMIT_EXCEEDED` / `ACCELERATOR_LIMIT_EXCEEDED` / `REPLICAS_LIMIT_EXCEEDED` |
| 变更幅度 | 单次副本数或显存配额变动超过 `changeFactor`（默认 **4 倍**）→ 拒绝，需显式 `force` | `BIG_CHANGE`（唯一可被 `force` 覆盖的码） |

违规码全表（前端按 `code` 分支，**不要** match 文案）：

| `code` | 含义 | 可否 `force` |
|---|---|---|
| `INVALID_SERVICE` | 请求缺字段/形状不对，护栏无法判断安全性 | 否 |
| `NAMESPACE_FORBIDDEN` | 命名空间不在白名单（含系统命名空间） | 否 |
| `INFRA_DISABLED` | `OPENLOG_K8S_INFRA !== '1'` | 否 |
| `NOT_MANAGED` | 同名对象已存在但不归本系统管 | 否 |
| `MEMORY_LIMIT_EXCEEDED` | 单 Pod 显存配额超上限 | 否 |
| `ACCELERATOR_LIMIT_EXCEEDED` | 每副本加速卡数超上限 | 否 |
| `REPLICAS_LIMIT_EXCEEDED` | 副本数超上限 | 否 |
| `BIG_CHANGE` | 单次变更幅度 > 4 倍 | **是**（进 `audit.forced[]`） |

### 3.1 命名空间白名单

白名单是**代码级常量**（`server/infra/model.js#NAMESPACE_WHITELIST` 与
`server/infra/guard.js#ALLOWED_NAMESPACES`），不是配置项：改它要改代码、过测试、重新发布。
原因很直白 —— 这一层能创建 Deployment、改配额，指向 `kube-system` 等于给了一个「让集群自己
挂掉」的按钮。

护栏对**意图和现状两侧**都查命名空间：既防写进系统命名空间，也防误删。

`infra-test` 是验收沙箱（`deploy/k8s/cluster/40-infra-test-namespace.yaml`）：独立命名空间 +
`ResourceQuota`（`nvidia.com/gpu: 2`、`gpumem: 16384`、`gpucores: 200`）+ `LimitRange` +
入站 `NetworkPolicy`。清单写错、Pod 起不来、配额申请超量，都只在 Namespace 边界内失败。

### 3.2 两个开关正交

| 开关 | 管什么 | 不开的后果 |
|---|---|---|
| `OPENLOG_K8S_INFRA=1` | 本层：定义服务、渲染、apply、回滚、基准 | `/api/infra/*` 写路径被 `INFRA_DISABLED` 拦 |
| `OPENLOG_K8S_WRITE=1` | 通用 k8s 写操作：scale、rolling restart、删 Pod | 那三个端点 `403`，但本层照常（本层不经过通用写路由） |

只想手动扩缩容就开 `WRITE`；想用模型服务编排就开 `INFRA`。两个都开也行 —— 写操作的记录里 `action` 能分清是哪条路径发起的。

### 3.3 只改带标签的对象

`managedBy: openlog-infra` 是这一层的**所有权凭据**。它由渲染器直接写进对象（
`render.js` 的 `MANAGED_BY_KEY` / `MANAGED_BY_LABEL`，值与 `guard.js` 共用并由单测跨模块断言），
因此「护栏认不出自己渲染的对象」这种漂移不可能发生：

- 需要补标时只有一个入口（`guard.markManaged`），不各处手写，避免格式漂移
- 同名但没标签的对象（手工 `kubectl apply` 的、别的工具生成的）→ `NOT_MANAGED`，禁止改/删，
  提示「换一个 name，或人工迁移」
- 定义里自己写 `labels.managedBy` 且值不是 `openlog-infra` → 同样 `NOT_MANAGED`（冒用别人的
  归属标签会污染清理逻辑）
- 回滚只动快照里的 `ref`（不看标签，见 §3.6）：不会因为回滚一个服务就把别人手工建的对象带走

### 3.4 变更幅度保护

误操作最典型的形态是「副本从 6 改成 1」或「显存从 512 改成 8192」。规则：

- 副本数、显存配额任一项单次变动超过 `changeFactor` 倍（默认 **4**）→ `BIG_CHANGE`
- 只有这条能被显式 `force: true` 覆盖，覆盖后 `violations[].overridden = true`，并在
  `audit.forced[]` 里留痕（合法路径是「先拆成两步小改动」）
- `0` 表示「不限制 / 整卡」，与任何非 0 值互换都按「幅度过大」处理 —— 这个不对称是刻意的
- 上限可被 `settings` 覆盖（`maxMemoryMiB` / `maxAccelerators` / `maxReplicas` /
  `changeFactor`），但**非法覆盖静默回落到默认值**：配置写错不能把护栏放开

### 3.5 审计与历史

分三层，别混为一谈：

| 层 | 产自哪里 | 内容 | 用途 |
|---|---|---|---|
| `force` 留痕 | `checkGuard` 的返回值 `audit` | `{ forced: ['BIG_CHANGE'], note }` —— 只收「被显式覆盖」的违规码 | 证明这次大幅变更是有人按过确认的 |
| 执行记录 | `applyService` 的返回值 | `steps[]`（每步 `name/ok/detail/ms`）+ `snapshot`（变更前对象）+ `action` + `errorStep` | 回答「这次到底改了什么、停在哪」，`snapshot` 同时是回滚依据 |
| 变更历史 | 接线层落库后随列表接口下发 | 每条 `{ version, at, action, ok, actor?, note? }` | UI 历史区与「回滚到 vN」按 `version` 定位 |

**这一层自己不写审计表**：`snapshot` 与 `steps` 是它给出去的第一手证据，落库、加 `auditId`、
记「谁改的」由路由层/存储层完成（发起人只能从请求头与认证方式推断）。所以审计的可追溯性
取决于接线层有没有把上面两样存下来 —— 部署时先确认这一点，再谈「事后能还原」。

审计是**事后回答**用的，不是事前拦截用的；拦截靠上面五道闸门。

### 3.6 回滚的边界

回滚**不重新过六道闸门**，它恢复的是快照里的对象原样（快照来自白名单内渲染、并经护栏放行的
那次 apply）。所以它的安全边界不是「再检查一遍」，而是这三条：

1. **只动快照里的 ref**：`rollback` 的输入是 `snapshot.objects[]`，每个条目带 `{ref, existed, body}`；
   快照之外的任何对象都不在它的视野里
2. **不会凭空创建**：`existed: false` 的条目只做 DELETE（且 404 视为已达目标），不会去创建
   「记忆里应该有」的对象
3. **来源受限**：快照只能由 `applyService` 产生（或历史里存下来的同一份），不是任意对象数组 ——
   虽然 `rollbackService` 为了兼容也接受原始对象数组，但那条路径不做白名单校验，
   属于接线层要自己守住的地方

换句话说：「回滚绕过护栏」不是漏洞，而是设计前提 —— 护栏在**写入的那一刻**已经过了一遍。
真正的风险在另一处：回滚不看当前容量（见 §1.7 最后一条），回滚成功 ≠ 服务能起来。

---

## 4. 日常操作 runbook

下文假设：服务端 `http://127.0.0.1:3011`，`TOKEN` 取自 `GET /api/auth/token`（仅 localhost），
集群 id `CLUSTER_ID`（`/k8s` 页可见），服务 id `SERVICE_ID`。

```bash
TOKEN=$(curl -s http://127.0.0.1:3011/api/auth/token | jq -r .token)
API=http://127.0.0.1:3011/api/infra
AUTH="Authorization: Bearer $TOKEN"
```

### 4.1 起一个新模型服务

**前置检查**（缺一条就别往下走）：

| 检查 | 怎么看 |
|---|---|
| 集群已注册且能连 | `/k8s` 页集群行显示 apiserver 版本 + 节点数 |
| 命名空间存在 | `inference`（生产）或 `infra-test`（验收，带 ResourceQuota） |
| 节点能跑 GPU | HAMi device-plugin 的 DaemonSet 在跑，节点打了它要的标签（常见约定 `gpu=on`） |
| 型号标签（用了亲和才需要） | 节点带 `openlog.io/accelerator-model=NVIDIA GeForce RTX 4090` 这类标签 |
| 模型目录在目标节点上 | `hostPath` 是节点本地路径，跨节点挂不到；用 `placement.nodeSelector` 钉住 |
| 网关 Pod 在跑 | `inference` 里的 hostNetwork nginx（`reranker-gateway`）；没有它就没有对外端口 |

**步骤**：

1. 容量预检（不写集群）：

   ```bash
   # 节点与占用由服务端从已注册集群读取（集群在 /k8s 里管理）
   curl -s -X POST "$API/capacity" -H "$AUTH" -H 'content-type: application/json' -d '{
     "service": {
       "name": "qwen-7b", "namespace": "inference",
       "model": { "source": "hostPath", "path": "/workspace/coder/models/Qwen2.5-7B-Instruct" },
       "engine": { "type": "vllm", "image": "vllm/vllm-openai:latest" },
       "resources": { "accelerators": 1, "memoryMiB": 16384, "coresPercent": 50 },
       "replicas": 1,
       "placement": { "nodeSelector": { "kubernetes.io/hostname": "node1" } },
       "ports": [{ "name": "http", "containerPort": 8000 }],
       "health": { "path": "/health", "initialDelaySeconds": 60 },
       "expose": {}
     }
   }' | jq '{fits, best, reasons, fragments}'
   ```

   `fits: false` 就按 `reasons` 改（换节点 / 降显存 / 等别人腾卡），不要硬 apply。

2. 创建定义（服务端先校验；不合法返回 `errors[]`，不落库）：

   ```bash
   curl -s -X POST "$API/services" -H "$AUTH" -H 'content-type: application/json' \
     -d @qwen-7b.json | jq '{id, version, errors, violations}'
   ```

3. 预览（diff + 影响估算，不写集群）：

   ```bash
   curl -s -X POST "$API/services/SERVICE_ID/preview" -H "$AUTH" \
     -H 'content-type: application/json' -d "$(jq -nc --slurpfile s qwen-7b.json '{service:$s[0]}')" \
     | jq '{allowed, violations, impact, diff}'
   ```

   `diff` 里应该只有「新增」；出现 `-` 行说明这次会改到已有对象，逐行看清再继续。
   `impact` 是这次要付的代价（新建通常是 `restarts:false`、`downtimeSeconds:0`，但模型加载
   仍要等）。

4. 执行：

   ```bash
   curl -s -X POST "$API/services/SERVICE_ID/apply" -H "$AUTH" -H 'content-type: application/json' \
     -d "$(jq -nc --slurpfile s qwen-7b.json '{service:$s[0]}')" \
     | jq '{ok, action, errorStep, steps: [.steps[] | {name, ok, detail}]}'
   ```

   `ok: true` 且校验步骤通过 = 服务起来了。`ok: false` → §4.4。

5. 验收：

   ```bash
   # 网关端口直连：hostNetwork，节点 IP + 分配到的端口。
   # expose.gatewayPort 没写时按服务名哈希（示例：qwen-7b → 30601），实际值看渲染出的 routes
   curl -s http://NODE_IP:30601/v1/models | jq '.data[].id'
   # 集群侧一致性：分配到了多少
   curl -s -H "$AUTH" "http://127.0.0.1:3011/api/k8s/clusters/CLUSTER_ID/usage" \
     | jq '.nodes[] | {name, mfu: .mfu.percent,
                        devices: [.devices[] | {uuid, allocMemMiB, usedMemMiB, measured}]}'
   ```

### 4.2 给服务加显存

**先接受两件事**：改配额 = 重建 Pod；`replicas: 1` 时必然中断，估算 **60 秒**。

| 情形 | 中断形态 |
|---|---|
| `replicas: 1` | 旧 Pod 删 → 新 Pod 起（镜像本地 + 模型已在 hostPath 时通常几十秒，冷启动更久），这段时间服务不可用 |
| `replicas: N ≥ 2` | 就绪探针逐个替换，估算 **5 秒**连接抖动；网关是同一个 Service，不涉及端口变化 |

**做法（单副本，接受中断）**：

1. 预检目标配额放得下：`POST $API/capacity`（把 `memoryMiB` 改成目标值）。
2. 记录当前版本号：`GET $API/services/SERVICE_ID` → `version`。
3. 改定义：`PUT $API/services/SERVICE_ID`（`memoryMiB: 5888 → 8192`）。
   变动 1.39 倍，不触发 `BIG_CHANGE`。
4. 预览：`POST $API/services/SERVICE_ID/preview`，body `{ "service": <改后的完整定义> }`
   （不发写请求；服务端干跑在 apply 的 `dry-run` 步骤）。diff 里应只有
   `resources.limits.nvidia.com/gpumem` 一行变化；出现别的东西说明改多了。
   `impact.restarts` 应为 `true`、`downtimeSeconds` 应为 60。
5. 执行：`POST $API/services/SERVICE_ID/apply`，盯 `steps`。第 5 步 `rollout` 之后还有第 6 步
   `allocation`：它读新 Pod 的 `hami.io/vgpu-devices-allocated`，核对真的拿到了 `8192 MiB`。
   这一步才是「改了配额」的判据 —— `rollout` 绿了但 `allocation` 红，说明 Pod 起来了却没拿到配额
   （典型：申请超过单卡余量、`gpucores` 与 `memoryMiB` 组合非法）。
6. 再进容器确认（**看容器内，而不是看 YAML**）：

   ```bash
   # HAMi 下容器内看到的 memory.total 就是配额，不是物理卡容量
   kubectl -n inference exec <pod> -- nvidia-smi --query-gpu=memory.total --format=csv,noheader
   ```

   期望 `8192 MiB`。还是旧值（比如 5888）说明新 Pod 没起来、旧 Pod 还在服务 ——
   去 `/k8s` 看 Pod 是否 `Pending`（§5.1）。

**回滚（起不来 / 配额没生效 / 业务不接受中断）**：

```bash
curl -s -X POST "$API/services/SERVICE_ID/rollback" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"version": <上一个版本号>}' | jq '{ok, steps, rollbackAvailable}'
```

回滚同样重建 Pod，同样中断；不要指望「回滚是瞬间的」。

**要降低中断（`replicas ≥ 2` 才可能）**：

1. 先加副本：`PUT` 把 `replicas` 提到 2，`apply`。注意 `1 → 2` 是 2 倍，不触发 `BIG_CHANGE`；
   `1 → 8` 是 8 倍，会被要求 `force`。
2. 等新副本 `Ready`（`GET /api/k8s/clusters/CLUSTER_ID/overview` 看 `ready`）。
3. 再改配额：`memoryMiB` 提到目标值，`apply`，接受逐个替换（估算 5 秒抖动）。
4. 按需缩回原副本数。

每一步都要先过容量预检：第 1 步会额外占一份显存，卡上可能已经没有余量了。

### 4.3 回收空转配额

空转的典型形态：**分配 80%，实测 4%** —— 抢到 vGPU 显存后闲置。判断靠三层数据，任何一层
单独看都会误判。

| 层 | 字段 | 来源 | 什么时候不可信 |
|---|---|---|---|
| 分配（allocated） | `nodes[].devices[].allocMemMiB`、`allocCores` | HAMi 节点注解 `hami.io/node-nvidia-register` + Pod 的 `hami.io/vgpu-devices-allocated` | 只看它 → 永远「满载」 |
| 实测（actually used） | `usedMemMiB`、`utilPercent`、`measured` | 各节点 `nvidia-smi`（走已配置的 SSH） | `measured: false` = 这台机器采不到，`0` 不是「真的 0」 |
| MFU | `nodes[].mfu.percent`、`mfu.engines[]` | 引擎 `/metrics` 差分（tokens/s ÷ 峰值算力） | 峰值算力表里没有这张卡 → `mfu.available: false` |

一次拿齐三层：

```bash
curl -s -H "$AUTH" "http://127.0.0.1:3011/api/k8s/clusters/CLUSTER_ID/usage" | jq '
  .nodes[] | {
    node: .name,
    mfu: .mfu.percent,
    devices: [.devices[] | {
      uuid, alloc: .allocMemMiB, used: .usedMemMiB, util: .utilPercent, measured,
      holders: [.pods[] | {pod: .name, mem: .memMiB}]
    }]
  }'
```

判据（观察窗口 ≥ 30 分钟，避免把「刚起来还在加载模型」当成空转）：

| 分配 | 实测 util | MFU | 结论 |
|---|---|---|---|
| 高 | 持续 < 5% | `available: false` 或 < 5% | **空转**：抢了配额不干活 → 回收 |
| 高 | 波动 30%~90% | 20%~60% | 正常在用，别动 |
| 高 | < 5% | ≥ 20% | 矛盾：多半是 `nvidia-smi` 与引擎不在同一张卡上，先核对 UUID |
| `measured: false` | — | — | 采不到数，**先修采集**（SSH / `nvidia-smi` 权限），不要据此回收 |

回收动作，从轻到重：

| 动作 | 影响 | 命令 |
|---|---|---|
| 降副本 | 少一个副本（降到 0 则服务停）；不重建已有 Pod | `PUT` `replicas: N-1` → `preview` → `apply` |
| 降显存配额 | 重建 Pod（估算 60s / 5s） | `PUT` `memoryMiB` → `preview` → `apply`（§4.2） |
| 整个服务下掉 | 服务消失，不可回滚到「还在跑」 | `DELETE $API/services/SERVICE_ID`（先 `GET` 保存定义） |

回收前确认没有别的副本扛同样流量：`GET /api/k8s/clusters/CLUSTER_ID/overview` 看
`workloads[].ready`，别把唯一入口收了。降幅过大（如显存 8192 → 1024，8 倍）会被
`BIG_CHANGE` 拦下，要求拆成两步。

### 4.4 服务起不来怎么查

按 `apply` 返回的 `steps[]` 逐项对。**失败之后第一件事**：别重复 apply，先看集群为什么拒绝。

| 停在哪一步 | 现象 | 去看什么 | 常见原因 |
|---|---|---|---|
| （apply 之前） | `errors[]` | 错误里的字段名 | 定义非法（§1.1 表） |
| `guard` | `violations[]` + `allowed:false` | 每条 violation 的 `code` + `message` | 命名空间越界 / 开关没开 / 不归本层管 / 超上限 / 幅度保护 |
| `dry-run` | apiserver 原文 | 错误体 `message` | 字段拼错、`immutable` 被改、RBAC 不足 |
| `apply` | `403` / `502` | 上游状态码 | 开关没开、token 无权限、apiserver 不可达 |
| `rollout` | 120s 内未就绪 | `overview` 的 `pods[]`（`phase` / `reason` / `message`）+ `warning-digest` | 见下面几条 |
| `allocation` | 起来了但配额不对 | `steps` 里 `allocation` 的 `detail`（期望值 vs 注解实际值） | 申请超单卡余量、`gpucores`/`gpumem` 组合非法、节点没装 HAMi |
| `endpoint` | health 打不通 | Pod 日志（`/k8s` 日志抽屉）+ `health.path` | 端口写错、`initialDelaySeconds` 太小、引擎还在加载模型 |

「等就绪」失败的典型：

| 现象 | 诊断 | 处置 |
|---|---|---|
| `Pending`，事件 `CardInsufficientMemory` | 申请的 `gpumem` 在这张卡上不够 | 降 `memoryMiB` 或换节点（§5.1） |
| `Pending`，事件 `CardInsufficientCore` | `gpucores` 配额占满 | 降 `coresPercent` 或等邻居释放 |
| `Pending`，无 GPU 相关事件 | 节点亲和/标签不匹配、节点不可调度 | 核对 `placement.nodeSelector` 与 `openlog.io/accelerator-model` 标签 |
| `Pending`，事件提到 hostPort / 端口 | 端口被占 | §5.3 |
| `CrashLoopBackOff`，日志 `bind: address already in use` | 端口被占（docker 容器 / 别的 hostPort Pod） | §5.3 |
| `CrashLoopBackOff`，**网关**日志 `host not found in upstream` | 网关配置里的上游 Service 不存在 | §5.2 |
| `ImagePullBackOff` | `IfNotPresent` 但节点上没有这个镜像 | 把镜像 load 到节点，或改成可拉取的仓库地址 |
| `Running` 但 `ready: 0/N` | readiness 打不通 | 探针路径/端口；`initialDelaySeconds` 加大 |

一条命令把证据拉齐（只读）：

```bash
curl -s -H "$AUTH" "http://127.0.0.1:3011/api/k8s/clusters/CLUSTER_ID/overview" | jq '
  {pods: [.pods[] | select(.namespace=="inference")
          | {name, phase, ready, restarts, reason, message}],
   warnings: [.events[] | select(.type=="Warning")
          | {reason, object, message, count}]}'
```

### 4.5 回滚

```bash
# 有哪些版本可回（历史也随列表接口下发：GET $API/services → services[].history）
curl -s -H "$AUTH" "$API/services" | jq '.services[] | select(.name=="qwen-7b") | .history[] | {version, at, action, ok}'
# 回滚到指定版本
curl -s -X POST "$API/services/SERVICE_ID/rollback" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"version": 3}' | jq '{ok, steps, rollbackAvailable}'
```

回滚的边界（都是刻意的）：

- 只回滚**对象**，不回滚数据：hostPath 上的模型文件、PVC 里的内容不会被还原
- 不看标签：快照里的 `ref` 都会被改回去（哪怕中途有人手工摘了标签）；快照里没有的对象一律不碰
- 不重新过护栏、不重新评估容量（§1.7）：回滚成功 ≠ 服务能起来，回完还是要去 `/k8s` 看 Pod
- 回滚失败不二次破坏：每个对象独立 try，`steps` 里点名哪些没恢复，其余对象继续恢复

---

## 5. 故障与边界

### 5.1 配额「申请了但没拿到」

三种形态，根因完全不同：

| 现象 | 根因 | 证据 |
|---|---|---|
| Pod `Pending`，事件 `CardInsufficientMemory` / `CardInsufficientCore` | 卡上余量不足（含超卖比已满） | `warning-digest?window=1h` 里对应 reason 的计数在涨 |
| Pod `Running`，容器内 `nvidia-smi` 显示整卡容量 | 资源键没写全：只写 `nvidia.com/gpu` 不写 `gpumem` 时，HAMi 按整卡分配 | 容器内 `nvidia-smi --query-gpu=memory.total` |
| Pod 拿到配额但**注解/配额校验失败** | `gpumem` / `gpucores` 值不合法（非整数、超单卡、`gpucores` 不在 1..100）；或节点没打 device-plugin 要的标签导致这张卡没注册；或槽位（`deviceSplitCount`，默认 10）用光 | 节点注解 `hami.io/node-nvidia-register` 里没有这张卡；HAMi 组件日志里的校验报错 |

五条实操结论：

- **`gpumem` 与 `gpucores` 成对写**。只写 `gpumem` 等于「限显存不限算力」，同卡邻居会互相拖慢；
  本层渲染时两者同时出现（`coresPercent: 0` 才省略）。
- **`gpumem` 必须 ≤ 单卡可用显存**。写超了不是「排队等」，是直接被判配额非法。
- **`memoryMiB: 0` 要的是「那张卡完全空闲」**。整卡语义下 HAMi 不再切分，卡上已有容器就交不出来 ——
  预检的 `fits:false` 常来自这里，而不是「集群总剩余不够」。
- **槽位比显存更容易被忽略**：卡上 10 个僵尸容器把 slot 占满时，显存空着也进不去。
- **节点标签缺失**（HAMi 常约定 `gpu=on`）→ device-plugin 不注册这张卡 → 任何 GPU 服务都 `Pending`。
  这是集群侧一次性配置，本层不会替你打。

### 5.2 网关端口冲突：缺 Service → nginx CrashLoop

真踩过的形态：给新服务加了网关路由（`upstream: newsvc.inference.svc.cluster.local:8000`），
但那次 apply 里没有创建 `newsvc` 这个 Service。nginx 在**启动时**解析 stream 的 `proxy_pass`
上游，解析不到就退出：

```
nginx: [emerg] host not found in upstream "newsvc.inference.svc.cluster.local" in /etc/nginx/nginx.conf:23
```

Pod 表现 `CrashLoopBackOff`，而且**整个网关**一起挂 —— 连带其它端口上原本正常的服务全部不可用。
所以排查顺序必须是「先看网关，再看业务 Pod」：业务 Pod 全绿而所有端口不通，就是网关配置错了。

两种冲突要分清：

| 冲突 | 报错 | 原因 |
|---|---|---|
| 上游不存在 | `host not found in upstream "X"` | 路由写进去了，Service 没创建（或创建失败、名字拼错） |
| 端口重复 | `bind() to 0.0.0.0:XXXX failed (98: Address already in use)` | 两条路由抢同一个 `listen`，或端口被节点上别的进程占着（hostNetwork） |

本层能做的和不能做的，分清楚：

**能做的**

- `Service` 是 apiserver 对象，跟着 `apply` 一起下发并等就绪；所以「Service 先存在」这一步有保证
- `routes[]` 的 `upstream` 用固定集群内 DNS，和 `Service` 同名 —— 名字对不上是能用眼睛看出来的
- 网关端口按服务名**稳定哈希**（`30000..30999`），同名服务永远同一个端口，不会每次渲染都漂移；
  与手工维护的固定端口（如 `deploy/k8s/cluster/30-node1-gateway.yaml` 里的 18100..18105）不重叠

**不能做的**

- **不写网关 ConfigMap**：`routes[]` 只是渲染输出，落进 nginx 配置并滚动网关仍由人/接线层完成
- **不做全局端口占用表校验**：哈希只是降低撞车概率，不等于唯一性证明。真正撞了，是在改网关
  配置那一刻暴露的 —— 所以改 ConfigMap 之前先手查一遍端口（见下面第 1 步），别指望门禁替你看

手工兜底（网关已经 CrashLoop 时）：

1. `kubectl -n inference get configmap reranker-gateway-conf -o yaml` 找到报错那一行端口
2. 确认对应 Service 是否存在（`get svc -n inference`）；不存在就先修 Service，不要删路由
3. 改回 ConfigMap，网关 Pod 自己会起来

### 5.3 docker 里同名容器抢 hostPort

真踩过的形态：docker → k8s 迁移过渡期，旧 docker 容器还在跑且仍占着 `18100`；k8s 侧服务
声明 `hostPort: 18100`，于是：

| 表现 | 说明 |
|---|---|
| Pod `CrashLoopBackOff`，日志 `bind: address already in use` | 起容器时绑不上端口 |
| Pod `Pending`，事件提到端口冲突 | 同一节点上已有别的 Pod 声明了同一个 hostPort |

为什么本层默认**不用 hostPort**：`Deployment` 只声明 `containerPort`，对外统一走 hostNetwork
网关 + nginx stream（`expose` 渲染出的路由），端口只由网关独占。这台机器上 CNI portmap 的
DNAT 规则会被清掉，hostPort 本身就不稳。

迁移期检查（三步，都在改集群之前做）：

```bash
# 1) 节点上谁在听这个端口
ss -ltnp | grep -E ':(18100|18101)\b'
# 2) docker 里有没有同名/同端口的容器还活着
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '18100|18101'
# 3) k8s 里有没有别的 Pod 声明了同一个 hostPort
kubectl -n inference get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].ports[*].hostPort}{"\n"}{end}'
```

确认冲突后：先停 docker 容器（保留镜像，可回滚），再 apply。**不要**用「换个端口绕过」——
那只是把冲突推迟到下一个服务。

---

## 6. 验收方法

### 6.1 用 mock 集群验证（不碰真集群）

这一层的核心是纯函数 + 注入式客户端，可以完全离线验证：

| 层 | 怎么验 | 命令 |
|---|---|---|
| 定义校验 + 渲染 | 输入 `ModelService` → 断言对象数组、`routes`、确定性、越界反例 | `npx vitest run server/__tests__/infra-render.test.js` |
| 护栏 + diff + impact | 白名单越界、开关、归属、上限、幅度保护、`force` 只覆盖 `BIG_CHANGE` | `npx vitest run server/__tests__/infra-guard.test.js` |
| 容量预检 | 放得下 / 放不下 / 差 1 MiB / 整卡要求空闲 / 槽位耗尽 / 碎片 | `npx vitest run server/__tests__/infra-capacity.test.js` |
| 加速卡适配 | 四家厂商的 `renderResources` / 峰值算力 / 探测 | `npx vitest run server/__tests__/infra-accelerator.test.js` |
| 执行与回滚 | 注入 fake `client`，断言步骤顺序与失败短路 | `npx vitest run server/__tests__/infra-apply.test.js` |
| 基准 | 注入 fake `fetchImpl`，断言限并发、超阈中止、推荐配额 | `npx vitest run server/__tests__/infra-bench.test.js` |

一次跑完：

```bash
npx vitest run server/__tests__/infra-*.test.js
```

mock 能证明：清单对不对、护栏拦不拦、状态机停不停、预检算得对不对。
mock **不能**证明：显存真的隔离了、调度器真的把 Pod 放到那张卡上、网关端口真的能连。

### 6.2 在 `infra-test` 真机验证

前提：`deploy/k8s/cluster/40-infra-test-namespace.yaml` 已应用（命名空间 + 配额 + LimitRange +
NetworkPolicy）、集群有 GPU 节点、HAMi 组件在跑、网关可用。

```bash
OPENLOG_K8S_INFRA=1 npm start   # 服务端；界面打开 /infra，命名空间选 infra-test
```

验证序列（每步都要看到指定结果才算过）：

| # | 动作 | 通过标准 |
|---|---|---|
| 1 | 起一个 1 副本小配额服务：`memoryMiB: 2048`、`coresPercent: 10`、`llama.cpp` + 小 gguf | `steps` 全 `ok`；Pod `Running` 且 `ready: 1/1` |
| 2 | 容器内看配额 | `nvidia-smi --query-gpu=memory.total` = `2048 MiB`（不是物理卡容量） |
| 3 | 走网关端口访问 | `curl http://NODE_IP:<gatewayPort>/v1/models` 返回 200 与模型名 |
| 4 | 观察侧三层对齐 | `/k8s` 的 GPU 分配卡：`allocMemMiB ≈ 2048`、`measured: true`、`usedMemMiB` 随请求上涨 |
| 5 | 改配额到 `4096` | 预览 `impact` 说 `restarts:true, downtimeSeconds:60`；执行后旧 Pod 消失、新 Pod 起来，容器内 `memory.total` = `4096` |
| 6 | 回滚到上一版本 | 版本号前进、容器内配额回到 `2048`、历史里多一条 `rollback` |
| 7 | 改 `expose.gatewayPort` 指向另一个空闲端口 | `routes[].port` 随之变化，`impact.restarts:false`、`downtimeSeconds:0`；Pod 不重建、Service 不变。**注意**：本层不检测端口是否已被占用（§5.2 的已知缺口），撞车只能在改网关配置时暴露 |
| 8 | 故意超配额：`memoryMiB` 填 `70000` | `MEMORY_LIMIT_EXCEEDED`，不产生任何对象 |
| 9 | 故意超幅：`replicas: 1 → 8` | `BIG_CHANGE`；带 `force` 才放行，且返回里 `audit.forced` 有记录 |
| 10 | 故意越界：`namespace: default` | `NAMESPACE_FORBIDDEN`，集群无对象变化 |
| 11 | 拔开关重试 | 去掉 `OPENLOG_K8S_INFRA` 后写路径全被 `INFRA_DISABLED` 拦，界面入口灰掉 |
| 12 | 演示模式 | `OPENLOG_DEMO=1` 下写请求 `409`，真实集群对象数量不变 |
| 13 | 别人的对象：手工 `kubectl apply` 一个同名 Deployment（不带标签）再 `apply` | `NOT_MANAGED`，那个对象不被改动 |

### 6.3 看到什么算通过

- [ ] mock 测试全绿（§6.1 的六组）
- [ ] `infra-test` 里 §6.2 的 13 步全部达到「通过标准」
- [ ] 中断窗口可量化：第 5 步的中断时长有记录（旧 Pod `Terminating` → 新 Pod 校验通过），
      与预览给出的 `downtimeSeconds` 同量级
- [ ] 回滚后集群状态与旧版本一致（对象清单 diff 为空，除版本注解）
- [ ] 网关在整个过程中 `RESTARTS` 不变（本层不写 ConfigMap，所以只要没人手工改，它就该一直不变）
- [ ] 变更可追溯：能从历史 + 执行记录还原「谁在何时把配额从 2048 改成 4096，然后又回滚」
- [ ] 三层数据无矛盾：同一张卡上不出现「分配高 / 实测高 / MFU 为 0」这种打架组合

---

## 附录 A：ModelService 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定标识（uuid），创建后不变 |
| `name` | string | DNS-1123 label，决定 Deployment / Service 名 |
| `namespace` | string | 白名单内：`inference` / `infra-test` |
| `model.source` | `hostPath` \| `pvc` \| `huggingface` \| `modelscope` \| `s3` | 模型来源；`hostPath` 是节点本地路径 |
| `model.path` | string | `hostPath` 绝对路径，或仓库 id |
| `model.format` | `safetensors` \| `gguf` \| `pytorch` | 可选，进环境变量 |
| `model.quantization` | string | 可选，如 `awq`、`Q2_0`、`fp16` |
| `model.contextLength` | number | 期望上下文长度（≤1048576） |
| `engine.type` | `vllm` \| `sglang` \| `llama.cpp` \| `strata` \| `tgi` | 决定默认参数与探针口径 |
| `engine.image` | string | 镜像；`IfNotPresent`，节点上要有 |
| `engine.args` | string[] | 追加启动参数 |
| `engine.env` | object | 追加环境变量（值必须是字符串） |
| `resources.accelerators` | number | 每副本加速卡数（整卡语义；HAMi 下即 vGPU 份额），`0..8` |
| `resources.memoryMiB` | number | 显存配额 `0..65536`；`0` = 整卡（要求卡完全空闲） |
| `resources.coresPercent` | number | 算力配额 `0..100`；`0` = 不限 |
| `resources.vendor` | `nvidia` \| `amd` \| `ascend` \| `generic` | 缺省 `nvidia`，决定资源键（[INFRA-COMPAT.md](./INFRA-COMPAT.md)） |
| `replicas` | number | `1..8` |
| `placement.nodeSelector` | object | 节点标签选择，钉在数据所在节点 |
| `placement.acceleratorModel` | string | 型号亲和 → `nodeAffinity`（节点标签 `openlog.io/accelerator-model`） |
| `ports[]` | `{name, containerPort}` | 首个端口是主端口（探针与网关都用它） |
| `health.path` | string | 健康检查路径，缺省 `/health` |
| `health.initialDelaySeconds` | number | 首检延迟 `0..600`，缺省 5；模型加载慢就调大 |
| `expose` | `{ gatewayPort?: number }` \| null | `null`/省略 = 不对外；`{}` = 自动分配端口 |
| `createdAt` / `updatedAt` | string | ISO 时间 |
| `version` | number | 每次成功 apply 后前进（由接线层的存储维护）；回滚按它定位 |

## 附录 B：三个「用了多少」不是一回事

| 术语 | 谁给的 | 回答的问题 |
|---|---|---|
| 分配（allocated） | HAMi 节点注解 + Pod 注解 | 「这个 Pod 被**允许**用多少」 |
| 实测（used） | `nvidia-smi`（SSH 到节点） | 「这张卡**实际**占了多少显存/算力」 |
| MFU | 引擎 `/metrics` 差分 ÷ 峰值算力 | 「这活儿在理论最优下该跑到多少，现在跑到几成」 |

三者并列才有意义：分配高而实测低 = 空转；实测高而 MFU 低 = 跑得慢（不是没活干）；
`measured: false` = 没有数据，不是 0。
