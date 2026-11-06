/**
 * 单个容器行（卡片）—— 头部信息 + 操作按钮 + 4 个可展开面板。
 *
 * 从 pages/Docker.tsx 的 `filtered.map(...)` 内部整块搬出，class / 文案 / 结构
 * 逐字保留。**行内不持有 state**：`drangKey` / `selected` / `expanded` /
 * `containerLogs` / `terminalOpen` / `terminalCmds` / `liveLog*` / `diagnose*`
 * 全部仍在父页面，原因见 Docker.tsx 顶部注释（多行共享同一份 cmdInput、
 * 诊断同一时刻只有一个、过滤时不能把已开的终端内容丢掉）。
 *
 * 组件用 React.memo：父页面所有回调都过 useCallback，数组/记录型 props 用
 * utils.ts 里的 EMPTY_* 常量兜底，所以未变化的行不会跟着别的行重渲染。
 */

import { memo } from 'react';
import {
  CheckCircle, GripVertical, ArrowRightLeft, Terminal, Loader,
} from 'lucide-react';
import type { ContainerRowItem, TraceResult, LiveLogLine, TermLine } from './types';
import {
  getStateColor, getStateDot, getExitLabel, logLevelColor,
} from './utils';
import ContainerActions from './ContainerActions';
import LiveLogPanel from './LiveLogPanel';
import TerminalPanel from './TerminalPanel';
import DiagnosisPanel from './DiagnosisPanel';

export interface DockerRowProps {
  rowKey: string;
  container: ContainerRowItem;

  // ── 行状态（父页面持有，这里只读） ──────────────────────────
  isExpanded: boolean;
  isSelected: boolean;
  isDragSource: boolean;
  logs: any[];
  trace?: TraceResult;
  logsLoading: boolean;
  traceLoading: boolean;

  terminalOpen: boolean;
  terminalCmds: TermLine[];
  cmdInput: string;
  execLoading: boolean;

  liveLogActive: boolean;
  liveLogLines: LiveLogLine[];
  liveLogPaused: boolean;
  liveLogConnecting: boolean;

  diagnoseActive: boolean;
  diagnoseLoading: boolean;
  diagnoseText: string;
  diagnoseCopied: boolean;
  diagnoseName: string;

  opStop: boolean;
  opStart: boolean;
  opRestart: boolean;
  opRemove: boolean;

  // ── 共享回调（父页面 useCallback） ──────────────────────────
  onDragStart: (e: React.DragEvent, key: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, targetKey: string) => void;
  onDragEnd: () => void;

  onToggleSelect: (sourceId: string, container: ContainerRowItem) => void;
  onToggleExpand: (sourceId: string, container: ContainerRowItem) => void;
  onToggleTerminal: (key: string) => void;
  onRunCmd: (sourceId: string, containerId: string, key: string, cmd: string) => void;
  onSetCmdInput: (v: string) => void;
  onClearTerminal: (key: string) => void;
  onDoOp: (sourceId: string, containerId: string, op: string, key: string) => void;
  onLoadTrace: (sourceId: string, container: ContainerRowItem) => void;
  onDiagnose: (sourceId: string, containerId: string, containerName: string) => void;
  onDiagnoseCopy: () => void;
  onDiagnoseClose: () => void;
  onToggleLiveLog: (sourceId: string, containerId: string) => void;
  onPauseLiveLog: (key: string) => void;
  onResumeLiveLog: (key: string) => void;
  onClearLiveLog: (key: string) => void;
}

