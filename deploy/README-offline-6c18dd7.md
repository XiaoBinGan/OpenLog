# OpenLog 离线部署包 6c18dd7

- 应用镜像：`openlog:6c18dd7`（`deploy/images/openlog-latest-20261108-002649.tar.gz`）
- 数据库镜像：`postgres:16-alpine`（`deploy/images/postgres-16-alpine.tar.gz`，仅 PG 部署需要）

## 安装

```bash
tar xf openlog-deploy-6c18dd7.tar && cd openlog-deploy-6c18dd7
sha256sum -c SHA256SUMS
bash deploy/install.sh --yes                    # SQLite
bash deploy/install.sh --with-postgres --yes    # PostgreSQL
```

装完会打印访问地址与令牌；令牌也可 `docker exec openlog cat /app/data/.auth_token`。

## 本版重点：监控能看「别的机器」的数据了

之前的问题：设备选择器切到远程机器，接口/数据库面板数据不动。原因不是 bug ——
那两块统计的是**运行 OpenLog 的这台机器**（它收到的请求、它连的库），
远程主机只被 SSH/Docker 管理、上面没有 OpenLog 进程，本来就不存在它的流量指标。

本版加了「外部数据源」面板，用两条互补的路解决：

### ① 数据库：登记别人的库，或从容器里自动挖出连接条件

点「从容器里找」，扫本机 + 所有 Docker 源里运行中的容器：

