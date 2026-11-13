# 镜像归档清单 | Image Archive Manifest

> 由 `deploy/scripts/save-image.sh` 自动维护。归档文件本身不进 git（见 `.gitignore`），
> 但这份清单会提交，用来记录「发过哪些版本、对应的 commit、校验和」。
| `openlog-6a14c377-20261112-112653.tar.gz` | `openlog:6a14c377` | `-` | `6a14c37` | 217M | 2026-11-12 11:26 | `7c2496fb4d2c…` | **当前生产版本 v1.0.0（x86/amd64）**：加 .gitattributes 钉死 LF（前端 bundle 哈希不一致的真因）；install.sh 带架构自检。243 与 4卡T4 均运行，两端 bundle sha256 一致 | 本地 + 服务器 |
| `openlog-9ccf4cd-20261112-145810.tar.gz` | `openlog:9ccf4cd` | `-` | `9ccf4cd` | 187M | 2026-11-12 14:58 | `db9c918b9c7f…` | **arm64 构建**（Mac Apple Silicon）：linux/arm64，better-sqlite3 e_machine=0xB7，bundle 与 x86 一致 `index-D_DQ4OgQ.js`；对应分发包 `openlog-deploy-9ccf4cd-arm64.tar` 295M sha256 `bc58b00a39bf…` | 本地（Mac） |
| `openlog-9f06a0a6-20261112-085039.tar.gz` | `openlog:9f06a0a6` | `-` | `9f06a0a6` | 217M | 2026-11-12 08:50 | `c33a8c2a0470…` | 上一版：架构自检 | 本地 + 服务器 |
| `openlog-c99bb354-20261111-174628.tar.gz` | `openlog:c99bb354` | `-` | `c99bb35` | 217M | 2026-11-11 17:46 | `e645996211e3…` | 上一版：v1.0.0 首个开源发布（c99bb354）；含容量告警强制弹窗 + 未知路径路由兜底。243 正在运行 | 本地 + 服务器 |
| `openlog-c99bb354-20261111-222718.tar.gz` | `openlog:c99bb354` | `-` | `c99bb35` | 187M | 2026-11-11 22:27 | `d937a6fc840a…` | **arm64 构建**（v1.0.0，Mac Apple Silicon 原生构建）：架构 linux/arm64，better-sqlite3 原生模块 ELF e_machine=0xB7(AArch64)，首页 200、缺失 chunk 404、无 bindings 报错 | 本地（Mac） |
| `openlog-7b3b3de8-20261111-172954.tar.gz` | `openlog:7b3b3de8` | `-` | `7b3b3de` | 217M | 2026-11-11 17:29 | `3615eec2ce37…` | 上一版：v1.0.0 首版（7b3b3de） | 本地 + 服务器 |
| `openlog-latest-20261111-142531.tar.gz` | `openlog:9ba4163` | `-` | `9ba4163` | 217M | 2026-11-11 14:25 | `e337b61136ec…` | 上一版：容量告警——内存>90%/磁盘>80% 弹强制确认框，持续显示直到手动关闭，关闭后 1 小时内不弹，到期仍超标继续弹；阈值可配。全量 2038 测试通过 | 本地 + 服务器 |
| `openlog-latest-20261109-180427.tar.gz` | `openlog:9571894` | `-` | `9571894` | 217M | 2026-11-09 18:04 | `a3e0f1e9615f…` | 上一版：修 SPA fallback 把不存在的 /assets/*.js 返回 HTML 导致整页白屏（「部署了没用」的真正原因）；assets 走 immutable、index.html 走 no-cache；视觉探测通过时给正向确认。全量 1978 测试通过 | 仅服务器 |
| `openlog-latest-20261109-153545.tar.gz` | `openlog:7ccc4e9` | `-` | `7ccc4e9` | 217M | 2026-11-09 15:35 | `9702a43ecc74…` | 上一版：视觉能力探测——真发一张洋红小图问颜色，三态结论（yes/no/unknown），unknown 不缓存；只在选图时探测不浪费 token；/api/chat 与 AI Shell 的图片错误单独说清原因。全量 1968 测试通过 | 仅服务器 |
| `openlog-latest-20261109-122733.tar.gz` | `openlog:cfbabad` | `-` | `cfbabad` | 217M | 2026-11-09 12:27 | `c99ac77d6abe…` | 上一版：AI Shell 与运维助手支持多图（最多 6 张，支持点选/粘贴/拖拽）；新增 vision-content.js 解决「base64 当文本估 token 导致上下文爆炸」与 `String(content)` 变 `[object Object]`；只收 data URL（防 SSRF）、白名单 MIME（拒 SVG）、历史图自动剥离 | 仅服务器 |
| `openlog-latest-20261109-001508.tar.gz` | `openlog:7132fde` | `-` | `7132fde` | 217M | 2026-11-09 00:15 | `59e72b396b61…` | 上一版：修拓扑缓存指纹碰撞、同网误含 exited 容器、`?limit=abc` 返回空列表、GPU 发现给别人制造 404 噪音；测试补齐 46 条（含此前零测试的 monitoring.js），全量 1865 通过 | 仅服务器 |
| `openlog-latest-20261108-154455.tar.gz` | `openlog:440030b` | `-` | `440030b` | 217M | 2026-11-08 15:44 | `ff41c1d9ec8c…` | 上一版：容器上下游链路重写——三个推断依据原本全读错字段（c.Networks / labels.env / depends-on），整段从未生效；现按 live_tcp（每容器 netns 真实连接）/ compose depends_on / --link / env 主机名 / 端口归属推断，每条边带证据与置信度；同网≠上下游；另修 SQLite 表体积永远 0 张表；全量 1819 测试通过 | 仅服务器 |
| `openlog-latest-20261108-093827.tar.gz` | `openlog:2f0fc38` | `763bf0c308b8` | `2f0fc38` | 217M | 2026-11-08 09:38 | `90d5c1df6839…` | 上一版：修 SQLite 面板表体积永远 0 张表（heavy 采样漏采 tables，用 dbstat + JOIN sqlite_master 排除索引，另修单表 count 失败拖垮整轮）；前版含外部数据源（容器挖连接条件 + 服务端取密码 + 探 Swagger 防 SPA 误判）与全部监控能力；全量 1770 测试通过；4卡T4 实测 11 张表真实体积与行数 | 仅服务器 |
| `openlog-latest-20261108-002649.tar.gz` | `openlog:6c18dd7` | `9bfa5bf51a5f` | `6c18dd7` | 217M | 2026-11-08 00:26 | `8ca78d955c67…` | 上一版：外部数据源面板（从容器挖 DB 连接条件 + 服务端取密码加密入库 + 探 Swagger/OpenAPI，含 SPA 兜底防误判）+ 前版全部监控能力与 9 个数据可信度修正；全量 1763 测试通过；生产 PG 实测采到 10 张表/10.6MB，vllm 探到 22 个真接口 | 仅服务器 |
| `openlog-latest-20261107-200123.tar.gz` | `openlog:138a0d6` | `854b12239f76` | `138a0d6` | 217M | 2026-11-07 20:01 | `38c24b1ae42f…` | 上一版：接口/数据库监控全套 + **5 个数据可信度缺陷修正**（错误率差 100 倍、慢查询面板永远 0 条、慢查询不落库、内存快照未标来源、切机器面板不动）+ WS token 移出 URL + PG 补列不再刷 ERROR + 覆盖率刚启动假 0 + Docker 页 1287→399、Settings 页 1968→272 + 官网双语 332 键；全量 1696 测试通过 | 仅服务器 |
| `openlog-adc09fdd1-20261106-193114.tar.gz` | `openlog:adc09fd` | `87a126a741c3` | `adc09fd` | 217M | 2026-11-06 19:31 | `2c482f94ee60…` | 上一版：接口监控 + 数据库监控（20 子代理并行交付，新增 130+ 测试，全量 1681 通过）——接口 QPS/错误率/P50-P95-P99、慢接口与错误 Top10、SQL 指纹化慢查询（不含参数值）、接口覆盖率（哪些接口从上线起没被调用）、依赖拨测、OpenAPI 文档 96 接口 + 面板内「文档」按钮；WS token 从 URL 移出改走 Sec-WebSocket-Protocol（升级闸门统一口径）；PG 补列不再每次启动刷 ERROR；Docker 页 1287→399 行、Settings 页 1968→272 行；官网中英双语 332 键 | 仅服务器 |
>
> 归档/恢复说明见 [README.md](./README.md)。
>
> **位置**列：`本地` = 开发机仓库内 `deploy/images/`；`服务器` = 部署目标机的
> `deploy/images/`。同一个文件两边可以都有，校验和一致即可互通。

| 归档文件 | 镜像 | 镜像 ID | commit | 大小 | 归档时间 | SHA256 | 备注 | 位置 |
|---|---|---|---|---|---|---|---|---|
| `openlog-d27b51104-20261106-191932.tar.gz` | `openlog:d27b51104` | `d27b51104` | `d27b511` | 217M | 2026-11-06 19:19 | `666b4ff206c12c40鈥` | 上一版：接口监控 + 数据库监控（20 子代理并行交付，262 个新测试）——接口 QPS/错误率/P50-P95-P99、慢接口与错误 Top10、SQL 指纹化慢查询、接口覆盖率（哪些接口从没被调用）、依赖拨测、OpenAPI 文档（96 接口）；WS token 从 URL 移出改走子协议；PG 补列不再刷 ERROR；Docker 页 1287→399 行、Settings 页 1968→272 行；官网中英双语 332 键 | 仅服务器 |
| `openlog-a415dab8-20261106-175913.tar.gz` | `openlog:a415dab8` | `5706dcc4a7b9` | `a415dab` | 217M | 2026-11-06 17:59 | `1b1b4487efc5…` | 上一版：修导出——Excel 大数据量栈溢出（150 条起必崩）改为按偏移写 Uint8Array；「机器」列改为机器 IP（含老数据反查）；导出失败给出可见提示 | 仅服务器 |
| `openlog-7068c566-20261106-161509.tar.gz` | `openlog:7068c566` | `682543910dff` | `7068c56` | 217M | 2026-11-06 16:15 | `8cda3a2474df…` | 上一版：修 Docker AI 智能诊断（服务端 inspect 取事实 / 日志 501 说人话 / 首字节 17s→32ms、正文 21s→2s） | 仅服务器 |
| `openlog-80075b5e-20261105-161406.tar.gz` | `openlog:80075b5e` | `f1278c4c2a12` | `80075b5e` | 217M | 2026-11-05 16:14 | `05559ac8172a4f23…` | 上一版：远程文件面板右键菜单（重命名/删除/新建文件夹/复制移动/权限，含路径校验与危险目录拦截）+ 修「选中服务器后文件列表不自动加载」 | 仅服务器 |
| `openlog-3e691168-20261105-100616.tar.gz` | `openlog:3e691168` | `2f29663e4790` | `3e691168` | 217M | 2026-11-05 10:06 | `99fdd8ed7456c018…` | 上一版：AI 分析结果并入通知中心（可筛选/导出）+ AMD/沐熙/华为 GPU 进程解析（原为 TODO 桩）+ 站点英文草稿回滚 | 仅服务器 |
| `openlog-cc0b719f-20261105-012958.tar.gz` | `openlog:cc0b719f` | `bc9ae77ebf62` | `cc0b719f` | 217M | 2026-11-05 01:29 | `8b031b3240c0195b…` | 上一版：巡检幽灵异常修复 + 会话持久化（容量受控）+ 路由懒加载（首屏 1.04MB→373KB）+ 轮询后台暂停 + 通知筛选/搜索 + AI Shell 步数/时长可调 | 仅服务器 |
| `openlog-8151d43d-20261105-000745.tar.gz` | `openlog:8151d43d` | `7014f0a775e6` | `8151d43d` | 217M | 2026-11-05 00:07 | `1e55e793ebdcf7b4…` | 上一版：通知中心告警导出（Markdown / 真实 XLSX，含机器/容器/级别/报错内容） | 仅服务器 |
| `openlog-2957a79c-20261104-175306.tar.gz` | `openlog:2957a79c` | `2048cad0a476` | `2957a79c` | 217M | 2026-11-04 17:53 | `f603029ae15ae210…` | 上一版：小模型（16k）上下文预算 + AI Shell 长任务（进度台账/24 步/继续任务） | 仅服务器 |
| `openlog-bba48c7a-20261103-005751.tar.gz` | `openlog:bba48c7a` | `05f55f4474be` | `bba48c7a` | 217M | 2026-11-03 00:57 | `d54f316da3e50e00…` | 上一版：通知中心 + 助手失败步骤「只重跑这一步」 | 仅服务器 |
| `openlog-fabbec8b-20261103-005011.tar.gz` | `openlog:fabbec8b` | `b7a646faaeab` | `fabbec8b` | 217M | 2026-11-03 00:50 | `5e72373744671152…` | 上一版：通知中心（拖拽前的初版，抽屉被顶栏 backdrop-blur 压扁的 bug 已修） | 仅服务器 |
| `openlog-edbfbaf5-20261102-231747.tar.gz` | `openlog:edbfbaf5` | `489ccc7acab2` | `edbfbaf5` | 217M | 2026-11-02 23:17 | `60a942a1be9a62dc…` | 上一版：助手正文流式输出 + 英文思维链过滤 + 失败步骤一键重试 + 历史步骤卡自动折叠 | 仅服务器 |
| `openlog-5c0b8abe-20261102-225407.tar.gz` | `openlog:5c0b8abe` | `ea534c2e90eb` | `5c0b8abe` | 217M | 2026-11-02 22:54 | `d1bfde3698c3be3e…` | 上一版：助手目标服务器绑定 + 上下文按模型窗口自适应 + 轮数收敛/继续 + 输入历史/复制 | 仅本地 |
| `openlog-2d1b390a-20261102-215203.tar.gz` | `openlog:2d1b390a` | `7ce4893153e2` | `2d1b390a` | 217M | 2026-11-02 21:52 | `34f6bbd3e875fd0e…` | 上一版：助手工具步骤卡 + 流式输出 + 假执行拦截 | 仅本地 |
| `openlog-cb13a5b-20261102-082155.tar.gz` | `openlog:cb13a5b` | `f3972d9f91be` | `cb13a5b` | 217M | 2026-11-02 08:21 | `3516b4a94af1f68d…` | 上一版：DB 未就绪返回中文 503 + 部署复用 PG 旧密码 + 诊断合并巡检日志 + 告警 toast 按容器去重 | 仅服务器 |
| `openlog-d00c4a45-20261102-014614.tar.gz` | `openlog:d00c4a45` | `239c914b3d1a` | `d00c4a45` | 217M | 2026-11-02 01:46 | `933bdc4a77d9aeda…` | 上一版：远程服务器页重排 + 磁盘 df 口径 + 开关白点修复 + 部署打印令牌 | 仅服务器 |
| `openlog-64d8d40-20261030-151329.tar.gz` | `openlog:64d8d40` | `6cc327868834` | `64d8d40` | 216M | 2026-10-30 15:13 | `162875b585fab7a9…` | 历史版本（连接状态以池实况为准 + 按需重连 + 批量重连/断开），仅作回滚点 | 本地 + 服务器 |
| `openlog-6885b4c0-20261030-020716.tar.gz` | `openlog:6885b4c0` | `3a8453355e98` | `6885b4c0` | 216M | 2026-10-30 02:07 | `a889678e49924f71…` | 已过期（缺状态修复/批量操作/部署技能），仅作历史回滚点 | 本地 + 服务器 |
| `openlog-latest-20261029-190823.tar.gz` | `openlog:latest` | `c29c63eaa3b6` | `e6264cc4` | 217M | 2026-10-29 19:08 | `664e711e29c29438…` | 旧版本（部署目录重构时） | 仅服务器 |
| `postgres-16-alpine.tar.gz` | `postgres:16-alpine` | `6a2e324ebe59` | — | 117M | 2026-10-30 16:10 | `8f0b66eb918d9fc7…` | PostgreSQL 16 运行时镜像（离线部署自带，`--with-postgres` 时自动导入） | 本地 + 服务器 |

> 说明：为省磁盘，本地 deploy/images/ 只保留最近 3 个镜像归档（更早的已删除，清单保留作历史）；离线包只保留最近 2 个（openlog-deploy-*.tar）。

> 本地只保留最近 3 个镜像归档与 1 个离线包（openlog-deploy-3e69116.tar）；更早的本地文件已删除，服务器上仍保留最近 3 个镜像归档。
