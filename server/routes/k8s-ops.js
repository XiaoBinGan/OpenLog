/**
 * routes/k8s-ops.js —— Kubernetes 写操作 HTTP 端点（A4，契约见 /tmp/hami-k8s-contract.md）
 *
 * 挂载方式与 routes/k8s.js 一致：路径写全（`/api/k8s/...`），index.js 里
 * `app.use(createK8sOpsRouter({ ensureSettings }))` 直接挂根，不要再套 `/api` 前缀。
 *
 * 三个端点（全部走审计，见 ../k8s/audit.js）：
 *   POST   /api/k8s/clusters/:id/workloads/:ns/:kind/:name/scale    { replicas }
 *   POST   /api/k8s/clusters/:id/workloads/:ns/:kind/:name/restart
 *   DELETE /api/k8s/clusters/:id/pods/:ns/:name
 *
 * ── 两道安全闸门（顺序不可调换）─────────────────────────────────────
 * 1. 演示模式（OPENLOG_DEMO=1）→ **409** + DEMO_DISABLED。
 *    演示实例连的是 fixture，写下去没有任何意义，而且演示环境经常被陌生的手点到；
 *    409 比 403 更能表达「环境不对」而不是「你没权限」。演示优先于开关：
 *    演示实例即使误设了 OPENLOG_K8S_WRITE=1，也仍然是 409。
 * 2. `OPENLOG_K8S_WRITE !== '1'` → **403** `{ error, readOnly: true }`。
 *    默认关闭是刻意的：kubeconfig 里的账号通常是 cluster-admin（见 deploy/k8s/rbac.yaml），
 *    「部署完就自动拥有改副本/删 Pod 的能力」比「多按一次环境变量」危险得多。
 *
 * 闸门是 router 的**最外层中间件**（见 createK8sOpsRouter 里的 `router.use(gate)`），
 * 先于 body 解析、先于路由匹配。所以：任何被闸门拦下的请求，即使 body 是坏 JSON、
 * 集群 id 不存在或参数非法，返回的也一定是 403/409 —— 「没开写」是一个无条件结论。
 * 放行之后才是 400（入参不合法）→ 404（集群 id 不存在）→ 上游 502。
 *
 * ── 为什么这里自带一个 PATCH/DELETE 传输层 ─────────────────────────
 * ../k8s/client.js 是**只读**客户端：它的 `request()` 只接受
 * `{ query, timeoutMs, method }`，既不能带请求体也不能自定义 header，
 * 所以 `PATCH /scale`、`PATCH`（打重启注解）、`DELETE`（带 DeleteOptions）都发不出去。
 * 契约允许「在自己文件里用 node:https 实现最小写能力」，于是：
 *   - 写请求：本文件的 `kubeRequest()`（复用 kubeconfig 解析出的 server/token/cert/key/ca/
 *     insecureSkipTlsVerify，语义与 client.js 保持一致：非 2xx 抛中文 Error）；
 *   - 读请求（scale 前读一次旧副本数，只用于审计里写「2 → 5」）：仍然走 client.js 的
 *     `createK8sClient().getJson()` —— 读的能力没必要重写一遍，而且这是对 client.js 的复用。
 * client.js 一行都没改。
 *
 * 鉴权由 index.js 的全局 authMiddleware 覆盖 /api，这里不再处理（因此 actor 只能从
 * 请求头 / 认证方式推断，见 resolveActor）。
 */
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import { errorMessage } from '../errors.js';
import * as k8sStore from '../k8s/store.js';
import * as k8sKubeconfig from '../k8s/kubeconfig.js';
import * as k8sClientModule from '../k8s/client.js';
import * as k8sAudit from '../k8s/audit.js';
import { isDemoMode, DEMO_DISABLED } from '../demo/mode.js';

/** 路由前缀：index.js 挂根，所以每条路径都写全 */
const PREFIX = '/api/k8s';

/** 写操作总开关：只认字面量 '1'，与 OPENLOG_DEMO 同一套约定 */
export const WRITE_ENV = 'OPENLOG_K8S_WRITE';

/** 未开启写操作时的 403 响应体（契约原文，前端按 readOnly 关掉操作按钮） */
export const WRITE_DISABLED_ERROR = '写操作未启用（设置 OPENLOG_K8S_WRITE=1 后生效）';

/** 可 scale/restart 的工作负载类型白名单（两者都有 .spec.template / scale 子资源） */
export const ALLOWED_KINDS = Object.freeze(['deployments', 'statefulsets']);

