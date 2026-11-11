#!/usr/bin/env bash
# ─── OpenLog 离线一键部署 ───────────────────────────────────────────────
#
# 适用场景：**目标机没有外网**，只能把部署包拷进去。
# 一条命令完成：校验包 → 导入镜像 → 生成配置 → 起数据库(可选) → 启动 → 健康检查 → 打印访问信息。
#
# 用法：
#     bash deploy/install.sh                       # 默认：SQLite + 端口 3001
#     bash deploy/install.sh --port 8080           # 换端口
#     bash deploy/install.sh --with-postgres       # 用 PostgreSQL（需本机已有 postgres:16-alpine 镜像）
#     bash deploy/install.sh --db-url 'postgres://user:pw@127.0.0.1:5432/openlog'  # 用现成的 PG
#     bash deploy/install.sh --data-dir /data/openlog --container-name openlog-2 --port 3002
#     bash deploy/install.sh --port 3031 --env-file /etc/openlog/instance2.env   # 同机多实例
#     bash deploy/install.sh --dry-run             # 只打印将要做什么
#     bash deploy/install.sh --skip-load           # 跳过镜像导入（镜像已就位时）
#
# 为什么默认 SQLite：离线机器上没有 postgres 镜像就起不来 PG；SQLite 零依赖，
# 一条命令必定跑通。要 PG 就显式带上 --with-postgres / --db-url。
#
# 架构：部署包分 amd64 与 arm64 两种，install.sh 会在导入前校验架构。
# 装错架构时 docker load 会成功、docker run 才报 exec format error（且不提架构），
# 所以宁可在导入前拦住。确实要先导入备用可加 --allow-arch-mismatch。
#
# 退出码：0 成功；非 0 失败（deploy.sh 会尝试回滚）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 默认参数 ──
APP_PORT=3001
DATA_DIR="$PKG_DIR/data"
CONTAINER_NAME="openlog"
LOGS_VOLUME="openlog-logs"
DB_MODE="sqlite"          # sqlite | postgres
DB_URL=""
WITH_POSTGRES=0
SKIP_LOAD=0
# 架构不匹配时是否放行。默认拦截：装错架构的包，docker load 会成功、
# 容器一启动就 exec format error，报错信息完全不提「架构」两个字，
# 排查方向会被带偏。显式传 --allow-arch-mismatch 才允许继续（比如先导入备用）。
ALLOW_ARCH_MISMATCH=0
DRY_RUN=0
ASSUME_YES=0
PG_IMAGE="postgres:16-alpine"
PG_CONTAINER="openlog-pg"
PG_PORT=5432
PG_VOLUME="openlog-pgdata"
# 显式指定过实例参数（端口/容器名/数据目录/数据库）时，必须重写 deploy.env，
# 否则会静默沿用旧配置 —— 实测踩到：用 --port 3031 --container-name xxx --with-postgres
# 起「第二个实例」，结果 deploy.sh 仍按旧 deploy.env 在 3001 上重建了第一个实例，
# 健康检查也打到了第一个实例，看起来"成功"其实什么都没改。
EXPLICIT_CONFIG=0
# 每实例独立的配置文件（默认 deploy/deploy.env）。
# 一个包目录跑多个实例时必须分开，否则后一次会覆盖前一次的配置。
ENV_FILE_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port)            APP_PORT="$2"; EXPLICIT_CONFIG=1; shift 2 ;;
    --data-dir)        DATA_DIR="$2"; EXPLICIT_CONFIG=1; shift 2 ;;
    --container-name)  CONTAINER_NAME="$2"; EXPLICIT_CONFIG=1; shift 2 ;;
    --logs-volume)     LOGS_VOLUME="$2"; shift 2 ;;
    --with-postgres)   WITH_POSTGRES=1; DB_MODE="postgres"; EXPLICIT_CONFIG=1; shift ;;
    --pg-container)    PG_CONTAINER="$2"; shift 2 ;;
    --pg-port)         PG_PORT="$2"; shift 2 ;;
    --pg-volume)       PG_VOLUME="$2"; shift 2 ;;
    --env-file)        ENV_FILE_OVERRIDE="$2"; EXPLICIT_CONFIG=1; shift 2 ;;
    --db-url)          DB_URL="$2"; DB_MODE="postgres"; EXPLICIT_CONFIG=1; shift 2 ;;
    --image)           IMAGE_ARCHIVE="$2"; shift 2 ;;
    --skip-load)       SKIP_LOAD=1; shift ;;
    --allow-arch-mismatch) ALLOW_ARCH_MISMATCH=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --yes|-y)          ASSUME_YES=1; shift ;;
    -h|--help)         sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（用 --help 看用法）"; exit 1 ;;
  esac
