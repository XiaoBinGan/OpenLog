/**
 * server/infra/model.js + render.js 单测（A1）
 *
 * 覆盖四块：
 * 1. 校验：合法最小定义、全字段、各类反例（命名空间白名单、枚举、范围、端口、探针…），
 *    以及「错误信息要能指导操作」——每条断言都检查中文关键字与收到的值。
 * 2. 渲染：Deployment / Service 逐字段、HAMi 切片与整卡两种模式、nodeAffinity、routes。
 * 3. 确定性：同输入两次渲染 deepEqual + 序列化完全一致；inject 的渲染函数只被调用一次。
 * 4. 安全边界：夹带 ClusterRole / Namespace / CRD 的输入被丢弃或拒绝，
 *    渲染结果只能是同一命名空间内的 Deployment / Service。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  validateModelService,
  serviceKey,
  NAMESPACE_WHITELIST,
  ENGINE_TYPES,
  MODEL_SOURCES,
  DEFAULT_LIMITS,
} from '../infra/model.js';

import {
  renderModelService,
  renderDeployment,
  renderService,
  renderRoutes,
  renderNodeAffinity,
  buildSnapshot,
  snapshotToObjects,
  setResourceRenderer,
  resetResourceRenderer,
  setAcceleratorModule,
  resetAcceleratorModule,
  loadAcceleratorModule,
  defaultRenderResources,
  assertNamespacedObjects,
  deriveGatewayPort,
  normalizeResourcesFragment,
  MANAGED_BY_KEY,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  ALLOWED_KINDS,
  ACCELERATOR_MODEL_LABEL,
  HAMI_SCHEDULER_NAME,
  DEFAULT_GATEWAY_PORT_BASE,
} from '../infra/render.js';

// ---------------------------------------------------------------- 夹具

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 只在两边都是普通对象时递归合并；数组/原始值直接覆盖。 */
function deepMerge(base, patch) {
  if (!isPlain(patch) || !isPlain(base)) return patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = isPlain(patch[key]) && isPlain(base[key]) ? deepMerge(base[key], patch[key]) : patch[key];
  }
  return out;
}

/** 最小合法定义：其余字段全部靠默认值补全。 */
function minimal() {
  return {
    name: 'qwen3-8b',
    namespace: 'inference',
    model: { source: 'hostPath', path: '/models/Qwen3-8B' },
    engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.11.0' },
    resources: { accelerators: 1 },
    ports: [{ name: 'http', containerPort: 8000 }],
  };
}

/** 最小定义 + 局部覆盖（嵌套对象递归合并）。 */
function svc(patch = {}) {
  return deepMerge(minimal(), patch);
}

/** 全字段定义：HAMi 切片模式（memoryMiB > 0）。 */
function fullService() {
  return {
    id: 'svc-abc123',
    name: 'qwen3-8b',
    namespace: 'inference',
    model: {
      source: 'hostPath',
      path: '/models/Qwen3-8B',
      format: 'safetensors',
      quantization: 'fp16',
      contextLength: 32768,
    },
    engine: {
      type: 'vllm',
      image: 'vllm/vllm-openai:v0.11.0',
      args: ['--tensor-parallel-size', '2'],
      env: { HF_HUB_OFFLINE: '1', OPENLOG_LOG_LEVEL: 'info' },
    },
    resources: { accelerators: 2, memoryMiB: 16384, coresPercent: 50, vendor: 'nvidia' },
    replicas: 2,
    placement: { nodeSelector: { 'gpu-type': '4090', zone: 'a' }, acceleratorModel: 'NVIDIA GeForce RTX 4090' },
    ports: [
      { name: 'http', containerPort: 8000 },
      { name: 'metrics', containerPort: 9090 },
    ],
    health: { path: '/health', initialDelaySeconds: 30 },
    expose: { gatewayPort: 31080 },
    createdAt: '2026-01-02T03:04:05Z',
    updatedAt: '2026-01-02T04:05:06Z',
    version: 3,
  };
}

/**
 * 假的加速卡渲染函数（替代 A3 的实现）。
 * 语义与 HAMi 一致：memoryMiB > 0 才有显存/算力配额；0 表示只申请整卡。
 */
function fakeAcceleratorResources(model) {
  const { accelerators, memoryMiB, coresPercent } = model.resources;
  const limits = { 'nvidia.com/gpu': String(accelerators) };
  if (memoryMiB > 0) {
    limits['nvidia.com/gpumem'] = String(memoryMiB);
    limits['nvidia.com/gpucores'] = String(coresPercent);
  }
  return { limits, requests: { ...limits } };
}

/** 收集 errors 里的字段名，方便断言「哪些字段被点了名」。 */
function fieldsOf(errors) {
  return errors.map((error) => error.field);
}

afterEach(() => {
  resetResourceRenderer();
  resetAcceleratorModule();
});

// ---------------------------------------------------------------- 1. 校验

