/**
 * 区块：单个 Docker 数据源的「连接字段」网格（SSH / TCP / Socket 三种模式 + 主机下拉 + TLS + AI 分析）
 *
 * 负责什么：
 *   - 只渲染 ds 的连接参数区（4 列网格），并把每次改动通过 update(patch) 交给上层卡片
 *   - 主机地址的远程服务器下拉（受控展开态由卡片持有，组件本身无 state）
 *
 * 为什么不放在父组件：
 *   这段 JSX 有 8 个分支组合（via/非 via × 有无远程服务器 × socketPath 是否启用），
 *   却只依赖「当前这一条 dockerSource」。抽出来之后，Docker 卡片能压到 130 行以内，
 *   卡片本身再用 React.memo 兜住，其它 source 的输入不会牵连它。
 */
import { memo } from 'react';
import { ChevronDown, Server } from 'lucide-react';
import type { DockerSource } from '../../types';

export interface DockerSourceFieldsProps {
  ds: DockerSource;
  /** 远程服务器下拉数据（形状与父组件 Settings.remoteServers 保持一致） */
  remoteServers: { id: string; host: string; name: string; port: number }[];
  /** 写入当前 source 的若干字段 */
  update: (patch: Partial<DockerSource>) => void;
  hostDropdownOpen: boolean;
  setHostDropdownOpen: (open: boolean) => void;
}

function DockerSourceFields({
  ds,
  remoteServers,
  update,
  hostDropdownOpen,
  setHostDropdownOpen,
}: DockerSourceFieldsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
      {ds.via?.serverId ? (
        <>
          <div>
            <p className="text-xs text-dark-600 mb-1">SSH 服务器</p>
            <select
              value={ds.via?.serverId || ''}
              onChange={e => update({ via: { serverId: e.target.value, socketPath: ds.via?.socketPath || '/var/run/docker.sock' } })}
              className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 focus:outline-none focus:border-amber-500/50"
            >
              <option value="">选择服务器…</option>
              {remoteServers.map(srv => (
                <option key={srv.id} value={srv.id}>{srv.name}（{srv.host}:{srv.port}）</option>
              ))}
            </select>
            {remoteServers.length === 0 && (
              <p className="text-[10px] text-red-400 mt-1">请先在「远程服务器」页添加一台 SSH 服务器</p>
            )}
          </div>
          <div>
            <p className="text-xs text-dark-600 mb-1">远端 Docker Socket</p>
            <input
              type="text"
              value={ds.via?.socketPath || '/var/run/docker.sock'}
              onChange={e => update({ via: { serverId: ds.via?.serverId || '', socketPath: e.target.value } })}
              placeholder="/var/run/docker.sock"
              className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-amber-500/50"
            />
            <p className="text-[10px] text-dark-600 mt-1">走 SSH 通道访问 docker.sock，无需暴露 2375</p>
          </div>
        </>
      ) : (
        <>
          <div className="relative">
            <p className="text-xs text-dark-600 mb-1">主机地址</p>
            {!ds.socketPath && remoteServers.length > 0 ? (
              <div className="relative">
                <div className="flex items-center">
                  <input
                    type="text"
                    value={ds.host}
                    onChange={e => update({ host: e.target.value })}
                    onFocus={() => setHostDropdownOpen(true)}
                    onBlur={() => setTimeout(() => setHostDropdownOpen(false), 150)}
                    placeholder="localhost / 192.168.1.100"
                    className="w-full pl-2.5 pr-7 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                  />
                  <button
                    type="button"
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={() => setHostDropdownOpen(!hostDropdownOpen)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-dark-500 hover:text-dark-300 rounded"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </div>
                {hostDropdownOpen && (
                  <div className="absolute z-50 mt-1 w-full bg-dark-800 border border-dark-700 rounded-lg shadow-xl max-h-36 overflow-y-auto">
                    {/* 手动输入选项 */}
                    <div className="px-3 py-1.5 border-b border-dark-700/50">
                      <span className="text-[10px] text-dark-500 uppercase tracking-wider">手动输入</span>
                    </div>
                    {remoteServers
                      .filter(s => s.host.toLowerCase().includes(ds.host?.toLowerCase() || '') || !ds.host)
                      .map((s, i) => (
                        <button
                          key={i}
                          type="button"
                          onMouseDown={e => {
                            e.preventDefault();
                            update({ host: s.host, port: 2375 });
                            setHostDropdownOpen(false);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-dark-300 hover:bg-dark-700 hover:text-dark-100 transition-colors text-left"
                        >
                          <Server className="w-3 h-3 text-dark-500 flex-shrink-0" />
                          <span className="text-dark-400 flex-shrink-0">{s.name}</span>
                          <span className="text-dark-200 font-mono text-[11px]">{s.host}</span>
                          <span className="text-dark-600 text-[10px] ml-auto">SSH:{s.port}</span>
                        </button>
                      ))}
                    {remoteServers.filter(s => s.host.toLowerCase().includes(ds.host?.toLowerCase() || '') || !ds.host).length === 0 && (
                      <div className="px-3 py-2 text-xs text-dark-600">无匹配服务器</div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <input
                type="text"
                value={ds.host}
                onChange={e => update({ host: e.target.value })}
                placeholder={ds.socketPath ? '已使用 Socket 连接' : 'localhost / 192.168.1.100'}
                disabled={!!ds.socketPath}
                className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-blue-500/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              />
            )}
          </div>
          <div>
            <p className="text-xs text-dark-600 mb-1">端口</p>
            <input
              type="number"
              value={ds.port}
              onChange={e => update({ port: parseInt(e.target.value) || 2375 })}
              placeholder="2375"
              className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-blue-500/50 transition-colors"
            />
          </div>
          <div>
            <p className="text-xs text-dark-600 mb-1">TLS 加密</p>
            <button
              onClick={() => update({ tls: !ds.tls })}
              className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-left transition-colors flex items-center justify-between"
            >
              <span className={ds.tls ? 'text-green-400' : 'text-dark-500'}>{ds.tls ? '已启用' : '未启用'}</span>
              <div className={`w-8 h-4 rounded-full transition-colors ${ds.tls ? 'bg-blue-500' : 'bg-dark-700'}`}
                onClick={() => {}}
              >
                <div className={`w-3 h-3 rounded-full bg-white m-0.5 transition-transform ${ds.tls ? 'translate-x-4' : ''}`} />
              </div>
            </button>
          </div>
        </>
      )}
      <div>
        <p className="text-xs text-dark-600 mb-1">AI 分析</p>
        <button
          onClick={() => update({ autoAnalysis: !ds.autoAnalysis })}
          className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-left"
        >
          <span className={ds.autoAnalysis ? 'text-blue-400' : 'text-dark-500'}>
            {ds.autoAnalysis ? '✅ 开启' : '⏸ 关闭'}
          </span>
        </button>
      </div>
    </div>
  );
}

export default memo(DockerSourceFields);