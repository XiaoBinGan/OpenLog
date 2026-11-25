/**
 * server/infra/autoscale.js 单测（B3：HPA 弹性）
 *
 * 覆盖五块：
 * 1. **校验**：合法最小配置 / 全字段配置，以及各类反例（min>max、max>8、缺指标、
 *    指标名非法、指标类型不在白名单、autoscale 不是对象）。每条都断言中文关键字与字段名，
 *    因为「错误信息能指导操作」是这个项目的硬要求。
 * 2. **渲染**：HPA 对象逐字段（apiVersion / kind / metadata / targetRef / min&maxReplicas /
 *    metrics / behavior），CPU、内存、Pods 三种指标各自的形态。
 * 3. **决策**：冷却期内 hold（reason 带剩余秒数）、扩容一次到目标、缩容一次只减 1、
 *    边界收敛（desired 超出 min..max）、入参不合法时 hold。
 * 4. **vGPU 预算**：内存受限 / 算力受限 / 整卡模式 / 刚好等于上限 / 未提供容量。
 * 5. **跨模块一致性**：MAX_REPLICAS_LIMIT 必须等于 guard 的 DEFAULT_LIMITS.replicas，
 *    否则会出现「HPA 扩到 8、护栏拒绝保存」的死锁；以及同输入两次渲染结果完全一致。
 */
import { describe, it, expect } from 'vitest';

import {
  validateAutoscale,
  renderHpa,
  evaluateScaleDecision,
  autoscaleBudget,
  MAX_REPLICAS_LIMIT,
  DEFAULT_MIN_REPLICAS,
  DEFAULT_COOLDOWN_SECONDS,
  MAX_COOLDOWN_SECONDS,
  SCALE_DOWN_MAX_STEP,
  METRIC_NAME_PATTERN,
  AUTOSCALE_METRIC_TYPES,
  RESOURCE_METRIC_NAMES,
  HPA_API_VERSION,
  HPA_KIND,
  MANAGED_BY_KEY,
  MANAGED_BY_VALUE,
} from '../infra/autoscale.js';

import { DEFAULT_LIMITS as GUARD_LIMITS } from '../infra/guard.js';

/** 一个典型的 vLLM 服务定义（只取 HPA 关心的字段）。 */
const SERVICE = {
  name: 'qwen3-8b-instruct',
  namespace: 'inference',
  replicas: 1,
  resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 0 },
};

/** 非法配置里找不到未定义字段时的兜底断言助手。 */
const fieldsOf = (errors) => errors.map((e) => e.field);

describe('validateAutoscale — 合法配置', () => {
  it('最小配置：只给 maxReplicas + 一个 CPU 指标，minReplicas / cooldownSeconds 走默认值', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: { maxReplicas: 4, metrics: [{ type: 'Resource', name: 'cpu', target: 70 }] },
    });

    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({
      minReplicas: DEFAULT_MIN_REPLICAS,
      maxReplicas: 4,
      cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
      metrics: [{ type: 'Resource', name: 'cpu', targetType: 'Utilization', averageUtilization: 70 }],
    });
    expect(DEFAULT_MIN_REPLICAS).toBe(1);
    expect(DEFAULT_COOLDOWN_SECONDS).toBe(300);
  });

  it('全字段配置：cpu + memory + Pods 自定义指标，cooldownSeconds 显式给出', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: {
        minReplicas: 2,
        maxReplicas: 6,
        cooldownSeconds: 600,
        metrics: [
          { type: 'Resource', name: 'cpu', target: 60 },
          { type: 'Resource', name: 'memory', target: { type: 'Utilization', averageUtilization: 80 } },
          { type: 'Pods', name: 'vllm_num_requests_waiting', target: '5' },
        ],
      },
    });

    expect(r.ok).toBe(true);
    expect(r.value.minReplicas).toBe(2);
    expect(r.value.maxReplicas).toBe(6);
    expect(r.value.cooldownSeconds).toBe(600);
    expect(r.value.metrics).toHaveLength(3);
    expect(r.value.metrics[2]).toEqual({
      type: 'Pods',
      name: 'vllm_num_requests_waiting',
      targetType: 'AverageValue',
      averageValue: '5',
    });
  });

  it('接受 k8s 原生形态的 metrics（resource.target / pods.metric.name）', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: {
        maxReplicas: 3,
        metrics: [
          {
            type: 'Resource',
            resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 75 } },
          },
          {
            type: 'Pods',
            pods: { metric: { name: 'vllm_waiting' }, target: { type: 'AverageValue', averageValue: '3' } },
          },
        ],
      },
    });

    expect(r.ok).toBe(true);
    expect(r.value.metrics[0].averageUtilization).toBe(75);
    expect(r.value.metrics[1]).toEqual({
      type: 'Pods',
      name: 'vllm_waiting',
      targetType: 'AverageValue',
      averageValue: '3',
    });
  });
});

