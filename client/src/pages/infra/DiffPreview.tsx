/**
 * 变更预览卡片：`{ allowed, violations[], diff, impact }` 的可读化。
 *
 * 这张卡是整个变更流程里的「干跑」环节（契约铁律 3：计划 → diff → 干跑 →
 * 执行 → 校验 → 可回滚）。它必须让人在**按下执行之前**同时看到三件事：
 *
 *   1. **护栏结论**：`violations` 每一条都是一个可读中文句子，红色的，说清
 *      「哪条规则、为什么、怎么改」。有一条未通过，执行按钮就必须是灰的，
 *      并在旁边写出原因 —— 不是只在 title 里藏一句 tooltip。
 *   2. **到底改了什么**：`diff` 用等宽字体逐行渲染，`+` 绿、`-` 红。
 *      unified diff 的头（`---` / `+++` / `@@`）单独算一类，不跟着`+`/`-` 染色，
 *      否则「文件头」会被读成「新增了一行」。
 *   3. **代价**：`impact` 三格 —— 动作 / 是否重启 / 预计中断秒数。
 *      中断秒数是**最坏情况**（单副本 30 秒 × 副本数），文案里写清楚口径。
 *
 * 三种「不能执行」的原因各自独立，UI 必须能区分：
 *   · 护栏未过（`!allowed` 或有 violations）→ 让用户先改定义；
 *   · 演示模式（`demo`）→ 根本没有集群可下发；
 *   · 执行中（`applying`）→ 防连点。
 */

import { Ban, CheckCircle2, FileDiff, Loader, Play } from 'lucide-react';
import type { GuardResult, InfraAction } from './types';

export interface DiffPreviewProps {
  /** A2 preview 的归一化结果；null = 还没生成预览。 */
  result: GuardResult | null;
  /** 预览请求进行中。 */
  loading?: boolean;
  /** 执行按钮点击（只在允许且非演示模式时可点）。 */
  onApply: () => void;
  /** 执行请求进行中。 */
  applying?: boolean;
  /** 演示模式：执行按钮永远禁用。 */
  demo?: boolean;
  /** 执行失败的消息。 */
  applyError?: string | null;
  /** 执行成功后的提示（含步骤摘要）。 */
  applyNotice?: string | null;
}

/** diff 行分类：新增 / 删除 / 上下文 / 头信息。 */
type DiffLineKind = 'add' | 'del' | 'ctx' | 'meta';

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * 文本 diff → 行数组。
 *
 * 先判头（`+++`/`---`/`@@`/`diff `/`index `），再判 `+`/`-`：否则
 * `+++ b/deployment.yaml` 会被当成「新增了 `++ b/deployment.yaml` 这一行」。
 */
function parseDiffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  return diff
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line, index, all) => !(index === all.length - 1 && line === ''))
    .map((line) => {
      if (
        line.startsWith('+++') ||
        line.startsWith('---') ||
        line.startsWith('@@') ||
        line.startsWith('diff ') ||
        line.startsWith('index ')
      ) {
        return { kind: 'meta', text: line };
      }
      if (line.startsWith('+')) return { kind: 'add', text: line };
      if (line.startsWith('-')) return { kind: 'del', text: line };
      return { kind: 'ctx', text: line };
    });
}

/** 每一类的配色（绿 / 红 / 灰 / 更灰）。 */
const LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/10 text-emerald-300',
  del: 'bg-red-500/10 text-red-300',
  ctx: 'text-dark-400',
  meta: 'text-dark-500',
};

/** 动作的中文说法。 */
const ACTION_LABEL: Record<InfraAction, string> = {
  create: '创建',
  update: '更新',
  delete: '删除',
  noop: '无变化',
};

/** 影响动作颜色的档位：创建/无变化是中性，更新是琥珀，删除是红。 */
const ACTION_CLASS: Record<InfraAction, string> = {
  create: 'text-accent-300',
  update: 'text-amber-300',
  delete: 'text-red-300',
  noop: 'text-dark-400',
};

/** 单格 impact 的小组件。 */
function ImpactCell({ field, label, value, className }: {
  field: string;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div data-testid="infra-impact-cell" data-field={field} className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-dark-600">{label}</div>
      <div className={`mt-0.5 text-sm ${className ?? 'text-dark-100'}`}>{value}</div>
    </div>
  );
}

/**
 * 变更预览卡片。
 *
 * 纯展示组件：不发请求，所有数据从 props 来；执行动作也交给调用方
 * （InfraPanel 负责 `POST .../apply` 与列表刷新）。
 */
