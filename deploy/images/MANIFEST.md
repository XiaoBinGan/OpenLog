# 镜像归档清单 | Image Archive Manifest

> 由 `deploy/scripts/save-image.sh` 自动维护。归档文件本身不进 git（见 `.gitignore`），
> 但这份清单会提交，用来记录「发过哪些版本、对应的 commit、校验和」。
>
> 归档/恢复说明见 [README.md](./README.md)。

| 归档文件 | 镜像 | 镜像 ID | commit | 大小 | 归档时间 | SHA256 | 备注 |
|---|---|---|---|---|---|---|---|
| `openlog-latest-20261029-190823.tar.gz` | `openlog:latest` | `c29c63eaa3b6` | `e6264cc4` | 217M | 2026-10-29 19:08 | `664e711e29c29438…` | — |