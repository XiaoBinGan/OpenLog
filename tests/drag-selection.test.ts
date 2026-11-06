import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 回归测试：拖拽排序不能和「选中文字 / 复制日志」冲突。
 *
 * 真实 bug：Docker 页把整个容器卡片设成 `draggable`，HTML5 原生拖拽会劫持鼠标拖动，
 * 于是卡片内所有文字（实时日志 / AI 诊断 / 终端输出）都选不中，也没法复制。
 * 同样写法在 Dashboard / Monitor 的卡片上也有。
 *
 * 正确做法：只有拖拽手柄（GripVertical 图标）可拖，卡片本身去掉 draggable；
 * dragstart 会冒泡，所以卡片上的 onDragStart/onDrop 处理器可以保留。
 *
 * 另外日志是流式追加的，自动滚动如果无条件执行，用户一框选就被滚走 ——
 * 必须检测「正在选中」时跳过自动滚动。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * Docker 页已被拆成 Docker.tsx + client/src/pages/docker/*。
 * 这些断言原本针对单个大文件，现在要覆盖所有拆出来的子组件，
 * 否则「组件搬走 = 断言假绿」。
 */
const readDockerAll = () => {
  const dir = path.join(ROOT, 'client/src/pages/docker');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts')) : [];
  return [read('client/src/pages/Docker.tsx'), ...files.map((f) => read(`client/src/pages/docker/${f}`))].join('\n');
};

/** 在拼接后的源码里取一个组件/函数体（到下一个顶层 function/export 为止） */
const sliceFn = (src: string, name: string, until?: string) => {
  const start = src.indexOf(name);
  if (start < 0) return '';
  const rest = src.slice(start + name.length);
  const stops = [
    until ? rest.indexOf(until) : -1,
    rest.indexOf('\nfunction '),
    rest.indexOf('\nexport function '),
    rest.indexOf('\nexport default '),
  ].filter((i) => i > 0);
  return rest.slice(0, stops.length ? Math.min(...stops) : rest.length);
};

describe('Docker 容器卡片：只有手柄可拖，正文可选中', () => {
  const src = readDockerAll();

  it('卡片本身不再有 draggable 属性（否则卡片内文字无法选中）', () => {
    // 容器卡片是 <div key={key} ... onDragStart={...handleDragStart...}
    expect(src).not.toMatch(/<div\s+key=\{key\}\s+draggable/);
    expect(src).not.toMatch(/key=\{key\}\s*\n\s*draggable/);
  });

  it('拖拽手柄带 draggable，排序功能保留', () => {
    // 手柄：draggable + title + GripVertical
    const gripBlock = src.slice(src.indexOf('{/* Drag handle'), src.indexOf('{/* Drag handle') + 600);
    expect(gripBlock).toContain('draggable');
    expect(gripBlock).toContain('GripVertical');
    // 卡片上仍保留 drop 处理器（拖到卡片上排序）。
    // 拆分后处理器可能叫 handleDrop（父组件里直接传）或 onDrop（子组件收到的 prop），
    // 两种写法都合法 —— 断言"存在一个把 (事件, key) 交给排序函数的 onDrop"。
    expect(src).toMatch(/onDrop=\{\(e\) => (handleDrop|onDrop)\(e, key\)\}/);
  });

  it('日志输出区显式允许选中文字', () => {
    // 日志滚动容器带 select-text
    const panel = sliceFn(src, 'function LiveLogPanel');
    expect(panel).toContain('select-text');
  });

  it('日志时间戳不再 select-none（整行可复制）', () => {
    expect(src).not.toMatch(/text-dark-700 flex-shrink-0 w-44 select-none/);
  });
});

describe('流式滚动不能打断用户框选', () => {
  const src = readDockerAll();

  it('LiveLogPanel 自动滚动前检查当前选区', () => {
    const panel = sliceFn(src, 'function LiveLogPanel');
    expect(panel).toContain('getSelection');
    expect(panel).toMatch(/isCollapsed/);
    // 用即时滚动，避免平滑滚动把选中区域滚走
    expect(panel).toContain("behavior: 'auto'");
    expect(panel).not.toContain("behavior: 'smooth', block: 'nearest' });\n  }, [lines");
  });

  it('DiagnosisPanel 自动滚动前检查当前选区', () => {
    // renderMarkdown 定义在 DiagnosisPanel 之前，所以这里取到文件末尾
    const panel = sliceFn(src, 'function DiagnosisPanel');
    expect(panel).toContain('getSelection');
    expect(panel).toMatch(/el\.contains\(sel\.anchorNode\)/);
  });

  it('日志 / 终端面板提供一键复制（框选不好用时的兜底）', () => {
    const logPanel = sliceFn(src, 'function LiveLogPanel');
    expect(logPanel).toContain('copyAll');
    expect(logPanel).toContain('已复制');
    const termPanel = sliceFn(src, 'function TerminalPanel');
    expect(termPanel).toContain('copyAll');
  });
});

describe('Dashboard / Monitor 卡片同样只允许手柄拖拽', () => {
  for (const rel of ['client/src/pages/Dashboard.tsx', 'client/src/pages/Monitor.tsx']) {
    it(`${rel} 卡片没有 draggable，手柄有 draggable`, () => {
      const src = read(rel);
      expect(src).not.toMatch(/<div\s+draggable\s+onDragStart=\{\(e\) => onDragStart\(e, index\)\}/);
      expect(src).toMatch(/draggable\s+title="按住拖动排序"/);
      // 排序回调仍然接在卡片上
      expect(src).toMatch(/onDrop=\{\(e\) => onDrop\(e, index\)\}/);
    });
  }
});
