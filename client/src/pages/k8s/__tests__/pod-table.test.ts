// @vitest-environment jsdom
/**
 * PodTable 渲染测试（jsdom）。
 *
 * 纯函数测试覆盖了「判断」，这里覆盖「显示」：OOM / CrashLoop / 重启标记必须真的出现在
 * 行里，点行必须能打开日志（onSelect 被调用），namespace 过滤必须能改变可见行数。
 * 之所以值得测：这三个都是「看起来没问题但点不动」的典型位置 ——
 * 标记忘了渲染、行上没挂 onClick、select 的 value 绑错都不会报错。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PodTable from '../PodTable';
import type { K8sPod } from '../types';

// React 18 的 act 环境标记：不设的话每个用例都会打一条警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pod(over: Partial<K8sPod> = {}): K8sPod {
  return {
    namespace: 'default',
    name: 'web-1',
    phase: 'Running',
    ready: '1/1',
    restarts: 0,
    node: 'node-1',
    ip: '10.0.0.1',
    created: new Date(Date.now() - 3 * 3600_000).toISOString(),
    oom: false,
    crashLoop: false,
    containers: [{ name: 'main', ready: true, restarts: 0, state: 'running' }],
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

function renderTable(element: ReturnType<typeof createElement>) {
  act(() => {
    root.render(element);
  });
  return container;
}

describe('PodTable', () => {
  it('渲染每行并显示 CrashLoop / OOM / 重启标记', () => {
    const pods = [
      pod({ name: 'web-1', crashLoop: true, restarts: 7, ready: '0/1', phase: 'Running' }),
      pod({ name: 'worker-1', oom: true }),
      pod({ name: 'ok-1' }),
    ];
    renderTable(
      createElement(PodTable, {
        pods,
        namespaces: ['default'],
        namespace: '',
        onNamespaceChange: () => {},
        onSelect: () => {},
      }),
    );

    const text = container.textContent ?? '';
    expect(text).toContain('web-1');
    expect(text).toContain('worker-1');
    expect(text).toContain('ok-1');
    expect(text).toContain('CrashLoopBackOff');
    expect(text).toContain('OOMKilled');
    expect(text).toContain('重启 7 次');

    // 3 个 Pod → 3 个数据行
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('异常 Pod 排在前面（error → warn → ok）', () => {
    renderTable(
      createElement(PodTable, {
        pods: [pod({ name: 'ok-1' }), pod({ name: 'bad-1', oom: true })],
        namespaces: ['default'],
        namespace: '',
        onNamespaceChange: () => {},
        onSelect: () => {},
      }),
    );
    const firstRow = container.querySelector('tbody tr');
    expect(firstRow?.textContent).toContain('bad-1');
  });

  it('点击行调用 onSelect 并带上该 Pod', () => {
    const onSelect = vi.fn();
    renderTable(
      createElement(PodTable, {
        pods: [pod({ name: 'web-1' }), pod({ name: 'web-2' })],
        namespaces: ['default'],
        namespace: '',
        onNamespaceChange: () => {},
        onSelect,
      }),
    );

    const rows = container.querySelectorAll('tbody tr');
    act(() => {
      rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ name: 'web-2' });
  });

  it('回车也能打开日志（键盘可达）', () => {
    const onSelect = vi.fn();
    renderTable(
      createElement(PodTable, {
        pods: [pod({ name: 'web-1' })],
        namespaces: ['default'],
        namespace: '',
        onNamespaceChange: () => {},
        onSelect,
      }),
    );
    const row = container.querySelector('tbody tr');
    act(() => {
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('按 namespace prop 过滤可见行', () => {
    renderTable(
      createElement(PodTable, {
        pods: [
          pod({ namespace: 'default', name: 'web-1' }),
          pod({ namespace: 'kube-system', name: 'coredns' }),
        ],
        namespaces: ['default', 'kube-system'],
        namespace: 'kube-system',
        onNamespaceChange: () => {},
        onSelect: () => {},
      }),
    );
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('coredns');
  });

  it('切换命名空间下拉时回调新值', () => {
    const onNamespaceChange = vi.fn();
    renderTable(
      createElement(PodTable, {
        pods: [pod({ namespace: 'default', name: 'web-1' })],
        namespaces: ['default', 'kube-system'],
        namespace: '',
        onNamespaceChange,
        onSelect: () => {},
      }),
    );
    const select = container.querySelector('select');
    expect(select).not.toBeNull();
    // 受控 select 必须走原生 setter，否则 React 的 value tracker 会吞掉 change
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(select, 'kube-system');
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onNamespaceChange).toHaveBeenCalledWith('kube-system');
  });

  it('空集群给出空状态文案', () => {
    renderTable(
      createElement(PodTable, {
        pods: [],
        namespaces: [],
        namespace: '',
        onNamespaceChange: () => {},
        onSelect: () => {},
      }),
    );
    expect(container.textContent).toContain('这个集群没有读到 Pod');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
  });

  it('过滤后为空时提示当前过滤条件没有 Pod', () => {
    renderTable(
      createElement(PodTable, {
        pods: [pod({ namespace: 'default', name: 'web-1' })],
        namespaces: ['default', 'kube-system'],
        namespace: 'kube-system',
        onNamespaceChange: () => {},
        onSelect: () => {},
      }),
    );
    expect(container.textContent).toContain('当前过滤条件下没有 Pod');
  });
});