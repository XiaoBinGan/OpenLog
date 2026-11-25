/**
 * server/infra/capacity.js —— 容量预检：这个服务放得下吗，以及**为什么放不下**。
 *
 * 定位：纯计算层。不做 k8s 调用、不读集群、不发请求 —— 节点的原始对象
 * （以及可选的 adapter）由调用方注入，这里只负责算账：
 *
 *   1) 每张加速卡的剩余显存 / 剩余算力 / 剩余槽位（总量 − 已分配，按 deviceId 聚合）；
 *   2) 一个副本能不能落进**某一张卡**；
 *   3) 多个副本怎么摊（binpack 或 spread），摊完还剩什么；
 *   4) 放不下时把"卡在哪、差多少、碎片长什么样"翻译成中文句子。
 *
 * ── 为什么必须有这一层（而不是让 k8s 调度失败后兜底）─────────────────────────
 *
 * HAMi（原 k8s-vGPU-scheduler）的设备语义是**单卡切分**：一个容器申请
 * `nvidia.com/gpumem: 8000` 时，调度器只在**单张卡**上找剩余的 8000 MiB，
 * 不会把两张卡各 4000 MiB 拼给同一个容器。所以「集群总剩余 20 GiB」这种数字
 * 对"放得下吗"没有意义 —— 唯一有意义的是「有没有**一张**卡剩余 ≥ 8000 MiB」。
 * 这条硬约束是本模块所有判定的核心（见 SINGLE_CARD_RULE），也是 reasons 里
 * 必须向用户讲清楚的那句话：用户看到"还剩 12 GiB"却起不来，八成就是踩了这个坑。
 *
 * ── 几个刻意的口径选择 ────────────────────────────────────────────────────
 *
 * · `memoryMiB === 0` → **整卡模式**（契约：0 = 不限制 = 整卡）。整卡要求那张卡
 *   当前**完全空闲**（剩余 === 总量），因为整卡语义下 HAMi 不再做切分，
 *   卡上已有别的容器就不可能交出去。
 * · `coresPercent === 0` → **不限算力**（不参与比较）。注意它与 memory 的 0 语义
 *   相反：算力 0 是"不要算力配额"，显存 0 是"要整张卡"。这个不对称来自契约
 *   `resources.memoryMiB: 0 = 不限制（整卡）` / `coresPercent: 0 = 不限制`。
 * · 槽位（slot）：HAMi 每张卡最多切 `totalSlots` 份（默认 deviceSplitCount = 10），
 *   一个副本占 1 个槽位。显存算力都够但槽位用光时同样放不下 —— 这一点真机上
 *   经常被忽略（卡上 10 个僵尸容器把 slot 占满，显存空着也进不去）。
 * · 超额分配（已分配 > 总量，通常是手工改过 annotation 或卡被替换）按剩余 0 计算
 *   并进 warnings，不让负数把后续判定带偏。
 *
 * ── 导出 ────────────────────────────────────────────────────────────────
 *
 *   planPlacement({ service, nodes, allocations, adapter, policy, log })
 *     → { fits, candidates[], best, reasons[], fragments[], plan[], unplaced[], warnings[] }
 *   planPlacementAsync(...)   同上，但允许 adapter.readCapacity 返回 Promise
 *   normalizeDemand(service)  → 把 ModelService.resources 归一成"每副本要多少"
 *   formatMiB(mib)            → '7.8 GiB' / '512 MiB'（reasons / fragments 统一口径）
 *
 * 与别的模块的边界：
 *   · A3（accelerator）负责"真机上这张卡到底多大"——这里只通过注入的
 *     `adapter.readCapacity(node)` 取；adapter 抛错就回退到 `node.devices` 并记 warning，
 *     保证预检不会因为一个采集 bug 直接崩掉整个 UI。
 *   · A5（apply）在真正提交前调它做门禁；A7（前端）把 candidates/reasons/fragments
 *     直接渲染成"哪个节点差多少"的表格，不要自己再算一遍。
 */

/** HAMi deviceSplitCount 默认值：一张卡最多切 10 份 */
export const DEFAULT_DEVICE_SLOTS = 10;

/** 契约里 replicas 上限（maxReplicas 默认 8），这里给个更宽的天花板防止脏值把循环拉爆 */
const MAX_REPLICAS = 64;

/**
 * 「单卡放」硬约束的原话。放在 reasons 里给用户看，也放在注释里给下一个人看。
 * 改了它就要同步改测试里的文案断言。
 */
export const SINGLE_CARD_RULE =
  'HAMi 是单卡语义：一个副本的显存/算力必须由同一张卡提供，两张卡各剩一半也拼不成一个副本'
  + '（跨卡拼显存会直接调度失败，不是"先跑起来再说"）。';

const toNumber = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clampPositiveInt = (value, fallback, max) => {
  const n = Math.trunc(toNumber(value, fallback));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
};

