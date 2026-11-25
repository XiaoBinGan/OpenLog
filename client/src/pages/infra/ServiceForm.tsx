/**
 * 模型服务定义表单。
 *
 * 设计上的三条硬约定：
 *
 * 1. **提交只生成预览，不直接 apply**。按钮写「生成变更预览」，调用方拿到
 *    ModelService 后去打 A2 的 `preview` 接口，diff / 护栏 / impact 都在下一步
 *    由用户确认。契约铁律 3：一切变更 = 计划 → diff → 干跑 → 执行 → 校验 → 可回滚，
 *    表单这一层不允许有「点了直接改」的路径。
 *
 * 2. **校验与后端同一套规则**（DNS-1123、memoryMiB 0–65536、cores 0–100、
 *    replicas 1–8、命名空间白名单）。前端放宽 = 让用户填完再被后端拒，纯浪费一次
 *    往返；前端收紧 = 用户明明合规却被拦住。规则集中在 `types.ts#validateDraft`，
 *    这里只负责「什么时候显示」：字段被碰过、或用户点过一次提交。
 *
 * 3. **诚实提示不可省略**。改动配额（显存/算力/副本/加速卡）必然重建 Pod，
 *    单副本约 30 秒不可用。这句话必须在**点提交之前**以琥珀色出现在表单里，
 *    而不是藏在 diff 的 impact 字段里等用户自己找。判断在本地做
 *    （`estimateImpact`），不依赖后端往返。
 *
 * 组件本身不持有「提交中 / 出错」的状态：这些来自调用方（InfraPanel），
 * 表单只在 `submitting` 时禁用按钮、在 `error` 时显示错误条。
 */

import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ClipboardCheck, Loader, TriangleAlert } from 'lucide-react';
import {
  ENGINE_OPTIONS,
  INFRA_LIMITS,
  INFRA_NAMESPACES,
  MODEL_SOURCE_OPTIONS,
  defaultImageFor,
  diffServiceFields,
  draftFromService,
  emptyDraft,
  quotaChanges,
  serviceFromDraft,
  validateDraft,
} from './types';
import type {
  EngineKind,
  ModelService,
  ModelSourceKind,
  ServiceDraft,
  DraftErrors,
} from './types';

export interface ServiceFormProps {
  /**
   * 编辑已有服务时传入；新建传 null / 省略。
   *
   * 注意：调用方应给本组件一个随服务变化的 `key`（`${id}:${version}`），
   * 让切换服务时组件重建 —— 否则草稿会串味（在 A 服务的表单里改了几个字段，
   * 点回 B 服务看到的还是 A 的草稿）。
   */
  initial?: ModelService | null;
  /** 预览请求进行中：禁用提交按钮，避免连点打出一堆 diff。 */
  submitting?: boolean;
  /** 预览请求失败的消息（由调用方从 ApiError 里取）。 */
  error?: string | null;
  /** 演示模式：提交仍然可用（本地生成 fake diff），但会明确标出来。 */
  demo?: boolean;
  /** 校验通过后把服务定义交出去，由调用方请求 preview。 */
  onPreview: (service: ModelService) => void;
  /** 取消编辑（返回列表）。 */
  onCancel?: () => void;
}

/** 输入框基础样式（与 k8s 页面的控件同一套视觉语言）。 */
const INPUT_CLASS =
  'w-full rounded-lg border border-dark-700/70 bg-dark-900/60 px-2.5 py-1.5 text-sm text-dark-100 ' +
  'placeholder:text-dark-600 focus:border-accent-500/60 focus:outline-none transition-colors';

/** 出错时的输入框样式：红边，和字段下方的红字成对出现。 */
const INPUT_ERROR_CLASS = 'border-red-500/60 focus:border-red-500/80';

interface FieldProps {
  /** 与 ServiceDraft 的键一致，用于 data-field / data-testid 定位。 */
  field: string;
  label: string;
  /** 没有错误时显示的灰色说明（有错误就让位给红字）。 */
  hint?: string;
  error?: string;
  children: ReactNode;
}

/** 单个字段的骨架：标签 + 控件 + 错误/说明。 */
function Field({ field, label, hint, error, children }: FieldProps) {
  return (
    <div data-field={field}>
      <label htmlFor={`infra-${field}`} className="mb-1 block text-xs text-dark-400">
        {label}
      </label>
      {children}
      {error ? (
        <p data-testid={`infra-error-${field}`} className="mt-1 text-[11px] leading-relaxed text-red-300">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-[11px] leading-relaxed text-dark-600">{hint}</p>
      ) : null}
    </div>
  );
}

/** 数字输入框的公共属性（step=1 让浏览器的上下键按整数走）。 */
const NUMBER_ATTRS = { type: 'number', step: 1, inputMode: 'numeric' } as const;

