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
│   │   ├── pages/           # 页面组件 / Page components
│   │   └── types.ts         # TypeScript 类型 / TypeScript types
│   └── package.json
├── server/                  # Node.js 后端 / Node.js backend
│   └── index.js             # 主服务器文件 / Main server file
├── SPEC.md                  # 项目规格说明 / Project specification
└── package.json
```

---

## 🛠️ 技术栈 | Tech Stack

| 中文 | English |
|------|---------|
| **前端**: React + TypeScript + Vite + TailwindCSS + Recharts | **Frontend**: React + TypeScript + Vite + TailwindCSS + Recharts |
| **后端**: Node.js + Express + SQLite | **Backend**: Node.js + Express + SQLite |
| **实时通信**: WebSocket | **Real-time**: WebSocket |
| **AI**: OpenAI API (兼容任意 OpenAI 兼容 API) | **AI**: OpenAI API (compatible with any OpenAI-compatible API) |

---

## 📖 使用指南 | User Guide

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

### 4. 系统监控 | System Monitor

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

---

## 📝 API

| 方法 | 端点 | 描述 | Method | Endpoint | Description |
|------|------|------|--------|----------|-------------|
| GET | `/api/logs` | 获取日志列表 | GET | `/api/logs` | Get log list |
| POST | `/api/logs/analyze` | AI 分析日志 | POST | `/api/logs/analyze` | AI analyze logs |
| DELETE | `/api/logs` | 清空日志 | DELETE | `/api/logs` | Clear logs |
| GET | `/api/monitor/stats` | 获取系统统计 | GET | `/api/monitor/stats` | Get system stats |
| GET | `/api/monitor/history` | 获取历史数据 | GET | `/api/monitor/history` | Get history data |
| GET | `/api/settings` | 获取设置 | GET | `/api/settings` | Get settings |
| PUT | `/api/settings` | 更新设置 | PUT | `/api/settings` | Update settings |

---

## 📄 许可证 | License

MIT License
