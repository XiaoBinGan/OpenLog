/**
 * infra-guard.test.js —— AI Infra 护栏（A2）的验收测试
 *
 * 这个文件要证明四件事，少一件护栏就不算做对：
 *   1. **每条红线都真的拦得住**：命名空间白名单、总开关、资源上限、归属标签、
 *      大幅变更、系统命名空间 —— 每个 code 至少一例，且都断言到「独立 code」而
 *      不是靠 message 文本匹配（message 是给用户看的，随时可能改文案）。
 *   2. **合法变更必须放行**：护栏太严会逼用户绕过它（手工 kubectl），那等于没有护栏。
 *      所以「正常创建 / 正常小改 / 正常删除自己的对象」都要有反向用例。
 *   3. **force 只放开它该放开的那一条**：force 能让 "1 → 8 副本" 过去并留审计标记，
 *      但**绝不能**顺手放过「改动别人的对象」—— 这是最容易被写成提权后门的地方。
 *   4. **impact 说真话**：改配额必须 `restarts: true`（k8s 里 resources 不可原地改，
 *      必须重建 Pod），单副本重建要给保守中断值；只改副本数不算重启。
 *      这条是产品对用户的承诺，不能为了「看起来更好」而填成 false / 0。
 *
 * 另：diff 的两个边界（无变化返回空串、超 200 行截断并标注）单独立了用例，
 * 因为前端靠「diff 为空串」来决定是否显示预览块。
 */
import { describe, it, expect } from 'vitest';
import {
  checkGuard,
  renderDiff,
  summarizeImpact,
  isManaged,
  markManaged,
  resolveLimits,
  parseMemoryMiB,
  VIOLATION_CODES,
  ALLOWED_NAMESPACES,
  DEFAULT_LIMITS,
  DIFF_MAX_LINES,
  DOWNTIME_ESTIMATE,
  MANAGED_BY_VALUE,
} from '../infra/guard.js';

// ─── 夹具 ────────────────────────────────────────────────────────────────

/** 开关打开的环境变量（默认关闭是铁律 4，所以每条正例都要显式给） */
const INFRA_ON = { OPENLOG_K8S_INFRA: '1' };
/** 开关关闭 */
const INFRA_OFF = { OPENLOG_K8S_INFRA: '0' };

/**
 * 一份合法的 ModelService 意图（A1 的模型形状）。
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
function service(overrides = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'qwen-7b',
    namespace: 'inference',
    model: { source: 'hostPath', path: '/models/Qwen2.5-7B-Instruct', format: 'safetensors', quantization: 'fp16' },
    engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.6.3', args: ['--max-model-len', '8192'] },
    resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 50 },
    replicas: 1,
    placement: { acceleratorModel: 'NVIDIA GeForce RTX 4090' },
    ports: [{ name: 'http', containerPort: 8000 }],
    health: { path: '/health', initialDelaySeconds: 30 },
    expose: { gatewayPort: 8080 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

/**
 * 「已存在且归我们管」的现状：带 managedBy 标签。
 * @param {Record<string, any>} [overrides]
 */
function managedExisting(overrides = {}) {
  return service({ labels: { managedBy: MANAGED_BY_VALUE }, ...overrides });
}

/**
 * 已存在但**不是**我们创建的对象（例如运维手工 kubectl apply 的）。
 * @param {Record<string, any>} [overrides]
 */
function foreignExisting(overrides = {}) {
  return service({ labels: { team: 'platform' }, ...overrides });
}

/**
 * 渲染后的 Deployment（A1 renderModelService 的产物形状，取字段子集）。
 * @param {{ replicas?: number, image?: string, memoryMiB?: number, gpu?: number, labels?: Record<string,string> }} [options]
 */
function renderedDeployment(options = {}) {
  const {
    replicas = 1,
    image = 'vllm/vllm-openai:v0.6.3',
    memoryMiB = 4096,
    gpu = 1,
    labels = { managedBy: 'openlog-infra' },
  } = options;
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'qwen-7b',
      namespace: 'inference',
      labels,
      // 服务端每次写入都会改这几个字段：diff / impact 必须无视它们
      resourceVersion: '88888',
      uid: '0f0f0f0f-1111-2222-3333-444444444444',
      creationTimestamp: '2026-01-01T00:00:00Z',
      generation: 7,
    },
    spec: {
      replicas,
      selector: { matchLabels: { app: 'qwen-7b' } },
      template: {
        metadata: { labels: { app: 'qwen-7b', ...labels } },
        spec: {
          containers: [
            {
              name: 'engine',
              image,
              args: ['--max-model-len', '8192'],
              ports: [{ name: 'http', containerPort: 8000 }],
              resources: {
                limits: {
                  'nvidia.com/gpu': String(gpu),
                  memory: `${memoryMiB}Mi`,
                },
              },
            },
          ],
        },
      },
    },
  };
}

