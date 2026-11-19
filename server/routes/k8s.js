/**
 * routes/k8s.js — 只读 Kubernetes 集群监控 HTTP 端点（契约见 /tmp/k8s-contract.md）
 *
 * 挂载方式：路径写全（`/api/k8s/...`），index.js 直接 `app.use(createK8sRouter({ ensureSettings, saveSettings }))`，
 * 不要再套 `/api` 前缀（与 server/routes/db-monitor.js、server/routes/settings.js 同一惯例）。
 *
 * 本文件只做「HTTP 语义 + 编排」，四块领域逻辑全部在 ../k8s/ 下，由其它 agent 并行实现：
 *   kubeconfig.js  parseKubeconfig()          —— 文本 → 解析结果（支持 mTLS / token）
 *   client.js      createK8sClient(resolved)  —— 直连 kube-apiserver（不依赖 kubectl）
 *   resources.js   normalize* / summarize()   —— CRD 原始 items → 契约里的视图结构
 *   store.js       list/get/upsert/delete/toView —— settings.k8sClusters 的增删改查
 *
 * 之所以用 `import * as`（而非具名导入）：四个模块正在被并行实现，具名导入一旦某个导出缺失
 * 会在 **ESM 链接阶段**直接抛 SyntaxError，整条 /api/k8s 全挂；命名空间导入则只有真正调用到
 * 该函数时才失败，可被下面的 try/catch 降级成 500，不至于把路由整个带崩。
 *
 * 注入（index.js）：
 *   ensureSettings —— 读取当前生效配置（settings.k8sClusters 存在这里）
 *   saveSettings   —— 持久化；A4 的 upsertCluster/deleteCluster 返回 `{ record, settings }`，
 *                     这里把「新的 settings」交回给 saveSettings，路由自己不写文件
 *
 * 状态码约定（契约）：400 = 入参/kubeconfig 解析失败，404 = 集群 id 不存在，
 * 502 = 连不上 kube-apiserver（网络/证书/权限由 client 抛错统一归到这里）。
 * 鉴权由 index.js 的全局 authMiddleware 覆盖 /api，这里不再处理。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import * as k8sStore from '../k8s/store.js';
import * as k8sKubeconfig from '../k8s/kubeconfig.js';
import * as k8sClientModule from '../k8s/client.js';
import * as k8sResources from '../k8s/resources.js';

/** 路由前缀：index.js 里 `app.use(createK8sRouter(...))` 直接挂根，所以每条路径都写全 */
const PREFIX = '/api/k8s';

/** 日志行数默认值与上下界（契约：`?tail=200`，夹在 1..2000） */
const LOG_TAIL_DEFAULT = 200;
const LOG_TAIL_MIN = 1;
const LOG_TAIL_MAX = 2000;

/**
 * overview 并发拉取的六类资源。
 *
 * 全部走 cluster-scope 列表接口（不带 namespace），一次拿全集群：
 * RBAC 由 deploy/k8s/rbac.yaml 授予只读 ClusterRole，不需要按 namespace 逐个循环，
 * 也就不存在「namespace 太多导致 N 次串行请求」的放大问题。
 */
const OVERVIEW_ENDPOINTS = [
  { key: 'nodes', label: '节点', path: '/api/v1/nodes' },
  { key: 'pods', label: 'Pod', path: '/api/v1/pods' },
  { key: 'deployments', label: 'Deployment', path: '/apis/apps/v1/deployments' },
  { key: 'statefulsets', label: 'StatefulSet', path: '/apis/apps/v1/statefulsets' },
  { key: 'daemonsets', label: 'DaemonSet', path: '/apis/apps/v1/daemonsets' },
  { key: 'events', label: '事件', path: '/api/v1/events' },
];

// ─── 小工具 ───────────────────────────────────────────────────────────

/** 带 HTTP 状态码的入参错误：400 走这里，其余交给 sendError 的兜底状态 */
function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * 统一错误出口。`err.statusCode` 优先（validate 出来的 400），否则用调用方给的兜底状态。
 * 502 是这里的默认值：除了「入参不合法」和「id 不存在」，剩下的失败基本都是
 * 「连不上 / 证书不对 / 权限不足」这类上游不可达，client.js 抛什么原文就透出什么。
 */
