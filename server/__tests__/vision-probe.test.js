/**
 * server/vision-probe.js —— 「这个模型能不能看图」的探测
 *
 * 为什么必须探测而不是猜：Ollama 上多数纯文本模型收到 image_url **不报错，
 * 直接静默忽略**。图片被丢弃，模型对着空图硬答，用户以为是「AI 看歪了」。
 * 所以真发一张洋红小图问颜色，答对才算 yes。
 *
 * 三态结论，绝不把「不知道」说成「支持」：
 *   yes / no / unknown（超时、限流、答非所问）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import zlib from 'node:zlib';
import {
  makeSolidPng,
  probeImageDataUrl,
  looksLikeMagenta,
  isImageUnsupportedError,
  probeVisionSupport,
  getCachedVisionSupport,
  setCachedVisionSupport,
  probeVisionSupportCached,
  _resetVisionCache,
  VISION_PROBE_TTL_MS,
} from '../vision-probe.js';

beforeEach(() => _resetVisionCache());

/** 造一个可解析的假响应 */
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const chatReply = (content) => res(200, { choices: [{ message: { content } }] });

describe('makeSolidPng —— 生成的 PNG 必须真的合法', () => {
  it('签名 + IHDR 尺寸正确', () => {
    const png = makeSolidPng(16, 16, [255, 0, 255]);
    expect(png.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // IHDR 数据紧跟 8 字节签名 + 4 字节长度 + 4 字节类型
    expect(png.readUInt32BE(16)).toBe(16); // width
    expect(png.readUInt32BE(20)).toBe(16); // height
    expect(png[24]).toBe(8);  // bit depth
    expect(png[25]).toBe(2);  // truecolor
  });

  it('IDAT 解压后是「每行 1 字节 filter + w*3 像素」', () => {
    const png = makeSolidPng(4, 3, [255, 0, 255]);
    // 从 IEND 前的 IDAT 块里取数据：简化做法——直接解压所有 IDAT
    // 块结构：len(4) type(4) data(len) crc(4)
    let off = 8;
    const idat = [];
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.slice(off + 4, off + 8).toString('ascii');
      if (type === 'IDAT') idat.push(png.slice(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    expect(raw.length).toBe(3 * (1 + 4 * 3));
    // 第一行：filter=0，然后 4 个 (255,0,255)
    expect(raw[0]).toBe(0);
    expect([raw[1], raw[2], raw[3]]).toEqual([255, 0, 255]);
  });

  it('最小尺寸 1x1 也能生成（不会因为算错长度崩）', () => {
    const png = makeSolidPng(1, 1, [255, 0, 255]);
    expect(png.length).toBeGreaterThan(50);
  });

  it('非法尺寸兜底成 1，不产生 NaN 长度', () => {
    const png = makeSolidPng(0, -5, [0, 0, 0]);
    expect(png.length).toBeGreaterThan(50);
  });
});

describe('probeImageDataUrl', () => {
  it('是可用的 data URL，且体积很小（探测不该烧带宽）', () => {
    const url = probeImageDataUrl();
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(url.length).toBeLessThan(2000);
  });
});

describe('looksLikeMagenta —— 判定模型是否真的看到了洋红', () => {
  it('认中英文洋红', () => {
    for (const t of ['magenta', 'Magenta', '洋红', '品红', '紫红', 'fuchsia', '这是一个品红色的方块']) {
      expect(looksLikeMagenta(t), t).toBe(true);
    }
  });

  it('红/蓝/绿不算（这些是模型不看图也能蒙的高频猜测色）', () => {
    for (const t of ['red', '红色', 'blue', 'green', 'a red square']) {
      expect(looksLikeMagenta(t), t).toBe(false);
    }
  });

  it('空回复不算', () => {
    expect(looksLikeMagenta('')).toBe(false);
    expect(looksLikeMagenta(null)).toBe(false);
    expect(looksLikeMagenta(undefined)).toBe(false);
  });
});

describe('isImageUnsupportedError —— 认出「不支持图片」', () => {
  it('认出各家常见措辞', () => {
    const msgs = [
      'image_url is not supported',
      'this model does not support image input',
      'multimodal input not supported',
      'vision is not enabled for this model',
      'invalid content type: image_url',
      'unsupported content type',
    ];
    for (const m of msgs) expect(isImageUnsupportedError({ message: m, status: 400 }), m).toBe(true);
  });

  it('5xx 不算「不支持」（那是服务端故障）', () => {
    expect(isImageUnsupportedError({ message: 'image_url is not supported', status: 500 })).toBe(false);
    expect(isImageUnsupportedError({ message: 'image input error', status: 503 })).toBe(false);
  });

  it('普通错误不算', () => {
    expect(isImageUnsupportedError({ message: 'context length exceeded', status: 400 })).toBe(false);
    expect(isImageUnsupportedError(null)).toBe(false);
  });
});

describe('probeVisionSupport —— 三态结论', () => {
  const base = { baseUrl: 'http://localhost:11434/v1', apiKey: 'k', model: 'qwen-vl' };

  it('模型答对洋红 → yes', async () => {
    const fetchImpl = vi.fn(async () => chatReply('洋红色'));
    const r = await probeVisionSupport({ ...base, fetchImpl });
    expect(r.supported).toBe('yes');
    expect(r.reason).toContain('识别');
  });

  it('引擎 400 明确拒绝图片 → no', async () => {
    const fetchImpl = vi.fn(async () => res(400, { error: { message: 'image_url is not supported' } }));
    const r = await probeVisionSupport({ ...base, fetchImpl });
    expect(r.supported).toBe('no');
  });

  it('**200 但答错颜色 → unknown**（这是静默忽略图片的典型表现，不能判成 no 也不能判成 yes）', async () => {
    const fetchImpl = vi.fn(async () => chatReply('red'));
    const r = await probeVisionSupport({ ...base, fetchImpl });
    expect(r.supported).toBe('unknown');
    expect(r.reason).toContain('忽略');
  });

  it('200 但空回复 → unknown', async () => {
    const fetchImpl = vi.fn(async () => chatReply(''));
    const r = await probeVisionSupport({ ...base, fetchImpl });
    expect(r.supported).toBe('unknown');
  });

  it('超时 → unknown（不代表不支持）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('The operation was aborted due to timeout'); });
    const r = await probeVisionSupport({ ...base, fetchImpl });
    expect(r.supported).toBe('unknown');
    expect(r.reason).toContain('超时');
  });

  it('网络错误 → unknown', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await probeVisionSupport({ ...base, fetchImpl });
    expect(r.supported).toBe('unknown');
    expect(r.reason).toContain('网络');
  });

  it('429 限流 → unknown', async () => {
    const fetchImpl = vi.fn(async () => res(429, 'slow down'));
    const r = await probeVisionSupport({ ...base, fetchImpl });
    expect(r.supported).toBe('unknown');
    expect(r.reason).toContain('限流');
  });

  it('401 → unknown（鉴权失败不是能力问题）', async () => {
    const fetchImpl = vi.fn(async () => res(401, 'bad key'));
    const r = await probeVisionSupport({ ...base, fetchImpl });
    expect(r.supported).toBe('unknown');
    expect(r.reason).toContain('鉴权');
  });

  it('没配 baseUrl/model → unknown，不发请求', async () => {
    const fetchImpl = vi.fn();
    expect((await probeVisionSupport({ baseUrl: '', model: 'x', fetchImpl })).supported).toBe('unknown');
    expect((await probeVisionSupport({ baseUrl: 'http://x/v1', model: '', fetchImpl })).supported).toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('真的把洋红图放进请求体（否则探测毫无意义）', async () => {
    const fetchImpl = vi.fn(async () => chatReply('magenta'));
    await probeVisionSupport({ ...base, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe('qwen-vl');
    expect(body.stream).toBe(false);
    const parts = body.messages[0].content;
    expect(parts.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);
    expect(parts.some((p) => p.type === 'text')).toBe(true);
  });

  it('max_tokens 很小（探测不该花大钱、不该慢）', async () => {
    const fetchImpl = vi.fn(async () => chatReply('magenta'));
    await probeVisionSupport({ ...base, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.max_tokens).toBeLessThanOrEqual(64);
  });
});

describe('缓存', () => {
  it('yes/no 会缓存，避免每次发图都探一次', async () => {
    const fetchImpl = vi.fn(async () => chatReply('magenta'));
    const p = { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm1', fetchImpl };
    await probeVisionSupportCached(p);
    await probeVisionSupportCached(p);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getCachedVisionSupport('http://x/v1', 'm1')?.supported).toBe('yes');
  });

  it('**unknown 不缓存**（下次可能就好了，缓存住会一直误导）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const p = { baseUrl: 'http://y/v1', apiKey: 'k', model: 'm2', fetchImpl };
    await probeVisionSupportCached(p);
    expect(getCachedVisionSupport('http://y/v1', 'm2')).toBe(null);
    // 第二次会重新探
    await probeVisionSupportCached(p);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('过期后不再命中', () => {
    setCachedVisionSupport('http://z/v1', 'm3', { supported: 'yes', reason: 'x' });
    expect(getCachedVisionSupport('http://z/v1', 'm3')).toBeTruthy();
    expect(getCachedVisionSupport('http://z/v1', 'm3', -1)).toBe(null);
  });

  it('不同模型/地址互不干扰', () => {
    setCachedVisionSupport('http://a/v1', 'mA', { supported: 'yes', reason: 'x' });
    expect(getCachedVisionSupport('http://a/v1', 'mB')).toBe(null);
    expect(getCachedVisionSupport('http://b/v1', 'mA')).toBe(null);
  });

  it('末尾斜杠归一（同一个地址不该存两份）', () => {
    setCachedVisionSupport('http://a/v1/', 'm', { supported: 'no', reason: 'x' });
    expect(getCachedVisionSupport('http://a/v1', 'm')?.supported).toBe('no');
  });

  it('命中缓存时带 cached 标记', async () => {
    setCachedVisionSupport('http://c/v1', 'm', { supported: 'yes', reason: 'x' });
    const r = await probeVisionSupportCached({ baseUrl: 'http://c/v1', model: 'm', fetchImpl: vi.fn() });
    expect(r.cached).toBe(true);
  });

  it('无效 result 不写缓存', () => {
    setCachedVisionSupport('http://d/v1', 'm', null);
    setCachedVisionSupport('http://d/v1', 'm', { reason: 'no supported field' });
    expect(getCachedVisionSupport('http://d/v1', 'm')).toBe(null);
  });
});
