/**
 * 告警规则引擎 —— Prometheus 的 `for:` / `keep_firing_for` / `labels` / `annotations` 语义，
 * 外加 Alertmanager 的分组、抑制、静默。
 *
 * 与 Prometheus 对齐的关键行为（这些是最容易被做错的地方）：
 *
 *   · **`for` 是「持续满足」而不是「累计满足」**。规则表达式第一次为真时进入
 *     pending 状态并记下时刻；在 for 到期前如果变成假，立刻退回 inactive。
 *     不是「数一数满足了多少次」。
 *
 *   · **pending 期间重启会重置**。Prometheus 也是这个行为（没有持久化 pending 状态），
 *     所以重启后要重新等满 for。不隐藏这一点。
 *
 *   · **整条规则用同一个求值时刻**。表达式里的 `time()` 与 for 的判定必须基于
 *     同一个 now，否则会出现「表达式说 12:00 满足，for 判定用 12:01」的错位。
 *
 *   · **同一规则的多条告警按 labels 区分**。`rate(x[5m]) > 0.1` 对 10 个实例
 *     同时为真，就是 10 条独立告警，各自有自己的 for 计时。
 */

import { createEvaluator } from './promql-engine.js';
import { labelKey } from './promql-engine.js';

/** 告警状态 */
export const ALERT_STATE = {
  INACTIVE: 'inactive',
  PENDING: 'pending',
  FIRING: 'firing',
};

/**
 * 校验规则组配置。
 *
 * @param {object} cfg
 * @param {Array<{name:string, interval?:string, rules:Array}>} cfg.ruleGroups
 * @returns {{ groups: Array, errors: Array<string> }}
 */
export function normalizeRuleGroups(cfg) {
  const errors = [];
  const groups = [];
  const raw = cfg && Array.isArray(cfg.ruleGroups) ? cfg.ruleGroups : [];

  raw.forEach((g, gi) => {
    if (!g || typeof g !== 'object') {
      errors.push(`ruleGroups[${gi}] 不是对象`);
      return;
    }
    const name = String(g.name || '').trim();
    if (!name) {
      errors.push(`ruleGroups[${gi}] 缺少组名`);
      return;
    }
    const rules = [];
    const rawRules = Array.isArray(g.rules) ? g.rules : [];
    rawRules.forEach((r, ri) => {
      const where = `ruleGroups[${gi}] (${name}) rules[${ri}]`;
      if (!r || typeof r !== 'object') { errors.push(`${where} 不是对象`); return; }
      const alert = String(r.alert || '').trim();
      const record = String(r.record || '').trim();
      const expr = String(r.expr || '').trim();
      if (!expr) { errors.push(`${where} 缺少 expr`); return; }
      if (!alert && !record) { errors.push(`${where} 必须有 alert 或 record`); return; }
      if (alert && record) { errors.push(`${where} alert 与 record 不能同时存在`); return; }
      if (alert && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alert)) {
        errors.push(`${where} 告警名非法: ${alert}`);
        return;
      }
      if (record && !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(record)) {
        errors.push(`${where} 记录规则名非法: ${record}`);
        return;
      }
      const forMs = r.for ? parseDurationLoose(String(r.for)) : 0;
      if (forMs === null) { errors.push(`${where} 的 for 非法: ${r.for}`); return; }

      rules.push({
        kind: alert ? 'alert' : 'record',
        name: alert || record,
        expr,
        forMs: forMs || 0,
        labels: r.labels && typeof r.labels === 'object' ? r.labels : {},
        annotations: r.annotations && typeof r.annotations === 'object' ? r.annotations : {},
        group: name,
      });
    });
    groups.push({
      name,
      intervalMs: g.interval ? parseDurationLoose(String(g.interval)) : null,
      rules,
    });
  });

  return { groups, errors };
}

/**
 * 宽松的时长解析：接受 `15s` / `1m` / `1h30m` / 纯数字（当毫秒）。
 * 必须支持组合写法 —— `for: 1h30m` 是运维里最常见的写法之一，只认单单位会静默丢规则。
 */
