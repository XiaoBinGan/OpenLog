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
import {
  deviceLabel,
  formatMibRaw,
  formatSlots,
  gpuCardsLabel,
  gpuDeviceGroups,
  nodeCardsLabel,
  sameGpuId,
  shortGpuId,
} from '../k8s/utils';
import type { K8sClusterView, K8sGpuNode, K8sGpuOverview, K8sOverview, K8sPod } from '../k8s/types';

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

// ─── 真机格式（243）：物理卡型号 / 容量 / 槽位 ────────────────────────────
//
// 数据取自 /tmp/hami-real-format.md 的实测 payload：
//   · 节点 `hami.io/node-nvidia-register` → 两张卡：RTX 5090 32607 MiB（10 槽）+ RTX 4090 49140 MiB（10 槽）
//   · Pod 注解 `hami.io/vgpu-devices-allocated` 是四段 `<uuid>,<type>,<memMiB>,<cores>`
// 服务端（并行 agent）负责解析成 devices / physicalCount / slots，这里只测「拿到这些字段后怎么显示」。

const GPU_4090 = 'GPU-86d14e75-1e54-3aed-e483-6652a4c30653';
const GPU_5090 = 'GPU-6b12533d-bcfb-25b6-bafe-5a8d5bd85d07';

/** 243 的节点视图：2 张物理卡 · 20 个 vGPU 槽位 · 81747 MiB 显存 */
const REAL_NODE: K8sGpuNode = {
  name: 'node-243',
  count: 2,
  memMiB: 81747,
  cores: 200,
  allocatedMemMiB: 57344,
  allocatedCores: 130,
  podCount: 4,
  devices: [
    {
      id: GPU_5090,
      type: 'NVIDIA GeForce RTX 5090',
      memMiB: 32607,
      cores: 100,
      slots: 10,
      allocatedMemMiB: 28672,
      allocatedCores: 60,
      podCount: 2,
    },
    {
      id: GPU_4090,
      type: 'NVIDIA GeForce RTX 4090',
      memMiB: 49140,
      cores: 100,
      slots: 10,
      allocatedMemMiB: 28672,
      allocatedCores: 70,
      podCount: 3,
    },
  ],
};

function realGpuFixture(over: Partial<K8sGpuOverview> = {}): K8sGpuOverview {
  return {
    hasHami: true,
    nodes: [REAL_NODE],
    pods: [
      {
        namespace: 'inference',
        name: 'vllm-qwen27b-0',
        nodeName: 'node-243',
        devices: [{ id: GPU_5090, type: 'NVIDIA', memMiB: 24576, cores: 50 }],
        totalMemMiB: 24576,
        totalCores: 50,
        phase: 'Running',
      },
      {
        // 跨两张卡：`<5090>,NVIDIA,4096,10:;<4090>,NVIDIA,8192,20:;`
        namespace: 'inference',
        name: 'sglang-router-6c8f7d9b-2xk4p',
        nodeName: 'node-243',
        devices: [
          { id: GPU_5090, type: 'NVIDIA', memMiB: 4096, cores: 10 },
          { id: GPU_4090, type: 'NVIDIA', memMiB: 8192, cores: 20 },
        ],
        totalMemMiB: 12288,
        totalCores: 30,
        phase: 'Running',
      },
      {
        namespace: 'inference',
        name: 'embedding-bge-m3-0',
        nodeName: 'node-243',
        devices: [{ id: GPU_4090, type: 'NVIDIA', memMiB: 8192, cores: 20 }],
        totalMemMiB: 8192,
        totalCores: 20,
        phase: 'Running',
      },
      {
        // 注解里的 UUID 与 register 对不上（升级/迁移常见）→ 落到「未匹配到物理卡」
        namespace: 'inference',
        name: 'vllm-canary-0',
        nodeName: 'node-243',
        devices: [{ id: 'GPU-ffffffff-0000-4000-8000-000000000000', type: 'NVIDIA', memMiB: 12288, cores: 30 }],
        totalMemMiB: 12288,
        totalCores: 30,
        phase: 'Running',
      },
    ],
    totals: {
      gpuCount: 20,
      memMiB: 81747,
      cores: 200,
      allocatedMemMiB: 57344,
      allocatedCores: 130,
      podCount: 4,
      physicalCount: 2,
      slots: 20,
    },
    warnings: [],
    ...over,
  };
}

