// @vitest-environment jsdom
/**
 * 「GPU 分配（HAMi）」卡片 + K8s 页面接线测试。
 *
 * 这一层测的是「看得见的东西对不对」：
 *   1. 有 HAMi 时卡片真的出现，节点行的卡数 / 显存 / 算力 / 占卡 Pod 与进度条宽度都在；
 *   2. **没有 HAMi 时卡片不渲染**，Pod 表也不出现 vGPU 列（老集群页面零变化）；
 *   3. 字段缺失时显示「—」，绝不出现 NaN / undefined；
 *   4. Pod 表那一列是 `12 GiB · 40%` 这种形态，没有分配的 Pod 显示「—」。
 *
 * 数据全部是本地 fixture（不发网络请求）；页面级用例用一个最小 fetch 替身。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../contexts/ToastContext';
import K8s from '../K8s';
import GpuAllocation from '../k8s/GpuAllocation';
import type { K8sClusterView, K8sGpuOverview, K8sOverview, K8sPod } from '../k8s/types';

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

/** 演示集群的形状：节点 4 卡 / 96 GiB / 400 算力点，两个 Pod 共享同一张卡 */
function gpuFixture(over: Partial<K8sGpuOverview> = {}): K8sGpuOverview {
  return {
    hasHami: true,
    nodes: [
      {
        name: 'k3s-infer-node-1',
        count: 4,
        memMiB: 98304,
        cores: 400,
        allocatedMemMiB: 16384,
        allocatedCores: 50,
        podCount: 2,
      },
    ],
    pods: [
      {
        namespace: 'inference',
        name: 'vllm-qwen27b-0',
        nodeName: 'k3s-infer-node-1',
        devices: [{ id: 'GPU-3f2a', memMiB: 12288, cores: 40 }],
        totalMemMiB: 12288,
        totalCores: 40,
        phase: 'Running',
      },
      {
        namespace: 'inference',
        name: 'sglang-router-7c9f5b6d4-x2qkz',
        nodeName: 'k3s-infer-node-1',
        devices: [{ id: 'GPU-3f2a', memMiB: 4096, cores: 10 }],
        totalMemMiB: 4096,
        totalCores: 10,
        phase: 'Running',
      },
    ],
    totals: {
      gpuCount: 4,
      memMiB: 98304,
      cores: 400,
      allocatedMemMiB: 16384,
      allocatedCores: 50,
      podCount: 2,
    },
    warnings: [],
    ...over,
  };
}

function renderCard(gpu: K8sGpuOverview | null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(GpuAllocation, { gpu }));
  });
  return container;
}

