# deploy/images/ — 镜像归档目录

存放 `docker save` 导出的镜像 tar.gz，用于**长期回滚点**和**离线部署**。

> 归档文件（`*.tar.gz`，每个约 200–300MB）已加入 `.gitignore`，不进 git。
> 只有 `MANIFEST.md`（归档清单）会提交，记录发过哪些版本、对应 commit、校验和。

## 常用操作

```bash
# 在开发机：远程归档服务器上的 openlog:latest
npm run deploy:image:save

# 在服务器：归档指定 tag / 带备注
bash deploy/scripts/save-image.sh openlog:29ebc01e "v1.2 上线前"
bash deploy/scripts/save-image.sh                       # 默认 openlog:latest

# 查看清单
cat deploy/images/MANIFEST.md

# 从归档恢复（服务器上）
bash deploy/scripts/load-image.sh deploy/images/openlog-latest-20261029-190000.tar.gz
bash deploy/scripts/load-image.sh <归档> openlog:rollback    # 恢复并打新 tag

# 从开发机远程恢复
node deploy/deploy.mjs --load-image deploy/images/openlog-latest-20261029-190000.tar.gz
```

## 命名规则

`openlog-<tag>-<YYYYMMDD-HHMMSS>.tar.gz`
（tag 里的 `/` 和 `:` 会替换成 `-`，例如 `openlog-latest-20261029-190000.tar.gz`）

## 保留策略

`save-image.sh` 默认只保留最近 **3** 个归档（按修改时间），可用环境变量调整：

```bash
KEEP_ARCHIVES=10 bash deploy/scripts/save-image.sh    # 保留 10 个
KEEP_ARCHIVES=0  bash deploy/scripts/save-image.sh    # 不清理
```

## 为什么需要它

`deploy/deploy.sh` 每次部署后会清理旧镜像（只保留最近 5 个 `openlog:*`），
所以「两个月前那个稳定版本」会被删掉。要长期留住某个可回滚版本，就归档成 tar.gz：

```bash
npm run deploy:image:save && git add deploy/images/MANIFEST.md && git commit -m "chore: archive image"
```

归档后即使旧镜像被清掉，也能用 `load-image.sh` 恢复回来。
