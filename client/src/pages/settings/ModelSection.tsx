/**
 * 区块：AI 模型配置（提供商网格 / API Key / Base URL / 模型选择）
 *
 * 负责什么：
 *   - providers 清单（导出给父组件底部的「支持的模型提供商」列表复用，不复制常量）
 *   - 提供商网格、API Key 明文切换、Base URL、模型下拉/手填、刷新已安装模型列表
 *   - 把「测试连接」「本地模型使用指南」挂回原来的 DOM 位置：./ModelConnectionTest.tsx、./LocalModelTips.tsx
 *
 * 为什么不放在父组件：
 *   只有 4 个字段是与父组件共享的（openaiApiKey / openaiBaseUrl / model / thinkingEnabled），
 *   其余（showApiKey、ollamaModels、loadingModels、拉模型列表的请求）都是本区块私有的。
 *   下沉后这边输入不会让 Docker / 告警 / MFU 等其它区块重画。
 *   例外：provider 选中态与 customModel 留在父组件——自动探测发生在父组件加载 settings 的同一个
 *   then 回调里（见 Settings.tsx），下沉需要额外的加载信号，反而更脆。
 */
import { memo, useCallback, useEffect, useState } from 'react';
import {
  Cpu,
  Cloud,
  Server,
  Terminal,
  Eye,
  EyeOff,
  RefreshCw,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import type { Settings as SettingsType } from '../../types';
import ThinkingTestBlock from './ThinkingTestBlock';
import ModelConnectionTest from './ModelConnectionTest';
import LocalModelTips from './LocalModelTips';

export const providers = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'], icon: Cloud },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-coder'], icon: Cpu },
  { id: 'moonshot', name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], icon: Cloud },
  { id: 'zhipu', name: '智谱 AI (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4', 'glm-4-flash', 'glm-3-turbo'], icon: Cpu },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'], icon: Cloud },
  { id: 'doubao', name: '豆包 (字节)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k', 'doubao-pro-128k', 'doubao-lite-32k'], icon: Cpu },
  { id: 'baichuan', name: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1', models: ['Baichuan2-Turbo', 'Baichuan3-Turbo'], icon: Cpu },
  { id: 'yi', name: '零一万物 (Yi)', baseUrl: 'https://api.lingyiwanwu.com/v1', models: ['yi-large', 'yi-medium', 'yi-spark'], icon: Cpu },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', models: ['abab6.5-chat', 'abab5.5-chat'], icon: Cpu },
  { id: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'], icon: Cloud },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama3-70b-8192', 'llama3-8b-8192', 'mixtral-8x7b-32768'], icon: Cpu },
  { id: 'vllm', name: 'vLLM (本地部署)', baseUrl: 'http://127.0.0.1:8000/v1', models: [], icon: Server },
  { id: 'sglang', name: 'SGLang (本地部署)', baseUrl: 'http://127.0.0.1:30000/v1', models: [], icon: Server },
  { id: 'ollama', name: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1', models: ['qwen3.5:9b', 'qwen3:8b', 'qwen2.5:14b', 'qwen2.5:7b', 'llama3.1:8b', 'mistral', 'codellama', 'deepseek-coder'], icon: Server },
  { id: 'lmstudio', name: 'LM Studio (本地)', baseUrl: 'http://localhost:1234/v1', models: ['local-model'], icon: Server },
  { id: 'custom', name: '自定义 API', baseUrl: '', models: [], icon: Terminal },
];

export interface ModelSectionProps {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinkingEnabled: boolean;
  provider: string;
  customModel: string;
  onProviderChange: (pid: string) => void;
  onCustomModelChange: (value: string) => void;
  /** 写 settings 字段（不带 dirty 标记） */
  onPatch: (patch: Partial<SettingsType>) => void;
  /** 标记「未保存」——原组件每次编辑后都会叫一次 setSaved(false) */
  onDirty: () => void;
  testResult: { success: boolean; message: string } | null;
  onTestResult: (result: { success: boolean; message: string } | null) => void;
}