- 识别 `postgres` / `postgresql` / `pgvector` / `timescaledb` / `mysql` / `mariadb` / `tidb` / `redis` / `mongo`（含 `bitnami/*` 变体）
- 从 `Config.Env` 挖 `POSTGRES_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`MYSQL_DATABASE`、`DATABASE_URL`、`MONGODB_URI` 等
- 从 `NetworkSettings.Ports` 算「宿主机哪个端口能连」；`host` 网络模式单独处理
- 端口没发布就明确说「连不进去，需要 `--publish` 或改用 host 网络」，不假装能连

密码纪律（写进实现，不是口号）：

- 候选只回**打码**（`Op***95`），够你确认是哪一串，不够拿去登录
- 点「登记」时前端只交 `sourceId + containerId`，**服务端重新 inspect 容器取密码并加密入库** —— 明文不经过浏览器内存、网络或 XSS 面
- 落库用与 settings 同一套 AES-256-GCM；任何返回前端的形状都不含明文

试连是真连：`pg` / `mysql2`，采版本、库大小、连接数、表体积、死元组、锁等待。
权限不足的单项降到 `unavailable` 并说人话（「权限不足」），**绝不用 0 冒充**。

实测（生产 PG）：`PostgreSQL 16.15 · 10.6MB · 连接 0/6 · 10 张表 · 锁等待 0`，
表样本 `db_metric_sample 1.1MB / 2102 行 / 0 死元组`、`api_metrics_minute 909KB / 5436 行`。

### ② 接口：探对方的 Swagger / OpenAPI

对有 Web 端口的非数据库容器，按序试 `/openapi.json`、`/v3/api-docs`、
`/swagger/v1/swagger.json`、`/api-docs`、`/swagger.json`、`/swagger-ui.html`、`/docs`…

拿到真 spec 就解析标题、版本、接口清单。**关键是要防误判**：
生产实测 nifi(`:8080`) 和 supremind(`:3002`) 对任意路径都回 `200 + index.html`（前端路由兜底），
按状态码判会把「没有文档」报成「找到文档」。所以先探一个不存在的路径当**指纹**，
内容一致的一律判为兜底页面跳过；HTML 里没有 `swagger|redoc|openapi` 关键词的也不算文档页。

实测结果：

| 服务 | 结果 |
|---|---|
| vllm `:30000` | ✅ 真 spec，`FastAPI`，**22 个接口**（`/detokenize`、`/inference/v1/generate`…） |
| T4 reranker `:8000/:8002` | ✅ 真 spec，`Qwen3-VL Embedding & Reranker Search API`，**23 个接口** |
| nifi `:8080` | ✅ 正确识别为「SPA 兜底，没有接口文档」 |
| supremind `:3002` | ✅ 正确识别为「SPA 兜底，没有接口文档」 |
| strata `:8899` | ✅ 所有文档地址 404，如实说「没找到」 |

### 界面上把两类数据的边界写清楚

- **接口清单**（来自对方文档）：有哪些接口，**不含调用量/耗时**
- **流量指标**（来自本机埋点）：真实调用量、错误率、分位延迟，**只有跑着 OpenLog 的机器才有**

Swagger 给不出 QPS —— 那是流量事实，只在服务自己的访问日志或 Prometheus 里。不拿假数字凑。

## 上一版内容（仍有效）

### 监控面板

| 面板 | 内容 |
|---|---|
| **接口指标** | QPS · 错误率 · P95 · 总请求数；慢接口 Top10；错误 Top10（4xx/5xx 分开）；QPS 分钟趋势；「文档」按钮直达 OpenAPI |
| **数据库** | 类型 · 连接池水位 · 探针延迟 · 表体积 Top10（体积/行数/死元组/索引命中率）· 慢查询（SQL 指纹 + 耗时 + 来源） |
| **外部数据源** | 自动发现候选 · 登记 · 试连 · 探文档（本版新增） |

两块本机面板头部都标「本机实例」；切到远程机器时出现黄色提示条说明原因，并提供「切回本机」按钮。

### 新增接口

| 路由 | 用途 |
|---|---|
| `GET /api/health` | 极轻健康检查（不查库不查 Docker） |
| `GET /api/monitor/api?window=1m/5m/1h` | 接口指标快照（含 `sinceMs` / `source`） |
| `GET /api/monitor/api/history` | 分钟级历史 |
| `GET /api/monitor/api/alerts?shadow=1` | 4 条告警规则 |
| `GET /api/monitor/coverage` | 接口覆盖率（谁从没被调用过） |
| `GET /api/monitor/probes` / `status` | 依赖拨测 / 监控总览 |
| `GET /api/monitor/db`、`/db/history`、`/db/slow-queries`、`/db/tables` | 数据库采样与慢查询 |
| `GET/PUT/DELETE /api/monitor/datasources` | 外部数据源登记 |
| `GET /api/monitor/datasources/discover` | 从容器挖连接条件 |
| `POST /api/monitor/datasources/adopt` | 服务端取密码并加密入库 |
| `POST /api/monitor/datasources/:id/probe` | 试连 / 探文档 |
| `GET /api/openapi.json`、`/api/docs` | 96 个接口文档（自渲染单文件） |

### 数据可信度：修掉的 9 个「看起来有数、其实是错的/空的」缺陷

1. **错误率差 100 倍**：后端给比值（1/15 = 0.0667），前端按百分比直读显示 0.07%，真实 6.67%；且判级把 6.67% 显示成绿色正常。现统一 ×100。
2. **慢查询面板永远 0 条**：`slow-query` 模块写完测完装进路由，但**没有任何地方调用 `record()`**。现给 db 三层适配层包耗时统计（单调时钟、失败查询也报、埋点抛错不影响查询）。
3. **慢查询不落库**：`apiStore.insertSlowQuery` 有实现有测试，生产无调用点，`slow_query_log` 表永远 0 行。现记录成功后异步落库（存指纹不存参数值），内存为空时回落读表。
4. **内存快照没标注来源**：接口指标来自内存滑窗，重启从 0 累计。现返回 `sinceMs` + `source`，脚注写明「自 HH:MM 起累计（进程内存；重启归零）」。
5. **切机器面板不动**：面板统计的是本机 OpenLog，不是远程主机。现显式标「本机实例」+ 提示条 + 切回本机按钮。
6. **自动发现的库登记后连不上**：候选只回打码密码，`PUT` 登记时没密码 → `SASL: client password must be a string`。现加 `adopt` 端点由服务端取密码。
7. **SPA 兜底误判成找到文档**：任意路径回 200 的前端站点会被误报。现用不存在路径的指纹识别兜底页面。
8. **PG 每次启动刷 `column "content" already exists`**：盲 ALTER → 探测差集只补缺的。
9. **覆盖率刚启动假 0**：把内存里未落库的当前分钟也计入。

### 实测数据（生产 PG + 4卡T4 SQLite）

| 项 | 生产 | 4卡T4 |
|---|---|---|
| 原始指标行 | api_metrics_minute 4500+ 行 | 每分 13~56 行 |
| DB 探针 | 0.22~8.9ms（PG） | 0.05~0.11ms（SQLite） |
| 慢查询 | 真抓到 994ms 的 `delete from log_records`（启动清理作业） | 空（确实不慢） |
| 外部库采样 | PG 16.15 / 10.6MB / 10 张表 | — |
| Swagger 探测 | vllm 22 接口 / nifi 兜底识别 / supremind 兜底识别 | reranker 23 接口 |

### 代码结构

- `server/metrics/*`：registry / api-middleware / api-store / sql-dialect / db-sampler / slow-query / route-coverage
- `server/datasource/*`：discover / api-probe / db-probe / store（本版新增）
- `server/openapi.js`、`dependency-probe.js`、`monitoring.js`、`ws-auth.js`
- `client/src/pages/Docker.tsx` 1287 → 399 行；`Settings.tsx` 1968 → 272 行
- 测试：**1763 passed / 2 skipped（98 文件）**

**沿用**：远程文件面板右键操作、Docker AI 智能诊断、告警导出 Markdown/真实 XLSX、AI 分析进通知中心、GPU 进程解析、路由懒加载。

完整手册见 `deploy/MANUAL.md`。
