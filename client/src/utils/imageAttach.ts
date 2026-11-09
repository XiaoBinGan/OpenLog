/**
 * 前端图片附件处理（AI Shell 与运维助手共用）。
 *
 * 为什么要压缩：手机截图动辄 3~8MB，直接 base64 后是 4~11MB 的字符串。
 *   - 后端 express.json 上限 10MB，几张就爆；
 *   - 模型端也要重新解码，慢且贵；
 *   - 上下文里一张图按固定值算 token，大图并不会让模型看得更清。
 * 所以统一压到长边 1568px、JPEG 0.85 —— 这是主流视觉模型的有效输入上限附近，
 * 再大只是浪费带宽。
 *
 * 这里只放**纯函数**（可被 vitest 直接测）；canvas 相关的编码放在
 * `encodeImageFile` 里，测试环境（node）不调用它。
 */

/** 单张图长边上限：主流视觉模型超过这个尺寸也不会看得更细 */
export const MAX_IMAGE_EDGE = 1568;
/** JPEG 编码质量 */
export const JPEG_QUALITY = 0.85;
/** 最多几张图 */
export const MAX_IMAGES = 6;
/** 单张图二进制上限（压缩前）：超过就拒绝，避免浏览器卡死 */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** 单张图 base64 后允许的字符数上限（与后端 MAX_IMAGE_DATA_URL_CHARS 对齐） */
export const MAX_DATA_URL_CHARS = 1_500_000;
/** 允许的 MIME */
export const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/**
 * 校验一个文件能不能作为附件。
 * @param {{type?: string, size?: number, name?: string}} file
 * @param {{count?: number, maxImages?: number, maxBytes?: number}} [opts]
 * @returns {{ok: true}|{ok: false, error: string}}
 */
export function validateImageFile(
  file: { type?: string; size?: number; name?: string } | null | undefined,
  opts: { count?: number; maxImages?: number; maxBytes?: number } = {},
) {
  const { count = 0, maxImages = MAX_IMAGES, maxBytes = MAX_SOURCE_BYTES } = opts;
  if (!file || typeof file !== 'object') return { ok: false, error: '无效的文件' };
  const type = String(file.type || '').toLowerCase();
  if (!ACCEPTED_MIME.includes(type)) {
    return { ok: false, error: `不支持的格式${type ? `：${type}` : ''}（支持 PNG / JPEG / WebP / GIF）` };
  }
  const size = Number(file.size) || 0;
  if (size <= 0) return { ok: false, error: '文件为空' };
  if (size > maxBytes) {
    return { ok: false, error: `图片过大（${formatBytes(size)}），上限 ${formatBytes(maxBytes)}` };
  }
  if (count >= maxImages) return { ok: false, error: `最多 ${maxImages} 张图片` };
  return { ok: true };
}

/**
 * 校验一批文件，返回可接受的与被拒的（被拒的带原因）。
 * @param {ArrayLike<{type?:string,size?:number,name?:string}>} files
 * @param {{count?: number, maxImages?: number}} [opts]
 */
export function pickAcceptedFiles(
  files: ArrayLike<{ type?: string; size?: number; name?: string }> | null | undefined,
  opts: { count?: number; maxImages?: number } = {},
) {
  const { count = 0, maxImages = MAX_IMAGES } = opts;
  const accepted = [];
  const rejected = [];
  let used = count;
  for (const f of Array.from(files || [])) {
    const v = validateImageFile(f, { count: used, maxImages });
    if (v.ok) { accepted.push(f); used += 1; }
    else rejected.push({ name: f?.name || '(未命名)', error: v.error });
  }
  return { accepted, rejected };
}

/**
 * 按长边缩放后的目标尺寸（不放大小图）。
 * @param {{width:number,height:number}} size
 * @param {number} [maxEdge]
 */
export function fitWithin(size: { width?: number; height?: number } | null | undefined, maxEdge = MAX_IMAGE_EDGE) {
  const w = Math.max(1, Math.round(Number(size?.width) || 0));
  const h = Math.max(1, Math.round(Number(size?.height) || 0));
  const limit = Math.max(1, Math.round(Number(maxEdge) || MAX_IMAGE_EDGE));
  const longest = Math.max(w, h);
  if (longest <= limit) return { width: w, height: h };
  const scale = limit / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * 把 data URL 组装成 OpenAI vision part。
 * @param {string} dataUrl
 * @returns {{type:'image_url', image_url:{url:string}}|null}
 */
export function toImagePart(dataUrl: unknown) {
  const url = String(dataUrl || '');
  if (!url.startsWith('data:image/')) return null;
  return { type: 'image_url', image_url: { url } };
}

/**
 * 把「文本 + 图片」组装成一条 user 消息的 content。
 * 没有图片时返回**字符串**（保持与旧协议一致，后端不必处理两种形态）。
 * @param {string} text
 * @param {Array<{dataUrl?: string}|string>} images
 */
export function buildUserContent(
  text: unknown,
  images: Array<{ dataUrl?: string } | string> = [],
) {
  const parts = [];
  for (const img of images || []) {
    const part = toImagePart(typeof img === 'string' ? img : img?.dataUrl);
    if (part) parts.push(part);
  }
  const body = String(text ?? '');
  if (parts.length === 0) return body;
  if (body.trim()) parts.unshift({ type: 'text', text: body });
  else parts.unshift({ type: 'text', text: '请看这些图片。' });
  return parts;
}

/** 从消息 content 里取纯文本（与后端 contentText 同语义） */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<string | { type?: string; text?: string }>)
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return String(p.text || '');
      if (p?.type === 'image_url') return '[图片]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** 人类可读的字节数 */
