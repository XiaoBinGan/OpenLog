/* eslint-disable react-refresh/only-export-components --
   门禁的三态判定（checkVerdict / checkVerdictClass）与响应归一必须导出：
   「scored:false 显示成通过」是这张卡片最危险的错误形态，要能被单独断言。 */
/**
 * 基准门禁报告卡片：跑基准 → 逐项判定 → 不通过就**禁止上线**。
 *
 * 背景：`server/infra/bench.js` 给的 `summary.recommended` 只是建议 ——
 * 建议没人执行就等于没有。门禁把建议变成闸门：一次变更必须带着基准结果来，
 * 逐项对着阈值过一遍，不达标就不许 apply，并产出一份能贴进变更单的 markdown 报告。
 *
 * 这个卡片负责三件事，每件都有「错了就出事」的默认值需要说清楚：
 *
 * 1. **跑之前必须二次确认**。基准会按并发矩阵往真实推理服务打流量
 *    （`POST /api/infra/bench` 在演示模式下直接 409），误点一次就是一次线上压测事故。
 *    所以默认弹 `window.confirm`，把「目标地址 / 并发矩阵 / 会压出真实负载」写在提示里；
 *    确认函数可通过 `confirm` prop 注入（测试与嵌入场景不用碰全局）。
 *
 * 2. **`scored === false` 显示「未验证」，不显示「通过」**。门禁在
 *    「没有基线 → 吞吐回归项不参与评分」「没读到实测显存 → 显存项跳过」这类情况下，
 *    会给 `pass: true, scored: false`。把三态压成两态（通过/不通过）会让用户以为
 *    「显存没问题」，而实际是**根本没测**。三态是这张卡片最核心的一条口径。
 *
 * 3. **failures 与 warnings 分开渲染**。failures 是「不许上线」的红条（阻塞）；
 *    warnings 是「知道了、你自己判断」的黄条（不阻塞，比如显存建议是估算值）。
 *    混在一个列表里，用户会以为黄条也阻塞，于是学会无视整块 —— 那门禁就失效了。
 *
 * 门禁结论通过 `onGateChange(gate)` 回吐给上层：`gate?.pass === true` 才允许 apply，
 * `null`（没跑过 / 正在跑 / 跑失败）一律按「不许上线」处理 —— 这是唯一安全的默认值。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader, Play, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { apiJson } from '../../api/client';
import { errorText } from './types';

// ─── 类型（与 server/infra/gate.js 的返回形状对齐，宽进） ─────────────────

/** 一条不达标项（阻塞上线）。 */
export interface GateFailure {
  metric: string;
  /** 实测值（可能是数字，也可能是 'missing' 这类文本）。 */
  actual: string;
  threshold: string;
  message: string;
}

/** 逐项判定的一行。`scored === false` = 本次没有可评项（不是通过）。 */
export interface GateCheck {
  metric: string;
  label: string;
  actual: string;
  threshold: string;
  pass: boolean;
  /** 是否真的参与了评分；false 时 UI 必须显示「未验证」。 */
  scored: boolean;
  satisfaction: number | null;
}

/** 归一化后的门禁结论（上层拿到的就是这个）。 */
export interface GateResult {
  pass: boolean;
  /** 0–100；无法评分时为 null（显示 —，不显示 0 分）。 */
  score: number | null;
  failures: GateFailure[];
  warnings: string[];
  checks: GateCheck[];
}

/** `POST /api/infra/bench` 的完整响应（`{...benchResult, gate, report}`）。 */
export interface BenchResponse {
  ok?: unknown;
  aborted?: unknown;
  reason?: unknown;
  results?: unknown;
  summary?: unknown;
  gate?: unknown;
  report?: unknown;
}