/**
 * 渲染对象 + HAMi 的显存/算力键。
 * 真实集群里 A1/A3 渲染出来的是 `nvidia.com/gpumem`（MiB 整数），
 * 与容器内存 `memory` 是两回事 —— 护栏必须认这个键。
 * @param {{ memoryMiB?: number, gpu?: number, coresPercent?: number }} [options]
 */
function renderedWithVram(options = {}) {
  const { memoryMiB = 4096, gpu = 1, coresPercent = 50 } = options;
  const dep = renderedDeployment({ memoryMiB, gpu });
  dep.spec.template.spec.containers[0].resources.limits['nvidia.com/gpumem'] = String(memoryMiB);
  dep.spec.template.spec.containers[0].resources.limits['nvidia.com/gpucores'] = String(coresPercent);
  return dep;
}

/** 只取 codes，断言时更好读 */
function codesOf(result) {
  return result.violations.map((v) => v.code);
}

/** 取某条违规 */
function findByCode(result, code) {
  return result.violations.find((v) => v.code === code);
}

const hasChinese = (text) => /[\u4e00-\u9fa5]/.test(text);

// ─── 1. 合法变更必须放行 ─────────────────────────────────────────────────

describe('checkGuard：合法变更放行', () => {
  it('新建一个白名单内、配额正常、开关打开的服务 → allowed，且没有任何违规', () => {
    const result = checkGuard({ service: service(), existing: null, settings: {}, env: INFRA_ON });

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.audit).toBeNull();
    expect(result.key).toBe('inference/qwen-7b');
  });

  it('新建时 diff 是「全新增」，每行都以 + 开头', () => {
    const result = checkGuard({ service: service(), existing: null, env: INFRA_ON });
    const body = result.diff.split('\n').filter((line) => line && !line.startsWith('---') && !line.startsWith('+++'));

    expect(result.diff).not.toBe('');
    expect(body.length).toBeGreaterThan(0);
    // 允许 hunk 头（@@）存在，其余正文必须全是新增行
    const content = body.filter((line) => !line.startsWith('@@'));
    expect(content.every((line) => line.startsWith('+'))).toBe(true);
  });

  it('修改自己创建的对象、幅度很小（1 → 2 副本）→ allowed', () => {
    const result = checkGuard({
      service: service({ replicas: 2 }),
      existing: managedExisting({ replicas: 1 }),
      settings: {},
      env: INFRA_ON,
    });

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.diff).not.toBe('');
  });

  it('恰好 4 倍（1 → 4 副本）不算「大幅变更」→ allowed', () => {
    const result = checkGuard({
      service: service({ replicas: 4 }),
      existing: managedExisting({ replicas: 1 }),
      env: INFRA_ON,
    });

    expect(codesOf(result)).not.toContain(VIOLATION_CODES.BIG_CHANGE);
    expect(result.allowed).toBe(true);
  });

  it('删除自己创建的对象 → allowed（且 diff 是「全删除」）', () => {
    const result = checkGuard({ existing: managedExisting(), op: 'delete', env: INFRA_ON });

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.diff).toMatch(/^-\{?/m);
    const removed = result.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
    expect(removed.length).toBeGreaterThan(0);
  });

  it('infra-test 命名空间同样放行（试跑通道不能被自己堵死）', () => {
    const result = checkGuard({ service: service({ namespace: 'infra-test' }), existing: null, env: INFRA_ON });

    expect(ALLOWED_NAMESPACES).toContain('infra-test');
    expect(result.allowed).toBe(true);
  });
});

// ─── 2. 命名空间 ─────────────────────────────────────────────────────────

