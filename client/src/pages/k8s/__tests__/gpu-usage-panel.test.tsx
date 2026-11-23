// @vitest-environment jsdom
/**
 * GpuUsagePanel 渲染测试（jsdom）。
 *
 * 这张卡片的全部价值在于「两条口径并排放」，而它错起来都是**静默**的：
 *   · available:false 时顺手把整张卡藏掉 → 分配数据白白消失；
 *   · 实测 > 分配时进度条画出 130% 宽 → 看起来像样式 bug，看不出是超卖；
 *   · 缺字段时把 undefined / NaN 拼进文案 → 界面上出现「已分配 NaN GiB」。
 * 所以这里逐个钉死：文案逐字、进度条数值、颜色档位、四种状态、重试回路。
 *
 * api/client 被整体 mock：这张卡的请求路径与响应形状是 A2 的契约，
 * 测试只需要「喂一个响应 — 断言一遍渲染」，不该真的发 HTTP。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../api/client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../api/client';
import GpuUsagePanel from '../GpuUsagePanel';

// React 18 的 act 环境标记：不设的话每个用例都会打一条警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** mock 的 apiFetch（泛型签名在这里用不上，包一层省掉类型噪音）。 */
const mockFetch = apiFetch as unknown as {
  mock: { calls: unknown[][] };
  mockReset: () => void;
  mockResolvedValue: (value: unknown) => void;
  mockRejectedValue: (error: unknown) => void;
  mockReturnValue: (value: unknown) => void;
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockFetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/** 把这个用例产生的微任务（Promise.then → setState）都跑完。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 挂载卡片并把首屏请求跑完。 */
async function renderPanel(clusterId = 'c1'): Promise<HTMLDivElement> {
  act(() => {
    root.render(createElement(GpuUsagePanel, { clusterId }));
  });
  await flush();
  return container;
}

/** 一条进度条（分配 / 实测，顺序即渲染顺序）。 */
function bars(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="progressbar"]'));
}

/** 按钮文案匹配。 */
function buttonByText(text: string): HTMLButtonElement | null {
  const found = Array.from(container.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes(text),
  );
  return found ?? null;
}

/** 一份「有分配、也有实测」的正常响应（48 GiB 卡，已分配 12 GiB，实测 3.2 GiB）。 */
function normalUsage() {
  return {
    available: true,
    scrapedAt: '2026-11-24T02:00:00.000Z',
    nodes: [
      {
        name: 'gpu-node-1',
        devices: [
          {
            uuid: 'GPU-86d14e75-1e54-4a6f-9d6c-0a1b2c3d4e5f',
            type: 'NVIDIA GeForce RTX 4090',
            totalMemMiB: 49152,
            allocMemMiB: 12288,
            allocCores: 25,
            usedMemMiB: 3277,
            utilPercent: 41,
            pods: 2,
          },
          {
            uuid: 'GPU-11aa22bb-3344-5566-7788-99aabbccddee',
            type: 'NVIDIA GeForce RTX 4090',
            totalMemMiB: 49152,
            allocMemMiB: 49152,
            allocCores: 100,
            usedMemMiB: 6144,
            utilPercent: 12,
            pods: 1,
          },
        ],
      },
    ],
  };
}

