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
  X
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
  });
  const [provider, setProvider] = useState('ollama');
  const [customModel, setCustomModel] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [logFiles, setLogFiles] = useState<{ name: string; path: string; size: number }[]>([]);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    // Load settings
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        setSettings(data);
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
          setOllamaModels(data.models);
        }
        setLoadingModels(false);
      })
      .catch(() => setLoadingModels(false));
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
          watchSources: settings.watchSources,
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