/**
 * 模型服务表单。
 *
 * 字段与 `ServiceDraft` 一一对应；数字字段在草稿里存字符串，校验时再解释成数字，
 * 这样「用户正在输入的中间态」（空串、`-`、`10.5`）不会把输入框洗成 NaN。
 */
export default function ServiceForm({
  initial = null,
  submitting = false,
  error = null,
  demo = false,
  onPreview,
  onCancel,
}: ServiceFormProps) {
  const [draft, setDraft] = useState<ServiceDraft>(() =>
    initial ? draftFromService(initial) : emptyDraft(),
  );
  /** 哪些字段被用户碰过（碰过就实时显示该校验结果）。 */
  const [touched, setTouched] = useState<Partial<Record<keyof ServiceDraft, boolean>>>({});
  /** 用户点过一次提交：此后所有字段的错误都摊开（包括从没碰过的必填项）。 */
  const [attempted, setAttempted] = useState(false);

  const errors: DraftErrors = useMemo(() => validateDraft(draft), [draft]);

  /** 错误显示时机：碰过、或已尝试提交。 */
  const errorOf = (field: keyof ServiceDraft): string | undefined =>
    attempted || touched[field] ? errors[field] : undefined;

  /** 通用更新：标脏 + 写值（不在这里做校验，校验是纯函数，渲染时算）。 */
  const update = <K extends keyof ServiceDraft>(field: K, value: ServiceDraft[K]) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setTouched((prev) => ({ ...prev, [field]: true }));
  };

  /** 切引擎时，如果镜像还停在旧引擎的默认值（或为空），就跟着换成新默认值。 */
  const onEngineChange = (next: EngineKind) => {
    setDraft((prev) => {
      const untouchedImage =
        !prev.image.trim() || prev.image === defaultImageFor(prev.engine);
      return {
        ...prev,
        engine: next,
        image: untouchedImage ? defaultImageFor(next) : prev.image,
      };
    });
    setTouched((prev) => ({ ...prev, engine: true }));
  };

  /** 当前草稿对应的服务定义（可能不合法，但永远是「没有 NaN 的形状」）。 */
  const candidate = useMemo(() => serviceFromDraft(draft, initial), [draft, initial]);
  const baseline = initial ?? null;

  const changes = useMemo(() => diffServiceFields(baseline, candidate), [baseline, candidate]);
  const quotaDelta = useMemo(() => quotaChanges(changes), [changes]);
  /**
   * 非配额、但同样会重建 Pod 的改动（镜像 / 模型路径 / 端口 / 健康检查）。
   * 这类改动的中断提示弱一档，但同样要在提交前出现。
   */
  const restartDelta = useMemo(
    () => changes.filter((change) => change.restarts && !change.quota),
    [changes],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    onPreview(candidate);
  };

  const replicas = Number(draft.replicas) || 0;
  const worstCase =
    replicas > 0 ? INFRA_LIMITS.podRestartSeconds * Math.min(replicas, INFRA_LIMITS.replicasMax) : 0;

  return (
    <form
      data-testid="infra-service-form"
      data-mode={initial ? 'edit' : 'create'}
      onSubmit={handleSubmit}
      className="space-y-3"
      noValidate
    >
      {error && (
        <div
          data-testid="infra-form-error"
          className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />
          <div className="min-w-0 flex-1 text-xs text-red-300 break-words">
            预览生成失败：{error}
          </div>
        </div>
      )}

      {demo && (
        <p
          data-testid="infra-form-demo"
          className="rounded-lg border border-accent-500/30 bg-accent-500/10 px-3 py-1.5 text-[11px] text-accent-200"
        >
          演示模式：表单可以填、预览是本地生成的假 diff，不会下发给集群
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field
          field="name"
          label="名称"
          error={errorOf('name')}
          hint="DNS-1123：小写字母/数字/连字符"
        >
          <input
            id="infra-name"
            data-testid="infra-field-name"
            className={`${INPUT_CLASS} ${errorOf('name') ? INPUT_ERROR_CLASS : ''}`}
            value={draft.name}
            onChange={(event) => update('name', event.target.value)}
            placeholder="qwen-72b"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field field="namespace" label="命名空间" error={errorOf('namespace')} hint="只允许白名单内的命名空间">
          <select
            id="infra-namespace"
            data-testid="infra-field-namespace"
            className={`${INPUT_CLASS} ${errorOf('namespace') ? INPUT_ERROR_CLASS : ''}`}
            value={draft.namespace}
            onChange={(event) => update('namespace', event.target.value)}
          >
            {/* 只给白名单两项：其它命名空间（kube-system / default）在契约里是硬禁忌，
                这里连选项都不提供，而不是让人选了再报错 */}
            {INFRA_NAMESPACES.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        </Field>

        <Field field="source" label="模型来源" error={errorOf('source')}>
          <select
            id="infra-source"
            data-testid="infra-field-source"
            className={INPUT_CLASS}
            value={draft.source}
            onChange={(event) => update('source', event.target.value as ModelSourceKind)}
          >
            {MODEL_SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field field="modelPath" label="模型路径 / 仓库 id" error={errorOf('modelPath')}>
          <input
            id="infra-modelPath"
            data-testid="infra-field-modelPath"
            className={`${INPUT_CLASS} ${errorOf('modelPath') ? INPUT_ERROR_CLASS : ''}`}
            value={draft.modelPath}
            onChange={(event) => update('modelPath', event.target.value)}
            placeholder={
              MODEL_SOURCE_OPTIONS.find((option) => option.value === draft.source)?.placeholder ??
              ''
            }
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field field="quantization" label="量化" hint="留空 = 引擎按权重自行推断">
          <input
            id="infra-quantization"
            data-testid="infra-field-quantization"
            className={INPUT_CLASS}
            value={draft.quantization}
            onChange={(event) => update('quantization', event.target.value)}
            placeholder="awq / fp16 / Q2_0"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field
          field="contextLength"
          label="上下文长度（token）"
          error={errorOf('contextLength')}
          hint="留空 = 用引擎默认"
        >
          <input
            id="infra-contextLength"
            data-testid="infra-field-contextLength"
            className={`${INPUT_CLASS} ${errorOf('contextLength') ? INPUT_ERROR_CLASS : ''}`}
            {...NUMBER_ATTRS}
            value={draft.contextLength}
            onChange={(event) => update('contextLength', event.target.value)}
            placeholder="32768"
          />
        </Field>

        <Field field="engine" label="引擎类型">
          <select
            id="infra-engine"
            data-testid="infra-field-engine"
            className={INPUT_CLASS}
            value={draft.engine}
            onChange={(event) => onEngineChange(event.target.value as EngineKind)}
          >
            {ENGINE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field field="image" label="引擎镜像" error={errorOf('image')} hint="带 tag，别用 latest 上生产">
          <input
            id="infra-image"
            data-testid="infra-field-image"
            className={`${INPUT_CLASS} ${errorOf('image') ? INPUT_ERROR_CLASS : ''}`}
            value={draft.image}
            onChange={(event) => update('image', event.target.value)}
            placeholder="vllm/vllm-openai:v0.6.3"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field field="accelerators" label="加速卡数（每副本）" error={errorOf('accelerators')}>
          <input
            id="infra-accelerators"
            data-testid="infra-field-accelerators"
            className={`${INPUT_CLASS} ${errorOf('accelerators') ? INPUT_ERROR_CLASS : ''}`}
            {...NUMBER_ATTRS}
            min={0}
            max={INFRA_LIMITS.acceleratorsMax}
            value={draft.accelerators}
            onChange={(event) => update('accelerators', event.target.value)}
          />
        </Field>

        <Field
          field="memoryMiB"
          label="显存配额（MiB / 每副本，0 = 不限制）"
          error={errorOf('memoryMiB')}
        >
          <input
            id="infra-memoryMiB"
            data-testid="infra-field-memoryMiB"
            className={`${INPUT_CLASS} ${errorOf('memoryMiB') ? INPUT_ERROR_CLASS : ''}`}
            {...NUMBER_ATTRS}
            min={0}
            max={INFRA_LIMITS.memoryMiBMax}
            value={draft.memoryMiB}
            onChange={(event) => update('memoryMiB', event.target.value)}
          />
        </Field>

        <Field field="coresPercent" label="算力配额（%，0 = 不限制）" error={errorOf('coresPercent')}>
          <input
            id="infra-coresPercent"
            data-testid="infra-field-coresPercent"
            className={`${INPUT_CLASS} ${errorOf('coresPercent') ? INPUT_ERROR_CLASS : ''}`}
            {...NUMBER_ATTRS}
            min={0}
            max={INFRA_LIMITS.coresPercentMax}
            value={draft.coresPercent}
            onChange={(event) => update('coresPercent', event.target.value)}
          />
        </Field>

        <Field field="replicas" label="副本数" error={errorOf('replicas')}>
          <input
            id="infra-replicas"
            data-testid="infra-field-replicas"
            className={`${INPUT_CLASS} ${errorOf('replicas') ? INPUT_ERROR_CLASS : ''}`}
            {...NUMBER_ATTRS}
            min={1}
            max={INFRA_LIMITS.replicasMax}
            value={draft.replicas}
            onChange={(event) => update('replicas', event.target.value)}
          />
        </Field>

        <Field field="acceleratorModel" label="节点型号亲和" hint="留空 = 不限型号，由调度器挑卡">
          <input
            id="infra-acceleratorModel"
            data-testid="infra-field-acceleratorModel"
            className={INPUT_CLASS}
            value={draft.acceleratorModel}
            onChange={(event) => update('acceleratorModel', event.target.value)}
            placeholder="NVIDIA GeForce RTX 4090"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field field="containerPort" label="容器端口" error={errorOf('containerPort')}>
          <input
            id="infra-containerPort"
            data-testid="infra-field-containerPort"
            className={`${INPUT_CLASS} ${errorOf('containerPort') ? INPUT_ERROR_CLASS : ''}`}
            {...NUMBER_ATTRS}
            min={1}
            max={INFRA_LIMITS.portMax}
            value={draft.containerPort}
            onChange={(event) => update('containerPort', event.target.value)}
          />
        </Field>

        <Field field="healthPath" label="健康检查路径" error={errorOf('healthPath')}>
          <input
            id="infra-healthPath"
            data-testid="infra-field-healthPath"
            className={`${INPUT_CLASS} ${errorOf('healthPath') ? INPUT_ERROR_CLASS : ''}`}
            value={draft.healthPath}
            onChange={(event) => update('healthPath', event.target.value)}
            placeholder="/health"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="rounded-lg border border-dark-700/50 bg-dark-900/40 px-3 py-2.5">
        <label className="flex items-center gap-2 text-xs text-dark-300">
          <input
            id="infra-exposeGateway"
            data-testid="infra-field-exposeGateway"
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-dark-600 bg-dark-900 text-accent-500 focus:ring-accent-500/40"
            checked={draft.exposeGateway}
            onChange={(event) => update('exposeGateway', event.target.checked)}
          />
          暴露网关端口（自动注册 nginx stream 转发）
        </label>
        {draft.exposeGateway && (
          <div className="mt-2 max-w-xs">
            <Field field="gatewayPort" label="网关端口" error={errorOf('gatewayPort')} hint="留空 = 由服务端分配">
              <input
                id="infra-gatewayPort"
                data-testid="infra-field-gatewayPort"
                className={`${INPUT_CLASS} ${errorOf('gatewayPort') ? INPUT_ERROR_CLASS : ''}`}
                {...NUMBER_ATTRS}
                min={1}
                max={INFRA_LIMITS.portMax}
                value={draft.gatewayPort}
                onChange={(event) => update('gatewayPort', event.target.value)}
                placeholder="8001"
              />
            </Field>
          </div>
        )}
      </div>

      {/* 诚实提示：配额变化必然重建 Pod。放在提交按钮上方，不藏在任何折叠区里。 */}
      {quotaDelta.length > 0 && (
        <div
          data-testid="infra-impact-hint"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2"
        >
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
            <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0" />
            改变配额会重建 Pod：单副本 ≈ {INFRA_LIMITS.podRestartSeconds} 秒中断
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
            {quotaDelta.map((change) => `${change.label} ${change.before} → ${change.after}`).join(' · ')}
            {worstCase > 0 ? ` · 按 ${replicas} 副本最坏 ≈ ${worstCase} 秒` : ''}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-amber-200/60">
            重建期间该服务不可用；多副本滚动更新可以缩短，但 readiness 没配好时仍会掉容量。
          </p>
        </div>
      )}

      {restartDelta.length > 0 && (
        <div
          data-testid="infra-restart-hint"
          className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/80"
        >
          {restartDelta.map((change) => change.label).join(' / ')} 变化会重建 Pod（单副本 ≈{' '}
          {INFRA_LIMITS.podRestartSeconds} 秒中断）
        </div>
      )}

      {/* 没改动时也说清楚：避免用户以为点一下会有什么动作 */}
      {baseline && changes.length === 0 && (
        <p data-testid="infra-noop-hint" className="text-[11px] text-dark-500">
          与当前定义一致，执行不会改动集群。
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          data-testid="infra-submit"
          disabled={submitting}
          className="flex items-center gap-1.5 rounded-lg bg-accent-500/20 px-3 py-1.5 text-xs font-medium text-accent-200 transition-colors hover:bg-accent-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Loader className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ClipboardCheck className="h-3.5 w-3.5" />
          )}
          生成变更预览
        </button>
        {onCancel && (
          <button
            type="button"
            data-testid="infra-cancel"
            onClick={onCancel}
            className="rounded-lg bg-dark-800/60 px-3 py-1.5 text-xs text-dark-300 transition-colors hover:bg-dark-700/60"
          >
            返回列表
          </button>
        )}
        <span className="ml-auto text-[11px] text-dark-600">
          {baseline ? `当前版本 v${baseline.version}` : '新建'}
        </span>
      </div>
    </form>
  );
}
