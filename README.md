# OpenLog

🤖 AI-Powered Log Analysis & Monitoring Platform | AI 智能日志分析与监控系统

---

## ✨ 特性 | Features

| 中文 | English |
|------|---------|
| 📊 实时仪表盘 — 系统 CPU、内存、磁盘、网络实时监控 | 📊 **Real-time Dashboard** — Live CPU, memory, disk, and network monitoring |
| 📝 日志流监控 — 实时日志流展示，支持过滤和搜索 | 📝 **Log Streaming** — Live log stream with filtering and search |
| 🤖 AI 智能分析 — 使用大模型自动分析日志中的问题 | 🤖 **AI Analysis** — Automatically analyze logs with LLM |
| 🔔 异常告警 — 自动检测并告警 | 🔔 **Alerting** — Automatic anomaly detection and alerts |
| 📈 可视化图表 — 折线图、面积图、热力图 | 📈 **Visualization** — Line charts, area charts, heatmaps |
| ⚙️ 灵活配置 — 支持自定义监控路径和参数 | ⚙️ **Flexible Config** — Customizable monitoring paths and parameters |
| 🏢 **多服务联合会诊** — 同时监控多个服务目录，独立分析队列 | 🏢 **Multi-service Diagnosis** — Monitor multiple services with independent analysis queues |
| 💬 **运维助手** — 内置 LLM 聊天，支持流式对话与技术支持 | 💬 **Ops Assistant** — Built-in LLM chat with streaming for tech support |
| 📜 **分析历史** — 查看所有 AI 分析记录，支持搜索与过滤 | 📜 **Analysis History** — View all AI analysis records with search & filter |
| 🐳 **Docker 容器管理** — 图形化管理 Docker 容器，进入容器执行命令，查看上下游链路 | 🐳 **Docker Container Management** — GUI for Docker containers, exec into containers, trace upstream/downstream |

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
│   │   │   ├── AnalysisHistory.tsx   # 分析历史 / Analysis history ⭐NEW
│   │   │   ├── Assistant.tsx         # 运维助手 / Ops assistant ⭐NEW
│   │   │   ├── Docker.tsx            # Docker 容器管理 ⭐NEW
│   │   │   ├── Monitor.tsx           # 系统监控 / System monitor
│   │   │   ├── Remote.tsx            # 远程服务器 / Remote servers
│   │   │   └── Settings.tsx          # 设置 / Settings
│   │   ├── contexts/        # React Context
│   │   │   └── WebSocketContext.tsx  # WebSocket 管理 / WebSocket management ⭐NEW
│   │   └── types.ts         # TypeScript 类型 / TypeScript types
│   └── package.json
├── server/                  # Node.js 后端 / Node.js backend
│   ├── index.js             # 主服务器文件 / Main server file
│   ├── remote.js            # 远程服务器管理 / Remote server management
│   └── docker.js            # Docker 连接与容器管理 / Docker connection & container management
├── SPEC.md                  # 项目规格说明 / Project specification
└── package.json
```

---

## 🛠️ 技术栈 | Tech Stack

| 中文 | English |
|------|---------|
| **前端**: React + TypeScript + Vite + TailwindCSS + Recharts | **Frontend**: React + TypeScript + Vite + TailwindCSS + Recharts |
| **后端**: Node.js + Express + WebSocket + SSE | **Backend**: Node.js + Express + WebSocket + SSE |
| **实时通信**: WebSocket (日志推送) + SSE (AI 流式输出) | **Real-time**: WebSocket (logs) + SSE (AI streaming) |
| **AI**: OpenAI API (兼容任意 OpenAI 兼容 API，支持本地 Ollama) | **AI**: OpenAI API (compatible with any OpenAI-compatible API, including local Ollama) |
| **监控**: chokidar (文件监控) + systeminformation (系统信息) | **Monitoring**: chokidar (file watch) + systeminformation (system stats) |

---

### 7. Docker 容器管理 | Docker Container Management ⭐NEW

访问 `/docker` 页面：

- **查看容器** — 实时查看 Docker 容器列表，过滤运行中/已停止的容器
- **进入容器** — 点击终端图标，展开内置终端，在容器内执行任意命令（如 `ps aux`、`ls /`、`cat /etc/hosts`）
- **启停操作** — 启动、停止、重启容器，无需打开终端
- **上下游链路** — 自动分析容器间的网络依赖关系，展示上游/下游服务
- **批量分析** — 同时分析多个容器的日志，AI 联合会诊

> **连接方式：** 支持 Unix Socket（macOS Docker Desktop：`/var/run/docker.sock`）和 TCP（远程 Docker Server）



### 1. 配置日志路径 | Configure Log Path

在设置页面配置要监控的日志目录。默认监控 `/var/log` 下的 `.log` 文件。

Configure the log directory to monitor on the Settings page. Default: `.log` files under `/var/log`.

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

### 4. 查看分析历史 | Analysis History ⭐NEW

访问 `/analysis-history` 页面：
- 查看所有自动触发的 AI 分析记录 / View all auto-triggered AI analysis records
- 按服务、状态过滤 / Filter by service and status
- 搜索日志内容或分析结果 / Search log content or analysis results
- 展开查看完整的 AI 诊断报告 / Expand to view full AI diagnosis report

### 5. 运维助手聊天 | Ops Assistant ⭐NEW

访问 `/assistant` 页面：
- 与 LLM 进行实时对话 / Real-time chat with LLM
- 支持流式输出，体验流畅 / Streaming output for smooth experience
- 快速提问：常见运维问题一键发送 / Quick prompts for common ops questions
- 支持 Markdown 格式（代码块、表格等）/ Markdown support (code blocks, tables, etc.)

### 6. 系统监控 | System Monitor

访问 `/monitor` 页面查看：
- CPU 使用率（总览 + 各核心）/ CPU usage (overall + per core)
- 内存使用情况 / Memory usage
- 磁盘使用情况 / Disk usage
- 网络流量 / Network traffic
- Top 进程 / Top processes

---

## ⚠️ 注意事项 | Notes

- 日志监控需要系统目录的读取权限 / Log monitoring requires read permission for system directories
- Mac/Linux: `/var/log` 或 `~/logs` / Mac/Linux: `/var/log` or `~/logs`
- Windows: `C:\Windows\System32\LogFiles` / Windows: `C:\Windows\System32\LogFiles`
- AI 分析需要有效的 OpenAI API Key / AI analysis requires a valid OpenAI API Key

### 多服务配置 | Multi-service Configuration ⭐NEW

在设置页面可以配置多个日志服务：

1. 开启"自动错误分析"总开关 / Enable "Auto Error Analysis" master switch
2. 添加多个服务目录（如 MySQL、Nginx、应用日志等）/ Add multiple service directories
3. 每个服务可独立控制是否启用 AI 分析 / Each service can independently enable/disable AI analysis
4. 各服务有独立的分析队列，互不阻塞 / Each service has independent analysis queue

示例配置 / Example config:
```json
{
  "watchSources": [
    { "id": "app", "name": "应用日志", "path": "/var/log/app", "pattern": "*.log", "enabled": true, "autoAnalysis": true },
    { "id": "mysql", "name": "MySQL", "path": "/var/log/mysql", "pattern": "*.log", "enabled": true, "autoAnalysis": true },
    { "id": "nginx", "name": "Nginx", "path": "/var/log/nginx", "pattern": "*.log", "enabled": true, "autoAnalysis": false }
  ]
}
```

### Docker 配置 | Docker Configuration ⭐NEW

在设置页面添加 Docker 连接：

- **macOS Docker Desktop** — 连接方式选「Socket」，Socket 路径填 `/var/run/docker.sock`
- **Linux 本地** — 同 macOS，或使用 TCP `http://localhost:2375`
- **远程 Docker Server** — 连接方式选「TCP」，填入 host 和端口（2375/2376）

