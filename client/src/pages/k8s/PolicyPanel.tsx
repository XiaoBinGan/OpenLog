/**
 * 「调度策略（HAMi）」卡片。
 *
 * 解决的问题：Pod 为什么被排到某张卡上、显存超卖到底开没开，答案全在
 * HAMi scheduler 的两个策略开关里（节点调度 / 设备调度 = binpack 或 spread），
 * 但这两个值只存在于 scheduler 的启动参数或 ConfigMap 中 —— 页面上看不到，
 * 只能登上节点 `ps aux | grep hami`。这里把 `GET /api/k8s/clusters/:id/policy`
 * 的结果摊成三行，并**标出每个值的来源**（启动参数 / ConfigMap / 默认值 / 未知），
 * 因为「值是多少」和「这个值是谁设的」是两个问题，后者才决定改哪个文件。
 *
 * 契约（A7：server/routes/k8s-policy.js 实际返回的形状，宽进）：
 *   {
 *     nodeSchedulerPolicy: 'binpack' | 'spread' | null,
 *     deviceSchedulerPolicy: 'binpack' | 'spread' | null,
 *     overcommit: true | false | null,
 *     resourceStrategy?: string | null,          // 本卡不展示（不属于三行契约）
 *     source: 'args' | 'configmap' | 'default' | 'unknown',   // 单个字符串，三行共用
 *     raw: [{ key, value }],                     // 生效项的原始参数（数组）
 *     defaults: { nodeSchedulerPolicy, deviceSchedulerPolicy, overcommit },  // HAMi 默认值
 *     note?, reason?, demo?
 *   }
 * 同时也吃「按字段给来源」的写法（source 是对象、raw 是 { 字段: 'k=v' } 映射），
 * 以及 source 为明细对象 { kind, raw } —— 后端换写法不用改这张卡。
 *
 * 五个显示约定：
 *   · **缺失**（字段没返回 / null）显示「—」（复用 utils.MISSING），
 *     绝不把 undefined / NaN 渲染出去；
 *   · **无法识别的值**（给了但既不是 binpack / spread）显示「未知」——
 *     这跟「没返回」是两件事，前者说明后端读到了怪东西，值得让人看见；
 *   · **source:'default' 且值为 null** 时显示 `defaults` 里的 HAMi 默认值
 *     （灰一点、标签写「默认值」）：集群里没读到配置，但调度器确实跑在默认值上，
 *     显示「—」等于把已知信息藏起来；
 *   · **source:'unknown'** 时把后端的 reason 落成琥珀提示 —— 读不到的原因
 *     （连不上 / 403 / 证书）比「值缺失」有用得多；
 *   · 错误态（非 2xx）用琥珀提示而不是红色：调度策略读不到不影响其他卡片，
 *     它只是「这一块信息缺了」，不该被当成页面级故障。
 *
 * demo:true 时标题旁加「演示数据」角标（演示模式的 fixture 不是真集群的配置，
 * 不标出来就会被当成真值去对照故障）。
 */

import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { MISSING, clusterApiPath, errorText } from './utils';

/** 来源类型：HAMi 的值只可能来自这三处，其余一律归「未知」。 */
export type PolicySourceKind = 'flag' | 'configmap' | 'default' | 'unknown';

/** 调度策略值：null = 后端没给（显示 —）；'unknown' = 给了但认不出来（显示 未知）。 */
export type SchedulerPolicyValue = 'binpack' | 'spread' | 'unknown' | null;

/** 显存超卖：三态 + 「给了但认不出来」。 */
export type OvercommitValue = 'on' | 'off' | 'unknown' | null;

/** `source.<field>` 的明细写法（能多给一条原始 key=value 就多给）。 */
export interface K8sPolicySourceRef {
  kind?: string;
  from?: string;
  type?: string;
  raw?: string;
  detail?: string;
}

/** `raw` 里的单条生效参数（A7 的数组形态）。 */
export interface K8sPolicyRawEntry {
  key?: unknown;
  value?: unknown;
}

/**
 * `GET /api/k8s/clusters/:id/policy` 的响应（宽进：字段都可能缺席、写法都可能变）。
 */