describe('validateAutoscale — 反例', () => {
  it('minReplicas 大于 maxReplicas：报 minReplicas 字段，并说明会永久 Pending', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: { minReplicas: 5, maxReplicas: 3, metrics: [{ type: 'Resource', name: 'cpu', target: 70 }] },
    });

    expect(r.ok).toBe(false);
    expect(fieldsOf(r.errors)).toContain('minReplicas');
    const message = r.errors.find((e) => e.field === 'minReplicas').message;
    expect(message).toContain('不能大于 maxReplicas');
    expect(message).toContain('Pending');
  });

  it('maxReplicas 超过 8：报错并提到与护栏 REPLICAS_LIMIT 一致', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: { maxReplicas: 12, metrics: [{ type: 'Resource', name: 'cpu', target: 70 }] },
    });

    expect(r.ok).toBe(false);
    const message = r.errors.find((e) => e.field === 'maxReplicas').message;
    expect(message).toContain(`最大 ${MAX_REPLICAS_LIMIT}`);
    expect(message).toContain('REPLICAS_LIMIT');
    expect(message).toContain('12');
  });

  it('maxReplicas 缺失：必填报错（不静默给一个上限）', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: { metrics: [{ type: 'Resource', name: 'cpu', target: 70 }] },
    });

    expect(r.ok).toBe(false);
    const message = r.errors.find((e) => e.field === 'maxReplicas').message;
    expect(message).toContain('必填');
    expect(message).toContain('无限扩副本');
  });

  it('metrics 为空数组：报「至少需要 1 个指标」', () => {
    const r = validateAutoscale({ service: SERVICE, autoscale: { maxReplicas: 4, metrics: [] } });

    expect(r.ok).toBe(false);
    expect(fieldsOf(r.errors)).toContain('metrics');
    expect(r.errors.find((e) => e.field === 'metrics').message).toContain('至少需要 1 个指标');
  });

  it('Resource 指标名不在白名单（gpu）：报 metrics[0].name 并指向 Pods 类型', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: { maxReplicas: 4, metrics: [{ type: 'Resource', name: 'gpu', target: 70 }] },
    });

    expect(r.ok).toBe(false);
    const message = r.errors.find((e) => e.field === 'metrics[0].name').message;
    expect(message).toContain(RESOURCE_METRIC_NAMES.join(' / '));
    expect(message).toContain('Pods');
  });

  it('Pods 指标名不匹配 ^[a-z][a-z0-9_.-]{0,62}$：报命名规则', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: { maxReplicas: 4, metrics: [{ type: 'Pods', name: 'Vllm:Waiting', target: '5' }] },
    });

    expect(r.ok).toBe(false);
    const message = r.errors.find((e) => e.field === 'metrics[0].name').message;
    expect(message).toContain(String(METRIC_NAME_PATTERN));
    expect(message).toContain('Vllm:Waiting');
  });

  it('指标类型不在白名单（External）：报 type 只允许 Resource / Pods', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: {
        maxReplicas: 4,
        metrics: [{ type: 'External', name: 'qps', target: '10' }],
      },
    });

    expect(r.ok).toBe(false);
    const message = r.errors.find((e) => e.field === 'metrics[0].type').message;
    expect(message).toContain(AUTOSCALE_METRIC_TYPES.join(' / '));
    expect(message).toContain('External');
  });

  it('利用率目标不是 1..100 的整数：报 metrics[0].target', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: { maxReplicas: 4, metrics: [{ type: 'Resource', name: 'cpu', target: 170 }] },
    });

    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.field === 'metrics[0].target').message).toContain('1..100');
  });

  it('autoscale 不是对象：ok=false 且 value 为 null（不猜配置）', () => {
    const r = validateAutoscale({ service: SERVICE, autoscale: 'max=4' });

    expect(r.ok).toBe(false);
    expect(r.value).toBeNull();
    expect(r.errors[0].field).toBe('autoscale');
    expect(r.errors[0].message).toContain('对象');
  });

  it('service 缺 name / namespace：字段级中文报错（HPA 的 targetRef 依赖 name）', () => {
    const r = validateAutoscale({
      service: { resources: { memoryMiB: 8192 } },
      autoscale: { maxReplicas: 2, metrics: [{ type: 'Resource', name: 'cpu', target: 70 }] },
    });

    expect(r.ok).toBe(false);
    expect(fieldsOf(r.errors)).toContain('service.name');
    expect(fieldsOf(r.errors)).toContain('service.namespace');
  });
});

