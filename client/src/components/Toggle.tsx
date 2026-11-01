import type { CSSProperties } from 'react';

/**
 * 统一开关组件
 *
 * 之前每个开关各自用「绝对定位 + translateX(魔法数字)」实现，滑块是 `absolute`
 * 但没写 `left`，所以它的原点取的是**静态位置**；而 button 默认 `text-align: center`，
 * 静态位置在轨道中间，再叠一个 translateX(18px) 就把白点推到了轨道右缘之外
 * （T4/生产上看到的现象：白点超出圆角背景）。
 *
 * 这里改成 flex 布局：滑块是普通 flex 子项，原点由 padding 决定；
 * 打开时整段位移 = 轨道内宽 - 滑块宽度，数值与尺寸一一对应，任何尺寸都不会越界。
 */

export type ToggleSize = 'sm' | 'md' | 'lg';

interface SizeSpec {
  /** 轨道尺寸（含内边距） */
  track: string;
  /** 左右内边距：决定滑块的起始位置 */
  pad: string;
  /** 滑块尺寸 */
  knob: string;
  /** 打开时的位移：轨道内宽 - 滑块宽度 */
  travel: string;
}

const SIZES: Record<ToggleSize, SizeSpec> = {
  // 轨道 36×20，内边距 2px，滑块 16px → 行程 16px
  sm: { track: 'h-5 w-9', pad: 'px-0.5', knob: 'h-4 w-4', travel: 'translate-x-4' },
  // 轨道 44×24，内边距 2px，滑块 20px → 行程 20px
  md: { track: 'h-6 w-11', pad: 'px-0.5', knob: 'h-5 w-5', travel: 'translate-x-5' },
  // 轨道 56×28，内边距 4px，滑块 20px → 行程 28px
  lg: { track: 'h-7 w-14', pad: 'px-1', knob: 'h-5 w-5', travel: 'translate-x-7' },
};

export interface ToggleProps {
  checked: boolean;
  /** 切换回调；不传则组件只读 */
  onChange?: (next: boolean) => void;
  size?: ToggleSize;
  /** 打开时的背景色 */
  color?: string;
  /** 关闭时的背景色 */
  offColor?: string;
  /** 聚焦环的 Tailwind 类，例如 'focus:ring-2 focus:ring-cyan-500/40' */
  ring?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  'aria-label'?: string;
}

export default function Toggle({
  checked,
  onChange,
  size = 'md',
  color = 'rgb(16 185 129)',
  offColor = '#374151',
  ring = '',
  disabled = false,
  title,
  className = '',
  'aria-label': ariaLabel,
}: ToggleProps) {
  const spec = SIZES[size];
  const style: CSSProperties = { background: checked ? color : offColor };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange?.(!checked); }}
      className={`inline-flex shrink-0 items-center rounded-full transition-colors focus:outline-none ${spec.track} ${spec.pad} ${ring} ${
        disabled ? 'cursor-not-allowed opacity-50' : onChange ? 'cursor-pointer' : ''
      } ${className}`}
      style={style}
    >
      <span
        aria-hidden="true"
        className={`block shrink-0 rounded-full bg-white shadow-sm transition-transform duration-200 ${spec.knob} ${
          checked ? spec.travel : 'translate-x-0'
        }`}
      />
    </button>
  );
}
