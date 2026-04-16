# OpenLog

🤖 AI-Powered Log Analysis & Monitoring Platform | AI 智能日志分析与监控系统

---

## 🐍 Python Backend (`python-server/`)

> 等效于 Node.js 版 server/index.js + remote.js + docker.js + db/index.js，使用 Python 实现。

### 技术栈

| 功能 | 技术 |
|------|------|
| Web 框架 | FastAPI + uvicorn ASGI |
| 实时通信 | python-socketio |
| SSH 连接 | asyncssh |
| 数据库 | aiosqlite（异步 SQLite） |
| 系统监控 | psutil |
| AI 分析 | openai SDK |
| Docker 管理 | docker Python SDK |

### 快速启动

```bash
cd server_python

# 创建虚拟环境
uv venv

# 安装依赖
uv pip install -r requirements.txt

# 启动服务
./run.sh
# 或
uvicorn server:app --host 0.0.0.0 --port 3001 --reload
```

### API

- REST API: `http://localhost:3001`
- WebSocket: `http://localhost:3001/socket.io/`
- SSE 流: `http://localhost:3001/api/logs/stream`

### 功能

- 本地日志文件监听（polling，跨平台兼容）
- 远程服务器 SSH 连接与监控
- 多磁盘采集、GPU 监控（nvidia-smi）
- AI 自动分析（流式输出，思考过程过滤）
- SQLite 持久化（settings、servers、monitor_history、kv_store）
- Docker 容器状态监控

### 环境变量（.env）

```bash
PORT=3001
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
MONITOR_INTERVAL=10
LOG_DIR=/Users/supre/logs
AI_MODEL=gpt-4o
AI_TEMPERATURE=0.7
```

---

## 📂 目录结构

```
.
├── server_python/          # Python 后端
│   ├── server.py           # 主服务（FastAPI + Socket.IO）
│   ├── requirements.txt    # 依赖
│   └── run.sh              # 启动脚本
├── data/                   # SQLite 数据库（运行时生成）
├── .env.example            # 环境变量示例
├── SPEC.md                 # 功能规格
└── SHELL_FEATURE.md       # Shell 功能说明
```

---

## 📱 前端

前端位于 `main` 分支的 `client/` 目录，配套本 Python 后端使用。

连接地址：`http://localhost:3001`

---

## 🔧 开发

```bash
# 语法检查
python3 -c "import ast; ast.parse(open('server_python/server.py').read())"

# 数据库初始化（启动时自动完成）
python3 -c "import sqlite3; sqlite3.connect('data/openlog.db').close()"

# 远程 SSH 测试
ssh user@hostname "echo ok"
```

---

## 🌳 分支说明

| 分支 | 说明 |
|------|------|
| `main` | Node.js 后端 + 前端（完整版） |
| `python-server` | Python 后端独立分支 |
| `node` | Node.js 后端独立分支（v0.12.0） |
