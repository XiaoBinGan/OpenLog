# server/routes/

`server/index.js` 曾是一个 4000+ 行的单体文件，路由、WebSocket 处理、业务逻辑、
定时任务、进程生命周期全部混在一起。这里存放从它抽出的 Express 路由模块。

## 抽取模式

每个模块导出一个 `express.Router()`，由 `server/index.js` 用 `app.use()` 挂载：

```js
// server/routes/foo.js
import express from 'express';
const router = express.Router();
router.get('/api/foo', handler);
export default router;

// server/index.js
import fooRouter from './routes/foo.js';
app.use(fooRouter);
```

**优先选择不依赖 `index.js` 内部状态的模块。** 如果一组路由只用到
`server/` 下的独立模块（如 `gpu.js`、`remote.js`、`db/`），它们可以直接
import 后整体搬出，不需要注入上下文 —— 这也是风险最低的抽取方式。

若某组路由确实需要 `index.js` 的模块级状态（`settings`、`logs`、`watchers`、
`broadcast()` 等），应导出工厂函数显式注入，而不是重新引入隐式全局耦合：

```js
// server/routes/bar.js
export default function createBarRouter({ ensureSettings, broadcast }) {
  const router = express.Router();
  // ...
  return router;
}
```

## 已抽出

| 模块 | 路由数 | 模式 | 说明 |
|---|---|---|---|
| `gpu.js` | 6 | 直接导出 | `/api/gpu/*`。仅依赖 `gpu.js` / `remote.js` / `gpu-host-ssh.js`，完全自包含。 |
| `skills.js` | 7 | 直接导出 | `/api/skills`（4）、`/api/machines`（1）、`/api/alerts`（2）。只依赖 db 层与 uuid。 |
| `monitor.js` | 2 | 工厂函数 | `/api/monitor/*`。注入 `monitorHistory`。 |
| `logs.js` | 6 | 工厂函数 | `/api/logs`（2）、`/api/logs/history`（2）、`/api/logs/analyze`、`/api/logs/fix`。注入 `logs`（实时缓冲）与 `ensureSettings`。 |
| `analysis.js` | 6 | 工厂函数 | `/api/analysis/*`。注入 `analysisQueues`、`analysisHistory`、`enqueueAnalysis`。 |
| `assistant-memory.js` | 3 | 直接导出 | `/api/assistant/memory`。只依赖 fs/path，自包含。**含路径穿越修复，见下。** |
| `models.js` | 1 | 工厂函数 | `/api/models/ollama`。注入 `ensureSettings`。 |
| `remote.js` | 23 | 工厂函数 | `/api/remote/*` 全部。注入 `ensureSettings` 与 `stripThinking`。 |
| `settings.js` | 2 | 工厂函数 | `/api/settings` GET+PUT。注入 6 项（见下）。导出 `SENSITIVE_KEYS`。 |
| `docker.js` | 24 | 工厂函数 | `/api/docker/*` 全部。注入 7 项（见下）。 |
| `chat.js` | 1 | 工厂函数 | `/api/chat` SSE + 工具调用。注入 3 项；`ASSISTANT_TOOLS` 与 `ThinkingStreamFilter` 一并搬入本文件。 |
| `auth.js` | 1 | 工厂函数 | `/api/auth/token`。注入 `authToken`。 |

## ✅ 拆分完成：84 / 84 路由

`server/index.js`：**4121 行 → 1836 行（-55%）**，其中**已无任何 `app.get/post/put/delete` 路由**，
只剩 16 个 `app.use(...)` 挂载、模块级状态与工具函数。12 个路由文件。

```
docker.js 722   remote.js 506   logs.js 340   chat.js 200
gpu.js 124      skills.js 113   settings.js 101   monitor.js 95
assistant-memory.js 95   analysis.js 86   models.js 43   auth.js 32
```

| 符号 | 为什么必须注入而不是直接 import |
|---|---|
| `ensureSettings` | settings 是可重新赋值的绑定，必须取函数而不是值 |
| `broadcast` | 依赖 index.js 的 `wsClients` |
| `addAnalysisRecord` | 写 index.js 的 `analysisHistory` |
| `buildHostExecMap` | 同时依赖 docker 与 remote 两侧信息 |
| `stripThinking` | 依赖 `ensureSettings` 的文本过滤器 |
| `get/setLastPatrolResults` | 巡检结果由 index.js 的定时器**和**本文件共同读写 |
| `buildAssistantContext` / `executeAssistantTool` | 需要 docker / remote / 本机三侧的工具上下文 |

