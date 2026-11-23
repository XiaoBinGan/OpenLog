/**
 * Pod 操作条：删除 Pod / 重启工作负载 / 扩缩容。
 *
 * 三个操作都走 A4 的写接口（server/routes/k8s-ops.js）：
 *   DELETE /api/k8s/clusters/:id/pods/:ns/:name
 *   POST   /api/k8s/clusters/:id/workloads/:ns/:kind/:name/restart
 *   POST   /api/k8s/clusters/:id/workloads/:ns/:kind/:name/scale   { replicas }
 *
 * 为什么要把「错误码」当成一等公民：
 *   · 403 = 写操作未启用（后端没设 OPENLOG_K8S_WRITE=1）。这不是故障，是配置状态 ——
 *     把后端返回的文案原样弹出来，同时**永久禁用**这几个按钮并给出 title 提示，
 *     否则用户会一遍遍点、一遍遍看到同一个 403。
 *   · 409 = 演示模式（OPENLOG_DEMO=1）。演示库里本来就没有真集群，
 *     直接告诉用户「该操作已被禁用」，同样禁用按钮。
 *   · 其它错误 → 只弹错误，按钮保持可用（网络抖动不该锁死界面）。
 *
 * 组件不自己拼后端地址：路径都从 clusterApiPath 的同一套 encodeURIComponent 规则来，
 * namespace / pod 名带 `/` 或大小写时不会拼出 404 的路径。
 */

import { useState } from 'react';
import { Loader, RefreshCw, Scaling, Trash2 } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';

/** 工作负载标识。kind 只允许这两种：Deployment / StatefulSet 以外的 Pod 没有「重启」语义。 */
export interface PodOpsWorkload {
  kind: 'deployments' | 'statefulsets';
  name: string;
}

export interface PodOpsBarProps {
  clusterId: string;
  namespace: string;
  podName: string;
  /** 有工作负载时才出现「重启」「扩缩容」；独立 Pod（static pod / bare pod）只有删除。 */
  workload?: PodOpsWorkload;
  /** 操作成功后回调，父页面据此刷新 overview / 列表。 */
  onDone?: () => void;
}

/** 副本数区间（后端也会校验，这里先拦一道，避免白跑一次请求）。 */
const MIN_REPLICAS = 0;
const MAX_REPLICAS = 1000;

/** 403 的 title 文案。测试与 UI 都认这串常量，改一处就够。 */
const WRITE_DISABLED_HINT = '需要 OPENLOG_K8S_WRITE=1（当前写操作未启用）';
/** 409 的 title 文案。 */
const DEMO_DISABLED_HINT = '演示模式（OPENLOG_DEMO=1）：该操作已被禁用';
/** 409 的 toast 文案（契约里给定的话术，别改）。 */
const DEMO_TOAST = '演示模式：该操作已被禁用';

const FALLBACK_ERROR = '操作失败，请查看服务端日志';

type OpAction = 'delete' | 'restart' | 'scale';

/** 路径里的每一段都必须编码：namespace 或 Pod 名里出现 `/` 时否则会拼出 404 的地址。 */
function clusterPath(clusterId: string, suffix: string): string {
  return `/api/k8s/clusters/${encodeURIComponent(clusterId)}${suffix}`;
}

function podDeletePath(clusterId: string, namespace: string, podName: string): string {
  return clusterPath(
    clusterId,
    `/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(podName)}`,
  );
}

function workloadPath(
  clusterId: string,
  namespace: string,
  workload: PodOpsWorkload,
  action: 'restart' | 'scale',
): string {
  return clusterPath(
    clusterId,
    `/workloads/${encodeURIComponent(namespace)}/${workload.kind}/${encodeURIComponent(workload.name)}/${action}`,
  );
}

/** 从任意抛出物里取 HTTP 状态码（ApiError 有 status，被包装过的错误退回 body.status）。 */
function statusOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const direct = (err as { status?: unknown }).status;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  return null;
}

/**
 * 后端错误文案：优先用响应体里的 `error`（A4 就是按这个字段返回的），
 * 其次 ApiError 的 message，最后兜一句中文。
 */
