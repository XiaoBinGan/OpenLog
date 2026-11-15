# 时序库与 Prometheus 兼容

OpenLog 内置一套 Prometheus 兼容的时序能力：抓取外部 `/metrics`、自己存指标、
用 PromQL 查询、按表达式告警。

## 它解决什么

在此之前，OpenLog 的系统指标只存在一个内存数组里：

```
monitorHistory：1000 条 × 5 秒 ≈ 83 分钟
进程重启 → 历史全部丢失
```

也就是说「昨天下午 CPU 是不是高过」这种问题答不了。现在有了持久化时序库。

## 快速开始

不需要配置就能用。默认情况下 OpenLog 只采集**自己**的指标并暴露在 `/metrics`。

要抓外部目标，创建 `data/tsdb.json`：

```json
{
  "scrapeConfigs": [
    { "job": "node", "targets": ["http://10.0.0.11:9100"] }
  ]
}
```

重启后生效。

完整样例见 [`deploy/tsdb.config.example.json`](./tsdb.config.example.json)。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `retentionDays` | 7 | 采样点保留天数。超期自动清理，每小时跑一次 |
| `scrapeInterval` | 15s | 全局默认抓取间隔，单个 job 可覆盖 |
| `scrapeConfigs[]` | `[]` | 抓取目标 |
| `ruleGroups[]` | `[]` | 告警与记录规则 |
| `inhibitRules[]` | `[]` | 抑制规则 |
| `routes[]` | `[{groupBy:["alertname"]}]` | 告警分组 |
| `silences[]` | `[]` | 静默窗口 |
| `receivers[]` | `[]` | 告警通知接收器（webhook）。不配则只经 API 拉取 |
| `remoteWrite[]` | `[]` | 推给 Thanos / VictoriaMetrics / Mimir |
| `tiers[]` | 5m/90天 | 保留期分层：原始 → 降采样 |

### scrapeConfigs

| 键 | 说明 |
|---|---|
| `job` | 必填。抓取任务名，会作为 `job` 标签 |
| `targets` | 必填。完整 URL 列表，必须带 `http://` 或 `https://` |
| `metricsPath` | 默认 `/metrics` |
| `interval` / `timeout` | `15s` / `10s` 这样的时长，或纯数字毫秒 |
| `labels` | 附加到所有样本的标签 |
| `bearerToken` | 端点需要鉴权时用 |
| `basicAuth` | `{ "username": "...", "password": "..." }` |

**OpenLog 自己的 `/metrics` 在鉴权后面**，抓它要配 token：

```bash
docker exec openlog cat /app/data/.auth_token
```

```json
{ "job": "self", "targets": ["http://127.0.0.1:3001"], "bearerToken": "<token>" }
```

### ruleGroups

```json
{
  "name": "host",
  "rules": [
    {
      "alert": "HostDown",
      "expr": "up == 0",
      "for": "1m",
      "labels": { "severity": "critical" },
      "annotations": { "summary": "{{ $labels.instance }} 抓取失败超过 1 分钟" }
    },
    { "record": "job:up:count", "expr": "count(up == 1) by (job)" }
  ]
}
```

`for` 的语义是**持续满足**，不是累计满足：条件第一次为真时进入 pending，
在 `for` 到期前如果变成假，立刻退回 inactive 且计时清零。

注意：pending 状态不持久化，**重启后要重新等满 `for`**。这是 Prometheus 的
同样行为，不隐藏。

### inhibitRules

一个节点挂掉会连带着喷出几十条「CPU 高」「磁盘满」，把原因埋掉。抑制规则
用来压掉这些衍生告警：

```json
{
  "sourceMatch": { "alertname": "HostDown" },
  "targetMatch": { "severity": "warning" },
  "equal": ["instance"]
}
```

`equal` 里列出的标签两边必须相同才抑制 —— 不加的话会全局误伤。

### silences

维护窗口用：

```json
{
  "id": "maint-2026-11",
  "matchers": { "job": "node" },
  "startsAt": 1794676000000,
  "endsAt": 1794683200000,
  "createdBy": "oncall",
  "comment": "内核升级"
}
```

## 告警通知

规则触发后要**发出去**。不配 `receivers` 时规则照常求值，
只是没有通知（可以从 `/api/v1/alerts` 拉）。

```json
{
  "receivers": [{
    "id": "ops",
    "name": "运维群",
    "url": "https://example.com/webhook/alert",
    "enabled": true,
    "repeatIntervalMs": 14400000,
    "sendResolved": true
  }]
}
```

payload 是 **Alertmanager 兼容格式**（`{status, alerts:[{labels, annotations, startsAt, endsAt}]}`），
钉钉/飞书/企业微信的中转器、Grafana OnCall、Robusta 都认这个形状。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 关掉这个接收器但不删配置 |
| `repeatIntervalMs` | 4 小时 | 同一条告警多久重发一次 |
| `sendResolved` | true | 恢复时是否也发（建议开，否则值班要自己回来确认） |
| `headers` | `{}` | 自定义请求头（有些通道要 token） |
| `timeoutMs` | 10 秒 | 超时只记日志，不阻塞规则求值 |

