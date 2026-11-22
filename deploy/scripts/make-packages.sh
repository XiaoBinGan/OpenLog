#!/usr/bin/env bash
# ─── OpenLog 双平台离线包（Mac 为主）──────────────────────────────────────
#
# 策略：开发与验证都在 Mac（Apple Silicon）上做；出包时一条命令导出
#       linux/amd64 与 linux/arm64 两个离线包。
#
#   bash deploy/scripts/make-packages.sh                  # 两个架构都出（默认 HEAD）
#   bash deploy/scripts/make-packages.sh --ref v1.2.0     # 指定 tag/提交
#   bash deploy/scripts/make-packages.sh --only arm64     # 只出 arm64
#   bash deploy/scripts/make-packages.sh --skip-build     # 复用已构建的 openlog:<sha>
#   bash deploy/scripts/make-packages.sh --dry-run        # 只打印将执行什么
#
# 每个架构都会做三重校验（镜像元数据 / 容器内 Node / better-sqlite3 ELF e_machine），
# 任一不过立即中止，绝不产出"标着 arm64 实际是 x86"的包。
#
# 跨架构构建说明：
#   · 目标架构 == 宿主架构 → 原生构建（快）
#   · 否则走 buildx + QEMU 模拟（慢，C++ 原生模块编译可达十几分钟；失败可重试）
#
# 依赖：docker（含 buildx）、git、gzip、sha256sum/shasum、tar。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGES_DIR="$REPO_DIR/deploy/images"
OUT_DIR="$(cd "$REPO_DIR/.." && pwd)"
REF="HEAD"
ONLY=""
SKIP_BUILD=0
DRY_RUN=0
NO_TAR=0

log()  { printf '\n▶ %s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*" >&2; }
die()  { printf '  ❌ %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)        REF="$2"; shift 2 ;;
    --only)       ONLY="$2"; shift 2 ;;
    --out-dir)    OUT_DIR="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --no-tar)     NO_TAR=1; shift ;;
    -h|--help)    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数: $1（--help 看用法）" ;;
  esac
done

case "$ONLY" in
  ''|amd64|arm64) : ;;
  *) die "--only 只接受 amd64 或 arm64（收到: $ONLY）" ;;
esac

command -v docker >/dev/null 2>&1 || die "没有 docker"
command -v git    >/dev/null 2>&1 || die "没有 git"
command -v tar    >/dev/null 2>&1 || die "没有 tar"
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
human()     { du -h "$1" 2>/dev/null | cut -f1 | tr -d ' '; }

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64|aarch64) HOST_ARCH=arm64 ;;
  x86_64|amd64)  HOST_ARCH=amd64 ;;
  *) warn "未知宿主架构 $HOST_ARCH，全部走 QEMU" ;;
esac

cd "$REPO_DIR"
[ -z "$(git status --porcelain 2>/dev/null)" ] || warn "工作区有未提交改动 —— 镜像会包含它们（出正式包前建议先提交）"

SHORT="$(git rev-parse --short=8 "$REF" 2>/dev/null)" || die "解析不到 git 引用: $REF"
COMMIT_FULL="$(git rev-parse "$REF")"
log "出包源：$REF → $SHORT"

TARGETS="amd64 arm64"
[ -n "$ONLY" ] && TARGETS="$ONLY"

mkdir -p "$IMAGES_DIR"

declare -a RESULTS=()

