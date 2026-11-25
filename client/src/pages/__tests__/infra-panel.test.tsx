// @vitest-environment jsdom
/**
 * InfraPanel + ServiceForm + DiffPreview 的渲染测试（jsdom + 伪造 fetch）。
 *
 * 这一整套 UI 的价值全在**「点了之后到底会发生什么」**上，所以用例围绕真实后端
 * 会返回的几种形状展开：
 *   · 列表正常 / 空列表 / 读取失败（500）；
 *   · preview allowed:true（可执行）与 allowed:false + violations（护栏拦住）;
 *   · apply 成功（带审计与快照）、rollback 按 version 下发；
 *   · 演示模式（`demo` prop 与 `window.__OPENLOG_DEMO__` 两条入口）：不发请求、
 *     执行禁用；
 *   · 表单校验：必填、配额越界、后端塞进来的非法命名空间；
 *   · 配额变化的**诚实提示**（改内存/副本必须提前说「单副本 ≈ 30 秒中断」）。
 *
 * 断言方式：全部按 `data-testid` / `data-field` / `data-kind` 定位，不依赖行序与
 * 文案微调；只有「必须被人看见的那句话」才断言原文。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import InfraPanel from '../infra/InfraPanel';
import {
  emptyDraft,
  estimateImpact,
  infraServicePath,
  normalizeGuardResult,
  serviceFromDraft,
  validateDraft,
} from '../infra/types';
import type {
  ApplyResult,
  GuardResult,
  InfraServiceListResponse,
  InfraServiceView,
  ModelService,
} from '../infra/types';

// React 18 的 act 环境标记：不设的话每个用例都会打一条警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── fetch 伪造（与 k8s 测试同一套写法） ─────────────────────────────────

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

// ─── 测试数据 ────────────────────────────────────────────────────────────

/** 一个合法的服务（各用例只覆盖自己关心的字段）。 */
function makeService(
  id: string,
  name: string,
  over: Partial<InfraServiceView> = {},
): InfraServiceView {
  return {
    id,
    name,
    namespace: 'inference',
    model: {
      source: 'hostPath',
      path: '/models/Qwen2.5-72B-Instruct',
      quantization: 'awq',
      contextLength: 32768,
    },
    engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.6.3' },
    resources: { accelerators: 2, memoryMiB: 40960, coresPercent: 100 },
    replicas: 1,
    placement: { acceleratorModel: 'NVIDIA GeForce RTX 4090' },
    ports: [{ name: 'http', containerPort: 8000 }],
    health: { path: '/health' },
    expose: { gatewayPort: 8001 },
    createdAt: '2026-11-20T02:10:00.000Z',
    updatedAt: '2026-11-24T09:00:00.000Z',
    version: 3,
    status: { phase: 'running', readyReplicas: 1 },
    history: [
      { id: 'h2', at: '2026-11-24T09:00:00.000Z', action: 'update', ok: true, version: 3, note: '显存配额 32768 → 40960 MiB' },
      { id: 'h1', at: '2026-11-20T02:10:00.000Z', action: 'create', ok: true, version: 1 },
    ],
    ...over,
  };
}

/** 列表响应。 */
function listBody(services: InfraServiceView[], over: Partial<InfraServiceListResponse> = {}) {
  return { services, enabled: true, ...over };
}

/** 一份「可以执行」的预览。 */
const PREVIEW_OK: GuardResult = {
  allowed: true,
  violations: [],
  diff: [
    '--- 当前（inference/qwen-72b v3）',
    '+++ 期望（inference/qwen-72b）',
    '@@ -1,3 +1,3 @@',
    '- 显存配额: 40960',
    '+ 显存配额: 8192',
    '  副本数: 1',
  ].join('\n'),
  impact: {
    action: 'update',
    restarts: true,
    downtimeSeconds: 30,
    reasons: ['显存配额 40960 → 8192', '单副本重建约 30 秒'],
  },
};

/** 一份「被护栏拦住」的预览。 */
const PREVIEW_BLOCKED: GuardResult = {
  allowed: false,
  violations: [
    { code: 'memory-over-limit', field: 'resources.memoryMiB', message: '显存配额 8192 MiB 超过所选卡型的单卡显存 4096 MiB' },
    { code: 'namespace', field: 'namespace', message: '命名空间只允许 inference / infra-test' },
  ],
  diff: '- 显存配额: 40960\n+ 显存配额: 8192',
  impact: { action: 'update', restarts: true, downtimeSeconds: 30, reasons: ['显存配额 40960 → 8192'] },
};

