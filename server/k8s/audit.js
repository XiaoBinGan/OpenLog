/**
 * k8s/audit.js —— Kubernetes 写操作审计流水（A4）。
 *
 * 背景：`POST .../scale`、`.../restart`、`DELETE .../pods/:name` 是**会改变线上状态**的操作，
 * 而且用的是集群里那个 kubeconfig 对应的高权限账号（见 deploy/k8s/rbac.yaml 的 operator 变体）。
 * 「谁在什么时候把哪个工作负载从几副本改成几副本」必须可查，否则出事只能靠 apiserver 的
 * audit log —— 那东西默认不开，也不在我们的部署清单里。
 *
 * 设计约束：
 * - **纯内存环形缓冲**，最多保留最近 200 条。不落库、不写文件：
 *   写操作审计是旁路，不能在磁盘/DB 故障时反过来把写操作卡死；进程重启即清空，
 *   长期留痕交给集群侧 audit policy（A9 的 RBAC 文档里说明）。
 * - **只记元数据**：action / cluster / target / actor / result / detail。
 *   不记 kubeconfig、token、证书，也不记完整 PATCH body —— 避免把凭据或业务数据复制一份。
 * - 任何字段都做长度截断，防止某个异常响应体把内存撑爆（detail 最多 500 字符）。
 * - `_reset()` 只给测试用，生产代码不要调用。
 */

/** 环形缓冲上限（契约：最近 200 条） */
export const MAX_AUDIT_ENTRIES = 200;

/** detail 最大长度：够写「replicas 2 → 5」或一句上游报错，又不至于塞进整段 HTML 错误页 */
const DETAIL_LIMIT = 500;

/** 短字段（action/cluster/target/actor）上限 */
const FIELD_LIMIT = 200;

/** 结果枚举：ok = 已下发并成功，error = 下发失败/上游报错，blocked = 被开关或演示模式拦下 */
export const AUDIT_RESULTS = Object.freeze(['ok', 'error', 'blocked']);

/**
 * 环形缓冲本体。新记录 unshift 到头部，所以数组本身「新的在前」，
 * 与 server/agent-audit.js 的 listAgentActions 语义保持一致。
 * @type {Array<object>}
 */
let buffer = [];

/** 单调序号：同一毫秒内产生多条记录时保证 id 唯一（不依赖 Math.random） */
let sequence = 0;

/** 统一转字符串 + 截断；null/undefined 给空串，避免前端渲染出 "undefined" */
function text(value, limit = FIELD_LIMIT) {
  if (value === undefined || value === null) return '';
  const raw = typeof value === 'string' ? value : String(value);
  const trimmed = raw.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * detail 归一化：字符串直接用；对象/数组序列化成 JSON（序列化失败降级为空串）。
 * 审计里只留可读文本，不保留引用，避免调用方后续改动对象污染历史记录。
 */
function detailText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return text(value, DETAIL_LIMIT);
  if (typeof value === 'object') {
    try {
      return text(JSON.stringify(value), DETAIL_LIMIT);
    } catch {
      return '';
    }
  }
  return text(value, DETAIL_LIMIT);
}

/**
 * 记一条审计。
 *
 * @param {object} input
 * @param {string} input.action  操作类型：`scale` / `restart` / `delete-pod`
 * @param {string} input.cluster 集群 id
 * @param {string} input.target  操作对象，形如 `default/deployments/web`、`default/pods/web-0`
 * @param {string} [input.actor] 发起人（`api-token` / 请求头里的用户名 / `local`）
 * @param {'ok'|'error'|'blocked'} [input.result] 默认 `ok`
 * @param {string|object} [input.detail] 一句话说明（replicas 变化、上游报错原因等）
 * @returns {{id:string,at:string,action:string,cluster:string,target:string,actor:string,result:string,detail:string}}
 *   写入的那条记录（路由层拿 `id` 当 auditId 回给前端）
 */
export function recordAudit(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const result = AUDIT_RESULTS.includes(source.result) ? source.result : 'ok';

  sequence += 1;
  const entry = {
    id: `k8s-audit-${Date.now().toString(36)}-${sequence.toString(36)}`,
    at: new Date().toISOString(),
    action: text(source.action) || 'unknown',
    cluster: text(source.cluster),
    target: text(source.target),
    actor: text(source.actor) || 'unknown',
    result,
    detail: detailText(source.detail),
  };

  buffer.unshift(entry);
  // 环形缓冲：超出上限就砍掉最老的（尾部），数组长度恒定在 MAX_AUDIT_ENTRIES 内
  if (buffer.length > MAX_AUDIT_ENTRIES) buffer.length = MAX_AUDIT_ENTRIES;

  return { ...entry };
}

/**
 * 读最近的审计记录（新的在前）。
 *
 * @param {number} [limit] 条数，默认全部（≤200）；非法值按默认处理，上下界夹在 1..200
 * @returns {Array<object>} 记录副本数组（外部改动不会影响缓冲）
 */
export function listAudit(limit = MAX_AUDIT_ENTRIES) {
  const parsed = Number(limit);
  const size = Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_AUDIT_ENTRIES)
    : MAX_AUDIT_ENTRIES;
  return buffer.slice(0, size).map((entry) => ({ ...entry }));
}

/**
 * 按集群过滤（前端审计面板大概率只需要当前集群的记录）。
 * cluster 为空时等价于 listAudit。
 */
export function listAuditByCluster(cluster, limit = MAX_AUDIT_ENTRIES) {
  const wanted = text(cluster);
  if (!wanted) return listAudit(limit);
  const all = listAudit(MAX_AUDIT_ENTRIES).filter((entry) => entry.cluster === wanted);
  const parsed = Number(limit);
  const size = Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_AUDIT_ENTRIES)
    : MAX_AUDIT_ENTRIES;
  return all.slice(0, size);
}

/** 当前缓冲条数（测试/统计用）；不对外暴露数组本体 */
export function auditCount() {
  return buffer.length;
}

/** 测试用：清空缓冲并重置序号。生产代码不要调用。 */
export function _reset() {
  buffer = [];
  sequence = 0;
}

export default { recordAudit, listAudit, listAuditByCluster, auditCount, _reset, MAX_AUDIT_ENTRIES };
