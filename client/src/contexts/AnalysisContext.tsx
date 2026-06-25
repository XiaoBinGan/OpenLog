import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from './ToastContext';

// ── Types ──────────────────────────────────────────────

export interface AnalysisState {
  // 日志分析 (非流式)
  logAnalysis: string | null;
  logAnalyzing: boolean;
  logError: string | null;

  // 健康检查分析 (SSE 流式)
  healthAnalysis: string | null;
  healthLoading: boolean;
  healthReport: any;
  healthError: string | null;

  // 巡检分析 (SSE 流式)
  patrolAnalysis: string | null;
  patrolAnalyzing: boolean;
  patrolResults: any[];
  patrolTimestamp: string;
  patrolError: string | null;

  // 单容器诊断 (SSE 流式)
  containerAnalysis: string | null;
  containerLoading: boolean;
  containerReport: any;
  containerError: string | null;
}

interface AnalysisContextValue extends AnalysisState {
  // 日志分析
  startLogAnalysis: (logs: any[], customPrompt?: string, deviceId?: string, deviceName?: string) => Promise<void>;

  // 健康检查 + AI 诊断
  startHealthCheck: () => Promise<void>;

  // 巡检 + AI 分析
  startPatrol: () => Promise<void>;
  startPatrolAnalysis: (results?: any[]) => Promise<void>;
  refreshPatrol: () => Promise<void>;

  // 单容器诊断
  startContainerDiagnosis: (sourceId: string, containerId: string, containerName: string, exitData: {
    exitCode: number; exitType: string; exitLabel: string; image: string;
  }) => Promise<void>;

  // 自动巡检（从 toast 跳转）
  runAutoPatrol: () => Promise<void>;

  // 自动退出诊断（从 toast 跳转）
  runAutoExit: (sourceId: string, containerId: string, containerName: string, exitData: {
    exitCode: number; exitType: string; exitLabel: string; image: string;
  }) => Promise<void>;
}

const AnalysisContext = createContext<AnalysisContextValue | null>(null);

// ── SSE 流读取工具 ─────────────────────────────────────

async function readSSEStream(
  res: Response,
  onChunk: (content: string) => void,
  onError: (err: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) {
    onError('No response body');
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (j.content) onChunk(j.content);
            if (j.error) onError(j.error);
          } catch { /* skip malformed */ }
        }
      }
    }
  } catch (err: any) {
    if (!signal?.aborted) {
      onError(err.message || String(err));
    }
  }
}

// ── Provider ───────────────────────────────────────────

