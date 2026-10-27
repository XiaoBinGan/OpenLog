import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  normalizeBaseUrl, apiUrl, guessEngine, listModels,
  getCachedToolSupport, setCachedToolSupport, isToolUnsupportedError,
  TOOL_PROTOCOL_PROMPT, renderToolsAsText, parseToolProtocol,
  renderToolResultForTextProtocol, extractDelta, ENGINE_HINTS,
  _resetToolCapabilityCache,
} = await import('../llm-provider.js');

beforeEach(() => _resetToolCapabilityCache());

describe('normalizeBaseUrl —— 各引擎地址归一', () => {
  it('补 /v1，去掉尾部斜杠', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8899')).toBe('http://127.0.0.1:8899/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:8899/')).toBe('http://127.0.0.1:8899/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:8000/v1/')).toBe('http://127.0.0.1:8000/v1');
  });

  it('SGLang 的 /v1 也保持', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:30000/v1')).toBe('http://127.0.0.1:30000/v1');
  });

  it('空值返回空串', () => {
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl(null)).toBe('');
  });

  it('apiUrl 拼路径', () => {
    expect(apiUrl('http://h:8000', 'models')).toBe('http://h:8000/v1/models');
    expect(apiUrl('http://h:8000/v1', '/chat/completions')).toBe('http://h:8000/v1/chat/completions');
  });
});

describe('guessEngine —— 引擎识别（仅影响提示文案）', () => {
  it('Strata(8899) / vLLM / SGLang / Ollama', () => {
    expect(guessEngine('http://127.0.0.1:8899/v1', 'qwen3.8-flash-next-q2_0')).toBe('strata');
    expect(guessEngine('http://127.0.0.1:8000/v1', 'vllm/served-model')).toBe('vllm');
    expect(guessEngine('http://127.0.0.1:30000/v1', 'sglang-model')).toBe('sglang');
    expect(guessEngine('http://localhost:11434/v1', 'qwen2.5:14b')).toBe('ollama');
  });

  it('默认落到 openai 兼容', () => {
    expect(guessEngine('https://api.openai.com/v1', 'gpt-4o-mini')).toBe('openai');
  });

  it('每个引擎都有提示文案（降级时要说清怎么开原生 tools）', () => {
    for (const key of ['vllm', 'sglang', 'strata', 'ollama', 'openai']) {
      expect(ENGINE_HINTS[key]).toBeTruthy();
      expect(ENGINE_HINTS[key].name).toBeTruthy();
    }
  });
});

