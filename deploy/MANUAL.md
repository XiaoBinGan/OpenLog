# 📖 OpenLog 部署手册

面向「这台机器要跑 OpenLog」的完整操作手册。按顺序看即可；日常更新直接跳到
[第 4 节](#4-日常更新一键部署)。

- [1. 架构与前置条件](#1-架构与前置条件)
- [2. 目录与配置文件](#2-目录与配置文件)
- [3. 首次部署](#3-首次部署)
- [4. 日常更新（一键部署）](#4-日常更新一键部署)
- [5. 镜像归档与离线部署](#5-镜像归档与离线部署)
- [6. 数据备份与恢复](#6-数据备份与恢复)
- [7. 回滚](#7-回滚)
- [8. 排障](#8-排障)
- [9. 配置项全表](#9-配置项全表)
- [10. 上线检查清单](#10-上线检查清单)

---

## 1. 架构与前置条件

单机部署由两个容器组成：

```
┌──────────────────────────────────────────────┐
│ 宿主机                                        │
│                                              │
│  openlog        （应用，host 网络，:3001）      │
│    ├── /app/data   ← 宿主机 ./data（令牌/SQLite）│
│    ├── /app/logs   ← docker volume            │
│    └── 连 PostgreSQL →                        │
│                                              │
│  openlog-pg     （postgres:16-alpine，        │
│                   127.0.0.1:5432，数据卷）      │
└──────────────────────────────────────────────┘
```

**前置条件**

| 项 | 要求 |
|---|---|
| 系统 | Linux（部署脚本用 bash）；CPU 架构 x86_64 / arm64 均可 |
| Docker | 已安装且守护进程可用（`docker info` 能通）；不需要 docker-compose |
| 磁盘 | 镜像约 600MB + 数据；建议 ≥ 10GB 可用 |
| 网络 | 服务器能访问目标被监控机器的 SSH 端口；能访问模型服务地址 |
| 端口 | 应用默认 3001（可改）；PostgreSQL 只监听 127.0.0.1:5432 |

> 服务器**不需要**能访问 GitHub。部署走 git bundle 上传，离线也能做。

---

## 2. 目录与配置文件

服务器上的目录结构（示例路径 `/workspace/Openlog-new`）：

```
/workspace/Openlog-new/
├── deploy/
│   ├── deploy.sh          # 部署脚本
│   ├── deploy.env         # ★ 部署配置（含数据库密码，不进 git）
│   ├── deploy.env.example # 配置模板
│   ├── MANUAL.md          # 本手册
│   └── images/            # 镜像归档
├── data/                  # openlog 数据（bind mount）
│   ├── .auth_token        # 访问令牌（首次启动自动生成）
│   └── openlog.db         # 只有用 SQLite 时才存在
├── backups/               # 自动备份（数据库 dump、部署记录）
└── .git/
```

**首次部署前必须做的一步**：创建 `deploy/deploy.env`

```bash
cd /workspace/Openlog-new
cp deploy/deploy.env.example deploy/deploy.env
chmod 600 deploy/deploy.env
vi deploy/deploy.env
```

最小可用内容：

```bash
APP_PORT=3001
DATA_DIR=/workspace/Openlog-new/data
LOGS_VOLUME=openlog-logs
NETWORK_MODE=host

OPENLOG_DB_TYPE=postgres
OPENLOG_DATABASE_URL=postgres://openlog:<密码>@127.0.0.1:5432/openlog
OPENLOG_PG_POOL_MAX=10

OPENLOG_ENABLE_CONTAINER_EXEC=1
```

完整字段说明见 [第 9 节](#9-配置项全表)。

开发机侧还需要 `deploy/.deploy.json`（SSH 连接信息）：

```json
{
  "host": "203.0.113.10",
  "port": 40022,
  "username": "deploy",
  "password": "…",
  "appDir": "/workspace/Openlog-new",
  "branch": "node",
  "port_http": 3001
}
```

`npm run deploy` 会自动找 `deploy/.deploy.json`，找不到再用根目录的 `.deploy.json`。

---

## 3. 首次部署

### 3.1 起 PostgreSQL（只需一次）

```bash
docker volume create openlog-pgdata
docker run -d --name openlog-pg --restart unless-stopped \
  -e POSTGRES_USER=openlog \
  -e POSTGRES_PASSWORD='<强密码>' \
  -e POSTGRES_DB=openlog \
  -v openlog-pgdata:/var/lib/postgresql/data \
  -p 127.0.0.1:5432:5432 \
  postgres:16-alpine

# 等到 ready
docker exec openlog-pg pg_isready -U openlog -d openlog
```

> 密码写进 `deploy/deploy.env` 的 `OPENLOG_DATABASE_URL`，只监听回环地址。

### 3.2 准备代码

```bash
# 方式 A：服务器能访问 GitHub
git clone -b node https://github.com/XiaoBinGan/Openlog.git /workspace/Openlog-new

# 方式 B：服务器离线 —— 在开发机执行 npm run deploy，会自动 bundle 上传并 reset
```

### 3.3 首次部署

在开发机（推荐）：

```bash
cd <本地仓库>
cp deploy/deploy.config.example.json deploy/.deploy.json   # 填 SSH 信息
npm run deploy
```

或者直接在服务器上：

```bash
cd /workspace/Openlog-new
bash deploy/deploy.sh
```

首次会建表、生成访问令牌。完成后访问 `http://<host>:3001/`，
首次需要输入令牌（`docker exec openlog cat /app/data/.auth_token`）。

### 3.4 如果从 SQLite 迁移过来的数据

```bash
OPENLOG_DB_TYPE=postgres \
OPENLOG_DATABASE_URL='postgres://openlog:<密码>@127.0.0.1:5432/openlog' \
node scripts/migrate-sqlite-to-pg.mjs
```

幂等（主键冲突跳过），可先加 `--dry-run` 看行数。

---

## 4. 日常更新（一键部署）

```bash
npm run deploy
```

脚本做的事（任何一步失败都不会留半拉子状态）：

1. 打 git bundle → SFTP 上传到 `/tmp`
2. 远端 `git fetch` + `git reset --hard`
3. 调 `deploy/deploy.sh`：
   - **备份数据库**（PG `pg_dump`，保留最近 10 份）
   - 构建镜像，打 `openlog:<commit>` 和 `openlog:latest`
   - 从 `deploy/deploy.env` 读配置启动容器
   - **健康检查**：页面 200 + `/api/db/info` 的 `ok:true`，最多等 90s
   - **失败自动回滚**到上一个镜像
   - 清理旧镜像（保留最近 5 个）

### 常用参数

| 命令 | 用途 |
|---|---|
| `npm run deploy` | 完整部署 |
| `npm run deploy -- --dry-run` | 只打印将执行的动作，不动线上 |
| `npm run deploy -- --no-build` | 只同步代码 + 重启（改了 env 后用） |
| `npm run deploy -- --skip-backup` | 跳过数据库备份（快，但没退路） |
| `npm run deploy:logs` | 只看服务状态 / 部署记录 / 最近日志 |
| `bash deploy/deploy.sh`（服务器上） | 不走 SSH 直接部署 |

### 部署记录

`backups/.last-deploy.json`：

```json
{
  "deployedAt": "2026-10-29T18:57:12+08:00",
  "commit": "29ebc01e",
  "image": "openlog:29ebc01e",
  "dbType": "postgres",
  "port": "3001",
  "previousImage": "sha256:1168b620…"
}
```

---

## 5. 镜像归档与离线部署

用途：长期回滚点、离线机器部署、避免旧镜像被自动清理后无法回退。

```bash
# 归档当前 latest（输出到 deploy/images/）
npm run deploy:image:save

# 指定 tag / 自定义名字
bash deploy/scripts/save-image.sh openlog:29ebc01e 2026-10-29-before-upgrade

# 从归档恢复（可指定新 tag）
bash deploy/scripts/load-image.sh deploy/images/openlog-2026-10-29-before-upgrade.tar.gz

# 列出已有归档
ls -lh deploy/images/
cat deploy/images/MANIFEST.md
```

归档文件命名：`openlog-<tag>-<日期>.tar.gz`，同时会更新 `deploy/images/MANIFEST.md` 清单。

**离线部署到一台新机器**（服务器不能上网）：

```bash
# 有网机器上
npm run deploy:image:save
scp deploy/images/openlog-*.tar.gz user@new-host:/tmp/
scp deploy/deploy.env.example deploy/deploy.sh user@new-host:/tmp/   # 或者 git bundle

# 新机器上
docker load -i /tmp/openlog-*.tar.gz
# 按第 3 节起 PG + 准备 deploy.env
docker run -d --name openlog --network host --restart unless-stopped \
  -e NODE_ENV=production -e PORT=3001 -e HOST=0.0.0.0 \
  $(grep -v '^#' /tmp/deploy.env | grep -E '^(OPENLOG|APP|DATA|LOGS|NETWORK)' | sed 's/^/-e /' | tr '\n' ' ') \
  -v <DATA_DIR>:/app/data -v openlog-logs:/app/logs openlog:latest
```

> `deploy/images/*.tar.gz` 已在 `.gitignore` 里，不会污染仓库。

---

## 6. 数据备份与恢复

### 自动备份

每次 `npm run deploy` 会自动做一次：

```bash
ls -lh backups/
# openlog-pg-20261029-184542.sql.gz
```

保留最近 10 份，自动清理更早的。

### 手动备份

```bash
# PostgreSQL
docker exec openlog-pg pg_dump -U openlog -d openlog | gzip > ~/openlog-$(date +%F).sql.gz

# SQLite（如果还在用）
docker exec openlog sh -lc 'cp /app/data/openlog.db /app/data/openlog.db.bak'
```

### 恢复

```bash
# 停应用，避免恢复期间写入
docker rm -f openlog

# 恢复数据库（会覆盖同名表数据）
gunzip -c backups/openlog-pg-20261029-184542.sql.gz | \
  docker exec -i openlog-pg psql -U openlog -d openlog

# 重新起应用
bash deploy/deploy.sh --no-build
```

### 访问令牌

在 `data/.auth_token`（bind mount，重建容器不丢）：

```bash
docker exec openlog cat /app/data/.auth_token
# 或
cat data/.auth_token
```

想换令牌：删文件重启（会重新生成），或用 `OPENLOG_TOKEN` 环境变量固定。

---

## 7. 回滚

### 自动回滚

健康检查失败时脚本自己回滚到上一个镜像并重启，退出码 1：

```
▶ 健康检查（最多 90s）
❌ 90s 内健康检查未通过
▶ 部署失败 → 回滚到上一个镜像
✅ 页面 200 / 数据库正常（postgres）
⚠️ 已回滚到 sha256:1168b620… 并恢复服务
```

### 手动回滚到某个镜像

```bash
# 看有哪些
docker images openlog --format '{{.Tag}} {{.ID}} {{.CreatedAt}}' | head -10

# 二选一
# A) 回滚到 git 历史版本（会重新构建）
cd /workspace/Openlog-new && git reset --hard <commit> && bash deploy/deploy.sh

# B) 直接跑旧镜像（更快，不改代码）
docker rm -f openlog
docker run -d --name openlog --network host --restart unless-stopped \
  -e NODE_ENV=production -e PORT=3001 -e HOST=0.0.0.0 \
  -e OPENLOG_DB_TYPE=postgres \
  -e OPENLOG_DATABASE_URL='postgres://openlog:<密码>@127.0.0.1:5432/openlog' \
  -v /workspace/Openlog-new/data:/app/data -v openlog-logs:/app/logs \
  openlog:<旧tag>
```

### 回滚到 SQLite

去掉 `OPENLOG_DB_TYPE` / `OPENLOG_DATABASE_URL` 再起容器即可（`data/openlog.db` 会保留切换时的快照，
之后的写入不在里面）。

---

## 8. 排障

### 部署失败

```bash
npm run deploy:logs                 # 看部署状态 + 最近 40 行日志
docker logs --tail 100 openlog      # 完整日志
cat backups/.last-deploy.json       # 上次部署信息
```

常见原因：

| 现象 | 处理 |
|---|---|
| `镜像构建失败` | 看构建输出；确认磁盘够、`docker build` 能拉基础镜像 |
| `90s 内健康检查未通过` | `docker logs openlog`；多半是数据库连不上或端口占用 |
| `数据库不可用 → PostgreSQL: …` | 检查 `openlog-pg` 容器、`OPENLOG_DATABASE_URL` 密码 |
| `EADDRINUSE` | 3001 被别的进程占了（`ss -tlnp \| grep 3001`） |

### 应用起来了但页面 401

生产模式强制鉴权。带上令牌访问，或从 `data/.auth_token` 取。
浏览器首次访问会弹输入框。

### 忘记令牌

```bash
docker exec openlog cat /app/data/.auth_token
```

### 数据库连不上

```bash
docker ps --filter name=openlog-pg          # 是否在跑
docker exec openlog-pg pg_isready -U openlog -d openlog
docker exec openlog-pg psql -U openlog -d openlog -c '\dt'   # 看表
```

### 磁盘被镜像占满

```bash
docker images openlog --format '{{.Tag}} {{.Size}}'     # 每个约 600MB
docker image prune -f
# 长期回滚点先归档：npm run deploy:image:save
```

---

## 9. 配置项全表

`deploy/deploy.env`：

### 应用

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_PORT` | `3001` | 宿主机端口（host 网络即应用监听端口） |
| `HOST_BIND` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `$APP_DIR/data` | 数据目录（bind mount 到 `/app/data`） |
| `LOGS_VOLUME` | `openlog-logs` | 日志卷名（挂到 `/app/logs`） |
| `NETWORK_MODE` | `host` | 网络模式 |
| `EXTRA_ENV` | 空 | 额外环境变量，空格分隔的 `KEY=VALUE` |

### 数据库

| 变量 | 说明 |
|---|---|
| `OPENLOG_DB_TYPE` | `postgres` / `mysql` / 留空 = SQLite |
| `OPENLOG_DATABASE_URL` | `postgres://user:pass@host:5432/db` |
| `OPENLOG_PG_POOL_MAX` | 连接池上限，默认 10 |

### 功能开关

| 变量 | 说明 |
|---|---|
| `OPENLOG_ENABLE_CONTAINER_EXEC` | 容器内命令面板（只读白名单），`1` 开启 |
| `OPENLOG_ENABLE_REMOTE_EXEC` | REST 远程命令执行（外部脚本用，默认关） |
| `OPENLOG_TOKEN` | 固定访问令牌；不设则自动生成到 `data/.auth_token` |
| `OPENLOG_SECRET_KEY` | 凭据加密密钥，**设置后不要再取消**（单向迁移） |
| `OPENLOG_ALLOWED_ORIGINS` | 浏览器来源白名单，逗号分隔 |

### 规模与预算（可选，有默认值）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENLOG_STATS_CONCURRENCY` | 16 | 状态采集并发 |
| `OPENLOG_STATS_INTERVAL_MS` | 30000 | 采集间隔 |
| `OPENLOG_MFU_INTERVAL_MS` | 60000 | MFU 采集间隔 |
| `OPENLOG_MAX_SSH_CONNECTIONS` | 300 | 常驻 SSH 连接上限（1000 台建议 ≥ 服务器数） |
| `OPENLOG_SSH_IDLE_TTL_MS` | 600000 | 空闲连接回收 |
| `OPENLOG_SSH_READY_TIMEOUT_MS` | 10000 | 建连超时 |
| `OPENLOG_RECONNECT_CONCURRENCY` | 16 | 自动重连并发 |
| `OPENLOG_RECONNECT_MAX_PER_PASS` | 64 | 每轮重连上限 |
| `OPENLOG_STARTUP_CONNECT_CONCURRENCY` | 16 | 启动重连并发 |
| `OPENLOG_ASSISTANT_MAX_ROUNDS` | 30 | 助手单次任务工具轮数 |
| `OPENLOG_ASSISTANT_MAX_WALL_MS` | 600000 | 助手单次任务时长上限 |
| `OPENLOG_ASSISTANT_CONTEXT_TOKENS` | 48000 | 助手上下文预算 |
| `OPENLOG_ASSISTANT_TOOL_RESULT_CHARS` | 6000 | 单条工具结果进上下文上限 |
| `OPENLOG_ASSISTANT_ROUND_TIMEOUT_MS` | 180000 | 单轮模型响应超时 |

---

## 10. 上线检查清单

部署完逐项确认：

```bash
# 1. 容器在跑
docker ps --filter name=openlog --format '{{.Names}} {{.Status}}'

# 2. 页面可访问
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/     # 期望 200

# 3. 数据库正常 + 连接池水位
TOK=$(curl -s http://127.0.0.1:3001/api/auth/token | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s -H "Authorization: Bearer $TOK" 'http://127.0.0.1:3001/api/db/info?counts=1'

# 4. 服务器列表与连接状态
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:3001/api/remote/servers

# 5. 部署记录
cat backups/.last-deploy.json

# 6. 日志无报错
docker logs --tail 40 openlog 2>&1 | grep -iE 'error|uncaught' || echo '无错误'
```

**监控建议**：把 `GET /api/db/info` 接到外部探针（`ok:true` + `pool.waiting` 持续为 0），
`npm run deploy` 前先确认 `deploy/.deploy.json` 与 `deploy/deploy.env` 都是最新配置。
