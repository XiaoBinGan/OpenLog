/**
 * AI Infra 审计存储（B2）—— "谁在什么时候把 strata 改成了 evil:1" 的唯一答案。
 *
 * 事故背景：A5（apply.js）已经把每一步都记在返回值的 `steps` 里，但那东西只在 HTTP
 * 响应里活几百毫秒。进程一重启、页面一刷新，真机事故复盘时就只剩一句"好像有人改过"。
 * 审计是**生产底线**：能回滚的变更还要能追溯，否则出事只能靠猜。
 *
 * 三条硬约束（来自 /tmp/infra-contract2.md B2）：
 *  1. **不碰 db**：所有读写都走注入的 `getKv` / `setKv`，因此 SQLite / MySQL / PG 通用；
 *  2. **环形保留**：默认 500 条，超出按时间淘汰最旧的（KV 里存的是一条 JSON 数组，
 *     无上限的话几周就能把 kv_store 撑成几 MB，`loadKvCache()` 启动时全量读会卡）；
 *  3. **绝不把完整 snapshot body 存进审计**：一次 apply 的 snapshot 是集群里对象的完整
 *     spec（几十 KB），存进 KV 等于把配置库变成垃圾场。这里只存 `snapshotRef`
 *     （调用方给的引用串，或对 body 取的短指纹），body 本身交给既有的 `saveSnapshot()`。
 *
 * 审计失败不能阻断运维：`record()` **永不抛错**。存储层炸了（磁盘满、库锁死、KV 序列化
 * 失败）时只 `console.warn` 一条，然后返回 `{ ok: false, error }`，让调用方的 apply 继续
 * 成功返回 —— 变更已经落到集群了，前端因为"审计写失败"弹一个红色错误、诱导运维重试一次
 * apply，才是真正危险的行为。
 *
 * 幂等可重放：`id` 由条目内容派生（见 `buildAuditEntry`），同一份结果重复 record 是覆盖
 * 而不是追加。这样"apply 成功但响应超时，调用方重试一次"不会在审计里变成两条变更。
 *
 * 用法：
 * ```js
 * import { getKv, setKv } from '../db/index.js';
 * const store = createAuditStore({ getKv, setKv });
 * const hit = await recordApply({ store, service, result, actor: 'alice', forced: [] });
 * hit.id;                 // 落库后的审计 id（路由回填给前端）
 * store.list({ limit: 20, actor: 'alice' });   // 同步读
 * store.stats();
 * ```
 */

import { createHash } from 'node:crypto';

/** KV 里的键名（单一数组，环形保留；不与 settings 混放）。 */
export const AUDIT_KV_KEY = 'infra_audit';

/** 默认保留条数。500 条约 200~400 KB（单条 < 1 KB），足够覆盖一周的运维动作。 */
export const DEFAULT_KEEP = 500;

/** `list()` 默认/最大页长（路由层还会各自再夹一次，这里兜底防打满内存）。 */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

/** 合法 action 枚举 —— 前端筛选器与 stats().byAction 的键都以它为准。 */
export const AUDIT_ACTIONS = Object.freeze(['create', 'update', 'rollback', 'rejected']);

/** 单条步骤说明/错误文案的截断长度（审计要能读，不是要存日志全文）。 */
export const DETAIL_MAX_CHARS = 500;

const ID_MAX_CHARS = 128;
const ACTOR_MAX_CHARS = 120;
const TARGET_MAX_CHARS = 200;
const FORCED_MAX_CHARS = 120;
const MAX_TARGETS = 20;
const MAX_STEPS = 30;

/* ────────────────────────── 小工具 ────────────────────────── */