两处需要改写的写法：

- **`app.handle(req, res)` 重派发**（`/diagnose` → `/analyze` 别名）：
  router 内没有 `app` 绑定，改为 `req.app.handle(req, res)` —— `req.app` 就是主应用，
  语义完全一致。
- **`lastPatrolResults = results`**：模块级 `let`，由 index.js 的定时器和本文件共同写，
  故改为注入取值/设值访问器。

## 🔴 第三份副本：回环判定曾被抄了三遍

搬 `/api/auth/token` 时发现「是不是本机」这个判定在 index.js 里已经存在
（`isLoopbackAddress`），而路由里又内联抄了一份。清点后实际是**三份**：

| 位置 | 用途 | 差异 |
|---|---|---|
| `isLoopbackAddress()` | 开发模式鉴权旁路、WS 升级放行 | 基准（含 `localhost`） |
| `/api/auth/token` 内联 | 决定是否发放令牌 | 同样三值比较 |
| 限速器的 localhost 豁免 | 本机不限速 | **少了 `localhost`** |

三份的判定对象都是 `req.ip`，都做「剥 `::ffff:` 前缀后精确比较」。
已合并到 `server/security/loopback.js`，三处共用。

CORS 的 Origin hostname 白名单**没有**合并 —— 它要额外处理带方括号的 `'[::1]'`
（`new URL('http://[::1]:3011').hostname` 返回 `'[::1]'`），是另一个关注点。

## ⚠️ 依赖扫描脚本有一个系统性漏洞