/** 动作名（同时进审计 action 字段，前端按它选图标） */
const ACTION_SCALE = 'scale';
const ACTION_RESTART = 'restart';
const ACTION_DELETE_POD = 'delete-pod';

/** replicas 合法区间（含端点）；上限 1000 是防空指针：手抖输成 10000 会把集群打满 */
const REPLICAS_MIN = 0;
const REPLICAS_MAX = 1000;

/** Pod 礼貌删除的宽限期（秒） */
export const POD_GRACE_PERIOD_SECONDS = 30;

/** 重启注解：kubectl rollout restart 用的也是这个键名，习惯保持一致 */
export const RESTART_ANNOTATION = 'openlog/restartedAt';

/** 写请求超时：apiserver 写路径通常比读慢，给得比 client.js 的 10s 宽一点 */
const WRITE_TIMEOUT_MS = 15_000;

/** 错误信息里回显上游响应体时的截断长度（与 client.js 的 BODY_PREVIEW 一致） */
const BODY_PREVIEW = 200;

/** DNS-1123 label：小写字母/数字/连字符，首尾必须是字母或数字，≤63 字符 */
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const MERGE_PATCH_CONTENT_TYPE = 'application/merge-patch+json';
const JSON_CONTENT_TYPE = 'application/json';

// ─── 错误构造 ─────────────────────────────────────────────────────────

/** 入参错误 → 400 */
function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/** 集群不存在 → 404 */
function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

/** 上游不可达/拒绝 → 502（默认兜底） */
function badGateway(message) {
  const err = new Error(message);
  err.statusCode = 502;
  return err;
}

/**
 * 统一错误出口。
 *
 * `statusCode` 是本文件自己判定的语义（400/404/502）；上游返回的 HTTP 状态挂在
 * `err.status` 且带 `upstream: true` —— 只把其中的 404 透出成 404（工作负载/Pod 不存在），
 * 其余（401/403/409/5xx）一律折成 502：上游 403 是「kubeconfig 账号缺 RBAC 权限」，
 * 如果原样返回 403，前端会误判成「写开关没开」，而那个 403 的响应体里没有 readOnly。
 */
function sendError(res, err, fallbackStatus = 502) {
  const explicit = Number(err?.statusCode);
  const upstreamStatus = err?.upstream === true ? Number(err?.status) : NaN;
  let status = Number.isFinite(explicit) && explicit > 0 ? explicit : fallbackStatus;
  if (!Number.isFinite(explicit) && upstreamStatus === 404) status = 404;
  res.status(status).json({ error: errorMessage(err) });
}

// ─── 参数校验 ─────────────────────────────────────────────────────────

/** 取路径参数并 trim（express 已做 URI 解码）；缺失给空串，交给校验函数报错 */
function pathParam(req, key) {
  const value = req?.params?.[key];
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

/** 空串 → 报错；不合法 → 报错。label 用于中文错误信息 */
function assertDnsLabel(value, label) {
  if (value === '') throw badRequest(`${label}不能为空`);
  if (value.length > 63) throw badRequest(`${label}不合法：长度不能超过 63 个字符（${value}）`);
  if (!DNS_LABEL_RE.test(value)) {
    throw badRequest(`${label}不合法：只允许小写字母、数字和连字符，且必须以字母或数字开头/结尾（${value}）`);
  }
  return value;
}

/** kind 白名单：只接受 deployments / statefulsets（大小写敏感，与 k8s 资源名一致） */
function assertKind(value) {
  if (value === '') throw badRequest('kind 不能为空，只支持 deployments 或 statefulsets');
  if (!ALLOWED_KINDS.includes(value)) {
    throw badRequest(`kind 不支持：${value}（只支持 deployments 或 statefulsets）`);
  }
  return value;
}

/**
 * replicas 校验：必须是 0..1000 的**整数**。
 *
 * 刻意不接受 `"3"` 这种字符串：K8s 的 Scale.spec.replicas 是 int32，
 * 字符串透传上去会被 apiserver 用一段难懂的 400 拒掉；在这里挡住，前端拿到的是中文原因。
 */
function parseReplicas(body) {
  const raw = body && typeof body === 'object' ? body.replicas : undefined;
  if (raw === undefined || raw === null) throw badRequest('replicas 不能为空');
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw badRequest('replicas 必须是数字');
  }
  if (!Number.isInteger(raw)) throw badRequest(`replicas 必须是整数（收到：${raw}）`);
  if (raw < REPLICAS_MIN || raw > REPLICAS_MAX) {
    throw badRequest(`replicas 必须在 ${REPLICAS_MIN}..${REPLICAS_MAX} 之间（收到：${raw}）`);
  }
  return raw;
}

