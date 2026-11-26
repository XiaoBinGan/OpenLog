/**
 * AI Infra 能力层 A1-①：模型服务定义（用户的「意图」）的校验与规范化
 *
 * 职责边界（与 /tmp/infra-contract.md 一致）：
 * - 本文件**只处理意图**，不产生任何 k8s 对象（渲染在 render.js）；
 * - **纯函数**：不联网、不读盘、不读环境变量、不抛异常（错误一律收集进 errors 数组）；
 * - 输出**确定性**：同一份输入必得同一份 `value`（键顺序、数组顺序都稳定）；
 * - **白名单式重建**：`value` 是从已知字段里重新拼出来的新对象，
 *   输入里多出来的任何字段（`kind`、`apiVersion`、`objects`、`rules`、`metadata`…）
 *   一律丢弃——这是防「往定义里塞一个 ClusterRole 让它跟着 apply 上去」的关键一环。
 *
 * 三条护栏（代码级，不接受参数覆盖）：
 * 1. 命名空间只允许 `inference` / `infra-test`；
 * 2. 每副本加速卡 1..8、显存 0..65536 MiB、算力 0..100%、副本 1..8；
 * 3. 只允许单命名空间内的命名对象（集群级对象由运维手工管理）。
 *
 * 错误信息一律中文且可操作：说清「字段 / 允许什么 / 收到什么 / 怎么改」。
 */

/** 允许部署的命名空间白名单。集群级命名空间（kube-system / default / kube-public）一律拒绝。 */
export const NAMESPACE_WHITELIST = Object.freeze(['inference', 'infra-test']);

/** 推理引擎类型枚举（与各引擎的镜像/参数约定对应）。 */
export const ENGINE_TYPES = Object.freeze(['vllm', 'sglang', 'llama.cpp', 'strata', 'tgi']);

/** 模型来源枚举：hostPath / pvc 是本机存储，其余是远端仓库或对象存储。 */
export const MODEL_SOURCES = Object.freeze(['hostPath', 'pvc', 'huggingface', 'modelscope', 's3']);

/** 权重格式枚举（可选字段 model.format）。 */
export const MODEL_FORMATS = Object.freeze(['safetensors', 'gguf', 'pytorch']);

/** 加速卡厂商枚举（可选字段 resources.vendor，交给 A3 的加速卡抽象层选择渲染器）。 */
export const ACCELERATOR_VENDORS = Object.freeze(['nvidia', 'amd', 'ascend', 'generic']);

/** 未指定时使用的加速卡厂商（A3 默认实现即 nvidia / HAMi）。 */
export const DEFAULT_ACCELERATOR_VENDOR = 'nvidia';

/** 未提供 health.path 时的默认探针路径。 */
export const DEFAULT_HEALTH_PATH = '/health';

/** 未提供 health.initialDelaySeconds 时的默认首检延迟（大模型加载慢，5s 起步）。 */
export const DEFAULT_HEALTH_INITIAL_DELAY_SECONDS = 5;

/**
 * 默认限额。`memoryMiB` 上限即「单卡容量」的保守默认值（65536 MiB = 64 GiB），
 * 真实机器容量由 A4 的容量预检负责，这里只挡住明显荒谬的输入。
 * 全部可通过 `validateModelService(input, options)` 覆盖（例如按机型放大 memoryMiB）。
 */
export const DEFAULT_LIMITS = Object.freeze({
  nameMaxLength: 63,
  maxAccelerators: 8,
  maxMemoryMiB: 65536,
  maxCoresPercent: 100,
  maxReplicas: 8,
  maxPorts: 8,
  portNameMaxLength: 15,
  maxContextLength: 1048576,
  minInitialDelaySeconds: 0,
  maxInitialDelaySeconds: 600,
  pathMaxLength: 1024,
  idMaxLength: 128,
  maxVersion: 1e9,
});

/** DNS-1123 label：小写字母/数字/中划线，首尾必须是字母或数字。 */
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** 容器端口名：本质是 DNS-1123 label，且不超过 15 个字符（k8s 的 IANA_SVC_NAME 限制）。 */
const PORT_NAME = DNS1123_LABEL;

