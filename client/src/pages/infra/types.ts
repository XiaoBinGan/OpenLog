/**
 * AI Infra 页面（模型服务）的本地类型 + 契约对齐的纯函数。
 *
 * 为什么类型放这里而不是 `client/src/types.ts`：那个文件由接线 agent（A9）统一维护，
 * 并行开发期两边同时改必然冲突。这里逐字照抄 `/tmp/infra-contract.md` 的
 * `ModelService`，并按 A2（护栏）/ A5（执行器）/ A6（基准）的返回形状补上
 * 响应包装类型 —— 契约是前后端共用的事实来源，本地副本只是编译期形状。
 *
 * 为什么纯函数也放这里：本轮只允许新建 `pages/infra/` 下的 4 个文件（没有 utils.ts），
 * 而下面这些判断**错了不会报错，只会显示成另一回事**：
 *   · 表单校验（DNS-1123、配额上下限、命名空间白名单）—— 必须与 A1/A2 同一套规则，
 *     前端宽了就会把注定被后端拒绝的表单提交上去；
 *   · impact 估算（改配额是否重建 Pod、预计中断多久）—— A2 的 impact 语义在前端的
 *     本地预判，用户要在**点提交之前**就看到「这一下会断 30 秒」；
 *   · draft ↔ ModelService 转换（输入框里全是字符串，NaN 绝不能流进 payload）。
 * 它们都不依赖 React、不发请求，因此可以被 vitest 直接按表驱动测试。
 *
 * 总开关语义（契约铁律 4）：`OPENLOG_K8S_INFRA=1` 才启用，列表接口用
 * `enabled:false + reason` 表达，前端据此禁用「新建服务」而不是假装一切正常。
 */

// ─── 数据模型（照抄契约中的 ModelService） ────────────────────────────────

/** 模型来源。hostPath 是节点上的目录，其余是仓库 id / 存储路径。 */
export type ModelSourceKind = 'hostPath' | 'pvc' | 'huggingface' | 'modelscope' | 's3';

/** 权重格式（可选，引擎多半能自己嗅探）。 */
export type ModelFormat = 'safetensors' | 'gguf' | 'pytorch';

/** 推理引擎类型。 */
export type EngineKind = 'vllm' | 'sglang' | 'llama.cpp' | 'strata' | 'tgi';

/** 容器端口。`name` 进 Service 的 port name，必须是 DNS-1123 label。 */
export interface ModelServicePort {
  name: string;
  containerPort: number;
}

/**
 * 一个模型服务：用户的**意图**，不是 k8s 对象。
 * 渲染成 Deployment/Service/Ingress 是 A1（`renderModelService`）的事。
 */
