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
  K8sGpuDevice,
  K8sGpuNode,
  K8sGpuNodeDevice,
  K8sGpuOverview,
  K8sGpuPod,
  K8sGpuTotals,
  K8sNode,
  K8sOverview,
  K8sPod,
  K8sPodVgpu,
  K8sPodWorkloadRef,
  K8sSummary,
  K8sWorkload,
  K8sLogTarget,
} from './types';

/** 命名空间过滤的「全部」哨兵值（<select> 的空 option）。 */
export const ALL_NAMESPACES = '';

/** 缺字段统一显示这个，绝不把 NaN / undefined 渲染到界面上。 */
export const MISSING = '—';

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

/**
 * 从 Pod 的归属信息推导「可操作的工作负载」——**推导不出来就返回 null，绝不猜**。
 *
 * 为什么值得单独一个函数：Pod 的 ownerReferences 一般是 ReplicaSet
 * （`deploy-<hash>`），从 RS 名反推 Deployment 名会猜错（哈希长度、多级 owner 都可能变），
 * 一旦猜错，「滚动重启」就会打到另一个工作负载上。所以只认服务端明确下发的
 * ownerKind/ownerName，且只接受 Deployment / StatefulSet 两种 kind。
 *
 * 返回的 kind 与写操作路由的 `:kind` 段一致（小写复数）。
 */
export function podWorkloadRef(pod: K8sPod): K8sPodWorkloadRef | null {
  const rawKind = (pod.ownerKind ?? '').trim();
  const name = (pod.ownerName ?? '').trim();
  if (!rawKind || !name) return null;
  const kind = rawKind.toLowerCase();
  if (kind === 'deployment' || kind === 'deployments') return { kind: 'deployments', name };
  if (kind === 'statefulset' || kind === 'statefulsets') return { kind: 'statefulsets', name };
  // DaemonSet / ReplicaSet / Job / 裸 Pod：没有「重启」「扩缩容」语义，只留删除
  return null;
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

// ─── HAMi vGPU ────────────────────────────────────────────────────────────
//
// 契约见 /tmp/hami-contract.md。这一层的全部意义是「显示得对」：
//   · 字段缺失 / NaN / 负值 → 「—」或 0，绝不把 NaN / undefined 渲染出来；
//   · 单位换算只做一次（服务端给 MiB 与算力点，这里换成 GiB 与 %）；
//   · 渲染判据只有一个：gpu.hasHami。没有 HAMi 的集群不出现卡片，也不出现 vGPU 列。

/** 数字兜底：NaN/Infinity/非数字 → 0。 */
export function toFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * MiB → 「96 GiB」/「512 MiB」。
 * 整 GiB 不带小数（96 GiB），非整带一位（1.5 GiB）；缺失或负数 → 「—」。
 */
export function formatMib(memMiB: number | null | undefined): string {
  if (memMiB === null || memMiB === undefined) return MISSING;
  const mib = Number(memMiB);
  if (!Number.isFinite(mib) || mib < 0) return MISSING;
  if (mib === 0) return '0 MiB';
  if (mib >= 1024) {
    const gib = mib / 1024;
    return `${Number.isInteger(gib) ? gib : Math.round(gib * 10) / 10} GiB`;
  }
  return `${Math.round(mib)} MiB`;
}

/** 算力点 → 「40%」（100 = 整卡）；缺失/负数 → 「—」。 */
export function formatCores(cores: number | null | undefined): string {
  if (cores === null || cores === undefined) return MISSING;
  const n = Number(cores);
  if (!Number.isFinite(n) || n < 0) return MISSING;
  return `${Math.round(n)}%`;
}

/**
 * Pod 的分配量文案：0 / 缺失都给「—」。
 * 与 formatMib 的区别：节点上的「0 MiB 已分配」是有意义的信息，
 * 而一个 Pod 分到 0 MiB 显存只可能是字段缺失（真实分配不会是 0），
 * 显示成「0 MiB」会让人以为它真的占了 0。
 */
export function formatAllocMib(memMiB: number | null | undefined): string {
  return toFiniteNumber(memMiB) > 0 ? formatMib(memMiB) : MISSING;
}

/** 同 formatAllocMib，算力点版本。 */
export function formatAllocCores(cores: number | null | undefined): string {
  return toFiniteNumber(cores) > 0 ? formatCores(cores) : MISSING;
}

/**
 * 整数文案（卡数 / 槽位数 / Pod 数 / 算力点）。
 * 缺字段时给「—」——直接把 undefined 插进 JSX 会渲染成 "undefined 张卡"。
 */
export function formatCount(value: number | null | undefined): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : MISSING;
}