done

run() { if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] $*"; else eval "$@"; fi }
log() { echo -e "\n▶ $*"; }
ok()  { echo "  ✅ $*"; }
warn(){ echo "  ⚠️  $*"; }
die() { echo "  ❌ $*" >&2; exit 1; }

# 用「真的连一次 TCP」验证 PG 密码，而不是只信容器里的 env。
# 原因：POSTGRES_PASSWORD 只在数据卷首次初始化时生效；卷里残留旧密码时，
# env 看起来是对的、实际认证会失败（app 侧报 password authentication failed）。
pg_auth_ok() {
  local container="$1" pw="$2"
  docker exec -e PGPASSWORD="$pw" "$container" \
    psql -h 127.0.0.1 -U openlog -d openlog -c 'select 1' >/dev/null 2>&1
}

echo "=================================================="
echo "  OpenLog 离线一键部署"
echo "=================================================="
echo "  部署包:     $PKG_DIR"
echo "  容器名:     $CONTAINER_NAME"
echo "  端口:       $APP_PORT"
echo "  数据目录:   $DATA_DIR"
echo "  数据库:     $([ "$DB_MODE" = "postgres" ] && echo "PostgreSQL" || echo "SQLite（零依赖）")"

# ── 1. 前置检查 ──
log "检查环境"
command -v docker >/dev/null 2>&1 || die "没装 docker"
docker info >/dev/null 2>&1 || die "docker 守护进程不可用（服务没起或当前用户无权限）"
command -v tar >/dev/null 2>&1 || die "没装 tar"
DOCKER_VER="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
ok "docker $DOCKER_VER"
# 19.03 及更早没有 `docker compose` 子命令（20.10+ 才是官方 v2 插件）。
# 本脚本用纯 docker run，不需要 compose —— 这里只把差异说清楚，免得你以为必须装 compose。
# ⚠️ 此行文案不能带反引号：它在双引号里会被 shell 当命令替换执行（实测会打印
#    "docker: 'compose' is not a docker command."）。
DOCKER_MAJOR="${DOCKER_VER%%.*}"
case "$DOCKER_MAJOR" in
  ''|*[!0-9]*) DOCKER_MAJOR=0 ;;
esac
if [ "$DOCKER_MAJOR" -lt 20 ]; then
  warn "docker $DOCKER_VER 没有 docker compose 子命令（需 20.10+）；本脚本不需要 compose，继续"
  warn "如确实要用 compose，请用 deploy/docker-compose.offline.yml（格式 2.4，兼容 docker-compose v1）"
fi
for tool in curl wget; do
  command -v "$tool" >/dev/null 2>&1 && { ok "健康检查用 $tool"; break; }
done || warn "宿主机没有 curl/wget，健康检查会退回到容器内 node（仍可用）"

# ── 2. 找镜像归档 ──
log "定位镜像归档"
if [ -z "${IMAGE_ARCHIVE:-}" ]; then
  IMAGE_ARCHIVE="$(ls -1t "$SCRIPT_DIR"/images/openlog-*.tar.gz 2>/dev/null | head -1 || true)"
fi
[ -n "${IMAGE_ARCHIVE:-}" ] || die "deploy/images/ 下没有 openlog-*.tar.gz，请确认部署包完整（或用 --image 指定）"
[ -f "$IMAGE_ARCHIVE" ] || die "镜像归档不存在: $IMAGE_ARCHIVE"
ok "$(basename "$IMAGE_ARCHIVE")（$(du -hL "$IMAGE_ARCHIVE" 2>/dev/null | cut -f1 || echo "?")）"

# ── 3. 校验（有 SHA256SUMS 就校验）──
if [ -f "$PKG_DIR/SHA256SUMS" ]; then
  log "校验镜像完整性"
  expected="$(grep -F "$(basename "$IMAGE_ARCHIVE")" "$PKG_DIR/SHA256SUMS" | awk '{print $1}' | head -1 || true)"
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$IMAGE_ARCHIVE" | awk '{print $1}')"
      [ "$expected" = "$actual" ] && ok "sha256 一致 (${actual:0:16}…)" || die "sha256 不匹配，包可能在传输中损坏"
    else
      warn "没有 sha256sum，跳过校验"
    fi
  fi
