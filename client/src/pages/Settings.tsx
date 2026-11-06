/**
 * 设置页 —— 薄壳（#18 settings-split 拆分后的容器）
 *
 * 这里只保留三类东西：
 *   1) 共享 state：settings（整页可编辑副本）、provider / customModel（提供商自动探测在下面的
 *      加载回调里，跨区块共享）、saved / saving（底部保存栏）、testResult（区块 A 展示、
 *      保存失败时由本文件写）、remoteServers（Docker 与 MFU 两个区块共用同一份）
 *   2) 往下的稳定回调：patchSettings / markDirty / setAssistantContextField / setDockerSources /
 *      handleProviderChange —— 全部 useCallback([]) 包裹，配合各区块的 React.memo 才真的省渲染
 *   3) 页面骨架：页头、底部「保存设置」、支持的提供商清单
 *
 * 各区块的实现与「为什么不放在父组件」见 ./settings/ 下每个文件头注释。
 */
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import { apiFetch, apiJson } from '../api/client';
import { Settings as SettingsIcon, Save, RefreshCw, Check } from 'lucide-react';
import type { Settings as SettingsType, DockerSource } from '../types';
import ModelSection, { providers } from './settings/ModelSection';
import AssistantContextSection from './settings/AssistantContextSection';
import LogSettingsSection from './settings/LogSettingsSection';
import WatchSourcesSection from './settings/WatchSourcesSection';
import DockerSourcesSection from './settings/DockerSourcesSection';
import ContainerMonitorSection from './settings/ContainerMonitorSection';
import AlertsSection from './settings/AlertsSection';
import MfuSection from './settings/MfuSection';

