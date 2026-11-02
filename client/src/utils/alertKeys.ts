/**
 * client/src/utils/alertKeys.ts — 告警 toast 的去重键
 *
 * 用户反馈：「已经报过错的容器，在没点清除之前不该再弹新的相关弹窗」。
 * 之前退出 / 巡检 / 日志告警各用各的 group（`exit-…`、`patrol-…`、
 * `logalert-…-ERROR`），同一个容器一晚上能堆出好几条；AI 分析 toast 更是
 * 每个 pending/done 都新弹一条。
 *
 * 现在统一成「每个容器一个键」，ToastProvider 按 group 合并成一条
 * （只更新文案），用户点 X 清除后才会再出现新的。
 */

/** 容器级告警键：同一容器的退出/巡检/日志告警共用，避免重复弹 */
export function containerToastGroup(sourceId?: string, containerId?: string, name?: string): string {
  return `container-${sourceId || ''}-${containerId || name || 'unknown'}`;
}

/** AI 分析 toast 键：同一来源/容器只占一条，pending → done 原位更新 */
export function analysisToastKey(data: { sourceId?: string; log?: any } | null | undefined): string {
  const sourceId = data?.sourceId || '';
  const log = data?.log || {};
  const origin = log.containerName || log.source || log.file || 'default';
  return `${sourceId}::${origin}`;
}
