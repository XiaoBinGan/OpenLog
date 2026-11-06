# OpenLog 监控体系 —— 并行开发契约（所有人必须遵守）

> 这份文件是 20 个子代理之间**唯一的接口约定**。任何人不许改这里已定好的函数签名；
> 确实需要改，先停止并在最终报告里写明，由 Lead 统一改。

## 0. 铁律

1. **只碰自己名下的文件**。清单见第 6 节。别人的文件一行都不改（包括修 typo）。
2. **不跑全量测试、不跑 lint:all、不跑 build、不 deploy、不 git commit**。
   只跑 `npx vitest run <你自己的测试文件>`。
3. **不新增 npm 依赖**。图表用已有组件，DB 用已有 `server/db` 适配层。
4. **模块是纯逻辑为主**：不 import express（除 middleware 那个文件）、不 import dockerode。
   需要 IO 的一律通过参数注入（`db` / `fetchImpl` / `exec` / `now`），便于单测。
5. 单文件 < 300 行；注释用中文，说明**为什么**这么做（不是复述代码）。
6. 所有导出都要有 JSDoc 说明参数与返回值。
7 交付时报告：创建/修改的文件、导出的函数签名、测试通过数、需要 Lead 做的接线（一句话）。

## 1. 目标

把「接口监控」和「数据库监控」做出来，落到 Monitor 页；同时补齐接口清单（OpenAPI）、
接口覆盖率、依赖拨测、测试覆盖率配置。**一切可关**：环境变量 `OPENLOG_METRICS=off` 时全部旁路。

## 2. 时间与时钟

- 延迟用**单调时钟**（`process.hrtime.bigint()`）计算，避免 NTP 跳变出现负值。
- 分钟桶 key 用 `Math.floor(Date.now() / 60000)`（wall clock），写入用 upsert（同分钟重复写只更新）。
- 所有落库时间戳统一 **UTC epoch 毫秒**。

## 3. 数据表（3 张，启动时自动建，失败不影响主服务启动）

```sql
-- 接口指标：每分钟每路由一行
CREATE TABLE IF NOT EXISTS api_metrics_minute (
  bucket_ms   BIGINT/INTEGER NOT NULL,   -- 分钟桶
  route       TEXT NOT NULL,             -- 归一化路径，如 /api/docker/containers/:sourceId/:containerId/logs
  method      TEXT NOT NULL,
  calls       INTEGER NOT NULL,          -- 该分钟请求数
  err4xx      INTEGER NOT NULL DEFAULT 0,
  err5xx      INTEGER NOT NULL DEFAULT 0,
  p50_ms      REAL,
  p95_ms      REAL,
  p99_ms      REAL,
  max_ms      REAL,
  PRIMARY KEY (bucket_ms, method, route)   -- SQLite/PG 都用这个主键
);

-- DB 采样：每 30s/5min 一行
CREATE TABLE IF NOT EXISTS db_metric_sample (
  ts_ms       BIGINT/INTEGER NOT NULL PRIMARY KEY,
  kind        TEXT NOT NULL,   -- 'light' | 'heavy'
  payload     TEXT NOT NULL    -- JSON 字符串（各库字段不同，避免建三套表）
);

-- 慢查询（只存指纹，不存参数值）
CREATE TABLE IF NOT EXISTS slow_query_log (
  id          BIGINT/INTEGER PRIMARY KEY,   -- 自增
  ts_ms       BIGINT/INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  ms          REAL NOT NULL,
  source      TEXT,                          -- 调用来源标记，如 'remote.files'
  sample      TEXT                           -- 截断后的 SQL（不含参数值）
);
```

索引：`api_metrics_minute(bucket_ms)`、`slow_query_log(ts_ms)`。
**SQLite 与 PG 的类型差异**：需要兼容层 —— `BIGINT` 在 SQLite 用 `INTEGER`，`SERIAL/自增` 在 PG 用 `BIGSERIAL`、SQLite 用 `INTEGER PRIMARY KEY AUTOINCREMENT`。
统一通过 `server/metrics/sql-dialect.js`（由 A2-store 负责人编写）提供的 `ddlFor(dbType)` 生成。

## 4. 关键函数签名（不许改）

### 4.1 `server/metrics/route-pattern.js`（负责人：pattern）

