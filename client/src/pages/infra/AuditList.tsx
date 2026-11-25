/* eslint-disable react-refresh/only-export-components --
   审计的动作标签 / 查询串拼装必须导出：过滤参数少一个就是「查不到记录」，
   而界面上看不出来。测试要能直接断言路径。 */
/**
 * 变更审计列表（`GET /api/infra/audit`）。
 *
 * 为什么需要这一块：apply / rollback 落到集群之后就只剩结果了 —— 「谁在几点动了哪个服务、
 * 动了哪些对象、每一步成没成、有没有人按过 force」这些只存在于审计里。事后排查时
 * 没有这张表，就只能翻服务器日志猜。
 *
 * 五个显示约定（每条都对应一个具体的误判）：
 *
 * 1. **`action=rejected` 用红色标签**。被护栏拒绝的变更是「有人试图做一件被禁止的事」，
 *    它和普通失败（apply 报了错）不是一回事：前者说明意图本身越界。混在灰色里就等于
 *    把这批事件藏起来了。
 *
 * 2. **审计存储不可读 ≠ 没有审计**。`store.list()` 在 KV 读失败时返回
 *    `{ total: 0, items: [], error }`，路由原样展开。如果把 `items: []` 当「暂无记录」渲染，
 *    用户会以为「没人动过集群」—— 这比报错危险得多。所以 `error` 非空时显示
 *    「审计存储不可读」并给出原因，绝不显示空态。
 *
 * 3. **分页按 limit=50**，并且显示 total / 当前区间。服务端 `total` 是**过滤后**的总数，
 *    所以「第 1–50 / 共 213 条」里的 213 是当前筛选条件下的条数，不是全库条数
 *    （全库条数在 stats.total 里，字幕里也写出来，避免两个数字打架）。
 *
 * 4. **行可展开看 steps 与 forced**。列表只显示结论（成功/失败），但「哪一步失败了」
 *    才是可操作的信息；`forced` 里的护栏 code 说明这次变更是被**绕过**护栏执行的。
 *
 * 5. **过滤变化的请求必须带 offset=0**。改过滤条件还停在第 3 页，会打到一个
 *    必然为空的页，用户看到「没有记录」而实际是翻过头了。
 *
 * 本组件只读：不发任何写请求。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileSearch, Loader, RefreshCw, TriangleAlert } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { ErrorBar } from '../k8s/Feedback';
import { errorText } from './types';

// ─── 常量 ────────────────────────────────────────────────────────────────

/** 审计动作枚举（与 `server/infra/audit-store.js` 的 AUDIT_ACTIONS 一致）。 */
export const AUDIT_ACTIONS = ['create', 'update', 'rollback', 'rejected'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 每页条数（契约默认 50；服务端上限 500）。 */
export const AUDIT_PAGE_SIZE = 50;

/** serviceKey 过滤输入的防抖（避免每个字符打一次请求）。 */
export const AUDIT_FILTER_DEBOUNCE_MS = 300;

/** 动作中文。 */
const ACTION_LABEL: Record<string, string> = {
  create: '创建',
  update: '更新',
  rollback: '回滚',
  rejected: '被拒绝',
};

/** 动作标签配色：rejected 走红色（见文件头第 1 条）。 */
const ACTION_CLASS: Record<string, string> = {
  create: 'border-accent-500/40 bg-accent-500/15 text-accent-300',
  update: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
  rollback: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  rejected: 'border-red-500/50 bg-red-500/15 text-red-300',
};

// ─── 类型（与 audit-store.js 的条目形状对齐，宽进） ──────────────────────

/** 审计条目的一个步骤。 */
export interface AuditStep {
  name: string;
  ok: boolean;
  detail: string | null;
}

/** 一条审计记录（服务端会做字段裁剪，这里全部按「可能存在」处理）。 */
export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  serviceKey: string | null;
  namespace: string | null;
  name: string | null;
  targets: string[];
  steps: AuditStep[];
  ok: boolean;
  error: string | null;
  snapshotRef: string | null;
  /** 被 force 绕过的护栏 code（非空 = 这次变更绕过了护栏）。 */
  forced: string[];
}

