/**
 * 告警通知通道 —— 把告警**真正发出去**。
 *
 * 在此之前，TSDB 的规则引擎只把 firing 的告警算出来返回给调用方，
 * 没有任何消费者：检查了、判定为真了，然后什么都不发生。
 * 那等于「有意义但不可用」—— 运维不会一直盯着 /api/v1/alerts 看。
 *
 * 设计上的四个决定：
 *
 * 1) **payload 兼容 Alertmanager 的 webhook 格式**。
 *    `{status, alerts:[{labels, annotations, startsAt, endsAt}]}` 是社区事实标准，
 *    钉钉/飞书/企业微信的中转器、Grafana OnCall、Robusta 都认这个形状。
 *    自己发明一个格式只会让用户多写一层转换。
 *
 * 2) **发送失败只记日志，绝不阻塞规则求值**。
 *    通知是旁路。一个 webhook 超时 10 秒，规则引擎不能跟着停 10 秒 ——
 *    后面的规则会全部延迟，firing 判定就失真了。
 *
 * 3) **按「告警实例」而非「规则」去重**。
 *    `sum by (instance)` 一条规则可能同时产出 10 条告警，
 *    去重的粒度必须是 labelset，否则一台上报就意味着其余 9 台被静音。
 *
 * 4) **恢复通知也要发**。
 *    只发「出问题」不发「已恢复」，值班的人得自己回来确认 ——
 *    那会让一次 3 分钟的抖动变成 30 分钟的焦虑。
 */

import crypto from 'node:crypto';

/** 通知事件的三种类型 */
export const NOTIFY_KIND = {
  FIRING: 'firing',
  RESOLVED: 'resolved',
};

/**
 * 把内部告警对象转成 Alertmanager 兼容的 alert 条目。
 *
 * @param {object} a 内部告警（{name, labels, annotations, value, state, activeAt}）
 * @param {number} [resolvedAt] 恢复时刻
 */
export function toAlertmanagerAlert(a, resolvedAt) {
  const labels = { alertname: a.name, ...(a.labels || {}) };
  const now = Date.now();
  const startsAt = new Date(Number(a.activeAt) || now).toISOString();
  return {
    status: resolvedAt ? 'resolved' : 'firing',
    labels,
    annotations: {
      ...(a.annotations || {}),
      // value 放进 annotation 而不是 label：它会一直变，当标签会造成序列爆炸
      value: a.value === undefined ? '' : String(a.value),
    },
    startsAt,
    endsAt: resolvedAt ? new Date(Number(resolvedAt)).toISOString() : '0001-01-01T00:00:00Z',
    generatorURL: '',
  };
}

/**
 * 构造发送体。
 *
 * @param {Array<object>} alerts 内部告警
 * @param {object} [opts]
 * @param {string} [opts.receiver] 接收器名
 * @param {Array<object>} [opts.groups] 分组结果（可选，带上更利于排查）
 * @param {number} [opts.resolvedAt] 传了就是恢复事件
 */
export function buildWebhookPayload(alerts, opts = {}) {
  const list = Array.isArray(alerts) ? alerts : [];
  const resolvedAt = opts.resolvedAt;
  const status = resolvedAt ? 'resolved' : 'firing';
  const converted = list.map((a) => toAlertmanagerAlert(a, resolvedAt));

  // text 字段：钉钉/飞书/企业微信的「文本」模式直接读它，
  // 没有这个字段就得让每个用户自己写转换器
  const title = resolvedAt ? '✅ 告警已恢复' : '🔴 告警触发';
  const lines = converted.map((a) => {
    const summary = a.annotations.summary || a.annotations.description || a.labels.alertname;
    return `· ${summary}`;
  });

  return {
    version: '4',
    status,
    receiver: opts.receiver || 'openlog',
    // 分组标签：Alertmanager 用它做通知去重
    groupLabels: converted.length ? pickGroupLabels(converted[0].labels) : {},
    commonLabels: converted.length ? converted[0].labels : {},
    commonAnnotations: converted.length ? converted[0].annotations : {},
    externalURL: '',
    alerts: converted,
    // 给纯文本通道用
    text: `${title}（${converted.length} 条）\n${lines.join('\n')}`,
    time: new Date().toISOString(),
  };
}

/** 挑出用作分组标签的键（告警名 + 常见维度） */
function pickGroupLabels(labels) {
  const keys = ['alertname', 'job', 'instance', 'severity'];
  const out = {};
  for (const k of keys) if (labels[k] !== undefined) out[k] = labels[k];
  return out;
}

