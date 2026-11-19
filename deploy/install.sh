#!/usr/bin/env bash
# ─── OpenLog 离线一键部署 ───────────────────────────────────────────────
#
# 适用场景：**目标机没有外网**，只能把部署包拷进去。
# 一条命令完成：校验包 → 导入镜像 → 生成配置 → 起数据库(可选) → 启动 → 健康检查 → 打印访问信息。
#
# 用法（首次安装）：
#     bash deploy/install.sh                       # 默认：SQLite + 端口 3001
#     bash deploy/install.sh --port 8080           # 换端口
#     bash deploy/install.sh --with-postgres       # 用 PostgreSQL（需本机已有 postgres:16-alpine 镜像）
#     bash deploy/install.sh --db-url 'postgres://user:pw@127.0.0.1:5432/openlog'  # 用现成的 PG
#     bash deploy/install.sh --data-dir /data/openlog --container-name openlog-2 --port 3002
#     bash deploy/install.sh --port 3031 --env-file /etc/openlog/instance2.env   # 同机多实例
#     bash deploy/install.sh --dry-run             # 只打印将要做什么
#     bash deploy/install.sh --skip-load           # 跳过镜像导入（镜像已就位时）
#
# 用法（升级已装实例）：
#     bash deploy/install.sh --upgrade             # 换成本地最新的 openlog-*.tar.gz
#     bash deploy/install.sh --upgrade --image deploy/images/openlog-<sha>-<ts>.tar.gz
#     bash deploy/install.sh --upgrade --container-name openlog-2 --env-file /etc/openlog/i2.env
#     bash deploy/install.sh --upgrade --dry-run   # 只打印升级将执行的命令，不动线上
#
# --upgrade 与首次安装的区别（很重要）：
#   * 配置**只读不写**：端口/数据目录/日志卷/数据库连接串全部取自 deploy.env 与现有容器的
#     实际运行参数；命令行上的 --port/--data-dir/--with-postgres/--db-url 会被忽略并告警。
#     这样“升级”不会因为重跑时参数不一致而把端口/数据目录换掉（那等于换了另一个实例）。
#   * 必须先找到实例：容器（默认 openlog，可用 --container-name 指定）+ 它的 deploy.env；
#     找不到就按“这是首次安装”提示退出，绝不静默走首次安装流程。
#   * 流程：读旧镜像作回滚点 → 备份数据库 → docker load 新镜像 → 架构自检 →
#     docker rm -f 旧容器 → 用同样的网络/端口/卷/环境变量起新容器 → 健康检查（≤90s）→
#     失败自动回滚到旧镜像并重启旧容器。
#   * 回滚点用独立 tag（openlog:rollback-<时间戳>），不用 latest —— latest 会被新镜像挤掉，
#     拿 latest 回滚等于回滚到刚装坏的版本。健康检查通过后才把 latest 指向新镜像。
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

# ── 升级模式（--upgrade）──
# 1 = 换镜像，配置只读不写；0 = 首次部署语义（默认，行为与以前完全一致）。
UPGRADE=0
# 升级时跳过的实例参数：--upgrade 下这些值不生效（只告警），但容器名/配置文件是“选择器”，仍然生效。
IGNORED_CONFIG=0
# 显式给过 --container-name 吗？升级时要区分「没给 → 用 deploy.env 里的」和「给了 → 听命令行的」。
CONTAINER_NAME_EXPLICIT=0
# 升级前的数据库备份是否跳过（--skip-backup）。默认不跳过：没有备份就不动线上容器。
SKIP_BACKUP=0
# 健康检查上限（秒）。90s 是按“冷启动 + 自动迁移”实测留的余量。
HEALTH_TIMEOUT="${UPGRADE_HEALTH_TIMEOUT:-90}"
# 健康检查轮询间隔（秒）。测试里调小，正常不用改。
HEALTH_INTERVAL="${UPGRADE_HEALTH_INTERVAL:-3}"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)            APP_PORT="$2"; EXPLICIT_CONFIG=1; IGNORED_CONFIG=1; shift 2 ;;
    --data-dir)        DATA_DIR="$2"; EXPLICIT_CONFIG=1; IGNORED_CONFIG=1; shift 2 ;;
    --container-name)  CONTAINER_NAME="$2"; CONTAINER_NAME_EXPLICIT=1; EXPLICIT_CONFIG=1; shift 2 ;;
    --logs-volume)     LOGS_VOLUME="$2"; IGNORED_CONFIG=1; shift 2 ;;
    --with-postgres)   WITH_POSTGRES=1; DB_MODE="postgres"; EXPLICIT_CONFIG=1; IGNORED_CONFIG=1; shift ;;
    --pg-container)    PG_CONTAINER="$2"; shift 2 ;;
    --pg-port)         PG_PORT="$2"; shift 2 ;;
    --pg-volume)       PG_VOLUME="$2"; shift 2 ;;
    --env-file)        ENV_FILE_OVERRIDE="$2"; EXPLICIT_CONFIG=1; shift 2 ;;
    --db-url)          DB_URL="$2"; DB_MODE="postgres"; EXPLICIT_CONFIG=1; IGNORED_CONFIG=1; shift 2 ;;
    --image)           IMAGE_ARCHIVE="$2"; shift 2 ;;
    --skip-load)       SKIP_LOAD=1; shift ;;
    --allow-arch-mismatch) ALLOW_ARCH_MISMATCH=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --yes|-y)          ASSUME_YES=1; shift ;;
    --upgrade)         UPGRADE=1; shift ;;
    --skip-backup)     SKIP_BACKUP=1; shift ;;
    --health-timeout)  HEALTH_TIMEOUT="$2"; shift 2 ;;
    -h|--help)         # 行号范围不再写死：头部注释以后加参数不会让 --help 截断/多印
                       sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "未知参数: $1（用 --help 看用法）"; exit 1 ;;
  esac