export function formatBytes(bytes: unknown) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 把 File 编码成压缩后的 data URL（浏览器专用，依赖 canvas）。
 *
 * 做了什么：读文件 → 按长边 1568 缩放 → 编码 JPEG 0.85 → data URL。
 * 动图（GIF）走原始字节：canvas 只能取第一帧，转 JPEG 会把动图变成静态图，
 * 对「看动图诊断」的场景是信息损失。
 *
 * @param {File|Blob} file
 * @param {{maxEdge?: number, quality?: number, maxChars?: number}} [opts]
 * @returns {Promise<{ok:true, dataUrl:string, width:number, height:number, bytes:number}|{ok:false, error:string}>}
 */
export type EncodeResult =
  | { ok: true; dataUrl: string; width: number; height: number; bytes: number }
  | { ok: false; error: string };

export async function encodeImageFile(
  file: File | Blob,
  opts: { maxEdge?: number; quality?: number; maxChars?: number } = {},
): Promise<EncodeResult> {
  const { maxEdge = MAX_IMAGE_EDGE, quality = JPEG_QUALITY, maxChars = MAX_DATA_URL_CHARS } = opts;
  const type = String(file?.type || '').toLowerCase();
  if (!ACCEPTED_MIME.includes(type)) return { ok: false, error: '不支持的图片格式' };

  const rawDataUrl = await readAsDataUrl(file as Blob);
  if (!rawDataUrl) return { ok: false, error: '读取文件失败' };

  // 动图保留原样（canvas 会丢帧）
  if (type === 'image/gif') {
    if (rawDataUrl.length > maxChars) return { ok: false, error: '动图过大，请裁剪后重试' };
    const dim = await readImageSize(rawDataUrl).catch((): { width: number; height: number } => ({ width: 0, height: 0 }));
    return { ok: true, dataUrl: rawDataUrl, width: dim.width, height: dim.height, bytes: file.size || 0 };
  }

  const img = await loadImage(rawDataUrl);
  if (!img) {
    // 解码失败（极少见，比如损坏的 webp）：退回原图，别让用户什么都发不出去
    if (rawDataUrl.length <= maxChars) {
      return { ok: true, dataUrl: rawDataUrl, width: 0, height: 0, bytes: file.size || 0 };
    }
    return { ok: false, error: '图片解码失败' };
  }

  const target = fitWithin({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height }, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, error: '浏览器不支持图片处理' };
  // JPEG 无透明通道：先铺白底，否则 PNG 透明区会变成黑块
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.drawImage(img, 0, 0, target.width, target.height);

  let qualityNow = quality;
  let dataUrl = canvas.toDataURL('image/jpeg', qualityNow);
  // 还超限就降质量重编（最多降到 0.55，再低就糊了）
  while (dataUrl.length > maxChars && qualityNow > 0.55) {
    qualityNow = Math.max(0.55, qualityNow - 0.1);
    dataUrl = canvas.toDataURL('image/jpeg', qualityNow);
  }
  if (dataUrl.length > maxChars) {
    return { ok: false, error: '图片压缩后仍然过大，请裁剪后重试' };
  }
  const bytes = Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
  return { ok: true, dataUrl, width: target.width, height: target.height, bytes };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    img.onerror = reject;
    img.src = src;
  });
}

/** 附件（与 ImageAttach 组件共用同一个类型） */
export interface AttachedImage {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  name: string;
}

let attachSeq = 0;
const nextAttachId = () => `img-${Date.now().toString(36)}-${(attachSeq += 1)}`;

/**
 * 把一批 File 处理成附件（校验 → 压缩 → 编码）。
 * 串行处理：并发 canvas 编码在低端机上会明显卡顿。
 */
export async function filesToAttachments(
  files: File[],
  existing: number,
  onError?: (msg: string) => void,
): Promise<AttachedImage[]> {
  const { accepted, rejected } = pickAcceptedFiles(files, { count: existing });
  for (const r of rejected) onError?.(`${r.name}：${r.error}`);

  const out: AttachedImage[] = [];
  for (const file of accepted) {
    const encoded = await encodeImageFile(file as File);
    if (!encoded.ok) { onError?.(`${(file as File).name || '图片'}：${encoded.error}`); continue; }
    out.push({
      id: nextAttachId(),
      dataUrl: String(encoded.dataUrl),
      width: Number(encoded.width) || 0,
      height: Number(encoded.height) || 0,
      bytes: Number(encoded.bytes) || 0,
      name: (file as File).name || '截图',
    });
  }
  return out;
}

/** 从 clipboard 事件里取图片文件（截图粘贴） */
export function imageFilesFromClipboard(e: { clipboardData?: DataTransfer | null }): File[] {
  const items = e?.clipboardData?.items || [];
  const out: File[] = [];
  for (const item of Array.from(items)) {
    if (item?.kind !== 'file') continue;
    const f = item.getAsFile?.();
    if (f && String(f.type || '').startsWith('image/')) out.push(f);
  }
  return out;
}

/** 从 drop 事件里取图片文件 */
export function imageFilesFromDrop(e: { dataTransfer?: DataTransfer | null }): File[] {
  const files = e?.dataTransfer?.files;
  if (!files) return [];
  return Array.from(files).filter((f) => String(f.type || '').startsWith('image/'));
}