我写的「扫描 routes/*.js 外部依赖」脚本，把「函数调用」和「对象访问」的正则都写成
`[a-z_$]` 开头 —— **只匹配小写开头的标识符**。于是大写开头的类名与常量全被漏掉：
抽 `chat.js` 时漏了 `ASSISTANT_TOOLS`（常量）和 `ThinkingStreamFilter`（类）。

代码搬走后 `node --check` 通过、服务能正常启动，**只有跑 lint 才报出来**。

结论：**eslint 的 `no-undef` 才是权威检查**，它做完整的自由标识符分析；
我的脚本只是粗糙的辅助，不能用来替代 lint。

## ✅ 这次用「对照服务」证明行为不变

前两轮都是靠「跑一遍看看有没有报错」来验证，这轮换了更严格的办法：

1. 用抽取前的 `index.js` 在另一个端口起一个**对照服务**
2. 对两个服务跑**同一份 21 项探测脚本**
3. `diff` 两份输出

结果：**除时间戳外逐字节一致** —— 状态码、错误文案、响应体全部相同。

这比「没报错」强得多：它能发现「状态码相同但内容变了」这类静默回归。
唯一有意的差异是我顺手修掉的那条 `docker.getContainer` 路由。

## 🐛 顺带发现的既有 bug：`docker.getContainer is not a function`

`/api/docker/containers/:sourceId/:containerId` 调用 `docker.getContainer(...)`，
但 `docker.js` **从未导出过这个名字** —— 该路由对任何请求都返回 500 TypeError。
（前端从未调用它，所以一直没被发现。）

已改为 `docker.getDocker(sourceId, config)` + `client.getContainer(id).inspect()`，
与同组的 start/stop/restart 行为一致。

> ⚠️ 记两笔测试自身的问题：
> 1. `refactor.test.js` 第一版把**注释里提到的** `docker.getContainer` 也当成真实调用而误报 ——
>    修复 docker 时我在注释里写了「原实现调用 docker.getContainer(...)」，测试因此一直红。
>    现在扫描前会剥掉整行注释与块注释。
> 2. 因此那一次「变异测试」是被污染的：变异前后都失败，看起来像变异命中，其实与变异无关。
>    **变异测试只有在基线为绿时才有意义。**

## 🔴 抽出 settings 路由时踩到的坑：副作用成功、响应失败

`PUT /api/settings` 原本以这一行结尾：

```js
res.json({ success: true, settings });   // settings 是 index.js 的模块级绑定
```

`settings` 来自 `index.js:331` 的 `let settings = null`，路由闭包能取到它，**原文没问题**。
搬到 `routes/settings.js` 之后该绑定不复存在，于是：

1. 所有副作用照常执行 —— 配置**已经写入磁盘**
2. 最后一行抛 `ReferenceError`，返回 **500**
3. 前端提示「保存失败」，但配置其实改了

这类「副作用成功、响应失败」的不一致最难排查。已修复为
`res.json({ success: true, settings: sanitizeSettings(ensureSettings()) })`。

**顺带发现的问题**：原文的 PUT 响应会原样回显整个 settings 对象，
也就是把**明文 `openaiApiKey`** 放在响应体里 —— 而同一个 key 在 GET 里是脱敏的。
同一个字段两条路由两种行为，只要各写一遍脱敏逻辑就一定会再次分叉。
现在 GET/PUT 共用 `sanitizeSettings()`。

**为什么 `node --check` 和启动都没报错**：模块能正常加载，只有真正请求 PUT 才会触发。
`eslint no-undef` 本可以静态抓到 —— **但我当时先启动服务、后跑 lint，顺序反了**。

新增 4 个回归测试（`api.test.js`）。**变异验证**：还原成 `settings` → 3 个测试失败；
让 GET 不脱敏 → 2 个失败；删掉「拒绝写回脱敏值」的守卫 → 1 个失败。

> ⚠️ 记一笔测试自身的问题：第 4 个测试**第一版是同义反复** ——
> 它把当前 key 的脱敏结果原样写回，于是无论守卫是否生效读回来都是同一串字符，
> 把守卫整个删掉它照样通过。改成写回一个**不同的**脱敏值后才真正有效。
> 变异测试在这里的价值就是：它能告诉你「这个测试其实什么都没测」。

## 🔴 抽出 remote 路由时踩到的三个坑（都通过了 `node --check`）

这一轮很值得记录：`node --check` 三次都通过、浅层 HTTP 冒烟也通过，
但代码其实是坏的。三个坑分别是：

### 1. 共享的安全策略被一起带走

`SHELL_METACHAR_PATTERN` / `hasShellMetaChars` / `REMOTE_EXEC_ENABLED` /
`rejectUnlessRemoteExecEnabled` / `READONLY_COMMANDS` / `commandBaseName`
定义在 **remote 区块内部**（index.js:2593-2638），却被**区块之外**的
docker `/api/docker/:sourceId/:containerId/exec` 路由使用 ——
靠函数提升和「只在请求时才读 const」侥幸能跑。

抽出 remote 会把定义一起带走并打断 docker 那条路由。
**对策**：提成 `server/security/shell-command-policy.js`，两边共同 import，
并用测试断言这些符号全项目只有一份定义（出现第二份就意味着策略分叉）。

### 2. 依赖扫描被我自己的过滤器骗了

我写了个脚本扫描区块的「调用但未定义」的标识符，脚本**算出了完整列表**，
但我加了一句只打印「看起来像 index.js 状态」的前缀过滤，
`stripThinking` 不匹配就被静默丢掉了。结果抽出后 `stripThinking` 成了自由变量。

**lint 抓到了**（`no-undef`）。教训：**不要过滤掉自己没预期的结果** ——
那正是最需要看到的东西。重跑不过滤的扫描后，真实的未解析依赖只有两个。

### 3. `import remote from` 拿不到全部导出

```js
import remote from '../remote.js';   // ← 只拿到 default 对象
```

`remote.js` 有 26 个命名导出，但 default 对象**不是**它们的超集 ——
`execShellCommand` 有命名导出却没被收进 default 对象，于是
`remote.execShellCommand` 是 `undefined`。这个错误只在 AI Shell
**真的拿到 LLM 回复、走到执行那一步**时才抛 `is not a function`。

`index.js` 一直用的是 `import * as remote`（命名空间导入），所以它没这个问题 ——
**同一个符号，两种导入方式，一种能跑一种炸**。

**对策**：路由文件改用命名空间导入；并新增
`server/__tests__/refactor.test.js`，**按每个文件各自的导入方式**校验
`remote.X` 是否可解析。第一版测试把「命名导出」和「default 成员」并成一个集合，
因此查不出这个缺口 —— 已修正为区分导入方式。

**三个坑的验证方式**（缺一不可）：
- `node --check` —— 只能查语法，三个坑全都查不出
- `npm run lint` 的 `no-undef` —— 抓到坑 2
- 真启动 + 逐个 curl —— 能查挂载，但坑 3 只有走到具体代码路径才暴露
- 开启 `OPENLOG_ENABLE_REMOTE_EXEC=1` 后真的调一次 `/api/remote/:id/aishell`
  —— 这才同时走通 `stripThinking`（第 459 行）与 `remote.execShellCommand`（第 490 行）

### 🔴 抽出时发现并修复：助手知识库路径穿越

抽出 `assistant-memory.js` 时发现原实现的
**`DELETE /api/assistant/memory/:name` 没有任何文件名消毒**：

```js
// 原实现（server/index.js:1189）
const filePath = path.join(ASSISTANT_MEMORY_DIR, req.params.name + '.md');
```

`POST` 有消毒，`DELETE` 没有。`name = "../pwned"` 会解析到知识库目录之外，
**删除任意 `.md` 文件**。

已验证（不是推测）：
- 旧写法对 `../pwned` 解析出 `/tmp/olv13/pwned.md`，逃出目录并**成功删除** —— 漏洞成立。
- 新写法用同一个 `sanitizeMemoryName()` 处理写入与删除，攻击目标文件存活。

回归测试在 `server/__tests__/security.test.js` 的「助手知识库文件名消毒」describe
（4 个用例）。**变异验证**：把 DELETE 改回 `req.params.name +`、或让消毒函数直接返回
原值，测试都会失败 —— 确认测试有牙齿。

顺带修正：
- 原 `POST` 是「先替换非法字符、再剥离 `.md`」，导致 `notes.md` 变成 `notes-md.md`
  （`.` 先被替换成 `-`，后面就匹配不到 `.md$`）。现在是先剥离再替换。
- 消毒结果去掉首尾 `-`，避免 `'   '` 变成 `---.md` 这种垃圾名。
  （这个疏漏是我自己第一版消毒函数里的，被上面那个测试当场抓到。）

### 大量代码的搬移要用程序化方式

`logs.js` 有 269 行（含 AI 提示词模板）。这类代码**不要手抄** —— 用脚本从源文件按行区间切片、
做 `app.` → `router.` 替换、拼上头部与 `export default`，可以保证逐字一致。
删除时**先删靠后的区间**，否则行号会偏移。

### 验证 AI 端点时不要真的打 LLM

`/api/logs/analyze` 与 `/api/logs/fix` 会真的调用 LLM。首次验证时未加限制，
请求打到了本机 Ollama 并真实返回了分析结果，把测试拖到超时。
正确做法是把 baseUrl 指向必然拒绝连接的地址：

```bash
OPENAI_BASE_URL=http://127.0.0.1:1/v1
# /api/logs/analyze → 500 {"error":"Connection error."}  ← 证明路由已挂载且走到调用路径
```

## 抽取后必须做的验证

机械式搬移极易出静默错误。已实际踩到两次：

- BSD `sed` 不支持 `\|` 交替，`app.` → `router.` 的批量替换**静默失败**，
  服务启动即 `ReferenceError: app is not defined`
- 在 `/tmp` 副本里先 `cd` 再执行 `git -C "$PWD" show`，`$PWD` 已不是仓库，
  命令失败并把目标文件写成了空文件

因此每次抽取后至少确认：

1. `node --check` 通过
2. `npm test`（含安全回归）全绿
3. **真实启动服务并逐个 curl 被搬移的路由**，比对状态码与响应体结构（含写操作与参数校验）
4. 抽样 curl 几个未搬移的路由，确认挂载顺序没破坏它们
5. 对行为有疑问时，用 `git show HEAD:<file>` 起一个对照服务，逐字比对响应

## 拆分已完成

84 / 84 路由全部抽出，`index.js` 中不再有任何路由定义。
后续新增路由请直接建 `server/routes/<domain>.js` 并按本文的工厂模式挂载，
不要再往 index.js 里加。