done

# 每实例独立的配置文件（默认 deploy/deploy.env）。
# 提前解析：升级模式要在打印头部时就说明“配置来自哪个文件”，不能让用户以为读的是默认值。
if [ -n "$ENV_FILE_OVERRIDE" ]; then
  ENV_FILE="$ENV_FILE_OVERRIDE"
else
  ENV_FILE="$SCRIPT_DIR/deploy.env"
fi

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
echo "  OpenLog 离线一键部署 — $([ "$UPGRADE" = "1" ] && echo "升级已装实例" || echo "首次安装")"
echo "=================================================="
echo "  部署包:     $PKG_DIR"
echo "  容器名:     $CONTAINER_NAME"
if [ "$UPGRADE" = "1" ]; then
  echo "  配置文件:   ${ENV_FILE}（只读，不重写）"
  echo "  模式说明:   沿用现有端口/数据目录/卷/数据库，仅替换镜像"
else
  echo "  端口:       $APP_PORT"
  echo "  数据目录:   $DATA_DIR"
  echo "  数据库:     $([ "$DB_MODE" = "postgres" ] && echo "PostgreSQL" || echo "SQLite（零依赖）")"
fi
if [ "$UPGRADE" = "1" ] && [ "$IGNORED_CONFIG" = "1" ]; then
  warn "升级模式忽略实例参数（--port/--data-dir/--logs-volume/--with-postgres/--db-url）："
  warn "它们只用于首次安装；要改这些必须显式重建实例（不带 --upgrade 重跑），本脚本不会偷偷改配置。"
fi

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
    warn "$label 架构不匹配：包=$got / 本机=${want}（--allow-arch-mismatch 已显式放行）"
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

# ═══════════════════════════════════════════════════════════════════════
# 升级模式（--upgrade）
# ═══════════════════════════════════════════════════════════════════════
# 与首次安装的根本区别：**配置只读**。升级只换镜像，绝不按命令行参数重写 deploy.env。
# 因为重跑 install.sh 时人很容易顺手带上记忆里的参数（--port、--data-dir），
# 首次安装语义会照参数重写配置并重建容器 —— 端口/数据目录一变，就等于换成了
# 另一个实例，而旧数据还躺在原来的目录里，现场表现是「升级后数据全没了」。
#
# 顺序也是刻意的：备份 → load → 架构自检 → rm 旧容器 → run 新容器 → 健康检查 → 回滚。
# 备份必须在 rm 之前；架构自检必须在 load 之后（也尽量在 rm 之前），因为装错架构时
# docker load 完全成功，只有 docker run 才报 exec format error，而那行错误不提架构。

BACKUP_DIR="$PKG_DIR/backups"

# 只读 docker 调用：dry-run 下也执行（不改任何状态），用来读旧配置/判存在。
ro() { "$@" 2>/dev/null || true; }

# 含敏感值的命令：真实执行走数组（值里有空格也不会被拆开），日志只显示脱敏后的字符串。
# 为什么要专门一个函数：docker run 会带上 OPENLOG_DATABASE_URL / OPENLOG_TOKEN，
# 直接 echo 等于把数据库密码和访问令牌打到终端和 CI 日志里。
run_strict() {  # 失败必须中断
  local shown="$1"; shift
  if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] $shown"; else "$@" >/dev/null; fi
}
run_soft() {    # 允许失败（rm -f 之类）
  local shown="$1"; shift
  if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] $shown"; else "$@" >/dev/null 2>&1 || true; fi
}

# 连接串/令牌脱敏：postgres://u:pw@h/db → postgres://u:***@h/db
mask_secret() {
  sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#g' \
    | sed -E "s#(OPENLOG_TOKEN=)[^[:space:]']*#\1***#g" \
    | sed -E "s#(OPENLOG_SECRET_KEY=)[^[:space:]']*#\1***#g"
}