export function AnalysisProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  // Abort controllers — stored in refs so they survive unmount
  const healthAbortRef = useRef<AbortController | null>(null);
  const patrolAbortRef = useRef<AbortController | null>(null);
  const containerAbortRef = useRef<AbortController | null>(null);

  // Cleanup on unmount (shouldn't happen for provider, but safety)
  useEffect(() => {
    return () => {
      healthAbortRef.current?.abort();
      patrolAbortRef.current?.abort();
      containerAbortRef.current?.abort();
    };
  }, []);

  // ── State ──
  const [logAnalysis, setLogAnalysis] = useState<string | null>(null);
  const [logAnalyzing, setLogAnalyzing] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  const [healthAnalysis, setHealthAnalysis] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthReport, setHealthReport] = useState<any>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [patrolAnalysis, setPatrolAnalysis] = useState<string | null>(null);
  const [patrolAnalyzing, setPatrolAnalyzing] = useState(false);
  const [patrolResults, setPatrolResults] = useState<any[]>([]);
  const [patrolTimestamp, setPatrolTimestamp] = useState('');
  const [patrolError, setPatrolError] = useState<string | null>(null);

  const [containerAnalysis, setContainerAnalysis] = useState<string | null>(null);
  const [containerLoading, setContainerLoading] = useState(false);
  const [containerReport, setContainerReport] = useState<any>(null);
  const [containerError, setContainerError] = useState<string | null>(null);

  const isOnAnalyticsPage = location.pathname === '/analytics';

  // ── 日志分析（非流式，直接 JSON） ──
  const startLogAnalysis = useCallback(async (logs: any[], customPrompt?: string, deviceId?: string, deviceName?: string) => {
    if (logs.length === 0) return;
    setLogAnalyzing(true);
    setLogAnalysis(null);
    setLogError(null);
    try {
      const res = await fetch('/api/logs/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs, prompt: customPrompt || undefined, deviceId: deviceId || 'local', deviceName }),
      });
      const data = await res.json();
      if (data.error) {
        setLogError(data.error);
        setLogAnalysis(`❌ 错误: ${data.error}\n\n请检查设置中的 API Key 配置。`);
      } else {
        setLogAnalysis(data.analysis);
        if (!isOnAnalyticsPage) {
          toast.success('日志分析完成', {
            action: { label: '查看 →', onClick: () => navigate('/analytics') },
            persistent: true,
            group: 'log-analysis',
          });
        }
      }
    } catch (err: any) {
      const msg = `❌ 分析失败: ${err}`;
      setLogError(msg);
      setLogAnalysis(msg);
    }
    setLogAnalyzing(false);
  }, [isOnAnalyticsPage, toast, navigate]);

  // ── 健康检查 + AI 诊断 ──
  const startHealthCheck = useCallback(async () => {
    // Abort any existing
    healthAbortRef.current?.abort();
    const controller = new AbortController();
    healthAbortRef.current = controller;

    setHealthLoading(true);
    setHealthAnalysis(null);
    setHealthReport(null);
    setHealthError(null);

    try {
      const reportRes = await fetch('/api/docker/health-check');
      const report = await reportRes.json();
      if (controller.signal.aborted) return;
      setHealthReport(report);

      if (report.problems && report.problems.length > 0) {
        if (!isOnAnalyticsPage) {
          toast.warning(`健康检查: ${report.problems.length} 个问题`, { group: 'health-check' });
        }

        const analyzeRes = await fetch('/api/docker/health-check/analyze', {
          method: 'POST',
          signal: controller.signal,
        });

        let content = '';
        setHealthAnalysis('');

        await readSSEStream(
          analyzeRes,
          (chunk) => {
            content += chunk;
            setHealthAnalysis(content);
          },
          (err) => {
            const msg = `\n❌ ${err}`;
            content += msg;
            setHealthAnalysis(content);
            setHealthError(err);
          },
          controller.signal,
        );

        if (!controller.signal.aborted) {
          if (!isOnAnalyticsPage) {
            toast.success('容器健康诊断完成', {
              action: { label: '查看 →', onClick: () => navigate('/analytics') },
              persistent: true,
              group: 'health-check-done',
            });
          }
        }
      } else {
        setHealthAnalysis(report.analysis || '🎉 所有容器运行正常');
        if (!isOnAnalyticsPage) {
          toast.success('健康检查通过 · 所有容器正常', { group: 'health-check' });
        }
      }
    } catch (err: any) {
      if (controller.signal.aborted) return;
      const msg = '❌ 诊断失败: ' + (err.message || err);
      setHealthAnalysis(msg);
      setHealthError(msg);
    }
    if (!controller.signal.aborted) {
      setHealthLoading(false);
    }
  }, [isOnAnalyticsPage, toast, navigate]);

  // ── 巡检 ──
  const refreshPatrol = useCallback(async () => {
    try {
      const res = await fetch('/api/docker/patrol/now', { method: 'POST' });
      const data = await res.json();
      if (data.results) {
        setPatrolResults(data.results);
        setPatrolTimestamp(new Date().toISOString());
        if (data.results.length > 0) {
          const total = data.results.reduce((s: number, r: any) => s + (r.uniqueCount || r.matchCount || 0), 0);
          if (!isOnAnalyticsPage) {
            toast.info(`巡检完成 · ${data.results.length} 个容器 · ${total} 种异常`, { group: 'patrol-refresh' });
          }
        } else if (!isOnAnalyticsPage) {
          toast.success('巡检完成 · 无异常', { group: 'patrol-refresh' });
        }
      }
      return data;
    } catch {
      if (!isOnAnalyticsPage) {
        toast.error('巡检请求失败');
      }
      return null;
    }
  }, [isOnAnalyticsPage, toast]);

  const startPatrol = useCallback(async () => {
    await refreshPatrol();
  }, [refreshPatrol]);

  const startPatrolAnalysis = useCallback(async (results?: any[]) => {
    patrolAbortRef.current?.abort();
    const controller = new AbortController();
    patrolAbortRef.current = controller;

    setPatrolAnalyzing(true);
    setPatrolAnalysis('');
    setPatrolError(null);

    try {
      const res = await fetch('/api/docker/patrol/analyze', {
        method: 'POST',
        signal: controller.signal,
      });

      if (!res.ok) {
        if (controller.signal.aborted) return;
        setPatrolAnalysis('🕐 暂无新异常日志，尝试分析历史数据...');
        const last = await fetch('/api/docker/patrol/last').then(r => r.json());
        if (last.results?.length > 0) {
          setPatrolResults(last.results);
          setPatrolTimestamp(last.timestamp);
          setPatrolAnalysis('✅ 上次巡检无新增异常。以下为已记录的异常：');
        } else {
          setPatrolAnalysis('✨ 所有容器运行正常，未发现任何异常日志。');
        }
        if (!isOnAnalyticsPage) {
          toast.info('巡检分析完成', {
            action: { label: '查看 →', onClick: () => navigate('/analytics') },
            persistent: true,
            group: 'patrol-analysis',
          });
        }
        setPatrolAnalyzing(false);
        return;
      }

      let content = '';
      setPatrolAnalysis('');

      await readSSEStream(
        res,
        (chunk) => {
          content += chunk;
          setPatrolAnalysis(content);
        },
        (err) => {
          const msg = `\n❌ ${err}`;
          content += msg;
          setPatrolAnalysis(content);
          setPatrolError(err);
        },
        controller.signal,
      );

      if (!controller.signal.aborted) {
        if (!isOnAnalyticsPage) {
          toast.success('巡检 AI 分析完成', {
            action: { label: '查看 →', onClick: () => navigate('/analytics') },
            persistent: true,
            group: 'patrol-analysis',
          });
        }
      }
    } catch (err: any) {
      if (controller.signal.aborted) return;
      setPatrolError(err.message || String(err));
    }
    if (!controller.signal.aborted) {
      setPatrolAnalyzing(false);
    }
  }, [isOnAnalyticsPage, toast, navigate]);

  // ── 单容器诊断 ──
  const startContainerDiagnosis = useCallback(async (
    sourceId: string,
    containerId: string,
    containerName: string,
    exitData: { exitCode: number; exitType: string; exitLabel: string; image: string },
  ) => {
    containerAbortRef.current?.abort();
    const controller = new AbortController();
    containerAbortRef.current = controller;

    setContainerLoading(true);
    setContainerAnalysis('');
    setContainerReport(null);
    setContainerError(null);

    try {
      const res = await fetch(
        `/api/docker/container/${encodeURIComponent(sourceId)}/${encodeURIComponent(containerId)}/analyze`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(exitData),
          signal: controller.signal,
        },
      );

      let content = '';
      setContainerAnalysis('');

      await readSSEStream(
        res,
        (chunk) => {
          content += chunk;
          setContainerAnalysis(content);
        },
        (err) => {
          const msg = `\n❌ ${err}`;
          content += msg;
          setContainerAnalysis(content);
          setContainerError(err);
        },
        controller.signal,
      );

      if (!controller.signal.aborted) {
        setContainerReport({
          target: containerName,
          problems: [{
            name: containerName,
            image: exitData.image,
            exitCode: exitData.exitCode,
            exitType: exitData.exitType,
            sourceName: sourceId,
            errors: [],
          }],
          summary: { total: 1, running: 0, oomKilled: 0, errorExited: 1, normalExited: 0 },
        });

        if (!isOnAnalyticsPage) {
          toast.success(`${containerName} 诊断完成`, {
            action: { label: '查看 →', onClick: () => navigate('/analytics') },
            persistent: true,
            group: `container-diagnosis-${containerId}`,
          });
        }
      }
    } catch (err: any) {
      if (controller.signal.aborted) return;
      const msg = '❌ 诊断失败: ' + (err.message || err);
      setContainerAnalysis(msg);
      setContainerError(msg);
    }
    if (!controller.signal.aborted) {
      setContainerLoading(false);
    }
  }, [isOnAnalyticsPage, toast, navigate]);

  // ── 自动巡检（从 toast 跳转 / URL param 触发） ──
  const runAutoPatrol = useCallback(async () => {
    // Step 1: 触发巡检
    try {
      const patrolRes = await fetch('/api/docker/patrol/now', { method: 'POST' });
      const patrolData = await patrolRes.json();
      if (patrolData.results?.length > 0) {
        setPatrolResults(patrolData.results);
        setPatrolTimestamp(new Date().toISOString());
      } else {
        try {
          const last = await fetch('/api/docker/patrol/last').then(r => r.json());
          if (last.results?.length > 0) {
            setPatrolResults(last.results);
            setPatrolTimestamp(last.timestamp);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // Step 2: AI 分析
    await startPatrolAnalysis();
  }, [startPatrolAnalysis]);

  // ── 自动退出诊断（从 toast 跳转 / URL param 触发） ──
  const runAutoExit = useCallback(async (
    sourceId: string,
    containerId: string,
    containerName: string,
    exitData: { exitCode: number; exitType: string; exitLabel: string; image: string },
  ) => {
    await startContainerDiagnosis(sourceId, containerId, containerName, exitData);
  }, [startContainerDiagnosis]);

  // ── Value ──
  const value: AnalysisContextValue = {
    // 日志分析
    logAnalysis, logAnalyzing, logError, startLogAnalysis,
    // 健康检查
    healthAnalysis, healthLoading, healthReport, healthError, startHealthCheck,
    // 巡检
    patrolAnalysis, patrolAnalyzing, patrolResults, patrolTimestamp, patrolError,
    startPatrol, startPatrolAnalysis, refreshPatrol,
    // 容器诊断
    containerAnalysis, containerLoading, containerReport, containerError, startContainerDiagnosis,
    // 自动
    runAutoPatrol, runAutoExit,
  };

  return (
    <AnalysisContext.Provider value={value}>
      {children}
    </AnalysisContext.Provider>
  );
}

// ── Hook ──
export function useAnalysisContext() {
  const ctx = useContext(AnalysisContext);
  if (!ctx) throw new Error('useAnalysisContext must be used inside AnalysisProvider');
  return ctx;
}