/**
 * MiB 原文 → 「49140 MiB」。
 *
 * 为什么不用 formatMib（→ GiB）：物理卡这一行要跟 243 上的 register 原文对齐
 * （`devmem: 49140`），工程师拿界面数字直接和 `kubectl get node -o yaml` 的注解对得上；
 * 换成「48 GiB」会丢精度也变得没法对照。Pod 行仍然用 GiB（那里在意的是体量）。
 */
export function formatMibRaw(memMiB: number | null | undefined): string {
  const mib = Number(memMiB);
  if (!Number.isFinite(mib) || mib < 0) return MISSING;
  return `${Math.round(mib)} MiB`;
}

/**
 * GPU UUID 短 id：「GPU-86d14e75-1e54-…」→「GPU-86d1…」。
 *
 * 用途有两个：物理卡没有型号时当标识（真机 register 的 `type` 可能为空），
 * 以及 title 里给人眼在长列表里比对。不截断非 GPU- 前缀的 id（可能不是 UUID）。
 */
export function shortGpuId(id: string | null | undefined): string {
  const text = (id ?? '').trim();
  if (text === '') return MISSING;
  if (text.startsWith('GPU-') && text.length > 12) return `GPU-${text.slice(4, 8)}…`;
  if (text.length > 16) return `${text.slice(0, 12)}…`;
  return text;
}

/** 槽位文案：「10 槽位」；缺失/0 → 「—」（槽位 0 只可能是没上报）。 */
export function formatSlots(slots: number | null | undefined): string {
  const n = Number(slots);
  if (!Number.isFinite(n) || n <= 0) return MISSING;
  return `${Math.round(n)} 槽位`;
}

/**
 * 一张物理卡的一行摘要（真机形态）：
 *   `NVIDIA GeForce RTX 4090 · 49140 MiB · 10 槽位 · 已分配 23552 MiB（48%）`
 *
 * 段与段之间「有才写」：
 *   · 有 `type` 写型号，没有就写短 id（`GPU-86d1…`）；
 *   · 显存 / 槽位为 0 或缺失 → 整段省略（不是「0 MiB 0 槽位」这种噪音）；
 *   · 「已分配」只在知道容量时带百分比，容量未知就只报绝对值；
 *   · 全部字段都缺 → 单个「—」，绝不出现 NaN / undefined。
 */
export function deviceLabel(device: K8sGpuNodeDevice): string {
  const parts: string[] = [];
  const type = (device.type ?? '').trim();
  parts.push(type !== '' ? type : shortGpuId(device.id));

  const totalMem = toFiniteNumber(device.memMiB);
  if (totalMem > 0) parts.push(formatMibRaw(totalMem));

  if (toFiniteNumber(device.slots) > 0) parts.push(formatSlots(device.slots));

  const usedMem = toFiniteNumber(device.allocatedMemMiB);
  if (totalMem > 0) {
    const percent = usagePercent(usedMem, totalMem);
    parts.push(`已分配 ${formatMibRaw(usedMem)}${percent === null ? '' : `（${percent}%）`}`);
  } else if (usedMem > 0) {
    parts.push(`已分配 ${formatMibRaw(usedMem)}`);
  }

  return parts.filter((part) => part !== '' && part !== MISSING).join(' · ') || MISSING;
}

/**
 * 卡片表头的卡量文案。
 *
 * 真机（服务端给了 physicalCount / slots）：`2 张物理卡 · 20 个 vGPU 槽位`；
 * 旧服务端没有这两个字段：退回 `N 张卡`（nvidia.com/gpu 的语义，可能等于槽位数）。
 */
