/**
 * 区块：AI 模型配置卡片里的「测试连接」按钮 + 结果行
 *
 * 负责什么：
 *   - testApiKey 的完整流程：先 PUT /api/settings（用页面上的最新值）再 POST /api/logs/analyze
 *   - testing 中的禁用态、成功/失败图标与文案；测试结果本身由父组件持有
 *     （保存设置失败时父组件也要往同一处写「保存失败」，所以这里只消费不拥有）
 *
 * 为什么不放在父组件：
 *   一段明确的网络副作用 + 一个本地 loading 态，只服务这一个按钮。拆出来以后
 *   ModelSection 能压到 300 行以内，且这个按钮的 loading 变化不会牵动整张模型卡片。
 */
import { memo, useState } from 'react';
import { Check, AlertCircle, Terminal } from 'lucide-react';
import { apiJson } from '../../api/client';

export interface ModelConnectionTestProps {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 本地模型 / 自定义端点：决定成功文案 */
  isLocal: boolean;
  testResult: { success: boolean; message: string } | null;
  onTestResult: (result: { success: boolean; message: string } | null) => void;
}

function ModelConnectionTest({ apiKey, baseUrl, model, isLocal, testResult, onTestResult }: ModelConnectionTestProps) {
  const [testing, setTesting] = useState(false);

  const testApiKey = async () => {
    setTesting(true);
    onTestResult(null);

    try {
      // 先保存当前配置，确保测试用的是页面上的最新值
      try {
        await apiJson('/api/settings', 'PUT', {
          openaiApiKey: apiKey,
          openaiBaseUrl: baseUrl,
          model,
        });
      } catch {
        onTestResult({ success: false, message: '保存配置失败，无法测试' });
        setTesting(false);
        return;
      }

      const data = await apiJson<{ analysis?: string; error?: string }>('/api/logs/analyze', 'POST', {
        logs: [{ id: '1', timestamp: new Date().toISOString(), level: 'INFO', message: 'API connection test' }],
        prompt: 'Reply with exactly: "API test successful"'
      });

      if (data.analysis) {
        onTestResult({ success: true, message: isLocal ? '本地模型连接成功！' : 'API 连接成功！' });
      } else {
        onTestResult({ success: false, message: data.error || 'API 测试失败' });
      }
    } catch (err) {
      onTestResult({ success: false, message: 'API 测试失败: ' + err });
    }

    setTesting(false);
  };

  return (
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
  );
}

export default memo(ModelConnectionTest);