export default function DiffPreview({
  result,
  loading = false,
  onApply,
  applying = false,
  demo = false,
  applyError = null,
  applyNotice = null,
}: DiffPreviewProps) {
  const violations = result?.violations ?? [];
  const lines = parseDiffLines(result?.diff ?? '');
  // 后端理论上 allowed 与 violations 一致；不一致时按「不允许」处理（宁可拦住）
  const blocked = result ? !result.allowed || violations.length > 0 : true;

  /** 执行按钮为什么不能点 —— 三档原因，文案各自说清。 */
  const blockReason = demo
    ? '演示模式：不会把变更下发到集群'
    : !result
      ? '先生成变更预览'
      : violations.length > 0
        ? `有 ${violations.length} 条护栏未通过，先按上面的提示修改定义`
        : !result.allowed
          ? '护栏拒绝了这次变更（后端未返回具体原因）'
          : null;

  return (
    <section className="glass rounded-xl p-4" data-testid="infra-diff-preview">
      <div className="mb-2 flex items-center gap-2">
        <FileDiff className="h-4 w-4 text-accent-400" />
        <h3 className="text-sm font-semibold text-dark-100">变更预览</h3>
        {result && (
          <span
            data-testid="infra-allowed-badge"
            data-allowed={blocked ? 'false' : 'true'}
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
              blocked
                ? 'border-red-500/40 bg-red-500/15 text-red-300'
                : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
            }`}
          >
            {blocked ? '护栏未通过' : '可以执行'}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 px-1 py-4 text-xs text-dark-400">
          <Loader className="h-4 w-4 animate-spin text-accent-400" />
          正在生成变更计划…
        </div>
      ) : !result ? (
        applyNotice ? null : (
          <p className="px-1 py-4 text-xs leading-relaxed text-dark-500" data-testid="infra-preview-empty">
            还没有预览。填好服务定义后点「生成变更预览」，这里会显示护栏结论、diff 和中断预估。
          </p>
        )
      ) : (
        <div className="space-y-3">
          {/* 1. 护栏：一条一行，红色的，带字段定位 */}
          {violations.length > 0 && (
            <div
              data-testid="infra-violations"
              className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2"
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-red-300">
                <Ban className="h-3.5 w-3.5 flex-shrink-0" />
                护栏未通过（{violations.length} 条）
              </p>
              <ul className="mt-1.5 space-y-1">
                {violations.map((violation, index) => (
                  <li
                    key={`${violation.code ?? 'v'}-${index}`}
                    data-testid="infra-violation"
                    data-field={violation.field ?? ''}
                    className="flex items-start gap-1.5 text-[11px] leading-relaxed text-red-200"
                  >
                    <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-red-400" />
                    <span className="min-w-0 break-words">
                      {violation.field && (
                        <code className="mr-1 rounded bg-red-500/20 px-1 py-0.5 font-mono text-[10px] text-red-200">
                          {violation.field}
                        </code>
                      )}
                      {violation.message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 2. impact：动作 / 重启 / 中断秒数 */}
          <div
            data-testid="infra-impact"
            data-action={result.impact.action}
            data-restarts={result.impact.restarts ? 'true' : 'false'}
            className="grid grid-cols-3 gap-3 rounded-lg border border-dark-700/50 bg-dark-900/40 px-3 py-2"
          >
            <ImpactCell
              field="action"
              label="动作"
              value={ACTION_LABEL[result.impact.action]}
              className={ACTION_CLASS[result.impact.action]}
            />
            <ImpactCell
              field="restarts"
              label="是否重启"
              value={result.impact.restarts ? '会重建 Pod' : '不重建'}
              className={result.impact.restarts ? 'text-amber-300' : 'text-emerald-300'}
            />
            <ImpactCell
              field="downtime"
              label="预计中断"
              value={
                result.impact.downtimeSeconds > 0
                  ? `最坏 ${result.impact.downtimeSeconds} 秒`
                  : '0 秒'
              }
              className={result.impact.downtimeSeconds > 0 ? 'text-amber-300' : 'text-emerald-300'}
            />
          </div>

          {result.impact.reasons.length > 0 && (
            <ul data-testid="infra-impact-reasons" className="space-y-0.5 px-1">
              {result.impact.reasons.map((reason, index) => (
                <li key={index} className="text-[11px] leading-relaxed text-dark-400">
                  · {reason}
                </li>
              ))}
            </ul>
          )}

          {/* 3. diff：等宽，+ 绿 / - 红 */}
          <div className="overflow-hidden rounded-lg border border-dark-700/50 bg-dark-950/60">
            <div className="flex items-center justify-between border-b border-dark-800/60 px-2.5 py-1">
              <span className="text-[10px] uppercase tracking-wide text-dark-600">diff</span>
              <span className="text-[10px] text-dark-600">{lines.length} 行</span>
            </div>
            {lines.length === 0 ? (
              <p className="px-2.5 py-2 text-[11px] text-dark-500" data-testid="infra-diff-empty">
                没有差异（服务定义与当前集群状态一致）
              </p>
            ) : (
              <pre
                data-testid="infra-diff"
                className="max-h-72 overflow-auto px-0 py-1 font-mono text-[11px] leading-5"
              >
                {lines.map((line, index) => (
                  <div
                    key={index}
                    data-testid="infra-diff-line"
                    data-kind={line.kind}
                    className={`whitespace-pre-wrap break-all px-2.5 ${LINE_CLASS[line.kind]}`}
                  >
                    {line.text === '' ? '\u00a0' : line.text}
                  </div>
                ))}
              </pre>
            )}
          </div>

          {/* 4. 执行区：禁用原因必须写出来，不能只靠 tooltip */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="infra-apply"
              onClick={onApply}
              disabled={blocked || demo || applying}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {applying ? (
                <Loader className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {applying ? '执行中…' : '执行'}
            </button>
            {blockReason ? (
              <span data-testid="infra-apply-reason" className="text-[11px] text-dark-500">
                {blockReason}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-dark-500">
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                执行会按顺序下发并保留回滚快照
              </span>
            )}
          </div>

        </div>
      )}

      {/* 执行反馈放在 result 分支之外：apply 成功后调用方会清掉预览，
          如果把提示塞在 result 里，用户会在「执行成功」的那一刻什么都看不到。 */}
      {applyError && (
        <div
          data-testid="infra-apply-error"
          className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300 break-words"
        >
          执行失败：{applyError}
        </div>
      )}
      {applyNotice && (
        <div
          data-testid="infra-apply-notice"
          className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200 break-words"
        >
          {applyNotice}
        </div>
      )}
    </section>
  );
}
