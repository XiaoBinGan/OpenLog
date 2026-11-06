/**
 * 区块：运维助手上下文（模型上下文窗口 / 预算 / 自动压缩 / 压缩阈值 / 轮数 / 时长）
 *
 * 负责什么：
 *   - 只渲染 settings.assistantContext 这一小块配置，以及它的派生显示（百分比、clamp 后的预算）
 *   - 所有写入都通过父组件下发的 onSetContextField 合并进 settings.assistantContext
 *
 * 为什么不放在父组件：
 *   这一块有 6 个派生值（win / budget / maxBudget / clamped / invalid / budgetPct）和一个
 *   局部 setCtx 合并函数，全部只为本卡片服务。留在父组件会让父组件的渲染函数里塞一个
 *   IIFE；下沉后父组件只传「当前 assistantContext + 一个稳定 setter」，别处改 settings
 *   （比如改日志路径）也不会重画这 150 行。
 */
import { memo } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { Settings as SettingsType } from '../../types';
import Toggle from '../../components/Toggle';

export interface AssistantContextSectionProps {
  assistantContext?: SettingsType['assistantContext'];
  onSetContextField: (patch: Record<string, unknown>) => void;
  onDirty: () => void;
}

function AssistantContextSection({ assistantContext, onSetContextField, onDirty }: AssistantContextSectionProps) {
  const ctx = assistantContext || {};
  const win = ctx.windowTokens ?? 65_536;
  const budget = ctx.budgetTokens ?? 48_000;
  const autoCompact = ctx.autoCompact !== false;
  const compactAt = ctx.compactAt ?? 0.85;
  const maxBudget = Math.max(4_000, win - (ctx.maxOutputTokens ?? 4_096));
  const clamped = Math.min(budget, maxBudget);
  const invalid = budget > maxBudget;
  const budgetPct = win > 0 ? Math.round((clamped / win) * 100) : 0;
  const setCtx = (patch: Record<string, unknown>) => {
    onSetContextField(patch);
    onDirty();
  };

  return (
    <div className="glass rounded-xl p-6">
      <div className="mb-5 flex items-start gap-3">
        <div className="rounded-lg bg-cyan-500/15 p-2">
          <SlidersHorizontal className="h-4 w-4 text-cyan-400" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-dark-100">运维助手上下文</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-dark-500">
            控制助手能「记住多少」。长任务或大文件排查建议调大窗口与预算；
            助手里的小齿轮可以只对单个会话临时覆盖，这里保存的是全局默认。
          </p>
        </div>
      </div>

      <div className="space-y-5">
        {/* 窗口 */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm text-dark-300">模型上下文窗口</label>
            <span className="tabular-nums text-xs text-dark-500">{(win / 1024).toFixed(0)}k tokens</span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[32_768, 65_536, 131_072, 262_144].map(v => (
              <button
                key={v}
                onClick={() => setCtx({ windowTokens: v, budgetTokens: Math.min(clamped, Math.max(4_000, v - 4_096)) })}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-all ${
                  win === v
                    ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                    : 'border-dark-800 bg-dark-900/60 text-dark-400 hover:border-dark-700 hover:text-dark-200'
                }`}
              >
                {v / 1024}k
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number" min={8_000} max={1_048_576} step={1024}
              value={win}
              onChange={e => setCtx({ windowTokens: Number(e.target.value) })}
              className="flex-1 rounded-lg border border-dark-800 bg-dark-900 px-3 py-2 text-sm tabular-nums text-dark-200 outline-none transition-colors focus:border-cyan-500/50"
            />
            <span className="text-xs text-dark-600">按模型真实上限填（如 Qwen3-128k 填 131072）</span>
          </div>
        </div>

        {/* 预算 */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm text-dark-300">上下文预算</label>
            <span className={`tabular-nums text-xs ${invalid ? 'text-yellow-500' : 'text-dark-500'}`}>
              {(clamped / 1000).toFixed(0)}k / {(win / 1000).toFixed(0)}k（占窗口 {budgetPct}%）
            </span>
          </div>
          <input
            type="range" min={4_000} max={maxBudget} step={1024}
            value={clamped}
            onChange={e => setCtx({ budgetTokens: Number(e.target.value) })}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-dark-800 accent-cyan-500
              [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400
              [&::-webkit-slider-thumb]:shadow-[0_0_0_4px_rgba(34,211,238,0.16)]"
          />
          <p className={`mt-1.5 text-xs ${invalid ? 'text-yellow-500' : 'text-dark-600'}`}>
            {invalid
              ? `超出窗口可容纳上限，保存时会自动压到 ${(maxBudget / 1000).toFixed(0)}k（窗口 − 输出上限）`
              : '建议留 15%~25% 给模型输出；预算越接近窗口，压缩越频繁'}
          </p>
        </div>

        {/* 压缩与运行上限 */}
        <div className="space-y-4 rounded-xl border border-dark-800/70 bg-dark-900/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm text-dark-300">自动压缩历史</div>
              <p className="mt-0.5 text-xs text-dark-600">关闭后超预算会中断任务</p>
            </div>
            <Toggle
              checked={autoCompact}
              onChange={next => setCtx({ autoCompact: next })}
              size="md"
              color="rgb(34 211 238)"
              ring="focus:ring-2 focus:ring-cyan-500/40"
              aria-label="自动压缩历史"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-dark-300">压缩触发阈值</span>
              <span className="tabular-nums text-xs text-dark-500">{Math.round(compactAt * 100)}%</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {[0.7, 0.8, 0.85, 0.9].map(v => (
                <button
                  key={v}
                  onClick={() => setCtx({ compactAt: v })}
                  className={`rounded-lg border px-2 py-1.5 text-xs tabular-nums transition-all ${
                    Math.abs(compactAt - v) < 0.001
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                      : 'border-dark-800 text-dark-400 hover:border-dark-700 hover:text-dark-200'
                  }`}
                >
                  {Math.round(v * 100)}%
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm text-dark-300">最大轮数</label>
              <input
                type="number" min={1} max={200}
                value={ctx.maxRounds ?? 30}
                onChange={e => setCtx({ maxRounds: Number(e.target.value) })}
                className="w-full rounded-lg border border-dark-800 bg-dark-900 px-3 py-2 text-sm tabular-nums text-dark-200 outline-none transition-colors focus:border-cyan-500/50"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm text-dark-300">最大时长（分钟）</label>
              <input
                type="number" min={1} max={120}
                value={Math.round((ctx.maxWallMs ?? 600_000) / 60_000)}
                onChange={e => setCtx({ maxWallMs: Number(e.target.value) * 60_000 })}
                className="w-full rounded-lg border border-dark-800 bg-dark-900 px-3 py-2 text-sm tabular-nums text-dark-200 outline-none transition-colors focus:border-cyan-500/50"
              />
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-cyan-500/15 bg-cyan-500/[0.04] px-3 py-2 text-xs leading-relaxed text-dark-400">
          <span className="mt-0.5 shrink-0 text-cyan-400">💡</span>
          <span>
            助手输入框上方会实时显示用量条。达到 <b className="text-dark-200">{Math.round((ctx.warnAt ?? 0.7) * 100)}%</b> 提示开启新会话，
            达到 <b className="text-dark-200">{Math.round(compactAt * 100)}%</b> 自动压缩历史。
            填大了会被模型拒绝，填小了会白白浪费上下文。
          </span>
        </div>
      </div>
    </div>
  );
}

export default memo(AssistantContextSection);