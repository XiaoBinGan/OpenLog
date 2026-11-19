/**
 * K8s 页面的纯函数工具层。
 *
 * 放这里而不是散在组件里，是因为下面这些判断「错了不会报错，只会显示成另一回事」：
 *   · Pod 是否健康（ready "1/1" 字符串解析、OOM、CrashLoop 的优先级）
 *   · 概览统计（服务端 summary 缺席时的本地兜底）
 *   · 请求路径拼装（namespace / pod 名可能带 `/`，必须 encodeURIComponent）
 * 它们都不依赖 React、不发请求，因此可以被 vitest 直接按表驱动测试。
 */

import type {
  K8sEvent,
  K8sNode,
  K8sOverview,
  K8sPod,
  K8sSummary,
  K8sWorkload,
  K8sLogTarget,
} from './types';

/** 命名空间过滤的「全部」哨兵值（<select> 的空 option）。 */
export const ALL_NAMESPACES = '';

/** 日志抽屉默认拉取的行数（契约：?tail=200）。 */
export const LOG_TAIL = 200;

/** Pod 健康档位：error（OOM/CrashLoop/Failed）> warn（未就绪/非 Running）> ok。 */
export type PodSeverity = 'error' | 'warn' | 'ok';

/** 统计卡描述（渲染层只负责套样式）。 */
export interface StatCard {
  key: string;
  label: string;
  value: string;
  hint: string;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
}

/** 把任意抛出的东西收敛成一句可展示的中文错误。 */
export function errorText(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return '请求失败，请查看服务端日志';
}

/** `/api/k8s/clusters/:id` + 后缀。所有集群相关请求都从这里拼，避免写死后端地址。 */
export function clusterApiPath(clusterId: string, suffix: string): string {
  return `/api/k8s/clusters/${encodeURIComponent(clusterId)}${suffix}`;
}

/**
 * Pod 日志路径。
 * tail 会被夹到 [1, 5000]：负数或 NaN 会让服务端 400 或把整个日志读进内存。
 */
export function podLogsPath(clusterId: string, target: K8sLogTarget, tail: number = LOG_TAIL): string {
  const safeTail = Number.isFinite(tail) ? Math.min(5000, Math.max(1, Math.floor(tail))) : LOG_TAIL;
  return clusterApiPath(
    clusterId,
    `/pods/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.pod)}/logs?tail=${safeTail}`,
  );
}

/** Pod 的稳定标识（列表 key、抽屉选中态都用它）。 */
export function podKey(pod: Pick<K8sPod, 'namespace' | 'name'>): string {
  return `${pod.namespace}/${pod.name}`;
}

/**
 * Pod 是否「就绪」。
 * ready 字段是 "1/1" 这样的字符串；缺失时退回容器的 ready 标记，
 * 再不行才用 phase 猜 —— 三种来源的可靠性依次递减。
 */
export function isPodReady(pod: K8sPod): boolean {
  const matched = /^(\d+)\s*\/\s*(\d+)$/.exec((pod.ready ?? '').trim());
  if (matched) {
    const ready = Number(matched[1]);
    const total = Number(matched[2]);
    return total > 0 && ready === total;
  }
  const containers = Array.isArray(pod.containers) ? pod.containers : [];
  if (containers.length > 0) return containers.every((c) => c.ready);
  return pod.phase === 'Running' || pod.phase === 'Succeeded';
}

/**
 * Pod 是否异常（统计卡「异常 Pod」与表格排序都用这一处判断，避免口径不一致）。
 *
 * Succeeded 特殊处理：Job 跑完的 Pod ready 是 "0/1"（容器都已退出），
 * 但它显然不是故障 —— 如果按 ready 判，每跑完一个 Job 都会亮一条假告警。
 */
export function isPodUnhealthy(pod: K8sPod): boolean {
  if (pod.oom || pod.crashLoop) return true;
  if (pod.phase === 'Succeeded') return false;
  if (pod.phase !== 'Running') return true;
  return !isPodReady(pod);
}

/** Pod 健康档位。OOM / CrashLoop / Failed 直接算 error，其它未就绪算 warn。 */
export function podSeverity(pod: K8sPod): PodSeverity {
  if (pod.oom || pod.crashLoop || pod.phase === 'Failed') return 'error';
  if (pod.phase === 'Succeeded') return 'ok';
  if (pod.phase !== 'Running') return 'warn';
  return isPodReady(pod) ? 'ok' : 'warn';
}

/** 表格里要显示的标记（OOMKilled / CrashLoopBackOff / 重启 n 次 / 未就绪）。 */
export function podMarkers(pod: K8sPod): string[] {
  const markers: string[] = [];
  if (pod.oom) markers.push('OOMKilled');
  if (pod.crashLoop) markers.push('CrashLoopBackOff');
  if (pod.restarts > 0) markers.push(`重启 ${pod.restarts} 次`);
  if (!isPodReady(pod) && pod.phase === 'Running') markers.push('未就绪');
  const reasons = (Array.isArray(pod.containers) ? pod.containers : [])
    .map((c) => (c.reason ?? '').trim())
    .filter((reason) => reason !== '' && reason !== 'OOMKilled' && reason !== 'CrashLoopBackOff');
  for (const reason of reasons) {
    if (!markers.includes(reason)) markers.push(reason);
  }
  return markers;
}