describe('renderHpa — 对象逐字段', () => {
  it('apiVersion / kind / metadata / targetRef / min&maxReplicas 全部按契约渲染', () => {
    const hpa = renderHpa({
      service: SERVICE,
      autoscale: {
        minReplicas: 1,
        maxReplicas: 4,
        cooldownSeconds: 300,
        metrics: [{ type: 'Resource', name: 'cpu', target: 70 }],
      },
    });

    expect(hpa).toEqual({
      apiVersion: HPA_API_VERSION,
      kind: HPA_KIND,
      metadata: {
        name: 'qwen3-8b-instruct',
        namespace: 'inference',
        labels: {
          app: 'qwen3-8b-instruct',
          [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
          'app.kubernetes.io/managed-by': MANAGED_BY_VALUE,
        },
        annotations: {
          'openlog.io/renderer-version': 'openlog-infra/v1',
          'openlog.io/cooldown-seconds': '300',
          'openlog.io/scale-down-max-step': '1',
          'openlog.io/replicas-limit': '8',
        },
      },
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'qwen3-8b-instruct' },
        minReplicas: 1,
        maxReplicas: 4,
        metrics: [
          { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } },
        ],
        behavior: {
          scaleUp: {
            stabilizationWindowSeconds: 0,
            selectPolicy: 'Max',
            policies: [{ type: 'Percent', value: 100, periodSeconds: 60 }],
          },
          scaleDown: {
            stabilizationWindowSeconds: 300,
            selectPolicy: 'Min',
            policies: [{ type: 'Pods', value: SCALE_DOWN_MAX_STEP, periodSeconds: 60 }],
          },
        },
      },
    });
    expect(HPA_API_VERSION).toBe('autoscaling/v2');
    expect(SCALE_DOWN_MAX_STEP).toBe(1);
  });

  it('CPU 指标渲染为 Resource + Utilization；缩容策略写死 Pods=1 且窗口跟随 cooldownSeconds', () => {
    const hpa = renderHpa({
      service: SERVICE,
      autoscale: { maxReplicas: 3, cooldownSeconds: 600, metrics: [{ type: 'Resource', name: 'cpu', target: 65 }] },
    });

    expect(hpa.spec.metrics).toEqual([
      { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 65 } } },
    ]);
    // 「缩容一次只减 1」必须写进集群侧，而不是只靠调用方守规矩
    expect(hpa.spec.behavior.scaleDown.policies).toEqual([
      { type: 'Pods', value: 1, periodSeconds: 60 },
    ]);
    expect(hpa.spec.behavior.scaleDown.stabilizationWindowSeconds).toBe(600);
    expect(hpa.metadata.annotations['openlog.io/cooldown-seconds']).toBe('600');
  });

  it('内存指标支持 Utilization 与 AverageValue 两种目标', () => {
    const hpa = renderHpa({
      service: SERVICE,
      autoscale: {
        maxReplicas: 2,
        metrics: [
          { type: 'Resource', name: 'memory', target: 85 },
          { type: 'Resource', name: 'cpu', target: { type: 'AverageValue', averageValue: '500m' } },
        ],
      },
    });

    expect(hpa.spec.metrics).toEqual([
      { type: 'Resource', resource: { name: 'memory', target: { type: 'Utilization', averageUtilization: 85 } } },
      { type: 'Resource', resource: { name: 'cpu', target: { type: 'AverageValue', averageValue: '500m' } } },
    ]);
  });

  it('Pods 自定义指标渲染为 metric.name + target.AverageValue', () => {
    const hpa = renderHpa({
      service: SERVICE,
      autoscale: { maxReplicas: 8, metrics: [{ type: 'Pods', name: 'vllm_num_requests_waiting', target: 5 }] },
    });

    expect(hpa.spec.metrics).toEqual([
      {
        type: 'Pods',
        pods: {
          metric: { name: 'vllm_num_requests_waiting' },
          target: { type: 'AverageValue', averageValue: '5' },
        },
      },
    ]);
  });

  it('配置非法时抛错（code=INFRA_INVALID_AUTOSCALE，errors 带字段明细）', () => {
    expect(() => renderHpa({ service: SERVICE, autoscale: { maxReplicas: 99, metrics: [] } })).toThrow();
    try {
      renderHpa({ service: SERVICE, autoscale: { maxReplicas: 99, metrics: [] } });
    } catch (error) {
      expect(error.code).toBe('INFRA_INVALID_AUTOSCALE');
      expect(Array.isArray(error.errors)).toBe(true);
      expect(error.message).toContain('弹性配置不合法');
      expect(error.errors.map((e) => e.field)).toContain('maxReplicas');
    }
  });
});