describe('GpuUsagePanel', () => {
  it('正常渲染：每张卡一行「型号 · 已分配 x/y GiB（%）· 实测占用 z GiB（%）· util %」+ 两条进度条', async () => {
    mockFetch.mockResolvedValue(normalUsage());
    await renderPanel();

    // 请求路径逐字对齐 A2 的契约
    expect(mockFetch.mock.calls).toHaveLength(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/k8s/clusters/c1/usage');

    const text = container.textContent ?? '';
    expect(text).toContain('GPU 分配 vs 实际使用');
    expect(text).toContain('gpu-node-1');
    expect(text).toContain(
      'NVIDIA GeForce RTX 4090 · 已分配 12.0/48.0 GiB（25%）· 实测占用 3.2 GiB（7%）· util 41%',
    );
    expect(text).toContain(
      'NVIDIA GeForce RTX 4090 · 已分配 48.0/48.0 GiB（100%）· 实测占用 6.0 GiB（13%）· util 12%',
    );

    // 两张卡各两条条：分配（主题色 accent）+ 实测（绿色 emerald）
    const all = bars();
    expect(all).toHaveLength(4);
    expect(all[0].getAttribute('aria-valuenow')).toBe('25');
    expect(all[0].className).toContain('bg-accent-500');
    expect(all[1].getAttribute('aria-valuenow')).toBe('7');
    expect(all[1].className).toContain('bg-emerald-400');
    // 宽度用真实百分比，不是 0 也不是全宽
    expect(all[0].style.width).toBe('25%');
    expect(all[1].style.width).toBe('7%');
  });

  it('available:false：出琥珀提示条（带 reason），分配部分照常渲染', async () => {
    mockFetch.mockResolvedValue({
      available: false,
      reason: 'HAMi scheduler metrics 抓取超时',
      scrapedAt: '2026-11-24T02:00:00.000Z',
      nodes: [
        {
          name: 'gpu-node-1',
          devices: [
            {
              uuid: 'GPU-86d14e75-1e54-4a6f-9d6c-0a1b2c3d4e5f',
              type: 'NVIDIA GeForce RTX 4090',
              totalMemMiB: 49152,
              allocMemMiB: 12288,
              allocCores: 25,
              pods: 2,
            },
          ],
        },
      ],
    });
    await renderPanel();

    const text = container.textContent ?? '';
    expect(text).toContain('实测占用不可用：');
    expect(text).toContain('HAMi scheduler metrics 抓取超时');

    // 关键：分配数据**没有**被藏起来
    expect(text).toContain('已分配 12.0/48.0 GiB（25%）');
    expect(text).toContain('NVIDIA GeForce RTX 4090');
    expect(bars()).toHaveLength(2);
    // 提示条是琥珀色系
    const banner = container.querySelector('.bg-amber-500\\/10');
    expect(banner).not.toBeNull();
  });

  it('available:false 且没给 reason：退回落底文案，仍然不藏分配', async () => {
    mockFetch.mockResolvedValue({
      available: false,
      nodes: [
        {
          name: 'gpu-node-1',
          devices: [{ uuid: 'GPU-aaaa1111-2222', type: 'A10', totalMemMiB: 24576, allocMemMiB: 24576 }],
        },
      ],
    });
    await renderPanel();

    const text = container.textContent ?? '';
    expect(text).toContain('HAMi 未上报实测指标');
    expect(text).toContain('已分配 24.0/24.0 GiB（100%）');
  });

  it('空 devices：显示空态，不渲染任何进度条', async () => {
    mockFetch.mockResolvedValue({ available: true, nodes: [{ name: 'gpu-node-1', devices: [] }] });
    await renderPanel();

    const text = container.textContent ?? '';
    expect(text).toContain('还没有读到 GPU 设备');
    expect(bars()).toHaveLength(0);
    // 空态不该同时冒出「不可用」提示条（这里是数据为空，不是抓取失败）
    expect(text).not.toContain('实测占用不可用：');
  });

  it('字段缺失：全部显示「—」，绝不出现 NaN / undefined', async () => {
    mockFetch.mockResolvedValue({
      available: true,
      nodes: [{ name: 'gpu-node-1', devices: [{ uuid: 'GPU-abcdef12-1e54-4a6f' }] }],
    });
    await renderPanel();

    const text = container.textContent ?? '';
    // 没有型号 → 短 UUID 当标识；其余字段全缺 → 逐段「—」
    expect(text).toContain('GPU-abcd… · 已分配 —/— GiB（—）· 实测占用 — GiB（—）· util —');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');

    const all = bars();
    expect(all).toHaveLength(2);
    expect(all[0].getAttribute('aria-valuenow')).toBe('0');
    expect(all[1].getAttribute('aria-valuenow')).toBe('0');
  });

  it('夹取：分配超过容量夹到 100%；实测 > 分配时实测条夹到 100% 并变黄 + 提示', async () => {
    mockFetch.mockResolvedValue({
      available: true,
      nodes: [
        {
          name: 'gpu-node-1',
          devices: [
            // 卡 1：分配 48 GiB（满）、实测 60 GiB（超卖）
            {
              uuid: 'GPU-over-0001',
              type: 'A10',
              totalMemMiB: 49152,
              allocMemMiB: 12288,
              usedMemMiB: 20480,
              utilPercent: 140,
            },
            // 卡 2：分配 60 GiB > 容量 48 GiB（HAMi 超卖比例没配好）
            {
              uuid: 'GPU-over-0002',
              type: 'A10',
              totalMemMiB: 49152,
              allocMemMiB: 61440,
              usedMemMiB: 1024,
              utilPercent: 3,
            },
          ],
        },
      ],
    });
    await renderPanel();

    const all = bars();
    expect(all).toHaveLength(4);
    // 卡 1：分配 25%，实测 42% → 超卖 → 夹到 100% + 琥珀
    expect(all[0].getAttribute('aria-valuenow')).toBe('25');
    expect(all[1].getAttribute('aria-valuenow')).toBe('100');
    expect(all[1].className).toContain('bg-amber-400');
    expect(all[1].style.width).toBe('100%');
    // 卡 2：分配 125% → 夹到 100%；util 140 → 夹到 100%
    expect(all[2].getAttribute('aria-valuenow')).toBe('100');
    expect(all[2].style.width).toBe('100%');
    expect(all[3].getAttribute('aria-valuenow')).toBe('2');

    const text = container.textContent ?? '';
    expect(text).toContain('实测占用超过分配');
    expect(text).toContain('util 100%');
    // 越界数字不会被原样打印出来
    expect(text).not.toContain('140%');
    expect(text).not.toContain('125%');
  });

  it('加载态：请求未返回时显示加载文案，刷新按钮禁用', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    act(() => {
      root.render(createElement(GpuUsagePanel, { clusterId: 'c1' }));
    });
    await flush();

    const text = container.textContent ?? '';
    expect(text).toContain('正在读取 GPU 使用数据…');
    expect(buttonByText('刷新')?.disabled).toBe(true);
    expect(bars()).toHaveLength(0);
  });

  it('请求失败：显示错误与重试；点重试重新拉取并渲染数据', async () => {
    mockFetch.mockRejectedValue(new Error('集群 API 不可达'));
    await renderPanel();

    const text = container.textContent ?? '';
    expect(text).toContain('GPU 使用数据读取失败：集群 API 不可达');
    const retry = buttonByText('重试');
    expect(retry).not.toBeNull();

    // 第二次请求成功 → 卡片从错误态翻到数据态
    mockFetch.mockResolvedValue(normalUsage());
    act(() => {
      retry?.click();
    });
    await flush();

    expect(mockFetch.mock.calls).toHaveLength(2);
    expect(container.textContent ?? '').toContain('已分配 12.0/48.0 GiB（25%）');
    expect(container.textContent ?? '').not.toContain('读取失败');
  });

  it('demo 响应带 demo 标记：卡片角标显示「演示数据」', async () => {
    mockFetch.mockResolvedValue({ ...normalUsage(), demo: true });
    await renderPanel();

    const badge = Array.from(container.querySelectorAll('span')).find(
      (span) => (span.textContent ?? '').trim() === '演示数据',
    );
    expect(badge).toBeDefined();
  });

  it('非 demo 响应不出现「演示数据」角标', async () => {
    mockFetch.mockResolvedValue(normalUsage());
    await renderPanel();

    const text = container.textContent ?? '';
    expect(text).not.toContain('演示数据');
  });
});