fi

# ── 4. 导入镜像 ──
IMAGE_TAG="$(basename "$IMAGE_ARCHIVE" | sed -E 's/^openlog-([0-9a-f]+)-.*/\1/')"

# ── 4.1 架构自检（必须在 docker tag latest 之前）──
# 为什么在这里而不是启动之后：装错架构时 docker load 完全成功，
# 直到 docker run 才报 "exec format error"，而那行错误里没有 architecture 字样，
# 人的第一反应会是"镜像坏了""文件权限不对"，不会想到是架构。
# 更隐蔽的是：报错发生在容器启动，而此时 install.sh 已经改好了 deploy.env ——
# 现场被污染，回滚后残留的配置还会影响下一次安装。
# 所以在打 latest tag、写任何配置之前拦下来。
host_arch() {
  local a
  a="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"
  [ -n "$a" ] || a="$(uname -m 2>/dev/null || echo unknown)"
  case "$a" in
    x86_64|amd64)   echo amd64 ;;
    aarch64|arm64|armv8*) echo arm64 ;;
    armv7*|armhf)   echo arm ;;
    *)              echo "$a" ;;
  esac
}

# docker save 出来的 tar 里，镜像的实际架构写在 config json 的 architecture 字段。
# 不能直接 tar -xOf | grep：tar 里除了 config json 还有 layer.tar 等二进制，
# grep 会把整个流当二进制处理，输出 "Binary file (standard input) matches" 而不是字段值。
# 正确顺序是：先读 manifest.json 拿 Config 文件名 → 只解那个文件 → 取 architecture。
# manifest.json 是 docker save 的固定产出（没有它连 docker load 都不成立）。
archive_arch() {
  local f="$1" cfg a=""
  command -v tar >/dev/null 2>&1 || { echo ""; return; }
  # 从 manifest.json 里抠出 Config 字段（"Config":"<file>.json"）
  cfg="$(tar -xzOf "$f" manifest.json 2>/dev/null \
         | tr -d '\000' \
         | grep -o '"Config"[[:space:]]*:[[:space:]]*"[^"]*"' \
         | head -1 \
         | sed -E 's/.*"([^"]*)"$/\1/')" || true

  if [ -n "$cfg" ]; then
    a="$(tar -xzOf "$f" "$cfg" 2>/dev/null \
          | tr -d '\000' \
          | grep -o '"architecture"[[:space:]]*:[[:space:]]*"[^"]*"' \
          | head -1 \
          | sed -E 's/.*"([^"]*)"$/\1/')" || true
  fi

  # 兜底：manifest 缺失或格式变化时，退回到扫所有顶层 .json
  if [ -z "$a" ]; then
    a="$(tar -xzOf "$f" --wildcards '*.json' 2>/dev/null \
          | tr -d '\000' \
          | grep -o '"architecture"[[:space:]]*:[[:space:]]*"[^"]*"' \
          | head -1 \
          | sed -E 's/.*"([^"]*)"$/\1/')" || true
  fi

  echo "$a"
}

check_arch() {
  local label="$1" want="$2" got="$3"
  [ -n "$got" ] || { warn "$label 架构未知，跳过校验"; return 0; }
  [ "$want" = "$got" ] && { ok "$label 架构匹配 ($got)"; return 0; }
  if [ "$ALLOW_ARCH_MISMATCH" = "1" ]; then
    warn "$label 架构不匹配：包=$got / 本机=$want（--allow-arch-mismatch 已显式放行）"
    return 0
  fi
  cat >&2 <<EOF
  ❌ $label 架构不匹配
       本机: $want
       包内: $got

  这个部署包是给 $got 机器的，装到 $want 上会在 docker run 阶段
  报 "exec format error"，而该报错不会提到架构。

  请换用对应架构的包：
       amd64 (x86_64) → openlog-deploy-*.tar          （镜像文件名不含 -arm64）
       arm64 (AArch64) → openlog-deploy-*-arm64.tar

  如确实要先导入备用，加 --allow-arch-mismatch
EOF
  exit 1
}

