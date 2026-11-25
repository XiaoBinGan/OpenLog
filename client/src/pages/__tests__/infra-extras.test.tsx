// @vitest-environment jsdom
/**
 * AI Infra 扩展组件（AutoscaleFields / GateReport / AuditList / CachePlan）的渲染测试。
 *
 * 这四个组件的共同点：**它们的错误形态不是崩溃，而是一句看起来正常的错话**。
 *   · 超预算的 maxReplicas 显示成绿色的「通过」→ 用户扩了副本，Pod 永远 Pending；
 *   · `scored:false` 的门禁项显示成「通过」→ 用户以为显存验过了，其实根本没测；
 *   · warnings 混进 failures → 用户学会无视红条，门禁彻底失效；
 *   · 审计存储读不出来时渲染空态 → 用户以为「没人动过集群」；
 *   · 跨节点 hostPath 显示成绿色 → DiskPressure 打满整节点，Pod 全被 Evicted。
 * 所以用例围绕「三态必须能区分」展开，全部按 data-testid / data-* 定位，
 * 只有「必须被人看见的那句话」才断言原文。
 *
 * fetch 全部伪造（jsdom + createRoot），不依赖真实后端。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AutoscaleFields, { type AutoscaleFieldState } from '../infra/AutoscaleFields';
import GateReport, { type GateResult } from '../infra/GateReport';
import AuditList from '../infra/AuditList';
import CachePlan from '../infra/CachePlan';

// React 18 的 act 环境标记
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── fetch 伪造（与 infra-panel.test.tsx 同一套写法） ────────────────────

/** 只实现 apiFetch / apiJson 用到的成员（ok / status / statusText / text）。 */
function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => text,
  } as unknown as Response;
}

/** 让 fetch 依次返回给定的响应（用完复用最后一个）。 */
function mockFetch(...responses: Response[]) {
  const spy = vi.fn(async () => responses[Math.min(spy.mock.calls.length - 1, responses.length - 1)]);
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** 取某次 fetch 调用的 URL 与 init。 */
function callAt(spy: ReturnType<typeof mockFetch>, index: number): { url: string; init?: RequestInit } {
  const call = spy.mock.calls[index] as unknown as [string, RequestInit?];
  return { url: String(call[0]), init: call[1] };
}

/** init.body 解析成对象。 */
function bodyAt(spy: ReturnType<typeof mockFetch>, index: number): Record<string, unknown> {
  const { init } = callAt(spy, index);
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom 的 window.confirm 会抛「Not implemented」：默认允许，取消路径由用例内注入的 confirm 覆盖
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
});

// ─── 工具 ───────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function all(testid: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`));
}

function text(testid: string): string {
  return el(testid)?.textContent ?? '';
}

/**
 * 抽干微任务链。一次 `setTimeout(0)` 只够 effect → setTimeout 起步，
 * fetch → .then → setState 还要再落到下一次宏任务上，所以刷三轮。
 */
async function flush(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 渲染并抽干（effect → apiFetch → setState）。
 *
 * 分两段 act：第一段提交 + 跑 effect，第二段才等 promise 链落地 ——
 * 一段里 `await` 的话，effect 是在 await 之后才被 React 冲掉的，
 * 于是「effect 里挂的定时器」永远等不到自己的宏任务。
 */
async function render(node: ReactElement) {
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await flush();
  });
  return container;
}

/** 点一下某个 testid（点完等一轮微任务）。 */
async function click(testid: string) {
  const target = el<HTMLElement>(testid);
  if (!target) throw new Error(`找不到 ${testid}`);
  await act(async () => {
    target.click();
    await flush();
  });
}

/** 受控输入框写值：必须走原生 setter 再派发事件，否则 React 认为「值没变」。 */
async function fill(testid: string, value: string) {
  const target = el<HTMLInputElement | HTMLSelectElement>(testid);
  if (!target) throw new Error(`找不到 ${testid}`);
  const isSelect = target instanceof HTMLSelectElement;
  const proto = isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(target, value);
  await act(async () => {
    target.dispatchEvent(new Event(isSelect ? 'change' : 'input', { bubbles: true }));
    await flush();
  });
}

// ══════════════════════════════════════════════════════════════════════
// 1. AutoscaleFields
// ══════════════════════════════════════════════════════════════════════