/**
 * 按「告警实例」生成去重键。
 *
 * 为什么不是按规则名：一条规则可能对 50 个实例同时成立，
 * 按规则名去重会让第一次上报之后其余 49 个实例都发不出去。
 */
export function alertInstanceKey(alert) {
  const labels = alert.labels || {};
  const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
  return `${alert.name}\u0000${parts.join('\u0001')}`;
}

/**
 * 创建通知发送器。
 *
 * @param {object} deps
 * @param {() => Promise<Array<object>>} [deps.getReceivers] 返回接收器列表
 *   `[{ id, name, url, enabled, repeatIntervalMs, sendResolved }]`
 * @param {() => number} [deps.now]
 * @param {Function} [deps.fetchImpl] 注入 fetch（测试用）
 * @param {(msg:string) => void} [deps.log]
 */
export function createNotifier(deps = {}) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || ((m) => console.log(`[Notify] ${m}`));
  const fetchImpl = deps.fetchImpl;
  const getReceivers = deps.getReceivers || (() => []);

  /** 去重状态：`${receiverId}\0${alertKey}` → 上次发送时刻 */
  const sentAt = new Map();
  /** 已通知过、还在 firing 的告警实例（用于判定「真的恢复了」） */
  const active = new Set();
  /** 统计 */
  const stats = { sends: 0, failures: 0, skipped: 0, lastError: null, lastSendMs: null };

  /**
   * 处理一轮规则求值的结果。
   *
   * @param {{alerts:Array, fired:Array, resolved:Array}} evalResult
   * @param {object} [opts]
   * @param {Array<object>} [opts.inhibitRules]
   * @param {Array<object>} [opts.silences]
   * @param {Array<object>} [opts.routes]
   */
  async function dispatch(evalResult, opts = {}) {
    const receivers = (await getReceivers()) || [];
    const enabled = receivers.filter((r) => r && r.enabled !== false && r.url);
    if (enabled.length === 0) {
      // 没配接收器不是错误 —— 用户可能就想只用 API 拉
      return { suppressed: true, reason: '未配置通知接收器' };
    }

    const { firing, resolved } = splitByState(evalResult, opts, now());

    const results = [];

    // ── firing ──
    for (const a of firing) {
      const key = alertInstanceKey(a);
      const wasActive = active.has(key);
      active.add(key);
      // 已经从 inactive 转成 firing 的（fired 列表里），第一次必发；
      // 之后按各接收器的 repeatIntervalMs 重发
      const isFirst = !wasActive || (evalResult.fired || []).some(
        (f) => alertInstanceKey({ name: f.name, labels: f.labels }) === key,
      );
      for (const r of enabled) {
        const dedupeKey = `${r.id || r.url}\u0000${key}`;
        const last = sentAt.get(dedupeKey);
        const repeatMs = Number(r.repeatIntervalMs) > 0 ? Number(r.repeatIntervalMs) : 4 * 3_600_000;
        if (!isFirst && last !== undefined && now() - last < repeatMs) {
          stats.skipped += 1;
          continue;
        }
        const payload = buildWebhookPayload([a], { receiver: r.name || r.id });
        const ok = await send(r, payload);
        if (ok) sentAt.set(dedupeKey, now());
        results.push({ receiver: r.id || r.url, alert: a.name, ok });
      }
    }

    // ── resolved ──
    const resolvedNotified = [];
    for (const a of resolved) {
      const key = alertInstanceKey(a);
      if (!active.has(key)) continue; // 没通知过 firing 就不发恢复
      active.delete(key);
      const fakeAlert = { name: a.name, labels: a.labels, annotations: a.annotations || {}, value: a.value };
      for (const r of enabled) {
        if (r.sendResolved === false) continue;
        const dedupeKey = `${r.id || r.url}\u0000${key}`;
        sentAt.delete(dedupeKey);
        const payload = buildWebhookPayload([fakeAlert], { receiver: r.name || r.id, resolvedAt: now() });
        const ok = await send(r, payload);
        results.push({ receiver: r.id || r.url, alert: a.name, ok, resolved: true });
      }
      resolvedNotified.push(a);
    }

    return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, resolved: resolvedNotified };
  }

  /** 发一个 POST，失败只记录不抛 */
  async function send(receiver, payload) {
    const doFetch = fetchImpl || globalThis.fetch;
    if (!doFetch) { stats.failures += 1; return false; }
    const timeoutMs = Number(receiver.timeoutMs) > 0 ? Number(receiver.timeoutMs) : 10_000;
    try {
      const res = await doFetch(receiver.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 有些通道（钉钉/飞书）要特定 UA 才接受，给一个稳定的标识
          'User-Agent': 'OpenLog-Alert/1.0',
          ...(receiver.headers || {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      stats.sends += 1;
      stats.lastSendMs = now();
      if (!res.ok) {
        stats.failures += 1;
        stats.lastError = `HTTP ${res.status} ${receiver.url}`;
        log(`发送失败 ${receiver.url}: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      stats.failures += 1;
      const msg = err?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : String(err?.message || err);
      stats.lastError = `${msg} (${receiver.url})`;
      log(`发送失败 ${receiver.url}: ${msg}`);
      return false;
    }
  }

  return {
    dispatch,
    stats: () => ({ ...stats, activeAlerts: active.size, dedupeKeys: sentAt.size }),
    /** 测试与配置变更时清空状态 */
    reset() {
      sentAt.clear();
      active.clear();
    },
    /**
     * 测试用：直接发一条测试通知，验证 webhook 配得对不对。
     * 用户配完接收器点一下就知道通不通，不用等真出故障。
     */
    async sendTest(receiver) {
      const payload = buildWebhookPayload([{
        name: 'OpenLogTestAlert',
        labels: { severity: 'info' },
        annotations: { summary: '这是一条来自 OpenLog 的测试通知，收到即表示通道正常' },
        value: 1,
        activeAt: now(),
      }], { receiver: receiver.name || 'test' });
      return send(receiver, payload);
    },
  };
}

/**
 * 按状态拆分（并应用抑制与静默）。
 *
 * 单独抽出来是为了可测：抑制/静默的语义错一次就会漏报或误报，
 * 而它们又很难在集成测试里覆盖。
 *
 * @returns {{firing:Array, resolved:Array}}
 */
export function splitByState(evalResult, opts = {}, nowMs) {
  const alerts = Array.isArray(evalResult?.alerts) ? evalResult.alerts : [];
  const firingNow = alerts.filter((a) => a.state === 'firing');
  const resolvedList = Array.isArray(evalResult?.resolved) ? evalResult.resolved : [];

  // 抑制与静默只影响「发不发」，不影响规则状态本身
  let visible = firingNow;
  if (Array.isArray(opts.inhibitRules) && opts.inhibitRules.length) {
    visible = applyInhibit(visible, opts.inhibitRules);
  }
  if (Array.isArray(opts.silences) && opts.silences.length) {
    visible = applySilence(visible, opts.silences, nowMs);
  }

  // 被抑制/静默压掉的告警不进入 fired 判定，
  // 但要保留在 active 里 —— 否则压制解除的瞬间会被当成「新告警」重发一遍
  return { firing: visible, resolved: resolvedList };
}

/**
 * 取出用于匹配的完整标签。
 *
 * **必须把 alertname 合进去**：内部告警对象的名字在 a.name 上，
 * 而规则里的 sourceMatch/targetMatch 写的是 `{alertname: "HostDown"}`。
 * 不补这一层，任何抑制/静默规则都永远匹配不上 —— 而且不报错。
 */
function matchLabelsOf(alert) {
  return { alertname: alert.name, ...(alert.labels || {}) };
}

/** 抑制：source 存在时压掉 target（同 equal 标签） */
function applyInhibit(alerts, rules) {
  const suppressed = new Set();
  for (const rule of rules) {
    const sources = alerts.filter((a) => matchSel(matchLabelsOf(a), rule.sourceMatch));
    if (!sources.length) continue;
    for (const t of alerts) {
      if (!matchSel(matchLabelsOf(t), rule.targetMatch)) continue;
      const equal = Array.isArray(rule.equal) ? rule.equal : [];
      const src = matchLabelsOf(sources[0]);
      const tgt = matchLabelsOf(t);
      if (!equal.every((k) => String(src[k] ?? '') === String(tgt[k] ?? ''))) continue;
      suppressed.add(t);
    }
  }
  return alerts.filter((a) => !suppressed.has(a));
}

/** 静默：时间窗 + 标签匹配 */
function applySilence(alerts, silences, nowMs) {
  const activeSilences = silences.filter(
    (s) => s && nowMs >= Number(s.startsAt) && nowMs <= Number(s.endsAt),
  );
  if (!activeSilences.length) return alerts;
  return alerts.filter((a) => !activeSilences.some((s) => matchSel(matchLabelsOf(a), s.matchers)));
}

function matchSel(labels, selector) {
  if (!selector || typeof selector !== 'object') return false;
  const keys = Object.keys(selector);
  if (!keys.length) return false;
  return keys.every((k) => String(labels?.[k] ?? '') === String(selector[k]));
}

/** 生成一个接收器 id（用户在配置里没写 id 时用） */
export function receiverId(receiver) {
  const base = `${receiver.name || ''}\u0000${receiver.url || ''}`;
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 12);
}