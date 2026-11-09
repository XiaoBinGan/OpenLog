# OpenLog 离线部署包 7ccc4e9

- 应用镜像：`openlog:7ccc4e9`（`deploy/images/openlog-latest-20261109-153545.tar.gz`）
- 数据库镜像：`postgres:16-alpine`（`deploy/images/postgres-16-alpine.tar.gz`，仅 PG 部署需要）

## 安装

```bash
tar xf openlog-deploy-7ccc4e9.tar && cd openlog-deploy-7ccc4e9
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

## 本版新增：探测「当前模型能不能看图」

图片发出去后，不同引擎行为差别很大 —— Ollama 上多数纯文本模型对 image_url
**不报错，直接静默忽略**。图片被丢弃，模型对着空图硬答，用户以为是「AI 看歪了」。

| 做法 | 说明 |
|---|---|
| 探测图用**洋红** | 红/蓝/绿是模型不看图也能蒙的高频猜测色；洋红不在常见猜测集合里，答对基本只能是真的看到了 |
| 真发一张 32×32 纯色 PNG | 服务端没有 canvas，手写最小 PNG 编码（IHDR/IDAT/IEND + CRC32），80 字节 |
| 三态结论 | yes（答对颜色）/ no（引擎明确拒绝）/ unknown（超时、限流、答非所问）|
| unknown **不缓存** | 下次可能就好了，缓存住会一直误导 |

前端（`client/src/utils/visionSupport.ts` + `hooks/useVisionSupport.ts`）：
- **只在第一次选图片时探测**，页面加载不探（不花用户没打算花的 token）
- no → 红色警示：这个模型不看图，请换模型或去掉图片
- unknown → 黄色提示：无法确认，可以先发，引擎不支持会明确说明

运行时错误也接上了：/api/chat 与 AI Shell 收到「不支持图片」类错误时单独说清原因
（而不是甩一句 image_url is not supported），并把 no 写进缓存。

真机验证（生产环境，配置的 qwen3.8-flash-next-q2_0）：
  首次探测 511ms → yes（模型答「品红」）
  再查 18ms → 命中缓存
  浏览器验收：页面加载 0 次探测 / 选图后 1 次探测 / 界面无多余提示

## 上一版：AI Shell 与运维助手支持多图

两个入口都能发图片，一次最多 6 张。三种添加方式：点按钮选文件（多选）、Ctrl+V 粘贴截图、把文件拖进消息区。

**服务端新增 `server/vision-content.js`**（纯函数，35 条测试）。核心是这些坑：

| 坑 | 后果 | 修法 |
|---|---|---|
| 图片 base64 被当文本估 token | 一张 300KB 的图 ≈ 8.5 万 token，上下文预算当场爆掉，历史被整段丢弃 —— 用户看到的是「助手突然忘了一切」 | 图片按固定值 1100 token 算 |
| `String(content)` 强转 parts 数组 | 得到 `[object Object]`，AI Shell 的「命令输出压缩」整段失效 | 新增 `contentText()` 统一取纯文本 |
| 远程图片 URL | 服务端会去取内网地址（SSRF） | 只收 data URL |
| 每轮重发历史图片 | 6 张图 = 6600 token/轮，几步就把小窗口模型吃光 | 只保留最后一条 user 的图片，更早的剥成「[图片]」 |
| SVG 当图片传 | 可携带脚本 | 白名单 PNG/JPEG/WebP/GIF |

**前端（两个入口共用）**：`client/src/utils/imageAttach.ts`（纯函数，24 条测试）+ `components/ImageAttach.tsx`。
压到长边 1568px、JPEG 0.85；GIF 保留原始字节（canvas 只能取第一帧，转 JPEG 会丢动画）；PNG 透明区先铺白底（否则变黑块）；压缩后仍超限就降质量重编，最低 0.55。

真机验收（生产环境，CDP 驱动真实 DOM）：运维助手注入 3 张 → 缩略图 3 + 计数 3/6 + 3 个删除按钮；AI Shell 注入 2 张 → 缩略图 2 + 计数 2/6。

## 上一轮修的第 11~13 个缺陷 + 测试补齐

1. **拓扑缓存指纹碰撞**：指纹用 `ids.join(',').length`，两个不同容器集合只要 id 总长度
   相同就命中同一份缓存 → 拿到另一批容器的拓扑。改成对 id 集合取 sha1。
2. **同网把退出的容器也算进去**：生产 openlog 属 host 网络，「同网 14 台」里 13 台是
   exited 的历史容器。现在只算运行中，退出的单独计数并显示「另有 N 台已退出」。
3. **`/api/monitor/history?limit=abc` 返回空列表**：`slice(0, NaN)` == `[]`，
   用户会以为历史丢了。非法值退回默认 100，上限 5000。
4. **GPU 发现脚本给别人制造 404 噪音**：openlog-site（nginx）2 小时内被打了 80 次
   `GET /metrics` → 每条 404 进它的 error log，容器日志巡检再把它们当 ERROR 报出来。
   现在取端口时带镜像名，排除 nginx/httpd/caddy/traefik/数据库类。

## 测试情况（诚实版）

| | 文件数 | 平均行覆盖 | 说明 |
|---|---|---|---|
| 服务端 | 70 | **81.1%**（分支 82.7%） | 核心逻辑 90%+；12 个文件低于 50% |
| 前端 | 82 | **22.1%** | 只有 utils 有测试，组件层几乎无测试 |

**服务端覆盖率低于 50% 的 12 个文件**（多数是薄路由层，逻辑在别处已覆盖）：

| 文件 | 行覆盖 | 为什么低 |
|---|---|---|
| routes/logs.js | 16% | 日志读/分析/修复，依赖真实文件系统与 LLM |
| routes/gpu.js | 22% | 依赖真实 nvidia-smi / SSH |
| routes/docker.js | 25% | 799 行大型路由，多数分支需要真 Docker |
| routes/remote.js | 26% | 依赖真实 SSH 连接 |
| index.js | 28% | 2333 行装配层，启动路径难在单测里跑 |
| routes/db-info.js | 28% | 依赖真实数据库 |
| docker.js | 35% | 编排层，核心推断逻辑已单独 100% 覆盖 |
| remote.js | 35% | SSH 生命周期 |
| routes/skills.js | 38% | 薄封装 |
| routes/settings.js | 38% | 薄封装 |
| routes/analysis.js | 45% | 依赖 LLM |
| routes/chat.js | 50% | 依赖 LLM 流式 |

**前端只有 utils 有测试**（22%）：组件层需要 testing-library + jsdom，当前只装了 jsdom。
这是已知缺口，不是遗漏。

本轮新增测试（46 条）：
- `monitoring-orchestration.test.js`（17 条）：`monitoring.js` 此前**零测试**（覆盖率 65%），
  补的全是降级路径 —— 建表失败、采样器/拨测启动抛错、落库抛错、写回 0 行、stop 幂等
- `monitor-route.test.js`（9 条）：`routes/monitor.js` 从 22% 提上来；含 GPU 分支
  （历史上用 `require` 在 ESM 下必抛、被静默吞掉、`gpus` 永远 `[]` 的回归）
  与磁盘去重（不去重前端相加会显示 476.9%）
- `docker-trace-orchestration.test.js`（12 条）：链路编排三处易错点
- `gpu-mfu-discovery.test.js`（7 条）：端口候选 + 注入防护
- 拓扑/连接/采样等既有文件补 3 条

## 上一版：容器上下游链路能真的分析出来了

之前「上下游链路」在任何容器上都显示空 —— 生产 86 个容器抽样 8 个，
上游/下游/同网**全是 0**。查出来是三个判断依据全都读错了字段：

| 原代码读的 | 实际字段 | 后果 |
|---|---|---|
| `c.Networks` | `NetworkSettings.Networks` | 恒为 undefined → 网络推断整段失效 |
| `c.labels.env` | `Config.Env`（inspect 才有） | Docker 从不把 env 写进 labels → 恒为空串 |
| `labels['depends-on']` | `com.docker.compose.depends_on` | compose v2 默认不写 → 几乎不存在 |

重写为 `server/docker-topology.js`，只认容器配置里能看到的事实，每条边都带**证据与置信度**：

| 证据 | 置信度 | 说明 |
|---|---|---|
| `live_tcp` | 高 | 此刻真实存在的 TCP 连接（读每台容器自己的 `/proc/net/tcp`） |
| `compose_depends_on` | 高 | compose 显式声明依赖 |
| `docker_link` | 高 | `--link` 声明 |
| `env_alias` | 高 | env 里的主机名 == 对方容器名 / compose 服务名 / 网络别名 |
| `env_published_port` | 中 | env 指向 `127.0.0.1:P` 且**只有一台**容器发布 P |
| `env_container_ip` | 中 | env 直接指向对方容器 IP |

同网但无调用证据 → 只进「同网」一栏，**不算上下游**（同 bridge 里互相可达是网络属性，不是调用关系）。

**生产实测**：openlog → openlog-pg，证据 `live_tcp`，
「此刻有 4 条已建立的 TCP 连接」；界面显示「实时 TCP 连接 · 高置信 — openlog 与它有 4 条已建立连接」。

**为什么用每台容器自己的 netns**：宿主机连接表里，host 网络容器发起连接的源地址是
docker 网关 IP（172.17.0.1），无法归到具体容器 —— 实测 86 容器映射出 0 条边。
换到容器自己的 netns，local 端必然是它自己，方向没有歧义。

其它修正：
- 列表接口的 `upstreamCount`/`downstreamCount` 改为 `null`（需 inspect，不该在列表里挨个查），
  不再用 0 冒充「没有上下游」
- 连接表只读**运行中**容器（77 台里 66 台是停的，逐台 exec 只会刷假失败）
- 真实连接证据会**升级**已有边（不是「已存在就跳过」）

## 上一版：SQLite 表体积永远 0 张表

在 4卡T4 上实测发现数据库面板「表体积」一直 `available:false`、0 张表，
而库里明明有 11 张表在写指标。根因是 `sampleSqlite('heavy')` 只做了 `quick_check` ——
PG 分支有 `pg_total_relation_size` 可查，SQLite 分支当时整段漏了。

现在用 `dbstat` 虚拟表按表聚合真实字节数，再对最大的 8 张表跑 `count(*)` 拿真实行数。
过程中又踩了两个坑、都修了：

1. `dbstat` 的行**既含表也含索引**（没有 `type` 列），只按 name 过滤会把
   `idx_log_records_timestamp` 当表列出来、还对它 count(*) 报错。改成
   `JOIN sqlite_master ON m.type='table'`。
2. 单表 count 失败曾走 `round.errors` → 整轮 `ok:false`。改成只进 failures，
   一张表数不出来不该让整轮采样算失败。

`dbstat` 没编译进发行版时退到 `sqlite_master` 只列表名，体积留 `null`（不是 0），
原因写进 `unavailable`。

**4卡T4 实测（修复后）**：11 张表全部拿到真实值 ——
`api_metrics_minute 424KB / 6954 行`、`db_metric_sample 636KB / 2757 行`、
`skills 12KB / 9 行`…，`unavailable` 为空。

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
- 测试：**1968 passed / 2 skipped（109 文件）**

**沿用**：远程文件面板右键操作、Docker AI 智能诊断、告警导出 Markdown/真实 XLSX、AI 分析进通知中心、GPU 进程解析、路由懒加载。

完整手册见 `deploy/MANUAL.md`。
