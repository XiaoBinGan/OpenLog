#!/bin/bash
# ─── OpenLog 开发启动脚本 ──────────────────────────────────────────────
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "🚀 OpenLog 开发环境启动"
echo "=========================="

# 1. 检查 Node 版本
REQUIRED_NODE=20
CURRENT_NODE=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ "$CURRENT_NODE" != "$REQUIRED_NODE" ]; then
  if command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
    echo "⚡ 切换到 Node v$REQUIRED_NODE..."
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm use "$REQUIRED_NODE" 2>/dev/null || nvm use 2>/dev/null || true
  else
    echo "⚠️  建议使用 Node v$REQUIRED_NODE（当前: v$CURRENT_NODE）"
  fi
fi

# 2. 安装/重建依赖
echo "📦 检查依赖..."
if [ ! -d "node_modules" ]; then
  npm install
else
  npm rebuild better-sqlite3 2>/dev/null || true
fi

# 3. 启动服务（数据库由 server/index.js 自动初始化）

# 4. 启动服务
echo ""
echo "🔧 启动后端: http://localhost:3001"
echo "🎨 启动前端: http://localhost:5173"
echo ""

# 后台启动 server
node server/index.js &
SERVER_PID=$!

# 启动 client
cd client && npm run dev -- --port 5173 --host &
CLIENT_PID=$!

# 等待
trap "kill $SERVER_PID $CLIENT_PID 2>/dev/null; exit" INT TERM
wait