describe('evaluateScaleDecision — 冷却与步长', () => {
  const NOW = Date.UTC(2026, 0, 2, 3, 0, 0);

  it('冷却期内返回 hold，reason 说明还剩多少秒与解除时间', () => {
    const cooldownUntil = NOW + 180_000;
    const r = evaluateScaleDecision({
      current: 2,
      desired: 4,
      metrics: [{ name: 'cpu', value: 92, target: 70 }],
      cooldownUntil,
      now: NOW,
    });

    expect(r.action).toBe('hold');
    expect(r.replicas).toBe(2);
    expect(r.reason).toContain('冷却窗口内');
    expect(r.reason).toContain('还剩 180 秒');
    expect(r.reason).toContain(new Date(cooldownUntil).toISOString());
    expect(r.reason).toContain('当前 2 个副本，目标 4 个');
  });

  it('冷却已过期（cooldownUntil <= now）则正常扩容，且一次到目标', () => {
    const r = evaluateScaleDecision({
      current: 1,
      desired: 4,
      cooldownUntil: NOW - 1_000,
      now: NOW,
    });

    expect(r.action).toBe('up');
    expect(r.replicas).toBe(4);
    expect(r.reason).toContain('扩容');
    expect(r.reason).toContain('一次到目标');
  });

  it('缩容保守：一次只减 1 个副本（5 → 4，尽管目标是 2）', () => {
    const r = evaluateScaleDecision({ current: 5, desired: 2, now: NOW });

    expect(r.action).toBe('down');
    expect(r.replicas).toBe(4);
    expect(r.reason).toContain('一次最多减 1 个');
    expect(r.reason).toContain('避免雪崩');
    expect(r.reason).toContain('剩余');
  });

  it('缩容到 minReplicas 边界：2 → 1', () => {
    const r = evaluateScaleDecision({ current: 2, desired: 1, now: NOW, policy: { minReplicas: 1, maxReplicas: 4 } });

    expect(r.action).toBe('down');
    expect(r.replicas).toBe(1);
  });

  it('已在目标副本数：hold 且 reason 说明「已等于目标」', () => {
    const r = evaluateScaleDecision({ current: 3, desired: 3, now: NOW });

    expect(r.action).toBe('hold');
    expect(r.replicas).toBe(3);
    expect(r.reason).toContain('已等于目标 3');
  });

  it('desired 超出 maxReplicas：收敛到上限并在 reason 里说明', () => {
    const r = evaluateScaleDecision({ current: 2, desired: 20, now: NOW, policy: { maxReplicas: 8 } });

    expect(r.action).toBe('up');
    expect(r.replicas).toBe(8);
    expect(r.reason).toContain('已按允许范围 1..8 收敛到 8');
  });

  it('desired 低于 minReplicas：收敛到下限（0 → 1），不会把服务缩没', () => {
    const r = evaluateScaleDecision({ current: 3, desired: 0, now: NOW, policy: { minReplicas: 2, maxReplicas: 6 } });

    expect(r.action).toBe('down');
    expect(r.replicas).toBe(2);
    expect(r.reason).toContain('收敛到 2');
  });

  it('入参不合法时 hold（不猜、不乱扩）', () => {
    const badCurrent = evaluateScaleDecision({ current: 'two', desired: 4, now: NOW });
    expect(badCurrent.action).toBe('hold');
    expect(badCurrent.reason).toContain('当前副本数不合法');

    const badDesired = evaluateScaleDecision({ current: 3, desired: Number.NaN, now: NOW });
    expect(badDesired.action).toBe('hold');
    expect(badDesired.replicas).toBe(3);
    expect(badDesired.reason).toContain('目标副本数不合法');
  });

  it('接受 ISO 字符串形式的 cooldownUntil，并按秒级时间戳兜底解析', () => {
    const iso = new Date(NOW + 60_000).toISOString();
    const fromIso = evaluateScaleDecision({ current: 2, desired: 3, cooldownUntil: iso, now: NOW });
    expect(fromIso.action).toBe('hold');
    expect(fromIso.reason).toContain('还剩 60 秒');

    const fromSeconds = evaluateScaleDecision({
      current: 2,
      desired: 3,
      cooldownUntil: Math.floor((NOW + 30_000) / 1000),
      now: NOW,
    });
    expect(fromSeconds.action).toBe('hold');
    expect(fromSeconds.reason).toContain('还剩 30 秒');
  });
});

