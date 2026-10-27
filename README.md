# OpenLog

🤖 AI-Powered Log Analysis & Monitoring Platform | AI 智能日志分析与监控系统

---

## ✨ 特性 | Features

| 特性 | Feature |
|------|---------|
| 📊 实时仪表盘 | Real-time Dashboard |
| 🎮 多服务算力监控 | Multi-server GPU Monitoring (利用率 / 显存 / 温度 / MFU) |
| 📝 日志流监控 | Live Log Streaming |
| 🤖 AI 智能分析 | AI Analysis (LLM-powered) |
| 💬 运维助手 | Ops Assistant (multi-turn chat + tool calling) |
| 🧠 AI Shell | AI Shell (natural language → shell commands) |
| 🔧 技能管理 | Skills Management (import/export, Markdown spec) |
| 🔔 告警规则 + Webhook 通知 | Alert Rules + Webhook Notifications |
| 🐳 Docker 管理 | Docker Management |
| 🖥️ 远程服务器管理 | Remote Server Management |
| 📜 分析历史 | Analysis History |
| ⚙️ 灵活配置 | Flexible Configuration |

---

## 🚀 快速开始 | Quick Start

### 前置要求 | Prerequisites

- Node.js **22.22+**（`jsdom 30` 依赖链要求；见 `.nvmrc`）
- npm
- OpenAI API Key（用于 AI 分析 / for AI analysis）

### 安装 | Installation

```bash
git clone https://github.com/XiaoBinGan/OpenLog.git
cd OpenLog
npm install
cd client && npm install && cd ..
```

### 配置 | Configuration

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

**没开原生 tool calling 也能用**：请求带 `tools` 被引擎拒绝时，OpenLog 会自动
降级到「文本协议」（`TOOL_CALL: {...}` / `FINAL:`），agent 能力（读代码、改配置、
执行命令、确认闸门、审计）全部保留，只是调度方式从原生 function calling 换成
提示词协议。降级结论会缓存 30 分钟，前端会收到一条 `provider_notice` 说明。

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

### 访问令牌 | Access Token

服务端用 `OPENLOG_TOKEN` 做访问鉴权（生产模式强制，见下文「生效范围」）。
**令牌就是控制台的总钥匙**：它能调 SSH、Docker、远程执行等全部管理接口，务必保密。

#### 1. 如何生成 | Generate

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

#### 2. 不设置时的默认行为 | Default behavior

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

#### 3. 生效范围与用法 | Scope & usage

| 场景 | 是否需要令牌 |
|---|---|
| `NODE_ENV=production`（含容器默认） | **所有** `/api`、`/ws` 请求都需要 |
| 开发模式 + 回环地址（`127.0.0.1` / `::1`） | 免鉴权（本机调试用） |
| 开发模式 + 其它机器访问 | 需要令牌 |

- HTTP 请求头：`Authorization: Bearer <token>`
- WebSocket：`ws://host:port/ws?token=<token>`
- 浏览器从其它机器访问生产实例时，会自动弹出「需要访问令牌」输入框（`AuthGate`），
  输入一次后保存在本机 `localStorage`，之后免输入；令牌变更后会重新提示。

#### 4. 更换令牌 | Rotate

任选一种，然后重启服务端，所有浏览器都会重新要求输入：

```bash
# 方式 A：改环境变量（推荐，令牌不受数据目录影响）
OPENLOG_TOKEN=<新令牌> node server/index.js

# 方式 B：删文件让它自动生成
rm -f data/.auth_token && node server/index.js
```

> 安全提醒：不要提交 `.env`、不要把令牌写进 URL/截图/聊天记录；生产环境建议把
> `OPENLOG_TOKEN` 放进 Compose `.env`、Docker secret 或部署平台的 Secret 管理里。

### 运行 | Running

```bash
# 终端 1 — Server / Terminal 1
nvm use 22
node server/index.js

# 终端 2 — Client / Terminal 2
cd client && npm run dev -- --port 5173 --host
```

访问 | Visit http://localhost:5173

### Windows 快速开始 | Windows Quick Start

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

### 生产模式部署（单端口） | Production (single port)

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
容器部署见 `Dockerfile` / `docker-compose.yml`（镜像已内置 `NODE_ENV=production`、`PORT=3011`、`HOST=0.0.0.0`）。

#### 远端访问与访问令牌 | Remote access & token

`GET /api/auth/token` 只允许**回环地址**调用（非 localhost 一律 403），所以从其它机器
用浏览器访问生产实例时，前端无法自动拿到令牌，会弹出「需要访问令牌」入口：