describe('validateModelService：合法输入', () => {
  it('最小定义通过校验，并补全所有默认值', () => {
    const result = validateModelService(minimal());

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({
      id: '',
      name: 'qwen3-8b',
      namespace: 'inference',
      model: { source: 'hostPath', path: '/models/Qwen3-8B' },
      engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.11.0', args: [], env: {} },
      resources: { accelerators: 1, memoryMiB: 0, coresPercent: 0 },
      replicas: 1,
      placement: { nodeSelector: {} },
      ports: [{ name: 'http', containerPort: 8000 }],
      health: { path: '/health', initialDelaySeconds: 5 },
      expose: null,
      createdAt: '',
      updatedAt: '',
      version: 0,
    });
  });

  it('infra-test 命名空间同样合法（白名单两个都在）', () => {
    expect(NAMESPACE_WHITELIST).toEqual(['inference', 'infra-test']);
    const result = validateModelService(svc({ namespace: 'infra-test' }));
    expect(result.ok).toBe(true);
    expect(result.value.namespace).toBe('infra-test');
  });

  it('全字段定义原样保留（含可选扩展 resources.vendor / engine.env）', () => {
    const result = validateModelService(fullService());

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value).toMatchObject({
      id: 'svc-abc123',
      name: 'qwen3-8b',
      namespace: 'inference',
      model: {
        source: 'hostPath',
        path: '/models/Qwen3-8B',
        format: 'safetensors',
        quantization: 'fp16',
        contextLength: 32768,
      },
      engine: {
        type: 'vllm',
        image: 'vllm/vllm-openai:v0.11.0',
        args: ['--tensor-parallel-size', '2'],
        env: { HF_HUB_OFFLINE: '1', OPENLOG_LOG_LEVEL: 'info' },
      },
      resources: { accelerators: 2, memoryMiB: 16384, coresPercent: 50, vendor: 'nvidia' },
      replicas: 2,
      placement: { nodeSelector: { 'gpu-type': '4090', zone: 'a' }, acceleratorModel: 'NVIDIA GeForce RTX 4090' },
      ports: [
        { name: 'http', containerPort: 8000 },
        { name: 'metrics', containerPort: 9090 },
      ],
      health: { path: '/health', initialDelaySeconds: 30 },
      expose: { gatewayPort: 31080 },
      createdAt: '2026-01-02T03:04:05Z',
      updatedAt: '2026-01-02T04:05:06Z',
      version: 3,
    });
  });

  it('枚举常量与契约一致（引擎类型 / 模型来源）', () => {
    expect(ENGINE_TYPES).toEqual(['vllm', 'sglang', 'llama.cpp', 'strata', 'tgi']);
    expect(MODEL_SOURCES).toEqual(['hostPath', 'pvc', 'huggingface', 'modelscope', 's3']);
  });

  it('规范化是幂等的：validate(value) 再次通过且结果一致', () => {
    const once = validateModelService(fullService()).value;
    const twice = validateModelService(once);
    expect(twice.ok).toBe(true);
    expect(twice.value).toEqual(once);
  });

  it('限额可配置：默认拒 128 GiB，放大到 256 GiB 后放行', () => {
    const big = svc({ resources: { memoryMiB: 131072 } });
    expect(DEFAULT_LIMITS.maxMemoryMiB).toBe(65536);
    expect(validateModelService(big).ok).toBe(false);
    expect(validateModelService(big, { maxMemoryMiB: 262144 }).ok).toBe(true);
  });

  it('未知字段被白名单丢弃（value 里不会出现 kind / objects / rules）', () => {
    const dirty = svc({ kind: 'ClusterRole', objects: [{ kind: 'Namespace' }], rules: [{ verbs: ['*'] }] });
    const result = validateModelService(dirty);
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBeUndefined();
    expect(result.value.objects).toBeUndefined();
    expect(result.value.rules).toBeUndefined();
    expect(Object.keys(result.value).sort()).toEqual([
      'createdAt', 'engine', 'expose', 'health', 'id', 'model', 'name', 'namespace',
      'placement', 'ports', 'replicas', 'resources', 'updatedAt', 'version',
    ]);
  });
});

