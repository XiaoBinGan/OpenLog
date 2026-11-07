/**
 * client/src/utils/datasource.ts —— 数据源面板的纯逻辑
 *
 * 全部可单测：候选去重/排序、试连结果归一、swagger 探测结果格式化、连接串拼装。
 * 组件只负责渲染与交互，判断逻辑都在这里。
 */

export type SourceKind = 'db' | 'service';

export interface DatasourceItem {
  id: string;
  kind: SourceKind;
  collection: string;
  label: string;
  dialect: string | null;
  host: string;
  port: number | null;
  user: string;
  database: string;
  baseUrl: string;
  enabled: boolean;
  hasPassword: boolean;
  passwordMasked: string;
  lastProbeMs: number | null;
  lastStatus: 'ok' | 'fail' | string | null;
  lastError: string | null;
  lastProbeAt: number | null;
  createdAt: number;
}

export interface DbCandidate {
  kind: 'db';
  id: string;
  collection: string;
  dialect: string;
  samplable: boolean;
  containerName: string;
  image: string;
  host: string;
  port: number;
  user: string;
  passwordMasked: string;
  hasPassword: boolean;
  database: string;
  fromUrl: boolean;
  reachable: boolean;
  reason: string;
  hint?: string;
}

export interface ServiceCandidate {
  kind: 'service';
  id: string;
  collection: string;
  containerName: string;
  image: string;
  baseUrl: string;
  containerPort: number;
  hint?: string;
}

export interface DiscoverResult {
  available?: boolean;
  dbCandidates?: unknown;
  serviceCandidates?: unknown;
  errors?: unknown;
  scannedSources?: number;
}

export interface SpecEndpoint { method: string; path: string }

export interface DocProbeResult {
  ok: boolean;
  baseUrl: string;
  found: string | null;
  ms: number;
  error?: string;
  summary: { title: string; version: string; specVersion: string; basePath: string; endpoints: SpecEndpoint[] } | null;
  attempts: Array<{ path: string; status: number | null; error?: string }>;
}

export interface DbProbeResult {
  ok: boolean;
  ms: number;
  version?: string;
  sizeBytes?: number | null;
  conns?: { total: number | null; active: number | null };
  tables?: Array<{ relname: string; bytes: number | null; liveTup: number | null; deadTup: number | null }>;
  waitingLocks?: number | null;
  unavailable?: string[];
  error?: string;
}

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

/** 归一化一条已登记数据源（脏数据不炸渲染） */
export function normalizeDatasource(raw: unknown): DatasourceItem {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: str(o.id, 'unknown'),
    kind: o.kind === 'service' ? 'service' : 'db',
    collection: str(o.collection, 'local'),
    label: str(o.label, str(o.id, '未命名')),
    dialect: typeof o.dialect === 'string' && o.dialect ? o.dialect : null,
    host: str(o.host),
    port: numOrNull(o.port),
    user: str(o.user),
    database: str(o.database),
    baseUrl: str(o.baseUrl),
    enabled: o.enabled !== false,
    hasPassword: Boolean(o.hasPassword),
    passwordMasked: str(o.passwordMasked),
    lastProbeMs: numOrNull(o.lastProbeMs),
    lastStatus: typeof o.lastStatus === 'string' ? o.lastStatus : null,
    lastError: typeof o.lastError === 'string' ? o.lastError : null,
    lastProbeAt: numOrNull(o.lastProbeAt),
    createdAt: num(o.createdAt),
  };
}

export function normalizeDatasourceList(raw: unknown): DatasourceItem[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map(normalizeDatasource).filter((x) => x.id !== 'unknown');
}

/** 归一化发现结果：保证界面拿到的两个数组一定是数组 */
export function normalizeDiscover(raw: unknown): {
  dbCandidates: DbCandidate[]; serviceCandidates: ServiceCandidate[]; errors: string[]; scannedSources: number;
} {
  const o = (raw && typeof raw === 'object' ? raw : {}) as DiscoverResult;
  const db = Array.isArray(o.dbCandidates) ? o.dbCandidates as DbCandidate[] : [];
  const svc = Array.isArray(o.serviceCandidates) ? o.serviceCandidates as ServiceCandidate[] : [];
  const errors = Array.isArray(o.errors) ? o.errors.map((e) => String(e)) : [];
  return {
    // 可连的排前面：不能连的候选对用户没有动作价值，只作为「为什么连不上」的解释
    dbCandidates: [...db].sort((a, b) => Number(Boolean(b.reachable)) - Number(Boolean(a.reachable))
      || String(a.containerName || '').localeCompare(String(b.containerName || ''))),
    serviceCandidates: svc,
    errors,
    scannedSources: num(o.scannedSources),
  };
}