export interface K8sPolicyResponse {
  nodeSchedulerPolicy?: unknown;
  deviceSchedulerPolicy?: unknown;
  overcommit?: unknown;
  source?: unknown;
  /** A7：`[{ key, value }]`；兼容 `{ 字段: 'key=value' }` 映射 */
  raw?: unknown;
  /** HAMi 默认值（读不到配置时的基线） */
  defaults?: unknown;
  note?: unknown;
  reason?: unknown;
  available?: unknown;
  demo?: unknown;
}

export interface PolicyPanelProps {
  /** 集群 id（会被 encodeURIComponent，允许含 `/` 之类的字符）。 */
  clusterId: string;
}

type PolicyField = 'nodeSchedulerPolicy' | 'deviceSchedulerPolicy' | 'overcommit';

/** 一行渲染所需的一切（渲染层不做任何判断）。 */
interface PolicyRow {
  field: PolicyField;
  label: string;
  /** 主值文案：binpack / spread / 开启 / 关闭 / 未知 / — */
  value: string;
  /** 括号里的解释（只有调度策略行有）。 */
  hint: string | null;
  source: PolicySourceKind;
  sourceLabel: string;
  /** 悬停展示的原始 key=value。 */
  raw: string;
  /** 值是否真的读到了（false 用灰色渲染「—」/「未知」）。 */
  known: boolean;
  /** 值是否来自 HAMi 默认值（不是集群里读到的）。 */
  fromDefaults: boolean;
}

interface PolicyView {
  rows: PolicyRow[];
  demo: boolean;
  /** 琥珀提示：source:'unknown' 的 reason，或 available:false 的说明。 */
  notice: string | null;
}

const SOURCE_LABEL: Record<PolicySourceKind, string> = {
  flag: '来自启动参数',
  configmap: '来自 ConfigMap',
  default: '默认值',
  unknown: '未知',
};

/** 来源标签配色：启动参数=主题蓝、ConfigMap=天蓝、默认值/未知=灰。 */
const SOURCE_CHIP_CLASS: Record<PolicySourceKind, string> = {
  flag: 'border-accent-500/30 bg-accent-500/15 text-accent-300',
  configmap: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
  default: 'border-dark-600/60 bg-dark-700/50 text-dark-300',
  unknown: 'border-dark-700/60 bg-dark-800/60 text-dark-500',
};

/**
 * 来源字符串 → 类型。
 * 后端可能写 'args' / 'flag' / 'flags' / 'CLI' / 'config-map' / 'builtin'。
 */
const SOURCE_ALIASES: Record<string, PolicySourceKind> = {
  args: 'flag',
  arg: 'flag',
  argv: 'flag',
  flag: 'flag',
  flags: 'flag',
  cli: 'flag',
  commandline: 'flag',
  command: 'flag',
  startup: 'flag',
  startuparg: 'flag',
  startupargs: 'flag',
  launcharg: 'flag',
  deployment: 'flag',
  configmap: 'configmap',
  config: 'configmap',
  cm: 'configmap',
  configmaps: 'configmap',
  default: 'default',
  defaults: 'default',
  fallback: 'default',
  builtin: 'default',
  hardcoded: 'default',
};

/** 字段 → 归一化后的参数名（用于在 raw 里认领自己那一项）。 */
const FIELD_CANONICAL: Record<PolicyField, string> = {
  nodeSchedulerPolicy: 'node-scheduler-policy',
  deviceSchedulerPolicy: 'device-scheduler-policy',
  overcommit: 'overcommit',
};

/** 字段 → 真机上对应的参数/配置键（仅用于没有 raw 时的悬停兜底文案）。 */
const FIELD_FLAG: Record<PolicyField, string> = {
  nodeSchedulerPolicy: '--node-scheduler-policy',
  deviceSchedulerPolicy: '--device-scheduler-policy',
  overcommit: '--overcommit',
};

const FIELD_CONFIG_KEY: Record<PolicyField, string> = {
  nodeSchedulerPolicy: 'scheduler.nodeSchedulerPolicy',
  deviceSchedulerPolicy: 'scheduler.deviceSchedulerPolicy',
  overcommit: 'scheduler.overcommit',
};

/** 卡片底部那句解释（binpack vs spread 对异构卡的实际影响）。 */
const FOOTER_HINT =
  'binpack 会先把一张卡填满再换下一张，异构集群里大显存整卡因此留得下来；spread 则把请求摊到各卡上，每张卡都被切碎，之后需要整卡的大任务更容易 Pending。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normSourceKind(value: unknown): PolicySourceKind {
  const text = asText(value);
  if (!text) return 'unknown';
  const key = text.toLowerCase().replace(/[\s_-]+/g, '');
  return SOURCE_ALIASES[key] ?? 'unknown';
}

