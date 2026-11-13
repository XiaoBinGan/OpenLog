# OpenLog

🤖 AI 驱动的日志分析与监控平台

**[[English](README.md)] | [[简体中文](README.zh-CN.md)]**

> 本文是中文版。英文版（[README.md](README.md)）为主版本，内容不一致时以英文版为准。

> **离线包与打包脚本：请用 [v1.0.1](https://github.com/XiaoBinGan/OpenLog/releases/tag/v1.0.1)。**
> `v1.0.0` 的 tag 是首个开源快照，不包含之后修的三处交付链路问题
> （`.gitattributes` 钉死 LF、`install.sh` 架构自检、`make-package.sh` 打包脚本）。运行时代码无变化。

---

## 📑 目录

- [特性](#-特性)
- [快速开始](#-快速开始)
  - [前置要求](#前置要求) · [安装](#安装) · [配置](#配置) · [支持的推理服务](#支持的推理服务vllm--sglang--strata--ollama)
  - [访问令牌](#访问令牌) · [运行](#运行) · [Windows 快速开始](#windows-快速开始)
  - [生产模式部署](#生产模式部署单端口) · [一键部署](#一键部署) · [数据库](#数据库) · [远端访问](#远端访问与访问令牌)
- [开发与质量门禁](#-开发与质量门禁)
- [页面导航](#-页面导航)
- [项目结构](#-项目结构)
- [更新记录](#-更新记录)
- [技术栈](#-技术栈)
- [核心功能详解](#-核心功能详解)
  - 远程服务器管理 · 规模与性能 · 运维助手 · AI Shell · 技能管理
  - 算力监控 · MFU 计算方式 · 接入自定义推理服务 · 告警规则
  - 容器日志告警 · Docker 实时日志 · 容器内执行命令
- [API 速查](#-api-速查)
- [许可证](#-许可证)

---

## ✨ 特性

| 特性 | Feature |
|------|---------|
| 📊 实时仪表盘 | Real-time Dashboard |
| 🎮 多服务算力监控 | Multi-server GPU Monitoring (利用率 / 显存 / 温度 / MFU) |
| 📝 日志流监控 | Live Log Streaming |
| 🤖 AI 智能分析 | AI Analysis (LLM-powered) |
| 💬 运维助手（会动手） | Ops Assistant (agent: locate → read → edit code/config → verify) |
| 🧠 AI Shell | AI Shell (natural language → multi-step shell agent) |
| 🩺 推理服务兼容 | OpenAI-compatible: vLLM / SGLang / Strata / Ollama (auto tool-calling fallback) |
| 🔍 容器日志实时告警 | Container log alert (multi-format level parsing + popup) |
| 📊 GPU MFU | MFU per card, engine-agnostic (vLLM / SGLang / Strata / TGI / custom) |
| 🔧 技能管理 | Skills Management (import/export, Markdown spec) |
| 🔔 告警规则 + Webhook 通知 | Alert Rules + Webhook Notifications |
| 🐳 Docker 管理 | Docker Management |
| 🖥️ 远程服务器管理 | Remote Server Management |
| 📜 分析历史 | Analysis History |
| ⚙️ 灵活配置 | Flexible Configuration |

---

## 🚀 快速开始

### 前置要求

- Node.js **22.22+**（`jsdom 30` 依赖链要求；见 `.nvmrc`）
- npm
- OpenAI API Key（用于 AI 分析 / for AI analysis）

### 安装

```bash
git clone https://github.com/XiaoBinGan/OpenLog.git
cd OpenLog
npm install
cd client && npm install && cd ..
```

### 配置

```bash
cp .env.example .env
# 编辑 .env。最少需要设置 OPENLOG_TOKEN（生产模式强制鉴权）
```

> ⚠️ 服务默认只监听 `127.0.0.1:3011`。若需要从其他机器访问，必须显式设置
> `HOST=0.0.0.0`、`OPENLOG_TOKEN`，并把前端来源加入 `OPENLOG_ALLOWED_ORIGINS`。
> 详见 `.env.example` 内的逐项说明。

模型 API Key 等配置在**页面「设置」中填写**，持久化在数据库里；`.env` 里的
`OPENAI_API_KEY` 只在数据库尚无配置时作为首次启动的默认值。

#### 支持的推理服务（vLLM / SGLang / Strata / Ollama）

设置页的「模型」可以指向任意 **OpenAI 兼容** 服务，只要填对 Base URL：

| 服务 | Base URL 示例 | 原生 function calling |
|---|---|---|
| vLLM | `http://127.0.0.1:8000/v1` | 需启动参数 `--enable-auto-tool-choice --tool-call-parser hermes`（或对应 parser） |
| SGLang | `http://127.0.0.1:30000/v1` | 需启动参数 `--tool-call-parser qwen25`（或对应 parser） |
| Strata | `http://127.0.0.1:8899/v1` | 支持 |
| Ollama | `http://localhost:11434/v1` | 取决于模型（qwen3 / llama3.1+ 支持） |
| OpenAI 兼容云服务 | 各家 `/v1` | 支持 |

**没开原生 tool calling 也能用**。两种失败模式都处理了：

1. 引擎**报错**（如 vLLM 的 `400 tools is not supported`）
2. 引擎**静默忽略** `tools`（vLLM / SGLang 没加 `--tool-call-parser` 时的真实行为：
   不报错，但只回一段「我需要调用 remote_ls…」的文字，一次工具都没执行）

两种情况都会自动切到「文本协议」（模型输出 `TOOL_CALL: {...}` / `FINAL:`），
agent 能力（读代码、改配置、执行命令、确认闸门、审计）全部保留，只是调度方式
从原生 function calling 换成提示词协议。降级结论缓存 30 分钟，前端会收到一条
`provider_notice` 说明，不会每次都重试。

设置页的「刷新列表」对上述所有服务都有效（统一走 `/v1/models`，Ollama 自动兜底
`/api/tags`），另有 `GET /api/chat/provider` 可查当前识别到的引擎类型与
「怎么开启原生 tools」的提示。

> 🔐 `OPENLOG_SECRET_KEY` 决定数据库里 SSH 密码 / 模型 Key 的加密密钥。
> 从「未设置」切到「已设置」会触发一次性数据迁移（单向），设置后不要再取消，
> 否则此前已重新加密的凭据将无法解读。生成方式（32 字节）：
>
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### 访问令牌

服务端用 `OPENLOG_TOKEN` 做访问鉴权（生产模式强制，见下文「生效范围」）。
**令牌就是控制台的总钥匙**：它能调 SSH、Docker、远程执行等全部管理接口，务必保密。

#### 1. 如何生成

推荐用 Node 自带的 `crypto` 生成 24 字节随机令牌（48 位十六进制，和服务端自动生成的格式一致）：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
# 示例输出：3f9c2a...（48 个十六进制字符）
```

把输出写进 `.env`（`cp .env.example .env` 后编辑）：

```bash
OPENLOG_TOKEN=3f9c2a...（你生成的值）
```

容器/Compose 部署时用环境变量传入（**不要**写进镜像）：

```bash
# docker run
docker run -d ... -e OPENLOG_TOKEN=<你的令牌> openlog:latest

# docker compose（compose 文件里已声明 OPENLOG_TOKEN 必填，可放在同目录 .env 或命令行传入）
OPENLOG_TOKEN=<你的令牌> docker compose up -d
```

#### 2. 不设置时的默认行为

**不设置 `OPENLOG_TOKEN` 也能用**，服务端会自己生成并持久化：

1. 首次启动时生成 24 字节随机令牌，写入 `data/.auth_token`（权限 `0600`，已被 `.gitignore` 忽略）；
2. 之后每次启动**复用该文件**，令牌不变（容器部署里它就在数据卷 `data/` 下，重建容器也不会变）；
3. 优先级：`OPENLOG_TOKEN` 环境变量 **>** `data/.auth_token` **>** 首次自动生成；
4. 删除 `data/.auth_token` 并重启 → 会重新生成一个**新令牌**，旧令牌立即失效
   （浏览器里存过旧令牌的会回到「需要访问令牌」输入框）。

读取当前生效的令牌：

```bash
cat data/.auth_token                       # 本机/裸机
docker exec openlog cat /app/data/.auth_token   # 容器部署（数据卷挂载在 /app/data）
```

> 注意：如果设置了 `OPENLOG_TOKEN` 环境变量，**以环境变量为准**，`data/.auth_token` 可能根本不存在或已过期，不要拿文件去猜。

#### 3. 生效范围与用法

| 场景 | 是否需要令牌 |
|---|---|
| `NODE_ENV=production`（含容器默认） | **所有** `/api`、`/ws` 请求都需要 |
| 开发模式 + 回环地址（`127.0.0.1` / `::1`） | 免鉴权（本机调试用） |
| 开发模式 + 其它机器访问 | 需要令牌 |

- HTTP 请求头：`Authorization: Bearer <token>`
- WebSocket：`ws://host:port/ws?token=<token>`
- 浏览器从其它机器访问生产实例时，会自动弹出「需要访问令牌」输入框（`AuthGate`），
  输入一次后保存在本机 `localStorage`，之后免输入；令牌变更后会重新提示。

#### 4. 更换令牌

任选一种，然后重启服务端，所有浏览器都会重新要求输入：

```bash
# 方式 A：改环境变量（推荐，令牌不受数据目录影响）
OPENLOG_TOKEN=<新令牌> node server/index.js

# 方式 B：删文件让它自动生成
rm -f data/.auth_token && node server/index.js
```

> 安全提醒：不要提交 `.env`、不要把令牌写进 URL/截图/聊天记录；生产环境建议把
> `OPENLOG_TOKEN` 放进 Compose `.env`、Docker secret 或部署平台的 Secret 管理里。

### 运行

```bash
# 终端 1 — Server / Terminal 1
nvm use 22
node server/index.js

# 终端 2 — Client / Terminal 2
cd client && npm run dev -- --port 5173 --host
```

访问 | Visit http://localhost:5173

### Windows 快速开始

Windows 上 `npm` 的 PowerShell 包装脚本（`npm.ps1`）常被执行策略拦截，
统一改用 `npm.cmd`；另外 Windows 不支持文件系统 unix socket，
Docker-over-SSH 桥会自动改用命名管道 `\\.\pipe\...`（已内置，无需配置）。

```powershell
cd D:\project\openlog
copy .env.example .env
npm.cmd install
npm.cmd install --prefix client

# 终端 1
node server/index.js
# 终端 2
cd client; npm.cmd run dev -- --port 5173 --host
```

### 生产模式部署（单端口）

`NODE_ENV=production` 时后端会直接托管 `client/dist` 静态页面，只需暴露 3011 一个端口：

```bash
npm ci --no-audit --no-fund
npm run build
OPENLOG_TOKEN=<你的访问令牌> NODE_ENV=production HOST=0.0.0.0 node server/index.js   # POSIX
```

```powershell
# Windows：用 npm.cmd start（跨平台，等价于 NODE_ENV=production）
$env:OPENLOG_TOKEN = '<你的访问令牌>'
npm.cmd start
```

生产模式强制鉴权：所有 `/api`、`/ws` 请求都需要携带 `OPENLOG_TOKEN`
（`scripts/start-prod.js` 会把 `NODE_ENV` 默认设为 `production`）。

#### 一键部署

两种形态，按场景选：

**A. 新机器从零起一套（应用 + PostgreSQL）**

```bash
cp deploy/deploy.env.example .env    # 填 OPENLOG_TOKEN / POSTGRES_PASSWORD
docker compose up -d --build
```

`docker-compose.yml` 里带 PostgreSQL 服务和健康检查，起完直接可用。

> ⚠️ compose 需要 Docker **20.10+**（`docker compose` 子命令）或 `docker-compose` **v1.27+**。
> Docker 19.03 及更早两者都没有（实测报 `docker: 'compose' is not a docker command.`），
> 用 `bash deploy/install.sh`（纯 docker run，不需要 compose）。

**B. 已有实例更新（生产推荐）**：一条命令，带备份、健康检查、失败自动回滚。

```bash
# 开发机：填 .deploy.json（服务器地址/账号，已 gitignore）
cp deploy/deploy.config.example.json deploy/.deploy.json
npm run deploy              # 或 npm run deploy
```

它做完整的一串，任何一步失败都不会留半拉子状态：

1. 打 git bundle（服务器通常连不上 GitHub，用 bundle 中转）→ SFTP 上传
2. 远端 `git fetch` + `reset --hard`
3. 调服务器上的 `deploy/deploy.sh`：
   - **备份数据库**（PG → `pg_dump`，SQLite → 在线备份，保留最近 10 份）
   - 构建镜像，打 `openlog:<commit>` + `openlog:latest`
   - 从 `deploy/deploy.env` 读全部配置启动容器（不再手写一长串 `-e`）
   - **健康检查**：页面 200 + `/api/db/info` 的 `ok:true`，最多等 90s
   - **失败自动回滚**到上一个镜像并恢复服务
   - 清理旧镜像（保留最近 N 个）

```bash
npm run deploy --dry-run     # 只打印将要执行的动作，不动线上
npm run deploy --no-build    # 只同步代码+重启（改了 deploy.env 后）
npm run deploy --skip-backup # 跳过数据库备份
npm run deploy:logs                   # 只看服务状态/最近日志
npm run deploy:image:save             # 归档当前镜像（离线部署 / 长期回滚点）
```

服务器侧配置在 `deploy/deploy.env`（含数据库密码，已 gitignore）：

```bash
APP_PORT=3001
DATA_DIR=/workspace/Openlog-new/data
LOGS_VOLUME=openlog-logs
NETWORK_MODE=host
OPENLOG_DB_TYPE=postgres
OPENLOG_DATABASE_URL=postgres://openlog:密码@127.0.0.1:5432/openlog
OPENLOG_ENABLE_CONTAINER_EXEC=1
```

也可以直接在服务器上跑（不走 SSH）：

```bash
cd /workspace/Openlog-new && bash deploy/deploy.sh
```

部署记录写在 `backups/.last-deploy.json`（时间 / commit / 镜像 / 上一个镜像，回滚用）。

> 首次部署前服务器上要准备好 `deploy/deploy.env`，之后每次改代码只需 `npm run deploy`。
> 完整部署手册（首次部署 / 镜像归档 / 备份恢复 / 回滚 / 排障）：**[deploy/MANUAL.md](deploy/MANUAL.md)**
> 升级到新版部署脚本时做一次手工同步（`git pull`/bundle），之后就是一条命令。

#### 数据库

默认 **SQLite**（`data/openlog.db`，WAL + `synchronous=NORMAL` + `busy_timeout=5s`），零配置、单机够用。
规模化或多实例共享时换 **PostgreSQL**（推荐）或 **MySQL**，两者都走**连接池**：

```bash
# PostgreSQL（连接池默认 10）
OPENLOG_DB_TYPE=postgres
OPENLOG_DATABASE_URL=postgres://openlog:密码@127.0.0.1:5432/openlog
OPENLOG_PG_POOL_MAX=10

# 也可以分字段：OPENLOG_PG_HOST / PORT / USER / PASSWORD / DATABASE
# MySQL：OPENLOG_DB_TYPE=mysql + OPENLOG_DATABASE_URL=mysql://...
```

几个行为约定：

- **显式配置了库却连不上会直接报错**，不会静默回退到本地 SQLite
  （否则生产换库时数据写到了没人知道的地方）。
- SQL 全部用 `?` 占位，PostgreSQL 在适配层转成 `$1,$2…`；业务代码不感知方言。
- 建表按方言生成类型：时间戳 PG/MySQL 用 `BIGINT`（SQLite 的 `INTEGER` 32 位会在 2038 溢出）、
  PG 的 JSON 列用 `JSONB`、MySQL 主键用 `VARCHAR`（TEXT 不能做主键）。
- `kv_store`（设置、GPU 配置、审计等）启动时**整表进内存**，读走内存、写异步落库 ——
  这样 `getKv()` 保持同步语义，异步适配器下也成立（这是之前 PG 读配置全是 undefined 的根因）。
- 迁移工具：

```bash
OPENLOG_DB_TYPE=postgres \
OPENLOG_DATABASE_URL=postgres://openlog:密码@127.0.0.1:5432/openlog \
  node scripts/migrate-sqlite-to-pg.mjs
```

幂等（主键冲突跳过）、可 `--dry-run` 先看行数；只复制数据、不动 SQLite 文件（留作回滚）。
⚠️ SSH 密码是加密存储的，迁移与运行时必须使用**同一个** `OPENLOG_SECRET_KEY`，否则密码解不开。

> PostgreSQL 在 1000 台量级的实测：1000 台服务器批量写入 674ms（分 100 行一批）、读回 86ms、
> 50 个并发查询 1ms（连接池）；`log_records` 与查询走 `machine_id` / `timestamp` 索引。

**健康检查**：`GET /api/db/info`（需 token）返回当前库类型、连接池水位、探活延迟、存储占用：

```json
{
  "type": "postgres", "dialect": "postgresql", "ready": true, "ok": true,
  "latencyMs": 2,
  "pool": { "total": 1, "idle": 1, "waiting": 0, "max": 10 },
  "database": "openlog",
  "storage": { "kind": "database", "bytes": 8454144 },
  "timestamp": "2026-10-29T00:24:11.000Z"
}
```

`waiting` 持续 > 0 说明池被打满，调大 `OPENLOG_PG_POOL_MAX`；`?counts=1` 额外给出关键表行数
（大表用方言估算：PG `pg_class.reltuples`、MySQL `information_schema`，不做全表扫描）。
端点不返回用户名/密码/连接串。

#### 远端访问与访问令牌

`GET /api/auth/token` 只允许**回环地址**调用（非 localhost 一律 403），所以从其它机器
用浏览器访问生产实例时，前端无法自动拿到令牌，会弹出「需要访问令牌」入口：

- 令牌取自服务端 `data/.auth_token`（首次启动自动生成，容器部署即数据卷里那个文件）；
  若设置了 `OPENLOG_TOKEN` 环境变量则以它为准。生成方式与默认行为见
  [访问令牌](#访问令牌)。
- 输入一次后保存在浏览器 `localStorage`（仅本机），后续访问免输入；
  令牌变更（换容器/换令牌）后会自动再次提示。
- 想临时换令牌：浏览器 DevTools 执行 `localStorage.removeItem('openlog_token')` 后刷新。
  （提示：Chrome 控制台首次粘贴会要求手动输入「允许粘贴」，这是浏览器的防自 XSS
  保护，不是本项目的提示；正常流程无需控制台，令牌直接输在页面输入框即可。）

---

## 🧪 开发与质量门禁

```bash
npm test              # 单元 + 集成测试（约 680 个用例，含安全回归）
npm run test:coverage # 带覆盖率
npm run lint          # 服务端 ESLint
npm run lint:client   # 客户端 ESLint（React + TS）
npm run lint:all      # 上面两个一起跑
npm run build         # tsc -b && vite build
```

CI（`.github/workflows/ci.yml`）在 push/PR 到 `node` / `main` 时依次执行
双端安装 → 双端 lint → 构建 → 测试；**矩阵覆盖 ubuntu-latest 与 windows-latest**
（Docker-over-SSH 桥、路径分隔符等差异只在 Windows 暴露，因此必须进 CI）。

> ⚠️ **测试隔离**：测试会拉起真实服务端子进程。若未设置 `OPENLOG_DATA_DIR`，
> 它会读写项目里的 `data/openlog.db`、`settings.json`、`remote-servers.json`。
> `vitest.config.js` 已默认把它们指向系统临时目录下的 `openlog-vitest`
> （跨平台，不再是写死的 `/tmp`），手动跑服务时请留意不要用测试参数指向生产数据。

---

## 🧭 页面导航

| 页面 | 路径 | 功能 |
|------|------|------|
| 系统监控 | `/monitor` | CPU、内存、磁盘、GPU、进程监控 |
| 算力监控 | `/gpu` | 所有服务器 GPU 总览（利用率/显存/温度/进程/MFU） |
| 仪表盘 | `/dashboard` | 总览面板 |
| 日志流 | `/logs` | 实时日志查看、级别过滤、搜索 |
| 远程服务器 | `/remote` | SSH 连接、文件浏览、终端、AI Shell |
| Docker 容器 | `/docker` | 容器管理、实时日志流、上下游链路 |
| AI 分析 | `/analytics` | 日志分析、容器巡检、健康诊断 |
| 分析历史 | `/analysis-history` | 历史分析记录查看 |
| 运维助手 | `/assistant` | Agent：定位问题、改代码/配置、跑命令并验证（写操作需确认，留审计） |
| 技能管理 | `/skills` | 自定义技能 CRUD、导入/导出、标准格式 |
| 设置 | `/settings` | 模型配置（vLLM/SGLang/Strata/Ollama）、告警规则、容器巡检 |

---

## 📁 项目结构

```
openlog/
├── client/                  # React 前端
│   ├── src/
│   │   ├── components/      # 组件
│   │   │   ├── AIShellTerminal.tsx   # AI Shell 终端
│   │   │   ├── Layout.tsx           # 布局 + 导航
│   │   │   └── ...
│   │   ├── pages/           # 页面
│   │   │   ├── Dashboard.tsx        # 仪表盘
│   │   │   ├── GPU.tsx              # 算力监控
│   │   │   ├── Logs.tsx             # 日志流
│   │   │   ├── Analytics.tsx        # AI 分析
│   │   │   ├── AnalysisHistory.tsx  # 分析历史
│   │   │   ├── Assistant.tsx        # 运维助手
│   │   │   ├── Docker.tsx           # Docker 管理
│   │   │   ├── Monitor.tsx          # 系统监控
│   │   │   ├── Remote.tsx           # 远程服务器
│   │   │   ├── Settings.tsx         # 设置
│   │   │   └── Skills.tsx           # 技能管理
│   │   ├── contexts/
│   │   │   ├── RemoteContext.tsx    # 远程服务器状态
│   │   │   ├── AssistantContext.tsx # 运维助手状态
│   │   │   └── ...
│   │   └── types.ts
│   └── package.json
├── server/                    # Node.js 后端
│   ├── index.js               # 主文件（API + WebSocket + 巡检）
│   ├── remote.js              # SSH 远程连接管理（含自动重连/退避）
│   ├── docker.js              # Docker API 封装
│   ├── docker-ssh-bridge.js   # Docker over SSH（命名管道桥接）
│   ├── gpu.js                 # GPU 查询（nvidia-smi）
│   ├── gpu-mfu.js             # MFU 计算（引擎无关，多来源探测）
│   ├── log-level.js           # 日志级别解析（多格式）
│   ├── container-log-watch.js # 容器日志实时错误监听
│   ├── ai-shell.js            # AI Shell 多步 agent（环境感知/风险分级）
│   ├── llm-provider.js        # 推理服务适配（vLLM/SGLang/Strata/Ollama）
│   ├── agent-tools.js         # 运维助手「动手」工具（读/改/回滚）
│   ├── agent-audit.js         # 写操作审计流水
│   ├── remote-store.js        # 服务器按行存储（1000 台量级）
│   ├── stats-scheduler.js     # 集中采集调度器
│   ├── security/              # 命令风险与 Shell 策略
│   ├── routes/                # 路由（chat/chat-runner/docker/remote/gpu/...）
│   └── db/                    # SQLite / PostgreSQL / MySQL 数据层
│       └── index.js           # 表结构 + CRUD
├── deploy/                  # 部署资产（脚本 / 配置模板 / 镜像归档）
│   ├── deploy.sh            #   服务端部署（备份/构建/健康检查/回滚）
│   ├── deploy.mjs           #   开发机一键部署
│   ├── MANUAL.md            #   完整部署手册
│   └── images/              #   镜像归档 + 清单
├── data/                    # 数据库文件（gitignored）
└── package.json
```

---

## 🕒 更新记录
### 2026-10-29 · 只读命令不再反复弹确认

- 新增 `server/security/command-risk.js`：引号感知解析 Shell 命令，判断是否为只读。
  `remote_exec` / `docker_exec` 的只读查询（ls/cat/grep/ps/df/ss/docker ps/docker logs/systemctl status/nginx -T…）
  **直接执行、不弹确认**；写文件、改配置、启停服务、`sudo`、命令替换等仍然确认。
- 同一次任务里完全相同的写操作只确认一次（批准记忆），减少重复点击。
- 判定保守：任一段管道/分号子命令不在只读白名单、或出现写重定向/`tee`/`sed -i`/`find -exec`/`xargs`/`sudo`/命令替换，
  都按需确认处理 —— 宁可多问一次，不误放行。

### 2026-10-29 · 修复拖动排序与日志选中的冲突

- Docker 页容器卡片原来整体设成 `draggable`，浏览器原生拖拽会劫持鼠标拖动 —— 卡片内**实时日志、AI 诊断、终端输出全部选不中、复制不了**。改成只有左侧手柄可拖（`dragstart` 冒泡，排序/投放逻辑不变），Dashboard 和 Monitor 的卡片同样修正。
- 日志/诊断流式追加时的自动滚动新增「正在选中文字就跳过」，并改用即时滚动，避免框选被滚走。
- 日志面板与终端面板新增「复制」按钮（一键复制全部，框选不好用时的兜底），日志时间戳也不再阻止选中。


> 只记对使用者有影响的变化，详细提交见 `git log`。

### 2026-10 · 运维助手变成 agent、推理服务兼容

**运维助手能动手了**（`/assistant`）

- 新增 10 个远程工具：`remote_stat` / `remote_ls` / `remote_read_file`（行区间、200KB 截断）/
  `remote_grep` / `remote_edit_file`（精确替换、要求唯一）/ `remote_write_file` /
  `remote_rollback_file` / `remote_git_status` / `remote_git_diff` / `remote_restart_service`
- **服务端确认闸门**：`write` / `danger` 工具调用会暂停 SSE，前端弹确认条（文件路径 / 命令 / diff 预览），
  3 分钟不操作视为拒绝；拒绝结果回灌给模型让它换方案
- **自动备份**：改/写前复制 `<文件>.openlog-bak.<时间戳>`，可 `remote_rollback_file` 回滚
- **审计流水**：`GET /api/chat/audit` 可查每次写操作的工具 / 服务器 / 文件 / 命令 / 结果
- 工具轮次上限 5 → 10，System prompt 写入「定位 → 说明 → 修改 → **验证** → 失败回滚」标准流程

**推理服务兼容**（vLLM / SGLang / Strata / Ollama）

- 新增 `GET /api/models`（统一 `/v1/models`，Ollama 自动兜底 `/api/tags`）与
  `GET /api/chat/provider`（识别引擎类型 + 开启原生 tools 的提示）
- **自动降级**：引擎不支持原生 function calling（报错 **或静默忽略 tools**）时，
  自动切到 `TOOL_CALL:` / `FINAL:` 文本协议，agent 能力不变；结论缓存 30 分钟
- 修复 `ThinkingStreamFilter` 吞掉回复的严重 bug：不输出 `<think>` 标记的模型
  （Strata / vLLM / SGLang 等把思考放 `reasoning_content`）曾导致回答只剩半句甚至全空
- 设置页新增 vLLM / SGLang 预设，「刷新列表」对所有引擎生效

**远程服务器**

- 断线自动重连（指数退避 5s → 300s 封顶），卡片上显示失败原因 / 重试次数 / 下次重试时间

**容器日志告警**

- 多格式日志级别解析（`[ERROR]` / `ERROR:` / JSON / pino 数字 / syslog / logback / nginx / `panic:` 等）
- 实时监听（5s 增量轮询）+ 前端弹框，点击直达该容器实时日志
- 防止自激放大：跳过 OpenLog 自己的容器和自身日志行

---

## 🛠 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React + TypeScript + Vite + TailwindCSS + Recharts + marked |
| 后端 | Node.js + Express + WebSocket + SSE |
| 数据库 | SQLite (better-sqlite3) / PostgreSQL / MySQL（连接池） |
| AI | OpenAI 兼容协议（vLLM / SGLang / Strata / Ollama / 云端），原生 tool calling 不可用时自动降级为文本协议 |
| 监控 | chokidar + systeminformation + nvidia-smi |

---

## 💡 核心功能详解

### 🖥 远程服务器管理

- SSH 连接（密码 / 私钥 / 密钥路径），连接池复用同一份实现
- 文件浏览、日志查看、文件编辑、上传下载（含分块上传）
- 内嵌终端（PTY）与 AI Shell
- **状态可信**：`GET /api/remote/servers` 返回的是**连接池实况**。上个进程持久化的
  `connected` 会降级成 `disconnected`，不会再出现「页面显示绿灯、一操作就报服务器未连接」。
- **按需重连**：浏览文件、读日志、执行命令、取状态时若连接不存在，会自动重建，
  而不是直接返回 `500 服务器未连接`。
- **批量操作**：远程页支持勾选/全选 + 一键重连 / 一键断开，另有「全部重连(N)」
  一次连上所有未连接的机器。
- **断线自动重连**：连不上的机器按 `5s → 10s → 20s → … → 5min` 指数退避持续重试，
  恢复后自动回到 `connected`，不需要人工点（早期版本只在进程启动时重连一次，
  机器下线再上线就永远是红灯）
  - 手动点「断开」会清掉重试计划，不会被自动连回来
  - 卡片上直接显示**最近一次失败原因**（如 `Timed out while waiting for handshake`、
    `All configured authentication methods failed`）和已重试次数 —— 红灯可诊断，
    不用猜是网络、sshd 还是密码问题

### 📈 规模与性能（1000 台量级）

原本是按「几十台」设计的，1000 台会先被这些地方卡死，现已逐项改造：

| 问题 | 原状态 | 现在 |
|---|---|---|
| 服务器配置存储 | 整块 JSON 存在 `kv_store`，每台状态变化都重写整个数组（1000 台 332KB / 1.7ms，同步阻塞事件循环） | 独立表 `remote_servers`，**一行一台**，状态变化只 UPDATE 一行；写操作合并 + 100ms 微批。实测 1000 次状态更新排队 5ms、落库 95ms；加载 1000 台 20ms |
| 算力监控采集 | 前端每 30s 对**每台**机器发 2 个请求（stats + mfu），`Promise.all` 无上限 → 1000 台 = 2000 并发请求/30s | **服务端集中采集**：限并发（默认 16）、内存缓存、间隔自适应；前端只发**一个**请求拿全量快照 `GET /api/remote/servers/stats` |
| 自动重连 | 串行 `for … await connect()`：1000 台不可达时一轮要数小时，期间不再重试（等于失效） | **限并发 + 每轮限量**（默认 16 并发 / 每轮 64 台，按下次重试时间排序），一轮几秒内完成并持续滚动 |
| SSH 连接数 | 每台一条常驻连接，无上限 | 连接池上限（默认 300）+ **空闲回收**（默认 10 分钟），按需重连；建连超时 10s（原默认 20s） |
| 容器日志监听 | 每 5s 双层串行循环，**无防重入** → 容器一多就任务堆积 | 定时器侧防重入 + 耗时超间隔自动放宽间隔 |
| 日志保留 | `logPersistenceMaxAge` 只在**手动**端点生效，没有定时任务 → 无限增长 | 维护任务每小时按保留天数清理 `log_records` / `analysis_records` + WAL checkpoint |
| 运维助手 prompt | 把所有已连接服务器都塞进 system prompt（几千台 = 十万级 token） | 只列前 30 台 + 总数摘要，其余让模型用 `remote_servers` 工具现查 |
| 启动重连 | `Promise.allSettled` 一次拉起上千条 SSH | 限并发（默认 16） |

**可调参数**（环境变量，均有默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENLOG_STATS_INTERVAL_MS` | `30000` | 状态采集间隔 |
| `OPENLOG_STATS_CONCURRENCY` | `16` | 采集并发上限（1000 台时建议 16–32） |
| `OPENLOG_MFU_INTERVAL_MS` | `60000` | MFU 采集间隔（只采有 GPU 的机器） |
| `OPENLOG_MAX_SSH_CONNECTIONS` | `1200` | 常驻 SSH 连接上限（应 ≥ 服务器台数） |
| `OPENLOG_SSH_IDLE_TTL_MS` | `600000` | 空闲连接回收时间 |
| `OPENLOG_SSH_READY_TIMEOUT_MS` | `10000` | SSH 建连超时 |
| `OPENLOG_RECONNECT_CONCURRENCY` | `16` | 自动重连并发 |
| `OPENLOG_RECONNECT_MAX_PER_PASS` | `64` | 每轮最多重试台数 |
| `OPENLOG_STARTUP_CONNECT_CONCURRENCY` | `16` | 启动时重连并发 |

> 数据库本身不是瓶颈：实测 SQLite（WAL）单条插入 8k+ 条/秒、1000 台服务器加载 20ms。
> 1000 台以上先调上面这几个并发/间隔参数；真要再上一个量级，再考虑采集进程与 Web 进程分离 + PostgreSQL 连接池。

**实测容量（单实例 1000 台）** —— 不是估算：

| 指标 | 实测值 | 1000 台推算 |
|---|---|---|
| 单连接 RSS | **29–64 KB** | 约 30–64 MB |
| 单连接文件描述符 | **1 个** | 约 1000 个（容器上限 1,048,576） |
| SSH 握手 | **197ms**（p95 244ms） | 并发 16 冷启动约 12s |
| 单机 stats 采集命令 | **101ms**（p95 106ms） | 并发 16 一轮约 **6.4s**（间隔 30s） |
| 1000 行批量写库 | **67ms** | — |
| 1000 行全量读取 | **18ms** | — |
| 1000 行状态更新（100 行批） | **34ms** | — |
| `GET /api/remote/servers`（1000 台） | **322 KB / 15ms** | — |
| 播入 1000 行后启动 | **约 1s** | — |
| 1000 并发连接 | **同时握持 839 条**，RSS +23.6MB，FD 839，跑完一轮重连后进程存活 | ✅ |

1000 并发测试里那 161 个失败来自**目标机 sshd 的 `MaxStartups 10:30:100` 限流**
（测试把 1000 条都指向同一台），生产环境每台是不同主机，不会触发。客户端侧已验证：
839 条活跃连接只占 23.6MB / 839 FD，关闭后无泄漏。

**真正的约束不是连接数，而是连接池上限**：`OPENLOG_MAX_SSH_CONNECTIONS` 小于服务器数时，
每轮采集都要 LRU 驱逐 + 重新握手（每次 197ms），CPU 和延迟都会白白翻倍。
所以默认值已改为 **1200**，配置原则是**上限 ≥ 服务器台数**。

**1000 台推荐配置**（连接数上限要 ≥ 服务器数，否则每轮采集都在做 SSH 重连）：

```bash
OPENLOG_STATS_CONCURRENCY=32        # 采集并发（1000 台一轮约 6-12s）
OPENLOG_STATS_INTERVAL_MS=30000     # 采集间隔
OPENLOG_MAX_SSH_CONNECTIONS=1200    # 常驻连接上限 ≥ 服务器数
OPENLOG_SSH_IDLE_TTL_MS=1800000     # 空闲回收放宽到 30 分钟
OPENLOG_RECONNECT_CONCURRENCY=32
OPENLOG_RECONNECT_MAX_PER_PASS=128
```

> 为什么连接数要放大：采集器每 30s 访问每台机器，如果上限只有 300，LRU 会在每轮采集里
> 把连接踢掉再重建（一次 SSH 握手 200–500ms + CPU），1000 台就是每秒几十次握手。
> 内存代价很小：一条空闲 ssh2 连接约几百 KB。

**已知边界**：单进程持有上千条 SSH 会话是可行的，但再加一个量级（5000+）建议把采集
拆成独立进程/多实例，Web 与采集解耦，数据库换 PostgreSQL + 连接池。

**升级说明**：旧版本把服务器存在 `kv_store` 的 `remote_servers` key 里，启动时会**自动迁移**到新表，
旧数据保留在 `remote_servers_legacy` 作为备份，不需要手工操作。

### 🤖 运维助手

不只会聊天——它能**在已连接的 SSH 服务器上定位问题、改代码、改配置**，然后把结果告诉你。

**查（自动执行）**

| 工具 | 用途 |
|---|---|
| `remote_servers` | 列出服务器与连接状态（拿 serverId） |
| `remote_stat` / `remote_ls` | 文件属性 / 目录列表 |
| `remote_read_file` | 读文件（带行号，可指定行区间；超 200KB 截断并提示） |
| `remote_grep` | **错误定位主力**：正则搜目录/文件，返回 `文件:行号:内容` |
| `remote_git_status` / `remote_git_diff` | 看仓库状态与未提交改动 |
| `remote_system_stats` / `remote_search_logs` | 系统状态 / 日志检索 |
| `docker_list` / `docker_logs` / `docker_inspect` / `docker_health_check` | 容器排查 |

**改（服务端强制确认，不是靠提示词自觉）**

| 工具 | 说明 |
|---|---|
| `remote_edit_file` | 精确替换字符串改代码/配置；**old_string 必须唯一**，否则拒绝并告诉模型有几处匹配 |
| `remote_write_file` | 整份写入（新建或覆盖） |
| `remote_rollback_file` | 用最近一次自动备份回滚 |
| `remote_restart_service` | 重启 systemd 服务 |
| `remote_exec` / `docker_exec` 的**非只读**命令、`docker_start/stop/restart` | 执行命令与容器操作 |

**三道安全闸**

1. **服务端确认**：`write` / `danger` 类工具调用会暂停，前端弹出确认条（显示文件路径、命令、diff 预览），
   点「允许执行」才真正跑；**3 分钟不操作视为拒绝**，拒绝结果会回灌给模型让它换方案（只靠 prompt 说「先问用户」不可靠，所以放在代码里拦）。
   **只读查询命令自动放行**：`remote_exec` / `docker_exec` 会先解析命令（`server/security/command-risk.js`）——
   `ls` / `cat` / `grep` / `ps` / `df` / `ss` / `docker ps` / `docker logs` / `systemctl status` / `nginx -T` / `journalctl` 等，
   以及它们用 `|` `;` `&&` 拼出的只读组合（重定向到 `/dev/null` 也算）都直接执行，不弹框；
   写文件重定向、`tee`、`sed -i`、`find -exec`、启停服务、`docker run/rm/restart`、`sudo`、命令替换一律仍需确认。
   同一次任务里**完全相同**的写操作只确认一次。
2. **自动备份**：写/改之前把原文件复制成 `<文件>.openlog-bak.<时间戳>`，改错可一键回滚
3. **路径与命令校验**：只接受绝对路径、拒绝引号/换行；`/etc`、`/root`、`~/.ssh` 等关键路径的写入升级为红色 danger 提示；
   删除/格式化/`dd` 等破坏性命令单独标注

**标准工作流**（写进了 system prompt）：`remote_servers` 定位机器 → `remote_grep` 搜报错 →
`remote_read_file` 读代码 → 说明方案 → `remote_edit_file` 改 → **验证**（读回复核 / 跑测试 / 重启后看日志）→ 失败则回滚。

**长任务不会半路死掉**（默认 30 轮 / 10 分钟，可配）：

| 机制 | 作用 |
|---|---|
| 轮数预算 30 轮 | 旧实现硬编码 10 轮，长任务必被砍；现在可 `OPENLOG_ASSISTANT_MAX_ROUNDS` 调整 |
| 时长预算 10 分钟 | `OPENLOG_ASSISTANT_MAX_WALL_MS`，超时也先给阶段性总结 |
| **上下文压缩** | 每轮请求前估算 token，超预算就把早期工具结果压成一行摘要（保留工具名/关键字段/错误），近几轮保持完整；实测 43 次工具调用需压缩一次（17k tokens） |
| **超限重试** | 模型真返回 `exceeds the context window` 时深度压缩后再试一次，而不是直接报错 |
| **优雅收尾** | 预算用尽不让模型「请简化问题重试」，而是让它基于已拿到的结果写阶段性总结（已确认什么/还差什么/建议怎么做） |
| 单轮模型超时 | `OPENLOG_ASSISTANT_ROUND_TIMEOUT_MS`（默认 180s），超时重试一次，连续两次才收尾 |
| SSE 心跳 | 每 15s 发注释帧，防止长时间等模型时被代理/浏览器掐断连接 |
| 连接自愈 | 工具执行前 `ensureSshConnection` 校验真实连接（状态显示 connected 但连接已被 LRU 回收时会自动重连） |

前端会显示三类提示：引擎降级（`provider_notice`）、上下文压缩（`context_compacted`）、
预算用尽（`budget_exhausted`）——用户能明确知道「发生了什么」和「回一句继续就能接着做」。

**上下文长度可配置、可见**（原先只能靠环境变量、启动时固化，界面上既看不到窗口也看不到用量，
用户不知道该开新会话还是换更大窗口的模型）：

| 位置 | 作用 |
|---|---|
| 设置页「运维助手上下文」 | 持久化默认值：模型窗口、上下文预算、压缩阈值、自动压缩、最大轮数、最大时长 |
| 助手输入框旁的小齿轮 | 同样几项，但**只作用于当前会话**（随会话存 localStorage）；「保存到设置页」可提升为全局默认 |
| 底部用量条 | 常驻显示 `12.3k / 48k · 26%`，带颜色分级、窗口大小、压缩次数；hover 看明细（系统提示 / 工具定义 / 消息） |
| 提示横幅 | 到 70% 提示「开启新会话」；到压缩阈值提示「历史即将被裁剪」；模型窗口 ≤32k 时直接建议换更大窗口的模型 |

优先级是**会话覆盖 → 设置页 → 环境变量**（`OPENLOG_ASSISTANT_CONTEXT_TOKENS` / `..._CONTEXT_WINDOW`
仍然生效，作为兜底）。服务端会夹紧所有值：预算不能超过 `窗口 − 输出上限`，预警阈值强制小于压缩阈值。
用量优先取引擎返回的真实 `prompt_tokens`，引擎不支持时才退回本地 CJK 估算（前端显示 `~` 前缀）。

其他：

- SSE 流式输出，工具调用状态与 diff 实时可视化
- @ 提及联动分析历史上下文；支持注入巡检报告自动分析
- 对话历史本地持久化，且按当前预算加载（不再固定只发最后 12 条，否则大窗口模型形同虚设）

**审计流水**：每次写/危险操作（执行成功、失败、被拒绝）都会记一条
`GET /api/chat/audit?limit=50` 可查——工具、服务器、文件路径、命令、结果、时间。
只记元数据不记文件内容（避免把配置里的密钥复制一份到库里），配合自动备份可事后回滚。

> ⚠️ 安全边界：工具直接用**现有 SSH 账号**执行（该账号通常已有 sudo / docker 权限），
> 没有做权限隔离。因此防线是三道：**服务端确认闸门**（改什么必须你点允许）、
> **自动备份**（可回滚）、**审计流水**（可复查）。确认闸门防的是「误改」，不是沙箱。

### 🧠 AI Shell

AI Shell 是一个**会自己动手的多步 agent**，不是「生成一条命令」的输入框：

- **环境感知**：会话建立时先采集服务器真实信息（发行版/内核/CPU/内存/磁盘/GPU/容器/监听端口/已装工具）注入 prompt，
  模型不会去猜「有没有 docker」「是不是 Ubuntu」
- **多步执行**：给一个目标（如「GPU 上跑着什么？显存正常吗」），AI 连续执行命令 →
  读输出 → 决定下一步 → 最后给结论；失败会看报错自我修正，最多 6 步
- **流式输出**：命令边跑边显示（长命令不再憋到结束），可随时停止（Esc / 停止按钮）
- **风险分级 + 确认**：
  - `read`（df/ls/ps/nvidia-smi/docker ps…）→ 自动模式直接执行
  - `write`（mkdir/cp/systemctl restart/docker restart…）→ 自动模式询问、逐步模式必问
  - `danger`（rm -rf / mkfs / shutdown / docker rm / 覆盖 /etc …）→ **任何模式都必须人工确认**
- **双模式**：AI 模式（自然语言目标）/ 命令模式（直接敲 shell，边跑边出结果，↑↓ 历史、Ctrl+L 清屏）
- **技能多选联用**：把技能里的 Workflow 注入 prompt，让 agent 按标准流程排障
- 会话内保留上下文；历史命令本地持久化

> ⚠️ 安全边界：AI Shell 用的是**现有 SSH 账号**的身份（通常已有 sudo / docker 权限），
> 风险分级 + 确认只降低误操作概率，**不是沙箱**。高危操作（drop 数据库、删数据盘）全靠确认闸门拦住。

### 🔧 技能管理

- 标准 Markdown 格式（Purpose / Workflow / Constraints / Output）
- 9 个内置技能（受保护，不可删除），含**「应用部署与发布」**——一份部署 runbook：
  读手册 → 找回滚点 → 优先 `docker load` 而不是慢构建 → 跑 `deploy/deploy.sh` →
  验证页面 200 / `/api/db/info` / 日志 → 失败回滚。这样助手是按固定流程走，不是临场发挥。
  内置技能在启动时按 id 幂等补齐，新增技能能进到已部署实例。
- JSON 导入/导出
- 一键在运维助手/AI Shell 中使用

### 🎮 算力监控

- 自动拉取所有已连接服务器的 GPU 状态
- 每卡展示：算力利用率、**MFU（模型算力利用率）**、显存、温度、进程（PID + 名称 + 显存）
- MFU 只在「服务确实暴露了推理指标」时才显示；没接入的服务只显示利用率/显存/温度（不猜、不用利用率冒充）
- 30 秒自动刷新
- 与远程服务器页面联动，无需重复输入 host/user

#### MFU（Model FLOPs Utilization）怎么算

卡片上的 `MFU` 显示在「跑着推理引擎的那张卡」上（引擎进程通过 nvidia-smi 的
`VLLM::EngineCore` / `strata` 等进程名自动映射到 GPU），公式：

```
MFU = 模型实际 FLOPs/s ÷ GPU 峰值算力（FP16/BF16 稠密，不含稀疏加速）
```

**核心原则：服务没有暴露推理指标，就不显示 MFU。** OpenLog 不会用
「GPU 利用率」冒充 MFU —— 那是 kernel 活跃时间占比，不是模型算力利用率，
两者在访存受限的 decode 阶段能差一个数量级。

数据来源（OpenLog 通过已有 SSH 连接在**目标机本地**读取，不额外开端口、不改远端配置）：

1. 引擎自报的 FLOPs 计数器（如 vLLM 的 `vllm:estimated_flops_per_gpu_total`）做差分；
2. 该计数器缺失或恒为 0 时，用 token 计数差分 × `2 × 激活参数量`
   （MoE 取 `A3B` 这类激活参数，避免用总参数量把 MFU 夸大）；
3. 有引擎自报 GPU 型号时（如 Strata 的 `/metrics`）用它把 MFU 映射到具体显卡。

**支持自动发现的引擎/格式**：

| 引擎/格式 | 端点 | 关键指标 |
|---|---|---|
| vLLM | `/metrics` (Prometheus) | `vllm:prompt_tokens_total` + `vllm:generation_tokens_total`（优先 `by_source{local_compute}`，剔除 prefix cache 命中） |
| Strata | `/metrics` (JSON) | `totals.prompt_tokens` / `totals.output_tokens` |
| SGLang | `/metrics` (Prometheus) | `sglang:prompt_tokens_total` / `generation_tokens_total` |
| TGI | `/metrics` (Prometheus) | `tgi_request_input_length_sum` / `tgi_request_generated_tokens_sum` |
| llama.cpp | `/metrics` (Prometheus) | `llamacpp:prompt_tokens_total` / `llamacpp:tokens_predicted_total` |
| 自定义服务 | `/metrics` (JSON 或 Prometheus) | 见下一节「接入自定义推理服务」 |

发现与鉴权都是自动的：扫本机监听端口 + `docker ps` 暴露端口；遇到 401/403 时，
从本机容器的 `*_KEY / *_TOKEN / *_SECRET` 环境变量里取候选 key 重试。
`/metrics` 只允许回环地址访问（`127.0.0.1` / `localhost`），不会把指标暴露到公网。

说明与边界：

- 首次加载需要两次采样（约 2 秒），之后 30 秒轮询只多一次 curl；差分窗口上限 90 秒，
  超过就重新采样，避免「旧窗口」被当成当前值（这也解释了为什么空闲时会显示 0%，而不是历史峰值）；
- 峰值算力表覆盖 4090/5090/A100/H100/L40S/T4 等常见型号，**表里没有的卡不猜**，该服务器不显示 MFU；
  未发现推理指标端点、或服务未实现指标时，同样**不显示 MFU**（只显示利用率/显存/温度）；
- 单流 decode 的 MFU 通常只有 1%–5%（显存带宽受限），高并发/长 prefill 才会明显升高；
- 该数值用于横向对比「同一台机器不同模型/批次配置」，不是绝对性能指标。

### 🔌 接入自定义推理服务（手写 transformer 代码）

OpenLog 的 MFU 采集和引擎无关：**只要你的服务能报告「处理了多少 token」，就能算出 MFU**。
手写 Transformer / 自研推理框架 / 训练脚本都适用。三条接入路径：

#### 方式一：加一个 `/metrics` 端点（推荐，5 行代码）

在推理循环里累计 token 数，暴露成 JSON（或 Prometheus 文本）。OpenLog 会自动发现并接入。

**JSON 契约**（字段名支持常见别名）：

```json
{
  "model": "my-transformer-7b",
  "prompt_tokens": 123456,
  "generation_tokens": 7890,
  "gpu": "NVIDIA GeForce RTX 4090"
}
```

- `prompt_tokens` 别名：`input_tokens` / `prefill_tokens`；`generation_tokens` 别名：
  `output_tokens` / `completion_tokens` / `decode_tokens`
- `flops_total`（可选）：如果你的代码能直接统计 FLOPs，填它最准，OpenLog 会优先用
- `gpu`（可选）：引擎自报显卡型号，用于把 MFU 挂到对应的卡上
- 必须是**单调递增的累计值**（OpenLog 用两次采样差分求速率）

示例（FastAPI + PyTorch，10 行接入）：

```python
from fastapi import FastAPI
import torch

app = FastAPI()
STATS = {"prompt_tokens": 0, "generation_tokens": 0}

@app.get("/metrics")
def metrics():
    return {
        "model": "my-transformer-7b",
        "prompt_tokens": STATS["prompt_tokens"],
        "generation_tokens": STATS["generation_tokens"],
        "gpu": torch.cuda.get_device_name(0),
    }

# 在你的推理循环里累计（prefill 后加 prompt 长度，每生成一个 token 加 1）
# STATS["prompt_tokens"] += len(input_ids[0])
# STATS["generation_tokens"] += 1
```

Prometheus 文本格式也可以（OpenLog 用 `sumMetric` 前缀匹配，`<任意前缀>:prompt_tokens_total` 都认）：

```
myengine:prompt_tokens_total 123456
myengine:generation_tokens_total 7890
```

#### 方式二：日志解析（不改代码，前提是日志里有 token 数）

如果你的脚本已经在打印 token 信息，可以把该日志目录配给 OpenLog（远程服务器页的
「日志目录 / 文件匹配」），OpenLog 会按行解析 `tokens=N` / `tok/s=N` 之类的字段。
第一次接入建议用方式一 —— 日志解析依赖格式稳定，脚本改版容易断。

#### 方式三：手工指定参数量（名字里没有 `27B` 时）

模型名解析不出参数量（例如 `my-transformer`）时，在 **设置 → 算力监控 / MFU 数据源** 里
为那台服务器填「激活参数量（B）」。同时也可以在这里覆盖：

| 字段 | 作用 |
|---|---|
| 指标地址 | 手动指定 `http://127.0.0.1:<port>/metrics`（留空=自动发现；**只接受回环地址**） |
| 鉴权 Key | 指标端点需要 Bearer 鉴权时填写（服务端存储、前端只显示前 4 位） |
| 激活参数量（B） | 覆盖模型名解析结果（MoE 填激活参数，不是总参数） |
| 引擎进程名 | 可选正则，用于把 MFU 挂到具体显卡（例：进程是 `python train_server.py` 就填 `train_server`） |
| 算力口径 | FP16/BF16 稠密 或 FP8 稠密（按模型实际计算精度选） |

> 找不到引擎进程、且服务没有自报 `gpu` 型号时，MFU 按「占满该机全部 GPU」折算（除以卡数），
> 卡片上会同时显示在每张卡上。想精确到卡，就补「引擎进程名」或让服务在 JSON 里带上 `gpu`。

#### 怎么确认接好了

1. 在目标机上 `curl -s http://127.0.0.1:<port>/metrics` 能看到上面契约里的字段；
2. 打开「算力监控」页 → 对应服务器的标题行会出现 `<engine> MFU x.x%` 徽标；
3. 发一次推理请求，30 秒内数值应明显升高（空闲时回落为 0% 是正常的）。

> 如果容器里的服务暂时没做指标上报，卡片上就**不会显示 MFU**（只有利用率/显存/温度）——
> 这是刻意设计：宁可不显示，也不给一个用 GPU 利用率冒充的假数。

### 🔔 告警规则

- 每台机器独立配置：关键词、级别过滤、冷却时间、Webhook URL
- 容器巡检自动触发 Webhook 通知
- 冷却去重避免重复告警

### 🐳 容器日志告警

两层机制，默认都开启：

| 机制 | 频率 | 作用 |
|---|---|---|
| **实时错误提醒** | 增量 tail，默认 5s | 运行中容器出现 `ERROR` / `FATAL` 立刻在页面右下角弹框，带日志原文和「查看日志 →」跳转 |
| **定时巡检** | 默认 5 分钟 | 批量扫描所有容器，结果进入 AI 分析页；配置了 Webhook 时同时推送 |

日志等级识别覆盖常见格式（`server/log-level.js`，有单测）：

```
[ERROR] xxx                          ERROR: xxx
ERROR xxx                            2026-10-26T18:35:14Z ERROR xxx
2026-10-26 18:35:14,532 - root - ERROR - xxx     (Python logging)
(APIServer pid=1) ERROR: xxx         (vLLM / uvicorn 包装前缀)
{"level":"error","msg":"..."}        (JSON 结构化日志，也支持 severity/log.level)
{"level":50,"msg":"..."}             (pino / bunyan 数字等级)
level=error msg="..."                (logfmt)
Oct 26 18:35:14 host app[1]: ERROR xxx           (syslog)
18:35:14.532 [main] ERROR com.x.App - xxx        (logback)
2026/10/26 18:35:14 [error] 12#0: xxx            (nginx)
panic: xxx / [CRITICAL] / [SEVERE]    → FATAL / ERROR
```

> 早期版本只认 `[ERROR]` 方括号前缀，因此 `ERROR xxx`、JSON 日志、vLLM 的
> `(APIServer pid=1) ERROR:` 全被判成 INFO，**巡检和弹框都不会触发** —— 这是「容器报错没弹框」的根因。
> 现在统一走多格式解析器，并且实时提醒默认开启。

弹框说明：

- 同一容器 + 同一错误模式（去掉时间戳/IP/UUID 后的签名）**60 秒内只弹一次**，避免刷屏；
- 单次检查单容器最多推 5 条，其余合并成「同批还有 N 条」；
- 弹框常驻，点「查看日志 →」直接跳到 Docker 页并自动展开该容器、打开实时日志流；
- 可在 **设置 → 容器异常监控** 里关掉实时提醒或调整间隔（3s / 5s / 10s / 30s）。

### 🐳 Docker 实时日志

- WebSocket 流式 tail，暗色终端风格
- 暂停/继续/清空/自动滚动
- 按日志级别着色（与告警共用同一套多格式等级解析）

### 💻 容器内执行命令（Docker 页面终端面板）

容器详情里展开的终端面板，可以在容器内跑**只读**命令做快速排查：

- 支持的：`ls` / `cat` / `head` / `tail` / `ps` / `grep` / `du` / `df` / `uname` / `stat` / `ss` / `ping` 等
  （完整白名单见 `server/security/shell-command-policy.js`）
- 禁止：shell 元字符与命令链接（`;` `|` `&&` `$( )` 反引号 `>` `<` 换行）——命令**不经过 shell**，
  直接按 argv 传给容器
- 输出做 Docker 多路复用帧解复用（否则帧头字节会混进正文），单条命令输出上限 256KB
- 命令按引号规则切分，`cat "/var/log/my app.log"` 这类带空格的路径可用

**默认关闭**，需要显式开启（可以只开面板、不开 SSH 远程执行）：

```bash
OPENLOG_ENABLE_CONTAINER_EXEC=1   # 或 OPENLOG_ENABLE_REMOTE_EXEC=1 一并开启
```

关闭时面板会返回明确提示「容器内命令执行未启用」，而不是让人摸不着头脑的报错。

> ⚠️ 「元字符过滤 + 命令名白名单」**不是安全边界**：命令本身可能有逃逸口。
> 真正的边界是这个开关默认关闭 + 页面 token 鉴权。看完整日志/排障建议用只读面板，
> 需要交互式 shell 时走 `/remote` 页的 AI Shell 或 SSH 终端。

---

## 📝 API 速查

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/monitor/stats` | 系统状态（含 GPU） |
| GET | `/api/db/info` | 数据库健康检查：库类型 / 连接池水位 / 探活延迟 / 存储占用（`?counts=1` 附关键表行数，不返回凭据） |
| GET | `/api/remote/servers` | 远程服务器列表（状态取自**连接池实况**，不是持久化的旧值） |
| POST | `/api/remote/servers/batch/connect` | 批量重连（`{ids:[...]}`，限并发，逐台返回结果） |
| POST | `/api/remote/servers/batch/disconnect` | 批量断开（`{ids:[...]}`） |
| GET | `/api/remote/servers/:id/stats` | 远程系统状态（含 GPU 进程，命中采集缓存） |
| GET | `/api/remote/servers/stats` | 全量状态快照（服务端集中采集，`?refresh=1` 或 `?ids=a,b` 可按需补采） |
| GET | `/api/remote/servers/:id/mfu` | 远程模型 MFU（读 vLLM `/metrics`） |
| GET | `/api/docker/containers` | 容器列表 |
| POST | `/api/docker/:sourceId/:containerId/exec` | 容器内执行命令（只读白名单，需 `OPENLOG_ENABLE_CONTAINER_EXEC=1`） |
| GET | `/api/docker/containers/:sid/:cid/logs` | 容器日志 |
| WS | `/ws/docker/logs/:sid/:cid` | 容器实时日志流 |
| WS | `/ws/aishell/:serverId` | AI Shell 终端 |
| GET | `/api/skills` | 技能列表 |
| POST | `/api/skills` | 创建技能 |
| GET | `/api/alerts` | 告警配置 |
| PUT | `/api/alerts` | 保存告警配置 |
| GET | `/api/gpu/remote-server/:id` | 远程 GPU（复用 SSH） |
| POST | `/api/chat` | 运维助手对话（SSE 流式，含 agent 工具调用） |
| POST | `/api/chat/confirm` | 确认/拒绝一次写操作（`{confirmId, approved}`） |
| GET | `/api/chat/audit` | 运维助手写操作审计流水 |
| GET | `/api/chat/provider` | 当前推理服务引擎类型与能力提示 |
| GET | `/api/models` | 模型列表（vLLM/SGLang/Strata/Ollama，支持 `?baseUrl=&apiKey=` 覆盖） |

---

## 📄 许可证

MIT License — 见 [LICENSE](LICENSE)。

Copyright (c) 2026 XiaoBinGan

---

## 🤝 参与贡献

欢迎贡献。动手前先读 [CONTRIBUTING.md](CONTRIBUTING.md)——里面写了代码库真正在执行的约定
（业务逻辑抽成纯函数、测试与代码同目录、注释解释「为什么」而不是「做什么」）。

提交 PR 前这几条必须本地跑过：

```bash
npm run lint:all       # 要求 0 error
npx vitest run         # 2038 条测试，必须全绿
npm run build          # 生产构建
cd client && npx tsc -b
```

安全问题请走 [SECURITY.md](SECURITY.md)，不要开公开 issue。

---

## 🙏 致谢

本项目构建于这些优秀开源项目之上：[Express](https://expressjs.com/)、
[React](https://react.dev/)、[Vite](https://vitejs.dev/)、
[Tailwind CSS](https://tailwindcss.com/)、
[systeminformation](https://systeminformation.io/)、
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)。

模型能力探测按引擎无关的方式设计，感谢 [vLLM](https://github.com/vllm-project/vllm)、
[SGLang](https://github.com/sgl-project/sglang)、[Ollama](https://ollama.com/)
公开其 OpenAI 兼容层的行为差异。
**官网：** https://xiaobingan.github.io/OpenLog/ · **仓库：** https://github.com/XiaoBinGan/OpenLog

