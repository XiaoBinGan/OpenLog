/**
 * 「GPU 分配 vs 实际使用」卡片。
 *
 * 解决的问题：「GPU 分配（HAMi）」只说这张卡被**许**出去多少显存，
 * 但被许出去的 Pod 可能一个字节都没用 —— 卡上写着「已分配 90%」而 util 只有 3%，
 * 于是「要不要扩容」「能不能再塞一个 Pod」这类判断只能靠猜。
 * 这张卡把两条口径并排放在同一行：HAMi 的**分配**（调度视角）与
 * GPU 的**实测占用**（运行时视角），差距本身就是结论。
 *
 * 数据来源：`GET /api/k8s/clusters/:id/usage`（`server/routes/k8s-usage.js`）
 *   { available, scrapedAt, demo?, reason?,
 *     nodes: [{ name, devices: [{ uuid, type, totalMemMiB, allocMemMiB, usedMemMiB,
 *                                 allocCores, utilPercent, pods }] }] }
 *
 * 三个硬约定：
 *   · `available:false`（HAMi 指标端点抓不到 / 集群没装 DCGM exporter）时
 *     **只加一条琥珀提示条，分配部分照常渲染** —— 分配数据一直是可用的，
 *     因为实测抓不到就把整张卡片藏起来，等于把已知信息也扔了；
 *   · 任何缺字段都显示「—」，绝不把 `NaN` / `undefined` 渲染出来
 *     （单位换算与百分比只在这一个文件里做一次）；
 *   · 实测占用 > 已分配（超卖 / 统计口径不一致）时，实测进度条夹到 100% 并变黄，
 *     否则那一格会画出超过轨道的长度，看起来像样式 bug 而不是数据异常。
 */

import { useCallback, useEffect, useState } from 'react';
import { Cpu, Loader, RefreshCw, TriangleAlert } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { ErrorBar } from './Feedback';
import { MISSING, errorText, shortGpuId } from './utils';

interface GpuUsagePanelProps {
  /** 集群 id（来自左侧集群列表的选中项）。 */
  clusterId: string;
}

/** 一张物理卡的实测/分配（服务端原文，字段一律按「可能存在也可能没有」处理）。 */
interface RawUsageDevice {
  uuid?: unknown;
  type?: unknown;
  /** 卡的总显存（MiB）。契约里 A2 可能命名为 totalMemMiB，这里同时接受 memMiB。 */
  totalMemMiB?: unknown;
  memMiB?: unknown;
  allocMemMiB?: unknown;
  allocCores?: unknown;
  usedMemMiB?: unknown;
  /** 0..100 的百分比（不是 0..1 的比例；A2 负责乘 100 后再下发）。 */
  utilPercent?: unknown;
  pods?: unknown;
}

interface RawUsageNode {
  name?: unknown;
  devices?: unknown;
}

/** `GET /api/k8s/clusters/:id/usage` 的响应。 */
interface RawUsageResponse {
  available?: unknown;
  scrapedAt?: unknown;
  demo?: unknown;
  reason?: unknown;
  nodes?: unknown;
}

/** 归一化后的一张卡：数值要么是有限数字，要么是 null（渲染层统一显示「—」）。 */
interface UsageDevice {
  uuid: string;
  type: string;
  totalMemMiB: number | null;
  allocMemMiB: number | null;
  usedMemMiB: number | null;
  utilPercent: number | null;
  pods: number | null;
}

interface UsageNode {
  name: string;
  mfu?: { available?: boolean; percent?: number | null; engines?: string[]; reason?: string | null };
  devices: UsageDevice[];
}

interface UsageView {
  available: boolean;
  demo: boolean;
  scrapedAt: string | null;
  reason: string | null;
  nodes: UsageNode[];
}

type Status = 'loading' | 'ready' | 'error';

interface PanelState {
  status: Status;
  usage: UsageView | null;
  error: string | null;
}

// ─── 归一化与格式化（全部纯函数，组件只负责套样式） ──────────────────────

/** 只认真正的有限数字（字符串数字也接受）；其余一律 null —— null 会在界面上变成「—」。 */
function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 非负数字（显存/槽位这类不该为负的量，负值视为「没上报」）。 */
function nonNegative(value: unknown): number | null {
  const n = numOrNull(value);
  return n !== null && n >= 0 ? n : null;
}