function backendErrorText(err: unknown): string {
  if (typeof err === 'string' && err.trim() !== '') return err.trim();
  if (err && typeof err === 'object') {
    const body = (err as { body?: unknown }).body;
    // 响应体本身是纯文本时（非 JSON 的 5xx）直接用它
    if (typeof body === 'string' && body.trim() !== '') return body.trim();
    if (body && typeof body === 'object') {
      const fromError = (body as { error?: unknown }).error;
      if (typeof fromError === 'string' && fromError.trim() !== '') return fromError.trim();
      const fromMessage = (body as { message?: unknown }).message;
      if (typeof fromMessage === 'string' && fromMessage.trim() !== '') return fromMessage.trim();
    }
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message.trim();
  }
  return FALLBACK_ERROR;
}

/**
 * 副本数解析：只接受 0..1000 的十进制整数。
 * 显式拒绝 `3.5` / `1e3` / `-1` / ` 3abc` / 空串 —— 这些送上去要么被后端 400，
 * 要么被 JSON 序列化成浮点数，扩出一个「0.5 副本」的诡异状态。
 */
function parseReplicas(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return null;
  if (value < MIN_REPLICAS || value > MAX_REPLICAS) return null;
  return value;
}

const buttonBase =
  'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

function PodOpsBar({ clusterId, namespace, podName, workload, onDone }: PodOpsBarProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<OpAction | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [scaling, setScaling] = useState(false);
  const [replicasText, setReplicasText] = useState('1');
  /** 403 / 409 之后锁死整条操作栏（per-action 的差异在这里没有意义：写能力是集群级的）。 */
  const [blockedHint, setBlockedHint] = useState<string | null>(null);

  const locked = blockedHint !== null;
  const running = busy !== null;

  /** 统一执行：loading → 成功 toast + onDone；403/409 上锁；其它错误只弹提示。 */
  const run = async (
    action: OpAction,
    path: string,
    init: RequestInit,
    successText: string,
  ): Promise<void> => {
    if (locked || running) return;
    setBusy(action);
    try {
      await apiFetch(path, init);
      toast.success(successText);
      if (onDone) onDone();
    } catch (err) {
      const status = statusOf(err);
      if (status === 403) {
        toast.error(backendErrorText(err), { description: WRITE_DISABLED_HINT });
        setBlockedHint(WRITE_DISABLED_HINT);
      } else if (status === 409) {
        toast.warning(DEMO_TOAST);
        setBlockedHint(DEMO_DISABLED_HINT);
      } else {
        toast.error(backendErrorText(err));
      }
    } finally {
      setBusy(null);
    }
  };

  const doDelete = (): void => {
    setConfirmingDelete(false);
    void run(
      'delete',
      podDeletePath(clusterId, namespace, podName),
      { method: 'DELETE' },
      `已删除 Pod ${podName}`,
    );
  };

  const doRestart = (): void => {
    if (!workload) return;
    void run(
      'restart',
      workloadPath(clusterId, namespace, workload, 'restart'),
      { method: 'POST' },
      `已重启 ${workload.kind === 'statefulsets' ? 'StatefulSet' : 'Deployment'} ${workload.name}`,
    );
  };

  const doScale = (): void => {
    if (!workload) return;
    const replicas = parseReplicas(replicasText);
    if (replicas === null) {
      toast.error(`副本数必须是 ${MIN_REPLICAS}..${MAX_REPLICAS} 之间的整数`);
      return;
    }
    setScaling(false);
    void run(
      'scale',
      workloadPath(clusterId, namespace, workload, 'scale'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replicas }),
      },
      `已把 ${workload.name} 扩缩到 ${replicas} 个副本`,
    );
  };

  const titleFor = (idle: string): string => {
    if (blockedHint) return blockedHint;
    if (running) return '上一个操作还在进行中';
    return idle;
  };

  return (
    <div
      data-testid="pod-ops-bar"
      aria-busy={running}
      className="flex flex-wrap items-center gap-2"
    >
      {/* 删除 Pod：危险操作，红色 + 二次确认 */}
      <button
        type="button"
        data-testid="pod-ops-delete"
        onClick={() => {
          if (locked || running) return;
          setConfirmingDelete(true);
          setScaling(false);
        }}
        disabled={locked || running || confirmingDelete}
        title={titleFor('删除这个 Pod（删除后由工作负载重建）')}
        className={`${buttonBase} bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20`}
      >
        {busy === 'delete' ? (
          <Loader className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Trash2 className="w-3.5 h-3.5" />
        )}
        {busy === 'delete' ? '删除中…' : '删除 Pod'}
      </button>

      {confirmingDelete && (
        <span
          data-testid="pod-ops-delete-confirm"
          className="inline-flex items-center gap-2 px-2 py-1 rounded-lg border border-red-500/30 bg-red-500/5 text-xs text-red-300"
        >
          <span>
            确认删除 <code className="font-mono">{podName}</code>？
          </span>
          <button
            type="button"
            data-testid="pod-ops-delete-confirm-yes"
            onClick={doDelete}
            className={`${buttonBase} bg-red-500/20 border-red-500/40 text-red-200 hover:bg-red-500/30`}
          >
            确认删除
          </button>
          <button
            type="button"
            data-testid="pod-ops-delete-confirm-cancel"
            onClick={() => setConfirmingDelete(false)}
            className={`${buttonBase} bg-dark-800 border-dark-700 text-dark-300 hover:bg-dark-700`}
          >
            取消
          </button>
        </span>
      )}

      {/* 重启工作负载：只有知道 workload 时才可能出现 */}
      {workload && (
        <button
          type="button"
          data-testid="pod-ops-restart"
          onClick={doRestart}
          disabled={locked || running}
          title={titleFor(`滚动重启 ${workload.name}`)}
          className={`${buttonBase} bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20`}
        >
          {busy === 'restart' ? (
            <Loader className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {busy === 'restart' ? '重启中…' : '重启工作负载'}
        </button>
      )}

      {/* 扩缩容：弹输入框填副本数 */}
      {workload && (
        <button
          type="button"
          data-testid="pod-ops-scale"
          onClick={() => {
            if (locked || running) return;
            setConfirmingDelete(false);
            setScaling(true);
          }}
          disabled={locked || running || scaling}
          title={titleFor('调整副本数（0..1000）')}
          className={`${buttonBase} bg-blue-500/10 border-blue-500/30 text-blue-400 hover:bg-blue-500/20`}
        >
          {busy === 'scale' ? (
            <Loader className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Scaling className="w-3.5 h-3.5" />
          )}
          {busy === 'scale' ? '扩缩中…' : '扩缩容'}
        </button>
      )}

      {workload && scaling && (
        <span
          data-testid="pod-ops-scale-form"
          className="inline-flex items-center gap-2 px-2 py-1 rounded-lg border border-blue-500/30 bg-blue-500/5 text-xs text-blue-300"
        >
          <label htmlFor="pod-ops-scale-input" className="whitespace-nowrap">
            副本数（{MIN_REPLICAS}..{MAX_REPLICAS}）
          </label>
          <input
            id="pod-ops-scale-input"
            data-testid="pod-ops-scale-input"
            type="text"
            inputMode="numeric"
            value={replicasText}
            onChange={(event) => setReplicasText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') doScale();
              if (event.key === 'Escape') setScaling(false);
            }}
            className="w-16 px-2 py-0.5 rounded border border-dark-700 bg-dark-900 text-dark-100 font-mono"
          />
          <button
            type="button"
            data-testid="pod-ops-scale-submit"
            onClick={doScale}
            className={`${buttonBase} bg-blue-500/20 border-blue-500/40 text-blue-200 hover:bg-blue-500/30`}
          >
            应用
          </button>
          <button
            type="button"
            data-testid="pod-ops-scale-cancel"
            onClick={() => setScaling(false)}
            className={`${buttonBase} bg-dark-800 border-dark-700 text-dark-300 hover:bg-dark-700`}
          >
            取消
          </button>
        </span>
      )}
    </div>
  );
}

export default PodOpsBar;
