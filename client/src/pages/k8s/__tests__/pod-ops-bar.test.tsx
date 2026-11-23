// @vitest-environment jsdom
/**
 * PodOpsBar 渲染 + 交互测试（jsdom，无 testing-library —— 与 PodTable 测试同一套手搓 act 环境）。
 *
 * 这一组用例盯的是「点下去之后到底发生了什么」，因为操作条的错误都不会抛到界面上：
 *   · 二次确认漏了 → 一次误点就把线上 Pod 删了（静默事故）；
 *   · 403/409 不上锁 → 用户反复点、反复吃同一个错误；
 *   · loading 态没禁用 → 双击发出两次删除；
 *   · scale 非法值没拦 → 后端 400，或者更糟，发了个 3.5 副本。
 * 这些都不会让页面白屏，只会让事情悄悄做错，所以必须逐条钉死请求参数。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PodOpsBar from '../PodOpsBar';
import { apiFetch, ApiError } from '../../../api/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Toast 上下文用桩替身：只关心「弹了什么文案」。 */
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => toast,
}));

vi.mock('../../../api/client', () => {
  class MockApiError extends Error {
    readonly status: number;
    readonly url: string;
    readonly body: unknown;

    constructor(message: string, status: number, url: string, body: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.url = url;
      this.body = body;
      Object.setPrototypeOf(this, MockApiError.prototype);
    }
  }
  return { apiFetch: vi.fn(), ApiError: MockApiError };
});

const apiFetchMock = vi.mocked(apiFetch);

const CLUSTER = 'c-1';
const WORKLOAD = { kind: 'deployments' as const, name: 'web' };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  toast.warning.mockReset();
  toast.info.mockReset();
  apiFetchMock.mockReset();
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

interface RenderOverrides {
  clusterId?: string;
  namespace?: string;
  podName?: string;
  workload?: { kind: 'deployments' | 'statefulsets'; name: string };
  onDone?: () => void;
}

/** 渲染操作条并返回查询器（每个用例都从干净的 DOM 开始）。 */
function renderPodOpsBar(over: RenderOverrides = {}): void {
  const props = {
    clusterId: CLUSTER,
    namespace: 'default',
    podName: 'web-1',
    ...over,
  };
  act(() => {
    root.render(createElement(PodOpsBar, props));
  });
}

function byId<T extends HTMLElement = HTMLButtonElement>(testId: string): T | null {
  return container.querySelector(`[data-testid="${testId}"]`) as T | null;
}

function textOf(testId: string): string {
  return byId(testId)?.textContent ?? '';
}

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** 受控 input 必须走原生 setter，否则 React 的 value tracker 会吞掉这次输入。 */
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 手动控制 resolve 时机，用于断言 loading 态。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function forbidden(): ApiError {
  const message = '写操作未启用（OPENLOG_K8S_WRITE=1 后生效）';
  return new ApiError(message, 403, '/api/k8s/clusters/c-1', { error: message, readOnly: true });
}

function demoMode(): ApiError {
  const message = '演示模式：该操作已被禁用';
  return new ApiError(message, 409, '/api/k8s/clusters/c-1', { error: message });
}

/** 打开删除确认并点击确认（两次点击是契约里的「二次确认」）。 */
async function confirmDelete(): Promise<void> {
  await click(byId('pod-ops-delete'));
  await click(byId('pod-ops-delete-confirm-yes'));
}

describe('PodOpsBar 渲染', () => {
  it('有 workload 时渲染删除 / 重启 / 扩缩容三个按钮', () => {
    renderPodOpsBar({ workload: WORKLOAD });
    expect(textOf('pod-ops-delete')).toContain('删除 Pod');
    expect(textOf('pod-ops-restart')).toContain('重启工作负载');
    expect(textOf('pod-ops-scale')).toContain('扩缩容');
    // 默认不展开任何表单/确认条
    expect(byId('pod-ops-delete-confirm')).toBeNull();
    expect(byId('pod-ops-scale-form')).toBeNull();
  });

  it('没有 workload 时只剩删除（独立 Pod 没有可重启/可扩缩的工作负载）', () => {
    renderPodOpsBar();
    expect(byId('pod-ops-delete')).not.toBeNull();
    expect(byId('pod-ops-restart')).toBeNull();
    expect(byId('pod-ops-scale')).toBeNull();
  });
});

