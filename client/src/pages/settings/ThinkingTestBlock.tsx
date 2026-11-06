/**
 * 区块：「显示思维过程」开关 + 测试思维过滤
 *
 * 负责什么：
 *   - 思维过程开关（由父级 Settings 通过 props 传入的 thinkingEnabled 控制）
 *   - 「测试思维过滤」按钮 + 它自己的一次性测试状态（idle/testing/ok/fail）
 *
 * 为什么不放在父组件：
 *   测试状态（thinkingTestStatus / thinkingTestMsg）以及 SSE 读取、<think/> 标签判定
 *   这一整套逻辑只服务于这一小块 UI，没有任何其它区块读它。下沉之后父组件不必为一个
 *   从没被共享过的状态承担重渲染；而且一旦结果变化，只有这个 ~110 行的组件重画，
 *   而不是整页（含 Docker 那一大坨 <pre> 文档）。
 */
import { memo, useState } from 'react';
import { Brain, Terminal } from 'lucide-react';
import Toggle from '../../components/Toggle';

export interface ThinkingTestBlockProps {
  thinkingEnabled: boolean;
  /** 切换开关；由 ModelSection 落到 settings.thinkingEnabled + setSaved(false) */
  onToggleThinking: (next: boolean) => void;
}

type ThinkingTestStatus = 'idle' | 'testing' | 'ok' | 'fail';

function ThinkingTestBlock({ thinkingEnabled, onToggleThinking }: ThinkingTestBlockProps) {
  const [thinkingTestStatus, setThinkingTestStatus] = useState<ThinkingTestStatus>('idle');
  const [thinkingTestMsg, setThinkingTestMsg] = useState('');

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

      if (thinkingEnabled) {
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

  return (
    <div className="p-4 rounded-lg bg-dark-900/60 border border-dark-800 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="w-4 h-4 text-purple-400" />
          <div>
            <p className="text-sm text-dark-200">显示思维过程</p>
            <p className="text-xs text-dark-500">
              {thinkingEnabled
                ? '输出 <think/> 标签内的推理过程（适用于 deepseek-r1、qwen3 等推理模型）'
                : '自动过滤模型的内部推理过程，只输出最终结果'}
            </p>
          </div>
        </div>
        <Toggle
          checked={thinkingEnabled}
          onChange={onToggleThinking}
          size="md"
          color="#a855f7"
          ring="focus:ring-2 focus:ring-purple-500/50"
          aria-label="显示思维过程"
        />
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
  );
}

export default memo(ThinkingTestBlock);