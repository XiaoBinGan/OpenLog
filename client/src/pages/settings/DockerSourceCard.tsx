/**
 * 区块：单个 Docker 数据源卡片（名称 / 启停 / 测试连接 / 三种连接方式 / 容器内日志路径）
 *
 * 负责什么：
 *   - 一条 dockerSource 的全部渲染与交互，包括它自己的「测试连接」按钮的三种视觉态
 *   - 连接方式按钮（Socket / TCP / SSH）对 ds 的整体切换
 *   - 容器内日志路径的增删（回车添加的自控 input）
 *
 * 为什么不放在父组件：
 *   一张卡片 ~130 行、有多处「改字段 → 重算整个数组」的写法。放在父组件里意味着任何一次
 *   输入都要重跑整页（含下面 140 行静态文档）。拆出来 + React.memo 之后，改 A 卡的名称只会
 *   让 A 卡重渲染；B/C 卡的 props 身份没变（容器里那几个回调都用 useCallback 固定），直接跳过。
 *   测试状态（testing/ok/fail + 文案）也留在外层容器按 id 索引，卡片只消费当前 id 那一条。
 */
import { memo } from 'react';
import { X } from 'lucide-react';
import type { DockerSource } from '../../types';
import Toggle from '../../components/Toggle';
import DockerSourceFields from './DockerSourceFields';
import DockerHelpSection from './DockerHelpSection';

export interface DockerSourceCardProps {
  ds: DockerSource;
  idx: number;
  /** 当前 source 总数：只剩 1 条时不允许删除 */
  count: number;
  remoteServers: { id: string; host: string; name: string; port: number }[];
  update: (idx: number, patch: Partial<DockerSource>) => void;
  remove: (idx: number) => void;
  onTest: (ds: DockerSource) => void;
  testStatus?: 'testing' | 'ok' | 'fail';
  testMsg?: string;
  openedHost: boolean;
  setOpenedHost: (id: string, open: boolean) => void;
}