function ModelSection({
  apiKey,
  baseUrl,
  model,
  thinkingEnabled,
  provider,
  customModel,
  onProviderChange,
  onCustomModelChange,
  onPatch,
  onDirty,
  testResult,
  onTestResult,
}: ModelSectionProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const patch = (p: Partial<SettingsType>) => { onPatch(p); onDirty(); };

  const currentProvider = providers.find(p => p.id === provider) || providers[providers.length - 1];
  const isLocal = ['ollama', 'lmstudio', 'vllm', 'sglang', 'custom'].includes(provider);

  const fetchOllamaModels = useCallback(() => {
    setLoadingModels(true);
    // 通用：vLLM / SGLang / Strata / Ollama 都提供 /v1/models，后端会自动兜底 /api/tags
    const qs = new URLSearchParams();
    if (baseUrl) qs.set('baseUrl', baseUrl);
    if (apiKey && !apiKey.includes('***')) qs.set('apiKey', apiKey);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    apiFetch<{ models?: any[] }>(`/api/models${suffix}`)
      .then(data => {
        setOllamaModels(Array.isArray(data.models) ? data.models : []);
        setLoadingModels(false);
      })
      .catch(() => setLoadingModels(false));
  }, [apiKey, baseUrl]);

  // 挂载时拉一次（与原实现一致：用的是 settings 默认值，而非服务端返回值）
  useEffect(() => { fetchOllamaModels(); }, []);

  return (
    <>
      {/* Model Provider */}
      <div className="glass rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Cpu className="w-5 h-5 text-purple-400" />
          AI 模型配置
        </h2>

        <div className="space-y-4">
          {/* Provider Grid */}
          <div>
            <label className="block text-sm text-dark-400 mb-2">模型提供商</label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {providers.map(p => {
                const Icon = p.icon;
                const isLocalP = p.id === 'ollama' || p.id === 'lmstudio';
                return (
                  <button
                    key={p.id}
                    onClick={() => onProviderChange(p.id)}
                    className={`p-3 rounded-lg border transition-all flex items-center gap-2 ${
                      provider === p.id
                        ? 'bg-accent-500/20 border-accent-500/50 text-accent-400'
                        : 'bg-dark-900 border-dark-800 text-dark-300 hover:border-dark-700'
                    }`}
                  >
                    <Icon className={`w-4 h-4 flex-shrink-0 ${isLocalP ? 'text-green-400' : ''}`} />
                    <span className="text-sm truncate">{p.name}</span>
                    {isLocalP && <span className="text-xs px-1 py-0.5 rounded bg-green-500/20 text-green-400 flex-shrink-0">本地</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* API Key - hidden for local */}
          {!isLocal && (
            <div>
              <label className="block text-sm text-dark-400 mb-2">API Key</label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => patch({ openaiApiKey: e.target.value })}
                  placeholder={provider === 'custom' ? 'Your API Key' : `${currentProvider.name} API Key`}
                  className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500 pr-12"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300"
                >
                  {showApiKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              <p className="text-xs text-dark-500 mt-1">
                {provider === 'custom' ? '输入兼容 OpenAI API 格式的 API Key' : `从 ${currentProvider.name} 官网获取 API Key`}
              </p>
            </div>
          )}

          {/* Base URL - always editable */}
          <div>
            <label className="block text-sm text-dark-400 mb-2">API Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={e => patch({ openaiBaseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500"
            />
            {provider === 'ollama' && (
              <p className="text-xs text-dark-500 mt-1">
                确保 Ollama 已运行: <code className="text-accent-400">ollama serve</code>
              </p>
            )}
          </div>

          {/* Model Selection */}
          <div>
            <label className="block text-sm text-dark-400 mb-2">模型</label>

            {/* Ollama: show detected models + preset */}
            {['ollama', 'vllm', 'sglang', 'lmstudio', 'custom'].includes(provider) ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={model}
                    onChange={e => patch({ model: e.target.value })}
                    placeholder="输入模型名称"
                    className="flex-1 px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500"
                  />
                  <button
                    onClick={fetchOllamaModels}
                    disabled={loadingModels}
                    className="px-3 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700 transition-colors flex items-center gap-1 text-sm whitespace-nowrap"
                  >
                    <RefreshCw className={`w-4 h-4 ${loadingModels ? 'animate-spin' : ''}`} />
                    刷新列表
                  </button>
                </div>

                {/* Detected models */}
                {ollamaModels.length > 0 && (
                  <div>
                    <p className="text-xs text-dark-500 mb-1">已安装的模型（点击选择）：</p>
                    <div className="flex flex-wrap gap-1">
                      {ollamaModels.map(m => (
                        <button
                          key={m}
                          onClick={() => patch({ model: m })}
                          className={`px-2 py-1 rounded text-xs transition-colors ${
                            model === m
                              ? 'bg-accent-500 text-white'
                              : 'bg-dark-800 text-dark-400 hover:bg-dark-700 hover:text-dark-200'
                          }`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {ollamaModels.length === 0 && !loadingModels && (
                  <p className="text-xs text-yellow-500">
                    未检测到已安装模型，请确认 Ollama 正在运行
                  </p>
                )}
              </div>
            ) : currentProvider.models.length > 0 ? (
              <div className="space-y-2">
                <select
                  value={model}
                  onChange={e => patch({ model: e.target.value })}
                  className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 focus:outline-none focus:border-accent-500"
                >
                  {currentProvider.models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={customModel}
                  onChange={e => {
                    onCustomModelChange(e.target.value);
                    if (e.target.value) {
                      patch({ model: e.target.value });
                    }
                  }}
                  placeholder="或手动输入模型名称"
                  className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500 text-sm"
                />
              </div>
            ) : (
              <input
                type="text"
                value={model}
                onChange={e => patch({ model: e.target.value })}
                placeholder="输入模型名称"
                className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500"
              />
            )}
          </div>

          <ThinkingTestBlock
            thinkingEnabled={thinkingEnabled}
            onToggleThinking={next => patch({ thinkingEnabled: next })}
          />

          {/* Test Connection */}
          <ModelConnectionTest
            apiKey={apiKey}
            baseUrl={baseUrl}
            model={model}
            isLocal={isLocal}
            testResult={testResult}
            onTestResult={onTestResult}
          />
        </div>
      </div>

      {/* Local model tips */}
      <LocalModelTips provider={provider} isLocal={isLocal} />
    </>
  );
}

export default memo(ModelSection);
