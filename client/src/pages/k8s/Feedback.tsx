/**
 * 页面级反馈组件：错误条 / 加载块 / 空状态。
 *
 * 为什么统一成组件：错误此前只有 `console.error`，用户看到的是「空白页」，
 * 分不清「没有集群」和「接口挂了」。这里把三种状态固定成三种可见的 UI，
 * 并且都带一次可点的恢复动作（重试 / 添加集群）。
 */

import type { ReactNode } from 'react';
import { CircleAlert, Loader, Boxes, Plus, RefreshCw } from 'lucide-react';

interface ErrorBarProps {
  message: string;
  /** 可选的重试动作；不传则只展示消息。 */
  onRetry?: () => void;
  /** 可选的自定义右侧动作（如「去设置」）。 */
  action?: ReactNode;
}

/** 内联错误条：红色系，保留原文（ApiError 的 message 已经是人类可读的中文）。 */
export function ErrorBar({ message, onRetry, action }: ErrorBarProps) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
      <CircleAlert className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-400" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-red-300 break-words">{message}</div>
      </div>
      {action}
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/20 text-xs text-red-200 hover:bg-red-500/30 transition-colors flex-shrink-0"
        >
          <RefreshCw className="w-3 h-3" />
          重试
        </button>
      )}
    </div>
  );
}

/** 加载块：占位高度固定，避免数据到达时页面跳动。 */
export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="glass rounded-xl p-12 flex items-center justify-center gap-2 text-dark-400">
      <Loader className="w-5 h-5 animate-spin text-accent-400" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

/** 空状态：没有集群时的引导（用户第一次进这个页面看到的就是它）。 */
export function EmptyClusters({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="glass rounded-xl p-10 text-center">
      <Boxes className="w-12 h-12 mx-auto mb-3 text-dark-600" />
      <p className="text-dark-300 font-medium">还没有接入 Kubernetes 集群</p>
      <p className="text-xs text-dark-500 mt-2 leading-relaxed">
        使用只读 ServiceAccount 的 kubeconfig 直连 kube-apiserver，不需要在节点上装 agent，也不需要 kubectl。
      </p>
      <ol className="text-xs text-dark-500 mt-3 mb-4 space-y-1 text-left inline-block">
        <li>1. 按 deploy/k8s/rbac.yaml 创建只读 SA，并生成 kubeconfig</li>
        <li>2. 点下方按钮，粘贴 kubeconfig 并起个名字</li>
        <li>3. 用「测试连接」确认证书/RBAC 可用后再看概览</li>
      </ol>
      <div>
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          <Plus className="w-4 h-4" />
          添加集群
        </button>
      </div>
    </div>
  );
}

/** 区块级空状态（节点表 / 事件列表这类「有数据源但这次是空」的位置）。 */
export function SectionEmpty({ text }: { text: string }) {
  return <div className="px-4 py-6 text-center text-xs text-dark-500">{text}</div>;
}