describe('validateModelService：反例（namespace / name）', () => {
  it('namespace kube-system 被拒，错误信息说明白名单与收到的值', () => {
    const result = validateModelService(svc({ namespace: 'kube-system' }));
    expect(result.ok).toBe(false);
    const [error] = result.errors;
    expect(error.field).toBe('namespace');
    expect(error.message).toContain('只允许 inference / infra-test');
    expect(error.message).toContain('kube-system');
  });

  it('namespace default 被拒', () => {
    const result = validateModelService(svc({ namespace: 'default' }));
    expect(result.ok).toBe(false);
    expect(fieldsOf(result.errors)).toEqual(['namespace']);
  });

  it('namespace 缺失被拒', () => {
    const input = minimal();
    delete input.namespace;
    const result = validateModelService(input);
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('namespace');
    expect(result.errors[0].message).toContain('必填');
  });

  it('name 含大写与下划线被拒（DNS-1123 label）', () => {
    const result = validateModelService(svc({ name: 'Qwen_8B' }));
    expect(result.ok).toBe(false);
    const error = result.errors.find((item) => item.field === 'name');
    expect(error.message).toContain('小写字母、数字和中划线');
    expect(error.message).toContain('Qwen_8B');
  });

  it('name 超过 63 字符被拒', () => {
    const result = validateModelService(svc({ name: 'a'.repeat(64) }));
    expect(result.ok).toBe(false);
    expect(result.errors.find((item) => item.field === 'name').message).toContain('最长 63 个字符');
  });

  it('输入不是对象时 ok=false、value=null，并说清缺什么', () => {
    for (const bad of [null, 'qwen3-8b', 42, []]) {
      const result = validateModelService(bad);
      expect(result.ok).toBe(false);
      expect(result.value).toBeNull();
      expect(result.errors[0].message).toContain('定义必须是一个对象');
    }
  });
});