**去重粒度是「告警实例」而不是规则名**：`sum by (instance)` 一条规则可能同时
产出 50 条告警，按规则名去重会让其余 49 个实例发不出去。

配完通道想验证通不通，不用等真出故障 —— 用 `POST /api/tsdb/test-notify`。

## 长期存储（remote write）

本地保留 7 天原始 + 90 天降采样。要更长周期，推给远端：

```json
{
  "remoteWrite": [{
    "url": "http://victoria-metrics:8428/api/v1/write",
    "enabled": true,
    "timeoutMs": 30000
  }]
}
```

协议是标准的 **Prometheus remote write**（protobuf + snappy，
`Content-Type: application/x-protobuf`），Thanos / VictoriaMetrics / Mimir 都能收。

实现上不依赖 protobuf/snappy 库：手写编码器，snappy 只做 literal-only 压缩。
压缩率不如官方实现，但**推送前会先本地解一遍自检** ——
编码错了在远端只表现为一句 "snappy: corrupt input"，本地自检能立刻定位。

## 保留期分层

一刀切删除会让超过保留期的历史永久消失。默认两档：

| 档位 | 分辨率 | 保留 |
|---|---|---|
| 原始 | 抓取间隔（默认 15s） | 7 天 |
| 降采样 | 5 分钟 | 90 天 |

```json
{
  "retentionDays": 7,
  "tiers": [{ "resolutionMs": 300000, "retentionDays": 90, "sourceRetentionDays": 7 }]
}
```

降采样产出四个聚合值，指标名带后缀：

```
openlog_cpu_usage_percent:5m_max
openlog_cpu_usage_percent:5m_min
openlog_cpu_usage_percent:5m_avg
openlog_cpu_usage_percent:5m_count
```

**为什么存四个而不是只存平均值**：只留 avg 会把「CPU 瞬间打满」这种尖峰抹平，
而那恰恰是排查时最想看的。四个值多占 4 倍空间，但比原始点少 20 倍，净省 5 倍。

顺序保证：**先降采样成功，才删原始数据**。降采样没追平就拒绝删除，
不会出现「原始已删、降采样还没算出来」的空洞。

## AI 助手能查指标

运维助手有两个工具：`list_metrics` 和 `query_metrics`。
可以直接问「昨天下午 CPU 最高到多少」「磁盘什么时候开始涨的」。

返回的是统计摘要（min/max/avg/首末值/趋势/峰值时刻）而不是几百个原始点。
危险查询会被挡掉：子查询步长 < 1 秒、`{__name__=~".*"}` 全表扫、跨度 > 7 天。

## API

与 Prometheus HTTP API 同形状，Grafana 可以直接接。

| 端点 | 说明 |
|---|---|
| `GET /metrics` | 自身的 Prometheus 暴露格式 |
| `GET /api/v1/query?query=&time=` | 瞬时查询 |
| `GET /api/v1/query_range?query=&start=&end=&step=` | 区间查询 |
| `GET /api/v1/labels` | 全部标签名 |
| `GET /api/v1/label/:name/values` | 某标签的值 |
| `GET /api/v1/series?match[]=` | 序列列表 |
| `GET /api/v1/targets` | 抓取目标状态 |
| `GET /api/v1/rules` | 规则与告警状态 |
| `GET /api/v1/alerts` | 当前告警 |
| `GET /api/v1/alert_groups` | 按 groupBy 分组后的告警 |
| `GET /api/tsdb/status` | 存储概况 |

```bash
TOKEN=$(docker exec openlog cat /app/data/.auth_token)

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/v1/query?query=openlog_memory_usage_percent"

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/v1/query_range?query=rate(openlog_tsdb_samples_total[5m])&start=$(date -d '1 hour ago' +%s)&end=$(date +%s)&step=60"
```

## 支持的 PromQL

**选择器**
```
metric
metric{a="1", b=~"x.*", c!="2", d!~"y.*"}
{__name__=~"node_.*"}
metric[5m]
metric offset 5m
metric[5m] offset 1h
```

**函数**

| 类别 | 函数 |
|---|---|
| 计数器 | `rate` `irate` `increase` `resets` `changes` |
| Gauge | `delta` `idelta` `deriv` `predict_linear` |
| 区间聚合 | `avg_over_time` `min_over_time` `max_over_time` `sum_over_time` `count_over_time` `stddev_over_time` `quantile_over_time` `last_over_time` `present_over_time` |
| 数学 | `abs` `ceil` `floor` `round` `sqrt` `exp` `ln` `log2` `log10` `sgn` `clamp` `clamp_min` `clamp_max` `deg` `rad` |
| 三角 | `sin` `cos` `tan` `asin` `acos` `atan` |
| 时间 | `time` `timestamp` `minute` `hour` `day_of_month` `day_of_week` `day_of_year` `month` `year` `days_in_month` |
| 标签 | `label_replace` `label_join` |
| 直方图 | `histogram_quantile` |
| 其他 | `vector` `scalar` `sort` `sort_desc` `absent` `absent_over_time` |