describe('autoscaleBudget — vGPU 预算', () => {
  it('内存受限：单卡 24576 MiB、每副本 8192 MiB → 最多 3 个副本，maxReplicas=4 超预算', () => {
    const budget = autoscaleBudget({
      service: SERVICE,
      autoscale: { maxReplicas: 4 },
      capacity: { perCardMemMiB: 24576, perCardCores: 100 },
    });

    expect(budget.maxReplicasByMemory).toBe(3);
    expect(budget.allowed).toBe(false);
    expect(budget.reason).toContain('只能放 3 个副本');
    expect(budget.reason).toContain('请把 maxReplicas 下调到 3 以内');
    expect(budget.reason).toContain('Pending');
  });

  it('算力受限：单卡 100%、每副本 40% → 最多 2 个副本', () => {
    const budget = autoscaleBudget({
      service: { ...SERVICE, resources: { accelerators: 1, memoryMiB: 1024, coresPercent: 40 } },
      autoscale: { maxReplicas: 4 },
      capacity: { perCardMemMiB: 24576, perCardCores: 100 },
    });

    expect(budget.maxReplicasByMemory).toBe(24);
    expect(budget.maxReplicasByCores).toBe(2);
    expect(budget.allowed).toBe(false);
    expect(budget.reason).toContain('算力');
    expect(budget.reason).toContain('只能放 2 个副本');
  });

  it('整卡模式（memoryMiB=0）：单卡只能放 1 个副本，并点名 HAMi 的 CardInsufficientMemory', () => {
    const budget = autoscaleBudget({
      service: { ...SERVICE, resources: { accelerators: 1, memoryMiB: 0, coresPercent: 0 } },
      autoscale: { maxReplicas: 2 },
      capacity: { perCardMemMiB: 49152, perCardCores: 100 },
    });

    expect(budget.maxReplicasByMemory).toBe(1);
    expect(budget.allowed).toBe(false);
    expect(budget.reason).toContain('整卡模式');
    expect(budget.reason).toContain('CardInsufficientMemory');
  });

  it('边界值：maxReplicas 刚好等于上限（32768 / 8192 = 4）时 allowed=true', () => {
    const budget = autoscaleBudget({
      service: SERVICE,
      autoscale: { maxReplicas: 4 },
      capacity: { perCardMemMiB: 32768, perCardCores: 100 },
    });

    expect(budget.maxReplicasByMemory).toBe(4);
    expect(budget.maxReplicasByCores).toBe(4);
    expect(budget.allowed).toBe(true);
    expect(budget.reason).toContain('在单卡预算内');
  });

  it('未提供 capacity：不假装知道，allowed=true 但 reason 说明跳过了检查', () => {
    const budget = autoscaleBudget({ service: SERVICE, autoscale: { maxReplicas: 8 } });

    expect(budget.maxReplicasByMemory).toBeNull();
    expect(budget.maxReplicasByCores).toBeNull();
    expect(budget.allowed).toBe(true);
    expect(budget.reason).toContain('跳过');
    expect(budget.reason).toContain('maxReplicas=8');
  });

  it('validateAutoscale 带 capacity 时，预算超标直接变成 maxReplicas 字段级错误', () => {
    const r = validateAutoscale({
      service: SERVICE,
      autoscale: { maxReplicas: 4, metrics: [{ type: 'Resource', name: 'cpu', target: 70 }] },
      capacity: { perCardMemMiB: 24576, perCardCores: 100 },
    });

    expect(r.ok).toBe(false);
    expect(r.budget.allowed).toBe(false);
    const message = r.errors.find((e) => e.field === 'maxReplicas').message;
    expect(message).toContain('只能放 3 个副本');
  });
});

describe('跨模块一致性与确定性', () => {
  it('MAX_REPLICAS_LIMIT 必须等于 guard 的 DEFAULT_LIMITS.replicas（否则会死锁）', () => {
    expect(MAX_REPLICAS_LIMIT).toBe(GUARD_LIMITS.replicas);
    expect(MAX_REPLICAS_LIMIT).toBe(8);
    expect(MAX_COOLDOWN_SECONDS).toBe(3600);
  });

  it('同输入两次渲染结果序列化完全一致（键序稳定）', () => {
    const args = {
      service: SERVICE,
      autoscale: {
        minReplicas: 1,
        maxReplicas: 4,
        cooldownSeconds: 300,
        metrics: [
          { type: 'Resource', name: 'cpu', target: 70 },
          { type: 'Pods', name: 'vllm_waiting', target: 5 },
        ],
      },
    };

    expect(JSON.stringify(renderHpa(args))).toBe(JSON.stringify(renderHpa(args)));
  });
});