describe('validateModelService：反例（model / engine）', () => {
  it('model.source 不在枚举内', () => {
    const result = validateModelService(svc({ model: { source: 'local' } }));
    expect(result.ok).toBe(false);
    const error = result.errors.find((item) => item.field === 'model.source');
    expect(error.message).toContain('只允许 hostPath / pvc / huggingface / modelscope / s3');
    expect(error.message).toContain('local');
  });

  it('model.path 为空串被拒', () => {
    const result = validateModelService(svc({ model: { path: '   ' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.find((item) => item.field === 'model.path').message).toContain('必填');
  });

  it('hostPath 来源必须是绝对路径', () => {
    const result = validateModelService(svc({ model: { path: 'models/Qwen3-8B' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.find((item) => item.field === 'model.path').message).toContain('必须是绝对路径');
  });

  it('model.path 含 ".." 被拒（防越出挂载目录）', () => {
    const result = validateModelService(svc({ model: { path: '/models/../../etc' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.find((item) => item.field === 'model.path').message).toContain('不允许包含 ".."');
  });

  it('huggingface 来源允许仓库 id（不要求以 / 开头）', () => {
    const result = validateModelService(svc({ model: { source: 'huggingface', path: 'Qwen/Qwen3-8B' } }));
    expect(result.ok).toBe(true);
    expect(result.value.model.path).toBe('Qwen/Qwen3-8B');
  });

  it('model.format 不在枚举内', () => {
    const result = validateModelService(svc({ model: { format: 'onnx' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.find((item) => item.field === 'model.format').message).toContain('safetensors / gguf / pytorch');
  });

  it('engine.type 不在枚举内', () => {
    const result = validateModelService(svc({ engine: { type: 'ollama' } }));
    expect(result.ok).toBe(false);
    const error = result.errors.find((item) => item.field === 'engine.type');
    expect(error.message).toContain('vllm / sglang / llama.cpp / strata / tgi');
    expect(error.message).toContain('ollama');
  });

  it('engine.image 为空被拒', () => {
    const result = validateModelService(svc({ engine: { image: '  ' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.find((item) => item.field === 'engine.image').message).toContain('必填');
  });

  it('engine.args 必须是字符串数组', () => {
    const result = validateModelService(svc({ engine: { args: ['--ok', 42] } }));
    expect(result.ok).toBe(false);
    expect(fieldsOf(result.errors)).toEqual(['engine.args[1]']);
  });

  it('engine.env 的值必须是字符串', () => {
    const result = validateModelService(svc({ engine: { env: { MAX_MODEL_LEN: 32768 } } }));
    expect(result.ok).toBe(false);
    const error = result.errors.find((item) => item.field === 'engine.env.MAX_MODEL_LEN');
    expect(error.message).toContain('必须是字符串');
  });
});

describe('validateModelService：反例（resources / replicas / ports / health / expose）', () => {
  it('accelerators 小于 1 或大于单服务上限 8 都被拒', () => {
    const zero = validateModelService(svc({ resources: { accelerators: 0 } }));
    expect(zero.ok).toBe(false);
    expect(zero.errors[0].field).toBe('resources.accelerators');
    expect(zero.errors[0].message).toContain('必须在 1..8 之间');

    const tooMany = validateModelService(svc({ resources: { accelerators: 9 } }));
    expect(tooMany.ok).toBe(false);
    expect(tooMany.errors[0].message).toContain('9');
  });

  it('accelerators 非整数被拒', () => {
    const result = validateModelService(svc({ resources: { accelerators: 1.5 } }));
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('整数');
  });

  it('memoryMiB 超过单卡上限（默认 65536）被拒', () => {
    const result = validateModelService(svc({ resources: { memoryMiB: 100000 } }));
    expect(result.ok).toBe(false);
    const error = result.errors.find((item) => item.field === 'resources.memoryMiB');
    expect(error.message).toContain('0..65536');
    expect(error.message).toContain('100000');
  });

  it('coresPercent 超过 100 被拒', () => {
    const result = validateModelService(svc({ resources: { coresPercent: 120 } }));
    expect(result.ok).toBe(false);
    expect(result.errors.find((item) => item.field === 'resources.coresPercent').message).toContain('0..100');
  });

  it('replicas 越界（0 与 12）被拒，并提示拆服务', () => {
    const zero = validateModelService(svc({ replicas: 0 }));
    expect(zero.ok).toBe(false);
    expect(zero.errors[0].field).toBe('replicas');

    const tooMany = validateModelService(svc({ replicas: 12 }));
    expect(tooMany.ok).toBe(false);
    expect(tooMany.errors[0].message).toContain('请拆成多个服务');
  });

  it('ports 为空数组被拒', () => {
    const result = validateModelService(svc({ ports: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('ports');
    expect(result.errors[0].message).toContain('至少需要 1 个端口');
  });

  it('containerPort 越界（70000）被拒', () => {
    const result = validateModelService(svc({ ports: [{ name: 'http', containerPort: 70000 }] }));
    expect(result.ok).toBe(false);
    const error = result.errors.find((item) => item.field === 'ports[0].containerPort');
    expect(error.message).toContain('1..65535');
    expect(error.message).toContain('70000');
  });

  it('端口号重复被拒', () => {
    const result = validateModelService(svc({
      ports: [{ name: 'http', containerPort: 8000 }, { name: 'grpc', containerPort: 8000 }],
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.message.includes('端口重复'))).toBe(true);
  });

  it('端口名重复、端口名非法都被拒', () => {
    const duplicated = validateModelService(svc({
      ports: [{ name: 'http', containerPort: 8000 }, { name: 'http', containerPort: 8001 }],
    }));
    expect(duplicated.ok).toBe(false);
    expect(duplicated.errors.some((item) => item.message.includes('端口名重复'))).toBe(true);

    const illegal = validateModelService(svc({
      ports: [{ name: 'HTTP_Port', containerPort: 8000 }],
    }));
    expect(illegal.ok).toBe(false);
    expect(illegal.errors[0].field).toBe('ports[0].name');
  });

  it('health.path 不以 / 开头被拒', () => {
    const result = validateModelService(svc({ health: { path: 'healthz' } }));
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('health.path');
    expect(result.errors[0].message).toContain('必须以 / 开头');
  });

  it('health.initialDelaySeconds 为负数被拒', () => {
    const result = validateModelService(svc({ health: { initialDelaySeconds: -1 } }));
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('health.initialDelaySeconds');
  });

  it('expose.gatewayPort 为 0 被拒', () => {
    const result = validateModelService(svc({ expose: { gatewayPort: 0 } }));
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('expose.gatewayPort');
    expect(result.errors[0].message).toContain('1..65535');
  });

  it('placement.nodeSelector 的值必须是字符串', () => {
    const result = validateModelService(svc({ placement: { nodeSelector: { gpu: 4090 } } }));
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('placement.nodeSelector.gpu');
  });

  it('一次返回全部错误（不是遇到第一个就返回）', () => {
    const result = validateModelService(svc({
      namespace: 'kube-system',
      name: 'Bad_Name',
      resources: { accelerators: 99 },
      replicas: 0,
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(fieldsOf(result.errors)).toEqual(
      expect.arrayContaining(['namespace', 'name', 'resources.accelerators', 'replicas']),
    );
  });

  it('拒绝注入 ClusterRole 的 namespace（kube-system）——白名单是代码级护栏', () => {
    const malicious = svc({
      namespace: 'kube-system',
      kind: 'ClusterRole',
      rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }],
    });
    const result = validateModelService(malicious);
    expect(result.ok).toBe(false);
    expect(result.value.namespace).toBe('kube-system'); // 仅用于回显，不能拿去渲染
    expect(() => renderModelService(malicious, { renderResources: fakeAcceleratorResources })).toThrow(/namespace/);
  });
});

// ---------------------------------------------------------------- 2. 渲染

describe('renderModelService：Deployment 逐字段', () => {
  it('Deployment 的元数据 / 副本 / 选择器 / 策略 / 容器 / 探针都与意图一致', () => {
    const { objects } = renderModelService(fullService(), { renderResources: fakeAcceleratorResources });
    const deployment = objects[0];

    expect(deployment.apiVersion).toBe('apps/v1');
    expect(deployment.kind).toBe('Deployment');
    expect(deployment.metadata.name).toBe('qwen3-8b');
    expect(deployment.metadata.namespace).toBe('inference');
    expect(deployment.metadata.labels.app).toBe('qwen3-8b');
    expect(deployment.metadata.annotations['openlog.io/service-key']).toBe('inference/qwen3-8b');

    expect(deployment.spec.replicas).toBe(2);
    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
    expect(deployment.spec.selector).toEqual({ matchLabels: { app: 'qwen3-8b' } });
    expect(deployment.spec.template.metadata.labels).toEqual({ app: 'qwen3-8b' });

    const podSpec = deployment.spec.template.spec;
    expect(podSpec.restartPolicy).toBe('Always');
    expect(podSpec.nodeSelector).toEqual({ 'gpu-type': '4090', zone: 'a' });

    expect(podSpec.containers).toHaveLength(1);
    const container = podSpec.containers[0];
    expect(container.name).toBe('qwen3-8b');
    expect(container.image).toBe('vllm/vllm-openai:v0.11.0');
    expect(container.imagePullPolicy).toBe('IfNotPresent');
    expect(container.args).toEqual(['--tensor-parallel-size', '2']);
    expect(container.ports).toEqual([
      { name: 'http', containerPort: 8000, protocol: 'TCP' },
      { name: 'metrics', containerPort: 9090, protocol: 'TCP' },
    ]);
    expect(container.readinessProbe).toEqual({
      httpGet: { path: '/health', port: 'http' },
      initialDelaySeconds: 30,
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 3,
    });
    expect(container.livenessProbe.httpGet).toEqual({ path: '/health', port: 'http' });
    expect(container.livenessProbe.initialDelaySeconds).toBe(60);
  });

  it('env 由意图推导且按变量名排序（确定性）', () => {
    const { objects } = renderModelService(fullService(), { renderResources: fakeAcceleratorResources });
    const env = objects[0].spec.template.spec.containers[0].env;

    expect(env.map((item) => item.name)).toEqual([
      'ENGINE_TYPE',
      'HF_HUB_OFFLINE',
      'MODEL_CONTEXT_LENGTH',
      'MODEL_FORMAT',
      'MODEL_PATH',
      'MODEL_QUANTIZATION',
      'MODEL_SOURCE',
      'OPENLOG_LOG_LEVEL',
      'OPENLOG_RENDERER',
      'OPENLOG_SERVICE_KEY',
    ]);
    expect(env.find((item) => item.name === 'MODEL_PATH').value).toBe('/models/Qwen3-8B');
    expect(env.find((item) => item.name === 'MODEL_CONTEXT_LENGTH').value).toBe('32768');
    // 用户提供的 env 覆盖同名推导值
    expect(env.find((item) => item.name === 'OPENLOG_LOG_LEVEL').value).toBe('info');
  });

  it('HAMi 切片模式：memoryMiB>0 时挂 hami-scheduler，资源带显存/算力配额', () => {
    const { objects } = renderModelService(fullService(), { renderResources: fakeAcceleratorResources });
    const podSpec = objects[0].spec.template.spec;

    expect(podSpec.schedulerName).toBe(HAMI_SCHEDULER_NAME);
    expect(HAMI_SCHEDULER_NAME).toBe('hami-scheduler');
    expect(podSpec.containers[0].resources).toEqual({
      limits: { 'nvidia.com/gpu': '2', 'nvidia.com/gpumem': '16384', 'nvidia.com/gpucores': '50' },
      requests: { 'nvidia.com/gpu': '2', 'nvidia.com/gpumem': '16384', 'nvidia.com/gpucores': '50' },
    });
  });

  it('整卡模式：memoryMiB=0 时不挂 hami-scheduler，只申请整卡', () => {
    const { objects } = renderModelService(
      svc({ resources: { accelerators: 1, memoryMiB: 0, coresPercent: 0 } }),
      { renderResources: fakeAcceleratorResources },
    );
    const podSpec = objects[0].spec.template.spec;

    expect(podSpec.schedulerName).toBeUndefined();
    expect(podSpec.containers[0].resources).toEqual({
      limits: { 'nvidia.com/gpu': '1' },
      requests: { 'nvidia.com/gpu': '1' },
    });
  });

  it('加速卡渲染函数由外部注入，收到的是规范化后的 svc', () => {
    const renderer = vi.fn(() => ({ limits: { 'example.com/gpu': '1' }, requests: {} }));
    const { objects } = renderModelService(minimal(), { renderResources: renderer });

    expect(renderer).toHaveBeenCalledTimes(1);
    const received = renderer.mock.calls[0][0];
    expect(received.name).toBe('qwen3-8b');
    expect(received.resources).toEqual({ accelerators: 1, memoryMiB: 0, coresPercent: 0 });
    expect(objects[0].spec.template.spec.containers[0].resources).toEqual({
      limits: { 'example.com/gpu': '1' },
      requests: {},
    });
  });

  it('setResourceRenderer 可全局注入，reset 后恢复默认实现', () => {
    setResourceRenderer(() => ({ limits: { 'example.com/vgpu': '1' } }));
    expect(renderModelService(minimal()).objects[0].spec.template.spec.containers[0].resources).toEqual({
      limits: { 'example.com/vgpu': '1' },
      requests: { 'example.com/vgpu': '1' },
    });
    resetResourceRenderer();
    expect(() => setResourceRenderer('nope')).toThrow(/需要函数或 null/);
  });
});

describe('renderModelService：nodeAffinity / Service / routes', () => {
  it('acceleratorModel 渲染成 nodeAffinity（openlog.io/accelerator-model In [...]）', () => {
    const { objects } = renderModelService(fullService(), { renderResources: fakeAcceleratorResources });
    const affinity = objects[0].spec.template.spec.affinity;

    expect(ACCELERATOR_MODEL_LABEL).toBe('openlog.io/accelerator-model');
    expect(affinity).toEqual({
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                { key: 'openlog.io/accelerator-model', operator: 'In', values: ['NVIDIA GeForce RTX 4090'] },
              ],
            },
          ],
        },
      },
    });
  });

  it('没指定 acceleratorModel 时不生成 affinity 键', () => {
    expect(renderNodeAffinity({ placement: {} })).toBeNull();
    const { objects } = renderModelService(minimal(), { renderResources: fakeAcceleratorResources });
    expect('affinity' in objects[0].spec.template.spec).toBe(false);
  });

  it('渲染产物带 A2 护栏认可的归属标签（managedBy=openlog-infra）', async () => {
    const { objects } = renderModelService(fullService(), { renderResources: fakeAcceleratorResources });
    const [deployment, service] = objects;

    expect(MANAGED_BY_KEY).toBe('managedBy');
    expect(MANAGED_BY_LABEL).toBe('app.kubernetes.io/managed-by');
    expect(MANAGED_BY_VALUE).toBe('openlog-infra');
    for (const object of [deployment, service]) {
      expect(object.metadata.labels.managedBy).toBe('openlog-infra');
      expect(object.metadata.labels['app.kubernetes.io/managed-by']).toBe('openlog-infra');
    }

    // 跨模块断言：A2 的护栏必须认得自己人，否则会拒绝修改自己创建的对象。
    const guard = await import('../infra/guard.js').catch(() => null);
    if (guard && typeof guard.isManaged === 'function') {
      expect(guard.MANAGED_BY_KEY).toBe(MANAGED_BY_KEY);
      expect(guard.MANAGED_BY_VALUE).toBe(MANAGED_BY_VALUE);
      expect(guard.isManaged(deployment)).toBe(true);
      expect(guard.isManaged(service)).toBe(true);
    }
  });

  it('Service 是 ClusterIP，端口按名字映射，选择器与 Deployment 一致', () => {
    const { objects } = renderModelService(fullService(), { renderResources: fakeAcceleratorResources });
    const service = objects[1];

    expect(service.apiVersion).toBe('v1');
    expect(service.kind).toBe('Service');
    expect(service.metadata.name).toBe('qwen3-8b');
    expect(service.metadata.namespace).toBe('inference');
    expect(service.metadata.labels.app).toBe('qwen3-8b');
    expect(service.spec).toEqual({
      type: 'ClusterIP',
      selector: { app: 'qwen3-8b' },
      ports: [
        { name: 'http', port: 8000, targetPort: 'http', protocol: 'TCP' },
        { name: 'metrics', port: 9090, targetPort: 'metrics', protocol: 'TCP' },
      ],
    });
  });

  it('expose 存在时生成 routes（显式 gatewayPort）', () => {
    const { routes } = renderModelService(fullService(), { renderResources: fakeAcceleratorResources });
    expect(routes).toEqual([
      { port: 31080, upstream: 'qwen3-8b.inference.svc.cluster.local:8000' },
    ]);
  });

  it('expose 为 null 时不生成 routes', () => {
    const { routes } = renderModelService(minimal(), { renderResources: fakeAcceleratorResources });
    expect(routes).toEqual([]);
    expect(renderRoutes({ expose: null, ports: [{ name: 'http', containerPort: 8000 }] })).toEqual([]);
  });

  it('未指定 gatewayPort 时按服务名稳定推导（30000..30999）', () => {
    const { routes } = renderModelService(
      svc({ expose: {} }),
      { renderResources: fakeAcceleratorResources },
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].port).toBeGreaterThanOrEqual(DEFAULT_GATEWAY_PORT_BASE);
    expect(routes[0].port).toBeLessThan(DEFAULT_GATEWAY_PORT_BASE + 1000);
    expect(routes[0].port).toBe(deriveGatewayPort('qwen3-8b'));
    expect(deriveGatewayPort('qwen3-8b')).toBe(deriveGatewayPort('qwen3-8b'));
  });

  it('gatewayIP 写进 Service 注解，供网关/运维核对', () => {
    const { objects } = renderModelService(minimal(), {
      gatewayIP: '10.0.0.243',
      renderResources: fakeAcceleratorResources,
    });
    expect(objects[1].metadata.annotations['openlog.io/gateway-ip']).toBe('10.0.0.243');
  });
});

// ---------------------------------------------------------------- 3. 确定性

describe('renderModelService：确定性', () => {
  it('同一输入两次渲染完全一致（deepEqual + 序列化逐字节一致）', () => {
    const input = fullService();
    const first = renderModelService(input, { renderResources: fakeAcceleratorResources });
    const second = renderModelService(input, { renderResources: fakeAcceleratorResources });

    expect(first).toEqual(second);
    expect(JSON.stringify(first.objects)).toBe(JSON.stringify(second.objects));
    expect(JSON.stringify(first.routes)).toBe(JSON.stringify(second.routes));
  });

  it('对象数组顺序固定：Deployment → Service', () => {
    const { objects } = renderModelService(minimal(), { renderResources: fakeAcceleratorResources });
    expect(objects.map((object) => object.kind)).toEqual(['Deployment', 'Service']);
  });

  it('不修改入参：深冻结后仍能渲染，且入参内容不变', () => {
    const input = fullService();
    const snapshot = JSON.parse(JSON.stringify(input));

    const deepFreeze = (value) => {
      if (!isPlain(value) && !Array.isArray(value)) return value;
      Object.values(value).forEach(deepFreeze);
      return Object.freeze(value);
    };
    deepFreeze(input);

    expect(() => renderModelService(input, { renderResources: fakeAcceleratorResources })).not.toThrow();
    expect(input).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------- 4. 安全边界

describe('渲染的安全边界：不生成集群级对象', () => {
  it('夹带 kind=ClusterRole / objects / rules 的输入被忽略，只出 Deployment + Service', () => {
    const malicious = svc({
      kind: 'ClusterRole',
      apiVersion: 'rbac.authorization.k8s.io/v1',
      rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }],
      objects: [{ kind: 'Namespace', metadata: { name: 'pwn' } }],
      metadata: { name: 'pwn', namespace: 'kube-system' },
    });

    const { objects } = renderModelService(malicious, { renderResources: fakeAcceleratorResources });

    expect(objects.map((object) => object.kind)).toEqual(['Deployment', 'Service']);
    expect(objects.every((object) => ALLOWED_KINDS.includes(object.kind))).toBe(true);
    expect(objects.every((object) => object.metadata.namespace === 'inference')).toBe(true);
    expect(JSON.stringify(objects)).not.toContain('ClusterRole');
    expect(JSON.stringify(objects)).not.toContain('apiGroups');
  });

  it('assertNamespacedObjects 拒绝集群级对象与跨命名空间对象', () => {
    expect(ALLOWED_KINDS).toEqual(['Deployment', 'Service']);
    const deployment = renderDeployment(validateModelService(minimal()).value, {
      resources: fakeAcceleratorResources(validateModelService(minimal()).value),
    });

    expect(() => assertNamespacedObjects([{ kind: 'ClusterRole', metadata: { name: 'x' } }], 'inference'))
      .toThrow(/只允许生成命名空间内的 Deployment \/ Service/);
    expect(() => assertNamespacedObjects([{ ...deployment, metadata: { ...deployment.metadata, namespace: 'infra-test' } }], 'inference'))
      .toThrow(/跨命名空间/);
    expect(() => assertNamespacedObjects([deployment], 'inference')).not.toThrow();
  });

  it('A3 适配器层的扁平 map 会被归一成 { limits, requests }（扩展资源 requests=limits）', () => {
    expect(normalizeResourcesFragment({ 'nvidia.com/gpu': '1' })).toEqual({
      limits: { 'nvidia.com/gpu': '1' },
      requests: { 'nvidia.com/gpu': '1' },
    });
    expect(normalizeResourcesFragment({ limits: { a: '1' }, requests: { b: '2' } })).toEqual({
      limits: { a: '1' },
      requests: { b: '2' },
    });
    expect(normalizeResourcesFragment({ limits: { a: '1' } }).requests).toEqual({ a: '1' });

    const { objects } = renderModelService(minimal(), { renderResources: () => ({ 'example.com/gpu': '1' }) });
    expect(objects[0].spec.template.spec.containers[0].resources).toEqual({
      limits: { 'example.com/gpu': '1' },
      requests: { 'example.com/gpu': '1' },
    });
  });

  it('渲染函数返回非对象时报错（不允许把奇怪的东西塞进容器 resources）', () => {
    expect(() => renderModelService(minimal(), { renderResources: () => null })).toThrow(/必须返回 k8s resources 片段对象/);
    expect(() => renderModelService(minimal(), { renderResources: () => 'nvidia.com/gpu=1' })).toThrow(/必须返回/);
  });
});

// ---------------------------------------------------------------- 5. 快照与标识

describe('serviceKey / buildSnapshot', () => {
  it('serviceKey 是 namespace/name，缺字段时给出可操作错误', () => {
    expect(serviceKey(minimal())).toBe('inference/qwen3-8b');
    expect(serviceKey(validateModelService(fullService()).value)).toBe('inference/qwen3-8b');
    expect(() => serviceKey({ name: 'qwen3-8b' })).toThrow(/需要 namespace 与 name/);
  });

  it('buildSnapshot 稳定排序、深拷贝、可再次 apply', () => {
    const { objects } = renderModelService(fullService(), { renderResources: fakeAcceleratorResources });
    const first = buildSnapshot(objects);
    const second = buildSnapshot(objects);

    expect(first).toEqual(second);
    expect(first.version).toBe(1);
    expect(first.kind).toBe('InfraSnapshot');
    expect(first.createdAt).toBeNull();
    expect(first.count).toBe(2);
    expect(first.entries.map((entry) => entry.kind)).toEqual(['Deployment', 'Service']);
    expect(first.entries[0]).toMatchObject({
      apiVersion: 'apps/v1',
      namespace: 'inference',
      name: 'qwen3-8b',
      key: 'inference/qwen3-8b',
    });

    // 深拷贝：改快照不影响原对象
    first.entries[0].manifest.metadata.name = 'tampered';
    expect(objects[0].metadata.name).toBe('qwen3-8b');
    expect(snapshotToObjects(second).map((object) => object.metadata.name)).toEqual(['qwen3-8b', 'qwen3-8b']);
    expect(snapshotToObjects(second)[0].kind).toBe('Deployment');
  });

  it('buildSnapshot 接受空输入（回滚到「什么都没有」= 删除资源）', () => {
    expect(buildSnapshot([])).toEqual({
      version: 1,
      kind: 'InfraSnapshot',
      createdAt: null,
      count: 0,
      entries: [],
    });
    expect(buildSnapshot(null).entries).toEqual([]);
    expect(snapshotToObjects(buildSnapshot([]))).toEqual([]);
  });
});

// ---------------------------------------------------------------- 6. 加速卡模块接入

describe('加速卡渲染的默认实现（A3 接入点）', () => {
  it('loadAcceleratorModule 在模块缺失时给出可操作错误', () => {
    let error;
    try {
      loadAcceleratorModule('./accelerator/does-not-exist.js');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('INFRA_ACCELERATOR_UNAVAILABLE');
    expect(error.message).toContain('accelerator');
    expect(error.message).toContain('renderResources');
  });

  it('defaultRenderResources 委派给 A3 的 renderAcceleratorResources', () => {
    const calls = [];
    setAcceleratorModule({
      renderAcceleratorResources: (input) => {
        calls.push(input);
        return { limits: { 'nvidia.com/gpu': String(input.accelerators) }, requests: {} };
      },
    });
    const value = validateModelService(fullService()).value;

    expect(defaultRenderResources(value)).toEqual({ limits: { 'nvidia.com/gpu': '2' }, requests: {} });
    expect(calls).toHaveLength(1);
    // 混合形状：配额摊在顶层（契约形状），同时保留 svc 全量（适配器层按 svc 实现也能用）
    expect(calls[0]).toMatchObject({ vendor: 'nvidia', accelerators: 2, memoryMiB: 16384, coresPercent: 50 });
    expect(calls[0].name).toBe('qwen3-8b');
    expect(calls[0].resources).toEqual({ accelerators: 2, memoryMiB: 16384, coresPercent: 50, vendor: 'nvidia' });
  });

  it('defaultRenderResources 兼容 getAdapter(vendor).renderResources 形状', () => {
    const seen = [];
    setAcceleratorModule({
      getAdapter: (vendor) => ({
        renderResources: (input) => {
          seen.push({ vendor, input });
          return { limits: { 'amd.com/gpu': '1' }, requests: {} };
        },
      }),
    });
    const value = validateModelService(svc({ resources: { vendor: 'amd', accelerators: 1 } })).value;

    expect(defaultRenderResources(value)).toEqual({ limits: { 'amd.com/gpu': '1' }, requests: {} });
    expect(seen[0].vendor).toBe('amd');
  });

  it('加速卡模块缺入口时报错，指出缺哪个函数', () => {
    setAcceleratorModule({});
    const value = validateModelService(minimal()).value;
    expect(() => defaultRenderResources(value)).toThrow(/renderAcceleratorResources/);
  });

  it('不注入时的默认实现：A3 未就绪给可操作错误，已就绪则返回 resources 片段', () => {
    const value = validateModelService(minimal()).value;
    let resources;
    try {
      resources = defaultRenderResources(value);
    } catch (error) {
      expect(error.code).toBe('INFRA_ACCELERATOR_UNAVAILABLE');
      expect(error.message).toContain('A3');
      return;
    }
    expect(resources).toBeTypeOf('object');
    expect(resources.limits).toBeTypeOf('object');
  });
});