/** 审计里的 target 文案：`ns/kind/name`；某段为空时省略，避免出现 `default//web` */
function composeTarget(ns, kind, name) {
  return [ns, kind, name].filter((part) => part !== '').join('/');
}

// ─── 闸门 ─────────────────────────────────────────────────────────────

/**
 * 判定当前请求是否被闸门拦下。
 *
 * @returns {{ status: number, body: object } | null} null 表示放行
 */
function writeGate() {
  // 演示优先：演示实例永远不发写请求，即使误开了 OPENLOG_K8S_WRITE
  if (isDemoMode()) {
    return { status: 409, body: { ...DEMO_DISABLED } };
  }
  if (process.env[WRITE_ENV] !== '1') {
    return { status: 403, body: { error: WRITE_DISABLED_ERROR, readOnly: true } };
  }
  return null;
}

/**
 * 从 URL 反推「这条被拦下的请求本来想干什么」，只为审计服务。
 *
 * 闸门挂在 router 的**最外层**（早于 body 解析与所有路由），此时 req.params 还没填，
 * 所以这里按路径自己切一段：
 *   DELETE /api/k8s/clusters/c-1/pods/app/web-0              → delete-pod  app/pods/web-0
 *   POST   /api/k8s/clusters/c-1/workloads/default/deployments/web/scale   → scale
 *   POST   /api/k8s/clusters/c-1/workloads/default/statefulsets/db/restart → restart
 * 认不出来的形状（拼错路径）按 scale 记，target 尽力而为 —— 审计宁可粗糙也不能丢。
 */
function describeRequest(req) {
  const parts = String(req?.path || '').split('/').filter(Boolean);
  const at = parts.indexOf('clusters');
  const cluster = at >= 0 ? (parts[at + 1] || '') : '';
  const rest = at >= 0 ? parts.slice(at + 2) : [];

  if (String(req?.method || '').toUpperCase() === 'DELETE') {
    const [, ns = '', name = ''] = rest; // ['pods', ns, name]
    return { action: ACTION_DELETE_POD, cluster, target: composeTarget(ns, 'pods', name) };
  }

  const [, ns = '', kind = '', name = '', verb = ''] = rest; // ['workloads', ns, kind, name, verb?]
  return {
    action: verb === 'restart' ? ACTION_RESTART : ACTION_SCALE,
    cluster,
    target: composeTarget(ns, kind, name),
  };
}

// ─── 身份 ─────────────────────────────────────────────────────────────

/**
 * 推断 actor。
 *
 * index.js 的 authMiddleware 用的是**共享访问令牌**，没有用户概念，
 * 所以这里只能尽力而为：
 *   1. `X-OpenLog-Actor` / `X-OpenLog-User` 请求头（反代/网关注入的用户名，或运维手动带上）
 *   2. 走认证的请求 → `api-token`（区分「带令牌的远程调用」）
 *   3. 其余（开发环境回环地址免鉴权）→ `local`
 * 前端不需要传这些头；A6 若要做「操作人」展示，可以带上 X-OpenLog-Actor。
 */
function resolveActor(req) {
  const header = req?.get?.('x-openlog-actor') || req?.get?.('x-openlog-user') || '';
  const trimmed = String(header).trim();
  if (trimmed !== '') return trimmed.slice(0, 120);
  const auth = String(req?.get?.('authorization') || '');
  if (/^bearer\s+/i.test(auth)) return 'api-token';
  return 'local';
}

// ─── kubeconfig / 集群连接 ────────────────────────────────────────────

/**
 * 按 id 找集群并解析 kubeconfig。
 *
 * 404 = id 不存在；400 = 记录在但 kubeconfig 空/解析失败（和 routes/k8s.js 的口径一致，
 * 这是配置问题而不是上游故障）。
 *
 * @returns {{ record: object, resolved: object }}
 */