/** 严格的对象字面量判断（null / 数组都不算）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 带 then 的对象（Promise / 伪 Promise）：用来识别"异步适配层"。 */
function isThenable(value) {
  return Boolean(value) && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

/** 归一成"非空短字符串"，否则 null。 */
function text(value, max = DETAIL_MAX_CHARS) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

/** 把任意时钟写法归一成毫秒（函数 / Date / 数字 / ISO 串都认）。 */
function resolveMs(now) {
  let ms;
  if (typeof now === 'function') ms = Number(now());
  else if (now instanceof Date) ms = now.getTime();
  else if (typeof now === 'number') ms = now;
  else if (typeof now === 'string') ms = Date.parse(now);
  if (!Number.isFinite(ms)) ms = Date.now();
  return ms;
}

/** 毫秒 → 规范 ISO（审计里所有时间都是 UTC ISO，排序与展示都靠它）。 */
function toIso(ms) {
  return new Date(ms).toISOString();
}

/** 对任意值取短指纹（只用于 ref，绝不用来存 body）。 */
function fingerprint(value) {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return null;
    return createHash('sha1').update(json).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/** 去重 + 截断的字符串数组。 */
function stringList(value, { max = Infinity, maxChars = DETAIL_MAX_CHARS } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const item = text(raw, maxChars);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/* ────────────────────────── 字段归一 / 校验 ────────────────────────── */

/**
 * 把一个"可能是脏的"审计条目归一成固定形状。
 *
 * 为什么用**白名单**而不是黑名单：审计条目的来源是 HTTP 响应 + 调用方随手拼的对象，
 * 里面随时可能被塞进 `snapshot`（几十 KB 的 spec）或 `steps[].ms` 之类的临时字段。
 * 只挑认识的 13 个字段复制，才能从结构上保证"完整 snapshot 永远不会进 KV"——
 * 黑名单漏一个键就前功尽弃。
 *
 * @param {unknown} entry 待归一化的条目
 * @returns {{ok:true, value:object}|{ok:false, error:string}} 归一结果（error 为中文）
 */
export function normalizeAuditEntry(entry) {
  if (!isPlainObject(entry)) {
    return { ok: false, error: '审计条目必须是对象：收到的是空值/数组，已丢弃本次审计' };
  }

  const id = text(entry.id, ID_MAX_CHARS);
  if (!id) {
    return { ok: false, error: '审计条目缺少 id：id 是幂等重放的唯一依据，缺它无法安全落库' };
  }

  const rawAt = entry.at;
  const ms = rawAt instanceof Date ? rawAt.getTime()
    : typeof rawAt === 'number' ? rawAt
      : typeof rawAt === 'string' ? Date.parse(rawAt)
        : NaN;
  if (!Number.isFinite(ms)) {
    return { ok: false, error: '审计条目缺少合法的 at（ISO 时间）：没有时间就无法排序、无法按时间淘汰' };
  }
  const at = toIso(ms);

  const action = AUDIT_ACTIONS.includes(entry.action) ? entry.action : 'update';
  const actor = text(entry.actor, ACTOR_MAX_CHARS) || 'unknown';

  const namespace = text(entry.namespace, TARGET_MAX_CHARS);
  const name = text(entry.name, TARGET_MAX_CHARS);
  let serviceKey = text(entry.serviceKey, TARGET_MAX_CHARS);
  if (!serviceKey && namespace && name) serviceKey = `${namespace}/${name}`;
  if (serviceKey && !serviceKey.includes('/')) serviceKey = null;

  const steps = [];
  if (Array.isArray(entry.steps)) {
    for (const raw of entry.steps) {
      if (steps.length >= MAX_STEPS) break;
      if (!isPlainObject(raw)) continue;
      const stepName = text(raw.name, TARGET_MAX_CHARS);
      if (!stepName) continue;
      steps.push({
        name: stepName,
        ok: raw.ok === true,
        detail: text(raw.detail) ?? '',
      });
    }
  }

  // snapshotRef 只接受字符串：哪怕调用方手滑把整个 snapshot 对象传进来，也不会被写进 KV。
  const snapshotRef = text(entry.snapshotRef, TARGET_MAX_CHARS);

  return {
    ok: true,
    value: {
      id,
      at,
      actor,
      action,
      serviceKey: serviceKey ?? null,
      namespace: namespace ?? null,
      name: name ?? null,
      targets: stringList(entry.targets, { max: MAX_TARGETS, maxChars: TARGET_MAX_CHARS }),
      steps,
      ok: entry.ok === true,
      error: text(entry.error),
      snapshotRef,
      forced: stringList(entry.forced, { max: 10, maxChars: FORCED_MAX_CHARS }),
    },
  };
}

/* ────────────────────────── 条目构造 ────────────────────────── */

/** 从 render 对象里拿 `Kind/name`（兼容 k8s 原生对象与 A5 快照的 {ref} 形状）。 */
function collectTargets({ service, result }) {
  const out = [];
  const push = (kind, name) => {
    const k = text(kind, TARGET_MAX_CHARS);
    const n = text(name, TARGET_MAX_CHARS);
    if (!k || !n) return;
    const target = `${k}/${n}`;
    if (!out.includes(target) && out.length < MAX_TARGETS) out.push(target);
  };

  // ① 优先用本次真正要写的对象（A1 render 的产物，调用方通过 result.objects 带过来）
  const objects = Array.isArray(result?.objects) ? result.objects : [];
  for (const obj of objects) push(obj?.kind, obj?.metadata?.name ?? obj?.name);
  if (out.length > 0) return out;

  // ② 退一步用 A5 抓的快照引用（只有 ref，没有 body —— 正好是审计需要的粒度）
  const snapshotObjects = Array.isArray(result?.snapshot?.objects) ? result.snapshot.objects : [];
  for (const item of snapshotObjects) push(item?.ref?.kind, item?.ref?.name);
  if (out.length > 0) return out;

  // ③ 再退一步：A1 对每个服务固定渲染 Deployment + Service，名字同服务名
  const name = text(service?.name, TARGET_MAX_CHARS);
  if (name) {
    push('Deployment', name);
    push('Service', name);
  }
  return out;
}

/** 把 A5 的 action 映射成审计的 4 值枚举（noop 归到 update，steps 里会说明"无实质差异"）。 */
function deriveAction({ action, result }) {
  const explicit = text(action, 40)?.toLowerCase();
  if (explicit && AUDIT_ACTIONS.includes(explicit)) return explicit;

  const raw = text(result?.action, 40)?.toLowerCase();
  if (raw === 'rollback') return 'rollback';
  if (raw === 'rejected') return 'rejected';
  if (raw === 'create') return 'create';
  if (raw === 'patch' || raw === 'update' || raw === 'noop') return 'update';
  if (result?.ok === false || result?.allowed === false) return 'rejected';
  return 'update';
}

/**
 * 把一次 apply/rollback 的结果整理成一条**可直接落库**的审计条目。
 *
 * 只搬运"能破案"的信息：谁（actor）、什么时候（at）、动了哪个服务（serviceKey）、
 * 动了哪些对象（targets）、每一步成没成（steps）、结果（ok/error）、
 * 能不能回滚（snapshotRef）、有没有人按了 force（forced）。
 * **不搬运** snapshot body：那是 `saveSnapshot()` 的活，审计只留引用/指纹。
 *
 * @param {object} params
 * @param {object} [params.service] A1 的 ModelService（只读 namespace / name）
 * @param {object} [params.result] A5 applyService / rollbackService 的返回值
 * @param {string} [params.actor] 操作者（登录名 / `x-openlog-actor` / 'api'）
 * @param {string[]|string} [params.forced] 被 force 绕过的护栏 code
 * @param {string|null} [params.snapshotRef] 快照引用；为空时对 result.snapshot 取短指纹
 * @param {'create'|'update'|'rollback'|'rejected'} [params.action] 显式覆盖（一般不用）
 * @param {number|Date|string|(() => number)} [params.now] 时钟（测试注入假时钟）
 * @returns {{id:string, at:string, actor:string, action:string, serviceKey:string|null,
 *   namespace:string|null, name:string|null, targets:string[], steps:{name:string,ok:boolean,detail:string}[],
 *   ok:boolean, error:string|null, snapshotRef:string|null, forced:string[]}}
 *   完整条目（字段与服务端契约一一对应）
 *
 * @example
 * buildAuditEntry({
 *   service: { namespace: 'inference', name: 'qwen' },
 *   result: { ok: true, action: 'patch', steps: [{ name: 'apply', ok: true, detail: '更新 2 个对象' }] },
 *   actor: 'alice',
 *   forced: [],
 *   snapshotRef: 'inference/qwen@2026-01-01T00:00:00.000Z',
 *   now: 1767225600000,
 * });
 */
export function buildAuditEntry({ service, result, actor, forced, snapshotRef, action, now } = {}) {
  const at = toIso(resolveMs(now));
  const namespace = text(service?.namespace, TARGET_MAX_CHARS);
  const name = text(service?.name, TARGET_MAX_CHARS);
  const serviceKey = namespace && name ? `${namespace}/${name}` : (text(service?.serviceKey, TARGET_MAX_CHARS) ?? null);
  const resolvedAction = deriveAction({ action, result });
  const ok = result?.ok === true;
  const error = ok ? null : (text(result?.error) ?? null);
  const targets = collectTargets({ service, result });

  const steps = [];
  for (const raw of (Array.isArray(result?.steps) ? result.steps : [])) {
    if (steps.length >= MAX_STEPS) break;
    const stepName = text(raw?.name, TARGET_MAX_CHARS);
    if (!stepName) continue;
    steps.push({ name: stepName, ok: raw?.ok === true, detail: text(raw?.detail) ?? '' });
  }

  const ref = text(snapshotRef, TARGET_MAX_CHARS);
  // 没给 ref 但确实抓到了快照对象：取 12 位指纹当 ref，body 依旧不落库（能对上 saveSnapshot 里的那份）。
  // 空快照（`objects: []`，被拒/干跑失败时就是这样）不编 ref —— 一个指向空数组的引用是假信息。
  const snapshotObjects = Array.isArray(result?.snapshot?.objects) ? result.snapshot.objects : [];
  const bodyHash = ref || snapshotObjects.length === 0 ? null : fingerprint(result.snapshot);
  const resolvedRef = ref ?? (bodyHash ? `snap_${bodyHash}` : null);

  const forcedList = stringList(
    typeof forced === 'string' ? [forced] : forced,
    { max: 10, maxChars: FORCED_MAX_CHARS },
  );

  // 幂等 id：同一份结果（服务 + 动作 + 时间 + 每步成败 + 目标）重放得到同一个 id。
  // 这样"apply 成功但响应超时，调用方重试"不会在审计里留下两条变更。
  const canonical = JSON.stringify([
    serviceKey, resolvedAction, at, ok, error,
    targets, steps.map((s) => [s.name, s.ok]),
    resolvedRef, forcedList,
  ]);
  const id = `aud_${createHash('sha1').update(canonical).digest('hex').slice(0, 16)}`;

  return {
    id,
    at,
    actor: text(actor, ACTOR_MAX_CHARS) || 'unknown',
    action: resolvedAction,
    serviceKey,
    namespace: namespace ?? null,
    name: name ?? null,
    targets,
    steps,
    ok,
    error,
    snapshotRef: resolvedRef,
    forced: forcedList,
  };
}

/* ────────────────────────── 存储 ────────────────────────── */

/** 比较两个条目（最新在前）。at 都是规范 ISO，字符串比较即时间比较；解析失败视为最旧。 */
function newerFirst(a, b) {
  const am = Date.parse(a?.at);
  const bm = Date.parse(b?.at);
  const av = Number.isFinite(am) ? am : -Infinity;
  const bv = Number.isFinite(bm) ? bm : -Infinity;
  return bv - av;
}

/**
 * 创建审计存储。所有读写都通过注入的 KV(getKv/setKv)，因此与数据库方言无关。
 *
 * @param {object} params
 * @param {(key:string)=>any} params.getKv 同步读（项目里的 `db.getKv` 是内存同步读）
 * @param {(key:string, value:any)=>any} params.setKv 写（可返回 Promise，异步失败也会被吞掉并 warn）
 * @param {() => number} [params.now] 毫秒时钟（默认 Date.now）
 * @param {number} [params.keep=500] 环形保留条数（超出按时间淘汰最旧的）
 * @param {{warn?:Function}} [params.logger] 注入日志（默认 console）
 * @returns {{
 *   record: (entry:object) => {ok:boolean, id:string|null, total:number, dropped:number, error:string|null, write:Promise<{ok:boolean, error:string|null}>},
 *   list: (filter?:{limit?:number, offset?:number, actor?:string, action?:string, serviceKey?:string}) => {total:number, items:object[], limit:number, offset:number, error?:string},
 *   stats: () => {total:number, byAction:Record<string,number>, byActor:{actor:string,count:number}[], lastAt:string|null},
 *   clear: () => {ok:boolean, total:number, error:string|null},
 *   now: () => number,
 *   key: string
 * }}
 *
 * @example
 * const store = createAuditStore({ getKv, setKv, keep: 200 });
 * store.record(buildAuditEntry({ service, result, actor: 'alice', now: Date.now() }));
 * store.list({ action: 'rejected', limit: 10 });
 */
export function createAuditStore({ getKv, setKv, now, keep = DEFAULT_KEEP, logger } = {}) {
  const log = logger && typeof logger.warn === 'function' ? logger : console;
  const clock = () => resolveMs(now);
  const capacity = Math.max(1, Math.floor(Number(keep) || DEFAULT_KEEP));

  /** 读全量（永不抛；返回 error 让调用方决定是"空列表"还是"别写坏数据"）。 */
  function readEntries() {
    if (typeof getKv !== 'function') {
      return { ok: false, entries: [], error: '审计存储缺少 getKv：请在 createAuditStore 里注入同步读取函数' };
    }
    let raw;
    try {
      raw = getKv(AUDIT_KV_KEY);
    } catch (err) {
      return { ok: false, entries: [], error: `审计读取失败：${err?.message ?? String(err)}` };
    }
    if (isThenable(raw)) {
      // 异步适配层：这里不能 await（list/stats 是同步 API，路由直接 `store.list(...)`）。
      // 与其把异步对象当空数组、把整库覆盖成空，不如明确报错。
      return { ok: false, entries: [], error: '审计存储要求同步 getKv：收到 Promise，已跳过读写以免覆盖历史审计' };
    }
    let parsed = raw;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return { ok: false, entries: [], error: '审计数据不是合法 JSON：请检查 kv_store 里的 infra_audit' };
      }
    }
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.items)) parsed = parsed.items;
    if (!Array.isArray(parsed)) return { ok: true, entries: [] };
    // 脏数据容忍：缺 id/at 的条目无法排序也无法幂等，直接跳过而不是让整表崩掉。
    const entries = parsed.filter((item) => isPlainObject(item) && text(item.id) && Number.isFinite(Date.parse(item.at)));
    return { ok: true, entries };
  }

  /**
   * 写一条审计。**永不抛错**：存储层失败只 warn，并返回 `{ ok:false, error }`。
   * `write` 是被吞过异常的 Promise（异步 KV 的失败也能被 `recordApply` 看见），
   * 不 await 也不会产生 unhandledRejection。
   */
  function record(entry) {
    const normalized = normalizeAuditEntry(entry);
    const failed = (error, id = null, total = 0, dropped = 0) => {
      log.warn(`[Infra][audit] ${error}`);
      return { ok: false, id, total, dropped, error, write: Promise.resolve({ ok: false, error }) };
    };

    if (!normalized.ok) return failed(normalized.error, text(entry?.id, ID_MAX_CHARS) ?? null);

    const loaded = readEntries();
    if (!loaded.ok) return failed(`${loaded.error}（本次审计未入库，变更本身不受影响）`);

    const value = normalized.value;
    const entries = loaded.entries.slice();
    const index = entries.findIndex((item) => item.id === value.id);
    if (index >= 0) entries[index] = value; // 幂等重放：覆盖，不追加
    else entries.push(value);

    entries.sort(newerFirst);
    const dropped = Math.max(0, entries.length - capacity);
    const kept = dropped > 0 ? entries.slice(0, capacity) : entries;

    let pending;
    try {
      pending = setKv(AUDIT_KV_KEY, kept);
    } catch (err) {
      return failed(`审计写入失败：${err?.message ?? String(err)}（变更本身已生效，请稍后补查）`, value.id, kept.length, dropped);
    }

    const message = err => `审计写入失败：${err?.message ?? String(err)}（变更本身已生效，请稍后补查）`;
    const write = Promise.resolve(pending).then(
      () => ({ ok: true, error: null }),
      (err) => {
        log.warn(`[Infra][audit] ${message(err)}`);
        return { ok: false, error: message(err) };
      },
    );

    return { ok: true, id: value.id, total: kept.length, dropped, error: null, write };
  }

  /** 查审计（同步，最新在前），支持 actor / action / serviceKey 过滤与分页。 */
  function list({ limit = DEFAULT_LIST_LIMIT, offset = 0, actor, action, serviceKey } = {}) {
    const loaded = readEntries();
    const size = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
    const start = Math.max(Math.floor(Number(offset) || 0), 0);
    if (!loaded.ok) {
      return { total: 0, items: [], limit: size, offset: start, error: loaded.error };
    }

    const wantActor = text(actor, ACTOR_MAX_CHARS);
    const wantAction = text(action, 40)?.toLowerCase() ?? null;
    const wantKey = text(serviceKey, TARGET_MAX_CHARS);

    const matched = loaded.entries.filter((item) => {
      if (wantActor && item.actor !== wantActor) return false;
      if (wantAction && item.action !== wantAction) return false;
      if (wantKey && item.serviceKey !== wantKey) return false;
      return true;
    });
    matched.sort(newerFirst);
    return {
      total: matched.length,
      items: matched.slice(start, start + size),
      limit: size,
      offset: start,
    };
  }

  /** 概览：总数、按动作分布、按人分布（降序）、最后一次操作时间。 */
  function stats() {
    const loaded = readEntries();
    const byAction = Object.fromEntries(AUDIT_ACTIONS.map((item) => [item, 0]));
    const actorMap = new Map();
    let lastAt = null;

    for (const item of loaded.entries) {
      if (item.action in byAction) byAction[item.action] += 1;
      const who = text(item.actor, ACTOR_MAX_CHARS) || 'unknown';
      actorMap.set(who, (actorMap.get(who) ?? 0) + 1);
      if (!lastAt || (Date.parse(item.at) || 0) > (Date.parse(lastAt) || 0)) lastAt = item.at;
    }

    const byActor = [...actorMap.entries()]
      .map(([who, count]) => ({ actor: who, count }))
      .sort((a, b) => b.count - a.count || a.actor.localeCompare(b.actor));

    return { total: loaded.entries.length, byAction, byActor, lastAt };
  }

  /** 清空审计（运维/测试用；同样不抛错）。 */
  function clear() {
    if (typeof setKv !== 'function') return { ok: false, total: 0, error: '审计存储缺少 setKv' };
    try {
      setKv(AUDIT_KV_KEY, []);
      return { ok: true, total: 0, error: null };
    } catch (err) {
      const error = `审计清空失败：${err?.message ?? String(err)}`;
      log.warn(`[Infra][audit] ${error}`);
      return { ok: false, total: 0, error };
    }
  }

  return { record, list, stats, clear, now: clock, key: AUDIT_KV_KEY };
}