HOST_ARCH="$(host_arch)"
CHECK_ARCH=1
[ "$SKIP_LOAD" = "1" ] && CHECK_ARCH=0
if [ "$CHECK_ARCH" = "1" ]; then
  log "校验镜像架构"
  check_arch "应用镜像" "$HOST_ARCH" "$(archive_arch "$IMAGE_ARCHIVE")"
fi

if [ "$SKIP_LOAD" = "1" ]; then
  warn "跳过镜像导入（--skip-load）"
else
  log "导入镜像（约 1 分钟）"
  run "docker load -i '$IMAGE_ARCHIVE'"
  ok "已导入 openlog:$IMAGE_TAG"
  # 导入后再用镜像元数据复核一次：tar 里若有多个 config json，
  # 上面的 grep 可能取到别的层，这里以真正加载进来的镜像为准。
  if [ "$DRY_RUN" != "1" ]; then
    LOADED_ARCH="$(docker image inspect "openlog:$IMAGE_TAG" --format '{{.Architecture}}' 2>/dev/null || true)"
    check_arch "已导入镜像" "$HOST_ARCH" "$LOADED_ARCH"
  fi
fi
# deploy.sh --no-build 用 latest，这里补 tag
run "docker tag 'openlog:$IMAGE_TAG' 'openlog:latest'"
ok "已打 tag openlog:latest → $IMAGE_TAG"

