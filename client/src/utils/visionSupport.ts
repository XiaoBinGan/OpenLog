/**
 * 视觉能力的界面文案（纯函数，可被 vitest 覆盖）。
 *
 * 后端探测返回三态：yes / no / unknown。界面必须区分对待：
 *   yes     → 不提示（正常）
 *   no      → 强提示：这个模型根本不看图片，发了也白发
 *   unknown → 弱提示：可能不支持，发出去如果失败会明确告诉你原因
 *
 * 为什么不把 unknown 当 no：超时/限流/模型答非所问都可能触发 unknown，
 * 直接拦住用户会比不拦更烦人。
 */

export type VisionSupport = 'yes' | 'no' | 'unknown';

export interface VisionProbeResult {
  supported?: VisionSupport | string;
  reason?: string;
  detail?: string;
  model?: string;
  baseUrl?: string;
  cached?: boolean;
}

export interface VisionHint {
  /** none = 不提示；warn = 可能不支持；block = 明确不支持 */
  level: 'none' | 'warn' | 'block';
  text: string;
}

/** 把探测结果翻译成界面提示 */
export function describeVision(result: VisionProbeResult | null | undefined): VisionHint {
  if (!result) return { level: 'none', text: '' };
  const model = String(result.model || '当前模型');
  if (result.supported === 'yes') return { level: 'none', text: '' };
  if (result.supported === 'no') {
    return {
      level: 'block',
      text: `${model} 不支持图片输入，图片会被引擎拒绝。请到设置里换成支持视觉的模型，或去掉图片后重试。`,
    };
  }
  // unknown：如实说是「没测出来」，不说成「不支持」
  const why = String(result.reason || '').trim();
  return {
    level: 'warn',
    text: `无法确认 ${model} 是否支持图片${why ? `（${why}）` : ''}。可以先发，如果引擎不支持会明确提示。`,
  };
}

/** 探测是否值得显示提示（只有选了图时才有意义） */
export function shouldHint(imageCount: number): boolean {
  return Number(imageCount) > 0;
}

/**
 * 探测结论是否可以复用。
 * 后端已带缓存，这里只处理「换了模型就该重新问」的判断。
 */
export function shouldRefetch(prev: VisionProbeResult | null, model: string, baseUrl?: string): boolean {
  if (!prev) return true;
  // 上次没记录模型：不知道那份结论属于谁，不能拿来用（否则会把 A 模型的结论套到 B 上）
  if (!prev.model) return true;
  if (prev.model !== model) return true;
  if (baseUrl && prev.baseUrl && prev.baseUrl !== baseUrl) return true;
  return false;
}
