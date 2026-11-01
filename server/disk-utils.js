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
    const key = d.name || `#${d.total}`;
    const prev = byName.get(key);
    if (!prev || d.used > prev.used) byName.set(key, d);
  }

  // 2) 总容量相同的视为同一块物理盘的不同视角，只留一条
  const bySize = new Map();
  for (const d of byName.values()) {
    const key = String(d.total);
    const prev = bySize.get(key);
    if (!prev) {
      bySize.set(key, d);
      continue;
    }
    const prevVirtual = isVirtual(prev.name);
    const nextVirtual = isVirtual(d.name);
    if (prevVirtual && !nextVirtual) bySize.set(key, d);
    else if (prevVirtual === nextVirtual && d.used > prev.used) bySize.set(key, d);
  }

  return [...bySize.values()];
}

/**
 * 汇总多块盘的总体占用。
 *
 * 只在 dedupeDisks 之后使用才有意义：对重复条目求和会算出 >100% 的值。
 *
 * @param {Array<{used?: number, total?: number}>} disks
 * @returns {{used: number, total: number, percent: number}}
 */
export function summarizeDisks(disks) {
  const list = Array.isArray(disks) ? disks : [];
  let used = 0;
  let total = 0;
  for (const d of list) {
    const t = num(d?.total);
    if (t <= 0) continue;
    total += t;
    used += Math.min(num(d?.used), t);
  }
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return { used, total, percent };
}