/** 环境变量名：POSIX 风格。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 量化标记（'Q2_0' / 'fp16' / 'awq'…）：安全字符集，避免拼进 args 时注入空格。 */
const QUANTIZATION = /^[A-Za-z0-9_.-]+$/;

/** 服务 id：只允许安全字符，避免被当成路径/查询参数拼接时出问题。 */
const ID_SAFE = /^[A-Za-z0-9_-]+$/;

/** 是否是「普通对象」（排除 null / 数组 / 原始值 / Date 之类）。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把任意值描述成人能读的中文类型名，用于错误文案。 */
function describeType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'object') return '对象';
  if (typeof value === 'string') return '字符串';
  return typeof value;
}

/** 把输入值放进错误文案（字符串加引号，其余原样），超长时截断。 */
function quote(value) {
  let text;
  if (typeof value === 'string') text = JSON.stringify(value);
  else if (value === undefined) text = 'undefined';
  else if (value === null) text = 'null';
  else if (typeof value === 'object') text = Array.isArray(value) ? '数组' : '对象';
  else text = String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 合并限额：只接受正整数/非负数的覆盖，非法覆盖直接忽略（保持护栏不可被削弱）。 */
function resolveLimits(options) {
  const limits = { ...DEFAULT_LIMITS };
  if (!isPlainObject(options)) return limits;
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const raw = options[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) limits[key] = raw;
  }
  return limits;
}

/**
 * 校验并规范化一个模型服务定义（用户意图）。
 *
 * @param {unknown} input 待校验的定义；形状见 /tmp/infra-contract.md 的 ModelService
 * @param {object} [options] 限额覆盖（`maxReplicas` / `maxMemoryMiB` / `maxAccelerators` /
 *   `maxPorts` / `maxContextLength` 等，见 DEFAULT_LIMITS）
 * @returns {{ ok: boolean, errors: Array<{field: string, message: string}>, value: object|null }}
 *   `value` 是**补全默认值后的规范化对象**（白名单重建，未知字段已被丢弃）；
 *   输入不是对象时 `value` 为 `null`。`ok=false` 时 `value` 只用于回显，
 *   不要直接拿去渲染（render.js 会重新校验并抛错）。
 */
export function validateModelService(input, options = {}) {
  const limits = resolveLimits(options);
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (!isPlainObject(input)) {
    fail('', `定义必须是一个对象（收到 ${describeType(input)}）：至少需要 { name, namespace, model, engine, resources, ports }`);
    return { ok: false, errors, value: null };
  }

  // 白名单重建：value 里只会出现下面这些键。
  const value = {
    id: '',
    name: '',
    namespace: '',
    model: { source: '', path: '' },
    engine: { type: '', image: '', args: [], env: {} },
    resources: { accelerators: 1, memoryMiB: 0, coresPercent: 0 },
    replicas: 1,
    placement: { nodeSelector: {} },
    ports: [],
    health: { path: DEFAULT_HEALTH_PATH, initialDelaySeconds: DEFAULT_HEALTH_INITIAL_DELAY_SECONDS },
    expose: null,
    // 弹性与模型缓存：白名单里必须有，否则 validateModelService 会把它们静默丢掉 ——
    // 后果是路由里 `if (validation.value.autoscale)` 恒 false，HPA 分支永远进不去。
    autoscale: null,
    cache: null,
    createdAt: '',
    updatedAt: '',
    version: 0,
  };

  validateId(input, value, limits, fail);
  validateNameAndNamespace(input, value, limits, fail);
  validateModel(input.model, value, limits, fail);
  validateEngine(input.engine, value, fail);
  validateResources(input.resources, value, limits, fail);
  validateReplicas(input.replicas, value, limits, fail);
  validatePlacement(input.placement, value, fail);
  validatePorts(input.ports, value, limits, fail);
  validateHealth(input.health, value, limits, fail);
  validateAutoscaleInput(input.autoscale, value, fail);
  validateCacheInput(input.cache, value, fail);
  validateExpose(input.expose, value, fail);
  validateMeta(input, value, limits, fail);

  return { ok: errors.length === 0, errors, value };
}