# ── HTTP 探测（与 deploy.sh 同策略：curl → wget → 000）──
http_code() {
  local url="$1" auth="${2:-}" code=""
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$auth" ]; then
      code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Authorization: Bearer $auth" "$url" 2>/dev/null)" || code=""
    else
      code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null)" || code=""
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -O /dev/null -T 5 ${auth:+--header="Authorization: Bearer $auth"} "$url" >/dev/null 2>&1; then
      code=200
    else
      code=000
    fi
  fi
  echo "${code:-000}"
}

http_get() {
  local url="$1" auth="${2:-}"
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$auth" ]; then curl -s -m 8 -H "Authorization: Bearer $auth" "$url" 2>/dev/null || true
    else curl -s -m 8 "$url" 2>/dev/null || true; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "$auth" ]; then wget -q -O - -T 8 --header="Authorization: Bearer $auth" "$url" 2>/dev/null || true
    else wget -q -O - -T 8 "$url" 2>/dev/null || true; fi
  fi
}

# 访问令牌从**宿主机数据目录**读（与 deploy.sh 一致），读不到再退回容器内。
read_token() {
  local t=""
  t="$(cat "$DATA_DIR/.auth_token" 2>/dev/null || true)"
  [ -n "$t" ] || t="$(docker exec "$CONTAINER_NAME" cat /app/data/.auth_token 2>/dev/null || true)"
  printf '%s' "$t"
}

# 健康检查：容器在跑 + 页面 200 + /api/db/info 的 "ok":true（或 /api/settings 200 可用）。
# 最多等 HEALTH_TIMEOUT 秒（默认 90s，冷启动 + 自动迁移的实测余量）。
upgrade_health() {
  local label="$1"
  local deadline page="" tok="" body="" code="" running=""
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    running="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
    if ! grep -qx "$CONTAINER_NAME" <<< "$running"; then
      echo "  ⏳ 容器 $CONTAINER_NAME 没在运行，等下一轮"
      docker logs --tail 20 "$CONTAINER_NAME" 2>&1 | sed 's/^/    /' || true
      sleep "$HEALTH_INTERVAL"
      continue
    fi
    page="$(http_code "http://127.0.0.1:$APP_PORT/")"
    if [ "$page" = "200" ]; then
      tok="$(read_token)"
      if [ -n "$tok" ]; then
        body="$(http_get "http://127.0.0.1:$APP_PORT/api/db/info" "$tok")"
        if grep -q '"ok":true' <<< "$body"; then
          ok "页面 200 / 数据库正常（${DB_TYPE}）"
          return 0
        fi
        # 有些版本没有 /api/db/info，退一步看 /api/settings 是否可鉴权访问
        code="$(http_code "http://127.0.0.1:$APP_PORT/api/settings" "$tok")"
        if [ "$code" = "200" ]; then
          ok "页面 200 / 设置接口可用（/api/settings 200）"
          return 0
        fi
      else
        # 没配令牌（或数据目录换了位置）时只看页面，不因为读不到令牌就误判成不健康
        warn "没读到访问令牌（$DATA_DIR/.auth_token），本次只按页面 200 判定"
        ok "页面 200"
        return 0
      fi
    fi
    sleep "$HEALTH_INTERVAL"
  done
  echo "  ❌ ${label}在 ${HEALTH_TIMEOUT}s 内未通过健康检查（最后一次页面状态=${page:-?}）"
  echo "  —— 最近日志 ——"
  docker logs --tail 30 "$CONTAINER_NAME" 2>&1 | sed 's/^/    /' || true
  return 1
}

# 回滚点和启动参数都是全局的：start_container / show_start 在正常路径和回滚路径共用，
# 保证「回滚」用的就是「升级前那套」网络/端口/卷/环境变量，不会两套命令各写一遍写歪。
START_ENV_ARGS=()
START_VOLS=()
START_ENV_SHOWN=""

