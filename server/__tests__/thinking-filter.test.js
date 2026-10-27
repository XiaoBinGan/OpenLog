import { describe, it, expect, vi } from 'vitest';

const kv = vi.hoisted(() => ({ store: new Map() }));
vi.mock('../db/index.js', () => ({
  getKv: (k) => kv.store.get(k),
  setKv: (k, v) => { kv.store.set(k, JSON.parse(JSON.stringify(v))); },
}));

const mod = await import('../routes/chat.js');
const { ThinkingStreamFilter } = mod;

/** 造一个过滤器；thinkingEnabled=false 时才会过滤 */
function makeFilter(thinkingEnabled = false) {
  return new ThinkingStreamFilter(() => ({ thinkingEnabled }));
}

/** 按 chunk 逐段喂，收集输出 */
function feedChunks(filter, chunks) {
  let out = '';
  for (const c of chunks) out += filter.feed(c);
  out += filter.flush();
  return out;
}

describe('ThinkingStreamFilter —— 不能吞掉正常回复', () => {
  it('模型不输出 think 标记时，正文必须完整透传（真实 bug：67 字回答变成 0 字）', () => {
    const answer = '这是第一行结论。\n这是第二行说明，比较长比较长比较长比较长比较长。\n第三行收尾。';
    expect(feedChunks(makeFilter(), [answer])).toBe(answer);
  });

  it('逐字流式也要完整（真实 SSE 是碎 chunk）', () => {
    const answer = 'Docker 容器是一种轻量级隔离运行环境。';
    expect(feedChunks(makeFilter(), [...answer])).toBe(answer);
  });

  it('thinkingEnabled=true 时原样透传（含 think 标记）', () => {
    const text = '<think>推理中</think>最终答案';
    expect(feedChunks(makeFilter(true), [text])).toBe(text);
  });
});

describe('ThinkingStreamFilter —— 过滤思维块', () => {
  it('剔除 <think> 块，只留正文', () => {
    const out = feedChunks(makeFilter(), ['<think>内部推理\n第二行</think>这是答案']);
    expect(out).toBe('这是答案');
  });

  it('思维块跨 chunk 切分也能识别（<thi + nk>）', () => {
    const out = feedChunks(makeFilter(), ['<thi', 'nk>推理</thi', 'nk>答案']);
    expect(out).toBe('答案');
  });

  it('思维块未闭合时全部丢弃（不把推理当答案展示）', () => {
    const out = feedChunks(makeFilter(), ['<think>还在想 ', '继续想']);
    expect(out).toBe('');
  });

  it('正文 + 思维块 + 正文混合', () => {
    const out = feedChunks(makeFilter(), ['开头。', '<think>想</think>', '结尾。']);
    expect(out).toBe('开头。结尾。');
  });

  it('多个思维块都被剔除', () => {
    const out = feedChunks(makeFilter(), ['<think>a</think>正文1<think>b</think>正文2']);
    expect(out).toBe('正文1正文2');
  });

  it('支持 &lt;think&gt; 实体形式', () => {
    const out = feedChunks(makeFilter(), ['&lt;think&gt;推理&lt;/think&gt;答案']);
    expect(out).toBe('答案');
  });

  it("支持 \"Here's a thinking\" 前缀形式", () => {
    const out = feedChunks(makeFilter(), ["Here's a thinking process...</think>答案"]);
    expect(out).toBe('答案');
  });

  it('正文里出现 <think 字样但没闭合标签，按正文处理（不吞）', () => {
    const out = feedChunks(makeFilter(), ['用 <think 标签可以标记思考过程']);
    expect(out).toContain('用');
    expect(out.length).toBeGreaterThan(0);
  });

  it('缓冲不会无限增长（大量正文逐块喂入不丢内容）', () => {
    const filter = makeFilter();
    const chunks = Array.from({ length: 500 }, (_, i) => `第${i}段内容。`);
    const out = feedChunks(filter, chunks);
    expect(out).toBe(chunks.join(''));
    expect(filter.buffer.length).toBeLessThanOrEqual(16); // 只留可能的标记前缀
  });
});

describe('确认闸门辅助', () => {
  it('_clearPendingApprovals 可清空挂起确认（测试可重复运行）', () => {
    expect(typeof mod._clearPendingApprovals).toBe('function');
    expect(() => mod._clearPendingApprovals()).not.toThrow();
  });
});