export default function Settings() {
  const [settings, setSettings] = useState<SettingsType>({
    openaiApiKey: '',
    openaiBaseUrl: 'http://localhost:11434/v1',
    model: 'qwen3.5:9b',
    logPath: '',
    watchFiles: '*.log',
    refreshInterval: '5000',
    autoAnalysis: true,
    thinkingEnabled: false,
    watchSources: [
      {
        id: 'default',
        name: '默认服务',
        path: '',
        pattern: '*.log',
        enabled: true,
        autoAnalysis: true
      }
    ],
    dockerSources: [
      {
        id: 'local',
        name: '本地 Docker',
        host: 'localhost',
        port: 2375,
        tls: false,
        enabled: false,
        autoAnalysis: true,
        projects: []
      }
    ],
  });
  const [provider, setProvider] = useState('ollama');
  const [customModel, setCustomModel] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [remoteServers, setRemoteServers] = useState<{ id: string; host: string; name: string; port: number }[]>([]);
  const toast = useToast();

  useEffect(() => {
    // Load settings
    apiFetch<Partial<SettingsType>>('/api/settings')
      .then(data => {
        // merge with defaults so no field becomes undefined
        setSettings(prev => ({ ...prev, ...data }));
        // Auto-detect provider from baseUrl
        const matched = providers.find(p => p.baseUrl && p.baseUrl === data.openaiBaseUrl);
        setProvider(matched?.id || 'custom');
        // If model not in preset list, set as custom
        const allModels = providers.flatMap(p => p.models);
        if (data.model && !allModels.includes(data.model)) {
          setCustomModel(data.model);
        }
      })
      .catch((err: unknown) => console.error('Failed to load settings:', err));

    // Load remote servers for Docker host dropdown + MFU 数据源
    apiFetch<{ servers?: any[] }>('/api/remote/servers')
      .then(data => {
        if (data.servers) {
          setRemoteServers(data.servers.map((s: any) => ({ id: s.id, host: s.host, name: s.name, port: s.port })));
        }
      })
      .catch(() => {});
  }, []);

  /** 写 settings 字段（不带脏标记） */
  const patchSettings = useCallback((patch: Partial<SettingsType>) => {
    setSettings(prev => ({ ...prev, ...patch }));
  }, []);

  /** 标记「未保存」 */
  const markDirty = useCallback(() => setSaved(false), []);

  const setAssistantContextField = useCallback((patch: Record<string, unknown>) => {
    setSettings(prev => ({ ...prev, assistantContext: { ...(prev.assistantContext || {}), ...patch } }));
  }, []);

  const setDockerSources = useCallback((updater: (prev: DockerSource[]) => DockerSource[]) => {
    setSettings(prev => ({ ...prev, dockerSources: updater(prev.dockerSources || []) }));
  }, []);

  const handleProviderChange = useCallback((pid: string) => {
    const p = providers.find(x => x.id === pid);
    if (!p) return;
    setProvider(pid);
    // Update baseUrl and first model
    setSettings(prev => ({
      ...prev,
      openaiBaseUrl: p.baseUrl,
      model: p.models[0] || prev.model,
    }));
    setCustomModel('');
    setSaved(false);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setTestResult(null);

    try {
      await apiJson('/api/settings', 'PUT', {
          openaiApiKey: settings.openaiApiKey,
          openaiBaseUrl: settings.openaiBaseUrl,
          model: settings.model,
          logPath: settings.logPath,
          watchFiles: settings.watchFiles,
          refreshInterval: settings.refreshInterval,
          autoAnalysis: settings.autoAnalysis,
          thinkingEnabled: settings.thinkingEnabled,
          watchSources: settings.watchSources,
          dockerSources: settings.dockerSources,
          dockerEventNotify: settings.dockerEventNotify,
          containerPatrolEnabled: settings.containerPatrolEnabled,
          containerPatrolInterval: settings.containerPatrolInterval,
          containerPatrolLevels: settings.containerPatrolLevels,
          containerLogWatchEnabled: settings.containerLogWatchEnabled,
          containerLogWatchInterval: settings.containerLogWatchInterval,
          // 助手上下文：没在这里改过的话不传，避免用默认值覆盖用户在助手齿轮里的全局设置
          ...(settings.assistantContext ? { assistantContext: settings.assistantContext } : {}),
      });

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      toast.success('设置已保存');
    } catch {
      setTestResult({ success: false, message: '保存失败' });
      toast.error('保存失败');
    }

    setSaving(false);
  };

  const hasEnabledDocker = (settings.dockerSources || []).filter(s => s.enabled).length > 0;

  return (
    <div className="space-y-6 animate-fade-in max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-3">
          <SettingsIcon className="w-7 h-7 text-accent-500" />
          设置
        </h1>
        <p className="text-dark-400">配置系统参数与 AI 模型</p>
      </div>

      <ModelSection
        apiKey={settings.openaiApiKey}
        baseUrl={settings.openaiBaseUrl}
        model={settings.model}
        thinkingEnabled={settings.thinkingEnabled}
        provider={provider}
        customModel={customModel}
        onProviderChange={handleProviderChange}
        onCustomModelChange={setCustomModel}
        onPatch={patchSettings}
        onDirty={markDirty}
        testResult={testResult}
        onTestResult={setTestResult}
      />

      <AssistantContextSection
        assistantContext={settings.assistantContext}
        onSetContextField={setAssistantContextField}
        onDirty={markDirty}
      />

      <LogSettingsSection
        logPath={settings.logPath}
        watchFiles={settings.watchFiles}
        refreshInterval={settings.refreshInterval}
        onPatch={patchSettings}
        onDirty={markDirty}
      />

      <WatchSourcesSection
        autoAnalysis={settings.autoAnalysis}
        watchSources={settings.watchSources}
        onPatch={patchSettings}
        onDirty={markDirty}
      />

      <DockerSourcesSection
        dockerSources={settings.dockerSources}
        remoteServers={remoteServers}
        setDockerSources={setDockerSources}
        onDirty={markDirty}
      />

      {hasEnabledDocker && (
        <ContainerMonitorSection
          dockerEventNotify={settings.dockerEventNotify}
          containerLogWatchEnabled={settings.containerLogWatchEnabled}
          containerLogWatchInterval={settings.containerLogWatchInterval}
          containerPatrolEnabled={settings.containerPatrolEnabled}
          containerPatrolInterval={settings.containerPatrolInterval}
          containerPatrolLevels={settings.containerPatrolLevels}
          onPatch={patchSettings}
        />
      )}

      <AlertsSection />

      <MfuSection remoteServers={remoteServers} />

      {/* Save */}
      <div className="flex items-center justify-end gap-4">
        {saved && (
          <div className="flex items-center gap-2 text-green-400">
            <Check className="w-5 h-5" />
            保存成功
          </div>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2.5 rounded-lg bg-gradient-to-r from-accent-600 to-accent-500 hover:from-accent-500 hover:to-accent-400 transition-all disabled:opacity-50 flex items-center gap-2 font-semibold"
        >
          {saving ? (
            <><RefreshCw className="w-5 h-5 animate-spin" />保存中...</>
          ) : (
            <><Save className="w-5 h-5" />保存设置</>
          )}
        </button>
      </div>

      {/* Supported providers */}
      <div className="glass rounded-xl p-4 bg-blue-500/10 border border-blue-500/20">
        <h3 className="font-semibold mb-2 text-blue-400">💡 支持的模型提供商</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-xs text-dark-400 mt-2">
          {providers.filter(p => p.id !== 'custom').map(p => (
            <div key={p.id} className="flex items-center gap-1">
              <Check className="w-3 h-3 text-green-400" />
              {p.name}
            </div>
          ))}
        </div>
        <p className="text-xs text-dark-500 mt-3">所有提供商均使用 OpenAI 兼容 API 格式，支持自定义 Base URL</p>
      </div>
    </div>
  );
}