# ── 5. PostgreSQL（可选）──
if [ "$DB_MODE" = "postgres" ]; then
  if [ -z "$DB_URL" ]; then
    log "准备 PostgreSQL"
    # 关键：只要容器「存在」（running 或 stopped）就必须复用它原来的密码。
    # 原因：POSTGRES_PASSWORD 只在数据卷**首次初始化**时生效，卷里已有数据时
    # 换新密码不会改库里的密码 → 应用侧报
    # "PostgreSQL: password authentication failed for user openlog"。
    # 真实踩到：重复跑安装（或 docker rm 容器但没删卷）时，脚本生成新密码 + 老数据卷。
    if docker inspect --type container "$PG_CONTAINER" >/dev/null 2>&1; then
      EXISTING_PW="$(docker inspect --type container "$PG_CONTAINER" \
        --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
        | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)"
      if [ -z "$EXISTING_PW" ]; then
        die "已有 $PG_CONTAINER 容器，但读不到它的 POSTGRES_PASSWORD。
     请改用 --db-url 'postgres://openlog:<密码>@127.0.0.1:$PG_PORT/openlog' 显式提供连接串。"
      fi
      ok "复用已有 $PG_CONTAINER 容器的密码（不重建，避免认证失配）"
      if [ "$DRY_RUN" = "0" ]; then
        docker start "$PG_CONTAINER" >/dev/null 2>&1 || true
        echo "  等待 PostgreSQL 就绪..."
        for i in $(seq 1 40); do
          if docker exec "$PG_CONTAINER" pg_isready -U openlog -d openlog >/dev/null 2>&1; then break; fi
          sleep 1
        done
        docker exec "$PG_CONTAINER" pg_isready -U openlog -d openlog >/dev/null 2>&1 \
          || die "复用的 $PG_CONTAINER 容器没起来，检查 docker logs $PG_CONTAINER"
      fi
      DB_URL="postgres://openlog:${EXISTING_PW}@127.0.0.1:${PG_PORT}/openlog"
      # 再验一次真连：容器 env 里记的密码不一定等于数据卷里的密码
      if [ "$DRY_RUN" = "0" ] && ! pg_auth_ok "$PG_CONTAINER" "$EXISTING_PW"; then
        die "复用到的密码认证失败：$PG_CONTAINER 的 env 密码与数据卷里的密码不一致。
     解决其一：
       1) 用 --db-url 'postgres://openlog:<正确密码>@127.0.0.1:$PG_PORT/openlog' 提供正确密码；
       2) 旧实例的 deploy.env 里存着当初的 OPENLOG_DATABASE_URL，可以从那里找密码；
       3) 确认数据可丢：docker rm -f $PG_CONTAINER && docker volume rm $PG_VOLUME 后重跑（会重建空库）。"
      fi
      ok "PostgreSQL 已就绪（复用原密码）"
    else
      # 没有容器但数据卷还在：卷里的旧密码无从得知，新建容器换密码一样会认证失败。
      PG_VOL_MOUNT="$(docker volume inspect "$PG_VOLUME" --format '{{.Mountpoint}}' 2>/dev/null || true)"
      if [ "$DRY_RUN" = "0" ] && [ -n "$PG_VOL_MOUNT" ] && [ -n "$(ls -A "$PG_VOL_MOUNT" 2>/dev/null)" ]; then
        die "数据卷 $PG_VOLUME 里已有 PostgreSQL 数据，但对应容器已删除，无法得知旧密码。
     解决其一：
       1) 用 --db-url 'postgres://openlog:<旧密码>@127.0.0.1:$PG_PORT/openlog' 提供旧密码；
       2) 确认数据可丢：docker volume rm $PG_VOLUME 后重跑本脚本（会重建空库）；
       3) 不用 PG：去掉 --with-postgres 走默认 SQLite。"
      fi
      if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
        # 部署包里带了 PG 镜像就自动导入（离线机器没法 docker pull）
        PG_ARCHIVE="$(ls -1t "$SCRIPT_DIR"/images/postgres-*.tar.gz 2>/dev/null | head -1 || true)"
        if [ -n "$PG_ARCHIVE" ] && [ "$DRY_RUN" = "0" ]; then
          # PG 镜像同样要过架构检查：应用镜像对、PG 镜像错了，
          # 表现是 openlog-pg 容器反复重启，而应用侧只报连接被拒。
          check_arch "PostgreSQL 镜像" "$HOST_ARCH" "$(archive_arch "$PG_ARCHIVE")"
          echo "  导入 PostgreSQL 镜像 $(basename "$PG_ARCHIVE")（约 1 分钟）..."
          docker load -i "$PG_ARCHIVE" >/dev/null
          ok "已导入 $PG_IMAGE"
        fi
      fi
      if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
        # 兜底：机器有外网时直接拉（离线机器会失败，属于预期）
        warn "本机没有 $PG_IMAGE，尝试 docker pull（无外网会失败）"
        if docker pull "$PG_IMAGE" >/dev/null 2>&1; then
          ok "已拉取 $PG_IMAGE"
        fi
      fi
      if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
        die "本机没有 $PG_IMAGE 镜像，且无法拉取（离线环境）。
     解决其一：
       1) 把 deploy/images/postgres-16-alpine.tar.gz 一起拷进来（本部署包默认已包含），
          重跑本脚本会自动 docker load；
       2) 手动 docker load -i postgres-16-alpine.tar.gz 后重跑；
       3) 不用 PG，去掉 --with-postgres 走默认 SQLite。"
      fi
      PG_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
      run "docker volume create '$PG_VOLUME' >/dev/null 2>&1 || true"
      run "docker rm -f '$PG_CONTAINER' >/dev/null 2>&1 || true"
      run "docker run -d --name '$PG_CONTAINER' --restart unless-stopped \
        -e POSTGRES_USER=openlog -e POSTGRES_PASSWORD='$PG_PASSWORD' -e POSTGRES_DB=openlog \
        -v '$PG_VOLUME':/var/lib/postgresql/data -p 127.0.0.1:$PG_PORT:5432 '$PG_IMAGE' >/dev/null"
      echo "  等待 PostgreSQL 就绪..."
      for i in $(seq 1 40); do
        if docker exec "$PG_CONTAINER" pg_isready -U openlog -d openlog >/dev/null 2>&1; then break; fi
        sleep 1
      done
      DB_URL="postgres://openlog:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/openlog"
      if [ "$DRY_RUN" = "0" ] && ! pg_auth_ok "$PG_CONTAINER" "$PG_PASSWORD"; then
        die "新建的 $PG_CONTAINER 认证失败（数据卷 $PG_VOLUME 里可能有旧密码）。
     解决其一：
       1) 用 --db-url 'postgres://openlog:<正确密码>@127.0.0.1:$PG_PORT/openlog' 提供正确密码；
       2) 确认数据可丢：docker rm -f $PG_CONTAINER && docker volume rm $PG_VOLUME 后重跑（会重建空库）；
       3) 不用 PG：去掉 --with-postgres 走默认 SQLite。"
      fi
      ok "PostgreSQL 已就绪（密码已写入 deploy.env）"
    fi
  else
    ok "使用提供的 PG 连接串"
  fi
fi

# ── 6. 生成 deploy.env ──
if [ -n "$ENV_FILE_OVERRIDE" ]; then
  ENV_FILE="$ENV_FILE_OVERRIDE"
else
  ENV_FILE="$SCRIPT_DIR/deploy.env"