build_start_args() {
  START_ENV_ARGS=(
    -e "NODE_ENV=production"
    -e "PORT=$APP_PORT"
    -e "HOST=$HOST_BIND"
  )
  # 数据库配置（原样从 deploy.env 透传，升级不改）
  [ -n "${OPENLOG_DB_TYPE:-}" ]      && START_ENV_ARGS+=(-e "OPENLOG_DB_TYPE=$OPENLOG_DB_TYPE")
  [ -n "${OPENLOG_DATABASE_URL:-}" ] && START_ENV_ARGS+=(-e "OPENLOG_DATABASE_URL=$OPENLOG_DATABASE_URL")
  [ -n "${OPENLOG_PG_POOL_MAX:-}"    ] && START_ENV_ARGS+=(-e "OPENLOG_PG_POOL_MAX=$OPENLOG_PG_POOL_MAX")
  # 功能开关
  [ -n "${OPENLOG_ENABLE_CONTAINER_EXEC:-}" ] && START_ENV_ARGS+=(-e "OPENLOG_ENABLE_CONTAINER_EXEC=$OPENLOG_ENABLE_CONTAINER_EXEC")
  [ -n "${OPENLOG_ENABLE_REMOTE_EXEC:-}"    ] && START_ENV_ARGS+=(-e "OPENLOG_ENABLE_REMOTE_EXEC=$OPENLOG_ENABLE_REMOTE_EXEC")
  [ -n "${OPENLOG_TOKEN:-}"                 ] && START_ENV_ARGS+=(-e "OPENLOG_TOKEN=$OPENLOG_TOKEN")
  [ -n "${OPENLOG_SECRET_KEY:-}"            ] && START_ENV_ARGS+=(-e "OPENLOG_SECRET_KEY=$OPENLOG_SECRET_KEY")
  [ -n "${OPENLOG_ALLOWED_ORIGINS:-}"       ] && START_ENV_ARGS+=(-e "OPENLOG_ALLOWED_ORIGINS=$OPENLOG_ALLOWED_ORIGINS")
  # 规模/预算（可选）
  local key val
  for key in \
    OPENLOG_STATS_CONCURRENCY OPENLOG_STATS_INTERVAL_MS OPENLOG_MFU_INTERVAL_MS \
    OPENLOG_MAX_SSH_CONNECTIONS OPENLOG_SSH_IDLE_TTL_MS OPENLOG_SSH_READY_TIMEOUT_MS \
    OPENLOG_RECONNECT_CONCURRENCY OPENLOG_RECONNECT_MAX_PER_PASS OPENLOG_STARTUP_CONNECT_CONCURRENCY \
    OPENLOG_ASSISTANT_MAX_ROUNDS OPENLOG_ASSISTANT_MAX_WALL_MS OPENLOG_ASSISTANT_CONTEXT_TOKENS \
    OPENLOG_ASSISTANT_TOOL_RESULT_CHARS OPENLOG_ASSISTANT_ROUND_TIMEOUT_MS; do
    eval "val=\${$key:-}"
    [ -n "$val" ] && START_ENV_ARGS+=(-e "$key=$val")
  done
  # 额外自定义变量（deploy.env 里 EXTRA_ENV="FOO=1 BAR=2"）
  local pair
  for pair in ${EXTRA_ENV:-}; do
    START_ENV_ARGS+=(-e "$pair")
  done
  START_VOLS=(-v "$DATA_DIR:/app/data" -v "$LOGS_VOLUME:/app/logs")

  # 用于 dry-run / 日志的脱敏展示
  START_ENV_SHOWN=""
  local i=0 k v
  while [ "$i" -lt "${#START_ENV_ARGS[@]}" ]; do
    k="${START_ENV_ARGS[i]}"; v="${START_ENV_ARGS[i+1]:-}"
    # START_ENV_ARGS 是「-e KEY=VALUE」对，所以 k 恒为 -e，密钥在 v 里。
    case "$v" in
      OPENLOG_TOKEN=*)      v="OPENLOG_TOKEN=***" ;;
      OPENLOG_SECRET_KEY=*) v="OPENLOG_SECRET_KEY=***" ;;
      *"://"*)              v="$(printf '%s' "$v" | sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#g')" ;;
    esac
    START_ENV_SHOWN+=" $k $(printf '%q' "$v")"
    i=$((i + 2))
  done
}

show_start() {  # $1 = 镜像引用
  echo "docker run -d --name '$CONTAINER_NAME' --network '$NETWORK_MODE' --restart unless-stopped$START_ENV_SHOWN -v '$DATA_DIR:/app/data' -v '$LOGS_VOLUME:/app/logs' '$1'"
}

start_container() {  # $1 = 镜像引用；真实执行，失败返回非 0
  docker run -d --name "$CONTAINER_NAME" \
    --network "$NETWORK_MODE" --restart unless-stopped \
    "${START_ENV_ARGS[@]}" "${START_VOLS[@]}" "$1" >/dev/null
}