async function connectCluster({ ensureSettings, getClusterRecord, parseKubeconfig }, clusterId) {
  const settings = await Promise.resolve(ensureSettings());
  const record = getClusterRecord(settings, clusterId);
  if (!record) throw notFound(`集群不存在：${clusterId}`);

  const kubeconfig = typeof record.kubeconfig === 'string' ? record.kubeconfig : '';
  if (kubeconfig.trim() === '') throw badRequest('该集群未配置 kubeconfig，无法连接 apiserver');

  let resolved;
  try {
    resolved = parseKubeconfig(kubeconfig, record.context || undefined);
  } catch (err) {
    throw badRequest(`kubeconfig 解析失败：${errorMessage(err)}`);
  }
  if (!resolved || typeof resolved !== 'object' || typeof resolved.server !== 'string' || resolved.server.trim() === '') {
    throw badRequest('kubeconfig 解析失败：缺少 apiserver 地址（server）');
  }
  return { record, resolved };
}

// ─── 写传输层（node:https / node:http 最小实现）────────────────────────

/** 校验并解析 apiserver 地址；非法配置直接抛中文错误，不发请求 */
function parseServerUrl(server) {
  const raw = typeof server === 'string' ? server.trim() : '';
  if (raw === '') throw badGateway('连接失败：kubeconfig 缺少 apiserver 地址（server）');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badGateway(`连接失败：apiserver 地址不合法（${raw}）`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badGateway(`连接失败：不支持的协议 ${url.protocol}（只支持 http/https）`);
  }
  return url;
}

/** 非空字符串才当证书用，避免把 '' 传给 https.Agent 触发底层报错 */
function pemOrUndefined(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 把上游非 2xx 响应变成中文 Error。
 * `status` 保留原始 HTTP 码、`upstream: true` 标记来源，供 sendError 分类。
 */
function upstreamError(statusCode, bodyText, pathname) {
  const preview = String(bodyText ?? '').slice(0, BODY_PREVIEW).trim();
  const suffix = preview ? `：${preview}` : '';

  let message;
  if (statusCode === 401) {
    message = 'Kubernetes API 鉴权失败（HTTP 401）：凭证无效或已过期，请检查 kubeconfig 的 token / 客户端证书';
  } else if (statusCode === 403) {
    message = `Kubernetes API 权限不足（HTTP 403）：kubeconfig 对应的账号缺少该资源的写权限${suffix}`;
  } else if (statusCode === 404) {
    message = `Kubernetes API 资源不存在（HTTP 404）：${pathname}${suffix}`;
  } else if (statusCode === 409) {
    message = `Kubernetes API 冲突（HTTP 409）：对象正在被修改，请重试${suffix}`;
  } else {
    message = `Kubernetes API 请求失败（HTTP ${statusCode}）${suffix}`;
  }

  const err = new Error(message);
  err.status = statusCode;
  err.upstream = true;
  err.path = pathname;
  err.body = String(bodyText ?? '');
  return err;
}

/**
 * 最小写传输层：发一次 PATCH/DELETE（也支持 GET，调试用），返回原始文本响应。
 *
 * 语义与 ../k8s/client.js 保持一致：
 *   - 2xx → resolve({ statusCode, headers, body })；
 *   - 非 2xx / 网络错误 / 超时 → reject（中文 Error，带 status/upstream）；
 *   - 复用 kubeconfig 解析结果里的 cert/key/ca/insecureSkipTlsVerify/token。
 *
 * @param {object} resolved  kubeconfig 解析结果（KubeConfigResolved）
 * @param {{ method?: string, path: string, body?: any, contentType?: string, timeoutMs?: number }} options
 * @returns {Promise<{ statusCode: number, headers: object, body: string }>}
 */
export function kubeRequest(resolved, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const method = String(opts.method || 'POST').toUpperCase();
  const rawPath = typeof opts.path === 'string' ? opts.path.trim() : '';
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : WRITE_TIMEOUT_MS;

  let bodyText;
  if (opts.body !== undefined) {
    try {
      bodyText = JSON.stringify(opts.body);
    } catch (err) {
      return Promise.reject(badGateway(`请求体序列化失败：${errorMessage(err)}`));
    }
  }

  return new Promise((resolve, reject) => {
    if (rawPath === '') {
      reject(badGateway('Kubernetes API 请求失败：path 不能为空'));
      return;
    }

    let base;
    let url;
    try {
      base = parseServerUrl(resolved?.server);
      url = new URL(rawPath.startsWith('/') ? rawPath : `/${rawPath}`, base);
    } catch (err) {
      reject(err instanceof Error ? err : badGateway(errorMessage(err)));
      return;
    }

    const useTls = url.protocol === 'https:';
    const transport = useTls ? https : http;
    const token = typeof resolved?.token === 'string' ? resolved.token.trim() : '';

    // 写操作频率很低，每次新建 Agent 比维护缓存/失效逻辑更简单也更安全。
    const agent = useTls
      ? new https.Agent({
          cert: pemOrUndefined(resolved?.cert),
          key: pemOrUndefined(resolved?.key),
          ca: pemOrUndefined(resolved?.ca),
          rejectUnauthorized: !resolved?.insecureSkipTlsVerify,
        })
      : undefined;

    const headers = { accept: 'application/json, text/plain, */*' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (bodyText !== undefined) {
      headers['content-type'] = typeof opts.contentType === 'string' && opts.contentType.trim() !== ''
        ? opts.contentType.trim()
        : JSON_CONTENT_TYPE;
      headers['content-length'] = String(Buffer.byteLength(bodyText));
    }

    const pathname = url.pathname;
    let settled = false;
    let timedOut = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const timeoutError = () => {
      const err = new Error(`Kubernetes API 超时（${Number((timeoutMs / 1000).toFixed(3))}s）：${method} ${pathname}`);
      err.code = 'ETIMEDOUT';
      err.path = pathname;
      return err;
    };

    const req = transport.request(url, { method, agent, headers }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => finish(reject, badGateway(`Kubernetes API 连接失败：${errorMessage(err)}`)));
      res.on('end', () => {
        const body = chunks.join('');
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 200 && statusCode < 300) {
          finish(resolve, { statusCode, headers: res.headers, body });
        } else {
          finish(reject, upstreamError(statusCode, body, pathname));
        }
      });
    });

    // apiserver 卡住时必须自己断开，否则写请求会永久挂着、前端按钮一直转圈
    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      timedOut = true;
      req.destroy(timeoutError());
    });

    req.on('error', (err) => {
      if (settled) return;
      finish(reject, timedOut ? timeoutError() : badGateway(`Kubernetes API 连接失败：${errorMessage(err)}`));
    });

    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