describe('checkGuard：命名空间白名单', () => {
  it('自创的命名空间（prod）→ NAMESPACE_FORBIDDEN', () => {
    const result = checkGuard({ service: service({ namespace: 'prod' }), existing: null, env: INFRA_ON });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.NAMESPACE_FORBIDDEN);
    expect(findByCode(result, VIOLATION_CODES.NAMESPACE_FORBIDDEN).field).toBe('namespace');
  });

  it('kube-system 里的对象即使 name 完全合法也拒绝，并在文案里点名系统命名空间', () => {
    const result = checkGuard({
      service: service({ namespace: 'kube-system', name: 'valid-dns1123-name' }),
      existing: null,
      env: INFRA_ON,
    });

    const v = findByCode(result, VIOLATION_CODES.NAMESPACE_FORBIDDEN);
    expect(result.allowed).toBe(false);
    expect(v).toBeTruthy();
    expect(v.message).toContain('kube-system');
    expect(v.message).toContain('系统命名空间');
    expect(hasChinese(v.message)).toBe(true);
  });

  it('default 命名空间同样拒绝', () => {
    const result = checkGuard({ service: service({ namespace: 'default' }), existing: null, env: INFRA_ON });

    expect(codesOf(result)).toContain(VIOLATION_CODES.NAMESPACE_FORBIDDEN);
    expect(result.allowed).toBe(false);
  });

  it('完全没给 namespace → 拒绝（不能默认落到 default）', () => {
    const { namespace, ...nameless } = service();
    const result = checkGuard({ service: nameless, existing: null, env: INFRA_ON });

    expect(codesOf(result)).toContain(VIOLATION_CODES.NAMESPACE_FORBIDDEN);
    expect(result.allowed).toBe(false);
    expect(hasChinese(findByCode(result, VIOLATION_CODES.NAMESPACE_FORBIDDEN).message)).toBe(true);
  });

  it('existing 在系统命名空间（哪怕 after 写的是 inference）也要拒绝', () => {
    const result = checkGuard({
      service: service(),
      existing: managedExisting({ namespace: 'kube-system' }),
      env: INFRA_ON,
    });

    expect(codesOf(result)).toContain(VIOLATION_CODES.NAMESPACE_FORBIDDEN);
    expect(result.allowed).toBe(false);
  });
});

// ─── 3. 总开关 ───────────────────────────────────────────────────────────

describe('checkGuard：能力开关（默认关闭）', () => {
  it("env 里没有 OPENLOG_K8S_INFRA → INFRA_DISABLED", () => {
    const result = checkGuard({ service: service(), existing: null, env: {} });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.INFRA_DISABLED);
    expect(findByCode(result, VIOLATION_CODES.INFRA_DISABLED).field).toBe('OPENLOG_K8S_INFRA');
    expect(findByCode(result, VIOLATION_CODES.INFRA_DISABLED).message).toContain('OPENLOG_K8S_INFRA=1');
  });

  it("env 传 undefined 也不放行（不能把「没配置」当「已启用」）", () => {
    const result = checkGuard({ service: service(), existing: null });

    expect(codesOf(result)).toContain(VIOLATION_CODES.INFRA_DISABLED);
    expect(result.allowed).toBe(false);
  });

  it("只认字符串 '1'：'true' / '0' 都算关闭", () => {
    for (const value of ['0', 'true', 'yes', 'on', '']) {
      const result = checkGuard({ service: service(), existing: null, env: { OPENLOG_K8S_INFRA: value } });
      expect(codesOf(result), `value=${value}`).toContain(VIOLATION_CODES.INFRA_DISABLED);
    }
  });

  it('开关关闭时 namespace 违规也要一起报出来（用户一次看到全部问题）', () => {
    const result = checkGuard({ service: service({ namespace: 'prod' }), existing: null, env: INFRA_OFF });

    expect(codesOf(result)).toEqual(
      expect.arrayContaining([VIOLATION_CODES.NAMESPACE_FORBIDDEN, VIOLATION_CODES.INFRA_DISABLED]),
    );
  });
});

// ─── 4. 资源上限 ─────────────────────────────────────────────────────────