/** binpack / spread 归一化；没给（undefined / null / 空串）→ null，给了怪值 → 'unknown'。 */
function normScheduler(value: unknown): SchedulerPolicyValue {
  if (value === undefined || value === null) return null;
  const text = asText(value);
  if (!text) return null;
  const key = text.toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'binpack' || key === 'binpacking' || key === 'bin') return 'binpack';
  if (key === 'spread' || key === 'spreading' || key === 'spreadout') return 'spread';
  return 'unknown';
}

/**
 * 显存超卖归一化。
 * 后端按布尔给（true/false），但字符串（'true'/'on'/'enabled'/'1'）与数字 1/0 也认：
 * 缺席 → null（显示 —），认不出来 → 'unknown'（显示 未知）。
 */
function normOvercommit(value: unknown): OvercommitValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') {
    if (value === 1) return 'on';
    if (value === 0) return 'off';
    return 'unknown';
  }
  const text = asText(value);
  if (!text) return null;
  const key = text.toLowerCase();
  if (['1', 'true', 'on', 'yes', 'enabled', 'enable', 'open', 'y'].includes(key)) return 'on';
  if (['0', 'false', 'off', 'no', 'disabled', 'disable', 'closed', 'n'].includes(key)) return 'off';
  return 'unknown';
}

/**
 * 参数名归一化，与后端 canonicalOptionName 同一套规则：
 * 去掉前导 `--`、取 `文件:键` 的最后一段、驼峰转 kebab、下划线转连字符、
 * 压掉重复连字符，再去掉 `hami-scheduler-` / `hami-` / `scheduler-` 前缀。
 */
function canonicalOptionKey(name: string): string {
  let text = String(name).trim().replace(/^-+/, '');
  const colon = text.lastIndexOf(':');
  if (colon >= 0) text = text.slice(colon + 1);
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/^hami-scheduler-/, '')
    .replace(/^hami-/, '')
    .replace(/^scheduler-/, '');
}

/**
 * raw 归一化：只摊平 A7 的 `[{key,value}]` 数组形态。
 * `{ 字段: 'k=v' }` 映射形态**不**走这里 —— 它的 key 是字段名、value 是整条
 * `key=value` 串，混进来会被拼成 `--nodeSchedulerPolicy=--node-scheduler-policy=binpack`。
 * 映射形态在 readSource 里按字段直接取。
 */
function rawEntries(data: K8sPolicyResponse): K8sPolicyRawEntry[] {
  const raw = data.raw;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((entry) => ({ key: entry.key, value: entry.value }));
}

/** `{ 字段: 'key=value' }` 映射形态：取本字段那条，没写成 `k=v` 就补上字段名。 */
function rawFromMap(field: PolicyField, raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const text = asText(raw[field]);
  if (!text) return null;
  return text.includes('=') ? text : `${FIELD_CANONICAL[field]}=${text}`;
}

/** 在 raw 里找本字段那一项，返回可悬停的 `key=value`（启动参数补回 `--`）。 */
function rawFromEntries(
  field: PolicyField,
  entries: K8sPolicyRawEntry[],
  source: PolicySourceKind,
): string | null {
  const want = FIELD_CANONICAL[field];
  for (const entry of entries) {
    const key = asText(entry.key);
    if (!key) continue;
    if (canonicalOptionKey(key) !== want) continue;
    const value = asText(entry.value) ?? '';
    // A7 的 key 已经去掉了 `--`；启动参数补回来才像真的 ps 输出
    const displayKey = source === 'flag' && !key.startsWith('-') ? `--${key}` : key;
    return `${displayKey}=${value}`;
  }
  return null;
}

/** 没有原始 key=value 时的悬停兜底：按来源类型给出「去哪儿找」而不是编一个集群配置。 */
function fallbackRaw(field: PolicyField, source: PolicySourceKind, value: string): string {
  if (value === MISSING) return '接口未返回该字段';
  if (source === 'flag') return `${FIELD_FLAG[field]}=${value.toLowerCase()}`;
  if (source === 'configmap') return `${FIELD_CONFIG_KEY[field]}=${value.toLowerCase()}`;
  if (source === 'default') {
    return `${FIELD_CONFIG_KEY[field]} 未设置（HAMi 默认值：${value.toLowerCase()}）`;
  }
  return '接口未返回原始 key=value';
}