/** id：可选稳定标识；给了就必须是安全字符串（避免被当路径拼接）。 */
function validateId(input, value, limits, fail) {
  const id = input.id;
  if (id === undefined || id === null || id === '') return;
  if (typeof id !== 'string') {
    fail('id', `id 必须是字符串（例如 uuid），收到 ${describeType(id)}`);
    return;
  }
  const trimmed = id.trim();
  if (!ID_SAFE.test(trimmed) || trimmed.length > limits.idMaxLength) {
    fail('id', `id 只允许字母、数字、下划线、中划线，最长 ${limits.idMaxLength}（收到 ${quote(id)}）`);
    return;
  }
  value.id = trimmed;
}

/** name / namespace：name 是 DNS-1123 label，namespace 必须在白名单内。 */
function validateNameAndNamespace(input, value, limits, fail) {
  const rawName = input.name;
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    fail('name', 'name 必填：DNS-1123 label，例如 qwen3-8b-instruct（小写字母/数字/中划线）');
  } else {
    const name = rawName.trim();
    value.name = name;
    if (name.length > limits.nameMaxLength) {
      fail('name', `name 最长 ${limits.nameMaxLength} 个字符（当前 ${name.length}），请缩短到 63 以内`);
    }
    if (!DNS1123_LABEL.test(name)) {
      fail('name', `name 只能包含小写字母、数字和中划线，且首尾必须是字母或数字（收到 ${quote(name)}）`);
    }
  }

  const rawNamespace = input.namespace;
  if (typeof rawNamespace !== 'string' || rawNamespace.trim() === '') {
    fail('namespace', `namespace 必填：只允许 ${NAMESPACE_WHITELIST.join(' / ')}`);
    return;
  }
  const namespace = rawNamespace.trim();
  value.namespace = namespace;
  if (!NAMESPACE_WHITELIST.includes(namespace)) {
    fail('namespace', `namespace 只允许 ${NAMESPACE_WHITELIST.join(' / ')}，收到 ${quote(namespace)}`);
  }
}

