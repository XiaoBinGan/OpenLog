#!/usr/bin/env bash
# ─── OpenLog 服务端一键部署脚本 ───────────────────────────────────────────
#
# 在服务器上执行（通常由 scripts/deploy.mjs 从开发机远程调用）：
#     bash scripts/deploy.sh
#
# 它做完整的一套，任何一步失败都不会留下半拉子状态：
#   1. 读配置（deploy.env，含数据库连接串等敏感信息，不进 git）
#   2. 备份数据库（PostgreSQL → pg_dump；SQLite → 复制 db/wal）
#   3. 构建镜像，打两个 tag：openlog:<短commit> + openlog:latest
#   4. 用新镜像启动容器（配置全部来自 deploy.env，不再手写一堆 -e）
#   5. 健康检查（页面 200 + /api/db/info ok + 延迟合理），最多等 90s
#   6. 健康检查失败 → **自动回滚**到上一个正常镜像并重启
#   7. 清理旧镜像（保留最近 N 个）
#
# 用法：
#   bash scripts/deploy.sh                 # 正常部署（当前工作区代码）
#   bash scripts/deploy.sh --no-build      # 只重启容器（改配置后用）
#   bash scripts/deploy.sh --skip-backup   # 跳过数据库备份
#   bash scripts/deploy.sh --dry-run       # 只打印将要执行的动作
#
# 退出码：0 = 部署成功；非 0 = 失败（已尝试回滚）

set -euo pipefail

# ─── 路径与配置 ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

CONFIG_FILE="${DEPLOY_ENV_FILE:-$APP_DIR/deploy.env}"
BACKUP_DIR="$APP_DIR/backups"
STATE_FILE="$BACKUP_DIR/.last-deploy.json"
IMAGE_NAME="openlog"
CONTAINER_NAME="openlog"
KEEP_IMAGES="${KEEP_IMAGES:-5}"

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$CONFIG_FILE"; set +a
else
  echo "❌ 缺少配置文件: $CONFIG_FILE"
  echo "   从 deploy.env.example 复制一份并填写（含数据库连接串，不要提交到 git）"
  exit 1
fi

# 默认值
APP_PORT="${APP_PORT:-3001}"
HOST_BIND="${HOST_BIND:-0.0.0.0}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
LOGS_VOLUME="${LOGS_VOLUME:-openlog-logs}"
NETWORK_MODE="${NETWORK_MODE:-host}"
EXTRA_ENV="${EXTRA_ENV:-}"

NO_BUILD=0
SKIP_BACKUP=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-build)    NO_BUILD=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] $*"
  else
    eval "$@"
  fi
}

log()  { echo -e "\n▶ $*"; }
ok()   { echo "  ✅ $*"; }
warn() { echo "  ⚠️  $*"; }
die()  { echo "  ❌ $*" >&2; exit 1; }

# ─── 0. 环境检查 ───────────────────────────────────────────────────────
log "检查环境"
command -v docker >/dev/null || die "没装 docker"
docker info >/dev/null 2>&1 || die "docker 守护进程不可用"
SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "nogit")"
NEW_IMAGE="$IMAGE_NAME:$SHORT_SHA"
ok "代码版本: $SHORT_SHA"
ok "配置文件: $CONFIG_FILE"

# 数据库类型（默认 sqlite）
DB_TYPE="${OPENLOG_DB_TYPE:-sqlite}"
ok "数据库: $DB_TYPE"

# ─── 1. 备份 ───────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
if [ "$SKIP_BACKUP" = "1" ]; then
  warn "跳过备份（--skip-backup）"
elif [ "$DB_TYPE" = "postgres" ]; then
  log "备份 PostgreSQL"
  if docker ps --format '{{.Names}}' | grep -qx "openlog-pg"; then
    PG_FILE="$BACKUP_DIR/openlog-pg-$(date +%Y%m%d-%H%M%S).sql.gz"
    run "docker exec openlog-pg pg_dump -U \${PG_USER:-openlog} -d \${PG_DATABASE:-openlog} | gzip > '$PG_FILE'"
    run "ls -la '$PG_FILE' | awk '{print \"  ✅ \" \$5 \" bytes → \" \$9}'"
    # 只保留最近 10 份
    run "ls -1t $BACKUP_DIR/openlog-pg-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f"
  else
    warn "没找到 openlog-pg 容器，跳过 PG 备份"
  fi
