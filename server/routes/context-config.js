/**
 * context-config.js — 运维助手的上下文配置解析
 *
 * 背景：上下文预算原先**只能通过环境变量**（OPENLOG_ASSISTANT_CONTEXT_TOKENS）设定，
 * 且是模块加载时固化的一次性常量 —— 用户想调整必须改环境变量并重启容器，
 * 界面上既看不到「模型窗口」，也看不到「已经用了多少」。
 *
 * 现在改成三级优先级（高 → 低）：
 *   1. 会话级覆盖（前端齿轮面板，随请求传 contextOverride，不落库）
 *   2. 设置页全局配置（app_settings.assistantContext，持久化，重启不丢）
 *   3. 环境变量 / 代码默认值（兜底，保持向后兼容）
 *
 * 所有值都会被 clamp 到合法区间并返回 warnings，避免「预算 > 模型窗口」这种
 * 会让服务端把请求发出去然后被模型拒绝的配置。
 */

/** 各配置项的环境变量/代码默认值（同时作为兜底） */
export const CONTEXT_DEFAULTS = {
  /** 模型上下文窗口（token）。默认按团队在用的 Strata qwen 65536 */
  windowTokens: Number(process.env.OPENLOG_ASSISTANT_CONTEXT_WINDOW) || 65_536,
  /** 给 messages 用的上下文预算（token） */
  budgetTokens: Number(process.env.OPENLOG_ASSISTANT_CONTEXT_TOKENS) || 48_000,
  /** 单次回复的最大 token */
  maxOutputTokens: Number(process.env.OPENLOG_ASSISTANT_MAX_OUTPUT_TOKENS) || 4_096,
  /** 是否自动压缩历史 */
  autoCompact: true,
  /** 用量达到预算的该比例时压缩（0~1） */
  compactAt: 0.85,
  /** 用量达到该比例时提前提示用户 */
  warnAt: 0.7,
  maxRounds: Number(process.env.OPENLOG_ASSISTANT_MAX_ROUNDS) || 30,
  maxWallMs: Number(process.env.OPENLOG_ASSISTANT_MAX_WALL_MS) || 10 * 60 * 1000,
  toolResultChars: Number(process.env.OPENLOG_ASSISTANT_TOOL_RESULT_CHARS) || 6_000,
};

/** 合法区间（超出就夹紧并给 warning，不直接报错） */
export const CONTEXT_BOUNDS = {
  windowTokens: { min: 8_000, max: 1_048_576 },
  budgetTokens: { min: 4_000, max: 1_048_576 },
  maxOutputTokens: { min: 256, max: 65_536 },
  compactAt: { min: 0.3, max: 0.98 },
  warnAt: { min: 0.2, max: 0.98 },
  maxRounds: { min: 1, max: 200 },
  maxWallMs: { min: 30_000, max: 2 * 60 * 60 * 1000 },
  toolResultChars: { min: 500, max: 200_000 },
};

/** 哪些引擎支持流式 usage（stream_options.include_usage），用于把估算换成真实值 */
export const STREAM_USAGE_ENGINES = new Set(['openai', 'vllm', 'sglang', 'strata']);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pick(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return undefined;
}

/**
 * 把任意来源的配置夹紧成合法值。
 * @param {object} raw 合并后的原始值
 * @returns {{ config: object, warnings: string[] }}
 */
