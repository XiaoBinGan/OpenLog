/**
 * AI Infra 面板（模型服务）：列表 + 定义表单 + 变更预览 + 历史回滚。
 *
 * 这个文件是**容器**：它负责取数据、串流程、把状态分发给三个纯组件
 * （`ServiceForm` / `DiffPreview` / 内部的历史列表），A9 之后把它挂到路由上即可，
 * 不需要改这里的内部结构。
 *
 * 三个值得写下来的决定：
 *
 * 1. **一次变更的完整链路在 UI 上是可见的**：
 *    选中/新建 → 填定义 → `POST /preview`（护栏 + diff + impact）→ 用户确认 →
 *    `POST /apply` → 刷新列表并保留回滚入口。表单页永远没有「直接保存」按钮，
 *    因为契约铁律 3 要求一切变更先出 diff。
 *
 * 2. **演示模式是「能点但不能落地」**：`window.__OPENLOG_DEMO__` 或 `demo` prop
 *    为真时用内置假数据、不发任何请求（预览用本地 diff 生成），执行按钮禁用并
 *    说明原因 —— 演示环境里最坏的事是让人以为真的建了一个服务。
 *
 * 3. **`enabled:false` 只禁用写操作**：`OPENLOG_K8S_INFRA` 默认关闭（契约铁律 4），
 *    此时列表照常渲染（读不需要开关），只把「新建服务」灰掉并给出原因。
 *    把整块藏起来会让人以为功能不存在，而实际只是开关没开。
 *
 * 数据来源（见 `types.ts` 的响应类型；后端尚未落地，路径与形状是 A9 的接线依据）：
 *   GET  /api/infra/services                   → InfraServiceListResponse
 *   POST /api/infra/services/:id/preview       → GuardResult（含 placement / footprint）
 *   POST /api/infra/services/:id/apply         → ApplyResult
 *   POST /api/infra/services/:id/rollback      → ApplyResult
 *   POST /api/infra/bench                      → BenchResult（由 GateReport 的「运行基准」触发）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  CircleAlert,
  History,
  Loader,
  Plus,
  RefreshCw,
  Server,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { apiFetch, apiJson } from '../../api/client';
import { ErrorBar } from '../k8s/Feedback';
import ServiceForm from './ServiceForm';
import DiffPreview from './DiffPreview';
import AutoscaleFields, { type AutoscaleFieldState } from './AutoscaleFields';
import CapacityReport from './CapacityReport';
import GateReport, { type GateResult } from './GateReport';
import AuditList from './AuditList';
import CachePlan from './CachePlan';
import {
  INFRA_SERVICES_PATH,
  diffServiceFields,
  errorText,
  estimateImpact,
  infraServicePath,
  normalizeGuardResult,
  serviceKeyOf,
} from './types';
import type {
  ApplyResult,
  GuardResult,
  InfraHistoryEntry,
  InfraServiceListResponse,
  InfraServiceView,
  ModelService,
  ServicePhase,
} from './types';

declare global {
  interface Window {
    /** 演示模式开关：由演示环境在 index.html 里注入，或由 A9 从路由参数透传。 */
    __OPENLOG_DEMO__?: boolean;
  }
}

export interface InfraPanelProps {
  /** 显式开启演示模式（覆盖 `window.__OPENLOG_DEMO__`）。 */
  demo?: boolean;
  /** 路由带过来的服务 id：加载完成后直接展开该服务的编辑视图。 */
  initialServiceId?: string;
}

// ─── 演示数据（只在演示模式使用；形状与真实响应完全一致） ────────────────

