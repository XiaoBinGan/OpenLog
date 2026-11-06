/**
 * 区块：算力监控 / MFU 数据源（每台远程服务器的 metrics 地址 / 鉴权 key / 参数量 / 进程名 / 口径）
 *
 * 负责什么：
 *   - 自己拉 /api/gpu/configs，本地编辑草稿，保存时 POST /api/gpu/configs
 *   - 每台服务器的 5 个覆盖字段，以及「已保存」态与保存 toast
 *
 * 为什么不放在父组件：
 *   gpuConfigs 与「保存 MFU 数据源」走的是一条独立接口，和「保存设置」的 PUT payload 无关，
 *   所以它不需要父组件的 settings 或 saved 标记。父组件只需要下发 remoteServers（和 Docker
 *   区块共用同一份），本区块自己管 3 个 state 和 60 行逻辑。
 */
import { memo, useEffect, useState } from 'react';
import { Check, Cpu, RefreshCw, Save, Server } from 'lucide-react';
import { apiFetch, apiJson } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';

export interface MfuSectionProps {
  /** 远程服务器列表（与 Docker 区块同源，父组件持有） */
  remoteServers: { id: string; host: string; name: string; port: number }[];
}

function MfuSection({ remoteServers }: MfuSectionProps) {
  const toast = useToast();
  const [gpuConfigs, setGpuConfigs] = useState<any[]>([]);
  const [mfuSaving, setMfuSaving] = useState(false);
  const [mfuSaved, setMfuSaved] = useState(false);

  useEffect(() => {
    apiFetch<{ configs?: any[] }>('/api/gpu/configs')
      .then(data => {
        if (Array.isArray(data.configs)) setGpuConfigs(data.configs);
      })
      .catch(() => {});
  }, []);

  // 读取某台服务器的 MFU 配置（不存在则给默认空配置）
  const mfuConfigFor = (serverId: string) =>
    gpuConfigs.find(c => c && (c.serverId === serverId || c.id === serverId)) || { serverId };

  const updateMfuConfig = (serverId: string, patch: Record<string, unknown>) => {
    setGpuConfigs(prev => {
      const idx = prev.findIndex(c => c && (c.serverId === serverId || c.id === serverId));
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...patch };
        return next;
      }
      return [...prev, { serverId, ...patch }];
    });
    setMfuSaved(false);
  };

  const saveMfuConfigs = async () => {
    setMfuSaving(true);
    try {
      const payload = gpuConfigs.map(c => {
        if (!c || typeof c !== 'object') return c;
        const next = { ...c };
        if (typeof next.apiKey !== 'string' || next.apiKey === '') delete next.apiKey;
        if (next.paramsB === '' || next.paramsB == null) delete next.paramsB;
        else next.paramsB = Number(next.paramsB);
        return next;
      });
      const res = await apiJson<{ configs?: any[] }>('/api/gpu/configs', 'POST', { configs: payload });
      if (Array.isArray(res.configs)) setGpuConfigs(res.configs);
      setMfuSaved(true);
      toast.success('MFU 数据源配置已保存');
    } catch (e: any) {
      toast.error(`保存失败：${e.message}`);
    } finally {
      setMfuSaving(false);
    }
  };

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-center gap-2 mb-2">
        <Cpu className="w-5 h-5 text-accent-500" />
        <h2 className="text-lg font-semibold">算力监控 / MFU 数据源</h2>
      </div>
      <p className="text-sm text-dark-400 mb-4">
        默认自动发现：扫描服务器本机端口的 <code className="text-dark-300">/metrics</code>
        （vLLM / Strata / SGLang / TGI / llama.cpp / 自定义 Prometheus），并自动从容器环境变量里取鉴权 key。
        <span className="text-amber-400"> 服务没有暴露推理指标时，算力监控里不会显示 MFU</span>，只显示利用率/显存/温度。
      </p>
      {remoteServers.length === 0 ? (
        <p className="text-sm text-dark-500">还没有远程服务器。先在「远程服务器」页添加并连接。</p>
      ) : (
        <div className="space-y-3">
          {remoteServers.map(srv => {
            const cfg = mfuConfigFor(srv.id);
            return (
              <div key={srv.id} className="rounded-lg border border-dark-800 bg-dark-900/40 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Server className="w-3.5 h-3.5 text-green-400" />
                  <span className="text-sm font-medium text-dark-200">{srv.name}</span>
                  <span className="text-xs text-dark-500">{srv.host}:{srv.port}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                  <div>
                    <p className="text-xs text-dark-600 mb-1">指标地址（留空=自动发现）</p>
                    <input
                      type="text"
                      value={cfg.metricsUrl || ''}
                      onChange={e => updateMfuConfig(srv.id, { metricsUrl: e.target.value })}
                      placeholder="http://127.0.0.1:8000/metrics"
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-amber-500/50"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-dark-600 mb-1">鉴权 Key（留空=自动/不变）</p>
                    <input
                      type="password"
                      value={cfg.apiKey || ''}
                      onChange={e => updateMfuConfig(srv.id, { apiKey: e.target.value })}
                      placeholder={cfg.apiKey ? '已保存（留空不修改）' : '可选'}
                      autoComplete="off"
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-amber-500/50"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-dark-600 mb-1">激活参数量（B，可选覆盖）</p>
                    <input
                      type="number"
                      min={0}
                      step="0.1"
                      value={cfg.paramsB ?? ''}
                      onChange={e => updateMfuConfig(srv.id, { paramsB: e.target.value })}
                      placeholder="例如 27 / 7.3"
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-amber-500/50"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-dark-600 mb-1" title="用于把 MFU 挂到具体显卡：nvidia-smi 进程名匹配（不区分大小写）。例如 python train_server.py → 填 train_server">
                      引擎进程名（可选，正则）
                    </p>
                    <input
                      type="text"
                      value={cfg.processPattern || ''}
                      onChange={e => updateMfuConfig(srv.id, { processPattern: e.target.value })}
                      placeholder="例如 train_server"
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-amber-500/50"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-dark-600 mb-1">算力口径</p>
                    <select
                      value={cfg.dtype || 'fp16'}
                      onChange={e => updateMfuConfig(srv.id, { dtype: e.target.value })}
                      className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 focus:outline-none focus:border-amber-500/50"
                    >
                      <option value="fp16">FP16/BF16 稠密</option>
                      <option value="fp8">FP8 稠密</option>
                    </select>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="flex items-center justify-end gap-4 mt-2">
            {mfuSaved && (
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <Check className="w-4 h-4" />
                已保存
              </div>
            )}
            <button
              onClick={saveMfuConfigs}
              disabled={mfuSaving}
              className="px-4 py-2 rounded-lg bg-amber-500/20 text-amber-400 text-sm font-medium hover:bg-amber-500/30 transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              {mfuSaving ? (
                <><RefreshCw className="w-4 h-4 animate-spin" />保存中...</>
              ) : (
                <><Save className="w-4 h-4" />保存 MFU 数据源</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(MfuSection);