export interface ModelService {
  /** 稳定标识（uuid）；新建草稿为空串。 */
  id: string;
  /** DNS-1123 label。 */
  name: string;
  /** 必须在白名单（inference / infra-test）内。 */
  namespace: string;
  model: {
    source: ModelSourceKind;
    /** hostPath 绝对路径，或仓库 id（org/repo）。 */
    path: string;
    format?: ModelFormat;
    /** 'Q2_0' | 'fp16' | 'awq' … */
    quantization?: string;
    /** 期望上下文长度（token）。 */
    contextLength?: number;
  };
  engine: {
    type: EngineKind;
    image: string;
    /** 额外启动参数（本页不编辑，原样回传）。 */
    args?: string[];
  };
  resources: {
    /** 每副本申请的加速卡数（整卡语义；HAMi 下是 vGPU 份额）。 */
    accelerators: number;
    /** 显存配额（MiB）；0 = 不限制（整卡）。 */
    memoryMiB: number;
    /** 算力配额（百分比点 0-100）；0 = 不限制。 */
    coresPercent: number;
  };
  /** 1..8。 */
  replicas: number;
  placement: {
    nodeSelector?: Record<string, string>;
    /** 型号亲和，渲染成 nodeAffinity。 */
    acceleratorModel?: string;
  };
  ports: ModelServicePort[];
  health: {
    path: string;
    initialDelaySeconds?: number;
  };
  /** 网关是否自动注册（hostNetwork nginx stream）；null/省略 = 不暴露。 */
  expose?: { gatewayPort?: number } | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

// ─── 后端响应类型（A2 / A5 / A6 的返回形状） ──────────────────────────────

/** 服务运行阶段（服务端从 Deployment/Service 汇总，读不到就是 unknown）。 */
export type ServicePhase =
  | 'pending'
  | 'applying'
  | 'running'
  | 'degraded'
  | 'failed'
  | 'unknown';

/** 服务实时状态。 */
export interface InfraServiceStatus {
  phase: ServicePhase;
  readyReplicas?: number;
  /** 为什么是这个阶段（读不到 Pod 时给人看的原因）。 */
  message?: string;
  observedAt?: string;
}

/** 一条变更历史（A5 写入，随服务下发）。 */
export interface InfraHistoryEntry {
  id: string;
  at: string;
  action: 'create' | 'update' | 'rollback';
  ok: boolean;
  /** 这次变更之后的版本号（回滚时用 version 定位快照）。 */
  version: number;
  actor?: string;
  note?: string;
}

/** 列表里的一个服务 = 意图 + 实时状态 + 历史。 */
export interface InfraServiceView extends ModelService {
  status?: InfraServiceStatus | null;
  history?: InfraHistoryEntry[];
}

/** `GET /api/infra/services` 的响应。 */
export interface InfraServiceListResponse {
  services: InfraServiceView[];
  /** false 表示 `OPENLOG_K8S_INFRA` 没开（新能力默认关闭）。 */
  enabled?: boolean;
  demo?: boolean;
  /** enabled:false 或读取失败时的人类可读原因。 */
  reason?: string;
}

/** A2 的一条护栏违规。`code` 便于机器分类，`message` 必须能指导操作。 */
export interface GuardViolation {
  code?: string;
  /** 出问题的字段（draft 字段名或 `resources.memoryMiB` 这类路径）。 */
  field?: string;
  message: string;
}

/** 变更动作。 */
export type InfraAction = 'create' | 'update' | 'delete' | 'noop';

/** A2 的 impact：这次变更会不会断服、断多久。 */
export interface InfraImpact {
  action: InfraAction;
  /** 是否需要重建 Pod（配额 / 镜像 / 模型路径 / 端口变化都算）。 */
  restarts: boolean;
  /** 预计中断秒数（0 = 不断服）。多副本时是**最坏情况**（全部副本依次重建）。 */
  downtimeSeconds: number;
  /** 中文理由，逐条展示；空数组时 UI 走兜底文案。 */
  reasons: string[];
}

/** `POST /api/infra/services/:id/preview` 的响应（= A2 checkGuard + renderDiff）。 */
export interface GuardResult {
  allowed: boolean;
  violations: GuardViolation[];
  /** 文本 diff（unified 风格，`+`/`-` 前缀）。 */
  diff: string;
  impact: InfraImpact;
}

/** A5 执行器的一个步骤。 */
export interface ApplyStep {
  name: string;
  ok: boolean;
  detail?: string;
}

/** `POST /api/infra/services/:id/apply`（和 `:id/rollback`）的响应。 */
export interface ApplyResult {
  ok: boolean;
  steps: ApplyStep[];
  error?: string;
  auditId?: string;
  /** 回滚是否可用（快照落盘了才可用）。 */
  snapshot?: { available: boolean; id?: string } | null;
  /** 执行后的服务视图（前端就地更新，不必等下一次列表刷新）。 */
  service?: InfraServiceView | null;
}

/** A6 基准矩阵的一个格子的结果。 */
export interface BenchCell {
  concurrency: number;
  promptTokens?: number;
  outputTokens?: number;
  /** 首 token 延迟（毫秒）；失败为 null。 */
  ttftMs?: number | null;
  /** 生成吞吐（token/s）；失败为 null。 */
  tokensPerSec?: number | null;
  /** 这一格失败的原因。 */
  error?: string;
}

/** `POST /api/infra/bench` 的响应。 */
export interface BenchResult {
  results: BenchCell[];
  /** 超阈中止时为 true，`reason` 说明触发了哪条阈值。 */
  aborted?: boolean;
  reason?: string;
  summary?: {
    bestConcurrency?: number | null;
    peakTokensPerSec?: number | null;
  };
  ranAt?: string;
}

/** `POST /api/infra/bench` 的请求体。 */
export interface BenchRequest {
  /** 目标服务（namespace/name 或 id）。 */
  serviceKey: string;
  matrix: {
    concurrency: number[];
    promptTokens?: number;
    outputTokens?: number;
  };
  limits?: {
    maxErrorRate?: number;
    timeoutMs?: number;
  };
}

// ─── 常量（与后端护栏同一套数字，改这里必须同步 A1/A2） ──────────────────

/** 命名空间白名单（契约铁律 2）。kube-system / default / 其它一律拒绝。 */
export const INFRA_NAMESPACES = ['inference', 'infra-test'] as const;

/** 白名单命名空间类型。 */
export type InfraNamespace = (typeof INFRA_NAMESPACES)[number];

/** 配额与端口的上限（A1 校验、A2 护栏用的是同一组数字）。 */
export const INFRA_LIMITS = {
  /** 显存配额上限（MiB）：64 GiB。 */
  memoryMiBMax: 65536,
  /** 算力配额上限（百分比点）。 */
  coresPercentMax: 100,
  /** 副本数上限（契约：1..maxReplicas，默认 8）。 */
  replicasMax: 8,
  /** 每副本加速卡数上限（防御性上限：单机没有 16 卡的消费级方案）。 */
  acceleratorsMax: 16,
  /** 上下文长度上限（token）。 */
  contextLengthMax: 4_194_304,
  /** 合法端口上限。 */
  portMax: 65535,
  /** 单副本重建的保守耗时（秒）—— 拉镜像 + 加载权重 + 建 KV cache。 */
  podRestartSeconds: 30,
} as const;

/** 模型来源下拉项。 */
export const MODEL_SOURCE_OPTIONS = [
  { value: 'hostPath', label: '主机目录（hostPath）', placeholder: '/models/Qwen2.5-72B-Instruct' },
  { value: 'pvc', label: 'PVC 存储卷', placeholder: 'models/qwen-72b' },
  { value: 'huggingface', label: 'HuggingFace 仓库', placeholder: 'Qwen/Qwen2.5-72B-Instruct' },
  { value: 'modelscope', label: 'ModelScope 仓库', placeholder: 'qwen/Qwen2.5-72B-Instruct' },
  { value: 's3', label: 'S3 对象存储', placeholder: 's3://bucket/models/qwen-72b' },
] as const satisfies readonly {
  value: ModelSourceKind;
  label: string;
  placeholder: string;
}[];

/** 引擎下拉项 + 各自常用的默认镜像（切引擎时镜像跟着换，省一次手打）。 */
export const ENGINE_OPTIONS = [
  { value: 'vllm', label: 'vLLM', image: 'vllm/vllm-openai:latest' },
  { value: 'sglang', label: 'SGLang', image: 'lmsysorg/sglang:latest' },
  { value: 'llama.cpp', label: 'llama.cpp', image: 'ghcr.io/ggml-org/llama.cpp:server' },
  { value: 'strata', label: 'Strata', image: 'openlog/strata:latest' },
  { value: 'tgi', label: 'TGI', image: 'ghcr.io/huggingface/text-generation-inference:latest' },
] as const satisfies readonly { value: EngineKind; label: string; image: string }[];

/** 表单里「改这些字段就会重建 Pod」的分组（配额类，用于诚实提示）。 */
export const QUOTA_FIELDS = ['accelerators', 'memoryMiB', 'coresPercent', 'replicas'] as const;

/** 判断命名空间是否在白名单内。 */
export function isInfraNamespace(value: string): value is InfraNamespace {
  return (INFRA_NAMESPACES as readonly string[]).includes(value);
}

/** 引擎默认镜像（找不到时给个空串，让校验把「请填写镜像」顶出来）。 */
export function defaultImageFor(engine: string): string {
  const found = ENGINE_OPTIONS.find((option) => option.value === engine);
  return found ? found.image : '';
}

// ─── 表单草稿（输入框里全是字符串，转换集中在这里） ──────────────────────

/**
 * 表单草稿。数字一律存字符串：`''` / `'12abc'` 这类中间态在受控输入里必然出现，
 * 用 number 存会先被 `Number()` 洗成 NaN 再渲染回输入框，用户看到的是空框。
 */
export interface ServiceDraft {
  id: string;
  name: string;
  namespace: string;
  source: ModelSourceKind;
  modelPath: string;
  quantization: string;
  contextLength: string;
  engine: EngineKind;
  image: string;
  accelerators: string;
  memoryMiB: string;
  coresPercent: string;
  replicas: string;
  acceleratorModel: string;
  containerPort: string;
  healthPath: string;
  exposeGateway: boolean;
  gatewayPort: string;
}

/** 校验结果：字段 → 中文错误（空对象 = 通过）。 */
export type DraftErrors = Partial<Record<keyof ServiceDraft, string>>;

/** 新建草稿的初值。路径**故意留空**：预填一个假路径等于教用户点提交。 */
export function emptyDraft(): ServiceDraft {
  return {
    id: '',
    name: '',
    namespace: 'inference',
    source: 'hostPath',
    modelPath: '',
    quantization: '',
    contextLength: '',
    engine: 'vllm',
    image: defaultImageFor('vllm'),
    accelerators: '1',
    memoryMiB: '8192',
    coresPercent: '100',
    replicas: '1',
    acceleratorModel: '',
    containerPort: '8000',
    healthPath: '/health',
    exposeGateway: false,
    gatewayPort: '',
  };
}

/** 已有服务 → 草稿（编辑态）。 */
export function draftFromService(service: ModelService): ServiceDraft {
  const port = service.ports[0]?.containerPort;
  return {
    id: service.id,
    name: service.name,
    namespace: service.namespace,
    source: service.model.source,
    modelPath: service.model.path,
    quantization: service.model.quantization ?? '',
    contextLength:
      typeof service.model.contextLength === 'number' ? String(service.model.contextLength) : '',
    engine: service.engine.type,
    image: service.engine.image,
    accelerators: String(service.resources.accelerators),
    memoryMiB: String(service.resources.memoryMiB),
    coresPercent: String(service.resources.coresPercent),
    replicas: String(service.replicas),
    acceleratorModel: service.placement.acceleratorModel ?? '',
    containerPort: typeof port === 'number' ? String(port) : '8000',
    healthPath: service.health.path,
    exposeGateway: Boolean(service.expose),
    gatewayPort:
      service.expose && typeof service.expose.gatewayPort === 'number'
        ? String(service.expose.gatewayPort)
        : '',
  };
}

/** 字符串 → 整数，非法/空一律落到 fallback（绝不让 NaN 进 payload）。 */
function intOr(text: string, fallback: number): number {
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * 草稿 → ModelService。
 *
 * 只在 `validateDraft` 通过后调用才会得到「干净」的服务；但即便被误调用也不会
 * 产出 NaN —— 数字字段全部走 `intOr` 兜底，`base` 里的 createdAt/version 等
 * 服务端字段原样保留（前端不造这些值）。
 */
export function serviceFromDraft(draft: ServiceDraft, base?: ModelService | null): ModelService {
  const now = new Date().toISOString();
  const accelerators = intOr(draft.accelerators, 0);
  const memoryMiB = intOr(draft.memoryMiB, 0);
  const coresPercent = intOr(draft.coresPercent, 0);
  const replicas = intOr(draft.replicas, 1);
  const containerPort = intOr(draft.containerPort, 8000);
  const contextLength = intOr(draft.contextLength, 0);

  return {
    id: draft.id || base?.id || '',
    name: draft.name.trim(),
    namespace: draft.namespace,
    model: {
      source: draft.source,
      path: draft.modelPath.trim(),
      quantization: draft.quantization.trim() || undefined,
      contextLength: contextLength > 0 ? contextLength : undefined,
    },
    engine: {
      type: draft.engine,
      image: draft.image.trim(),
      // 额外启动参数本页不编辑，编辑态原样带回去，否则提交会把用户手写的 args 抹掉
      args: base?.engine.args,
    },
    resources: { accelerators, memoryMiB, coresPercent },
    replicas,
    placement: {
      nodeSelector: base?.placement.nodeSelector,
      acceleratorModel: draft.acceleratorModel.trim() || undefined,
    },
    ports: [{ name: base?.ports[0]?.name || 'http', containerPort }],
    health: {
      path: draft.healthPath.trim(),
      initialDelaySeconds: base?.health.initialDelaySeconds,
    },
    expose:
      draft.exposeGateway && draft.gatewayPort.trim()
        ? { gatewayPort: intOr(draft.gatewayPort, 0) || undefined }
        : draft.exposeGateway
          ? {}
          : null,
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
    version: base?.version ?? 0,
  };
}

// ─── 校验（与 A1/A2 同一套规则，中文错误直接显示在字段下方） ──────────────

/** DNS-1123 label：小写字母/数字/连字符，字母数字开头结尾。 */
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** 整数区间校验，错误写进 errors[field]。 */
function checkInt(
  errors: DraftErrors,
  field: keyof ServiceDraft,
  text: string,
  min: number,
  max: number,
  label: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) {
    errors[field] = `${label}不能为空（${min}–${max}）`;
    return;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value)) {
    errors[field] = `${label}必须是整数（${min}–${max}）`;
    return;
  }
  if (value < min || value > max) {
    errors[field] = `${label}必须是 ${min}–${max} 的整数`;
  }
}