else
  log "备份 SQLite"
  if [ -f "$DATA_DIR/openlog.db" ]; then
    DB_FILE="$BACKUP_DIR/openlog-sqlite-$(date +%Y%m%d-%H%M%S).db"
    # 用 sqlite3 的在线备份（若可用），否则直接复制（WAL 模式下先落盘）
    if command -v sqlite3 >/dev/null 2>&1; then
      run "sqlite3 '$DATA_DIR/openlog.db' \".backup '$DB_FILE'\""
    else
      run "cp -p '$DATA_DIR/openlog.db' '$DB_FILE'"
    fi
    run "ls -la '$DB_FILE' | awk '{print \"  ✅ \" \$5 \" bytes → \" \$9}'"
    run "ls -1t $BACKUP_DIR/openlog-sqlite-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f"
  else
    warn "没有 SQLite 文件，跳过"
  fi
fi

# 记录当前镜像，供回滚
PREV_IMAGE=""
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  PREV_IMAGE="$(docker inspect "$CONTAINER_NAME" --format '{{.Image}}')"
  echo "  当前镜像: $PREV_IMAGE"
fi

# ─── 2. 构建镜像 ───────────────────────────────────────────────────────
if [ "$NO_BUILD" = "1" ]; then
  warn "跳过构建（--no-build）"
  CREATED=$(docker images -q "$IMAGE_NAME:latest" | head -1)
  [ -n "$CREATED" ] || die "没有可用的 $IMAGE_NAME:latest 镜像，不能跳过构建"
  NEW_IMAGE="$IMAGE_NAME:latest"
else
  log "构建镜像 $NEW_IMAGE"
  # CACHE_BUST 用 commit 保证代码变了就重新编译，而不是吃旧层缓存
  run "docker build --build-arg CACHE_BUST=$SHORT_SHA -t '$NEW_IMAGE' -t '$IMAGE_NAME:latest' '$APP_DIR'" \
    || die "镜像构建失败（旧容器未受影响）"
  ok "镜像构建完成"
fi

# ─── 3. 启动新容器 ─────────────────────────────────────────────────────
log "启动容器"
ENV_ARGS=(
  -e "NODE_ENV=production"
  -e "PORT=$APP_PORT"
  -e "HOST=$HOST_BIND"
)
# 数据库配置（原样从 deploy.env 透传）
[ -n "${OPENLOG_DB_TYPE:-}"          ] && ENV_ARGS+=(-e "OPENLOG_DB_TYPE=$OPENLOG_DB_TYPE")
[ -n "${OPENLOG_DATABASE_URL:-}"     ] && ENV_ARGS+=(-e "OPENLOG_DATABASE_URL=$OPENLOG_DATABASE_URL")
[ -n "${OPENLOG_PG_POOL_MAX:-}"      ] && ENV_ARGS+=(-e "OPENLOG_PG_POOL_MAX=$OPENLOG_PG_POOL_MAX")
# 功能开关
[ -n "${OPENLOG_ENABLE_CONTAINER_EXEC:-}" ] && ENV_ARGS+=(-e "OPENLOG_ENABLE_CONTAINER_EXEC=$OPENLOG_ENABLE_CONTAINER_EXEC")
[ -n "${OPENLOG_ENABLE_REMOTE_EXEC:-}"    ] && ENV_ARGS+=(-e "OPENLOG_ENABLE_REMOTE_EXEC=$OPENLOG_ENABLE_REMOTE_EXEC")
[ -n "${OPENLOG_TOKEN:-}"                 ] && ENV_ARGS+=(-e "OPENLOG_TOKEN=$OPENLOG_TOKEN")
[ -n "${OPENLOG_SECRET_KEY:-}"            ] && ENV_ARGS+=(-e "OPENLOG_SECRET_KEY=$OPENLOG_SECRET_KEY")
[ -n "${OPENLOG_ALLOWED_ORIGINS:-}"       ] && ENV_ARGS+=(-e "OPENLOG_ALLOWED_ORIGINS=$OPENLOG_ALLOWED_ORIGINS")
# 规模/预算（可选）
for key in \
  OPENLOG_STATS_CONCURRENCY OPENLOG_STATS_INTERVAL_MS OPENLOG_MFU_INTERVAL_MS \
  OPENLOG_MAX_SSH_CONNECTIONS OPENLOG_SSH_IDLE_TTL_MS OPENLOG_SSH_READY_TIMEOUT_MS \
  OPENLOG_RECONNECT_CONCURRENCY OPENLOG_RECONNECT_MAX_PER_PASS OPENLOG_STARTUP_CONNECT_CONCURRENCY \
  OPENLOG_ASSISTANT_MAX_ROUNDS OPENLOG_ASSISTANT_MAX_WALL_MS OPENLOG_ASSISTANT_CONTEXT_TOKENS \
  OPENLOG_ASSISTANT_TOOL_RESULT_CHARS OPENLOG_ASSISTANT_ROUND_TIMEOUT_MS; do
  eval "val=\${$key:-}"
  [ -n "$val" ] && ENV_ARGS+=(-e "$key=$val")
