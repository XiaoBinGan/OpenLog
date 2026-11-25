/* eslint-disable react-refresh/only-export-components --
   单位换算（formatMiB）/ 策略配色 / 跨节点判定必须导出：「每节点各占 X GiB」
   算错就是误报或漏报 DiskPressure，需要按表驱动测试。 */
/**
 * 模型缓存与磁盘估算卡片（`POST /api/infra/cache-estimate`）。
 *
 * 这张卡片的来历是一条真机事故：node1 的 200GB 数据盘在几分钟内被打满，
 * 节点被 kubelet 打上 `node.kubernetes.io/disk-pressure:NoSchedule` taint 并开始
 * Evicted Pod，此后**任何**新 Pod 都调不上去，所有人先去查显存和调度器，方向全错。
 * 根因很简单：strata 的 Q2_0 权重 67GB，部署方式是 3 副本各拷一份 = 201GB。
 *
 * 于是这里守一条硬规则，并且必须在**上线前**让人看见：
 *
 *   **同一节点上的多个副本必须挂同一个只读目录；跨节点时只有 RWX PVC 才真共享。**
 *
 * 因此本卡片的红/黄/绿三档含义是固定的：
 *   · 绿 —— `plan.shared === true`：跨节点只有一份（RWX），或单节点内共享；
 *   · 红 —— `plan.shared === false` 且跨节点（nodeCount > 1）：**每节点各占一份**，
 *     磁盘随节点数线性翻倍，这正是 DiskPressure 的配方。红条里会说清后果；
 *   · 黄 —— `plan.warnings[]`：退化形态（RWO PVC、hostPath 多节点）、需要预热、
 *     未配置共享目录等，逐条原样展示（后端文案已经是可操作的中文）。
 *
 * 另外两个口径：
 *   · **估算与规划是两件事**：`estimate` 回答「要占多少盘」，`plan` 回答「怎么挂」。
 *     策略是 `none` 时 estimate 仍然有意义（那就是「每 Pod 各一份」的账）。
 *   · **数字不换错单位**：后端全部是 MiB，超过 1024 才显示 GiB，且保留一位小数；
 *     `savedMiB === 0` 时显示「0 MiB 省下」，而不是把它藏起来 —— 「没省」本身是结论。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { HardDrive, Loader, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { apiJson } from '../../api/client';
import { errorText } from './types';

// ─── 类型（与 server/infra/model-cache.js 的返回形状对齐，宽进） ──────────

/** 缓存策略：`none` = 每个 Pod 各自准备权重（最危险）。 */
export type CacheStrategy = 'hostPath' | 'pvc-rwx' | 'pvc-rwo' | 'none';

/** 磁盘估算。 */
export interface CacheEstimate {
  /** 每份权重占多少 MiB。 */
  perPodMiB: number | null;
  /** 共享之后实际占盘（每节点一份 × 节点数）。 */
  totalMiB: number | null;
  /** 相比「每 Pod 各拷一份」省下的 MiB。 */
  savedMiB: number | null;
  /** 估算依据（人话，直接展示）。 */
  assumption: string | null;
  replicas: number | null;
  nodeCount: number | null;
}

/** 挂载规划。 */
export interface CachePlanInfo {
  strategy: CacheStrategy;
  /** 是否真共享（false 且跨节点 = 红色警告）。 */
  shared: boolean;
  warnings: string[];
  volumes: number;
  volumeMounts: number;
}

/** 一次估算的完整结果。 */
export interface CacheEstimateResult {
  estimate: CacheEstimate;
  plan: CachePlanInfo;
}

