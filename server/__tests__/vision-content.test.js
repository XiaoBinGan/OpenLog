/**
 * server/vision-content.js —— 多模态消息处理
 *
 * 这层最怕的是「悄悄算错 token」：图片 base64 一旦被当文本估算，
 * 一张 300KB 的图 ≈ 8.5 万 token，预算当场爆掉，历史会被整段丢弃，
 * 用户看到的就是「助手突然忘了一切」。所以重点测 token 与上限。
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_DATA_URL_CHARS,
  IMAGE_TOKEN_ESTIMATE,
  isImagePart,
  contentText,
  countImages,
  contentTokens,
  dataUrlMime,
  stripImagesFromContent,
  normalizeContent,
  normalizeMessages,
} from '../vision-content.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const img = (url = PNG) => ({ type: 'image_url', image_url: { url } });
const txt = (text) => ({ type: 'text', text });

describe('isImagePart / countImages', () => {
  it('识别 image_url part', () => {
    expect(isImagePart(img())).toBe(true);
    expect(isImagePart(txt('x'))).toBe(false);
    expect(isImagePart(null)).toBe(false);
    expect(isImagePart('image_url')).toBe(false);
  });

  it('数出图片数量，字符串content算0张', () => {
    expect(countImages([txt('a'), img(), img()])).toBe(2);
    expect(countImages('纯文本')).toBe(0);
    expect(countImages(null)).toBe(0);
  });
});

describe('contentText', () => {
  it('字符串原样返回', () => {
    expect(contentText('hello')).toBe('hello');
  });

  it('parts 里拼文本，图片留标记', () => {
    expect(contentText([txt('看这个'), img(), txt('明白吗')])).toBe('看这个\n[图片]\n明白吗');
  });

  it('绝不产生 [object Object]（这是 String(content) 的经典坑）', () => {
    const out = contentText([img()]);
    expect(out).not.toContain('object');
    expect(out).toBe('[图片]');
  });

  it('非字符串非数组返回空串，不抛', () => {
    expect(contentText(null)).toBe('');
    expect(contentText(undefined)).toBe('');
    expect(contentText({ a: 1 })).toBe('');
    expect(contentText(42)).toBe('');
  });
});

describe('contentTokens —— 图片必须按固定值算', () => {
  const est = (t) => Math.ceil(String(t || '').length / 3.5);

  it('一张图 = 文本 token + IMAGE_TOKEN_ESTIMATE', () => {
    const t = contentTokens([txt('abc'), img()], est);
    expect(t).toBe(est('abc') + IMAGE_TOKEN_ESTIMATE);
  });

  it('两张图线性叠加', () => {
    expect(contentTokens([img(), img()], est)).toBe(IMAGE_TOKEN_ESTIMATE * 2);
  });

  it('**不能**把 base64 当文本算（回归：一张大图不能顶得上十万 token）', () => {
    // 造一个 300KB 的 base64：如果代码走 JSON.stringify，会算出 ~8.5 万 token
    const big = `data:image/png;base64,${'A'.repeat(300_000)}`;
    const t = contentTokens([img(big)], est);
    expect(t).toBe(IMAGE_TOKEN_ESTIMATE);
    expect(t).toBeLessThan(2000);
  });

  it('不传估算函数也能工作（有默认兜底）', () => {
    expect(contentTokens([img()])).toBe(IMAGE_TOKEN_ESTIMATE);
  });

  it('纯文本 content 与直接估算一致', () => {
    expect(contentTokens('你好世界', est)).toBe(est('你好世界'));
  });
});

describe('dataUrlMime', () => {
  it('取出 MIME', () => {
    expect(dataUrlMime(PNG)).toBe('image/png');
    expect(dataUrlMime(JPG)).toBe('image/jpeg');
  });

  it('非法输入返回空串', () => {
    expect(dataUrlMime('https://x/a.png')).toBe('');
    expect(dataUrlMime('')).toBe('');
    expect(dataUrlMime(null)).toBe('');
  });
});

describe('normalizeContent —— 只收 data URL + 白名单 MIME', () => {
  it('字符串原样通过', () => {
    expect(normalizeContent('你好')).toEqual({ ok: true, content: '你好' });
  });

  it('null/undefined 归一成空串', () => {
    expect(normalizeContent(null)).toEqual({ ok: true, content: '' });
  });

  it('**拒绝远程 URL**（否则服务端会去取内网地址 = SSRF）', () => {
    const r = normalizeContent([txt('x'), img('http://169.254.169.254/latest/meta-data/')]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('data URL');
  });

  it('拒绝 SVG（可携带脚本，不能当图片传）', () => {
    const r = normalizeContent([img('data:image/svg+xml;base64,PHN2Zz4=')]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('不支持');
  });

  it('接受 PNG/JPEG/WebP/GIF', () => {
    for (const m of ['png', 'jpeg', 'webp', 'gif']) {
      const r = normalizeContent([img(`data:image/${m};base64,AAAA`)]);
      expect(r.ok, m).toBe(true);
    }
  });

  it('超过单张体积上限被拒，错误里有可读大小', () => {
    const huge = `data:image/png;base64,${'A'.repeat(MAX_IMAGE_DATA_URL_CHARS + 10)}`;
    const r = normalizeContent([img(huge)]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('KB');
  });

  it('超过张数上限被拒', () => {
    const parts = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => img());
    const r = normalizeContent(parts);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain(String(MAX_IMAGES_PER_MESSAGE));
  });

  it('恰好等于张数上限应当通过（边界）', () => {
    const parts = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, () => img());
    expect(normalizeContent(parts).ok).toBe(true);
  });

  it('没有图片时退回字符串（下游不必处理两种形态）', () => {
    const r = normalizeContent([txt('a'), txt('b')]);
    expect(r.ok).toBe(true);
    expect(r.ok === true && typeof r.content).toBe('string');
  });

  it('纯图片自动补一句提示（否则模型不知道该干什么）', () => {
    const r = normalizeContent([img()]);
    expect(r.ok).toBe(true);
    const parts = r.content;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('图片');
  });

  it('拒绝未知 part 类型（避免引擎报难懂的 400）', () => {
    const r = normalizeContent([{ type: 'audio_url', audio_url: {} }]);
    expect(r.ok).toBe(false);
  });

  it('非数组非字符串直接拒', () => {
    expect(normalizeContent({ content: 'x' }).ok).toBe(false);
  });
});

describe('normalizeMessages —— 历史图片要剥掉', () => {
  it('只保留最后一条 user 的图片，更早的剥成文字', () => {
    const messages = [
      { role: 'user', content: [txt('第一轮'), img()] },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: [txt('第二轮'), img(JPG)] },
    ];
    const r = normalizeMessages(messages);
    expect(r.ok).toBe(true);
    const out = r.messages;
    // 第一轮图片被剥
    expect(typeof out[0].content).toBe('string');
    expect(out[0].content).toContain('第一轮');
    // 最后一轮保留 parts（含 image_url）
    expect(Array.isArray(out[2].content)).toBe(true);
    expect(out[2].content.some((p) => p.type === 'image_url')).toBe(true);
  });

  it('keepImagesInLastUser=false 时全部剥成文字（用于存储/不重发场景）', () => {
    const r = normalizeMessages(
      [{ role: 'user', content: [txt('x'), img()] }],
      { keepImagesInLastUser: false },
    );
    expect(r.ok).toBe(true);
    expect(typeof r.messages[0].content).toBe('string');
  });

  it('历史里的非法图片退化成文字，不整单 400', () => {
    const messages = [
      { role: 'user', content: [txt('老消息'), img('https://evil/x.png')] },
      { role: 'user', content: [txt('新消息'), img()] },
    ];
    const r = normalizeMessages(messages);
    expect(r.ok).toBe(true);
    expect(typeof r.messages[0].content).toBe('string');
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('**最后一条 user 的图片非法 → 整单拒绝**（不能悄悄把图丢了还当成功）', () => {
    const r = normalizeMessages([
      { role: 'user', content: [txt('看我这张图'), img('https://evil/x.png')] },
    ]);
    expect(r.ok).toBe(false);
  });

  it('非数组直接拒', () => {
    expect(normalizeMessages(null).ok).toBe(false);
    expect(normalizeMessages('x').ok).toBe(false);
  });

  it('null 元素被跳过，不抛', () => {
    const r = normalizeMessages([null, { role: 'user', content: 'x' }, undefined]);
    expect(r.ok).toBe(true);
    expect(r.messages).toHaveLength(1);
  });
});

describe('stripImagesFromContent', () => {
  it('返回纯文本', () => {
    expect(stripImagesFromContent([txt('a'), img()])).toBe('a\n[图片]');
  });

  it('字符串原样', () => {
    expect(stripImagesFromContent('abc')).toBe('abc');
  });
});

describe('回归：图片让 token 估算不再爆表', () => {
  it('6 张大图的消息，token 估算仍是可控范围（而不是几十万）', () => {
    const est = (t) => Math.ceil(String(t || '').length / 3.5);
    const big = `data:image/png;base64,${'A'.repeat(500_000)}`;
    const parts = [txt('看图'), ...Array.from({ length: 6 }, () => img(big))];
    const t = contentTokens(parts, est);
    expect(t).toBeLessThan(10_000);
    expect(t).toBe(est('看图') + 6 * IMAGE_TOKEN_ESTIMATE);
  });

  it('contentText 的长度不含 base64（压缩与摘要依赖这个前提）', () => {
    const big = `data:image/png;base64,${'A'.repeat(500_000)}`;
    const text = contentText([txt('看'), img(big)]);
    expect(text.length).toBeLessThan(20);
  });
});