/** 执行成功。 */
const APPLY_OK: ApplyResult = {
  ok: true,
  steps: [
    { name: 'render', ok: true },
    { name: 'apply', ok: true, detail: 'Deployment 已更新' },
  ],
  auditId: 'audit-42',
  snapshot: { available: true, id: 'snap-3' },
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
  delete (window as unknown as { __OPENLOG_DEMO__?: boolean }).__OPENLOG_DEMO__;
});

// ─── 渲染与交互工具 ──────────────────────────────────────────────────────

/** 渲染面板并抽干微任务队列（effect → apiFetch → setState）。 */
async function renderPanel(props: { demo?: boolean; initialServiceId?: string } = {}) {
  await act(async () => {
    root.render(createElement(InfraPanel, props));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

/** 按 testid 取元素。 */
function el<T extends HTMLElement>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

/** 按 data-name 点开某一行的服务。 */
async function openService(name: string) {
  const row = container.querySelector<HTMLElement>(
    `[data-testid="infra-service-row"][data-name="${name}"]`,
  );
  if (!row) throw new Error(`找不到服务行 ${name}`);
  await act(async () => {
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 点一个 testid（点完等一轮微任务，让可能触发的请求落地）。 */
async function clickTestId(testid: string) {
  const target = el<HTMLElement>(testid);
  if (!target) throw new Error(`找不到 ${testid}`);
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * 往受控输入框写值：必须走原生 setter 再派发事件，否则 React 的
 * value tracker 会认为「值没变」而不触发 onChange。
 */
async function fill(testid: string, value: string) {
  const target = el<HTMLInputElement | HTMLSelectElement>(testid);
  if (!target) throw new Error(`找不到 ${testid}`);
  const isSelect = target instanceof HTMLSelectElement;
  const proto = isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(target, value);
  await act(async () => {
    target.dispatchEvent(new Event(isSelect ? 'change' : 'input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 提交表单（React 的 onSubmit 监听在 root 上，submit 事件要冒泡上去）。 */
async function submitForm() {
  const form = el<HTMLFormElement>('infra-service-form');
  if (!form) throw new Error('表单还没渲染');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 取错误文本（没有就返回空串）。 */
function errorOf(field: string): string {
  return el(`infra-error-${field}`)?.textContent ?? '';
}

// ─── 列表 ────────────────────────────────────────────────────────────────

describe('InfraPanel 列表', () => {
  it('读取 /api/infra/services 并渲染名称 / 引擎 / 配额 / 副本 / 状态', async () => {
    const spy = mockFetch(jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])));
    await renderPanel();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe('/api/infra/services');

    const row = el('infra-service-row');
    expect(row).not.toBeNull();
    const text = row?.textContent ?? '';
    expect(text).toContain('qwen-72b');
    expect(text).toContain('inference');
    expect(text).toContain('vllm');
    expect(text).toContain('2 卡');
    expect(text).toContain('40960 MiB');
    expect(text).toContain('100%');
    expect(text).toContain('1 副本');
    expect(text).toContain('运行中');
    // 状态角标带 data-phase，便于别的用例按阶段断言
    expect(el('infra-service-phase')?.getAttribute('data-phase')).toBe('running');
    // 正常态没有任何演示角标 / 提示条
    expect(el('infra-demo-badge')).toBeNull();
    expect(el('infra-notice')).toBeNull();
  });

  it('空列表：显示空态与「新建服务」入口，不渲染任何行', async () => {
    mockFetch(jsonResponse(listBody([])));
    await renderPanel();

    const empty = el('infra-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('还没有模型服务');
    expect(el('infra-empty-new')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="infra-service-row"]')).toHaveLength(0);
  });

  it('列表读取失败：错误条 + 服务端消息，点重试重新请求', async () => {
    const spy = mockFetch(
      jsonResponse({ error: '读取模型服务失败：OPENLOG_K8S_INFRA 未开启' }, 500),
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
    );
    await renderPanel();

    const errorBox = el('infra-list-error');
    expect(errorBox).not.toBeNull();
    expect(errorBox?.textContent).toContain('OPENLOG_K8S_INFRA');
    expect(container.querySelectorAll('[data-testid="infra-service-row"]')).toHaveLength(0);

    // ErrorBar 自带的重试按钮
    const retry = errorBox?.querySelector('button');
    expect(retry?.textContent).toContain('重试');
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(el('infra-list-error')).toBeNull();
    expect(container.querySelectorAll('[data-testid="infra-service-row"]')).toHaveLength(1);
  });

  it('enabled:false（开关没开）只禁用新建，列表照常可读', async () => {
    mockFetch(
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')], { enabled: false, reason: 'OPENLOG_K8S_INFRA 未开启，本页只读' })),
    );
    await renderPanel();

    const notice = el('infra-notice');
    expect(notice?.textContent).toContain('OPENLOG_K8S_INFRA');
    expect(el<HTMLButtonElement>('infra-new-service')?.disabled).toBe(true);
    // 读不需要开关：列表照常渲染
    expect(container.querySelectorAll('[data-testid="infra-service-row"]')).toHaveLength(1);
  });
});

// ─── 演示模式 ────────────────────────────────────────────────────────────

describe('InfraPanel 演示模式', () => {
  it('demo prop：用内置假数据、不发任何请求、执行按钮禁用并说明原因', async () => {
    const spy = mockFetch(jsonResponse(listBody([])));
    await renderPanel({ demo: true });

    // 演示模式完全不碰后端
    expect(spy).not.toHaveBeenCalled();
    expect(el('infra-demo-badge')?.textContent).toBe('演示数据');
    expect(container.querySelectorAll('[data-testid="infra-service-row"]').length).toBeGreaterThan(0);

    // 打开服务 → 生成预览（本地 diff，仍然不发请求）
    await openService('qwen-72b');
    await submitForm();
    expect(spy).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-testid="infra-diff-line"]').length).toBeGreaterThan(0);

    const apply = el<HTMLButtonElement>('infra-apply');
    expect(apply?.disabled).toBe(true);
    expect(el('infra-apply-reason')?.textContent).toContain('演示模式');
    // 历史里的回滚按钮同样禁用
    expect(el<HTMLButtonElement>('infra-history-rollback')?.disabled).toBe(true);
  });

  it('window.__OPENLOG_DEMO__ 也能开启演示模式（A9 从环境注入的入口）', async () => {
    const spy = mockFetch(jsonResponse(listBody([])));
    (window as unknown as { __OPENLOG_DEMO__?: boolean }).__OPENLOG_DEMO__ = true;
    await renderPanel();

    expect(spy).not.toHaveBeenCalled();
    expect(el('infra-demo-badge')).not.toBeNull();
    expect(el('infra-panel')?.getAttribute('data-demo')).toBe('true');
    // 显式 demo={false} 优先于全局开关
    await act(async () => {
      root.render(createElement(InfraPanel, { demo: false }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(spy).toHaveBeenCalled();
  });
});

// ─── 表单校验 ────────────────────────────────────────────────────────────

describe('ServiceForm 校验', () => {
  it('新建时必填项为空：提交被拦，字段下方给出中文错误，且不请求 preview', async () => {
    const spy = mockFetch(jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])));
    await renderPanel();

    await clickTestId('infra-new-service');
    expect(el('infra-service-form')?.getAttribute('data-mode')).toBe('create');

    await submitForm();

    expect(errorOf('name')).toContain('请填写服务名');
    expect(errorOf('modelPath')).toContain('绝对路径');
    // 只发生了列表那一次请求，预览没有发出去
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('配额越界：副本数报「1–8」、显存报「0–65536」、算力报「0–100」', async () => {
    mockFetch(jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])));
    await renderPanel();
    await openService('qwen-72b');

    await fill('infra-field-replicas', '99');
    await fill('infra-field-memoryMiB', '999999');
    await fill('infra-field-coresPercent', '120');
    await fill('infra-field-accelerators', '-1');
    await submitForm();

    // 被碰过的字段实时显示，不必等提交
    expect(errorOf('replicas')).toContain('副本数必须是 1–8 的整数');
    expect(errorOf('memoryMiB')).toContain('显存配额（MiB）必须是 0–65536 的整数');
    expect(errorOf('coresPercent')).toContain('算力配额（%）必须是 0–100 的整数');
    expect(errorOf('accelerators')).toContain('加速卡数必须是 0–16 的整数');
  });

  it('namespace 下拉只给白名单两项', async () => {
    mockFetch(jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])));
    await renderPanel();
    await clickTestId('infra-new-service');

    const select = el<HTMLSelectElement>('infra-field-namespace');
    const values = Array.from(select?.querySelectorAll('option') ?? []).map((option) => option.value);
    expect(values).toEqual(['inference', 'infra-test']);
    // kube-system / default 连选项都不该出现
    expect(values).not.toContain('kube-system');
    expect(values).not.toContain('default');
  });

  it('后端塞进来的非法 namespace 会被拦住（不信任服务端回包）', async () => {
    mockFetch(
      jsonResponse(listBody([makeService('svc-bad', 'bad-ns', { namespace: 'kube-system' })])),
    );
    await renderPanel();
    await openService('bad-ns');
    await submitForm();

    expect(errorOf('namespace')).toContain('命名空间只允许 inference / infra-test');
  });

  it('校验规则与后端同一套：validateDraft 直接拦 DNS-1123 与白名单外命名空间', () => {
    const ok = { ...emptyDraft(), name: 'qwen-72b', modelPath: '/models/qwen' };
    expect(validateDraft(ok)).toEqual({});

    // 大写 / 下划线 / 首字符是连字符都不合法
    for (const bad of ['Qwen-72b', 'qwen_72b', '-qwen', 'qwen-', '']) {
      expect(validateDraft({ ...ok, name: bad }).name).toBeTruthy();
    }
    expect(validateDraft({ ...ok, namespace: 'kube-system' }).namespace).toContain('inference');
    expect(validateDraft({ ...ok, replicas: '0' }).replicas).toContain('1–8');
    expect(validateDraft({ ...ok, memoryMiB: '65537' }).memoryMiB).toContain('65536');
    expect(validateDraft({ ...ok, coresPercent: '101' }).coresPercent).toContain('100');
  });
});

// ─── 诚实提示（配额变化会重建 Pod） ──────────────────────────────────────

describe('配额变化的诚实提示', () => {
  it('改显存配额：提交前就出现「单副本 ≈ 30 秒中断」', async () => {
    mockFetch(jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])));
    await renderPanel();
    await openService('qwen-72b');

    // 未改动时没有提示
    expect(el('infra-impact-hint')).toBeNull();

    await fill('infra-field-memoryMiB', '8192');

    const hint = el('infra-impact-hint');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('改变配额会重建 Pod：单副本 ≈ 30 秒中断');
    expect(hint?.textContent).toContain('显存配额 40960 → 8192');
  });

  it('改副本数同样触发提示，并给出最坏中断秒数', async () => {
    mockFetch(jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])));
    await renderPanel();
    await openService('qwen-72b');

    await fill('infra-field-replicas', '3');

    const hint = el('infra-impact-hint');
    expect(hint?.textContent).toContain('单副本 ≈ 30 秒中断');
    expect(hint?.textContent).toContain('副本数 1 → 3');
    expect(hint?.textContent).toContain('最坏 ≈ 90 秒');
  });

  it('只改镜像不会误报「配额」，但会提示同样要重建 Pod', async () => {
    mockFetch(jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])));
    await renderPanel();
    await openService('qwen-72b');

    await fill('infra-field-image', 'vllm/vllm-openai:v0.7.0');

    expect(el('infra-impact-hint')).toBeNull();
    expect(el('infra-restart-hint')?.textContent).toContain('镜像');
    expect(el('infra-restart-hint')?.textContent).toContain('30 秒中断');
  });

  it('本地 impact 估算与 A2 口径一致：配额变化 = 重建 + 30×副本数', () => {
    const before = serviceFromDraft({ ...emptyDraft(), name: 'svc', modelPath: '/m' });
    const after = serviceFromDraft(
      { ...emptyDraft(), name: 'svc', modelPath: '/m', memoryMiB: '1024', replicas: '2' },
      { ...before, resources: { ...before.resources, memoryMiB: 8192 } },
    );

    const impact = estimateImpact({ ...before, resources: { ...before.resources, memoryMiB: 8192 } }, after);
    expect(impact.action).toBe('update');
    expect(impact.restarts).toBe(true);
    expect(impact.downtimeSeconds).toBe(60);
    expect(impact.reasons.join(' ')).toContain('显存配额');

    // 没有任何变化时不能虚报中断
    const noop = estimateImpact(before, { ...before });
    expect(noop.action).toBe('noop');
    expect(noop.restarts).toBe(false);
    expect(noop.downtimeSeconds).toBe(0);
  });
});