/* ────────────────────────── 便捷入口 ────────────────────────── */

/**
 * 记录一次 apply / rollback：构造条目 + 落库 + 把失败转成返回值。**永不因审计失败而抛错**。
 *
 * 路由层用法（apply 成功之后立刻调用，失败不影响响应）：
 * ```js
 * const { id } = await recordApply({ store, service, result, actor, forced, snapshotRef });
 * result.auditId = id ?? null;
 * ```
 *
 * @param {object} params
 * @param {ReturnType<typeof createAuditStore>|null} params.store 审计存储（为空时返回 ok:false，不抛）
 * @param {object} [params.service] ModelService
 * @param {object} [params.result] applyService / rollbackService 的返回值
 * @param {string} [params.actor] 操作者
 * @param {string[]|string} [params.forced] force 绕过的护栏 code
 * @param {string|null} [params.snapshotRef] 快照引用（不要传 body）
 * @param {'create'|'update'|'rollback'|'rejected'} [params.action] 显式动作覆盖
 * @param {number|Date|string|(() => number)} [params.now] 时钟
 * @returns {Promise<{ok:boolean, id:string|null, entry:object|null, total:number|null, error:string|null}>}
 *   `id` 是**已入库**的审计 id（失败时为 null，路由据此回填 auditId）
 */
