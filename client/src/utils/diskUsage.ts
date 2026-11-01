/**
 * 磁盘用量汇总
 *
 * 服务端已经把同一块盘的重复条目去重了（server/disk-utils.js），但客户端仍要做一层
 * 防御：接口可能来自旧版本服务端、或者远程服务器采集到的 `df` 输出里同一设备被多个
 * 挂载点重复列出。直接把这些条目相加会算出 476.9% 这种不可能的值。
 *
 * 规则与服务端保持一致：
 *   1. 丢弃总容量 <= 0 的条目；
 *   2. 同一设备名（没有设备名时用总容量兜底）只算一次；
 *   3. 总容量完全相同的条目视为同一块物理盘的不同视角，只算一次。
 */
export interface DiskEntryLike {
  name?: string;
  used?: number;
  total?: number;
  usePercent?: number;
}

export interface DiskSummary {
  /** 去重后的磁盘条目 */
  disks: DiskEntryLike[];
  used: number;
  total: number;
  /** 0~100 的整体占用率 */
  percent: number;
}

const toNumber = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 与 server/disk-utils.js 的 dedupeDisks 保持一致的客户端版本 */
export function dedupeDisks(disks: DiskEntryLike[] | null | undefined): DiskEntryLike[] {
  const list = (Array.isArray(disks) ? disks : []).filter((d) => d && toNumber(d.total) > 0);

  const byName = new Map<string, DiskEntryLike>();
  for (const d of list) {
    const total = toNumber(d.total);
    // 同一块盘被 bind mount 重复列出时设备名相同，用设备名收敛；
    // 没有设备名时用"The 总容量 + 已用量"兜底，避免把两块同容量盘并成一块
    const name = String(d.name ?? '').trim();
    const key = name ? `n:${name}` : `a:${total}:${toNumber(d.used)}`;
    const prev = byName.get(key);
    if (!prev || toNumber(d.used) > toNumber(prev.used)) byName.set(key, d);
  }

  // 同一块盘的另一视角：total 与 used 完全一致（容器里 overlay 与 /dev/sda3 就是这种关系）
  // 只按 total 合并会把"两块同容量的真实磁盘"错误合并，所以必须连 used 一起比。
  const byView = new Map<string, DiskEntryLike>();
  for (const d of byName.values()) {
    const key = `${toNumber(d.total)}:${toNumber(d.used)}`;
    const prev = byView.get(key);
    if (!prev) {
      byView.set(key, d);
      continue;
    }
    // 名字带 /dev/ 或盘符的是真实设备，优先保留
    const isReal = (x: DiskEntryLike) => /^\/dev\/|^[A-Za-z]:/.test(String(x.name ?? ''));
    if (!isReal(prev) && isReal(d)) byView.set(key, d);
  }

  return [...byView.values()];
}

/**
 * 汇总多块盘的整体占用（先去重再求和，避免重复计数）。
 * 只有一块盘时就是这块盘的占用率。
 *
 * percent 优先按 usePercent 加权（df 口径，已扣掉 root 保留块，和 `df -h` 一致），
 * 拿不到 usePercent 时才退回 used/total。
 */
export function summarizeDisks(disks: DiskEntryLike[] | null | undefined): DiskSummary {
  const unique = dedupeDisks(disks);
  let used = 0;
  let total = 0;
  let weightedPct = 0;
  let pctKnown = 0;
  for (const d of unique) {
    const t = toNumber(d.total);
    if (t <= 0) continue;
    total += t;
    used += Math.min(Math.max(0, toNumber(d.used)), t);
    if (Number.isFinite(Number(d.usePercent))) {
      weightedPct += Math.min(100, Math.max(0, Number(d.usePercent))) * t;
      pctKnown += t;
    }
  }
  const percent = total <= 0
    ? 0
    : pctKnown > 0
      ? Math.min(100, weightedPct / pctKnown)
      : Math.min(100, (used / total) * 100);
  return { disks: unique, used, total, percent };
}
