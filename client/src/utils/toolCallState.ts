/**
 * 工具调用 chip 的状态机（纯函数，便于测试）。
 *
 * 背景（真实 bug）：运维助手回答完之后，顶部的工具 chip 还停在「运行中」转圈，
 * 用户以为 agent 没干完。两个原因：
 *   1. 前端 SSE 拆行不跨 chunk，`tool_result` 被切断就丢了（已在 sseLines 修）
 *   2. 流结束/中断时没人给残留的 running 状态收尾
 *
 * 这里把「结果回填」和「收尾」抽成纯函数：同一个工具可能被连续调用多次，
 * 结果要按顺序一一对应，不能一次把一个工具名的所有调用都标成完成。
 */

export type ToolCallStatus = 'running' | 'done' | 'aborted';

export interface ToolCall {
  tool: string;
  args?: any;
  status: ToolCallStatus;
  result?: any;
}

/**
 * 把一次工具结果回填给「第一个还没结果的同名调用」。
 * 找不到可回填的调用时原样返回（避免乱配）。
 */
export function applyToolResult<T extends ToolCall>(calls: T[], tool: string, result: any): T[] {
  const idx = calls.findIndex(c => c.tool === tool && c.status === 'running');
  if (idx === -1) return calls;
  return calls.map((c, i) => (i === idx ? { ...c, status: 'done' as const, result } : c));
}

/**
 * 流结束（正常结束/报错/用户停止）时收尾：所有还在 running 的调用标为 aborted。
 * 返回 null 表示没有需要改的（调用方可以跳过 setState）。
 */
export function settleToolCalls<T extends ToolCall>(calls: T[]): T[] | null {
  if (!calls || !calls.some(c => c.status === 'running')) return null;
  return calls.map(c => (c.status === 'running' ? { ...c, status: 'aborted' as const } : c));
}

/** chip 展示用：状态 → 样式语义 */
export function toolCallTone(call: ToolCall): 'running' | 'failed' | 'aborted' | 'ok' {
  if (call.status === 'running') return 'running';
  if (call.status === 'aborted') return 'aborted';
  if (call.result?.error) return 'failed';
  return 'ok';
}
