# ─── OpenLog Dockerfile ────────────────────────────────────────────────
# 多阶段构建：先编译前端，再运行后端

# ── Stage 1: 构建前端 ──
# Node 20 已 EOL，统一到 22（与 CI / .nvmrc 一致）
FROM node:22-alpine AS client-builder
# 这个 ARG 必须声明在**本阶段内**：Docker 的 ARG 作用域不跨阶段，
# 写在第二阶段的 ARG 对这里不可见。
# 为什么前端阶段也需要它：没有它时 `RUN npm run build` 的缓存键只由 client/
# 内容决定 —— 看起来合理，实际踩过：243 上连续部署两次，第二次的前端产物
# 仍是上一版（bundle index-D_DQ4OgQ），而干净重建是 index-EGEQfdxr。
# 三个独立构建（本地 / T4 / 243 --no-cache）都得到后者，只有吃缓存的那次不同。
# 部署出去的产物和源码对不上，是最难查的一类问题。
ARG CACHE_BUST=1
WORKDIR /app/client
COPY client/package*.json ./
RUN echo "Cache bust: ${CACHE_BUST}" && npm install --legacy-peer-deps
COPY client/ ./
# 用 npm run build 而不是 npx vite build，让 tsc -b 的类型错误能中断镜像构建
RUN echo "Cache bust: ${CACHE_BUST}" && npm run build

# ── Stage 2: 生产镜像 ──
FROM node:22-alpine

ARG CACHE_BUST=1

WORKDIR /app

# 安装系统依赖（better-sqlite3 需要编译工具）
RUN echo "Cache bust: ${CACHE_BUST}" && apk add --no-cache python3 make g++ openssh sshpass

# 复制后端依赖
COPY package*.json ./
# postinstall（ensure-sqlite-binding.js）在 npm install 阶段就会执行，
# 必须先把它复制进来，否则构建直接 MODULE_NOT_FOUND（旧镜像构建时还没有这个脚本）
COPY scripts/ensure-sqlite-binding.js ./scripts/
RUN echo "Cache bust: ${CACHE_BUST}" && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund && npm rebuild better-sqlite3

# 复制后端源码
COPY server/ ./server/
COPY scripts/ ./scripts/

# 复制前端构建产物
COPY --from=client-builder /app/client/dist ./client/dist

# 清理缓存
RUN rm -rf /root/.npm

# 数据持久化目录
VOLUME ["/app/data", "/app/logs"]

# 端口必须与 server/index.js 的 PORT 默认值一致，否则容器内无人监听、端口映射打空
EXPOSE 3011
ENV NODE_ENV=production
# 容器内必须绑 0.0.0.0：server 默认只绑 127.0.0.1，会导宿主机端口映射不可达
ENV PORT=3011
ENV HOST=0.0.0.0

# 数据库在容器启动时由 server/index.js 自动初始化
CMD ["node", "server/index.js"]
