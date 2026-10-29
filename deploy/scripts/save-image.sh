#!/usr/bin/env bash
# ─── 归档 Docker 镜像到 deploy/images/ ─────────────────────────────────────
#
# 用途：长期回滚点、离线部署、防止旧镜像被自动清理后无法回退。
#       （deploy.sh 每次部署会清理旧镜像，只保留最近 5 个）
#
# 用法（**在服务器上执行**，因为镜像在服务器 Docker 里）：
#     bash deploy/scripts/save-image.sh                        # 归档 openlog:latest
#     bash deploy/scripts/save-image.sh openlog:29ebc01e        # 归档指定 tag
#     bash deploy/scripts/save-image.sh openlog:latest 升级前    # 附备注
#
# 从开发机远程归档（无需登录服务器）：
#     node deploy/deploy.mjs --save-image
#
# 输出：deploy/images/openlog-<tag>-<日期>.tar.gz + 更新 MANIFEST.md
#
# 环境变量：
#   KEEP_ARCHIVES  保留最近多少个归档（默认 3；0 = 不清理）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
IMAGES_DIR="$DEPLOY_DIR/images"
MANIFEST="$IMAGES_DIR/MANIFEST.md"
KEEP_ARCHIVES="${KEEP_ARCHIVES:-3}"

IMAGE="${1:-openlog:latest}"
NOTE="${2:-}"

command -v docker >/dev/null || { echo "❌ 没装 docker"; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "❌ 镜像不存在: $IMAGE"; exit 1; }
mkdir -p "$IMAGES_DIR"

# 文件名里的 tag 不能带 / 和 :
SAFE_TAG="$(echo "$IMAGE" | tr '/:' '--')"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$IMAGES_DIR/${SAFE_TAG}-${STAMP}.tar.gz"

echo "▶ 归档 $IMAGE"
echo "  目标: $ARCHIVE"

# docker save 到管道再 gzip，避免先落一个 600MB 的裸 tar
docker save "$IMAGE" | gzip -1 > "$ARCHIVE"

SIZE_BYTES="$(stat -c%s "$ARCHIVE" 2>/dev/null || stat -f%z "$ARCHIVE")"
SIZE_HUMAN="$(du -h "$ARCHIVE" | cut -f1)"
SHA="$(sha256sum "$ARCHIVE" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}' | sed 's/^sha256://' | cut -c1-12)"
CREATED="$(docker image inspect "$IMAGE" --format '{{.Created}}')"
COMMIT="$(cd "$APP_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"

# 首次创建清单时写表头
if [ ! -f "$MANIFEST" ]; then
  cat > "$MANIFEST" <<'HEADER'
# 镜像归档清单 | Image Archive Manifest

> 由 `deploy/scripts/save-image.sh` 自动维护。归档文件本身不进 git（见 .gitignore），
> 但这份清单会提交，用来记录「发过哪些版本、对应的 commit、校验和」。

| 归档文件 | 镜像 | 镜像 ID | commit | 大小 | 归档时间 | SHA256 | 备注 |
|---|---|---|---|---|---|---|---|
HEADER
fi

# 追加前确保上一行以换行结尾，否则新记录会并进上一行（曾把两条归档挤成一行）
if [ -s "$MANIFEST" ] && [ -n "$(tail -c 1 "$MANIFEST")" ]; then
  echo >> "$MANIFEST"
fi

REL="$(realpath --relative-to="$APP_DIR" "$ARCHIVE" 2>/dev/null || echo "$ARCHIVE")"
printf '| `%s` | `%s` | `%s` | `%s` | %s | %s | `%s` | %s |\n' \
  "$(basename "$ARCHIVE")" "$IMAGE" "$IMAGE_ID" "$COMMIT" "$SIZE_HUMAN" \
  "$(date '+%Y-%m-%d %H:%M')" "$(echo "$SHA" | cut -c1-16)…" "${NOTE:-—}" >> "$MANIFEST"

echo "  ✅ $SIZE_HUMAN | sha256 ${SHA:0:16}… | commit $COMMIT"
echo "  清单: $REL"

# 清理旧归档（按修改时间）
if [ "$KEEP_ARCHIVES" -gt 0 ]; then
  OLD="$(ls -1t "$IMAGES_DIR"/*.tar.gz 2>/dev/null | tail -n +$((KEEP_ARCHIVES + 1)) || true)"
  if [ -n "$OLD" ]; then
    echo "▶ 清理旧归档（保留最近 $KEEP_ARCHIVES 个）"
    echo "$OLD" | while read -r f; do
      [ -n "$f" ] && echo "  删除 $(basename "$f")" && rm -f "$f"
    done
  fi
fi

echo "✅ 归档完成"
echo "   恢复: bash deploy/scripts/load-image.sh $REL"
