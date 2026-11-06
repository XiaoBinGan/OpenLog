/**
 * 容器操作按钮组（终端 / 启停 / 重启 / 链路 / 删除 / AI 诊断 / 实时日志 / 展开日志）。
 *
 * 从 pages/Docker.tsx 的行内 JSX 抽出，class、title、aria-label、文案逐字保留。
 * 每个按钮都保留了 `e.preventDefault(); e.stopPropagation();` —— 卡片外层挂
 * 拖拽处理器，少了这两行点一次会连带触发拖拽/选中。
 */

import { memo } from 'react';
import {
  Terminal, Pause, Play, RotateCcw, ArrowRightLeft, Trash2,
  Stethoscope, StopCircle, Activity, ChevronDown, Loader,
} from 'lucide-react';
import type { ContainerRowItem } from './types';

export interface ContainerActionsProps {
  container: ContainerRowItem;
  isExpanded: boolean;
  terminalOpen: boolean;
  traceActive: boolean;
  traceLoading: boolean;
  liveLogActive: boolean;
  liveLogConnecting: boolean;
  diagnoseActive: boolean;
  opStop: boolean;
  opStart: boolean;
  opRestart: boolean;
  opRemove: boolean;
  onToggleTerminal: (key: string) => void;
  onDoOp: (sourceId: string, containerId: string, op: string, key: string) => void;
  onLoadTrace: (sourceId: string, container: ContainerRowItem) => void;
  onDiagnose: (sourceId: string, containerId: string, containerName: string) => void;
  onToggleLiveLog: (sourceId: string, containerId: string) => void;
  onToggleExpand: (sourceId: string, container: ContainerRowItem) => void;
}

