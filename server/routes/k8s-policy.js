/**
 * routes/k8s-policy.js — 集群 HAMi 调度策略只读端点（A7，契约见 /tmp/hami-k8s-contract.md）
 *
 * 挂载方式（A10 负责）：路径写全（`/api/k8s/...`），index.js 直接
 *   app.use(createK8sPolicyRouter({ ensureSettings }))
 * 不要再套 `/api` 前缀（与 server/routes/k8s.js、db-monitor.js、settings.js 同一惯例）。
 *
 * GET /api/k8s/clusters/:id/policy
 *   → { nodeSchedulerPolicy, deviceSchedulerPolicy, overcommit, resourceStrategy,
 *       source, raw, defaults, note?, reason?, demo? }
 *
 * 取数优先级（全部只读，只走 kube-apiserver 的 GET）：
 *   1. `kube-system` 里 hami-scheduler Deployment 的
 *      `spec.template.spec.containers[0].args` 中的
 *      `--node-scheduler-policy` / `--device-scheduler-policy` / `--overcommit` / `--resource-strategy`
 *      （`--key=value` 与 `--key value` 两种写法都认）；
 *   2. 读不到就用 `kube-system` 的 ConfigMap `hami-scheduler-device` / `hami-scheduler-config`
 *      （存在哪个读哪个），从 key 里找同名项（同时兼容 key 直接同名、以及 value 里是
 *      `nodeSchedulerPolicy: binpack` 这种 YAML/K=V 文本的情况）；
 *   3. 都没有 → 四个值全 null、`source:'default'`，并用 `defaults`/`note` 给出
 *      HAMi 默认值说明（节点与设备两个维度默认都是 binpack）。
 *
 * 三条硬约束：
 *   - **只读**：只调用 client.getJson，不发写请求；
 *   - **不抛错**：任何失败（连不上 / 403 / 解析异常 / settings 读不出来）都降级成
 *     `source:'unknown'` + HTTP 200，前端只会看到「暂时读不到」，不会看到 500；
 *   - **演示模式**（OPENLOG_DEMO=1）**不连集群**：直接返回 `demo:true` + 默认值说明，
 *     只在演示集群清单明确不含该 id 时给 404。
 *
 * 注入：ensureSettings —— 读当前生效配置（`settings.k8sClusters` 在这里）。
 * 可选注入 createClient(record) —— 单测用它替换真实 kube 客户端；缺省走
 * kubeconfig 解析 + ../k8s/client.js（与 k8s.js 的 connectCluster 同一路径）。
 *
 * 鉴权由 index.js 的全局 authMiddleware 覆盖 /api，这里不再处理。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import * as k8sStore from '../k8s/store.js';
import * as k8sKubeconfig from '../k8s/kubeconfig.js';
import * as k8sClientModule from '../k8s/client.js';
import { isDemoMode } from '../demo/mode.js';
import * as demoFixtures from '../demo/fixtures.js';

/** 路由前缀：index.js 里直接挂根，所以每条路径都写全 */
const PREFIX = '/api/k8s';

/** HAMi 调度器所在命名空间（Deployment 与 ConfigMap 都固定在这里） */
const HAMI_NAMESPACE = 'kube-system';

/** hami-scheduler Deployment（args 是第一优先级来源） */
const HAMI_DEPLOYMENT_PATH = `/apis/apps/v1/namespaces/${HAMI_NAMESPACE}/deployments/hami-scheduler`;

/** HAMi 的 ConfigMap 候选（存在哪个读哪个，前者优先） */
const HAMI_CONFIGMAP_NAMES = ['hami-scheduler-device', 'hami-scheduler-config'];

/**
 * 认得的四个调度参数：归一化后的参数名 → 响应字段名。
 * 顺序即文档顺序，单测与说明都按这个顺序读。
 */