export interface GateReportProps {
  /** 目标服务（`namespace/name` 或 id）；同时进请求体与压测目标推导。 */
  serviceKey: string;
  /** 展示用名字（缺省用 serviceKey）。 */
  serviceName?: string;
  /** 集群 id（进请求体，多集群部署时必填；单集群可省）。 */
  clusterId?: string;
  /** 压测目标地址；缺省按 serviceKey 推成集群内 DNS。 */
  targetUrl?: string;
  /** 模型名（引擎按它路由）；缺省用服务名。 */
  modelName?: string;
  /** 并发矩阵；缺省 [1, 2, 4, 8]。 */
  matrix?: number[];
  /**
   * 原样塞进 bench 请求体的 `service`（门禁用它的 `resources.memoryMiB`
   * 做「推荐显存是否超过申请值」的超卖检查；不传则该检查显示「未验证」）。
   */
  service?: Record<string, unknown> | null;
  /** 演示模式：不跑基准（后端也会 409），只展示说明。 */
  demo?: boolean;
  /** 二次确认函数（默认 window.confirm）。返回 false 则不发请求。 */
  confirm?: (message: string) => boolean;
  /** 门禁结论变化（`null` = 没跑过 / 正在跑 / 跑失败 → 上层必须禁用 apply）。 */
  onGateChange?: (gate: GateResult | null) => void;
}

// ─── 归一化与格式化（纯函数） ────────────────────────────────────────────

