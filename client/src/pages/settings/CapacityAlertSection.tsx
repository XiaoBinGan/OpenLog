/**
 * 区块：容量告警（内存 / 磁盘阈值 + 弹窗抑制窗口）
 *
 * 负责什么：4 个扁平字段的编辑 UI。真正「要不要弹」的判定在
 * server/capacity-alerts.js（判超标）+ client/src/utils/capacityAlert.ts（判"关过没有"），
 * 这里只负责让用户改阈值。
 *
 * 为什么阈值可改：90/80 是默认值，不是硬编码的真理。有的机器磁盘天生就该跑到 85%
 * （比如日志盘），硬钉死会让用户天天挨弹窗，最后学会无视它 —— 那比不弹更糟。
 */
import { memo } from 'react';
import { Gauge } from 'lucide-react';
import type { Settings as SettingsType } from '../../types';

export interface CapacityAlertSectionProps {
  capacityAlertEnabled?: boolean;
  capacityAlertMemoryPercent?: number;
  capacityAlertDiskPercent?: number;
  capacityAlertSnoozeMinutes?: number;
  onPatch: (patch: Partial<SettingsType>) => void;
}

function CapacityAlertSection({
  capacityAlertEnabled,
  capacityAlertMemoryPercent,
  capacityAlertDiskPercent,
  capacityAlertSnoozeMinutes,
  onPatch,
}: CapacityAlertSectionProps) {
  const enabled = capacityAlertEnabled !== false;
  const mem = Number(capacityAlertMemoryPercent) > 0 ? Number(capacityAlertMemoryPercent) : 90;
  const disk = Number(capacityAlertDiskPercent) > 0 ? Number(capacityAlertDiskPercent) : 80;
  const snooze = Number(capacityAlertSnoozeMinutes) > 0 ? Number(capacityAlertSnoozeMinutes) : 60;

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Gauge className="w-5 h-5 text-accent-500" />
        <h2 className="text-lg font-semibold">容量告警</h2>
      </div>

      <div className="mb-4 pb-4 border-b border-dark-800">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">内存 / 磁盘超阈值弹窗</p>
            <p className="text-sm text-dark-400">
              超标时弹出**必须手动确认**的对话框，持续显示直到点「我知道了」；关闭后一段时间内不再弹出，到期仍超标会继续提醒
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => onPatch({ capacityAlertEnabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-10 h-5 bg-dark-700 rounded-full peer peer-checked:bg-accent-500 peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
          </label>
        </div>
      </div>

      {enabled && (
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-dark-400">内存阈值</label>
              <span className="text-sm font-mono text-amber-400">{mem}%</span>
            </div>
            <input
              type="range"
              min={50}
              max={99}
              step={1}
              value={mem}
              onChange={e => onPatch({ capacityAlertMemoryPercent: Number(e.target.value) })}
              className="w-full accent-amber-500"
            />
            <p className="text-xs text-dark-600 mt-1">超过该值即告警（≥95% 标为严重）</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-dark-400">磁盘阈值</label>
              <span className="text-sm font-mono text-amber-400">{disk}%</span>
            </div>
            <input
              type="range"
              min={50}
              max={99}
              step={1}
              value={disk}
              onChange={e => onPatch({ capacityAlertDiskPercent: Number(e.target.value) })}
              className="w-full accent-amber-500"
            />
            <p className="text-xs text-dark-600 mt-1">任意一块盘超过该值即告警（≥90% 标为严重）</p>
          </div>

          <div>
            <label className="block text-sm text-dark-400 mb-1">关闭后静默时长</label>
            <select
              value={String(snooze)}
              onChange={e => onPatch({ capacityAlertSnoozeMinutes: Number(e.target.value) })}
              className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-dark-200 text-sm"
            >
              <option value="15">15 分钟</option>
              <option value="30">30 分钟</option>
              <option value="60">1 小时（默认）</option>
              <option value="180">3 小时</option>
              <option value="720">12 小时</option>
            </select>
            <p className="text-xs text-dark-600 mt-1">
              点「我知道了」后在这段时间内不再弹出；到期若仍未恢复会重新弹出
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(CapacityAlertSection);
