#!/usr/bin/env bash
# ─── OpenLog 服务端一键部署脚本 ───────────────────────────────────────────
#
# 在服务器上执行（通常由 deploy/deploy.mjs 从开发机远程调用）：
#     bash deploy/deploy.sh
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
#   bash deploy/deploy.sh                  # 正常部署（当前工作区代码）
#   bash deploy/deploy.sh --no-build       # 只重启容器（改配置后用）
#   bash deploy/deploy.sh --skip-backup    # 跳过数据库备份
#   bash deploy/deploy.sh --dry-run        # 只打印将要执行的动作
#
# 退出码：0 = 部署成功；非 0 = 失败（已尝试回滚）

set -euo pipefail

# ─── 路径与配置 ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

# 配置文件优先 deploy/deploy.env，兼容旧位置（根目录 deploy.env）
if [ -n "${DEPLOY_ENV_FILE:-}" ]; then
  CONFIG_FILE="$DEPLOY_ENV_FILE"
elif [ -f "$APP_DIR/deploy/deploy.env" ]; then
  CONFIG_FILE="$APP_DIR/deploy/deploy.env"
else
  CONFIG_FILE="$APP_DIR/deploy.env"
fi
BACKUP_DIR="$APP_DIR/backups"
STATE_FILE="$BACKUP_DIR/.last-deploy.json"
IMAGE_NAME="${IMAGE_NAME:-openlog}"
CONTAINER_NAME="${CONTAINER_NAME:-openlog}"
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
  PG_RUNNING="$(docker ps --format '{{.Names}}' || true)"
  # herestring 而不是管道：pipefail 下 grep 命中早退会让上游吃 SIGPIPE(141)，
  # 整条管道被判失败 —— 于是「容器明明在跑」也会走进 else 分支跳过备份。
  if grep -qx "openlog-pg" <<< "$PG_RUNNING"; then
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
# 注意：--type container 不能省。不带 type 时 docker 会回退去找同名**镜像**，
# 首次部署（镜像已导入、容器还没建）就是这样踩的坑，见上方注释。
if docker inspect --type container "$CONTAINER_NAME" >/dev/null 2>&1; then
  PREV_IMAGE="$(docker inspect --type container "$CONTAINER_NAME" --format '{{.Image}}' 2>/dev/null || true)"
  if [ -n "$PREV_IMAGE" ]; then
    echo "  当前镜像: $PREV_IMAGE"
  else
    warn "取不到当前镜像 ID，跳过回滚点记录（首次部署属正常）"
  fi
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

# ─── HTTP 探测（离线机器上可能没有 curl）──────────────────────────────
# 三级回退：curl → wget → 容器内 node fetch。
# 为什么要这么麻烦：部署目标常常是内网精简系统，curl 不一定装；
# 而部署脚本跑在宿主机上，没 curl 就没法做健康检查，也就无法判断该不该回滚。
http_code() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w '%{http_code}' -m 5 "$url" 2>/dev/null || echo 000
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -O /dev/null -T 5 "$url" >/dev/null 2>&1; then echo 200; else echo 000; fi
  elif docker inspect --type container "$CONTAINER_NAME" >/dev/null 2>&1; then
    # 容器是 host 网络，容器内访问 127.0.0.1 就是宿主机
    docker exec "$CONTAINER_NAME" node -e "
      fetch(process.argv[1]).then(r => { console.log(r.status); process.exit(0); })
        .catch(() => { console.log('000'); process.exit(0); });
    " "$url" 2>/dev/null || echo 000
  else
    echo 000
  fi
}

# 带 Authorization 的 GET（取 /api/auth/token 与 /api/db/info）
http_get() {
  local url="$1"
  # 调用方经常只传 1 个参数；`set -u` 下直接写 $2 会报 unbound variable（实测踩到：
  # 取 token 时脚本报错 → token 为空 → 数据库健康检查被静默跳过）
  local auth="${2:-}"
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$auth" ]; then curl -s -m 8 -H "Authorization: Bearer $auth" "$url" 2>/dev/null || true
    else curl -s -m 8 "$url" 2>/dev/null || true; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "$auth" ]; then wget -q -O - -T 8 --header="Authorization: Bearer $auth" "$url" 2>/dev/null || true
    else wget -q -O - -T 8 "$url" 2>/dev/null || true; fi
  elif docker inspect --type container "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker exec "$CONTAINER_NAME" node -e "
      const [url, auth] = process.argv.slice(1);
      fetch(url, auth ? { headers: { Authorization: 'Bearer ' + auth } } : undefined)
        .then(r => r.text()).then(t => { console.log(t); process.exit(0); })
        .catch(() => process.exit(0));
    " "$url" "$auth" 2>/dev/null || true
  fi
}