export function clampContextConfig(raw = {}) {
  const warnings = [];
  const cfg = {};

  const win = num(raw.windowTokens) ?? CONTEXT_DEFAULTS.windowTokens;
  cfg.windowTokens = Math.round(Math.min(
    CONTEXT_BOUNDS.windowTokens.max,
    Math.max(CONTEXT_BOUNDS.windowTokens.min, win),
  ));
  if (cfg.windowTokens !== Math.round(win)) {
    warnings.push(`模型窗口 ${win} 超出范围，已调整为 ${cfg.windowTokens}`);
  }

  const out = num(raw.maxOutputTokens) ?? CONTEXT_DEFAULTS.maxOutputTokens;
  cfg.maxOutputTokens = Math.round(Math.min(
    CONTEXT_BOUNDS.maxOutputTokens.max,
    Math.max(CONTEXT_BOUNDS.maxOutputTokens.min, out),
  ));

  const budgetRaw = num(raw.budgetTokens) ?? CONTEXT_DEFAULTS.budgetTokens;
  // 预算必须给「输出 + 系统提示」留出空间，否则请求会被模型直接拒绝
  const hardCeil = Math.max(CONTEXT_BOUNDS.budgetTokens.min, cfg.windowTokens - cfg.maxOutputTokens);
  cfg.budgetTokens = Math.round(Math.min(
    CONTEXT_BOUNDS.budgetTokens.max,
    hardCeil,
    Math.max(CONTEXT_BOUNDS.budgetTokens.min, budgetRaw),
  ));
  if (cfg.budgetTokens !== Math.round(budgetRaw)) {
    if (budgetRaw > hardCeil) {
      warnings.push(`上下文预算 ${budgetRaw} 超过了窗口可容纳上限，已压到 ${cfg.budgetTokens}（窗口 ${cfg.windowTokens} - 输出 ${cfg.maxOutputTokens}）`);
    } else {
      warnings.push(`上下文预算 ${budgetRaw} 超出范围，已调整为 ${cfg.budgetTokens}`);
    }
  }

  cfg.autoCompact = raw.autoCompact === undefined ? CONTEXT_DEFAULTS.autoCompact : Boolean(raw.autoCompact);

  const compactAt = num(raw.compactAt) ?? CONTEXT_DEFAULTS.compactAt;
  cfg.compactAt = Math.min(CONTEXT_BOUNDS.compactAt.max, Math.max(CONTEXT_BOUNDS.compactAt.min, compactAt));
  if (cfg.compactAt !== compactAt) warnings.push(`压缩阈值 ${compactAt} 超出范围，已调整为 ${cfg.compactAt}`);

  const warnAt = num(raw.warnAt) ?? CONTEXT_DEFAULTS.warnAt;
  cfg.warnAt = Math.min(CONTEXT_BOUNDS.warnAt.max, Math.max(CONTEXT_BOUNDS.warnAt.min, warnAt));
  // 预警必须早于压缩，否则用户永远看不到「该换会话了」
  if (cfg.warnAt >= cfg.compactAt) {
    cfg.warnAt = Math.max(CONTEXT_BOUNDS.warnAt.min, Math.min(cfg.compactAt - 0.05, 0.9));
    warnings.push(`预警阈值必须小于压缩阈值，已调整为 ${cfg.warnAt.toFixed(2)}`);
  }

  const rounds = num(raw.maxRounds) ?? CONTEXT_DEFAULTS.maxRounds;
  cfg.maxRounds = Math.round(Math.min(CONTEXT_BOUNDS.maxRounds.max, Math.max(CONTEXT_BOUNDS.maxRounds.min, rounds)));

  const wall = num(raw.maxWallMs) ?? CONTEXT_DEFAULTS.maxWallMs;
  cfg.maxWallMs = Math.round(Math.min(CONTEXT_BOUNDS.maxWallMs.max, Math.max(CONTEXT_BOUNDS.maxWallMs.min, wall)));

  const toolChars = num(raw.toolResultChars) ?? CONTEXT_DEFAULTS.toolResultChars;
  cfg.toolResultChars = Math.round(Math.min(
    CONTEXT_BOUNDS.toolResultChars.max,
    Math.max(CONTEXT_BOUNDS.toolResultChars.min, toolChars),
  ));

  // 派生的绝对值，方便前端直接展示，免得两边各算一遍算错
  cfg.compactAtTokens = Math.floor(cfg.budgetTokens * cfg.compactAt);
  cfg.warnAtTokens = Math.floor(cfg.budgetTokens * cfg.warnAt);

  return { config: cfg, warnings };
}

/**
 * 解析当前生效的上下文配置。
 *
 * @param {object} settings 全局设置（app_settings）
 * @param {object} [override] 会话级覆盖（来自前端齿轮面板）
 * @returns {{ config: object, warnings: string[], sources: object }}
 */
export function resolveContextConfig(settings = {}, override = {}) {
  const globalCfg = (settings && typeof settings.assistantContext === 'object' && settings.assistantContext) || {};
  const sessionCfg = (override && typeof override === 'object' && override) || {};

  const merged = {
    windowTokens: pick(num(sessionCfg.windowTokens), num(globalCfg.windowTokens), CONTEXT_DEFAULTS.windowTokens),
    budgetTokens: pick(num(sessionCfg.budgetTokens), num(globalCfg.budgetTokens), CONTEXT_DEFAULTS.budgetTokens),
    maxOutputTokens: pick(num(sessionCfg.maxOutputTokens), num(globalCfg.maxOutputTokens), CONTEXT_DEFAULTS.maxOutputTokens),
    autoCompact: pick(sessionCfg.autoCompact, globalCfg.autoCompact, CONTEXT_DEFAULTS.autoCompact),
    compactAt: pick(num(sessionCfg.compactAt), num(globalCfg.compactAt), CONTEXT_DEFAULTS.compactAt),
    warnAt: pick(num(sessionCfg.warnAt), num(globalCfg.warnAt), CONTEXT_DEFAULTS.warnAt),
    maxRounds: pick(num(sessionCfg.maxRounds), num(globalCfg.maxRounds), CONTEXT_DEFAULTS.maxRounds),
    maxWallMs: pick(num(sessionCfg.maxWallMs), num(globalCfg.maxWallMs), CONTEXT_DEFAULTS.maxWallMs),
    toolResultChars: pick(num(sessionCfg.toolResultChars), num(globalCfg.toolResultChars), CONTEXT_DEFAULTS.toolResultChars),
  };

  const { config, warnings } = clampContextConfig(merged);

  // 说明每一项来自哪一层，前端可以据此标注「会话覆盖」/「全局」/「默认」
  const sources = {};
  for (const key of Object.keys(CONTEXT_DEFAULTS)) {
    sources[key] = num(sessionCfg[key]) !== undefined || (key in sessionCfg)
      ? 'session'
      : (globalCfg && (num(globalCfg[key]) !== undefined || key in globalCfg) ? 'settings' : 'default');
  }

  return { config, warnings, sources };
}

/** 只保留可持久化到设置页的字段（去掉派生值） */
export function pickPersistableConfig(config = {}) {
  const out = {};
  for (const key of Object.keys(CONTEXT_DEFAULTS)) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  return out;
}