**聚合**

`sum` `avg` `min` `max` `count` `group` `stddev` `stdvar` `topk` `bottomk` `quantile` `count_values`

支持 `by (...)` / `without (...)`，也支持前置与后置两种写法：
```
sum by (job) (rate(x[5m]))
sum(rate(x[5m])) by (job)
```

**二元运算**

`+ - * / % ^ atan2`、`== != > < >= <=`、`and or unless`，
以及 `bool`、`on(...)`、`ignoring(...)`、`group_left(...)`、`group_right(...)`。

## 子查询与 @ 修饰符

```
rate(sum(http_total)[5m:1m])          先聚合再算变化率
max_over_time(rate(x[1m])[30m:1m])   对外层结果再取区间聚合
x @ 1700000000                       钉在指定时刻求值
x @ start()  /  x @ end()            取查询区间的两端
x[5m] @ 1700000000 offset 5m         钉住时刻后再往前偏移
```

子查询默认步长 60 秒，单次最多 5000 步 —— `x[1h:1s]` 会明确报错，
不会把服务拖死。

**错误一律明确报出，不静默降级**。一个被悄悄忽略的 `offset` 会让查询
返回完全错误的数据，比报错难查得多。

## 导出的自身指标

| 指标 | 类型 | 说明 |
|---|---|---|
| `openlog_cpu_usage_percent` | gauge | CPU 平均使用率 |
| `openlog_cpu_core_usage_percent{core}` | gauge | 单核使用率 |
| `openlog_cpu_load_percent` | gauge | CPU 负载（与界面同口径） |
| `openlog_memory_total_bytes` / `_used_bytes` / `_free_bytes` | gauge | 内存 |
| `openlog_memory_usage_percent` | gauge | 内存使用率 |
| `openlog_disk_total_bytes{mount}` / `_used_bytes` / `_usage_percent` | gauge | 磁盘 |
| `openlog_network_receive_bytes_total{iface}` / `_transmit_` | counter | 网卡累计字节 |
| `openlog_gpu_utilization_percent{gpu}` | gauge | GPU 利用率 |
| `openlog_gpu_memory_used_bytes{gpu}` / `_total_bytes` | gauge | 显存（字节） |
| `openlog_gpu_temperature_celsius{gpu}` | gauge | GPU 温度 |
| `openlog_processes_total` | gauge | 进程数 |
| `openlog_capacity_alert{key,level}` | gauge | 容量告警是否触发 |
| `openlog_docker_containers_total` | gauge | 容器总数 |
| `openlog_docker_containers_by_state{state}` | gauge | 按状态分组 |
| `openlog_tsdb_series_total` / `_samples_total` | gauge | 时序库规模 |
| `openlog_tsdb_ready` | gauge | 时序库是否可用 |
| `openlog_scrape_rounds_total` / `_targets_total` / `_failures_total` | counter | 抓取统计 |
| `up{job,instance}` | gauge | 目标是否存活 |
| `scrape_duration_seconds{job,instance}` | gauge | 抓取耗时 |

### 为什么容器不按容器导出

容器 ID 基数高且会频繁重建，把它当标签会产生大量短命序列 —— 这是
Prometheus 使用者最常踩的坑（cardinality explosion）。所以只导出计数，
要看单个容器用 `/api/docker/containers`。

同理 GPU 用序号不用名称（名称随驱动升级变化），磁盘用挂载点。

## 让 Prometheus 抓 OpenLog

```yaml
# prometheus.yml
scrape_configs:
  - job_name: openlog
    authorization:
      credentials_file: /etc/prometheus/openlog-token
    static_configs:
      - targets: ['openlog-host:3001']
```

反过来也成立：OpenLog 的 `scrapeConfigs` 可以抓任何 `/metrics` 端点。

## 环境变量

| 变量 | 说明 |
|---|---|
| `OPENLOG_TSDB=off` | 关闭整个时序库子系统 |
| `OPENLOG_TSDB_RETENTION_DAYS` | 保留天数，覆盖配置文件 |
| `OPENLOG_TSDB_INTERVAL` | 抓取间隔，覆盖配置文件 |

## 规模与限制

- 存储：SQLite 单文件，写入按批（500 点/语句）。10 万序列 × 15s 抓取
  对单机 SQLite 偏重，这个量级建议改用 PG
- 抓取：中心化拉取，目标数受限于单进程并发。1000 台以内实测可跑
  （见 `deploy/bench/`），再大需要分片
- 查询：区间查询逐点求值，单次上限 11000 点。超了会报错让你调大 step，
  而不是静默截断
- 没有 federation 与 remote write。要长期存储请用 Prometheus + Thanos 那条路