function sendError(res, err, fallbackStatus = 502) {
  const status = Number(err?.statusCode) || fallbackStatus;
  res.status(status).json({ error: errorMessage(err) });
}

/** 容忍 store 同步/异步两种实现：`await Promise.resolve(x)` 对同步返回值无副作用 */
async function call(fn, ...args) {
  if (typeof fn !== 'function') return undefined;
  return await Promise.resolve(fn(...args));
}

/** 从 store 的返回值里取「新的 settings」（A4 约定返回 { record, settings }，也兼容只返回 settings） */
function settingsOf(result, fallback) {
  if (result && typeof result === 'object') {
    if (result.settings && typeof result.settings === 'object') return result.settings;
    if (Array.isArray(result.k8sClusters)) return result;
  }
  return fallback;
}

/**
 * record → K8sClusterView。
 * 首选 store 的 toView（脱敏/字段顺序由 A4 统一负责）；它缺失或抛错时用本地兜底，
 * 保证「列表能显示」—— 回退结果里绝不含 kubeconfig 明文。
 */
function clusterView(record) {
  if (!record || typeof record !== 'object') return record;
  try {
    const view = k8sStore.toView(record);
    if (view && typeof view === 'object') return view;
  } catch { /* 回退到本地构造 */ }

  const view = {
    id: String(record.id ?? ''),
    name: String(record.name ?? ''),
    context: String(record.context || record.contextName || ''),
    server: String(record.server || ''),
    enabled: record.enabled !== false,
    authType: record.authType === 'token' ? 'token' : 'cert',
    hasKubeconfig: typeof record.kubeconfig === 'string' && record.kubeconfig.trim() !== '',
  };
  if (record.updatedAt) view.updatedAt = String(record.updatedAt);
  return view;
}

/** 解析 kubeconfig；文本缺失或解析失败都折成 400（契约：解析失败 → 400） */
function parseStrict(text, context) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw badRequest('kubeconfig 不能为空');
  }
  try {
    const resolved = k8sKubeconfig.parseKubeconfig(text, context || undefined);
    if (!resolved || typeof resolved !== 'object') {
      throw new Error('kubeconfig 解析结果为空');
    }
    return resolved;
  } catch (err) {
    // client 侧的 401/403 已经带 statusCode 时不要被改写成 400；解析期不会有那种错误
    if (err?.statusCode === 400) throw err;
    throw badRequest(`kubeconfig 解析失败：${errorMessage(err)}`);
  }
}

/** 用已保存的配置建客户端；缺 kubeconfig / 建不出来都归到 400/502 */
function connectCluster(record) {
  const resolved = parseStrict(record?.kubeconfig, record?.context);
  let client;
  try {
    client = k8sClientModule.createK8sClient(resolved);
  } catch (err) {
    throw Object.assign(new Error(`创建 Kubernetes 客户端失败：${errorMessage(err)}`), { statusCode: 502 });
  }
  if (!client || typeof client.getJson !== 'function') {
    throw Object.assign(new Error('Kubernetes 客户端不可用'), { statusCode: 502 });
  }
  return { resolved, client };
}

/** list 型响应里取 items：结构不符时按空数组处理，不让上层拿到 undefined */
function itemsOf(data) {
  if (!data || typeof data !== 'object') return [];
  return Array.isArray(data.items) ? data.items : [];
}

/** normalize* 抛错时降级成空数组 + warning，避免单类资源把整个 overview 拖垮 */
function normalizeSafe(label, fn, warnings) {
  try {
    const out = fn();
    return Array.isArray(out) ? out : [];
  } catch (err) {
    warnings.push(`${label}解析失败：${errorMessage(err)}`);
    return [];
  }
}

/** summarize 缺失/抛错时的本地汇总（字段名与契约 summary 完全一致） */
function localSummary({ nodes = [], pods = [], workloads = [], events = [] } = {}) {
  const phase = (p) => String(p?.phase || '');
  return {
    nodes: nodes.length,
    nodesReady: nodes.filter((n) => n?.ready === true).length,
    pods: pods.length,
    podsRunning: pods.filter((p) => phase(p) === 'Running').length,
    podsUnhealthy: pods.filter((p) => phase(p) !== 'Running' || p?.oom === true || p?.crashLoop === true).length,
    workloads: workloads.length,
    workloadsUnready: workloads.filter((w) => Number(w?.ready) < Number(w?.desired)).length,
    warningEvents: events.filter((e) => String(e?.type || '').toLowerCase() === 'warning').length,
  };
}

