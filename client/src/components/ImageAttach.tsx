/**
 * 图片附件条 + 选择按钮（AI Shell 与运维助手共用）。
 *
 * 交互覆盖三种最常见的贴图方式：
 *   1. 点回形针选文件（支持多选）
 *   2. 直接 Ctrl+V 粘贴截图（运维场景 90% 是截图）
 *   3. 把文件拖进输入区
 *
 * 组件只管「显示 + 触发校验」，压缩/编码/取文件都在 utils/imageAttach 里
 * （那边是纯函数，可被 vitest 覆盖；这里只负责渲染）。
 */
import { useCallback, useRef, useState } from 'react';
import { ImagePlus, X, Loader2 } from 'lucide-react';
import { MAX_IMAGES, formatBytes, filesToAttachments } from '../utils/imageAttach';
import type { AttachedImage } from '../utils/imageAttach';

export type { AttachedImage };

interface ImageAttachBarProps {
  images: AttachedImage[];
  onChange: (next: AttachedImage[]) => void;
  /** 校验/压缩失败的提示（由父组件接到自己的 toast / error 区） */
  onError?: (message: string) => void;
  disabled?: boolean;
  /** 主题色：AI Shell 用 accent，助手也用 accent（保持一致） */
  compact?: boolean;
}

export default function ImageAttachBar({ images, onChange, onError, disabled, compact }: ImageAttachBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const full = images.length >= MAX_IMAGES;

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const added = await filesToAttachments(files, images.length, onError);
      if (added.length) onChange([...images, ...added]);
    } finally {
      setBusy(false);
    }
  }, [images, onChange, onError]);

  const remove = (id: string) => onChange(images.filter((i) => i.id !== id));

  return (
    <div className={compact ? 'flex items-center gap-2' : 'space-y-2'}>
      {/* 缩略图条 */}
      {images.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {images.map((img) => (
            <div key={img.id} className="relative group">
              <img
                src={img.dataUrl}
                alt={img.name}
                title={`${img.name}${img.width ? ` · ${img.width}×${img.height}` : ''} · ${formatBytes(img.bytes)}`}
                className="w-14 h-14 object-cover rounded-lg border border-dark-700 bg-dark-900"
              />
              <button
                type="button"
                onClick={() => remove(img.id)}
                title="移除"
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-dark-800 border border-dark-600
                  text-dark-300 hover:text-red-400 hover:border-red-500/50 flex items-center justify-center"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 选择按钮 */}
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = ''; // 允许重复选同一张
            void addFiles(files);
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || busy || full}
          title={
            full ? `最多 ${MAX_IMAGES} 张图片`
              : '添加图片（也可直接粘贴截图 / 拖入文件）'
          }
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-dark-800 border border-dark-700
            text-dark-400 hover:text-dark-200 hover:border-dark-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
          <span>{busy ? '处理中' : '图片'}</span>
          {images.length > 0 && <span className="text-dark-500">{images.length}/{MAX_IMAGES}</span>}
        </button>
      </div>
    </div>
  );
}