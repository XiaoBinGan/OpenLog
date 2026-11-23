# 📖 OpenLog 部署手册

面向「这台机器要跑 OpenLog」的完整操作手册。按顺序看即可；日常更新直接跳到
[第 4 节](#4-日常更新一键部署)。

- [1. 架构与前置条件](#1-架构与前置条件)
- [2. 目录与配置文件](#2-目录与配置文件)
- [3. 首次部署](#3-首次部署)
- [4. 日常更新（一键部署）](#4-日常更新一键部署)
- [5. 升级到新版本](#5-升级到新版本)
- [6. 镜像归档与离线部署](#6-镜像归档与离线部署)
- [7. 数据备份与恢复](#7-数据备份与恢复)
- [8. 回滚](#8-回滚)
- [9. 排障](#9-排障)
- [10. 配置项全表](#10-配置项全表)
- [11. 上线检查清单](#11-上线检查清单)

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

完整字段说明见 [第 10 节](#10-配置项全表)。

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
ls -lt backups/ | head -3                     # 最近一份 openlog-pg-*.sql.gz（第 7 节）
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

> 升级是单向前进的：升级到 v1.1.x 之后要降回 v1.0.x，按 [第 8 节](#8-回滚) 回滚到升级前的镜像，
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

自动回滚没兜住，或健康检查过了但业务不对，手动回（详细版在 [第 8 节](#8-回滚)）：

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
  正常快进部署没有这个分支，回滚走 A / B，或者用 [第 6 节](#6-镜像归档与离线部署) 的镜像归档。
- 只有数据被写坏才恢复数据库（[第 7 节](#7-数据备份与恢复)）；单纯代码回滚不要顺手恢复，
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

- **403 / `forbidden`**：报错会带上缺的 verb + resource，对着 `deploy/k8s/README.md` 第三节的表补规则，
  仍然只加 `get` / `list` / `watch`；注意 `pods/log` 要单独给（`get pods` 不包含日志子资源）。
- **连不上 / 401**：`ECONNREFUSED` / `ETIMEDOUT` 是 `--server` 地址或 6443 不可达（跨机部署时别填 `127.0.0.1`）；
  证书不匹配要给 apiserver 加 SAN；`Unauthorized` 是 token 失效，重跑第 2~3 步重新生成。
- **k3s**：kubectl 用 `sudo kubectl` 或 `sudo k3s kubectl`，集群配置在 `/etc/rancher/k3s/k3s.yaml`。
- 完整权限模型（明确不给 `secrets`、`pods/exec`、任何写动词）、token 轮换与 403 对照表：
  `deploy/k8s/README.md`。

---

## 6. 镜像归档与离线部署

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

## 7. 数据备份与恢复

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

## 8. 回滚

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

## 9. 排障

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

## 10. 配置项全表

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

## 11. 上线检查清单

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
