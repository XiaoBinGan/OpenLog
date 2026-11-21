// @vitest-environment jsdom
/**
 * 演示模式横幅 + 共享状态的契约测试。
 *
 * 这几条是「不测就一定会回归」的：
 *   1. `demo: true` 才显示横幅；字段缺失 / 请求失败一律静默（不显示空条、不报错）；
 *   2. 关闭只在本次会话 —— 重新挂载后（等价于刷新）横幅会回来；
 *   3. `/api/demo` 只探一次：横幅与页面共用模块级缓存，切页不会重复打接口；
 *   4. 未加载完时 `demo` 为 false（宁可多一次点击，也不误禁写操作）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import DemoBanner from '../DemoBanner';
import {
  __resetDemoModeForTests,
  DEMO_BANNER_TEXT,
  useDemoMode,
} from '../../hooks/useDemoMode';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  __resetDemoModeForTests();
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 最小 Response 替身：apiFetch 只用到 ok/status/statusText/text。 */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mount(node: ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root?.render(node);
  });
}

describe('DemoBanner', () => {
  it('demo === true 时显示琥珀色横幅', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ demo: true })));
    await mount(createElement(DemoBanner));
    expect(container?.textContent).toContain(DEMO_BANNER_TEXT);
  });

  it('字段缺失时静默（不渲染任何东西）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({})));
    await mount(createElement(DemoBanner));
    expect(container?.textContent).toBe('');
  });

  it('请求失败时静默（后端还没有 /api/demo 也不报错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ error: 'not found' }, 404)));
    await mount(createElement(DemoBanner));
    expect(container?.textContent).toBe('');
  });

  it('点关闭后本次会话隐藏，重新挂载（等价刷新）后再次出现', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ demo: true })));
    await mount(createElement(DemoBanner));
    const close = container?.querySelector('button');
    expect(close).toBeTruthy();
    await act(async () => {
      close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container?.textContent).toBe('');

    // 重新挂载 = 刷新页面；演示状态仍是缓存的 true，横幅应该回来
    act(() => root?.unmount());
    container?.remove();
    await mount(createElement(DemoBanner));
    expect(container?.textContent).toContain(DEMO_BANNER_TEXT);
  });

  it('/api/demo 只探一次：多个消费者共用同一份缓存', async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ demo: true }));
    vi.stubGlobal('fetch', fetchMock);
    await mount(createElement(DemoBanner));
    act(() => root?.unmount());
    container?.remove();
    await mount(createElement(DemoBanner));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('还没加载完时对外表现为「非演示」', async () => {
    let release: ((r: Response) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })),
    );

    const seen: boolean[] = [];
    function Probe() {
      const { demo, loaded } = useDemoMode();
      seen.push(demo);
      return createElement('span', null, `${loaded}/${demo}`);
    }

    await mount(createElement(Probe));
    // 请求还没回来：loaded=false，demo=false（按钮保持可用）
    expect(seen.every((d) => d === false)).toBe(true);
    expect(container?.textContent).toBe('false/false');

    await act(async () => {
      release?.(fakeResponse({ demo: true }));
    });
    expect(container?.textContent).toBe('true/true');
  });
});
