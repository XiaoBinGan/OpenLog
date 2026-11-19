/**
 * 节点表：Ready 状态、角色、版本、系统架构、InternalIP、容量、年龄。
 *
 * 容量字段是 capacity 原文（"8123456Ki" 这种），后端没做单位换算，
 * 所以这里也不换算 —— 换错了比不换更难查。
 */

import { Server } from 'lucide-react';
import type { K8sNode } from './types';
import { formatAge, nodeRolesLabel } from './utils';

function NodeTable({ nodes }: { nodes: K8sNode[] }) {
  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-dark-800/60">
        <Server className="w-4 h-4 text-accent-400" />
        <h2 className="text-sm font-semibold text-dark-100">节点</h2>
        <span className="text-xs text-dark-500">{nodes.length}</span>
      </div>

      {nodes.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-dark-500">
          没有读到节点：请确认 kubeconfig 对应的 ServiceAccount 拥有 nodes 的 list 权限
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-dark-500 border-b border-dark-800/60">
                <th className="text-left font-medium px-4 py-2">状态</th>
                <th className="text-left font-medium px-3 py-2">名称</th>
                <th className="text-left font-medium px-3 py-2">角色</th>
                <th className="text-left font-medium px-3 py-2">版本</th>
                <th className="text-left font-medium px-3 py-2">OS / 架构</th>
                <th className="text-left font-medium px-3 py-2">InternalIP</th>
                <th className="text-left font-medium px-3 py-2">CPU / 内存 / Pods</th>
                <th className="text-left font-medium px-3 py-2">年龄</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.name} className="border-b border-dark-800/40 hover:bg-dark-800/30 transition-colors">
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          node.ready ? 'bg-emerald-400' : 'bg-red-400'
                        }`}
                      />
                      <span className={node.ready ? 'text-emerald-400' : 'text-red-400'}>
                        {node.ready ? 'Ready' : 'NotReady'}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-dark-200 whitespace-nowrap" title={node.name}>
                    {node.name}
                  </td>
                  <td className="px-3 py-2 text-dark-400 whitespace-nowrap">{nodeRolesLabel(node.roles)}</td>
                  <td className="px-3 py-2 text-dark-400 font-mono text-xs whitespace-nowrap">
                    {node.version || '—'}
                  </td>
                  <td className="px-3 py-2 text-dark-400 text-xs whitespace-nowrap">
                    {node.os || '—'} / {node.arch || '—'}
                  </td>
                  <td className="px-3 py-2 text-dark-400 font-mono text-xs whitespace-nowrap">
                    {node.internalIP || '—'}
                  </td>
                  <td className="px-3 py-2 text-dark-400 font-mono text-xs whitespace-nowrap">
                    {node.cpu || '?'} / {node.memory || '?'} / {node.pods || '?'}
                  </td>
                  <td className="px-3 py-2 text-dark-500 text-xs whitespace-nowrap" title={node.created}>
                    {formatAge(node.created)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default NodeTable;