export function gpuCardsLabel(totals: K8sGpuTotals | null | undefined): string {
  if (!totals) return MISSING;
  const physical = Number(totals.physicalCount);
  const slots = Number(totals.slots);
  const hasPhysical = Number.isFinite(physical) && physical > 0;
  const hasSlots = Number.isFinite(slots) && slots > 0;
  if (hasPhysical && hasSlots) {
    return `${Math.round(physical)} 张物理卡 · ${Math.round(slots)} 个 vGPU 槽位`;
  }
  if (hasPhysical) return `${Math.round(physical)} 张物理卡`;
  const count = Number(totals.gpuCount);
  return Number.isFinite(count) ? `${Math.round(count)} 张卡` : MISSING;
}

/**
 * 节点行的卡量文案：有物理卡明细就报明细，否则退回 `N 张卡`。
 * （真机上 `count` 是物理卡数、`nvidia.com/gpu` 是槽位数，混用会自相矛盾。）
 */
export function nodeCardsLabel(node: K8sGpuNode | null | undefined): string {
  if (!node) return '卡数未知';
  const devices = Array.isArray(node.devices) ? node.devices : [];
  if (devices.length > 0) {
    const slots = devices.reduce((sum, device) => sum + toFiniteNumber(device.slots), 0);
    return slots > 0 ? `${devices.length} 张物理卡 · ${slots} 个槽位` : `${devices.length} 张物理卡`;
  }
  const count = Number(node.count);
  return Number.isFinite(count) ? `${Math.round(count)} 张卡` : '卡数未知';
}

/**
 * 两个 GPU id 是否**严格**相同（忽略大小写；空串不算命中）。
 *
 * 前缀匹配不在这一层：真机注解里是完整 UUID，两边一致；
 * 演示 / 手写注解可能只写前缀（`GPU-3f2a`），那一步必须额外要求「唯一命中」，
 * 否则一个短 id 会同时命中同前缀的多张卡（见 matchNodeDevice）。
 */
export function sameGpuId(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase();
  const right = (b ?? '').trim().toLowerCase();
  return left !== '' && left === right;
}

/**
 * 把 Pod 的某段设备分配挂到节点物理卡上；匹配不上返回 null。
 * 先精确匹配（真机路径）；再退一步按前缀匹配，且**只有唯一候选**时才认。
 */
function matchNodeDevice(
  podDevice: K8sGpuDevice,
  devices: K8sGpuNodeDevice[],
): K8sGpuNodeDevice | null {
  const id = (podDevice.id ?? '').trim();
  if (id === '') return null;
  const exact = devices.find((device) => sameGpuId(device.id, id));
  if (exact) return exact;
  const lowered = id.toLowerCase();
  const prefixed = devices.filter((device) => {
    const candidate = (device.id ?? '').trim().toLowerCase();
    return candidate !== '' && (candidate.startsWith(lowered) || lowered.startsWith(candidate));
  });
  return prefixed.length === 1 ? prefixed[0] : null;
}

/** 某张物理卡上的一段分配（Pod 视角，只算这张卡）。 */
export interface GpuDeviceAllocation {
  pod: K8sGpuPod;
  memMiB: number;
  cores: number;
}

/** 物理卡分组结果：每张卡上挂了哪些 Pod，以及没匹配到任何卡的 Pod。 */
export interface GpuNodeDeviceGroup {
  device: K8sGpuNodeDevice;
  allocations: GpuDeviceAllocation[];
}

/**
 * 按**物理卡**给一个节点上的占卡 Pod 分组（真机展示的核心一步）。
 *
 * 没有 `devices` 的旧服务端返回空数组，调用方据此退回「节点聚合 + 平铺 Pod 表」。
 * 一个 Pod 占多张卡时会在每张卡下各出现一次，显存/算力只算这张卡那一段
 * （否则一张卡的「已分配」会被另一张卡的份额撑爆）。
 */