describe('GpuAllocation 卡片', () => {
  it('没有 HAMi 时整张卡片不渲染（hasHami:false / null 都一样）', () => {
    renderCard({ ...gpuFixture(), hasHami: false, nodes: [], pods: [], totals: { gpuCount: 0, memMiB: 0, cores: 0, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 } });
    expect(container?.textContent ?? '').toBe('');
    expect(container?.querySelector('h2')).toBeNull();

    act(() => {
      root?.unmount();
    });
    root = createRoot(container as HTMLDivElement);
    act(() => {
      root?.render(createElement(GpuAllocation, { gpu: null }));
    });
    expect(container?.textContent ?? '').toBe('');
  });

  it('节点行显示卡数 / 显存总量·已分配 / 算力总量·已分配 / 占卡 Pod 数', () => {
    renderCard(gpuFixture());
    const text = container?.textContent ?? '';

    expect(text).toContain('GPU 分配（HAMi）');
    expect(text).toContain('k3s-infer-node-1');
    expect(text).toContain('4 张卡');
    expect(text).toContain('2 个 Pod 占用');
    // 显存：16 GiB / 96 GiB（17%）；算力：50 / 400 点（13%）
    expect(text).toContain('16 GiB / 96 GiB');
    expect(text).toContain('50 / 400 点');
    expect(text).toContain('17%');
    expect(text).toContain('13%');
  });

  it('进度条宽度按已分配/总量算，且不会超出 100%', () => {
    renderCard(gpuFixture());
    const bars = [...(container?.querySelectorAll('div[title]') ?? [])].filter((el) =>
      (el.getAttribute('title') ?? '').includes('GiB'),
    );
    const bar = bars[0]?.querySelector('div');
    expect(bar?.getAttribute('style')).toContain('width: 17%');

    // 已分配 > 总量（异常数据）时夹到 100%，不出现 1700% 这种宽度
    act(() => {
      root?.render(
        createElement(GpuAllocation, {
          gpu: gpuFixture({
            nodes: [
              {
                name: 'n1',
                count: 1,
                memMiB: 1024,
                cores: 100,
                allocatedMemMiB: 17408,
                allocatedCores: 1000,
                podCount: 1,
              },
            ],
            totals: { gpuCount: 1, memMiB: 1024, cores: 100, allocatedMemMiB: 17408, allocatedCores: 1000, podCount: 1 },
          }),
        }),
      );
    });
    const wide = [...(container?.querySelectorAll('div[title]') ?? [])]
      .filter((el) => (el.getAttribute('title') ?? '').startsWith('17 GiB'))
      .map((el) => el.querySelector('div')?.getAttribute('style'));
    expect(wide[0]).toContain('width: 100%');
  });

  it('按节点列出占卡的 Pod：命名空间 / Pod / 显存 / 算力', () => {
    renderCard(gpuFixture());
    const text = container?.textContent ?? '';
    expect(text).toContain('vllm-qwen27b-0');
    expect(text).toContain('sglang-router-7c9f5b6d4-x2qkz');
    expect(text).toContain('inference');
    expect(text).toContain('12 GiB');
    expect(text).toContain('40%');
    expect(text).toContain('4 GiB');
    expect(text).toContain('10%');
    // 表头齐全
    for (const head of ['命名空间', 'Pod', '显存', '算力']) {
      expect([...(container?.querySelectorAll('th') ?? [])].some((th) => th.textContent === head)).toBe(true);
    }
  });

  it('字段缺失时显示「—」，不出现 NaN / undefined', () => {
    const broken = {
      hasHami: true,
      nodes: [{ name: 'n-broken' }],
      pods: [{ namespace: 'inference', name: 'half-parsed' }],
      totals: {},
      warnings: [],
    } as unknown as K8sGpuOverview;
    renderCard(broken);
    const text = container?.textContent ?? '';
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
    expect(text).toContain('—');
    expect(text).toContain('n-broken');
    expect(text).toContain('half-parsed');
  });

  it('有 HAMi 但没有分配时给空态（而不是空白卡片）', () => {
    renderCard(gpuFixture({ pods: [], totals: { gpuCount: 4, memMiB: 98304, cores: 400, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 } }));
    expect(container?.textContent).toContain('检测到 HAMi');
    expect(container?.textContent).toContain('没有读到任何 vGPU 分配');
  });

  it('解析警告显示在卡片底部', () => {
    renderCard(gpuFixture({ warnings: ['Pod inference/bad: hami.io/vgpu-devices-allocated 解析失败'] }));
    expect(container?.textContent).toContain('hami.io/vgpu-devices-allocated 解析失败');
  });
});

// ─── 页面接线：卡片出现与否 + Pod 表的 vGPU 列 ─────────────────────────────

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
  name: 'k3s-infer',
  context: 'demo-k3s',
  server: 'https://10.20.40.10:6443',
  enabled: true,
  authType: 'cert',
  hasKubeconfig: true,
};

