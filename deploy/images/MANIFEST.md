# 镜像归档清单 | Image Archive Manifest

> 由 `deploy/scripts/save-image.sh` 自动维护。归档文件本身不进 git（见 `.gitignore`），
> 但这份清单会提交，用来记录「发过哪些版本、对应的 commit、校验和」。
>
> 归档/恢复说明见 [README.md](./README.md)。
>
> **位置**列：`本地` = 开发机仓库内 `deploy/images/`；`服务器` = 部署目标机的
> `deploy/images/`。同一个文件两边可以都有，校验和一致即可互通。

| 归档文件 | 镜像 | 镜像 ID | commit | 大小 | 归档时间 | SHA256 | 备注 | 位置 |
|---|---|---|---|---|---|---|---|---|
| `openlog-6885b4c0-20261030-020716.tar.gz` | `openlog:6885b4c0` | `3a8453355e98` | `6885b4c0` | 216M | 2026-10-30 02:07 | `a889678e49924f71…` | 当前生产版本（只读命令免确认 + watchFiles 修复 + 1000 台池上限） | 本地 + 服务器 |
| `openlog-latest-20261029-190823.tar.gz` | `openlog:latest` | `c29c63eaa3b6` | `e6264cc4` | 217M | 2026-10-29 19:08 | `664e711e29c29438…` | 旧版本（部署目录重构时） | 仅服务器 |