describe('PodOpsBar 删除', () => {
  it('第一次点击只展开二次确认，不发请求', async () => {
    renderPodOpsBar({ workload: WORKLOAD });
    await click(byId('pod-ops-delete'));
    expect(byId('pod-ops-delete-confirm')).not.toBeNull();
    expect(container.textContent).toContain('确认删除');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('取消二次确认后不调用接口，确认条收起', async () => {
    renderPodOpsBar({ workload: WORKLOAD });
    await click(byId('pod-ops-delete'));
    await click(byId('pod-ops-delete-confirm-cancel'));
    expect(byId('pod-ops-delete-confirm')).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('确认后按契约发出 DELETE 请求，成功后 toast + onDone', async () => {
    const onDone = vi.fn();
    apiFetchMock.mockResolvedValueOnce({ ok: true, auditId: 'audit-1' });

    renderPodOpsBar({ workload: WORKLOAD, onDone });
    await confirmDelete();

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/api/k8s/clusters/c-1/pods/default/web-1');
    expect(init?.method).toBe('DELETE');
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(String(toast.success.mock.calls[0][0])).toContain('web-1');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('PodOpsBar 重启工作负载', () => {
  it('deployments 走 /workloads/:ns/deployments/:name/restart（POST）', async () => {
    const onDone = vi.fn();
    apiFetchMock.mockResolvedValueOnce({ ok: true, auditId: 'audit-2' });

    renderPodOpsBar({ workload: WORKLOAD, onDone });
    await click(byId('pod-ops-restart'));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/api/k8s/clusters/c-1/workloads/default/deployments/web/restart');
    expect(init?.method).toBe('POST');
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('statefulsets 的 kind 原样进路径', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true });
    renderPodOpsBar({ workload: { kind: 'statefulsets', name: 'db' } });
    await click(byId('pod-ops-restart'));
    expect(apiFetchMock.mock.calls[0][0]).toBe(
      '/api/k8s/clusters/c-1/workloads/default/statefulsets/db/restart',
    );
  });
});

describe('PodOpsBar 扩缩容', () => {
  it('填合法副本数后 POST /scale，body 是 { replicas }', async () => {
    const onDone = vi.fn();
    apiFetchMock.mockResolvedValueOnce({ ok: true, auditId: 'audit-3' });

    renderPodOpsBar({ workload: WORKLOAD, onDone });
    await click(byId('pod-ops-scale'));

    const input = byId<HTMLInputElement>('pod-ops-scale-input');
    expect(input).not.toBeNull();
    typeInto(input as HTMLInputElement, '3');
    await click(byId('pod-ops-scale-submit'));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/api/k8s/clusters/c-1/workloads/default/deployments/web/scale');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ replicas: 3 });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    // 生效后表单收起
    expect(byId('pod-ops-scale-form')).toBeNull();
  });

  it('副本数 0 与 1000 是边界内合法值', async () => {
    apiFetchMock.mockResolvedValue({ ok: true });
    renderPodOpsBar({ workload: WORKLOAD });

    await click(byId('pod-ops-scale'));
    typeInto(byId<HTMLInputElement>('pod-ops-scale-input') as HTMLInputElement, '0');
    await click(byId('pod-ops-scale-submit'));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await click(byId('pod-ops-scale'));
    typeInto(byId<HTMLInputElement>('pod-ops-scale-input') as HTMLInputElement, '1000');
    await click(byId('pod-ops-scale-submit'));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(apiFetchMock.mock.calls[1][1]?.body))).toEqual({ replicas: 1000 });
  });

  it.each(['', '-1', '1001', '3.5', 'abc', '1e3', ' 2 4 '])(
    '非法副本数 %j 被本地拦下：弹错误、不发请求',
    async (raw) => {
      renderPodOpsBar({ workload: WORKLOAD });
      await click(byId('pod-ops-scale'));
      typeInto(byId<HTMLInputElement>('pod-ops-scale-input') as HTMLInputElement, raw);
      await click(byId('pod-ops-scale-submit'));

      expect(apiFetchMock).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(String(toast.error.mock.calls[0][0])).toContain('0..1000');
      // 表单保留，让用户改数字而不是重新点一遍
      expect(byId('pod-ops-scale-form')).not.toBeNull();
    },
  );
});

describe('PodOpsBar 错误码', () => {
  it('403：弹后端原文并把按钮切成 disabled，title 指向 OPENLOG_K8S_WRITE=1', async () => {
    apiFetchMock.mockRejectedValueOnce(forbidden());
    renderPodOpsBar({ workload: WORKLOAD });

    await confirmDelete();

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0][0])).toContain('写操作未启用');

    for (const id of ['pod-ops-delete', 'pod-ops-restart', 'pod-ops-scale']) {
      const btn = byId(id);
      expect(btn?.disabled).toBe(true);
      expect(btn?.getAttribute('title') ?? '').toContain('OPENLOG_K8S_WRITE=1');
    }
  });

  it('403 之后重启/扩缩容不再发请求（已上锁）', async () => {
    apiFetchMock.mockRejectedValueOnce(forbidden());
    renderPodOpsBar({ workload: WORKLOAD });
    await confirmDelete();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await click(byId('pod-ops-restart'));
    await click(byId('pod-ops-scale'));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(byId('pod-ops-scale-form')).toBeNull();
  });

  it('409：提示「演示模式：该操作已被禁用」并禁用按钮', async () => {
    apiFetchMock.mockRejectedValueOnce(demoMode());
    renderPodOpsBar({ workload: WORKLOAD });

    await confirmDelete();

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0][0]).toBe('演示模式：该操作已被禁用');
    expect(byId('pod-ops-delete')?.disabled).toBe(true);
    expect(byId('pod-ops-restart')?.disabled).toBe(true);
    expect(byId('pod-ops-delete')?.getAttribute('title') ?? '').toContain('演示模式');
  });

  it('其它错误只弹错误信息，不锁按钮、不调 onDone', async () => {
    const onDone = vi.fn();
    apiFetchMock.mockRejectedValueOnce(new ApiError('集群连接超时', 500, '/x', { error: '集群连接超时' }));
    renderPodOpsBar({ workload: WORKLOAD, onDone });

    await confirmDelete();

    expect(toast.error).toHaveBeenCalledWith('集群连接超时');
    expect(onDone).not.toHaveBeenCalled();
    expect(byId('pod-ops-delete')?.disabled).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('网络异常（非 ApiError）也收敛成一句中文提示', async () => {
    apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderPodOpsBar({ workload: WORKLOAD });
    await confirmDelete();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0][0])).toContain('Failed to fetch');
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('PodOpsBar 进行中状态', () => {
  it('请求未返回时按钮 disabled + 文案变「删除中…」，返回后复原', async () => {
    const d = deferred<{ ok: boolean }>();
    apiFetchMock.mockReturnValueOnce(d.promise);
    const onDone = vi.fn();

    renderPodOpsBar({ workload: WORKLOAD, onDone });
    await click(byId('pod-ops-delete'));
    await click(byId('pod-ops-delete-confirm-yes'));

    expect(textOf('pod-ops-delete')).toContain('删除中…');
    expect(byId('pod-ops-delete')?.disabled).toBe(true);
    expect(byId('pod-ops-restart')?.disabled).toBe(true);
    expect(byId('pod-ops-bar')?.getAttribute('aria-busy')).toBe('true');
    // 请求还没回来，回调不该提前触发
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => {
      d.resolve({ ok: true });
    });

    expect(textOf('pod-ops-delete')).toContain('删除 Pod');
    expect(byId('pod-ops-delete')?.disabled).toBe(false);
    expect(byId('pod-ops-bar')?.getAttribute('aria-busy')).toBe('false');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('PodOpsBar 路径构造', () => {
  it('namespace / pod 名里的特殊字符被 encodeURIComponent 编码', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true });
    renderPodOpsBar({ namespace: 'team a/b', podName: 'web/1 x' });
    await confirmDelete();
    expect(apiFetchMock.mock.calls[0][0]).toBe(
      '/api/k8s/clusters/c-1/pods/team%20a%2Fb/web%2F1%20x',
    );
  });

  it('onDone 是可选 props：不传时成功路径照常走完', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true });
    renderPodOpsBar({ workload: WORKLOAD });
    await confirmDelete();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="pod-ops-bar"]')).not.toBeNull();
  });
});
