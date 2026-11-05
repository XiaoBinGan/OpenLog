/**
 * client/src/utils/analysisNotice.ts —— AI 分析结果 → 通知中心条目
 *
 * 背景：AI 分析（ERROR 日志自动分析）之前只在右下角弹一个浮层卡片，**不进通知列表**，
 * 所以它既不能被筛选，也不能被导出（用户明确要求通知中心能导出机器/容器/报错）。
 * 这里把 WS 的 `ai_analysis` 事件转成一条标准通知（纯函数，方便单测）。
 */
import type { NotificationItem } from './notifications';

export interface AiAnalysisEvent {
  status?: 'pending' | 'done' | 'error' | 'skipped';
  sourceId?: string;
  sourceName?: string;
  analysis?: string | null;
  message?: string;
  log?: { source?: string; level?: string; message?: string; timestamp?: string } | null;
  recordId?: string;
}

export interface AnalysisNotice {
  /** 通知类型 */
  type: NotificationItem['type'];
  /** 标题 */
  message: string;
  /** 详情（列表里显示的第二行） */
  description?: string;
  /** 合并键：同一个来源的重复分析只留一条 */
  group: string;
  /** 点通知跳到分析历史 */
  nav: string;
  meta: Pick<NotificationItem, 'sourceId' | 'sourceName' | 'containerName' | 'level' | 'errorType' | 'errorContent'>;
}

/** 从日志来源里取一个可读名字：容器名 / 文件名 / 来源 ID */
export function analysisTargetName(ev: AiAnalysisEvent): string {
  const source = String(ev?.log?.source || '').trim();
  if (source) {
    const base = source.split(/[\\/]/).filter(Boolean).pop() || source;
    return base;
  }
  if (ev?.sourceName) return String(ev.sourceName);
  if (ev?.sourceId) return String(ev.sourceId);
  return '日志';
}

/** 分析正文太长不适合塞进通知（会撑爆 localStorage），超出部分截断并标注 */
export const ANALYSIS_STORE_CHARS = 4000;

export function clipAnalysis(text: string | null | undefined, limit = ANALYSIS_STORE_CHARS): string {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n…（分析内容过长，已截断 ${s.length - limit} 字；完整内容见「分析历史」）`;
}

/**
 * 构造通知条目。pending 不生成（分析开始没必要进列表），
 * done / error / skipped 才生成。
 */
export function buildAnalysisNotice(ev: AiAnalysisEvent): AnalysisNotice | null {
  const status = ev?.status;
  if (status !== 'done' && status !== 'error' && status !== 'skipped') return null;

  const target = analysisTargetName(ev);
  const sourceId = ev?.sourceId || '';
  const level = String(ev?.log?.level || '').toUpperCase();
  const logMessage = String(ev?.log?.message || '').trim();
  const analysis = clipAnalysis(ev?.analysis);
  const group = `ai-analysis:${sourceId}:${target}`;
  const nav = '/analysis-history';

  const commonMeta = {
    sourceId,
    sourceName: ev?.sourceName || sourceId,
    containerName: target,
    level: level || 'ERROR',
    errorType: 'AI 分析',
  };

  if (status === 'done') {
    const firstLine = analysis.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
    return {
      type: 'info',
      message: `🤖 ${target} AI 分析完成`,
      description: (firstLine || logMessage || '已生成分析结果').slice(0, 200),
      group,
      nav,
      meta: { ...commonMeta, errorContent: analysis || logMessage },
    };
  }

  if (status === 'error') {
    const msg = String(ev?.message || 'AI 分析失败').trim();
    return {
      type: 'error',
      message: `❌ ${target} AI 分析失败`,
      description: msg.slice(0, 200),
      group,
      nav,
      meta: { ...commonMeta, errorContent: `${msg}${logMessage ? `\n原始日志：${logMessage}` : ''}` },
    };
  }

  // skipped：通常是没配 LLM / 没配模型
  const msg = String(ev?.message || '已跳过分析').trim();
  return {
    type: 'warning',
    message: `⚠️ ${target} 跳过 AI 分析`,
    description: msg.slice(0, 200),
    group,
    nav,
    meta: { ...commonMeta, errorContent: `${msg}${logMessage ? `\n原始日志：${logMessage}` : ''}` },
  };
}
