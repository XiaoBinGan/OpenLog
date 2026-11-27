// @vitest-environment jsdom
/**
 * 容量预检（A4）+ 模型足迹（A7）的渲染与归一测试。
 *
 * 这块的错误形态不是崩溃，而是**一句看起来正常的错话**：
 *   · 没拿到 placement 就显示「放得下」→ 用户按一个根本没算过的配额下发，Pod 卡 Pending；
 *   · `tight` 显示成绿色「放得下」→ 并发一涨就 OOM，而界面上一切正常；
 *   · warnings 混进 reasons → 用户以为结论不可信，于是两个都不看。
 * 所以用例围绕「三态必须能区分」「未知不许折叠成通过」展开，
 * 全部按 data-testid / data-* 定位，只有必须被人看见的那句话才断言原文。
 *
 * fetch 全部伪造（jsdom + createRoot），不依赖真实后端。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import CapacityReport, {
  capacityVerdict,
  capacityVerdictText,
  footprintVerdictText,
  formatMiB,
} from '../infra/CapacityReport';
import InfraPanel from '../infra/InfraPanel';
import {
  normalizeFootprint,
  normalizeGuardResult,
  normalizePlacement,
  type FootprintResult,
  type InfraImpact,
} from '../infra/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── fetch 伪造（与 infra-panel.test.tsx 同一套写法） ────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => text,
  } as unknown as Response;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('confirm', () => true);
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

async function render(ui: ReturnType<typeof createElement>) {
  await act(async () => {
    root.render(ui);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function el<T extends HTMLElement>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function all(testid: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`));
}

function text(testid: string): string {
  return el(testid)?.textContent ?? '';
}

// ─── 夹具 ────────────────────────────────────────────────────────────────

const PLACEMENT_FITS = {
  fits: true,
  best: 'gpu4090-a',
  reasons: ['放得下：1 个副本有落点 —— gpu4090-a', '落点后最紧的节点是 gpu4090-a：剩余 8192 MiB'],
  warnings: [],
  fragments: [],
  candidates: [
    { node: 'gpu4090-a', eligible: true, maxFreeMemMiB: 24576, remainingMiB: 16384, placedReplicas: 1 },
    { node: 'gpu4090-b', eligible: false, maxFreeMemMiB: 0, remainingMiB: 0, placedReplicas: 0 },
  ],
};

const PLACEMENT_INSUFFICIENT = {
  fits: false,
  best: null,
  reasons: ['放不下：0/1 个副本有落点', '单卡规则：一个副本的显存必须来自同一张卡，不能跨卡拼'],
  warnings: ['节点 gpu4090-b 的显存读数缺失，已忽略'],
  fragments: ['gpu4090-a 剩余 4096 MiB：小于单副本 8192 MiB'],
  candidates: [{ node: 'gpu4090-a', eligible: true, maxFreeMemMiB: 4096, remainingMiB: 4096, placedReplicas: 0 }],
};

const FOOTPRINT_TIGHT: FootprintResult = {
  verdict: 'tight',
  basis: 'estimated',
  quotaMiB: 24576,
  requiredMiB: 23284,
  headroomMiB: 1292,
  reasons: ['勉强够：配额 24576 MiB 刚过需求 23284 MiB，但低于含 10% 余量的 25612 MiB —— 并发或上下文一涨就会 OOM。'],
  warnings: [],
  assumption: '按权重 + 引擎开销 + KV cache（上下文 × 并发）估算；判定阈值 1.1×',
  breakdown: { weightsMiB: 18432, overheadMiB: 2048, kvCacheMiB: 2804, kvSource: 'model-file' },
};

const IMPACT: InfraImpact = { action: 'update', restarts: true, downtimeSeconds: 60, reasons: ['改配额'] };

// ─── 纯函数 ──────────────────────────────────────────────────────────────

describe('容量/足迹：纯函数口径', () => {
  it('没有结论时是 unknown —— 不许折叠成放得下', () => {
    expect(capacityVerdict(null)).toBe('unknown');
    expect(capacityVerdict(undefined)).toBe('unknown');
    expect(capacityVerdictText('unknown')).toBe('未验证');
    // unknown 不带任何绿色
    expect(capacityVerdictText('unknown')).not.toContain('放得下');
  });

  it('fits 只认布尔 true', () => {
    expect(capacityVerdict({ ...PLACEMENT_FITS, fits: true })).toBe('fits');
    expect(capacityVerdict({ ...PLACEMENT_FITS, fits: false })).toBe('insufficient');
  });

  it('足迹文案区分三档，tight 不弱化成「通过」', () => {
    expect(footprintVerdictText('fits')).toBe('放得下');
    expect(footprintVerdictText('tight')).toContain('勉强');
    expect(footprintVerdictText('insufficient')).toContain('放不下');
    expect(footprintVerdictText('unknown')).toBe('未验证');
  });

  it('MiB 格式化：非有限值显示 —，不显示 NaN', () => {
    expect(formatMiB(8192)).toBe('8.0 GiB');
    expect(formatMiB(512)).toBe('512 MiB');
    expect(formatMiB(null)).toBe('—');
    expect(formatMiB(Number.NaN)).toBe('—');
  });

  it('normalizePlacement：缺 fits 视为没有结论（不是放不下）', () => {
    expect(normalizePlacement(null)).toBeNull();
    expect(normalizePlacement({})).toBeNull();
    expect(normalizePlacement({ reasons: ['x'] })).toBeNull();
  });

  it('normalizePlacement：节点名兼容字符串与 { name } 两种形状，空理由被剔除', () => {
    const placement = normalizePlacement({
      fits: false,
      reasons: ['放不下', '   ', 42],
      warnings: ['读数缺失'],
      best: { name: 'gpu-a' },
      fragments: ['碎片'],
      candidates: [{ node: { name: 'gpu-a' }, eligible: true, maxFreeMemMiB: 4096 }, { node: '' }],
    });
    expect(placement?.reasons).toEqual(['放不下']);
    expect(placement?.best).toBe('gpu-a');
    expect(placement?.candidates).toHaveLength(1);
    expect(placement?.candidates[0].maxFreeMemMiB).toBe(4096);
  });

  it('normalizeFootprint：认不出的档位一律 unknown', () => {
    expect(normalizeFootprint(null)).toBeNull();
    expect(normalizeFootprint({ reasons: ['没有 verdict'] })).toBeNull();
    expect(normalizeFootprint({ verdict: 'passed' })?.verdict).toBe('unknown');
    expect(normalizeFootprint({ verdict: 'insufficient', quotaMiB: '21504' })?.quotaMiB).toBe(21504);
  });

  it('normalizeGuardResult 透传 placement / footprint（此前被整块丢掉）', () => {
    const result = normalizeGuardResult(
      { allowed: true, violations: [], diff: '--- a', impact: IMPACT, placement: PLACEMENT_INSUFFICIENT, footprint: FOOTPRINT_TIGHT },
      IMPACT,
    );
    expect(result.placement?.fits).toBe(false);
    expect(result.placement?.reasons).toHaveLength(2);
    expect(result.footprint?.verdict).toBe('tight');
    expect(result.allowed).toBe(true);
  });
});

// ─── 渲染 ────────────────────────────────────────────────────────────────

describe('CapacityReport 渲染', () => {
  it('放不下：红色结论 + 逐条理由 + 碎片单独列出 + warnings 不混进 reasons', async () => {
    await render(
      createElement(CapacityReport, {
        placement: PLACEMENT_INSUFFICIENT as never,
        footprint: null,
        hasPreview: true,
      }),
    );

    expect(el('capacity-report')?.getAttribute('data-capacity')).toBe('insufficient');
    expect(text('capacity-verdict')).toContain('放不下');
    expect(all('capacity-reason').length).toBe(2);
    expect(all('capacity-fragment').length).toBe(1);
    expect(all('capacity-warning').length).toBe(1);
    expect(all('capacity-warning')[0].textContent).toContain('读数缺失');
    expect(text('capacity-fragments')).toContain('4096 MiB');
    // 没有任何落点时不给「最紧的落点」
    expect(el('capacity-best')).toBeNull();
  });

  it('放得下：绿色结论 + 候选节点表（不匹配的节点标出「否」）', async () => {
    await render(
      createElement(CapacityReport, { placement: PLACEMENT_FITS as never, hasPreview: true }),
    );

    expect(text('capacity-verdict')).toBe('放得下');
    expect(el('capacity-verdict')?.className).toContain('emerald');
    expect(text('capacity-best')).toContain('gpu4090-a');
    const rows = all('capacity-candidate');
    expect(rows).toHaveLength(2);
    expect(rows[1].getAttribute('data-eligible')).toBe('false');
    expect(rows[1].textContent).toContain('型号不匹配');
  });

  it('候选表并列「分配剩余」与「实测剩余」：采不到显示未采到，不显示 0', async () => {
    await render(
      createElement(CapacityReport, {
        placement: {
          ...PLACEMENT_FITS,
          candidates: [
            { node: 'gpu4090-a', eligible: true, maxFreeMemMiB: 24576, measuredMaxFreeMiB: 8192, placedReplicas: 1 },
            { node: 'gpu4090-b', eligible: true, maxFreeMemMiB: 16384, placedReplicas: 0 },
          ],
        } as never,
        hasPreview: true,
      }),
    );

    const rows = all('capacity-candidate');
    expect(rows[0].textContent).toContain('24.0 GiB');
    expect(rows[0].textContent).toContain('8.0 GiB');
    // 没采到 = 未知，不是 0 MiB
    expect(rows[1].textContent).toContain('未采到');
    expect(rows[1].textContent).not.toContain('0 MiB');
  });

  it('足迹 tight：琥珀色「勉强够」，并给出需要/配额/余量与分项', async () => {
    await render(createElement(CapacityReport, { footprint: FOOTPRINT_TIGHT, hasPreview: true }));

    const verdict = el('footprint-verdict');
    expect(verdict?.getAttribute('data-verdict')).toBe('tight');
    expect(verdict?.textContent).toContain('勉强');
    expect(verdict?.className).toContain('amber');
    expect(text('footprint-required')).toBe('22.7 GiB');
    expect(text('footprint-quota')).toBe('24.0 GiB');
    expect(text('footprint-breakdown')).toContain('18.0 GiB');
    expect(text('footprint-assumption')).toContain('口径');
  });

  it('足迹 insufficient：红色硬拦', async () => {
    await render(
      createElement(CapacityReport, {
        footprint: { ...FOOTPRINT_TIGHT, verdict: 'insufficient', headroomMiB: -2560 },
        hasPreview: true,
      }),
    );
    expect(el('footprint-verdict')?.className).toContain('red');
    expect(el('footprint-headroom')?.className).toContain('red');
  });

  it('服务端没给结论：显示「未验证」，绝不显示放得下', async () => {
    await render(createElement(CapacityReport, { hasPreview: true }));

    expect(el('capacity-report')?.getAttribute('data-capacity')).toBe('unknown');
    expect(text('capacity-verdict')).toBe('未验证');
    expect(el('capacity-verdict')?.className).not.toContain('emerald');
    expect(text('capacity-unknown')).toContain('未验证');
    expect(text('footprint-unknown')).toContain('未验证');
    expect(el('footprint-verdict')?.className).not.toContain('emerald');
  });

  it('演示模式：说明不查真实容量，一个假数字都不画', async () => {
    await render(createElement(CapacityReport, { demo: true, hasPreview: false }));

    expect(text('capacity-demo')).toContain('演示模式');
    expect(el('capacity-block')).toBeNull();
    expect(el('footprint-block')).toBeNull();
  });

  it('还没生成预览：给空态引导，不报结论', async () => {
    await render(createElement(CapacityReport, { hasPreview: false }));
    expect(text('capacity-empty')).toContain('生成预览');
    expect(el('capacity-verdict')).toBeNull();
  });

  it('预览请求在飞：先收起上一轮结论（旧结论不能给新定义背书）', async () => {
    await render(createElement(CapacityReport, { placement: PLACEMENT_FITS as never, loading: true, hasPreview: true }));
    expect(text('capacity-loading')).toContain('正在读');
    expect(el('capacity-report')?.getAttribute('data-capacity')).toBe('unknown');
    expect(el('capacity-verdict')).toBeNull();
  });
});

// ─── 接线（面板 → 卡片） ─────────────────────────────────────────────────

describe('InfraPanel 接线：preview 的容量结论要出现在界面上', () => {
  const SERVICE = {
    id: 'svc-1',
    name: 'qwen-72b',
    namespace: 'inference',
    model: { source: 'hostPath', path: '/models/qwen-72b' },
    engine: { type: 'vllm', image: 'vllm/vllm-openai:latest' },
    resources: { accelerators: 1, memoryMiB: 40960, coresPercent: 100 },
    replicas: 1,
    placement: {},
    ports: [{ name: 'http', containerPort: 8000 }],
    health: { path: '/health' },
    createdAt: '2026-11-20T02:10:00.000Z',
    updatedAt: '2026-11-24T09:00:00.000Z',
    version: 3,
  };

  const LIST = { services: [SERVICE], enabled: true };

  /**
   * 按 URL 片段分派的 fetch 伪造：apply 之后面板会重新拉列表，
   * 用「响应序列」会让刷新拿到 apply 的响应，服务行消失、编辑区被卸载 ——
   * 那测的就不是提示有没有渲染，而是测试自己的夹具错位。
   */
  function mockApi(routes: Array<[string, Response]>) {
    const spy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/infra/audit')) {
        return jsonResponse({ total: 0, items: [], stats: { total: 0, byAction: {}, byActor: [], lastAt: null } });
      }
      for (const [fragment, response] of routes) {
        if (url.includes(fragment)) return response;
      }
      return jsonResponse({ error: `未匹配的请求：${url}` }, 404);
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  async function fill(testid: string, value: string) {
    const target = el<HTMLInputElement>(testid);
    if (!target) throw new Error(`找不到 ${testid}`);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(target, value);
    await act(async () => {
      target.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function openServiceAndSubmit() {
    const row = container.querySelector<HTMLElement>('[data-testid="infra-service-row"][data-name="qwen-72b"]');
    if (!row) throw new Error('找不到服务行');
    await act(async () => {
      row.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await fill('infra-field-memoryMiB', '8192');
    const form = el<HTMLFormElement>('infra-service-form');
    if (!form) throw new Error('表单还没渲染');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function clickApply() {
    const apply = el<HTMLButtonElement>('infra-apply');
    if (!apply) throw new Error('执行按钮没渲染（预览没被判定为可执行）');
    await act(async () => {
      apply.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('preview 返回放不下 → 卡片显示「放不下」并列出理由', async () => {
    mockApi([
      ['/preview', jsonResponse({
        allowed: true,
        violations: [],
        diff: '--- 当前\n+++ 期望\n',
        impact: IMPACT,
        placement: PLACEMENT_INSUFFICIENT,
        footprint: FOOTPRINT_TIGHT,
      })],
      ['/api/infra/services', jsonResponse(LIST)],
    ]);

    await render(createElement(InfraPanel, {}));
    await openServiceAndSubmit();

    expect(el('capacity-report')?.getAttribute('data-capacity')).toBe('insufficient');
    expect(el('capacity-report')?.getAttribute('data-footprint')).toBe('tight');
    expect(text('capacity-reasons')).toContain('放不下');
    expect(text('footprint-verdict')).toContain('勉强');
  });

  it('apply 半成功（网关 ok:false）→ 出现琥珀色提示，而不是静默成功', async () => {
    mockApi([
      ['/apply', jsonResponse({
        ok: true,
        steps: [{ name: 'render', ok: true }, { name: 'apply', ok: true }],
        auditId: 'aud-7',
        gateway: { ok: false, changed: false, error: '网关端口冲突，已跳过网关注册：30001 被 qwen-72b / llama-8b 占用' },
        snapshot: { available: true },
      })],
      ['/preview', jsonResponse({
        allowed: true,
        violations: [],
        diff: '--- 当前\n+++ 期望\n- 显存配额: 40960\n+ 显存配额: 8192\n',
        impact: IMPACT,
        placement: PLACEMENT_FITS,
        footprint: FOOTPRINT_TIGHT,
      })],
      ['/api/infra/services', jsonResponse(LIST)],
    ]);

    await render(createElement(InfraPanel, {}));
    await openServiceAndSubmit();
    await clickApply();

    const warning = text('infra-gateway-warning');
    expect(warning).toContain('半成功');
    expect(warning).toContain('30001');
  });

  it('apply 网关也成功 → 不出现半成功提示', async () => {
    mockApi([
      ['/apply', jsonResponse({
        ok: true,
        steps: [{ name: 'apply', ok: true }],
        auditId: 'aud-8',
        gateway: { ok: true, changed: true },
        snapshot: { available: true },
      })],
      ['/preview', jsonResponse({
        allowed: true,
        violations: [],
        diff: '--- 当前\n+++ 期望\n',
        impact: IMPACT,
        placement: PLACEMENT_FITS,
        footprint: FOOTPRINT_TIGHT,
      })],
      ['/api/infra/services', jsonResponse(LIST)],
    ]);

    await render(createElement(InfraPanel, {}));
    await openServiceAndSubmit();
    await clickApply();

    expect(el('infra-gateway-warning')).toBeNull();
    expect(text('infra-apply-notice')).toContain('已执行');
  });
});
