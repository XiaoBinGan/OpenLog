/* eslint-disable react-refresh/only-export-components --
   三档判定的取词与配色必须能单独断言：「没查」渲染成「放得下」是这块最危险的错误形态，
   而它不会崩溃、只会显示一句看起来很正常的错话。 */
/**
 * 容量预检 + 模型足迹卡片：回答两个**不同**的问题。
 *
 *   · 容量预检（`capacity.js` / A4）：配额放得进**卡**吗 —— 单卡剩余显存够不够装下
 *     一个副本的 `memoryMiB`。HAMi 不能跨卡拼显存，所以「两台机器各剩一半」等于放不下。
 *   · 模型足迹（`footprint.js` / A7）：模型放得进**配额**吗 —— 权重 + 引擎开销 + KV cache
 *     装不装得进你申请的那点显存。真机上 21 GiB 配额下 AWQ 反量化 OOM、22.7 GiB 下 KV 为负，
 *     都是这一步没做导致的：容量预检当时是绿的。
 *
 * 三条口径（错了不会报错，只会变成另一句话）：
 *
 * 1. **没有结论 ≠ 放得下**。`placement` 为 null（没接集群 / 老后端）显示「未验证」，
 *    并且说清楚为什么没验；三档判定永远不把未知折叠进通过。
 * 2. **`tight` 是黄不是绿**。放行了，但并发或上下文一涨就 OOM —— 用户必须在点执行之前看到。
 * 3. **warnings 与 reasons 分开**。reasons 是「为什么是这个结论」，warnings 是「这次的数据
 *    本身可疑」（被忽略的节点、口径不一致），混在一起会让人以为结论不可信而不看结论。
 */

import { Boxes, CircleAlert, Loader, TriangleAlert, XCircle } from 'lucide-react';
import type { FootprintResult, FootprintVerdict, PlacementResult } from './types';

// ─── 三档判定（纯函数，便于按表驱动测试） ─────────────────────────────────

/** 容量结论的展示态。`unknown` = 没有拿到结论，不是「放不下」。 */
export type CapacityVerdict = 'fits' | 'insufficient' | 'unknown';

/** 足迹结论沿用后端三档 + unknown。 */
export type FootprintVerdictView = FootprintVerdict;

/** 容量结论取词：只有明确 `fits === true` 才算放得下。 */
export function capacityVerdict(placement: PlacementResult | null | undefined): CapacityVerdict {
  if (!placement) return 'unknown';
  return placement.fits ? 'fits' : 'insufficient';
}

/** 容量结论文案。 */
export function capacityVerdictText(verdict: CapacityVerdict): string {
  if (verdict === 'fits') return '放得下';
  if (verdict === 'insufficient') return '放不下';
  return '未验证';
}

/** 容量结论配色：未验证走灰（不是绿！）。 */
export function capacityVerdictClass(verdict: CapacityVerdict): string {
  if (verdict === 'fits') return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';
  if (verdict === 'insufficient') return 'border-red-500/40 bg-red-500/15 text-red-300';
  return 'border-dark-600/50 bg-dark-700/40 text-dark-400';
}

/** 足迹结论文案（`tight` 明确写成「勉强够」，不要弱化成「通过」）。 */
export function footprintVerdictText(verdict: FootprintVerdictView): string {
  if (verdict === 'fits') return '放得下';
  if (verdict === 'tight') return '勉强够（放行但会 OOM 风险）';
  if (verdict === 'insufficient') return '放不下（硬拦）';
  return '未验证';
}

/** 足迹结论配色：tight 是琥珀，不是绿。 */
export function footprintVerdictClass(verdict: FootprintVerdictView): string {
  if (verdict === 'fits') return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';
  if (verdict === 'tight') return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
  if (verdict === 'insufficient') return 'border-red-500/40 bg-red-500/15 text-red-300';
  return 'border-dark-600/50 bg-dark-700/40 text-dark-400';
}

/** MiB → 人话（≥1024 走 GiB，保留一位小数；非有限值显示 `—`）。 */
export function formatMiB(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1024) return `${(value / 1024).toFixed(1)} GiB`;
  return `${Math.round(value)} MiB`;
}

// ─── 组件 ────────────────────────────────────────────────────────────────

export interface CapacityReportProps {
  /** A4 容量预检结论（preview 响应的 `placement` 字段）。 */
  placement?: PlacementResult | null;
  /** A7 模型足迹结论（preview 响应的 `footprint` 字段）。 */
  footprint?: FootprintResult | null;
  /** 预览请求在飞：说明「正在查」，而不是显示上一次的结论。 */
  loading?: boolean;
  /** 演示模式：不查真实集群，也不画假数字。 */
  demo?: boolean;
  /** 是否已经生成过预览（没有预览时给空态引导，而不是「放不下」）。 */
  hasPreview?: boolean;
}

