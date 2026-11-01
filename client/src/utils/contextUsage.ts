/**
 * 上下文用量与配置的展示逻辑（纯函数，便于单测）。
 *
 * 背景：用户反馈「上下文支持长度有限、配置里看不到怎么改、也不知道用了多少」，
 * 因此需要底部常驻用量条 + 齿轮面板。这里的函数负责：
 *   1. 把 token 数变成人类可读的 "12.3k"
 *   2. 按占用比例给出颜色档位（正常/警告/危险）
 *   3. 判断该不该提示「换会话 / 换更大上下文模型」
 *
 * 为什么要独立成文件：档位边界和提示文案是产品规则，散在 JSX 里既测不到
 * 也容易两处不一致（用量条一个判断、提示气泡另一个判断）。
 */

/** 上下文配置形状（与后端 context-config.js 对齐） */
export interface ContextConfigLike {
  windowTokens: number;
  budgetTokens: number;
  maxOutputTokens?: number;
  autoCompact?: boolean;
  compactAt?: number;
  warnAt?: number;
  maxRounds?: number;
  maxWallMs?: number;
  compactAtTokens?: number;
  warnAtTokens?: number;
}

/** 用量形状（与后端 SSE context_usage 对齐） */
export interface ContextUsageLike {
  used: number;
  budget: number;
  window: number;
  percent: number;
  breakdown?: { system: number; tools: number; messages: number };
  compacted?: number;
  rounds?: number;
  estimated?: boolean;
}

export type UsageLevel = 'normal' | 'warn' | 'critical' | 'over';

export const USAGE_LEVEL_STYLES: Record<UsageLevel, { bar: string; text: string; label: string }> = {
  normal:   { bar: 'bg-emerald-500', text: 'text-emerald-400', label: '正常' },
  warn:     { bar: 'bg-yellow-500',  text: 'text-yellow-400',  label: '偏高' },
  critical: { bar: 'bg-orange-500',  text: 'text-orange-400',  label: '即将压缩' },
  over:     { bar: 'bg-red-500',     text: 'text-red-400',     label: '已超预算' },
};

/** token 数 → 紧凑可读形式（1234 → 1.2k，1234567 → 1.2M） */
export function formatTokens(n: number): string {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) {
    const k = v / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return `${Math.round((v / 1_000_000) * 10) / 10}M`;
}

/**
 * 按占用比例分档。
 * 阈值来自配置（默认 warnAt=0.7、compactAt=0.85），而不是写死 —— 用户在齿轮面板
 * 调整阈值后，颜色和提示必须同步变化。
 */
export function usageLevel(percent: number, config?: Partial<ContextConfigLike>): UsageLevel {
  const warnAt = (config?.warnAt ?? 0.7) * 100;
  const compactAt = (config?.compactAt ?? 0.85) * 100;
  const p = Number(percent) || 0;
  if (p >= 100) return 'over';
  if (p >= compactAt) return 'critical';
  if (p >= warnAt) return 'warn';
  return 'normal';
}

/** 安全计算百分比（budget 为 0 时不产生 NaN/Infinity） */
export function usagePercent(used: number, budget: number): number {
  const b = Number(budget) || 0;
  if (b <= 0) return 0;
  const p = ((Number(used) || 0) / b) * 100;
  return Math.max(0, Math.min(999, Math.round(p * 10) / 10));
}

export interface UsageAdvice {
  /** 是否需要在用量条右侧显示提示 */
  show: boolean;
  level: 'info' | 'warn' | 'critical';
  text: string;
  /** 建议动作：开新会话 / 换模型 / 压缩 */
  action?: 'new_session' | 'switch_model' | 'compact';
  actionLabel?: string;
}

/**
 * 给出建议文案。
 *
 * @param usage 当前用量
 * @param config 生效配置
 * @param opts.dismissed 用户本次会话已关闭过提示（不再打扰）
 */