const DEMO_SERVICES: InfraServiceView[] = [
  {
    id: 'demo-qwen-72b',
    name: 'qwen-72b',
    namespace: 'inference',
    model: {
      source: 'hostPath',
      path: '/models/Qwen2.5-72B-Instruct',
      quantization: 'awq',
      contextLength: 32768,
    },
    engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.6.3' },
    resources: { accelerators: 2, memoryMiB: 40960, coresPercent: 100 },
    replicas: 1,
    placement: { acceleratorModel: 'NVIDIA GeForce RTX 4090' },
    ports: [{ name: 'http', containerPort: 8000 }],
    health: { path: '/health' },
    expose: { gatewayPort: 8001 },
    createdAt: '2026-11-20T02:10:00.000Z',
    updatedAt: '2026-11-24T09:00:00.000Z',
    version: 3,
    status: { phase: 'running', readyReplicas: 1 },
    history: [
      {
        id: 'h-3',
        at: '2026-11-24T09:00:00.000Z',
        action: 'update',
        ok: true,
        version: 3,
        actor: 'demo',
        note: '显存配额 32768 → 40960 MiB',
      },
      {
        id: 'h-2',
        at: '2026-11-22T11:30:00.000Z',
        action: 'update',
        ok: true,
        version: 2,
        actor: 'demo',
        note: '副本数 1 → 1，镜像升级到 v0.6.3',
      },
      { id: 'h-1', at: '2026-11-20T02:10:00.000Z', action: 'create', ok: true, version: 1 },
    ],
  },
  {
    id: 'demo-llama-8b',
    name: 'llama-3-8b',
    namespace: 'infra-test',
    model: { source: 'modelscope', path: 'LLM-Research/Meta-Llama-3-8B-Instruct', quantization: 'Q4_K_M' },
    engine: { type: 'llama.cpp', image: 'ghcr.io/ggml-org/llama.cpp:server' },
    resources: { accelerators: 1, memoryMiB: 12288, coresPercent: 60 },
    replicas: 2,
    placement: {},
    ports: [{ name: 'http', containerPort: 8080 }],
    health: { path: '/health' },
    expose: null,
    createdAt: '2026-11-18T07:45:00.000Z',
    updatedAt: '2026-11-23T15:20:00.000Z',
    version: 5,
    status: { phase: 'degraded', readyReplicas: 1, message: '1/2 副本未就绪：镜像拉取超时' },
    history: [
      {
        id: 'd-5',
        at: '2026-11-23T15:20:00.000Z',
        action: 'update',
        ok: false,
        version: 5,
        actor: 'demo',
        note: '滚动更新卡在 ImagePullBackOff',
      },
      { id: 'd-4', at: '2026-11-18T07:45:00.000Z', action: 'create', ok: true, version: 1 },
    ],
  },
];

/** 演示模式下的列表说明（与真实模式一样显示成提示条，别让人误判）。 */
const DEMO_NOTICE = '演示模式：以下为内置假数据，预览在本地生成，执行会被禁用';

// ─── 状态类型 ────────────────────────────────────────────────────────────

type ListStatus = 'loading' | 'ready' | 'error';

interface ListState {
  status: ListStatus;
  services: InfraServiceView[];
  /** 服务端是否允许写（`OPENLOG_K8S_INFRA`）。 */
  enabled: boolean;
  demo: boolean;
  /** 服务端给的原因（开关没开 / 读取失败）。 */
  notice: string | null;
  error: string | null;
}

/** 当前选中的对象：新建 or 某个已有服务。null = 停在列表。 */
type Selection = { kind: 'new' } | { kind: 'edit'; id: string } | null;

/** 一次已经生成好的预览（service 是点预览那一刻的草稿快照，执行时原样下发）。 */
interface PreviewState {
  key: string;
  service: ModelService;
  result: GuardResult;
}

const PHASE_LABEL: Record<ServicePhase, string> = {
  pending: '待创建',
  applying: '下发中',
  running: '运行中',
  degraded: '降级',
  failed: '失败',
  unknown: '未知',
};

const PHASE_CLASS: Record<ServicePhase, string> = {
  pending: 'border-dark-600/50 bg-dark-700/40 text-dark-300',
  applying: 'border-accent-500/40 bg-accent-500/15 text-accent-300',
  running: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  degraded: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  failed: 'border-red-500/40 bg-red-500/15 text-red-300',
  unknown: 'border-dark-600/50 bg-dark-700/40 text-dark-400',
};

// ─── 纯函数（渲染前的口径统一） ──────────────────────────────────────────

/** 演示模式判定：props 优先，其次全局开关。 */
function resolveDemo(prop: boolean | undefined): boolean {
  if (typeof prop === 'boolean') return prop;
  return typeof window !== 'undefined' && window.__OPENLOG_DEMO__ === true;
}

