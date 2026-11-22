/**
 * 演示模式横幅（琥珀色）。
 *
 * 数据源：`GET /api/demo` → `{ demo: boolean }`，走 hooks/useDemoMode 的共享缓存，
 * 因此与各页面的「只读适配」读的是同一份状态，不会出现「横幅说在演示、
 * 按钮却能点」这种自相矛盾。
 *
 * 关闭只在本次会话生效（组件内 useState，不落 localStorage/后端）：
 * 刷新页面会重新出现 —— 免得不小心的误关让人以为连的是真实机器。
 * 请求失败 / 字段缺失 / 尚未加载完时一律不渲染（静默）。
 */

import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { DEMO_BANNER_TEXT, useDemoMode } from '../hooks/useDemoMode';

export default function DemoBanner() {
  const { demo, loaded } = useDemoMode();
  const [dismissed, setDismissed] = useState(false);

  // 未加载完 + 非演示 + 已关闭：都不渲染（静默，不留空白占位）
  if (!loaded || !demo || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-14 z-20 flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/15 px-4 py-2 text-xs text-amber-200 backdrop-blur"
    >
      <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-400" aria-hidden="true" />
      <span className="min-w-0 flex-1 leading-snug">{DEMO_BANNER_TEXT}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title="关闭横幅（仅本次会话，刷新后重新出现）"
        aria-label="关闭演示模式横幅"
        className="flex-shrink-0 rounded p-1 text-amber-300/80 transition-colors hover:bg-amber-500/20 hover:text-amber-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
