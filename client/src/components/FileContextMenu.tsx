/**
 * client/src/components/FileContextMenu.tsx —— 文件/目录右键菜单
 *
 * 用户反馈：「远程服务器连接的操作窗口，文件支持修改但无法右键修改文件名等操作」。
 * 这个组件就是那个右键菜单：重命名、删除、新建文件夹、复制/移动、改权限、复制路径。
 *
 * 定位用 fixed + 视口内翻转（点太靠右/太靠下时向左/上展开），点空白或 Esc 关闭。
 */
import { useEffect, useRef } from 'react';
import {
  Pencil, Trash2, FolderPlus, Copy, Scissors, ShieldCheck, ClipboardCopy, RefreshCw, PencilLine,
} from 'lucide-react';

export type FileOpKind =
  | 'rename' | 'delete' | 'mkdir' | 'copy' | 'move' | 'chmod' | 'refresh';

export interface FileMenuTarget {
  kind: 'file' | 'dir';
  path: string;
  name: string;
}

interface FileContextMenuProps {
  /** 菜单锚点（鼠标位置，client 坐标） */
  x: number;
  y: number;
  /** 右键的目标；为空表示右键了空白处（只显示「新建文件夹 / 刷新」） */
  target: FileMenuTarget | null;
  /** 是否显示「编辑文件」（只有文本文件才有意义） */
  canEdit?: boolean;
  /** 是否显示「打开目录」 */
  onOpen?: () => void;
  onEdit?: () => void;
  onOp: (op: FileOpKind) => void;
  onCopyPath: (path: string) => void;
  onClose: () => void;
}

interface MenuItem {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  separator?: boolean;
  onClick: () => void;
}

const MENU_WIDTH = 200;
const MENU_ITEM_HEIGHT = 32;
const MENU_PADDING = 12;

export default function FileContextMenu({
  x, y, target, canEdit, onOpen, onEdit, onOp, onCopyPath, onClose,
}: FileContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // 点空白 / Esc / 滚动 关闭
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const items: MenuItem[] = [];
  const run = (fn: () => void) => () => { fn(); onClose(); };

  if (target) {
    if (target.kind === 'dir' && onOpen) {
      items.push({ key: 'open', label: '打开目录', icon: ChevronLike, onClick: run(onOpen) });
    }
    if (target.kind === 'file' && canEdit && onEdit) {
      items.push({ key: 'edit', label: '编辑文件', icon: PencilLine, onClick: run(onEdit) });
    }
    items.push({ key: 'rename', label: '重命名', icon: Pencil, onClick: () => { onOp('rename'); onClose(); } });
    items.push({ key: 'copy', label: '复制到…', icon: Copy, onClick: () => { onOp('copy'); onClose(); } });
    items.push({ key: 'move', label: '移动到…', icon: Scissors, onClick: () => { onOp('move'); onClose(); } });
    items.push({ key: 'chmod', label: '修改权限', icon: ShieldCheck, onClick: () => { onOp('chmod'); onClose(); } });
    items.push({ key: 'copypath', label: '复制完整路径', icon: ClipboardCopy, onClick: run(() => onCopyPath(target.path)) });
    items.push({ key: 'sep', label: '', icon: Trash2, separator: true, onClick: onClose });
    items.push({ key: 'delete', label: '删除', icon: Trash2, danger: true, onClick: () => { onOp('delete'); onClose(); } });
  } else {
    items.push({ key: 'mkdir', label: '新建文件夹', icon: FolderPlus, onClick: () => { onOp('mkdir'); onClose(); } });
    items.push({ key: 'refresh', label: '刷新目录', icon: RefreshCw, onClick: () => { onOp('refresh'); onClose(); } });
  }

  // 视口边界翻转：菜单不会跑出屏幕
  const estHeight = items.length * MENU_ITEM_HEIGHT + MENU_PADDING * 2;
  const openLeft = x + MENU_WIDTH > window.innerWidth - 8;
  const openUp = y + estHeight > window.innerHeight - 8;
  const style: React.CSSProperties = {
    left: openLeft ? Math.max(8, x - MENU_WIDTH) : x,
    top: openUp ? Math.max(8, y - estHeight) : y,
    width: MENU_WIDTH,
  };

  return (
    <div
      ref={ref}
      style={style}
      className="fixed z-[999] rounded-lg border border-dark-700 bg-dark-900/98 py-1 shadow-2xl shadow-black/60 backdrop-blur"
      role="menu"
      onContextMenu={e => e.preventDefault()}
    >
      {items.map(item => {
        if (item.separator) return <div key={item.key} className="my-1 h-px bg-dark-800" />;
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            role="menuitem"
            onClick={item.onClick}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
              item.danger
                ? 'text-red-400 hover:bg-red-500/15'
                : 'text-dark-300 hover:bg-dark-800 hover:text-dark-100'
            }`}
          >
            <Icon className="h-3.5 w-3.5 flex-shrink-0" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** 目录打开图标（复用视觉，不额外引依赖） */
function ChevronLike({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
