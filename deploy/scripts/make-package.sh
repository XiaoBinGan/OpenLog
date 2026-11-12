#!/usr/bin/env bash
# ─── OpenLog 离线包装配 ────────────────────────────────────────────────
#
# 解决的问题：README-offline.md 里写死了版本号、镜像文件名、架构、包名，
# 每打一个架构的包都要手工改四处 —— 已经因此出过错：
#   · x86 包里写着 c99bb354 的文件名，包里实际是 7b3b3de → 照着 README 会找不到文件
#   · arm64 包里写着「本包为 linux/amd64」→ 让人以为装错了
# 手工改文档一定会漏。这里改成：文档里放占位符，装配时按包里**实际内容**渲染。
#
# 用法：
#   bash deploy/scripts/make-package.sh --arch arm64
#   bash deploy/scripts/make-package.sh --arch amd64 --out /tmp/openlog-deploy-x.tar
#
# 前置：
#   在仓库根目录执行；deploy/images/ 下已有一个 openlog-*.tar.gz 与 postgres-*.tar.gz
# 产出：
#   ../openlog-deploy-<commit>-<arch>/   （目录）
#   ../openlog-deploy-<commit>-<arch>.tar（除非 --no-tar）
#
# 退出码：0 成功；非 0 失败。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGES_DIR="$REPO_DIR/deploy/images"

ARCH=""
NO_TAR=0
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --arch)   ARCH="$2"; shift 2 ;;
    --out)    OUT="$2"; shift 2 ;;
    --no-tar) NO_TAR=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

log() { echo -e "\n▶ $*"; }
ok()  { echo "  ✅ $*"; }
die() { echo "  ❌ $*" >&2; exit 1; }

command -v tar >/dev/null 2>&1 || die "没有 tar"

# ── 1. 定版本与架构 ──
#
# 版本号以**包内镜像归档**为准，不是 git HEAD。
# 为什么：镜像名形如 openlog-<sha>-<时间>.tar.gz，里面的 <sha> 才是这个镜像
# 真正构建自哪个提交。用 HEAD 会出现「包叫 9ccf4cd、镜像却是 6a14c377」的错位
# —— 打包时 HEAD 可能已经往前走了（比如只改了文档提交），镜像还是上一次构建的。
APP_ARCHIVE="$(ls -1t "$IMAGES_DIR"/openlog-*.tar.gz 2>/dev/null | head -1 || true)"
[ -n "$APP_ARCHIVE" ] || die "deploy/images/ 下没有 openlog-*.tar.gz（先用 save-image.sh 归档）"

COMMIT="$(basename "$APP_ARCHIVE" | sed -E 's/^openlog-([0-9a-f]+)-.*/\1/')"
[ -n "$COMMIT" ] || die "无法从归档文件名解析版本: $(basename "$APP_ARCHIVE")"

HEAD_COMMIT="$(cd "$REPO_DIR" && git rev-parse --short=8 HEAD 2>/dev/null || echo unknown)"
if [ "$HEAD_COMMIT" != "unknown" ] && [ "${HEAD_COMMIT#"$COMMIT"}" = "$HEAD_COMMIT" ]; then
  echo "  ⚠️  包内镜像是 $COMMIT，但当前 HEAD 是 $HEAD_COMMIT —— 以镜像为准打包"
  echo "     （若这是有意的，忽略即可；否则先重新构建镜像再打包）"
fi

echo "  ℹ️  版本取自镜像归档：$COMMIT"

if [ -z "$ARCH" ]; then
  # 从归档里读，而不是问用户 —— 问用户就会填错
  ARCH="$(tar -xzOf "$APP_ARCHIVE" manifest.json 2>/dev/null \
          | tr -d '\000' | grep -o '"Config"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
          | sed -E 's/.*"([^"]*)"$/\1/' \
          | xargs -I{} tar -xzOf "$APP_ARCHIVE" {} 2>/dev/null \
          | tr -d '\000' | grep -o '"architecture"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
          | sed -E 's/.*"([^"]*)"$/\1/')"
  [ -n "$ARCH" ] || die "无法从归档读出架构，请用 --arch 指定"
fi

case "$ARCH" in
  amd64|x86_64) ARCH=amd64; ARCH_LABEL="linux/amd64（x86_64）"; OTHER_ARCH=arm64; OTHER_SUFFIX="-arm64" ;;
  arm64|aarch64) ARCH=arm64; ARCH_LABEL="linux/arm64（AArch64）"; OTHER_ARCH=amd64; OTHER_SUFFIX="" ;;
  *) die "不认识的架构: $ARCH" ;;
esac

PKG_NAME="openlog-deploy-${COMMIT}"
[ "$ARCH" = "arm64" ] && PKG_NAME="${PKG_NAME}-arm64"

log "装配 $PKG_NAME（$ARCH）"

# ── 2. 定位镜像 ──
# APP_ARCHIVE 已在第 1 步定位（版本号取自它），这里只补 postgres
PG_ARCHIVE="$(ls -1t "$IMAGES_DIR"/postgres-*.tar.gz 2>/dev/null | head -1 || true)"

