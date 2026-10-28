import { describe, it, expect } from 'vitest';
import { createSSELineSplitter, parseSSEDataLine } from './sseLines';

/** 模拟网络把一个 SSE 流切成任意大小的 chunk */
function chunksOf(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** 把 chunk 序列喂进 splitter，返回按行拆好的结果 */
function collect(chunks: string[]): string[] {
  const splitter = createSSELineSplitter();
  const lines: string[] = [];
  for (const c of chunks) lines.push(...splitter.push(c));
  lines.push(...splitter.flush());
  return lines;
}

describe('createSSELineSplitter —— 跨 chunk 不能丢事件（真实 bug）', () => {
  const stream = [
    'data: {"type":"tool_start","tool":"docker_logs","args":{}}',
    '',
    'data: {"type":"tool_result","tool":"docker_logs","result":{"content":"很长的日志内容…"}}',
    '',
    'data: {"content":"结论"}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  it('整段一次喂入', () => {
    const lines = collect([stream]).filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('tool_result');
  });

  it('任意切分都不能丢行（这是原来丢 tool_result 的根因）', () => {
    for (const size of [1, 2, 3, 7, 13, 64]) {
      const lines = collect(chunksOf(stream, size)).filter(Boolean);
      expect(lines, `chunkSize=${size}`).toHaveLength(4);
      expect(lines[1], `chunkSize=${size}`).toContain('tool_result');
      expect(lines[3], `chunkSize=${size}`).toBe('data: [DONE]');
    }
  });

  it('JSON 只有在行完整后才能解析（半行解析必失败，所以要等）', () => {
    const splitter = createSSELineSplitter();
    const full = 'data: {"type":"tool_result","tool":"docker_ls"}\n';
    const half = Math.floor(full.length / 2);
    // 前半段：拿不到完整行
    expect(splitter.push(full.slice(0, half))).toEqual([]);
    // 后半段：拼出完整行
    const lines = splitter.push(full.slice(half));
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(parseSSEDataLine(lines[0]) as string)).not.toThrow();
  });

  it('flush 返回结尾没有换行的残行', () => {
    const splitter = createSSELineSplitter();
    splitter.push('data: {"content":"最后一句话"}');
    expect(splitter.peek()).toContain('最后一句话');
    const rest = splitter.flush();
    expect(rest).toHaveLength(1);
    expect(rest[0]).toContain('最后一句话');
    expect(splitter.peek()).toBe('');
  });

  it('空 chunk 与空流不炸', () => {
    const splitter = createSSELineSplitter();
    expect(splitter.push('')).toEqual([]);
    expect(splitter.flush()).toEqual([]);
  });

  it('CRLF 也能处理（代理/网关可能改写换行）', () => {
    const splitter = createSSELineSplitter();
    const lines = splitter.push('data: {"a":1}\r\ndata: {"b":2}\r\n');
    expect(lines).toHaveLength(2);
    expect(parseSSEDataLine(lines[0])).toBe('{"a":1}');
  });
});

describe('parseSSEDataLine', () => {
  it('取 data 后的 payload', () => {
    expect(parseSSEDataLine('data: {"x":1}')).toBe('{"x":1}');
    expect(parseSSEDataLine('data:{"x":1}')).toBe('{"x":1}');
  });

  it('非 data 行返回 null（注释/keep-alive）', () => {
    expect(parseSSEDataLine(': keep-alive')).toBeNull();
    expect(parseSSEDataLine('')).toBeNull();
    expect(parseSSEDataLine('event: ping')).toBeNull();
  });
});