// ─── 预览 / diff / 执行 ──────────────────────────────────────────────────

describe('预览与执行', () => {
  it('提交只调用 preview（POST + service 请求体），不直接 apply', async () => {
    const spy = mockFetch(
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
      jsonResponse(PREVIEW_OK),
    );
    await renderPanel();
    await openService('qwen-72b');
    await fill('infra-field-memoryMiB', '8192');
    await submitForm();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1][0])).toBe('/api/infra/services/svc-1/preview');
    const init = spy.mock.calls[1][1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as { service: ModelService };
    expect(body.service.name).toBe('qwen-72b');
    expect(body.service.resources.memoryMiB).toBe(8192);
    // 没有任何 apply 请求
    expect(spy.mock.calls.map((call) => String(call[0])).some((url) => url.endsWith('/apply'))).toBe(false);
  });

  it('diff 逐行渲染：`+` 绿、`-` 红、文件头不染色', async () => {
    mockFetch(
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
      jsonResponse(PREVIEW_OK),
    );
    await renderPanel();
    await openService('qwen-72b');
    await submitForm();

    const lines = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="infra-diff-line"]'));
    expect(lines.length).toBe(6);

    const kinds = lines.map((line) => line.getAttribute('data-kind'));
    expect(kinds).toEqual(['meta', 'meta', 'meta', 'del', 'add', 'ctx']);

    const added = lines.find((line) => line.getAttribute('data-kind') === 'add');
    const removed = lines.find((line) => line.getAttribute('data-kind') === 'del');
    expect(added?.textContent).toContain('+ 显存配额: 8192');
    expect(added?.className).toContain('emerald');
    expect(removed?.textContent).toContain('- 显存配额: 40960');
    expect(removed?.className).toContain('red');
    // 等宽字体
    expect(el('infra-diff')?.className).toContain('font-mono');
  });

  it('impact 三格：动作 / 是否重启 / 预计中断秒数', async () => {
    mockFetch(
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
      jsonResponse(PREVIEW_OK),
    );
    await renderPanel();
    await openService('qwen-72b');
    await submitForm();

    const cells = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="infra-impact-cell"]'));
    expect(cells.map((cell) => cell.getAttribute('data-field'))).toEqual(['action', 'restarts', 'downtime']);
    expect(cells[0].textContent).toContain('更新');
    expect(cells[1].textContent).toContain('会重建 Pod');
    expect(cells[2].textContent).toContain('最坏 30 秒');
    expect(el('infra-impact')?.getAttribute('data-restarts')).toBe('true');
  });

  it('violations：红色列逐条可读，执行按钮禁用并写明原因', async () => {
    mockFetch(
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
      jsonResponse(PREVIEW_BLOCKED),
    );
    await renderPanel();
    await openService('qwen-72b');
    await submitForm();

    const violations = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="infra-violation"]'));
    expect(violations).toHaveLength(2);
    expect(violations[0].textContent).toContain('显存配额 8192 MiB 超过所选卡型的单卡显存');
    expect(violations[0].getAttribute('data-field')).toBe('resources.memoryMiB');
    expect(violations[1].textContent).toContain('命名空间只允许');
    expect(el('infra-violations')?.className).toContain('red');

    const apply = el<HTMLButtonElement>('infra-apply');
    expect(apply?.disabled).toBe(true);
    expect(el('infra-apply-reason')?.textContent).toContain('2 条护栏未通过');
    expect(el('infra-allowed-badge')?.getAttribute('data-allowed')).toBe('false');
  });

  it('护栏通过后点执行：POST apply，展示步骤摘要并刷新列表', async () => {
    const spy = mockFetch(
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
      jsonResponse(PREVIEW_OK),
      jsonResponse(APPLY_OK),
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b', { version: 4 })])),
    );
    await renderPanel();
    await openService('qwen-72b');
    await submitForm();

    const apply = el<HTMLButtonElement>('infra-apply');
    expect(apply?.disabled).toBe(false);
    await clickTestId('infra-apply');

    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls[2]).toBe('/api/infra/services/svc-1/apply');
    expect((spy.mock.calls[2][1] as RequestInit).method).toBe('POST');

    const notice = el('infra-apply-notice');
    expect(notice?.textContent).toContain('已执行 2 个步骤');
    expect(notice?.textContent).toContain('audit-42');
    expect(notice?.textContent).toContain('回滚快照已保留');
    // 执行完刷新了列表
    expect(urls.filter((url) => url === '/api/infra/services').length).toBe(2);
  });

  it('执行失败：错误来自第一个失败步骤，界面显示红色条', async () => {
    mockFetch(
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
      jsonResponse(PREVIEW_OK),
      jsonResponse({ ok: false, steps: [{ name: 'apply', ok: false, detail: 'Deployment 冲突：resourceVersion 已过期' }] }),
    );
    await renderPanel();
    await openService('qwen-72b');
    await submitForm();
    await clickTestId('infra-apply');

    const error = el('infra-apply-error');
    expect(error?.textContent).toContain('resourceVersion 已过期');
    expect(error?.className).toContain('red');
  });

  it('preview 请求失败：表单上方红色错误条，且不渲染可执行的 diff', async () => {
    mockFetch(
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
      jsonResponse({ error: '渲染清单失败：镜像不存在' }, 500),
    );
    await renderPanel();
    await openService('qwen-72b');
    await submitForm();

    expect(el('infra-form-error')?.textContent).toContain('镜像不存在');
    expect(el('infra-apply')).toBeNull();
  });

  it('id 含 `/` 与空格时被 URL 编码（新建草稿用 namespace/name 作标识）', async () => {
    const weird = makeService('svc/weird id', 'weird');
    const spy = mockFetch(jsonResponse(listBody([weird])), jsonResponse(PREVIEW_OK));
    await renderPanel();
    await openService('weird');
    await submitForm();

    expect(String(spy.mock.calls[1][0])).toBe(`/api/infra/services/${encodeURIComponent('svc/weird id')}/preview`);
    // 纯函数口径一致：`/` 不能被当成路径分隔符
    expect(infraServicePath('svc/weird id', '/preview')).toBe('/api/infra/services/svc%2Fweird%20id/preview');
  });
});

