# 更新日志

本项目自 2026-11 开源。版本号按 [语义化版本](https://semver.org/lang/zh-CN/)：
功能新增抬次版本号，只有修的抬补丁号。

---

## Unreleased — K8s 写操作 / GPU 使用率 / 调度策略

只读监控的行为与响应形状一律不变，这一批是**增量**：GPU 使用率的实际值、调度策略与超卖、
以及默认关闭的写操作。

### 新增

- **GPU 使用率**（`GET /api/k8s/clusters/:id/usage`）：节点注解给出「分配了多少」，
  HAMi 调度器指标（`hami_container_device_utilization_ratio` + 每卡显存）给出「实际用了多少」，
  两者对照渲染在「GPU 分配」卡片下方。利用率一律是 0..100 的百分比，不是 0..1 的比例。
  指标抓不到（没部署 vgpu-monitor / `/metrics` 不可达 / RBAC 不足）时返回
  `{ available: false, reason }`，卡片显示这个原因而不是一排 0，其它卡片照常工作。
- **调度策略与超卖**（`GET /api/k8s/clusters/:id/policy`）：`nodeSchedulerPolicy` /
  `deviceSchedulerPolicy`（binpack / spread）与 `overcommit`（1 = 不超卖），
  每一项都带 `source`（`configmap` / `scheduler-args` / `default` / `none`）——
  从活的 ConfigMap / 调度器启动参数读到的值，不会被当成 HAMi 默认值。读不到就显示「未知」。
- **Warning 聚合**（`GET /api/k8s/clusters/:id/warning-digest?window=1h`）：把 `type=Warning`
  事件按 reason 归并成「次数 + 最后出现时间」，反复出现的 BackOff 是一行而不是四十条。
  `POST /api/k8s/clusters/:id/warning-digest/ack { reason }` 确认一组；确认状态只存在进程内存里，
  不写集群、不写库、不动 settings。
- **写操作（默认关闭）**：
  - `POST /api/k8s/clusters/:id/workloads/:ns/:kind/:name/scale`，body `{ replicas }`
  - `POST /api/k8s/clusters/:id/workloads/:ns/:kind/:name/restart`（打 `restartedAt` 注解做滚动重启）
  - `DELETE /api/k8s/clusters/:id/pods/:ns/:name`（优雅删除，30s 宽限期，不做 force delete）

  `kind` 只接受 `deployments` / `statefulsets`。没有 `OPENLOG_K8S_WRITE=1` 时三条一律
  `403 { error: '写操作未启用（设置 OPENLOG_K8S_WRITE=1 后生效）', readOnly: true }`；
  每次成功的写操作返回 `{ ok: true, auditId }` 并落一条审计记录（含改动前的副本数，
  「2 → 5」比「→ 5」可追溯得多）。
- **Pod 表操作列**：行内可以直接删 Pod；只有当服务端下发了 owner 且能确定是
  Deployment / StatefulSet 时才出现「重启」「扩缩容」。owner 推不出来（裸 Pod / static pod，
  或 Pod 的 owner 是 ReplicaSet 而无法可靠反推 Deployment 名）就只显示删除，**不猜** ——
  猜错会把重启打到别的工作负载上。操作单元格拦掉 click / keydown 冒泡，
  点操作不会顺带把该 Pod 的日志抽屉打开。
- **路由挂载容错**：`server/index.js` 用动态 import + try/catch 挂载 4 个新路由模块
  （usage / alerts / ops / policy），任何一个模块缺失、导出不对或工厂抛错，
  都只打一行 `[K8s] … 未挂载` 的 warn 然后继续启动，只读监控不受影响。

### 运维提示

- 演示模式（`OPENLOG_DEMO=1`）：写操作一律 `409`，读接口返回 fixture 或空态，不触达真实集群。
- 要用写操作，除了 `OPENLOG_K8S_WRITE=1` 还需要集群侧权限：`deploy/k8s/rbac.yaml`
  的 operator 变体（scale 子资源 patch、pods delete）。只读 ServiceAccount 继续够用于其它能力。
- 前端顺序：节点表 → GPU 分配 → GPU 使用率 → 调度策略 → Pod 表 → Warning 事件。

---

## v1.5.0 — 2026-11-26

AI Infra 能力层：从「只看得到 / 只能扩缩容」到「定义服务 → 预检 → 执行 → 校验 → 回滚」的完整闭环，
并在真机上跑通全流程。

### 新增

- **模型服务定义**（ModelService）：模型路径/量化/上下文、引擎镜像、vGPU 配额、副本、亲和、端口、探针。
  校验 → 护栏（命名空间白名单、配额上限、归属标签、变更幅度）→ 渲染（Deployment + Service + HPA 可选）。
- **容量预检**：坚持 HAMi 单卡语义（跨卡拼显存必然调度失败），用真机 register + 当前分配算落点。
- **变更执行器**：guard → dry-run → snapshot → apply → rollout → **配额实证**（回读
  `hami.io/vgpu-devices-allocated`）→ endpoint，任一步失败自动回滚。
- **网关注册**：nginx stream 配置渲染 + 端口冲突预检 + 增量更新（只重写自己的区间）+ ConfigMap/reload。
- **变更审计**：13 字段、幂等指纹、环形 500 条、snapshot 只存 ref；审计失败不阻断运维。
- **弹性**：HPA 渲染 + vGPU 预算校验（超预算在保存期就报错）+ 冷却窗口 + 缩容一次只减 1。
- **模型缓存**：同节点多副本共享只读目录 / PVC-RWX 跨节点；每 Pod 各拷一份会明确告警（67GB×N 曾导致 DiskPressure）。
- **基准门禁**：TTFT p95 / 错误率 / 吞吐回归 / 推荐显存是否超卖；`docs/INFRA-BENCH.md` + `scripts/infra-bench-verify.mjs`。
- **加速卡抽象**：NVIDIA（HAMi 切分）/ AMD / Ascend / generic，上层零 `nvidia.com/*` 硬编码。

### 修复（真机验证暴露）

- `bench.js` 主循环用 `now()` 而非 `clockNow()` → `POST /api/infra/bench` 真机必然 500
  （测试都注入 now 所以测不出来）。
- `buildEndpoint('http://host:8000/v1')` 拼成 `/v1/v1/chat/completions`（必然 404）。
- `autoscale` / `cache` 不在校验白名单 → 被静默丢弃，HPA 与 PVC 缓存分支永远进不去。
- apply 传 `existing: null` 绕过归属校验 → 曾覆盖生产 Deployment（靠 rollout 超时后自动回滚恢复）；
  现在 apply/preview 都先读现状、fail closed，并有 5 条事故回归测试。
- 回滚：`ref.namespace` 缺失时静默跳过（表现为"回滚成功但没恢复"）；恢复时旧 resourceVersion 导致 409。
- 403 文案按路径猜动词，PATCH 被报成「缺少 GET 权限」，照着改 RBAC 会一直改不对。
- RBAC：补 create/delete（命名空间级 Role）+ services patch/update + operator services 读权限。

### 真机验证（243，infra-test 命名空间，业务零影响）

```
建服务      7 步全绿 5.9s，HAMi 注解实证 2048,10
改配额      2048→4096 patch 14.7s，注解变 4096,20
回滚        restore Deployment+Service，配额精确回到 2048,10
审计        3 条留痕（含一次失败），actor 与动作归类正确
```

## v1.4.0 — 2026-11-25

界面改版（K8s 手风琴、Pod 表不再横向溢出）+ 运维助手的三处真实卡顿修复 + 全站截图集。

### 新增

- **K8s 页改手风琴**：每个集群一行（名称 / apiserver / 连接状态 + 测试·编辑·删除），
  点开在下方内联展开全部信息。取代原来的左右分栏 —— 详情不再被压窄，Pod 表也不用横向滚动。
- **集群深链**：`/k8s?cluster=<id>` 直接展开指定集群（分享与排障用）。
- **运维助手进度反馈**：等待首字期间每 3 秒推「模型思考中…（已等待 Ns）」；
  等待人工确认时每 10 秒推「剩余 Ns，超时自动拒绝」。此前这两段等待界面完全静止。
- **全站截图集**：`docs/screenshots/`（13 张整页截图，全部来自演示模式）+ `docs/SCREENSHOTS.md`
  逐页说明 + 官网「界面实拍」区块。

### 修复

- **助手「长时间等待 + 突然结束」**：`list_metrics` / `query_metrics` / `local_*` 此前未被分类，
  落到「未知工具按写操作处理」→ 每次弹确认框并等满 180 秒；实测同一个问题要 510 秒。
  加入只读白名单后实测降到 70 秒、零确认框。
- **确认等待**：3 分钟 → 90 秒（`OPENLOG_ASSISTANT_CONFIRM_TIMEOUT_MS` 可调）。
- **工具级超时**：单次工具 45 秒（`OPENLOG_ASSISTANT_TOOL_TIMEOUT_MS` 可调），
  卡住时返回结构化错误让模型换策略，而不是把整轮拖到 180s 上限。
- **上游断连自动重试**：`Connection error` / `ECONNRESET` 在未收到正文时重试一次；
  报错中文化（「模型服务不可达：<地址> —— 检查推理服务是否在运行、地址端口是否正确」）。
- **Pod 表**：`table-fixed` + 名称列截断，状态列 w-28、命名空间 w-32，不再挤在一起/横向溢出。
- **官网发布链路**：`actions/deploy-pages@v4` 持续报 `Found 0 artifact(s)`（artifact 明明上传成功），
  改用 `peaceiris/actions-gh-pages@v4` 推 `gh-pages` 分支，不再经过 artifact 部署 API。

## v1.3.0 — 2026-11-24

K8s / HAMi 从「只看得到分配」补到「分配 vs 实测 + 调度策略 + 事件摘要 + 可选写操作」。

### 新增

- **GPU 分配 vs 实际使用**：`GET /api/k8s/clusters/:id/usage` 把 HAMi 的分配与 nvidia-smi 的
  实测并排（按物理卡、按设备 UUID join）。**HAMi v2 已移除容器级 util 指标**，实测必须走
  nvidia-smi —— 这一点写进了 `server/k8s/gpu-usage.js` 的文件头，避免以后又踩。
- **调度策略**：`GET .../policy` 从 hami-scheduler 的启动参数 / ConfigMap 读 binpack|spread 与
  overcommit，读不到时降级为默认值并说明来源。
- **Warning 事件摘要**：`GET .../warning-digest` 按 reason 聚合 + 已读标记，配前端卡片。
- **写操作（默认关闭）**：扩缩容 / 滚动重启 / 删 Pod，`OPENLOG_K8S_WRITE=1` 才生效，
  演示模式 409，每次调用写审计（内存环形 200 条）。`deploy/k8s/rbac.yaml` 新增可选
  `openlog-operator`（只多三项权限，仍禁 secrets 与 exec）。
- 前端新增三张卡片：GPU 使用率、调度策略、Warning 摘要；Pod 表增加操作列（stopPropagation，
  不会误触日志抽屉）。
- overview 的 Pod 带 `ownerKind/ownerName`（ReplicaSet 名去 hash 后需在 deployments 列表中命中）。

### 修正

- HAMi 指标采集用真机标签与端口：`app.kubernetes.io/component=hami-scheduler` / **9395**
  （此前按 `app=hami-scheduler` / 31993，243 上一直 `available:false`）。
- `deploy.sh` 透传 `OPENLOG_K8S_WRITE`；`deploy.mjs --dry-run` 不再执行 `git reset`。
- 两个依赖 `process.cwd()` 的客户端测试改按文件定位，`cd client` 跑也能通过。
- 演示模式补齐 `/usage` 与 `/warning-digest` 数据（此前是空卡片）。

## v1.2.1 — 2026-11-23

只修打包脚本的一处命名问题，没有功能改动。

- `deploy/scripts/make-packages.sh` 用 `$REF^{commit}` 解析引用：annotated tag 的
  `git rev-parse v1.2.0` 返回的是 tag 对象的 sha，导致 v1.2.0 的离线包叫
  `openlog-deploy-c6ae1a2d.tar`，而对应提交其实是 `92f53fa5`。现在包名与提交号一致。
- 已发布的 v1.2.0 包不受影响（包内镜像 tag 与包名同一串，安装行为一致）。

## v1.2.0 — 2026-11-23

只读 Kubernetes 监控（含 HAMi vGPU 分配）、演示模式、Mac 为主的双平台打包，
以及部署链路的升级安全加固。自 v1.1.1 起的全部改动都在这一个版本里。

### 概要

- **Kubernetes 监控**：kubeconfig → kube-apiserver 直连（mTLS / SA token 都支持），
  节点 / Pod / 工作负载 / Warning 事件，只读、节点上不装任何东西、不依赖 `kubectl`
- **HAMi vGPU 分配**：解析 `hami.io/node-nvidia-register` 与 `hami.io/vgpu-devices-allocated`，
  按物理卡展示「型号 / 容量 / 槽位 / 被哪些 Pod 占用多少显存与算力」
- **演示模式**：`OPENLOG_DEMO=1` 时全站使用确定性假数据（容器/GPU/日志/TSDB/K8s/助手），
  不连真实资源、不写库，顶部有通栏提示
- **双平台打包**：`deploy/scripts/make-packages.sh` 在 Apple Silicon 上一条命令出 amd64 + arm64
- **升级安全**：`deploy.mjs` 部署前漂移检测（服务端本地提交默认拦下，`--force` 才覆盖并自动建备份分支）、
  `install.sh --upgrade` 原地升级（备份 → 换镜像 → 健康检查 → 失败回滚）、MANUAL 新增升级章节

### 变更明细



只读接入 Kubernetes：节点上不装 agent，跑 OpenLog 的机器上也不需要 `kubectl`。

### 新增

- **只读 kubeconfig 接入**：粘贴 kubeconfig 后直连 kube-apiserver，支持客户端证书（mTLS，
  k3s 默认形态）与 ServiceAccount token 两种认证，另支持自定义 CA 与 `insecure-skip-tls-verify`。
  所有请求都是 GET，不往集群写任何东西，单次请求默认 10s 超时。
- **集群 / 节点 / Pod / 工作负载 / Warning 事件 / Pod 日志**六类视图：
  节点 Ready 状态、角色、版本与 conditions；Pod 的 `ready` 比例、重启次数与逐容器状态，
  并单独识别 **OOMKilled** 与 **CrashLoopBackOff**；Deployment / StatefulSet / DaemonSet 的
  期望-就绪-已更新-可用对比；只取 `type=Warning` 的事件（含 reason / 关联对象 / 次数 / 最后发生时间）；
  以及经 apiserver 直接 tail 的 Pod 日志（默认 `?tail=200`）。
- **多集群**：任意多个 kubeconfig 并存，可指定 context（留空用 `current-context`），
  逐个启用/停用，并有独立的「测试连接」探活，返回 apiserver 版本与节点数，失败给出上游原始错误。
- **只读 RBAC 资产**：`deploy/k8s/rbac.yaml`（只读 ServiceAccount + ClusterRole）、
  `deploy/k8s/make-kubeconfig.sh` 与 `deploy/k8s/README.md`（权限模型与最小 verb 说明）。

> 尚未发版：`package.json` 版本仍是 1.1.1，本节只作增量记录，正式发布时并入对应版本段。

---

### 双平台打包（Mac 为主）

策略调整：开发与验证都在 Apple Silicon Mac 上做，出包时一条命令导出两个架构。

- 新增 `deploy/scripts/make-packages.sh`：`--ref` 指定提交、`--only amd64|arm64` 只出一个、
  `--skip-build` 复用镜像、`--dry-run` 零副作用
- 每个架构独立跑三重校验（镜像元数据 / 容器内 Node / better-sqlite3 ELF `e_machine`），
  任一不过即中止，绝不产出架构标错的包
- 处理了两个 Mac 专属坑：`--platform` 拉下来的 postgres 是多平台 index（`docker save` 会失败，
  已用同平台重建收敛）；BuildKit 的 attestation manifest（构建统一带 `--provenance=false`）
- 实测：amd64 包 307M、arm64 包 295M，解包后 `sha256sum -c` 与镜像架构全部核对通过

---

### 演示模式（OPENLOG_DEMO=1）

没有真实机器/数据时页面不再全空：服务端从内置假数据回答，客户端明确告诉用户「这是演示」。

### 新增

- **前端演示横幅**：新增 `client/src/components/DemoBanner.tsx`，挂在 `Layout` 内容区顶部，
  读 `GET /api/demo` 的 `{ demo: boolean }`；`demo === true` 时显示琥珀色
  「演示数据 · 未连接任何真实服务器（OPENLOG_DEMO=1）」，可关闭（仅本次会话，刷新后重现）。
  请求失败 / 字段缺失 / 尚未加载完一律静默不显示。
- **共享演示状态**：新增 `client/src/hooks/useDemoMode.ts`，模块级缓存一次 `/api/demo` 探测
  （并发共用同一个 in-flight 请求、成功后本次会话不再请求），横幅与页面共用同一份状态；
  加载完成前按「非演示」处理 —— 宁可多一次点击，也不要把真实环境误禁成只读。
- **写操作只读适配**：演示模式下容器启动 / 停止 / 重启 / 删除（`Docker.tsx`）、
  远程 Shell 与 AI Shell（`Remote.tsx`）、K8s 集群新增 / 删除（`K8s.tsx`）全部禁用并给出
  Toast / title 提示；按钮变灰、走禁用光标，点击不发请求。服务端另有 `409 + demo: true` 兜底。
- **文档**：README（英文主版本 `## Demo mode`）与 `README.zh-CN.md`（`## 演示模式`）新增章节并加进目录。

> 尚未发版：`package.json` 版本仍是 1.1.1，本节只作增量记录，正式发布时并入对应版本段。

---

## v1.1.1 — 健康检查只说有证据的问题

「容器健康诊断」在生产上报了 51 个问题容器，点进去发现 41 个"错误"是
`(HTTP code 501) configured logging driver does not support reading` —— 那是**我们读不出日志**，
不是容器报错；剩下 10 个连一行错误都没有。51 个全部是 exited，退出时间从 4 天前到 7 个月前。
换句话说：一堆从来没被采集过的容器，把真正的当前故障埋掉了。

### 修复

- **健康检查不再把「读不到日志」当成容器报错**：`getContainerLogs()` 返回的是数组，
  `healthCheck()` 却按 `logResult.logs` 取值，恒为 `undefined` → 错误行永远是空；
  失败分支还把 `无法获取日志: …` 塞进 `errors[]`，于是 501 变成了"容器错误"。
  两处都修了。
- **`getContainerLogs()` 补上第 4 个参数**：`routes/docker.js` 一直在传
  `{ tail: 200 }` / `{ tail: 50 }`，函数签名只有 3 个参数，静默丢弃，永远按 `tail: 500` 拉。
  同时补上 `since` / `startTime` / `filterLevel`（都是前端传了、后端没生效的参数）。
- **按证据分流，不再只数退出码**：
  - `problem` —— 有证据的当前问题，照报
  - `stale` —— 退出超过 `containerHealthStaleHours`（默认 24h）的历史容器
  - `unobserved` —— 日志驱动不支持读取、且没有退出码证据，等于从未被采集
  后两类不进 `problems`、不计入 `unhealthy`，但都在 `summary.ignoredStale` /
  `summary.ignoredUnobserved` 显式计数，前端可展开看名单，不静默吞掉。
- **OOM(137) / 段错误(139) 不受过滤影响**：退出码本身就是硬证据，即使日志读不出来照报。

### 新增

- 设置项 `containerHealthStaleHours`（0 / 1 / 6 / 24 / 72 / 168 小时，0 = 不过滤）
  与 `containerHealthIgnoreUnobserved`（默认开），在设置页「容器异常监控 → 健康检查过滤」里可调。
- 健康报告与诊断 prompt 都会带上过滤条数，AI 不会再对着噪音编故事。

### 生产实测

87 个容器（12 运行中 / 75 exited），日志驱动 `json-file` 45 个、`none` 42 个。
默认参数下 `unhealthy` 从 **51 → 0**，`ignoredStale 51` / `ignoredUnobserved 0`（全部都是 4 天以上）。
关掉时间过滤（`staleHours: 0`）单独看未采集过滤：`unhealthy 51 → 9`，42 个 `none` 驱动容器被正确识别。

---

## v1.1.0 — 内置时序库

系统指标从「83 分钟的内存数组」变成真正的时序数据库，并补齐了围绕它的
抓取、查询、告警、长期存储、AI 查询。

**运行时代码零破坏性变更**：v1.0.x 的配置、数据、API 全部兼容。

### 新增

**时序库（Prometheus 兼容）**
- 持久化存储：`ts_series` / `ts_sample` 两张表，SQLite / PostgreSQL / MySQL 三方言
- 抓取器：pull 模型，从任意 `/metrics` 端点抓 Prometheus 文本格式，
  支持 bearer / basic 鉴权
- PromQL 子集：40+ 函数、聚合（`by` / `without`）、二元运算、
  向量匹配（`on` / `ignoring` / `group_left`）、**子查询** `x[5m:1m]`、
  **`@` 修饰符**（`@ <unix>` / `@ start()` / `@ end()`）
- 表达式告警：`for` 持续判定 + 分组 / 抑制 / 静默 / repeat_interval 去重
- 记录规则：结果写回时序库，可用指标名直接查询
- 保留期分层：原始 7 天 → 5 分钟粒度（max/min/avg/count 四个值）90 天
- remote write：手写 protobuf + snappy，推给 Thanos / VictoriaMetrics / Mimir

**对外接口**
- `GET /metrics` — 自身指标，Prometheus 可直接抓
- `/api/v1/query`、`query_range`、`labels`、`label/:name/values`、
  `series`、`targets`、`rules`、`alerts` — 与 Prometheus HTTP API 同形状，
  Grafana 可直接接
- `POST /api/tsdb/test-notify` — 配完 webhook 当场验证

**告警通知**
- Alertmanager 兼容的 webhook payload，钉钉/飞书写中转器即可
- 按**告警实例**（labelset）去重，不是按规则名
- 恢复通知也会发

**AI**
- `query_metrics` / `list_metrics` 两个工具：可以直接问
  「昨天下午 CPU 最高到多少」「磁盘什么时候开始涨的」
- 返回统计摘要（min/max/avg/趋势/峰值时刻）而不是几百个原始点
- 危险查询会被挡掉：子查询步长 < 1s、`{__name__=~".*"}` 全表扫、跨度 > 7 天

**前端**
- 监控页新增「时序库查询」面板：PromQL 输入 + 9 个常用查询预设 +
  图表/表格双视图

**接口监控**
- `api_metrics_minute` 的数据同时写进时序库，可以写
  `sum(rate(openlog_api_requests_5xx_total[5m])) / ... > 0.05` 这种告警
- 附带三条推荐规则：错误率 / P99 延迟 / 流量骤降

### 修复

- **SQLite 备份会丢数据**：WAL 模式下用 `cp` 复制主 db 文件拿到的是
  上次 checkpoint 的样子，未落盘的部分丢失，而且备份文件本身完全合法、
  打开不报错。现在强制走 `sqlite3 .backup` 并做 `PRAGMA integrity_check`，
  缺 sqlite3 直接失败而不是降级复制。
- 接口延迟为 `null` 时被写成 `0`（`Number(null) === 0`），
  会让「该分钟没有请求」在图上显示成「响应时间 0 秒」。
- 抑制/静默规则永远不命中：内部告警名在 `a.name` 上，规则写的是
  `{alertname: "..."}`，不合并就永远匹配不上，且不报错。
- AI 摘要把 Prometheus 的秒级时间戳当毫秒用，峰值时刻显示成 1970 年。
- 降采样批量窗口固定为一天，进程停过几天再启动时超出窗口的旧数据
  会被直接删掉而不降采样。改为自适应起点 + 水位线 + 分块推进。
- `db_metric_sample` 历史读取的报错文案是过时描述（「读取未接入」），
  实际只是 db 适配层缺失。改成准确说明。

### 测试

2608 passed / 2 skipped（130 文件）。新增 12 个测试文件：
tsdb-labels / exposition / store / promql-lexer / promql-engine / scrape /
rules / notify / retention / remote-write / ai-tools / api-tsdb-bridge。

存储层用真的 better-sqlite3 而不是 mock —— 这一层的复杂度全在 SQL 本身
（方言、冲突子句、参数顺序），mock 全绿但真库跑不通的情况见过太多次。

---

## v1.0.1 — 打包脚本与架构自检修正

**v1.0.0 的 tag 是首个开源快照，不含这些修正。用离线包请用 v1.0.1 或更新。**

### 修复

- **`.gitattributes` 钉死 LF**：Windows 工作区是 CRLF、Linux 是 LF，
  同一份源码构建出的前端 bundle 哈希不同（`index-EGEQfdxr` vs `index-D_DQ4OgQ`）。
  排查时先后误判为「构建缓存」和「架构差异」，真因是换行符。
- **`install.sh` 架构自检**：装错架构的包，`docker load` 会成功、
  `docker run` 才报 `exec format error`，而那行报错不含 architecture 字样。
  现在在导入前拦截并指出该换哪个包。
- **`deploy/scripts/make-package.sh`**：离线包装配脚本。README 改模板渲染
  （版本号 / 镜像文件名 / 架构从包内实际文件推导），打包时自动生成
  `SHA256SUMS` 并做五项自查。
  - 修 macOS bash 3.2 的多字节缺陷（`$VAR（` 会把全角括号吞进变量名）
  - 修 `pipefail` 下 `cmd | grep -q` 的 SIGPIPE 假失败

---

## v1.0.0 — 首次开源发布

- MIT LICENSE
- CONTRIBUTING.md / SECURITY.md（如实写威胁模型）
- Issue / PR 模板
- 官网 Pages
- 路由兜底：未知路径不再渲染成空白页
