/**
 * 区块：容器异常监控（异常退出通知 / 错误日志实时提醒 / 定时巡检）
 *
 * 负责什么：
 *   - 4 个容器监控开关 + 2 个间隔下拉 + 巡检的日志等级多选
 *   - 「有启用的 Docker 数据源才显示」这层门禁留在父组件（它读的是 dockerSources）
 *
 * 为什么不放在父组件：
 *   这里只有 6 个扁平字段，且互相关联（关掉某个开关要收起它下面的子选项）。这些条件渲染
 *   留在 130 行的独立文件里比塞进父组件更好读；父组件每次改别的字段也不会重画它。
 */
import { memo } from 'react';
import { AlertCircle } from 'lucide-react';
import type { Settings as SettingsType } from '../../types';

export interface ContainerMonitorSectionProps {
  dockerEventNotify?: boolean;
  containerLogWatchEnabled?: boolean;
  containerLogWatchInterval?: number;
  containerPatrolEnabled?: boolean;
  containerPatrolInterval?: string;
  containerPatrolLevels?: string[];
  /** 只写 settings，不带 dirty 标记（原实现这几处也没有 setSaved(false)） */
  onPatch: (patch: Partial<SettingsType>) => void;
}

function ContainerMonitorSection({
  dockerEventNotify,
  containerLogWatchEnabled,
  containerLogWatchInterval,
  containerPatrolEnabled,
  containerPatrolInterval,
  containerPatrolLevels,
  onPatch,
}: ContainerMonitorSectionProps) {
  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <AlertCircle className="w-5 h-5 text-accent-500" />
        <h2 className="text-lg font-semibold">容器异常监控</h2>
      </div>

      {/* 异常退出通知 */}
      <div className="mb-4 pb-4 border-b border-dark-800">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">容器异常退出通知</p>
            <p className="text-sm text-dark-400">Docker 容器非正常退出时实时推送通知</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={dockerEventNotify !== false}
              onChange={e => onPatch({ dockerEventNotify: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-10 h-5 bg-dark-700 rounded-full peer peer-checked:bg-accent-500 peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
          </label>
        </div>
      </div>

      {/* 容器日志实时错误提醒 */}
      <div className="mb-4 pb-4 border-b border-dark-800">
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="font-medium">容器错误日志实时提醒</p>
            <p className="text-sm text-dark-400">
              增量 tail 运行中容器的日志，出现 ERROR / FATAL 立刻在页面右下角弹框（含日志原文，可一键跳转日志）
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={containerLogWatchEnabled !== false}
              onChange={e => onPatch({ containerLogWatchEnabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-10 h-5 bg-dark-700 rounded-full peer peer-checked:bg-accent-500 peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
          </label>
        </div>
        {containerLogWatchEnabled !== false && (
          <div className="flex items-center gap-3">
            <label className="text-sm text-dark-400">检查间隔</label>
            <select
              value={String(containerLogWatchInterval ?? 5000)}
              onChange={e => onPatch({ containerLogWatchInterval: Number(e.target.value) })}
              className="px-3 py-1.5 bg-dark-900 border border-dark-700 rounded-lg text-dark-200 text-sm"
            >
              <option value="3000">3 秒</option>
              <option value="5000">5 秒（推荐）</option>
              <option value="10000">10 秒</option>
              <option value="30000">30 秒（省资源）</option>
            </select>
            <span className="text-xs text-dark-600">命中后同一错误 60 秒内不重复弹框</span>
          </div>
        )}
      </div>

      {/* 定时巡检配置 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="font-medium">容器日志巡检</p>
            <p className="text-sm text-dark-400">定时扫描所有运行中容器的日志，匹配配置的异常等级</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={containerPatrolEnabled || false}
              onChange={e => onPatch({ containerPatrolEnabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-10 h-5 bg-dark-700 rounded-full peer peer-checked:bg-accent-500 peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
          </label>
        </div>

        {containerPatrolEnabled && (
          <div className="space-y-3 ml-0">
            <div>
              <label className="block text-sm text-dark-400 mb-1">巡检间隔</label>
              <select
                value={containerPatrolInterval || '300000'}
                onChange={e => onPatch({ containerPatrolInterval: e.target.value })}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-dark-200 text-sm"
              >
                <option value="10000">10 秒（测试）</option>
                <option value="60000">1 分钟</option>
                <option value="300000">5 分钟</option>
                <option value="600000">10 分钟</option>
                <option value="1800000">30 分钟</option>
                <option value="3600000">1 小时</option>
              </select>
            </div>

            <div>
              <label className="block text-sm text-dark-400 mb-1">匹配日志等级</label>
              <div className="flex flex-wrap gap-2">
                {['FATAL','ERROR','WARN','INFO'].map(level => {
                  const selected = (containerPatrolLevels || ['ERROR','FATAL']).includes(level);
                  return (
                    <button
                      key={level}
                      onClick={() => {
                        const current = containerPatrolLevels || ['ERROR','FATAL'];
                        const next = selected ? current.filter(l => l !== level) : [...current, level];
                        onPatch({ containerPatrolLevels: next });
                      }}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                        selected
                          ? level === 'FATAL' ? 'bg-red-500/30 text-red-300 border border-red-500/50'
                          : level === 'ERROR' ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                          : level === 'WARN' ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                          : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                          : 'bg-dark-800 text-dark-500 border border-dark-700'
                      }`}
                    >
                      {level}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ContainerMonitorSection);