/**
 * 从候选生成「保存用」的载荷。
 * 密码不在候选里（只有打码版），所以要么用户手动填，要么先保存空密码再试连。
 */
export function candidateToPayload(c: DbCandidate | ServiceCandidate, label?: string): Record<string, unknown> {
  if (c.kind === 'service') {
    return {
      id: c.id,
      kind: 'service',
      collection: c.collection,
      label: label || `${c.containerName} 接口`,
      baseUrl: c.baseUrl,
      enabled: true,
    };
  }
  return {
    id: c.id,
    kind: 'db',
    collection: c.collection,
    label: label || `${c.containerName} (${c.dialect})`,
    dialect: c.dialect,
    host: c.host,
    port: c.port,
    user: c.user,
    database: c.database,
    enabled: true,
  };
}

/** 用于界面显示的一行地址：db 显示 host:port/database，service 显示 baseUrl */
export function describeTarget(item: DatasourceItem): string {
  if (item.kind === 'service') return item.baseUrl || '(未填地址)';
  const host = item.host || '(未填主机)';
  const port = item.port ? `:${item.port}` : '';
  const db = item.database ? `/${item.database}` : '';
  return `${host}${port}${db}`;
}

/** 试连结果的单行摘要（成功显示关键指标，失败显示人话原因） */
export function summarizeProbe(res: unknown): { ok: boolean; text: string } {
  const o = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
  if (!o.ok) {
    return { ok: false, text: str(o.error, '失败（没有返回原因）') };
  }
  // 接口探测
  if ('found' in o) {
    const found = o.found ? String(o.found) : '';
    const summary = o.summary as DocProbeResult['summary'];
    const n = summary?.endpoints?.length ?? 0;
    const ms = num(o.ms);
    if (!summary) return { ok: true, text: `找到文档 ${found}（${ms}ms），但拿不到接口清单` };
    return { ok: true, text: `${summary.title || '未命名'} v${summary.version || '?'} · ${n} 个接口 · ${found} · ${ms}ms` };
  }
  // 数据库探测
  const parts = [];
  if (o.version) parts.push(String(o.version).slice(0, 40));
  if (o.conns) parts.push(`连接 ${num((o.conns as any).active)}/${num((o.conns as any).total)}`);
  const tables = Array.isArray(o.tables) ? o.tables.length : 0;
  parts.push(`${tables} 张表`);
  const un = Array.isArray(o.unavailable) ? o.unavailable.length : 0;
  if (un) parts.push(`${un} 项权限不足`);
  return { ok: true, text: parts.join(' · ') };
}

/** 探测失败/降级时要展示的补充说明（不进 error，避免把「部分成功」显示成失败） */
export function probeNotes(res: unknown): string[] {
  const o = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
  const out: string[] = [];
  if (Array.isArray(o.unavailable)) for (const u of o.unavailable) out.push(String(u));
  if (typeof o.error === 'string' && o.ok && o.error) out.push(String(o.error));
  return out;
}

/** 探测尝试过的地址（失败时用来解释「我试了哪些」） */
export function attemptedPaths(res: unknown): string[] {
  const o = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
  const arr = Array.isArray(o.attempts) ? o.attempts as Array<Record<string, unknown>> : [];
  return arr.map((a) => {
    const p = str(a.path);
    const status = a.status == null ? str(a.error, 'error') : `HTTP ${a.status}`;
    return `${p} → ${status}`;
  });
}

/** 时间戳 → 「3 分钟前」；没有就返回 ''（不伪造时间） */
export function relativeTime(ts: number | null, nowMs: number): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const diff = Math.max(0, nowMs - ts);
  if (diff < 60_000) return '刚刚';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 给「接口清单」和「流量指标」划清界限。
 * 用户最容易误解的一点：从 swagger 拿到接口列表 ≠ 拿到了 QPS。
 */
export function dataNatureLabel(kind: 'spec' | 'traffic'): string {
  return kind === 'spec'
    ? '接口清单（来自对方文档：有哪些接口，不含调用量/耗时）'
    : '流量指标（来自本实例埋点：真实调用量、错误率、分位延迟）';
}