/** 优先用 resources.summarize（A3 负责口径），不可用时回退本地实现 */
function computeSummary(parts) {
  try {
    const summary = k8sResources.summarize(parts);
    if (summary && typeof summary === 'object') return summary;
  } catch { /* 回退到本地汇总 */ }
  return localSummary(parts);
}

/** tail 参数：非法/缺省 → 200，越界夹到 1..2000（前端传 0 或 99999 都不该报错） */
function clampTail(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return LOG_TAIL_DEFAULT;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return LOG_TAIL_DEFAULT;
  return Math.min(LOG_TAIL_MAX, Math.max(LOG_TAIL_MIN, n));
}

/** 查询参数取单个字符串（express 4 里同名参数重复会变数组） */
function queryString(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

// ─── 工厂 ─────────────────────────────────────────────────────────────

export default function createK8sRouter({ ensureSettings, saveSettings } = {}) {
  if (typeof ensureSettings !== 'function') {
    throw new TypeError('createK8sRouter 需要注入 ensureSettings');
  }
  const router = express.Router();

  /**
   * :id 校验放在 router.param 里，只写一次。
   *
   * 与 routes/docker.js 的 sourceId 白名单同理：7 条路由都要「先找记录再干活」，
   * 逐条重复 `find()` 迟早会漏掉一条，把 undefined 带进下游（kubeconfig 读不到、
   * client 拿空配置去连默认地址）。这里一次性 404，并把记录挂到 req.k8sCluster。
   */
  router.param('id', (req, res, next, id) => {
    const clusterId = String(id ?? '').trim();
    if (!clusterId) {
      res.status(404).json({ error: '缺少集群 id' });
      return;
    }
    let record = null;
    try {
      record = k8sStore.getClusterRecord(ensureSettings(), clusterId);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
      return;
    }
    if (!record) {
      res.status(404).json({ error: `Kubernetes 集群不存在: ${clusterId}` });
      return;
    }
    req.k8sCluster = record;
    next();
  });

  // ── 集群配置 CRUD ──────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters`, async (req, res) => {
    try {
      // store.listClusters() 已经返回 K8sClusterView（见 store.js），这里不能再套 toView，
      // 否则对 view 再解析一次会把 server / authType / hasKubeconfig 全丢掉。
      const views = await call(k8sStore.listClusters, ensureSettings());
      res.json({ clusters: Array.isArray(views) ? views : [] });
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  router.post(`${PREFIX}/clusters`, async (req, res) => {
    try {
      const body = req.body || {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) throw badRequest('集群名称不能为空');

      const kubeconfig = typeof body.kubeconfig === 'string' ? body.kubeconfig.trim() : '';
      if (!kubeconfig) throw badRequest('kubeconfig 不能为空');

      const context = queryString(body.context);
      // 先解析一遍再落库：解析失败必须止步于 400，不能把一个连不上的集群存进 settings
      const resolved = parseStrict(kubeconfig, context);

      const input = {
        name,
        kubeconfig,
        context: context || String(resolved.contextName || ''),
        enabled: body.enabled !== false && body.enabled !== 'false',
        // 这两个字段给 store 落库用（toView 的 server/authType 来源）；A4 若不认可忽略
        server: String(resolved.server || ''),
        authType: resolved.authType === 'token' ? 'token' : 'cert',
      };
      if (typeof body.id === 'string' && body.id.trim() !== '') input.id = body.id.trim();

      const result = await call(k8sStore.upsertCluster, ensureSettings(), input);
      const nextSettings = settingsOf(result, ensureSettings());
      const record = result && typeof result === 'object' && result.record ? result.record : null;

      if (typeof saveSettings === 'function') saveSettings(nextSettings);

      // 契约里创建返回「view」本身（不包一层），前端直接拿去替换列表项
      res.json(clusterView(record || { ...input, id: input.id || '' }));
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  router.put(`${PREFIX}/clusters/:id`, async (req, res) => {
    try {
      const existing = req.k8sCluster;
      const body = req.body || {};

      const name = body.name === undefined
        ? String(existing.name || '')
        : (typeof body.name === 'string' ? body.name.trim() : '');
      if (!name) throw badRequest('集群名称不能为空');

      // kubeconfig 省略（或空串）时沿用旧值 —— 前端编辑「改个名字」不必回传敏感文本
      const provided = typeof body.kubeconfig === 'string' ? body.kubeconfig.trim() : '';
      const kubeconfig = provided || String(existing.kubeconfig || '');
      if (!kubeconfig) throw badRequest('kubeconfig 不能为空');

      const context = body.context === undefined
        ? String(existing.context || '')
        : queryString(body.context);

      // 只有真的换了 kubeconfig 才重新解析；只改名时沿用旧记录的 server/authType
      const resolved = provided ? parseStrict(kubeconfig, context) : null;

      const input = {
        id: existing.id,
        name,
        kubeconfig,
        context: context || String(resolved?.contextName || existing.context || ''),
        enabled: body.enabled === undefined ? existing.enabled !== false : Boolean(body.enabled),
        server: String(resolved?.server || existing.server || ''),
        authType: (resolved?.authType || existing.authType) === 'token' ? 'token' : 'cert',
      };

      const result = await call(k8sStore.upsertCluster, ensureSettings(), input);
      const nextSettings = settingsOf(result, ensureSettings());
      const record = result && typeof result === 'object' && result.record ? result.record : null;

      if (typeof saveSettings === 'function') saveSettings(nextSettings);

      res.json(clusterView(record || { ...existing, ...input }));
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  router.delete(`${PREFIX}/clusters/:id`, async (req, res) => {
    try {
      const existing = req.k8sCluster;
      const result = await call(k8sStore.deleteCluster, ensureSettings(), existing.id);
      const nextSettings = settingsOf(result, ensureSettings());
      if (typeof saveSettings === 'function') saveSettings(nextSettings);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  // ── 连通性测试 ────────────────────────────────────────────────────

  router.post(`${PREFIX}/clusters/:id/test`, async (req, res) => {
    try {
      const { client } = connectCluster(req.k8sCluster);

      let version = '';
      if (typeof client.apiServerVersion === 'function') {
        version = await Promise.resolve(client.apiServerVersion());
      }
      // 版本能读到不代表有节点读权限，再打一次 nodes 才算「真连上了且权限对」
      const nodeList = await Promise.resolve(client.getJson('/api/v1/nodes'));
      const nodes = itemsOf(nodeList);

      res.json({ ok: true, version: String(version ?? ''), nodes: nodes.length });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  // ── 概览 ──────────────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters/:id/overview`, async (req, res) => {
    try {
      const { client, resolved } = connectCluster(req.k8sCluster);
      const warnings = [];

      /**
       * 六类资源 + 版本号并发拉取，用 allSettled 而不是 all：
       * 只读监控里「Deployment 列表被 RBAC 挡住」不该让整页白屏 —— 缺的那类给空数组，
       * 原因写进 warnings 让前端提示「该类资源不可用」，其余照常渲染。
       */
      const tasks = OVERVIEW_ENDPOINTS.map((endpoint) => Promise.resolve().then(() => client.getJson(endpoint.path)));
      tasks.push(Promise.resolve().then(() => (
        typeof client.apiServerVersion === 'function' ? client.apiServerVersion() : ''
      )));

      const settled = await Promise.allSettled(tasks);

      const raw = {};
      const failures = [];
      settled.slice(0, OVERVIEW_ENDPOINTS.length).forEach((result, index) => {
        const endpoint = OVERVIEW_ENDPOINTS[index];
        if (result.status === 'fulfilled') {
          raw[endpoint.key] = result.value;
        } else {
          raw[endpoint.key] = null;
          failures.push({ endpoint, reason: result.reason });
          warnings.push(`${endpoint.label}查询失败：${errorMessage(result.reason)}`);
        }
      });

      /**
       * 「部分失败」与「整体连不上」必须区分开：
       * 六类资源全挂在同一件事上（apiserver 不可达 / 证书不被接受 / token 失效），
       * 这时返回一份全空但 200 的概览，值班的人只会看到「0 节点 0 Pod 全部正常」，
       * 比报错更危险。所以只有**至少一类资源拿到数据**才走降级 200，全灭一律 502。
       */
      if (failures.length === OVERVIEW_ENDPOINTS.length) {
        const first = failures[0];
        throw Object.assign(
          new Error(`无法连接 Kubernetes API（${errorMessage(first.reason)}）`),
          { statusCode: 502 },
        );
      }

      const versionResult = settled[OVERVIEW_ENDPOINTS.length];
      let version = '';
      if (versionResult && versionResult.status === 'fulfilled') version = String(versionResult.value ?? '');

      const nodes = normalizeSafe('节点', () => k8sResources.normalizeNodes(itemsOf(raw.nodes)), warnings);
      const pods = normalizeSafe('Pod', () => k8sResources.normalizePods(itemsOf(raw.pods)), warnings);
      const workloads = [
        ...normalizeSafe('Deployment', () => k8sResources.normalizeWorkloads('Deployment', itemsOf(raw.deployments)), warnings),
        ...normalizeSafe('StatefulSet', () => k8sResources.normalizeWorkloads('StatefulSet', itemsOf(raw.statefulsets)), warnings),
        ...normalizeSafe('DaemonSet', () => k8sResources.normalizeWorkloads('DaemonSet', itemsOf(raw.daemonsets)), warnings),
      ];
      const events = normalizeSafe('事件', () => k8sResources.normalizeEvents(itemsOf(raw.events)), warnings);

      const parts = { nodes, pods, workloads, events };
      res.json({
        cluster: {
          version,
          server: String(resolved?.server || req.k8sCluster.server || ''),
          context: String(resolved?.contextName || req.k8sCluster.context || ''),
        },
        nodes,
        pods,
        workloads,
        events,
        summary: computeSummary(parts),
        // 契约外的附加字段：某类资源拉取/解析失败的原因，前端可忽略
        warnings,
      });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  // ── Pod 列表 ──────────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters/:id/pods`, async (req, res) => {
    try {
      const { client } = connectCluster(req.k8sCluster);
      const namespace = queryString(req.query.namespace);
      // 指定 namespace 就走命名空间路径（RBAC 只给了单 namespace 权限时同样可用）
      const path = namespace
        ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
        : '/api/v1/pods';

      const data = await Promise.resolve(client.getJson(path));
      const pods = normalizeSafe('Pod', () => k8sResources.normalizePods(itemsOf(data)), []);
      res.json({ pods });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  // ── 事件列表 ──────────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters/:id/events`, async (req, res) => {
    try {
      const { client } = connectCluster(req.k8sCluster);
      const namespace = queryString(req.query.namespace);
      const type = queryString(req.query.type);

      // 事件始终按集群整体拉取后再筛：events 的 fieldSelector 在各版本/各发行版行为不一致
      // （k3s 与上游对 involvedObject 的支持有差异），本地过滤才是稳定的口径。
      const data = await Promise.resolve(client.getJson('/api/v1/events'));
      let events = normalizeSafe('事件', () => k8sResources.normalizeEvents(itemsOf(data)), []);

      if (namespace) {
        events = events.filter((event) => String(event?.namespace ?? '') === namespace);
      }
      if (type) {
        const wanted = type.toLowerCase();
        events = events.filter((event) => String(event?.type ?? '').toLowerCase() === wanted);
      }

      res.json({ events });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  // ── Pod 日志 ──────────────────────────────────────────────────────

  router.get(`${PREFIX}/clusters/:id/pods/:namespace/:pod/logs`, async (req, res) => {
    try {
      const { client } = connectCluster(req.k8sCluster);
      const namespace = String(req.params.namespace ?? '').trim();
      const pod = String(req.params.pod ?? '').trim();
      if (!namespace || !pod) throw badRequest('namespace 与 pod 不能为空');

      const tail = clampTail(req.query.tail);
      const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log`;
      if (typeof client.getText !== 'function') {
        throw Object.assign(new Error('Kubernetes 客户端不支持读取日志'), { statusCode: 502 });
      }

      const text = await Promise.resolve(client.getText(path, { query: { tailLines: tail } }));
      res.json({ logs: typeof text === 'string' ? text : String(text ?? '') });
    } catch (err) {
      sendError(res, err, 502);
    }
  });

  return router;
}