/** 列表响应 → 视图状态。`services` 缺失时当空数组，绝不让 undefined 流到 map 上。 */
function normalizeList(raw: InfraServiceListResponse | null | undefined): ListState {
  const services = raw && Array.isArray(raw.services) ? raw.services : [];
  return {
    status: 'ready',
    services,
    // 只有明确 false 才算关闭；字段缺失按「可用」处理（老后端没这个字段）
    enabled: raw?.enabled !== false,
    demo: raw?.demo === true,
    notice: typeof raw?.reason === 'string' && raw.reason.trim() ? raw.reason : null,
    error: null,
  };
}

/** 配额一句话摘要：显存 / 算力 / 卡数。 */
function quotaText(service: InfraServiceView): string {
  const { memoryMiB, coresPercent, accelerators } = service.resources;
  const mem = memoryMiB > 0 ? `${memoryMiB} MiB` : '整卡不限显存';
  const cores = coresPercent > 0 ? `${coresPercent}%` : '不限算力';
  return `${accelerators} 卡 · ${mem} · ${cores}`;
}

/** 时间展示：只到分钟，非法时间不渲染 NaN。 */
function timeText(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 动作中文。 */
function actionText(action: InfraHistoryEntry['action']): string {
  if (action === 'create') return '创建';
  if (action === 'rollback') return '回滚';
  return '更新';
}

/** 演示模式的本地 diff（形状与 A2 的文本 diff 一致：头 + `+`/`-` 行）。 */
function demoDiff(before: ModelService | null, after: ModelService): string {
  const lines = [`--- 当前（${before ? `${before.namespace}/${before.name} v${before.version}` : '无'}）`];
  lines.push(`+++ 期望（${after.namespace}/${after.name}）`);
  if (!before) {
    lines.push('+ kind: Deployment');
    lines.push(`+ image: ${after.engine.image}`);
    lines.push(`+ replicas: ${after.replicas}`);
    lines.push(`+ resources: ${after.resources.accelerators} 卡 / ${after.resources.memoryMiB} MiB`);
    return lines.join('\n');
  }
  const changes = diffServiceFields(before, after);
  if (changes.length === 0) return lines.join('\n');
  for (const change of changes) {
    lines.push(`- ${change.label}: ${change.before}`);
    lines.push(`+ ${change.label}: ${change.after}`);
  }
  return lines.join('\n');
}

/** 执行失败时把第一个失败步骤翻成人话（后端可能只给 steps 不给 error）。 */
function failedStepText(result: ApplyResult | null | undefined): string {
  const failed = result?.steps?.find((step) => !step.ok);
  if (!failed) return '执行未成功（服务端未返回原因）';
  return `${failed.name} 失败${failed.detail ? `：${failed.detail}` : ''}`;
}

// ─── 组件 ────────────────────────────────────────────────────────────────

/**
 * 模型服务面板。
 *
 * 自己不假设集群可写：列表读得到就渲染，写操作受 `enabled` / `demo` 双重约束。
 */
export default function InfraPanel({ demo: demoProp, initialServiceId }: InfraPanelProps) {
  const demo = resolveDemo(demoProp);

  const [list, setList] = useState<ListState>({
    status: 'loading',
    services: [],
    enabled: true,
    demo: false,
    notice: null,
    error: null,
  });
  /** 手动刷新计数：只用来重新触发列表 effect。 */
  const [reloadTick, setReloadTick] = useState(0);

  const [selection, setSelection] = useState<Selection>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  /** 网关注册的半成功状态：服务已就绪但外部访问不到（§0 状态表里的「半成功」）。 */
  const [gatewayWarning, setGatewayWarning] = useState<string | null>(null);
  /** 正在回滚的历史条目 id（用来禁用按钮 + 显示转圈）。 */
  const [rollbackBusy, setRollbackBusy] = useState<string | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  // ── 列表加载 ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (demo) {
      setList({
        status: 'ready',
        services: DEMO_SERVICES,
        enabled: true,
        demo: true,
        notice: DEMO_NOTICE,
        error: null,
      });
      return;
    }

    // 卸载 / 重复刷新时丢弃上一次响应，避免把旧列表盖回来
    let alive = true;
    const controller = new AbortController();
    setList((prev) => ({ ...prev, status: 'loading', error: null }));

    apiFetch<InfraServiceListResponse>(INFRA_SERVICES_PATH, { signal: controller.signal })
      .then((raw) => {
        if (!alive) return;
        setList(normalizeList(raw));
      })
      .catch((err: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setList({
          status: 'error',
          services: [],
          enabled: true,
          demo: false,
          notice: null,
          error: errorText(err),
        });
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [demo, reloadTick]);

  const reload = useCallback(() => {
    setReloadTick((tick) => tick + 1);
  }, []);

  /** 路由带 id 时自动展开该服务（只在第一次加载完成后做一次）。 */
  useEffect(() => {
    if (!initialServiceId || selection !== null) return;
    const exists = list.services.some((service) => service.id === initialServiceId);
    if (exists) setSelection({ kind: 'edit', id: initialServiceId });
  }, [initialServiceId, list.services, selection]);

  const selected: InfraServiceView | null = useMemo(() => {
    if (!selection || selection.kind !== 'edit') return null;
    return list.services.find((service) => service.id === selection.id) ?? null;
  }, [list.services, selection]);

  /** 选中项被删掉（刷新后不见了）时回到列表，而不是渲染一个空表单。 */
  useEffect(() => {
    if (selection?.kind === 'edit' && list.status === 'ready' && !selected) {
      setSelection(null);
    }
  }, [list.status, selected, selection]);

  /** 清掉上一次的预览与执行反馈（换服务 / 重新生成时必须清，否则会拿旧 diff 执行）。 */
  const resetPreview = useCallback(() => {
    setGate(null);
    setPreview(null);
    setPreviewError(null);
    setApplyError(null);
    setApplyNotice(null);
    setGatewayWarning(null);
    setRollbackError(null);
  }, []);

  const openNew = useCallback(() => {
    resetPreview();
    setSelection({ kind: 'new' });
  }, [resetPreview]);

  const openEdit = useCallback(
    (id: string) => {
      resetPreview();
      setSelection({ kind: 'edit', id });
    },
    [resetPreview],
  );

  const backToList = useCallback(() => {
    resetPreview();
    setSelection(null);
  }, [resetPreview]);

  // ── 预览：只生成计划，不落地 ───────────────────────────────────────────
  const handlePreview = useCallback(
    async (service: ModelService) => {
      const key = serviceKeyOf(service);
      const before = list.services.find((item) => item.id === service.id) ?? null;
      // 后端没返回 impact 时用本地估算兜底（口径与 A2 一致：单副本 30 秒）
      const fallback = estimateImpact(before, service);

      setPreviewError(null);
      setApplyError(null);
      setApplyNotice(null);

      if (demo) {
        // 演示模式：不发请求，本地造一份形状正确的 diff
        setPreview({
          key,
          service,
          result: { allowed: true, violations: [], diff: demoDiff(before, service), impact: fallback },
        });
        return;
      }

      setPreviewLoading(true);
      try {
        const raw = await apiJson<unknown>(infraServicePath(key, '/preview'), 'POST', { service });
        setPreview({ key, service, result: normalizeGuardResult(raw, fallback) });
      } catch (err) {
        setPreview(null);
        setPreviewError(errorText(err));
      } finally {
        setPreviewLoading(false);
      }
    },
    [demo, list.services],
  );

  // ── 执行：护栏通过 + 非演示模式才允许 ─────────────────────────────────
  // 门禁结论：null = 没有基准/正在跑 —— 此时不允许 apply（旧结论不能给新配置背书）
  const [gate, setGate] = useState<GateResult | null>(null);
  const [, setAutoscale] = useState<AutoscaleFieldState | null>(null);

  const handleApply = useCallback(async () => {
    if (!preview || demo || applying) return;
    if (!preview.result.allowed || preview.result.violations.length > 0) return;

    setApplying(true);
    setApplyError(null);
    setApplyNotice(null);
    setGatewayWarning(null);
    try {
      const raw = await apiJson<ApplyResult>(infraServicePath(preview.key, '/apply'), 'POST', {
        service: preview.service,
      });
      if (raw && raw.ok === true) {
        const steps = Array.isArray(raw.steps) ? raw.steps.length : 0;
        setApplyNotice(
          `已执行 ${steps} 个步骤${raw.auditId ? `（审计 ${raw.auditId}）` : ''}${
            raw.snapshot?.available ? '，回滚快照已保留' : '，未保留回滚快照'
          }`,
        );
        // 半成功：服务跑起来了，但没有路由 / 端口撞车 → 外部访问不到。
        // 审计里这条仍是 ok:true，所以这条提示是唯一会告诉用户"外面打不开"的地方。
        const gateway = raw.gateway;
        setGatewayWarning(
          gateway && gateway.ok === false
            ? gateway.error && gateway.error.trim()
              ? gateway.error
              : '网关注册未成功：服务本身已就绪，但外部访问不到（见 docs/INFRA.md §4.6）'
            : null,
        );
        setPreview(null);
        reload();
      } else {
        setApplyError(raw?.error && raw.error.trim() ? raw.error : failedStepText(raw));
      }
    } catch (err) {
      setApplyError(errorText(err));
    } finally {
      setApplying(false);
    }
  }, [applying, demo, preview, reload]);

  // ── 回滚：按历史里的 version 定位快照 ─────────────────────────────────
  const handleRollback = useCallback(
    async (service: InfraServiceView, entry: InfraHistoryEntry) => {
      if (demo || rollbackBusy) return;
      const key = serviceKeyOf(service);
      setRollbackBusy(entry.id);
      setRollbackError(null);
      try {
        const raw = await apiJson<ApplyResult>(infraServicePath(key, '/rollback'), 'POST', {
          version: entry.version,
        });
        if (raw && raw.ok === true) {
          setApplyNotice(`已回滚到 v${entry.version}`);
          reload();
        } else {
          setRollbackError(raw?.error && raw.error.trim() ? raw.error : failedStepText(raw));
        }
      } catch (err) {
        setRollbackError(errorText(err));
      } finally {
        setRollbackBusy(null);
      }
    },
    [demo, reload, rollbackBusy],
  );

  const canWrite = list.enabled && list.status === 'ready';

  return (
    <div className="space-y-4" data-testid="infra-panel" data-demo={demo ? 'true' : 'false'}>
      {/* ── 列表卡 ─────────────────────────────────────────────────── */}
      <section className="glass rounded-xl p-4" data-testid="infra-list-card">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Server className="h-4 w-4 text-accent-400" />
          <h2 className="text-sm font-semibold text-dark-100">模型服务（AI Infra）</h2>
          {list.status === 'ready' && (
            <span className="text-xs text-dark-500">{list.services.length} 个服务</span>
          )}
          {demo && (
            <span
              data-testid="infra-demo-badge"
              className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
            >
              演示数据
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              data-testid="infra-refresh"
              onClick={reload}
              disabled={demo || list.status === 'loading'}
              className="flex items-center gap-1.5 rounded-lg bg-dark-800/60 px-2.5 py-1 text-xs text-dark-300 transition-colors hover:bg-dark-700/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${list.status === 'loading' ? 'animate-spin' : ''}`} />
              刷新
            </button>
            <button
              type="button"
              data-testid="infra-new-service"
              onClick={openNew}
              disabled={!canWrite && !demo}
              title={!list.enabled ? 'OPENLOG_K8S_INFRA 未开启' : undefined}
              className="flex items-center gap-1.5 rounded-lg bg-accent-500/20 px-2.5 py-1 text-xs font-medium text-accent-200 transition-colors hover:bg-accent-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3 w-3" />
              新建服务
            </button>
          </div>
        </div>

        {/* 开关没开 / 演示说明：琥珀条，说明「为什么点不了」 */}
        {list.notice && (
          <p
            data-testid="infra-notice"
            className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] leading-relaxed text-amber-200"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
            <span className="min-w-0 break-words">{list.notice}</span>
          </p>
        )}

        {list.error ? (
          <div data-testid="infra-list-error">
            <ErrorBar message={`读取服务列表失败：${list.error}`} onRetry={reload} />
          </div>
        ) : list.status === 'loading' && list.services.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-dark-400">
            <Loader className="h-4 w-4 animate-spin text-accent-400" />
            <span className="text-xs">正在读取模型服务…</span>
          </div>
        ) : list.services.length === 0 ? (
          <div data-testid="infra-empty" className="py-8 text-center">
            <Boxes className="mx-auto mb-2 h-10 w-10 text-dark-600" />
            <p className="text-sm text-dark-300">还没有模型服务</p>
            <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-dark-500">
              服务定义只描述「要跑什么」，下发由护栏 + diff + 执行器完成；
              新增、扩容、改配额都会先出预览，不会点了直接改集群。
            </p>
            <button
              type="button"
              data-testid="infra-empty-new"
              onClick={openNew}
              disabled={!canWrite && !demo}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent-500/20 px-3 py-1.5 text-xs font-medium text-accent-200 transition-colors hover:bg-accent-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3 w-3" />
              新建服务
            </button>
          </div>
        ) : (
          <div className="divide-y divide-dark-800/60">
            {list.services.map((service) => {
              const phase = service.status?.phase ?? 'unknown';
              const active = selection?.kind === 'edit' && selection.id === service.id;
              return (
                <button
                  type="button"
                  key={service.id || `${service.namespace}/${service.name}`}
                  data-testid="infra-service-row"
                  data-name={service.name}
                  data-namespace={service.namespace}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => openEdit(service.id)}
                  className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2 text-left transition-colors hover:bg-dark-800/40 ${
                    active ? 'bg-dark-800/40' : ''
                  }`}
                >
                  <span className="min-w-[8rem] flex-1">
                    <span className="block truncate text-sm text-dark-100" title={service.name}>
                      {service.name || '（未命名）'}
                    </span>
                    <span className="block text-[10px] text-dark-600">{service.namespace}</span>
                  </span>
                  <span className="min-w-[5rem] text-xs text-dark-300">{service.engine.type}</span>
                  <span className="min-w-[10rem] flex-1 text-[11px] text-dark-400">
                    {quotaText(service)}
                  </span>
                  <span className="text-xs text-dark-300" title="副本数">
                    {service.replicas} 副本
                    {service.status?.readyReplicas != null
                      ? `（就绪 ${service.status.readyReplicas}）`
                      : ''}
                  </span>
                  <span
                    data-testid="infra-service-phase"
                    data-phase={phase}
                    className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${PHASE_CLASS[phase]}`}
                    title={service.status?.message}
                  >
                    {PHASE_LABEL[phase]}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 详情：表单 + 预览 + 历史 ───────────────────────────────── */}
      {selection && (
        <div className="space-y-4" data-testid="infra-detail">
          {selection.kind === 'edit' && !selected ? null : (
            <section className="glass rounded-xl p-4" data-testid="infra-form-card">
              <div className="mb-3 flex items-center gap-2">
                <CircleAlert className="h-4 w-4 text-accent-400" />
                <h3 className="text-sm font-semibold text-dark-100">
                  {selection.kind === 'new'
                    ? '新建服务'
                    : `编辑 ${selected?.namespace}/${selected?.name}`}
                </h3>
                <span className="text-[11px] text-dark-500">
                  提交只生成预览，执行需要二次确认
                </span>
              </div>
              <ServiceForm
                // key 随服务与版本变化：切换服务时草稿不能串味
                key={selection.kind === 'new' ? 'new' : `${selected?.id}:${selected?.version}`}
                initial={selection.kind === 'new' ? null : selected}
                submitting={previewLoading}
                error={previewError}
                demo={demo}
                onPreview={handlePreview}
                onCancel={backToList}
              />
            </section>
          )}

          {/* 弹性：扩副本吃 vGPU 配额，超预算时这里会红字说明"HPA 会一直重试 Pending" */}
          {selection.kind === 'edit' && selected && (
            <AutoscaleFields
              key={`as:${selected.id}:${selected.version}`}
              memoryMiB={selected.resources.memoryMiB}
              coresPercent={selected.resources.coresPercent}
              replicas={selected.replicas}
              initial={(selected as unknown as { autoscale?: never }).autoscale ?? null}
              demo={demo}
              onChange={setAutoscale}
            />
          )}

          {/* 磁盘：跨节点不共享会各占一份，历史上因此出现过 DiskPressure → 整节点 Evicted */}
          {selection.kind === 'edit' && selected && (
            <CachePlan
              key={`cache:${selected.id}:${selected.version}`}
              modelPath={selected.model.path}
              quantization={selected.model.quantization}
              replicas={selected.replicas}
              nodeCount={2}
              demo={demo}
            />
          )}

          {/* 容量 + 足迹：回答「配额放得进卡吗」（A4）与「模型放得进配额吗」（A7）。
              两者都从 preview 响应里来 —— 门禁只测吞吐/显存回归，拦不住"根本调度不上"。 */}
          {selection && (
            <CapacityReport
              placement={preview?.result.placement ?? null}
              footprint={preview?.result.footprint ?? null}
              loading={previewLoading}
              demo={demo}
              hasPreview={Boolean(preview)}
            />
          )}

          {/* 基准门禁：必须放在 DiffPreview 之前 —— 执行按钮在那里，结论要先出现 */}
          {selection.kind === 'edit' && selected && (
            <GateReport
              key={`gate:${selected.id}:${selected.version}`}
              serviceKey={`${selected.namespace}/${selected.name}`}
              serviceName={selected.name}
              service={selected as unknown as Record<string, unknown>}
              demo={demo}
              onGateChange={setGate}
            />
          )}
          {gate && !gate.pass && preview && (
            <p data-testid="infra-gate-block" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
              基准门禁未通过 —— 默认仍可执行（门禁是取证工具）；需要强制时在 apply 请求里带 requireGate: true
            </p>
          )}

          {gatewayWarning && (
            <p
              data-testid="infra-gateway-warning"
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] leading-relaxed text-amber-200 break-words"
            >
              半成功：{gatewayWarning}
              <span className="ml-1 text-amber-300/70">
                服务本身已下发成功；网关修好后重跑一次 apply 即可补上路由（不会重建 Pod）
              </span>
            </p>
          )}

          <DiffPreview
            result={preview?.result ?? null}
            loading={previewLoading}
            onApply={handleApply}
            applying={applying}
            demo={demo}
            applyError={applyError}
            applyNotice={applyNotice}
          />

          {/* ── 历史 ─────────────────────────────────────────────────── */}
          {selection.kind === 'edit' && selected && (
            <section className="glass rounded-xl p-4" data-testid="infra-history-card">
              <div className="mb-2 flex items-center gap-2">
                <History className="h-4 w-4 text-accent-400" />
                <h3 className="text-sm font-semibold text-dark-100">变更历史</h3>
                <span className="text-[11px] text-dark-500">
                  回滚按历史版本定位快照，只有落盘过快照的版本能回滚
                </span>
              </div>

              {rollbackError && (
                <p
                  data-testid="infra-rollback-error"
                  className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300 break-words"
                >
                  回滚失败：{rollbackError}
                </p>
              )}

              {(selected.history ?? []).length === 0 ? (
                <p data-testid="infra-history-empty" className="py-3 text-xs text-dark-500">
                  暂无变更记录
                </p>
              ) : (
                <div className="divide-y divide-dark-800/60">
                  {(selected.history ?? []).map((entry) => (
                    <div
                      key={entry.id}
                      data-testid="infra-history-row"
                      data-action={entry.action}
                      data-ok={entry.ok ? 'true' : 'false'}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5"
                    >
                      <span className="text-xs text-dark-300">{actionText(entry.action)}</span>
                      <span className="text-[11px] text-dark-500">v{entry.version}</span>
                      <span
                        className={`text-[10px] ${entry.ok ? 'text-emerald-400' : 'text-red-400'}`}
                      >
                        {entry.ok ? '成功' : '失败'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-dark-500" title={entry.note}>
                        {entry.note ?? '—'}
                      </span>
                      <span className="text-[10px] text-dark-600">{timeText(entry.at)}</span>
                      <button
                        type="button"
                        data-testid="infra-history-rollback"
                        onClick={() => handleRollback(selected, entry)}
                        disabled={demo || rollbackBusy !== null}
                        title={demo ? '演示模式：不会下发' : '回滚到该版本（快照不存在时服务端会拒绝）'}
                        className="flex items-center gap-1 rounded-md bg-dark-800/60 px-2 py-0.5 text-[10px] text-dark-300 transition-colors hover:bg-dark-700/60 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {rollbackBusy === entry.id ? (
                          <Loader className="h-3 w-3 animate-spin" />
                        ) : (
                          <Undo2 className="h-3 w-3" />
                        )}
                        回滚
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* 变更审计：跨服务，放页面底部；谁在什么时候改了什么靠它追溯 */}
      <AuditList serviceKey={selected ? `${selected.namespace}/${selected.name}` : ''} />
    </div>
  );
}
