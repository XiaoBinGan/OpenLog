/**
 * 区块：告警规则配置（按机器一行，关键词 / 严重级别 / 冷却 / Webhook + 保存）
 *
 * 负责什么：
 *   - 自己拉 /api/remote/servers（机器列表）和 /api/alerts（已有规则）
 *   - 本地编辑 alertConfigs 草稿，保存时逐机器 PUT /api/alerts（Promise.allSettled）
 *
 * 为什么不放在父组件：
 *   这一块和 settings 完全无关——它既不在「保存设置」的 PUT payload 里，也不需要全局脏标记。
 *   以前它占着父组件的 3 个 state（machines / alertConfigs / alertSaving）和 2 个 60 行函数，
 *   现在整块独立，父组件里一个字都不用改就能让它单独重渲染。
 */
import { memo, useEffect, useState } from 'react';
import { Bell, Check, RefreshCw, Save } from 'lucide-react';
import { apiFetch, apiJson } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import Toggle from '../../components/Toggle';

function AlertsSection() {
  const toast = useToast();
  const [machines, setMachines] = useState<any[]>([]);
  const [alertConfigs, setAlertConfigs] = useState<any[]>([]);
  const [alertSaving, setAlertSaving] = useState(false);
  const [alertSaved, setAlertSaved] = useState(false);

  useEffect(() => {
    // Load machines from remote servers
    apiFetch<{ servers?: any[] }>('/api/remote/servers')
      .then(data => {
        const servers = (data.servers || []).map((s: any) => ({ id: s.id, name: s.name, host: s.host, type: s.host }));
        setMachines(servers);
      })
      .catch(() => {});

    apiFetch<{ configs?: any[] }>('/api/alerts')
      .then(data => {
        if (data.configs) setAlertConfigs(data.configs);
      })
      .catch(() => {});
  }, []);

  const updateAlertConfig = (machineId: string, field: string, value: any) => {
    setAlertConfigs(prev => {
      const existing = prev.find((c: any) => c.machine_id === machineId);
      if (existing) {
        return prev.map((c: any) => c.machine_id === machineId ? { ...c, [field]: value } : c);
      }
      return [...prev, { machine_id: machineId, enabled: true, patterns: '', severity_filter: 'ERROR', cooldown_minutes: 5, webhook_url: '', [field]: value }];
    });
    setAlertSaved(false);
  };

  const handleSaveAlerts = async () => {
    setAlertSaving(true);
    setAlertSaved(false);
    try {
      // Save each machine's alert config individually
      const promises = machines.map(machine => {
        const cfg = alertConfigs.find((c: any) => c.machine_id === machine.id) || {
          machine_id: machine.id,
          enabled: true,
          patterns: '',
          severity_filter: 'ERROR',
          cooldown_minutes: 5,
          webhook_url: '',
        };
        return apiJson('/api/alerts', 'PUT', {
            machine_id: cfg.machine_id,
            enabled: cfg.enabled,
            patterns: cfg.patterns,
            severity_filter: cfg.severity_filter,
            cooldown_minutes: cfg.cooldown_minutes,
            webhook_url: cfg.webhook_url,
        });
      });

      const results = await Promise.allSettled(promises);
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length === 0) {
        setAlertSaved(true);
        setTimeout(() => setAlertSaved(false), 3000);
        toast.success('告警规则已保存');
      } else {
        toast.error(`${failed.length} 条规则保存失败`);
      }
    } catch {
      toast.error('保存告警规则失败');
    }
    setAlertSaving(false);
  };

  return (
    <div className="glass rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Bell className="w-5 h-5 text-red-400" />
        告警规则配置
      </h2>
      <p className="text-sm text-dark-400 mb-4">为每个机器配置日志告警规则，检测到异常关键词时通过 Webhook 推送通知</p>

      {machines.length === 0 ? (
        <div className="text-center py-8 text-dark-600 text-sm">
          暂无机器，请先在「远程服务」中添加机器
        </div>
      ) : (
        <div className="space-y-4">
          {machines.map((machine: any) => {
            const cfg = alertConfigs.find((c: any) => c.machine_id === machine.id) || {
              machine_id: machine.id,
              enabled: true,
              patterns: '',
              severity_filter: 'ERROR',
              cooldown_minutes: 5,
              webhook_url: '',
            };
            return (
              <div
                key={machine.id}
                className={`rounded-xl border transition-all duration-200 ${
                  cfg.enabled ? 'border-dark-700 bg-dark-900/80' : 'border-dark-800/50 bg-dark-900/40 opacity-60'
                }`}
              >
                {/* Card header */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-dark-800">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.enabled ? 'bg-red-400' : 'bg-dark-600'}`} />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-dark-100">{machine.name}</p>
                    <p className="text-xs text-dark-500">{machine.host}{machine.type === 'docker' ? ' (Docker)' : ''}</p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${
                    cfg.enabled
                      ? 'border-red-500/30 bg-red-500/10 text-red-400'
                      : 'border-dark-700 bg-dark-800 text-dark-500'
                  }`}>
                    {cfg.enabled ? '告警中' : '已关闭'}
                  </span>
                  <Toggle
                    checked={cfg.enabled}
                    onChange={() => updateAlertConfig(machine.id, 'enabled', cfg.enabled ? 0 : 1)}
                    size="sm"
                    color="#ef4444"
                    aria-label={`${machine.host} 告警`}
                  />
                </div>

                {/* Card body */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 px-4 py-3">
                  {/* 异常关键词 */}
                  <div>
                    <p className="text-xs text-dark-600 mb-1">异常关键词（逗号分隔）</p>
                    <input
                      type="text"
                      value={cfg.patterns}
                      onChange={e => updateAlertConfig(machine.id, 'patterns', e.target.value)}
                      placeholder="OutOfMemory, timeout, 500, panic"
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-red-500/50 transition-colors"
                    />
                  </div>

                  {/* 严重级别筛选 */}
                  <div>
                    <p className="text-xs text-dark-600 mb-1">严重级别筛选</p>
                    <select
                      value={cfg.severity_filter}
                      onChange={e => updateAlertConfig(machine.id, 'severity_filter', e.target.value)}
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 focus:outline-none focus:border-red-500/50 transition-colors"
                    >
                      <option value="ERROR">ERROR</option>
                      <option value="FATAL">FATAL</option>
                      <option value="WARN">WARN</option>
                      <option value="ERROR,FATAL">ERROR + FATAL</option>
                      <option value="ERROR,WARN">ERROR + WARN</option>
                      <option value="ALL">全部级别</option>
                    </select>
                  </div>

                  {/* 冷却时间 */}
                  <div>
                    <p className="text-xs text-dark-600 mb-1">冷却时间（分钟）</p>
                    <select
                      value={cfg.cooldown_minutes}
                      onChange={e => updateAlertConfig(machine.id, 'cooldown_minutes', parseInt(e.target.value))}
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 focus:outline-none focus:border-red-500/50 transition-colors"
                    >
                      <option value={1}>1 分钟</option>
                      <option value={5}>5 分钟</option>
                      <option value={10}>10 分钟</option>
                      <option value={30}>30 分钟</option>
                      <option value={60}>1 小时</option>
                    </select>
                  </div>

                  {/* Webhook URL */}
                  <div>
                    <p className="text-xs text-dark-600 mb-1">Webhook URL</p>
                    <input
                      type="text"
                      value={cfg.webhook_url}
                      onChange={e => updateAlertConfig(machine.id, 'webhook_url', e.target.value)}
                      placeholder="https://hooks.slack.com/... 或 钉钉/飞书 Webhook"
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-red-500/50 transition-colors"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {machines.length > 0 && (
        <div className="flex justify-end mt-4">
          {alertSaved && (
            <div className="flex items-center gap-2 text-green-400 mr-4">
              <Check className="w-4 h-4" />
              已保存
            </div>
          )}
          <button
            onClick={handleSaveAlerts}
            disabled={alertSaving}
            className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/30 transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {alertSaving ? (
              <><RefreshCw className="w-4 h-4 animate-spin" />保存中...</>
            ) : (
              <><Save className="w-4 h-4" />保存告警规则</>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(AlertsSection);