/** 审计概览。 */
export interface AuditStats {
  total: number;
  byAction: Record<string, number>;
  byActor: { actor: string; count: number }[];
  lastAt: string | null;
}

/** 一页审计。 */
export interface AuditPage {
  total: number;
  items: AuditEntry[];
  /** 存储读失败的原因（非空时**不能**渲染成空态）。 */
  error: string | null;
  stats: AuditStats | null;
  demo: boolean;
}

export interface AuditListProps {
  /** 只显示某个服务（`namespace/name`）的变更；省略 = 全部。 */
  serviceKey?: string;
  /** 演示模式角标。 */
  demo?: boolean;
  /** 每页条数（默认 50，测试可调小）。 */
  pageSize?: number;
}

// ─── 纯函数 ──────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 字符串字段（trim 后空串 → null，避免渲染出空标签）。 */
function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 字符串数组（过滤掉非字符串与空串）。 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
  }
  return out;
}

/** 时间展示：到秒，非法时间不渲染 NaN。 */
export function timeText(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 动作标签（未知动作原样显示，不吞掉）。 */
export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action ?? '—';
}

/** 动作配色（未知动作走灰）。 */
export function actionClass(action: string): string {
  return ACTION_CLASS[action] ?? 'border-dark-600/50 bg-dark-700/40 text-dark-300';
}

/** 单条记录归一。 */
function normalizeEntry(raw: unknown): AuditEntry | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = textOrNull(record.id) ?? '';
  const stepsRaw = Array.isArray(record.steps) ? record.steps : [];
  const steps: AuditStep[] = [];
  for (const item of stepsRaw) {
    const step = asRecord(item);
    if (!step) continue;
    const name = textOrNull(step.name);
    if (!name) continue;
    steps.push({ name, ok: step.ok === true, detail: textOrNull(step.detail) });
  }
  return {
    id,
    at: textOrNull(record.at) ?? '',
    actor: textOrNull(record.actor) ?? 'unknown',
    action: textOrNull(record.action) ?? 'unknown',
    serviceKey: textOrNull(record.serviceKey),
    namespace: textOrNull(record.namespace),
    name: textOrNull(record.name),
    targets: stringList(record.targets),
    steps,
    ok: record.ok === true,
    error: textOrNull(record.error),
    snapshotRef: textOrNull(record.snapshotRef),
    forced: stringList(record.forced),
  };
}

/** stats 归一（缺字段给零值，避免渲染 undefined）。 */
function normalizeStats(raw: unknown): AuditStats | null {
  const record = asRecord(raw);
  if (!record) return null;
  const byActionRaw = asRecord(record.byAction) ?? {};
  const byAction: Record<string, number> = {};
  for (const [key, value] of Object.entries(byActionRaw)) {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    byAction[key] = n;
  }
  const byActorRaw = Array.isArray(record.byActor) ? record.byActor : [];
  const byActor: { actor: string; count: number }[] = [];
  for (const item of byActorRaw) {
    const actor = asRecord(item);
    if (!actor) continue;
    const who = textOrNull(actor.actor);
    if (!who) continue;
    byActor.push({
      actor: who,
      count: typeof actor.count === 'number' && Number.isFinite(actor.count) ? actor.count : 0,
    });
  }
  return {
    total: typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : 0,
    byAction,
    byActor,
    lastAt: textOrNull(record.lastAt),
  };
}

/** 整页归一。`error` 非空时保留原因（绝不吞成空列表）。 */
export function normalizeAuditPage(raw: unknown): AuditPage {
  const record = asRecord(raw);
  if (!record) {
    return { total: 0, items: [], error: '审计响应为空，无法判断是否有变更记录', stats: null, demo: false };
  }
  const itemsRaw = Array.isArray(record.items) ? record.items : [];
  const items: AuditEntry[] = [];
  for (const item of itemsRaw) {
    const entry = normalizeEntry(item);
    if (entry) items.push(entry);
  }
  return {
    total: typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : items.length,
    items,
    error: textOrNull(record.error),
    stats: normalizeStats(record.stats),
    demo: record.demo === true,
  };
}