- 令牌取自服务端 `data/.auth_token`（首次启动自动生成，容器部署即数据卷里那个文件）；
  若设置了 `OPENLOG_TOKEN` 环境变量则以它为准。生成方式与默认行为见
  [访问令牌 | Access Token](#访问令牌--access-token)。
- 输入一次后保存在浏览器 `localStorage`（仅本机），后续访问免输入；
  令牌变更（换容器/换令牌）后会自动再次提示。
- 想临时换令牌：浏览器 DevTools 执行 `localStorage.removeItem('openlog_token')` 后刷新。
  （提示：Chrome 控制台首次粘贴会要求手动输入「允许粘贴」，这是浏览器的防自 XSS
  保护，不是本项目的提示；正常流程无需控制台，令牌直接输在页面输入框即可。）

---

## 🧪 开发与质量门禁 | Dev & Quality Gates

```bash
npm test              # 单元 + 集成测试（约 300 个用例，含安全回归）
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

## 🧭 页面导航 | Page Navigation

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
| 运维助手 | `/assistant` | LLM 多轮对话、工具调用、@ 提及联动 |
| 技能管理 | `/skills` | 自定义技能 CRUD、导入/导出、标准格式 |
| 设置 | `/settings` | 模型配置、告警规则、容器巡检 |

---

## 📁 项目结构 | Project Structure

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
├── server/                  # Node.js 后端
│   ├── index.js             # 主文件（API + WebSocket + 巡检）
│   ├── remote.js            # SSH 远程连接管理
│   ├── docker.js            # Docker API 封装
│   ├── gpu.js               # GPU 查询（nvidia-smi）
│   └── db/                  # SQLite 数据库层
│       └── index.js         # 表结构 + CRUD
├── data/                    # 数据库文件（gitignored）
└── package.json
```

---

## 🛠️ 技术栈 | Tech Stack

| 层级 | 技术 |
|------|------|
| 前端 | React + TypeScript + Vite + TailwindCSS + Recharts + marked |
| 后端 | Node.js + Express + WebSocket + SSE |
| 数据库 | SQLite (better-sqlite3) |
| AI | OpenAI API（兼容 Ollama 等本地模型） |
| 监控 | chokidar + systeminformation + nvidia-smi |

---

## 💡 核心功能详解

### 🖥️ 远程服务器管理

- SSH 连接（密码 / 私钥 / 密钥路径），连接池复用同一份实现
- 文件浏览、日志查看、文件编辑、上传下载（含分块上传）
- 内嵌终端（PTY）与 AI Shell
- **断线自动重连**：连不上的机器按 `5s → 10s → 20s → … → 5min` 指数退避持续重试，
  恢复后自动回到 `connected`，不需要人工点（早期版本只在进程启动时重连一次，
  机器下线再上线就永远是红灯）
  - 手动点「断开」会清掉重试计划，不会被自动连回来
  - 卡片上直接显示**最近一次失败原因**（如 `Timed out while waiting for handshake`、
    `All configured authentication methods failed`）和已重试次数 —— 红灯可诊断，
    不用猜是网络、sshd 还是密码问题

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
| `remote_exec` / `docker_exec` / `docker_start/stop/restart` | 执行命令与容器操作 |

**三道安全闸**

1. **服务端确认**：`write` / `danger` 类工具调用会暂停，前端弹出确认条（显示文件路径、命令、diff 预览），
   点「允许执行」才真正跑；**3 分钟不操作视为拒绝**，拒绝结果会回灌给模型让它换方案（只靠 prompt 说「先问用户」不可靠，所以放在代码里拦）
2. **自动备份**：写/改之前把原文件复制成 `<文件>.openlog-bak.<时间戳>`，改错可一键回滚
3. **路径与命令校验**：只接受绝对路径、拒绝引号/换行；`/etc`、`/root`、`~/.ssh` 等关键路径的写入升级为红色 danger 提示；
   删除/格式化/`dd` 等破坏性命令单独标注

**标准工作流**（写进了 system prompt）：`remote_servers` 定位机器 → `remote_grep` 搜报错 →
`remote_read_file` 读代码 → 说明方案 → `remote_edit_file` 改 → **验证**（读回复核 / 跑测试 / 重启后看日志）→ 失败则回滚。
最多 10 轮工具调用。

其他：

- SSE 流式输出，工具调用状态与 diff 实时可视化
- @ 提及联动分析历史上下文；支持注入巡检报告自动分析
- 对话历史本地持久化

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
- 8 个内置运维技能（受保护，不可删除）
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

---

## 📝 API 速查

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/monitor/stats` | 系统状态（含 GPU） |
| GET | `/api/remote/servers` | 远程服务器列表 |
| GET | `/api/remote/servers/:id/stats` | 远程系统状态（含 GPU 进程） |
| GET | `/api/remote/servers/:id/mfu` | 远程模型 MFU（读 vLLM `/metrics`） |
| GET | `/api/docker/containers` | 容器列表 |
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

---

## 📄 许可证 | License

MIT License
