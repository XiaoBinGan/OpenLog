/**
 * 区块：日志监控配置（日志目录 / 检测到的文件 / 监控文件模式 / 刷新间隔）
 *
 * 负责什么：
 *   - 渲染 3 个日志字段；「检测到的文件」快捷按钮会反推目录写回 logPath
 *   - 自己拉 /api/logs/files（只在这块用得到，父组件不再为它保存一份 state）
 *
 * 为什么不放在父组件：
 *   logFiles 这个数组全站只有这一处消费；把它和请求一起搬进来，父组件少一个 state +
 *   一段分支，别处（Docker / 告警 / MFU）的输入也不会让它重画。
 */
import { memo, useEffect, useState } from 'react';
import { Folder } from 'lucide-react';
import { apiFetch } from '../../api/client';
import type { Settings as SettingsType } from '../../types';

export interface LogSettingsSectionProps {
  logPath: string;
  watchFiles: string;
  refreshInterval: string;
  onPatch: (patch: Partial<SettingsType>) => void;
  onDirty: () => void;
}

function LogSettingsSection({ logPath, watchFiles, refreshInterval, onPatch, onDirty }: LogSettingsSectionProps) {
  const [logFiles, setLogFiles] = useState<{ name: string; path: string; size: number }[]>([]);

  useEffect(() => {
    apiFetch<{ name: string; path: string; size: number }[]>('/api/logs/files')
      .then(data => setLogFiles(data))
      .catch(() => {});
  }, []);

  const patch = (p: Partial<SettingsType>) => { onPatch(p); onDirty(); };

  return (
    <div className="glass rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Folder className="w-5 h-5 text-blue-400" />
        日志监控配置
      </h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm text-dark-400 mb-2">日志目录</label>
          <input
            type="text"
            value={logPath}
            onChange={e => patch({ logPath: e.target.value })}
            placeholder="留空则使用 ~/logs"
            className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500"
          />
          {logFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              <span className="text-xs text-dark-500">检测到的文件：</span>
              {logFiles.slice(0, 5).map((file, idx) => (
                <button
                  key={idx}
                  onClick={() => patch({ logPath: file.path.replace(`/${file.name}`, '') })}
                  className="px-2 py-1 bg-dark-800 rounded text-xs text-dark-400 hover:text-dark-200 transition-colors"
                >
                  {file.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm text-dark-400 mb-2">监控文件模式</label>
          <input
            type="text"
            value={watchFiles}
            onChange={e => patch({ watchFiles: e.target.value })}
            placeholder="*.log"
            className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500"
          />
          <p className="text-xs text-dark-500 mt-1">支持 glob 模式，如 *.log, app*.log</p>
        </div>

        <div>
          <label className="block text-sm text-dark-400 mb-2">监控刷新间隔</label>
          <select
            value={refreshInterval}
            onChange={e => patch({ refreshInterval: e.target.value })}
            className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 focus:outline-none focus:border-accent-500"
          >
            <option value="2000">2 秒</option>
            <option value="5000">5 秒</option>
            <option value="10000">10 秒</option>
            <option value="30000">30 秒</option>
            <option value="60000">1 分钟</option>
          </select>
        </div>
      </div>
    </div>
  );
}

export default memo(LogSettingsSection);