/** 一条理由（reasons / warnings / fragments 共用样式，靠 data-kind 与 testid 区分）。 */
function Line({ kind, text }: { kind: 'reason' | 'warning' | 'fragment'; text: string }) {
  const warning = kind !== 'reason';
  const testid =
    kind === 'reason' ? 'capacity-reason' : kind === 'fragment' ? 'capacity-fragment' : 'capacity-warning';
  return (
    <li
      data-testid={testid}
      data-kind={kind}
      className={`flex items-start gap-2 rounded-lg border px-3 py-1.5 text-[11px] leading-relaxed ${
        warning
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
          : 'border-dark-700/50 bg-dark-800/40 text-dark-300'
      }`}
    >
      {warning ? (
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
      ) : (
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-dark-500" />
      )}
      <span className="min-w-0 flex-1 break-words">{text}</span>
    </li>
  );
}

/**
 * 容量 + 足迹卡片。
 *
 * 自己不取数据：结论必须来自**本次** preview，跨请求缓存的容量数字会让人照着
 * 一份过期的落点判断改配额。
 */
export default function CapacityReport({
  placement = null,
  footprint = null,
  loading = false,
  demo = false,
  hasPreview = false,
}: CapacityReportProps) {
  const capacity = capacityVerdict(placement);
  const footprintVerdict: FootprintVerdictView = footprint?.verdict ?? 'unknown';

  // 有预览请求在飞时先不展示结论：上一次的"放得下"不能给这一次定义背书
  const showResult = !demo && !loading && hasPreview;

  return (
    <section
      className="glass rounded-xl p-4"
      data-testid="capacity-report"
      data-demo={demo ? 'true' : 'false'}
      data-capacity={showResult ? capacity : 'unknown'}
      data-footprint={showResult ? footprintVerdict : 'unknown'}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Boxes className="h-4 w-4 text-accent-400" />
        <h3 className="text-sm font-semibold text-dark-100">容量预检与模型足迹</h3>
        <span className="text-[11px] text-dark-500">
          配额放得进卡 ≠ 模型放得进配额：前者看单卡剩余显存，后者看权重 + 开销 + KV
        </span>
      </div>

      {demo && (
        <p
          data-testid="capacity-demo"
          className="mb-2 rounded-lg border border-accent-500/30 bg-accent-500/10 px-3 py-1.5 text-[11px] text-accent-200"
        >
          演示模式：不读取真实节点容量，也不估算模型足迹（画一组假数字会让人以为配额是验过的）
        </p>
      )}

      {loading && (
        <p data-testid="capacity-loading" className="flex items-center gap-2 py-3 text-xs text-dark-400">
          <Loader className="h-4 w-4 animate-spin text-accent-400" />
          正在读节点容量与模型元数据…
        </p>
      )}

      {!demo && !loading && !hasPreview && (
        <p data-testid="capacity-empty" className="py-3 text-xs leading-relaxed text-dark-500">
          还没有预览结果。先「生成预览」——容量预检按每副本配额算落点，模型足迹按模型文件 +
          上下文算需求；两项都没结论时，执行按钮拿不到「放得下」的证据。
        </p>
      )}

      {showResult && (
        <div className="space-y-3">
          {/* ── 容量预检 ─────────────────────────────────────────────── */}
          <div data-testid="capacity-block" className="rounded-lg border border-dark-700/50 p-2.5">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-dark-200">容量预检（配额 → 卡）</span>
              <span
                data-testid="capacity-verdict"
                data-verdict={capacity}
                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${capacityVerdictClass(capacity)}`}
              >
                {capacity === 'insufficient' ? <XCircle className="mr-1 inline h-3 w-3" /> : null}
                {capacityVerdictText(capacity)}
              </span>
              {placement?.best ? (
                <span data-testid="capacity-best" className="text-[11px] text-dark-500">
                  最紧的落点{' '}
                  <code className="rounded bg-dark-800/60 px-1 py-0.5 font-mono text-[10px] text-dark-300">
                    {placement.best}
                  </code>
                </span>
              ) : null}
            </div>

            {capacity === 'unknown' ? (
              <p data-testid="capacity-unknown" className="text-[11px] leading-relaxed text-dark-400">
                服务端没有返回容量结论（可能没接入集群，或这一层模块未就绪）——
                这一项按「未验证」处理，不当作放得下。
              </p>
            ) : (
              <>
                {placement && placement.reasons.length > 0 && (
                  <ul data-testid="capacity-reasons" className="space-y-1">
                    {placement.reasons.map((reason, index) => (
                      <Line key={`reason-${index}`} kind="reason" text={reason} />
                    ))}
                  </ul>
                )}

                {placement && placement.fragments.length > 0 && (
                  <ul data-testid="capacity-fragments" className="mt-1 space-y-1">
                    {placement.fragments.map((fragment, index) => (
                      <Line key={`fragment-${index}`} kind="fragment" text={fragment} />
                    ))}
                  </ul>
                )}

                {placement && placement.candidates.length > 0 && (
                  <div className="mt-2 overflow-x-auto rounded-lg border border-dark-700/50">
                    <table className="w-full text-sm" data-testid="capacity-candidates">
                      <thead>
                        <tr className="border-b border-dark-800/60 text-xs text-dark-500">
                          <th className="px-2.5 py-1.5 text-left font-medium">节点</th>
                          <th className="px-2.5 py-1.5 text-left font-medium">单卡剩余</th>
                          <th className="px-2.5 py-1.5 text-left font-medium">落点后剩余</th>
                          <th className="px-2.5 py-1.5 text-left font-medium">承载副本</th>
                          <th className="px-2.5 py-1.5 text-left font-medium">参与判定</th>
                        </tr>
                      </thead>
                      <tbody>
                        {placement.candidates.map((candidate) => (
                          <tr
                            key={candidate.node}
                            data-testid="capacity-candidate"
                            data-eligible={candidate.eligible === false ? 'false' : 'true'}
                            className="border-b border-dark-800/40 last:border-b-0"
                          >
                            <td className="px-2.5 py-1.5 font-mono text-[11px] text-dark-200">
                              {candidate.node}
                            </td>
                            <td className="px-2.5 py-1.5 font-mono text-[11px] text-dark-300">
                              {formatMiB(candidate.maxFreeMemMiB ?? candidate.freeMemMiB)}
                            </td>
                            <td className="px-2.5 py-1.5 font-mono text-[11px] text-dark-400">
                              {formatMiB(candidate.remainingMiB)}
                            </td>
                            <td className="px-2.5 py-1.5 font-mono text-[11px] text-dark-300">
                              {typeof candidate.placedReplicas === 'number'
                                ? candidate.placedReplicas
                                : '—'}
                            </td>
                            <td
                              className={`px-2.5 py-1.5 text-xs ${
                                candidate.eligible === false ? 'text-dark-500' : 'text-dark-200'
                              }`}
                            >
                              {candidate.eligible === false ? '否（型号不匹配/不可用）' : '是'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {placement && placement.warnings.length > 0 && (
              <ul data-testid="capacity-warnings" className="mt-2 space-y-1">
                {placement.warnings.map((warning, index) => (
                  <Line key={`warn-${index}`} kind="warning" text={warning} />
                ))}
              </ul>
            )}
          </div>

          {/* ── 模型足迹 ─────────────────────────────────────────────── */}
          <div data-testid="footprint-block" className="rounded-lg border border-dark-700/50 p-2.5">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-dark-200">模型足迹（模型 → 配额）</span>
              <span
                data-testid="footprint-verdict"
                data-verdict={footprintVerdict}
                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${footprintVerdictClass(footprintVerdict)}`}
              >
                {footprintVerdictText(footprintVerdict)}
              </span>
              {footprint?.basis ? (
                <span
                  data-testid="footprint-basis"
                  className="rounded bg-dark-800/60 px-1.5 py-0.5 font-mono text-[10px] text-dark-400"
                  title={footprint.assumption || undefined}
                >
                  口径 {footprint.basis === 'measured' ? '实测' : '估算'}
                </span>
              ) : null}
            </div>

            {!footprint ? (
              <p data-testid="footprint-unknown" className="text-[11px] leading-relaxed text-dark-400">
                服务端没有返回足迹结论（这一层模块未就绪）—— 按「未验证」处理，
                不代表模型放得进当前配额。
              </p>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dark-400">
                  <span>
                    需要{' '}
                    <span data-testid="footprint-required" className="font-mono text-dark-200">
                      {formatMiB(footprint.requiredMiB)}
                    </span>
                  </span>
                  <span>
                    配额{' '}
                    <span data-testid="footprint-quota" className="font-mono text-dark-200">
                      {formatMiB(footprint.quotaMiB)}
                    </span>
                  </span>
                  <span>
                    余量{' '}
                    <span
                      data-testid="footprint-headroom"
                      className={`font-mono ${
                        typeof footprint.headroomMiB === 'number' && footprint.headroomMiB < 0
                          ? 'text-red-300'
                          : 'text-dark-300'
                      }`}
                    >
                      {formatMiB(footprint.headroomMiB)}
                    </span>
                  </span>
                  {footprint.breakdown && (
                    <span data-testid="footprint-breakdown" className="text-dark-500">
                      权重 {formatMiB(footprint.breakdown.weightsMiB)} · 开销{' '}
                      {formatMiB(footprint.breakdown.overheadMiB)} · KV{' '}
                      {formatMiB(footprint.breakdown.kvCacheMiB)}
                      {footprint.breakdown.kvSource ? `（${footprint.breakdown.kvSource}）` : ''}
                    </span>
                  )}
                </div>

                {footprint.reasons.length > 0 && (
                  <ul data-testid="footprint-reasons" className="space-y-1">
                    {footprint.reasons.map((reason, index) => (
                      <Line key={`fp-${index}`} kind="reason" text={reason} />
                    ))}
                  </ul>
                )}

                {footprint.warnings.length > 0 && (
                  <ul data-testid="footprint-warnings" className="mt-1 space-y-1">
                    {footprint.warnings.map((warning, index) => (
                      <Line key={`fpw-${index}`} kind="warning" text={warning} />
                    ))}
                  </ul>
                )}

                {footprint.assumption ? (
                  <p data-testid="footprint-assumption" className="mt-1 text-[10px] leading-relaxed text-dark-500">
                    口径：{footprint.assumption}
                    {footprint.specSource ? ` · 元数据来源 ${footprint.specSource}` : ''}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