describe('checkGuard：资源上限', () => {
  it('显存配额超过默认 65536 MiB → MEMORY_LIMIT_EXCEEDED', () => {
    const result = checkGuard({
      service: service({ resources: { accelerators: 1, memoryMiB: DEFAULT_LIMITS.memoryMiB + 1, coresPercent: 50 } }),
      existing: null,
      env: INFRA_ON,
    });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.MEMORY_LIMIT_EXCEEDED);
    expect(findByCode(result, VIOLATION_CODES.MEMORY_LIMIT_EXCEEDED).field).toBe('resources.memoryMiB');
  });

  it('settings 可以把上限调低（按小机器部署时），例如 8192', () => {
    const result = checkGuard({
      service: service({ resources: { accelerators: 1, memoryMiB: 16384, coresPercent: 50 } }),
      existing: null,
      settings: { maxMemoryMiB: 8192 },
      env: INFRA_ON,
    });

    expect(resolveLimits({ maxMemoryMiB: 8192 }).memoryMiB).toBe(8192);
    expect(codesOf(result)).toContain(VIOLATION_CODES.MEMORY_LIMIT_EXCEEDED);
  });

  it('settings 也可以把上限调高，此时 70000 MiB 放行', () => {
    const result = checkGuard({
      service: service({ resources: { accelerators: 1, memoryMiB: 70000, coresPercent: 50 } }),
      existing: null,
      settings: { limits: { memoryMiB: 131072 } },
      env: INFRA_ON,
    });

    expect(codesOf(result)).not.toContain(VIOLATION_CODES.MEMORY_LIMIT_EXCEEDED);
    expect(result.allowed).toBe(true);
  });

  it('加速卡超过 8 张 → ACCELERATOR_LIMIT_EXCEEDED', () => {
    const result = checkGuard({
      service: service({ resources: { accelerators: DEFAULT_LIMITS.accelerators + 1, memoryMiB: 4096, coresPercent: 50 } }),
      existing: null,
      env: INFRA_ON,
    });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.ACCELERATOR_LIMIT_EXCEEDED);
    expect(findByCode(result, VIOLATION_CODES.ACCELERATOR_LIMIT_EXCEEDED).field).toBe('resources.accelerators');
  });

  it('副本数超过 8 → REPLICAS_LIMIT_EXCEEDED', () => {
    const result = checkGuard({ service: service({ replicas: 9 }), existing: null, env: INFRA_ON });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.REPLICAS_LIMIT_EXCEEDED);
    expect(findByCode(result, VIOLATION_CODES.REPLICAS_LIMIT_EXCEEDED).field).toBe('replicas');
  });

  it('副本数 0（等于把服务停掉）也归到 REPLICAS_LIMIT_EXCEEDED', () => {
    const result = checkGuard({ service: service({ replicas: 0 }), existing: managedExisting(), env: INFRA_ON });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.REPLICAS_LIMIT_EXCEEDED);
  });

  it('删除不看配额（否则超限的对象永远删不掉）', () => {
    const result = checkGuard({
      existing: managedExisting({ replicas: 99, resources: { accelerators: 16, memoryMiB: 999999, coresPercent: 100 } }),
      op: 'delete',
      env: INFRA_ON,
    });

    expect(codesOf(result)).not.toContain(VIOLATION_CODES.MEMORY_LIMIT_EXCEEDED);
    expect(codesOf(result)).not.toContain(VIOLATION_CODES.REPLICAS_LIMIT_EXCEEDED);
    expect(result.allowed).toBe(true);
  });

  it('三条上限同时越界时给出三个不同的 code（不是一个笼统的失败）', () => {
    const result = checkGuard({
      service: service({
        replicas: 99,
        resources: { accelerators: 99, memoryMiB: 999999, coresPercent: 100 },
      }),
      existing: null,
      env: INFRA_ON,
    });

    expect(codesOf(result)).toEqual(
      expect.arrayContaining([
        VIOLATION_CODES.MEMORY_LIMIT_EXCEEDED,
        VIOLATION_CODES.ACCELERATOR_LIMIT_EXCEEDED,
        VIOLATION_CODES.REPLICAS_LIMIT_EXCEEDED,
      ]),
    );
    expect(new Set(codesOf(result)).size).toBe(codesOf(result).length);
  });
});

// ─── 5. 归属：只能动自己创建的对象 ───────────────────────────────────────

describe('checkGuard：归属（禁止改动别人的对象）', () => {
  it('同 key 已存在但不是本系统创建 → NOT_MANAGED，文案要能指导操作', () => {
    const result = checkGuard({ service: service({ replicas: 2 }), existing: foreignExisting(), env: INFRA_ON });

    const v = findByCode(result, VIOLATION_CODES.NOT_MANAGED);
    expect(result.allowed).toBe(false);
    expect(v).toBeTruthy();
    expect(v.field).toBe('managedBy');
    expect(v.message).toContain('managedBy=openlog-infra');
    expect(v.message).toContain('误删');
    expect(hasChinese(v.message)).toBe(true);
  });

  it('删除未受管对象 → NOT_MANAGED（这是最危险的路径：点删除不能删掉别人的生产）', () => {
    const result = checkGuard({ existing: foreignExisting(), op: 'delete', env: INFRA_ON });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.NOT_MANAGED);
    expect(findByCode(result, VIOLATION_CODES.NOT_MANAGED).message).toContain('删除');
  });

  it('把 managedBy 写成别的值（冒用归属）→ NOT_MANAGED', () => {
    const result = checkGuard({
      service: service({ labels: { managedBy: 'some-other-operator' } }),
      existing: null,
      env: INFRA_ON,
    });

    expect(codesOf(result)).toContain(VIOLATION_CODES.NOT_MANAGED);
    expect(result.allowed).toBe(false);
  });

  it('渲染后的 Deployment 没带 managedBy 标签 → NOT_MANAGED', () => {
    const result = checkGuard({
      service: service({ replicas: 2 }),
      existing: renderedDeployment({ labels: { app: 'qwen-7b' } }),
      env: INFRA_ON,
    });

    expect(codesOf(result)).toContain(VIOLATION_CODES.NOT_MANAGED);
    expect(result.allowed).toBe(false);
  });

  it('isManaged / markManaged 的标签契约一致（A1/A5 复用同一份判定）', () => {
    expect(isManaged(renderedDeployment())).toBe(true);
    expect(isManaged(renderedDeployment({ labels: {} }))).toBe(false);
    expect(isManaged({ metadata: { labels: { 'app.kubernetes.io/managed-by': 'openlog-infra' } } })).toBe(true);
    expect(isManaged(null)).toBe(false);

    const marked = markManaged({ kind: 'Deployment', metadata: { name: 'x', labels: { app: 'x' } } });
    expect(isManaged(marked)).toBe(true);
    expect(marked.metadata.labels.app).toBe('x'); // 不覆盖已有标签
  });
});