const OPTION_FIELDS = {
  'node-scheduler-policy': 'nodeSchedulerPolicy',
  'device-scheduler-policy': 'deviceSchedulerPolicy',
  'overcommit': 'overcommit',
  'resource-strategy': 'resourceStrategy',
};

/** 需要归一化取值的字段（overcommit 走布尔解析，resourceStrategy 保留原文） */
const POLICY_FIELDS = ['nodeSchedulerPolicy', 'deviceSchedulerPolicy'];

/**
 * 别名表：把「去掉连字符后的名字」映射回规范名。
 * 有了它，`--overCommit` / `over_commit` / `overcommit` 都能认成同一个参数。
 */
const OPTION_ALIASES = Object.freeze(Object.fromEntries(
  Object.keys(OPTION_FIELDS).map((key) => [key.replace(/-/g, ''), key]),
));

/** 三个核心字段（args 全给齐时就不必再打 ConfigMap 的请求） */
const CORE_FIELDS = ['nodeSchedulerPolicy', 'deviceSchedulerPolicy', 'overcommit'];

/** HAMi 的默认值说明（真实集群读不到任何配置时前端按这个展示基线） */
const HAMI_DEFAULTS = Object.freeze({
  nodeSchedulerPolicy: 'binpack',
  deviceSchedulerPolicy: 'binpack',
  overcommit: false,
});

/** 「按默认值」时的说明文案：为什么是 binpack，而不是让前端猜 */
const HAMI_DEFAULT_NOTE = '集群里没有读到 HAMi 调度参数（Deployment args 与 ConfigMap 均未命中）：'
  + 'HAMi 默认使用 binpack —— 节点与设备两个维度都优先堆叠到已有负载的节点/显卡上，'
  + '以提高利用率、减少碎片；需要打散时在 hami-scheduler 启动参数里显式设置 spread。';

/** 读取失败时的说明文案：默认值仍可作参考，但要讲清「这次没读到」而不是「没配」 */
const HAMI_UNKNOWN_NOTE = '暂时读不到 hami-scheduler 的配置（权限不足 / 网络不通 / 资源不存在）：'
  + 'HAMi 未显式配置时的默认值是 binpack（节点与设备两个维度），'
  + '实际集群可能已改成 spread，请以 kubectl 看到的启动参数为准。';

// ─── 纯解析函数（导出给单测与前端契约核对）─────────────────────────────

/** 空结果：四个值全 null、raw 为空数组（与响应形状完全同形） */
export function emptyPolicy() {
  return {
    nodeSchedulerPolicy: null,
    deviceSchedulerPolicy: null,
    overcommit: null,
    resourceStrategy: null,
    raw: [],
  };
}

/**
 * 参数名归一化：去掉前导 `--`、驼峰转 kebab、下划线转连字符、压掉重复连字符，
 * 再去掉 `hami-scheduler-` / `hami-` / `scheduler-` 前缀。
 * 认不出来（不是我们关心的四个参数）返回 null。
 */
function canonicalOptionName(name) {
  let text = String(name ?? '').trim().replace(/^-+/, '');
  if (text === '') return null;
  text = text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  for (const prefix of ['hami-scheduler-', 'hami-', 'scheduler-']) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  if (Object.prototype.hasOwnProperty.call(OPTION_FIELDS, text)) return text;
  // 连字符差异（overCommit → over-commit）走别名表
  const dashless = text.replace(/-/g, '');
  return Object.prototype.hasOwnProperty.call(OPTION_ALIASES, dashless) ? OPTION_ALIASES[dashless] : null;
}

/**
 * 策略值归一化：'binpack' | 'spread' | null。
 * 大小写、首尾空白、`bin-pack` / `bin_pack` / `bin packing` 都算 binpack；其它值一律 null
 * （不认识就当没读到，绝不让脏字符串流到前端）。
 */
