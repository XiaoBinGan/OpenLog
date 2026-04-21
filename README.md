# OpenLog - Go Backend

一个高性能的日志监控与分析平台，Go 语言后端 + React 前端。

## 项目结构

```
.
├── client/          # React 前端 (Vite + TypeScript + Tailwind)
└── server_go/       # Go 后 端
```

## 快速开始

### 后端

```bash
cd server_go

# 构建
go build -o openlog_go .

# 运行（默认端口 3002）
./openlog_go
```

### 前端

```bash
cd client

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build
```

## 特性

- 🚀 高性能 HTTP API + WebSocket
- 📊 系统监控（CPU/内存/磁盘/网络/GPU）
- 🔌 远程服务器 SSH 管理
- 📁 远程文件浏览/编辑/上传
- 🐚 远程 Shell (PTY over WebSocket)
- 🐳 Docker 容器管理
- 🤖 AI 日志分析（Ollama 集成）
- 📝 日志文件实时监听
- 💾 SQLite 持久化

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /api/health` | 健康检查 |
| `GET /api/monitor/stats` | 系统状态 |
| `GET /api/monitor/history` | 历史数据 |
| `GET/PUT /api/settings` | 配置管理 |
| `GET/POST/DELETE /api/servers` | 远程服务器管理 |
| `GET /api/servers/:id/stats` | 远程服务器状态 |
| `POST /api/servers/:id/upload` | 文件上传 |
| `GET /api/docker/containers` | Docker 容器列表 |
| `POST /api/ai/chat` | AI 对话 |
| `POST /api/ai/chat/stream` | AI 流式对话 |

## WebSocket

```
ws://localhost:3002/ws?type=main      # 主通道（日志、监控广播）
ws://localhost:3002/ws?type=shell     # Shell PTY 交互
```

## 配置

配置文件 `settings.json`（首次运行自动创建）：

```json
{
  "port": 3002,
  "aiEndpoint": "http://localhost:11434/v1",
  "aiModel": "qwen2.5:7b"
}
```

## 技术栈

### 后端
- Go 1.23.6
- gorilla/websocket
- shirou/gopsutil/v3
- mattn/go-sqlite3
- golang.org/x/crypto/ssh

### 前端
- React 18
- TypeScript
- Vite
- Tailwind CSS

## 许可证

MIT