示例配置 / Example config:
```json
{
  "dockerSources": [
    { "id": "local", "name": "本地 Docker", "socketPath": "/var/run/docker.sock", "enabled": true }
  ]
}
```

---

## 📝 API

| 方法 | 端点 | 描述 | Method | Endpoint | Description |
|------|------|------|--------|----------|-------------|
| GET | `/api/logs` | 获取日志列表 | GET | `/api/logs` | Get log list |
| POST | `/api/logs/analyze` | AI 分析日志 | POST | `/api/logs/analyze` | AI analyze logs |
| DELETE | `/api/logs` | 清空日志 | DELETE | `/api/logs` | Clear logs |
| GET | `/api/monitor/stats` | 获取系统统计 | GET | `/api/monitor/stats` | Get system stats |
| GET | `/api/monitor/history` | 获取历史数据 | GET | `/api/monitor/history` | Get history data |
| GET | `/api/analysis/history` | 获取分析历史 ⭐NEW | GET | `/api/analysis/history` | Get AI analysis history |
| DELETE | `/api/analysis/history/:id` | 删除分析记录 ⭐NEW | DELETE | `/api/analysis/history/:id` | Delete analysis record |
| POST | `/api/analysis/trigger` | 手动触发分析 ⭐NEW | POST | `/api/analysis/trigger` | Trigger manual analysis |
| POST | `/api/chat` | LLM 聊天（SSE 流式）⭐NEW | POST | `/api/chat` | LLM chat (SSE streaming) |
| GET | `/api/settings` | 获取设置 | GET | `/api/settings` | Get settings |
| PUT | `/api/settings` | 更新设置 | PUT | `/api/settings` | Update settings |
| GET | `/api/docker/containers` | 获取容器列表 | GET | `/api/docker/containers` | List containers |
| POST | `/api/docker/:sourceId/:containerId/exec` | 在容器内执行命令 | POST | `/api/docker/:sourceId/:containerId/exec` | Exec command in container |
| POST | `/api/docker/:sourceId/:containerId/start` | 启动容器 | POST | `/api/docker/:sourceId/:containerId/start` | Start container |
| POST | `/api/docker/:sourceId/:containerId/stop` | 停止容器 | POST | `/api/docker/:sourceId/:containerId/stop` | Stop container |
| POST | `/api/docker/:sourceId/:containerId/restart` | 重启容器 | POST | `/api/docker/:sourceId/:containerId/restart` | Restart container |
| GET | `/api/docker/trace/:sourceId/:containerId` | 上下游链路追踪 | GET | `/api/docker/trace/:sourceId/:containerId` | Trace upstream/downstream |

---

## 📄 许可证 | License

MIT License