export async function recordApply({
  store, service, result, actor, forced, snapshotRef, action, now,
} = {}) {
  const entry = buildAuditEntry({
    service, result, actor, forced, snapshotRef, action,
    now: now ?? (typeof store?.now === 'function' ? store.now : undefined),
  });

  if (!store || typeof store.record !== 'function') {
    const error = '审计存储未就绪（缺 record）：本次变更未留痕，请检查 audit-store 模块加载';
    console.warn(`[Infra][audit] ${error}`);
    return { ok: false, id: null, entry, total: null, error };
  }

  let outcome;
  try {
    outcome = store.record(entry);
  } catch (err) {
    // record 本身不该抛；这里兜一层，防止自定义 store 实现把 apply 带走。
    const error = `审计落库异常：${err?.message ?? String(err)}（变更本身已生效）`;
    console.warn(`[Infra][audit] ${error}`);
    return { ok: false, id: null, entry, total: null, error };
  }

  if (outcome?.write) {
    const settled = await outcome.write;
    if (!settled?.ok) {
      return { ok: false, id: null, entry, total: outcome?.total ?? null, error: settled?.error ?? '审计写入失败' };
    }
  }
  if (outcome?.ok === false) {
    return { ok: false, id: null, entry, total: outcome.total ?? null, error: outcome.error ?? '审计被拒绝' };
  }

  return {
    ok: true,
    id: outcome?.id ?? entry.id,
    entry,
    total: outcome?.total ?? null,
    error: null,
  };
}

export default { createAuditStore, buildAuditEntry, recordApply, normalizeAuditEntry };