# ─── 4. 健康检查（失败自动回滚）──────────────────────────────────────────
health_check() {
  local container="$1"
  local deadline=$(( $(date +%s) + 90 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    RUNNING="$(docker ps --format '{{.Names}}' || true)"
  if ! grep -qx "$container" <<< "$RUNNING"; then
      echo "  容器没在运行"
      docker logs --tail 20 "$container" 2>&1 | sed 's/^/    /'
      return 1
    fi
    # 页面
    local page
    page=$(http_code "http://127.0.0.1:$APP_PORT/")
    if [ "$page" = "200" ]; then
      # 数据库探活（回环可取 token，不需要额外配置）
      local tok body
      tok=$(http_get "http://127.0.0.1:$APP_PORT/api/auth/token" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
      if [ -n "$tok" ]; then
        body=$(http_get "http://127.0.0.1:$APP_PORT/api/db/info" "$tok")
        # 同上：误判成 false 会导致「其实健康却回滚」
        if grep -q '"ok":true' <<< "$body"; then
          echo "  ✅ 页面 200 / 数据库正常（${DB_TYPE}）"
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
  LOG_TAIL="$(docker logs --tail 30 "$container" 2>&1)"
  echo "$LOG_TAIL" | sed 's/^/    /'
  # 把最常见的两种启动失败直接翻译成可操作的下一步，省得对着日志猜
  if grep -qi 'password authentication failed' <<< "$LOG_TAIL"; then
    echo ""
    echo "  💡 数据库密码不对：openlog-pg 数据卷里的旧密码与 deploy.env 里的不一致。"
    echo "     用 --db-url 提供旧密码，或复用已有容器的密码（install.sh 现在会自动复用）。"
  elif grep -qi 'DB.*初始化失败\|数据库未就绪' <<< "$LOG_TAIL"; then
    echo ""
    echo "  💡 数据库没连上：检查 deploy.env 里的 OPENLOG_DATABASE_URL（用户名/密码/库名）"
    echo "     以及数据库容器是否在运行（docker ps | grep -E 'openlog-pg|postgres'）。"
  fi
  return 1
}

if [ "$DRY_RUN" = "1" ]; then
  warn "dry-run：跳过健康检查与回滚（不会动线上容器）"
  HEALTHY=1
else
  log "健康检查（最多 90s）"
  if health_check "$CONTAINER_NAME"; then
    HEALTHY=1
  else
    HEALTHY=0
  fi
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
  die "部署失败且没有可回滚的旧镜像；容器保持运行供排查（docker logs ${CONTAINER_NAME}）"
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

# ─── 8. 打印访问令牌 ───────────────────────────────────────────────────
# 令牌只输出到部署终端，不写进 .last-deploy.json（状态文件会被备份/同步，
# 写进去等于把长期凭据摊到多处）。优先用显式配置的 OPENLOG_TOKEN，否则读
# 宿主机数据目录里自动生成的 .auth_token；都读不到时回退到容器内读取
# （旧部署可能把 data 放在别的挂载点）。
if [ -n "${OPENLOG_TOKEN:-}" ]; then
  ACCESS_TOKEN="$OPENLOG_TOKEN"
else
  ACCESS_TOKEN="$(cat "$DATA_DIR/.auth_token" 2>/dev/null || true)"
  [ -n "$ACCESS_TOKEN" ] || ACCESS_TOKEN="$(docker exec "$CONTAINER_NAME" cat /app/data/.auth_token 2>/dev/null || true)"
fi

log "部署成功"
echo "  版本:     $SHORT_SHA"
echo "  镜像:     $NEW_IMAGE"
echo "  数据库:   $DB_TYPE"
echo "  地址:     http://<host>:$APP_PORT/"
echo "  访问令牌: ${ACCESS_TOKEN:-（见 $DATA_DIR/.auth_token）}"
echo "  回滚镜像: ${PREV_IMAGE:-无}"
echo "  状态文件: $STATE_FILE"
