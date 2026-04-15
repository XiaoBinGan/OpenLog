# OpenLog

🤖 AI-Powered Log Analysis & Monitoring Platform | AI 智能日志分析与监控系统

---

## ✨ 特性 | Features

| 中文 | English |
|------|---------|
| 📊 实时仪表盘 — 系统 CPU、内存、磁盘、网络实时监控 | 📊 **Real-time Dashboard** — Live CPU, memory, disk, and network monitoring |
| 🎮 **GPU 监控** — NVIDIA GPU 利用率、显存、温度实时监控 | 🎮 **GPU Monitoring** — NVIDIA GPU utilization, memory, temperature live monitoring |
| 📝 日志流监控 — 实时日志流展示，支持过滤和搜索 | 📝 **Log Streaming** — Live log stream with filtering and search |
| 🤖 AI 智能分析 — 使用大模型自动分析日志中的问题 | 🤖 **AI Analysis** — Automatically analyze logs with LLM |
| 🔔 异常告警 — 自动检测并告警 | 🔔 **Alerting** — Automatic anomaly detection and alerts |
| 📈 可视化图表 — 折线图、面积图、热力图 | 📈 **Visualization** — Line charts, area charts, heatmaps |
| ⚙️ 灵活配置 — 支持自定义监控路径和参数 | ⚙️ **Flexible Config** — Customizable monitoring paths and parameters |
| 🏢 **多服务联合会诊** — 同时监控多个服务目录，独立分析队列 | 🏢 **Multi-service Diagnosis** — Monitor multiple services with independent analysis queues |
| 💬 **运维助手** — 内置 LLM 聊天，支持流式对话与技术支持 | 💬 **Ops Assistant** — Built-in LLM chat with streaming for tech support |
| 📜 **分析历史** — 查看所有 AI 分析记录，支持搜索与过滤 | 📜 **Analysis History** — View all AI analysis records with search & filter |
| 🐳 **Docker 容器管理** — 图形化管理 Docker 容器，进入容器执行命令，查看上下游链路 | 🐳 **Docker Container Management** — GUI for Docker containers, exec into containers, trace upstream/downstream |
| 🖥️ **远程服务器管理** — SSH 连接多台远程服务器，浏览器内终端、文件浏览与编辑 | 🖥️ **Remote Server Management** — SSH connect to remote servers, browser terminal, file browse & edit |
| 🧠 **思考过程开关** — 可显示/隐藏推理模型的思维输出过程 | 🧠 **Thinking Toggle** — Show/hide reasoning model thought process output |

---

## 🚀 快速开始 | Quick Start

### 前置要求 | Prerequisites

- Node.js 18+
- npm 或 yarn / npm or yarn
- OpenAI API Key（用于 AI 分析功能）/ OpenAI API Key (for AI analysis)

### 安装 | Installation

```bash
# 克隆项目 / Clone the project
git clone https://github.com/XiaoBinGan/OpenLog.git
cd OpenLog

# 安装依赖 / Install dependencies
npm install

# 安装前端依赖 / Install client dependencies
cd client && npm install && cd ..
```

### 配置 | Configuration

```bash
# 复制环境变量文件 / Copy env file
cp .env.example .env

# 编辑 .env，填入你的 API Key / Fill in your API Key in .env
OPENAI_API_KEY=sk-your-api-key-here
```

### 运行 | Running

```bash
# 启动开发服务器（前端 + 后端）/ Start dev server
npm run dev
```

访问 | Visit http://localhost:5173

---

## 📁 项目结构 | Project Structure