function DockerSourceCard({
  ds,
  idx,
  count,
  remoteServers,
  update,
  remove,
  onTest,
  testStatus,
  testMsg,
  openedHost,
  setOpenedHost,
}: DockerSourceCardProps) {
  const updateDs = (patch: Partial<DockerSource>) => update(idx, patch);

  return (
    <div className="rounded-xl border border-dark-800 bg-dark-900/60 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-dark-800">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${ds.enabled ? 'bg-blue-400' : 'bg-dark-600'}`} />
        <input
          type="text"
          value={ds.name}
          onChange={e => updateDs({ name: e.target.value })}
          className="flex-1 bg-transparent text-sm font-medium text-dark-100 border-b border-transparent hover:border-dark-600 focus:border-blue-500 focus:outline-none py-0.5 transition-colors"
          placeholder="输入名称..."
        />
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded border ${
            ds.autoAnalysis && ds.enabled
              ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
              : 'border-dark-700 bg-dark-800 text-dark-500'
          }`}>
            {ds.autoAnalysis && ds.enabled ? 'AI 分析' : '已关闭'}
          </span>
          <Toggle
            checked={ds.enabled}
            onChange={next => updateDs({ enabled: next })}
            size="sm"
            color="#3b82f6"
            aria-label={`${ds.name || 'Docker 数据源'} 启用`}
          />
          {count > 1 && (
            <button
              onClick={() => remove(idx)}
              className="p-1 rounded text-dark-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {/* 测试 Docker 连接 */}
          <button
            onClick={() => onTest(ds)}
            disabled={testStatus === 'testing'}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1 ${
              testStatus === 'ok'
                ? 'bg-green-500/20 border-green-500/50 text-green-400'
                : testStatus === 'fail'
                ? 'bg-red-500/20 border-red-500/50 text-red-400'
                : 'bg-dark-800/40 border-dark-700/50 text-dark-400 hover:border-blue-500/50 hover:text-blue-400'
            }`}
          >
            {testStatus === 'testing' ? '⏳' : testStatus === 'ok' ? '✅' : testStatus === 'fail' ? '❌' : '🔌'}
            {testStatus === 'testing' ? '连接中...' : '测试连接'}
          </button>
        </div>
      </div>

      {/* 测试结果 */}
      {testMsg && (
        <div className={`mx-4 mb-2 px-3 py-2 rounded-lg text-xs ${
          testStatus === 'ok' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
        }`}>
          {testMsg}
        </div>
      )}

      {/* 连接方式选择 */}
      <div className="px-4 py-2 border-b border-dark-800 bg-dark-900/40">
        <div className="flex gap-2 mb-2">
          <button
            type="button"
            onClick={() => updateDs({ socketPath: '/var/run/docker.sock', host: '', port: 0, via: undefined })}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              ds.socketPath && !ds.via?.serverId
                ? 'bg-green-500/20 border-green-500/50 text-green-400'
                : 'bg-dark-800/40 border-dark-700/50 text-dark-400 hover:border-dark-600'
            }`}
          >
            🍎 macOS Socket
          </button>
          <button
            type="button"
            onClick={() => updateDs({ socketPath: '', host: 'localhost', port: 2375, via: undefined })}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              !ds.socketPath && !ds.via?.serverId && ds.host
                ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                : 'bg-dark-800/40 border-dark-700/50 text-dark-400 hover:border-dark-600'
            }`}
          >
            🖥️ TCP
          </button>
          <button
            type="button"
            onClick={() => updateDs({ socketPath: '', host: '', port: 0, tls: false,
              via: { serverId: remoteServers[0]?.id || '', socketPath: '/var/run/docker.sock' } })}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              ds.via?.serverId
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                : 'bg-dark-800/40 border-dark-700/50 text-dark-400 hover:border-dark-600'
            }`}
          >
            🔐 SSH 服务器
          </button>
        </div>
        {ds.socketPath && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-dark-500">Socket:</span>
            <input
              type="text"
              value={ds.socketPath}
              onChange={e => updateDs({ socketPath: e.target.value })}
              placeholder="/var/run/docker.sock"
              className="flex-1 px-2 py-1 bg-dark-800/60 border border-dark-700/50 rounded text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-green-500/50"
            />
          </div>
        )}
      </div>

      {/* Fields */}
      <DockerSourceFields
        ds={ds}
        remoteServers={remoteServers}
        update={updateDs}
        hostDropdownOpen={openedHost}
        setHostDropdownOpen={open => setOpenedHost(ds.id, open)}
      />

      {/* 容器内日志路径 */}
      {!ds.socketPath ? (
        <div className="px-4 pb-2">
          <p className="text-xs text-dark-600 mb-1">
            📂 容器内日志路径
            <span className="text-dark-600 ml-1">（如 /app/logs，巡检时扫描 *.log 中的错误行。留空则仅检查容器 stdout/stderr 输出）</span>
          </p>
          <div className="flex flex-wrap gap-1.5 items-center">
            {(ds.logPaths || []).map((lp: string, li: number) => (
              <span key={li} className="inline-flex items-center gap-1 px-2 py-0.5 bg-dark-800/60 border border-dark-700/50 rounded text-xs text-dark-300">
                {lp}
                <button
                  onClick={() => updateDs({ logPaths: (ds.logPaths || []).filter((_: string, fi: number) => fi !== li) })}
                  className="text-dark-500 hover:text-red-400"
                >×</button>
              </span>
            ))}
            <input
              type="text"
              placeholder="输入路径按回车添加..."
              className="flex-1 min-w-[160px] px-2.5 py-1 bg-dark-800/60 border border-dark-700/50 rounded text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-blue-500/50"
              onKeyDown={e => {
                if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) {
                    updateDs({ logPaths: [...(ds.logPaths || []), val] });
                    (e.target as HTMLInputElement).value = '';
                  }
                }
              }}
            />
          </div>
        </div>
      ) : null}

      <DockerHelpSection />
    </div>
  );
}

export default memo(DockerSourceCard);