export function buildUsageAdvice(
  usage: ContextUsageLike | null | undefined,
  config: Partial<ContextConfigLike> | undefined,
  opts: { dismissed?: boolean; modelName?: string } = {},
): UsageAdvice {
  if (!usage || opts.dismissed) return { show: false, level: 'info', text: '' };

  const percent = Number(usage.percent) || 0;
  const budget = Number(usage.budget) || 0;
  const window = Number(usage.window) || 0;
  const level = usageLevel(percent, config);

  // 1) 窗口本身太小：换会话没用，得换模型 —— 这条最容易被忽略，
  //    所以优先于「已用多少」的判断。
  if (window > 0 && window <= 32_768) {
    return {
      show: true,
      level: 'info',
      text: `当前模型窗口只有 ${formatTokens(window)}，长任务容易触发压缩；如需处理大文件/长排查，建议换窗口更大的模型`,
      action: 'switch_model',
      actionLabel: '去设置',
    };
  }

  // 2) 已超预算 / 即将压缩
  if (level === 'over' || level === 'critical') {
    return {
      show: true,
      level: 'critical',
      text: `上下文已用 ${percent}%（${formatTokens(usage.used)} / ${formatTokens(budget)}），继续下去会压缩历史、丢失早期细节`,
      action: 'new_session',
      actionLabel: '开启新会话',
    };
  }

  // 3) 偏高
  if (level === 'warn') {
    return {
      show: true,
      level: 'warn',
      text: `上下文已用 ${percent}%，接近上限。长任务建议先开启新会话`,
      action: 'new_session',
      actionLabel: '开启新会话',
    };
  }

  return { show: false, level: 'info', text: '' };
}

/** 用量条主文案：`12.3k / 48k · 26%` */
export function usageSummary(
  usage: ContextUsageLike | null | undefined,
  opts: { estimatedPrefix?: boolean } = {},
): string {
  if (!usage) return '—';
  const prefix = opts.estimatedPrefix && usage.estimated ? '~' : '';
  return `${prefix}${formatTokens(usage.used)} / ${formatTokens(usage.budget)} · ${Math.round(Number(usage.percent) || 0)}%`;
}

/** hover 明细文案 */
export function usageBreakdownText(usage: ContextUsageLike | null | undefined): string {
  if (!usage) return '';
  const b = usage.breakdown;
  const parts: string[] = [];
  if (b) {
    parts.push(`系统提示 ${formatTokens(b.system)}`);
    parts.push(`工具定义 ${formatTokens(b.tools)}`);
    parts.push(`消息 ${formatTokens(b.messages)}`);
  }
  parts.push(`模型窗口 ${formatTokens(usage.window)}`);
  if (usage.rounds) parts.push(`第 ${usage.rounds} 轮`);
  if (usage.compacted) parts.push(`已压缩 ${usage.compacted} 次`);
  parts.push(usage.estimated ? '（估算值）' : '（引擎实测）');
  return parts.join(' · ');
}

/** 把毫秒时长格式化成「10 分钟」这类文案（齿轮面板用） */
export function formatDuration(ms: number): string {
  const v = Number(ms) || 0;
  if (v < 60_000) return `${Math.round(v / 1000)} 秒`;
  const min = v / 60_000;
  return `${min >= 10 ? Math.round(min) : Math.round(min * 10) / 10} 分钟`;
}

/**
 * 客户端 token 粗估（与后端 estimateTokens 同款启发式：CJK 记 1，ASCII 记 1/3.5）。
 *
 * 为什么要在前端也算一遍：历史消息该发多少条，必须在**发请求之前**就决定，
 * 不能等后端压缩 —— 后端压缩意味着请求已经把超量内容发出去了。
 */
export function estimateTextTokens(text: string): number {
  const s = String(text ?? '');
  if (!s) return 0;
  let wide = 0;
  for (const ch of s) {
    if ((ch.codePointAt(0) || 0) > 0x2e80) wide += 1;
  }
  const narrow = s.length - wide;
  return Math.ceil(wide + narrow / 3.5);
}

/**
 * 从最早的开始丢弃历史，直到估算 token 落进预算。
 *
 * 关键约束：**不能把 tool 消息和它的 assistant(tool_calls) 拆开**
 * （拆开后 OpenAI 兼容接口会直接 400）。所以先按整段（assistant + 后续 tool）切分，
 * 再整段丢弃。
 *
 * @param items 历史消息（旧 → 新）
 * @param tokensOf 单条估算
 * @param budget 预算（token）
 * @returns 保留的消息与丢弃条数
 */
export function trimHistoryToBudget<T>(
  items: T[],
  tokensOf: (item: T) => number,
  budget: number,
): { kept: T[]; droppedCount: number; usedTokens: number } {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(0, Number(budget) || 0);

  // 从新往旧累加，超预算就停（保留最近的部分）
  const keepFromEnd: T[] = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = tokensOf(list[i]);
    if (used + t > limit && keepFromEnd.length > 0) break;
    used += t;
    keepFromEnd.push(list[i]);
  }
  const kept = keepFromEnd.reverse();

  // 修正边界：kept 的第一条若是 tool 消息，说明它的父 assistant 被丢了 → 一起丢
  let dropMore = 0;
  while (kept.length > 1 && (kept[0] as any)?.role === 'tool') {
    used -= tokensOf(kept[0]);
    kept.shift();
    dropMore += 1;
  }

  return { kept, droppedCount: list.length - kept.length, usedTokens: used };
}

