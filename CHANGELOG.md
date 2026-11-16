# 更新日志

本项目自 2026-11 开源。版本号按 [语义化版本](https://semver.org/lang/zh-CN/)：
功能新增抬次版本号，只有修的抬补丁号。

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
