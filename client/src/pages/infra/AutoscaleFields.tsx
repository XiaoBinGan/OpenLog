/* eslint-disable react-refresh/only-export-components --
   纯函数（预算归一 / 路径拼装 / 草稿构造）与常量必须导出：它们是「算错了不会报错、
   只会显示成另一回事」的那部分，测试要按表驱动断言。本文件不是 HMR 边界。 */
/**
 * HPA 弹性伸缩的表单段（minReplicas / maxReplicas / 冷却窗口 / 指标列表）。
 *
 * 这个组件存在的唯一理由，是让**一个必然会踩的坑在填表时就露出来**：
 *
 *   HAMi 是单卡语义 —— 一个副本的显存必须由同一张卡提供。所以
 *   `maxReplicas × resources.memoryMiB` 一旦超过单卡可容纳的量，第 N+1 个副本
 *   会永远 Pending（HAMi 报 CardInsufficientMemory），而 **HPA 不会因为 Pending
 *   而自动止损，只会一直重试**。用户看到的现象是「扩了但没起来」，比直接报错更难查。
 *
 * 因此这里每改一次上限就打一次 `GET /api/infra/clusters/:clusterId/autoscale-budget`
 * （默认 300ms 防抖，避免键盘连打把接口打满），把「单卡最多 N 副本」写在输入框下面；
 * 超预算时用红色块说明**后果**，而不是只写一句「超出预算」。
 *
 * 几个刻意的口径：
 *   · **预算判定不信单一字段**：服务端 `budget.allowed` 是按「服务当前副本数」算的
 *     （它不知道用户此刻在输入框里填了多少），所以本地还要拿 `min(byMemory, byCores)`
 *     与用户输入的 maxReplicas 再比一次，两边任一判超就算超。
 *   · **读不到容量不等于安全**：`maxReplicasByMemory === null` 说明节点单卡容量没拿到，
 *     此时不显示绿色的「通过」，而是灰色「未验证」—— 绿色是个承诺，给不出来就别给。
 *   · **数字全部走字符串草稿**：`''` / `'1-'` 这类中间态在受控输入里必然出现，
 *     用 number 存会先被 Number() 洗成 NaN 再渲染回空框。
 *
 * 本组件不发 apply 请求、不做校验拦截之外的副作用；它通过 `onChange` 把
 * 「草稿 + 预算 + 是否超限」一起交给上层（InfraPanel 负责在超限时禁用保存）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Loader, Plus, SlidersHorizontal, Trash2, TriangleAlert } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { errorText } from './types';

// ─── 常量（与 server/infra/autoscale.js 同一套数字，改这里必须同步后端） ──

/** 副本数上限（服务端 MAX_REPLICAS_LIMIT，也是护栏的 replicasMax）。 */
export const AUTOSCALE_MAX_REPLICAS = 8;

/** 冷却窗口默认 300s（大于模型冷启动的常见耗时，小于运维的耐心）。 */
export const AUTOSCALE_DEFAULT_COOLDOWN = 300;

/** 冷却窗口上限 3600s（k8s 的 stabilizationWindowSeconds 最大就是 3600）。 */
export const AUTOSCALE_MAX_COOLDOWN = 3600;

/** 一次最多声明多少个指标（超过这个数说明策略没想清楚）。 */
export const AUTOSCALE_MAX_METRICS = 8;

/** 预算请求的防抖窗口（毫秒）：键盘连打时只发最后一次。 */
export const AUTOSCALE_DEBOUNCE_MS = 300;

// ─── 草稿与响应类型 ──────────────────────────────────────────────────────

/** HPA 指标类型白名单（k8s 只支持这两类走 Resource 分支）。 */
export type AutoscaleMetricType = 'Resource' | 'Pods';

/** 一个指标草稿（`target` 是利用率百分比字符串，输入中间态）。 */
export interface AutoscaleMetricDraft {
  /** 稳定的行 key（增删行时不能用 index，否则输入框会串味）。 */
  id: string;
  type: AutoscaleMetricType;
  /** 'cpu' | 'memory' | 'pods' | 自定义指标名 */
  name: string;
  /** 目标利用率（百分比数字的字符串形态）。 */
  target: string;
}