/** 概览里出现过的命名空间（去重 + 排序，供过滤下拉使用）。 */
export function listNamespaces(pods: K8sPod[]): string[] {
  const set = new Set<string>();
  for (const pod of pods) {
    if (pod.namespace) set.add(pod.namespace);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** 按命名空间（ALL_NAMESPACES = 全部）+ 关键字过滤 Pod。 */
export function filterPods(pods: K8sPod[], namespace: string = ALL_NAMESPACES, keyword = ''): K8sPod[] {
  const needle = keyword.trim().toLowerCase();
  return pods.filter((pod) => {
    if (namespace && pod.namespace !== namespace) return false;
    if (!needle) return true;
    return pod.name.toLowerCase().includes(needle) || pod.node.toLowerCase().includes(needle);
  });
}

/** 异常优先、重启多的优先、再按名字 —— 让「今天要看的东西」自动浮到第一屏。 */
export function sortPods(pods: K8sPod[]): K8sPod[] {
  const rank: Record<PodSeverity, number> = { error: 0, warn: 1, ok: 2 };
  return [...pods].sort((a, b) => {
    const bySeverity = rank[podSeverity(a)] - rank[podSeverity(b)];
    if (bySeverity !== 0) return bySeverity;
    if (b.restarts !== a.restarts) return b.restarts - a.restarts;
    if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
    return a.name.localeCompare(b.name);
  });
}

/** 只看 Warning 事件（服务端已过滤，这里再兜一层，防止 ?type= 被忽略时混入 Normal）。 */
export function warningEvents(events: K8sEvent[]): K8sEvent[] {
  return events.filter((e) => (e.type ?? '').toLowerCase() === 'warning');
}

/**
 * 本地统计（服务端 summary 缺席 / 字段不全时的兜底）。
 * 口径与契约一致：podsUnhealthy 用 isPodUnhealthy，workloadsUnready 用 ready < desired。
 */
export function deriveSummary(parts: {
  nodes?: K8sNode[] | null;
  pods?: K8sPod[] | null;
  workloads?: K8sWorkload[] | null;
  events?: K8sEvent[] | null;
}): K8sSummary {
  const nodes = parts.nodes ?? [];
  const pods = parts.pods ?? [];
  const workloads = parts.workloads ?? [];
  const events = parts.events ?? [];
  return {
    nodes: nodes.length,
    nodesReady: nodes.filter((n) => n.ready).length,
    pods: pods.length,
    podsRunning: pods.filter((p) => p.phase === 'Running').length,
    podsUnhealthy: pods.filter(isPodUnhealthy).length,
    workloads: workloads.length,
    workloadsUnready: workloads.filter((w) => Number(w.ready) < Number(w.desired)).length,
    warningEvents: events.filter((e) => (e.type ?? '').toLowerCase() === 'warning').length,
  };
}

/**
 * 把 overview 响应补齐成完整形状。
 * 服务端缺字段时页面不该整页白屏，所以数组一律兜成 []，summary 缺了就地重算。
 */
export function ensureOverview(raw: Partial<K8sOverview> | null | undefined): K8sOverview | null {
  if (!raw || typeof raw !== 'object') return null;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const pods = Array.isArray(raw.pods) ? raw.pods : [];
  const workloads = Array.isArray(raw.workloads) ? raw.workloads : [];
  const events = Array.isArray(raw.events) ? raw.events : [];
  const summary =
    raw.summary && typeof raw.summary === 'object'
      ? raw.summary
      : deriveSummary({ nodes, pods, workloads, events });
  return {
    cluster: {
      version: raw.cluster?.version ?? '',
      server: raw.cluster?.server ?? '',
      context: raw.cluster?.context ?? '',
    },
    nodes,
    pods,
    workloads,
    events,
    summary,
  };
}

/**
 * kubectl 风格的年龄：30s / 5m / 3h / 2d / 1y。
 * created 解析不出来时返回「—」而不是 NaN 或 1970 年。
 */
export function formatAge(created: string, now: number = Date.now()): string {
  if (!created) return '—';
  const ts = Date.parse(created);
  if (Number.isNaN(ts)) return '—';
  const seconds = Math.floor((now - ts) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

/** 节点角色：k3s 的 `<none>` 视为 worker，避免表格里出现空角色列。 */
export function nodeRolesLabel(roles: string[]): string {
  const cleaned = (Array.isArray(roles) ? roles : [])
    .map((r) => (r ?? '').trim())
    .filter((r) => r !== '' && r !== '<none>');
  return cleaned.length > 0 ? cleaned.join(', ') : 'worker';
}

/** 顶部四张统计卡（值 + 副标题 + 色调）。 */
export function buildStatCards(summary: K8sSummary): StatCard[] {
  const nodesNotReady = Math.max(0, summary.nodes - summary.nodesReady);
  const workloadsUnready = Math.max(0, summary.workloadsUnready);
  return [
    {
      key: 'nodes',
      label: '节点 Ready',
      value: `${summary.nodesReady}/${summary.nodes}`,
      hint: summary.nodes === 0 ? '没有节点' : nodesNotReady === 0 ? '全部就绪' : `${nodesNotReady} 个未就绪`,
      tone: summary.nodes === 0 ? 'neutral' : nodesNotReady === 0 ? 'ok' : 'error',
    },
    {
      key: 'pods',
      label: 'Pod 总数',
      value: String(summary.pods),
      hint: `${summary.podsRunning} Running · ${summary.podsUnhealthy} 异常`,
      tone: summary.podsUnhealthy === 0 ? 'ok' : 'warn',
    },
    {
      key: 'workloads',
      label: '工作负载',
      value: String(summary.workloads),
      hint: workloadsUnready === 0 ? '副本全部就绪' : `${workloadsUnready} 个副本不足`,
      tone: workloadsUnready === 0 ? 'ok' : 'warn',
    },
    {
      key: 'events',
      label: 'Warning 事件',
      value: String(summary.warningEvents),
      hint: summary.warningEvents === 0 ? '暂无告警' : '需要关注',
      tone: summary.warningEvents === 0 ? 'ok' : 'error',
    },
  ];
}
