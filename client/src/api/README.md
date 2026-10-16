# client/src/api/

前端 API 调用层。目标是把散落各处的 `fetch()` 收敛到这里，让「检查响应状态」
和「解析 JSON」只实现一次。

## 为什么需要这一层

迁移前客户端有 **85 处直接 `fetch()`**，散落在 18 个文件里，其中
**45 处既不检查 `res.ok` 也没有 `catch`** —— 服务端返回 500/401 时，
错误响应体会被当作正常数据继续解析，故障静默发生。

## 用法

```ts
import { apiFetch, apiJson } from '../api/client';

// GET
const data = await apiFetch<{ skills: Skill[] }>('/api/skills');
setSkills(data.skills || []);

// POST / PUT / DELETE（自动加 Content-Type 并序列化）
await apiJson('/api/skills', 'POST', payload);
await apiFetch(`/api/skills/${id}`, { method: 'DELETE' });

// 允许失败的轮询：显式降级，而不是忘记处理错误
const stats = await apiFetch<MonitorStats>('/api/monitor/stats').catch(() => null);
```

失败时抛 `ApiError`（带 `status` / `url` / `body`），消息优先取自响应体的
`error` 或 `message` 字段。调用方沿用既有约定即可：

```ts
try {
  const data = await apiFetch<...>('/api/x');
} catch (e: any) {
  setError(e.message);
}
```

`isAuthError(err)` 可区分 401/403。

## 认证不在这一层

`api/auth.ts` 拦截了全局 `fetch`，**只对同源 `/api/` 请求**注入
`Authorization: Bearer`。跨域请求完全不动 —— `isSameOriginApiUrl()` 同时校验
origin 与路径前缀，解析失败还 fail-closed 返回 false，因此不存在把 token
泄露给第三方源的风险。`api/client.ts` 不重复实现该逻辑。

## ⚠️ 流式端点不能用 apiFetch

`apiFetch` 会读取整个响应体并 `JSON.parse`，**会破坏 SSE 流**。
`AnalysisContext.tsx` 中有 3 处由 `readSSEStream` 消费的流式请求，必须保持原始
`fetch`：

```
/api/docker/health-check/analyze
/api/docker/patrol/analyze
/api/docker/container/:sourceId/:containerId/analyze
```

这是机械式批量替换最容易踩的坑。

## 迁移状态：已完成

**79 / 85 处已迁移**（起点 85 处 / 18 个文件）。**剩余 6 处全部不可迁移**
（SSE 流式端点，见下），也就是说**这一层能收的口已经收完了**。

| 文件 | 迁移 |
|---|---|
| `contexts/RemoteContext.tsx` | 14 处（含分片上传） |
| `pages/Settings.tsx` | 11 处（另 1 处 SSE） |
| `contexts/AnalysisContext.tsx` | 6 处（另 3 处 SSE） |
| `pages/Docker.tsx` | 6 处（另 1 处 SSE） |
| `pages/Dashboard.tsx` | 6 处 |
| `pages/Remote.tsx` | 5 处 |
| `pages/Skills.tsx` | 5 处 |
| `pages/Analytics.tsx` · `Monitor.tsx` | 各 4 处 |
| `pages/Assistant.tsx` | 3 处（另 1 处 SSE） |
| `pages/AnalysisHistory.tsx` · `contexts/AssistantContext.tsx` | 各 3 处 |
| `pages/Logs.tsx` · `pages/GPU.tsx` · `components/GlobalStatusBar.tsx` | 各 2 处 |
| `contexts/DeviceContext.tsx` · `components/Layout.tsx` · `AIShellTerminal.tsx` | 各 1 处 |

### 顺带修掉的历史缺陷

- `DELETE /api/logs`、`DELETE /api/analysis/history/:id`、`DELETE /api/remote/servers/:id`、
  `POST /api/remote/import`：原先**既无 `res.ok` 检查也无 `try/catch`** ——
  写入失败时用户完全无从得知（界面照常显示成功）。均已补上错误处理。
- `Settings.tsx` 的 `fetch('/api/settings').then(...)` 链**没有 `.catch()`**：
  一旦请求失败就是 unhandled rejection。已补。
- `Settings.tsx` 保存告警规则用 `Promise.allSettled` 判断成败，但原始 `fetch`
  在 HTTP 500 时**也是 resolved**，所以「3 条规则全部保存失败」会显示「保存成功」。
  换成 `apiJson` 后 HTTP 错误正确变成 rejected，失败计数才是真的。
- `AnalysisContext.refreshPatrol` 在上下文接口里声明为 `Promise<void>`，
  函数体却 `return data` —— 被 `any` 掩盖已久，改类型后暴露。已修正声明。

## ⚠️ 两类不能迁移的调用

### 1. SSE 流式端点（6 处，全部保留原始 fetch）

`apiFetch` 会读完整个响应体再 `JSON.parse`，**必然破坏 SSE 流**：

| 端点 | 文件 |
|---|---|
| `/api/docker/health-check/analyze` | `AnalysisContext` |
| `/api/docker/patrol/analyze` | `AnalysisContext` |
| `/api/docker/container/:sourceId/:containerId/analyze` | `AnalysisContext` |
| `/api/docker/container/:sourceId/:containerId/diagnose` | `Docker.tsx` |
| `/api/chat` | `Assistant.tsx` |
| `/api/chat` | `Settings.tsx`（思考模式测试） |

后三处**没有用 `readSSEStream`，而是自己 `res.body.getReader()`**，
所以按「是否调用 readSSEStream」去搜索会漏掉它们。要按
`getReader()` / `text/event-stream` 一起搜。

### 2. 用 `!res.ok` 做控制流的端点

这类即使不是流式也不能迁移，因为 `!res.ok` 是**正常分支**而不是错误：

- `/api/docker/patrol/analyze`：非 2xx 表示「暂无新异常」，代码据此回退到展示历史数据。
- `/api/docker/container/.../diagnose`：非 2xx 时读取 body 里的 `error` 字段显示给用户，
  与 `catch` 分支的文案不同。

`Settings.tsx` 里「先保存配置再测试 API Key」也在用 `!res.ok` 早返回（提示
「保存配置失败」而非「API 测试失败」）。这处**可以**迁移，但要用内层 `try/catch`
包住 `apiJson` 才能保住原有文案。

## 关于 lint 警告数的一个说明

迁移后 `no-explicit-any` 警告增加约 12 条（`apiFetch<{ records?: any[] }>` 这类）。

这**不是新增了 `any`**，而是把原本由 `res.json()` 隐式产生的 `any` 写成了显式类型
参数。`no-explicit-any` 规则只抓显式的，所以数字上升了，但代码里 `any` 的总量没变
—— 只是从看不见变成看得见。要真正消掉，得先把那些 `useState<any[]>` 换成真实类型。

## 文件分片上传

`RemoteContext.uploadFile` 的三步（init / chunk / complete）是 JSON body，
不是 FormData，所以可以直接用 `apiJson`。它们需要传 `AbortSignal`，
因此 `apiJson` 第 4 个参数接受 `init`：

```ts
await apiJson(url, 'POST', payload, { signal: abort.signal });
```

`method` / `body` / `headers` 由 `apiJson` 接管，不接受覆盖。

## 测试

`tests/client-api.test.ts` 覆盖本层（16 个用例）。放在根 `tests/` 而不是
`client/src/`：`client/tsconfig.json` 的 `include` 是 `["src"]`，放进 src 会被
`tsc -b` 类型检查，而客户端 tsconfig 没有 vitest 类型。

已验证测试有牙齿：把 `if (!res.ok)` 改成 `if (false)` → 6 个用例失败。