```
openlog/
├── client/                  # React 前端 / React frontend
│   ├── src/
│   │   ├── components/      # React 组件 / React components
│   │   │   ├── AIAnalysisToast.tsx   # AI 分析实时通知 / Real-time AI analysis notifications
│   │   │   └── ...
│   │   ├── pages/           # 页面组件 / Page components
│   │   │   ├── Dashboard.tsx         # 仪表盘 / Dashboard
│   │   │   ├── Logs.tsx              # 日志流 / Log streaming
│   │   │   ├── Analytics.tsx         # AI 分析 / AI analysis
│   │   │   ├── AnalysisHistory.tsx   # 分析历史 / Analysis history
│   │   │   ├── Assistant.tsx         # 运维助手 / Ops assistant
│   │   │   ├── Docker.tsx            # Docker 容器管理 / Docker container management
│   │   │   ├── Monitor.tsx           # 系统监控（含 GPU）/ System monitor
│   │   │   ├── Remote.tsx            # 远程服务器 / Remote servers
│   │   │   └── Settings.tsx          # 设置 / Settings
│   │   ├── contexts/        # React Context
│   │   │   ├── WebSocketContext.tsx  # WebSocket 管理 / WebSocket management
│   │   │   └── RemoteContext.tsx     # 远程服务器状态管理 / Remote server state management
│   │   └── types.ts         # TypeScript 类型 / TypeScript types
│   └── package.json
├── server/                  # Node.js 后端 / Node.js backend
│   ├── index.js             # 主服务器文件 / Main server file
│   ├── remote.js            # 远程服务器管理 / Remote server management
│   ├── docker.js            # Docker 连接与容器管理 / Docker connection & container management
│   └── db/                  # SQLite 数据库层 / SQLite database layer
│       └── index.js         # 数据库初始化、kv_store、日志/分析/告警表
├── data/                    # SQLite 数据库文件 / SQLite database file (gitignored)
│   └── openlog.db
├── SPEC.md                  # 项目规格说明 / Project specification
└── package.json
```

---

## 🛠️ 技术栈 | Tech Stack

| 中文 | English |
|------|---------|
| **前端**: React + TypeScript + Vite + TailwindCSS + Recharts | **Frontend**: React + TypeScript + Vite + TailwindCSS + Recharts |
| **后端**: Node.js + Express + WebSocket + SSE | **Backend**: Node.js + Express + WebSocket + SSE |
| **数据库**: SQLite（本地）+ MySQL/PostgreSQL（远程）| **Database**: SQLite (local) + MySQL/PostgreSQL (remote) |
| **实时通信**: WebSocket (日志推送) + SSE (AI 流式输出) | **Real-time**: WebSocket (logs) + SSE (AI streaming) |
| **AI**: OpenAI API (兼容任意 OpenAI 兼容 API，支持本地 Ollama) | **AI**: OpenAI API (compatible with any OpenAI-compatible API, including local Ollama) |
| **监控**: chokidar (文件监控) + systeminformation (系统信息) + nvidia-smi (GPU) | **Monitoring**: chokidar (file watch) + systeminformation (system stats) + nvidia-smi (GPU) |

---

## 📖 使用指南 | Usage Guide

### 1. 配置日志路径 | Configure Log Path

在设置页面配置要监控的日志目录。默认监控 `~/logs` 下的 `.log` 文件。

Configure the log directory to monitor on the Settings page. Default: `.log` files under `~/logs`.

### 2. 查看实时日志 | View Live Logs

访问 `/logs` 页面：
- 实时查看日志流 / View live log stream
- 按级别过滤（ERROR, WARN, INFO, DEBUG）/ Filter by level
- 搜索日志内容 / Search log content

### 3. 使用 AI 分析 | AI Analysis

访问 `/analytics` 页面：
1. 选择要分析的日志范围 / Select log range to analyze
2. 点击"开始 AI 分析" / Click "Start AI Analysis"
3. AI 自动分析并提供问题摘要和修复建议 / AI analyzes and provides summary + fix suggestions

### 4. 查看分析历史 | Analysis History

访问 `/analysis-history` 页面：
- 查看所有自动触发的 AI 分析记录 / View all auto-triggered AI analysis records
- 按服务、状态过滤 / Filter by service and status
- 搜索日志内容或分析结果 / Search log content or analysis results
- 展开查看完整的 AI 诊断报告 / Expand to view full AI diagnosis report

### 5. 运维助手聊天 | Ops Assistant

访问 `/assistant` 页面：
- 与 LLM 进行实时对话 / Real-time chat with LLM
- 支持流式输出，体验流畅 / Streaming output for smooth experience
- 快速提问：常见运维问题一键发送 / Quick prompts for common ops questions
- 支持 Markdown 格式（代码块、表格等）/ Markdown support (code blocks, tables, etc.)
- **思考过程开关**：可切换推理模型的思维输出显示 / **Thinking Toggle**: show/hide reasoning model thought process

