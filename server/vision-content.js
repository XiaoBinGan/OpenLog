/**
 * 多模态消息（文本 + 图片）的公共处理。
 *
 * 为什么单独一个模块：图片让「content 是字符串」这个隐含假设全面失效。
 * 现有代码里 6 处 `String(m.content)` 会把数组变成 `[object Object]`；
 * 而 `estimateTokens(JSON.stringify(content))` 会把 base64 正文当文本算 token ——
 * 一张 300KB 的图 ≈ 8.5 万 token，上下文预算当场爆掉，历史会被整段丢掉。
 *
 * 这里集中解决三件事：
 *   1. `contentText()`：从字符串/parts 数组里取**纯文本**（压缩、判断语言、摘要都用它）
 *   2. `contentTokens()`：图片按**固定估值**算，绝不按 base64 长度算
 *   3. 校验：只接受 data URL、白名单 MIME、数量与体积上限
 *
 * 本模块不 import 项目内其它模块（避免和 chat-context 形成循环依赖）。
 */

/** 单条消息最多几张图 */
export const MAX_IMAGES_PER_MESSAGE = 6;
/** 单张图 data URL 的最大字符数（约 1.1MB 二进制） */
export const MAX_IMAGE_DATA_URL_CHARS = 1_500_000;
/** 单条消息所有图片 data URL 合计最大字符数 */
export const MAX_TOTAL_IMAGE_CHARS = 6_000_000;

/**
 * 一张图在上下文里占多少 token。
 *
 * 不用 base64 长度算（那是天文数字）。按 OpenAI 高细节图的量级取一个保守常量：
 * 客户端已把长边压到 1568px，这个尺寸的高细节图约 1000~1200 token。
 * 宁可估多，让预算提前收紧，也好过估少了被引擎静默截断。
 */
export const IMAGE_TOKEN_ESTIMATE = 1100;

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 是不是一个图片 part（OpenAI vision 格式） */
export function isImagePart(part) {
  return Boolean(part) && typeof part === 'object' && part.type === 'image_url';
}

/**
 * 从 content 里取纯文本。
 * - 字符串 → 原样
 * - parts 数组 → 拼接所有 text part，图片位置留 `[图片]`
 * - 其它 → 空串（不再做 String() 强转，避免 `[object Object]` 流进 prompt）
 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const part of content) {
    if (typeof part === 'string') { out.push(part); continue; }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') out.push(part.text);
    else if (isImagePart(part)) out.push('[图片]');
  }
  return out.join('\n');
}

/** content 里有几张图 */
export function countImages(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) if (isImagePart(part)) n += 1;
  return n;
}

/**
 * content 的 token 估算。
 *
 * 文本部分只统计真正的 text part，**不含** `[图片]` 这个占位标记 ——
 * 占位是给人看/给压缩用的，多算它会让「同一张图」的估值漂移。
 * @param {unknown} content
 * @param {(text: string) => number} estimateText 文本估算函数（各模块的估算口径不同，由调用方传入）
 */
export function contentTokens(content, estimateText) {
  const est = typeof estimateText === 'function' ? estimateText : (t) => Math.ceil(String(t || '').length / 3.5);
  if (typeof content === 'string') return est(content);
  if (!Array.isArray(content)) return 0;
  let text = '';
  let images = 0;
  for (const part of content) {
    if (typeof part === 'string') { text += part; continue; }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') text += part.text;
    else if (isImagePart(part)) images += 1;
  }
  return est(text) + images * IMAGE_TOKEN_ESTIMATE;
}

