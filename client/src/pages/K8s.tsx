/**
 * Kubernetes 集群页（只读监控）。
 *
 * 结构：左侧集群列表（GET /api/k8s/clusters），右侧概览
 * （统计卡 / 节点表 / Pod 表 / Warning 事件 / Pod 日志抽屉）。
 *
 * 这里只保留「页面级」状态与请求编排，渲染细节下沉到 ./k8s/*：
 *   k8s/ClusterList.tsx  左侧集群列表（选择 / 测试连接 / 删除 / 刷新）
 *   k8s/ClusterForm.tsx  新增（编辑）集群弹窗：粘贴 kubeconfig + 测试连接
 *   k8s/StatCards.tsx    顶部四张统计卡
 *   k8s/NodeTable.tsx    节点表
 *   k8s/GpuAllocation.tsx GPU 分配（HAMi vGPU：每节点的卡数/显存/算力 + 占卡 Pod）
 *   k8s/GpuUsagePanel.tsx GPU 使用率（HAMi 实际值：调度器指标 + 节点注解对照）
 *   k8s/PolicyPanel.tsx   调度策略与超卖（HAMi scheduler 的 binpack/spread、显存倍率）
 *   k8s/PodTable.tsx     Pod 表（namespace 过滤 + OOM/CrashLoop 标记 + 点击看日志 + vGPU 列 + 操作列）
 *   k8s/PodOpsBar.tsx    Pod 行内操作（删除 Pod / 重启工作负载 / 扩缩容，需 OPENLOG_K8S_WRITE=1）
 *   k8s/EventList.tsx    Warning 事件列表
 *   k8s/LogDrawer.tsx    最近日志抽屉（tail=200）
 *   k8s/Feedback.tsx     错误条 / 加载块 / 空状态
 *   k8s/utils.tsx        纯函数（过滤、统计兜底、路径拼装、年龄格式化）
 *   k8s/types.ts         契约类型的本地副本（不改 client/src/types.ts）
 *
 * 请求统一走 api/client 的 apiFetch / apiJson：非 2xx 会抛 ApiError，
 * 消息直接来自服务端的 `{ error }`，页面把它落进错误条而不是 console.error。
 * 所有路径都是同源相对路径（/api/k8s/...），不写死后端地址。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, Plus, RefreshCw } from 'lucide-react';
import { apiFetch, apiJson } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { usePolling } from '../utils/usePolling';
import { DEMO_DISABLED_HINT, useDemoMode } from '../hooks/useDemoMode';
import type {
  K8sClusterListResponse,
  K8sClusterView,
  K8sLogTarget,
  K8sOkResponse,
  K8sOverview,
  K8sPod,
  K8sTestResponse,
  K8sTestState,
} from './k8s/types';
import {
  ALL_NAMESPACES,
  clusterApiPath,
  ensureOverview,
  errorText,
  hasHamiData,
  listNamespaces,
  podWorkloadRef,
} from './k8s/utils';
import ClusterAccordion from './k8s/ClusterAccordion';
import ClusterForm from './k8s/ClusterForm';
import StatCards from './k8s/StatCards';
import NodeTable from './k8s/NodeTable';
import GpuAllocation from './k8s/GpuAllocation';
import GpuUsagePanel from './k8s/GpuUsagePanel';
import PolicyPanel from './k8s/PolicyPanel';
import WarningDigestPanel from './k8s/WarningDigestPanel';
import PodTable from './k8s/PodTable';
import PodOpsBar from './k8s/PodOpsBar';
import EventList from './k8s/EventList';
import LogDrawer from './k8s/LogDrawer';
import { EmptyClusters, ErrorBar, LoadingBlock } from './k8s/Feedback';

/** 概览自动刷新间隔：集群页是「挂着看」的页面，30s 足够，也不至于把 apiserver 压出限流。 */
const OVERVIEW_POLL_MS = 30_000;

