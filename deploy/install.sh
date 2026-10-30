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
#     bash deploy/install.sh --dry-run             # 只打印将要做什么
#
# 为什么默认 SQLite：离线机器上没有 postgres 镜像就起不来 PG；SQLite 零依赖，
# 一条命令必定跑通。要 PG 就显式带上 --with-postgres / --db-url。
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
DRY_RUN=0
ASSUME_YES=0
PG_IMAGE="postgres:16-alpine"
PG_CONTAINER="openlog-pg"
PG_PORT=5432
PG_VOLUME="openlog-pgdata"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)            APP_PORT="$2"; shift 2 ;;
    --data-dir)        DATA_DIR="$2"; shift 2 ;;
    --container-name)  CONTAINER_NAME="$2"; shift 2 ;;
    --logs-volume)     LOGS_VOLUME="$2"; shift 2 ;;
    --with-postgres)   WITH_POSTGRES=1; DB_MODE="postgres"; shift ;;
    --pg-container)    PG_CONTAINER="$2"; shift 2 ;;
    --pg-port)         PG_PORT="$2"; shift 2 ;;
    --pg-volume)       PG_VOLUME="$2"; shift 2 ;;
    --db-url)          DB_URL="$2"; DB_MODE="postgres"; shift 2 ;;
    --image)           IMAGE_ARCHIVE="$2"; shift 2 ;;
    --skip-load)       SKIP_LOAD=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --yes|-y)          ASSUME_YES=1; shift ;;
    -h|--help)         sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（用 --help 看用法）"; exit 1 ;;
  esac
done

run() { if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] $*"; else eval "$@"; fi }
log() { echo -e "\n▶ $*"; }
ok()  { echo "  ✅ $*"; }
warn(){ echo "  ⚠️  $*"; }
die() { echo "  ❌ $*" >&2; exit 1; }

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
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
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
ok "$(basename "$IMAGE_ARCHIVE")（$(du -h "$IMAGE_ARCHIVE" | cut -f1)）"

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
if [ "$SKIP_LOAD" = "1" ]; then
  warn "跳过镜像导入（--skip-load）"
else
  log "导入镜像（约 1 分钟）"
  run "docker load -i '$IMAGE_ARCHIVE'"
  ok "已导入 openlog:$IMAGE_TAG"
fi
# deploy.sh --no-build 用 latest，这里补 tag
run "docker tag 'openlog:$IMAGE_TAG' 'openlog:latest'"
ok "已打 tag openlog:latest → $IMAGE_TAG"

# ── 5. PostgreSQL（可选）──
if [ "$DB_MODE" = "postgres" ]; then
  if [ -z "$DB_URL" ]; then
    log "准备 PostgreSQL"
    if docker ps --filter "name=^$PG_CONTAINER$" --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
      ok "已有运行中的 openlog-pg 容器"
      warn "请用 --db-url 显式提供连接串（或先自己设置）"
      die "需要知道现有 PG 的密码；请改用 --db-url 'postgres://user:pw@127.0.0.1:5432/openlog'"
    fi
    if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
      # 部署包里带了 PG 镜像就自动导入（离线机器没法 docker pull）
      PG_ARCHIVE="$(ls -1t "$SCRIPT_DIR"/images/postgres-*.tar.gz 2>/dev/null | head -1 || true)"
      if [ -n "$PG_ARCHIVE" ] && [ "$DRY_RUN" = "0" ]; then
        echo "  导入 PostgreSQL 镜像 $(basename "$PG_ARCHIVE")（约 1 分钟）..."
        docker load -i "$PG_ARCHIVE" >/dev/null
        ok "已导入 $PG_IMAGE"
      fi
    fi
    if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
      die "本机没有 $PG_IMAGE 镜像（离线机器无法拉取）。
     解决：把 deploy/images/postgres-16-alpine.tar.gz 一起拷进来（本部署包默认已包含），
           或手动 docker load -i postgres-16-alpine.tar.gz；
           也可以直接用默认 SQLite（去掉 --with-postgres）。"
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
    ok "PostgreSQL 已就绪（密码已写入 deploy.env）"
  else
    ok "使用提供的 PG 连接串"
  fi
fi

# ── 6. 生成 deploy.env ──
ENV_FILE="$SCRIPT_DIR/deploy.env"
if [ -f "$ENV_FILE" ]; then
  warn "deploy.env 已存在，保留不动（删掉它可重新生成）"
else
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
  if ! bash "$SCRIPT_DIR/deploy.sh" --no-build --skip-backup; then
    die "部署失败（deploy.sh 已尝试回滚）。排查：docker logs --tail 80 $CONTAINER_NAME"
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
