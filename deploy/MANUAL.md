# 📖 OpenLog 部署手册

面向「这台机器要跑 OpenLog」的完整操作手册。按顺序看即可；日常更新直接跳到
[第 4 节](#4-日常更新一键部署)。

- [1. 架构与前置条件](#1-架构与前置条件)
- [2. 目录与配置文件](#2-目录与配置文件)
- [3. 首次部署](#3-首次部署)
- [4. 日常更新（一键部署）](#4-日常更新一键部署)
- [5. 升级到新版本](#5-升级到新版本)
- [6. AI Infra 能力层（模型服务编排）](#6-ai-infra-能力层模型服务编排)
- [7. 镜像归档与离线部署](#7-镜像归档与离线部署)
- [8. 数据备份与恢复](#8-数据备份与恢复)
- [9. 回滚](#9-回滚)
- [10. 排障](#10-排障)
- [11. 配置项全表](#11-配置项全表)
- [12. 上线检查清单](#12-上线检查清单)

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

完整字段说明见 [第 11 节](#11-配置项全表)。

开发机侧还需要 `deploy/.deploy.json`（SSH 连接信息）：

```json
{
  "host": "203.0.113.10",
  "port": 40022,
  "username": "your-ssh-user",
  "password": "…",
  "appDir": "/workspace/Openlog-new",
  "branch": "node",
  "port_http": 3001
}
```

`npm run deploy` 会自动找 `deploy/.deploy.json`，找不到再用根目录的 `.deploy.json`。

**端口默认值有两个，别混用**：

| 入口 | 默认端口 | 怎么改 |
|---|---|---|
| `deploy/install.sh`（离线一键部署） | **3001** | `bash deploy/install.sh --port 8080` |
| `deploy/deploy.sh` + `deploy/deploy.env` | **3001** | `APP_PORT=8080` |
| 直接 `node server/index.js`（裸机 / 开发） | **3011** | `PORT=3001 node server/index.js` |

`install.sh` 的 `APP_PORT=3001` 与 `server/index.js` 里 `process.env.PORT || 3011` 的兜底值
**不是同一个默认值**：走脚本/容器部署时生效的是 3001（脚本会以 `-e PORT=<APP_PORT>` 传进容器），
直接起 node 而没设 `PORT` 时才是 3011（README 里的示例大多是这种裸 node 场景）。
统一端口只用两个变量：容器部署改 `APP_PORT` / `--port`，裸 node 改 `PORT`；
反向代理、健康检查、探针、防火墙规则都按**实际生效的那个端口**写。

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

**离线机器（无外网）**：把部署包拷进去后一条命令即可，脚本会自己导入镜像、
生成 `deploy.env`、按需拉起 PostgreSQL、启动并做健康检查：

```bash
tar xf openlog-deploy-<commit>.tar && cd openlog-deploy-<commit>
bash deploy/install.sh --yes                              # 默认 SQLite
bash deploy/install.sh --with-postgres --yes              # 用 PostgreSQL（自动导镜像/起容器）
bash deploy/install.sh --port 8080 --data-dir /data/openlog --yes
bash deploy/install.sh --dry-run                          # 只打印动作
```

> 不需要外网、不需要 `docker pull`、不需要 `curl`（健康检查会退回到容器内 node）。
> 同机多实例用 `--container-name` / `--pg-container` / `--pg-port` 区分。

**有仓库的机器**：

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
首次需要输入令牌——`deploy.sh` 结束时会把「访问令牌」直接打印在最后几行，
不用再登服务器翻目录；也可以手动取（`docker exec openlog cat /app/data/.auth_token`）。

> 上面的 `3001` 是 `deploy.env` 里 `APP_PORT` 的默认值；直接 `node server/index.js` 的兜底端口是
> **3011**，两者不是同一个默认值（见 [第 2 节](#2-目录与配置文件) 的端口默认值表）。改过端口就换掉 URL。

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

## 5. 升级到新版本

[第 4 节](#4-日常更新一键部署) 讲的是把当前分支的最新提交推上去；**跨版本升级**
（v1.0.x → v1.1.0 → v1.1.1 → v1.2）多一层要确认的东西：数据表结构会不会变、有没有新增设置项、
集群侧要不要额外做事。顺序固定：**检查 → 升级 → 验证 → 兜底**。

### 升级前检查

1）先确认现在跑的是什么 —— 镜像 tag 是 commit 短 sha，版本号要对 `CHANGELOG.md` 看：

```bash
docker inspect openlog --format '{{.Config.Image}}'          # openlog:<sha>
docker inspect openlog --format '{{.Created}}'               # 这个镜像是什么时候构建的
cat backups/.last-deploy.json                                # commit / image / deployedAt / previousImage
cd /workspace/Openlog-new && git log --oneline -1            # 服务器上的代码到哪个提交了
grep '"version"' package.json                                # 代码侧版本号（例如 1.1.1）
```

页面还能开的话，也可以从运行中的实例对照（都是 GET，不改数据）：

```bash
curl -s http://127.0.0.1:3001/api/health                     # 免鉴权：ok / dbReady / uptime
TOK=$(docker exec openlog cat /app/data/.auth_token)
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:3001/api/settings | head -c 400
```

`/api/settings` 不返回版本号字段 —— 它的用处是看**新版本引入的设置项是否已经出现**
（例如 v1.1.1 的 `containerHealthStaleHours` / `containerHealthIgnoreUnobserved`），
以及升级后配置有没有被覆盖。版本号以镜像 tag 与 `package.json` 为准。

2）备份与空间必须在：

```bash
ls -lt backups/ | head -3                     # 最近一份 openlog-pg-*.sql.gz（第 8 节）
df -h /workspace                              # 镜像约 600MB + 构建缓存，留 5GB 以上更稳
docker images openlog --format '{{.Tag}} {{.Size}}' | head
```

3）给升级起点留个长期回滚点（旧镜像会被自动清理，只有 5 个）：

```bash
npm run deploy:image:save                     # → deploy/images/openlog-<tag>-<日期>.tar.gz
```

### 先检查服务端有没有未上传的改动

`npm run deploy` 上传 bundle 后是 `git reset --hard`，服务器上如果有**没进仓库的本地提交**
（现场热修、直接 `vi` 改的代码），默认会被拦下，而不是静默覆盖。升级前先跑一遍：

```bash
node deploy/deploy.mjs --dry-run        # 只打印远程将执行的命令 + 漂移检查结果，不动线上
```

看输出里「检查服务端是否有未推送的提交」那一段：

| 结果 | 含义 | 做法 |
|---|---|---|
| 无漂移（快进） | 服务器 HEAD 是目标提交的祖先 | 继续升级 |
| 有漂移（列出若干提交） | 服务器有未推送的本地提交 | **先在服务器上收编**：push 回仓库，或 `git format-patch` / `git stash` 留一份，再正常升级 |
| 探测不出来 | 连不上 / `appDir` 不存在 / 没有 HEAD | 输出会写明跳过原因；修好再跑，不要当它通过了 |

确认这些提交**可以丢弃**时才用 `--force`：它会先在服务端建备份分支 `backup/predeploy-<8位sha>`，
再 `reset --hard` 覆盖，并把回滚命令一并打印：

```bash
node deploy/deploy.mjs --force                        # 丢弃服务端本地提交（先自动建备份分支）
cd /workspace/Openlog-new && git reset --hard backup/predeploy-<sha>   # 反悔时（在服务器上）
git branch -D backup/predeploy-<sha>                   # 部署确认没问题后清掉
```

标准顺序：`--dry-run` 看漂移 → 有漂移先收编 → `node deploy/deploy.mjs` 正常升级 →
只有确认丢弃才 `--force`。

> `deploy/.deploy.json` 里的 `branch` 填 **`node`**（开发分支）；`main` 只用于发版。
> 没有这个文件时用 `node deploy/deploy.mjs --init` 生成模板（纯本地、零网络操作；
> 已存在会拒绝，要覆盖得加 `--force`，覆盖前先 `cp` 备份一份）。

### 标准升级步骤

```bash
# 1) 拉代码，切到目标版本（tag 最稳：v1.0.1 / v1.1.0 / v1.1.1）
cd /workspace/Openlog-new
git fetch --tags
git checkout v1.1.1                           # 或 git reset --hard v1.1.1

# 2) 一条命令部署：备份 → 构建 → 起容器 → 健康检查 → 失败自动回滚
bash deploy/deploy.sh

# 3) 按下面「升级后验证」逐项确认
```

- 有开发机时 `npm run deploy` 等价，并且会先做「服务端有没有未推送的本地提交」的漂移检测。
- `deploy.sh` 的内部顺序是固定的，**不用自己先备份、也不用自己写回滚**：
  先 `pg_dump` 备份数据库（保留最近 10 份）→ 构建并打 `openlog:<commit>` / `openlog:latest` →
  按 `deploy.env` 起容器 → 健康检查（页面 200 + `/api/db/info` 的 `ok:true`，最多 90s）→
  **健康检查失败自动回滚到上一个镜像并重启**，退出码 1。
  唯一会打破这个保证的是 `--skip-backup`（快，但没退路），升级时不要带。
- 只改了 `deploy.env`（换端口 / 换库 / 加环境变量）用 `bash deploy/deploy.sh --no-build`，
  不重新构建镜像。
- 升级期间建议先看一眼 `docker logs --tail 40 openlog` 的基线，升级后再对比，噪音才分得清。

**离线机器（只有镜像包，没有仓库）** 走 `install.sh` 的升级模式，不碰配置：

```bash
bash deploy/install.sh --upgrade                                    # 换成本地最新的 openlog-*.tar.gz
bash deploy/install.sh --upgrade --image deploy/images/openlog-<sha>-<ts>.tar.gz
bash deploy/install.sh --upgrade --dry-run                          # 只打印会执行什么，不动线上
```

`--upgrade` 与首次安装的区别：端口 / 数据目录 / 日志卷 / 数据库连接串**只读不写**，全部沿用现有容器
与它的 `deploy.env`（命令行上的 `--port` / `--data-dir` / `--with-postgres` / `--db-url` 会被忽略并告警，
避免「升级」变成「换了个实例」）；旧镜像先打成独立回滚点 `openlog:rollback-<时间戳>`，
健康检查通过后才把 `latest` 指向新镜像。

### 版本变更对照表

| 版本 | 这版改了什么 | 升级要做什么 |
|---|---|---|
| v1.0.x | 基线。v1.0.0 是首个开源快照，**离线包请用 v1.0.1 或更新**（打包脚本与架构自检的修正） | — |
| v1.1.0 | 内置时序库（Prometheus 兼容）：持久化 `ts_series` / `ts_sample`，抓取器、PromQL 子集、表达式告警、记录规则、保留期分层、remote write；`/metrics` 与 `/api/v1/*` 对外接口 | **不需要手工迁移**。两张表用 `CREATE TABLE IF NOT EXISTS` 在启动时自动建（SQLite / PostgreSQL / MySQL 三方言都如此）；v1.0.x 的配置、数据、API 全部兼容，运行时代码零破坏性变更 |
| v1.1.1 | 健康检查去噪：不再把「读不到日志」当容器报错，按证据分成 `problem` / `stale` / `unobserved`，OOM(137) 与段错误(139) 照报 | 无需手工动作。新增两个设置项：`containerHealthStaleHours`（默认 `24`，可选 0 / 1 / 6 / 24 / 72 / 168，`0` = 不过滤）与 `containerHealthIgnoreUnobserved`（默认开），位置在「设置 → 容器异常监控 → 健康检查过滤」。升级后 `unhealthy` 数量明显下降属预期（被过滤的条数在 `summary.ignoredStale` / `ignoredUnobserved` 里单独计数，没有静默吞掉） |
| v1.2（未发布） | 只读 Kubernetes 监控：kubeconfig 直连 apiserver，节点 / Pod / 工作负载 / Warning 事件 / Pod 日志 / 多集群 | **要在集群里 apply RBAC 并生成 kubeconfig**，见下一小节。不 apply 也能升级：K8s 页没有数据、不报错，其它功能不受影响 |

> 升级是单向前进的：升级到 v1.1.x 之后要降回 v1.0.x，按 [第 9 节](#9-回滚) 回滚到升级前的镜像，
> 并先确认备份可用（旧代码不读 TSDB 的两张表，但升级期间写入的时序数据在旧版本里没有入口）。

### 升级后验证

```bash
# 1. 页面 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/        # 期望 200

# 2. 进程自身健康（免鉴权，不查库）
curl -s http://127.0.0.1:3001/api/health                               # ok:true, dbReady:true

# 3. 数据库与设置可读（需要令牌）
TOK=$(docker exec openlog cat /app/data/.auth_token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOK" \
  http://127.0.0.1:3001/api/settings                                   # 期望 200
curl -s -H "Authorization: Bearer $TOK" 'http://127.0.0.1:3001/api/db/info?counts=1'

# 4. 数据还在：服务器列表条数、历史指标
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:3001/api/remote/servers | head -c 300

# 5. 日志无报错
docker logs --tail 40 openlog 2>&1 | grep -iE 'error|uncaught' || echo '无错误'
```

按版本对号入座：

| 项 | v1.1.0 起 | v1.1.1 起 |
|---|---|---|
| 页面 200、`/api/health` 的 `ok:true` | 必查 | 必查 |
| `/api/settings` 200，设置没被覆盖 | 必查 | 必查 |
| 服务器列表条数与连接状态、历史数据仍在 | 必查 | 必查 |
| 监控页「时序库查询」能出图（PromQL 预设跑一条） | 建议 | 建议 |
| 健康检查过滤项已出现、`unhealthy` 回落 | — | 建议 |
| 「K8s 集群」页有数据 | 按需（v1.2 且已 apply RBAC） | 按需 |

v1.2 上线后如果 K8s 页是空的：那不是升级失败，先确认下一小节的 RBAC 有没有 apply 过。

### 升级失败怎么办

自动回滚是默认行为，先确认它发生了什么：

```bash
npm run deploy:logs                                   # 部署状态 + 最近 40 行
cat backups/.last-deploy.json                         # previousImage 就是回滚目标
docker ps --filter name=openlog --format '{{.Names}} {{.Image}} {{.Status}}'
docker images openlog --format '{{.Tag}} {{.CreatedAt}}' | head -10
```

自动回滚没兜住，或健康检查过了但业务不对，手动回（详细版在 [第 9 节](#9-回滚)）：

```bash
# A) 回到上一个镜像：最快，不改代码
docker rm -f openlog
docker run -d --name openlog --network host --restart unless-stopped \
  -e NODE_ENV=production -e PORT=3001 -e HOST=0.0.0.0 \
  -e OPENLOG_DB_TYPE=postgres \
  -e OPENLOG_DATABASE_URL='postgres://openlog:<密码>@127.0.0.1:5432/openlog' \
  -v /workspace/Openlog-new/data:/app/data -v openlog-logs:/app/logs \
  openlog:<上一个tag>

# B) 代码也退回去，重新构建
cd /workspace/Openlog-new && git reset --hard <上一个commit> && bash deploy/deploy.sh

# C) 部署时用 --force 覆盖了服务器本地提交：回到部署脚本留的备份分支
git branch -a | grep predeploy                        # backup/predeploy-<sha>
git reset --hard backup/predeploy-<sha> && bash deploy/deploy.sh
```

- `backup/predeploy-<sha>` **只有** `npm run deploy -- --force` 覆盖服务端本地提交时才会建；
  正常快进部署没有这个分支，回滚走 A / B，或者用 [第 7 节](#7-镜像归档与离线部署) 的镜像归档。
- 只有数据被写坏才恢复数据库（[第 8 节](#8-数据备份与恢复)）；单纯代码回滚不要顺手恢复，
  否则会丢掉升级期间正常写入的采集数据。
- 回滚完记得把 `deploy/deploy.env` 也退回与新版本匹配的内容（新版本新增的开关旧版本读不懂，
  一般无害，但不要留下半新半旧的配置）。

#### 没有 GPU 集群时：用模拟 HAMi 集群验证

想验证 vGPU 分配视图（`nvidia.com/gpumem` / `hami.io/vgpu-devices-allocated`）不必先有 GPU 机器：

```bash
node scripts/mock-hami-cluster.mjs            # 监听 127.0.0.1:18445，启动时打印 kubeconfig
node scripts/mock-hami-cluster.mjs --port 18080
node scripts/mock-hami-cluster.mjs --print-kubeconfig   # 只输出 kubeconfig
```

它是个假的 kube-apiserver（纯 node，无依赖）：2 个节点（4×4090 + 2×T4，共 6 卡）、
7 个 Pod（5 个带 vGPU 分配、1 个因显存不足 Pending、1 个 CrashLoop+OOM）、3 条 Warning 事件。
把打印出来的 kubeconfig 粘到「K8s 集群」页即可看到完整链路 —— 走的是真 HTTP / 真 JSON /
真归一化，与连真集群没有区别，只是数据写死。

> token 写死为 `mock-hami-token`，只监听 127.0.0.1，仅供本地验证，不要暴露到外网。

### 启用 Kubernetes 监控（v1.2 / 未发布）

只读接入：OpenLog 直连 kube-apiserver，**不在节点装 agent，也不要求 OpenLog 所在机器装 kubectl**
（kubectl 只在生成 kubeconfig 时用一次）。全部请求都是 GET，不往集群写任何东西。

```bash
# 1) 应用 RBAC：openlog 命名空间 + 只读 ServiceAccount + 只读 ClusterRole/Binding + 长期 token Secret
kubectl apply -f deploy/k8s/rbac.yaml

# 2) 等 token 被填充（k8s ≥ 1.24 不再自动签发，控制器异步写入，通常 1~10s；输出为空就再等等）
kubectl -n openlog get secret openlog-readonly-token -o jsonpath='{.data.token}' | head -c 24; echo

# 3) 生成 kubeconfig（--server 必须是「OpenLog 所在机器能访问到」的 apiserver 地址）
bash deploy/k8s/make-kubeconfig.sh --server https://127.0.0.1:6443 > /tmp/openlog-kubeconfig.yaml

# 4) 用只读凭据自检一次
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml get --raw /version
```

然后把 `/tmp/openlog-kubeconfig.yaml` 全文粘贴到 OpenLog →「K8s 集群」页 → 新增集群
（context 留空 = 用 `current-context`）→ **测试连接** → 成功会回 apiserver 版本与节点数 →
保存后立刻 `rm -f /tmp/openlog-kubeconfig.yaml`（OpenLog 已把它存进自己的 settings，
`GET /api/settings` 读取时只回打码占位符，不需要本地副本）。

- **403 / `forbidden`**：报错会带上缺的 verb + resource，对着 `deploy/k8s/README.md` 第四节的表补规则，
  读接口仍然只加 `get` / `list` / `watch`；注意 `pods/log` 要单独给（`get pods` 不包含日志子资源）。
- **连不上 / 401**：`ECONNREFUSED` / `ETIMEDOUT` 是 `--server` 地址或 6443 不可达（跨机部署时别填 `127.0.0.1`）；
  证书不匹配要给 apiserver 加 SAN；`Unauthorized` 是 token 失效，重跑第 2~3 步重新生成。
- **k3s**：kubectl 用 `sudo kubectl` 或 `sudo k3s kubectl`，集群配置在 `/etc/rancher/k3s/k3s.yaml`。
- 完整权限模型（明确不给 `secrets`、`pods/exec`、任何写动词）、token 轮换与 403 对照表：
  `deploy/k8s/README.md`。

#### K8s 写操作（可选）：扩缩容 / 重启 / 删 Pod

上面装完是**纯只读**。要让页面出现「扩缩容」「重启」「删 Pod」这三个按钮，需要额外一份**可写**凭据，
并且在服务端打开开关 —— 两步缺一个都不生效。

```bash
# 1) 安装可选的 operator 权限（rbac.yaml 后半段：SA openlog-operator + 可写 ClusterRole
#    + 两条 Binding + token Secret openlog-operator-token；只读部分一个字符都不变）
kubectl apply -f deploy/k8s/rbac.yaml

#    反向：只想保持只读，把「以下为可选」之后的内容截掉再 apply（不会创建任何可写凭据）
awk '/^# ===== 以下为可选/{exit} {print}' deploy/k8s/rbac.yaml | kubectl apply -f -

# 2) 等 token 填充，用 operator 的 SA / Secret 生成 kubeconfig
kubectl -n openlog get secret openlog-operator-token -o jsonpath='{.data.token}' | head -c 24; echo
bash deploy/k8s/make-kubeconfig.sh --server https://127.0.0.1:6443 \
  --sa openlog-operator --secret openlog-operator-token > /tmp/openlog-operator-kubeconfig.yaml
chmod 600 /tmp/openlog-operator-kubeconfig.yaml

# 3) 自检：该有的写权限有，不该有的一条都没有
K=--kubeconfig=/tmp/openlog-operator-kubeconfig.yaml
kubectl $K auth can-i patch deployments -A     # yes
kubectl $K auth can-i delete pods -A           # yes
kubectl $K auth can-i get secrets -A           # no
kubectl $K auth can-i create pods/exec -n openlog   # no
```

```bash
# 4) OpenLog 里把该集群的 kubeconfig 换成上面这份
#    「K8s 集群」页 → 编辑该集群 → 粘贴 operator kubeconfig → 测试连接 → 保存
#    测试通过后删掉本地副本：rm -f /tmp/openlog-operator-kubeconfig.yaml

# 5) 打开服务端开关（deploy/deploy.env）
#    OPENLOG_K8S_WRITE 在 deploy.sh 的透传白名单里，直接写进 deploy.env 即可；
#    走 install.sh（离线包）时它不在白名单，用 EXTRA_ENV 传：
#      EXTRA_ENV="OPENLOG_K8S_WRITE=1"
#    改完重新部署（只换环境变量，不用重建镜像）：
bash deploy/deploy.sh --no-build
```

```ini
# deploy/deploy.env 片段（deploy.sh 路径）
OPENLOG_K8S_WRITE=1
```

**6) 刷新**「K8s 集群」页：工作负载行出现「扩缩容」「重启」，Pod 列表出现「删除」，操作成功返回 `auditId`。

**没开启时的表现**（也可以用它反查当前状态）：

| 场景 | 表现 |
|---|---|
| 未设 `OPENLOG_K8S_WRITE`（默认） | 页面不出现写按钮；手工 `POST .../workloads/:ns/:kind/:name/scale` 返回 `403 {"error":"写操作未启用（OPENLOG_K8S_WRITE=1 后生效）","readOnly":true}`，请求**不会**发到 apiserver |
| 开关已开，但 kubeconfig 还是只读那份 | 应用层放行，apiserver 回 `forbidden`（如 `deployments.apps "x" is forbidden`），页面显示失败原因 |
| 用的是 operator kubeconfig，但没设开关 | 同第一行：应用层 403，仍然写不动 |
| `OPENLOG_DEMO=1` 演示模式 | 写操作返回 `409`，任何情况下都不连真集群 |

- 开关取值在进程启动时读一次，改了必须重新部署（重建容器）才生效。
- 最小权限做法（把可写权限收窄到单个命名空间）与风险提示见 `deploy/k8s/README.md` 第二节「只读 vs 可写」。
- **风险**：开启写权限等于把「改副本数 / 滚动重启 / 删 Pod」的集群变更能力交给了所有能登 OpenLog 的人；
  生产或共享集群上建议按需临时开，排障结束换回只读 kubeconfig 并去掉 `OPENLOG_K8S_WRITE`。

---

## 6. AI Infra 能力层（模型服务编排）

前置：第 5 节的 K8s 接入已经走通（`/k8s` 页能看到集群、节点、GPU 分配）。这一节只讲**运维怎么做**；
设计原理、估算公式、兼容矩阵放在文末指向的两份文档里，不在本手册重复。

### 6.1 它是什么、什么时候用

一句话：在 `inference` / `infra-test` 两个命名空间里，把「模型路径 + 引擎镜像 + vGPU 配额 + 副本」
变成跑得起来的服务，全程**可预检、可回滚**。

什么时候用：新模型要上线一个 vLLM / llama.cpp / strata 服务；给现有服务加显存（KV cache 不够、OOM 过）；
把空转的配额压回去；改错了要回到上一版对象。

它**不是**这三样东西，边界会直接影响你怎么用它：

| 不是 | 含义 | 该去哪 |
|---|---|---|
| 不做训练 | 只编排推理服务，没有 job 队列、checkpoint、分布式通信拓扑 | 训练任务用 k8s Job / Kubeflow，本层不接管 |
| 不替代 k8s / HAMi | 不实现调度器、不改 kubelet；只生成标准对象。怎么排、能不能超卖、vGPU 怎么隔离，全由 HAMi + kube-scheduler 决定 | 集群侧配置（device-plugin、节点标签） |
| 不能跨卡拼显存 | 一个副本的显存/算力必须来自**同一张卡**：两张 24 GiB 各剩一半，拼不成一个 48 GiB 的副本 | 要跨卡 = 引擎自己的张量并行（`accelerators: N` + `--tensor-parallel-size`） |

### 6.2 开启与关闭

```bash
# deploy/deploy.env 追加一行
OPENLOG_K8S_INFRA=1
```

```bash
# 只改环境变量，不需要重新构建镜像
bash deploy/deploy.sh --no-build

# 核对：容器里必须能看到这一行（看不到就是没传进去）
docker exec openlog env | grep OPENLOG_K8S_
# OPENLOG_K8S_INFRA=1
# OPENLOG_K8S_WRITE=1        ← 有这行说明另一类开关也开着
```

关闭：把值改成 `0`（或整行删掉）再 `bash deploy/deploy.sh --no-build`。**读接口不受影响**——
服务列表、审计、缓存估算、弹性预算照常能查，只是不能改。

| 状态 | 读接口 | 写接口 |
|---|---|---|
| 未设 / `0` | 正常 | `preview` 返回 `violations[]` 里一条 `INFRA_DISABLED`、`allowed:false`；`apply` / `rollback` 返回 `403`，集群一个字节没动 |
| `1` | 正常 | 放行，然后还要过护栏与命名空间白名单 |

只认字面量 `'1'`：`true` / `yes` / `01` 一律当关闭（与 `OPENLOG_K8S_WRITE` 同一口径）。
开关在进程启动时读一次，改完必须重建容器才生效。

**与 `OPENLOG_K8S_WRITE` 相互独立，各管一类操作**：

| 开关 | 管什么 | 不开时的后果 |
|---|---|---|
| `OPENLOG_K8S_INFRA=1` | 本层：定义服务、渲染、apply、回滚、基准 | `/api/infra/*` 的写路径被拦 |
| `OPENLOG_K8S_WRITE=1` | 「K8s 集群」页的扩缩容 / 重启 / 删 Pod | 那三个按钮 403，本层照常工作 |

只想手动扩缩容就开 `WRITE`，想用模型服务编排就开 `INFRA`，两个都开也行。

> 离线机器走的是 `deploy/install.sh`，它同样只透传白名单变量；这两个开关都要写在 `EXTRA_ENV` 里：
> `EXTRA_ENV="OPENLOG_K8S_INFRA=1 OPENLOG_K8S_WRITE=1"`。

### 6.3 权限准备（一次性）

`deploy/k8s/rbac.yaml` 里与 Infra 相关的是三类权限：

| 权限 | 范围 | 给了什么 | 为什么需要 |
|---|---|---|---|
| ClusterRole `openlog-readonly` | 全集群只读（原有） | 各类资源 `get/list/watch`，含 `services` 读 | 预览要读集群现状：节点余量算容量、同名对象判归属、快照要读旧对象 |
| ClusterRole `openlog-operator` | 全集群 | 工作负载 `patch/update`、`pods delete`、`services get/list`（读 `services` 是这版新增的） | 更新已有对象、把旧 spec PATCH 回去、删单个 Pod 做重启 |
| Role `openlog-infra-creator` | **只绑 `inference` 与 `infra-test`** | `deployments`/`statefulsets` 的 `create`+`delete`；`services` 的 `create`+`delete`+`patch`+`update` | 起新服务要 `create`，回滚掉本次新建的对象要 `delete`，`services` 的 `patch/update` 是回滚恢复旧 spec 用的（只给 create/delete 会在 restore 那步 403） |

```bash
kubectl apply -f deploy/k8s/rbac.yaml
```

**为什么用命名空间级 Role，而不是把 `create` 加进 ClusterRole**：`create` 的对象还不存在，
没法用 `resourceNames` 收窄到一个白名单。ClusterRole 一旦给了 `create`，等于拿到「在 `kube-system`
里建 Deployment」的能力——那是让集群自己挂掉的按钮。绑成两个命名空间的 Role 之后，
被 RBAC 拒绝的范围和护栏的命名空间白名单完全一致：代码拒绝的、apiserver 拒绝的是同一批。

用 operator 那份 kubeconfig 自检一遍（四条都要对上）：

```bash
K=--kubeconfig=/tmp/openlog-operator-kubeconfig.yaml
kubectl $K auth can-i create deployments -n inference     # yes
kubectl $K auth can-i delete services -n infra-test       # yes
kubectl $K auth can-i create deployments -n kube-system   # no  ← 必须是 no
kubectl $K auth can-i create pods -n inference            # no  ← 本层不建裸 Pod
```

对不上时：第一条 no → RBAC 里没有 `openlog-infra-creator` 这两段，重新 `apply`；
`kube-system` 那条是 yes → 有人把 `create` 加到了 ClusterRole 上，立刻改回去。

### 6.4 起一个新服务（最常用）

前置（缺一条就别往下走）：`inference` 命名空间存在；节点上已有这个引擎镜像（离线环境先
`k3s ctr images import`）；模型目录在目标节点上（`hostPath` 是**节点本地**路径，跨节点挂不到）。

```bash
TOK=$(docker exec openlog cat /app/data/.auth_token)
API=http://127.0.0.1:3001/api/infra
AUTH="Authorization: Bearer $TOK"
```

定义存成 `qwen.json`（字段全表见 `docs/INFRA.md` 附录 A）：

```json
{
  "service": {
    "name": "qwen3-8b",
    "namespace": "inference",
    "model": {
      "source": "hostPath",
      "path": "/models/Qwen3-8B-AWQ",
      "specPath": "/models/Qwen3-8B-AWQ",
      "format": "safetensors",
      "quantization": "awq",
      "sizeMiB": 6000,
      "parametersB": 8,
      "contextLength": 8192,
      "maxConcurrency": 4
    },
    "engine": { "type": "vllm", "image": "vllm/vllm-openai:v0.11.0", "args": ["--max-model-len", "8192"] },
    "resources": { "accelerators": 1, "memoryMiB": 16384, "coresPercent": 50, "vendor": "nvidia" },
    "replicas": 1,
    "placement": { "nodeSelector": { "kubernetes.io/hostname": "node1" } },
    "ports": [{ "name": "http", "containerPort": 8000 }],
    "health": { "path": "/health", "initialDelaySeconds": 120 },
    "expose": { "gatewayPort": 30601 }
  }
}
```

**1）存定义（不下发集群）**

```bash
curl -s -X POST "$API/services/qwen3-8b/definition" \
  -H "$AUTH" -H 'content-type: application/json' -d @qwen.json \
  | jq '{ok, note, version: .service.version, id: .service.id}'
# 期望：{"ok":true,"note":"已保存定义（未下发集群）","version":1,"id":"svc-…"}
# 校验不过：{"error":"服务定义校验未通过","violations":[{"code":"INVALID_SERVICE",
#            "field":"resources.memoryMiB","message":"…"}]} → 按 field 改 qwen.json
```

这条路由**不碰集群、不需要开关**：先把定义想清楚、先跑 bench 回填实测值（6.6），都靠它。
`:id` 位置写服务名或 `namespace/name` 都行。下面的 `preview` / `apply` 要读集群，多集群时在 URL 上加
`?clusterId=<集群 id>`；不写就用 settings 里第一个启用的集群。

**2）预览（校验 + 护栏 + 容量预检 + 足迹预检 + diff + 中断预期）**

```bash
curl -s -X POST "$API/services/qwen3-8b/preview?clusterId=$CLUSTER_ID" \
  -H "$AUTH" -H 'content-type: application/json' -d @qwen.json \
  | jq '{allowed, violations, impact,
         fits: .placement.fits,
         footprint: {verdict: .footprint.verdict, basis: .footprint.basis, need: .footprint.requiredMiB}}'
# 期望：{"allowed":true,"violations":[],
#        "impact":{"action":"create","restarts":false,"downtimeSeconds":0},
#        "fits":true,"footprint":{"verdict":"fits","basis":"measured",...}}
```

三个字段必须逐个看完再点执行：

| 字段 | 通过长什么样 | 不通过怎么办 |
|---|---|---|
| `allowed` | `true` | `false` 时逐条读 `violations[].message`，按 6.5 的表处置 |
| `impact.downtimeSeconds` | 新建是 `0` | 不是 `0` 说明这次会**改到已有对象**：先看 `diff` 里有没有 `-` 行，有就说明改多了 |
| `footprint.verdict` | `fits`（`tight` 也放行，但余量 < 10%） | `insufficient` 会被硬拦，按 `footprint.reasons` 里的建议值调整 |

**3）执行（7 步状态机，失败自动回滚）**

```bash
curl -s -X POST "$API/services/qwen3-8b/apply?clusterId=$CLUSTER_ID" \
  -H "$AUTH" -H 'content-type: application/json' -d @qwen.json \
  | jq '{ok, action, auditId, errorStep,
         steps: [.steps[] | {name, ok, detail}],
         gateway: {ok: .gateway.ok, action: .gateway.action, error: .gateway.error}}'
# 期望：{"ok":true,"action":"create","auditId":"aud_1a2b3c4d5e6f","errorStep":null,
#        "steps":[{"name":"guard","ok":true},{"name":"dry-run","ok":true},
#                 {"name":"snapshot","ok":true},{"name":"apply","ok":true},
#                 {"name":"rollout","ok":true},{"name":"allocation","ok":true},
#                 {"name":"endpoint","ok":true}],
#        "gateway":{"ok":true,"action":"patched"}}
#        gateway.action：created / patched（首次或改动了路由）；配置没变时是 noop
#        gateway.ok:false 且 action:"configmap-written" = 半成功（线上仍是旧配置），处理见 6.9
```

七个步骤名是固定的：`guard` → `dry-run` → `snapshot` → `apply` → `rollout` → `allocation` → `endpoint`。
任何一步 `ok:false` 就停在那一步，并追加一条 `rollback`。
`rollout` 的超时按模型大小自动放大（约每 GiB 6 秒，下限 120s、上限 20min），大模型冷启动慢不会被误杀；要覆盖就带 `"rolloutTimeoutMs": <毫秒>`。

- `ok:true` 且 `steps` 全绿 = 服务起来了；`auditId` 有值说明这次变更已进审计。
- `ok:true` 但 `gateway.ok:false` **不是失败**：服务在跑，只是外部还访问不到，按 6.9 里 `configmap-written` 那一条处理。
- `ok:false` 时**不要重复 apply**，先看 `errorStep` 落在哪一步，照 6.9 的表处置。

验收：

```bash
curl -s http://NODE_IP:30601/v1/models | jq '.data[].id'        # 期望返回模型名
curl -s -H "$AUTH" "http://127.0.0.1:3001/api/k8s/clusters/$CLUSTER_ID/usage" \
  | jq '.nodes[] | {name, devices: [.devices[] | {uuid, allocMemMiB, usedMemMiB, measured}]}'
# 期望：allocMemMiB ≈ 16384，measured: true，usedMemMiB 随请求上涨
```

### 6.5 三个预检怎么读

`preview` 一次跑三个预检，回答三个不同的问题，别混着看：

| 预检 | 看哪个字段 | 回答的问题 | 典型不通过 | 怎么办 |
|---|---|---|---|---|
| 容量 | `placement.fits`；`violations[].code = CAPACITY_INSUFFICIENT` | 配额**放得进卡**吗 | 「显存不足：GPU-x 剩余 12000 MiB < 需要 16384 MiB」 | 降副本 / 降 `memoryMiB` / 换节点（`placement.nodeSelector`）/ 等邻居腾卡。**单卡剩余不够就是不够**：两张卡各剩 9 GiB 放不下一个 16 GiB 的副本 |
| 足迹 | `footprint.verdict`；`violations[].code = MODEL_FOOTPRINT_EXCEEDED` | 模型**放得进配额**吗 | `insufficient`：权重 + 引擎开销 + KV cache > 配额 | 按 `footprint.reasons` 里给出的建议值调 `resources.memoryMiB`；调不动就换更大显存的卡或换量化 |
| 基准门禁 | `gate.pass`（`POST /api/infra/bench` 的响应里） | 这个配置**能不能上线** | `failures[]`：TTFT p95 超阈、错误率超阈、显存超卖 | 按 `failures[].message` 修配置（降并发 / 加显存 / 换量化）后重跑 bench；基线只在通过时才更新 |

三条附带事实：

- 容量预检是**单卡语义**的估算，不是承诺：最终裁决在 kube-scheduler / HAMi。预检说 `fits: true`
  而 Pod 仍 `Pending`，看 6.9。
- `footprint.basis` 决定结论有多可信：

| `basis` | 含义 | 怎么用 |
|---|---|---|
| `measured` | 用的是 bench 回填的实测值 | **以它为准**，可以直接据此定配额 |
| `estimated` | 按 `model.sizeMiB` 或「参数量 × 位宽」估算 | 看 `footprint.warnings`；卸载型引擎必须改跑 bench（6.6） |

- 门禁当前是**取证工具**，`apply` 不读 `gate`：它不会替你拦下上线，要看的就是 `pass` 与 `failures[]` 本身。

### 6.6 实测显存回填（重要，别跳过）

卸载型引擎下**磁盘文件大小 ≠ 显存占用**，差 4~5 倍是常态：真机上 strata 的 63 GB 权重文件
实测只占 **13.3 GiB**（`--expert-cache` 把 expert 放在内存里）。llama.cpp 默认 mmap、
vLLM `--cpu-offload-gb` 同理。拿文件大小当权重口径，足迹预检会报 `MODEL_FOOTPRINT_EXCEEDED`，
而实际上配额绰绰有余——反过来（照着文件大小去配配额）就是 OOM。

正确做法：**跑一次 bench，让实测值回填进定义**。

```bash
curl -s -X POST "$API/bench?clusterId=$CLUSTER_ID" \
  -H "$AUTH" -H 'content-type: application/json' -d '{
    "serviceKey": "inference/qwen3-8b",
    "target": { "url": "http://NODE_IP:30601/v1", "model": "qwen3-8b" },
    "matrix": { "concurrencies": [1, 4], "inputTokens": [512, 4096] },
    "gpuMemPeakMiB": 13600
  }' | jq '{ok, backfilled,
           gate: {pass: .gate.pass, failures: [.gate.failures[].metric]},
           recommended: .summary.recommended}'
# 期望：{"ok":true,
#        "backfilled":{"serviceKey":"inference/qwen3-8b","measuredMemMiB":13600},
#        "gate":{"pass":true,"failures":[]},
#        "recommended":{"memoryMiB":16384,"coresPercent":50,"confidence":"measured",...}}
```

- `backfilled` 是**回填回执**：告诉你哪个服务被写入了多少 MiB。它是 `null` 说明没回填——
  多半是 `serviceKey` 在定义里找不到（定义还没存，先做 6.4 第 1 步），或者压根没拿到显存峰值。
- 不想手抄数字就别传 `gpuMemPeakMiB`：给了 `serviceKey` 之后，服务端会走已注册的 SSH 通道到
  集群对应节点读**进程级**显存峰值（卡级读数是同卡所有租户的总和，不能当本模型的占用）。
  读不到不报错，退回估算并明确告警。
- 回填之后再 preview，`footprint.basis` 会从 `estimated` 变成 `measured`，结论以实测为准：

```bash
curl -s -X POST "$API/services/qwen3-8b/preview" -H "$AUTH" \
  -H 'content-type: application/json' -d @qwen.json \
  | jq '{verdict: .footprint.verdict, basis: .footprint.basis, need: .footprint.requiredMiB}'
# 期望：{"verdict":"fits","basis":"measured","need":…}
```

在 GPU 节点上手工复核（进程级占用，单位 MiB）：

```bash
nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader
# 12345, 13600 MiB
```

看到的数比 `backfilled.measuredMemMiB` 大很多，通常是同卡还有别的租户进程：按 `pid` 对
`kubectl -n inference get pod` 找到自己那个，别把邻居的算进去。

> bench 会**真打这个服务**（压力可控：矩阵串行跑，单格上限并发 8、请求 20 条、整轮 120s），
> 生产上挑低峰跑。演示模式（`OPENLOG_DEMO=1`）直接 `409`，不会压测。

### 6.7 改配额（会中断，必须知道）

**k8s 里 Pod 的 `resources` 不可原地修改**：`nvidia.com/gpumem` 一变就等价于换 Pod。
这是 k8s 的语义，没有绕过的办法，只能把中断安排进窗口。

中断多久，护栏会在 `impact` 里算给你：

| 情形 | `impact.restarts` | `impact.downtimeSeconds` | 实际表现 |
|---|---|---|---|
| `replicas: 1` 时改配额 | `true` | **60** | 旧 Pod 删 → 新 Pod 起并加载模型，这段时间服务不可用 |
| 变更前后都 ≥2 副本 | `true` | **5** | 就绪探针逐个替换，只有连接抖动 |
| 只改 `replicas` | `false` | `0` | 扩缩容，不重建已有 Pod |
| 只改 `expose` / 网关端口 | `false` | `0` | Pod 不重建 |

做法固定是「先看 impact，再决定要不要挑时间窗」：

```bash
# 1) 改定义：16384 → 24576
jq '.service.resources.memoryMiB = 24576' qwen.json > qwen-24g.json

# 2) 预览：diff 应该只有一行，impact 告诉你断多久
curl -s -X POST "$API/services/qwen3-8b/preview" -H "$AUTH" \
  -H 'content-type: application/json' -d @qwen-24g.json | jq '{allowed, impact, diff}'
# 期望：{"allowed":true,"impact":{"restarts":true,"downtimeSeconds":60,...},
#        "diff":"…-  nvidia.com/gpumem: \"16384\"\n…+  nvidia.com/gpumem: \"24576\""}
# diff 里出现别的行 = 这次改多了，回第 1 步；downtimeSeconds 不是预期的数 = 先别 apply
```

```bash
# 3) 挑窗口执行，并核对「真的拿到了配额」
curl -s -X POST "$API/services/qwen3-8b/apply" -H "$AUTH" \
  -H 'content-type: application/json' -d @qwen-24g.json | jq '[.steps[] | {name, ok, detail}]'
# 期望：allocation 这一步绿。它读新 Pod 的 hami.io/vgpu-devices-allocated，
#       核对申请值真的到位——rollout 绿了但 allocation 红，就是「Pod 起来了没拿到配额」

kubectl -n inference exec <pod> -- nvidia-smi --query-gpu=memory.total --format=csv,noheader
# 期望：24576 MiB。HAMi 下容器内看到的就是配额，不是物理卡容量
# 还是旧值 = 新 Pod 没起来、旧 Pod 还在服务，去 /k8s 看 Pod 是否 Pending
```

两条硬规则：

- **单次变动超过 4 倍会被拦**（`BIG_CHANGE`）：`1024 → 8192`、`replicas 1 → 8` 都算。要么拆成两步小改动，
  要么显式带 `"force": true`；强制放行会写进 `audit.forced[]`，责任在按确认的人。
- **想少中断就先加副本**：`replicas: 1 → 2`（2 倍，不触发 `BIG_CHANGE`）→ 等新副本 `Ready`
  → 再改配额（逐个替换，约 5 秒抖动）→ 按需缩回。加副本本身要先过容量预检：多一份副本 = 多占一份显存。

### 6.8 回滚

两种入口，恢复的都是**快照里存下来的对象原样**（不是重新渲染一遍旧定义）：

| 形态 | 触发 | 看哪里 |
|---|---|---|
| 执行失败自动回滚 | `apply` 任一步 `ok:false` | `steps[]` 末尾多一条 `rollback`：`ok:true` = 已经拉回变更前；`ok:false` 会点名哪些对象没恢复，此时集群可能处于中间状态，人工核对 |
| 手动回滚 | 你调 `POST .../rollback` | 响应的 `steps[]`，每项形如 `restore:Deployment/qwen3-8b` 或 `delete:Service/qwen3-8b` |

```bash
# 有哪些服务、最后一版是什么时候
curl -s "$API/services" -H "$AUTH" | jq '.services[] | {name, version, updatedAt, last: .history[0]}'

# 回滚（取该服务最近一份快照）
curl -s -X POST "$API/services/qwen3-8b/rollback" -H "$AUTH" \
  -H 'content-type: application/json' -d '{}' | jq '{ok, steps, error}'
# 期望：{"ok":true,"steps":[{"name":"restore:Deployment/qwen3-8b","ok":true,...}],...}
# 没有快照：{"error":"没有可回滚的快照（该服务还没有成功执行过，或快照已过期）"}
#           → 没有退路，改完配置直接 apply
```

快照存在 **KV** 里（键 `infra_snapshots`），按 `namespace/name` 索引，每个服务保留最近 **5** 份；
`DELETE /api/infra/services/:id` **删定义时会连快照一起清掉**——所以「准备删定义但还想留退路」时，
先把那份 `qwen.json` 存到自己机器上。

> 回滚取的是最近一份快照；请求体里的 `version` 目前不参与选版本，别指望「回滚到 v3」。

回滚的三条边界，不知道就会误判：

- **不重新过护栏、不重新评估容量**：集群现在没地方放旧配额，回滚照样 PATCH，然后 Pod 起不来。
  回滚之后必须回 `/k8s` 看一遍 Pod 状态。
- 回滚同样**重建 Pod**、同样中断，不要指望「回滚是瞬间的」。
- 只回滚对象，不回滚数据：hostPath 上的模型文件、PVC 里的内容一律不动。

### 6.9 常见故障排查

有 `steps` 的按停在哪一步对号入座；预览阶段的按 `violations[].code` 对。

| 现象 / 判据 | 根因 | 处置 |
|---|---|---|
| 网关 Pod `CrashLoopBackOff`，日志 `nginx: [emerg] host not found in upstream "x.inference.svc.cluster.local"` | 网关配置引用了不存在的 Service（历史脏配置，或服务删了路由还在）。网关一挂，所有端口上的服务一起不可用 | 现在网关注册只接受「集群里真实存在且受管」的服务，不会再新写脏路由；已有的要手工清：`kubectl -n inference get cm reranker-gateway-conf -o yaml`，找到 `# openlog-service: <ns>/<name>` 那段，确认对应 Service 不存在后整块删掉，网关自己会起来 |
| `apply` 返回 `ok:true`，但 `gateway:{ok:false, changed:true, action:"configmap-written"}` | ConfigMap 已写入新配置，但给网关 Deployment 打 reload 注解失败 → **线上仍跑旧配置**，服务在跑、端口不通 | 不用重跑 apply（服务本身是好的）：`kubectl -n inference rollout restart deployment/reranker-gateway`，再 `kubectl -n inference rollout status deployment/reranker-gateway --timeout=120s`；然后 `kubectl -n inference get deploy reranker-gateway -o jsonpath='{.metadata.annotations.openlog\.io/nginx-reload}'` 确认注解值变过 |
| Pod 卡在 `ContainerCreating` / `FailedMount`，rollout 最后超时 | hostPath 不存在。k8s **不会**拒绝创建，只在挂载时失败，最终只表现为「rollout 超时」 | `kubectl -n inference describe pod <pod> \| grep -A3 FailedMount` 看具体路径；把 `model.path` / `cache.hostPath` 改成节点上真实存在的目录，或用 `placement.nodeSelector` 钉到有数据的节点 |
| `ImagePullBackOff` | `imagePullPolicy` 固定 `IfNotPresent`，节点上没这个镜像 | 离线环境先在**目标节点**导入：`k3s ctr images import <镜像 tar>`；或换成节点上已有的 tag |
| rollout 超时，但 Pod 是 `Running`、`ready: 0/1` | 探针没过：`health.path` 写错、`containerPort` 与引擎实际监听端口不一致、`initialDelaySeconds` 太小（模型还在加载） | `kubectl -n inference logs <pod> --tail=50` 看引擎监听在哪个端口；`health.path` 改成引擎真实的健康端点，`initialDelaySeconds` 按模型大小给到 120~300 |
| `MODEL_FOOTPRINT_EXCEEDED`，但你确信放得下 | `model.sizeMiB` 填的是**磁盘文件大小**，而引擎是卸载型的（strata `--expert-cache`、llama.cpp mmap、vLLM `--cpu-offload-gb`） | 别动配额，改口径：跑一次 bench 让实测值回填（6.6），再 preview 看 `footprint.basis` 是否变成 `measured` |
| 服务日志 `bind: address already in use`，或 Pod `Pending` 事件提到端口 | docker 里还有同名容器抢着 `hostPort`；或两个服务 expose 了同一个网关端口 | ① `ss -ltnp \| grep :<端口>` 找占端口的进程；② `docker ps --format '{{.Names}}\t{{.Ports}}' \| grep <端口>` 看是不是迁移期的旧容器（停掉，保留镜像）；③ 撞网关端口时 `apply` 返回 `gateway.conflicts`，改其中一个的 `expose.gatewayPort` |
| `apply` 返回 `403 {"error":"AI Infra 写能力未启用…"}` | 开关没开 | 按 6.2 打开并重建容器；先 `docker exec openlog env \| grep OPENLOG_K8S_INFRA` 确认到底传进去没有 |
| `apply` 返回 `409`，错误里有「已存在且不属于 OpenLog 管理」 | 同名 Deployment/Service 是别人手工 `kubectl apply` 的，没有 `managedBy=openlog-infra` 标签 | 换一个服务名；真要接管就先人工确认，再 `kubectl -n inference label deploy <name> managedBy=openlog-infra` |
| `dry-run` 步骤报 `forbidden` | 用的是只读那份 kubeconfig，或 `openlog-infra-creator` 那两段 Role 没 apply | 按 6.3 自检 `auth can-i create deployments -n inference`，然后换 operator kubeconfig 并重新 apply RBAC |

### 6.10 删除定义与清理

```bash
curl -s -X DELETE "$API/services/qwen3-8b" -H "$AUTH" | jq .
# 期望：{"ok":true,"removed":"inference/qwen3-8b","remaining":3,
#        "note":"只删除了定义记录，集群里的工作负载未受影响"}
```

**只删定义记录，不删集群里的工作负载**：Pod、Deployment、Service 都还在跑。所以要下线一个服务，
顺序是「先缩到 0，再删定义」：

```bash
# 1) 缩到 0。注意 replicas 只允许 1..8，replicas=0 会被定义校验拒掉，
#    下线是 k8s 侧动作：要么 kubectl，要么页面「K8s 集群 → 工作负载 → 扩缩容」（需 OPENLOG_K8S_WRITE=1）
kubectl -n inference scale deploy/qwen3-8b --replicas=0

# 2) 确认 Pod 全没了
kubectl -n inference get pods | grep qwen3-8b || echo '已无 Pod'

# 3) 再删定义（定义里记得先留一份 qwen.json，删定义会连快照一起清掉）
curl -s -X DELETE "$API/services/qwen3-8b" -H "$AUTH" | jq '{ok, removed}'

# 4) 需要连对象一起清掉，手工删（本层不做这件事）
kubectl -n inference delete deploy/qwen3-8b svc/qwen3-8b
```

测试命名空间用 `deploy/k8s/cluster/40-infra-test-namespace.yaml`（带 `ResourceQuota` + `LimitRange` +
入站 `NetworkPolicy`）：配额限制 `nvidia.com/gpu: 2`、`gpumem: 16384`、`gpucores: 200`，
清单写错、Pod 起不来、配额申请超量都只在 Namespace 边界内失败，不会波及 `inference` 里的真实业务。

```bash
kubectl apply -f deploy/k8s/cluster/40-infra-test-namespace.yaml
kubectl -n infra-test describe resourcequota infra-test-quota | sed -n '1,12p'
# 期望：nvidia.com/gpumem   Used 0 / Hard 16384
#       nvidia.com/gpu      Used 0 / Hard 2
```

清理前记住两件不可撤销的事：删定义会带走它的快照（6.8）；删命名空间会带走里面所有对象。

原理、估算公式、兼容矩阵见 [docs/INFRA.md](../docs/INFRA.md) 与 [docs/INFRA-COMPAT.md](../docs/INFRA-COMPAT.md)

---

## 7. 镜像归档与离线部署

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

### 一次出双平台包（Mac 为主）

策略：**开发与验证都在 Mac（Apple Silicon）上做，出包时一条命令同时导出两个架构**。
不需要在 Intel 机器上装环境，也不依赖 CI。

```bash
# 默认：当前 HEAD，amd64 + arm64 各一个包
bash deploy/scripts/make-packages.sh

# 指定发布提交 / 只出一个架构 / 复用已构建镜像
bash deploy/scripts/make-packages.sh --ref v1.2.0
bash deploy/scripts/make-packages.sh --only arm64
bash deploy/scripts/make-packages.sh --skip-build

# 只看会做什么（零副作用）
bash deploy/scripts/make-packages.sh --dry-run
```

每个架构都会跑**三重校验**，任一不过立即中止（不会产出"标着 arm64 实际是 x86"的包）：

| 检查 | amd64 期望 | arm64 期望 |
|---|---|---|
| 镜像元数据 `docker inspect` | `linux/amd64` | `linux/arm64` |
| 容器内 `process.platform/arch` | `linux/x64` | `linux/arm64` |
| better-sqlite3 的 ELF `e_machine` | `0x3e` | `0xb7` |

产物（默认落在仓库上一级目录）：

```
openlog-deploy-<sha>.tar         # linux/amd64
openlog-deploy-<sha>-arm64.tar   # linux/arm64
```

**跨架构说明**：目标架构 ≠ 宿主架构时走 QEMU 模拟（amd64 在 Mac 上约 10~15 分钟，原生模块要编译）。
两条已知的 Mac 专属坑，脚本里已经处理：

- `docker save` 在 Mac 上保存 `--platform` 拉下来的 postgres 会失败（多平台 index 缺其它平台 blob）
  → 脚本用同平台 `FROM` 重建一次，把 index 收敛成单平台镜像再归档；
- BuildKit 默认给镜像加 attestation manifest，`docker save` 同样会失败
  → 构建时统一带 `--provenance=false`。

> CI 里的 `.github/workflows/release-package.yml` 保留作**备用通道**（手动触发，x86 runner 上构建；
> arm64 需 QEMU，较慢且偶发失败），日常以 Mac 本地脚本为准。

## 8. 数据备份与恢复

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

`deploy.sh` / `install.sh` 成功结束时都会在最后打印「访问令牌」，直接从部署输出里复制即可。
需要再次查看时，令牌存在 `data/.auth_token`（bind mount，重建容器不丢）：

```bash
docker exec openlog cat /app/data/.auth_token
# 或
cat data/.auth_token
```

令牌不会写进 `backups/.last-deploy.json`（状态文件会被备份/同步，避免长期凭据扩散）；
固定令牌用 `OPENLOG_TOKEN` 环境变量，改令牌删文件重启即可（会重新生成）。

想换令牌：删文件重启（会重新生成），或用 `OPENLOG_TOKEN` 环境变量固定。

---

## 9. 回滚

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

## 10. 排障

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
docker logs openlog | grep -E '\[DB\]|数据库'
```

### PG 密码认证失败（`password authentication failed for user "openlog"`）

这是重复安装最常见的坑：**`POSTGRES_PASSWORD` 只在数据卷首次初始化时生效**。
容器被 `docker rm` 后重建、但数据卷 `openlog-pgdata` 还在，脚本换了新密码，
卷里仍是旧密码 → 应用连不上。

```bash
# 1) 读旧容器的密码（容器还在的话）
docker inspect --type container openlog-pg \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep POSTGRES_PASSWORD

# 2) 用这个密码改 deploy.env
sed -i 's#^OPENLOG_DATABASE_URL=.*#OPENLOG_DATABASE_URL=postgres://openlog:<旧密码>@127.0.0.1:5432/openlog#' deploy/deploy.env

# 3) 重起应用（不用重新构建）
bash deploy/deploy.sh --no-build

# 找不到旧密码时：旧实例的 deploy.env.bak.* 里通常还有
ls -lt deploy/deploy.env.bak.* | head

# 确认数据可丢才这么做（会清空库）
docker rm -f openlog-pg && docker volume rm openlog-pgdata
```

> 新版 `install.sh` 已经自动处理：只要 `openlog-pg` 容器还在（running 或
> stopped）就复用它的密码，并在启动前 `psql` 真连一次验证；卷里残留旧密码
> 时会直接报错并给出三条出路，不会留下「容器起来了但数据库连不上」的半死状态。

### 磁盘被镜像占满

```bash
docker images openlog --format '{{.Tag}} {{.Size}}'     # 每个约 600MB
docker image prune -f
# 长期回滚点先归档：npm run deploy:image:save
```

---

## 11. 配置项全表

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
| `OPENLOG_K8S_WRITE` | K8s 写操作（扩缩容 / 重启 / 删 Pod），`1` 开启；只认字面量 `1`（见 [第 5 节](#5-升级到新版本)） |
| `OPENLOG_K8S_INFRA` | AI Infra 能力层（模型服务编排），`1` 开启；与 `OPENLOG_K8S_WRITE` 正交，只认字面量 `1`（见 [第 6 节](#6-ai-infra-能力层模型服务编排)） |
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

## 12. 上线检查清单

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
