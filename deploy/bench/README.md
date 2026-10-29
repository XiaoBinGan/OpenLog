# deploy/bench/ — 容量基准脚本

用于**复核** README 里「单实例 1000 台」那些实测数字。改动连接池/采集逻辑后重跑一遍，
比凭感觉调参数靠谱。

三个脚本都是独立进程，**不接生产数据**：要么用独立临时库，要么只做连接探测。

## 1. SSH 连接成本与并发上限

```bash
# 在服务器上，用生产镜像的临时容器跑（host 网络）
docker run --rm --network host --memory=1g \
  -e PROBE_N=1000 -e PROBE_CONC=20 \
  -e PROBE_HOST=127.0.0.1 -e PROBE_PORT=40022 \
  -e PROBE_USER=<user> -e PROBE_PASS=<password> -e PROBE_STATS=20 \
  -v "$PWD/deploy/bench/ssh-connections.mjs:/app/probe.mjs" \
  openlog:latest node /app/probe.mjs
```

输出：成功/失败连接数、失败原因、单连接 RSS（MB/条）、FD 增量、握手耗时 p95、单机 stats 命令耗时。

> ⚠️ 把 1000 条连接指向**同一台** sshd 会撞上目标机的 `MaxStartups 10:30:100`
> （默认 10:30:100），出现一批失败——这是测试假象，生产每台是不同主机。
> 判断客户端能力看 `connected` 数与 RSS/FD 增量即可。

## 2. 1000 台服务器 API/DB 端到端

```bash
docker run --rm --network host --memory=2g --cpus=2 \
  -e BENCH_N=1000 -e BENCH_PORT=3021 -e BENCH_DEAD_PORT=45999 \
  -v "$PWD/deploy/bench/servers-1000.mjs:/app/e2e.mjs" \
  openlog:latest node /app/e2e.mjs
```

自己播种 1000 行到独立 SQLite、起一个「接受即断开」的端口模拟不可达，然后测：
启动耗时、`GET /api/remote/servers` 体积/耗时、stats 一轮耗时、进程 RSS/FD。

## 3. PostgreSQL 1000 行读写

```bash
docker run --rm --network host \
  -e BENCH_PG_URL='postgres://user:pass@127.0.0.1:5432/openlog' -e BENCH_N=1000 \
  -v "$PWD/deploy/bench/pg-1000-rows.mjs:/app/bench.mjs" \
  openlog:latest node --expose-gc /app/bench.mjs
```

会建一个**临时库** `openlog_bench`（跑完自动删），测：批量插入、全量读取、
100 行批状态更新、API JSON 体积、常驻对象内存、索引查询。
