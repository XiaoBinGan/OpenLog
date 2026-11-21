// @vitest-environment jsdom
/**
 * 演示模式下的只读适配（K8s 页）。
 *
 * 断言两件事：
 *   1. `/api/demo` 返回 `demo: true` 时，「新增集群」按钮是 disabled 的（视觉 + 语义都禁）；
 *   2. 就算绕过 disabled 直接点，也不会有任何写请求发出（守卫在 handler 里，不只靠样式）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../contexts/ToastContext';
import K8s from '../K8s';
import { __resetDemoModeForTests } from '../../hooks/useDemoMode';

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

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

async function renderK8s(fetchMock: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => fetchMock(String(input))),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(MemoryRouter, null, createElement(ToastProvider, null, createElement(K8s))),
    );
  });
}

describe('K8s 页 · 演示模式只读', () => {
  it('「新增集群」被禁用，点击也不会打开表单', async () => {
    const calls: string[] = [];
    await renderK8s((url) => {
      calls.push(url);
      if (url === '/api/demo') return fakeResponse({ demo: true });
      if (url === '/api/k8s/clusters') return fakeResponse({ clusters: [] });
      return fakeResponse({ error: `unexpected ${url}` }, 500);
    });

    const addButton = [...(container?.querySelectorAll('button') ?? [])]
      .find((b) => (b.textContent ?? '').includes('新增集群'));
    expect(addButton, '没找到「新增集群」按钮').toBeTruthy();
    expect(addButton?.disabled).toBe(true);

    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 表单没打开：没有出现 kubeconfig 粘贴框（ClusterForm 的 textarea）
    expect(container?.querySelector('textarea')).toBeNull();
    // 没有发出任何写请求（POST/PUT/PATCH/DELETE 都不该出现）
    expect(calls.filter((u) => u === '/api/k8s/clusters')).toHaveLength(1); // 只有首次 GET
  });

  it('非演示模式（demo: false）按钮照常可用', async () => {
    await renderK8s((url) => {
      if (url === '/api/demo') return fakeResponse({ demo: false });
      if (url === '/api/k8s/clusters') return fakeResponse({ clusters: [] });
      return fakeResponse({ error: `unexpected ${url}` }, 500);
    });
    const addButton = [...(container?.querySelectorAll('button') ?? [])]
      .find((b) => (b.textContent ?? '').includes('新增集群'));
    expect(addButton?.disabled).toBe(false);
  });
});