/** 从 source / raw 里挖该字段的来源类型与原始串。 */
function readSource(
  field: PolicyField,
  data: K8sPolicyResponse,
  entries: K8sPolicyRawEntry[],
): { source: PolicySourceKind; raw: string | null } {
  const sourceMap = isRecord(data.source) ? data.source : {};

  let source: PolicySourceKind = 'unknown';
  let raw: string | null = null;

  const entry = sourceMap[field];
  if (typeof entry === 'string') {
    source = normSourceKind(entry);
  } else if (isRecord(entry)) {
    const ref = entry as K8sPolicySourceRef;
    source = normSourceKind(ref.kind ?? ref.from ?? ref.type);
    raw = asText(ref.raw) ?? asText(ref.detail);
  }

  // 顶层 source 是字符串时（A7 的写法：三行共用同一个来源），以它为准
  if (typeof data.source === 'string') {
    const shared = normSourceKind(data.source);
    if (shared !== 'unknown' || source === 'unknown') source = shared;
  }

  if (!raw) raw = rawFromEntries(field, entries, source);
  if (!raw) raw = rawFromMap(field, data.raw);

  return { source, raw };
}

/** defaults 里该字段的「HAMi 默认值」（binpack / spread / 开启关闭），没有就 null。 */
function defaultValueOf(
  data: K8sPolicyResponse,
  field: PolicyField,
): { value: string; known: boolean } | null {
  const defaults = isRecord(data.defaults) ? data.defaults : null;
  if (!defaults) return null;

  if (field === 'overcommit') {
    const normalized = normOvercommit(defaults.overcommit);
    if (normalized === 'on') return { value: '开启', known: true };
    if (normalized === 'off') return { value: '关闭', known: true };
    return null;
  }

  const normalized = normScheduler(defaults[field]);
  if (normalized === 'binpack' || normalized === 'spread') return { value: normalized, known: true };
  return null;
}

function schedulerRow(
  data: K8sPolicyResponse,
  entries: K8sPolicyRawEntry[],
  field: 'nodeSchedulerPolicy' | 'deviceSchedulerPolicy',
  label: string,
): PolicyRow {
  const normalized = normScheduler(data[field]);
  const { source, raw } = readSource(field, data, entries);

  // 读不到但后端给了默认值基线：显示默认值 + 「默认值」标签（灰一档，别当成集群配置）
  const fallback = normalized === null && source === 'default' ? defaultValueOf(data, field) : null;

  const resolved = normalized ?? (fallback?.known ? (fallback.value as 'binpack' | 'spread') : null);
  const fromDefaults = normalized === null && fallback !== null;

  const value =
    resolved === null ? MISSING : resolved === 'unknown' ? '未知' : resolved;
  const hint =
    resolved === 'binpack' ? '优先填满单卡' : resolved === 'spread' ? '优先打散' : null;

  return {
    field,
    label,
    value,
    hint,
    source,
    sourceLabel: SOURCE_LABEL[source],
    raw: raw ?? fallbackRaw(field, source, value),
    known: resolved === 'binpack' || resolved === 'spread',
    fromDefaults,
  };
}

function overcommitRow(data: K8sPolicyResponse, entries: K8sPolicyRawEntry[]): PolicyRow {
  const normalized = normOvercommit(data.overcommit);
  const { source, raw } = readSource('overcommit', data, entries);

  const fallback = normalized === null && source === 'default' ? defaultValueOf(data, 'overcommit') : null;
  const resolved = normalized ?? (fallback?.known ? (fallback.value === '开启' ? 'on' : 'off') : null);
  const fromDefaults = normalized === null && fallback !== null;

  const value = resolved === 'on' ? '开启' : resolved === 'off' ? '关闭' : resolved === 'unknown' ? '未知' : MISSING;

  return {
    field: 'overcommit',
    label: '显存超卖',
    value,
    hint: null,
    source,
    sourceLabel: SOURCE_LABEL[source],
    raw: raw ?? fallbackRaw('overcommit', source, value),
    known: resolved === 'on' || resolved === 'off',
    fromDefaults,
  };
}