/** model：来源枚举 + 路径（hostPath 必须绝对路径，且任何来源都不许穿越）。 */
function validateModel(input, value, limits, fail) {
  if (!isPlainObject(input)) {
    fail('model', 'model 必填：需要 { source, path }，例如 { source: "hostPath", path: "/models/Qwen3-8B" }');
    return;
  }

  const source = input.source;
  if (typeof source !== 'string' || !MODEL_SOURCES.includes(source)) {
    fail('model.source', `model.source 只允许 ${MODEL_SOURCES.join(' / ')}，收到 ${quote(source)}`);
  } else {
    value.model.source = source;
  }

  const rawPath = input.path;
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    fail('model.path', 'model.path 必填：hostPath/pvc 填绝对路径（如 /models/Qwen3-8B），huggingface/modelscope 填仓库 id（如 Qwen/Qwen3-8B），s3 填对象前缀');
  } else {
    const modelPath = rawPath.trim();
    value.model.path = modelPath;
    if (modelPath.length > limits.pathMaxLength) {
      fail('model.path', `model.path 最长 ${limits.pathMaxLength} 个字符（当前 ${modelPath.length}）`);
    }
    if (/\s/.test(modelPath)) {
      fail('model.path', `model.path 不允许包含空白字符（收到 ${quote(modelPath)}）`);
    }
    if (modelPath.includes('..')) {
      fail('model.path', `model.path 不允许包含 ".."（会越出挂载目录，收到 ${quote(modelPath)}）`);
    }
    if (source === 'hostPath' && !modelPath.startsWith('/')) {
      fail('model.path', `model.source=hostPath 时 model.path 必须是绝对路径（以 / 开头，收到 ${quote(modelPath)}）`);
    }
  }

  const format = input.format;
  if (format !== undefined && format !== null) {
    if (typeof format !== 'string' || !MODEL_FORMATS.includes(format)) {
      fail('model.format', `model.format 只允许 ${MODEL_FORMATS.join(' / ')}，收到 ${quote(format)}`);
    } else {
      value.model.format = format;
    }
  }

  const quantization = input.quantization;
  if (quantization !== undefined && quantization !== null) {
    if (typeof quantization !== 'string' || !QUANTIZATION.test(quantization) || quantization.length > 32) {
      fail('model.quantization', `model.quantization 只允许字母、数字、下划线、点、中划线，最长 32（收到 ${quote(quantization)}）`);
    } else {
      value.model.quantization = quantization;
    }
  }

  const contextLength = input.contextLength;
  if (contextLength !== undefined && contextLength !== null) {
    if (!Number.isInteger(contextLength) || contextLength < 1 || contextLength > limits.maxContextLength) {
      fail('model.contextLength', `model.contextLength 必须是 1..${limits.maxContextLength} 的整数（收到 ${quote(contextLength)}）`);
    } else {
      value.model.contextLength = contextLength;
    }
  }

  // 模型足迹估算需要的三个字段（sizeMiB / parametersB / maxConcurrency）。
  // 注意：白名单里没有的键会被静默丢弃 —— autoscale 与 cache 已经因此丢过一次，
  // 表现是"上层分支永远进不去"。这里必须显式接住。
  // specPath：宿主机上的模型路径（读 GGUF 头 / config.json 用）。
  // 为什么和 path 分开：path 是**容器内**路径（可能被 volumeMount 映射过），
  // SSH 读元数据是在宿主机上执行，两者经常不一致（strata: 容器 /data/... ↔ 宿主 /workspace/agent/models/...）。
  const specPath = input.specPath;
  if (specPath !== undefined && specPath !== null) {
    if (typeof specPath !== 'string' || !specPath.trim()) {
      fail('model.specPath', 'model.specPath 必须是非空字符串（宿主机上的模型文件/目录绝对路径）');
    } else if (specPath.includes('..')) {
      fail('model.specPath', 'model.specPath 不允许包含 ..');
    } else if (!specPath.startsWith('/')) {
      fail('model.specPath', `model.specPath 必须是绝对路径，收到 ${quote(specPath)}`);
    } else {
      value.model.specPath = specPath.trim();
    }
  }

  const sizeMiB = input.sizeMiB;
  if (sizeMiB !== undefined && sizeMiB !== null) {
    if (!Number.isFinite(Number(sizeMiB)) || Number(sizeMiB) <= 0) {
      fail('model.sizeMiB', `model.sizeMiB 必须是正数（模型权重占用的 MiB，可用 du -sm 得到），收到 ${quote(sizeMiB)}`);
    } else {
      value.model.sizeMiB = Math.round(Number(sizeMiB));
    }
  }

  const parametersB = input.parametersB ?? input.parameters;
  if (parametersB !== undefined && parametersB !== null) {
    const parsed = typeof parametersB === 'number' ? parametersB : Number(String(parametersB).replace(/[bB]$/, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      fail('model.parametersB', `model.parametersB 必须是正数（单位 B，例如 32 或 "32B"），收到 ${quote(parametersB)}`);
    } else {
      value.model.parametersB = parsed;
    }
  }

  const maxConcurrency = input.maxConcurrency;
  if (maxConcurrency !== undefined && maxConcurrency !== null) {
    if (!Number.isInteger(Number(maxConcurrency)) || Number(maxConcurrency) < 1 || Number(maxConcurrency) > 1024) {
      fail('model.maxConcurrency', `model.maxConcurrency 必须是 1..1024 的整数（KV cache 估算按它算），收到 ${quote(maxConcurrency)}`);
    } else {
      value.model.maxConcurrency = Number(maxConcurrency);
    }
  }
}

