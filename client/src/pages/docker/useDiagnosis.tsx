/**
 * 「AI 智能诊断」的请求与流式解析。
 *
 * 从 pages/Docker.tsx 原样搬出，**逐字保留**（这是刚修过的 bug，不要顺手优化）：
 *  1. POST 必须带 `headers: { 'Content-Type': 'application/json' }` 与
 *     `body: JSON.stringify({})` —— 老后端以前连 body 都没有，提示词里出现过
 *     「退出码: undefined」。
 *  2. 必须处理服务端 `{ status: ... }` 进度事件（`j.status`），流结束没出正文
 *     时要给明确提示，不能留一个空白面板。
 *
 * state 仍在父页面这一层（同一时刻只有一个容器的诊断面板可见），
 * 用 hook 收拢只是为了让 Docker.tsx 保持薄壳。
 */

import { useCallback, useState } from 'react';

export interface DiagnosisState {
  diagnoseKey: string | null;
  diagnoseContainerName: string;
  diagnoseLoading: boolean;
  diagnoseText: string;
  diagnoseCopied: boolean;
  diagnoseContainer: (sourceId: string, containerId: string, containerName: string) => Promise<void>;
  closeDiagnose: () => void;
  copyDiagnose: () => void;
}

export function useDiagnosis(): DiagnosisState {
  // AI 诊断（单容器）
  const [diagnoseKey, setDiagnoseKey] = useState<string | null>(null);
  const [diagnoseContainerName, setDiagnoseContainerName] = useState('');
  const [diagnoseLoading, setDiagnoseLoading] = useState(false);
  const [diagnoseText, setDiagnoseText] = useState('');
  const [diagnoseCopied, setDiagnoseCopied] = useState(false);

  const diagnoseContainer = useCallback(async (sourceId: string, containerId: string, containerName: string) => {
    const key = `${sourceId}:${containerId}`;
    setDiagnoseKey(key);
    setDiagnoseContainerName(containerName);
    setDiagnoseLoading(true);
    setDiagnoseText('⏳ 正在读取容器状态…');
    setDiagnoseCopied(false);

    try {
      const res = await fetch(`/api/docker/container/${encodeURIComponent(sourceId)}/${encodeURIComponent(containerId)}/diagnose`, {
        method: 'POST',
        // 兼容老后端：以前这里连 body 都没带，导致提示词里出现「退出码: undefined」。
        // 现在服务端以 docker inspect 为准，这里传的值只作降级兜底。
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setDiagnoseText(`❌ 诊断失败: ${errData.error || res.statusText}`);
        setDiagnoseLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setDiagnoseText('❌ 无法读取响应流');
        setDiagnoseLoading(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let sawContent = false;
      while (true) {
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
              // status：后端报进度（读取状态 / 请求模型 / 模型思考中）
              if (j.status !== undefined) {
                if (!sawContent) setDiagnoseText(j.status ? `⏳ ${j.status}` : '');
              }
              if (j.content) {
                sawContent = true;
                setDiagnoseText(prev => (prev.startsWith('⏳') ? j.content : prev + j.content));
              }
              if (j.error) setDiagnoseText(prev => `${prev}\n\n❌ ${j.error}`);
            } catch {}
          }
        }
      }
      // 流结束但一个字都没出：给明确提示，别留一个空白面板
      setDiagnoseText(prev => {
        if (prev && !prev.startsWith('⏳')) return prev;
        return prev ? '❌ 模型没有返回任何内容，请检查「设置」里的 Base URL / 模型名，或稍后重试。' : '❌ 诊断结束但没有返回内容。';
      });
    } catch (err: any) {
      setDiagnoseText(`❌ 诊断请求失败: ${err.message}`);
    }
    setDiagnoseLoading(false);
  }, []);

  const closeDiagnose = useCallback(() => {
    setDiagnoseKey(null);
    setDiagnoseContainerName('');
    setDiagnoseText('');
    setDiagnoseCopied(false);
  }, []);

  const copyDiagnose = useCallback(() => {
    if (diagnoseText) {
      navigator.clipboard.writeText(diagnoseText);
      setDiagnoseCopied(true);
      setTimeout(() => setDiagnoseCopied(false), 2000);
    }
  }, [diagnoseText]);

  return {
    diagnoseKey,
    diagnoseContainerName,
    diagnoseLoading,
    diagnoseText,
    diagnoseCopied,
    diagnoseContainer,
    closeDiagnose,
    copyDiagnose,
  };
}
