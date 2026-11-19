// @vitest-environment jsdom
/**
 * K8s 页面级集成测试（jsdom + 假 fetch）。
 *
 * 覆盖三件「不测就一定会回归」的事：
 *   1. 没有集群时给引导文案（不是白屏，也不是 0/0 的空表格）
 *   2. 接口失败时错误条可见（不是只 console.error）
 *   3. 点 Pod 行真的会去请求 `.../pods/:ns/:pod/logs?tail=200`，并把日志渲染出来
 *
 * 这里的 fetch 用最小假响应对象（只实现 apiFetch 用到的 ok/status/statusText/text），
 * 不依赖运行环境是否提供 Response，也不会真的发网络请求。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../../contexts/ToastContext';
import K8s from '../../K8s';
import type { K8sClusterView, K8sOverview } from '../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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

/** 最小 Response 替身：apiFetch 只用到这几个成员。 */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const CLUSTER: K8sClusterView = {
  id: 'c1',
  name: 'k3s-prod',
  context: 'k3s-prod',
  server: 'https://127.0.0.1:6443',
  enabled: true,
  authType: 'cert',
  hasKubeconfig: true,
};

const OVERVIEW: K8sOverview = {
  cluster: { version: 'v1.33.1+k3s1', server: 'https://127.0.0.1:6443', context: 'k3s-prod' },
  nodes: [
    {
      name: 'k3s-server-1',
      ready: true,
      roles: ['control-plane', 'master'],
      version: 'v1.33.1+k3s1',
      os: 'linux',
      arch: 'arm64',
      internalIP: '10.0.0.10',
      cpu: '8',
      memory: '16234567Ki',
      pods: '110',
      created: new Date(Date.now() - 86_400_000).toISOString(),
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  ],
  pods: [
    {
      namespace: 'kube-system',
      name: 'coredns-7d8f9',
      phase: 'Running',
      ready: '0/1',
      restarts: 6,
      node: 'k3s-server-1',
      ip: '10.42.0.7',
      created: new Date(Date.now() - 3_600_000).toISOString(),
      oom: true,
      crashLoop: true,
      containers: [{ name: 'coredns', ready: false, restarts: 6, state: 'waiting', reason: 'CrashLoopBackOff' }],
    },
  ],
  workloads: [
    { namespace: 'kube-system', name: 'coredns', kind: 'Deployment', desired: 2, ready: 1, upToDate: 2, available: 1, created: '2026-01-01T00:00:00Z' },
  ],
  events: [
    {
      namespace: 'kube-system',
      type: 'Warning',
      reason: 'BackOff',
      object: 'pod/coredns-7d8f9',
      message: 'Back-off restarting failed container',
      count: 12,
      lastSeen: '2026-01-01T00:00:00Z',
    },
  ],
  summary: {
    nodes: 1,
    nodesReady: 1,
    pods: 1,
    podsRunning: 1,
    podsUnhealthy: 1,
    workloads: 1,
    workloadsUnready: 1,
    warningEvents: 1,
  },
};

function renderPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root?.render(
      createElement(MemoryRouter, null, createElement(ToastProvider, null, createElement(K8s))),
    );
  });
}

describe('K8s 页面', () => {
  it('没有集群时显示引导文案与添加入口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ clusters: [] })));
    await renderPage();
    const text = container?.textContent ?? '';
    expect(text).toContain('Kubernetes 集群');
    expect(text).toContain('还没有接入 Kubernetes 集群');
    expect(text).toContain('添加集群');
  });

  it('集群列表接口失败时显示错误条（不是白屏）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ error: '权限不足：需要 nodes 的 list 权限' }, 502)),
    );
    await renderPage();
    expect(container?.textContent).toContain('权限不足');
    expect(container?.textContent).toContain('重试');
  });

  it('读到集群后渲染概览：统计卡 / 节点 / Pod 标记 / Warning 事件', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/k8s/clusters') return fakeResponse({ clusters: [CLUSTER] });
      if (url === '/api/k8s/clusters/c1/overview') return fakeResponse(OVERVIEW);
      return fakeResponse({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderPage();
    const text = container?.textContent ?? '';
    // 统计卡
    expect(text).toContain('节点 Ready');
    expect(text).toContain('1/1');
    expect(text).toContain('1 异常');
    // 节点与 Pod
    expect(text).toContain('k3s-server-1');
    expect(text).toContain('coredns-7d8f9');
    expect(text).toContain('CrashLoopBackOff');
    expect(text).toContain('OOMKilled');
    // Warning 事件
    expect(text).toContain('BackOff');
    expect(text).toContain('Back-off restarting failed container');
    // 概览请求确实发过
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/k8s/clusters/c1/overview')).toBe(true);
  });

  it('点 Pod 行会请求 logs?tail=200 并渲染日志内容', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/k8s/clusters') return fakeResponse({ clusters: [CLUSTER] });
      if (url === '/api/k8s/clusters/c1/overview') return fakeResponse(OVERVIEW);
      if (url === '/api/k8s/clusters/c1/pods/kube-system/coredns-7d8f9/logs?tail=200') {
        return fakeResponse({ logs: 'plugin/kubernetes: Ready\nplugin/kubernetes: 2 zones' });
      }
      return fakeResponse({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderPage();
    // 页面里有两张表（节点表 + Pod 表），按内容挑出 Pod 那一行
    const rows = [...(container?.querySelectorAll('tbody tr') ?? [])];
    const podRow = rows.find((r) => (r.textContent ?? '').includes('coredns-7d8f9'));
    expect(podRow).toBeDefined();

    await act(async () => {
      podRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/k8s/clusters/c1/pods/kube-system/coredns-7d8f9/logs?tail=200')).toBe(true);
    expect(container?.textContent).toContain('plugin/kubernetes: 2 zones');
    expect(container?.textContent).toContain('最近 200 行');
  });

  it('概览接口失败时在右侧显示错误条并可重试', async () => {
    let overviewCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/k8s/clusters') return fakeResponse({ clusters: [CLUSTER] });
      if (url === '/api/k8s/clusters/c1/overview') {
        overviewCalls += 1;
        return fakeResponse({ error: 'x509: certificate signed by unknown authority' }, 502);
      }
      return fakeResponse({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderPage();
    expect(container?.textContent).toContain('概览读取失败');
    expect(container?.textContent).toContain('certificate signed by unknown authority');

    const retry = [...(container?.querySelectorAll('button') ?? [])].find((b) =>
      (b.textContent ?? '').includes('重试'),
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(overviewCalls).toBeGreaterThan(1);
  });
});