function DockerRow({
  rowKey,
  container: c,
  isExpanded,
  isSelected,
  isDragSource,
  logs,
  trace,
  logsLoading,
  traceLoading,
  terminalOpen,
  terminalCmds,
  cmdInput,
  execLoading,
  liveLogActive,
  liveLogLines,
  liveLogPaused,
  liveLogConnecting,
  diagnoseActive,
  diagnoseLoading,
  diagnoseText,
  diagnoseCopied,
  diagnoseName,
  opStop,
  opStart,
  opRestart,
  opRemove,
  onDragStart,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
  onDragEnd,
  onToggleSelect,
  onToggleExpand,
  onToggleTerminal,
  onRunCmd,
  onSetCmdInput,
  onClearTerminal,
  onDoOp,
  onLoadTrace,
  onDiagnose,
  onDiagnoseCopy,
  onDiagnoseClose,
  onToggleLiveLog,
  onPauseLiveLog,
  onResumeLiveLog,
  onClearLiveLog,
}: DockerRowProps) {
  const key = rowKey;
  const errorLogs = logs.filter(l => l.level === 'ERROR' || l.level === 'WARN');
  // 去重计数：忽略时间戳，只比错误模式
  const normalize = (s: string) => (s || '').replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\w+\s+\d{4}\s*-\s*/i, '').replace(/req_[a-f0-9]+/gi,'req_XXX').trim();
  const uniqueErrorSet = new Set(errorLogs.map(l => normalize(l.content || l.line)));

  return (
    <div
      key={key}
      onDragStart={(e) => onDragStart(e, key)}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, key)}
      onDragEnd={onDragEnd}
      className={`group glass rounded-xl border transition-all w-full max-w-full overflow-hidden ${
        isDragSource ? 'opacity-50 border-2 border-dashed border-blue-400' :
        isSelected ? 'border-accent-500/50 bg-accent-500/5' :
        c.exitType === 'oom' ? 'border-red-500/30 border-l-2 bg-red-500/5' :
        c.exitType === 'error' || c.exitType === 'segfault' ? 'border-orange-500/20 border-l-2 bg-orange-500/3' :
        'border-dark-800 hover:border-dark-700'
      } `}
    >
      {/* Container row */}
      <div className="flex items-center gap-3 px-4 py-3 min-w-0">
        {/* Drag handle —— 只有这里可拖，卡片其余区域（日志/诊断/终端）保持文字可选中 */}
        <div
          draggable
          title="按住拖动排序"
          className="flex-shrink-0 text-dark-700 opacity-30 group-hover:opacity-100 hover:text-dark-300 cursor-grab active:cursor-grabbing transition-opacity"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <GripVertical className="w-4 h-4" />
        </div>

        {/* Select */}
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleSelect(c._sourceId, c); }}
          className={`w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
            isSelected
              ? 'bg-accent-500 border-accent-500 text-white'
              : 'border-dark-700 hover:border-dark-600'
          }`}
        >
          {isSelected && <CheckCircle className="w-3.5 h-3.5" />}
        </button>

        {/* State dot */}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getStateDot(c.state, c.exitType)}`} />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-dark-100 truncate">
              {c.names[0] || c.shortId}
            </span>
            <span className={`text-xs ${getStateColor(c.state, c.exitType)}`}>{c.state}</span>
            {errorLogs.length > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">
                {uniqueErrorSet.size} 种错误
              </span>
            )}
            {getExitLabel(c.exitType, c.exitCode) && (
              <span className={`text-xs px-1.5 py-0.5 rounded border ${
                c.exitType === 'oom' ? 'bg-red-500/20 text-red-300 border-red-500/30' :
                c.exitType === 'error' || c.exitType === 'segfault' ? 'bg-orange-500/15 text-orange-300 border-orange-500/20' :
                c.exitType === 'terminated' ? 'bg-yellow-500/15 text-yellow-300 border-yellow-500/20' :
                'bg-dark-600/50 text-dark-400 border-dark-600'
              }`}>
                {getExitLabel(c.exitType, c.exitCode)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-xs text-dark-600 truncate max-w-[200px]">{c.image}</span>
            <span className="text-xs text-dark-600">{c.status}</span>
            <span className="text-xs text-dark-700">{c._sourceName}</span>
          </div>
        </div>

        {/* Actions */}
        <ContainerActions
          container={c}
          isExpanded={isExpanded}
          terminalOpen={terminalOpen}
          traceActive={!!trace}
          traceLoading={traceLoading}
          liveLogActive={liveLogActive}
          liveLogConnecting={liveLogConnecting}
          diagnoseActive={diagnoseActive}
          opStop={opStop}
          opStart={opStart}
          opRestart={opRestart}
          opRemove={opRemove}
          onToggleTerminal={onToggleTerminal}
          onDoOp={onDoOp}
          onLoadTrace={onLoadTrace}
          onDiagnose={onDiagnose}
          onToggleLiveLog={onToggleLiveLog}
          onToggleExpand={onToggleExpand}
        />
      </div>

      {/* 实时日志流面板 */}
      {liveLogActive && (
        <LiveLogPanel
          panelKey={key}
          containerName={c.names[0] || c.shortId}
          lines={liveLogLines}
          paused={liveLogPaused}
          connecting={liveLogConnecting}
          onPause={() => onPauseLiveLog(key)}
          onResume={() => onResumeLiveLog(key)}
          onClear={() => onClearLiveLog(key)}
          onClose={() => onToggleLiveLog(c._sourceId, c.id)}
        />
      )}

      {/* 终端面板 */}
      {terminalOpen && (
        <TerminalPanel
          panelKey={key}
          containerName={c.names[0] || c.shortId}
          cmds={terminalCmds}
          cmdInput={cmdInput}
          setCmdInput={onSetCmdInput}
          onRun={cmd => onRunCmd(c._sourceId, c.id, key, cmd)}
          onClear={() => onClearTerminal(key)}
          execLoading={execLoading}
        />
      )}

      {/* AI 诊断面板 */}
      {diagnoseActive && (
        <DiagnosisPanel
          panelKey={key}
          containerName={diagnoseName || c.names[0] || c.shortId}
          loading={diagnoseLoading}
          text={diagnoseText}
          copied={diagnoseCopied}
          onCopy={onDiagnoseCopy}
          onClose={onDiagnoseClose}
        />
      )}

      {/* Expanded: logs + trace */}
      {isExpanded && (
        <div className="border-t border-dark-800 w-full max-w-full overflow-hidden">
          {/* Trace */}
          {trace && (
            <div className="px-4 py-3 bg-dark-900/50 border-b border-dark-800 w-full max-w-full overflow-hidden">
              <p className="text-xs font-medium text-dark-400 mb-2 flex items-center gap-1">
                <ArrowRightLeft className="w-3 h-3" /> 上下游链路 — {trace.serviceName}
              </p>
              <div className="flex flex-wrap gap-2 max-w-full">
                {(trace.upstream || []).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 max-w-full">
                    <span className="text-xs text-dark-600 flex-shrink-0">上游:</span>
                    {(trace.upstream || []).map(u => (
                      <span key={u.id} className="text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 truncate max-w-[200px]" title={u.names?.[0] || u.shortId || u.id}>
                        {u.names?.[0] || u.shortId || u.id?.slice(0, 12)}
                      </span>
                    ))}
                  </div>
                )}
                {(trace.downstream || []).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 max-w-full">
                    <span className="text-xs text-dark-600 flex-shrink-0">下游:</span>
                    {(trace.downstream || []).map(u => (
                      <span key={u.id} className="text-xs px-2 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/20 truncate max-w-[200px]" title={u.names?.[0] || u.shortId || u.id}>
                        {u.names?.[0] || u.shortId || u.id?.slice(0, 12)}
                      </span>
                    ))}
                  </div>
                )}
                {(trace.networkPeers || []).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 max-w-full">
                    <span className="text-xs text-dark-600 flex-shrink-0">同网:</span>
                    {(trace.networkPeers || []).slice(0, 5).map(u => (
                      <span key={u.id} className="text-xs px-2 py-0.5 rounded bg-dark-800 text-dark-400 truncate max-w-[180px]" title={u.names?.[0] || u.shortId || u.id}>
                        {u.names?.[0] || u.shortId || u.id?.slice(0, 12)}
                      </span>
                    ))}
                  </div>
                )}
                {(trace.upstream || []).length === 0 && (trace.downstream || []).length === 0 && (
                  <span className="text-xs text-dark-600">无链路信息（检查容器 label）</span>
                )}
              </div>
            </div>
          )}

          {/* Logs */}
          <div className="px-4 py-2 w-full max-w-full overflow-hidden">
            <p className="text-xs text-dark-600 mb-2 flex items-center gap-1">
              <Terminal className="w-3 h-3" /> 最近日志
              {logsLoading && <Loader className="w-3 h-3 animate-spin ml-1" />}
            </p>
            <div className="max-h-60 overflow-y-auto space-y-0.5 overflow-x-hidden w-full max-w-full">
              {logsLoading ? (
                <div className="text-xs text-dark-600 py-2">加载中...</div>
              ) : logs.length === 0 ? (
                <div className="text-xs text-dark-600 py-2">无日志</div>
              ) : logs.slice(-30).map((l, i) => (
                <div key={i} className="flex items-center gap-2 text-xs font-mono py-0.5 w-full max-w-full min-w-0 overflow-hidden">
                  <span className="text-dark-700 flex-shrink-0 w-36 select-none">{l.timestamp?.slice(0, 19) || '-'}</span>
                  <span className={`flex-shrink-0 w-12 font-medium ${logLevelColor(l.level)}`}>[{l.level}]</span>
                  <span className="text-dark-300 truncate flex-1 min-w-0 block" title={l.content || l.line}>{l.content || l.line}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(DockerRow);
