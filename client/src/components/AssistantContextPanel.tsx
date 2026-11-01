import { useEffect, useRef, useState } from 'react';
import {
  Gauge, SlidersHorizontal, X, AlertTriangle, ArrowRight, RotateCcw,
  Sparkles, Check, TriangleAlert,
} from 'lucide-react';
import type { ContextSettings } from '../contexts/AssistantContext';
import {
  type ContextConfigLike, type ContextUsageLike,
  USAGE_LEVEL_STYLES, usageLevel, usageSummary, formatTokens, formatDuration,
} from '../utils/contextUsage';

/** 上下文用量与配置面板的展示组件（把视觉细节从 Assistant 页面里抽出来） */

/* ─────────────────────────── 用量条 ─────────────────────────── */

export function ContextUsageBar({
  usage, config, warnings, sessionOverridden, open, onToggle,
}: {
  usage: ContextUsageLike | null;
  config: ContextConfigLike;
  warnings: string[];
  sessionOverridden: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  // 还没发过消息时不要显示「—」：直接按预算给出 0%，用户一眼就知道总量
  const effective = usage || {
    used: 0, budget: config.budgetTokens, window: config.windowTokens, percent: 0,
    estimated: true,
  };
  const pct = Math.max(0, Math.min(100, effective.percent ?? 0));
  const level = usageLevel(usage?.percent ?? 0, config);
  const style = USAGE_LEVEL_STYLES[level];
  const budgetShare = config.windowTokens > 0
    ? Math.min(100, (config.budgetTokens / config.windowTokens) * 100)
    : 0;

  return (
    <div className="flex items-center gap-2">
      {/* 主条：窗口为底、预算为中间层、已用为最上层 —— 一眼看出三者关系 */}
      <div className="group/usage relative min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1.5 text-[11px] font-medium tabular-nums ${style.text}`}>
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            {usage ? usageSummary(usage, { estimatedPrefix: true }) : `0 / ${formatTokens(config.budgetTokens)} · 0%`}
          </span>
          <span className="text-[10px] text-dark-600">
            窗口 {formatTokens(config.windowTokens)}
          </span>
          {usage?.compacted ? (
            <span className="rounded bg-dark-800/80 px-1.5 py-px text-[10px] text-dark-500">
              压缩 {usage.compacted}
            </span>
          ) : null}
          {sessionOverridden && (
            <span className="rounded bg-accent-500/15 px-1.5 py-px text-[10px] text-accent-400">
              会话覆盖
            </span>
          )}
          {warnings.length > 0 && (
            <span className="flex cursor-help items-center gap-0.5 text-[10px] text-yellow-500" title={warnings.join('\n')}>
              <TriangleAlert className="h-3 w-3" />已校正
            </span>
          )}
        </div>

        <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-dark-800/90">
          {/* 预算占窗口的比例（浅色底） */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-dark-700/70 transition-all duration-300"
            style={{ width: `${budgetShare}%` }}
          />
          {/* 已用量（彩色） */}
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${style.bar} transition-all duration-500`}
            style={{ width: `${Math.min(budgetShare, pct)}%` }}
          />
        </div>

        {/* hover 明细 */}
        <div className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 hidden w-64 rounded-xl border border-dark-700/80 bg-dark-900/95 p-3 shadow-2xl backdrop-blur group-hover/usage:block">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-dark-100">上下文占用</span>
            <span className={`text-[11px] font-medium tabular-nums ${style.text}`}>
              {Math.round(usage?.percent ?? 0)}%
            </span>
          </div>
          <BreakdownRow label="系统提示" value={usage?.breakdown?.system ?? 0} total={config.budgetTokens} tone="bg-sky-500" />
          <BreakdownRow label="工具定义" value={usage?.breakdown?.tools ?? 0} total={config.budgetTokens} tone="bg-violet-500" />
          <BreakdownRow label="对话消息" value={usage?.breakdown?.messages ?? 0} total={config.budgetTokens} tone="bg-emerald-500" />
          <div className="mt-2 flex items-center justify-between border-t border-dark-800 pt-2 text-[10px] text-dark-500">
            <span>预算 {formatTokens(config.budgetTokens)}</span>
            <span>{usage?.estimated ? '本地估算' : '引擎实测'}</span>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onToggle}
        title="上下文设置"
        className={`shrink-0 rounded-lg p-1.5 transition-all ${
          open
            ? 'bg-accent-500/20 text-accent-400 ring-1 ring-accent-500/30'
            : 'text-dark-500 hover:bg-dark-800 hover:text-dark-200'
        }`}
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
    </div>
  );
}

function BreakdownRow({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="mb-0.5 flex items-center justify-between text-[10px]">
        <span className="text-dark-400">{label}</span>
        <span className="tabular-nums text-dark-300">{formatTokens(value)}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-dark-800">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ─────────────────────────── 提示横幅 ─────────────────────────── */

export function ContextAdviceBanner({
  level, text, action, actionLabel, onAction, onDismiss,
}: {
  level: 'info' | 'warn' | 'critical';
  text: string;
  action?: 'new_session' | 'switch_model';
  actionLabel?: string;
  onAction: () => void;
  onDismiss: () => void;
}) {
  const palette = level === 'critical'
    ? { box: 'border-red-500/25 bg-red-500/[0.07]', icon: 'text-red-400', text: 'text-red-200/90' }
    : level === 'warn'
      ? { box: 'border-yellow-500/25 bg-yellow-500/[0.07]', icon: 'text-yellow-400', text: 'text-yellow-100/90' }
      : { box: 'border-dark-700 bg-dark-800/60', icon: 'text-dark-400', text: 'text-dark-300' };

  return (
    <div className={`mb-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${palette.box}`}>
      <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${palette.icon}`} />
      <span className={`min-w-0 flex-1 text-[11px] leading-relaxed ${palette.text}`}>{text}</span>
      {action && (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded-md bg-accent-500/15 px-2 py-0.5 text-[11px] font-medium text-accent-300 transition-colors hover:bg-accent-500/25"
        >
          {actionLabel || (action === 'switch_model' ? '去设置' : '新会话')}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-dark-500 transition-colors hover:bg-dark-700/60 hover:text-dark-300"
        title="关闭提示"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/* ─────────────────────────── 设置面板 ─────────────────────────── */

const WINDOW_PRESETS = [32_768, 65_536, 131_072, 262_144];
const THRESHOLD_PRESETS = [0.7, 0.8, 0.85, 0.9];

export function ContextSettingsPanel({
  config, onClose, onApply, onReset, saving,
}: {
  config: ContextConfigLike;
  onClose: () => void;
  onApply: (patch: ContextSettings, persist: boolean) => void;
  onReset: () => void;
  saving: boolean;
}) {
  const [windowTokens, setWindowTokens] = useState(config.windowTokens);
  const [budgetTokens, setBudgetTokens] = useState(config.budgetTokens);
  const [autoCompact, setAutoCompact] = useState(config.autoCompact ?? true);
  const [compactAt, setCompactAt] = useState(config.compactAt ?? 0.85);
  const [maxRounds, setMaxRounds] = useState(config.maxRounds ?? 30);
  const [maxMinutes, setMaxMinutes] = useState(Math.round((config.maxWallMs ?? 600_000) / 60_000));
  const ref = useRef<HTMLDivElement>(null);

  // Esc 关闭 + 点外部关闭（面板浮在输入区上方，容易误触）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // 延迟绑定，避免打开面板的这次点击立刻把它关掉
    const t = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  // 预算是窗口的子集：改窗口不能留下非法预算
  const maxBudget = Math.max(4_000, windowTokens - (config.maxOutputTokens ?? 4_096));
  const clampedBudget = Math.min(budgetTokens, maxBudget);
  const budgetPct = windowTokens > 0 ? (clampedBudget / windowTokens) * 100 : 0;
  const invalid = budgetTokens > maxBudget;

  const handleApply = (persist: boolean) => {
    onApply({
      windowTokens, budgetTokens: clampedBudget, autoCompact, compactAt, maxRounds, maxWallMs: maxMinutes * 60_000,
    }, persist);
  };

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 z-[60] mb-2 w-[23rem] overflow-hidden rounded-2xl border border-dark-700/80 bg-dark-900/95 shadow-2xl backdrop-blur-xl animate-scale-in"
    >
      {/* 头部 */}
      <div className="flex items-start justify-between border-b border-dark-800/80 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 rounded-lg bg-accent-500/15 p-1.5">
            <SlidersHorizontal className="h-3.5 w-3.5 text-accent-400" />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-dark-100">上下文设置</h3>
            <p className="mt-0.5 text-[10px] text-dark-500">只影响当前会话，可另存为全局默认</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-dark-500 transition-colors hover:bg-dark-800 hover:text-dark-300"
          title="关闭（Esc）"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-[60vh] space-y-4 overflow-y-auto px-4 py-3">
        {/* 模型窗口 */}
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-[11px] font-medium text-dark-300">模型窗口</label>
            <span className="tabular-nums text-[10px] text-dark-500">{formatTokens(windowTokens)} tokens</span>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {WINDOW_PRESETS.map(v => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  setWindowTokens(v);
                  setBudgetTokens(b => Math.min(b, Math.max(4_000, v - (config.maxOutputTokens ?? 4_096))));
                }}
                className={`rounded-md border px-1 py-1.5 text-[11px] transition-all ${
                  windowTokens === v
                    ? 'border-accent-500/40 bg-accent-500/15 text-accent-300'
                    : 'border-dark-800 bg-dark-900 text-dark-400 hover:border-dark-700 hover:text-dark-200'
                }`}
              >
                {v / 1024}k
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <input
              type="number" min={8_000} max={1_048_576} step={1024}
              value={windowTokens}
              onChange={e => setWindowTokens(Math.max(8_000, Number(e.target.value) || 8_000))}
              className="w-full rounded-md border border-dark-800 bg-dark-900 px-2 py-1 text-[11px] tabular-nums text-dark-200 outline-none transition-colors focus:border-accent-500/50"
            />
            <span className="shrink-0 text-[10px] text-dark-600">自定义</span>
          </div>
        </section>

        {/* 预算 */}
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-[11px] font-medium text-dark-300">上下文预算</label>
            <span className={`tabular-nums text-[10px] ${invalid ? 'text-yellow-500' : 'text-dark-500'}`}>
              {formatTokens(clampedBudget)} / {formatTokens(windowTokens)}
            </span>
          </div>
          <input
            type="range" min={4_000} max={maxBudget} step={1024}
            value={clampedBudget}
            onChange={e => setBudgetTokens(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-dark-800 accent-accent-500
              [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent-500
              [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(20,184,166,0.18)]"
          />
          <div className="mt-1 flex items-center justify-between text-[10px]">
            <span className="text-dark-600">占窗口 {Math.round(budgetPct)}%</span>
            <span className={invalid ? 'text-yellow-500' : 'text-dark-600'}>
              {invalid
                ? `超出窗口，将按 ${formatTokens(maxBudget)} 保存`
                : `${Math.round(compactAt * 100)}% 用量触发压缩`}
            </span>
          </div>
        </section>

        {/* 压缩 */}
        <section>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-[11px] font-medium text-dark-300">自动压缩历史</label>
              <p className="mt-0.5 text-[10px] text-dark-600">关闭后超预算会直接中断任务</p>
            </div>
            <button
              type="button"
              onClick={() => setAutoCompact(v => !v)}
              className="relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none"
              style={{ background: autoCompact ? 'rgb(20 184 166)' : '#374151' }}
              aria-pressed={autoCompact}
            >
              <span
                className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all"
                style={{ transform: autoCompact ? 'translateX(18px)' : 'translateX(2px)' }}
              />
            </button>
          </div>
          {autoCompact && (
            <div className="mt-2 flex items-center gap-1">
              {THRESHOLD_PRESETS.map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setCompactAt(v)}
                  className={`flex-1 rounded-md border py-1 text-[10px] tabular-nums transition-all ${
                    Math.abs(compactAt - v) < 0.001
                      ? 'border-accent-500/40 bg-accent-500/15 text-accent-300'
                      : 'border-dark-800 text-dark-400 hover:border-dark-700 hover:text-dark-200'
                  }`}
                >
                  {Math.round(v * 100)}%
                </button>
              ))}
            </div>
          )}
        </section>

        {/* 运行上限 */}
        <section>
          <label className="text-[11px] font-medium text-dark-300">单次任务上限</label>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            <div className="flex items-center gap-1 rounded-md border border-dark-800 bg-dark-900 px-2 py-1">
              <input
                type="number" min={1} max={200} value={maxRounds}
                onChange={e => setMaxRounds(Math.max(1, Number(e.target.value) || 1))}
                className="w-full bg-transparent text-[11px] tabular-nums text-dark-200 outline-none"
              />
              <span className="shrink-0 text-[10px] text-dark-600">轮</span>
            </div>
            <div className="flex items-center gap-1 rounded-md border border-dark-800 bg-dark-900 px-2 py-1">
              <input
                type="number" min={1} max={120} value={maxMinutes}
                onChange={e => setMaxMinutes(Math.max(1, Number(e.target.value) || 1))}
                className="w-full bg-transparent text-[11px] tabular-nums text-dark-200 outline-none"
              />
              <span className="shrink-0 text-[10px] text-dark-600">分钟</span>
            </div>
          </div>
        </section>

        {/* 当前生效摘要 */}
        <div className="rounded-lg border border-dark-800/70 bg-dark-900/60 px-2.5 py-2 text-[10px] leading-relaxed text-dark-500">
          <span className="text-dark-400">当前生效：</span>
          窗口 {formatTokens(config.windowTokens)} · 预算 {formatTokens(config.budgetTokens)}
          {' · '}压缩 {Math.round((config.compactAt ?? 0.85) * 100)}%
          {' · '}{config.maxRounds ?? 30} 轮 · {formatDuration(config.maxWallMs ?? 600_000)}
        </div>
      </div>

      {/* 底部操作 */}
      <div className="flex items-center gap-1.5 border-t border-dark-800/80 bg-dark-900/80 px-3 py-2.5">
        <button
          type="button"
          onClick={() => handleApply(false)}
          disabled={saving}
          className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-accent-500 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-50"
        >
          <Check className="h-3 w-3" />应用到本会话
        </button>
        <button
          type="button"
          onClick={() => handleApply(true)}
          disabled={saving}
          title="写入设置页，之后新建的会话都用这套"
          className="flex items-center gap-1 rounded-lg border border-dark-700 px-2.5 py-1.5 text-[11px] text-dark-300 transition-colors hover:border-dark-600 hover:text-dark-100 disabled:opacity-50"
        >
          <Sparkles className="h-3 w-3" />存为默认
        </button>
        <button
          type="button"
          onClick={onReset}
          title="清除本会话覆盖，回到全局设置"
          className="rounded-lg p-1.5 text-dark-500 transition-colors hover:bg-dark-800 hover:text-dark-300"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