export function gpuDeviceGroups(
  node: K8sGpuNode | null | undefined,
  pods: K8sGpuPod[] | null | undefined,
): { groups: GpuNodeDeviceGroup[]; unassigned: GpuDeviceAllocation[] } {
  const devices = Array.isArray(node?.devices) ? node?.devices ?? [] : [];
  const podList = Array.isArray(pods) ? pods : [];
  if (devices.length === 0) return { groups: [], unassigned: [] };

  const groups: GpuNodeDeviceGroup[] = devices.map((device) => ({ device, allocations: [] }));
  const unassigned: GpuDeviceAllocation[] = [];

  for (const pod of podList) {
    const podDevices = Array.isArray(pod.devices) ? pod.devices : [];
    const hits = new Set<GpuNodeDeviceGroup>();
    for (const podDevice of podDevices) {
      const nodeDevice = matchNodeDevice(podDevice, devices);
      if (!nodeDevice) continue;
      const group = groups.find((item) => item.device === nodeDevice);
      if (!group) continue;
      hits.add(group);
      group.allocations.push({
        pod,
        memMiB: toFiniteNumber(podDevice.memMiB),
        cores: toFiniteNumber(podDevice.cores),
      });
    }
    // 有设备列表但一个都对不上（注解里的 UUID 与 register 不一致）：
    // 挂到「未归属」，宁可多显示一行也不要静默吞掉 podCount
    if (hits.size === 0) {
      unassigned.push({
        pod,
        memMiB: toFiniteNumber(pod.totalMemMiB),
        cores: toFiniteNumber(pod.totalCores),
      });
    }
  }

  return { groups, unassigned };
}

/**
 * 已分配 / 总量 的百分比（0..100 取整）。
 * 总量缺失或为 0 时返回 null（进度条不画、文案显示「—」），而不是 NaN / Infinity。
 */
export function usagePercent(
  allocated: number | null | undefined,
  total: number | null | undefined,
): number | null {
  const used = Number(allocated);
  const all = Number(total);
  if (!Number.isFinite(used) || !Number.isFinite(all) || all <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / all) * 100)));
}

/** 设备类型字段：非空字符串才算有（空串/缺失都是「没写型号」）。 */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 服务端给的 vgpu 字段 → 固定形状；缺失/非对象 → null。 */
export function normalizeVgpu(raw: unknown): K8sPodVgpu | null {
  if (!raw || typeof raw !== 'object') return null;
  const bag = raw as Partial<K8sPodVgpu>;
  const devices = (Array.isArray(bag.devices) ? bag.devices : [])
    .filter((device) => device && typeof device === 'object')
    .map((device) => {
      const type = optionalText(device.type);
      return {
        id: typeof device.id === 'string' ? device.id : '',
        memMiB: toFiniteNumber(device.memMiB),
        cores: toFiniteNumber(device.cores),
        // 两段格式（`<uuid>,<type>`）没有显存/算力，但有型号；保留它供展示
        ...(type ? { type } : {}),
      };
    });
  const sumMem = devices.reduce((sum, device) => sum + device.memMiB, 0);
  const sumCores = devices.reduce((sum, device) => sum + device.cores, 0);
  return {
    hasVgpu: bag.hasVgpu === true || devices.length > 0,
    devices,
    // 服务端没给合计时就按卡加起来（缺字段不该显示成 0）
    totalMemMiB: toFiniteNumber(bag.totalMemMiB) || sumMem,
    totalCores: toFiniteNumber(bag.totalCores) || sumCores,
    nodeName: typeof bag.nodeName === 'string' && bag.nodeName !== '' ? bag.nodeName : null,
  };
}

/** Pod 表格的 vGPU 列：「12 GiB · 40%」；没有分配 → 「—」。 */
export function vgpuLabel(vgpu: K8sPodVgpu | null | undefined): string {
  const normalized = normalizeVgpu(vgpu);
  if (!normalized || !normalized.hasVgpu) return MISSING;
  const parts = [
    formatAllocMib(normalized.totalMemMiB),
    formatAllocCores(normalized.totalCores),
  ].filter((part) => part !== MISSING);
  return parts.length > 0 ? parts.join(' · ') : MISSING;
}

/**
 * 节点的物理卡明细 → 固定形状。
 * 旧服务端没有这个字段（或给的不是数组）→ `undefined`（不是空数组）：
 * 「没有物理卡信息」和「有信息但一张卡都没上报」在前端是两种展现。
 */