/** 百分比夹到 [0, 100] 并取整；NaN / Infinity 落成 0（进度条不会画成 Infinity 宽）。 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** 部分 / 总量 → 百分比；总量缺失或 ≤ 0 时返回 null（进度条不画，「—」代替）。 */
function percentOf(part: number | null, total: number | null): number | null {
  if (part === null || total === null || total <= 0) return null;
  return clampPercent((part / total) * 100);
}

/** 百分比文案：「25%」或「—」。 */
function percentLabel(percent: number | null): string {
  return percent === null ? MISSING : `${percent}%`;
}

/** MiB → 「12.0」（GiB，保留一位小数，与卡片行文案一致）；缺失或负数 → 「—」。 */
function gibLabel(memMiB: number | null): string {
  if (memMiB === null || memMiB < 0) return MISSING;
  return (memMiB / 1024).toFixed(1);
}

/** 卡名：优先型号；没有型号就用短 UUID（真机 register 的 type 可能为空）；都没有 → 「—」。 */
function deviceLabel(device: UsageDevice): string {
  const type = device.type.trim();
  if (type !== '') return type;
  return shortGpuId(device.uuid);
}

/**
 * 一行卡摘要（与需求逐字对齐）：
 *   `RTX 4090 · 已分配 12.0/48.0 GiB（25%）· 实测占用 3.2 GiB（7%）· util 41%`
 *
 * 段与段之间固定用「 · 」，缺的字段自己变成「—」而不是整段消失 ——
 * 只有「已分配」在**总量未知**时写成 `12.0/—`，因为总量是这一行的分母，省掉会看不懂。
 */
function deviceLine(device: UsageDevice): string {
  const allocPercent = percentOf(device.allocMemMiB, device.totalMemMiB);
  const usedPercent = percentOf(device.usedMemMiB, device.totalMemMiB);
  const head = deviceLabel(device);
  // 分隔符长度不同：型号后面是「 · 」，全角括号后面直接「· 」（与设计稿逐字一致）
  const rest = [
    `已分配 ${gibLabel(device.allocMemMiB)}/${gibLabel(device.totalMemMiB)} GiB（${percentLabel(allocPercent)}）`,
    `实测占用 ${gibLabel(device.usedMemMiB)} GiB（${percentLabel(usedPercent)}）`,
    `util ${percentLabel(device.utilPercent)}`,
  ].join('· ');
  return `${head} · ${rest}`;
}

/** 实测是否超过分配（超卖 / 口径不一致）：两种口径任一成立就算。 */
function isOvercommitted(device: UsageDevice): boolean {
  const allocPercent = percentOf(device.allocMemMiB, device.totalMemMiB);
  const usedPercent = percentOf(device.usedMemMiB, device.totalMemMiB);
  if (allocPercent !== null && usedPercent !== null && usedPercent > allocPercent) return true;
  return (
    device.allocMemMiB !== null &&
    device.usedMemMiB !== null &&
    device.usedMemMiB > device.allocMemMiB
  );
}

function normalizeDevice(raw: unknown): UsageDevice | null {
  if (!raw || typeof raw !== 'object') return null;
  const bag = raw as RawUsageDevice;
  const util = numOrNull(bag.utilPercent);
  return {
    uuid: typeof bag.uuid === 'string' ? bag.uuid : '',
    type: typeof bag.type === 'string' ? bag.type : '',
    // 总量两种命名都认：契约叫 totalMemMiB，老响应可能叫 memMiB
    totalMemMiB: nonNegative(bag.totalMemMiB) ?? nonNegative(bag.memMiB),
    allocMemMiB: nonNegative(bag.allocMemMiB),
    usedMemMiB: nonNegative(bag.usedMemMiB),
    utilPercent: util === null ? null : clampPercent(util),
    pods: nonNegative(bag.pods),
  };
}