// ─── 历史与回滚 ──────────────────────────────────────────────────────────

describe('历史与回滚', () => {
  it('渲染变更历史，回滚按 version 下发', async () => {
    const spy = mockFetch(
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
      jsonResponse(APPLY_OK),
      jsonResponse(listBody([makeService('svc-1', 'qwen-72b')])),
    );
    await renderPanel();
    await openService('qwen-72b');

    const rows = container.querySelectorAll<HTMLElement>('[data-testid="infra-history-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('更新');
    expect(rows[0].textContent).toContain('v3');
    expect(rows[0].textContent).toContain('显存配额 32768 → 40960 MiB');

    await clickTestId('infra-history-rollback');

    expect(String(spy.mock.calls[1][0])).toBe('/api/infra/services/svc-1/rollback');
    const body = JSON.parse(String((spy.mock.calls[1][1] as RequestInit).body)) as { version: number };
    expect(body.version).toBe(3);
    expect(el('infra-apply-notice')?.textContent).toContain('已回滚到 v3');
  });

  it('没有历史时显示空态，不渲染任何回滚按钮', async () => {
    mockFetch(jsonResponse(listBody([makeService('svc-1', 'qwen-72b', { history: [] })])));
    await renderPanel();
    await openService('qwen-72b');

    expect(el('infra-history-empty')?.textContent).toContain('暂无变更记录');
    expect(el('infra-history-rollback')).toBeNull();
  });
});

// ─── 响应归一（防止「没拿到许可」被当成「允许」） ─────────────────────────

describe('normalizeGuardResult', () => {
  const impact = { action: 'update' as const, restarts: true, downtimeSeconds: 30, reasons: ['x'] };

  it('allowed 只认布尔 true；字符串 "true" / 缺字段一律按不允许处理', () => {
    expect(normalizeGuardResult({ allowed: true }, impact).allowed).toBe(true);
    expect(normalizeGuardResult({ allowed: 'true' }, impact).allowed).toBe(false);
    expect(normalizeGuardResult({}, impact).allowed).toBe(false);
    expect(normalizeGuardResult(null, impact).allowed).toBe(false);
  });

  it('violations 兼容字符串与对象两种形状，缺 message 时给兜底文案', () => {
    const result = normalizeGuardResult(
      { allowed: false, violations: ['命名空间不在白名单', { code: 'no-message' }, { field: 'replicas', message: '副本数超出上限' }] },
      impact,
    );
    expect(result.violations).toHaveLength(3);
    expect(result.violations[0].message).toBe('命名空间不在白名单');
    expect(result.violations[1].message).toContain('no-message');
    expect(result.violations[2].field).toBe('replicas');
  });

  it('impact 缺失时用本地估算兜底（旧后端没有 impact 也能看）', () => {
    const result = normalizeGuardResult({ allowed: true, diff: '+ x' }, impact);
    expect(result.impact).toEqual(impact);
    const partial = normalizeGuardResult({ allowed: true, impact: { action: 'create' } }, impact);
    expect(partial.impact.action).toBe('create');
    expect(partial.impact.downtimeSeconds).toBe(30);
  });
});