upgrade_flow() {
  local t0 old_ref old_id old_desc rollback_tag new_tag backup_file=""
  local pg_user pg_db c_env c_port c_data c_net integ
  t0="$(date +%s)"

  # ── 1. 前置校验：deploy.env + 容器都必须存在 ─────────────────────────
  log "校验现有实例"
  [ -f "$ENV_FILE" ] || die "找不到配置文件 $ENV_FILE
     升级必须能读到原实例的 deploy.env（端口/数据目录/数据库连接串都在里面）。
     用 --env-file 指到实际位置再试；如果这台机器还没装过 OpenLog，这是首次安装，
     请不带 --upgrade 运行：
         bash deploy/install.sh"

  # --container-name 是“选择器”，必须在 source 之后仍然生效。
  # deploy.env 里通常也写着 CONTAINER_NAME，直接 source 会把命令行给的值盖掉，
  # 结果是「指定了 openlog-2，脚本却去操作 openlog」—— 这种错会真的动错实例。
  local cli_container="$CONTAINER_NAME"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  if [ "$CONTAINER_NAME_EXPLICIT" = "1" ]; then
    CONTAINER_NAME="$cli_container"
  fi

  # 容器名优先级：命令行显式指定 > deploy.env（上面 source 进来的）> 默认 openlog
  CONTAINER_NAME="${CONTAINER_NAME:-openlog}"

  # 注意必须带 --type container：不带 type 时 docker 会去找同名**镜像**，
  # 于是「早就装过、只是容器被删了」会被误判成「实例存在」。
  if ! docker inspect --type container "$CONTAINER_NAME" >/dev/null 2>&1; then
    die "没找到容器 ${CONTAINER_NAME}（配置里 CONTAINER_NAME=${CONTAINER_NAME:-openlog}）。
     --upgrade 只用于升级**已存在**的实例；这台机器上找不到它。
     如果这是首次安装，请不带 --upgrade 运行：
         bash deploy/install.sh
     如果实例在别的容器名下：
         bash deploy/install.sh --upgrade --container-name <实际容器名>
         bash deploy/install.sh --upgrade --container-name <实际容器名> --env-file <它的 deploy.env>"
  fi
  ok "找到容器 ${CONTAINER_NAME}（${ENV_FILE}）"

  # ── 2. 复用现有配置（不按命令行参数重写）──────────────────────────────
  # 值优先来自 deploy.env；deploy.env 没写的再问现有容器实际挂载/网络。
  if [ -z "${DATA_DIR:-}" ]; then
    DATA_DIR="$(ro docker inspect --type container "$CONTAINER_NAME" \
      --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}')"
    [ -n "$DATA_DIR" ] || DATA_DIR="$PKG_DIR/data"
  fi
  if [ -z "${NETWORK_MODE:-}" ]; then
    NETWORK_MODE="$(ro docker inspect --type container "$CONTAINER_NAME" --format '{{.HostConfig.NetworkMode}}')"
    [ -n "$NETWORK_MODE" ] || NETWORK_MODE="host"
  fi
  APP_PORT="${APP_PORT:-3001}"
  HOST_BIND="${HOST_BIND:-0.0.0.0}"
  LOGS_VOLUME="${LOGS_VOLUME:-openlog-logs}"
  NETWORK_MODE="${NETWORK_MODE:-host}"
  DB_TYPE="${OPENLOG_DB_TYPE:-sqlite}"

  # 用现有容器的实际样子核对 deploy.env，drift 只告警不阻断（不替用户改配置，
  # 但必须在 docker rm 之前让人看见「你以为复用的是 A，实际原来跑的是 B」）。
  c_env="$(ro docker inspect --type container "$CONTAINER_NAME" \
    --format '{{range .Config.Env}}{{println .}}{{end}}')"
  c_port="$(printf '%s\n' "$c_env" | sed -n 's/^PORT=//p')"
  # 只取第一行（容器 env 里可能有重复/多行）；注意 pattern 要用未加引号的 $'\n'，
  # 写成 "${c_port%%"$'\n'"*}" 里层引号会把 $'\n' 变成字面量，整串都匹配不上。
  c_port="${c_port%%$'\n'*}"
  c_data="$(ro docker inspect --type container "$CONTAINER_NAME" \
    --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}')"
  c_net="$(ro docker inspect --type container "$CONTAINER_NAME" --format '{{.HostConfig.NetworkMode}}')"
  if [ -n "$c_port" ] && [ "$c_port" != "$APP_PORT" ]; then
    warn "deploy.env 的 APP_PORT=$APP_PORT 与现有容器实际 PORT=$c_port 不一致：按 deploy.env 起（想按容器就改 deploy.env）"
  fi
  if [ -n "$c_data" ] && [ "$c_data" != "$DATA_DIR" ]; then
    warn "deploy.env 的 DATA_DIR=$DATA_DIR 与现有容器实际挂载=$c_data 不一致：按 deploy.env 起"
    warn "若这个目录里没有 openlog.db，等于换了一本账 —— 现在 Ctrl-C 还来得及，改完 deploy.env 再跑"
  fi
  if [ -n "$c_net" ] && [ "$c_net" != "$NETWORK_MODE" ]; then
    warn "deploy.env 的 NETWORK_MODE=$NETWORK_MODE 与现有容器实际网络=$c_net 不一致：按 deploy.env 起"
  fi

  ok "端口     $APP_PORT"
  ok "数据目录 $DATA_DIR"
  ok "日志卷   $LOGS_VOLUME"
  ok "网络模式 $NETWORK_MODE"
  ok "数据库   $DB_TYPE $(printf '%s' "${OPENLOG_DATABASE_URL:-}" | mask_secret)"

  # ── 3. 读旧镜像作为回滚点 ────────────────────────────────────────────
  old_ref="$(ro docker inspect --type container "$CONTAINER_NAME" --format '{{.Config.Image}}')"
  old_id="$(ro docker inspect --type container "$CONTAINER_NAME" --format '{{.Image}}')"
  [ -n "$old_ref" ] || old_ref="$old_id"
  [ -n "$old_ref" ] || die "读不到容器 $CONTAINER_NAME 的镜像信息，无法建立回滚点。
     已中止，线上容器未做任何改动。可先手工确认：docker inspect -f '{{.Config.Image}}' $CONTAINER_NAME"
  old_desc="$old_ref"
  [ -n "$old_id" ] || old_id="$old_ref"
  # 回滚点必须是**独立 tag**：新镜像一定抢走 openlog:latest，拿 latest 回滚＝回滚到坏版本。
  rollback_tag="openlog:rollback-$(date +%Y%m%d-%H%M%S)"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] docker tag '$old_id' '$rollback_tag'"
  else
    docker tag "$old_id" "$rollback_tag" >/dev/null 2>&1 \
      || die "无法创建回滚 tag ${rollback_tag}（源 ${old_id}），已中止，线上容器未改动"
  fi
  ok "回滚点 $old_desc → $rollback_tag"
  ok "新镜像 $IMAGE_ARCHIVE → openlog:$IMAGE_TAG"

  # ── 4. 备份数据库（必须在 rm 之前）──────────────────────────────────
  log "备份数据库"
  run "mkdir -p '$BACKUP_DIR'"
  if [ "$SKIP_BACKUP" = "1" ]; then
    warn "跳过数据库备份（--skip-backup）：回滚只还原镜像，不还原数据"
  elif [ "$DB_TYPE" = "postgres" ]; then
    PG_RUNNING="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
    # herestring 而不是管道：pipefail 下 grep 命中早退会让上游吃 SIGPIPE(141)，
    # 整条管道被判失败 —— 「容器明明在跑」也会走进 else 分支跳过备份。
    if grep -qx "$PG_CONTAINER" <<< "$PG_RUNNING"; then
      pg_user="openlog"; pg_db="openlog"
      if [ -n "${OPENLOG_DATABASE_URL:-}" ]; then
        local u d
        u="$(printf '%s' "$OPENLOG_DATABASE_URL" | sed -nE 's#^[a-zA-Z]+://([^:@/]+)(:[^@]*)?@.*#\1#p')"
        d="$(printf '%s' "$OPENLOG_DATABASE_URL" | sed -nE 's#^[a-zA-Z]+://[^/]+/([^?]+).*#\1#p')"
        [ -n "$u" ] && pg_user="$u"
        [ -n "$d" ] && pg_db="$d"
      fi
      backup_file="$BACKUP_DIR/openlog-pg-$(date +%Y%m%d-%H%M%S).sql.gz"
      # 不传 PGPASSWORD：容器内本地 socket 走 trust；传了只会把密码漏进命令和日志。
      run "docker exec '$PG_CONTAINER' pg_dump -U '$pg_user' -d '$pg_db' | gzip > '$backup_file'"
      if [ "$DRY_RUN" = "0" ]; then
        [ -s "$backup_file" ] || die "PostgreSQL 备份为空或未生成：$backup_file
     已中止，线上容器未改动（通常是没有 $PG_CONTAINER 的读权限，或库名/用户名不对）。"
        ok "已备份 $(basename "$backup_file")（$(du -h "$backup_file" 2>/dev/null | cut -f1)）"
      fi
      run "ls -1t $BACKUP_DIR/openlog-pg-*.sql.gz 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true"
    else
      warn "deploy.env 是 postgres，但本机没有在跑的 $PG_CONTAINER 容器，跳过 pg_dump（本次无数据备份）"
    fi
  elif [ -f "$DATA_DIR/openlog.db" ]; then
    # WAL 模式下不能 cp 主库文件：最近的写入还在 openlog.db-wal 里，cp 出来的是
    # 「上次 checkpoint 的样子」——文件合法、打开不报错、只是少了最近的记录，
    # 这种「看起来成功」的备份最危险。所以优先 sqlite3 的在线备份协议。
    if command -v sqlite3 >/dev/null 2>&1; then
      backup_file="$BACKUP_DIR/openlog-sqlite-$(date +%Y%m%d-%H%M%S).db"
      run "sqlite3 '$DATA_DIR/openlog.db' \".backup '$backup_file'\""
      if [ "$DRY_RUN" = "0" ]; then
        integ="$(sqlite3 "$backup_file" 'PRAGMA integrity_check;' 2>/dev/null || echo 'error')"
        [ "$integ" = "ok" ] || die "SQLite 备份完整性校验失败（${integ}）：${backup_file}
     已中止，线上容器未改动。"
        ok "已备份 $(basename "$backup_file")（$(du -h "$backup_file" 2>/dev/null | cut -f1)，integrity=ok）"
      fi
    else
      # 降级路径：没有 sqlite3 时，把 db + WAL + SHM 三件一起拷走。
      # deploy.sh 在这种情况会直接失败（它只做一次部署，缺工具就让人去装）；
      # 升级路径不能因为缺个小工具就不备份，所以保留降级复制，并在文件名里标 degraded，
      # 恢复时三件一起拷回原目录即可。
      backup_file="$BACKUP_DIR/openlog-sqlite-$(date +%Y%m%d-%H%M%S).degraded.db"
      warn "本机没有 sqlite3：降级为 cp 复制 openlog.db + -wal + -shm（标记 .degraded）"
      warn "要更严格的在线备份请装 sqlite3（apt-get install -y sqlite3 / apk add sqlite）后重跑"
      run "cp -f '$DATA_DIR/openlog.db' '$backup_file'"
      if [ -f "$DATA_DIR/openlog.db-wal" ]; then
        run "cp -f '$DATA_DIR/openlog.db-wal' '$backup_file-wal'"
      fi
      if [ -f "$DATA_DIR/openlog.db-shm" ]; then
        run "cp -f '$DATA_DIR/openlog.db-shm' '$backup_file-shm'"
      fi
      if [ "$DRY_RUN" = "0" ] && [ -s "$backup_file" ]; then
        ok "已降级备份 $(basename "$backup_file")（含 wal/shm）"
      fi
    fi
    run "ls -1t $BACKUP_DIR/openlog-sqlite-*.db* 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true"
  else
    warn "没有 $DATA_DIR/openlog.db，跳过 SQLite 备份（数据目录可能刚建或用了别的库文件）"
  fi

  # ── 5. 导入新镜像 + 架构自检 ────────────────────────────────────────
  log "导入新镜像"
  new_tag="$IMAGE_TAG"
  check_arch "新镜像" "$(host_arch)" "$(archive_arch "$IMAGE_ARCHIVE")"
  if [ "$SKIP_LOAD" = "1" ]; then
    # 镜像已在本机时跳过导入（大包重复 load 要等好几分钟）。但必须确认 tag 真的存在，
    # 否则后面 docker run 才报 "Unable to find image"，而那时旧容器已经 rm 了。
    warn "跳过镜像导入（--skip-load），直接使用本机已有的 openlog:$new_tag"
    if [ "$DRY_RUN" = "0" ] && ! docker image inspect "openlog:$new_tag" >/dev/null 2>&1; then
      die "本机没有 openlog:$new_tag 镜像，不能跳过导入。
     去掉 --skip-load 让脚本先 docker load '$IMAGE_ARCHIVE'。
     （已中止，线上容器未改动）"
    fi
  else
    run "docker load -i '$IMAGE_ARCHIVE'"
  fi
  if [ "$DRY_RUN" = "0" ]; then
    # 导入后再用镜像元数据复核：tar 里若有多个 config json，归档侧的 grep 可能取错层
    LOADED_ARCH="$(docker image inspect "openlog:$new_tag" --format '{{.Architecture}}' 2>/dev/null || true)"
    check_arch "已导入镜像" "$(host_arch)" "$LOADED_ARCH"
  fi
  ok "已导入 openlog:$new_tag"

  # ── 6. 起新容器（同样的网络/端口/卷/环境变量）───────────────────────
  build_start_args
  run "mkdir -p '$DATA_DIR'"

  if [ "$DRY_RUN" = "1" ]; then
    echo ""
    echo "  [dry-run] 以下为升级将执行的命令（本次一条都没执行）："
    echo "  [dry-run] docker rm -f '$CONTAINER_NAME'"
    echo "  [dry-run] $(show_start "openlog:$new_tag")"
    echo "  [dry-run] 健康检查（最多 ${HEALTH_TIMEOUT}s）:"
    echo "            GET http://127.0.0.1:$APP_PORT/                                     → 期望 200"
    echo "            GET http://127.0.0.1:$APP_PORT/api/db/info   （Bearer $DATA_DIR/.auth_token）→ 期望 \"ok\":true"
    echo "            GET http://127.0.0.1:$APP_PORT/api/settings  （Bearer ...）          → 期望 200"
    echo "  [dry-run] 通过后: docker tag 'openlog:$new_tag' 'openlog:latest'"
    echo "  [dry-run] 失败则回滚:"
    echo "            docker rm -f '$CONTAINER_NAME'"
    echo "            $(show_start "$rollback_tag")"
    echo ""
    log "dry-run 结束（未做任何改动）"
    echo "  旧版本 → 新版本: $old_desc → openlog:$new_tag"
    echo "  备份将写入:       ${backup_file:-（无，见上方告警）}"
    echo "  回滚 tag:         $rollback_tag"
    exit 0
  fi

  log "替换容器"
  run_soft "docker rm -f '$CONTAINER_NAME'" docker rm -f "$CONTAINER_NAME"
  if ! start_container "openlog:$new_tag"; then
    warn "新容器启动失败（docker run 直接返回非 0）→ 回滚"
    rollback_and_exit "$old_desc" "$rollback_tag" "openlog:$new_tag" "$backup_file" "$t0"
  fi
  ok "容器已启动（openlog:${new_tag}）"

  # ── 7. 健康检查 ────────────────────────────────────────────────────
  log "健康检查（最多 ${HEALTH_TIMEOUT}s）"
  if ! upgrade_health "新镜像"; then
    rollback_and_exit "$old_desc" "$rollback_tag" "openlog:$new_tag" "$backup_file" "$t0"
  fi

  # 健康检查通过后才移动 latest：deploy.sh --no-build 用 latest，
  # 提前移动会让「回滚后 latest 仍指向坏镜像」变成一个隐蔽的坑。
  run_soft "docker tag 'openlog:$new_tag' 'openlog:latest'" docker tag "openlog:$new_tag" openlog:latest
  ok "openlog:latest → $new_tag"

  # ── 8. 收尾 ────────────────────────────────────────────────────────
  local elapsed; elapsed=$(( $(date +%s) - t0 ))
  local token; token="$(read_token)"
  if [ -d "$BACKUP_DIR" ]; then
    cat > "$BACKUP_DIR/.last-upgrade.json" <<JSON
{
  "upgradedAt": "$(date -Iseconds)",
  "container": "$CONTAINER_NAME",
  "from": "$old_desc",
  "to": "openlog:$new_tag",
  "rollbackTag": "$rollback_tag",
  "backupFile": "${backup_file:-}",
  "dbType": "$DB_TYPE",
  "port": "$APP_PORT",
  "elapsedSec": $elapsed
}
JSON
  fi

  log "升级完成"
  echo "  旧版本  : $old_desc"
  echo "  新版本  : openlog:$new_tag"
  echo "  数据库  : $DB_TYPE"
  echo "  备份文件: ${backup_file:-（未备份）}"
  echo "  回滚 tag: $rollback_tag"
  echo "  耗时    : ${elapsed}s"
  echo "  地址    : http://<host>:$APP_PORT/"
  echo "  令牌    : ${token:-（见 $DATA_DIR/.auth_token）}"
  echo ""
  echo "  手工回滚（本次升级已成功，仅备查）："
  echo "    docker rm -f $CONTAINER_NAME"
  echo "    $(show_start "$rollback_tag")"
  echo ""
  echo "  升级记录: $BACKUP_DIR/.last-upgrade.json"
  exit 0
}