describe('GpuAllocation 卡片 · 真机格式（物理卡）', () => {
  it('表头显示「N 张物理卡 · M 个 vGPU 槽位」', () => {
    renderCard(realGpuFixture());
    const text = container?.textContent ?? '';
    expect(text).toContain('2 张物理卡 · 20 个 vGPU 槽位');
    expect(text).toContain('4 个 Pod 占用');
  });

  it('节点下面按物理卡列一行：型号 · 显存 · 槽位 · 已分配（%）', () => {
    renderCard(realGpuFixture());
    const text = container?.textContent ?? '';
    // 4090：28672 / 49140 = 58%
    expect(text).toContain('NVIDIA GeForce RTX 4090 · 49140 MiB · 10 槽位 · 已分配 28672 MiB（58%）');
    // 5090：28672 / 32607 = 88%
    expect(text).toContain('NVIDIA GeForce RTX 5090 · 32607 MiB · 10 槽位 · 已分配 28672 MiB（88%）');
    // 节点行也报真机口径（物理卡 + 槽位），不是含混的「20 张卡」
    expect(text).toContain('2 张物理卡 · 20 个槽位');
    expect(text).not.toContain('20 张卡');
  });

  it('Pod 挂在它实际占的那张卡下面，且只算该卡那一段显存/算力', () => {
    renderCard(realGpuFixture());
    const text = container?.textContent ?? '';
    // 跨卡 Pod 在两张卡下各出现一次，显存分别是 4 GiB / 8 GiB（不是合计 12 GiB）
    expect(text).toContain('sglang-router-6c8f7d9b-2xk4p');
    expect(text).toContain('4 GiB');
    expect(text).toContain('8 GiB');
    expect(text).toContain('24 GiB');
    expect(text).toContain('50%');
    // 对不上 register 的 Pod 不静默丢弃
    expect(text).toContain('未匹配到物理卡（1 个 Pod）');
    expect(text).toContain('vllm-canary-0');
  });

  it('没有 type 时只显示短 id（GPU-86d1…），不写「未知型号」', () => {
    renderCard(
      realGpuFixture({
        nodes: [
          {
            ...REAL_NODE,
            devices: [
              { id: GPU_4090, memMiB: 49140, cores: 100, slots: 10, allocatedMemMiB: 0, allocatedCores: 0, podCount: 1 },
            ],
          },
        ],
        totals: { gpuCount: 10, memMiB: 49140, cores: 100, allocatedMemMiB: 0, allocatedCores: 0, podCount: 1 },
      }),
    );
    const text = container?.textContent ?? '';
    expect(text).toContain('GPU-86d1…');
    expect(text).toContain('49140 MiB · 10 槽位 · 已分配 0 MiB（0%）');
    expect(text).not.toContain('未知型号');
    expect(text).not.toContain('NaN');
  });

  it('没有物理卡明细（旧服务端 / 演示数据）时退回「N 张卡」与节点级平铺表', () => {
    renderCard(
      realGpuFixture({
        nodes: [{ ...REAL_NODE, devices: undefined }],
        totals: {
          gpuCount: 4,
          memMiB: 98304,
          cores: 400,
          allocatedMemMiB: 16384,
          allocatedCores: 50,
          podCount: 2,
        },
      }),
    );
    const text = container?.textContent ?? '';
    expect(text).toContain('4 张卡');
    expect(text).not.toContain('张物理卡');
    expect(text).not.toContain('槽位');
    // Pod 仍然列出来（只是没有物理卡分层）
    expect(text).toContain('vllm-qwen27b-0');
  });

  it('物理卡字段全空/为 0：显示「—」，不出现 NaN / undefined / Infinity', () => {
    renderCard(
      realGpuFixture({
        nodes: [
          {
            name: 'node-empty',
            count: 0,
            memMiB: 0,
            cores: 0,
            allocatedMemMiB: 0,
            allocatedCores: 0,
            podCount: 1,
            devices: [
              { id: '', memMiB: 0, cores: 0, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 },
            ],
          },
        ],
        pods: [
          {
            namespace: 'inference',
            name: 'half-parsed',
            nodeName: 'node-empty',
            devices: [],
            totalMemMiB: 0,
            totalCores: 0,
            phase: 'Running',
          },
        ],
        totals: {},
      }),
    );
    const text = container?.textContent ?? '';
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('Infinity');
    expect(text).toContain('—');
    expect(text).toContain('node-empty');
    expect(text).toContain('half-parsed');
  });
});

// ─── 纯函数（utils）：物理卡格式化与分组 ──────────────────────────────────

