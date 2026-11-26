/**
 * 模型规格解析 —— 从 GGUF 头部 / HuggingFace config.json 读出**真实**的 KV cache 参数。
 *
 * 为什么要它（实测数据说话）：
 *   `footprint.js` 里 KV 用的是"按参数量档位查经验表"（30B 级 ≈ 256 KiB/token）。
 *   拿真机的 strata 模型（Qwen3.8-Flash-Next，GGUF 元数据）对账，误差是 **80 倍**：
 *     经验值    256 KiB/token × 32768 = 8 GiB
 *     真算      12 层全注意力 × 2 KV头 × (256+256) B × int8 ÷ 压缩4 ≈ 3 KiB/token
 *               → 32768 × 3 KiB ≈ 96 MiB
 *   原因是三条都被经验表忽略了：
 *     ① 混合架构：48 层里只有 12 层是全注意力，其余是 SSM/线性层（KV 不随 token 增长）
 *     ② GQA/MQA：KV 头数（2）远小于注意力头数（24）
 *     ③ KV 精度：int8 / fp8 只有 fp16 的一半或更低
 *
 * 另一个必须处理的现实：MoE 卸载引擎（strata 的 --expert-cache、llama.cpp 的 mmap）
 * 权重**不全驻显存**。strata 那个 63GB 文件只占 14 GiB 显存。所以"权重=文件大小"对它们不成立，
 * 这种情况必须显式告警，让用户知道估算用的是哪种口径。
 *
 * 设计约束：
 *   · 纯函数，不碰文件系统 —— 读文件由调用方（路由层通过 SSH）把字节喂进来
 *   · 解析失败一律返回 { ok:false, reason }，绝不抛
 *   · 只读文件头部（GGUF 通常 <256KB 就能读完元数据），不需要读几十 GB
 */

/** GGUF 值类型 → 字节序 + 宽度（t=9 是数组，单独处理） */
/** GGUF 标量类型 → Buffer 读取方法名（与 GGUF_SCALAR 的 fmt 对应） */
const GGUF_READERS = {
  0: 'readUInt8',
  1: 'readInt8',
  2: 'readUInt16LE',
  3: 'readInt16LE',
  4: 'readUInt32LE',
  5: 'readInt32LE',
  6: 'readFloatLE',
  7: 'readUInt8',
  10: 'readBigUInt64LE',
  11: 'readBigInt64LE',
  12: 'readDoubleLE',
};

const GGUF_SCALAR = {
  0: { fmt: '<B', size: 1 },   // uint8
  1: { fmt: '<b', size: 1 },   // int8
  2: { fmt: '<H', size: 2 },   // uint16
  3: { fmt: '<h', size: 2 },   // int16
  4: { fmt: '<I', size: 4 },   // uint32
  5: { fmt: '<i', size: 4 },   // int32
  6: { fmt: '<f', size: 4 },   // float32
  7: { fmt: '<B', size: 1 },   // bool
  10: { fmt: '<Q', size: 8 },  // uint64
  11: { fmt: '<q', size: 8 },  // int64
  12: { fmt: '<d', size: 8 },  // float64
};

/** 每元素字节数（KV cache 用；按 kv 精度名） */
export const KV_DTYPE_BYTES = Object.freeze({
  fp32: 4,
  fp16: 2,
  bf16: 2,
  fp8: 1,
  int8: 1,
  q8_0: 1,
  q4_0: 0.5,
});

/**
 * 把 `--kv int8` / `kv_cache_dtype=fp8` / `q8_0` 之类的写法归一到字节数。
 * 认不出返回 null（调用方据此判定"精度未知"）。
 */
export function kvDtypeToBytes(dtype) {
  if (typeof dtype !== 'string' || !dtype.trim()) return null;
  const key = dtype.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KV_DTYPE_BYTES, key)) return KV_DTYPE_BYTES[key];
  if (key.includes('fp8') || key.includes('e4m3') || key.includes('e5m2')) return 1;
  if (key.includes('int8')) return 1;
  if (key.includes('bf16') || key.includes('fp16') || key.includes('float16')) return 2;
  if (key.includes('fp32') || key.includes('float32')) return 4;
  return null;
}

