#!/usr/bin/env bash
# ─── 从归档恢复 Docker 镜像 ───────────────────────────────────────────────
#
# 用法（**在服务器上执行**，因为镜像要 load 进服务器 Docker）：
#     bash deploy/scripts/load-image.sh deploy/images/openlog-latest-20261029-190000.tar.gz
#     bash deploy/scripts/load-image.sh <archive> openlog:rollback    # 恢复并打新 tag
#
# 从开发机远程执行：
#     node deploy/deploy.mjs --load-image <archive>
#
# 恢复后可以用它起容器，或让 deploy.sh 回滚（见 deploy/MANUAL.md 第 7 节）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ARCHIVE="${1:-}"
NEW_TAG="${2:-}"

if [ -z "$ARCHIVE" ]; then
  echo "用法: bash deploy/scripts/load-image.sh <归档文件.tar.gz> [新tag]"
  echo ""
  echo "可用归档:"
  ls -lh "$DEPLOY_DIR/images"/*.tar.gz 2>/dev/null || echo "  （暂无，先用 save-image.sh 归档）"
  exit 1
fi

# 支持相对 root 的路径（清单里记录的是相对路径）
if [ ! -f "$ARCHIVE" ] && [ -f "$DEPLOY_DIR/../$ARCHIVE" ]; then
  ARCHIVE="$DEPLOY_DIR/../$ARCHIVE"
fi
[ -f "$ARCHIVE" ] || { echo "❌ 找不到归档: $ARCHIVE"; exit 1; }

command -v docker >/dev/null || { echo "❌ 没装 docker"; exit 1; }

echo "▶ 校验归档"
EXPECTED="$(basename "$ARCHIVE" | sed -n 's/.*\.tar\.gz$//p')"
ACTUAL_SHA="$(sha256sum "$ARCHIVE" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
echo "  sha256: ${ACTUAL_SHA:0:16}…"

echo "▶ 导入镜像"
LOAD_OUTPUT="$(gunzip -c "$ARCHIVE" | docker load 2>&1)"
echo "$LOAD_OUTPUT" | sed 's/^/  /'

# docker load 输出形如 "Loaded image: openlog:latest" / "Loaded image ID: sha256:..."
LOADED_TAG="$(echo "$LOAD_OUTPUT" | sed -n 's/^Loaded image: //p' | head -1)"
LOADED_REF="${LOADED_TAG:-$(echo "$LOAD_OUTPUT" | sed -n 's/^Loaded image ID: //p' | head -1)}"

if [ -n "$NEW_TAG" ] && [ -n "$LOADED_REF" ]; then
  echo "▶ 打新 tag: $NEW_TAG"
  docker tag "$LOADED_REF" "$NEW_TAG"
  LOADED_REF="$NEW_TAG"
fi

echo ""
echo "✅ 恢复完成: ${LOADED_REF:-（未解析到 tag，用 docker images 确认）}"
echo "   起容器示例:"
echo "   docker rm -f openlog && docker run -d --name openlog --network host --restart unless-stopped \\"
echo "     -e NODE_ENV=production -e PORT=3001 -e HOST=0.0.0.0 \\"
echo "     -e OPENLOG_DB_TYPE=postgres -e OPENLOG_DATABASE_URL='<连接串>' \\"
echo "     -v <DATA_DIR>:/app/data -v openlog-logs:/app/logs ${LOADED_REF:-openlog:latest}"