```js
/** 把真实路径归一化成路由模板，控制基数 */
export function normalizeRoutePath(path: string): string
// '/api/remote/servers/3f2b.../files' -> '/api/remote/servers/:id/files'
// '/api/docker/containers/local/4b53b00c8d2f/logs' -> '/api/docker/containers/:sourceId/:containerId/logs'
// 规则：uuid / 12+位hex（docker 短 id 就是 12 位）/ 纯数字 / 域名样式 都换成 :id；
//      已知前缀（/api/docker/containers/、/api/remote/servers/）按位置命名 :sourceId/:containerId
// 语义白名单（stats/batch/history/files/local/ping…）在特化位置不被吞，原样保留
/** 是否应该跳过（静态资源、webpack chunk、favicon 等） */
export function shouldSkipPath(path: string): boolean
/** 基数上限保护：超过上限的路径归到 '/__other__' */
export const MAX_ROUTES: number = 300
/** 超限兜底的路由名（registry 用） */
export const OTHER_ROUTE: string = '/__other__'
```

### 4.2 `server/metrics/registry.js`（负责人：registry）

```js
/** 创建内存滑窗注册表 */
export function createRegistry(opts?: { windowMs?: number; maxRoutes?: number }): Registry
// Registry.record(route, method, statusCode, durationMs): void
// Registry.snapshot(opts?: { windowMs?: number; limit?: number }): {
//   windowMs, totalCalls, totalErrors5xx, totalErrors4xx, errorRate, qps,
//   routes: Array<{ route, method, calls, err4xx, err5xx, errorRate, qps, p50, p95, p99, max }>,
//   slowest: Array<...>,   // 按 p95 降序 top10
//   errorTop: Array<...>,  // 按 err5xx 降序 top10
// }
// Registry.takeMinuteBuckets(nowMs): Array<{ bucketMs, route, method, calls, err4xx, err5xx, p50, p95, p99, max }>
//   —— 取走已结束分钟的聚合（取走后清零），供 api-store 落库
// Registry.reset(): void
/** 纯函数：百分位（线性插值），空数组返回 0 */
export function percentile(sortedAsc: number[], p: number): number
```

### 4.3 `server/metrics/api-middleware.js`（负责人：middleware）—— ✅ 已交付

```js
export function createApiMetricsMiddleware(opts: {
  registry: Registry,                             // 必填（record 非函数 → 创建期抛 TypeError）
  enabled?: () => boolean,                        // 默认 OPENLOG_METRICS !== 'off'
  normalize?: (p: string) => string,              // 默认原样返回 req.path；接线时注入 normalizeRoutePath
  shouldSkip?: ((p: string) => boolean) | null,   // 默认 null；接线时注入 shouldSkipPath
}): ((req, res, next) => void) & { dropped: number }
```
（原契约是硬 import `route-pattern.js`，实际改成**注入**：测试不需要真模块，且接线更灵活。返回的中间件上挂 `dropped` 计数。）
要求：
- 用 `res.on('finish')`；延迟用 `process.hrtime.bigint()`。
- 路由模板优先取 `req.route?.path` 拼 `req.baseUrl`；拿不到再用 `normalizeRoutePath(req.path)`。
- **丢弃 query string**；不记录 header、不记录 body。
- 跳过 `shouldSkipPath()` 命中项。
- 中间件本身不能抛异常（try/catch 包住，失败计数到 `dropped`）。

### 4.4 `server/metrics/api-store.js`（负责人：store）—— ✅ 已交付

```js
export function createApiStore(opts: { db: any; dbType: string; keepDays?: number; maxRows?: number }): ApiStore
// ApiStore.ensureSchema(): Promise<boolean>      —— 失败不抛，返回 false（调用方不要用它当启动闸门）
// ApiStore.writeBuckets(buckets): Promise<number> —— 一个事务批量 upsert；失败/丢批返回 0
// ApiStore.queryRange({ fromMs, toMs, route?, limit? }): Promise<rows>   // camelCase 字段
// ApiStore.prune(nowMs?): Promise<number>        // 保留期 + 行数硬上限（默认 200000 行）
// ApiStore.stats(): Promise<{ rows, approxBytes: number|null, tables }>
// ApiStore.insertSlowQuery({ tsMs, fingerprint, ms, source, sample }): Promise<boolean>  // 给 slowquery 落库
```
（实际实现把 `ddlFor`/`placeholder`/`upsertSql` 放到 `sql-dialect.js`，`api-store` 转出 `ddlFor`；
`db_metric_sample` 的保留期由 db-router/sampler 负责，store 不删它。）

### 4.5 `server/metrics/db-sampler.js`（负责人：sampler）