/**
 * 从引擎启动参数里取 KV cache 精度（vLLM: --kv-cache-dtype；llama.cpp/strata: --kv）。
 * 默认 fp16（绝大多数引擎不指定就是这个）。
 */
export function kvDtypeFromArgs(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    for (const flag of ['--kv-cache-dtype', '--kv_cache_dtype', '--kv', '--cache-type-k', '-ctk']) {
      if (a === flag) return { dtype: list[i + 1] || null, source: flag };
      if (a.startsWith(`${flag}=`)) return { dtype: a.slice(flag.length + 1) || null, source: flag };
    }
  }
  return { dtype: null, source: null };
}

/* ────────────────────────── GGUF ────────────────────────── */

/**
 * 解析 GGUF 头部元数据。只需要文件前若干 KB（元数据在张量之前）。
 *
 * @param {Buffer|Uint8Array} buffer 文件开头若干字节（建议 ≥256KB，超大词表可能要更多）
 * @returns {{ok:true, version:number, tensors:number, meta:Record<string,unknown>} | {ok:false, reason:string}}
 */
export function parseGgufHeader(buffer) {
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    // 先判魔数再判长度：20 字节的垃圾数据应该报"不是 GGUF"，而不是"缓冲太小"
    if (buf.toString('latin1', 0, 4) !== 'GGUF') {
      return { ok: false, reason: `不是 GGUF 文件（魔数 ${JSON.stringify(buf.toString('latin1', 0, 4))}）` };
    }
    if (buf.length < 24) return { ok: false, reason: '缓冲太小，读不到 GGUF 头部（至少要 24 字节）' };
    const version = buf.readUInt32LE(4);
    let offset = 8;
    let tensorCount;
    let kvCount;
    if (version === 1) {
      tensorCount = buf.readUInt32LE(offset); offset += 4;
      kvCount = buf.readUInt32LE(offset); offset += 4;
    } else {
      tensorCount = Number(buf.readBigUInt64LE(offset)); offset += 8;
      kvCount = Number(buf.readBigUInt64LE(offset)); offset += 8;
    }
    if (kvCount > 100000) {
      return { ok: false, reason: `GGUF 元数据条数异常多（${kvCount}），可能不是标准 GGUF 或缓冲不足` };
    }

    const meta = {};
    const need = () => {
      if (offset > buf.length) throw new Error('缓冲不足：元数据超过已读字节（可加大读取长度）');
    };
    const readString = () => {
      need();
      const len = Number(buf.readBigUInt64LE(offset)); offset += 8;
      need();
      const s = buf.toString('utf8', offset, offset + len);
      offset += len;
      return s;
    };
    const readValue = (type) => {
      if (type === 8) return readString();
      if (type === 9) {
        need();
        const elemType = buf.readUInt32LE(offset); offset += 4;
        need();
        const count = Number(buf.readBigUInt64LE(offset)); offset += 8;
        const out = [];
        // 关键：必须**完整消费** count 个元素，否则后续 key 全会错位
        // （这里曾错误地只读前 N 个，导致 "bad type" 崩掉）
        for (let i = 0; i < count; i += 1) out.push(readValue(elemType));
        return out;
      }
      const spec = GGUF_SCALAR[type];
      if (!spec) throw new Error(`未知的 GGUF 值类型 ${type}`);
      need();
      // 显式方法表：嵌套模板 + 对象字面量取索引这种写法解析器容易choke，也不好看
      const reader = GGUF_READERS[type];
      if (!reader) throw new Error(`未知的 GGUF 值类型 ${type}`);
      const raw = buf[reader](offset);
      const v = type === 7 ? raw !== 0 : raw;
      offset += spec.size;
      return typeof v === 'bigint' ? Number(v) : v;
    };

    for (let i = 0; i < kvCount; i += 1) {
      const key = readString();
      need();
      const type = buf.readUInt32LE(offset); offset += 4;
      meta[key] = readValue(type);
    }
    return { ok: true, version, tensors: tensorCount, meta };
  } catch (err) {
    return { ok: false, reason: `GGUF 解析失败：${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * 把 GGUF meta 归一成统一的模型规格。
 *
 * 支持两种架构族：
 *   · 常规 Transformer（`<arch>.attention.head_count` / `head_count_kv` / `block_count`）
 *   · 混合 SSM（Qwen3-Next / qwen4exp 那类：`full_attention_interval` 表示每 N 层才有一个全注意力层）
 */
export function specFromGgufMeta(meta) {
  if (!meta || typeof meta !== 'object') return { ok: false, reason: 'meta 为空' };
  const arch = typeof meta['general.architecture'] === 'string' ? meta['general.architecture'] : null;
  if (!arch) return { ok: false, reason: 'GGUF 缺少 general.architecture' };
  const pick = (suffix) => meta[`${arch}.${suffix}`];

  const layerCount = Number(pick('block_count'));
  const headCount = Number(pick('attention.head_count'));
  const kvHeadCount = Number(pick('attention.head_count_kv'));
  const keyLength = Number(pick('attention.key_length'));
  const valueLength = Number(pick('attention.value_length'));
  const embedLength = Number(pick('embedding_length'));
  const contextLength = Number(pick('context_length'));

  if (!Number.isFinite(layerCount) || layerCount <= 0) {
    return { ok: false, reason: `GGUF 缺少 ${arch}.block_count（层数）` };
  }
  if (!Number.isFinite(kvHeadCount) || kvHeadCount <= 0) {
    return { ok: false, reason: `GGUF 缺少 ${arch}.attention.head_count_kv（KV 头数）` };
  }
  // head_dim：优先 key_length；否则 embedding/head_count
  let headDim = Number.isFinite(keyLength) && keyLength > 0 ? keyLength : null;
  if (!headDim && Number.isFinite(embedLength) && Number.isFinite(headCount) && headCount > 0) {
    headDim = Math.round(embedLength / headCount);
  }
  if (!headDim) {
    return { ok: false, reason: `GGUF 缺少 ${arch}.attention.key_length 与 embedding_length，无法确定 head_dim` };
  }
  const vDim = Number.isFinite(valueLength) && valueLength > 0 ? valueLength : headDim;

  // 混合架构：每 full_attention_interval 层才有一个全注意力层
  const interval = Number(pick('full_attention_interval'));
  const fullAttentionLayers = Number.isFinite(interval) && interval > 1
    ? Math.ceil(layerCount / interval)
    : layerCount;
  const linearLayers = layerCount - fullAttentionLayers;

  // KV 压缩比（部分架构对全注意力层再做压缩，如 qwen4exp 的 compress_ratios）
  const compressRatios = pick('attention.compress_ratios');
  let avgCompress = 1;
  if (Array.isArray(compressRatios) && compressRatios.length > 0) {
    const ratios = compressRatios.map((x) => (Number(x) > 1 ? Number(x) : 1));
    avgCompress = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }

  return {
    ok: true,
    source: 'gguf',
    arch,
    name: typeof meta['general.name'] === 'string' ? meta['general.name'] : null,
    sizeLabel: typeof meta['general.size_label'] === 'string' ? meta['general.size_label'] : null,
    layerCount,
    headCount: Number.isFinite(headCount) ? headCount : null,
    kvHeadCount,
    headDim,
    valueDim: vDim,
    contextLength: Number.isFinite(contextLength) && contextLength > 0 ? contextLength : null,
    fullAttentionLayers,
    linearLayers,
    fullAttentionInterval: Number.isFinite(interval) && interval > 1 ? interval : 1,
    avgCompressRatio: Math.round(avgCompress * 100) / 100,
    expertCount: Number.isFinite(Number(pick('expert_count'))) ? Number(pick('expert_count')) : null,
    expertUsed: Number.isFinite(Number(pick('expert_used_count'))) ? Number(pick('expert_used_count')) : null,
    notes: linearLayers > 0
      ? [`混合架构：${layerCount} 层里 ${fullAttentionLayers} 层全注意力 + ${linearLayers} 层线性/SSM（后者 KV 不随 token 增长）`]
      : [],
  };
}

/* ────────────────────────── HuggingFace config.json ────────────────────────── */

/**
 * 从 HF config.json 归一模特规格。
 *
 * 认的字段（各家命名不一，按优先级取）：
 *   层数      num_hidden_layers / n_layer / num_layers / text_config.num_hidden_layers
 *   KV 头数   num_key_value_heads / n_head_kv / multi_query_group_num；缺省 = num_attention_heads（MHA）
 *   head_dim  head_dim / hidden_size ÷ num_attention_heads / text_config.*
 */
export function specFromHfConfig(config) {
  if (!config || typeof config !== 'object') return { ok: false, reason: 'config 为空' };
  // 多模态模型把语言塔放在 text_config 里
  const t = (config.text_config && typeof config.text_config === 'object') ? config.text_config : config;
  const num = (...keys) => {
    for (const k of keys) {
      const v = t[k] ?? config[k];
      if (Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
    }
    return null;
  };

  const layerCount = num('num_hidden_layers', 'n_layer', 'num_layers', 'num_transformer_layers');
  if (!layerCount) return { ok: false, reason: 'config.json 缺少层数（num_hidden_layers / n_layer）' };
  const headCount = num('num_attention_heads', 'n_head', 'n_heads');
  const kvHeadCount = num('num_key_value_heads', 'n_head_kv', 'multi_query_group_num') ?? headCount;
  const hidden = num('hidden_size', 'n_embd', 'd_model');
  let headDim = num('head_dim', 'kv_channels', 'attention_head_size');
  if (!headDim && hidden && headCount) headDim = Math.round(hidden / headCount);
  if (!headDim) return { ok: false, reason: 'config.json 缺 head_dim 且无法由 hidden_size ÷ heads 推出' };

  const contextLength = num('max_position_embeddings', 'max_sequence_length', 'n_positions', 'seq_length');
  const expertCount = num('num_experts', 'num_local_experts', 'n_routed_experts', 'moe_num_experts');
  const expertUsed = num('num_experts_per_tok', 'moe_topk', 'num_selected_experts');

  // 混合架构（Qwen3-Next 那类）：layer_types 标明每层是 full_attention 还是 linear_attention
  const layerTypes = t.layer_types || config.layer_types;
  let fullAttentionLayers = layerCount;
  let linearLayers = 0;
  if (Array.isArray(layerTypes) && layerTypes.length === layerCount) {
    fullAttentionLayers = layerTypes.filter((x) => String(x).includes('full')).length;
    linearLayers = layerCount - fullAttentionLayers;
  }

  return {
    ok: true,
    source: 'hf-config',
    arch: typeof config.model_type === 'string' ? config.model_type : null,
    name: typeof config._name_or_path === 'string' ? config._name_or_path : null,
    sizeLabel: null,
    layerCount,
    headCount,
    kvHeadCount: kvHeadCount ?? null,
    headDim,
    valueDim: headDim,
    contextLength,
    fullAttentionLayers,
    linearLayers,
    fullAttentionInterval: linearLayers > 0 && fullAttentionLayers > 0
      ? Math.round(layerCount / fullAttentionLayers)
      : 1,
    avgCompressRatio: 1,
    expertCount,
    expertUsed,
    notes: linearLayers > 0
      ? [`混合架构：${fullAttentionLayers} 层全注意力 + ${linearLayers} 层线性注意力`]
      : [],
  };
}


/* ────────────────────────── 真机读取（注入 exec，不直接碰 SSH） ────────────────────────── */

/** 判定一个模型路径该按哪种方式读元数据 */
export function detectSpecKind(path) {
  const p = String(path || '').trim();
  if (!p) return { kind: 'unknown', reason: '路径为空' };
  if (/\.gguf$/i.test(p)) return { kind: 'gguf', reason: '单个 GGUF 文件' };
  if (/\.(safetensors|bin|pt)$/i.test(p)) return { kind: 'hf-dir', reason: '权重目录（需要读同目录 config.json）' };
  return { kind: 'hf-dir', reason: '按 HF 目录处理（读 config.json）' };
}

/**
 * 通过注入的 `exec(cmd)` 读模型规格。
 *
 * 为什么只读头部：GGUF 元数据在所有张量之前，通常 <256KB 就能读完；
 * 读几十 GB 文件的头部代价可以忽略（`head -c` 会在读满后立即关闭管道）。
 *
 * @param {object} input
 * @param {string} input.path            模型路径（GGUF 文件 或 HF 目录 或 目录下的 gguf）
 * @param {(cmd:string)=>Promise<{stdout?:string}>} input.exec  在目标机器上执行命令
 * @returns {Promise<{ok:true, spec:object, kind:string, bytesRead:number} | {ok:false, reason:string}>}
 */
export async function readModelSpec({ path, exec, headBytes = 4 * 1024 * 1024 } = {}) {
  if (typeof exec !== 'function') return { ok: false, reason: '缺少 exec（需要在目标机器上执行命令）' };
  const target = String(path || '').trim();
  if (!target) return { ok: false, reason: '模型路径为空' };
  if (target.includes('..')) return { ok: false, reason: '路径不允许包含 ..' };

  const safe = target.replace(/'/g, "'\\''");

  try {
    const kind = detectSpecKind(target);

    if (kind.kind === 'gguf') {
      // base64 传二进制，避免 shell 层把字节当文本处理
      const res = await exec(`head -c ${headBytes} '${safe}' | base64 | tr -d '\\n'`);
      const out = String(res?.stdout || '').trim();
      if (!out) return { ok: false, reason: `读不到 GGUF 头部（文件不存在或为空）：${target}` };
      const buf = Buffer.from(out, 'base64');
      let parsed = parseGgufHeader(buf);
      if (!parsed.ok && /缓冲不足|out of range/i.test(parsed.reason || '') && headBytes < 32 * 1024 * 1024) {
        // 元数据比读到的更长（大词表模型常见）：翻倍重试一次
        return readModelSpec({ path: target, exec, headBytes: headBytes * 2 });
      }
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      const spec = specFromGgufMeta(parsed.meta);
      if (!spec.ok) return { ok: false, reason: spec.reason };
      return { ok: true, spec, kind: 'gguf', bytesRead: buf.length };
    }

    // HF 目录：读 config.json；如果目录里只有一个 gguf（量化模型），优先用 gguf
    const dirListing = await exec(`ls -1 '${safe}' 2>/dev/null | head -50`);
    const entries = String(dirListing?.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const gguf = entries.find((x) => /\.gguf$/i.test(x));
    if (gguf) {
      const nested = `${target.replace(/\/+$/, '')}/${gguf}`;
      return readModelSpec({ path: nested, exec, headBytes });
    }
    if (!entries.includes('config.json')) {
      return { ok: false, reason: `目录里既没有 config.json 也没有 .gguf：${target}` };
    }
    const catRes = await exec(`cat '${safe}/config.json' 2>/dev/null`);
    const text = String(catRes?.stdout || '').trim();
    if (!text) return { ok: false, reason: `config.json 读不到或为空：${target}` };
    let config;
    try {
      config = JSON.parse(text);
    } catch (err) {
      return { ok: false, reason: `config.json 不是合法 JSON：${err && err.message ? err.message : String(err)}` };
    }
    const spec = specFromHfConfig(config);
    if (!spec.ok) return { ok: false, reason: spec.reason };
    return { ok: true, spec, kind: 'hf-config', bytesRead: text.length };
  } catch (err) {
    return { ok: false, reason: `读取模型规格失败：${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * 一次性算出"这个模型配这个方案需要多少显存"的完整账，供 footprint 复用。
 *
 * 与 footprint.estimateModelFootprint 的分工：
 *   · 本函数只负责 **KV + SSM** 这两块（需要模型规格才能算准）
 *   · footprint 负责权重、引擎开销、util 换算与三档判定
 */
export function preciseKvBudget({ spec, meta, args, contextLength, maxConcurrency = 1 } = {}) {
  if (!spec || spec.ok !== true) return { ok: false, reason: '模型规格不可用' };
  const { dtype, source } = kvDtypeFromArgs(args);
  const kv = kvBytesPerTokenExact(spec, { kvDtype: dtype ?? 'fp16' });
  if (!kv.ok) return { ok: false, reason: kv.reason };

  const ctx = Number(contextLength) > 0 ? Number(contextLength) : (spec.contextLength ?? 4096);
  const conc = Number(maxConcurrency) > 0 ? Number(maxConcurrency) : 1;
  const kvMiB = (kv.bytesPerToken * ctx * conc) / (1024 * 1024);
  const ssm = ssmStateMiB(spec, meta);

  return {
    ok: true,
    kvBytesPerToken: kv.bytesPerToken,
    kvMiB: Math.round(kvMiB * 10) / 10,
    ssmMiB: ssm.miB,
    totalMiB: Math.round((kvMiB + ssm.miB) * 10) / 10,
    contextLength: ctx,
    maxConcurrency: conc,
    kvDtype: dtype ?? 'fp16',
    kvDtypeSource: source ?? '默认 fp16（引擎未指定 --kv/--kv-cache-dtype）',
    formula: kv.formula,
    ssmReason: ssm.reason,
    specNotes: Array.isArray(spec.notes) ? spec.notes : [],
  };
}

/* ────────────────────────── KV 计算 ────────────────────────── */

/**
 * 精确计算每 token 的 KV cache 字节数。
 *
 * 公式：fullAttentionLayers × kvHeadCount × (keyDim + valueDim) × bytesPerElem ÷ avgCompressRatio
 *
 * 注意**不含**线性/SSM 层的状态：那部分与上下文长度无关（是常量，按 batch 计），
 * 单独由 `ssmStateMiB()` 估算并在报告里列为固定项。
 *
 * @param {object} spec  specFromGgufMeta / specFromHfConfig 的产物
 * @param {object} [opts]
 * @param {string|number} [opts.kvDtype]    'int8' / 'fp16' / 直接给字节数
 * @returns {{ok:true, bytesPerToken:number, bytesPerLayer:number, formula:string} | {ok:false, reason:string}}
 */
export function kvBytesPerTokenExact(spec, opts = {}) {
  if (!spec || spec.ok !== true) return { ok: false, reason: '模型规格不可用，无法精确计算 KV' };
  const bytes = typeof opts.kvDtype === 'number' ? opts.kvDtype : kvDtypeToBytes(opts.kvDtype ?? 'fp16');
  if (bytes === null) {
    return { ok: false, reason: `KV 精度 "${opts.kvDtype}" 认不出来（支持 fp16/bf16/fp8/int8/q8_0…）` };
  }
  const layers = Number(spec.fullAttentionLayers);
  const heads = Number(spec.kvHeadCount);
  const kDim = Number(spec.headDim);
  const vDim = Number(spec.valueDim ?? spec.headDim);
  if (!Number.isFinite(layers) || layers <= 0) return { ok: false, reason: '全注意力层数无效' };
  if (!Number.isFinite(heads) || heads <= 0) return { ok: false, reason: 'KV 头数无效' };
  if (!Number.isFinite(kDim) || kDim <= 0) return { ok: false, reason: 'head_dim 无效' };
  const compress = Number(spec.avgCompressRatio) > 0 ? Number(spec.avgCompressRatio) : 1;

  const perLayer = heads * (kDim + vDim) * bytes / compress;
  const perToken = layers * perLayer;
  return {
    ok: true,
    bytesPerToken: Math.round(perToken * 100) / 100,
    bytesPerLayer: Math.round(perLayer * 100) / 100,
    formula: `${layers} 层 × ${heads} KV头 × (${kDim}+${vDim}) × ${bytes}B${compress !== 1 ? ` ÷ ${compress}` : ''}`,
  };
}

/**
 * 混合架构里线性/SSM 层的常量状态估算（与上下文长度无关，按 1 路并发计）。
 * 只有 GGUF 里带 ssm 字段时才估；否则返回 0 并说明。
 */
export function ssmStateMiB(spec, meta) {
  if (!meta || typeof meta !== 'object') return { miB: 0, reason: '没有 SSM 元数据，按 0 计（混合架构的常量状态可能被低估）' };
  const arch = spec?.arch;
  if (!arch) return { miB: 0, reason: '未知架构' };
  const inner = Number(meta[`${arch}.ssm.inner_size`]);
  const state = Number(meta[`${arch}.ssm.state_size`]);
  const groups = Number(meta[`${arch}.ssm.group_count`]);
  const conv = Number(meta[`${arch}.ssm.conv_kernel`]);
  const layers = Number(spec.linearLayers);
  if (!Number.isFinite(inner) || !Number.isFinite(state) || !Number.isFinite(layers) || layers <= 0) {
    return { miB: 0, reason: 'SSM 字段不全，按 0 计：线性注意力层的常量状态可能被低估' };
  }
  // 递推状态：inner_size × state_size；卷积状态：(conv-1) × inner_size
  const g = Number.isFinite(groups) && groups > 0 ? groups : 1;
  const convPart = Number.isFinite(conv) && conv > 1 ? (conv - 1) * inner : 0;
  const bytes = layers * (inner * state + convPart) * 2 /* fp16 递推 */;
  return {
    miB: Math.round((bytes / (1024 * 1024)) * 10) / 10,
    reason: `${layers} 层线性注意力 × (inner ${inner} × state ${state} + conv) × 2B，与上下文无关（组数 ${g} 不入公式，属保守估计）`,
  };
}

/**
 * MoE 卸载检测：这些引擎/参数下，磁盘上的权重**不全驻显存**。
 * strata 的 --expert-cache、llama.cpp 的 mmap、vLLM 的 --cpu-offload-gb 都属于这类。
 */
export function detectWeightOffload({ engineType, args } = {}) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const has = (flag) => list.some((a) => a === flag || a.startsWith(`${flag}=`));
  const hits = [];
  if (has('--expert-cache') || has('--expert-cache-dir')) hits.push('--expert-cache（expert 走内存/磁盘缓存）');
  if (has('--ple-io')) hits.push('--ple-io（PLE 放内存）');
  if (has('--cpu-offload-gb')) hits.push('--cpu-offload-gb（部分层放 CPU）');
  if (has('--no-kv-offload') === false && has('--kv-offload')) hits.push('--kv-offload');
  const mmapDefault = engineType === 'llama.cpp';
  if (mmapDefault) hits.push('llama.cpp 默认 mmap（权重按需分页，RSS 可能远小于文件大小）');
  return {
    offloads: hits.length > 0 || mmapDefault,
    reasons: hits,
    hint: hits.length > 0 || mmapDefault
      ? '该引擎会把部分权重放在内存/磁盘，磁盘文件大小 ≠ 显存占用：'
        + '权重项建议用实测值（bench 的 readGpuMem）而不是文件大小，否则估算会严重偏大'
      : null,
  };
}