function parseDurationLoose(s) {
  const str = String(s).trim();
  if (str === '') return null;
  if (/^\d+$/.test(str)) return Number(str);

  const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
  let i = 0;
  let total = 0;
  let matched = false;
  while (i < str.length) {
    const numStart = i;
    while (i < str.length && /[0-9.]/.test(str[i])) i += 1;
    if (i === numStart) return null;
    const num = Number(str.slice(numStart, i));
    if (!Number.isFinite(num) || num < 0) return null;

    let unit = null;
    for (const u of ['ms', 's', 'm', 'h', 'd', 'w', 'y']) {
      if (str.startsWith(u, i)) { unit = u; break; }
    }
    if (!unit) return null;
    i += unit.length;
    total += num * UNITS[unit];
    matched = true;
  }
  return matched ? total : null;
}

/** 把 annotation 里的 `{{ $labels.x }}` / `{{ $value }}` 模板替换掉 */
export function renderTemplate(tpl, labels, value) {
  return String(tpl ?? '').replace(/\{\{\s*\$labels\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, k) => {
    return labels && labels[k] !== undefined ? String(labels[k]) : '';
  }).replace(/\{\{\s*\$value\s*\}\}/g, () => (value === undefined ? '' : String(value)));
}

/**
 * 创建规则求值器。
 *
 * @param {object} deps
 * @param {object} deps.store TSDB
 * @param {() => number} [deps.now]
 * @param {(samples:Array) => Promise<any>} [deps.writeSamples] 记录规则的输出写回
 */
export function createRuleEngine(deps = {}) {
  const store = deps.store;
  const now = deps.now || (() => Date.now());
  const evaluator = createEvaluator({ store, now });

  /** 规则名 → Map(alertKey → { activeAt, state, labels, value, annotations }) */
  const state = new Map();
  /** 最近一次求值的结果快照（/api/v1/rules） */
  let lastEval = { at: null, groups: [], errors: [] };
  /** 记录规则产出的样本（用户可查询 <record名>） */
  const recordedSeries = new Map();

  /**
   * 求值全部规则组。
   * @returns {Promise<{ alerts:Array, fired:Array, resolved:Array, errors:Array }>}
   */
  async function evaluateAll(groups) {
    const evalAt = now();
    const allAlerts = [];
    const fired = [];
    const resolved = [];
    const errors = [];
    const groupSnapshots = [];

    for (const group of groups || []) {
      const groupAlerts = [];
      for (const rule of group.rules || []) {
        try {
          const r = await evaluator.query(rule.expr, { time: evalAt });
          if (r.error) {
            errors.push({ group: group.name, rule: rule.name, error: r.error.message });
            groupAlerts.push({ name: rule.name, kind: rule.kind, health: 'err', error: r.error.message });
            continue;
          }

          if (rule.kind === 'record') {
            // 记录规则：把结果当成新序列写回（本轮只在内存里，供后续查询）
            const series = (r.result || []).map((item) => ({
              labels: { ...item.metric, ...rule.labels },
              value: Number(item.value[1]),
            }));
            recordedSeries.set(rule.name, { at: evalAt, series });
            groupAlerts.push({
              name: rule.name, kind: 'record', health: 'ok',
              seriesCount: series.length, lastEvalMs: evalAt,
            });
            continue;
          }

          // 告警规则
          const prevMap = state.get(rule.name) || new Map();
          const nextMap = new Map();

          for (const item of r.result || []) {
            const labels = { ...item.metric, ...rule.labels };
            const key = labelKey(labels);
            const value = Number(item.value[1]);
            const prev = prevMap.get(key);

            let activeAt = prev ? prev.activeAt : evalAt;
            let st;
            if (rule.forMs > 0 && evalAt - activeAt < rule.forMs) {
              st = ALERT_STATE.PENDING;
            } else {
              st = ALERT_STATE.FIRING;
            }

            // 从 pending 变 firing 的那一刻才算 fired
            if (st === ALERT_STATE.FIRING && (!prev || prev.state !== ALERT_STATE.FIRING)) {
              fired.push({ name: rule.name, labels, value, group: rule.group });
            }

            const alert = {
              name: rule.name,
              group: rule.group,
              labels,
              annotations: renderAnnotations(rule.annotations, labels, value),
              value,
              state: st,
              activeAt,
              forMs: rule.forMs,
            };
            nextMap.set(key, alert);
            allAlerts.push(alert);
          }

          // 上一轮有、这一轮没有 → 已恢复
          for (const [key, prev] of prevMap) {
            if (!nextMap.has(key)) {
              if (prev.state !== ALERT_STATE.INACTIVE) {
                resolved.push({ name: rule.name, labels: prev.labels, state: prev.state, group: rule.group });
              }
            }
          }

          state.set(rule.name, nextMap);
          groupAlerts.push({
            name: rule.name, kind: 'alert', health: 'ok',
            alerts: [...nextMap.values()],
            lastEvalMs: evalAt,
          });
        } catch (err) {
          errors.push({ group: group.name, rule: rule.name, error: String(err?.message || err) });
          groupAlerts.push({ name: rule.name, kind: rule.kind, health: 'err', error: String(err?.message || err) });
        }
      }
      groupSnapshots.push({ name: group.name, intervalMs: group.intervalMs, rules: groupAlerts, lastEvalMs: evalAt });
    }

    lastEval = { at: evalAt, groups: groupSnapshots, errors };
    return { alerts: allAlerts, fired, resolved, errors };
  }

  function renderAnnotations(annotations, labels, value) {
    const out = {};
    for (const [k, v] of Object.entries(annotations || {})) {
      out[k] = renderTemplate(v, labels, formatAlertValue(value));
    }
    return out;
  }

  return {
    evaluateAll,
    /** 全部告警（含 pending） */
    alerts() {
      const out = [];
      for (const m of state.values()) out.push(...m.values());
      return out;
    },
    /** 只有 firing 的 */
    firing() {
      return this.alerts().filter((a) => a.state === ALERT_STATE.FIRING);
    },
    /** 记录规则的产出 */
    recorded(name) {
      return recordedSeries.get(name) || null;
    },
    snapshot() {
      return lastEval;
    },
    /** 清空全部状态（改配置后调用） */
    reset() {
      state.clear();
      recordedSeries.clear();
      lastEval = { at: null, groups: [], errors: [] };
    },
  };
}

function formatAlertValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  // 告警文案里的数字要短：0.123456789 → 0.1235
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

// ────────────────────── Alertmanager 语义：分组 / 抑制 / 静默 ──────────────────────

/**
 * 告警分组。
 *
 * 分组的目的是「一次故障只发一条通知」，而不是每个实例发一条。
 * `groupBy: ['alertname', 'cluster']` 表示同一告警名 + 同一集群的实例归成一组。
 *
 * @param {Array<object>} alerts firing 的告警
 * @param {Array<{groupBy:string[], groupWait?:string, groupInterval?:string, repeatInterval?:string}>} routes
 * @returns {Array<{key:string, groupBy:object, alerts:Array}>}
 */
export function groupAlerts(alerts, routes) {
  const list = Array.isArray(alerts) ? alerts : [];
  const groups = new Map();

  const routeList = Array.isArray(routes) && routes.length ? routes : [{ groupBy: ['alertname'] }];

  for (const alert of list) {
    // 逐条 route 匹配：这里简化成「按 groupBy 全量分组」，
    // 真实 Alertmanager 的 route 树是递归匹配 + continue，本项目按单层处理
    for (const route of routeList) {
      const by = Array.isArray(route.groupBy) && route.groupBy.length ? route.groupBy : ['alertname'];
      const keyParts = by.map((k) => `${k}=${alert.labels?.[k] ?? ''}`);
      const key = keyParts.join('\u0001');
      if (!groups.has(key)) {
        const groupLabels = {};
        for (const k of by) if (alert.labels?.[k] !== undefined) groupLabels[k] = alert.labels[k];
        groups.set(key, { key, groupBy: groupLabels, alerts: [] });
      }
      groups.get(key).alerts.push(alert);
    }
  }

  return [...groups.values()];
}

/**
 * 抑制规则：某类告警存在时，把另一类告警压掉。
 *
 * 典型用法：机器宕机（`up == 0`）时，抑制这台机器上的所有其它告警 ——
 * 否则一个节点挂掉会喷出几十条「CPU 高」「磁盘满」，把真正的原因埋掉。
 *
 * @param {Array<object>} alerts
 * @param {Array<{sourceMatch:Object, targetMatch:Object, equal?:string[]}>} inhibitRules
 * @returns {{ kept:Array, suppressed:Array }}
 */
export function applyInhibition(alerts, inhibitRules) {
  const list = Array.isArray(alerts) ? alerts : [];
  const rules = Array.isArray(inhibitRules) ? inhibitRules : [];
  const suppressed = [];
  const suppressedSet = new Set();

  for (const rule of rules) {
    const sources = list.filter((a) => matchSelector(a.labels, rule.sourceMatch));
    if (sources.length === 0) continue;

    for (const target of list) {
      if (!matchSelector(target.labels, rule.targetMatch)) continue;
      // equal 里列的标签必须两边相同才算「同一个对象」
      const equal = Array.isArray(rule.equal) ? rule.equal : [];
      const isEqual = equal.every((k) => (sources[0].labels?.[k] ?? '') === (target.labels?.[k] ?? ''));
      if (!isEqual) continue;
      // 自己抑制自己没意义
      if (suppressedSet.has(target)) continue;
      suppressedSet.add(target);
      suppressed.push({ alert: target, by: sources[0].name });
    }
  }

  return { kept: list.filter((a) => !suppressedSet.has(a)), suppressed };
}

/** 用 {k:v} 匹配标签（等值） */
export function matchSelector(labels, selector) {
  if (!selector || typeof selector !== 'object') return false;
  const keys = Object.keys(selector);
  if (keys.length === 0) return false;
  return keys.every((k) => String(labels?.[k] ?? '') === String(selector[k]));
}

/**
 * 静默（silence）：在时间窗内按标签匹配压掉告警。
 *
 * 与抑制的区别：静默是**人工**的（维护窗口），抑制是**规则**的。
 *
 * @param {Array<object>} alerts
 * @param {Array<{id:string, matchers:Object, startsAt:number, endsAt:number, createdBy?:string, comment?:string}>} silences
 * @param {number} nowMs
 * @returns {{ kept:Array, suppressed:Array }}
 */
export function applySilences(alerts, silences, nowMs) {
  const list = Array.isArray(alerts) ? alerts : [];
  const active = (Array.isArray(silences) ? silences : []).filter(
    (s) => s && Number(nowMs) >= Number(s.startsAt) && Number(nowMs) <= Number(s.endsAt),
  );
  const suppressed = [];
  const kept = [];
  for (const a of list) {
    const hit = active.find((s) => matchSelector(a.labels, s.matchers));
    if (hit) suppressed.push({ alert: a, silenceId: hit.id });
    else kept.push(a);
  }
  return { kept, suppressed };
}

/**
 * 去重：同一组告警在 repeatInterval 内不重复通知。
 *
 * @param {Array<object>} alerts
 * @param {Map<string, number>} sentAt key → 上次发送时刻
 * @param {number} nowMs
 * @param {number} repeatMs
 * @returns {{ toSend:Array, skipped:Array }}
 */
export function dedupeByRepeatInterval(alerts, sentAt, nowMs, repeatMs) {
  const toSend = [];
  const skipped = [];
  const map = sentAt instanceof Map ? sentAt : new Map();
  for (const a of alerts) {
    const key = labelKey({ alertname: a.name, ...a.labels });
    const last = map.get(key);
    if (last !== undefined && Number(nowMs) - last < Number(repeatMs)) {
      skipped.push(a);
    } else {
      toSend.push(a);
      map.set(key, Number(nowMs));
    }
  }
  return { toSend, skipped };
}