/** 弹性策略草稿（字符串，和 ServiceDraft 的约定一致）。 */
export interface AutoscaleDraft {
  minReplicas: string;
  maxReplicas: string;
  cooldownSeconds: string;
  metrics: AutoscaleMetricDraft[];
}

/** 单卡容量（服务端读集群得到；读不到时字段为 null）。 */
export interface AutoscaleCapacity {
  perCardMemMiB: number | null;
  perCardCores: number | null;
}

/** 归一化后的预算（`limit` 是本地取小后的结论）。 */
export interface AutoscaleBudget {
  maxReplicasByMemory: number | null;
  maxReplicasByCores: number | null;
  /** 服务端结论（按「服务当前副本数」算，仅供参考）。 */
  allowed: boolean;
  reason: string;
  /** 单卡最多能放几个副本（两项取小；都为 null 时 null）。 */
  limit: number | null;
  capacity: AutoscaleCapacity | null;
}

/** 交给上层的完整状态。 */
export interface AutoscaleFieldState {
  draft: AutoscaleDraft;
  /** 预算还没读到时为 null。 */
  budget: AutoscaleBudget | null;
  /** 单卡最多副本（预算未就绪时为 null）。 */
  limit: number | null;
  /** 用户填的 maxReplicas 是否超预算（读不到容量时按「未验证」处理，不算超）。 */
  overBudget: boolean;
  /** 预算读取失败的消息（有值表示这次判断没有依据）。 */
  budgetError: string | null;
}

export interface AutoscaleFieldsProps {
  /**
   * 集群 id（进路径，会被 encodeURIComponent）。
   * 服务端那条路由用 `mountClusterParams` 把 `/clusters/:clusterId` 挂到 `/api/infra`，
   * 所以这里拼的是 `/api/infra/clusters/<id>/autoscale-budget`。
   */
  clusterId?: string;
  /** 每副本显存配额（MiB；0 = 整卡，每个副本独占一张卡）。 */
  memoryMiB?: number;
  /** 每副本算力配额（百分比点；0 = 不限）。 */
  coresPercent?: number;
  /** 当前副本数 —— 作为 maxReplicas 的初值（新建服务时通常等于 1）。 */
  replicas?: number;
  /**
   * 初始草稿（编辑已有服务时由上层把已保存的策略传进来）。
   *
   * 只在**首次挂载**时读取：切换服务时请给本组件一个随服务变化的 `key`
   * （例如 `${service.id}:${service.version}`），否则草稿会串味 ——
   * 在 A 服务里改了 maxReplicas，点回 B 服务看到的还是 A 的数字。
   */
  initial?: Partial<AutoscaleDraft> | null;
  /** 草稿 / 预算变化（上层据此禁用保存）。 */
  onChange?: (state: AutoscaleFieldState) => void;
  /** 演示模式：不发请求，也不显示任何预算结论。 */
  demo?: boolean;
  /** 只读（比如上游没开 OPENLOG_K8S_INFRA）。 */
  disabled?: boolean;
  /** 预算请求的防抖窗口（毫秒）；测试可传 0。 */
  debounceMs?: number;
}

// ─── 纯函数 ──────────────────────────────────────────────────────────────