function ContainerActions({
  container: c,
  isExpanded,
  terminalOpen,
  traceActive,
  traceLoading,
  liveLogActive,
  liveLogConnecting,
  diagnoseActive,
  opStop,
  opStart,
  opRestart,
  opRemove,
  onToggleTerminal,
  onDoOp,
  onLoadTrace,
  onDiagnose,
  onToggleLiveLog,
  onToggleExpand,
}: ContainerActionsProps) {
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {/* 终端 */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleTerminal(`${c._sourceId}:${c.id}`); }}
        className={`group/btn relative p-1.5 rounded-lg transition-colors ${terminalOpen ? 'bg-accent-500/15 text-accent-400' : 'hover:bg-dark-700 text-dark-500 hover:text-accent-400'}`}
        title="进入容器终端"
        aria-label="进入容器终端"
      >
        <Terminal className="w-4 h-4" />
        <span className="pointer-events-none absolute top-full mt-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-dark-900/95 px-2 py-1 text-[11px] leading-none text-dark-100 opacity-0 shadow-xl border border-dark-700 transition-opacity duration-150 group-hover/btn:opacity-100 z-30 pointer-events-none">
          进入终端
        </span>
      </button>

      {/* 启停 */}
      {c.state === 'running' ? (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDoOp(c._sourceId, c.id, 'stop', `${c._sourceId}:${c.id}:stop`); }}
          disabled={opStop}
          className="group/btn relative p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-yellow-400 transition-colors"
          title="停止容器"
          aria-label="停止容器"
        >
          {opStop ? <Loader className="w-4 h-4 animate-spin" /> : <Pause className="w-4 h-4" />}
          <span className="pointer-events-none absolute top-full mt-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-dark-900/95 px-2 py-1 text-[11px] leading-none text-dark-100 opacity-0 shadow-xl border border-dark-700 transition-opacity duration-150 group-hover/btn:opacity-100 z-30 pointer-events-none">
            停止容器
          </span>
        </button>
      ) : (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDoOp(c._sourceId, c.id, 'start', `${c._sourceId}:${c.id}:start`); }}
          disabled={opStart}
          className="group/btn relative p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-green-400 transition-colors"
          title="启动容器"
          aria-label="启动容器"
        >
          {opStart ? <Loader className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          <span className="pointer-events-none absolute top-full mt-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-dark-900/95 px-2 py-1 text-[11px] leading-none text-dark-100 opacity-0 shadow-xl border border-dark-700 transition-opacity duration-150 group-hover/btn:opacity-100 z-30 pointer-events-none">
            启动容器
          </span>
        </button>
      )}

      {/* 重启 */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDoOp(c._sourceId, c.id, 'restart', `${c._sourceId}:${c.id}:restart`); }}
        disabled={opRestart}
        className="group/btn relative p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-blue-400 transition-colors"
        title="重启容器"
        aria-label="重启容器"
      >
        {opRestart ? <Loader className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
        <span className="pointer-events-none absolute top-full mt-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-dark-900/95 px-2 py-1 text-[11px] leading-none text-dark-100 opacity-0 shadow-xl border border-dark-700 transition-opacity duration-150 group-hover/btn:opacity-100 z-30 pointer-events-none">
          重启容器
        </span>
      </button>

      {/* 链路追踪 */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onLoadTrace(c._sourceId, c); }}
        disabled={traceLoading}
        className={`group/btn relative p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-purple-400 transition-colors ${traceActive ? 'text-purple-400 bg-purple-500/10' : ''}`}
        title="上下游链路追踪"
        aria-label="上下游链路追踪"
      >
        {traceLoading ? <Loader className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
        <span className="pointer-events-none absolute top-full mt-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-dark-900/95 px-2 py-1 text-[11px] leading-none text-dark-100 opacity-0 shadow-xl border border-dark-700 transition-opacity duration-150 group-hover/btn:opacity-100 z-30 pointer-events-none">
          上下游链路
        </span>
      </button>

      {/* 删除容器 */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation();
          if (confirm(`确定删除容器 "${c.names[0] || c.shortId}"？此操作不可撤销。`)) {
            onDoOp(c._sourceId, c.id, 'remove', `${c._sourceId}:${c.id}:remove`);
          }
        }}
        disabled={opRemove}
        className="group/btn relative p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-red-400 transition-colors"
        title="删除容器"
        aria-label="删除容器"
      >
        {opRemove ? <Loader className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        <span className="pointer-events-none absolute top-full mt-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-dark-900/95 px-2 py-1 text-[11px] leading-none text-dark-100 opacity-0 shadow-xl border border-dark-700 transition-opacity duration-150 group-hover/btn:opacity-100 z-30 pointer-events-none">
          删除容器
        </span>
      </button>

      {/* AI 诊断 */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDiagnose(c._sourceId, c.id, c.names[0] || c.shortId); }}
        className={`group/btn relative p-1.5 rounded-lg transition-colors ${diagnoseActive ? 'bg-accent-500/15 text-accent-400' : 'hover:bg-dark-700 text-dark-500 hover:text-accent-400'}`}
        title="AI 智能诊断"
        aria-label="AI 智能诊断"
      >
        <Stethoscope className="w-4 h-4" />
        <span className="pointer-events-none absolute top-full mt-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-dark-900/95 px-2 py-1 text-[11px] leading-none text-dark-100 opacity-0 shadow-xl border border-dark-700 transition-opacity duration-150 group-hover/btn:opacity-100 z-30 pointer-events-none">
          AI 智能诊断
        </span>
      </button>

      {/* 实时日志 */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleLiveLog(c._sourceId, c.id); }}
        className={`group/btn relative p-1.5 rounded-lg transition-colors ${liveLogActive ? 'bg-green-500/15 text-green-400' : 'hover:bg-dark-700 text-dark-500 hover:text-green-400'}`}
        title="实时日志流"
        aria-label="实时日志流"
      >
        {liveLogConnecting ? <Loader className="w-4 h-4 animate-spin" /> : <StopCircle className="w-4 h-4" />}
        <span className="pointer-events-none absolute top-full mt-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-dark-900/95 px-2 py-1 text-[11px] leading-none text-dark-100 opacity-0 shadow-xl border border-dark-700 transition-opacity duration-150 group-hover/btn:opacity-100 z-30 pointer-events-none">
          实时日志流
        </span>
      </button>

      {/* 展开/收起日志 */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleExpand(c._sourceId, c); }}
        className="group/btn relative p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-dark-200 transition-colors"
        title={isExpanded ? "收起日志详情" : "查看最近日志"}
        aria-label={isExpanded ? "收起日志详情" : "查看最近日志"}
      >
        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
        <span className="pointer-events-none absolute top-full mt-1.5 right-0 whitespace-nowrap rounded-md bg-dark-900/95 px-2 py-1 text-[11px] leading-none text-dark-100 opacity-0 shadow-xl border border-dark-700 transition-opacity duration-150 group-hover/btn:opacity-100 z-30 pointer-events-none">
          {isExpanded ? "收起日志" : "查看日志"}
        </span>
      </button>
    </div>
  );
}

export default memo(ContainerActions);