/** 预算响应：单卡 40960 MiB，每副本 8192 MiB → 最多 5 个副本。 */
function budgetBody(maxReplicasByMemory: number | null, maxReplicasByCores: number | null, allowed: boolean) {
  return {
    budget: {
      maxReplicasByMemory,
      maxReplicasByCores,
      allowed,
      reason: allowed ? '在单卡预算内' : '超出单卡预算，请下调 maxReplicas',
    },
    capacity: { perCardMemMiB: 40960, perCardCores: 100 },
  };
}

describe('AutoscaleFields 预算', () => {
  it('查询 autoscale-budget 并显示「单卡最多 N 副本」', async () => {
    const spy = mockFetch(jsonResponse(budgetBody(5, 4, true)));
    await render(
      createElement(AutoscaleFields, {
        clusterId: 'cluster-a',
        memoryMiB: 10240,
        coresPercent: 25,
        replicas: 2,
        debounceMs: 0,
      }),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const { url } = callAt(spy, 0);
    // 路径（clusterId 编码）与两个配额参数都必须带上，否则服务端只能猜
    expect(url).toContain('/api/infra/clusters/cluster-a/autoscale-budget');
    expect(url).toContain('memoryMiB=10240');
    expect(url).toContain('coresPercent=25');

    // 两项上限取小（显存 5 / 算力 4 → 4）
    expect(text('autoscale-budget-limit')).toContain('单卡最多 4 副本');
    expect(el('autoscale-budget')?.getAttribute('data-allowed')).toBe('true');
    expect(el('autoscale-budget-warning')).toBeNull();
  });

  it('maxReplicas 超预算：红色提示 + 说明「会一直 Pending、HPA 不会自动止损」', async () => {
    mockFetch(jsonResponse(budgetBody(2, 2, true)));
    await render(
      createElement(AutoscaleFields, {
        clusterId: 'cluster-a',
        memoryMiB: 20480,
        coresPercent: 50,
        replicas: 1,
        debounceMs: 0,
      }),
    );

    // 默认 maxReplicas = 当前副本数 1，先确认初始判定是「通过」
    expect(el('autoscale-budget-ok')).not.toBeNull();

    await fill('autoscale-max', '6');

    const warning = el('autoscale-budget-warning');
    expect(warning).not.toBeNull();
    const warningText = warning?.textContent ?? '';
    // 必须说清后果，而不是只写一句「超出预算」
    expect(warningText).toContain('超出单卡预算');
    expect(warningText).toContain('Pending');
    expect(warningText).toContain('HPA');
    expect(warningText).toContain('不会自动止损');
    // 超预算时不能再出现绿色的通过
    expect(el('autoscale-budget-ok')).toBeNull();
    expect(el('autoscale-fields')?.getAttribute('data-over-budget')).toBe('true');
  });

  it('预算通过：maxReplicas 在限内显示绿色「在单卡预算内」', async () => {
    mockFetch(jsonResponse(budgetBody(5, 8, true)));
    await render(
      createElement(AutoscaleFields, {
        clusterId: 'cluster-a',
        memoryMiB: 8192,
        coresPercent: 10,
        replicas: 1,
        debounceMs: 0,
        // 初始 maxReplicas 由 initial 给，走「已保存策略」这条路径
        initial: { minReplicas: '1', maxReplicas: '3', cooldownSeconds: '120' },
      }),
    );

    expect(el('autoscale-budget-ok')).not.toBeNull();
    expect(text('autoscale-budget-ok')).toContain('单卡最多 5 副本');
    expect(el('autoscale-budget-warning')).toBeNull();
    // 冷却窗口回填到输入框
    expect(el<HTMLInputElement>('autoscale-cooldown')?.value).toBe('120');
  });

  it('读不到单卡容量：不显示绿色通过，显示「尚未验证」', async () => {
    mockFetch(
      jsonResponse({
        budget: { maxReplicasByMemory: null, maxReplicasByCores: null, allowed: true, reason: '未提供节点单卡容量' },
        capacity: { perCardMemMiB: 0, perCardCores: 100 },
      }),
    );
    await render(
      createElement(AutoscaleFields, {
        clusterId: 'cluster-a',
        memoryMiB: 8192,
        coresPercent: 10,
        debounceMs: 0,
      }),
    );

    expect(el('autoscale-budget-unknown')).not.toBeNull();
    expect(text('autoscale-budget-unknown')).toContain('尚未验证');
    // 绿色是个承诺：没有数据就不给
    expect(el('autoscale-budget-ok')).toBeNull();
    expect(el('autoscale-budget-warning')).toBeNull();
  });

  it('指标可增删，且 onChange 回吐超限状态（上层据此禁用保存）', async () => {
    mockFetch(jsonResponse(budgetBody(1, 8, true)));
    const states: AutoscaleFieldState[] = [];
    await render(
      createElement(AutoscaleFields, {
        clusterId: 'cluster-a',
        memoryMiB: 40960,
        coresPercent: 10,
        replicas: 1,
        debounceMs: 0,
        onChange: (state: AutoscaleFieldState) => states.push(state),
      }),
    );

    expect(all('autoscale-metric-row')).toHaveLength(1);

    await click('autoscale-metric-add');
    expect(all('autoscale-metric-row')).toHaveLength(2);

    // 删掉一行（用行内按钮）
    const remove = all('autoscale-metric-remove')[1];
    await act(async () => {
      remove.click();
      await flush();
    });
    expect(all('autoscale-metric-row')).toHaveLength(1);

    // 单卡只能放 1 个副本（整卡模式），填 4 必须报超限
    await fill('autoscale-max', '4');
    const last = states[states.length - 1];
    expect(last.overBudget).toBe(true);
    expect(last.limit).toBe(1);
    expect(last.draft.maxReplicas).toBe('4');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. GateReport
// ══════════════════════════════════════════════════════════════════════

/** 一份通过的门禁结论。 */
const GATE_PASS = {
  pass: true,
  score: 96.5,
  failures: [],
  warnings: [],
  checks: [
    { metric: 'ttftP95Ms', label: 'p95 首 token 延迟', actual: '820 ms', threshold: '<= 3000 ms', pass: true, satisfaction: 1, scored: true },
    { metric: 'errorRate', label: '错误率', actual: '0.00%', threshold: '<= 1.00%', pass: true, satisfaction: 1, scored: true },
  ],
};

/** 一份不通过的门禁结论（含未评分项 + warnings，用来验证三者分开渲染）。 */
const GATE_FAIL = {
  pass: false,
  score: 42,
  failures: [
    {
      metric: 'ttftP95Ms',
      actual: '5200 ms',
      threshold: '<= 3000 ms',
      message: 'p95 首 token 延迟 5200 ms 超过阈值 3000 ms（8 并发那档在排队）',
    },
  ],
  warnings: [
    '首次运行：仅记录基线，未做回归对比（吞吐回归项未参与判定）',
    '显存建议为估算值（confidence=estimated）：上线前请人工核对',
  ],
  checks: [
    { metric: 'ttftP95Ms', label: 'p95 首 token 延迟', actual: '5200 ms', threshold: '<= 3000 ms', pass: false, satisfaction: 0, scored: true },
    { metric: 'tokensPerSec', label: '吞吐回归', actual: '—', threshold: '>= baseline × 0.8', pass: true, satisfaction: 1, scored: false },
    { metric: 'memMiB', label: '显存超卖', actual: '—', threshold: '<= 申请值', pass: true, satisfaction: 1, scored: false },
  ],
};

/** bench 路由的响应外壳（`{...benchResult, gate, report}`）。 */
function benchBody(gate: unknown, report = '## 基准门禁报告 · inference/qwen-72b\n\n**结论：❌ 不通过**') {
  return {
    ok: gate && (gate as { pass?: boolean }).pass !== false,
    aborted: false,
    results: [{ concurrency: 1 }, { concurrency: 8 }],
    summary: { recommended: { memoryMiB: 24576, coresPercent: 100, confidence: 'estimated' } },
    gate,
    report,
  };
}

describe('GateReport 门禁', () => {
  it('通过：显示 score 与「通过（允许上线）」，并回吐 gate 给上层', async () => {
    const gates: (GateResult | null)[] = [];
    await render(
      createElement(GateReport, {
        serviceKey: 'inference/qwen-72b',
        onGateChange: (gate: GateResult | null) => gates.push(gate),
      }),
    );

    // 初始没有任何结论 → 回吐 null（上层必须据此禁用 apply）
    expect(gates[0]).toBeNull();
    expect(el('gate-idle')).not.toBeNull();
    expect(el('gate-score')?.textContent).toBe('—');

    const spy = mockFetch(jsonResponse(benchBody(GATE_PASS)));
    await click('gate-run');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(el('gate-verdict')?.getAttribute('data-pass')).toBe('true');
    expect(text('gate-verdict')).toContain('通过');
    expect(text('gate-score')).toBe('96.5');
    expect(el('gate-report')?.getAttribute('data-pass')).toBe('true');

    const last = gates[gates.length - 1];
    expect(last?.pass).toBe(true);
    expect(last?.score).toBe(96.5);
  });

  it('不通过：failures 红条 + 明确的「禁止上线」提示（scored:false 不混进去）', async () => {
    mockFetch(jsonResponse(benchBody(GATE_FAIL)));
    const gates: (GateResult | null)[] = [];
    await render(
      createElement(GateReport, {
        serviceKey: 'inference/qwen-72b',
        onGateChange: (gate: GateResult | null) => gates.push(gate),
      }),
    );

    await click('gate-run');

    expect(el('gate-verdict')?.getAttribute('data-pass')).toBe('false');
    expect(text('gate-verdict')).toContain('不通过');
    expect(el('gate-apply-hint')).not.toBeNull();
    expect(text('gate-apply-hint')).toContain('禁用');

    // failures 只有 1 条（warnings 不在里面）
    expect(all('gate-failure')).toHaveLength(1);
    expect(text('gate-failure')).toContain('5200 ms 超过阈值 3000 ms');

    const last = gates[gates.length - 1];
    expect(last?.pass).toBe(false);
    expect(last?.failures).toHaveLength(1);
  });

  it('checks 里 scored:false 显示「未验证」而不是「通过」', async () => {
    mockFetch(jsonResponse(benchBody(GATE_FAIL)));
    await render(createElement(GateReport, { serviceKey: 'inference/qwen-72b' }));
    await click('gate-run');

    const rows = all('gate-check-row');
    expect(rows).toHaveLength(3);

    const byMetric = (metric: string) =>
      rows.find((row) => row.getAttribute('data-metric') === metric) ?? null;

    // 已评分且通过
    expect(byMetric('ttftP95Ms')?.getAttribute('data-scored')).toBe('true');
    expect(byMetric('ttftP95Ms')?.querySelector('[data-testid="gate-check-verdict"]')?.textContent).toBe('不通过');

    // 未评分：判定列必须是「未验证」，绝不能是「通过」
    const unscored = byMetric('tokensPerSec');
    expect(unscored?.getAttribute('data-scored')).toBe('false');
    expect(unscored?.querySelector('[data-testid="gate-check-verdict"]')?.textContent).toBe('未验证');
    expect(unscored?.textContent).not.toContain('通过');
  });

  it('warnings 与 failures 分开渲染（黄条不混进红条列表）', async () => {
    mockFetch(jsonResponse(benchBody(GATE_FAIL)));
    await render(createElement(GateReport, { serviceKey: 'inference/qwen-72b' }));
    await click('gate-run');

    expect(all('gate-failure')).toHaveLength(1);
    expect(all('gate-warning')).toHaveLength(2);
    expect(text('gate-warnings')).toContain('confidence=estimated');
    // 红条里不能出现 warning 的文案
    expect(text('gate-failures')).not.toContain('confidence=estimated');
    // 黄条里也不能出现 failure 的文案
    expect(text('gate-warnings')).not.toContain('5200 ms');
  });

  it('「运行基准」发 POST /api/infra/bench，请求体带 serviceKey，markdown 报告用 <pre> 原样显示', async () => {
    const spy = mockFetch(jsonResponse(benchBody(GATE_PASS, '## 报告\n\n| 指标 | 实测 |\n| --- | --- |\n| ttft | 820 ms |')));
    await render(
      createElement(GateReport, {
        serviceKey: 'inference/qwen-72b',
        confirm: () => true,
      }),
    );
    await click('gate-run');

    const { url, init } = callAt(spy, 0);
    expect(url).toBe('/api/infra/bench');
    expect(init?.method).toBe('POST');

    const body = bodyAt(spy, 0);
    expect(body.serviceKey).toBe('inference/qwen-72b');
    // 压测目标按 serviceKey 推导（namespace/name → 集群内 DNS）
    expect((body.target as { url: string }).url).toContain('qwen-72b.inference.svc.cluster.local');
    expect(body.matrix).toBeTruthy();

    const pre = el('gate-report-md');
    expect(pre?.tagName).toBe('PRE');
    // 原样贴：不做 markdown 渲染（表格竖线还在）
    expect(pre?.textContent).toContain('| ttft | 820 ms |');
  });

  it('二次确认被取消时不发任何压测请求', async () => {
    const spy = mockFetch(jsonResponse(benchBody(GATE_PASS)));
    await render(
      createElement(GateReport, {
        serviceKey: 'inference/qwen-72b',
        confirm: () => false,
      }),
    );
    await click('gate-run');

    expect(spy).not.toHaveBeenCalled();
    expect(el('gate-notice')).not.toBeNull();
    expect(text('gate-notice')).toContain('已取消');
    // 取消后仍然没有放行依据
    expect(el('gate-verdict')).toBeNull();
  });

  it('响应缺少 gate 字段：报错且不放行（不把「没结论」当成通过）', async () => {
    mockFetch(jsonResponse({ ok: true, results: [], report: '# 报告' }));
    const gates: (GateResult | null)[] = [];
    await render(
      createElement(GateReport, {
        serviceKey: 'inference/qwen-72b',
        confirm: () => true,
        onGateChange: (gate: GateResult | null) => gates.push(gate),
      }),
    );
    await click('gate-run');

    expect(el('gate-error')).not.toBeNull();
    expect(el('gate-verdict')).toBeNull();
    expect(gates[gates.length - 1]).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. AuditList
// ══════════════════════════════════════════════════════════════════════

/** 一条审计记录。 */
function auditEntry(over: Record<string, unknown> = {}) {
  return {
    id: 'audit-42',
    at: '2026-11-24T09:00:00.000Z',
    actor: 'alice',
    action: 'update',
    serviceKey: 'inference/qwen-72b',
    namespace: 'inference',
    name: 'qwen-72b',
    targets: ['Deployment/qwen-72b', 'Service/qwen-72b'],
    steps: [
      { name: 'render', ok: true, detail: null },
      { name: 'apply', ok: false, detail: 'Deployment 已更新，Service 冲突' },
    ],
    ok: false,
    error: 'Service 已存在同名 ClusterIP 冲突',
    snapshotRef: 'inference/qwen-72b@v3',
    forced: [],
    ...over,
  };
}

/** 一页审计。 */
function auditBody(items: unknown[], over: Record<string, unknown> = {}) {
  return {
    total: items.length,
    items,
    limit: 50,
    offset: 0,
    stats: {
      total: 213,
      byAction: { create: 12, update: 198, rollback: 2, rejected: 1 },
      byActor: [{ actor: 'alice', count: 200 }],
      lastAt: '2026-11-24T09:00:00.000Z',
    },
    demo: false,
    ...over,
  };
}

describe('AuditList 审计', () => {
  it('渲染表格（时间 / actor / 动作 / 服务 / 结果 / 审计号）并默认 limit=50', async () => {
    const spy = mockFetch(jsonResponse(auditBody([auditEntry()])));
    await render(createElement(AuditList, {}));

    const { url } = callAt(spy, 0);
    expect(url).toContain('/api/infra/audit?');
    expect(url).toContain('limit=50');
    expect(url).toContain('offset=0');

    const row = el('audit-row');
    expect(row).not.toBeNull();
    const rowText = row?.textContent ?? '';
    expect(rowText).toContain('alice');
    expect(rowText).toContain('更新');
    expect(rowText).toContain('inference/qwen-72b');
    expect(rowText).toContain('失败');
    expect(rowText).toContain('audit-42');
    // 概览字幕里两个 total 都要出现（全库 213 / 当前筛选 1）
    expect(text('audit-stats')).toContain('213');
    expect(text('audit-page-info')).toContain('共 1 条');
  });

  it('按 action 过滤：重新发请求并带 action=rejected，offset 归零', async () => {
    const spy = mockFetch(
      jsonResponse(auditBody([auditEntry()])),
      jsonResponse(auditBody([auditEntry({ id: 'audit-7', action: 'rejected', ok: false })])),
    );
    await render(createElement(AuditList, {}));

    await fill('audit-filter-action', 'rejected');

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const { url } = callAt(spy, spy.mock.calls.length - 1);
    expect(url).toContain('action=rejected');
    expect(url).toContain('offset=0');
  });

  it('action=rejected 用红色标签（与普通失败区分开）', async () => {
    mockFetch(
      jsonResponse(
        auditBody([
          auditEntry({ id: 'a-1', action: 'rejected', ok: false }),
          auditEntry({ id: 'a-2', action: 'update', ok: true }),
        ]),
      ),
    );
    await render(createElement(AuditList, {}));

    const tags = all('audit-action-tag');
    expect(tags).toHaveLength(2);
    const rejected = tags.find((tag) => tag.getAttribute('data-action') === 'rejected');
    expect(rejected?.textContent).toBe('被拒绝');
    // 红色标签带 red 系 class（不是灰/绿）
    expect(rejected?.className).toContain('red');
    const ok = tags.find((tag) => tag.getAttribute('data-action') === 'update');
    expect(ok?.className).not.toContain('red');
  });

  it('审计存储不可读（error 非空）：显示错误，绝不渲染成空态', async () => {
    mockFetch(
      jsonResponse({
        total: 0,
        items: [],
        limit: 50,
        offset: 0,
        error: '审计 KV 读取失败：SQLITE_IOERR',
        stats: null,
      }),
    );
    await render(createElement(AuditList, {}));

    expect(el('audit-storage-error')).not.toBeNull();
    expect(text('audit-storage-error')).toContain('审计存储不可读');
    expect(text('audit-storage-error')).toContain('SQLITE_IOERR');
    // 「没有记录」这句话在这一刻是误导
    expect(el('audit-empty')).toBeNull();
  });

  it('点行展开 steps 与 forced', async () => {
    mockFetch(
      jsonResponse(
        auditBody([
          auditEntry({
            id: 'a-forced',
            action: 'update',
            ok: true,
            forced: ['memory-over-limit', 'namespace-whitelist'],
            steps: [
              { name: 'render', ok: true, detail: null },
              { name: 'apply', ok: true, detail: 'Deployment 已更新' },
            ],
          }),
        ]),
      ),
    );
    await render(createElement(AuditList, {}));

    // 默认收起
    expect(el('audit-row-detail')).toBeNull();

    await click('audit-row');

    expect(el('audit-row-detail')).not.toBeNull();
    expect(all('audit-step')).toHaveLength(2);
    expect(text('audit-steps')).toContain('Deployment 已更新');
    expect(text('audit-forced')).toContain('memory-over-limit');
    expect(text('audit-forced')).toContain('namespace-whitelist');
    // forced 非空时行上也有 force 角标
    expect(el('audit-forced-badge')).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. CachePlan
// ══════════════════════════════════════════════════════════════════════

/** 估算 + 规划响应。 */
function cacheBody(over: {
  strategy?: string;
  shared?: boolean;
  warnings?: string[];
  perPodMiB?: number;
  totalMiB?: number;
  savedMiB?: number;
} = {}) {
  const {
    strategy = 'hostPath',
    shared = false,
    warnings = ['跨节点无法共享 hostPath，每节点各占 67.0 GiB（2 个节点合计 134.0 GiB）；如需真共享请用 RWX PVC 或 NFS。'],
    perPodMiB = 68608,
    totalMiB = 137216,
    savedMiB = 68608,
  } = over;
  return {
    estimate: {
      perPodMiB,
      totalMiB,
      savedMiB,
      assumption: '采用 model.sizeMiB = 68608 MiB（67.0 GiB，视为已实测的真值，不再加余量）',
      replicas: 3,
      nodeCount: 2,
      naiveMiB: 205824,
      source: 'sizeMiB',
    },
    plan: {
      strategy,
      volumes: strategy === 'none' ? [] : [{ name: 'model-cache' }],
      volumeMounts: strategy === 'none' ? [] : [{ name: 'model-cache', mountPath: '/models' }],
      warnings,
      shared,
      ok: true,
      errors: [],
    },
  };
}

describe('CachePlan 缓存估算', () => {
  it('POST cache-estimate 并渲染策略 / 每 Pod / 共享后 / 省下的磁盘', async () => {
    const spy = mockFetch(jsonResponse(cacheBody()));
    await render(
      createElement(CachePlan, {
        modelPath: '/models/Qwen2.5-72B-Instruct',
        sizeMiB: 68608,
        replicas: 3,
        nodeCount: 2,
        debounceMs: 0,
      }),
    );

    const { url, init } = callAt(spy, 0);
    expect(url).toBe('/api/infra/cache-estimate');
    expect(init?.method).toBe('POST');
    const body = bodyAt(spy, 0);
    expect((body.model as { path: string }).path).toBe('/models/Qwen2.5-72B-Instruct');
    expect((body.model as { sizeMiB: number }).sizeMiB).toBe(68608);
    expect(body.replicas).toBe(3);
    expect(body.nodeCount).toBe(2);

    expect(text('cache-strategy')).toContain('hostPath');
    expect(text('cache-per-pod')).toBe('67.0 GiB');
    expect(text('cache-total')).toBe('134.0 GiB');
    expect(text('cache-saved')).toBe('67.0 GiB');
    expect(el('cache-shared')?.getAttribute('data-shared')).toBe('false');
  });

  it('shared:false 且跨节点：红色警告「每节点各占 X，DiskPressure 导致整节点 Evicted」', async () => {
    mockFetch(jsonResponse(cacheBody({ shared: false, strategy: 'hostPath' })));
    await render(
      createElement(CachePlan, {
        modelPath: '/models/Qwen2.5-72B-Instruct',
        sizeMiB: 68608,
        replicas: 3,
        nodeCount: 2,
        debounceMs: 0,
      }),
    );

    const warning = el('cache-cross-node-warning');
    expect(warning).not.toBeNull();
    const warningText = warning?.textContent ?? '';
    expect(warningText).toContain('每节点各占 67.0 GiB');
    expect(warningText).toContain('DiskPressure');
    expect(warningText).toContain('Evicted');
    // 红色系 class（不是绿/黄）
    expect(warning?.className).toContain('red');
    // 未共享时不能同时出现绿色共享提示
    expect(el('cache-shared-ok')).toBeNull();
  });

  it('共享策略（pvc-rwx）显示绿色提示，且没有红色警告', async () => {
    mockFetch(jsonResponse(cacheBody({ strategy: 'pvc-rwx', shared: true, warnings: [] })));
    await render(
      createElement(CachePlan, {
        modelPath: 'models/qwen-72b',
        sizeMiB: 68608,
        replicas: 3,
        nodeCount: 3,
        debounceMs: 0,
      }),
    );

    expect(text('cache-strategy')).toContain('pvc-rwx');
    expect(el('cache-shared')?.getAttribute('data-shared')).toBe('true');
    const ok = el('cache-shared-ok');
    expect(ok).not.toBeNull();
    expect(ok?.className).toContain('emerald');
    expect(text('cache-shared-ok')).toContain('67.0 GiB');
    expect(el('cache-cross-node-warning')).toBeNull();
    expect(all('cache-warning')).toHaveLength(0);
  });

  it('规划器告警逐条展示；路径为空时不发请求（停在 idle）', async () => {
    const spy = mockFetch(
      jsonResponse(cacheBody({ strategy: 'pvc-rwo', shared: false, warnings: ['RWO PVC 跨节点无法共享', '共享前请先预热目录'] })),
    );
    await render(createElement(CachePlan, { modelPath: '', debounceMs: 0 }));

    // 没有模型路径 → 不发注定被拒的请求
    expect(spy).not.toHaveBeenCalled();
    expect(el('cache-idle')).not.toBeNull();

    await fill('cache-model-path', 'models/qwen-72b');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(all('cache-warning')).toHaveLength(2);
    expect(text('cache-warnings')).toContain('RWO PVC 跨节点无法共享');
    expect(text('cache-warnings')).toContain('预热');
    expect(text('cache-assumption')).toContain('model.sizeMiB');
  });
});
