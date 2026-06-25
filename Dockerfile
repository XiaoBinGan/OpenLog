# ─── OpenLog Dockerfile ────────────────────────────────────────────────
# 多阶段构建：先编译前端，再运行后端

# ── Stage 1: 构建前端 ──
FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── Stage 2: 生产镜像 ──
FROM node:20-alpine

WORKDIR /app

# 安装系统依赖（better-sqlite3 需要编译工具）
RUN apk add --no-cache python3 make g++

# 复制后端依赖
COPY package*.json ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3

# 复制后端源码
COPY server/ ./server/
COPY scripts/ ./scripts/

# 复制前端构建产物
COPY --from=client-builder /app/client/dist ./client/dist

# 初始化数据库
RUN npm run init-db

# 数据持久化目录
VOLUME ["/app/data", "/app/logs"]

EXPOSE 3001
ENV NODE_ENV=production

CMD ["node", "server/index.js"]