# 回滚：同样的网络/端口/卷/环境变量 + 旧镜像，再验一次健康。
rollback_and_exit() {
  local old_desc="$1" rollback_tag="$2" failed_tag="$3" backup_file="$4" t0="$5"
  local elapsed token
  log "升级失败 → 自动回滚到旧镜像"
  warn "失败镜像: $failed_tag"
  warn "回滚 tag: ${rollback_tag}（${old_desc}）"
  if [ -n "$backup_file" ] && [ -f "$backup_file" ]; then
    warn "数据备份: ${backup_file}（回滚镜像不会自动还原数据，需要时手工恢复）"
  fi
  run_soft "docker rm -f '$CONTAINER_NAME'" docker rm -f "$CONTAINER_NAME"
  if ! start_container "$rollback_tag"; then
    echo "  ❌ 旧镜像也起不来，需要人工介入：docker logs $CONTAINER_NAME" >&2
    exit 1
  fi
  if upgrade_health "回滚后"; then
    warn "已回滚到 $old_desc 并恢复服务；新镜像 $failed_tag 请排查后再升级"
  else
    warn "回滚后仍不健康，请人工检查：docker logs $CONTAINER_NAME"
  fi
  elapsed=$(( $(date +%s) - t0 ))
  token="$(read_token 2>/dev/null || true)"
  log "升级失败（已回滚）"
  echo "  旧版本  : ${old_desc}（正在运行）"
  echo "  失败版本: $failed_tag"
  echo "  备份文件: ${backup_file:-（未备份）}"
  echo "  回滚 tag: $rollback_tag"
  echo "  耗时    : ${elapsed}s"
  echo "  令牌    : ${token:-（见 $DATA_DIR/.auth_token）}"
  exit 1
}

if [ "$UPGRADE" = "1" ]; then
  upgrade_flow
  exit $?
fi
# ═══ 以上为升级模式；以下全部是首次部署流程，行为保持原样 ═══

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
        warn "本机没有 ${PG_IMAGE}，尝试 docker pull（无外网会失败）"
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
# 注意：ENV_FILE 在参数解析后就已经解析好了（升级模式也要用它定位配置文件）。
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
  ok "已生成（端口 ${APP_PORT}，数据库 ${DB_MODE}）"
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