### 6. 系统监控 | System Monitor

访问 `/monitor` 页面查看：
- CPU 使用率（总览 + 各核心）/ CPU usage (overall + per core)
- 内存使用情况 / Memory usage
- 磁盘使用情况 / Disk usage
- 网络流量 / Network traffic
- **GPU 监控** — NVIDIA GPU 利用率、显存占用、温度（自动检测 nvidia-smi）/ **GPU Monitoring** — NVIDIA GPU utilization, memory, temperature
- Top 进程 / Top processes

### 7. Docker 容器管理 | Docker Container Management

访问 `/docker` 页面：

- **查看容器** — 实时查看 Docker 容器列表，过滤运行中/已停止的容器
- **进入容器** — 点击终端图标，展开内置终端，在容器内执行任意命令（如 `ps aux`、`ls /`、`cat /etc/hosts`）
- **启停操作** — 启动、停止、重启容器，无需打开终端
- **上下游链路** — 自动分析容器间的网络依赖关系，展示上游/下游服务
- **批量分析** — 同时分析多个容器的日志，AI 联合会诊

> **连接方式：** 支持 Unix Socket（macOS Docker Desktop：`/var/run/docker.sock`）和 TCP（远程 Docker Server）

### 8. 远程服务器管理 | Remote Server Management

访问 `/remote` 页面：

- **添加服务器** — 支持密码和私钥认证，持久化到 SQLite
- **一键连接** — 点击连接按钮发起 SSH，自动拉取系统状态与日志目录
- **切换服务器** — 点击任意服务器卡片，右侧面板立即切换到该服务器状态
- **文件浏览** — 树形目录展示，支持打开文件查看内容
- **在线编辑** — 支持修改远程服务器上的文件（需确认）
- **内置终端** — 点击 Shell 按钮展开终端面板，执行任意命令
- **实时日志** — 点击日志图标，实时查看服务器日志文件流
- **多服务器并发** — 支持同时连接多台服务器，独立操作互不干扰
- **GPU 监控** — 远程服务器 GPU 数据（利用率、显存、温度）实时展示

> **认证方式：** 支持密码（Password）和私钥（Private Key）两种认证方式

---

### 多服务配置 | Multi-service Configuration

在设置页面可以配置多个日志服务：

1. 开启"自动错误分析"总开关 / Enable "Auto Error Analysis" master switch
2. 添加多个服务目录（如 MySQL、Nginx、应用日志等）/ Add multiple service directories
3. 每个服务可独立控制是否启用 AI 分析 / Each service can independently enable/disable AI analysis
4. 各服务有独立的分析队列，互不阻塞 / Each service has independent analysis queue

### Docker 配置 | Docker Configuration

在设置页面添加 Docker 连接：

- **macOS Docker Desktop** — 连接方式选「Socket」，Socket 路径填 `/var/run/docker.sock`
- **Linux 本地** — 同 macOS，或使用 TCP `http://localhost:2375`
- **远程 Docker Server** — 连接方式选「TCP」，填入 host 和端口（2375/2376）

---

## 💾 数据持久化 | Data Persistence

从 v0.12.0 起，所有配置数据统一存储在 SQLite 数据库中：

| 数据 | 存储位置 |
|------|----------|
| 全局设置（模型、日志路径等） | `data/openlog.db` → `kv_store` 表 |
| 远程服务器配置 | `data/openlog.db` → `kv_store` 表 |
| 日志记录（规划中） | `data/openlog.db` → `log_records` 表 |
| AI 分析结果（规划中） | `data/openlog.db` → `analysis_records` 表 |
| 告警配置（规划中） | `data/openlog.db` → `alert_configs` 表 |
| 机器信息（规划中） | `data/openlog.db` → `machines` 表 |

> 数据库文件 `data/openlog.db` 已加入 `.gitignore`，不会提交到版本库

---

## 📝 API