/** 响应 → 固定形状。整个响应不是对象时给「不可用 + 空节点」，页面照常出卡片。 */
function normalizeUsage(raw: RawUsageResponse | null | undefined): UsageView {
  if (!raw || typeof raw !== 'object') {
    return { available: false, demo: false, scrapedAt: null, reason: null, nodes: [] };
  }
  const nodes: UsageNode[] = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .filter((node): node is RawUsageNode => Boolean(node) && typeof node === 'object')
    .map((node) => ({
      name: typeof node.name === 'string' ? node.name : '',
      mfu: (node as RawUsageNode & { mfu?: UsageNode['mfu'] }).mfu,
      devices: (Array.isArray(node.devices) ? node.devices : [])
        .map(normalizeDevice)
        .filter((device): device is UsageDevice => device !== null),
    }));
  const scrapedAt = typeof raw.scrapedAt === 'string' && raw.scrapedAt !== '' ? raw.scrapedAt : null;
  const reason = typeof raw.reason === 'string' && raw.reason.trim() !== '' ? raw.reason.trim() : null;
  return {
    // 只有明确的 available === true 才算可用：字段缺失按「不可用」处理更安全
    // （宁可多一条提示条，也不要让「没数据」被当成「利用率 0%」）
    available: raw.available === true,
    demo: raw.demo === true,
    scrapedAt,
    reason,
    nodes,
  };
}

/** 采样时间 → 本地时间文案；解析不出来 → 「—」（不显示 Invalid Date）。 */
function scrapedLabel(scrapedAt: string | null): string {
  if (!scrapedAt) return MISSING;
  const ts = Date.parse(scrapedAt);
  if (Number.isNaN(ts)) return MISSING;
  return new Date(ts).toLocaleTimeString();
}

// ─── 渲染 ────────────────────────────────────────────────────────────────

/**
 * 一条进度条（与 GpuAllocation 的 UsageBar 同款尺寸/圆角，保证两张卡并排时不打架）。
 *
 * 用 role="progressbar" 而不是纯 div：一是屏幕阅读器能读出真实数值，
 * 二是测试可以直接按角色断言「条被夹到 100% 了没有」，不必去猜 class 名。
 */