/** 任意值 → 展示文本（null/undefined 变 —，对象变 JSON，绝不让 [object Object] 出现）。 */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.trim() || '—';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  try {
    return JSON.stringify(value);
  } catch {
    return '—';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 数字或 null（分数用；NaN/Infinity 一律 null）。 */
function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 门禁响应归一。**`pass` 只认布尔 true** —— 缺字段按不通过处理。 */
export function normalizeGate(raw: unknown): GateResult | null {
  const record = asRecord(raw);
  if (!record) return null;

  const checksRaw = Array.isArray(record.checks) ? record.checks : [];
  const checks: GateCheck[] = [];
  for (const item of checksRaw) {
    const check = asRecord(item);
    if (!check) continue;
    const metric = textOf(check.metric);
    checks.push({
      metric,
      label: textOf(check.label ?? check.metric) === '—' ? metric : textOf(check.label ?? check.metric),
      actual: textOf(check.actual),
      threshold: textOf(check.threshold),
      pass: check.pass === true,
      // 只有明确 false 才算「未验证」；缺字段按「已评分」处理以免把通过项标成未验证
      scored: check.scored !== false,
      satisfaction: numOrNull(check.satisfaction),
    });
  }

  const failuresRaw = Array.isArray(record.failures) ? record.failures : [];
  const failures: GateFailure[] = [];
  for (const item of failuresRaw) {
    if (typeof item === 'string') {
      if (item.trim()) failures.push({ metric: '', actual: '—', threshold: '—', message: item.trim() });
      continue;
    }
    const failure = asRecord(item);
    if (!failure) continue;
    const message = textOf(failure.message);
    if (message === '—' && textOf(failure.metric) === '—') continue;
    failures.push({
      metric: textOf(failure.metric),
      actual: textOf(failure.actual),
      threshold: textOf(failure.threshold),
      message: message === '—' ? `未达标：${textOf(failure.metric)}` : message,
    });
  }

  const warnings = Array.isArray(record.warnings)
    ? record.warnings
        .map((item) => (typeof item === 'string' ? item.trim() : textOf(item)))
        .filter((item) => item !== '' && item !== '—')
    : [];

  const score = numOrNull(record.score);

  return {
    // 唯一的放行条件：明确 true
    pass: record.pass === true,
    score: score === null ? null : Math.max(0, Math.min(100, Math.round(score * 100) / 100)),
    failures,
    warnings,
    checks,
  };
}

/** 判定文案：三态（通过 / 不通过 / 未验证）。 */
export function checkVerdict(check: Pick<GateCheck, 'pass' | 'scored'>): string {
  if (check.scored === false) return '未验证';
  return check.pass ? '通过' : '不通过';
}

/** 判定配色：未验证走灰（不是绿！）。 */
export function checkVerdictClass(check: Pick<GateCheck, 'pass' | 'scored'>): string {
  if (check.scored === false) return 'text-dark-400';
  return check.pass ? 'text-emerald-300' : 'text-red-300';
}

/** 缺省压测地址：集群内 Service DNS（`<name>.<ns>.svc.cluster.local:8000`）。 */
export function deriveTargetUrl(serviceKey: string): string {
  const key = serviceKey.trim();
  if (!key) return '';
  const parts = key.split('/');
  const name = (parts.length > 1 ? parts[1] : parts[0]).trim();
  const namespace = (parts.length > 1 ? parts[0] : 'inference').trim() || 'inference';
  if (!name) return '';
  return `http://${name}.${namespace}.svc.cluster.local:8000`;
}

/** 缺省模型名：服务名（引擎按模型名路由，缺了必然 404）。 */
export function deriveModelName(serviceKey: string): string {
  const parts = serviceKey.trim().split('/');
  return (parts.length > 1 ? parts[1] : parts[0]).trim();
}

/** 缺省并发矩阵（从单并发的正确性到能压出排队的档位）。 */
export const DEFAULT_BENCH_MATRIX = [1, 2, 4, 8];

/** 二次确认文案（写成一句话，能被人复述给同事）。 */
export function benchConfirmMessage(targetUrl: string, matrix: number[]): string {
  return [
    '基准会向真实推理服务打流量（不是干跑）：',
    `目标 ${targetUrl || '（未填写）'}`,
    `并发矩阵 ${matrix.join(' / ')}`,
    '压测期间该服务的响应会变慢甚至超时，请确认当前时段可以承受。',
    '继续运行基准吗？',
  ].join('\n');
}

// ─── 组件 ────────────────────────────────────────────────────────────────

type RunStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * 门禁报告卡片。
 *
 * 自己不缓存上次结果到 localStorage：门禁结论必须来自**本次**基准，
 * 跨会话沿用旧报告等于用一份过期的成绩单放行新的配置。
 */
export default function GateReport({
  serviceKey,
  serviceName,
  clusterId,
  targetUrl,
  modelName,
  matrix = DEFAULT_BENCH_MATRIX,
  service = null,
  demo = false,
  confirm,
  onGateChange,
}: GateReportProps) {
  const [status, setStatus] = useState<RunStatus>('idle');
  const [gate, setGate] = useState<GateResult | null>(null);
  const [report, setReport] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 本次基准的元信息（展示用：跑了几格 / 是否中止）。 */
  const [meta, setMeta] = useState<{ cells: number; aborted: boolean; ok: boolean; reason: string | null } | null>(
    null,
  );

  const onGateChangeRef = useRef(onGateChange);
  onGateChangeRef.current = onGateChange;

  /** 结论变化就回吐：上层据此禁用 apply。 */
  useEffect(() => {
    onGateChangeRef.current?.(gate);
  }, [gate]);

  const resolvedTarget = useMemo(
    () => (typeof targetUrl === 'string' && targetUrl.trim() ? targetUrl.trim() : deriveTargetUrl(serviceKey)),
    [targetUrl, serviceKey],
  );
  const resolvedModel = useMemo(
    () => (typeof modelName === 'string' && modelName.trim() ? modelName.trim() : deriveModelName(serviceKey)),
    [modelName, serviceKey],
  );

  const askConfirm = (message: string): boolean => {
    if (typeof confirm === 'function') return confirm(message);
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      try {
        return window.confirm(message);
      } catch {
        // 某些嵌入环境里 confirm 会抛（jsdom / iframe），此时按「不跑」处理最安全
        return false;
      }
    }
    return false;
  };

  const runBench = async () => {
    if (status === 'running') return;
    if (demo) {
      setError('演示模式不会对真实服务压测');
      return;
    }
    if (!serviceKey.trim()) {
      setError('缺少服务标识（serviceKey），无法定位压测目标');
      return;
    }
    if (!resolvedTarget) {
      setError('无法推导压测地址：请显式填写 targetUrl');
      return;
    }
    if (!askConfirm(benchConfirmMessage(resolvedTarget, matrix))) {
      setNotice('已取消：没有发出任何压测请求');
      return;
    }

    setStatus('running');
    setError(null);
    setNotice(null);
    // 开始跑的这一刻就收回放行权：旧结论不能给新配置背书
    setGate(null);

    try {
      const raw = await apiJson<BenchResponse>('/api/infra/bench', 'POST', {
        serviceKey,
        clusterId,
        target: { url: resolvedTarget, model: resolvedModel },
        matrix: { concurrency: matrix, promptTokens: 256, outputTokens: 128 },
        ...(service ? { service } : {}),
      });

      const normalized = normalizeGate(raw?.gate);
      const results = Array.isArray(raw?.results) ? raw.results : [];
      const aborted = raw?.aborted === true;
      const ok = raw?.ok !== false;
      const reason = typeof raw?.reason === 'string' && raw.reason.trim() ? raw.reason : null;

      setMeta({ cells: results.length, aborted, ok, reason });
      setReport(typeof raw?.report === 'string' ? raw.report : '');

      if (!normalized) {
        // 服务端没给 gate（模块没加载 / 旧版本）：不能假装通过
        setGate(null);
        setError('基准已返回，但响应里没有门禁结论（gate 缺失）：本次不做放行判断，请检查服务端 gate 模块');
        setStatus('error');
        return;
      }

      setGate(normalized);
      setStatus('done');
    } catch (err) {
      setGate(null);
      setError(errorText(err));
      setStatus('error');
    }
  };

  const pass = gate?.pass === true;
  const scoreText = gate?.score === null || gate?.score === undefined ? '—' : String(gate.score);

  return (
    <section
      className="glass rounded-xl p-4"
      data-testid="gate-report"
      data-status={status}
      data-pass={gate ? (pass ? 'true' : 'false') : 'unknown'}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-accent-400" />
        <h3 className="text-sm font-semibold text-dark-100">基准门禁</h3>
        {serviceKey ? (
          <code
            data-testid="gate-service"
            className="rounded bg-dark-800/60 px-1.5 py-0.5 font-mono text-[10px] text-dark-300"
            title={serviceKey}
          >
            {serviceName && serviceName.trim() ? serviceName.trim() : serviceKey}
          </code>
        ) : null}
        <span className="text-[11px] text-dark-500">
          没跑过基准的配置不许上线：扩缩、配额变更都要带着基准结果来
        </span>
        <div className="ml-auto flex items-center gap-2">
          {gate && (
            <span
              data-testid="gate-verdict"
              data-pass={pass ? 'true' : 'false'}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                pass
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                  : 'border-red-500/40 bg-red-500/15 text-red-300'
              }`}
            >
              {pass ? <ShieldCheck className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
              {pass ? '通过（允许上线）' : '不通过（禁止上线）'}
            </span>
          )}
          <button
            type="button"
            data-testid="gate-run"
            onClick={runBench}
            disabled={status === 'running' || demo}
            title={demo ? '演示模式：不会压测真实服务' : '会向目标服务打真实流量'}
            className="flex items-center gap-1.5 rounded-lg bg-accent-500/20 px-2.5 py-1 text-xs font-medium text-accent-200 transition-colors hover:bg-accent-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === 'running' ? (
              <Loader className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            {status === 'running' ? '压测中…' : '运行基准'}
          </button>
        </div>
      </div>

      {/* 分数 + 结论 */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-xs text-dark-400">
          评分{' '}
          <span
            data-testid="gate-score"
            className={`font-mono text-sm ${
              gate ? (pass ? 'text-emerald-300' : 'text-red-300') : 'text-dark-400'
            }`}
          >
            {scoreText}
          </span>
          <span className="text-dark-600"> / 100</span>
        </span>
        {meta && (
          <span data-testid="gate-meta" className="text-[11px] text-dark-500">
            {meta.cells} 个组合 · {meta.aborted ? '基准中止' : '完整跑完'} · ok={meta.ok ? 'true' : 'false'}
            {meta.reason ? ` · ${meta.reason}` : ''}
          </span>
        )}
        {gate && !pass && (
          <span data-testid="gate-apply-hint" className="text-[11px] text-red-300">
            执行（apply）已被门禁禁用：先修掉红条里的问题再重跑基准
          </span>
        )}
      </div>

      {demo && (
        <p
          data-testid="gate-demo"
          className="mb-2 rounded-lg border border-accent-500/30 bg-accent-500/10 px-3 py-1.5 text-[11px] text-accent-200"
        >
          演示模式：不会发起压测（后端也会拒绝），门禁结论无从产生 → 执行按钮保持禁用
        </p>
      )}

      {notice && (
        <p
          data-testid="gate-notice"
          className="mb-2 rounded-lg border border-dark-600/60 bg-dark-800/50 px-3 py-1.5 text-[11px] text-dark-300"
        >
          {notice}
        </p>
      )}

      {error && (
        <div
          data-testid="gate-error"
          className="mb-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />
          <span className="min-w-0 flex-1 text-xs text-red-300 break-words">基准运行失败：{error}</span>
        </div>
      )}

      {status === 'idle' && !gate ? (
        <p data-testid="gate-idle" className="py-3 text-xs leading-relaxed text-dark-500">
          还没有基准结果。点「运行基准」会按并发矩阵向 {resolvedTarget || '（目标未定）'} 打流量，
          跑完立刻逐项判定；不通过的配置在这里就停住，不会走到执行。
        </p>
      ) : null}

      {status === 'running' && (
        <p data-testid="gate-running" className="flex items-center gap-2 py-3 text-xs text-dark-400">
          <Loader className="h-4 w-4 animate-spin text-accent-400" />
          正在压测 {resolvedTarget}（矩阵 {matrix.join(' / ')}）…
        </p>
      )}

      {/* ── 逐项判定表 ─────────────────────────────────────────────── */}
      {gate && gate.checks.length > 0 && (
        <div className="mb-3 overflow-x-auto rounded-lg border border-dark-700/50">
          <table className="w-full text-sm" data-testid="gate-checks">
            <thead>
              <tr className="border-b border-dark-800/60 text-xs text-dark-500">
                <th className="px-3 py-1.5 text-left font-medium">指标</th>
                <th className="px-3 py-1.5 text-left font-medium">实测</th>
                <th className="px-3 py-1.5 text-left font-medium">阈值</th>
                <th className="px-3 py-1.5 text-left font-medium">判定</th>
              </tr>
            </thead>
            <tbody>
              {gate.checks.map((check) => (
                <tr
                  key={check.metric || check.label}
                  data-testid="gate-check-row"
                  data-metric={check.metric}
                  data-pass={check.pass ? 'true' : 'false'}
                  data-scored={check.scored ? 'true' : 'false'}
                  className="border-b border-dark-800/40 last:border-b-0"
                >
                  <td className="px-3 py-1.5 text-xs text-dark-200" data-testid="gate-check-label">
                    {check.label}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-dark-300" data-testid="gate-check-actual">
                    {check.actual}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-dark-400" data-testid="gate-check-threshold">
                    {check.threshold}
                  </td>
                  <td
                    className={`px-3 py-1.5 text-xs ${checkVerdictClass(check)}`}
                    data-testid="gate-check-verdict"
                  >
                    {checkVerdict(check)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── failures（红，阻塞）与 warnings（黄，不阻塞）分开渲染 ───── */}
      {gate && gate.failures.length > 0 && (
        <ul data-testid="gate-failures" className="mb-2 space-y-1">
          {gate.failures.map((failure, index) => (
            <li
              key={`${failure.metric}-${index}`}
              data-testid="gate-failure"
              data-metric={failure.metric}
              className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5"
            >
              <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-400" />
              <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-red-200 break-words">
                {failure.message}
                {failure.metric ? (
                  <span className="ml-1 block text-red-300/70">
                    实测 {failure.actual} · 阈值 {failure.threshold}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {gate && gate.warnings.length > 0 && (
        <ul data-testid="gate-warnings" className="mb-2 space-y-1">
          {gate.warnings.map((warning, index) => (
            <li
              key={`warn-${index}`}
              data-testid="gate-warning"
              className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] leading-relaxed text-amber-200"
            >
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
              <span className="min-w-0 flex-1 break-words">{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {/* ── markdown 报告：原样贴 <pre>，不引第三方 renderer ─────────── */}
      {report ? (
        <div className="overflow-hidden rounded-lg border border-dark-700/50 bg-dark-950/60">
          <div className="flex items-center justify-between border-b border-dark-800/60 px-2.5 py-1">
            <span className="text-[10px] uppercase tracking-wide text-dark-600">gate report (markdown)</span>
            <span className="text-[10px] text-dark-600">{report.split('\n').length} 行</span>
          </div>
          <pre
            data-testid="gate-report-md"
            className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-5 text-dark-300"
          >
            {report}
          </pre>
        </div>
      ) : null}
    </section>
  );
}