// ─── 6. 变更幅度保护 + force ─────────────────────────────────────────────

describe('checkGuard：变更幅度（BIG_CHANGE）与 force', () => {
  it('副本数 1 → 8（8 倍）→ BIG_CHANGE，field 指向 replicas', () => {
    const result = checkGuard({
      service: service({ replicas: 8 }),
      existing: managedExisting({ replicas: 1 }),
      env: INFRA_ON,
    });

    const v = findByCode(result, VIOLATION_CODES.BIG_CHANGE);
    expect(result.allowed).toBe(false);
    expect(v).toBeTruthy();
    expect(v.field).toBe('replicas');
    expect(v.message).toContain('4 倍');
  });

  it('显存配额 1024 → 8192（8 倍）→ BIG_CHANGE，field 指向 resources.memoryMiB', () => {
    const result = checkGuard({
      service: service({ resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 50 } }),
      existing: managedExisting({ resources: { accelerators: 1, memoryMiB: 1024, coresPercent: 50 } }),
      env: INFRA_ON,
    });

    const v = findByCode(result, VIOLATION_CODES.BIG_CHANGE);
    expect(result.allowed).toBe(false);
    expect(v.field).toBe('resources.memoryMiB');
  });

  it('从「不限制」（0 MiB）改成具体限额也算大幅变更 → BIG_CHANGE', () => {
    const result = checkGuard({
      service: service({ resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 50 } }),
      existing: managedExisting({ resources: { accelerators: 1, memoryMiB: 0, coresPercent: 50 } }),
      env: INFRA_ON,
    });

    expect(codesOf(result)).toContain(VIOLATION_CODES.BIG_CHANGE);
    expect(result.allowed).toBe(false);
  });

  it('force: true 放行 BIG_CHANGE，但违规仍保留（overridden）并写审计标记', () => {
    const result = checkGuard({
      service: service({ replicas: 8 }),
      existing: managedExisting({ replicas: 1 }),
      env: INFRA_ON,
      force: true,
    });

    expect(result.allowed).toBe(true);
    const v = findByCode(result, VIOLATION_CODES.BIG_CHANGE);
    expect(v).toBeTruthy();
    expect(v.overridden).toBe(true);
    expect(result.audit).not.toBeNull();
    expect(result.audit.forced).toContain(VIOLATION_CODES.BIG_CHANGE);
    expect(result.audit.note).toContain('审计');
  });

  it('force 不能放过 NOT_MANAGED（提权后门测试：最容易被写错的一行）', () => {
    const result = checkGuard({
      service: service({ replicas: 8 }),
      existing: foreignExisting({ replicas: 1 }),
      env: INFRA_ON,
      force: true,
    });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.NOT_MANAGED);
    expect(findByCode(result, VIOLATION_CODES.NOT_MANAGED).overridden).toBeUndefined();
  });

  it('force 也不能放过命名空间/开关/配额', () => {
    const result = checkGuard({
      service: service({ namespace: 'prod', replicas: 99 }),
      existing: null,
      env: INFRA_ON,
      force: true,
    });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toEqual(
      expect.arrayContaining([VIOLATION_CODES.NAMESPACE_FORBIDDEN, VIOLATION_CODES.REPLICAS_LIMIT_EXCEEDED]),
    );
  });

  it('没有大幅变更时 force 不产生审计噪音（audit 为 null）', () => {
    const result = checkGuard({
      service: service({ replicas: 2 }),
      existing: managedExisting({ replicas: 1 }),
      env: INFRA_ON,
      force: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.audit).toBeNull();
  });
});

// ─── 7. 请求形状 ─────────────────────────────────────────────────────────