| 方法 | 端点 | 描述 | Method | Endpoint | Description |
|------|------|------|--------|----------|-------------|
| GET | `/api/logs` | 获取日志列表 | GET | `/api/logs` | Get log list |
| POST | `/api/logs/analyze` | AI 分析日志 | POST | `/api/logs/analyze` | AI analyze logs |
| DELETE | `/api/logs` | 清空日志 | DELETE | `/api/logs` | Clear logs |
| GET | `/api/monitor/stats` | 获取系统统计（含 GPU）| GET | `/api/monitor/stats` | Get system stats (incl. GPU) |
| GET | `/api/monitor/history` | 获取历史数据 | GET | `/api/monitor/history` | Get history data |
| GET | `/api/analysis/history` | 获取分析历史 | GET | `/api/analysis/history` | Get AI analysis history |
| DELETE | `/api/analysis/history/:id` | 删除分析记录 | DELETE | `/api/analysis/history/:id` | Delete analysis record |
| POST | `/api/analysis/trigger` | 手动触发分析 | POST | `/api/analysis/trigger` | Trigger manual analysis |
| POST | `/api/chat` | LLM 聊天（SSE 流式）| POST | `/api/chat` | LLM chat (SSE streaming) |
| GET | `/api/settings` | 获取设置 | GET | `/api/settings` | Get settings |
| PUT | `/api/settings` | 更新设置 | PUT | `/api/settings` | Update settings |
| GET | `/api/docker/containers` | 获取容器列表 | GET | `/api/docker/containers` | List containers |
| POST | `/api/docker/:sourceId/:containerId/exec` | 在容器内执行命令 | POST | `/api/docker/:sourceId/:containerId/exec` | Exec command in container |
| POST | `/api/docker/:sourceId/:containerId/start` | 启动容器 | POST | `/api/docker/:sourceId/:containerId/start` | Start container |
| POST | `/api/docker/:sourceId/:containerId/stop` | 停止容器 | POST | `/api/docker/:sourceId/:containerId/stop` | Stop container |
| POST | `/api/docker/:sourceId/:containerId/restart` | 重启容器 | POST | `/api/docker/:sourceId/:containerId/restart` | Restart container |
| GET | `/api/docker/trace/:sourceId/:containerId` | 上下游链路追踪 | GET | `/api/docker/trace/:sourceId/:containerId` | Trace upstream/downstream |
| GET | `/api/remote/servers` | 获取服务器列表 | GET | `/api/remote/servers` | Get remote servers list |
| POST | `/api/remote/servers` | 添加服务器 | POST | `/api/remote/servers` | Add remote server |
| PUT | `/api/remote/servers/:id` | 更新服务器配置 | PUT | `/api/remote/servers/:id` | Update server config |
| DELETE | `/api/remote/servers/:id` | 删除服务器 | DELETE | `/api/remote/servers/:id` | Delete server |
| POST | `/api/remote/servers/:id/connect` | 连接服务器 | POST | `/api/remote/servers/:id/connect` | Connect to server |
| POST | `/api/remote/servers/:id/disconnect` | 断开连接 | POST | `/api/remote/servers/:id/disconnect` | Disconnect server |
| GET | `/api/remote/servers/:id/stats` | 获取系统状态（含 GPU）| GET | `/api/remote/servers/:id/stats` | Get server stats (incl. GPU) |
| GET | `/api/remote/servers/:id/files` | 获取文件列表 | GET | `/api/remote/servers/:id/files` | List files |
| GET | `/api/remote/servers/:id/file/read` | 读取文件内容 | GET | `/api/remote/servers/:id/file/read` | Read file content |
| POST | `/api/remote/servers/:id/file/write` | 写入文件 | POST | `/api/remote/servers/:id/file/write` | Write file |
| POST | `/api/remote/servers/:id/shell` | 执行 Shell 命令 | POST | `/api/remote/servers/:id/shell` | Execute shell command |
| GET | `/api/remote/servers/:id/logs` | 实时日志流 | GET | `/api/remote/servers/:id/logs` | Live log stream |

---

## ⚠️ 注意事项 | Notes

- 日志监控需要系统目录的读取权限 / Log monitoring requires read permission for system directories
- Mac/Linux: `~/logs` / Mac/Linux: `~/logs`
- Windows: `C:\Users\<user>\logs` / Windows: `C:\Users\<user>\logs`
- AI 分析需要有效的 OpenAI API Key / AI analysis requires a valid OpenAI API Key
- GPU 监控需要服务器安装 nvidia-smi / GPU monitoring requires nvidia-smi installed on the server

---

## 📄 许可证 | License

MIT License