export function normalizePolicyValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (text === '') return null;
  if (text === 'binpack' || text === 'bin-pack' || text === 'binpacking' || text === 'bin-packing') {
    return 'binpack';
  }
  if (text === 'spread' || text === 'spreading') return 'spread';
  return null;
}

/**
 * overcommit 布尔归一化：true / false / null。
 * 认 true|1|yes|on|enable(d) 与 false|0|no|off|disable(d)（大小写、空白无关），
 * 其余（空串、'2'、'abc'）一律 null。
 */
export function parseOvercommit(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '') return null;
  if (['true', '1', 'yes', 'on', 'enable', 'enabled'].includes(text)) return true;
  if (['false', '0', 'no', 'off', 'disable', 'disabled'].includes(text)) return false;
  return null;
}

/** 结果里是否至少读到了一项（null 不算读到；overcommit 的 false 算读到） */
function hasAnyValue(result) {
  if (!result) return false;
  return POLICY_FIELDS.some((field) => result[field] !== null)
    || result.overcommit !== null
    || result.resourceStrategy !== null;
}

/**
 * 把一项「参数名 + 原始值」写进结果。
 * 同一个字段先出现者优先（k8s 的 args 里重复传同名参数时以第一个为准），
 * raw 只记录**实际生效**的那一项，避免前端把被覆盖的旧值当成配置来源。
 */
function applyOption(result, canonical, value, rawKey) {
  const field = OPTION_FIELDS[canonical];
  if (!field) return;
  if (result[field] !== null) return;

  const text = String(value ?? '').trim();
  let parsed;
  if (field === 'overcommit') parsed = parseOvercommit(text);
  else if (field === 'resourceStrategy') parsed = text === '' ? null : text;
  else parsed = normalizePolicyValue(text);
  if (parsed === null) return;

  result[field] = parsed;
  result.raw.push({ key: rawKey || canonical, value: text });
}

/**
 * 解析容器 args（纯函数，单测主入口）。
 *
 * 支持的写法：
 *   `--node-scheduler-policy=spread`            等号形式
 *   `--node-scheduler-policy spread`            空格形式（值在下一项）
 *   `--node_scheduler_policy=SPREAD`            下划线 / 大写
 *   `--overcommit=1` / `--overcommit false`
 * 值缺失（下一项又是 `--xxx`）或值非法时该字段保持 null。
 *
 * @param {string[]} args 容器 args（非数组 / 非字符串项一律忽略）
 * @returns {{nodeSchedulerPolicy:('binpack'|'spread'|null),deviceSchedulerPolicy:('binpack'|'spread'|null),overcommit:(boolean|null),resourceStrategy:(string|null),raw:{key:string,value:string}[]}}
 */
export function parseSchedulerArgs(args) {
  const result = emptyPolicy();
  if (!Array.isArray(args)) return result;

  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text === '') continue;

    const stripped = text.replace(/^-+/, '');
    const eqAt = stripped.indexOf('=');
    const rawName = eqAt >= 0 ? stripped.slice(0, eqAt) : stripped;
    const canonical = canonicalOptionName(rawName);
    if (!canonical) continue;

    let value;
    if (eqAt >= 0) {
      value = stripped.slice(eqAt + 1).trim();
    } else {
      const next = args[i + 1];
      // 下一项还是一项参数（`--xxx`）→ 本项没带值，不要把它「吃掉」
      if (typeof next === 'string' && !next.trim().startsWith('-')) {
        value = next.trim();
        i += 1;
      } else {
        value = '';
      }
    }
    applyOption(result, canonical, value, rawName.trim());
  }

  return result;
}

/**
 * 解析 ConfigMap（纯函数）。
 *
 * 两种形态都认：
 *   1. data 的 key 直接就是参数名 —— `node-scheduler-policy: spread`、
 *      `HAMI_NODE_SCHEDULER_POLICY=spread`、`hami-device-scheduler-policy: binpack`；
 *   2. key 是文件名（HAMi 常见的 `device-config.yaml`），参数写在 value 文本里的某一行 ——
 *      `nodeSchedulerPolicy: binpack` / `overcommit=true`。
 * 只有第 1 种一个都没命中时才走第 2 种，避免把配置文件里的注释/示例值当配置。
 *
 * @param {object} configMap kube-apiserver 返回的 ConfigMap 对象
 */
