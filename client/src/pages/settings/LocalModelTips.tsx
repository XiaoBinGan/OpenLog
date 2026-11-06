/**
 * 区块：「本地模型使用指南」（Ollama / LM Studio 安装指引）
 *
 * 负责什么：
 *   - 选中本地提供商时展示的静态步骤卡片，按 provider 切换 Ollama / LM Studio 两套文案
 *
 * 为什么不放在父组件：
 *   纯静态 JSX，只依赖一个 provider 字符串。独立成 memo 组件后，父组件与 ModelSection
 *   里任何输入都不会让它重渲染；也顺手把 ModelSection 压到 300 行以内。
 */
import { memo } from 'react';
import { Server } from 'lucide-react';

export interface LocalModelTipsProps {
  provider: string;
  /** 是否为本地提供商（ollama/lmstudio/vllm/sglang/custom） */
  isLocal: boolean;
}

function LocalModelTips({ provider, isLocal }: LocalModelTipsProps) {
  if (!isLocal) return null;

  return (
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
  );
}

export default memo(LocalModelTips);