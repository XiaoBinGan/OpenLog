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

  const byKey = new Map<string, DiskEntryLike>();
  for (const d of list) {
    const total = toNumber(d.total);
    // 同一块盘的不同视角总容量相同，用总容量做 key 就能收敛；
    // 有设备名时用设备名，避免不同容量盘被误合并
    const name = String(d.name ?? '').trim();
    const key = name ? `n:${name}` : `t:${total}`;
    const prev = byKey.get(key);
    if (!prev || toNumber(d.used) > toNumber(prev.used)) byKey.set(key, d);
  }

  const bySize = new Map<number, DiskEntryLike>();
  for (const d of byKey.values()) {
    const total = toNumber(d.total);
    const prev = bySize.get(total);
    if (!prev || toNumber(d.used) > toNumber(prev.used)) bySize.set(total, d);
  }

  return [...bySize.values()];
}

/**
 * 汇总多块盘的整体占用（先去重再求和，避免重复计数）。
 * 只有一块盘时就是这块盘的占用率。
 */
export function summarizeDisks(disks: DiskEntryLike[] | null | undefined): DiskSummary {
  const unique = dedupeDisks(disks);
  let used = 0;
  let total = 0;
  for (const d of unique) {
    const t = toNumber(d.total);
    if (t <= 0) continue;
    total += t;
    used += Math.min(Math.max(0, toNumber(d.used)), t);
  }
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return { disks: unique, used, total, percent };
}