/**
 * 表单校验。规则与后端一致，**前端不放大也不放宽**：
 *   · name：DNS-1123 label，1–63 字符；
 *   · namespace：只允许 inference / infra-test；
 *   · memoryMiB：0–65536；coresPercent：0–100；replicas：1–8；
 *   · accelerators：0–16；containerPort / gatewayPort：1–65535；
 *   · hostPath 必须绝对路径，S3 必须 s3:// 前缀。
 */
export function validateDraft(draft: ServiceDraft): DraftErrors {
  const errors: DraftErrors = {};

  const name = draft.name.trim().trim();
  if (!name) {
    errors.name = '请填写服务名（DNS-1123：小写字母、数字、连字符，最长 63 字符）';
  } else if (name.length > 63 || !DNS1123_LABEL.test(name)) {
    errors.name =
      '服务名必须是 DNS-1123 label：只能用小写字母、数字和连字符，以字母或数字开头结尾，最长 63 字符';
  }

  if (!isInfraNamespace(draft.namespace)) {
    errors.namespace = `命名空间只允许 ${INFRA_NAMESPACES.join(' / ')}（其它命名空间会被护栏直接拒绝）`;
  }

  const path = draft.modelPath.trim();
  if (!path) {
    errors.modelPath =
      draft.source === 'hostPath'
        ? '请填写模型在节点上的绝对路径（以 / 开头）'
        : '请填写模型仓库 id 或存储路径';
  } else if (draft.source === 'hostPath' && !path.startsWith('/')) {
    errors.modelPath = 'hostPath 必须是节点上的绝对路径（以 / 开头）';
  } else if (draft.source === 's3' && !path.startsWith('s3://')) {
    errors.modelPath = 'S3 来源的路径必须以 s3:// 开头';
  } else if (draft.source === 'pvc' && !path.includes('/')) {
    errors.modelPath = 'PVC 路径写成 <claim>/<子路径>，例如 models/qwen-72b';
  }

  const contextLength = draft.contextLength.trim();
  if (contextLength) {
    const value = Number(contextLength);
    if (!Number.isInteger(value) || value < 128 || value > INFRA_LIMITS.contextLengthMax) {
      errors.contextLength = `上下文长度必须是不小于 128 的整数（留空 = 用引擎默认），上限 ${INFRA_LIMITS.contextLengthMax}`;
    }
  }

  const image = draft.image.trim();
  if (!image) {
    errors.image = '请填写引擎镜像（带 tag，例如 vllm/vllm-openai:v0.6.3）';
  } else if (/\s/.test(image)) {
    errors.image = '镜像名里不能有空格';
  }

  checkInt(errors, 'accelerators', draft.accelerators, 0, INFRA_LIMITS.acceleratorsMax, '加速卡数');
  checkInt(errors, 'memoryMiB', draft.memoryMiB, 0, INFRA_LIMITS.memoryMiBMax, '显存配额（MiB）');
  checkInt(errors, 'coresPercent', draft.coresPercent, 0, INFRA_LIMITS.coresPercentMax, '算力配额（%）');
  checkInt(errors, 'replicas', draft.replicas, 1, INFRA_LIMITS.replicasMax, '副本数');
  checkInt(errors, 'containerPort', draft.containerPort, 1, INFRA_LIMITS.portMax, '容器端口');
  // 留空 = 由服务端分配端口（与字段说明一致，不能反过来要求必填）
  if (draft.exposeGateway && draft.gatewayPort.trim()) {
    checkInt(errors, 'gatewayPort', draft.gatewayPort, 1, INFRA_LIMITS.portMax, '网关端口');
  }

  const healthPath = draft.healthPath.trim();
  if (!healthPath) {
    errors.healthPath = '请填写健康检查路径（例如 /health）';
  } else if (!healthPath.startsWith('/')) {
    errors.healthPath = '健康检查路径必须以 / 开头';
  }

  return errors;
}