function UsageBar({
  label,
  percent,
  tone,
}: {
  label: string;
  percent: number | null;
  tone: 'alloc' | 'used' | 'over';
}) {
  const colorClass =
    tone === 'over' ? 'bg-amber-400' : tone === 'alloc' ? 'bg-accent-500' : 'bg-emerald-400';
  const width = percent === null ? 0 : clampPercent(percent);
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-[10px] text-dark-600">{label}</span>
      <div className="flex-1 min-w-0 h-1.5 rounded-full bg-dark-800 overflow-hidden">
        <div
          role="progressbar"
          aria-label={`${label}进度`}
          aria-valuenow={width}
          aria-valuemin={0}
          aria-valuemax={100}
          className={`h-full rounded-full transition-all ${colorClass}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-[10px] font-mono text-dark-400">
        {percentLabel(percent)}
      </span>
    </div>
  );
}

/** 一张物理卡：一行摘要 + 分配条（主题色）+ 实测条（绿/黄）。 */
function DeviceRow({ device }: { device: UsageDevice }) {
  const allocPercent = percentOf(device.allocMemMiB, device.totalMemMiB);
  const usedPercent = percentOf(device.usedMemMiB, device.totalMemMiB);
  const over = isOvercommitted(device);
  return (
    <div className="mt-1.5 rounded-lg border border-dark-800/50 bg-dark-900/30 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 text-[11px] text-dark-300 break-words" title={device.uuid || MISSING}>
          {deviceLine(device)}
        </span>
        {device.pods !== null && device.pods > 0 && (
          <span className="shrink-0 text-[11px] text-dark-600 font-mono">{device.pods} 个 Pod</span>
        )}
      </div>
      <div className="mt-1.5 space-y-1">
        <UsageBar label="分配" percent={allocPercent} tone="alloc" />
        <UsageBar label="实测" percent={over ? 100 : usedPercent} tone={over ? 'over' : 'used'} />
      </div>
      {over && (
        <div className="mt-1 text-[11px] leading-snug text-amber-300/90">
          实测占用超过分配（超卖或统计口径不一致），实测条已按 100% 截断
        </div>
      )}
    </div>
  );
}

/** 卡片骨架：标题 + 副标题 + 演示角标 + 刷新按钮（加载/错误态共用）。 */
function PanelHeader({
  usage,
  loading,
  onRefresh,
}: {
  usage: UsageView | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const deviceCount = usage
    ? usage.nodes.reduce((sum, node) => sum + node.devices.length, 0)
    : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-dark-800/60">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <Cpu className="w-4 h-4 text-accent-400" />
        <h2 className="text-sm font-semibold text-dark-100">GPU 分配 vs 实际使用</h2>
        {usage && (
          <span className="text-xs text-dark-500">
            {usage.nodes.length} 个节点 · {deviceCount ?? 0} 张卡 · 采样 {scrapedLabel(usage.scrapedAt)}
          </span>
        )}
        {usage?.demo && (
          <span className="rounded-full border border-accent-500/40 bg-accent-500/15 px-2 py-0.5 text-[10px] text-accent-200">
            演示数据
          </span>
        )}
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-dark-800/60 text-xs text-dark-300 hover:bg-dark-700/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        刷新
      </button>
    </div>
  );
}

/**
 * 「GPU 分配 vs 实际使用」卡片。
 *
 * 自己拉 `/usage`（不把请求交给页面）：这张卡片的数据源与 overview 完全独立 ——
 * 实测指标要从 HAMi scheduler 的 metrics 端点抓，慢且可能失败，
 * 而 overview 必须保持可用。两者失败互不牵连，所以各拉各的。
 */
export function GpuUsagePanel({ clusterId }: GpuUsagePanelProps) {
  const [state, setState] = useState<PanelState>({ status: 'loading', usage: null, error: null });
  /** 手动刷新：+1 触发重新请求（不重建组件，滚到一半的位置不丢）。 */
  const [reloadTick, setReloadTick] = useState(0);

  const reload = useCallback(() => {
    setReloadTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    if (!clusterId) {
      setState({ status: 'ready', usage: normalizeUsage(null), error: null });
      return;
    }
    // 关掉上一次请求的回调：快速切集群时，慢响应不能覆盖新集群的数据
    const controller = new AbortController();
    let cancelled = false;
    setState((prev) => ({ status: 'loading', usage: prev.usage, error: null }));

    apiFetch<RawUsageResponse>(`/api/k8s/clusters/${encodeURIComponent(clusterId)}/usage`, {
      signal: controller.signal,
    })
      .then((raw) => {
        if (cancelled) return;
        setState({ status: 'ready', usage: normalizeUsage(raw), error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', usage: null, error: errorText(err) });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [clusterId, reloadTick]);

  const loading = state.status === 'loading';
  const usage = state.usage;
  const deviceCount = usage ? usage.nodes.reduce((sum, node) => sum + node.devices.length, 0) : 0;

  return (
    <div className="glass rounded-xl overflow-hidden">
      <PanelHeader usage={usage} loading={loading} onRefresh={reload} />

      {state.status === 'error' ? (
        <div className="px-4 py-3">
          <ErrorBar message={`GPU 使用数据读取失败：${state.error ?? MISSING}`} onRetry={reload} />
        </div>
      ) : loading && !usage ? (
        <div className="flex items-center justify-center gap-2 px-4 py-10 text-dark-400">
          <Loader className="w-4 h-4 animate-spin text-accent-400" />
          <span className="text-xs">正在读取 GPU 使用数据…</span>
        </div>
      ) : usage ? (
        <>
          {/* 实测不可用：只加提示条，下面的分配数据照常显示 */}
          {!usage.available && (
            <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
              <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
              <div className="min-w-0 text-[11px] leading-relaxed text-amber-200">
                <span className="font-medium">实测占用不可用：</span>
                {usage.reason ?? 'HAMi 未上报实测指标（scheduler metrics 抓取失败或未开启）'}
                <span className="text-amber-200/70">
                  {' '}
                  · 下方仍显示 HAMi 的分配数据，实测条与 util 将显示「—」
                </span>
              </div>
            </div>
          )}

          {deviceCount === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-dark-500">
              还没有读到 GPU 设备（节点未上报 nvidia.com/gpu 资源，或 HAMi 没有下发设备明细）
            </div>
          ) : (
            <div className="divide-y divide-dark-800/40">
              {usage.nodes.map((node, nodeIndex) => (
                <div key={`${nodeIndex}-${node.name}`} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm text-dark-200 truncate" title={node.name || MISSING}>
                      {node.name || MISSING}
                    </span>
                    <span className="text-[11px] text-dark-500">
                      {node.devices.length} 张卡
                      {node.mfu?.percent != null && (
                        <span className="ml-2 text-emerald-400">MFU {node.mfu.percent}%</span>
                      )}
                    </span>
                  </div>
                  {node.devices.length === 0 ? (
                    <div className="mt-1 text-[11px] text-dark-600">该节点没有 GPU 设备明细</div>
                  ) : (
                    node.devices.map((device, deviceIndex) => (
                      <DeviceRow key={`${device.uuid || device.type || deviceIndex}`} device={device} />
                    ))
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

export default GpuUsagePanel;