describe('checkGuard：请求形状', () => {
  it('什么都没传 → INVALID_SERVICE（护栏不能因为「没看懂」就默认放行）', () => {
    const result = checkGuard({ env: INFRA_ON });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.INVALID_SERVICE);
  });

  it('缺 name → INVALID_SERVICE', () => {
    const { name, ...nameless } = service();
    const result = checkGuard({ service: nameless, existing: null, env: INFRA_ON });

    expect(codesOf(result)).toContain(VIOLATION_CODES.INVALID_SERVICE);
    expect(findByCode(result, VIOLATION_CODES.INVALID_SERVICE).field).toBe('name');
  });

  it('每条 violation 都有可用 code + 中文可操作 message', () => {
    const result = checkGuard({
      service: service({ namespace: 'prod', replicas: 99, resources: { accelerators: 99, memoryMiB: 999999, coresPercent: 100 } }),
      existing: foreignExisting(),
      env: {},
    });
    const knownCodes = new Set(Object.values(VIOLATION_CODES));

    expect(result.violations.length).toBeGreaterThanOrEqual(5);
    for (const v of result.violations) {
      expect(knownCodes.has(v.code), `未知 code: ${v.code}`).toBe(true);
      expect(typeof v.message).toBe('string');
      expect(v.message.length).toBeGreaterThan(8);
      expect(hasChinese(v.message), `message 应是中文: ${v.message}`).toBe(true);
    }
  });
});

// ─── 8. renderDiff ───────────────────────────────────────────────────────