/** 成功响应体里的 JSON；解析失败/空体返回 null（写操作已成功，不能因为回包不是 JSON 就报错） */
function parseJsonSafe(response) {
  const raw = String(response?.body ?? '').trim();
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 默认读能力：复用 ../k8s/client.js 的只读客户端（只为拿旧副本数写进审计） */
async function defaultReadJson(resolved, path) {
  const client = k8sClientModule.createK8sClient(resolved);
  if (!client || typeof client.getJson !== 'function') {
    throw new Error('Kubernetes 客户端不可用');
  }
  return client.getJson(path);
}

// ─── 工厂 ─────────────────────────────────────────────────────────────

/**
 * 创建 K8s 写操作路由。
 *
 * 除契约要求的 `ensureSettings` 外，其余依赖都是**可注入**的，默认取真实实现。
 * 注入点存在的唯一目的是单测能截住传输层（断言 method/URL/body），而不必起一个假 apiserver：
 *   request          (resolved, opts) => Promise<{ statusCode, headers, body }>  写请求
 *   readJson         (resolved, path) => Promise<any>                            读请求（client.js）
 *   getClusterRecord (settings, id) => record|undefined                          settings → 集群
 *   parseKubeconfig  (text, context?) => resolved                                kubeconfig 解析
 *   recordAudit      (entry) => entry                                            审计写入
 *
 * @param {{
 *   ensureSettings: () => object,
 *   request?: Function, readJson?: Function, getClusterRecord?: Function,
 *   parseKubeconfig?: Function, recordAudit?: Function
 * }} deps
 * @returns {import('express').Router}
 */
export function createK8sOpsRouter(deps = {}) {
  const settings = deps && typeof deps === 'object' ? deps : {};
  const ensureSettings = settings.ensureSettings;
  if (typeof ensureSettings !== 'function') {
    throw new Error('createK8sOpsRouter 需要注入 ensureSettings（读取当前生效配置）');
  }

  const request = typeof settings.request === 'function' ? settings.request : kubeRequest;
  const readJson = typeof settings.readJson === 'function' ? settings.readJson : defaultReadJson;
  const getClusterRecord = typeof settings.getClusterRecord === 'function'
    ? settings.getClusterRecord
    : k8sStore.getClusterRecord;
  const parseKubeconfig = typeof settings.parseKubeconfig === 'function'
    ? settings.parseKubeconfig
    : k8sKubeconfig.parseKubeconfig;
  const recordAudit = typeof settings.recordAudit === 'function'
    ? settings.recordAudit
    : k8sAudit.recordAudit;

  const router = express.Router();

  /**
   * 闸门：**最外层**，先于 body 解析与所有路由。
   *
   * 顺序放在这里而不是每条路由里，是为了让「未开启写」成为**无条件**结果：
   * 即使 body 是坏 JSON、集群 id 不存在、参数非法，返回的也一定是 403/409。
   * 反过来说，被放行的请求才会走到下面的解析与校验。
   */
  function gate(req, res, next) {
    const blocked = writeGate();
    if (!blocked) {
      next();
      return;
    }
    // 被拦下的请求也要留痕：这能回答「有没有人在写开关没开的时候试过改副本」
    // —— 这类尝试往往比成功操作更值得看一眼。
    const { action, cluster, target } = describeRequest(req);
    recordAudit({
      action,
      cluster,
      target,
      actor: resolveActor(req),
      result: 'blocked',
      detail: blocked.body.error,
    });
    res.status(blocked.status).json(blocked.body);
  }

  router.use(gate);

  // index.js 已经全局挂了 express.json()，这里再挂一层是为了让本模块能独立挂载
  // （单测/子应用不需要记得先装 body 解析器）。body-parser 对已解析的请求会跳过，不会重复解析。
  router.use(express.json({ limit: '256kb' }));

  /** 三条端点共用的执行外壳：统一 try/catch + 审计失败记录 + 错误出口 */
  function handle(action, work) {
    return async (req, res) => {
      const actor = resolveActor(req);
      const cluster = pathParam(req, 'id');
      // 失败审计里的 target 用「未校验的原始参数」拼：参数非法时也要能看出他想改什么
      const rawTarget = action === ACTION_DELETE_POD
        ? composeTarget(pathParam(req, 'namespace'), 'pods', pathParam(req, 'name'))
        : composeTarget(pathParam(req, 'namespace'), pathParam(req, 'kind'), pathParam(req, 'name'));

      try {
        const result = await work({ req, res, actor, cluster });
        if (result !== undefined) res.json(result);
      } catch (err) {
        recordAudit({
          action,
          cluster,
          target: rawTarget,
          actor,
          result: 'error',
          detail: errorMessage(err),
        });
        sendError(res, err, 502);
      }
    };
  }

  /** 三个端点共用的连接解析（404 / 400 / 502 都在这里定型） */
  function connect(clusterId) {
    return connectCluster({ ensureSettings, getClusterRecord, parseKubeconfig }, clusterId);
  }

  // ── POST /api/k8s/clusters/:id/workloads/:ns/:kind/:name/scale ──────
  router.post(
    `${PREFIX}/clusters/:id/workloads/:namespace/:kind/:name/scale`,
    handle(ACTION_SCALE, async ({ req, actor, cluster }) => {
      const namespace = assertDnsLabel(pathParam(req, 'namespace'), '命名空间');
      const kind = assertKind(pathParam(req, 'kind'));
      const name = assertDnsLabel(pathParam(req, 'name'), '工作负载名称');
      const replicas = parseReplicas(req.body);
      const target = composeTarget(namespace, kind, name);

      const { resolved } = await connect(cluster);
      const scalePath = `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}`
        + `/${kind}/${encodeURIComponent(name)}/scale`;

      // 旧副本数只用于审计（「2 → 5」比「→ 5」有用得多）。读失败不阻塞写。
      let previousReplicas;
      try {
        const current = await readJson(resolved, scalePath);
        const value = current?.spec?.replicas;
        if (Number.isInteger(value)) previousReplicas = value;
      } catch {
        previousReplicas = undefined;
      }

      // Scale 子资源只认 autoscaling/v1 的 Scale 对象；PATCH 用 merge-patch
      // —— 前端只想改一个数字，用 merge 语义不会把并发写的其它字段覆盖掉。
      const patch = {
        apiVersion: 'autoscaling/v1',
        kind: 'Scale',
        metadata: { name, namespace },
        spec: { replicas },
      };
      const response = await request(resolved, {
        method: 'PATCH',
        path: scalePath,
        body: patch,
        contentType: MERGE_PATCH_CONTENT_TYPE,
      });
      const applied = parseJsonSafe(response);
      const appliedReplicas = Number.isInteger(applied?.spec?.replicas) ? applied.spec.replicas : replicas;

      const entry = recordAudit({
        action: ACTION_SCALE,
        cluster,
        target,
        actor,
        result: 'ok',
        detail: `replicas ${previousReplicas ?? '?'} → ${appliedReplicas}`,
      });

      return {
        ok: true,
        auditId: entry.id,
        action: ACTION_SCALE,
        target,
        replicas: appliedReplicas,
        ...(previousReplicas === undefined ? {} : { previousReplicas }),
      };
    }),
  );

  // ── POST /api/k8s/clusters/:id/workloads/:ns/:kind/:name/restart ────
  router.post(
    `${PREFIX}/clusters/:id/workloads/:namespace/:kind/:name/restart`,
    handle(ACTION_RESTART, async ({ req, actor, cluster }) => {
      const namespace = assertDnsLabel(pathParam(req, 'namespace'), '命名空间');
      const kind = assertKind(pathParam(req, 'kind'));
      const name = assertDnsLabel(pathParam(req, 'name'), '工作负载名称');
      const target = composeTarget(namespace, kind, name);

      const { resolved } = await connect(cluster);
      const path = `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}`
        + `/${kind}/${encodeURIComponent(name)}`;

      const restartedAt = new Date().toISOString();
      // 与 `kubectl rollout restart` 同款做法：只改 Pod 模板上的注解。
      // 注解一变化 → 模板 hash 变化 → 控制器滚动重建 Pod，这是 K8s 官方推荐的触发方式。
      // merge-patch 只带这一个键，不会碰 replicas / image / 其它注解。
      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: { [RESTART_ANNOTATION]: restartedAt },
            },
          },
        },
      };
      await request(resolved, {
        method: 'PATCH',
        path,
        body: patch,
        contentType: MERGE_PATCH_CONTENT_TYPE,
      });

      const entry = recordAudit({
        action: ACTION_RESTART,
        cluster,
        target,
        actor,
        result: 'ok',
        detail: `${RESTART_ANNOTATION}=${restartedAt}`,
      });

      return { ok: true, auditId: entry.id, action: ACTION_RESTART, target, restartedAt };
    }),
  );

  // ── DELETE /api/k8s/clusters/:id/pods/:ns/:name ─────────────────────
  router.delete(
    `${PREFIX}/clusters/:id/pods/:namespace/:name`,
    handle(ACTION_DELETE_POD, async ({ req, actor, cluster }) => {
      const namespace = assertDnsLabel(pathParam(req, 'namespace'), '命名空间');
      const name = assertDnsLabel(pathParam(req, 'name'), 'Pod 名称');
      const target = composeTarget(namespace, 'pods', name);

      const { resolved } = await connect(cluster);
      const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`;

      // 礼貌删除：给容器 30s 走完 preStop / 收尾，不是 force delete。
      // 习惯上 `kubectl delete pod` 默认也是 30s，和运维的手感一致。
      await request(resolved, {
        method: 'DELETE',
        path,
        body: { apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds: POD_GRACE_PERIOD_SECONDS },
        contentType: JSON_CONTENT_TYPE,
      });

      const entry = recordAudit({
        action: ACTION_DELETE_POD,
        cluster,
        target,
        actor,
        result: 'ok',
        detail: `gracePeriodSeconds=${POD_GRACE_PERIOD_SECONDS}`,
      });

      return {
        ok: true,
        auditId: entry.id,
        action: ACTION_DELETE_POD,
        target,
        gracePeriodSeconds: POD_GRACE_PERIOD_SECONDS,
      };
    }),
  );

  /**
   * 请求体不是合法 JSON 时，body-parser 会带着 status=400 把错误抛给错误中间件。
   * express 默认会回一段 HTML，前端拿到的就不是 `{ error }` 了 —— 这里统一成 JSON。
   * 其它错误（没有 status 的）继续往下传，不影响全局错误处理。
   */
  router.use((err, _req, res, next) => {
    const status = Number(err?.status ?? err?.statusCode);
    if (!Number.isFinite(status) || status < 400 || status > 599) {
      next(err);
      return;
    }
    const message = err?.type === 'entity.parse.failed'
      ? '请求体不是合法 JSON'
      : (errorMessage(err) || '请求处理失败');
    res.status(status).json({ error: message });
  });

  return router;
}

export default createK8sOpsRouter;
