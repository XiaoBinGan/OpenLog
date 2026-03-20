# Give Me The Log (Open Log)

🤖 AI-Powered Log Analysis & Monitoring Platform

一个使用大模型智能分析日志、监控系统运行状态的 Web 应用。类似 Grafana 但更智能，能自动识别日志中的异常并提供修复建议。

![Dashboard](https://via.placeholder.com/800x400?text=Dashboard)

## ✨ 特性

- 📊 **实时仪表盘** - 系统 CPU、内存、磁盘、网络实时监控
- 📝 **日志流监控** - 实时日志流展示，支持过滤和搜索
- 🤖 **AI 智能分析** - 使用大模型自动分析日志中的问题
- 🔔 **异常告警** - 自动检测并告警
- 📈 **可视化图表** - 折线图、面积图、热力图
- ⚙️ **灵活配置** - 支持自定义监控路径和参数

## 🚀 快速开始

### 前置要求

- Node.js 18+
- npm 或 yarn
- OpenAI API Key（用于 AI 分析功能）

### 安装

```bash
# 克隆项目
git clone https://github.com/yourusername/give-me-the-log.git
cd give-me-the-log

# 安装依赖
npm install

# 安装前端依赖
cd client && npm install && cd ..
```

### 配置

```bash
# 复制环境变量文件
cp .env.example .env

# 编辑 .env 文件，填入你的 API Key
OPENAI_API_KEY=sk-your-api-key-here
```

### 运行

```bash
# 启动开发服务器（前端 + 后端）
npm run dev
```

访问 http://localhost:5173

### 生产构建

```bash
# 构建前端
npm run build

# 启动生产服务器
npm start
```

## 📁 项目结构

```
give-me-the-log/
├── client/                 # React 前端
│   ├── src/
│   │   ├── components/     # React 组件
│   │   ├── pages/          # 页面组件
│   │   ├── types.ts        # TypeScript 类型
│   │   └── ...
│   ├── public/
│   └── package.json
├── server/                 # Node.js 后端
│   └── index.js           # 主服务器文件
├── SPEC.md                # 项目规格说明
└── package.json
```

## 🛠️ 技术栈

- **前端**: React + TypeScript + Vite + TailwindCSS + Recharts
- **后端**: Node.js + Express + SQLite (better-sqlite3)
- **实时通信**: WebSocket
- **AI**: OpenAI API (兼容任意 OpenAI 兼容 API)

## 📖 使用指南

### 1. 配置日志路径

在设置页面配置要监控的日志目录。默认监控 `/var/log` 下的 `.log` 文件。

### 2. 查看实时日志

访问 `/logs` 页面，可以：
- 实时查看日志流
- 按级别过滤（ERROR, WARN, INFO, DEBUG）
- 按来源过滤
- 搜索日志内容

### 3. 使用 AI 分析

访问 `/analytics` 页面：
1. 选择要分析的日志范围
2. 点击"开始 AI 分析"
3. AI 会自动分析日志并提供：
   - 问题摘要
   - 发现的问题
   - 修复建议

### 4. 系统监控

访问 `/monitor` 页面查看：
- CPU 使用率（总览 + 各核心）
- 内存使用情况
- 磁盘使用情况
- 网络流量
- Top 进程

## ⚠️ 注意事项

- 日志监控需要系统目录的读取权限
- Mac/Linux 用户可使用 `/var/log` 或 `~/logs`
- Windows 用户可使用 `C:\Windows\System32\LogFiles`
- AI 分析功能需要有效的 OpenAI API Key

## 📝 API

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/logs` | 获取日志列表 |
| POST | `/api/logs/analyze` | AI 分析日志 |
| DELETE | `/api/logs` | 清空日志 |
| GET | `/api/monitor/stats` | 获取系统统计 |
| GET | `/api/monitor/history` | 获取历史数据 |
| GET | `/api/settings` | 获取设置 |
| PUT | `/api/settings` | 更新设置 |

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