export function parseSchedulerConfigMap(configMap) {
  const result = emptyPolicy();
  const data = configMap && typeof configMap === 'object' ? configMap.data : null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result;

  for (const [key, value] of Object.entries(data)) {
    const canonical = canonicalOptionName(key);
    if (!canonical) continue;
    applyOption(result, canonical, typeof value === 'string' ? value : '', key);
  }
  if (hasAnyValue(result)) return result;

  // 回退：key 是文件名，真正的参数在文本里
  const lineRe = /^\s*-?\s*([A-Za-z][A-Za-z0-9_.-]*)\s*[:=]\s*(.*)$/;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue;
    for (const line of value.split(/\r?\n/)) {
      const hit = line.match(lineRe);
      if (!hit) continue;
      const canonical = canonicalOptionName(hit[1]);
      if (!canonical) continue;
      const rawValue = hit[2].trim().replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim();
      applyOption(result, canonical, rawValue, `${key}:${hit[1]}`);
    }
  }
  return result;
}

/**
 * 由一条 raw 记录反推它属于哪个字段。
 * 兼容两种 key：参数名（node-scheduler-policy）与「文件名:行内键」（device-config.yaml:nodeSchedulerPolicy）。
 */
function rawEntryField(entry) {
  const key = String(entry?.key ?? '');
  const tail = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
  const canonical = canonicalOptionName(tail);
  return canonical ? OPTION_FIELDS[canonical] : null;
}

/**
 * 合并两个来源：primary（Deployment args）逐字段优先，secondary（ConfigMap）补空缺。
 * raw 只保留**真正生效**的那几项：被 args 覆盖掉的 ConfigMap 旧值不会出现，
 * 前端拿 raw 展示「这个值是从哪读来的」时不会自相矛盾。
 */
export function mergePolicy(primary, secondary) {
  const merged = emptyPolicy();
  const a = primary || emptyPolicy();
  const b = secondary || emptyPolicy();
  const fromA = new Set();

  for (const field of [...POLICY_FIELDS, 'overcommit', 'resourceStrategy']) {
    if (a[field] !== null && a[field] !== undefined) {
      merged[field] = a[field];
      fromA.add(field);
    } else {
      merged[field] = b[field] ?? null;
    }
  }

  const keep = (entry, preferA) => {
    const field = rawEntryField(entry);
    if (!field) return false;
    return preferA ? fromA.has(field) : !fromA.has(field);
  };
  merged.raw = [
    ...(Array.isArray(a.raw) ? a.raw.filter((entry) => keep(entry, true)) : []),
    ...(Array.isArray(b.raw) ? b.raw.filter((entry) => keep(entry, false)) : []),
  ];
  return merged;
}

// ─── 集群读取（只读）───────────────────────────────────────────────────

/**
 * 从 hami-scheduler Deployment 的 args 解析策略。
 *
 * 契约要求读 `containers[0].args`；但真实集群里偶尔会先挂一个 sidecar（istio 注入、
 * 日志 sidecar），此时 containers[0] 不是调度器本身。所以：先按契约读 containers[0]，
 * 它一项都没命中时再回退到名字含 scheduler 的容器 —— 只会更准，不会改变契约结果。
 */
async function readDeploymentPolicy(client) {
  const data = await client.getJson(HAMI_DEPLOYMENT_PATH);
  const containers = data?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length === 0) return emptyPolicy();

  const first = containers[0];
  const fromFirst = parseSchedulerArgs(Array.isArray(first?.args) ? first.args : []);
  if (hasAnyValue(fromFirst)) return fromFirst;

  const named = containers.find((c) => /scheduler/i.test(String(c?.name ?? '')));
  if (!named || named === first) return fromFirst;
  const fromNamed = parseSchedulerArgs(Array.isArray(named.args) ? named.args : []);
  return hasAnyValue(fromNamed) ? fromNamed : fromFirst;
}

