/**
 * client/src/components/monitor/DatasourceSection.tsx
 *
 * 系统监控页的「外部数据源」区块：解决「切到别的机器想看数据」这件事。
 *
 * 为什么需要它：那两块监控面板（接口指标/数据库）统计的是**本机 OpenLog 进程**，
 * 远程主机上没跑 OpenLog，自然没数据。可行的替代是：
 *   ① 把远程数据库连接登记进来（可从容器 env/端口自动挖出来）→ 能看池/表体积/死元组
 *   ② 反过来探远程服务的 /openapi.json → 能拿到「它有哪些接口 + 是否活着」
 *
 * 边界必须在界面上说清：**swagger 给的是接口清单，不是调用量**。
 * QPS/P95 属于流量事实，只有埋点或对方访问日志才有。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, Globe, Loader2, Plug, RefreshCw, Search, Trash2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '../../api/client';
import {
  normalizeDatasourceList, normalizeDiscover, candidateToPayload, describeTarget,
  summarizeProbe, probeNotes, attemptedPaths, relativeTime, dataNatureLabel,
  type DatasourceItem, type DbCandidate, type ServiceCandidate,
} from '../../utils/datasource';

const LEVEL = {
  ok: 'text-emerald-400',
  fail: 'text-red-400',
  idle: 'text-dark-500',
} as const;

export default function DatasourceSection() {
  const [items, setItems] = useState<DatasourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discover, setDiscover] = useState<{ db: DbCandidate[]; svc: ServiceCandidate[]; errors: string[]; scanned: number } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [probeResult, setProbeResult] = useState<Record<string, unknown>>({});
  const [manualHost, setManualHost] = useState('');
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await apiFetch<{ available?: boolean; items?: unknown; reason?: string }>('/api/monitor/datasources');
      if (raw?.available === false) {
        setError(raw.reason || '数据源功能未接入');
        setItems([]);
      } else {
        setItems(normalizeDatasourceList(raw?.items));
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取数据源失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runDiscover = useCallback(async () => {
    setDiscovering(true);
    setError(null);
    try {
      const q = manualHost ? `?hostHint=${encodeURIComponent(manualHost)}` : '';
      const raw = await apiFetch<unknown>(`/api/monitor/datasources/discover${q}`);
      const d = normalizeDiscover(raw);
      setDiscover({ db: d.dbCandidates, svc: d.serviceCandidates, errors: d.errors, scanned: d.scannedSources });
    } catch (err) {
      setError(err instanceof Error ? err.message : '自动发现失败');
    } finally {
      setDiscovering(false);
    }
  }, [manualHost]);

  const save = useCallback(async (payload: Record<string, unknown>) => {
    const id = String(payload.id || '');
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await apiFetch<{ ok?: boolean; error?: string }>(`/api/monitor/datasources/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res?.ok === false) setError(res.error || '保存失败');
      else await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }, [load]);

  const probe = useCallback(async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await apiFetch<unknown>(`/api/monitor/datasources/${encodeURIComponent(id)}/probe`, { method: 'POST' });
      setProbeResult((p) => ({ ...p, [id]: res }));
      await load();
    } catch (err) {
      setProbeResult((p) => ({ ...p, [id]: { ok: false, error: err instanceof Error ? err.message : '探测失败' } }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }, [load]);

  const remove = useCallback(async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await apiFetch(`/api/monitor/datasources/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }, [load]);

  const registered = useMemo(() => new Set(items.map((i) => i.id)), [items]);

  return (
    <section className="bg-dark-800/60 border border-dark-700 rounded-xl p-4 md:p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Plug className="w-5 h-5 text-accent-500 shrink-0" />
          <h3 className="text-lg font-semibold">外部数据源</h3>
          <span className="px-2 py-0.5 rounded-md text-xs bg-dark-900 border border-dark-700 text-dark-500" title="远程主机上没跑 OpenLog，所以拿不到它的流量指标；但可以把它的数据库或接口文档登记进来">
            别人机器上的库 / 接口
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={manualHost}
            onChange={(e) => setManualHost(e.target.value)}
            placeholder="宿主机地址（可空，默认 localhost）"
            className="px-2 py-1 rounded-lg bg-dark-900 border border-dark-700 text-xs text-dark-200 placeholder:text-dark-600 w-56"
          />
          <button
            type="button"
            onClick={runDiscover}
            disabled={discovering}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-dark-300 hover:text-accent-400 hover:bg-dark-900/60 transition-colors disabled:opacity-50"
          >
            {discovering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            从容器里找
          </button>
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-900/60 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
          </button>
        </div>
      </div>

      {/* 两类数据的边界，写在最显眼的位置 */}
      <div className="rounded-lg border border-dark-700 bg-dark-900/50 px-3 py-2 text-[11px] text-dark-400 space-y-0.5">
        <div>· <span className="text-dark-300">接口清单</span>：{dataNatureLabel('spec')}</div>
        <div>· <span className="text-dark-300">流量指标</span>：{dataNatureLabel('traffic')} —— 只有跑着 OpenLog 的机器才有</div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-600/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      {/* 已登记 */}
      <div className="space-y-2">
        <div className="text-xs text-dark-500">已登记（{items.length}）</div>
        {items.length === 0 && !loading && (
          <div className="text-xs text-dark-500 py-2">还没有登记任何数据源。点上边「从容器里找」，或手动填地址后期补上。</div>
        )}
        {items.map((it) => {
          const res = probeResult[it.id];
          const sum = res ? summarizeProbe(res) : null;
          const notes = res ? probeNotes(res) : [];
          const attempts = res ? attemptedPaths(res) : [];
          const Icon = it.kind === 'service' ? Globe : Database;
          return (
            <div key={it.id} className="rounded-lg border border-dark-700 bg-dark-900/40 px-3 py-2 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Icon className="w-3.5 h-3.5 text-accent-400 shrink-0" />
                <span className="text-sm text-dark-200">{it.label}</span>
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-dark-800 border border-dark-700 text-dark-400 font-mono">
                  {it.dialect || it.kind}
                </span>
                <span className="text-xs text-dark-500 font-mono">{describeTarget(it)}</span>
                {it.hasPassword && <span className="text-[11px] text-dark-600 font-mono">{it.passwordMasked}</span>}
                <span className={`text-[11px] ${it.lastStatus === 'ok' ? LEVEL.ok : it.lastStatus === 'fail' ? LEVEL.fail : LEVEL.idle}`}>
                  {it.lastStatus === 'ok' ? `上次成功 ${it.lastProbeMs ?? '?'}ms` : it.lastStatus === 'fail' ? '上次失败' : '未试过'}
                  {it.lastProbeAt ? ` · ${relativeTime(it.lastProbeAt, now)}` : ''}
                </span>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => probe(it.id)}
                  disabled={busy[it.id]}
                  className="px-2 py-0.5 rounded text-xs text-accent-400 hover:bg-accent-500/10 transition-colors disabled:opacity-50"
                >
                  {busy[it.id] ? '测试中…' : '试连'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(it.id)}
                  disabled={busy[it.id]}
                  className="px-2 py-0.5 rounded text-xs text-dark-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              {it.lastError && !res && <div className="text-[11px] text-red-300/80 break-words">上次失败：{it.lastError}</div>}
              {sum && (
                <div className={`text-[11px] break-words ${sum.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                  {sum.ok ? <CheckCircle2 className="w-3 h-3 inline mr-1" /> : <XCircle className="w-3 h-3 inline mr-1" />}
                  {sum.text}
                </div>
              )}
              {notes.length > 0 && (
                <div className="text-[11px] text-yellow-300/90 break-words">⚠ {notes.join('；')}</div>
              )}
              {attempts.length > 0 && (
                <div className="text-[11px] text-dark-600 font-mono break-words">试过：{attempts.join(' | ')}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* 发现结果 */}
      {discover && (
        <div className="space-y-3 pt-2 border-t border-dark-700">
          <div className="text-xs text-dark-500">
            扫描了 {discover.scanned} 个容器源 · 找到 {discover.db.length} 个数据库候选、{discover.svc.length} 个接口服务候选
          </div>

          {discover.db.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-dark-400">数据库候选</div>
              {discover.db.map((c) => {
                const saved = registered.has(c.id);
                return (
                  <div key={c.id} className="rounded-lg border border-dark-700 bg-dark-900/40 px-3 py-2 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Database className="w-3.5 h-3.5 text-accent-400 shrink-0" />
                      <span className="text-sm text-dark-200">{c.containerName}</span>
                      <span className="text-[11px] font-mono text-dark-500">{c.image}</span>
                      <span className="text-xs text-dark-400 font-mono">
                        {c.host || '(不可达)'}{c.port ? `:${c.port}` : ''}{c.database ? `/${c.database}` : ''}
                      </span>
                      {c.hasPassword && <span className="text-[11px] text-dark-600 font-mono">{c.passwordMasked}</span>}
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => save(candidateToPayload(c))}
                        disabled={saved || busy[c.id]}
                        className="px-2 py-0.5 rounded text-xs text-accent-400 hover:bg-accent-500/10 disabled:opacity-40 transition-colors"
                      >
                        {saved ? '已登记' : busy[c.id] ? '保存中…' : '登记'}
                      </button>
                    </div>
                    <div className={`text-[11px] ${c.reachable ? 'text-dark-500' : 'text-yellow-300/90'}`}>{c.hint || c.reason}</div>
                    {!c.samplable && <div className="text-[11px] text-dark-600">该方言暂不支持采集指标，只能登记为「存在」</div>}
                  </div>
                );
              })}
            </div>
          )}

          {discover.svc.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-dark-400">接口服务候选（登记后可探文档）</div>
              {discover.svc.map((c) => {
                const saved = registered.has(c.id);
                return (
                  <div key={c.id} className="rounded-lg border border-dark-700 bg-dark-900/40 px-3 py-2 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Globe className="w-3.5 h-3.5 text-accent-400 shrink-0" />
                      <span className="text-sm text-dark-200">{c.containerName}</span>
                      <span className="text-[11px] font-mono text-dark-500">{c.image}</span>
                      <span className="text-xs text-dark-400 font-mono">{c.baseUrl}</span>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => save(candidateToPayload(c))}
                        disabled={saved || busy[c.id]}
                        className="px-2 py-0.5 rounded text-xs text-accent-400 hover:bg-accent-500/10 disabled:opacity-40 transition-colors"
                      >
                        {saved ? '已登记' : busy[c.id] ? '保存中…' : '登记'}
                      </button>
                    </div>
                    {c.hint && <div className="text-[11px] text-dark-500">{c.hint}</div>}
                  </div>
                );
              })}
            </div>
          )}

          {discover.errors.length > 0 && (
            <div className="text-[11px] text-yellow-300/80 space-y-0.5">
              {discover.errors.slice(0, 5).map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}

          {discover.db.length === 0 && discover.svc.length === 0 && discover.errors.length === 0 && (
            <div className="text-xs text-dark-500">
              没有找到可监控的容器。可能原因：容器不是数据库镜像、端口没发布到宿主机（`--publish` 缺失）、
              或 Docker 源没配好。也可以直接在上面填地址手动登记。
            </div>
          )}
        </div>
      )}
    </section>
  );
}