function pod(over: Partial<K8sPod> = {}): K8sPod {
  return {
    namespace: 'inference',
    name: 'vllm-qwen27b-0',
    phase: 'Running',
    ready: '1/1',
    restarts: 0,
    node: 'k3s-infer-node-1',
    ip: '10.42.1.14',
    created: '2026-05-01T00:00:00Z',
    oom: false,
    crashLoop: false,
    containers: [{ name: 'vllm', ready: true, restarts: 0, state: 'running' }],
    ...over,
  };
}

function overviewFixture(gpu: K8sGpuOverview | undefined): K8sOverview {
  return {
    cluster: { version: 'v1.31.4+k3s1', server: 'https://10.20.40.10:6443', context: 'demo-k3s' },
    nodes: [
      {
        name: 'k3s-infer-node-1',
        ready: true,
        roles: ['control-plane'],
        version: 'v1.31.4+k3s1',
        os: 'linux',
        arch: 'amd64',
        internalIP: '10.20.40.10',
        cpu: '32',
        memory: '131842000Ki',
        pods: '110',
        created: '2026-03-02T04:12:31Z',
        conditions: [{ type: 'Ready', status: 'True' }],
      },
    ],
    // 故意不带 vgpu 字段：页面要从 gpu.pods 补齐（服务端只给汇总也能显示）
    pods: [
      pod(),
      pod({ namespace: 'monitoring', name: 'grafana-6b9f8d7c5-w9r4n', node: 'k3s-infer-node-1' }),
    ],
    workloads: [],
    events: [],
    summary: {
      nodes: 1,
      nodesReady: 1,
      pods: 2,
      podsRunning: 2,
      podsUnhealthy: 0,
      workloads: 0,
      workloadsUnready: 0,
      warningEvents: 0,
    },
    gpu,
  };
}

async function renderPage(overview: K8sOverview) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/demo') return fakeResponse({ demo: false });
      if (url === '/api/k8s/clusters') return fakeResponse({ clusters: [CLUSTER] });
      if (url === '/api/k8s/clusters/c1/overview') return fakeResponse(overview);
      return fakeResponse({ error: `unexpected ${url}` }, 500);
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(MemoryRouter, null, createElement(ToastProvider, null, createElement(K8s))));
  });
  return container;
}

describe('K8s 页 · HAMi 接线', () => {
  it('有 HAMi：渲染「GPU 分配（HAMi）」卡片，Pod 表出现 vGPU 列', async () => {
    await renderPage(overviewFixture(gpuFixture()));
    const text = container?.textContent ?? '';

    expect(text).toContain('GPU 分配（HAMi）');
    expect(text).toContain('k3s-infer-node-1');
    // Pod 表的 vGPU 列（表头 + 单元格）
    const heads = [...(container?.querySelectorAll('th') ?? [])].map((th) => th.textContent);
    expect(heads).toContain('vGPU');
    expect(text).toContain('12 GiB · 40%');
    // 没有分配的 Pod 显示「—」（不出现 NaN/undefined）
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
  });

  it('没有 HAMi（hasHami:false）：卡片与 vGPU 列都不出现', async () => {
    await renderPage(
      overviewFixture({
        hasHami: false,
        nodes: [],
        pods: [],
        totals: { gpuCount: 0, memMiB: 0, cores: 0, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 },
        warnings: [],
      }),
    );
    const text = container?.textContent ?? '';
    expect(text).not.toContain('GPU 分配（HAMi）');
    const heads = [...(container?.querySelectorAll('th') ?? [])].map((th) => th.textContent);
    expect(heads).not.toContain('vGPU');
    // 其余照常渲染
    expect(text).toContain('vllm-qwen27b-0');
  });

  it('服务端根本没有 gpu 字段（旧版）：同样不渲染卡片，页面不报错', async () => {
    await renderPage(overviewFixture(undefined));
    const text = container?.textContent ?? '';
    expect(text).not.toContain('GPU 分配（HAMi）');
    expect([...(container?.querySelectorAll('th') ?? [])].map((th) => th.textContent)).not.toContain('vGPU');
    expect(text).toContain('Kubernetes 集群');
  });
});