function normalizeNodeDevices(raw: unknown): K8sGpuNodeDevice[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const devices = raw
    .filter((device) => device && typeof device === 'object')
    .map((device) => {
      const type = optionalText(device.type);
      const slots = toFiniteNumber(device.slots);
      return {
        id: typeof device.id === 'string' ? device.id : '',
        ...(type ? { type } : {}),
        memMiB: toFiniteNumber(device.memMiB),
        cores: toFiniteNumber(device.cores),
        // slots 缺失时留 undefined（渲染时整段省略），不要兜成 0 变成「0 槽位」
        ...(Number.isFinite(Number(device.slots)) && slots > 0 ? { slots } : {}),
        allocatedMemMiB: toFiniteNumber(device.allocatedMemMiB),
        allocatedCores: toFiniteNumber(device.allocatedCores),
        podCount: toFiniteNumber(device.podCount),
        ...(typeof device.health === 'boolean' ? { health: device.health } : {}),
      };
    });
  return devices;
}

/** `overview.gpu` → 固定形状；缺失/非对象 → null。 */
export function normalizeGpu(raw: unknown): K8sGpuOverview | null {
  if (!raw || typeof raw !== 'object') return null;
  const bag = raw as Partial<K8sGpuOverview>;

  const nodes: K8sGpuNode[] = (Array.isArray(bag.nodes) ? bag.nodes : [])
    .filter((node) => node && typeof node === 'object')
    .map((node) => {
      const devices = normalizeNodeDevices(node.devices);
      return {
        name: typeof node.name === 'string' ? node.name : '',
        count: toFiniteNumber(node.count),
        memMiB: toFiniteNumber(node.memMiB),
        cores: toFiniteNumber(node.cores),
        allocatedMemMiB: toFiniteNumber(node.allocatedMemMiB),
        allocatedCores: toFiniteNumber(node.allocatedCores),
        podCount: toFiniteNumber(node.podCount),
        ...(devices ? { devices } : {}),
      };
    });

  const pods: K8sGpuPod[] = (Array.isArray(bag.pods) ? bag.pods : [])
    .filter((pod) => pod && typeof pod === 'object')
    .map((pod) => {
      const vgpu = normalizeVgpu({ ...pod, hasVgpu: true }) ?? {
        hasVgpu: true,
        devices: [],
        totalMemMiB: 0,
        totalCores: 0,
        nodeName: null,
      };
      return {
        namespace: typeof pod.namespace === 'string' ? pod.namespace : '',
        name: typeof pod.name === 'string' ? pod.name : '',
        nodeName: typeof pod.nodeName === 'string' && pod.nodeName !== '' ? pod.nodeName : null,
        devices: vgpu.devices,
        totalMemMiB: vgpu.totalMemMiB,
        totalCores: vgpu.totalCores,
        phase: typeof pod.phase === 'string' ? pod.phase : '',
      };
    });

  // 服务端 totals 缺席时按节点/ Pod 重算（口径与后端 summarizeVgpu 一致）
  const totals = bag.totals && typeof bag.totals === 'object' ? bag.totals : null;
  const sum = (list: number[]) => list.reduce((acc, n) => acc + toFiniteNumber(n), 0);
  const hasDevices = nodes.some((node) => (node.devices?.length ?? 0) > 0);
  const derivedPhysical = hasDevices
    ? sum(nodes.map((node) => toFiniteNumber(node.devices?.length)))
    : 0;
  const derivedSlots = hasDevices
    ? sum(nodes.map((node) => sum((node.devices ?? []).map((device) => toFiniteNumber(device.slots)))))
    : 0;

  return {
    hasHami: bag.hasHami === true,
    nodes,
    pods,
    totals: {
      gpuCount: toFiniteNumber(totals?.gpuCount) || sum(nodes.map((node) => node.count)),
      memMiB: toFiniteNumber(totals?.memMiB) || sum(nodes.map((node) => node.memMiB)),
      cores: toFiniteNumber(totals?.cores) || sum(nodes.map((node) => node.cores)),
      allocatedMemMiB:
        toFiniteNumber(totals?.allocatedMemMiB) || sum(nodes.map((node) => node.allocatedMemMiB)),
      allocatedCores:
        toFiniteNumber(totals?.allocatedCores) || sum(nodes.map((node) => node.allocatedCores)),
      podCount: toFiniteNumber(totals?.podCount) || pods.length,
      // 旧服务端没有这两个字段：缺席就**不写**，表头退回「N 张卡」
      ...(toFiniteNumber(totals?.physicalCount) > 0
        ? { physicalCount: toFiniteNumber(totals?.physicalCount) }
        : derivedPhysical > 0
          ? { physicalCount: derivedPhysical }
          : {}),
      ...(toFiniteNumber(totals?.slots) > 0
        ? { slots: toFiniteNumber(totals?.slots) }
        : derivedSlots > 0
          ? { slots: derivedSlots }
          : {}),
    },
    warnings: (Array.isArray(bag.warnings) ? bag.warnings : [])
      .filter((warning): warning is string => typeof warning === 'string' && warning !== '')
      .slice(0, 5),
  };
}