done
# 额外自定义变量（deploy.env 里 EXTRA_ENV="FOO=1 BAR=2"）
for pair in $EXTRA_ENV; do
  ENV_ARGS+=(-e "$pair")
done

mkdir -p "$DATA_DIR"

run "docker rm -f '$CONTAINER_NAME' >/dev/null 2>&1 || true"
run "docker run -d --name '$CONTAINER_NAME' \
  --network '$NETWORK_MODE' --restart unless-stopped \
  ${ENV_ARGS[*]} \
  -v '$DATA_DIR:/app/data' \
  -v '$LOGS_VOLUME:/app/logs' \
  '$NEW_IMAGE' >/dev/null"
ok "容器已启动"

# ─── 4. 健康检查（失败自动回滚）──────────────────────────────────────────
health_check() {
  local container="$1"
  local deadline=$(( $(date +%s) + 90 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! docker ps --format '{{.Names}}' | grep -qx "$container"; then
      echo "  容器没在运行"
      docker logs --tail 20 "$container" 2>&1 | sed 's/^/    /'
      return 1
    fi
    # 页面
    local page
    page=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$APP_PORT/" || echo 000)
    if [ "$page" = "200" ]; then
      # 数据库探活（回环可取 token，不需要额外配置）
      local tok body
      tok=$(curl -s -m 5 "http://127.0.0.1:$APP_PORT/api/auth/token" 2>/dev/null \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
      if [ -n "$tok" ]; then
        body=$(curl -s -m 8 -H "Authorization: Bearer $tok" \
          "http://127.0.0.1:$APP_PORT/api/db/info" 2>/dev/null || echo '')
        if echo "$body" | grep -q '"ok":true'; then
          echo "  ✅ 页面 200 / 数据库正常（$DB_TYPE）"
          return 0
        fi
      else
        # 没配 token（开发模式）时只看页面
        echo "  ✅ 页面 200（未取到 token，跳过数据库检查）"
        return 0
      fi
    fi
    sleep 3
  done
  echo "  ❌ 90s 内健康检查未通过"
  echo "  —— 最近日志 ——"
  docker logs --tail 30 "$container" 2>&1 | sed 's/^/    /'
  return 1
}

log "健康检查（最多 90s）"
if health_check "$CONTAINER_NAME"; then
  HEALTHY=1
else
  HEALTHY=0
fi

# ─── 5. 失败回滚 ───────────────────────────────────────────────────────
if [ "$HEALTHY" = "0" ] && [ -n "$PREV_IMAGE" ]; then
  log "部署失败 → 回滚到上一个镜像"
  run "docker rm -f '$CONTAINER_NAME' >/dev/null 2>&1 || true"
  run "docker run -d --name '$CONTAINER_NAME' \
    --network '$NETWORK_MODE' --restart unless-stopped \
    ${ENV_ARGS[*]} \
    -v '$DATA_DIR:/app/data' \
    -v '$LOGS_VOLUME:/app/logs' \
    '$PREV_IMAGE' >/dev/null"
  if health_check "$CONTAINER_NAME"; then
    warn "已回滚到 $PREV_IMAGE 并恢复服务；新版本请排查后再部署"
  else
    warn "回滚后仍不健康，请人工检查：docker logs $CONTAINER_NAME"
  fi
  exit 1
elif [ "$HEALTHY" = "0" ]; then
  die "部署失败且没有可回滚的旧镜像；容器保持运行供排查（docker logs $CONTAINER_NAME）"
fi

# ─── 6. 清理旧镜像 ─────────────────────────────────────────────────────
log "清理旧镜像（保留最近 $KEEP_IMAGES 个 $IMAGE_NAME 镜像）"
# shellcheck disable=SC2016
run "docker images '$IMAGE_NAME' --format '{{.Tag}} {{.ID}} {{.CreatedAt}}' \
  | grep -v '<none>' | sort -k3 -r | tail -n +$((KEEP_IMAGES + 1)) \
  | awk '{print \$2}' | xargs -r docker rmi -f >/dev/null 2>&1 || true"
ok "清理完成"

# ─── 7. 记录状态 ───────────────────────────────────────────────────────
if [ "$DRY_RUN" = "0" ]; then
  cat > "$STATE_FILE" <<JSON
{
  "deployedAt": "$(date -Iseconds)",
  "commit": "$SHORT_SHA",
  "image": "$NEW_IMAGE",
  "dbType": "$DB_TYPE",
  "port": "$APP_PORT",
  "previousImage": "$PREV_IMAGE"
}
JSON
fi

log "部署成功"
echo "  版本:     $SHORT_SHA"
echo "  镜像:     $NEW_IMAGE"
echo "  数据库:   $DB_TYPE"
echo "  地址:     http://<host>:$APP_PORT/"
echo "  回滚镜像: ${PREV_IMAGE:-无}"
echo "  状态文件: $STATE_FILE"
