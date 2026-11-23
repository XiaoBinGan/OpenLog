# 更新日志

本项目自 2026-11 开源。版本号按 [语义化版本](https://semver.org/lang/zh-CN/)：
功能新增抬次版本号，只有修的抬补丁号。

---

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
