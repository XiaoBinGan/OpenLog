/**
 * 图片附件工具的单测。
 *
 * 只测纯函数部分（校验 / 尺寸计算 / content 组装 / 文本提取）；
 * canvas 编码（encodeImageFile）依赖真实浏览器 API，用 CDP 真机验收覆盖。
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_IMAGES,
  MAX_SOURCE_BYTES,
  ACCEPTED_MIME,
  validateImageFile,
  pickAcceptedFiles,
  fitWithin,
  toImagePart,
  buildUserContent,
  contentText,
  formatBytes,
} from './imageAttach';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';

describe('validateImageFile', () => {
  it('接受常见图片格式', () => {
    for (const type of ACCEPTED_MIME) {
      expect(validateImageFile({ type, size: 1024, name: 'a' }).ok).toBe(true);
    }
  });

  it('拒绝非图片（含 SVG —— 可带脚本，不能当图片传）', () => {
    expect(validateImageFile({ type: 'application/pdf', size: 1024 }).ok).toBe(false);
    expect(validateImageFile({ type: 'image/svg+xml', size: 1024 }).ok).toBe(false);
    expect(validateImageFile({ type: '', size: 1024 }).ok).toBe(false);
  });

  it('空文件被拒（0 字节多半是读取失败）', () => {
    expect(validateImageFile({ type: 'image/png', size: 0 }).ok).toBe(false);
  });

  it('超过单张上限被拒，错误里带可读体积', () => {
    const r = validateImageFile({ type: 'image/png', size: MAX_SOURCE_BYTES + 1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('MB');
  });

  it('已达数量上限时继续拒', () => {
    const r = validateImageFile({ type: 'image/png', size: 1024 }, { count: MAX_IMAGES });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain(String(MAX_IMAGES));
  });

  it('恰好等于上限应当放行（边界不能写成 > 与 >= 混用）', () => {
    expect(validateImageFile({ type: 'image/png', size: MAX_SOURCE_BYTES }).ok).toBe(true);
  });
});

describe('pickAcceptedFiles', () => {
  it('一次选多张：合格的留下，不合格的带原因', () => {
    const { accepted, rejected } = pickAcceptedFiles([
      { type: 'image/png', size: 100, name: 'ok1.png' },
      { type: 'text/plain', size: 100, name: 'bad.txt' },
      { type: 'image/jpeg', size: 100, name: 'ok2.jpg' },
    ]);
    expect(accepted.map((f) => f.name)).toEqual(['ok1.png', 'ok2.jpg']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].name).toBe('bad.txt');
    expect(rejected[0].error).toBeTruthy();
  });

  it('已有附件时按剩余额度接收，多的明确拒绝（不能静默丢弃）', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ type: 'image/png', size: 100, name: `f${i}.png` }));
    const { accepted, rejected } = pickAcceptedFiles(files, { count: MAX_IMAGES - 2 });
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(3);
  });
});

describe('fitWithin', () => {
  it('大图按长边等比缩放', () => {
    expect(fitWithin({ width: 4000, height: 3000 }, 1568)).toEqual({ width: 1568, height: 1176 });
    expect(fitWithin({ width: 3000, height: 4000 }, 1568)).toEqual({ width: 1176, height: 1568 });
  });

  it('小图不放大（放大只是浪费字节）', () => {
    expect(fitWithin({ width: 800, height: 600 }, 1568)).toEqual({ width: 800, height: 600 });
  });

  it('极端长图不会算出 0 宽高（否则 canvas 直接抛错）', () => {
    const r = fitWithin({ width: 10000, height: 1 }, 1568);
    expect(r.width).toBe(1568);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });

  it('非法尺寸兜底成 1x1，不返回 NaN', () => {
    const r = fitWithin({ width: 0, height: 0 }, 1568);
    expect(Number.isFinite(r.width)).toBe(true);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });
});

describe('toImagePart', () => {
  it('data URL 转成 OpenAI vision part', () => {
    expect(toImagePart(PNG)).toEqual({ type: 'image_url', image_url: { url: PNG } });
  });

  it('非 data URL 一律拒绝（远程 URL 会让服务端去取内网地址）', () => {
    expect(toImagePart('https://example.com/a.png')).toBe(null);
    expect(toImagePart('file:///etc/passwd')).toBe(null);
    expect(toImagePart('')).toBe(null);
  });
});

describe('buildUserContent', () => {
  it('没有图片 → 返回字符串（保持旧协议）', () => {
    expect(buildUserContent('你好', [])).toBe('你好');
  });

  it('有图片 → parts 数组，文本在前图片在后', () => {
    const content = buildUserContent('看看这个', [{ dataUrl: PNG }, { dataUrl: JPG }]);
    expect(Array.isArray(content)).toBe(true);
    const parts = content as any[];
    expect(parts[0]).toEqual({ type: 'text', text: '看看这个' });
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });

  it('只发图片不带文字时补一句提示（否则模型不知道该干什么）', () => {
    const parts = buildUserContent('   ', [{ dataUrl: PNG }]) as any[];
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('图片');
  });

  it('接受裸 dataUrl 字符串形式的图片', () => {
    const parts = buildUserContent('x', [PNG]) as any[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1);
  });

  it('非法图片被静默剔除，不影响文本发出', () => {
    const parts = buildUserContent('x', [{ dataUrl: 'https://evil/a.png' }, { dataUrl: PNG }]) as any[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1);
  });
});

describe('contentText', () => {
  it('字符串原样返回', () => {
    expect(contentText('abc')).toBe('abc');
  });

  it('从 parts 里拼文本，图片位置留标记', () => {
    expect(contentText([{ type: 'text', text: 'A' }, { type: 'image_url', image_url: { url: PNG } }, { type: 'text', text: 'B' }]))
      .toBe('A\n[图片]\nB');
  });

  it('不产生 [object Object]（这是 String(content) 的经典坑）', () => {
    expect(contentText([{ type: 'image_url', image_url: { url: PNG } }])).not.toContain('object');
  });

  it('非字符串非数组返回空串', () => {
    expect(contentText(null)).toBe('');
    expect(contentText(undefined)).toBe('');
    expect(contentText({ foo: 1 })).toBe('');
  });
});

describe('formatBytes', () => {
  it('按大小选单位', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(2048)).toBe('2KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0MB');
  });
});
