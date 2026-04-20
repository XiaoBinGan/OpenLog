import { useState, useEffect } from 'react';
import {
  Settings as SettingsIcon,
  Folder,
  Save,
  RefreshCw,
  Check,
  AlertCircle,
  Eye,
  EyeOff,
  Terminal,
  Cpu,
  Cloud,
  Server,
  Plus,
  Trash2,
  Brain,
  X,
  Boxes
} from 'lucide-react';
import type { Settings as SettingsType } from '../types';

const providers = [
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
  { id: 'ollama', name: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1', models: ['qwen3.5:9b', 'qwen3:8b', 'qwen2.5:14b', 'qwen2.5:7b', 'llama3.1:8b', 'mistral', 'codellama', 'deepseek-coder'], icon: Server },
  { id: 'lmstudio', name: 'LM Studio (本地)', baseUrl: 'http://localhost:1234/v1', models: ['local-model'], icon: Server },
  { id: 'custom', name: '自定义 API', baseUrl: '', models: [], icon: Terminal },
];

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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [dockerTestStatus, setDockerTestStatus] = useState<Record<string, 'testing' | 'ok' | 'fail'>>({});
  const [dockerTestMsg, setDockerTestMsg] = useState<Record<string, string>>({});
  const [showApiKey, setShowApiKey] = useState(false);
  const [logFiles, setLogFiles] = useState<{ name: string; path: string; size: number }[]>([]);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [thinkingTestStatus, setThinkingTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [thinkingTestMsg, setThinkingTestMsg] = useState('');

  useEffect(() => {
    // Load settings
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        setSettings(prev => ({ ...prev, ...data }));
        // Auto-detect provider from baseUrl
        const matched = providers.find(p => p.baseUrl && p.baseUrl === data.openaiBaseUrl);
        setProvider(matched?.id || 'custom');
        // If model not in preset list, set as custom
        const allModels = providers.flatMap(p => p.models);
        if (!allModels.includes(data.model)) {
          setCustomModel(data.model);
        }
      });

    // Load log files
    fetch('/api/logs/files')
      .then(r => r.json())
      .then(data => setLogFiles(data))
      .catch(() => {});

    // Load Ollama models
    fetchOllamaModels();
  }, []);

  const fetchOllamaModels = () => {
    setLoadingModels(true);
    fetch('/api/models/ollama')
      .then(r => r.json())
      .then(data => {
        if (data.models && data.models.length > 0) {
          setOllamaModels(data.models.map((m: any) => typeof m === 'string' ? m : m.name || m.model));
        }
        setLoadingModels(false);
      })
      .catch(() => setLoadingModels(false));
  };

  const testThinkingFilter = async () => {
    setThinkingTestStatus('testing');
    setThinkingTestMsg('');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '请用一句话回答：1+1等于几？' }],
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // 读取 SSE 流
      const reader = res.body?.getReader();
      if (!reader) throw new Error('无法读取流');

      let fullText = '';
      let hasThink = false;
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) fullText += data.content;
              if (data.error) throw new Error(data.error);
            } catch (e: any) {
              if (e.message && !e.message.includes('JSON')) throw e;
            }
          }
        }
      }

      // 检查原始模型是否输出 <think/> 标签
      hasThink = fullText.includes('<think') || fullText.includes('&lt;think');

      if (settings.thinkingEnabled) {
        // 开启思维 → 应该能看到 <think/> 内容
        setThinkingTestStatus('ok');
        setThinkingTestMsg(hasThink
          ? `✅ 思维过程可见（模型输出了推理标签）`
          : `✅ 模型未输出推理标签，或当前模型不支持推理模式`
        );
      } else {
        // 关闭思维 → 不应该看到 <think/> 标签
        if (hasThink) {
          setThinkingTestStatus('fail');
          setThinkingTestMsg(`❌ 过滤失败：仍然包含推理标签`);
        } else {
          setThinkingTestStatus('ok');
          setThinkingTestMsg(`✅ 过滤正常（无推理标签输出）`);
        }
      }
    } catch (err: any) {
      setThinkingTestStatus('fail');
      setThinkingTestMsg(`❌ 测试失败: ${err.message}`);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setTestResult(null);

    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        })
      });

      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      } else {
        setTestResult({ success: false, message: '保存失败' });
      }
    } catch {
      setTestResult({ success: false, message: '保存失败' });
    }

    setSaving(false);
  };

  const testDocker = async (ds: any) => {
    setDockerTestStatus(prev => ({ ...prev, [ds.id]: 'testing' }));
    try {
      const res = await fetch('/api/docker/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: ds.id, config: {
          socketPath: ds.socketPath || undefined,
          host: ds.socketPath ? undefined : (ds.host || 'localhost'),
          port: ds.socketPath ? undefined : (ds.port || 2375),
          tls: ds.tls,
        }})
      });
      const data = await res.json();
      if (data.success) {
        setDockerTestStatus(prev => ({ ...prev, [ds.id]: 'ok' }));
        setDockerTestMsg(prev => ({ ...prev, [ds.id]: `${data.name} ✅ ${data.containers} 容器 / ${data.running} 运行中` }));
      } else {
        setDockerTestStatus(prev => ({ ...prev, [ds.id]: 'fail' }));
        setDockerTestMsg(prev => ({ ...prev, [ds.id]: data.error || '连接失败' }));
      }
    } catch (err: any) {
      setDockerTestStatus(prev => ({ ...prev, [ds.id]: 'fail' }));
      setDockerTestMsg(prev => ({ ...prev, [ds.id]: err.message }));
    }
  };

  const testApiKey = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch('/api/logs/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logs: [{ id: '1', timestamp: new Date().toISOString(), level: 'INFO', message: 'API connection test' }],
          prompt: 'Reply with exactly: "API test successful"'
        })
      });

      const data = await res.json();
      if (data.analysis) {
        setTestResult({ success: true, message: isLocal ? '本地模型连接成功！' : 'API 连接成功！' });
      } else {
        setTestResult({ success: false, message: data.error || 'API 测试失败' });
      }
    } catch (err) {
      setTestResult({ success: false, message: 'API 测试失败: ' + err });
    }

    setTesting(false);
  };

  const handleProviderChange = (pid: string) => {
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
  };

  const currentProvider = providers.find(p => p.id === provider) || providers[providers.length - 1];
  const isLocal = provider === 'ollama' || provider === 'lmstudio';

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
                    onClick={() => handleProviderChange(p.id)}
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
                  value={settings.openaiApiKey}
                  onChange={e => { setSettings(p => ({ ...p, openaiApiKey: e.target.value })); setSaved(false); }}
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
              value={settings.openaiBaseUrl}
              onChange={e => { setSettings(p => ({ ...p, openaiBaseUrl: e.target.value })); setSaved(false); }}
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
            {provider === 'ollama' ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.model}
                    onChange={e => { setSettings(p => ({ ...p, model: e.target.value })); setSaved(false); }}
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
                          onClick={() => { setSettings(p => ({ ...p, model: m })); setSaved(false); }}
                          className={`px-2 py-1 rounded text-xs transition-colors ${
                            settings.model === m
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
                  value={settings.model}
                  onChange={e => { setSettings(p => ({ ...p, model: e.target.value })); setSaved(false); }}
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
                    setCustomModel(e.target.value);
                    if (e.target.value) {
                      setSettings(p => ({ ...p, model: e.target.value }));
                      setSaved(false);
                    }
                  }}
                  placeholder="或手动输入模型名称"
                  className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500 text-sm"
                />
              </div>
            ) : (
              <input
                type="text"
                value={settings.model}
                onChange={e => { setSettings(p => ({ ...p, model: e.target.value })); setSaved(false); }}
                placeholder="输入模型名称"
                className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500"
              />
            )}
          </div>

          {/* Thinking Toggle */}
          <div className="p-4 rounded-lg bg-dark-900/60 border border-dark-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Brain className="w-4 h-4 text-purple-400" />
                <div>
                  <p className="text-sm text-dark-200">显示思维过程</p>
                  <p className="text-xs text-dark-500">
                    {settings.thinkingEnabled
                      ? '输出 <think/> 标签内的推理过程（适用于 deepseek-r1、qwen3 等推理模型）'
                      : '自动过滤模型的内部推理过程，只输出最终结果'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => { setSettings(p => ({ ...p, thinkingEnabled: !p.thinkingEnabled })); setSaved(false); }}
                className="relative w-11 h-6 rounded-full transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                style={{ background: settings.thinkingEnabled ? '#a855f7' : '#374151' }}
              >
                <div
                  className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200"
                  style={{ transform: settings.thinkingEnabled ? 'translateX(22px)' : 'translateX(2px)' }}
                />
              </button>
            </div>
            {/* Thinking Test */}
            <div className="flex items-center gap-3">
              <button
                onClick={testThinkingFilter}
                disabled={thinkingTestStatus === 'testing'}
                className="px-3 py-1.5 rounded-lg bg-purple-500/15 text-purple-400 text-xs font-medium hover:bg-purple-500/25 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                <Terminal className="w-3.5 h-3.5" />
                {thinkingTestStatus === 'testing' ? '测试中...' : '测试思维过滤'}
              </button>
              {thinkingTestMsg && (
                <span className={`text-xs ${thinkingTestStatus === 'ok' ? 'text-green-400' : thinkingTestStatus === 'fail' ? 'text-red-400' : 'text-dark-400'}`}>
                  {thinkingTestMsg}
                </span>
              )}
            </div>
          </div>

          {/* Test Connection */}
          <div className="flex items-center gap-4">
            <button
              onClick={testApiKey}
              disabled={testing}
              className="px-4 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700 transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              <Terminal className="w-4 h-4" />
              {testing ? '测试中...' : '测试连接'}
            </button>

            {testResult && (
              <div className={`flex items-center gap-2 text-sm ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                {testResult.success ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                {testResult.message}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Local model tips */}
      {isLocal && (
        <div className="glass rounded-xl p-4 bg-green-500/10 border border-green-500/20">
          <h3 className="font-semibold mb-2 text-green-400 flex items-center gap-2">
            <Server className="w-5 h-5" />
            本地模型使用指南
          </h3>
          {provider === 'ollama' && (
            <div className="text-sm text-dark-400 space-y-1">
              <p>1. 安装: <code className="text-accent-400">brew install ollama</code></p>
              <p>2. 启动: <code className="text-accent-400">ollama serve</code></p>
              <p>3. 下载模型: <code className="text-accent-400">ollama pull qwen3.5:9b</code></p>
              <p>4. 查看已安装: <code className="text-accent-400">ollama list</code></p>
            </div>
          )}
          {provider === 'lmstudio' && (
            <div className="text-sm text-dark-400 space-y-1">
              <p>1. 下载安装 LM Studio</p>
              <p>2. 在 LM Studio 中下载模型</p>
              <p>3. 启动本地服务器（默认端口 1234）</p>
            </div>
          )}
        </div>
      )}

      {/* Log Settings */}
      <div className="glass rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Folder className="w-5 h-5 text-blue-400" />
          日志监控配置
        </h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-dark-400 mb-2">日志目录</label>
            <input
              type="text"
              value={settings.logPath}
              onChange={e => { setSettings(p => ({ ...p, logPath: e.target.value })); setSaved(false); }}
              placeholder="留空则使用 ~/logs"
              className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500"
            />
            {logFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                <span className="text-xs text-dark-500">检测到的文件：</span>
                {logFiles.slice(0, 5).map((file, idx) => (
                  <button
                    key={idx}
                    onClick={() => { setSettings(p => ({ ...p, logPath: file.path.replace(`/${file.name}`, '') })); setSaved(false); }}
                    className="px-2 py-1 bg-dark-800 rounded text-xs text-dark-400 hover:text-dark-200 transition-colors"
                  >
                    {file.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm text-dark-400 mb-2">监控文件模式</label>
            <input
              type="text"
              value={settings.watchFiles}
              onChange={e => { setSettings(p => ({ ...p, watchFiles: e.target.value })); setSaved(false); }}
              placeholder="*.log"
              className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500"
            />
            <p className="text-xs text-dark-500 mt-1">支持 glob 模式，如 *.log, app*.log</p>
          </div>

          <div>
            <label className="block text-sm text-dark-400 mb-2">监控刷新间隔</label>
            <select
              value={settings.refreshInterval}
              onChange={e => { setSettings(p => ({ ...p, refreshInterval: e.target.value })); setSaved(false); }}
              className="w-full px-4 py-2.5 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 focus:outline-none focus:border-accent-500"
            >
              <option value="2000">2 秒</option>
              <option value="5000">5 秒</option>
              <option value="10000">10 秒</option>
              <option value="30000">30 秒</option>
              <option value="60000">1 分钟</option>
            </select>
          </div>
        </div>
      </div>

      {/* Auto Analysis Settings */}
      <div className="glass rounded-xl p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-accent-500/20">
              <Brain className="w-5 h-5 text-accent-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-dark-100">主动分析</h2>
              <p className="text-xs text-dark-500">ERROR 日志出现时自动调用 AI 诊断</p>
            </div>
          </div>

          {/* Master Toggle */}
          <button
            onClick={() => setSettings(p => ({ ...p, autoAnalysis: !p.autoAnalysis }))}
            className="relative w-14 h-7 rounded-full transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500/50"
            style={{ background: settings.autoAnalysis ? '#10b981' : '#374151' }}
          >
            <div
              className="absolute top-1 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200"
              style={{ transform: settings.autoAnalysis ? 'translateX(28px)' : 'translateX(4px)' }}
            />
          </button>
        </div>

        {/* Multi-service sources */}
        {settings.autoAnalysis && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-dark-400 uppercase tracking-wider">日志服务</span>
              <button
                onClick={() => {
                  const id = `svc-${Date.now()}`;
                  setSettings(p => ({
                    ...p,
                    watchSources: [
                      ...p.watchSources,
                      { id, name: `服务${p.watchSources.length + 1}`, path: '', pattern: '*.log', enabled: true, autoAnalysis: true }
                    ]
                  }));
                  setSaved(false);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-500/15 text-accent-400 text-xs font-medium hover:bg-accent-500/25 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                添加服务
              </button>
            </div>

            <div className="space-y-2">
              {(settings.watchSources || []).map((src, idx) => (
                <div
                  key={src.id}
                  className={`relative rounded-xl border transition-all duration-200 overflow-hidden ${
                    src.enabled
                      ? 'border-dark-700 bg-dark-900/80'
                      : 'border-dark-800/50 bg-dark-900/40 opacity-60'
                  }`}
                >
                  {/* Card header */}
                  <div className="flex items-center gap-3 px-4 py-3">
                    {/* Status dot */}
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${src.enabled ? 'bg-green-400' : 'bg-dark-600'}`} />

                    {/* Service name */}
                    <input
                      type="text"
                      value={src.name}
                      onChange={e => {
                        const updated = [...(settings.watchSources || [])];
                        updated[idx] = { ...src, name: e.target.value };
                        setSettings(p => ({ ...p, watchSources: updated }));
                        setSaved(false);
                      }}
                      placeholder="服务名称"
                      className="flex-1 bg-transparent text-sm font-medium text-dark-100 placeholder-dark-600 focus:outline-none"
                    />

                    {/* Analysis badge */}
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      src.autoAnalysis && src.enabled
                        ? 'border-accent-500/30 bg-accent-500/10 text-accent-400'
                        : 'border-dark-700 bg-dark-800 text-dark-500'
                    }`}>
                      {src.autoAnalysis && src.enabled ? 'AI 分析' : '已关闭'}
                    </span>

                    {/* Toggle */}
                    <button
                      onClick={() => {
                        const updated = [...(settings.watchSources || [])];
                        updated[idx] = { ...src, enabled: !src.enabled };
                        setSettings(p => ({ ...p, watchSources: updated }));
                        setSaved(false);
                      }}
                      className="relative w-10 h-5 rounded-full transition-all duration-200 focus:outline-none"
                      style={{ background: src.enabled ? '#10b981' : '#374151' }}
                    >
                      <div
                        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200"
                        style={{ transform: src.enabled ? 'translateX(20px)' : 'translateX(2px)' }}
                      />
                    </button>

                    {/* Delete */}
                    {(settings.watchSources || []).length > 1 && (
                      <button
                        onClick={() => {
                          const updated = (settings.watchSources || []).filter((_, i) => i !== idx);
                          setSettings(p => ({ ...p, watchSources: updated }));
                          setSaved(false);
                        }}
                        className="p-1 rounded text-dark-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Card body */}
                  <div className="grid grid-cols-2 gap-2 px-4 pb-3">
                    <div>
                      <p className="text-xs text-dark-600 mb-1">日志目录</p>
                      <input
                        type="text"
                        value={src.path}
                        onChange={e => {
                          const updated = [...(settings.watchSources || [])];
                          updated[idx] = { ...src, path: e.target.value };
                          setSettings(p => ({ ...p, watchSources: updated }));
                          setSaved(false);
                        }}
                        placeholder="~/logs"
                        className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50 transition-colors"
                      />
                    </div>
                    <div>
                      <p className="text-xs text-dark-600 mb-1">文件模式</p>
                      <input
                        type="text"
                        value={src.pattern}
                        onChange={e => {
                          const updated = [...(settings.watchSources || [])];
                          updated[idx] = { ...src, pattern: e.target.value };
                          setSettings(p => ({ ...p, watchSources: updated }));
                          setSaved(false);
                        }}
                        placeholder="*.log"
                        className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50 transition-colors"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Docker 配置 */}
      <div className="glass rounded-xl p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/20">
              <Boxes className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-dark-100">Docker 连接配置</h2>
              <p className="text-xs text-dark-500">每个配置项对应一个 Docker Server（守护进程），连接后自动发现其下所有容器</p>
            </div>
          </div>
          <button
            onClick={() => {
              const id = `docker-${Date.now()}`;
              setSettings(p => ({
                ...p,
                dockerSources: [
                  ...(p.dockerSources || []),
                  { id, name: `Docker ${(p.dockerSources || []).length + 1}`, host: 'localhost', port: 2375, tls: false, enabled: true, autoAnalysis: true, projects: [] }
                ]
              }));
              setSaved(false);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/15 text-blue-400 text-xs font-medium hover:bg-blue-500/25 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            添加 Docker
          </button>
        </div>

        <div className="space-y-3">
          {(settings.dockerSources || []).map((ds, idx) => (
            <div key={ds.id} className="rounded-xl border border-dark-800 bg-dark-900/60 overflow-hidden">
              {/* Header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-dark-800">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${ds.enabled ? 'bg-blue-400' : 'bg-dark-600'}`} />
                <input
                  type="text"
                  value={ds.name}
                  onChange={e => {
                    const updated = [...(settings.dockerSources || [])];
                    updated[idx] = { ...ds, name: e.target.value };
                    setSettings(p => ({ ...p, dockerSources: updated }));
                    setSaved(false);
                  }}
                  className="flex-1 bg-transparent text-sm font-medium text-dark-100 focus:outline-none"
                />
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded border ${
                    ds.autoAnalysis && ds.enabled
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
                      : 'border-dark-700 bg-dark-800 text-dark-500'
                  }`}>
                    {ds.autoAnalysis && ds.enabled ? 'AI 分析' : '已关闭'}
                  </span>
                  <button
                    onClick={() => {
                      const updated = [...(settings.dockerSources || [])];
                      updated[idx] = { ...ds, enabled: !ds.enabled };
                      setSettings(p => ({ ...p, dockerSources: updated }));
                      setSaved(false);
                    }}
                    className="relative w-10 h-5 rounded-full transition-all duration-200"
                    style={{ background: ds.enabled ? '#3b82f6' : '#374151' }}
                  >
                    <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200"
                      style={{ transform: ds.enabled ? 'translateX(20px)' : 'translateX(2px)' }}
                    />
                  </button>
                  {(settings.dockerSources || []).length > 1 && (
                    <button
                      onClick={() => {
                        const updated = (settings.dockerSources || []).filter((_, i) => i !== idx);
                        setSettings(p => ({ ...p, dockerSources: updated }));
                        setSaved(false);
                      }}
                      className="p-1 rounded text-dark-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {/* 测试 Docker 连接 */}
                  <button
                    onClick={() => testDocker(ds)}
                    disabled={dockerTestStatus[ds.id] === 'testing'}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1 ${
                      dockerTestStatus[ds.id] === 'ok'
                        ? 'bg-green-500/20 border-green-500/50 text-green-400'
                        : dockerTestStatus[ds.id] === 'fail'
                        ? 'bg-red-500/20 border-red-500/50 text-red-400'
                        : 'bg-dark-800/40 border-dark-700/50 text-dark-400 hover:border-blue-500/50 hover:text-blue-400'
                    }`}
                  >
                    {dockerTestStatus[ds.id] === 'testing' ? '⏳' : dockerTestStatus[ds.id] === 'ok' ? '✅' : dockerTestStatus[ds.id] === 'fail' ? '❌' : '🔌'}
                    {dockerTestStatus[ds.id] === 'testing' ? '连接中...' : '测试连接'}
                  </button>
                </div>
              </div>

              {/* 测试结果 */}
              {dockerTestMsg[ds.id] && (
                <div className={`mx-4 mb-2 px-3 py-2 rounded-lg text-xs ${
                  dockerTestStatus[ds.id] === 'ok' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
                }`}>
                  {dockerTestMsg[ds.id]}
                </div>
              )}

              {/* 连接方式选择 */}
              <div className="px-4 py-2 border-b border-dark-800 bg-dark-900/40">
                <div className="flex gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => {
                      const updated = [...(settings.dockerSources || [])];
                      updated[idx] = { ...ds, socketPath: '/var/run/docker.sock', host: '', port: 0 };
                      setSettings(p => ({ ...p, dockerSources: updated }));
                      setSaved(false);
                    }}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      ds.socketPath
                        ? 'bg-green-500/20 border-green-500/50 text-green-400'
                        : 'bg-dark-800/40 border-dark-700/50 text-dark-400 hover:border-dark-600'
                    }`}
                  >
                    🍎 macOS Socket
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const updated = [...(settings.dockerSources || [])];
                      updated[idx] = { ...ds, socketPath: '', host: 'localhost', port: 2375 };
                      setSettings(p => ({ ...p, dockerSources: updated }));
                      setSaved(false);
                    }}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      !ds.socketPath && ds.host
                        ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                        : 'bg-dark-800/40 border-dark-700/50 text-dark-400 hover:border-dark-600'
                    }`}
                  >
                    🖥️ TCP
                  </button>
                </div>
                {ds.socketPath && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-dark-500">Socket:</span>
                    <input
                      type="text"
                      value={ds.socketPath}
                      onChange={e => {
                        const updated = [...(settings.dockerSources || [])];
                        updated[idx] = { ...ds, socketPath: e.target.value };
                        setSettings(p => ({ ...p, dockerSources: updated }));
                        setSaved(false);
                      }}
                      placeholder="/var/run/docker.sock"
                      className="flex-1 px-2 py-1 bg-dark-800/60 border border-dark-700/50 rounded text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-green-500/50"
                    />
                  </div>
                )}
              </div>

              {/* Fields */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
                <div>
                  <p className="text-xs text-dark-600 mb-1">主机地址</p>
                  <input
                    type="text"
                    value={ds.host}
                    onChange={e => {
                      const updated = [...(settings.dockerSources || [])];
                      updated[idx] = { ...ds, host: e.target.value };
                      setSettings(p => ({ ...p, dockerSources: updated }));
                      setSaved(false);
                    }}
                    placeholder="localhost / 192.168.1.100"
                    className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                  />
                </div>
                <div>
                  <p className="text-xs text-dark-600 mb-1">端口</p>
                  <input
                    type="number"
                    value={ds.port}
                    onChange={e => {
                      const updated = [...(settings.dockerSources || [])];
                      updated[idx] = { ...ds, port: parseInt(e.target.value) || 2375 };
                      setSettings(p => ({ ...p, dockerSources: updated }));
                      setSaved(false);
                    }}
                    placeholder="2375"
                    className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-dark-200 placeholder-dark-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                  />
                </div>
                <div>
                  <p className="text-xs text-dark-600 mb-1">TLS 加密</p>
                  <button
                    onClick={() => {
                      const updated = [...(settings.dockerSources || [])];
                      updated[idx] = { ...ds, tls: !ds.tls };
                      setSettings(p => ({ ...p, dockerSources: updated }));
                      setSaved(false);
                    }}
                    className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-left transition-colors flex items-center justify-between"
                  >
                    <span className={ds.tls ? 'text-green-400' : 'text-dark-500'}>{ds.tls ? '已启用' : '未启用'}</span>
                    <div className={`w-8 h-4 rounded-full transition-colors ${ds.tls ? 'bg-blue-500' : 'bg-dark-700'}`}
                      onClick={() => {}}
                    >
                      <div className={`w-3 h-3 rounded-full bg-white m-0.5 transition-transform ${ds.tls ? 'translate-x-4' : ''}`} />
                    </div>
                  </button>
                </div>
                <div>
                  <p className="text-xs text-dark-600 mb-1">AI 分析</p>
                  <button
                    onClick={() => {
                      const updated = [...(settings.dockerSources || [])];
                      updated[idx] = { ...ds, autoAnalysis: !ds.autoAnalysis };
                      setSettings(p => ({ ...p, dockerSources: updated }));
                      setSaved(false);
                    }}
                    className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-dark-700/50 rounded-lg text-xs text-left"
                  >
                    <span className={ds.autoAnalysis ? 'text-blue-400' : 'text-dark-500'}>
                      {ds.autoAnalysis ? '✅ 开启' : '⏸ 关闭'}
                    </span>
                  </button>
                </div>
              </div>
              <div className="px-4 pb-3">
                <p className="text-xs text-dark-600 mb-1">💡 连接说明</p>
                <p className="text-xs text-dark-600 leading-relaxed mb-2">
                  每个配置项连接的是一个 <strong className="text-dark-400">Docker Server（守护进程）</strong>，不是单个容器。
                  连接成功后会自动列出该 Server 上的所有容器，无需手动添加。
                </p>
                <details className="group">
                  <summary className="text-xs text-blue-400 cursor-pointer hover:text-blue-300 transition-colors">
                    📖 如何查看 Docker Server 地址？
                  </summary>
                  <div className="mt-2 space-y-2 text-xs">
                    <div>
                      <p className="text-dark-400 font-medium">macOS（Docker Desktop）</p>
                      <pre className="mt-1 px-2.5 py-1.5 bg-dark-800 rounded text-dark-300 font-mono overflow-x-auto">
                        docker context ls{'\n'}
                        {'#'} 默认: localhost:2375 或 unix:///var/run/docker.sock
                      </pre>
                    </div>
                    <div>
                      <p className="text-dark-400 font-medium">Linux</p>
                      <pre className="mt-1 px-2.5 py-1.5 bg-dark-800 rounded text-dark-300 font-mono overflow-x-auto">
                        {'#'} 查看 Docker 监听地址{'\n'}
                        sudo systemctl show docker --property=ListenStream{'\n'}
                        cat /etc/docker/daemon.json | grep hosts{'\n'}
                        {'\n'}
                        {'#'} 开启远程 TCP（需重启 Docker）{'\n'}
                        {'#'} 在 /etc/docker/daemon.json 中添加：{'\n'}
                        {'{'}`"hosts"`: [`"unix:///var/run/docker.sock"`, `"tcp://0.0.0.0:2375"`]{'}'}
                      </pre>
                    </div>
                    <div>
                      <p className="text-dark-400 font-medium">Windows（Docker Desktop）</p>
                      <pre className="mt-1 px-2.5 py-1.5 bg-dark-800 rounded text-dark-300 font-mono overflow-x-auto">
                        {'#'} PowerShell 查看配置{'\n'}
                        docker info | Select-String "Server Version|Operating System"{'\n'}
                        {'\n'}
                        {'#'} 默认: npipe:////./pipe/docker_engine{'\n'}
                        {'#'} 开启 TCP: Docker Desktop → Settings → General → Expose daemon on tcp://localhost:2375
                      </pre>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          ))}
          {(settings.dockerSources || []).length === 0 && (
            <div className="text-center py-8 text-dark-600 text-sm">
              <Boxes className="w-10 h-10 mx-auto mb-2 opacity-30" />
              暂未配置 Docker 连接，点击上方「添加 Docker」配置
            </div>
          )}
        </div>
      </div>

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