/** 从 data URL 里取 MIME */
export function dataUrlMime(url) {
  const m = /^data:([^;,]+)[;,]/.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * 把 content 里的图片换成文字占位，只保留文本。
 *
 * 用途：写入 localStorage（base64 会瞬间撑爆 5MB 配额）、
 * 以及把上一轮图片塞进历史（每轮重发一遍图片既贵又没必要）。
 */
export function stripImagesFromContent(content) {
  return contentText(content);
}

/**
 * 校验并归一化一条消息的 content。
 *
 * @returns {{ok: true, content: string|Array}|{ok: false, error: string}}
 */
export function normalizeContent(content, { maxImages = MAX_IMAGES_PER_MESSAGE } = {}) {
  if (typeof content === 'string') return { ok: true, content };
  if (content === null || content === undefined) return { ok: true, content: '' };
  if (!Array.isArray(content)) return { ok: false, error: 'content 必须是字符串或 parts 数组' };

  const parts = [];
  let images = 0;
  let totalChars = 0;

  for (const raw of content) {
    if (typeof raw === 'string') { parts.push({ type: 'text', text: raw }); continue; }
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'parts 里有非法元素' };

    if (raw.type === 'text') {
      const text = typeof raw.text === 'string' ? raw.text : '';
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    if (isImagePart(raw)) {
      const url = String(raw?.image_url?.url || '');
      if (!url.startsWith('data:')) {
        // 只收 data URL：远程 URL 会让服务端去取内网地址（SSRF），也会拖慢每一步
        return { ok: false, error: '图片必须是 data URL（data:image/...）' };
      }
      const mime = dataUrlMime(url);
      if (!ALLOWED_MIME.has(mime)) {
        return { ok: false, error: `不支持的图片类型：${mime || '未知'}（只支持 PNG/JPEG/WebP/GIF）` };
      }
      if (url.length > MAX_IMAGE_DATA_URL_CHARS) {
        return { ok: false, error: `单张图片过大（${Math.round(url.length / 1024)}KB），上限约 ${Math.round(MAX_IMAGE_DATA_URL_CHARS / 1024)}KB` };
      }
      images += 1;
      if (images > maxImages) return { ok: false, error: `最多 ${maxImages} 张图片` };
      totalChars += url.length;
      if (totalChars > MAX_TOTAL_IMAGE_CHARS) {
        return { ok: false, error: '图片总大小超出限制，请减少数量或压缩后重试' };
      }
      parts.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    // 其它 part 类型（audio 等）不支持：直接拒绝，别让引擎报难懂的错
    return { ok: false, error: `不支持的 part 类型：${String(raw.type || '未知')}` };
  }

  if (!parts.some((p) => p.type === 'text') && images > 0) {
    // 纯图片也能问，但补一句提示让模型知道该看图
    parts.unshift({ type: 'text', text: '请看这些图片。' });
  }
  // 没有任何图片就退回字符串，避免下游要处理两种形态
  if (images === 0) {
    return { ok: true, content: parts.map((p) => p.text || '').join('\n') };
  }
  return { ok: true, content: parts };
}

/**
 * 处理一遍消息数组：校验 content、把**非最后一条** user 消息里的图片剥掉。
 *
 * 为什么要剥历史图片：
 *   1. 每轮重发 6 张图 = 6600 token，几轮就把窗口吃光；
 *   2. 模型只需要看当前这一轮的图，旧图留着只是占地方。
 *
 * @param {Array} messages
 * @param {{maxImages?: number, keepImagesInLastUser?: boolean}} [opts]
 * @returns {{ok: true, messages: Array, errors: string[]}|{ok: false, error: string}}
 */
export function normalizeMessages(messages, opts = {}) {
  const { maxImages, keepImagesInLastUser = true } = opts;
  if (!Array.isArray(messages)) return { ok: false, error: 'messages 必须是数组' };

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') { lastUserIdx = i; break; }
  }

  const out = [];
  const errors = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const normalized = normalizeContent(m.content, { maxImages });
    if (!normalized.ok) {
      // 非关键消息的图片不合法就退化成文本，别让整个请求 400
      if (m.role !== 'user' || i !== lastUserIdx) {
        out.push({ ...m, content: contentText(m.content) });
        errors.push(normalized.error);
        continue;
      }
      return { ok: false, error: normalized.error };
    }
    let content = normalized.content;
    const isLastUser = i === lastUserIdx;
    if (!keepImagesInLastUser || !isLastUser) {
      if (Array.isArray(content)) content = contentText(content);
    }
    out.push({ ...m, content });
  }
  return { ok: true, messages: out, errors };
}