# ── 单架构：构建 → 校验 → 归档 → 装配 ────────────────────────────────────
build_and_package() {
  local arch="$1"
  local tag="openlog:$SHORT"
  local node_arch e_machine

  case "$arch" in
    amd64) node_arch=x64;   e_machine=0x3e ;;
    arm64) node_arch=arm64; e_machine=0xb7 ;;
  esac

  log "【$arch】构建镜像（宿主 $HOST_ARCH）"
  if [ "$SKIP_BUILD" = "1" ]; then
    ok "跳过构建（--skip-build）"
  elif [ "$HOST_ARCH" = "$arch" ]; then
    # --provenance=false：关掉 BuildKit 的 attestation manifest，否则 docker save 会报
    # "unable to create manifests file: NotFound: content digest ... not found"
    run "docker build --provenance=false -t '$tag' ."
    ok "原生构建完成"
  else
    warn "跨架构：QEMU 模拟构建（慢，原生模块编译可能 10 分钟以上）"
    # 先把目标架构的基础镜像拉到本地：Docker Hub 偶发超时，buildx 在解析 base 时
    # 失败过一次；预拉 + 重试能把这类网络抖动挡在构建之前。
    if [ "$DRY_RUN" != "1" ]; then
      local i
      for i in 1 2 3; do
        docker pull --platform "linux/$arch" node:22-alpine >/dev/null 2>&1 && break
        warn "拉取 node:22-alpine(linux/$arch) 失败，重试 $i/3"
        sleep 5
      done
    fi
    # 用 dockerd 自带的 BuildKit（docker build --platform）：它复用本地镜像库，
    # 比 buildx(docker-container driver) 少一次远端 metadata 解析。
    run "docker build --platform 'linux/$arch' --provenance=false -t '$tag' ."
    ok "QEMU 构建完成"
  fi

  log "【$arch】拉取数据库镜像 postgres:16-alpine"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] docker pull --platform linux/%s postgres:16-alpine\n' "$arch"
    printf '  [dry-run] 平台化重建 postgres:16-alpine（把多平台 index 收敛成单平台，否则 docker save 会失败）\n'
  else
    local j
    for j in 1 2 3; do
      docker pull --platform "linux/$arch" postgres:16-alpine >/dev/null 2>&1 && break
      warn "拉取 postgres:16-alpine(linux/$arch) 失败，重试 $j/3"; sleep 5
    done
    docker image inspect postgres:16-alpine >/dev/null 2>&1 || die "拿不到 postgres:16-alpine（linux/$arch）"

    # 关键：在 Mac 上用 --platform 拉到的是多平台 index，本地只有目标架构的 blob，
    # 直接 docker save 会报 "unable to create manifests file: NotFound: content digest"。
    # 用同平台 FROM 重建一次（layers 全部复用，秒级）把它收敛成单平台镜像。
    local ctx
    ctx="$(mktemp -d)"
    printf 'FROM postgres:16-alpine\n' > "$ctx/Dockerfile"
    if ! docker build --platform "linux/$arch" --provenance=false -t postgres:16-alpine "$ctx" >/dev/null; then
      rm -rf "$ctx"; die "postgres:16-alpine 平台化重建失败"
    fi
    rm -rf "$ctx"
    # 注意不能用 `-o /dev/null` 做探针：docker save 会拒绝字符设备
    local probe
    probe="$(mktemp)"
    docker save postgres:16-alpine -o "$probe" 2>/dev/null || { rm -f "$probe"; die "postgres 镜像仍无法 save"; }
    rm -f "$probe"
  fi

  log "【$arch】三重架构校验"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] docker inspect %s --format {{.Os}}/{{.Architecture}}\n' "$tag"
    printf '  [dry-run] docker run --rm --platform linux/%s --entrypoint node %s -e process.platform+"/"+process.arch\n' "$arch" "$tag"
    printf '  [dry-run] 读 better-sqlite3 的 ELF e_machine（期望 %s）\n' "$e_machine"
  else
    local got
    got="$(docker inspect "$tag" --format '{{.Os}}/{{.Architecture}}')"
    printf '    ① 镜像元数据: %s\n' "$got"
    [ "$got" = "linux/$arch" ] || die "镜像架构 $got ≠ linux/$arch"

    got="$(docker run --rm --platform "linux/$arch" --entrypoint node "$tag" -e 'console.log(process.platform+"/"+process.arch)')"
    printf '    ② 容器内 Node: %s（期望 linux/%s）\n' "$got" "$node_arch"
    [ "$got" = "linux/$node_arch" ] || die "运行时架构 $got ≠ linux/$node_arch"

    local elf
    elf="$(docker run --rm --platform "linux/$arch" --entrypoint node "$tag" -e '
      const fs=require("fs"),p=require("path");
      const d="/app/node_modules/better-sqlite3/build/Release";
      const f=fs.readdirSync(d).find(x=>x.endsWith(".node"));
      const b=fs.readFileSync(p.join(d,f));
      console.log("0x"+b.readUInt16LE(18).toString(16));
    ')"
    printf '    ③ better-sqlite3 e_machine: %s（期望 %s）\n' "$elf" "$e_machine"
    [ "$elf" = "$e_machine" ] || die "原生模块架构不对（$elf ≠ $e_machine）"
    ok "三重校验通过"
  fi

  log "【$arch】归档镜像并装配离线包"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  # make-package.sh 取 deploy/images 里「最新的 openlog-*.tar.gz」+ postgres-*.tar.gz，
  # 两个架构共用同一个目录会串味，所以每次只保留当前架构的两个归档。
  run "rm -f '$IMAGES_DIR'/openlog-*.tar.gz '$IMAGES_DIR'/postgres-*.tar.gz"
  run "docker save '$tag' | gzip -1 > '$IMAGES_DIR/openlog-${SHORT}-${stamp}.tar.gz'"
  run "docker save postgres:16-alpine | gzip -1 > '$IMAGES_DIR/postgres-16-alpine.tar.gz'"

  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] cd %s && bash deploy/scripts/make-package.sh --arch %s%s\n' "$REPO_DIR" "$arch" "$([ "$NO_TAR" = 1 ] && echo ' --no-tar')"
    RESULTS+=("$arch|dry-run|-|-")
    return 0
  fi

  ( cd "$REPO_DIR" && bash deploy/scripts/make-package.sh --arch "$arch" $([ "$NO_TAR" = 1 ] && echo ' --no-tar') ) >/dev/null
  local pkg="$OUT_DIR/openlog-deploy-${SHORT}$([ "$arch" = arm64 ] && echo '-arm64')"
  [ "$NO_TAR" = 1 ] || pkg="$pkg.tar"
  [ -e "$pkg" ] || die "装配后找不到产物: $pkg"
  RESULTS+=("$arch|$pkg|$(human "$pkg")|$(sha256_of "$pkg")")
  ok "$(basename "$pkg")"
}

for arch in $TARGETS; do
  build_and_package "$arch"
done

# ── 收尾：清掉临时的镜像归档（包里已经有）────────────────────────────────
if [ "$DRY_RUN" != "1" ]; then
  rm -f "$IMAGES_DIR"/openlog-*.tar.gz "$IMAGES_DIR"/postgres-*.tar.gz
fi

log "产物汇总"
printf '  %-8s %-52s %-8s %s\n' 架构 文件 大小 sha256
for row in "${RESULTS[@]}"; do
  IFS='|' read -r a f s h <<< "$row"
  printf '  %-8s %-52s %-8s %s\n' "$a" "$(basename "$f")" "$s" "$h"
done
[ "$DRY_RUN" = "1" ] || ok "两个架构各自独立校验通过；把 sha256 记进 deploy/images/MANIFEST.md"
