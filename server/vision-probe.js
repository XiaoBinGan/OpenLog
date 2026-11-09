/**
 * 视觉能力探测 —— 「当前模型到底能不能看图」。
 *
 * 为什么需要：图片按 OpenAI vision 格式发出去后，不同引擎的行为差别很大：
 *   - 支持：正常理解图片；
 *   - 不支持但会报错：400 `image_url is not supported` / `does not support image`；
 *   - 不支持却**静默忽略**（Ollama 上纯文本模型最常见）：图片被丢弃，
 *     模型对着空图硬答，用户以为「AI 看图看歪了」，实际它根本没看到。
 *
 * 三种结论，绝不把「不知道」说成「支持」：
 *   yes     —— 模型正确说出了探测图的颜色
 *   no      —— 引擎明确拒绝图片
 *   unknown —— 超时/限流/答非所问；不阻止用户，但界面要提示「可能不支持」
 *
 * 探测用什么图：一张纯洋红色小图 + 「这是什么颜色」。
 * 为什么不用红色：红/蓝/绿属于高频猜测色，模型不看图也可能蒙对；
 * 洋红（magenta）不在常见猜测集合里，答对基本只能是真的看到了。
 */

import zlib from 'node:zlib';

/** 探测结果缓存时长：与窗口探测一致 */
export const VISION_PROBE_TTL_MS = 10 * 60 * 1000;

// ── PNG 生成（服务端没有 canvas，手写最小 PNG 编码）──────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/**
 * 生成一张纯色 PNG（RGB，无隔行）。
 * @param {number} w
 * @param {number} h
 * @param {[number, number, number]} rgb
 * @returns {Buffer}
 */
export function makeSolidPng(w, h, rgb) {
  const width = Math.max(1, Math.floor(w));
  const height = Math.max(1, Math.floor(h));
  const [r, g, b] = rgb;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  // 每行首字节是 filter type（0 = None）
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 洋红（255,0,255）—— 不在常见猜测色里，答对基本只能是真的看到了 */
const PROBE_RGB = [255, 0, 255];
const PROBE_SIZE = 32;

/** 探测用的 data URL（固定内容，模块级算一次） */
export function probeImageDataUrl() {
  return `data:image/png;base64,${makeSolidPng(PROBE_SIZE, PROBE_SIZE, PROBE_RGB).toString('base64')}`;
}

/** 判定「模型答对了洋红」的别名集合（中英+常见变体） */
export function looksLikeMagenta(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return false;
  // magenta / 洋红 / 品红 / 紫红 / fuchsia；以及「粉紫」「紫」这类近似描述
  return /magenta|fuchsia|洋红|洋紅|品红|品紅|紫红|紫紅|粉紫|紫/.test(s);
}

/**
 * 判定错误信息是否表示「不支持图片输入」。
 * 覆盖 vLLM / SGLang / Ollama / OpenAI 的常见措辞。
 */
export function isImageUnsupportedError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return false;
  const status = Number(err?.status || err?.response?.status || 0);
  if (status && status >= 500) return false; // 服务端错误不是「不支持」
  return /image[_ ]?url|image input|images? (are|is) not supported|does not support (image|vision|multimodal)|multimodal.*not (supported|enabled)|vision.*not (supported|enabled)|unsupported (content|message) type|invalid content type|only text/.test(msg);
}

/**
 * 探测某模型是否支持图片输入。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{supported:'yes'|'no'|'unknown', reason:string, detail?:string}>}
 */
export async function probeVisionSupport({ baseUrl, apiKey, model, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base || !model) return { supported: 'unknown', reason: '未配置 Base URL 或模型名' };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        // 只要 1 个 token 就够判断，省时间也省钱
        max_tokens: 24,
        temperature: 0,
        stream: false,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这张图片是什么颜色？只回答颜色名，不要解释。' },
            { type: 'image_url', image_url: { url: probeImageDataUrl() } },
          ],
        }],
      }),
    });
  } catch (err) {
    const m = String(err?.message || err || '');
    if (/timeout|timed out|aborted/i.test(m)) return { supported: 'unknown', reason: '探测超时（模型响应太慢，不代表不支持）', detail: m };
    return { supported: 'unknown', reason: '探测请求失败（网络原因，不代表不支持）', detail: m };
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* 读不到就算了 */ }
    if (isImageUnsupportedError({ message: body, status: res.status })) {
      return { supported: 'no', reason: '引擎明确拒绝图片输入', detail: body.slice(0, 300) };
    }
    if (res.status === 429) return { supported: 'unknown', reason: '被限流，探测未完成', detail: body.slice(0, 200) };
    if (res.status === 401 || res.status === 403) return { supported: 'unknown', reason: '鉴权失败，探测未完成', detail: body.slice(0, 200) };
    return { supported: 'unknown', reason: `探测返回 HTTP ${res.status}`, detail: body.slice(0, 300) };
  }

  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  const reply = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!reply) {
    // 200 但没内容：可能是引擎吞掉了图片却没说话
    return { supported: 'unknown', reason: '引擎返回空回复（可能静默忽略了图片）' };
  }
  if (looksLikeMagenta(reply)) {
    return { supported: 'yes', reason: '模型正确识别了探测图颜色', detail: reply.slice(0, 120) };
  }
  // 200 但答错：很可能是「图片被静默忽略」，不是理解错误
  return {
    supported: 'unknown',
    reason: '模型没有正确识别探测图（可能静默忽略了图片）',
    detail: reply.slice(0, 160),
  };
}

// ── 缓存（避免每次发图都探一次）────────────────────────────────

const visionCache = new Map(); // `${base}||${model}` → { result, ts }

function cacheKey(baseUrl, model) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}||${model || ''}`;
}

/** 读缓存；超过 TTL 视为没有 */
export function getCachedVisionSupport(baseUrl, model, ttlMs = VISION_PROBE_TTL_MS) {
  const hit = visionCache.get(cacheKey(baseUrl, model));
  if (!hit) return null;
  if (Date.now() - hit.ts > ttlMs) { visionCache.delete(cacheKey(baseUrl, model)); return null; }
  return hit.result;
}

/** 写缓存（探测结果与运行时错误识别都会写） */
export function setCachedVisionSupport(baseUrl, model, result) {
  if (!result || !result.supported) return;
  visionCache.set(cacheKey(baseUrl, model), { result, ts: Date.now() });
  if (visionCache.size > 50) {
    const oldest = [...visionCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) visionCache.delete(oldest[0]);
  }
}

/** 带缓存的探测 */
export async function probeVisionSupportCached(opts = {}, ttlMs = VISION_PROBE_TTL_MS) {
  const cached = getCachedVisionSupport(opts.baseUrl, opts.model, ttlMs);
  if (cached) return { ...cached, cached: true };
  const result = await probeVisionSupport(opts);
  // unknown 不缓存：下次可能就是好的，缓存住反而一直误导
  if (result.supported !== 'unknown') setCachedVisionSupport(opts.baseUrl, opts.model, result);
  return { ...result, cached: false };
}

/** 测试用：清缓存 */
export function _resetVisionCache() {
  visionCache.clear();
}