fi
if [ -f "$ENV_FILE" ] && [ "$EXPLICIT_CONFIG" = "1" ]; then
  # 显式指定了参数：备份旧配置后重写，保证命令行参数真正生效
  ENV_BACKUP="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$ENV_FILE" "$ENV_BACKUP"
  warn "deploy.env 已存在，已备份到 $(basename "$ENV_BACKUP")，按本次参数重写"
  rm -f "$ENV_FILE"
  NEED_WRITE=1
elif [ -f "$ENV_FILE" ]; then
  warn "deploy.env 已存在，保留不动（想按新参数重建实例，请显式传 --port/--container-name/--with-postgres 等）"
  NEED_WRITE=0
else
  NEED_WRITE=1
fi
if [ "$NEED_WRITE" = "1" ]; then
  log "生成部署配置 $ENV_FILE"
  {
    echo "# 由 deploy/install.sh 于 $(date '+%Y-%m-%d %H:%M:%S') 生成"
    echo "APP_PORT=$APP_PORT"
    echo "HOST_BIND=0.0.0.0"
    echo "DATA_DIR=$DATA_DIR"
    echo "LOGS_VOLUME=$LOGS_VOLUME"
    echo "NETWORK_MODE=host"
    echo "CONTAINER_NAME=$CONTAINER_NAME"
    echo ""
    if [ "$DB_MODE" = "postgres" ]; then
      echo "OPENLOG_DB_TYPE=postgres"
      echo "OPENLOG_DATABASE_URL=$DB_URL"
      echo "OPENLOG_PG_POOL_MAX=10"
    else
      echo "# 留空 = SQLite（数据在 \$DATA_DIR/openlog.db），离线环境零依赖"
      echo "# OPENLOG_DB_TYPE=postgres"
    fi
    echo ""
    echo "OPENLOG_ENABLE_CONTAINER_EXEC=1"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "已生成（端口 $APP_PORT，数据库 $DB_MODE）"
fi

run "mkdir -p '$DATA_DIR'"

# ── 7. 部署（deploy.sh 负责备份/启动/健康检查/失败回滚）──
log "启动服务"
if [ "$DRY_RUN" = "1" ]; then
  echo "  [dry-run] bash $SCRIPT_DIR/deploy.sh --no-build --skip-backup"
else
  if ! DEPLOY_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/deploy.sh" --no-build --skip-backup; then
    echo ""
    warn "deploy.sh 非零退出。若报错发生在「启动容器」之前，并没有发生回滚（首次部署本就没有上一个镜像）。"
    if docker inspect --type container "$CONTAINER_NAME" >/dev/null 2>&1; then
      warn "容器存在，最后 20 行日志："
      docker logs --tail 20 "$CONTAINER_NAME" 2>&1 | sed 's/^/    /'
    else
      warn "容器未创建，说明失败在启动之前；请把上面输出完整贴出来排查。"
    fi
    die "部署失败"
  fi
fi

# ── 8. 打印结果 ──
if [ "$DRY_RUN" = "1" ]; then
  log "dry-run 结束（未做任何改动）"
  exit 0
fi

log "部署完成"
IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "$IP" ] || IP="<本机IP>"
TOKEN="$(docker exec "$CONTAINER_NAME" cat /app/data/.auth_token 2>/dev/null || true)"

echo ""
echo "=================================================="
echo "  访问地址: http://$IP:$APP_PORT/"
echo "  访问令牌: ${TOKEN:-（见 $DATA_DIR/.auth_token）}"
echo "  数据目录: $DATA_DIR"
echo "  容器名  : $CONTAINER_NAME"
echo "  镜像版本: openlog:$IMAGE_TAG"
echo "  数据库  : $DB_MODE"
echo "=================================================="
echo ""
echo "常用命令："
echo "  看状态   : docker ps --filter name=$CONTAINER_NAME"
echo "  看日志   : docker logs --tail 50 -f $CONTAINER_NAME"
echo "  重启     : bash $SCRIPT_DIR/deploy.sh --no-build"
echo "  查看记录 : cat $(dirname "$SCRIPT_DIR")/backups/.last-deploy.json"
echo "  健康检查 : bash -c 'curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:$APP_PORT/'"
echo ""
echo "下一步：浏览器打开上面的地址，输入令牌；然后在「设置」里填模型 API（Base URL + Key）。"