describe('renderDiff：文本 diff', () => {
  it('完全相同的对象 → 空字符串（前端据此隐藏预览块）', () => {
    expect(renderDiff(service(), service())).toBe('');
    expect(renderDiff(null, null)).toBe('');
    expect(renderDiff(undefined, undefined)).toBe('');
  });

  it('只有记账字段变化 → 仍然是空字符串（否则每次保存都「有变化」）', () => {
    const before = service({ version: 1 });
    const after = service({ version: 2, updatedAt: '2026-06-01T00:00:00.000Z' });

    expect(renderDiff(before, after)).toBe('');
  });

  it('有变化时输出 unified 风格头，且只列出变化的行', () => {
    const before = service({ replicas: 1 });
    const after = service({ replicas: 2 });
    const diff = renderDiff(before, after);

    expect(diff).toContain('--- before');
    expect(diff).toContain('+++ after');
    expect(diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    expect(diff).toContain('-  "replicas": 1,');
    expect(diff).toContain('+  "replicas": 2,');
    // 没变的行不出现（否则 diff 变成整份对象的粘贴板）
    expect(diff).not.toContain('"name": "qwen-7b"');
  });

  it('超过 200 行时截断并明确标注（不静默丢内容）', () => {
    const before = service({ engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.6.3', args: [] } });
    const after = service({
      engine: {
        type: 'vllm',
        image: 'vllm/vllm-openai:v0.6.3',
        args: Array.from({ length: 300 }, (_, i) => `--flag-${i}=value-${i}`),
      },
    });
    const diff = renderDiff(before, after);
    const lines = diff.split('\n');

    expect(diff).toContain('diff 已截断');
    expect(diff).toContain(String(DIFF_MAX_LINES));
    // 头部 2 行 + 正文 ≤ 200 行 + 截断提示 1 行
    expect(lines.length).toBeLessThanOrEqual(DIFF_MAX_LINES + 3);
  });

  it('maxLines 可被调用方调小（前端预览块高度固定时用）', () => {
    const before = service({ engine: { type: 'vllm', image: 'a', args: [] } });
    const after = service({ engine: { type: 'vllm', image: 'a', args: Array.from({ length: 50 }, (_, i) => `--x${i}`) } });
    const diff = renderDiff(before, after, { maxLines: 10 });

    expect(diff.split('\n').length).toBeLessThanOrEqual(10 + 3);
    expect(diff).toContain('diff 已截断');
  });

  it('支持渲染后的 k8s 对象数组，并忽略 resourceVersion / generation 这类易变字段', () => {
    const before = [renderedDeployment({ image: 'vllm/vllm-openai:v0.6.3' })];
    const after = [renderedDeployment({ image: 'vllm/vllm-openai:v0.7.0' })];
    const diff = renderDiff(before, after);

    // 段落头 `# Deployment/...` 两侧相同 → 属于「未变的行」，不应出现在 diff 里
    expect(diff).not.toContain('# Deployment');
    expect(diff).toContain('-            "image": "vllm/vllm-openai:v0.6.3",');
    expect(diff).toContain('+            "image": "vllm/vllm-openai:v0.7.0",');
    expect(diff).not.toContain('resourceVersion');
    expect(diff).not.toContain('generation');
  });

  it('渲染对象完全一致（只差 resourceVersion）→ 空字符串', () => {
    const a = renderedDeployment();
    const b = renderedDeployment();
    b.metadata.resourceVersion = '99999';

    expect(renderDiff(a, b)).toBe('');
  });
});

// ─── 9. summarizeImpact ──────────────────────────────────────────────────

describe('summarizeImpact：影响判定', () => {
  it('create：没有现有副本，不算重启也不算中断', () => {
    const impact = summarizeImpact(null, service());

    expect(impact.action).toBe('create');
    expect(impact.restarts).toBe(false);
    expect(impact.downtimeEstimateSec).toBe(0);
    expect(impact.reasons.length).toBeGreaterThan(0);
  });

  it('update（镜像）：Pod 会被替换 → restarts true，单副本给保守中断值', () => {
    const impact = summarizeImpact(
      managedExisting({ engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.6.3' } }),
      managedExisting({ engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.7.0' } }),
    );

    expect(impact.action).toBe('update');
    expect(impact.restarts).toBe(true);
    expect(impact.downtimeEstimateSec).toBeGreaterThanOrEqual(30);
    expect(impact.reasons.join('\n')).toContain('镜像');
  });

  it('update（配额 memoryMiB）：resources 不可原地修改 → 必须 restarts true', () => {
    const impact = summarizeImpact(
      managedExisting({ resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 50 } }),
      managedExisting({ resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 50 } }),
    );

    expect(impact.action).toBe('update');
    expect(impact.restarts).toBe(true);
    expect(impact.downtimeEstimateSec).toBeGreaterThanOrEqual(30); // 单副本
    expect(impact.reasons.join('\n')).toContain('resources');
  });

  it('update（配额 × 多副本）：仍要 restarts true，但中断明显更低', () => {
    const impact = summarizeImpact(
      managedExisting({ replicas: 3, resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 50 } }),
      managedExisting({ replicas: 3, resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 50 } }),
    );

    expect(impact.restarts).toBe(true);
    expect(impact.downtimeEstimateSec).toBeLessThan(DOWNTIME_ESTIMATE.singleReplicaSec);
    expect(impact.downtimeEstimateSec).toBeGreaterThan(0);
  });

  it('update（只改 coresPercent / accelerators）同样 restarts true', () => {
    const cores = summarizeImpact(
      managedExisting({ resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 50 } }),
      managedExisting({ resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 80 } }),
    );
    const cards = summarizeImpact(
      managedExisting({ resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 50 } }),
      managedExisting({ resources: { accelerators: 2, memoryMiB: 4096, coresPercent: 50 } }),
    );

    expect(cores.restarts).toBe(true);
    expect(cards.restarts).toBe(true);
  });

  it('update（只改副本数）：扩缩容不重建已运行的 Pod → restarts false / 0 秒', () => {
    const impact = summarizeImpact(managedExisting({ replicas: 1 }), managedExisting({ replicas: 4 }));

    expect(impact.action).toBe('update');
    expect(impact.restarts).toBe(false);
    expect(impact.downtimeEstimateSec).toBe(0);
    expect(impact.reasons.join('\n')).toContain('副本数');
  });

  it('delete：动作正确，并明确「不是重启」', () => {
    const impact = summarizeImpact(managedExisting(), null);

    expect(impact.action).toBe('delete');
    expect(impact.restarts).toBe(false);
    expect(impact.reasons.join('\n')).toContain('下线');
  });

  it('noop：完全一致 → 不重启、0 秒、无动作', () => {
    const impact = summarizeImpact(managedExisting(), managedExisting());

    expect(impact.action).toBe('noop');
    expect(impact.restarts).toBe(false);
    expect(impact.downtimeEstimateSec).toBe(0);
    expect(impact.reasons.length).toBeGreaterThan(0);
  });

  it('只有记账字段变化也算 noop（version 递增不代表要动集群）', () => {
    const impact = summarizeImpact(service({ version: 1 }), service({ version: 9 }));

    expect(impact.action).toBe('noop');
    expect(impact.restarts).toBe(false);
  });

  it('渲染后对象（Deployment 改镜像）也能正确判定 restarts', () => {
    const impact = summarizeImpact(
      [renderedDeployment({ image: 'vllm/vllm-openai:v0.6.3' })],
      [renderedDeployment({ image: 'vllm/vllm-openai:v0.7.0' })],
    );

    expect(impact.action).toBe('update');
    expect(impact.restarts).toBe(true);
  });

  it('渲染后对象改配额 → restarts true，且能从 limits 里读出 MiB', () => {
    expect(parseMemoryMiB('16Gi')).toBe(16384);
    expect(parseMemoryMiB('512Mi')).toBe(512);
    expect(parseMemoryMiB('nonsense')).toBeNull();

    const impact = summarizeImpact(
      [renderedDeployment({ memoryMiB: 4096 })],
      [renderedDeployment({ memoryMiB: 8192 })],
    );

    expect(impact.restarts).toBe(true);
    expect(impact.downtimeEstimateSec).toBeGreaterThanOrEqual(30);
  });
});