/**
 * 读 ConfigMap：按候选名逐个试，读到第一份有命中项的配置就停。
 * 全部读失败时返回 `{ result, ok:false }`，交给上层决定 source。
 */
async function readConfigMapPolicy(client, errors) {
  const result = emptyPolicy();
  let ok = false;

  for (const name of HAMI_CONFIGMAP_NAMES) {
    try {
      const data = await client.getJson(`/api/v1/namespaces/${HAMI_NAMESPACE}/configmaps/${name}`);
      ok = true;
      const parsed = parseSchedulerConfigMap(data);
      if (hasAnyValue(parsed)) return { result: parsed, ok: true };
    } catch (err) {
      errors.push(`读取 ConfigMap ${name} 失败：${errorMessage(err)}`);
    }
  }
  return { result, ok };
}

/**
 * 汇总一次集群读取：args 优先、ConfigMap 兜底。
 *
 * args 已经把 node/device/overcommit 三项都给齐时不再读 ConfigMap（省一次请求）；
 * 只要缺一项就去读 —— 这样「args 只配了节点策略、设备策略写在 ConfigMap 里」的集群
 * 也能被正确补全。
 *
 * source 判定顺序：args 命中 → 'args'；ConfigMap 命中 → 'configmap'；
 * 有任一来源读成功但没命中 → 'default'；两个来源都没读成功且没命中 → 'unknown'。
 */
async function readClusterPolicy(client) {
  const errors = [];
  let argsResult = emptyPolicy();
  let argsOk = false;

  try {
    argsResult = await readDeploymentPolicy(client);
    argsOk = true;
  } catch (err) {
    errors.push(`读取 hami-scheduler Deployment 失败：${errorMessage(err)}`);
  }

  const argsComplete = CORE_FIELDS.every((field) => argsResult[field] !== null);
  const cmResult = argsComplete
    ? { result: emptyPolicy(), ok: false }
    : await readConfigMapPolicy(client, errors);

  let source;
  if (hasAnyValue(argsResult)) source = 'args';
  else if (hasAnyValue(cmResult.result)) source = 'configmap';
  else if (!argsOk && !cmResult.ok) source = 'unknown';
  else source = 'default';

  return {
    policy: mergePolicy(argsResult, cmResult.result),
    source,
    // 有失败但仍有来源可用时，也把原因透出来（前端只在 tooltip 里展示，不影响主流程）
    reason: errors.length > 0 ? errors.join('；') : undefined,
  };
}

// ─── 响应组装 ─────────────────────────────────────────────────────────

/**
 * 统一响应体。
 * `defaults` 永远带上：前端在 source 为 default/unknown 时按它显示「HAMi 默认 binpack」，
 * 有真实值时也可以拿来做「与默认一致 / 已改过」的对比。
 */
function policyPayload(policy, source, extra = {}) {
  const body = {
    nodeSchedulerPolicy: policy.nodeSchedulerPolicy ?? null,
    deviceSchedulerPolicy: policy.deviceSchedulerPolicy ?? null,
    overcommit: policy.overcommit ?? null,
    resourceStrategy: policy.resourceStrategy ?? null,
    source,
    raw: Array.isArray(policy.raw) ? policy.raw : [],
    defaults: { ...HAMI_DEFAULTS },
  };
  if (source === 'default') body.note = HAMI_DEFAULT_NOTE;
  else if (source === 'unknown') body.note = HAMI_UNKNOWN_NOTE;
  if (extra.reason) body.reason = extra.reason;
  if (extra.demo) body.demo = true;
  return body;
}

