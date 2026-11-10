/**
 * CapacityAlertModal —— 容量告警强制确认框（内存 > 90% / 磁盘 > 80%）。
 *
 * 行为约束（来自需求原文）：
 *   · **持续展示在屏幕上**：没有倒计时、没有自动关闭、点遮罩不关、Esc 不关。
 *     只有「我知道了」这一个出口。
 *   · **关闭后 1 小时内不显示**：按告警 key 记在 localStorage，刷新页面也有效。
 *   · **未处理继续弹**：1 小时到点后，只要服务端仍报超标，就重新弹出来。
 *
 * 为什么不用 toast：toast 2 秒就没了。用户正在看别的页面，抬头时早消失了 ——
 * 磁盘要满这种事不能靠"刚好看见"。所以这里做成阻塞式遮罩。
 *
 * 为什么状态放浏览器而不是服务端：服务端无条件如实报告当前是否超标，
 * 抑制逻辑是「这台浏览器上谁在什么时候关过」，多标签页/多用户不该互相影响。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, HardDrive, MemoryStick, ShieldAlert } from 'lucide-react';
import { apiFetch } from '../api/client';
import {
  loadSnoozesFromStorage,
  saveSnoozesToStorage,
  visibleAlerts,
  snoozeAlerts,
  pruneSnoozes,
  snoozeRemainingMinutes,
  hasCritical,
  DEFAULT_SNOOZE_MINUTES,
  type CapacityAlert,
} from '../utils/capacityAlert';

/** 轮询间隔：60 秒。告警是"分钟级"的事，不需要 5 秒一次把机器查出火。 */
const POLL_MS = 60_000;

interface MonitorStatsLite {
  capacityAlerts?: CapacityAlert[];
  capacitySnoozeMinutes?: number;
}

export default function CapacityAlertModal() {
  const [alerts, setAlerts] = useState<CapacityAlert[]>([]);
  const [snoozes, setSnoozes] = useState(() => loadSnoozesFromStorage());
  const [snoozeMinutes, setSnoozeMinutes] = useState(DEFAULT_SNOOZE_MINUTES);
  const [loaded, setLoaded] = useState(false);
  // 每秒重算一次"抑制是否到期"：到点就自动弹出来，不需要等下一轮轮询
  const [, forceTick] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const poll = useCallback(async () => {
    try {
      const data = await apiFetch<MonitorStatsLite>('/api/monitor/stats');
      if (!mountedRef.current) return;
      const list = Array.isArray(data?.capacityAlerts) ? data.capacityAlerts : [];
      setAlerts(list);
      setSnoozeMinutes(
        Number(data?.capacitySnoozeMinutes) > 0
          ? Number(data.capacitySnoozeMinutes)
          : DEFAULT_SNOOZE_MINUTES,
      );
      setLoaded(true);

      // 恢复即遗忘：已经不超标的 key 必须清掉关闭时间戳，
      // 否则下次再超标时会因为"1 小时内关过"而不提醒 —— 那是新的一次故障。
      setSnoozes((prev) => {
        const next = pruneSnoozes(prev, list.map((a) => a.key));
        if (JSON.stringify(next) !== JSON.stringify(prev)) saveSnoozesToStorage(next);
        return next;
      });
    } catch {
      // 拉不到数据就保持现状：不要因为一次网络抖动把已经弹出来的告警收掉
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => { void poll(); }, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // 抑制到点时立刻重弹（否则用户要等最多 60 秒的下一轮轮询）
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(
    () => visibleAlerts(alerts, snoozes, Date.now(), snoozeMinutes),
    [alerts, snoozes, snoozeMinutes],
  );

  const handleAcknowledge = () => {
    const keys = visible.map((a) => a.key);
    if (keys.length === 0) return;
    const next = snoozeAlerts(keys, snoozes, Date.now());
    setSnoozes(next);
    saveSnoozesToStorage(next);
  };

  const critical = hasCritical(visible);
  const remaining = visible.length > 0
    ? Math.min(...visible.map((a) => snoozeRemainingMinutes(a.key, snoozes, Date.now(), snoozeMinutes)))
    : 0;

  if (!loaded || visible.length === 0) return null;

  return (
    /*
     * 遮罩层：z-index 高于通知中心(50)与 AI 分析浮层，确保在最上面。
     * **没有 onClick 关闭** —— 这是刻意的：点外面关不掉，只能点按钮。
     */
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="capacity-alert-title"
    >
      <div
        className={`w-full max-w-lg rounded-2xl border shadow-2xl overflow-hidden ${
          critical
            ? 'border-red-500/40 bg-dark-900'
            : 'border-amber-500/40 bg-dark-900'
        }`}
      >
        {/* 标题区 */}
        <div className={`flex items-start gap-3 px-5 pt-5 pb-3 ${critical ? 'bg-red-500/10' : 'bg-amber-500/10'}`}>
          <div className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${
            critical ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'
          }`}>
            {critical ? <ShieldAlert className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="capacity-alert-title" className={`text-base font-semibold ${critical ? 'text-red-300' : 'text-amber-300'}`}>
              {critical ? '资源即将耗尽，请立即处理' : '资源使用已超过阈值'}
            </h2>
            <p className="mt-0.5 text-xs text-dark-400">
              {critical
                ? '继续下去可能导致服务异常或写入失败。'
                : '建议尽快清理，否则可能影响服务。'}
            </p>
          </div>
        </div>

        {/* 告警明细 */}
        <div className="px-5 py-3 space-y-2 max-h-[45vh] overflow-y-auto">
          {visible.map((a) => (
            <div
              key={a.key}
              className="flex items-start gap-2.5 rounded-xl border border-dark-700/70 bg-dark-800/50 px-3 py-2.5"
            >
              <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-dark-700/60 flex items-center justify-center text-dark-300">
                {a.kind === 'memory'
                  ? <MemoryStick className="w-4 h-4" />
                  : <HardDrive className="w-4 h-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm font-medium text-dark-100">{a.title}</span>
                  <span className={`text-xs font-mono ${a.level === 'critical' ? 'text-red-400' : 'text-amber-400'}`}>
                    {a.percent}% / 阈值 {a.threshold}%
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-dark-500">{a.detail}</div>
                {/* 进度条：直观看出离满还有多少 */}
                <div className="mt-1.5 h-1.5 rounded-full bg-dark-700 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${a.level === 'critical' ? 'bg-red-500' : 'bg-amber-500'}`}
                    style={{ width: `${Math.min(100, Math.max(0, a.percent))}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 操作区 */}
        <div className="px-5 pb-5 pt-2">
          <button
            type="button"
            onClick={handleAcknowledge}
            className={`w-full h-10 rounded-xl text-sm font-medium transition-colors ${
              critical
                ? 'bg-red-500/90 hover:bg-red-500 text-white'
                : 'bg-amber-500/90 hover:bg-amber-500 text-dark-950'
            }`}
          >
            我知道了
          </button>
          <p className="mt-2 text-center text-[11px] text-dark-600">
            关闭后 {snoozeMinutes} 分钟内不再弹出；若届时仍未恢复会再次提醒
            {remaining > 0 ? `（当前 ${remaining} 分钟后到期）` : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