// ─── 10. 纵深防御：渲染后的对象同样受约束 ────────────────────────────────

describe('checkGuard：渲染后的 k8s 对象也要被同一套红线约束', () => {
  it('渲染对象显存超限（nvidia.com/gpumem 999999）→ MEMORY_LIMIT_EXCEEDED', () => {
    const result = checkGuard({ service: renderedWithVram({ memoryMiB: 999999 }), existing: null, env: INFRA_ON });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.MEMORY_LIMIT_EXCEEDED);
  });

  it('渲染对象加速卡超限（nvidia.com/gpu 16）→ ACCELERATOR_LIMIT_EXCEEDED', () => {
    const result = checkGuard({ service: renderedWithVram({ gpu: 16 }), existing: null, env: INFRA_ON });

    expect(codesOf(result)).toContain(VIOLATION_CODES.ACCELERATOR_LIMIT_EXCEEDED);
  });

  it('容器内存 memory 不算显存：124Gi 宿主机内存不应被当成超限', () => {
    const dep = renderedDeployment({ memoryMiB: 126976 }); // 124Gi 宿主内存，无 gpumem 键
    const result = checkGuard({ service: dep, existing: null, env: INFRA_ON });

    expect(codesOf(result)).not.toContain(VIOLATION_CODES.MEMORY_LIMIT_EXCEEDED);
    expect(result.allowed).toBe(true);
  });

  it('跨形态且读不到显存时不会误报 BIG_CHANGE（null 不等于「配额变了」）', () => {
    const result = checkGuard({
      service: service({ replicas: 1, resources: { accelerators: 1, memoryMiB: 8192, coresPercent: 50 } }),
      existing: renderedDeployment({ replicas: 1, memoryMiB: 126976 }), // 只有宿主内存，没有 gpumem
      env: INFRA_ON,
    });

    expect(codesOf(result)).not.toContain(VIOLATION_CODES.BIG_CHANGE);
    expect(result.allowed).toBe(true);
  });
});

// ─── 11. 接入契约：A5 最容易踩的三个坑 ───────────────────────────────────

describe('checkGuard：接入契约（A5 传参约定）', () => {
  it('existing 传数据库里的 ModelService 记录（无归属标签）→ NOT_MANAGED，并在文案里指路', () => {
    // 记录里没有 labels，护栏无法确认它是自己人 —— 故意拦下，提示改传集群现状
    const result = checkGuard({ service: service({ replicas: 2 }), existing: service(), env: INFRA_ON });

    const v = findByCode(result, VIOLATION_CODES.NOT_MANAGED);
    expect(result.allowed).toBe(false);
    expect(v).toBeTruthy();
    expect(v.message).toContain('集群');
  });

  it('删除一个根本不存在的对象 → INVALID_SERVICE（不能靠「删不存在的」赌运气）', () => {
    const result = checkGuard({ existing: null, op: 'delete', env: INFRA_ON });

    expect(result.allowed).toBe(false);
    expect(codesOf(result)).toContain(VIOLATION_CODES.INVALID_SERVICE);
  });

  it('完全无变化的更新 → allowed 且 diff 为空串（前端隐藏预览块、A5 直接跳过）', () => {
    const result = checkGuard({ service: managedExisting(), existing: managedExisting(), env: INFRA_ON });

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.diff).toBe('');
  });
});

// ─── 12. checkGuard 与 impact 的一致性 ───────────────────────────────────

describe('checkGuard：整体契约', () => {
  it('放行结果里同时带 diff 和 limits，前端一次调用就能渲染预览', () => {
    const result = checkGuard({
      service: service({ replicas: 2 }),
      existing: managedExisting({ replicas: 1 }),
      env: INFRA_ON,
    });

    expect(result.allowed).toBe(true);
    expect(typeof result.diff).toBe('string');
    expect(result.diff).not.toBe('');
    expect(result.limits).toEqual(DEFAULT_LIMITS);
  });

  it('跨形态（existing 是 Deployment、after 是 ModelService）diff 仍然可读且不含 k8s 噪音', () => {
    const result = checkGuard({
      service: service({ replicas: 2 }),
      existing: renderedDeployment({ replicas: 1 }),
      env: INFRA_ON,
    });

    expect(result.allowed).toBe(true);
    expect(result.diff).toContain('"replicas": 1');
    expect(result.diff).toContain('"replicas": 2');
    expect(result.diff).not.toContain('resourceVersion');
  });

  it('被拦下时同样返回 diff（用户要能看到自己提交了什么）', () => {
    const result = checkGuard({
      service: service({ namespace: 'prod' }),
      existing: null,
      env: INFRA_OFF,
    });

    expect(result.allowed).toBe(false);
    expect(result.diff).not.toBe('');
  });
});
