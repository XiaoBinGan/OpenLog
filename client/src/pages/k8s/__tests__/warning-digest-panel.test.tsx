// @vitest-environment jsdom
/**
 * WarningDigestPanel 渲染测试（jsdom + 伪造 fetch）。
 *
 * 关注点：按 reason 聚合的行、窗口总次数、ack 之后的新增条数、标记已读会 POST、
 * 错误与空态、演示角标、URL 编码。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WarningDigestPanel from '../WarningDigestPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => text,
  } as unknown as Response;
}

const calls: { url: string; method: string }[] = [];
let nextBody: unknown = { window: '1h', total: 0, newEvents: 0, byReason: [] };
let nextStatus = 200;

beforeEach(() => {
  calls.length = 0;
  nextStatus = 200;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (init?.method === 'POST') return jsonResponse({ ok: true }, 200);
    return jsonResponse(nextBody, nextStatus);
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

async function mount(clusterId = 'c1') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root;
  await act(async () => { root = createRoot(host); root.render(createElement(WarningDigestPanel, { clusterId })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { host, root: root! };
}

describe('WarningDigestPanel', () => {
  it('渲染聚合行、次数与窗口总计', async () => {
    nextBody = {
      window: '1h', total: 99, newEvents: 3,
      byReason: [
        { reason: 'FailedScheduling', count: 61, lastSeen: '2026-11-23T20:10:00Z', objects: ['Pod/inference/a'] },
        { reason: 'BackOff', count: 38, lastSeen: null },
      ],
    };
    const { host } = await mount();
    expect(host.textContent).toContain('FailedScheduling');
    expect(host.textContent).toContain('61 次');
    expect(host.textContent).toContain('BackOff');
    expect(host.textContent).toContain('共 99 次');
    expect(host.textContent).toContain('新增 3 条');
    expect(host.querySelectorAll('[data-reason]')).toHaveLength(2);
  });

  it('lastSeen 为空显示 —（不出现 undefined）', async () => {
    nextBody = { window: '1h', total: 1, newEvents: 0, byReason: [{ reason: 'BackOff', count: 1, lastSeen: null }] };
    const { host } = await mount();
    expect(host.textContent).not.toContain('undefined');
    expect(host.textContent).toContain('—');
  });

  it('空列表给空态文案', async () => {
    nextBody = { window: '1h', total: 0, newEvents: 0, byReason: [] };
    const { host } = await mount();
    expect(host.textContent).toContain('没有 Warning 事件');
  });

  it('点「已读」会 POST 到 ack 接口并重新拉取', async () => {
    nextBody = { window: '1h', total: 5, newEvents: 5, byReason: [{ reason: 'BackOff', count: 5, lastSeen: '2026-11-23T20:10:00Z' }] };
    const { host } = await mount('c/1');
    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '已读');
    expect(btn).toBeTruthy();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/api/k8s/clusters/c%2F1/warning-digest/ack');
    // ack 之后应再拉一次
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('请求失败显示错误条', async () => {
    nextStatus = 502;
    nextBody = { error: '无法连接 Kubernetes API' };
    const { host } = await mount();
    expect(host.textContent).toContain('读取失败');
  });

  it('demo 标记显示角标', async () => {
    nextBody = { demo: true, window: '1h', total: 0, newEvents: 0, byReason: [] };
    const { host } = await mount();
    expect(host.textContent).toContain('演示数据');
  });

  it('请求 URL 带 window=1h 且 clusterId 被编码', async () => {
    await mount('a b/c');
    expect(calls[0]?.url).toContain('/api/k8s/clusters/a%20b%2Fc/warning-digest?window=1h');
  });
});
