/**
 * server/__tests__/assistant-tool-progress.test.js
 *
 * 运维助手体验优化（对齐 AI Shell）的接线保护：
 *   1. chat-runner 必须把流式钩子传给 executeAssistantTool，并发出 tool_progress
 *   2. tool_result 必须带 durationMs（前端步骤卡显示耗时）
 *   3. 收尾前必须拦截「没调工具却声称已执行」
 *   4. index.js 的 remote_exec / agent 工具必须支持流式执行
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const runner = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'chat-runner.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'chat.js'), 'utf8');

describe('chat-runner —— 工具事件与流式输出', () => {
  it('tool_result 带 durationMs', () => {
    expect(runner).toMatch(/type: 'tool_result', tool: tc\.name, result: guardUiResult\(result\), durationMs/);
  });

  it('执行工具时传入 onOutput 钩子并发 tool_progress', () => {
    expect(runner).toContain('executeAssistantTool(tc.name, args, hooks)');
    expect(runner).toMatch(/type: 'tool_progress'/);
    expect(runner).toContain('onOutput: (stream, chunk)');
  });

  it('单个工具结果有大小保护（避免 SSE 事件过大卡页面）', () => {
    expect(runner).toContain('function guardUiResult');
    expect(runner).toContain('UI_RESULT_CHARS');
  });
});

describe('chat-runner —— 假执行拦截', () => {
  it('收尾前调用 maybeCorrectFakeExecution（两条收尾路径都拦）', () => {
    expect(runner).toContain('const maybeCorrectFakeExecution =');
    // 文本协议收尾 + 原生收尾各一处调用
    const calls = runner.match(/if \(maybeCorrectFakeExecution\(/g) || [];
    expect(calls.length).toBe(2);
  });

  it('只在本次任务没有真正执行过工具时才纠正', () => {
    expect(runner).toContain('if (anyToolExecuted || fakeExecCorrected) return false;');
    expect(runner).toContain('anyToolExecuted = true;');
  });
});

describe('index.js —— 工具执行的流式接线', () => {
  it('remote_exec 有钩子时走 execRemoteCommandStream', () => {
    expect(index).toContain('remote.execRemoteCommandStream(args.serverId, args.command');
    expect(index).toContain("hooks.onOutput('stdout', chunk)");
  });

  it('agent 工具（remote_grep/read 等）也支持流式', () => {
    expect(index).toContain('exec: hooks.onOutput');
    expect(index).toContain("hooks.onOutput('stderr', chunk)");
  });
});

describe('chat.js —— 提示词禁止假执行', () => {
  it('明确要求没调工具不许说已执行', () => {
    expect(chat).toContain('没调工具就不许说"已执行"');
    expect(chat).toContain('禁止编造命令输出');
  });

  it('强制简体中文回答', () => {
    expect(chat).toContain('一律用简体中文回答');
  });

  it('支持会话指定目标服务器（写进系统提示，省掉先 remote_servers）', () => {
    expect(chat).toContain('targetServerId');
    expect(chat).toContain('当前目标服务器（用户已指定）');
    expect(chat).toContain('不需要先调 remote_servers');
  });

  it('按模型窗口自适应上下文预算', () => {
    expect(chat).toContain('probeModelWindow');
    expect(chat).toContain('adaptContextToWindow');
  });
});

describe('客户端 —— 目标服务器 / 历史 / 复制 接线', () => {
  const assistant = fs.readFileSync(path.join(ROOT, 'client', 'src', 'pages', 'Assistant.tsx'), 'utf8');
  const card = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'ToolCallCard.tsx'), 'utf8');

  it('发送消息带上 targetServerId', () => {
    expect(assistant).toContain('targetServerId: targetServerId || undefined');
  });

  it('输入框 ↑/↓ 翻历史 + Enter 发送', () => {
    expect(assistant).toContain('handleInputKeyDown');
    expect(assistant).toContain("e.key === 'ArrowUp'");
    expect(assistant).toContain('assistant.inputHistory');
  });

  it('回答可复制、预算用尽可继续', () => {
    expect(assistant).toContain('copyText(msg.content');
    expect(assistant).toContain('继续（接着当前进度做）');
  });

  it('工具步骤卡可复制输出', () => {
    expect(card).toContain('复制输出');
    expect(card).toContain('navigator.clipboard.writeText');
  });

  it('失败步骤有「让助手重试」入口', () => {
    expect(assistant).toContain('retryFailedTool');
    expect(card).toContain('让助手重试');
    expect(card).toContain('onRetry');
  });

  it('历史消息的步骤卡自动折叠（openOverride）', () => {
    expect(assistant).toContain('isOldMessage');
    expect(card).toContain('openOverride');
  });
});

describe('chat-runner —— 正文流式输出', () => {
  it('原生模式边收边推（liveFilter / streamedContent），文本协议仍攒完再解析', () => {
    expect(runner).toContain('const liveFilter = useNative ? new ThinkingStreamFilter');
    expect(runner).toContain('streamedContent');
    expect(runner).toContain('shouldStartStreaming');
  });

  it('假执行话术不提前流出（首轮流式有门槛）', () => {
    expect(runner).toContain('looksLikeFakeExecution(contentAcc.slice(0, 60))');
  });
});