export default function K8s() {
  const toast = useToast();
  /** 演示模式：K8s 集群只能看，新增/删除一律挡在入口（并给出提示）。 */
  const { demo } = useDemoMode();

  const [clusters, setClusters] = useState<K8sClusterView[]>([]);
  const [clustersLoading, setClustersLoading] = useState(true);
  const [clustersError, setClustersError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [overview, setOverview] = useState<K8sOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [namespace, setNamespace] = useState(ALL_NAMESPACES);

  const [formOpen, setFormOpen] = useState(false);
  const [formCluster, setFormCluster] = useState<K8sClusterView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, K8sTestState>>({});
  const [logTarget, setLogTarget] = useState<K8sLogTarget | null>(null);

  /** 最近一次请求的集群 id：切换集群时用它丢弃迟到的旧响应。 */
  const overviewReqRef = useRef<string | null>(null);

  const fetchClusters = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setClustersLoading(true);
    try {
      const data = await apiFetch<K8sClusterListResponse>('/api/k8s/clusters');
      const list = Array.isArray(data?.clusters) ? data.clusters : [];
      setClusters(list);
      setClustersError(null);
      // 选中项失效（首次加载 / 被删除）时自动落到第一个集群
      setSelectedId((prev) => {
        if (prev && list.some((c) => c.id === prev)) return prev;
        return list.length > 0 ? list[0].id : null;
      });
    } catch (e) {
      setClustersError(errorText(e));
    } finally {
      setClustersLoading(false);
    }
  }, []);

  const fetchOverview = useCallback(async (clusterId: string, opts?: { silent?: boolean }) => {
    overviewReqRef.current = clusterId;
    if (!opts?.silent) setOverviewLoading(true);
    setOverviewError(null);
    try {
      const data = await apiFetch<Partial<K8sOverview>>(clusterApiPath(clusterId, '/overview'));
      if (overviewReqRef.current !== clusterId) return; // 迟到的响应，丢弃
      setOverview(ensureOverview(data));
      setLastRefreshed(Date.now());
    } catch (e) {
      if (overviewReqRef.current !== clusterId) return;
      setOverview(null);
      setOverviewError(errorText(e));
    } finally {
      if (overviewReqRef.current === clusterId) setOverviewLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchClusters();
  }, [fetchClusters]);

  useEffect(() => {
    if (!selectedId) {
      overviewReqRef.current = null;
      setOverview(null);
      setOverviewError(null);
      setOverviewLoading(false);
      return;
    }
    setNamespace(ALL_NAMESPACES);
    setLogTarget(null);
    void fetchOverview(selectedId);
  }, [selectedId, fetchOverview]);

  // 页面可见时每 30s 静默刷新（错误态不会被静默刷新覆盖掉 loading 提示）
  usePolling(
    () => {
      if (selectedId) void fetchOverview(selectedId, { silent: true });
    },
    OVERVIEW_POLL_MS,
    [selectedId, fetchOverview],
    { immediate: false },
  );

  const handleRefresh = useCallback(() => {
    void fetchClusters({ silent: true });
    if (selectedId) void fetchOverview(selectedId);
  }, [fetchClusters, fetchOverview, selectedId]);

  const handleEdit = useCallback((cluster: K8sClusterView) => {
    if (demo) {
      toast.warning(DEMO_DISABLED_HINT, { description: '演示模式不能修改集群（OPENLOG_DEMO=1）' });
      return;
    }
    setFormCluster(cluster);
    setFormOpen(true);
  }, [demo, toast]);

  const handleAdd = useCallback(() => {
    if (demo) {
      toast.warning(DEMO_DISABLED_HINT, { description: '演示模式不能新增集群（OPENLOG_DEMO=1）' });
      return;
    }
    setFormCluster(null);
    setFormOpen(true);
  }, [demo, toast]);

  const handleSaved = useCallback(
    (view: K8sClusterView) => {
      setClusters((prev) => {
        const exists = prev.some((c) => c.id === view.id);
        return exists ? prev.map((c) => (c.id === view.id ? view : c)) : [...prev, view];
      });
      setSelectedId(view.id);
      void fetchClusters({ silent: true });
    },
    [fetchClusters],
  );

  const handleTest = useCallback(async (cluster: K8sClusterView) => {
    setBusyId(cluster.id);
    try {
      const res = await apiJson<K8sTestResponse>(clusterApiPath(cluster.id, '/test'), 'POST');
      const state: K8sTestState =
        res && res.ok === false
          ? { ok: false, text: res.error || '连接失败' }
          : { ok: true, text: `v${res?.version || '?'} · ${res?.nodes ?? 0} 节点` };
      setTestResults((prev) => ({ ...prev, [cluster.id]: state }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [cluster.id]: { ok: false, text: errorText(e) } }));
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleDelete = useCallback(
    async (cluster: K8sClusterView) => {
      if (demo) {
        toast.warning(DEMO_DISABLED_HINT, { description: '演示模式不能删除集群（OPENLOG_DEMO=1）' });
        return;
      }
      const confirmed = window.confirm(
        `删除集群「${cluster.name}」？\n只会删除本地保存的 kubeconfig，集群本身不受影响。`,
      );
      if (!confirmed) return;
      setBusyId(cluster.id);
      try {
        await apiJson<K8sOkResponse>(clusterApiPath(cluster.id, ''), 'DELETE');
        setTestResults((prev) => {
          const next = { ...prev };
          delete next[cluster.id];
          return next;
        });
        toast.success(`已删除集群 ${cluster.name}`);
        // fetchClusters 会把 selectedId 修正到仍然存在的集群（或 null）
        await fetchClusters({ silent: true });
      } catch (e) {
        setClustersError(errorText(e));
      } finally {
        setBusyId(null);
      }
    },
    [demo, fetchClusters, toast],
  );

  const handleSelectPod = useCallback((pod: K8sPod) => {
    setLogTarget({ namespace: pod.namespace, pod: pod.name });
  }, []);

  // 深链：/k8s?cluster=<id> 直接展开该集群（截图、分享、排障时都省一次点击）
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const wanted = searchParams.get('cluster');
    if (wanted && wanted !== selectedId) setSelectedId(wanted);
    // 只在首次挂载或 URL 参数变化时跟随
  }, [searchParams]);   // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCluster = useMemo(
    () => clusters.find((c) => c.id === selectedId) ?? null,
    [clusters, selectedId],
  );
  /**
   * 集群 id 的「一定有值」版本。usage / policy 面板与 Pod 操作条都要靠它拼路径，
   * 渲染前先判断：没有选中的集群就整块不渲染（组件内部按 clusterId: string 收参，
   * 不能让 undefined 漏进去变成 `/api/k8s/clusters/undefined/usage`）。
   */
  const activeClusterId = selectedCluster?.id ?? null;
  /** 操作成功后的「reload」：重拉这一份 overview（写操作会改变 Pod / 工作负载状态）。 */
  const reloadOverview = useCallback(() => {
    if (activeClusterId) void fetchOverview(activeClusterId);
  }, [activeClusterId, fetchOverview]);
  const namespaces = useMemo(() => listNamespaces(overview?.pods ?? []), [overview]);
  const selectedPodKey = logTarget ? `${logTarget.namespace}/${logTarget.pod}` : null;

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent-500/20">
            <Boxes className="w-6 h-6 text-accent-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-dark-100">Kubernetes 集群</h1>
            <p className="text-xs text-dark-500">
              {clusters.length === 0
                ? '尚未接入集群'
                : `${clusters.length} 个集群 · 当前 ${selectedCluster?.name ?? '未选择'}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastRefreshed && selectedId && (
            <span className="text-xs text-dark-500">
              上次刷新 {new Date(lastRefreshed).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={clustersLoading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-dark-800 text-dark-300 text-sm hover:bg-dark-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${clustersLoading ? 'animate-spin' : ''}`} />
            刷新
          </button>
          <button
            onClick={handleAdd}
            disabled={demo}
            title={demo ? DEMO_DISABLED_HINT : '新增集群'}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600 transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent-500"
          >
            <Plus className="w-4 h-4" />
            新增集群
          </button>
        </div>
      </div>

      {clustersError && <ErrorBar message={clustersError} onRetry={() => void fetchClusters()} />}

      {demo && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-300">
          演示模式：集群<span className="font-medium">新增 / 删除</span>已禁用，只保留只读浏览
          （节点、Pod、事件与 Pod 日志照常可见）。
        </div>
      )}

      {/* 手风琴：每个集群一行，点开在下方内联展开全部信息（不再左右分栏） */}
      {clustersLoading && clusters.length === 0 ? (
        <LoadingBlock label="正在加载集群列表…" />
      ) : clusters.length === 0 ? (
        <EmptyClusters onAdd={handleAdd} />
      ) : (
        <ClusterAccordion
          clusters={clusters}
          expandedId={selectedId}
          busyId={busyId}
          testResults={testResults}
          onToggle={(id) => setSelectedId((prev) => (prev === id ? null : id))}
          onTest={(cluster) => void handleTest(cluster as never)}
          onEdit={(cluster) => handleEdit(cluster as never)}
          onDelete={(cluster) => void handleDelete(cluster as never)}
          disabledReason={demo ? DEMO_DISABLED_HINT : null}
          renderDetail={(cluster) => (
            <>
              {overviewError && (
                <ErrorBar
                  message={`概览读取失败：${overviewError}`}
                  onRetry={() => void fetchOverview(cluster.id)}
                />
              )}

              {overviewLoading && !overview ? (
                <LoadingBlock label="正在读取集群概览…" />
              ) : overview ? (
                <>
                  <div className="glass rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dark-500">
                    <span>
                      版本 <span className="font-mono text-dark-300">{overview.cluster.version || '—'}</span>
                    </span>
                    <span className="min-w-0 truncate" title={overview.cluster.server || cluster.server}>
                      server <span className="font-mono text-dark-300">{overview.cluster.server || cluster.server || '—'}</span>
                    </span>
                    <span className="min-w-0 truncate" title={overview.cluster.context || cluster.context}>
                      context <span className="font-mono text-dark-300">{overview.cluster.context || cluster.context || '—'}</span>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className={overview.summary.workloadsUnready > 0 ? 'text-amber-400' : 'text-dark-400'}>
                        {overview.summary.workloadsUnready > 0
                          ? `${overview.summary.workloadsUnready} 个工作负载副本不足`
                          : '工作负载就绪'}
                      </span>
                    </span>
                  </div>

                  <StatCards summary={overview.summary} />
                  {/* 顺序：节点表 → GPU 分配 → GPU 使用率 → 调度策略 → Warning 摘要 → Pod 表 → 事件 */}
                  <NodeTable nodes={overview.nodes} />
                  <GpuAllocation gpu={overview.gpu} />
                  {activeClusterId && <GpuUsagePanel clusterId={activeClusterId} />}
                  {activeClusterId && <PolicyPanel clusterId={activeClusterId} />}
                  {activeClusterId && <WarningDigestPanel clusterId={activeClusterId} />}
                  <PodTable
                    pods={overview.pods}
                    namespaces={namespaces}
                    namespace={namespace}
                    onNamespaceChange={setNamespace}
                    selectedKey={selectedPodKey}
                    onSelect={handleSelectPod}
                    showVgpu={hasHamiData(overview.gpu)}
                    renderRowActions={
                      activeClusterId
                        ? (pod) => (
                            <PodOpsBar
                              clusterId={activeClusterId}
                              namespace={pod.namespace}
                              podName={pod.name}
                              workload={podWorkloadRef(pod) ?? undefined}
                              onDone={reloadOverview}
                            />
                          )
                        : undefined
                    }
                  />
                  <EventList events={overview.events} />
                </>
              ) : null}
            </>
          )}
        />
      )}

      {formOpen && (
        <ClusterForm
          cluster={formCluster}
          onClose={() => {
            setFormOpen(false);
            setFormCluster(null);
          }}
          onSaved={handleSaved}
        />
      )}

      {logTarget && selectedCluster && (
        <LogDrawer
          key={`${selectedCluster.id}:${logTarget.namespace}/${logTarget.pod}`}
          clusterId={selectedCluster.id}
          target={logTarget}
          onClose={() => setLogTarget(null)}
        />
      )}
    </div>
  );
}