describe('k8s/utils · 物理卡格式化', () => {
  it('deviceLabel 按「有才写」拼：型号 → 显存 → 槽位 → 已分配（%）', () => {
    expect(
      deviceLabel({
        id: GPU_4090,
        type: 'NVIDIA GeForce RTX 4090',
        memMiB: 49140,
        cores: 100,
        slots: 10,
        allocatedMemMiB: 23552,
        allocatedCores: 40,
        podCount: 2,
      }),
    ).toBe('NVIDIA GeForce RTX 4090 · 49140 MiB · 10 槽位 · 已分配 23552 MiB（48%）');

    // 没有 type / 没有槽位：省略这两段，不写「未知」
    expect(deviceLabel({ id: GPU_4090, memMiB: 49140, cores: 100, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 })).toBe(
      'GPU-86d1… · 49140 MiB · 已分配 0 MiB（0%）',
    );

    // 全空 → 单个「—」
    expect(deviceLabel({ id: '', memMiB: 0, cores: 0, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 })).toBe('—');
  });

  it('formatMibRaw 保留 MiB 原文（能和 register 的 devmem 直接对照）', () => {
    expect(formatMibRaw(49140)).toBe('49140 MiB');
    expect(formatMibRaw(0)).toBe('0 MiB');
    expect(formatMibRaw(undefined)).toBe('—');
    expect(formatMibRaw(Number.NaN)).toBe('—');
    expect(formatMibRaw(-1)).toBe('—');
  });

  it('formatSlots / shortGpuId 的边界', () => {
    expect(formatSlots(10)).toBe('10 槽位');
    expect(formatSlots(0)).toBe('—');
    expect(shortGpuId(GPU_4090)).toBe('GPU-86d1…');
    expect(shortGpuId('')).toBe('—');
  });

  it('gpuCardsLabel：有 physicalCount/slots 用真机口径，缺了退回「N 张卡」', () => {
    const base = { gpuCount: 20, memMiB: 0, cores: 0, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 };
    expect(gpuCardsLabel({ ...base, physicalCount: 2, slots: 20 })).toBe('2 张物理卡 · 20 个 vGPU 槽位');
    expect(gpuCardsLabel({ ...base, physicalCount: 2 })).toBe('2 张物理卡');
    expect(gpuCardsLabel(base)).toBe('20 张卡');
    expect(gpuCardsLabel({ ...base, gpuCount: 0 })).toBe('0 张卡');
  });

  it('nodeCardsLabel：有 devices 报物理卡+槽位，否则报 N 张卡', () => {
    expect(nodeCardsLabel(REAL_NODE)).toBe('2 张物理卡 · 20 个槽位');
    expect(nodeCardsLabel({ ...REAL_NODE, devices: [] })).toBe('2 张卡');
    expect(nodeCardsLabel(null)).toBe('卡数未知');
  });

  it('sameGpuId 严格比对（忽略大小写、空串不命中）', () => {
    expect(sameGpuId(GPU_4090, GPU_4090)).toBe(true);
    expect(sameGpuId(GPU_4090.toLowerCase(), GPU_4090)).toBe(true);
    expect(sameGpuId('GPU-86d1', GPU_4090)).toBe(false);
    expect(sameGpuId('', '')).toBe(false);
  });

  it('gpuDeviceGroups：按卡分组、只算该卡那一段、匹配不上的进 unassigned', () => {
    const pods = realGpuFixture().pods;
    const { groups, unassigned } = gpuDeviceGroups(REAL_NODE, pods);
    expect(groups).toHaveLength(2);

    const byId = new Map(groups.map((group) => [group.device.id, group]));
    const on4090 = byId.get(GPU_4090);
    // 4090 上：sglang-router 的 8192/20 + embedding 的 8192/20
    expect(on4090?.allocations.map((a) => [a.pod.name, a.memMiB, a.cores])).toEqual([
      ['sglang-router-6c8f7d9b-2xk4p', 8192, 20],
      ['embedding-bge-m3-0', 8192, 20],
    ]);
    const on5090 = byId.get(GPU_5090);
    expect(on5090?.allocations.map((a) => [a.pod.name, a.memMiB])).toEqual([
      ['vllm-qwen27b-0', 24576],
      ['sglang-router-6c8f7d9b-2xk4p', 4096],
    ]);
    expect(unassigned.map((a) => a.pod.name)).toEqual(['vllm-canary-0']);

    // 没有 devices 的旧服务端：空分组 + 不把 Pod 塞进 unassigned（交给平铺表）
    expect(gpuDeviceGroups({ ...REAL_NODE, devices: undefined }, pods)).toEqual({ groups: [], unassigned: [] });
  });

  it('gpuDeviceGroups：短 id 前缀匹配只在唯一命中时成立', () => {
    const node: K8sGpuNode = {
      ...REAL_NODE,
      devices: [
        { ...REAL_NODE.devices![0], id: 'GPU-aaaa1111-0000-4000-8000-000000000001' },
        { ...REAL_NODE.devices![1], id: 'GPU-aaaa1111-0000-4000-8000-000000000002' },
      ],
    };
    const makePod = (id: string) => ({
      namespace: 'inference',
      name: `pod-${id.slice(-2)}`,
      nodeName: 'node-243',
      devices: [{ id, memMiB: 1024, cores: 5 }],
      totalMemMiB: 1024,
      totalCores: 5,
      phase: 'Running',
    });
    // 唯一前缀 → 命中第一张卡
    const unique = gpuDeviceGroups(node, [makePod('GPU-aaaa1111-0000-4000-8000-000000000001')]);
    expect(unique.groups[0].allocations).toHaveLength(1);
    expect(unique.unassigned).toHaveLength(0);
    // 前缀同时命中两张卡 → 不猜，进 unassigned
    const ambiguous = gpuDeviceGroups(node, [makePod('GPU-aaaa1111')]);
    expect(ambiguous.groups[0].allocations).toHaveLength(0);
    expect(ambiguous.unassigned).toHaveLength(1);
  });
});
