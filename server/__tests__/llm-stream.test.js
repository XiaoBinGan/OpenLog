/**
 * server/__tests__/llm-stream.test.js
 *
 * 修 2026-11-06「AI 智能诊断点下去十几秒空白」：本机 Qwen 类模型先输出
 * reasoning_content 思考很久，正文才来，而路由只转发 content → 面板长时间空白。
 *
 * 这里测三件事：
 *   1. buildThinkingParams 生成关闭思考的参数
 *   2. 引擎不认这个参数时自动降级重试（不能因为优化把功能搞挂）
 *   3. 流式转发的事件序列：思考期发心跳、正文一到先清心跳再发正文
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildThinkingParams, isUnsupportedParamError, readChunk,
  createChatStream, pipeChatStreamToSSE,
} from '../llm-stream.js';

function fakeRes() {
  const chunks = [];
  return {
    chunks,
    write: (s) => { chunks.push(String(s)); return true; },
    end: () => { chunks.push('[END]'); },
    get text() { return chunks.filter(c => c !== '[END]').join(''); },
    get events() {
      return chunks
        .filter(c => c.startsWith('data: '))
        .map(c => c.slice(6).trim())
        .filter(c => c !== '[DONE]')
        .map(c => { try { return JSON.parse(c); } catch { return { raw: c }; } });
    },
  };
}

async function* streamOf(deltas) {
  for (const d of deltas) {
    await Promise.resolve();
    yield { choices: [{ delta: d }] };
  }
}

describe('buildThinkingParams —— 关闭思考的请求参数', () => {
  it('thinkingEnabled=true 时不加任何参数（保留思考）', () => {
    expect(buildThinkingParams(true)).toEqual({});
  });
  it('关闭时给出通用写法（Qwen3 / vLLM / SGLang）', () => {
    const p = buildThinkingParams(false);
    expect(p.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(p.reasoning_effort).toBe('none');
  });
  it('不传参默认关闭（诊断场景要快）', () => {
    expect(buildThinkingParams()).toEqual(buildThinkingParams(false));
  });
});

describe('isUnsupportedParamError —— 只有「参数不认识」才降级', () => {
  it('识别常见的不支持参数报错', () => {
    expect(isUnsupportedParamError(new Error('400 Unsupported parameter: reasoning_effort'))).toBe(true);
    expect(isUnsupportedParamError(new Error('unknown field chat_template_kwargs'))).toBe(true);
    expect(isUnsupportedParamError(new Error('invalid request argument'))).toBe(true);
  });
  it('认证/网络错误不当作参数问题（不能盲目重试）', () => {
    expect(isUnsupportedParamError(new Error('401 Unauthorized'))).toBe(false);
    expect(isUnsupportedParamError(new Error('ETIMEDOUT'))).toBe(false);
    expect(isUnsupportedParamError(null)).toBe(false);
  });
});

describe('readChunk —— 兼容各家 reasoning 字段', () => {
  it('OpenAI 风格 content', () => {
    expect(readChunk({ choices: [{ delta: { content: 'abc' } }] })).toEqual({ content: 'abc', reasoning: '' });
  });
  it('reasoning_content / reasoning 都识别', () => {
    expect(readChunk({ choices: [{ delta: { reasoning_content: 'R1' } }] }).reasoning).toBe('R1');
    expect(readChunk({ choices: [{ delta: { reasoning: 'R2' } }] }).reasoning).toBe('R2');
  });
  it('空 chunk / 坏结构不崩', () => {
    expect(readChunk({})).toEqual({ content: '', reasoning: '' });
    expect(readChunk(null)).toEqual({ content: '', reasoning: '' });
  });
});

describe('createChatStream —— 不支持思考参数时自动降级', () => {
  it('正常情况只请求一次，且带上关闭思考的参数', async () => {
    const create = vi.fn().mockResolvedValue('STREAM');
    const out = await createChatStream({
      openai: { chat: { completions: { create } } },
      model: 'm', prompt: 'p', thinkingEnabled: false,
    });
    expect(out).toBe('STREAM');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(create.mock.calls[0][0].stream).toBe(true);
  });

  it('引擎报「不支持的参数」→ 去掉参数重试一次并成功', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('400 Unsupported parameter: reasoning_effort'))
      .mockResolvedValueOnce('STREAM');
    const out = await createChatStream({
      openai: { chat: { completions: { create } } },
      model: 'm', prompt: 'p', thinkingEnabled: false,
    });
    expect(out).toBe('STREAM');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].reasoning_effort).toBeUndefined();
    expect(create.mock.calls[1][0].chat_template_kwargs).toBeUndefined();
  });

  it('认证错误直接抛出，不做无意义重试', async () => {
    const create = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
    await expect(createChatStream({
      openai: { chat: { completions: { create } } },
      model: 'm', prompt: 'p',
    })).rejects.toThrow('401');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('thinkingEnabled=true 时一次请求且不带关闭参数', async () => {
    const create = vi.fn().mockResolvedValue('S');
    await createChatStream({
      openai: { chat: { completions: { create } } },
      model: 'm', prompt: 'p', thinkingEnabled: true,
    });
    expect(create.mock.calls[0][0].chat_template_kwargs).toBeUndefined();
  });
});

describe('pipeChatStreamToSSE —— 思考期也要有反馈', () => {
  it('正文增量按 {content} 转发，结束时写 [DONE]', async () => {
    const res = fakeRes();
    const full = await pipeChatStreamToSSE({
      res, stream: streamOf([{ content: '你好' }, { content: '世界' }]),
    });
    expect(full).toBe('你好世界');
    expect(res.events.filter(e => e.content).map(e => e.content)).toEqual(['你好', '世界']);
    expect(res.chunks[res.chunks.length - 2]).toContain('[DONE]');
    expect(res.chunks[res.chunks.length - 1]).toBe('[END]');
  });

  it('思考期发心跳（status），正文一来就清掉 status', async () => {
    const res = fakeRes();
    // 心跳间隔压到 0，保证必发
    await pipeChatStreamToSSE({
      res,
      heartbeatMs: 0,
      stream: streamOf([
        { reasoning_content: '先想想' },
        { reasoning_content: '再想想' },
        { content: '结论' },
      ]),
    });
    const evts = res.events;
    const statuses = evts.filter(e => e.status !== undefined).map(e => e.status);
    expect(statuses.some(s => String(s).includes('思考中'))).toBe(true);
    // 正文之前有一个空 status 清场
    expect(statuses[statuses.length - 1]).toBe('');
    // 顺序：思考心跳 → 空 status → 正文
    const idxFirstContent = evts.findIndex(e => e.content);
    const idxClear = evts.findIndex(e => e.status === '');
    expect(idxClear).toBeLessThan(idxFirstContent);
  });

  it('只思考不正文时不会崩，返回空正文', async () => {
    const res = fakeRes();
    const full = await pipeChatStreamToSSE({
      res, heartbeatMs: 0, stream: streamOf([{ reasoning_content: 'R' }, { reasoning_content: 'R2' }]),
    });
    expect(full).toBe('');
    expect(res.chunks).toContain('[END]');
  });

  it('onContent 回调累计（调用方存分析历史用）', async () => {
    const res = fakeRes();
    const seen = [];
    await pipeChatStreamToSSE({ res, stream: streamOf([{ content: 'A' }, { content: 'B' }]), onContent: c => seen.push(c) });
    expect(seen).toEqual(['A', 'B']);
  });
});
