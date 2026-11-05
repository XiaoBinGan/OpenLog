/**
 * client/src/utils/fileOpPrompt.ts —— 文件操作的输入校验（纯函数）
 *
 * 右键菜单里「重命名 / 新建文件夹 / 复制到 / 移动到 / 权限」都需要用户输入，
 * 这里把校验抽出来做单测，避免与后端规则不一致（后端见 server/remote-file-ops.js）。
 */

export interface Validation { ok: boolean; value?: string; error?: string }

/** 名称/路径里不允许的控制字符（换行、NUL 等；用字符串判断，避免 no-control-regex） */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 新文件名/目录名：不能为空、不能带路径分隔符、不能是 . / .. */
export function validateFileName(name: string): Validation {
  const v = String(name ?? '').trim();
  if (!v) return { ok: false, error: '名称不能为空' };
  if (v === '.' || v === '..') return { ok: false, error: '名称非法' };
  if (/[/\\]/.test(v)) return { ok: false, error: '名称不能包含 / 或 \\' };
  if (hasControlChars(v)) return { ok: false, error: '名称包含非法字符' };
  if (v.length > 255) return { ok: false, error: '名称过长（最多 255 字符）' };
  return { ok: true, value: v };
}

/** 目标绝对路径：必须以 / 开头 */
export function validateRemotePathInput(path: string): Validation {
  const v = String(path ?? '').trim();
  if (!v) return { ok: false, error: '路径不能为空' };
  if (!v.startsWith('/')) return { ok: false, error: '请填绝对路径（以 / 开头）' };
  if (hasControlChars(v)) return { ok: false, error: '路径包含非法字符' };
  return { ok: true, value: v.replace(/\/{2,}/g, '/') };
}

/** 权限：755 / 0644 这类八进制 */
export function validateMode(mode: string): Validation {
  const v = String(mode ?? '').trim();
  if (!/^[0-7]{3,4}$/.test(v)) return { ok: false, error: '请填八进制权限，例如 755 或 0644' };
  return { ok: true, value: v };
}

/** 拼目标路径：dir + name（重命名/新建用） */
export function joinPath(dir: string, name: string): string {
  const d = String(dir || '/').replace(/\/+$/, '') || '/';
  return d === '/' ? `/${name}` : `${d}/${name}`;
}

/** 从完整路径取文件名（用于重命名对话框预填） */
export function baseName(path: string): string {
  const p = String(path || '').replace(/\/+$/, '');
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** 从完整路径取父目录 */
export function parentDir(path: string): string {
  const p = String(path || '').replace(/\/+$/, '');
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}

/** 删除确认文案（危险操作要把路径写清楚） */
export function deleteConfirmText(kind: 'file' | 'dir', name: string, path: string): string {
  const what = kind === 'dir' ? '目录及其全部内容' : '文件';
  return `确定删除${what}「${name}」吗？\n\n${path}\n\n此操作不可撤销。`;
}