/** engine：类型枚举、镜像非空、args 字符串数组、env 变量名安全。 */
function validateEngine(input, value, fail) {
  if (!isPlainObject(input)) {
    fail('engine', 'engine 必填：需要 { type, image }，例如 { type: "vllm", image: "vllm/vllm-openai:v0.11.0" }');
    return;
  }

  const type = input.type;
  if (typeof type !== 'string' || !ENGINE_TYPES.includes(type)) {
    fail('engine.type', `engine.type 只允许 ${ENGINE_TYPES.join(' / ')}，收到 ${quote(type)}`);
  } else {
    value.engine.type = type;
  }

  const image = input.image;
  if (typeof image !== 'string' || image.trim() === '') {
    fail('engine.image', 'engine.image 必填：容器镜像地址，例如 vllm/vllm-openai:v0.11.0');
  } else if (/\s/.test(image.trim())) {
    fail('engine.image', `engine.image 不允许包含空白字符（收到 ${quote(image)}）`);
  } else {
    value.engine.image = image.trim();
  }

  const args = input.args;
  if (args !== undefined && args !== null) {
    if (!Array.isArray(args)) {
      fail('engine.args', `engine.args 必须是字符串数组，例如 ["--tensor-parallel-size", "2"]（收到 ${describeType(args)}）`);
    } else {
      args.forEach((arg, index) => {
        if (typeof arg !== 'string') {
          fail(`engine.args[${index}]`, `engine.args[${index}] 必须是字符串（收到 ${describeType(arg)}）`);
        } else if (arg === '') {
          fail(`engine.args[${index}]`, `engine.args[${index}] 不能是空字符串`);
        } else {
          value.engine.args.push(arg);
        }
      });
    }
  }

  const env = input.env;
  if (env !== undefined && env !== null) {
    if (!isPlainObject(env)) {
      fail('engine.env', `engine.env 必须是 { 变量名: 字符串值 } 的对象（收到 ${describeType(env)}）`);
    } else {
      for (const key of Object.keys(env).sort()) {
        const raw = env[key];
        if (!ENV_NAME.test(key)) {
          fail(`engine.env.${key}`, `engine.env 变量名不合法：${quote(key)}（只允许字母/数字/下划线，且不能以数字开头）`);
        } else if (typeof raw !== 'string') {
          fail(`engine.env.${key}`, `engine.env.${key} 必须是字符串（收到 ${describeType(raw)}），数字/布尔请加引号`);
        } else {
          value.engine.env[key] = raw;
        }
      }
    }
  }
}

/** resources：加速卡 1..maxAccelerators、显存 0..maxMemoryMiB、算力 0..100、可选厂商枚举。 */
function validateResources(input, value, limits, fail) {
  if (!isPlainObject(input)) {
    fail('resources', 'resources 必填：需要 { accelerators, memoryMiB, coresPercent }，例如 { accelerators: 1, memoryMiB: 8192, coresPercent: 0 }');
    return;
  }

  const accelerators = input.accelerators;
  if (accelerators === undefined || accelerators === null) {
    fail('resources.accelerators', `resources.accelerators 必填：每副本申请的加速卡数（HAMi 下是 vGPU 份额），允许 1..${limits.maxAccelerators}`);
  } else if (!Number.isInteger(accelerators)) {
    fail('resources.accelerators', `resources.accelerators 必须是 1..${limits.maxAccelerators} 的整数（收到 ${quote(accelerators)}）`);
  } else if (accelerators < 1 || accelerators > limits.maxAccelerators) {
    fail('resources.accelerators', `resources.accelerators 必须在 1..${limits.maxAccelerators} 之间（收到 ${accelerators}），单服务最多 8 卡`);
  } else {
    value.resources.accelerators = accelerators;
  }

  const memoryMiB = input.memoryMiB;
  if (memoryMiB !== undefined && memoryMiB !== null) {
    if (!Number.isInteger(memoryMiB)) {
      fail('resources.memoryMiB', `resources.memoryMiB 必须是 0..${limits.maxMemoryMiB} 的整数，单位 MiB（收到 ${quote(memoryMiB)}）`);
    } else if (memoryMiB < 0 || memoryMiB > limits.maxMemoryMiB) {
      fail('resources.memoryMiB', `resources.memoryMiB 必须在 0..${limits.maxMemoryMiB} 之间，0 表示整卡不限显存（收到 ${memoryMiB}）`);
    } else {
      value.resources.memoryMiB = memoryMiB;
    }
  }

  const coresPercent = input.coresPercent;
  if (coresPercent !== undefined && coresPercent !== null) {
    if (!Number.isInteger(coresPercent)) {
      fail('resources.coresPercent', `resources.coresPercent 必须是 0..${limits.maxCoresPercent} 的整数（收到 ${quote(coresPercent)}）`);
    } else if (coresPercent < 0 || coresPercent > limits.maxCoresPercent) {
      fail('resources.coresPercent', `resources.coresPercent 必须在 0..${limits.maxCoresPercent} 之间，0 表示不限算力（收到 ${coresPercent}）`);
    } else {
      value.resources.coresPercent = coresPercent;

      // 算力配额必须与显存配额同时给：memoryMiB = 0 表示"整卡不切分"，
      // 此时再限算力会让加速卡适配器无从生成资源键（NVIDIA 侧会抛 ACCELERATOR_INVALID）。
      // 校验层就拦掉，用户看到的是字段级中文提示，而不是渲染期的内部错误。
      if (coresPercent > 0 && (input.memoryMiB === 0 || value.resources.memoryMiB === 0)) {
        fail(
          'resources.coresPercent',
          '整卡模式（显存配额 0 = 不切分）不能单独限制算力配额：请同时填写显存配额 MiB，或把算力配额也设为 0',
        );
      }
    }
  }

  const vendor = input.vendor;
  if (vendor !== undefined && vendor !== null) {
    if (typeof vendor !== 'string' || !ACCELERATOR_VENDORS.includes(vendor)) {
      fail('resources.vendor', `resources.vendor 只允许 ${ACCELERATOR_VENDORS.join(' / ')}，收到 ${quote(vendor)}`);
    } else {
      value.resources.vendor = vendor;
    }
  }
}

