/**
 * 视觉能力探测 hook（AI Shell 与运维助手共用）。
 *
 * 触发时机：**第一次选图片时**才探测，不在页面加载时探 ——
 * 探测要真发一张图给模型，用户没打算发图时不该花他的 token。
 * 结论由后端缓存（yes/no 缓存 10 分钟，unknown 不缓存）。
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/client';
import { describeVision, shouldRefetch, type VisionHint, type VisionProbeResult } from '../utils/visionSupport';

export function useVisionSupport(imageCount: number) {
  const [result, setResult] = useState<VisionProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (imageCount <= 0) return; // 没选图不探
    if (inFlight.current) return;
    inFlight.current = true;
    let cancelled = false;
    setProbing(true);
    setError(null);
    apiFetch<VisionProbeResult & { model?: string }>('/api/models/vision')
      .then((data) => { if (!cancelled) setResult(data); })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 探测失败不影响发图：只记下来，界面按 unknown 处理
        setError(e instanceof Error ? e.message : String(e));
        setResult({ supported: 'unknown', reason: '探测请求失败' });
      })
      .finally(() => { if (!cancelled) setProbing(false); inFlight.current = false; });
    return () => { cancelled = true; };
  }, [imageCount > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const hint: VisionHint = describeVision(result);
  return { result, probing, error, hint, refetch: () => { inFlight.current = false; setResult(null); } };
}

export { shouldRefetch };