/** 查询路径：只带非空参数（后端按 `if (req.query.x)` 判断，空串等于不过滤）。 */
export function auditPath(options: {
  limit: number;
  offset: number;
  action?: string;
  serviceKey?: string;
  actor?: string;
}): string {
  const params = new URLSearchParams();
  params.set('limit', String(Math.max(1, Math.trunc(options.limit))));
  params.set('offset', String(Math.max(0, Math.trunc(options.offset))));
  for (const key of ['action', 'serviceKey', 'actor'] as const) {
    const value = (options[key] ?? '').trim();
    if (value) params.set(key, value);
  }
  return `/api/infra/audit?${params.toString()}`;
}

// ─── 组件 ────────────────────────────────────────────────────────────────

/**
 * 变更审计列表。
 *
 * 状态机：`loading / ready / error`。`ready` 里再分「存储不可读（page.error）」与
 * 「有记录 / 没记录」—— 这三种在界面上必须是三张不同的脸。
 */
export default function AuditList({
  serviceKey: serviceKeyProp,
  demo = false,
  pageSize = AUDIT_PAGE_SIZE,
}: AuditListProps) {
  const [action, setAction] = useState<'' | AuditAction>('');
  /** 输入框里的原始值（防抖用）；真正发请求的是 `serviceKey`。 */
  const [serviceKeyInput, setServiceKeyInput] = useState(serviceKeyProp ?? '');
  const [serviceKey, setServiceKey] = useState(serviceKeyProp ?? '');
  const [offset, setOffset] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [page, setPage] = useState<AuditPage | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** 展开的行 id 集合（可同时展开多条）。 */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const limit = Math.max(1, Math.trunc(pageSize));

  // 上层换了服务 → 同步输入框（编辑态切换时不必手打）
  useEffect(() => {
    const next = serviceKeyProp ?? '';
    setServiceKeyInput(next);
    setServiceKey(next);
    setOffset(0);
  }, [serviceKeyProp]);

  // serviceKey 输入防抖
  useEffect(() => {
    const next = serviceKeyInput.trim();
    if (next === serviceKey) return;
    const timer = setTimeout(() => {
      setServiceKey(next);
      setOffset(0);
    }, AUDIT_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [serviceKeyInput, serviceKey]);

  useEffect(() => {
    if (demo) {
      setStatus('ready');
      setPage({
        total: 0,
        items: [],
        error: null,
        stats: null,
        demo: true,
      });
      return;
    }

    let alive = true;
    const controller = new AbortController();
    setStatus('loading');
    setListError(null);

    apiFetch<unknown>(auditPath({ limit, offset, action, serviceKey }), {
      signal: controller.signal,
    })
      .then((raw) => {
        if (!alive) return;
        setPage(normalizeAuditPage(raw));
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setPage(null);
        setListError(errorText(err));
        setStatus('error');
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [demo, limit, offset, action, serviceKey, reloadTick]);

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const toggleRow = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const total = page?.total ?? 0;
  const items = useMemo(() => page?.items ?? [], [page]);
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + items.length;
  const canPrev = offset > 0;
  const canNext = offset + items.length < total;
  const storageBroken = Boolean(page?.error);

  return (
    <section className="glass rounded-xl p-4" data-testid="audit-list" data-status={status}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FileSearch className="h-4 w-4 text-accent-400" />
        <h3 className="text-sm font-semibold text-dark-100">变更审计</h3>
        <span className="text-[11px] text-dark-500">
          谁在什么时候动了什么、每一步成没成、有没有绕过护栏
        </span>
        {page?.demo && (
          <span
            data-testid="audit-demo-badge"
            className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
          >
            演示数据
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            data-testid="audit-filter-action"
            aria-label="按动作过滤"
            className="rounded-lg border border-dark-700/70 bg-dark-900/60 px-1.5 py-1 text-[11px] text-dark-100 focus:border-accent-500/60 focus:outline-none"
            value={action}
            onChange={(event) => {
              // 换过滤条件必须同时把分页归零，否则会打到一个必然为空的页
              setAction(event.target.value as '' | AuditAction);
              setOffset(0);
            }}
          >
            <option value="">全部动作</option>
            {AUDIT_ACTIONS.map((item) => (
              <option key={item} value={item}>
                {actionLabel(item)}
              </option>
            ))}
          </select>
          <input
            data-testid="audit-filter-service"
            aria-label="按服务过滤"
            className="w-44 rounded-lg border border-dark-700/70 bg-dark-900/60 px-2 py-1 text-[11px] text-dark-100 placeholder:text-dark-600 focus:border-accent-500/60 focus:outline-none"
            value={serviceKeyInput}
            onChange={(event) => setServiceKeyInput(event.target.value)}
            placeholder="namespace/name"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            data-testid="audit-refresh"
            onClick={reload}
            disabled={demo}
            className="flex items-center gap-1.5 rounded-lg bg-dark-800/60 px-2.5 py-1 text-xs text-dark-300 transition-colors hover:bg-dark-700/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${status === 'loading' ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {/* 概览字幕：两个 total 都写出来，避免它们打架（见文件头第 3 条） */}
      {page?.stats && (
        <p data-testid="audit-stats" className="mb-2 text-[11px] text-dark-500">
          全库 {page.stats.total} 条 · 当前筛选 {total} 条
          {page.stats.lastAt ? ` · 最后一次 ${timeText(page.stats.lastAt)}` : ''}
          {page.stats.byAction.rejected ? ` · 被拒绝 ${page.stats.byAction.rejected}` : ''}
        </p>
      )}

      {/* 请求失败（HTTP 层） */}
      {status === 'error' && listError && (
        <div data-testid="audit-error">
          <ErrorBar message={`读取审计失败：${listError}`} onRetry={reload} />
        </div>
      )}

      {/* 存储不可读（HTTP 200 但 error 非空）—— 绝不能渲染成空态 */}
      {storageBroken && (
        <div
          data-testid="audit-storage-error"
          className="mb-2 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />
          <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-red-300 break-words">
            审计存储不可读：{page?.error}
            <span className="mt-0.5 block text-red-200/70">
              这不代表「没有变更记录」—— 是审计库读不出来，排查前请先确认存储状态。
            </span>
          </span>
        </div>
      )}

      {status === 'loading' && items.length === 0 && !storageBroken ? (
        <div className="flex items-center justify-center gap-2 py-8 text-dark-400">
          <Loader className="h-4 w-4 animate-spin text-accent-400" />
          <span className="text-xs">正在读取审计…</span>
        </div>
      ) : items.length === 0 ? (
        status === 'error' || storageBroken ? null : (
          <p data-testid="audit-empty" className="py-6 text-center text-xs text-dark-500">
            没有符合条件的变更记录（审计只记录真正下发过的 apply / rollback，以及被护栏拒绝的尝试）
          </p>
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="audit-table">
            <thead>
              <tr className="border-b border-dark-800/60 text-xs text-dark-500">
                <th className="w-6 px-2 py-1.5" />
                <th className="px-3 py-1.5 text-left font-medium">时间</th>
                <th className="px-3 py-1.5 text-left font-medium">actor</th>
                <th className="px-3 py-1.5 text-left font-medium">动作</th>
                <th className="px-3 py-1.5 text-left font-medium">服务</th>
                <th className="px-3 py-1.5 text-left font-medium">结果</th>
                <th className="px-3 py-1.5 text-left font-medium">审计号</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry, index) => {
                const key = entry.id || `${entry.at}-${index}`;
                const open = Boolean(expanded[key]);
                return (
                  <Fragment key={key}>
                    <tr
                      data-testid="audit-row"
                      data-action={entry.action}
                      data-ok={entry.ok ? 'true' : 'false'}
                      data-id={entry.id}
                      onClick={() => toggleRow(key)}
                      className="cursor-pointer border-b border-dark-800/40 transition-colors hover:bg-dark-800/30"
                    >
                      <td className="px-2 py-1.5 text-dark-500">
                        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </td>
                      <td className="px-3 py-1.5 text-[11px] whitespace-nowrap text-dark-400">
                        {timeText(entry.at)}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-dark-200">{entry.actor}</td>
                      <td className="px-3 py-1.5">
                        <span
                          data-testid="audit-action-tag"
                          data-action={entry.action}
                          className={`rounded border px-1.5 py-0.5 text-[10px] ${actionClass(entry.action)}`}
                        >
                          {actionLabel(entry.action)}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-dark-300" title={entry.serviceKey ?? ''}>
                        {entry.serviceKey ?? (entry.name ? `${entry.namespace ?? '?'}/${entry.name}` : '—')}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-xs ${entry.ok ? 'text-emerald-400' : 'text-red-400'}`}
                        title={entry.error ?? undefined}
                      >
                        {entry.ok ? '成功' : '失败'}
                        {entry.forced.length > 0 && (
                          <span
                            data-testid="audit-forced-badge"
                            className="ml-1 rounded border border-amber-500/40 bg-amber-500/15 px-1 text-[10px] text-amber-300"
                          >
                            force
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[10px] text-dark-500">
                        {entry.id || '—'}
                      </td>
                    </tr>

                    {open && (
                      <tr data-testid="audit-row-detail" data-id={entry.id}>
                        <td colSpan={7} className="bg-dark-900/40 px-6 py-2">
                          {entry.error && (
                            <p data-testid="audit-row-error" className="mb-1 text-[11px] text-red-300 break-words">
                              错误：{entry.error}
                            </p>
                          )}

                          <p className="mb-1 text-[10px] uppercase tracking-wide text-dark-600">steps</p>
                          {entry.steps.length === 0 ? (
                            <p data-testid="audit-step-empty" className="text-[11px] text-dark-500">
                              没有记录步骤（该动作在执行前就被拒绝，或旧版本没有 steps）
                            </p>
                          ) : (
                            <ul data-testid="audit-steps" className="space-y-0.5">
                              {entry.steps.map((step, stepIndex) => (
                                <li
                                  key={`${step.name}-${stepIndex}`}
                                  data-testid="audit-step"
                                  data-ok={step.ok ? 'true' : 'false'}
                                  className="text-[11px] leading-relaxed"
                                >
                                  <span className={step.ok ? 'text-emerald-400' : 'text-red-400'}>
                                    {step.ok ? '✓' : '✗'} {step.name}
                                  </span>
                                  {step.detail ? <span className="text-dark-500"> — {step.detail}</span> : null}
                                </li>
                              ))}
                            </ul>
                          )}

                          {entry.forced.length > 0 && (
                            <div data-testid="audit-forced" className="mt-1.5">
                              <p className="mb-0.5 text-[10px] uppercase tracking-wide text-amber-500">
                                forced（被绕过的护栏）
                              </p>
                              <ul className="space-y-0.5">
                                {entry.forced.map((code) => (
                                  <li key={code} className="font-mono text-[11px] text-amber-300">
                                    {code}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {entry.targets.length > 0 && (
                            <p data-testid="audit-targets" className="mt-1.5 text-[11px] text-dark-400">
                              改动对象：{entry.targets.join(' · ')}
                            </p>
                          )}

                          {entry.snapshotRef && (
                            <p className="mt-1 font-mono text-[10px] text-dark-600">
                              快照 {entry.snapshotRef}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页 */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span data-testid="audit-page-info" className="text-[11px] text-dark-500">
          {total === 0 ? '共 0 条' : `第 ${from}–${to} 条 / 共 ${total} 条`}（每页 {limit} 条）
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            data-testid="audit-prev"
            onClick={() => setOffset((prev) => Math.max(0, prev - limit))}
            disabled={!canPrev || demo}
            className="rounded-lg bg-dark-800/60 px-2.5 py-1 text-[11px] text-dark-300 transition-colors hover:bg-dark-700/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            上一页
          </button>
          <button
            type="button"
            data-testid="audit-next"
            onClick={() => setOffset((prev) => prev + limit)}
            disabled={!canNext || demo}
            className="rounded-lg bg-dark-800/60 px-2.5 py-1 text-[11px] text-dark-300 transition-colors hover:bg-dark-700/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
    </section>
  );
}