/** 字符串 → 整数；空 / 非法返回 fallback（绝不让 NaN 流进 payload）。 */
function intOr(text: string, fallback: number): number {
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * 按需延迟执行：`delay <= 0` 时**同步**跑（测试与嵌入场景要的是确定性，
 * 而 effect 里挂 0ms 定时器会让「挂载即请求」多等一个宏任务）。
 * 返回值是取消函数。
 */
function runAfter(delay: number, task: () => void): () => void {
  if (delay <= 0) {
    task();
    return () => {};
  }
  const timer = setTimeout(task, delay);
  return () => clearTimeout(timer);
}

/** 夹到区间内。 */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 只认有限数字（字符串数字也吃），其余 null —— null 在界面上变成「—」。 */
function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 两个可空上限取小（都为 null → null；任一为 0 → 0 = 一个都放不下）。 */
export function budgetLimit(memory: number | null, cores: number | null): number | null {
  if (memory === null && cores === null) return null;
  if (memory === null) return cores;
  if (cores === null) return memory;
  return Math.min(memory, cores);
}

/** 新建草稿：min 1、max = 当前副本数、冷却 300s、一条 CPU 70% 指标。 */
export function emptyAutoscale(replicas = 1): AutoscaleDraft {
  const max = clampInt(Number.isFinite(replicas) ? Math.trunc(replicas) : 1, 1, AUTOSCALE_MAX_REPLICAS);
  return {
    minReplicas: '1',
    maxReplicas: String(max),
    cooldownSeconds: String(AUTOSCALE_DEFAULT_COOLDOWN),
    metrics: [{ id: 'metric-1', type: 'Resource', name: 'cpu', target: '70' }],
  };
}

/** 归一化外部传进来的初始值（缺字段用默认，绝不让 undefined 进受控输入）。 */
function draftFrom(initial: Partial<AutoscaleDraft> | null | undefined, replicas: number): AutoscaleDraft {
  const base = emptyAutoscale(replicas);
  if (!initial) return base;
  const metrics = Array.isArray(initial.metrics) && initial.metrics.length > 0
    ? initial.metrics.slice(0, AUTOSCALE_MAX_METRICS).map((metric, index) => ({
        id: metric.id || `metric-${index + 1}`,
        type: metric.type === 'Pods' ? 'Pods' as const : 'Resource' as const,
        name: typeof metric.name === 'string' ? metric.name : 'cpu',
        target: typeof metric.target === 'string' ? metric.target : String(metric.target ?? 70),
      }))
    : base.metrics;
  return {
    minReplicas: typeof initial.minReplicas === 'string' ? initial.minReplicas : base.minReplicas,
    maxReplicas: typeof initial.maxReplicas === 'string' ? initial.maxReplicas : base.maxReplicas,
    cooldownSeconds:
      typeof initial.cooldownSeconds === 'string' ? initial.cooldownSeconds : base.cooldownSeconds,
    metrics,
  };
}

/** 预算响应归一：形状对不上时给 `allowed:true + 说明`，而不是假装「通过」。 */
export function normalizeBudget(raw: unknown): AutoscaleBudget | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const budget = record.budget && typeof record.budget === 'object'
    ? (record.budget as Record<string, unknown>)
    : record;
  const capacityRaw = record.capacity && typeof record.capacity === 'object'
    ? (record.capacity as Record<string, unknown>)
    : null;

  const maxReplicasByMemory = numOrNull(budget.maxReplicasByMemory ?? budget.maxReplicasByMem);
  const maxReplicasByCores = numOrNull(budget.maxReplicasByCores);
  const reason = typeof budget.reason === 'string' ? budget.reason.trim() : '';

  const capacity: AutoscaleCapacity | null = capacityRaw
    ? {
        perCardMemMiB: numOrNull(capacityRaw.perCardMemMiB ?? capacityRaw.memoryMiB),
        perCardCores: numOrNull(capacityRaw.perCardCores ?? capacityRaw.cores ?? capacityRaw.coresPercent),
      }
    : null;

  return {
    maxReplicasByMemory,
    // 服务端没给容量时不会算 cores 上限，这里如实保留 null
    maxReplicasByCores,
    // 只有明确 true 才算通过（缺字段一律按「未验证」，见文件头第 2 条）
    allowed: budget.allowed === true,
    reason,
    limit: budgetLimit(maxReplicasByMemory, maxReplicasByCores),
    capacity,
  };
}

/** 预算查询路径（clusterId 可能含 `/`，必须编码）。 */
export function autoscaleBudgetPath(
  clusterId: string,
  memoryMiB: number,
  coresPercent: number,
): string {
  const params = new URLSearchParams({
    memoryMiB: String(Math.max(0, Math.trunc(memoryMiB))),
    coresPercent: String(Math.max(0, Math.trunc(coresPercent))),
  });
  return `/api/infra/clusters/${encodeURIComponent(clusterId)}/autoscale-budget?${params.toString()}`;
}

// ─── 样式 ────────────────────────────────────────────────────────────────