// ─── 变更比较与 impact 估算（A2 的语义在前端的本地预判） ─────────────────

/** 一个字段的变化（用于 impact 理由与「诚实提示」）。 */
export interface FieldChange {
  /** draft 字段名（与表单 data-field 一致）。 */
  field: keyof ServiceDraft;
  label: string;
  before: string;
  after: string;
  /** 是否属于「配额」类（改了就重建 Pod，必须给中断提示）。 */
  quota: boolean;
  /** 是否触发 Pod 重建。 */
  restarts: boolean;
}

/** 取第一个端口以外的比较值统一转字符串。 */
function show(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

/**
 * 逐个字段比较两份服务（`before` 为 null 时返回空数组 = 新建，没有可比较的基线）。
 * 顺序固定：配额 → 镜像/模型 → 端口 → 健康检查，UI 直接顺序渲染。
 */
export function diffServiceFields(
  before: ModelService | null,
  after: ModelService,
): FieldChange[] {
  if (!before) return [];
  const changes: FieldChange[] = [];

  const push = (
    field: keyof ServiceDraft,
    label: string,
    from: string | number | undefined | null,
    to: string | number | undefined | null,
    quota: boolean,
    restarts = true,
  ) => {
    const a = show(from);
    const b = show(to);
    if (a === b) return;
    changes.push({ field, label, before: a, after: b, quota, restarts });
  };

  push('accelerators', '加速卡数', before.resources.accelerators, after.resources.accelerators, true);
  push('memoryMiB', '显存配额', before.resources.memoryMiB, after.resources.memoryMiB, true);
  push('coresPercent', '算力配额', before.resources.coresPercent, after.resources.coresPercent, true);
  push('replicas', '副本数', before.replicas, after.replicas, true);

  push('name', '服务名', before.name, after.name, false);
  push('namespace', '命名空间', before.namespace, after.namespace, false);
  push('engine', '引擎', before.engine.type, after.engine.type, false);
  push('image', '镜像', before.engine.image, after.engine.image, false);
  push('source', '模型来源', before.model.source, after.model.source, false);
  push('modelPath', '模型路径', before.model.path, after.model.path, false);
  push('quantization', '量化', before.model.quantization, after.model.quantization, false);
  push('contextLength', '上下文长度', before.model.contextLength, after.model.contextLength, false);
  push('containerPort', '容器端口', before.ports[0]?.containerPort, after.ports[0]?.containerPort, false);
  push('healthPath', '健康检查路径', before.health.path, after.health.path, false);
  push(
    'acceleratorModel',
    '节点型号亲和',
    before.placement.acceleratorModel,
    after.placement.acceleratorModel,
    false,
  );
  push(
    'gatewayPort',
    '网关端口',
    before.expose?.gatewayPort,
    after.expose?.gatewayPort,
    false,
    false,
  );

  return changes;
}

/**
 * 本地 impact 估算 —— 与 A2 的 impact 语义对齐，用于「提交之前」的诚实提示。
 *
 * 中断秒数的口径：**保守按最坏情况**给单副本 30 秒（拉镜像 + 加载权重 + 建 KV cache），
 * 多副本滚动更新时理论上可以不断服，但 readiness 探针没配好、模型加载慢于
 * maxUnavailable 时依然会掉容量，所以按 `30 × 副本数` 写在「最坏情况」这一档，
 * 并在文案里说清楚它是上限而不是预期值。
 */
export function estimateImpact(before: ModelService | null, after: ModelService): InfraImpact {
  const changes = diffServiceFields(before, after);

  if (!before) {
    return {
      action: 'create',
      restarts: false,
      downtimeSeconds: 0,
      reasons: ['首次创建，不影响任何已运行的服务'],
    };
  }

  if (changes.length === 0) {
    return {
      action: 'noop',
      restarts: false,
      downtimeSeconds: 0,
      reasons: ['与当前定义一致，执行不会改动集群'],
    };
  }

  const restartChanges = changes.filter((change) => change.restarts);
  const restarts = restartChanges.length > 0;
  const replicas = Math.max(1, after.replicas);
  const downtimeSeconds = restarts ? INFRA_LIMITS.podRestartSeconds * replicas : 0;

  const reasons = changes.map(
    (change) => `${change.label} ${change.before} → ${change.after}`,
  );
  if (restarts) {
    reasons.push(
      `单副本重建约 ${INFRA_LIMITS.podRestartSeconds} 秒（拉镜像 + 加载权重），${replicas} 副本最坏约 ${downtimeSeconds} 秒`,
    );
  }

  return { action: 'update', restarts, downtimeSeconds, reasons };
}

/** 配额类变化（内存/算力/副本/加速卡）—— 表单里的「诚实提示」只在非空时出现。 */
export function quotaChanges(changes: FieldChange[]): FieldChange[] {
  return changes.filter((change) => change.quota);
}

// ─── 路径与响应归一 ──────────────────────────────────────────────────────

/** 列表接口路径。 */
export const INFRA_SERVICES_PATH = '/api/infra/services';

/**
 * 单个服务的子路径（preview / apply / rollback / history）。
 *
 * id 可能来自用户输入的 `namespace/name`（新建草稿没有 uuid），因此必须
 * `encodeURIComponent`，否则 `/` 会被当成路径分隔符打到另一个路由上。
 */
export function infraServicePath(id: string, suffix = ''): string {
  return `${INFRA_SERVICES_PATH}/${encodeURIComponent(id)}${suffix}`;
}

/** 服务标识：优先 uuid，新建草稿退回 `namespace/name`。 */
export function serviceKeyOf(service: Pick<ModelService, 'id' | 'namespace' | 'name'>): string {
  const id = (service.id ?? '').trim();
  if (id) return id;
  return `${service.namespace}/${service.name}`;
}

/** 任意抛出物 → 一句可展示的中文（ApiError 的 message 已经是人类可读的）。 */
export function errorText(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return '请求失败，请查看服务端日志';
}

/** 把任意值收敛成对象（响应里多一层包装 / 少一层包装都不至于渲染成 undefined）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 违规项归一：后端可能给字符串，也可能给 `{code, field, message}`。 */
export function normalizeViolations(input: unknown): GuardViolation[] {
  if (!Array.isArray(input)) return [];
  const out: GuardViolation[] = [];
  for (const item of input) {
    if (typeof item === 'string') {
      const message = item.trim();
      if (message) out.push({ message });
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    // 「只有 code 没有 message」时也要能给用户一句话，而不是空白红条
    const code = typeof record.code === 'string' ? record.code : undefined;
    const field = typeof record.field === 'string' ? record.field : undefined;
    if (!message && !code) continue;
    out.push({ code, field, message: message || `护栏未通过（${code}）` });
  }
  return out;
}

/** impact 归一：缺字段时用本地估算兜底（后端旧版本没有 impact 时页面照样能看）。 */
export function normalizeImpact(input: unknown, fallback: InfraImpact): InfraImpact {
  const record = asRecord(input);
  if (!record) return fallback;
  const action =
    record.action === 'create' ||
    record.action === 'update' ||
    record.action === 'delete' ||
    record.action === 'noop'
      ? record.action
      : fallback.action;
  const restarts = typeof record.restarts === 'boolean' ? record.restarts : fallback.restarts;
  const downtimeSeconds =
    typeof record.downtimeSeconds === 'number' && Number.isFinite(record.downtimeSeconds)
      ? Math.max(0, Math.round(record.downtimeSeconds))
      : fallback.downtimeSeconds;
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : fallback.reasons;
  return { action, restarts, downtimeSeconds, reasons: reasons.length > 0 ? reasons : fallback.reasons };
}

/**
 * preview 响应归一。
 *
 * `allowed` **只认布尔 true**：后端漏字段 / 返回 `"false"` 字符串时一律按「不允许」处理 ——
 * 把「没拿到许可」当成「允许」是这一整块最危险的默认值。
 */
export function normalizeGuardResult(raw: unknown, fallbackImpact: InfraImpact): GuardResult {
  const record = asRecord(raw);
  if (!record) {
    return { allowed: false, violations: [], diff: '', impact: fallbackImpact };
  }
  return {
    allowed: record.allowed === true,
    violations: normalizeViolations(record.violations),
    diff: typeof record.diff === 'string' ? record.diff : '',
    impact: normalizeImpact(record.impact, fallbackImpact),
  };
}