/** 默认客户端：解析 kubeconfig → 直连 kube-apiserver（与 k8s.js 的 connectCluster 同一路径） */
function defaultCreateClient(record) {
  const text = typeof record?.kubeconfig === 'string' ? record.kubeconfig : '';
  if (text.trim() === '') throw new Error('集群配置里缺少 kubeconfig，无法连接集群');
  const resolved = k8sKubeconfig.parseKubeconfig(text, record?.context || undefined);
  const client = k8sClientModule.createK8sClient(resolved);
  if (!client || typeof client.getJson !== 'function') throw new Error('Kubernetes 客户端不可用');
  return client;
}

/** 演示集群清单（fixture 缺失 / 形状不符时给空数组，不影响主流程） */
function demoClusterList() {
  try {
    const fn = demoFixtures.demoK8sClusters;
    if (typeof fn !== 'function') return [];
    const data = fn();
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.clusters) ? data.clusters : [];
  } catch {
    return [];
  }
}

/**
 * 创建路由。
 *
 * @param {object} deps
 * @param {() => object} deps.ensureSettings 读取当前生效配置（settings.k8sClusters）
 * @param {(record:object) => object|Promise<object>} [deps.createClient] 可选：替换 kube 客户端（单测注入）
 * @returns {import('express').Router}
 */
export function createK8sPolicyRouter({ ensureSettings, createClient } = {}) {
  const router = express.Router();
  const getSettings = typeof ensureSettings === 'function' ? ensureSettings : () => ({});
  const makeClient = typeof createClient === 'function' ? createClient : defaultCreateClient;

  router.get(`${PREFIX}/clusters/:id/policy`, async (req, res) => {
    const clusterId = String(req.params?.id ?? '').trim();

    // 演示模式：不碰真实集群，也不读 settings（settings 里可能根本没有这个演示集群）
    if (isDemoMode()) {
      const list = demoClusterList();
      if (list.length > 0 && !list.some((c) => String(c?.id ?? '') === clusterId)) {
        res.status(404).json({ demo: true, error: `Kubernetes 集群不存在: ${clusterId}` });
        return;
      }
      res.json(policyPayload(emptyPolicy(), 'default', { demo: true }));
      return;
    }

    if (clusterId === '') {
      res.status(404).json({ error: 'Kubernetes 集群不存在: （空 id）' });
      return;
    }

    // 1) 找集群记录：读 settings 抛错不代表集群不存在，统一降级成 unknown + 200
    let record;
    try {
      record = k8sStore.getClusterRecord(getSettings(), clusterId);
    } catch (err) {
      res.json(policyPayload(emptyPolicy(), 'unknown', {
        reason: `读取集群配置失败：${errorMessage(err)}`,
      }));
      return;
    }
    if (!record) {
      res.status(404).json({ error: `Kubernetes 集群不存在: ${clusterId}` });
      return;
    }

    // 2) 建客户端（连接/证书问题都在这里暴露，而不是等到第一次请求）
    let client;
    try {
      client = await Promise.resolve(makeClient(record));
    } catch (err) {
      res.json(policyPayload(emptyPolicy(), 'unknown', {
        reason: `创建 Kubernetes 客户端失败：${errorMessage(err)}`,
      }));
      return;
    }
    if (!client || typeof client.getJson !== 'function') {
      res.json(policyPayload(emptyPolicy(), 'unknown', { reason: 'Kubernetes 客户端不可用' }));
      return;
    }

    // 3) 只读取数；任何异常都留在 reason 里，状态码始终 200
    try {
      const { policy, source, reason } = await readClusterPolicy(client);
      res.json(policyPayload(policy, source, { reason }));
    } catch (err) {
      res.json(policyPayload(emptyPolicy(), 'unknown', {
        reason: `读取调度策略失败：${errorMessage(err)}`,
      }));
    }
  });

  return router;
}

export default createK8sPolicyRouter;
