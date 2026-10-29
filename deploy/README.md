# deploy/ — 部署资产目录

部署相关的东西都集中在这里，和业务代码分开：

```
deploy/
├── README.md                    # 本文件：目录导航
├── MANUAL.md                    # 📖 部署手册（从零到运维的完整流程）
├── deploy.sh                    # 服务端部署脚本（备份 → 构建 → 启动 → 健康检查 → 回滚）
├── deploy.mjs                   # 开发机一键部署（bundle 上传 + 远程调用 deploy.sh）
├── deploy.env.example           # 服务端部署配置模板（复制成 deploy.env 并填密码）
├── deploy.config.example.json   # 开发机 SSH 配置模板（复制成 .deploy.json）
├── images/                      # 📦 镜像归档（docker save 的 tar.gz）+ 清单
│   ├── MANIFEST.md              # 当前归档了哪些镜像、对应 commit
│   └── README.md                # 归档/恢复说明
└── scripts/
    ├── save-image.sh            # 把镜像导出成 tar.gz 存到 images/
    └── load-image.sh            # 从 tar.gz 恢复镜像
```

## 三个常用命令

```bash
npm run deploy            # 一键部署（推荐）
npm run deploy:logs       # 看部署状态 / 最近日志
npm run deploy:image:save # 归档当前镜像（离线部署/长期回滚用）
```

## 注意

- `deploy.env`（含数据库密码）和 `deploy/.deploy.json`（SSH 凭据）**不进 git**，
  从对应的 `.example` 复制后填写。
- `deploy/images/*.tar.gz` 是几百 MB 的镜像归档，**不进 git**，只保留 `MANIFEST.md` 清单。
- 完整流程、备份恢复、回滚、排障见 **[MANUAL.md](./MANUAL.md)**。
