// @vitest-environment jsdom
/**
 * PolicyPanel 渲染测试（jsdom + 伪造 fetch）。
 *
 * 这张卡的价值全在「值 + 来源 + 原始 key=value」三者对得上，所以用例围绕后端
 * （A7：server/routes/k8s-policy.js）实际会返回的几种形状展开：
 *   · source:'args' + raw:[{key,value}]（启动参数命中，最常见）；
 *   · source:'default' + 值全 null + defaults（集群里没读到，但调度器跑在默认值上）；
 *   · source:'unknown' + reason（连不上 / 403 / 证书，读不到的原因要给出来）；
 *   · 值给了但认不出来（'some-new-policy'）→「未知」，不能被当成缺失去猜默认值。
 * 另外覆盖「缺失显示 —」、显存超卖三态、错误态 + 重试、demo 角标、URL 编码。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PolicyPanel from '../PolicyPanel';
import type { K8sPolicyResponse } from '../PolicyPanel';

// React 18 的 act 环境标记：不设的话每个用例都会打一条警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 只实现 apiFetch 用到的四个成员（ok / status / statusText / text）。 */
function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => text,
  } as unknown as Response;
}

/** 让 fetch 依次返回给定的响应（用完了就复用最后一个）。 */
function mockFetch(...responses: Response[]) {
  const spy = vi.fn(async () => responses[Math.min(spy.mock.calls.length - 1, responses.length - 1)]);
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** HAMi 默认值基线（后端每次都会带上）。 */
const DEFAULTS = { nodeSchedulerPolicy: 'binpack', deviceSchedulerPolicy: 'binpack', overcommit: false };

/** A7 形状 1：启动参数命中（raw 是数组）。 */
const ARGS_RESPONSE: K8sPolicyResponse = {
  nodeSchedulerPolicy: 'binpack',
  deviceSchedulerPolicy: 'spread',
  overcommit: true,
  resourceStrategy: 'binpack',
  source: 'args',
  raw: [
    { key: 'node-scheduler-policy', value: 'binpack' },
    { key: 'device-scheduler-policy', value: 'spread' },
    { key: 'overcommit', value: 'true' },
  ],
  defaults: DEFAULTS,
};

/** A7 形状 2：集群里没读到配置，只有默认值说明。 */
const DEFAULT_RESPONSE: K8sPolicyResponse = {
  nodeSchedulerPolicy: null,
  deviceSchedulerPolicy: null,
  overcommit: null,
  source: 'default',
  raw: [],
  defaults: DEFAULTS,
  note: '集群里没有读到 HAMi 调度参数',
};

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 渲染并等 fetch 的 promise 链全部落地（effect → apiFetch → setState）。 */
async function renderPanel(clusterId = 'c1') {
  await act(async () => {
    root.render(createElement(PolicyPanel, { clusterId }));
    // setTimeout(0) 一次性抽干微任务队列：apiFetch 里有 2 次 await
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

/** 取某一行的显示文本（按 data-field 定位，避免依赖行序）。 */
function rowText(field: string): string {
  const row = container.querySelector(`[data-testid="policy-row"][data-field="${field}"]`);
  return row?.textContent ?? '';
}

/** 取某一行的来源标签节点。 */
function sourceChip(field: string): HTMLElement | null {
  const row = container.querySelector(`[data-testid="policy-row"][data-field="${field}"]`);
  const chip = row?.querySelector('[data-testid="policy-source"]');
  return (chip as HTMLElement | null) ?? null;
}

describe('PolicyPanel', () => {
  it('正常渲染：三行标签 + binpack/spread 释义 + 显存超卖开启', async () => {
    const spy = mockFetch(jsonResponse(ARGS_RESPONSE));
    await renderPanel('c1');

    // 请求路径（clusterApiPath + '/policy'）
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe('/api/k8s/clusters/c1/policy');

    const text = container.textContent ?? '';
    expect(text).toContain('调度策略（HAMi）');
    expect(text).toContain('节点调度');
    expect(text).toContain('设备调度');
    expect(text).toContain('显存超卖');

    // 三行、顺序固定：节点 → 设备 → 显存超卖
    const rows = container.querySelectorAll('[data-testid="policy-row"]');
    expect(rows).toHaveLength(3);
    expect(rowText('nodeSchedulerPolicy')).toContain('binpack');
    expect(rowText('nodeSchedulerPolicy')).toContain('优先填满单卡');
    expect(rowText('deviceSchedulerPolicy')).toContain('spread');
    expect(rowText('deviceSchedulerPolicy')).toContain('优先打散');
    expect(rowText('overcommit')).toContain('开启');

    // 底部那句 binpack vs spread 对异构卡的解释
    expect(container.querySelector('[data-testid="policy-footer"]')?.textContent).toContain('异构');
    // 正常态没有琥珀提示、没有演示角标
    expect(container.querySelector('[data-testid="policy-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="policy-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="policy-demo-badge"]')).toBeNull();
  });

  it('source 是单个字符串（args）时三行共用「来自启动参数」，悬停给出原始 key=value', async () => {
    mockFetch(jsonResponse(ARGS_RESPONSE));
    await renderPanel();

    for (const field of ['nodeSchedulerPolicy', 'deviceSchedulerPolicy', 'overcommit']) {
      const chip = sourceChip(field);
      expect(chip?.textContent).toBe('来自启动参数');
      expect(chip?.getAttribute('data-source')).toBe('flag');
    }

    // raw 数组按参数名认领到各自的行，启动参数补回 `--`
    expect(sourceChip('nodeSchedulerPolicy')?.getAttribute('title')).toBe(
      '--node-scheduler-policy=binpack',
    );
    expect(sourceChip('deviceSchedulerPolicy')?.getAttribute('title')).toBe(
      '--device-scheduler-policy=spread',
    );
    expect(sourceChip('overcommit')?.getAttribute('title')).toBe('--overcommit=true');
  });

  it('兼容按字段给来源的写法：启动参数 / ConfigMap / 默认值', async () => {
    mockFetch(
      jsonResponse({
        ...ARGS_RESPONSE,
        raw: { nodeSchedulerPolicy: '--node-scheduler-policy=binpack' },
        source: {
          nodeSchedulerPolicy: 'flag',
          deviceSchedulerPolicy: 'configmap',
          overcommit: { kind: 'builtin' },
        },
      }),
    );
    await renderPanel();

    expect(sourceChip('nodeSchedulerPolicy')?.textContent).toBe('来自启动参数');
    expect(sourceChip('nodeSchedulerPolicy')?.getAttribute('title')).toBe(
      '--node-scheduler-policy=binpack',
    );
    expect(sourceChip('deviceSchedulerPolicy')?.textContent).toBe('来自 ConfigMap');
    // 没有原始串时按来源类型拼兜底串，仍然是一句可读的 key=value
    expect(sourceChip('deviceSchedulerPolicy')?.getAttribute('title')).toBe(
      'scheduler.deviceSchedulerPolicy=spread',
    );
    expect(sourceChip('overcommit')?.textContent).toBe('默认值');
  });

  it('ConfigMap 命中的原始键（`文件:键`）也能认领到自己那一行', async () => {
    // A7 解析 ConfigMap 时 key 会带上文件名，canonical 只取最后一段
    mockFetch(
      jsonResponse({
        nodeSchedulerPolicy: 'spread',
        deviceSchedulerPolicy: 'binpack',
        overcommit: true,
        source: 'configmap',
        raw: [
          { key: 'device-config.yaml:nodeSchedulerPolicy', value: 'spread' },
          { key: 'hami-device-scheduler-policy', value: 'binpack' },
        ],
        defaults: DEFAULTS,
      }),
    );
    await renderPanel();

    expect(sourceChip('nodeSchedulerPolicy')?.textContent).toBe('来自 ConfigMap');
    expect(sourceChip('nodeSchedulerPolicy')?.getAttribute('title')).toBe(
      'device-config.yaml:nodeSchedulerPolicy=spread',
    );
    // 前缀 `hami-` 会被剥掉，仍然对得上 device-scheduler-policy
    expect(sourceChip('deviceSchedulerPolicy')?.getAttribute('title')).toBe(
      'hami-device-scheduler-policy=binpack',
    );
  });

  it('缺失字段显示「—」，来源显示「未知」，不出现 undefined/NaN', async () => {
    mockFetch(
      jsonResponse({
        nodeSchedulerPolicy: null,
        deviceSchedulerPolicy: null,
        overcommit: null,
        source: 'unknown',
        raw: [],
      }),
    );
    await renderPanel();

    expect(rowText('nodeSchedulerPolicy')).toContain('—');
    expect(rowText('deviceSchedulerPolicy')).toContain('—');
    expect(rowText('overcommit')).toContain('—');
    // 缺失时没有任何释义
    expect(rowText('nodeSchedulerPolicy')).not.toContain('优先');
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('NaN');

    const chip = sourceChip('nodeSchedulerPolicy');
    expect(chip?.textContent).toBe('未知');
    expect(chip?.getAttribute('title')).toBe('接口未返回该字段');
  });

  it('source:default 时按 defaults 显示 HAMi 默认值，标签写「默认值」', async () => {
    mockFetch(jsonResponse(DEFAULT_RESPONSE));
    await renderPanel();

    // 值不是 —，而是后端给的默认基线（binpack / binpack / 关闭），并标成默认值
    expect(rowText('nodeSchedulerPolicy')).toContain('binpack');
    expect(rowText('deviceSchedulerPolicy')).toContain('binpack');
    expect(rowText('overcommit')).toContain('关闭');
    expect(sourceChip('nodeSchedulerPolicy')?.textContent).toBe('默认值');

    const row = container.querySelector(
      '[data-testid="policy-row"][data-field="nodeSchedulerPolicy"]',
    );
    expect(row?.getAttribute('data-from-defaults')).toBe('true');
    expect(sourceChip('nodeSchedulerPolicy')?.getAttribute('title')).toContain('HAMi 默认值');
  });

  it('source:unknown 时把 reason 落成琥珀提示', async () => {
    mockFetch(
      jsonResponse({
        nodeSchedulerPolicy: null,
        deviceSchedulerPolicy: null,
        overcommit: null,
        source: 'unknown',
        raw: [],
        defaults: DEFAULTS,
        reason: '创建 Kubernetes 客户端失败：x509: certificate signed by unknown authority',
      }),
    );
    await renderPanel();

    const notice = container.querySelector('[data-testid="policy-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.className).toContain('amber');
    expect(notice?.textContent).toContain('x509');
    // 读不到时三行仍是 —（source 不是 default，不拿默认值冒充集群配置）
    expect(rowText('nodeSchedulerPolicy')).toContain('—');
    expect(sourceChip('nodeSchedulerPolicy')?.textContent).toBe('未知');
  });

  it('显存超卖三态：开启 / 关闭 / 未知', async () => {
    // true → 开启
    mockFetch(jsonResponse({ ...ARGS_RESPONSE, overcommit: true }));
    await renderPanel();
    expect(rowText('overcommit')).toContain('开启');
    act(() => root.unmount());

    // false → 关闭（false 是「读到了」，不能当成缺失）
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockFetch(jsonResponse({ ...ARGS_RESPONSE, overcommit: false }));
    await renderPanel();
    expect(rowText('overcommit')).toContain('关闭');
    act(() => root.unmount());

    // 认不出来的值 → 未知（不是缺省的「—」）
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockFetch(jsonResponse({ ...ARGS_RESPONSE, overcommit: 'auto' }));
    await renderPanel();
    expect(rowText('overcommit')).toContain('未知');
    expect(rowText('overcommit')).not.toContain('—');
  });

  it('策略值认不出来时显示「未知」而不是猜默认值', async () => {
    mockFetch(
      jsonResponse({ ...ARGS_RESPONSE, nodeSchedulerPolicy: 'some-new-policy', defaults: DEFAULTS }),
    );
    await renderPanel();

    expect(rowText('nodeSchedulerPolicy')).toContain('未知');
    expect(rowText('nodeSchedulerPolicy')).not.toContain('binpack');
    expect(rowText('nodeSchedulerPolicy')).not.toContain('优先');
  });

  it('错误态：琥珀提示 + 服务端消息，点重试重新请求', async () => {
    const spy = mockFetch(
      jsonResponse({ error: '集群 243 不可达：dial tcp 10.0.0.243:6443 timeout' }, 500),
      jsonResponse(ARGS_RESPONSE),
    );
    await renderPanel('c9');

    const errorBar = container.querySelector('[data-testid="policy-error"]');
    expect(errorBar).not.toBeNull();
    // 琥珀色，不是页面级红色故障
    expect(errorBar?.className).toContain('amber');
    expect(errorBar?.textContent).toContain('集群 243 不可达');
    // 出错时不渲染三行（避免显示成「全部为默认值」的假象）
    expect(container.querySelectorAll('[data-testid="policy-row"]')).toHaveLength(0);

    const retry = errorBar?.querySelector('button');
    expect(retry?.textContent).toContain('重试');
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="policy-error"]')).toBeNull();
    expect(rowText('nodeSchedulerPolicy')).toContain('binpack');
  });

  it('demo:true（演示模式的空策略）加「演示数据」角标', async () => {
    // 演示模式后端返回的正是这个形状：source:'default' + 空值 + demo
    mockFetch(jsonResponse({ ...DEFAULT_RESPONSE, demo: true }));
    await renderPanel();

    const badge = container.querySelector('[data-testid="policy-demo-badge"]');
    expect(badge?.textContent).toBe('演示数据');
    // 角标不改变三行渲染
    expect(container.querySelectorAll('[data-testid="policy-row"]')).toHaveLength(3);
    expect(rowText('nodeSchedulerPolicy')).toContain('binpack');
  });

  it('集群 id 变化会重新请求，且 id 被 URL 编码', async () => {
    const spy = mockFetch(
      jsonResponse(ARGS_RESPONSE),
      jsonResponse({ ...ARGS_RESPONSE, nodeSchedulerPolicy: 'spread' }),
    );
    await renderPanel('cluster/a b');

    expect(String(spy.mock.calls[0][0])).toBe('/api/k8s/clusters/cluster%2Fa%20b/policy');

    await act(async () => {
      root.render(createElement(PolicyPanel, { clusterId: 'other' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1][0])).toBe('/api/k8s/clusters/other/policy');
    expect(rowText('nodeSchedulerPolicy')).toContain('spread');
  });
});
