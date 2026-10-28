import { describe, it, expect } from 'vitest';
import { applyToolResult, settleToolCalls, toolCallTone, type ToolCall } from './toolCallState';

const call = (tool: string, status: ToolCall['status'] = 'running', result?: any): ToolCall =>
  ({ tool, status, result });

describe('applyToolResult —— 结果回填', () => {
  it('把结果回填给同名 running 调用', () => {
    const out = applyToolResult([call('docker_logs')], 'docker_logs', { content: 'x' });
    expect(out[0].status).toBe('done');
    expect(out[0].result).toEqual({ content: 'x' });
  });

  it('同一工具连调两次时按顺序一一对应（不能一次全标完）', () => {
    let calls = [call('docker_logs'), call('docker_logs')];
    calls = applyToolResult(calls, 'docker_logs', { n: 1 });
    expect(calls.map(c => c.status)).toEqual(['done', 'running']);
    calls = applyToolResult(calls, 'docker_logs', { n: 2 });
    expect(calls.map(c => c.status)).toEqual(['done', 'done']);
    expect(calls[0].result).toEqual({ n: 1 });
    expect(calls[1].result).toEqual({ n: 2 });
  });

  it('不同工具互不影响', () => {
    const calls = [call('docker_list'), call('remote_exec')];
    const out = applyToolResult(calls, 'remote_exec', { ok: true });
    expect(out[0].status).toBe('running');
    expect(out[1].status).toBe('done');
  });

  it('没有匹配的 running 调用时原样返回（不会把已完成的重置）', () => {
    const calls = [call('a', 'done', { v: 1 })];
    const out = applyToolResult(calls, 'a', { v: 2 });
    expect(out).toEqual(calls);
    expect(out[0].result).toEqual({ v: 1 });
  });

  it('空列表不炸', () => {
    expect(applyToolResult([], 'x', {})).toEqual([]);
  });
});

describe('settleToolCalls —— 流结束收尾（用户抱怨的转圈 bug）', () => {
  it('残留的 running 全部标为 aborted（不再转圈）', () => {
    const out = settleToolCalls([call('docker_logs'), call('remote_servers', 'done', {})]);
    expect(out).not.toBeNull();
    expect(out![0].status).toBe('aborted');
    expect(out![1].status).toBe('done');
  });

  it('全部已完成时返回 null（调用方可跳过 setState）', () => {
    expect(settleToolCalls([call('a', 'done', {}), call('b', 'aborted')])).toBeNull();
    expect(settleToolCalls([])).toBeNull();
  });

  it('已完成的结果不被改写', () => {
    const done = call('a', 'done', { error: 'x' });
    const out = settleToolCalls([done, call('b')])!;
    expect(out[0]).toBe(done);
    expect(out[0].result).toEqual({ error: 'x' });
  });
});

describe('toolCallTone —— chip 样式语义', () => {
  it('running / failed / aborted / ok', () => {
    expect(toolCallTone(call('a', 'running'))).toBe('running');
    expect(toolCallTone(call('a', 'done', { error: 'no' }))).toBe('failed');
    expect(toolCallTone(call('a', 'aborted'))).toBe('aborted');
    expect(toolCallTone(call('a', 'done', { ok: 1 }))).toBe('ok');
  });

  it('aborted 优先级高于 error（中断不是失败）', () => {
    expect(toolCallTone(call('a', 'aborted', { error: 'x' }))).toBe('aborted');
  });
});
