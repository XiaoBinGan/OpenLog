/**
 * default-skills.js — 系统内置技能（is_default=1，界面不可修改/删除）
 *
 * 为什么单独一个模块：
 *   内置技能原先硬编码在 scripts/init-db.js 里，而那段逻辑是「库里没有内置技能时才播种」。
 *   结果是**新增内置技能对已部署实例无效** —— 老库永远看不到新技能。
 *   现在清单放这里，server 启动时由 ensureBuiltinSkills() 按 id 幂等补齐。
 *
 * 技能格式：Markdown，含 # Purpose / # Workflow / # Constraints / # Output 四段。
 * 在「技能」页点「在运维助手中使用」会把 content 整段带进对话，等于给模型一份 runbook。
 */

export const BUILTIN_SKILLS = [
  {
    "id": "d8b4c5e9-f0a1-2345-abcd-456789012345",
    "name": "应用部署与发布",
    "command": "bash deploy/deploy.sh",
    "description": "按部署包发布/更新服务：备份数据库 → 导入或构建镜像 → 启动容器 → 健康检查 → 失败自动回滚",
    "category": "部署",
    "content": "# Purpose\n把一台机器上的服务**部署或更新**到目标版本，并验证确实可用；失败要能回滚。\n适用于本仓库的 OpenLog，也适用于任何「有部署脚本 + 健康检查」的服务。\n\n# Workflow\n1. **定位目标机**：remote_servers 拿 serverId（不确定是哪台就先问，别猜）。\n2. **确认部署包在位**：remote_ls 看目标机是否有 deploy/ 目录；\n   有 deploy/MANUAL.md 就先 remote_read_file 读它（步骤以目标机上的手册为准）。\n3. **读配置**：remote_read_file 读 deploy/deploy.env（拿端口、数据库连接串、镜像名）。\n   **只读不改**，尤其不要改密码。\n4. **确认回滚点**：\n   - remote_exec `cat backups/.last-deploy.json` 看上一个正常镜像；\n   - remote_exec `docker images --format \"{{.Repository}}:{{.Tag}} {{.CreatedAt}}\" | head` 看可用镜像。\n   没有回滚点就先跟用户确认是否继续。\n5. **发布**（二选一）：\n   - 有镜像归档：remote_exec `docker load -i deploy/images/<file>.tar.gz`，\n     然后 `bash deploy/deploy.sh --no-build`（脚本会备份、启动、健康检查、失败回滚）；\n   - 没有归档：remote_exec `bash deploy/deploy.sh`（脚本自己 build，**耗时 2-4 分钟**，\n     超过单轮预算就先告诉用户再跑）。\n6. **健康检查**（全部只读，直接执行）：\n   - `curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:<PORT>/` 期望 200；\n   - `TOK=$(curl -s http://127.0.0.1:<PORT>/api/auth/token | sed -n 's/.*\"token\":\"\\([^\"]*\\)\".*/\\1/p')`\n     然后 `curl -s -H \"Authorization: Bearer $TOK\" http://127.0.0.1:<PORT>/api/db/info` 期望 `\"ok\":true`；\n   - `docker ps --filter name=<容器名> --format \"{{.Status}}\"` 确认在跑；\n   - `docker logs --tail 40 <容器名>` 确认没有 ERROR/UncaughtException。\n7. **失败就回滚**：deploy.sh 自带失败回滚；手工回滚用更新前的镜像 tag 重新 docker run。\n8. **汇报**：版本/commit、镜像 tag、健康检查结果、回滚点、是否需要后续动作。\n\n# Constraints\n- **先备份再动手**：部署脚本会备份数据库；手工部署时必须自己 `pg_dump` 或复制 SQLite。\n- **不碰无关容器**：只操作目标服务，禁止 `docker rm -f` 别的容器、禁止 `docker system prune`。\n- **不改密钥**：deploy.env 里的数据库密码、OPENLOG_SECRET_KEY 只读不改（改了会导致既有数据无法解密）。\n- **单任务预算 30 轮 / 10 分钟**：构建慢或要排查很久时，先给阶段性结论，让用户决定是否继续。\n- **写操作会弹确认**：一次说明白「要执行什么、为什么」，不要反复试探。\n- **验证通过才算完成**：没跑健康检查不要说「已部署」。\n\n# Output\n- 部署前版本（commit / 镜像）与回滚点\n- 执行的命令要点（导入镜像 / 启动 / 回滚）\n- 健康检查逐项结果（页面码、db/info、容器状态、日志有无报错）\n- 部署后版本与访问地址\n- 未解决项与建议下一步",
    "is_default": 1
  },
  {
    "id": "b6da56e1-c0f7-49d6-9677-ca9d4e55b7ee",
    "name": "Docker 容器异常退出",
    "command": "docker ps -a --filter status=exited",
    "description": "列出异常退出的容器及退出码",
    "content": "# Purpose\n检查 Docker 容器异常退出情况\n\n# Workflow\n1. 列出所有异常退出的容器\n2. 检查退出码和退出原因\n3. 查看容器日志最后 50 行\n\n# Constraints\n- 只读操作，不修改容器状态\n- 如发现 OOMKilled，建议检查内存限制\n\n# Output\n- 容器名、退出码、退出时间\n- 异常原因分析",
    "category": "Docker",
    "is_default": 1
  },
  {
    "id": "c1a7b8d2-e3f4-5678-9abc-def012345678",
    "name": "磁盘空间检查",
    "command": "df -h && du -sh /var/log/* 2>/dev/null | sort -rh | head -10",
    "description": "检查磁盘使用率和最大目录",
    "content": "# Purpose\n检查服务器磁盘使用情况\n\n# Workflow\n1. 查看所有挂载点使用率\n2. 列出 /var/log 下最大的目录/文件\n3. 识别占用超过 80% 的分区\n\n# Constraints\n- 只读操作\n\n# Output\n- 各分区使用率\n- Top 10 大目录",
    "category": "系统",
    "is_default": 1
  },
  {
    "id": "d2b8c9e3-f4a5-6789-abcd-ef0123456789",
    "name": "CPU 飙高排查",
    "command": "top -bn1 | head -20 && ps aux --sort=-%cpu | head -10",
    "description": "排查 CPU 占用高的进程",
    "content": "# Purpose\n排查 CPU 使用率异常\n\n# Workflow\n1. top 查看系统负载概览\n2. ps 按 CPU 排序列出 Top 10 进程\n3. 检查 load average 与 CPU 核心数比例\n\n# Constraints\n- 只读操作\n\n# Output\n- 系统负载\n- Top 10 CPU 进程",
    "category": "系统",
    "is_default": 1
  },
  {
    "id": "e3c9d0f4-a5b6-7890-bcde-f01234567890",
    "name": "内存泄漏排查",
    "command": "free -h && ps aux --sort=-%mem | head -10",
    "description": "排查内存占用异常",
    "content": "# Purpose\n排查内存使用异常\n\n# Workflow\n1. free 查看内存总览\n2. ps 按内存排序列出 Top 10 进程\n3. 检查 swap 使用情况\n\n# Constraints\n- 只读操作\n\n# Output\n- 内存使用率\n- Top 10 内存进程",
    "category": "系统",
    "is_default": 1
  },
  {
    "id": "f4d0e1a5-b6c7-8901-cdef-012345678901",
    "name": "日志巡检",
    "command": "grep -rn \"ERROR|FATAL|Exception\" /var/log/*.log 2>/dev/null | tail -50",
    "description": "扫描日志中的错误和异常",
    "content": "# Purpose\n扫描日志中的错误信息\n\n# Workflow\n1. 搜索 ERROR/FATAL/Exception 关键词\n2. 返回最近 50 条匹配\n3. 统计各类错误频率\n\n# Constraints\n- 只读操作，不修改日志\n\n# Output\n- 错误日志条目\n- 错误类型分布",
    "category": "日志",
    "is_default": 1
  },
  {
    "id": "a5e1f2b6-c7d8-9012-defa-123456789012",
    "name": "Nginx 访问分析",
    "command": "tail -1000 /var/log/nginx/access.log 2>/dev/null | awk '{print $9}' | sort | uniq -c | sort -rn",
    "description": "分析 Nginx 访问日志状态码分布",
    "content": "# Purpose\n分析 Nginx 访问状态\n\n# Workflow\n1. 统计最近 1000 条请求的状态码分布\n2. 检查 4xx/5xx 比例\n3. 如有大量 5xx，检查 error.log\n\n# Constraints\n- 只读操作\n\n# Output\n- 状态码分布\n- 异常比例分析",
    "category": "服务",
    "is_default": 1
  },
  {
    "id": "b6f2a3c7-d8e9-0123-efab-234567890123",
    "name": "MySQL 慢查询",
    "command": "mysql -e \"SHOW FULL PROCESSLIST;\" 2>/dev/null || echo \"MySQL 未连接\"",
    "description": "检查 MySQL 慢查询和锁等待",
    "content": "# Purpose\n检查 MySQL 运行状态\n\n# Workflow\n1. SHOW PROCESSLIST 查看当前查询\n2. 检查长时间运行的查询\n3. 检查锁等待\n\n# Constraints\n- 只读操作\n\n# Output\n- 运行中的查询列表\n- 慢查询分析",
    "category": "数据库",
    "is_default": 1
  },
  {
    "id": "c7a3b4d8-e9f0-1234-fabc-345678901234",
    "name": "网络连通性",
    "command": "ping -c 4 8.8.8.8 && ss -tlnp | head -20",
    "description": "检查网络连通性和监听端口",
    "content": "# Purpose\n检查网络连通性\n\n# Workflow\n1. ping 外网测试连通性\n2. 列出所有监听端口\n3. 检查 DNS 解析\n\n# Constraints\n- 只读操作\n\n# Output\n- 网络连通状态\n- 端口监听列表",
    "category": "网络",
    "is_default": 1
  }
];

/** 内置技能的 id 集合（用于判断某个技能是否受保护） */
export const BUILTIN_SKILL_IDS = new Set(BUILTIN_SKILLS.map(s => s.id));

export default BUILTIN_SKILLS;