/**
 * MiB → 人类可读。1077 → '1.1 GiB'；512 → '512 MiB'。
 *
 * 显存讨论里 GiB 更好读，但**判定必须用 MiB 原值**：四舍五入后的 8.0 GiB
 * 会把"差 1 MiB"这种真实失败藏起来（见测试「差 1 MiB 放不下」）。
 *
 * @param {number} mib
 * @returns {string}
 */
export function formatMiB(mib) {
  const n = Number(mib);
  if (!Number.isFinite(n)) return '未知';
  if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} GiB`;
  return `${Math.round(n)} MiB`;
}

const normalizeModelName = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * 型号是否匹配。
 *
 * 真机上同一个型号会以多种写法出现：节点 label 常写
 * `NVIDIA GeForce RTX 4090`，而某些采集路径只给 `RTX 4090`。所以做
 * 「忽略大小写与多余空格 + 允许一方是另一方的子串」的宽松匹配 —— 宁可多放一个
 * 节点出来让调度器拒，也不要在预检阶段把用户想用的卡判死。
 */
const modelMatches = (deviceType, wanted) => {
  const a = normalizeModelName(deviceType);
  const b = normalizeModelName(wanted);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
};

/** 节点名：兼容裸对象、k8s Node 对象、以及 A3 采集输出的几种写法 */
const readNodeName = (node, index) => String(
  node?.name ?? node?.nodeName ?? node?.metadata?.name ?? `node-${index}`,
);

const readNodeLabels = (node) => {
  const labels = node?.labels ?? node?.metadata?.labels;
  return labels && typeof labels === 'object' ? labels : {};
};

const readNodeModel = (node) => {
  const explicit = node?.acceleratorModel ?? node?.model ?? node?.gpuModel;
  if (explicit) return String(explicit);
  const labels = readNodeLabels(node);
  return String(labels['nvidia.com/gpu.product'] ?? labels['amd.com/gpu.product'] ?? '') || undefined;
};

/**
 * 把各种来源的"一张卡"归一成内部结构。
 *
 * 兼容字段名（不同采集路径 / 不同版本 annotation 的写法）：
 *   显存：totalMemMiB | memMiB | memoryMiB | memoryTotalMiB
 *   算力：totalCores | coresPercent | cores（百分比点 0-100）
 *   槽位：totalSlots | slots | splitCount
 */
function normalizeDevice(raw, index) {
  const id = String(raw?.id ?? raw?.deviceId ?? raw?.name ?? `card-${index}`);
  const type = String(raw?.type ?? raw?.model ?? raw?.product ?? raw?.acceleratorModel ?? 'unknown');
  const totalMemMiB = Math.max(
    0,
    Math.round(toNumber(raw?.totalMemMiB ?? raw?.memMiB ?? raw?.memoryMiB ?? raw?.memoryTotalMiB, 0)),
  );
  const totalCores = Math.max(0, toNumber(raw?.totalCores ?? raw?.coresPercent ?? raw?.cores, 100));
  const totalSlots = clampPositiveInt(
    raw?.totalSlots ?? raw?.slots ?? raw?.splitCount,
    DEFAULT_DEVICE_SLOTS,
    DEFAULT_DEVICE_SLOTS,
  );
  return { id, type, totalMemMiB, totalCores, totalSlots };
}

/** adapter.readCapacity 的几种合理返回形状 → 设备数组 */
function devicesFromCapacity(capacity, index = 0) {
  if (!capacity) return [];
  if (Array.isArray(capacity)) return capacity.map((d, i) => normalizeDevice(d, i));
  if (Array.isArray(capacity.devices)) return capacity.devices.map((d, i) => normalizeDevice(d, i));
  if (Array.isArray(capacity.gpus)) return capacity.gpus.map((d, i) => normalizeDevice(d, i));
  if (capacity.id || capacity.deviceId) return [normalizeDevice(capacity, index)];
  return [];
}

/**
 * 取节点上所有卡的"总量"信息。
 *
 * 优先 adapter（A3：真机 annotation / nvidia-smi / DCGM 汇总），失败或为空则回退
 * `node.devices`。回退不是"降级糊弄"：A3 没就绪时（并行开发期）预检也得能跑，
 * 而且出问题时 warnings 会明写"回退过"，不会让人误以为是真机数据。
 */
function resolveNodeDevices(node, name, adapter, warnings) {
  if (adapter && typeof adapter.readCapacity === 'function') {
    let capacity;
    try {
      capacity = adapter.readCapacity(node);
    } catch (err) {
      warnings.push(`节点 ${name} 读取容量失败（${err?.message || err}），已回退到 nodes[].devices`);
      capacity = null;
    }
    if (capacity && typeof capacity.then === 'function') {
      warnings.push(`节点 ${name} 的 adapter.readCapacity 返回了 Promise，同步版 planPlacement 忽略它；请改用 planPlacementAsync()`);
    } else if (capacity) {
      const devices = devicesFromCapacity(capacity);
      if (devices.length) return devices;
    }
  }
  const inline = node?.devices ?? node?.gpus ?? node?.accelerator?.devices ?? [];
  return devicesFromCapacity(inline);
}

/**
 * 服务需求归一化。
 *
 * @param {object} service ModelService（契约 A1）；也接受只带 resources/replicas 的裸对象
 * @returns {{ label: string, replicas: number, cardsPerReplica: number, memoryMiB: number,
 *   coresPercent: number, wholeCard: boolean, acceleratorModel: (string|undefined),
 *   nodeSelector: (Record<string,string>|undefined), policy: ('binpack'|'spread') }}
 */
export function normalizeDemand(service) {
  const svc = service && typeof service === 'object' ? service : {};
  const res = svc.resources && typeof svc.resources === 'object' ? svc.resources : {};
  const placement = svc.placement && typeof svc.placement === 'object' ? svc.placement : {};

  const memoryMiB = Math.max(0, Math.round(toNumber(res.memoryMiB, 0)));
  const coresPercent = Math.max(0, Math.min(100, toNumber(res.coresPercent, 0)));
  const policyRaw = String(svc.policy ?? placement.policy ?? 'binpack').toLowerCase();

  return {
    label: String(svc.name ?? svc.id ?? '未命名服务'),
    replicas: clampPositiveInt(svc.replicas, 1, MAX_REPLICAS),
    // 契约里 accelerators 是"每副本申请的加速卡数"；HAMi 下通常 1（vGPU 份额）。
    cardsPerReplica: clampPositiveInt(res.accelerators, 1, 16),
    memoryMiB,
    coresPercent,
    // 0 = 不限制 = 整卡
    wholeCard: memoryMiB === 0,
    acceleratorModel: placement.acceleratorModel ? String(placement.acceleratorModel) : undefined,
    nodeSelector: placement.nodeSelector && typeof placement.nodeSelector === 'object'
      ? placement.nodeSelector
      : undefined,
    policy: policyRaw === 'spread' ? 'spread' : 'binpack',
  };
}

/**
 * 一张卡能不能吃下一个副本。
 *
 * 返回**全部**不满足项（而不是第一条），因为"显存也不够、算力也不够"和
 * "只差 1 MiB"是完全不同的处置：前者要换卡，后者清一下邻居就行。
 *
 * @returns {{ ok: boolean, needMemMiB: number, needCores: number, reasons: string[] }}
 */
function checkDevice(device, demand) {
  const reasons = [];
  const needMemMiB = demand.wholeCard ? device.totalMemMiB : demand.memoryMiB;
  // 整卡语义下没写 coresPercent 就是整卡算力 100%；写了就按写的算（允许整卡显存 + 部分算力）
  const needCores = demand.wholeCard
    ? (demand.coresPercent > 0 ? demand.coresPercent : 100)
    : demand.coresPercent;

  if (device.totalMemMiB <= 0) {
    reasons.push(`卡 ${device.id} 没有上报显存总量（totalMemMiB=0），无法判断能否切分`);
  }

  if (demand.wholeCard) {
    if (device.freeMemMiB !== device.totalMemMiB) {
      reasons.push(
        `整卡模式要求 ${device.id} 完全空闲：当前已占用 ${device.usedMemMiB} MiB，`
        + `剩余 ${device.freeMemMiB} MiB ≠ 总量 ${device.totalMemMiB} MiB`,
      );
    }
  } else if (device.freeMemMiB < needMemMiB) {
    reasons.push(`显存不足：${device.id} 剩余 ${device.freeMemMiB} MiB < 需要 ${needMemMiB} MiB`);
  }

  if (needCores > 0 && device.freeCores < needCores) {
    reasons.push(`算力不足：${device.id} 剩余 ${device.freeCores}% < 需要 ${needCores}%`);
  }

  if (device.freeSlots < 1) {
    reasons.push(
      `槽位已满：${device.id} 可用槽位 0（上限 ${device.totalSlots} 份，`
      + `显存空着也切不进去，需清理卡上的旧容器）`,
    );
  }

  return { ok: reasons.length === 0, needMemMiB, needCores, reasons };
}

/** 单卡剩余显存从多到少 —— 用来挑"最宽裕的卡"做失败解释 */
const byFreeMemDesc = (a, b) => (b.freeMemMiB - a.freeMemMiB) || (a.order - b.order);

/**
 * 在给定卡集合里为一个副本挑卡（不扣减，纯预演）。
 *
 * policy：
 *   binpack（默认）—— 挑"扣掉需求后剩余最小"的卡，也就是**最能塞满**的卡。
 *                     和 HAMi 默认调度策略一致：把小碎片留给小请求。
 *   spread         —— 挑"扣掉需求后剩余最大"的卡，尽量摊开、别把一张卡塞死。
 *
 * @returns {Array<object>|null} 选中的卡（长度 = cardsPerReplica）；放不下返回 null
 */
function pickCards(devices, demand, policy) {
  const eligible = [];
  for (let i = 0; i < devices.length; i += 1) {
    const device = devices[i];
    const check = checkDevice(device, demand);
    if (!check.ok) continue;
    eligible.push({ device, index: i, remaining: device.freeMemMiB - check.needMemMiB });
  }
  if (eligible.length < demand.cardsPerReplica) return null;

  eligible.sort((a, b) => {
    const diff = policy === 'spread' ? (b.remaining - a.remaining) : (a.remaining - b.remaining);
    return diff || (a.index - b.index);
  });

  return eligible.slice(0, demand.cardsPerReplica).map((item) => item.device);
}

/** 把一次放置真正记到工作副本上（显存/算力/槽位三样都要扣） */
function applyPlacement(cards, demand) {
  for (const card of cards) {
    const check = checkDevice(card, demand);
    card.usedMemMiB += check.needMemMiB;
    card.freeMemMiB -= check.needMemMiB;
    card.freeCores = Math.max(0, card.freeCores - check.needCores);
    card.freeSlots = Math.max(0, card.freeSlots - 1);
  }
}

/**
 * 失败原因：拿**最宽裕的那张卡**去解释。
 *
 * 「最宽的卡都放不下」是最强的一句话 —— 如果拿一张本来就快满了的卡举例，
 * 用户会以为"换个节点就好了"。同时把节点的总剩余也报出来，方便对照
 * "总和够、单卡不够"这个典型碎片场景。
 */
function explainCardFailure(devices, demand) {
  if (!devices.length) {
    return ['节点上没有可用加速卡（devices 为空）'];
  }
  const widest = [...devices].sort(byFreeMemDesc)[0];
  const check = checkDevice(widest, demand);

  // 卡数不够是另一种失败：单卡都合格，但一个副本要 cardsPerReplica 张同时在，
  // 这个节点凑不齐（例如 accelerators=2 的副本落到只有 1 张卡的节点）。
  const able = devices.filter((d) => checkDevice(d, demand).ok).length;
  if (able < demand.cardsPerReplica) {
    if (!check.ok) {
      const totalFree = devices.reduce((sum, d) => sum + Math.max(0, d.freeMemMiB), 0);
      const lines = totalFree > Math.max(0, widest.freeMemMiB)
        ? [`（节点剩余显存合计 ${totalFree} MiB 也拼不出来：单卡最多只给到 ${Math.max(0, widest.freeMemMiB)} MiB）`]
        : [];
      return [...check.reasons, ...lines];
    }
    return [
      `卡数不足：副本要 ${demand.cardsPerReplica} 张卡，节点上只有 ${able} 张能满足单卡要求`,
    ];
  }

  return [`未被选中的卡状态异常（可用 ${able} 张 ≥ 需要 ${demand.cardsPerReplica} 张），请检查设备上报`];
}

/** 单节点独立预演：假设整个服务都塞进这一个节点，能塞几个 */
function simulateNode(entry, demand, policy) {
  const devices = entry.devices.map((d) => ({ ...d }));
  const placements = [];
  let failure = null;

  for (let replica = 1; replica <= demand.replicas; replica += 1) {
    const cards = pickCards(devices, demand, policy);
    if (!cards) {
      failure = { replica, reasons: explainCardFailure(devices, demand) };
      break;
    }
    applyPlacement(cards, demand);
    placements.push({ replica, node: entry.name, cards: cards.map((c) => c.id) });
  }

  return {
    placements,
    failure,
    fits: placements.length === demand.replicas,
    remainingMemMiB: devices.reduce((sum, d) => sum + Math.max(0, d.freeMemMiB), 0),
    devices,
  };
}

/** 节点适用性：nodeSelector 全等 + 型号亲和至少要有一张匹配的卡 */
function checkEligibility(entry, demand) {
  const reasons = [];

  if (demand.nodeSelector) {
    for (const [key, want] of Object.entries(demand.nodeSelector)) {
      const got = entry.labels[key];
      if (String(got) !== String(want)) {
        reasons.push(`nodeSelector 不匹配：要求 ${key}=${want}，节点 ${entry.name} 上是 ${got === undefined ? '（无此 label）' : got}`);
      }
    }
  }

  let devices = entry.devices;
  if (demand.acceleratorModel) {
    const matched = entry.devices.filter((d) => modelMatches(d.type, demand.acceleratorModel));
    if (!matched.length) {
      const present = [...new Set(entry.devices.map((d) => d.type))];
      reasons.push(
        `型号亲和不满足：要求 ${demand.acceleratorModel}，节点 ${entry.name} 上是 `
        + `${present.length ? present.join(' / ') : '没有任何加速卡'}`,
      );
    }
    devices = matched;
  }

  return { eligible: reasons.length === 0, reasons, devices };
}

/**
 * 把 allocations 按 (节点, 设备) 聚合到每张卡的 used/free 上。
 *
 * 未知节点 / 未知设备 id 一律忽略并 warning：真机上残留的旧 allocation
 * （卡被换过、节点重命名过）很常见，直接报错会让整个预检不可用；
 * 忽略也不会算错 —— 那些记录本来就不属于当前这张卡。
 */
function indexAllocations(entries, allocations, warnings) {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const list = Array.isArray(allocations) ? allocations : [];

  for (const raw of list) {
    const nodeName = String(raw?.node ?? raw?.nodeName ?? raw?.host ?? '');
    const deviceId = String(raw?.deviceId ?? raw?.device ?? raw?.id ?? '');
    const memMiB = Math.max(0, Math.round(toNumber(raw?.memoryMiB ?? raw?.memMiB ?? raw?.memory, 0)));
    const cores = Math.max(0, toNumber(raw?.coresPercent ?? raw?.cores, 0));
    const slots = clampPositiveInt(raw?.slots ?? raw?.count ?? raw?.pods, 1, DEFAULT_DEVICE_SLOTS);

    if (!nodeName) {
      warnings.push(`有一条 allocation 缺少节点名（deviceId=${deviceId || '未知'}），已忽略`);
      continue;
    }
    const entry = byName.get(nodeName);
    if (!entry) {
      warnings.push(`allocation 指向集群里不存在的节点 ${nodeName}，已忽略`);
      continue;
    }
    const device = entry.devices.find((d) => d.id === deviceId);
    if (!device) {
      const known = entry.devices.map((d) => d.id).join(' / ') || '无';
      warnings.push(
        `allocation 指向节点 ${nodeName} 上不存在的设备 ${deviceId}，已忽略`
        + `（该节点现有设备：${known}）`,
      );
      continue;
    }

    device.usedMemMiB += memMiB;
    device.usedCores += cores;
    device.usedSlots += slots;
  }

  // 汇总成 free，并处理超额分配（负数会把后续比较带偏）
  for (const entry of entries) {
    for (const device of entry.devices) {
      device.freeMemMiB = device.totalMemMiB - device.usedMemMiB;
      if (device.freeMemMiB < 0) {
        warnings.push(
          `节点 ${entry.name} 的卡 ${device.id} 显存超额分配：已占用 ${device.usedMemMiB} MiB > 总量 ${device.totalMemMiB} MiB，剩余按 0 计算`,
        );
        device.freeMemMiB = 0;
      }
      device.freeCores = Math.max(0, device.totalCores - device.usedCores);
      device.freeSlots = Math.max(0, device.totalSlots - device.usedSlots);
    }
  }
}

/** 集群侧装配：节点归一 + 分配聚合 + 适用性过滤 */
function buildCluster({ nodes, allocations, adapter, demand, warnings }) {
  const entries = (Array.isArray(nodes) ? nodes : []).map((node, index) => {
    const name = readNodeName(node, index);
    const devices = resolveNodeDevices(node, name, adapter, warnings).map((device, i) => ({
      ...device,
      order: i,
      usedMemMiB: 0,
      usedCores: 0,
      usedSlots: 0,
      freeMemMiB: device.totalMemMiB,
      freeCores: device.totalCores,
      freeSlots: device.totalSlots,
    }));
    return { name, labels: readNodeLabels(node), model: readNodeModel(node), devices };
  });

  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.name)) warnings.push(`节点 ${entry.name} 出现了不止一次，按多次登记处理（容量会被重复计算）`);
    seen.add(entry.name);
  }

  indexAllocations(entries, allocations, warnings);

  for (const entry of entries) {
    const verdict = checkEligibility(entry, demand);
    entry.eligible = verdict.eligible;
    entry.ineligibleReasons = verdict.reasons;
    entry.effectiveDevices = verdict.devices;
    for (const device of entry.devices) {
      device.modelMatched = !demand.acceleratorModel || modelMatches(device.type, demand.acceleratorModel);
    }
  }

  return entries;
}

/**
 * 全局贪心：逐副本在集群里挑落点，边放边扣。
 *
 * 每轮为所有适用节点各算一个"这一副本落在哪张卡"的预演结果，再按 policy 比：
 *   binpack → 选扣完剩余**最小**的那个（越紧越先填满，碎片留得整齐）
 *   spread  → 选扣完剩余**最大**的那个（摊开，抗单节点故障）
 * 平票按节点输入顺序，保证同一输入永远同一输出（前端每次轮询不能端点乱跳）。
 */
function planCluster(entries, demand) {
  const working = new Map(entries.map((e) => [e.name, e.effectiveDevices.map((d) => ({ ...d }))]));
  const placements = [];
  let failure = null;

  for (let replica = 1; replica <= demand.replicas; replica += 1) {
    const options = [];
    for (const entry of entries) {
      if (!entry.eligible) continue;
      const devices = working.get(entry.name);
      const cards = pickCards(devices, demand, demand.policy);
      if (!cards) continue;
      const remaining = cards.reduce((sum, card) => {
        const check = checkDevice(card, demand);
        return sum + (card.freeMemMiB - check.needMemMiB);
      }, 0);
      options.push({ entry, cards, remaining });
    }

    if (!options.length) {
      failure = { replica, reasons: collectClusterFailureReasons(entries, working, demand) };
      break;
    }

    options.sort((a, b) => {
      const diff = demand.policy === 'spread' ? (b.remaining - a.remaining) : (a.remaining - b.remaining);
      return diff || (entries.indexOf(a.entry) - entries.indexOf(b.entry));
    });

    const chosen = options[0];
    applyPlacement(chosen.cards, demand);
    placements.push({
      replica,
      node: chosen.entry.name,
      cards: chosen.cards.map((c) => c.id),
      memoryMiB: demand.wholeCard ? 'whole-card' : demand.memoryMiB,
    });
  }

  return { placements, failure, working };
}

/** 集群级失败解释：按节点逐条给，能一次看清"每个节点各差在哪" */
function collectClusterFailureReasons(entries, working, demand) {
  if (!entries.length) return ['集群里没有任何节点登记，无卡可放'];

  const eligible = entries.filter((e) => e.eligible);
  if (!eligible.length) {
    const lines = [];
    for (const entry of entries) lines.push(...entry.ineligibleReasons);
    return lines.length ? lines : ['没有通过适用性过滤的节点'];
  }

  const lines = [];
  for (const entry of eligible) {
    const devices = working.get(entry.name);
    lines.push(`节点 ${entry.name}：${explainCardFailure(devices, demand).join('；')}`);
  }
  return lines;
}

/**
 * 碎片说明：把"总和够、单卡不够"这件事画成一句话。
 *
 * 例：`NVIDIA GeForce RTX 4090 剩 6.0 GiB / NVIDIA GeForce RTX 5090 剩 2.0 GiB，
 *      单个副本要 8.0 GiB → 单卡都放不下（不能跨卡拼显存）`
 */
function buildFragments(entries, demand, candidates) {
  const fragments = [];

  if (!entries.length) {
    fragments.push('集群里没有任何节点，没有任何一张卡可以承载副本');
    return fragments;
  }
  if (!candidates.some((c) => c.eligible)) {
    const detail = entries.flatMap((e) => e.ineligibleReasons).slice(0, 3).join('；');
    fragments.push(`没有节点通过适用性过滤（nodeSelector / 型号亲和），可用卡数为 0${detail ? `：${detail}` : ''}`);
    return fragments;
  }

  // 按型号分组：每个型号报"单卡最多还剩多少"，这正是单卡语义下唯一有意义的数字。
  // perCard 保留每张卡的 {free, total}，才能算准"还能塞几个副本"和"有没有整卡空闲"。
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.eligible) continue;
    for (const device of entry.effectiveDevices) {
      const key = device.type;
      const prev = groups.get(key) ?? { perCard: [], freeSlots: 0 };
      prev.perCard.push({ free: Math.max(0, device.freeMemMiB), total: device.totalMemMiB });
      prev.freeSlots += device.freeSlots;
      groups.set(key, prev);
    }
  }

  if (!groups.size) {
    fragments.push(`节点上没有上报任何加速卡（${entries.length} 个节点全是空的），无法承载副本`);
    return fragments;
  }

  const allCards = [...groups.values()].flatMap((g) => g.perCard);
  const totalFree = allCards.reduce((sum, c) => sum + c.free, 0);
  const maxSingle = Math.max(0, ...allCards.map((c) => c.free));
  const freeSlotsTotal = [...groups.values()].reduce((sum, g) => sum + g.freeSlots, 0);

  const perModel = [...groups.entries()]
    .map(([type, g]) => `${type} 剩 ${formatMiB(Math.max(0, ...g.perCard.map((c) => c.free)))}（该型号共 ${g.perCard.length} 张，最宽的一张）`);

  if (demand.wholeCard) {
    // 整卡：剩余 == 总量 才算"空"。一张空的都没有时，说清"几张卡都有残留"比只说 false 有用
    const idleCards = allCards.filter((c) => c.total > 0 && c.free === c.total).length;
    if (!idleCards) {
      fragments.push(
        `${perModel.join(' / ')}，整卡模式要求一张完全空闲的卡（剩余 = 总量）`
        + ` → 集群 ${allCards.length} 张卡都有残留分配，没有一张能整卡交付`,
      );
    }
  } else if (maxSingle < demand.memoryMiB) {
    const tail = totalFree >= demand.memoryMiB
      ? `；集群显存合计 ${formatMiB(totalFree)} 看着够，但那是 ${allCards.length} 张卡相加，HAMi 不能跨卡拼显存`
      : `；集群显存合计只有 ${formatMiB(totalFree)}，连相加都不够`;
    fragments.push(
      `${perModel.join(' / ')}，单个副本要 ${formatMiB(demand.memoryMiB)}`
      + `（${demand.memoryMiB} MiB）→ 单卡都放不下${tail}`,
    );
  }

  // 副本数超出物理容量：把"总共还能放几个副本"算清楚，比只说 false 有用
  const capacityPerCard = demand.wholeCard
    ? allCards.filter((c) => c.total > 0 && c.free === c.total).length
    : allCards.reduce((sum, c) => sum + Math.floor(c.free / Math.max(1, demand.memoryMiB)), 0);
  if (capacityPerCard < demand.replicas) {
    fragments.push(
      `按当前碎片${demand.wholeCard ? '还能整卡交付' : '最多再放'} ${capacityPerCard} 个副本`
      + `（每副本${demand.wholeCard ? '整卡' : ` ${formatMiB(demand.memoryMiB)}`}），`
      + `服务要 ${demand.replicas} 个 → 差 ${demand.replicas - capacityPerCard} 个副本的容量`,
    );
  }

  if (freeSlotsTotal < demand.replicas) {
    fragments.push(
      `槽位碎片：全集群只剩 ${freeSlotsTotal} 个可用槽位，服务要 ${demand.replicas} 个`
      + `（每副本占 1 槽，HAMi 单卡默认最多切 ${DEFAULT_DEVICE_SLOTS} 份）`,
    );
  }

  return fragments;
}

/** candidates：每个节点一行，前端直接渲染成表格 */
function buildCandidates(entries, demand) {
  return entries.map((entry) => {
    const sum = (fn) => entry.effectiveDevices.reduce((acc, d) => acc + Math.max(0, fn(d)), 0);
    const max = (fn) => (entry.effectiveDevices.length
      ? Math.max(0, ...entry.effectiveDevices.map(fn))
      : 0);

    const base = {
      node: entry.name,
      eligible: entry.eligible,
      fits: false,
      // 注意：freeMemMiB 是**节点剩余显存合计**，只能用来显示"这节点还剩多少"，
      // 绝不能拿去和单副本需求比较 —— 那是跨卡拼显存的经典误区。判单卡看 maxFreeMemMiB。
      freeMemMiB: sum((d) => d.freeMemMiB),
      freeCores: sum((d) => d.freeCores),
      freeSlots: sum((d) => d.freeSlots),
      maxFreeMemMiB: max((d) => d.freeMemMiB),
      maxFreeCores: max((d) => d.freeCores),
      maxFreeSlots: max((d) => d.freeSlots),
      devices: entry.effectiveDevices.map((d) => ({
        id: d.id,
        type: d.type,
        totalMemMiB: d.totalMemMiB,
        freeMemMiB: Math.max(0, d.freeMemMiB),
        totalCores: d.totalCores,
        freeCores: d.freeCores,
        totalSlots: d.totalSlots,
        freeSlots: d.freeSlots,
      })),
      reasons: [],
      placedReplicas: 0,
    };

    if (!entry.eligible) {
      return { ...base, reasons: [...entry.ineligibleReasons], remainingMiB: base.freeMemMiB };
    }

    const sim = simulateNode(entry, demand, demand.policy);
    const reasons = [];
    if (!sim.fits) {
      if (sim.failure) {
        reasons.push(`第 ${sim.failure.replica} 个副本起放不下：${sim.failure.reasons.join('；')}`);
        if (sim.placements.length) {
          reasons.push(`该节点最多容纳 ${sim.placements.length}/${demand.replicas} 个副本`);
        }
      }
      if (entry.devices.length && !entry.effectiveDevices.length) {
        reasons.push(`节点 ${entry.name} 上没有符合条件的加速卡`);
      }
    }
    return {
      ...base,
      fits: sim.fits,
      placedReplicas: sim.placements.length,
      remainingMiB: sim.remainingMemMiB,
      reasons,
    };
  });
}

/** 落点摘要：'node-a 2 个副本（卡 gpu0）'；同节点多副本不重复列卡 */
function describePlacements(placements) {
  if (!placements.length) return '没有任何副本找到落点';
  const byNode = new Map();
  for (const item of placements) {
    const key = item.node;
    if (!byNode.has(key)) byNode.set(key, []);
    byNode.get(key).push(item);
  }
  return [...byNode.entries()]
    .map(([node, items]) => `${node} ${items.length} 个副本（卡 ${[...new Set(items.flatMap((i) => i.cards))].join(' / ')}）`)
    .join('；');
}

/**
 * 容量预检主入口。
 *
 * @param {object} input
 * @param {object} input.service ModelService（读 resources / replicas / placement）
 * @param {Array<object>} input.nodes 节点原始对象：`{ name, labels?, acceleratorModel?, devices? }`
 *   devices[] 每项 `{ id, type, totalMemMiB, totalCores?, totalSlots? }`
 * @param {Array<object>} [input.allocations] 已分配记录：`{ node, deviceId, memoryMiB, coresPercent, slots? }`
 * @param {{ readCapacity: (node: object) => any }} [input.adapter] A3 的加速卡适配器（测试里 mock）
 * @param {'binpack'|'spread'} [input.policy] 覆盖 service.placement.policy
 * @param {(msg: string) => void} [input.log] warning 回调（默认不打印，避免测试噪声）
 * @returns {{
 *   fits: boolean,
 *   candidates: Array<object>,
 *   best: (string|null),
 *   reasons: string[],
 *   fragments: string[],
 *   plan: Array<{ replica: number, node: string, cards: string[] }>,
 *   unplaced: { replica: number, reasons: string[] }|null,
 *   warnings: string[]
 * }}
 */
export function planPlacement(input = {}) {
  const { service, nodes, allocations, adapter, log } = input;
  const warnings = [];

  const demand = normalizeDemand(service);
  if (input.policy) demand.policy = String(input.policy).toLowerCase() === 'spread' ? 'spread' : 'binpack';

  const entries = buildCluster({ nodes, allocations, adapter, demand, warnings });
  for (const msg of warnings) if (typeof log === 'function') {
    try { log(msg); } catch { /* 日志回调自己炸了不该影响预检结论 */ }
  }
  const candidates = buildCandidates(entries, demand);
  const cluster = planCluster(entries, demand);
  const fits = cluster.placements.length === demand.replicas;
  const fragments = buildFragments(entries, demand, candidates);

  // ── best：承载副本最多的节点；并列时取"独立放完全部副本后剩余最少"（最紧凑）的那个 ──
  let best = null;
  if (cluster.placements.length) {
    const counts = new Map();
    for (const item of cluster.placements) counts.set(item.node, (counts.get(item.node) ?? 0) + 1);
    const candidateByNode = new Map(candidates.map((c) => [c.node, c]));
    const ranked = [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const remainA = candidateByNode.get(a[0])?.remainingMiB ?? 0;
      const remainB = candidateByNode.get(b[0])?.remainingMiB ?? 0;
      return remainA - remainB;
    });
    best = ranked[0][0];
  }

  // ── reasons：结论 + 为什么 ──
  const reasons = [];
  const needText = demand.wholeCard
    ? '整卡（memoryMiB=0 → 要求那张卡完全空闲）'
    : `${formatMiB(demand.memoryMiB)} 显存（${demand.memoryMiB} MiB）`;
  const coresText = demand.coresPercent > 0 ? ` + ${demand.coresPercent}% 算力` : '，不限算力';

  reasons.push(
    `服务 ${demand.label}：${demand.replicas} 个副本，每副本 ${demand.cardsPerReplica} 张卡，`
    + `单副本要 ${needText}${coresText}；策略 ${demand.policy}。`,
  );
  reasons.push(SINGLE_CARD_RULE);

  if (!entries.length) {
    reasons.push('集群里没有任何节点登记（nodes 为空），没有任何一张卡可以承载副本 → 放不下。');
  } else if (fits) {
    reasons.push(`放得下：${demand.replicas} 个副本全部有落点 —— ${describePlacements(cluster.placements)}。`);
    const tightest = candidates
      .filter((c) => c.placedReplicas > 0)
      .sort((a, b) => a.remainingMiB - b.remainingMiB)[0];
    if (tightest) {
      reasons.push(
        `落点后最紧的节点是 ${tightest.node}：剩余 ${formatMiB(tightest.remainingMiB)}`
        + `（${tightest.remainingMiB} MiB），后续扩副本要盯它。`,
      );
    }
  } else {
    reasons.push(
      `放不下：${cluster.placements.length}/${demand.replicas} 个副本有落点`
      + `${cluster.placements.length ? `（${describePlacements(cluster.placements)}）` : ''}`
      + `，第 ${cluster.failure?.replica ?? demand.replicas} 个副本起无卡可放。`,
    );
    for (const line of cluster.failure?.reasons ?? []) reasons.push(line);
    for (const fragment of fragments) reasons.push(`碎片：${fragment}`);
  }

  if (demand.acceleratorModel) {
    const matchedNodes = candidates.filter((c) => c.eligible).map((c) => c.node);
    reasons.push(
      matchedNodes.length
        ? `型号亲和 ${demand.acceleratorModel}：只有 ${matchedNodes.join(' / ')} 参与判定，其余节点的卡不参与（即使显存更大）。`
        : `型号亲和 ${demand.acceleratorModel}：没有任何节点的卡匹配，等于可用卡数为 0。`,
    );
  }
  if (warnings.length) {
    reasons.push(`注意：${warnings.length} 条数据异常已忽略（${warnings[0]}${warnings.length > 1 ? ' …' : ''}），详见 warnings。`);
  }

  return {
    fits,
    candidates,
    best,
    reasons,
    fragments,
    plan: cluster.placements,
    unplaced: cluster.placements.length === demand.replicas ? null : cluster.failure,
    warnings,
  };
}

/**
 * 异步版：A3 的 `readCapacity` 在真机上可能要去读节点 annotation / 探测设备，
 * 天然是 async 的。这里先把每个节点的容量读出来热身，再复用同步核心，
 * 保证两条路径的判定逻辑**完全同一份**（不会出现"异步版口径不一样"的鬼故事）。
 *
 * @param {object} input 同 planPlacement
 * @returns {Promise<object>} 同 planPlacement
 */
export async function planPlacementAsync(input = {}) {
  const { nodes, adapter } = input;
  if (!adapter || typeof adapter.readCapacity !== 'function') {
    return planPlacement(input);
  }

  const cache = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    try {
      cache.set(node, { ok: true, value: await adapter.readCapacity(node) });
    } catch (err) {
      cache.set(node, { ok: false, error: err });
    }
  }

  const syncAdapter = {
    readCapacity(node) {
      const hit = cache.get(node);
      if (!hit) return null;
      if (!hit.ok) throw hit.error;
      return hit.value;
    },
  };

  return planPlacement({ ...input, adapter: syncAdapter });
}