/** replicas：1..maxReplicas（默认 8）。 */
function validateReplicas(input, value, limits, fail) {
  if (input === undefined || input === null) return;
  if (!Number.isInteger(input)) {
    fail('replicas', `replicas 必须是 1..${limits.maxReplicas} 的整数（收到 ${quote(input)}）`);
    return;
  }
  if (input < 1 || input > limits.maxReplicas) {
    fail('replicas', `replicas 必须是 1..${limits.maxReplicas} 的整数（收到 ${input}），超过 ${limits.maxReplicas} 副本请拆成多个服务`);
    return;
  }
  value.replicas = input;
}

/** placement：nodeSelector 是 string→string 映射，acceleratorModel 非空字符串。 */
function validatePlacement(input, value, fail) {
  if (input === undefined || input === null) return;
  if (!isPlainObject(input)) {
    fail('placement', `placement 必须是对象，例如 { nodeSelector: { "gpu-type": "4090" }, acceleratorModel: "NVIDIA GeForce RTX 4090" }（收到 ${describeType(input)}）`);
    return;
  }

  const nodeSelector = input.nodeSelector;
  if (nodeSelector !== undefined && nodeSelector !== null) {
    if (!isPlainObject(nodeSelector)) {
      fail('placement.nodeSelector', `placement.nodeSelector 必须是 { 标签名: 字符串值 } 的对象（收到 ${describeType(nodeSelector)}）`);
    } else {
      for (const key of Object.keys(nodeSelector).sort()) {
        const raw = nodeSelector[key];
        if (key.trim() === '' || /\s/.test(key)) {
          fail('placement.nodeSelector', `placement.nodeSelector 的键不能为空或包含空白（收到 ${quote(key)}）`);
        } else if (typeof raw !== 'string') {
          fail(`placement.nodeSelector.${key}`, `placement.nodeSelector["${key}"] 必须是字符串（收到 ${describeType(raw)}）`);
        } else {
          value.placement.nodeSelector[key] = raw;
        }
      }
    }
  }

  const model = input.acceleratorModel;
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string') {
      fail('placement.acceleratorModel', `placement.acceleratorModel 必须是型号字符串，例如 "NVIDIA GeForce RTX 4090"（收到 ${describeType(model)}）`);
    } else if (model.trim() !== '') {
      value.placement.acceleratorModel = model.trim();
    }
  }
}