describe('listModels —— 兼容 /v1/models 与 Ollama /api/tags', () => {
  function fakeFetch(map) {
    return vi.fn(async (url) => {
      for (const [re, res] of map) {
        if (re.test(url)) return { ok: true, json: async () => res };
      }
      return { ok: false, json: async () => ({}) };
    });
  }

  it('vLLM / SGLang / Strata 通过 /v1/models', async () => {
    const f = fakeFetch([[/\/v1\/models$/, { data: [{ id: 'qwen3.8-27b' }, { id: 'other-model' }] }]]);
    const r = await listModels('http://127.0.0.1:8000/v1', 'k', f);
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(['qwen3.8-27b', 'other-model']);
    expect(f.mock.calls[0][0]).toContain('/v1/models');
  });

  it('Ollama 走 /api/tags 兜底', async () => {
    const f = fakeFetch([[/\/api\/tags$/, { models: [{ name: 'qwen2.5:14b' }, { name: 'llama3.1:8b' }] }]]);
    const r = await listModels('http://localhost:11434/v1', '', f);
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(['qwen2.5:14b', 'llama3.1:8b']);
    expect(r.engine).toBe('ollama');
  });

  it('都失败时返回错误但不抛异常', async () => {
    const f = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    const r = await listModels('http://127.0.0.1:9999', '', f);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('网络异常也不抛', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(listModels('http://127.0.0.1:9999', '', f)).resolves.toMatchObject({ ok: false });
  });

  it('未配置 baseUrl 直接报错', async () => {
    expect((await listModels('', '', fakeFetch([]))).ok).toBe(false);
  });
});

describe('tool 能力缓存', () => {
  it('默认未知（null）→ 先试原生', () => {
    expect(getCachedToolSupport('http://h:8000', 'm')).toBeNull();
  });

  it('写入后可读，且按 baseUrl+model 区分', () => {
    setCachedToolSupport('http://h:8000', 'm', false);
    expect(getCachedToolSupport('http://h:8000/', 'm')).toBe(false); // 归一化后命中
    expect(getCachedToolSupport('http://h:8000', 'other')).toBeNull();
  });
});

describe('isToolUnsupportedError —— 识别「引擎不支持 tools」', () => {
  it('典型报错都能识别', () => {
    const cases = [
      { message: 'tools is not supported by this model', status: 400 },
      { message: 'tool_choice: unknown parameter', status: 400 },
      { message: 'Function calling is not enabled', status: 400 },
      { message: 'unsupported tool use', status: 422 },
    ];
    for (const c of cases) expect(isToolUnsupportedError(c), JSON.stringify(c)).toBe(true);
  });

  it('不误判：普通报错（限流/鉴权/上下文超长）', () => {
    expect(isToolUnsupportedError({ message: 'rate limit exceeded', status: 429 })).toBe(false);
    expect(isToolUnsupportedError({ message: 'invalid api key', status: 401 })).toBe(false);
    expect(isToolUnsupportedError({ message: 'context length exceeded', status: 400 })).toBe(false);
    expect(isToolUnsupportedError({ message: 'Service Unavailable', status: 503 })).toBe(false);
  });
});

describe('文本工具协议 —— 不支持原生 tools 时的降级方案', () => {
  it('renderToolsAsText 把工具定义渲染成清单', () => {
    const text = renderToolsAsText([
      { type: 'function', function: { name: 'remote_grep', description: '搜索', parameters: { type: 'object', properties: { serverId: { type: 'string', description: '服务器' }, pattern: { type: 'string' } }, required: ['serverId'] } } },
    ]);
    expect(text).toContain('remote_grep');
    expect(text).toContain('serverId*');
    expect(text).toContain('pattern');
  });

  it('协议提示里明确要求一次一个工具', () => {
    expect(TOOL_PROTOCOL_PROMPT).toContain('TOOL_CALL');
    expect(TOOL_PROTOCOL_PROMPT).toContain('FINAL');
  });

  it('parseToolProtocol 解析 TOOL_CALL 行', () => {
    const r = parseToolProtocol('TOOL_CALL: {"tool":"remote_grep","args":{"serverId":"s1","pattern":"ERROR"}}');
    expect(r).toMatchObject({ kind: 'tool', tool: 'remote_grep' });
    expect(r.args.pattern).toBe('ERROR');
  });

  it('解析 FINAL 回答', () => {
    const r = parseToolProtocol('FINAL: 磁盘没问题，用了 42%。');
    expect(r.kind).toBe('final');
    expect(r.content).toContain('42%');
  });

  it('容忍 ```json 围栏', () => {
    const r = parseToolProtocol('TOOL_CALL: ```json\n{"tool":"remote_ls","args":{"serverId":"s1"}}\n```');
    expect(r.kind).toBe('tool');
    expect(r.tool).toBe('remote_ls');
  });

  it('普通文本按 text 返回（不丢内容）', () => {
    const r = parseToolProtocol('这台机器负载很低。');
    expect(r.kind).toBe('text');
    expect(r.content).toContain('负载');
  });

  it('非法 JSON 不抛异常', () => {
    expect(() => parseToolProtocol('TOOL_CALL: {oops')).not.toThrow();
  });

  it('空输入', () => {
    expect(parseToolProtocol('').kind).toBe('text');
    expect(parseToolProtocol(null).kind).toBe('text');
  });

  it('工具结果回灌文本带截断', () => {
    const big = { content: 'x'.repeat(20000) };
    const text = renderToolResultForTextProtocol('remote_read_file', big);
    expect(text).toContain('TOOL_RESULT: remote_read_file');
    expect(text.length).toBeLessThan(9000);
    expect(text).toContain('已截断');
  });
});

describe('extractDelta —— 兼容各引擎的 reasoning 字段', () => {
  it('标准 content', () => {
    expect(extractDelta({ content: 'hi' })).toEqual({ content: 'hi', reasoning: '' });
  });

  it('Strata/vLLM 的 reasoning_content', () => {
    expect(extractDelta({ reasoning_content: '想想' })).toEqual({ content: '', reasoning: '想想' });
  });

  it('SGLang 部分版本的 reasoning', () => {
    expect(extractDelta({ reasoning: '思考' })).toEqual({ content: '', reasoning: '思考' });
  });

  it('同时有正文和思维', () => {
    expect(extractDelta({ content: '答案', reasoning_content: '推理' })).toEqual({ content: '答案', reasoning: '推理' });
  });

  it('空 delta 不炸', () => {
    expect(extractDelta(null)).toEqual({ content: '', reasoning: '' });
    expect(extractDelta({})).toEqual({ content: '', reasoning: '' });
  });
});