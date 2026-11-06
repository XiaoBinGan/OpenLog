/**
 * 区块：主动分析（总开关 + 多日志服务源列表）
 *
 * 负责什么：
 *   - 「主动分析」总开关（settings.autoAnalysis）
 *   - 日志服务源卡片列表：增删、改名、改目录/文件模式、单源启停开关
 *
 * 为什么不放在父组件：
 *   源列表数组（watchSources）确实要留在父组件（保存时和 dockerSources 一起 PUT），但本区块
 *   需要的是「增一条 / 删一条 / 改第 idx 条的某个字段」这三种动作。父组件把数组 + 两个
 *   setter 下发即可，卡片里那一整套 100 行 JSX 不再参与父组件重渲染。
 */
import { memo } from 'react';
import { Brain, Plus, X } from 'lucide-react';
import type { Settings as SettingsType, WatchSource } from '../../types';
import Toggle from '../../components/Toggle';

export interface WatchSourcesSectionProps {
  autoAnalysis: boolean;
  watchSources: WatchSource[];
  onPatch: (patch: Partial<SettingsType>) => void;
  onDirty: () => void;
}

function WatchSourcesSection({ autoAnalysis, watchSources, onPatch, onDirty }: WatchSourcesSectionProps) {
  const sources = watchSources || [];

  const updateSource = (idx: number, patch: Partial<WatchSource>) => {
    const updated = [...sources];
    updated[idx] = { ...sources[idx], ...patch };
    onPatch({ watchSources: updated });
    onDirty();
  };

  return (
    <div className="glass rounded-xl p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent-500/20">
            <Brain className="w-5 h-5 text-accent-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-dark-100">主动分析</h2>
            <p className="text-xs text-dark-500">ERROR 日志出现时自动调用 AI 诊断</p>
          </div>
        </div>

        {/* Master Toggle */}
        <Toggle
          checked={autoAnalysis}
          onChange={next => { onPatch({ autoAnalysis: next }); onDirty(); }}
          size="lg"
          color="#10b981"
          ring="focus:ring-2 focus:ring-accent-500/50"
          aria-label="主动分析"
        />
      </div>

      {/* Multi-service sources */}
      {autoAnalysis && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-dark-400 uppercase tracking-wider">日志服务</span>
            <button
              onClick={() => {
                const id = `svc-${Date.now()}`;
                onPatch({
                  watchSources: [
                    ...sources,
                    { id, name: `服务${sources.length + 1}`, path: '', pattern: '*.log', enabled: true, autoAnalysis: true }
                  ]
                });
                onDirty();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-500/15 text-accent-400 text-xs font-medium hover:bg-accent-500/25 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              添加服务
            </button>
          </div>

          <div className="space-y-2">
            {sources.map((src, idx) => (
              <div
                key={src.id}
                className={`relative rounded-xl border transition-all duration-200 overflow-hidden ${
                  src.enabled
                    ? 'border-dark-700 bg-dark-900/80'
                    : 'border-dark-800/50 bg-dark-900/40 opacity-60'
                }`}
              >
                {/* Card header */}
                <div className="flex items-center gap-3 px-4 py-3">
                  {/* Status dot */}
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${src.enabled ? 'bg-green-400' : 'bg-dark-600'}`} />

                  {/* Service name */}
                  <input
                    type="text"
                    value={src.name}
                    onChange={e => updateSource(idx, { name: e.target.value })}
                    placeholder="服务名称"
                    className="flex-1 bg-transparent text-sm font-medium text-dark-100 placeholder-dark-600 focus:outline-none"
                  />

                  {/* Analysis badge */}
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${
                    src.autoAnalysis && src.enabled
                      ? 'border-accent-500/30 bg-accent-500/10 text-accent-400'
                      : 'border-dark-700 bg-dark-800 text-dark-500'
                  }`}>
                    {src.autoAnalysis && src.enabled ? 'AI 分析' : '已关闭'}
                  </span>

                  {/* Toggle */}
                  <Toggle
                    checked={src.enabled}
                    onChange={next => updateSource(idx, { enabled: next })}
                    size="sm"
                    color="#10b981"
                    aria-label={`${src.name || '日志服务'} 启用`}
                  />

                  {/* Delete */}
                  {sources.length > 1 && (
                    <button
                      onClick={() => {
                        const updated = sources.filter((_, i) => i !== idx);
                        onPatch({ watchSources: updated });
                        onDirty();
                      }}
                      className="p-1 rounded text-dark-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Card body */}
                <div className="grid grid-cols-2 gap-2 px-4 pb-3">
                  <div>
                    <p className="text-xs text-dark-600 mb-1">日志目录</p>
                    <input
                      type="text"
                      value={src.path}
                      onChange={e => updateSource(idx, { path: e.target.value })}
                      placeholder="~/logs"
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50 transition-colors"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-dark-600 mb-1">文件模式</p>
                    <input
                      type="text"
                      value={src.pattern}
                      onChange={e => updateSource(idx, { pattern: e.target.value })}
                      placeholder="*.log"
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50 transition-colors"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(WatchSourcesSection);