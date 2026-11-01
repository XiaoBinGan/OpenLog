/**
 * 磁盘用量归一化
 *
 * 问题背景：在容器里（host 网络 + bind mount）`df` / `systeminformation.fsSize()` 会把
 * **同一块物理盘**重复列出很多次，例如 T4 上 /dev/sda3 出现了 6 次（/etc/hosts、
 * /etc/hostname、/etc/resolv.conf 这类单文件 bind mount 也各自算一条），
 * 另外还有一条 overlay 指向同一块盘的存储。
 *
 * 前端把这些条目加起来当"总磁盘"用，于是出现 476.9%（6 × 79.5%）这种不可能的值。
 * 真正的语义应该是：**一块盘只出现一次**。
 *
 * 归一化规则：
 *   1. 丢掉总容量为 0 / 非有限的条目（tmpfs、proc 之类）；
 *   2. 同一设备名只保留一条（同一块盘的多个 bind mount）；
 *   3. 总容量完全相同的条目视为同一块物理盘的不同视角（overlay vs /dev/sda3），
 *      优先保留真实设备名，其次保留已用量更大的那条。
 *
 * 注意：不同总容量的盘会全部保留 —— 多块真实磁盘仍然要分别统计。
 */

/** 这些名字不是"真实块设备"，只在没有真实设备可用时才保留 */
const VIRTUAL_NAMES = new Set(['overlay', 'tmpfs', 'devtmpfs', 'none', 'shm', 'aufs', 'rootfs']);

const isVirtual = (name) => {
  const n = String(name || '').trim();
  if (!n) return true;
  if (VIRTUAL_NAMES.has(n)) return true;
  // Linux 伪文件系统（/proc、/sys 等）不是磁盘；真实块设备都是 /dev/xxx
  return !n.startsWith('/dev/') && !/^[A-Za-z]:/.test(n) && !n.startsWith('/');
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * @param {Array<{name?: string, used?: number, total?: number, usePercent?: number}>} disks
 * @returns {Array<{name: string, used: number, total: number, usePercent: number}>}
 */
export function dedupeDisks(disks) {
  const list = (Array.isArray(disks) ? disks : [])
    .filter((d) => d && num(d.total) > 0)
    .map((d) => ({
      name: String(d.name ?? '').trim(),
      used: num(d.used),
      total: num(d.total),
      usePercent: Number.isFinite(Number(d.usePercent))
        ? Math.min(100, Math.max(0, Number(d.usePercent)))
        : Math.min(100, Math.max(0, (num(d.used) / num(d.total)) * 100)),
    }));

  // 1) 同一设备名只留一条（容器里同一块盘会被 bind mount 重复列出）
  const byName = new Map();
  for (const d of list) {
    // 没有设备名时用 total+used 兜底，避免把两块同容量的真实磁盘并成一块
    const key = d.name || `#${d.total}:${d.used}`;
    const prev = byName.get(key);
    if (!prev || d.used > prev.used) byName.set(key, d);
  }

  // 2) total 和 used 都完全相同的条目 = 同一块盘的另一个视角（如容器里的 overlay 与 /dev/sda3），
  //    只留一条，优先真实设备名。
  //    注意：只按 total 去重会错误合并"两块同容量的真实磁盘"（used 几乎不可能字节相同）。
  const byView = new Map();
  for (const d of byName.values()) {
    const key = `${d.total}:${d.used}`;
    const prev = byView.get(key);
    if (!prev) {
      byView.set(key, d);
      continue;
    }
    const prevVirtual = isVirtual(prev.name);
    const nextVirtual = isVirtual(d.name);
    if (prevVirtual && !nextVirtual) byView.set(key, d);
  }

  return [...byView.values()];
}

/**
 * 汇总多块盘的总体占用。
 *
 * 只在 dedupeDisks 之后使用才有意义：对重复条目求和会算出 >100% 的值。
 *
 * percent 优先按各盘的 usePercent 汇总（df 口径：used/(used+avail)，已扣掉 root 保留块），
 * 这样和用户 `df -h` 看到的数字一致；只有拿不到 usePercent 时才退回 used/total。
 *
 * @param {Array<{used?: number, total?: number, usePercent?: number}>} disks
 * @returns {{used: number, total: number, percent: number}}
 */
export function summarizeDisks(disks) {
  const list = Array.isArray(disks) ? disks : [];
  let used = 0;
  let total = 0;
  let weightedPct = 0;
  let pctKnown = 0;
  for (const d of list) {
    const t = num(d?.total);
    if (t <= 0) continue;
    total += t;
    used += Math.min(num(d?.used), t);
    if (Number.isFinite(Number(d?.usePercent))) {
      weightedPct += Math.min(100, Math.max(0, Number(d.usePercent))) * t;
      pctKnown += t;
    }
  }
  const percent = total <= 0
    ? 0
    : pctKnown > 0
      ? Math.min(100, weightedPct / pctKnown)
      : Math.min(100, (used / total) * 100);
  return { used, total, percent };
}