/** 是否有 HAMi 数据 —— 卡片与 vGPU 列的唯一渲染判据（没有 HAMi 时行为完全不变）。 */
export function hasHamiData(gpu: K8sGpuOverview | null | undefined): boolean {
  return Boolean(gpu && gpu.hasHami === true);
}

/**
 * 服务端只在 Pod 上挂了 `vgpu`（overview/pods 都有）时才直接用；
 * 只给 `gpu.pods` 的响应（旧版服务端 / 演示）在这里按 namespace+name 补齐。
 */
export function withPodVgpu(pods: K8sPod[], gpu: K8sGpuOverview | null | undefined): K8sPod[] {
  if (!hasHamiData(gpu) || !gpu) return pods;
  const byKey = new Map<string, K8sGpuPod>();
  for (const pod of gpu.pods) byKey.set(`${pod.namespace}/${pod.name}`, pod);
  if (byKey.size === 0) return pods;
  return pods.map((pod) => {
    if (pod.vgpu) return pod;
    const hit = byKey.get(`${pod.namespace}/${pod.name}`);
    if (!hit) return pod;
    return {
      ...pod,
      vgpu: {
        hasVgpu: hit.devices.length > 0 || hit.totalMemMiB > 0 || hit.totalCores > 0,
        devices: hit.devices,
        totalMemMiB: hit.totalMemMiB,
        totalCores: hit.totalCores,
        nodeName: hit.nodeName,
      },
    };
  });
}

/**
 * 按节点分组「占着卡的 Pod」，节点顺序跟 gpu.nodes 一致，
 * 多出来的节点（Pod 有分配但节点没上报 GPU 数）追加在后面；没 nodeName 的归到「—」。
 */
export function gpuPodsByNode(
  gpu: K8sGpuOverview | null | undefined,
): Array<{ node: string; pods: K8sGpuPod[] }> {
  if (!gpu) return [];
  const order: string[] = [];
  const buckets = new Map<string, K8sGpuPod[]>();
  const bucketOf = (name: string): K8sGpuPod[] => {
    const key = name || MISSING;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    return bucket;
  };

  for (const node of gpu.nodes) bucketOf(node.name);
  for (const pod of gpu.pods) bucketOf(pod.nodeName ?? '');
  for (const pod of gpu.pods) bucketOf(pod.nodeName ?? '').push(pod);

  return order.map((node) => ({ node, pods: buckets.get(node) ?? [] }));
}

/**
 * 把 overview 响应补齐成完整形状。
 * 服务端缺字段时页面不该整页白屏，所以数组一律兜成 []，summary 缺了就地重算；
 * `gpu` 段缺席（旧版服务端/演示）时是 null，页面据此不渲染 GPU 卡片。
 */
export function ensureOverview(raw: Partial<K8sOverview> | null | undefined): K8sOverview | null {
  if (!raw || typeof raw !== 'object') return null;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const workloads = Array.isArray(raw.workloads) ? raw.workloads : [];
  const events = Array.isArray(raw.events) ? raw.events : [];
  const gpu = normalizeGpu(raw.gpu);
  // 服务端没在 Pod 上挂 vgpu（只给了 gpu.pods）时就地补齐，Pod 表的 vGPU 列才不会空着
  const pods = withPodVgpu(Array.isArray(raw.pods) ? raw.pods : [], gpu);
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
    gpu,
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