/** ports：至少 1 个，端口名/端口号各自唯一，范围 1..65535。 */
function validatePorts(input, value, limits, fail) {
  if (!Array.isArray(input) || input.length === 0) {
    fail('ports', 'ports 至少需要 1 个端口，例如 [{ name: "http", containerPort: 8000 }]');
    return;
  }
  if (input.length > limits.maxPorts) {
    fail('ports', `ports 最多 ${limits.maxPorts} 个（收到 ${input.length}），多余端口请合并或走网关`);
    return;
  }

  const seenNames = new Set();
  const seenPorts = new Set();

  input.forEach((item, index) => {
    const field = `ports[${index}]`;
    if (!isPlainObject(item)) {
      fail(field, `${field} 必须是 { name, containerPort } 对象（收到 ${describeType(item)}）`);
      return;
    }

    let nameOk = false;
    let portOk = false;
    let name = '';
    let containerPort = 0;

    const rawName = item.name;
    if (typeof rawName !== 'string' || rawName.trim() === '') {
      fail(`${field}.name`, `${field}.name 必填：1..${limits.portNameMaxLength} 个小写字母/数字/中划线，例如 "http"`);
    } else {
      name = rawName.trim();
      if (name.length > limits.portNameMaxLength) {
        fail(`${field}.name`, `${field}.name 最长 ${limits.portNameMaxLength} 个字符（k8s 端口名限制，收到 ${quote(name)}）`);
      } else if (!PORT_NAME.test(name)) {
        fail(`${field}.name`, `${field}.name 只能是小写字母、数字和中划线，且首尾是字母或数字（收到 ${quote(name)}）`);
      } else if (seenNames.has(name)) {
        fail(`${field}.name`, `端口名重复：${quote(name)}（同一个 Service 内端口名必须唯一）`);
      } else {
        seenNames.add(name);
        nameOk = true;
      }
    }

    const rawPort = item.containerPort;
    if (!Number.isInteger(rawPort)) {
      fail(`${field}.containerPort`, `${field}.containerPort 必须是 1..65535 的整数（收到 ${quote(rawPort)}）`);
    } else if (rawPort < 1 || rawPort > 65535) {
      fail(`${field}.containerPort`, `${field}.containerPort 必须在 1..65535 之间（收到 ${rawPort}）`);
    } else if (seenPorts.has(rawPort)) {
      fail(`${field}.containerPort`, `端口重复：${rawPort}（同一个 Pod 内不能有两个容器端口同号）`);
    } else {
      seenPorts.add(rawPort);
      containerPort = rawPort;
      portOk = true;
    }

    if (nameOk && portOk) value.ports.push({ name, containerPort });
  });
}

/** health：可选；给了 path 就必须以 / 开头，首检延迟 0..600 秒。 */
function validateHealth(input, value, limits, fail) {
  if (input === undefined || input === null) return;
  if (!isPlainObject(input)) {
    fail('health', `health 必须是 { path, initialDelaySeconds } 对象，例如 { path: "/health", initialDelaySeconds: 30 }（收到 ${describeType(input)}）`);
    return;
  }

  const rawPath = input.path;
  if (rawPath !== undefined && rawPath !== null) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      fail('health.path', `health.path 必填且非空，必须是以 / 开头的 HTTP 路径（收到 ${quote(rawPath)}）`);
    } else {
      const path = rawPath.trim();
      if (!path.startsWith('/')) {
        fail('health.path', `health.path 必须以 / 开头（收到 ${quote(path)}），例如 /health 或 /v1/models`);
      } else if (/\s/.test(path)) {
        fail('health.path', `health.path 不允许包含空白字符（收到 ${quote(path)}）`);
      } else {
        value.health.path = path;
      }
    }
  }

  const delay = input.initialDelaySeconds;
  if (delay !== undefined && delay !== null) {
    if (!Number.isInteger(delay) || delay < limits.minInitialDelaySeconds || delay > limits.maxInitialDelaySeconds) {
      fail('health.initialDelaySeconds', `health.initialDelaySeconds 必须是 ${limits.minInitialDelaySeconds}..${limits.maxInitialDelaySeconds} 的整数（收到 ${quote(delay)}）`);
    } else {
      value.health.initialDelaySeconds = delay;
    }
  }
}

