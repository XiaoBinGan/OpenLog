/**
 * 心跳毫秒 → 「（已运行 32s）」。
 *
 * 为什么要单独一个文件：它被组件和测试同时使用，留在组件文件里会触发
 * react-refresh 的「只导出组件」告警（热更新会整页刷新）。
 *
 * 小于 1 秒返回空串：每步刚起步就闪一下「已运行 0s」比不显示更让人怀疑。
 */
export function elapsedText(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1000) return '';
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `（已运行 ${Math.floor(sec / 60)}m${sec % 60}s）` : `（已运行 ${sec}s）`;
}
