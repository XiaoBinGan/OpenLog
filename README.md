# OpenLog

🤖 AI-Powered Log Analysis & Monitoring Platform | AI 智能日志分析与监控系统

---

## ✨ 特性 | Features

| 特性 | Feature |
|------|---------|
| 📊 实时仪表盘 | Real-time Dashboard |
| 🎮 多服务算力监控 | Multi-server GPU Monitoring |
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

> 🔐 `OPENLOG_SECRET_KEY` 决定数据库里 SSH 密码 / 模型 Key 的加密密钥。
> 从「未设置」切到「已设置」会触发一次性数据迁移（单向），设置后不要再取消，
> 否则此前已重新加密的凭据将无法解读。

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
| 算力监控 | `/gpu` | 所有服务器 GPU 总览（利用率/显存/温度/进程） |
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

### 🤖 运维助手

- 多轮对话 + 工具调用（docker_list/logs、remote_system_stats 等）
- SSE 流式输出，工具调用状态可视化
- @ 提及联动分析历史上下文
- 支持注入巡检报告自动分析

### 🧠 AI Shell

- 自然语言 → Shell 命令 → 远程执行
- 双模式：命令生成 + 文本问答（ANSWER:）
- 多轮对话历史上下文
- 技能多选联用

### 🔧 技能管理

- 标准 Markdown 格式（Purpose / Workflow / Constraints / Output）
- 8 个内置运维技能（受保护，不可删除）
- JSON 导入/导出
- 一键在运维助手/AI Shell 中使用

### 🎮 算力监控

- 自动拉取所有已连接服务器的 GPU 状态
- 每卡展示：算力利用率、显存、温度、进程（PID + 名称 + 显存）
- 30 秒自动刷新
- 与远程服务器页面联动，无需重复输入 host/user

### 🔔 告警规则

- 每台机器独立配置：关键词、级别过滤、冷却时间、Webhook URL
- 容器巡检自动触发 Webhook 通知
- 冷却去重避免重复告警

### 🐳 Docker 实时日志

- WebSocket 流式 tail，暗色终端风格
- 暂停/继续/清空/自动滚动
- 按日志级别着色

---

## 📝 API 速查

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/monitor/stats` | 系统状态（含 GPU） |
| GET | `/api/remote/servers` | 远程服务器列表 |
| GET | `/api/remote/servers/:id/stats` | 远程系统状态（含 GPU 进程） |
| GET | `/api/docker/containers` | 容器列表 |
| GET | `/api/docker/containers/:sid/:cid/logs` | 容器日志 |
| WS | `/ws/docker/logs/:sid/:cid` | 容器实时日志流 |
| WS | `/ws/aishell/:serverId` | AI Shell 终端 |
| GET | `/api/skills` | 技能列表 |
| POST | `/api/skills` | 创建技能 |
| GET | `/api/alerts` | 告警配置 |
| PUT | `/api/alerts` | 保存告警配置 |
| GET | `/api/gpu/remote-server/:id` | 远程 GPU（复用 SSH） |
| POST | `/api/chat` | 运维助手对话（SSE 流式） |

---

## 📄 许可证 | License

MIT License