```js
export function createDbSampler(opts: {
  db: any; dbType: string;
  lightIntervalMs?: number;   // 默认 30_000
  heavyIntervalMs?: number;   // 默认 300_000
  now?: () => number;
  jitterRatio?: number;       // 默认 0.2，错峰用
}): DbSampler
// DbSampler.start(): void
// DbSampler.stop(): void
// DbSampler.sample(kind?: 'light'|'heavy'): Promise<object>  —— 手动触发一次（测试用）
// DbSampler.snapshot(): { lastLight, lastHeavy, lastError, samples, unavailable: string[] }
/** 纯函数：把 PG 的 pg_stat_activity 行数组压成摘要 */
export function summarizeActivities(rows: Array<{ state?: string, duration_ms?: number, wait_event?: string }>): {
  byState: Record<string, number>, longestMs: number, longestQuery?: string, waitEvents: Array<{ event: string, count: number }>
}
/** 纯函数：锁等待摘要 */
export function summarizeLocks(rows: Array<{ waiting?: boolean, blocked_by?: number }>): { waiting: number, blocking: number }
/** 纯函数：每张表的体积/命中率整理 */
export function summarizeTables(rows: Array<{ relname: string, bytes: number, live_tup: number, idx_scan: number, seq_scan: number, dead_tup: number }>): Array<{...}>
```
要求：
- 采样用**独立连接**（PG 传 `pool` 只借用一次连接并 `statement_timeout=3000`；SQLite 直接读同一 db 但只读 PRAGMA）。
- **重采样不重叠**：上次没跑完就跳过本次。
- 权限不足 / 方言不支持 → 记到 `unavailable`，**不许返回 0 冒充正常**。
- SQLite：`wal` 大小、`page_count*page_size`、`busy` 次数；`PRAGMA quick_check` 只在 heavy 且距上次 ≥ 6 小时时跑。
- MySQL：能力探测失败就把 `'mysql'` 加进 `unavailable`，不做假装支持。

### 4.6 `server/metrics/slow-query.js`（负责人：slowquery）—— ✅ 已交付

```js
export function fingerprintSql(sql: string): string
export function createSlowQueryLog(opts?: { thresholdMs?: number; max?: number; now?: () => number }): SlowQueryLog
// record({ sql, ms, source }) -> boolean
// list(limit?) -> Array<{ ts_ms, fingerprint, ms, source, sample }>
// reset()
export function shouldRecord(state, { fingerprint, ms, nowMs }): boolean
```
（`opts.now` 为追加的时钟注入；`sample` 直接存**指纹**——这是唯一能保证零参数泄露的取值。）

### 4.7 `server/metrics/route-coverage.js`（负责人：coverage）

```js
/** 接口清单 × 实际流量 = 覆盖率 */
export function buildCoverage(opts: {
  inventory: Array<{ method: string, path: string }>,
  traffic: Array<{ method: string, route: string, calls: number, lastSeenMs?: number }>,
  nowMs?: number,
}): {
  total: number, used: number, unused: number, coverageRate: number,
  unusedRoutes: Array<{ method: string, path: string }>,
  rows: Array<{ method: string, path: string, calls: number, lastSeenMs: number|null, used: boolean }>,
  /** 增量字段：有流量但清单里没有的路由（说明收集器漏了路由） */
  unknownTraffic: Array<{ method: string, route: string, calls: number, lastSeenMs: number|null }>,
}
```

### 4.8 `server/openapi.js`（负责人：openapi）

```js
/** 递归遍历 express app 的路由表，产出 OpenAPI 3.0 文档对象 */
export function buildOpenApi(app: any, opts?: { title?: string, version?: string, serverUrl?: string }): object
/** 把 express 的 ':id' 路径转成 OpenAPI 的 '{id}' */
export function expressPathToOpenApi(path: string): string
/** 从路由栈里收集 [{ method, path }]（docs 与覆盖率共用，供 U 层显示） */
export function collectRoutes(app: any): Array<{ method: string, path: string }>
/** 极小 HTML 文档页（不引 swagger-ui），返回完整 HTML 字符串 */
export function renderDocsHtml(spec: object): string
```
要求：必须处理 `app._router.stack` + 嵌套 `router.stack` + `app.use(prefix, router)` 的前缀拼接。

### 4.9 `server/dependency-probe.js`（负责人：probes）—— ✅ 已交付

```js
export function createProbes(opts: {
  targets: Array<{ id: string, kind: 'http'|'exec', url?: string, command?: string, timeoutMs?: number }>,
  fetchImpl?: typeof fetch, execImpl?: (cmd: string, opts?) => Promise<string>,
  now?: () => number,
  selfUrl?: string,        // 契约外追加：probeSelf 的基址，默认 http://127.0.0.1:PORT
}): Probes
// Probes.probeAll() / snapshot() / probeSelf()
export function computeUptime(history): { ok, fail, rate }
```
**已知前置**：仓库原先**没有 `GET /api/health` 路由**（`docker.js` 里的 `healthCheck` 是容器健康检查，不是 HTTP 端点）。
Lead 在集成时补一个极轻的 `/api/health`（放 `DB_FREE_PATHS`，不查库、不查 Docker，只回 `{ ok: true, uptime, version }`），
否则 `probeSelf()` 会稳定 404。