/** 输入框基础样式（与 ServiceForm 同一套视觉语言）。 */
const INPUT_CLASS =
  'w-full rounded-lg border border-dark-700/70 bg-dark-900/60 px-2.5 py-1.5 text-sm text-dark-100 ' +
  'placeholder:text-dark-600 focus:border-accent-500/60 focus:outline-none transition-colors';

const INPUT_ERROR_CLASS = 'border-red-500/60 focus:border-red-500/80';

const SELECT_CLASS =
  'rounded-lg border border-dark-700/70 bg-dark-900/60 px-1.5 py-1 text-[11px] text-dark-100 focus:border-accent-500/60 focus:outline-none';

/** 指标名建议值（下拉可选，也可手输自定义指标）。 */
const METRIC_NAME_SUGGESTIONS = ['cpu', 'memory', 'pods'];

// ─── 组件 ────────────────────────────────────────────────────────────────

/**
 * HPA 表单段。
 *
 * 受控性：内部持有草稿（父层不需要为了 min/max 再维护一份 state），
 * 每次草稿变化都通过 `onChange` 回吐「草稿 + 预算 + 是否超限」。
 */
export default function AutoscaleFields({
  clusterId = '',
  memoryMiB = 0,
  coresPercent = 0,
  replicas = 1,
  initial = null,
  onChange,
  demo = false,
  disabled = false,
  debounceMs = AUTOSCALE_DEBOUNCE_MS,
}: AutoscaleFieldsProps) {
  const [draft, setDraft] = useState<AutoscaleDraft>(() => draftFrom(initial, replicas));
  const [budget, setBudget] = useState<AutoscaleBudget | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [budgetStatus, setBudgetStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  /** 行 id 计数器：增删行时用，不用 index（避免输入框串味）。 */
  const nextId = useRef(2);
  /** onChange 放 ref：父层每次 render 都可能传一个新的内联箭头函数。 */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const minInt = intOr(draft.minReplicas, NaN);
  const maxInt = intOr(draft.maxReplicas, NaN);
  const cooldownInt = intOr(draft.cooldownSeconds, NaN);

  const minError =
    Number.isNaN(minInt) || minInt < 1
      ? `minReplicas 必须是 1–${AUTOSCALE_MAX_REPLICAS} 的整数`
      : minInt > AUTOSCALE_MAX_REPLICAS
        ? `minReplicas 不能超过 ${AUTOSCALE_MAX_REPLICAS}（护栏与 HPA 的上限一致）`
        : !Number.isNaN(maxInt) && minInt > maxInt
          ? 'minReplicas 不能大于 maxReplicas'
          : undefined;

  const maxError =
    Number.isNaN(maxInt) || maxInt < 1 || maxInt > AUTOSCALE_MAX_REPLICAS
      ? `maxReplicas 必须是 1–${AUTOSCALE_MAX_REPLICAS} 的整数`
      : undefined;

  const cooldownError =
    Number.isNaN(cooldownInt) || cooldownInt < 0 || cooldownInt > AUTOSCALE_MAX_COOLDOWN
      ? `冷却窗口必须是 0–${AUTOSCALE_MAX_COOLDOWN} 秒（k8s 的 stabilizationWindowSeconds 上限）`
      : undefined;

  // ── 预算查询：草稿里的配额变了才重新算（防抖，避免键盘连打） ──────────
  useEffect(() => {
    if (demo || disabled || !clusterId) {
      setBudget(null);
      setBudgetError(null);
      setBudgetStatus('idle');
      return;
    }

    let alive = true;
    const controller = new AbortController();
    setBudgetStatus('loading');

    const cancel = runAfter(debounceMs, () => {
      apiFetch<unknown>(autoscaleBudgetPath(clusterId, memoryMiB, coresPercent), {
        signal: controller.signal,
      })
        .then((raw) => {
          if (!alive) return;
          const normalized = normalizeBudget(raw);
          setBudget(normalized);
          setBudgetError(normalized ? null : '预算响应缺少 budget 字段，无法判断单卡容量');
          setBudgetStatus(normalized ? 'ready' : 'error');
        })
        .catch((err: unknown) => {
          if (!alive || controller.signal.aborted) return;
          setBudget(null);
          setBudgetError(errorText(err));
          setBudgetStatus('error');
        });
    });

    return () => {
      alive = false;
      cancel();
      controller.abort();
    };
  }, [clusterId, memoryMiB, coresPercent, demo, disabled, debounceMs]);

  /** 单卡最多副本（预算未就绪 → null）。 */
  const limit = budget ? budget.limit : null;

  /**
   * 是否超预算。
   * `limit === 0` 也算超（连一个副本都放不下）；`limit === null` 是「没数据」，
   * 不判超 —— 但它同样不会显示绿色的「通过」。
   */
  const overBudget = useMemo(() => {
    if (!budget) return false;
    if (!Number.isFinite(maxInt)) return false;
    if (limit !== null && maxInt > limit) return true;
    return budget.allowed === false;
  }, [budget, limit, maxInt]);

  // ── 回吐状态给上层 ─────────────────────────────────────────────────────
  useEffect(() => {
    onChangeRef.current?.({ draft, budget, limit, overBudget, budgetError });
  }, [draft, budget, limit, overBudget, budgetError]);

  // ── 编辑动作 ───────────────────────────────────────────────────────────
  const patch = (next: Partial<AutoscaleDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  };

  const patchMetric = (id: string, next: Partial<AutoscaleMetricDraft>) => {
    setDraft((prev) => ({
      ...prev,
      metrics: prev.metrics.map((metric) => (metric.id === id ? { ...metric, ...next } : metric)),
    }));
  };

  const addMetric = () => {
    setDraft((prev) => {
      if (prev.metrics.length >= AUTOSCALE_MAX_METRICS) return prev;
      const id = `metric-${nextId.current}`;
      nextId.current += 1;
      return { ...prev, metrics: [...prev.metrics, { id, type: 'Resource', name: 'cpu', target: '70' }] };
    });
  };

  const removeMetric = (id: string) => {
    setDraft((prev) => {
      // 至少留一条：HPA 没有指标就没有扩缩依据，只会在日志里报错
      if (prev.metrics.length <= 1) return prev;
      return { ...prev, metrics: prev.metrics.filter((metric) => metric.id !== id) };
    });
  };

  const overLimitText =
    limit !== null && Number.isFinite(maxInt) && maxInt > limit
      ? `maxReplicas=${maxInt} 超出单卡预算（单卡最多 ${limit} 个副本）`
      : '当前 maxReplicas 超出单卡预算';

  return (
    <div
      data-testid="autoscale-fields"
      data-over-budget={overBudget ? 'true' : 'false'}
      data-budget-status={budgetStatus}
      className="rounded-lg border border-dark-700/50 bg-dark-900/40 px-3 py-2.5"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SlidersHorizontal className="h-3.5 w-3.5 text-accent-400" />
        <h4 className="text-xs font-semibold text-dark-100">自动伸缩（HPA）</h4>
        <span className="text-[11px] text-dark-500">
          扩缩决策权在 k8s 的 HPA 手里；这里只负责把注定失败的配置挡住
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div data-field="minReplicas">
          <label htmlFor="autoscale-min" className="mb-1 block text-xs text-dark-400">
            最小副本（minReplicas）
          </label>
          <input
            id="autoscale-min"
            data-testid="autoscale-min"
            className={`${INPUT_CLASS} ${minError ? INPUT_ERROR_CLASS : ''}`}
            type="number"
            step={1}
            inputMode="numeric"
            min={1}
            max={AUTOSCALE_MAX_REPLICAS}
            value={draft.minReplicas}
            disabled={disabled}
            onChange={(event) => patch({ minReplicas: event.target.value })}
          />
          {minError && (
            <p data-testid="autoscale-min-error" className="mt-1 text-[11px] leading-relaxed text-red-300">
              {minError}
            </p>
          )}
        </div>

        <div data-field="maxReplicas">
          <label htmlFor="autoscale-max" className="mb-1 block text-xs text-dark-400">
            最大副本（maxReplicas）
          </label>
          <input
            id="autoscale-max"
            data-testid="autoscale-max"
            className={`${INPUT_CLASS} ${maxError || overBudget ? INPUT_ERROR_CLASS : ''}`}
            type="number"
            step={1}
            inputMode="numeric"
            min={1}
            max={AUTOSCALE_MAX_REPLICAS}
            value={draft.maxReplicas}
            disabled={disabled}
            onChange={(event) => patch({ maxReplicas: event.target.value })}
          />
          {maxError && (
            <p data-testid="autoscale-max-error" className="mt-1 text-[11px] leading-relaxed text-red-300">
              {maxError}
            </p>
          )}
        </div>

        <div data-field="cooldownSeconds">
          <label htmlFor="autoscale-cooldown" className="mb-1 block text-xs text-dark-400">
            冷却窗口（秒）
          </label>
          <input
            id="autoscale-cooldown"
            data-testid="autoscale-cooldown"
            className={`${INPUT_CLASS} ${cooldownError ? INPUT_ERROR_CLASS : ''}`}
            type="number"
            step={10}
            inputMode="numeric"
            min={0}
            max={AUTOSCALE_MAX_COOLDOWN}
            value={draft.cooldownSeconds}
            disabled={disabled}
            onChange={(event) => patch({ cooldownSeconds: event.target.value })}
          />
          {cooldownError ? (
            <p data-testid="autoscale-cooldown-error" className="mt-1 text-[11px] leading-relaxed text-red-300">
              {cooldownError}
            </p>
          ) : (
            <p className="mt-1 text-[11px] leading-relaxed text-dark-600">
              窗口内不动副本；缩容一次最多减 1 个（扩容不限步长）
            </p>
          )}
        </div>
      </div>

      {/* ── 指标列表 ───────────────────────────────────────────────── */}
      <div className="mt-3">
        <div className="mb-1 flex items-center gap-2">
          <Cpu className="h-3 w-3 text-dark-500" />
          <span className="text-xs text-dark-400">扩缩指标（{draft.metrics.length}/{AUTOSCALE_MAX_METRICS}）</span>
          <button
            type="button"
            data-testid="autoscale-metric-add"
            onClick={addMetric}
            disabled={disabled || draft.metrics.length >= AUTOSCALE_MAX_METRICS}
            className="ml-auto flex items-center gap-1 rounded-md bg-dark-800/60 px-2 py-0.5 text-[11px] text-dark-300 transition-colors hover:bg-dark-700/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            添加指标
          </button>
        </div>

        <div className="space-y-1.5">
          {draft.metrics.map((metric) => (
            <div
              key={metric.id}
              data-testid="autoscale-metric-row"
              data-type={metric.type}
              data-name={metric.name}
              className="flex flex-wrap items-center gap-1.5"
            >
              <select
                data-testid="autoscale-metric-type"
                aria-label="指标类型"
                className={SELECT_CLASS}
                value={metric.type}
                disabled={disabled}
                onChange={(event) =>
                  patchMetric(metric.id, {
                    type: event.target.value === 'Pods' ? 'Pods' : 'Resource',
                    name:
                      event.target.value === 'Pods'
                        ? 'pods'
                        : metric.name === 'pods'
                          ? 'cpu'
                          : metric.name,
                  })
                }
              >
                <option value="Resource">Resource</option>
                <option value="Pods">Pods</option>
              </select>

              <input
                data-testid="autoscale-metric-name"
                aria-label="指标名"
                className={`${SELECT_CLASS} w-28 font-mono`}
                list="autoscale-metric-names"
                value={metric.name}
                disabled={disabled}
                onChange={(event) => patchMetric(metric.id, { name: event.target.value })}
                placeholder="cpu / memory / pods"
                spellCheck={false}
              />
              <datalist id="autoscale-metric-names">
                {METRIC_NAME_SUGGESTIONS.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>

              <div className="flex items-center gap-1">
                <input
                  data-testid="autoscale-metric-target"
                  aria-label="目标利用率（%）"
                  className={`${SELECT_CLASS} w-16 text-right font-mono`}
                  type="number"
                  step={1}
                  min={1}
                  max={100}
                  value={metric.target}
                  disabled={disabled}
                  onChange={(event) => patchMetric(metric.id, { target: event.target.value })}
                />
                <span className="text-[11px] text-dark-500">
                  {metric.type === 'Pods' ? '个' : '%'}
                </span>
              </div>

              <button
                type="button"
                data-testid="autoscale-metric-remove"
                onClick={() => removeMetric(metric.id)}
                disabled={disabled || draft.metrics.length <= 1}
                title="至少保留一条指标"
                className="ml-auto rounded-md bg-dark-800/60 p-1 text-dark-400 transition-colors hover:bg-red-500/20 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── 实时预算 ───────────────────────────────────────────────── */}
      <div className="mt-3">
        {demo ? (
          <p data-testid="autoscale-budget-idle" className="text-[11px] text-dark-500">
            演示模式：不查询单卡预算
          </p>
        ) : budgetStatus === 'loading' && !budget ? (
          <p data-testid="autoscale-budget-loading" className="flex items-center gap-1.5 text-[11px] text-dark-400">
            <Loader className="h-3 w-3 animate-spin text-accent-400" />
            正在读取单卡容量…
          </p>
        ) : budgetStatus === 'idle' && !budget ? (
          <p data-testid="autoscale-budget-idle" className="text-[11px] leading-relaxed text-dark-500">
            {clusterId
              ? '还没有预算结论：填完配额后会立刻计算单卡能放几个副本'
              : '未选择集群：读不到单卡容量，maxReplicas 只能靠人工核对（超出的副本会一直 Pending）'}
          </p>
        ) : budgetError ? (
          <p
            data-testid="autoscale-budget-error"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200 break-words"
          >
            预算读取失败：{budgetError}
            <span className="block text-amber-200/70">
              没有预算依据时不要凭感觉填 maxReplicas —— 超出的副本会一直 Pending。
            </span>
          </p>
        ) : budget ? (
          <div data-testid="autoscale-budget" data-allowed={overBudget ? 'false' : 'true'}>
            {limit !== null ? (
              <p data-testid="autoscale-budget-limit" className="text-[11px] text-dark-300">
                单卡最多 <span className="font-mono text-dark-100">{limit}</span> 副本
                <span className="text-dark-500">
                  （显存侧 {budget.maxReplicasByMemory ?? '—'} · 算力侧{' '}
                  {budget.maxReplicasByCores ?? '—'}
                  {budget.capacity?.perCardMemMiB
                    ? ` · 单卡 ${budget.capacity.perCardMemMiB} MiB`
                    : ''}
                  ）
                </span>
              </p>
            ) : (
              <p data-testid="autoscale-budget-unknown" className="text-[11px] text-dark-400">
                单卡容量未知（未读到节点加速卡信息）：maxReplicas 是否放得下尚未验证
              </p>
            )}

            {overBudget ? (
              <div
                data-testid="autoscale-budget-warning"
                className="mt-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-2"
              >
                <p className="flex items-start gap-1.5 text-[11px] font-medium leading-relaxed text-red-300">
                  <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  <span>
                    {overLimitText}：超出预算的副本会长期停在 Pending（HAMi 报
                    CardInsufficientMemory），而 HPA 会一直重试 Pending、不会自动止损 ——
                    它只会按 CPU/内存指标反复要求更多副本，把节点排到没有空位。
                  </span>
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-red-200/80">
                  后果：扩不出容量但也不会回退，负载跑在更少的副本上；同时 Pending 的 Pod
                  会占住调度队列，让别的服务也排不进去。
                  {limit !== null
                    ? ` 请把 maxReplicas 下调到 ${Math.max(limit, 1)} 以内，或减小每副本显存 / 算力配额，或换更大显存的卡。`
                    : ''}
                </p>
              </div>
            ) : limit === null ? null : (
              <p
                data-testid="autoscale-budget-ok"
                className="mt-1 flex items-center gap-1 text-[11px] text-emerald-300"
              >
                maxReplicas={Number.isFinite(maxInt) ? maxInt : '—'} 在单卡预算内（单卡最多 {limit} 副本）
              </p>
            )}

            {budget.reason && (
              <p data-testid="autoscale-budget-reason" className="mt-1 text-[11px] leading-relaxed text-dark-600">
                {budget.reason}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