# 复核归档架构与实际架构一致
ACTUAL_ARCH="$(tar -xzOf "$APP_ARCHIVE" manifest.json 2>/dev/null \
               | tr -d '\000' | grep -o '"Config"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
               | sed -E 's/.*"([^"]*)"$/\1/' \
               | xargs -I{} tar -xzOf "$APP_ARCHIVE" {} 2>/dev/null \
               | tr -d '\000' | grep -o '"architecture"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
               | sed -E 's/.*"([^"]*)"$/\1/')"
[ -z "$ACTUAL_ARCH" ] || [ "$ACTUAL_ARCH" = "$ARCH" ] \
  || die "归档架构是 $ACTUAL_ARCH，但 --arch 指定了 $ARCH"
ok "应用镜像 $(basename "$APP_ARCHIVE")  ($ARCH)"
[ -n "$PG_ARCHIVE" ] && ok "数据库镜像 $(basename "$PG_ARCHIVE")"

# ── 3. 组装目录 ──
STAGE_ROOT="$(cd "$REPO_DIR/.." && pwd)"
STAGE="$STAGE_ROOT/$PKG_NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/deploy"

# 复制 deploy/ 的脚本与文档，排除镜像 tar 与敏感文件
( cd "$REPO_DIR" && tar -cf - \
    --exclude='.deploy.json' \
    --exclude='deploy/deploy.env' \
    --exclude='*.tar.gz' \
    --exclude='*.bak.*' \
    deploy ) | ( cd "$STAGE" && tar -xf - )
ok "已复制 deploy/ 脚本树"

mkdir -p "$STAGE/deploy/images"
cp "$APP_ARCHIVE" "$STAGE/deploy/images/"
[ -n "$PG_ARCHIVE" ] && cp "$PG_ARCHIVE" "$STAGE/deploy/images/"

# ── 4. 渲染 README（文档内容一律从实际文件推导，不手写）──
IMAGE_TAG="$(basename "$APP_ARCHIVE" | sed -E 's/^openlog-([0-9a-f]+)-.*/\1/')"
SELF_TAR="${PKG_NAME}.tar"

render() {
  sed \
    -e "s|{{VERSION}}|$COMMIT|g" \
    -e "s|{{IMAGE_TAG}}|$IMAGE_TAG|g" \
    -e "s|{{IMAGE_FILE}}|$(basename "$APP_ARCHIVE")|g" \
    -e "s|{{ARCH_LABEL}}|$ARCH_LABEL|g" \
    -e "s|{{ARCH}}|$ARCH|g" \
    -e "s|{{OTHER_ARCH}}|$OTHER_ARCH|g" \
    -e "s|{{OTHER_SUFFIX}}|$OTHER_SUFFIX|g" \
    -e "s|{{PKG_NAME}}|$PKG_NAME|g" \
    -e "s|{{SELF_TAR}}|$SELF_TAR|g" \
    "$1"
}

render "$REPO_DIR/deploy/README-offline.md" > "$STAGE/README.md"
# 包内那份也渲染，避免两份文档不一致
render "$REPO_DIR/deploy/README-offline.md" > "$STAGE/deploy/README-offline.md"

# 未替换的占位符说明模板与脚本不同步，必须报错而不是发出去
if grep -q '{{[A-Z_]*}}' "$STAGE/README.md"; then
  echo "  残留占位符：" >&2
  grep -o '{{[A-Z_]*}}' "$STAGE/README.md" | sort -u | sed 's/^/    /' >&2
  die "README 模板里有未知占位符，检查 make-package.sh 的 render()"
fi
ok "README 已按实际内容渲染（版本 $COMMIT / 架构 $ARCH）"

# ── 5. SHA256SUMS ──
( cd "$STAGE" && sha256sum deploy/images/*.tar.gz > SHA256SUMS )
ok "SHA256SUMS 已生成（$(grep -c . "$STAGE/SHA256SUMS") 项）"

# ── 6. 打包 ──
if [ "$NO_TAR" = "1" ]; then
  ok "目录已就绪（--no-tar 跳过打包）: $STAGE"
  exit 0
fi
[ -n "$OUT" ] || OUT="$STAGE_ROOT/$SELF_TAR"
rm -f "$OUT"
( cd "$STAGE_ROOT" && tar -cf "$OUT" "$PKG_NAME" )
ok "已打包 $OUT （$(du -h "$OUT" | cut -f1)）"
if command -v sha256sum >/dev/null 2>&1; then
  echo "     sha256 $(sha256sum "$OUT" | cut -d' ' -f1)"
fi

# ── 7. 自查 ──
log "自查"
N_TARS="$(tar -tf "$OUT" | grep -c '\.tar\.gz$' || true)"
[ "$N_TARS" -ge 2 ] || die "包内只有 $N_TARS 个镜像 tar，应为 2（应用 + postgres）"
ok "镜像 tar 数量 $N_TARS"
tar -tf "$OUT" | grep -q '\.deploy\.json' && die "包里混进了 .deploy.json（含真实凭据）"
ok "无 .deploy.json"
tar -tf "$OUT" | grep -q 'install.sh' || die "包里没有 install.sh"
ok "install.sh 在"
grep -q 'check_arch' "$STAGE/deploy/install.sh" || die "install.sh 不含架构自检"
ok "install.sh 带架构自检"