## 5. 路由（HTTP API）约定

| 路由 | 负责 | 返回要点 |
|---|---|---|
| `GET /api/monitor/api?window=1m\|5m\|1h` | api-router | `{ enabled, window, qps, errorRate, routes[], slowest[], errorTop[], dropped, storage }` |
| `GET /api/monitor/api/history?from=&to=&route=` | api-router | `{ rows[] }`（来自 api-store） |
| `GET /api/monitor/api/alerts?shadow=1` | api-router | `{ rules[], fired[] }`，shadow 模式只返回不发通知 |
| `GET /api/monitor/db` | db-router | `{ enabled, type, pool, lastLight, lastHeavy, unavailable[], tables[] }` |
| `GET /api/monitor/db/history?kind=&limit=` | db-router | `{ samples[] }` |
| `GET /api/monitor/db/slow-queries?limit=` | db-router | `{ threshold, items[] }` |
| `GET /api/openapi.json` | openapi-router | spec（**需鉴权**） |
| `GET /api/docs` | openapi-router | HTML（**需鉴权**） |
| `GET /api/monitor/coverage` | api-router | `{ total, used, unused, coverageRate, rows[], unusedRoutes[] }` |
| `GET /api/monitor/probes` | api-router | `{ results[], uptime{} }` |

全部走现有 auth 中间件（不要加到 `PUBLIC_PATHS`）。

## 6. 文件归属（谁碰什么，互不重叠）

| # | 负责人 | 只能创建/修改 |
|---|---|---|
| 1 | migration | `server/db/index.js`, `server/__tests__/db-migration-idempotent.test.js` |
| 2 | flaky | `server/__tests__/api.test.js` |
| 3 | openapi | `server/openapi.js`, `server/__tests__/openapi.test.js` |
| 4 | pattern | `server/metrics/route-pattern.js`, `server/__tests__/metrics-route-pattern.test.js` |
| 5 | registry | `server/metrics/registry.js`, `server/__tests__/metrics-registry.test.js` |
| 6 | middleware | `server/metrics/api-middleware.js`, `server/__tests__/metrics-middleware.test.js` |
| 7 | store | `server/metrics/api-store.js`, `server/metrics/sql-dialect.js`, `server/__tests__/metrics-store.test.js` |
| 8 | sampler | `server/metrics/db-sampler.js`, `server/__tests__/metrics-db-sampler.test.js` |
| 9 | slowquery | `server/metrics/slow-query.js`, `server/__tests__/metrics-slow-query.test.js` |
| 10 | coverage | `server/metrics/route-coverage.js`, `server/__tests__/metrics-coverage.test.js` |
| 11 | probes | `server/dependency-probe.js`, `server/__tests__/dependency-probe.test.js` |
| 12 | api-router | `server/routes/api-monitor.js`, `server/__tests__/api-monitor-route.test.js` |
| 13 | db-router | `server/routes/db-monitor.js`, `server/__tests__/db-monitor-route.test.js` |
| 14 | openapi-router | `server/routes/openapi.js`, `server/__tests__/openapi-route.test.js` |
| 15 | ui-api | `client/src/components/monitor/ApiSection.tsx`, `client/src/utils/apiMetrics.ts`, `client/src/utils/apiMetrics.test.ts` |
| 16 | ui-db | `client/src/components/monitor/DbSection.tsx`, `client/src/utils/dbMetrics.ts`, `client/src/utils/dbMetrics.test.ts` |
| 17 | ws-auth | `server/ws-auth.js`, `client/src/api/auth.ts`, `server/__tests__/ws-auth.test.js` |
| 18 | settings-split | `client/src/pages/Settings.tsx` + 新建 `client/src/pages/settings/*` |
| 19 | docker-split | `client/src/pages/Docker.tsx` + 新建 `client/src/pages/docker/*` |
| 20 | site-i18n | `site/index.html`, `site/assets/*`, 新建 `site/assets/i18n/*` |

**Lead 独占**（别人不许动）：`server/index.js`、`client/src/pages/Monitor.tsx`、`vitest.config.js`、
`package.json`、`deploy/**`、`server/routes/monitor.js`、所有 `.md` 文档。

## 7. 每人交付时必须报告

1. 文件清单（新增/修改）
2. 导出签名（实际写出来的）
3. `npx vitest run <你的测试>` 的通过数
4. 需要 Lead 接线的一行说明（例如「`server/index.js` 需要 `app.use(createApiMetricsMiddleware({ registry }))`，放在鉴权之前」）
5. 你发现的契约问题（若有）