/** 响应 → 视图（纯函数，所有「怎么显示」的判断都在这里）。 */
function toPolicyView(data: K8sPolicyResponse | null | undefined): PolicyView {
  const safe: K8sPolicyResponse = isRecord(data) ? data : {};
  const entries = rawEntries(safe);
  const source = readSource('nodeSchedulerPolicy', safe, entries).source;

  let notice: string | null = null;
  if (safe.available === false) {
    notice = asText(safe.reason) ?? 'HAMi scheduler 未就绪，读不到调度策略';
  } else if (source === 'unknown') {
    // 后端读不到时会带 reason（连不上 / 403 / 证书），比「值缺失」有用得多
    notice = asText(safe.reason);
  }

  return {
    rows: [
      schedulerRow(safe, entries, 'nodeSchedulerPolicy', '节点调度'),
      schedulerRow(safe, entries, 'deviceSchedulerPolicy', '设备调度'),
      overcommitRow(safe, entries),
    ],
    demo: safe.demo === true,
    notice,
  };
}

export default function PolicyPanel({ clusterId }: PolicyPanelProps) {
  const [view, setView] = useState<PolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 重试计数：只用来重新触发下面的 effect。 */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!clusterId) {
      setView(null);
      setError(null);
      setLoading(false);
      return;
    }

    // 卸载 / 切集群后回来的响应一律丢弃，避免把 A 集群的策略画到 B 集群下面
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    apiFetch<K8sPolicyResponse>(clusterApiPath(clusterId, '/policy'), {
      signal: controller.signal,
    })
      .then((data) => {
        if (!alive) return;
        setView(toPolicyView(data));
      })
      .catch((err: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setView(null);
        setError(errorText(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [clusterId, reloadToken]);

  const retry = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  return (
    <section className="glass rounded-xl p-4" data-testid="policy-panel" data-cluster={clusterId}>
      <div className="flex items-center gap-2 mb-2">
        <SlidersHorizontal className="w-4 h-4 text-accent-400" />
        <h3 className="text-sm font-semibold text-dark-100">调度策略（HAMi）</h3>
        {view?.demo && (
          <span
            data-testid="policy-demo-badge"
            className="ml-1 rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
          >
            演示数据
          </span>
        )}
      </div>

      {error ? (
        <div
          data-testid="policy-error"
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2"
        >
          <CircleAlert className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1 text-xs text-amber-300 break-words">
            读取调度策略失败：{error}
          </div>
          <button
            type="button"
            onClick={retry}
            className="flex flex-shrink-0 items-center gap-1 rounded-md bg-amber-500/20 px-2 py-0.5 text-xs text-amber-200 transition-colors hover:bg-amber-500/30"
          >
            <RefreshCw className="w-3 h-3" />
            重试
          </button>
        </div>
      ) : loading ? (
        <p className="px-1 py-3 text-xs text-dark-500">读取调度策略…</p>
      ) : view ? (
        <>
          {view.notice && (
            <p
              data-testid="policy-notice"
              className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300 break-words"
            >
              {view.notice}
            </p>
          )}
          <div className="divide-y divide-dark-800/60">
            {view.rows.map((row) => (
              <div
                key={row.field}
                data-testid="policy-row"
                data-field={row.field}
                data-from-defaults={row.fromDefaults ? 'true' : 'false'}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-1 py-2"
              >
                <span className="text-xs text-dark-400">{row.label}</span>
                <span className="min-w-0 text-sm">
                  <span
                    className={
                      row.fromDefaults
                        ? 'text-dark-300'
                        : row.known
                          ? 'font-medium text-dark-100'
                          : 'text-dark-500'
                    }
                  >
                    {row.value}
                  </span>
                  {row.hint && <span className="text-[11px] text-dark-500">（{row.hint}）</span>}
                </span>
                <span
                  data-testid="policy-source"
                  data-source={row.source}
                  title={row.raw}
                  className={`flex-shrink-0 cursor-help rounded border px-1.5 py-0.5 text-[10px] ${SOURCE_CHIP_CLASS[row.source]}`}
                >
                  {row.sourceLabel}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-dark-500" data-testid="policy-footer">
        {FOOTER_HINT}
      </p>
    </section>
  );
}