/** expose：null/缺省表示不注册网关；给了 gatewayPort 就必须是 1..65535。 */
function validateExpose(input, value, fail) {
  if (input === undefined || input === null) return;
  if (!isPlainObject(input)) {
    fail('expose', `expose 必须是 { gatewayPort } 对象或 null（null 表示不注册网关，收到 ${describeType(input)}）`);
    return;
  }
  value.expose = {};
  const gatewayPort = input.gatewayPort;
  if (gatewayPort !== undefined && gatewayPort !== null) {
    if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
      fail('expose.gatewayPort', `expose.gatewayPort 必须是 1..65535 的整数（收到 ${quote(gatewayPort)}）`);
    } else {
      value.expose.gatewayPort = gatewayPort;
    }
  }
}

/** 元数据字段：version / createdAt / updatedAt（都是可选，缺省给稳定默认值）。 */
function validateMeta(input, value, limits, fail) {
  const version = input.version;
  if (version !== undefined && version !== null) {
    if (!Number.isInteger(version) || version < 0 || version > limits.maxVersion) {
      fail('version', `version 必须是 0..${limits.maxVersion} 的整数（收到 ${quote(version)}）`);
    } else {
      value.version = version;
    }
  }

  for (const field of ['createdAt', 'updatedAt']) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
      fail(field, `${field} 必须是 ISO 时间字符串，例如 2026-01-02T03:04:05Z（收到 ${quote(raw)}）`);
    } else {
      value[field] = raw;
    }
  }
}

/**
 * 模型服务的稳定标识：`${namespace}/${name}`（A5 的 apply/rollback、A7 的历史列表都靠它对齐）。
 *
 * @param {{namespace?: string, name?: string}} svc 模型服务（或已规范化的 value）
 * @returns {string} 例如 `inference/qwen3-8b`
 * @throws {Error} name/namespace 缺失时抛错（中文，指出缺哪个）
 */
/**
 * 弹性配置：形状校验交给 infra/autoscale.js（单一事实来源），
 * 这里只做"要不要带进来"的判断 —— 没给就保持 null，给了就归一后存下。
 */
function validateAutoscaleInput(input, value, fail) {
  if (input === undefined || input === null) return;
  if (typeof input !== 'object' || Array.isArray(input)) {
    fail('autoscale', 'autoscale 必须是对象（{ minReplicas, maxReplicas, metrics }），或者省略表示不启用');
    return;
  }
  // 缺 maxReplicas 视为不启用（不是错误：表单里没勾选）
  if (input.maxReplicas === undefined || input.maxReplicas === null) return;
  value.autoscale = {
    minReplicas: input.minReplicas,
    maxReplicas: input.maxReplicas,
    cooldownSeconds: input.cooldownSeconds,
    metrics: Array.isArray(input.metrics) ? input.metrics : undefined,
  };
  // 深度校验（区间/指标白名单）在路由层调 autoscale.validateAutoscale 做，
  // 那里能给出更有针对性的文案；这里不重复实现，避免两处规则漂移。
}

/** 模型缓存配置：同上，只决定"带不带"，细节由 infra/model-cache.js 校验 */
function validateCacheInput(input, value, fail) {
  if (input === undefined || input === null) return;
  if (typeof input !== 'object' || Array.isArray(input)) {
    fail('cache', 'cache 必须是对象（{ mode, hostPath?, pvc? }），或者省略表示按 model.source 自动推导');
    return;
  }
  value.cache = input;
}

export function serviceKey(svc) {
  const namespace = typeof svc?.namespace === 'string' ? svc.namespace.trim() : '';
  const name = typeof svc?.name === 'string' ? svc.name.trim() : '';
  if (!namespace || !name) {
    throw new Error(
      `serviceKey 需要 namespace 与 name：收到 namespace=${quote(svc?.namespace)}，name=${quote(svc?.name)}；请先跑 validateModelService() 拿到规范化的 value。`,
    );
  }
  return `${namespace}/${name}`;
}