export interface CachePlanProps {
  /**
   * 模型路径（hostPath 绝对路径 / PVC 子路径 / 仓库 id）。
   * 表单里改了路径会同步进来；用户在本卡片内的改动不回写表单（保持单向，避免打架）。
   */
  modelPath?: string;
  /** 权重体积（MiB）；留空则后端按量化 + 参数量推断。 */
  sizeMiB?: number;
  /** 量化标记（sizeMiB 为空时用得上，例如 Q2_0 / awq / fp16）。 */
  quantization?: string;
  /** 副本数（默认 1）。 */
  replicas?: number;
  /** 节点数（默认 1；> 1 才可能跨节点）。 */
  nodeCount?: number;
  /** 演示模式：不发请求。 */
  demo?: boolean;
  /** 请求防抖（毫秒）；测试可传 0。 */
  debounceMs?: number;
  /** 估算结果变化（上层可用来提示「磁盘够不够」）。 */
  onChange?: (result: CacheEstimateResult | null) => void;
}

// ─── 纯函数 ──────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function intOr(text: string, fallback: number): number {
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * 按需延迟执行：`delay <= 0` 时同步跑（挂载即估算，测试也确定）。
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

/** MiB → 人类可读（≥1024 换 GiB，保留一位小数；无效值 → —）。 */
export function formatMiB(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GiB`;
  return `${Math.round(value)} MiB`;
}

/** 策略 → 中文（枚举外的值原样显示，不吞）。 */
export function strategyLabel(strategy: string): string {
  if (strategy === 'hostPath') return 'hostPath（节点本地目录）';
  if (strategy === 'pvc-rwx') return 'pvc-rwx（ReadWriteMany，跨节点真共享）';
  if (strategy === 'pvc-rwo') return 'pvc-rwo（ReadWriteOnce，降级：跨节点各一份）';
  if (strategy === 'none') return 'none（不做共享挂载）';
  return strategy || '—';
}

/** 策略 → 标签配色：真共享绿、降级黄、不共享红。 */
export function strategyClass(strategy: string, shared: boolean): string {
  if (strategy === 'none') return 'border-red-500/50 bg-red-500/15 text-red-300';
  if (shared) return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';
  return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
}

/** 结果归一：形状对不上时返回 null（由调用方显示「无法估算」，不编一个数出来）。 */
export function normalizeCacheEstimate(raw: unknown): CacheEstimateResult | null {
  const record = asRecord(raw);
  if (!record) return null;
  const estimateRaw = asRecord(record.estimate);
  const planRaw = asRecord(record.plan);
  if (!estimateRaw && !planRaw) return null;

  const strategyRaw = planRaw && typeof planRaw.strategy === 'string' ? planRaw.strategy : 'none';
  const strategy: CacheStrategy =
    strategyRaw === 'hostPath' || strategyRaw === 'pvc-rwx' || strategyRaw === 'pvc-rwo' || strategyRaw === 'none'
      ? strategyRaw
      : 'none';

  const warnings = planRaw && Array.isArray(planRaw.warnings)
    ? planRaw.warnings
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item !== '')
    : [];

  return {
    estimate: {
      perPodMiB: numOrNull(estimateRaw?.perPodMiB),
      totalMiB: numOrNull(estimateRaw?.totalMiB),
      savedMiB: numOrNull(estimateRaw?.savedMiB),
      assumption:
        estimateRaw && typeof estimateRaw.assumption === 'string' && estimateRaw.assumption.trim()
          ? estimateRaw.assumption.trim()
          : null,
      replicas: numOrNull(estimateRaw?.replicas),
      nodeCount: numOrNull(estimateRaw?.nodeCount),
    },
    plan: {
      strategy,
      // 只有明确 true 才算共享：`shared` 缺失时按「没共享」处理（更危险的那一侧）
      shared: planRaw?.shared === true,
      warnings,
      volumes: planRaw && Array.isArray(planRaw.volumes) ? planRaw.volumes.length : 0,
      volumeMounts: planRaw && Array.isArray(planRaw.volumeMounts) ? planRaw.volumeMounts.length : 0,
    },
  };
}

/** 跨节点未共享（红色警告的触发条件）：没共享 + 节点数 > 1。 */
export function isCrossNodeUnshared(plan: CachePlanInfo | null, nodeCount: number): boolean {
  if (!plan) return false;
  if (plan.shared) return false;
  return nodeCount > 1;
}

/** 请求体（只带后端认识的字段，不塞 undefined）。 */
export function cacheEstimateBody(options: {
  modelPath: string;
  sizeMiB: number | null;
  quantization: string;
  replicas: number;
  nodeCount: number;
}): Record<string, unknown> {
  const model: Record<string, unknown> = { path: options.modelPath.trim() };
  if (options.sizeMiB !== null && options.sizeMiB > 0) model.sizeMiB = Math.round(options.sizeMiB);
  if (options.quantization.trim()) model.quantization = options.quantization.trim();
  return {
    model,
    replicas: Math.max(1, Math.min(8, options.replicas)),
    nodeCount: Math.max(1, Math.min(8, options.nodeCount)),
  };
}

// ─── 样式 ────────────────────────────────────────────────────────────────

const INPUT_CLASS =
  'w-full rounded-lg border border-dark-700/70 bg-dark-900/60 px-2.5 py-1.5 text-sm text-dark-100 ' +
  'placeholder:text-dark-600 focus:border-accent-500/60 focus:outline-none transition-colors';

// ─── 组件 ────────────────────────────────────────────────────────────────

/**
 * 缓存与磁盘估算。
 *
 * 输入变化即重算（默认 300ms 防抖）：这个数字要跟着输入框实时走，
 * 否则用户填完 67GB / 3 副本之后还得再点一次才知道盘会不会爆。
 */
export default function CachePlan({
  modelPath = '',
  sizeMiB,
  quantization = '',
  replicas = 1,
  nodeCount = 1,
  demo = false,
  debounceMs = 300,
  onChange,
}: CachePlanProps) {
  const [path, setPath] = useState(modelPath);
  const [sizeText, setSizeText] = useState(
    typeof sizeMiB === 'number' && Number.isFinite(sizeMiB) ? String(sizeMiB) : '',
  );
  const [replicasText, setReplicasText] = useState(String(replicas || 1));
  const [nodesText, setNodesText] = useState(String(nodeCount || 1));

  const [result, setResult] = useState<CacheEstimateResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  /** 手动重算计数（同样的输入也要能再算一次）。 */
  const [reloadTick, setReloadTick] = useState(0);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 上层换了服务（或从表单带过来新的路径）时同步本地输入框
  useEffect(() => {
    setPath(modelPath);
  }, [modelPath]);
  useEffect(() => {
    setSizeText(typeof sizeMiB === 'number' && Number.isFinite(sizeMiB) ? String(sizeMiB) : '');
  }, [sizeMiB]);

  const replicasInt = intOr(replicasText, 1);
  const nodesInt = intOr(nodesText, 1);
  const sizeInt = sizeText.trim() ? intOr(sizeText, 0) : null;

  useEffect(() => {
    onChangeRef.current?.(result);
  }, [result]);

  useEffect(() => {
    if (demo) {
      setResult(null);
      setStatus('idle');
      setError(null);
      return;
    }
    if (!path.trim()) {
      // 没有模型路径就没有估算对象：停在 idle，不要发一个注定被拒的请求
      setResult(null);
      setStatus('idle');
      setError(null);
      return;
    }

    let alive = true;
    const controller = new AbortController();
    setStatus('loading');

    const cancel = runAfter(debounceMs, () => {
      apiJson<unknown>(
        '/api/infra/cache-estimate',
        'POST',
        cacheEstimateBody({
          modelPath: path,
          sizeMiB: sizeInt && sizeInt > 0 ? sizeInt : null,
          quantization,
          replicas: replicasInt,
          nodeCount: nodesInt,
        }),
        { signal: controller.signal },
      )
        .then((raw) => {
          if (!alive) return;
          const normalized = normalizeCacheEstimate(raw);
          setResult(normalized);
          if (normalized) {
            setError(null);
            setStatus('ready');
          } else {
            setError('估算响应缺少 estimate / plan 字段');
            setStatus('error');
          }
        })
        .catch((err: unknown) => {
          if (!alive || controller.signal.aborted) return;
          setResult(null);
          setError(errorText(err));
          setStatus('error');
        });
    });

    return () => {
      alive = false;
      cancel();
      controller.abort();
    };
  }, [demo, path, sizeInt, quantization, replicasInt, nodesInt, debounceMs, reloadTick]);

  const crossNodeUnshared = useMemo(
    () => isCrossNodeUnshared(result?.plan ?? null, nodesInt),
    [result, nodesInt],
  );

  const perPodText = formatMiB(result?.estimate.perPodMiB);
  const totalText = formatMiB(result?.estimate.totalMiB);
  const savedText = formatMiB(result?.estimate.savedMiB);

  return (
    <section className="glass rounded-xl p-4" data-testid="cache-plan" data-status={status}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <HardDrive className="h-4 w-4 text-accent-400" />
        <h3 className="text-sm font-semibold text-dark-100">模型缓存与磁盘估算</h3>
        <span className="text-[11px] text-dark-500">
          跨节点的共享只有 RWX PVC 做得到；hostPath 每个节点各占一份
        </span>
        <button
          type="button"
          data-testid="cache-refresh"
          onClick={() => setReloadTick((tick) => tick + 1)}
          disabled={demo}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-dark-800/60 px-2.5 py-1 text-xs text-dark-300 transition-colors hover:bg-dark-700/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${status === 'loading' ? 'animate-spin' : ''}`} />
          重新估算
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="md:col-span-2">
          <label htmlFor="cache-model-path" className="mb-1 block text-xs text-dark-400">
            模型路径（model.path）
          </label>
          <input
            id="cache-model-path"
            data-testid="cache-model-path"
            className={INPUT_CLASS}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/models/Qwen2.5-72B-Instruct"
            autoComplete="off"
            spellCheck={false}
            disabled={demo}
          />
        </div>

        <div>
          <label htmlFor="cache-size" className="mb-1 block text-xs text-dark-400">
            权重体积（MiB）
          </label>
          <input
            id="cache-size"
            data-testid="cache-size"
            className={INPUT_CLASS}
            type="number"
            step={1}
            inputMode="numeric"
            min={0}
            value={sizeText}
            onChange={(event) => setSizeText(event.target.value)}
            placeholder="留空 = 按量化推断"
            disabled={demo}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="cache-replicas" className="mb-1 block text-xs text-dark-400">
              副本数
            </label>
            <input
              id="cache-replicas"
              data-testid="cache-replicas"
              className={INPUT_CLASS}
              type="number"
              step={1}
              inputMode="numeric"
              min={1}
              max={8}
              value={replicasText}
              onChange={(event) => setReplicasText(event.target.value)}
              disabled={demo}
            />
          </div>
          <div>
            <label htmlFor="cache-nodes" className="mb-1 block text-xs text-dark-400">
              节点数
            </label>
            <input
              id="cache-nodes"
              data-testid="cache-nodes"
              className={INPUT_CLASS}
              type="number"
              step={1}
              inputMode="numeric"
              min={1}
              max={8}
              value={nodesText}
              onChange={(event) => setNodesText(event.target.value)}
              disabled={demo}
            />
          </div>
        </div>
      </div>

      {/* ── 结果 ───────────────────────────────────────────────────── */}
      <div className="mt-3">
        {demo ? (
          <p data-testid="cache-demo" className="rounded-lg border border-accent-500/30 bg-accent-500/10 px-3 py-1.5 text-[11px] text-accent-200">
            演示模式：不请求估算接口
          </p>
        ) : status === 'loading' && !result ? (
          <p data-testid="cache-loading" className="flex items-center gap-1.5 text-[11px] text-dark-400">
            <Loader className="h-3 w-3 animate-spin text-accent-400" />
            正在估算磁盘…
          </p>
        ) : status === 'error' ? (
          <p
            data-testid="cache-error"
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] leading-relaxed text-red-300 break-words"
          >
            估算失败：{error}
          </p>
        ) : status === 'idle' ? (
          <p data-testid="cache-idle" className="text-[11px] text-dark-500">
            填写模型路径后自动估算（策略与占盘都要在上线前看见，DiskPressure 是整节点 Evicted 的开端）。
          </p>
        ) : result ? (
          <div data-testid="cache-result" data-strategy={result.plan.strategy}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-dark-400">策略</span>
              <span
                data-testid="cache-strategy"
                data-strategy={result.plan.strategy}
                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${strategyClass(result.plan.strategy, result.plan.shared)}`}
              >
                {strategyLabel(result.plan.strategy)}
              </span>
              <span
                data-testid="cache-shared"
                data-shared={result.plan.shared ? 'true' : 'false'}
                className={`text-[11px] ${result.plan.shared ? 'text-emerald-300' : 'text-amber-300'}`}
              >
                {result.plan.shared ? '跨节点共享' : '未共享（每节点各一份）'}
              </span>
              {result.plan.volumeMounts > 0 && (
                <span className="text-[11px] text-dark-500">
                  {result.plan.volumes} 个卷 / {result.plan.volumeMounts} 个挂载
                </span>
              )}
            </div>

            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
              <div className="rounded-lg border border-dark-700/50 bg-dark-900/40 px-2.5 py-1.5">
                <p className="text-[10px] text-dark-500">每 Pod 一份</p>
                <p data-testid="cache-per-pod" className="font-mono text-sm text-dark-100">
                  {perPodText}
                </p>
              </div>
              <div className="rounded-lg border border-dark-700/50 bg-dark-900/40 px-2.5 py-1.5">
                <p className="text-[10px] text-dark-500">共享后（{nodesInt} 节点）</p>
                <p data-testid="cache-total" className="font-mono text-sm text-dark-100">
                  {totalText}
                </p>
              </div>
              <div className="rounded-lg border border-dark-700/50 bg-dark-900/40 px-2.5 py-1.5">
                <p className="text-[10px] text-dark-500">省下的磁盘</p>
                <p
                  data-testid="cache-saved"
                  className={`font-mono text-sm ${(result.estimate.savedMiB ?? 0) > 0 ? 'text-emerald-300' : 'text-dark-300'}`}
                >
                  {savedText}
                </p>
              </div>
            </div>

            {/* 跨节点未共享：红色（这是 DiskPressure 的配方） */}
            {crossNodeUnshared && (
              <div
                data-testid="cache-cross-node-warning"
                className="mt-2 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />
                <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-red-300 break-words">
                  跨节点无法共享：每节点各占 {perPodText}（{nodesInt} 节点合计 {totalText}），
                  历史上因此出现过 DiskPressure 导致整节点 Pod 被 Evicted
                  —— 节点被打上 disk-pressure:NoSchedule 之后，连新 Pod 都调不上去。
                  <span className="mt-0.5 block text-red-200/70">
                    要真共享请换 ReadWriteMany 的 PVC（NFS / CephFS / S3-CSI），或把副本收敛到单节点并给节点留出 20% 余量。
                  </span>
                </span>
              </div>
            )}

            {/* 真共享：绿色 */}
            {result.plan.shared && (
              <p
                data-testid="cache-shared-ok"
                className="mt-2 flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] leading-relaxed text-emerald-200"
              >
                <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
                {result.plan.strategy === 'pvc-rwx'
                  ? `跨节点共享同一份只读权重：${nodesInt} 个节点合计只占 ${totalText}（比每 Pod 各拷一份省 ${savedText}）。`
                  : `单节点内多副本共享同一份只读权重：合计 ${totalText}（比每 Pod 各拷一份省 ${savedText}）。`}
              </p>
            )}

            {/* 规划器的其余告警：黄色，逐条原样展示 */}
            {result.plan.warnings.length > 0 && (
              <ul data-testid="cache-warnings" className="mt-2 space-y-1">
                {result.plan.warnings.map((warning, index) => (
                  <li
                    key={`cache-warn-${index}`}
                    data-testid="cache-warning"
                    className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] leading-relaxed text-amber-200"
                  >
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
                    <span className="min-w-0 flex-1 break-words">{warning}</span>
                  </li>
                ))}
              </ul>
            )}

            {result.estimate.assumption && (
              <p data-testid="cache-assumption" className="mt-2 text-[11px] leading-relaxed text-dark-500">
                {result.estimate.assumption}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
