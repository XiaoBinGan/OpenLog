/**
 * capacity-alerts.js —— 容量告警判定（内存 / 磁盘）。
 *
 * 需求：内存使用率 > 90%，或任意一块磁盘 > 80%，就要报警。
 *
 * 这里只做**判定**，不做"提醒过没有"的记忆 —— 那是客户端的事。
 * 为什么拆开：告警是否该弹，取决于「当前是否超标」×「用户多久前手动关过」，
 * 后者是浏览器本地状态（localStorage），服务端不持有。
 * 服务端无条件如实报告，客户端负责抑制重复打扰，这样刷新页面、换标签页
 * 都不会出现「关过了又弹」或者「明明超标却不弹」。
 */

/** 默认阈值：内存 90%、磁盘 80% */
export const DEFAULT_CAPACITY_THRESHOLDS = Object.freeze({
  memoryPercent: 90,
  diskPercent: 80,
});

const clampPercent = (v, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(100, n);
};

/**
 * 归一化阈值。用户可在设置里改；这里保证脏值（0 / 负数 / NaN / >100）
 * 不会变成"永不报警"或"永远报警"。
 */
export function normalizeThresholds(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    memoryPercent: clampPercent(src.memoryPercent, DEFAULT_CAPACITY_THRESHOLDS.memoryPercent),
    diskPercent: clampPercent(src.diskPercent, DEFAULT_CAPACITY_THRESHOLDS.diskPercent),
  };
}

/**
 * 告警条目的稳定标识。
 *
 * 必须是「同类告警不同实例才不同」：
 *   memory      —— 内存只有一条
 *   disk:/data  —— 每块盘一条（关掉 /data 的提示不该顺带压住 / 的提示）
 * 客户端拿这个 key 记"1 小时内已关闭"。
 */
export function alertKey(kind, name) {
  return kind === 'memory' ? 'memory' : `disk:${String(name || '')}`;
}

/**
 * 判定容量告警。
 *
 * @param {object} input
 * @param {number} input.memoryPercent 内存使用率（0-100）
 * @param {Array<{name?: string, usePercent?: number, used?: number, total?: number}>} input.disks
 * @param {object} [input.thresholds]
 * @returns {Array<{key: string, kind: 'memory'|'disk', name: string, percent: number,
 *   threshold: number, level: 'critical'|'warning', title: string, detail: string}>}
 */
export function evaluateCapacityAlerts(input, thresholds) {
  const t = normalizeThresholds(thresholds);
  const out = [];

  const memPct = Number(input?.memoryPercent);
  if (Number.isFinite(memPct) && memPct > t.memoryPercent) {
    out.push({
      key: alertKey('memory'),
      kind: 'memory',
      name: '内存',
      percent: round1(memPct),
      threshold: t.memoryPercent,
      // 超过 95% 视为严重：这时已经接近 OOM，语气要更重
      level: memPct >= 95 ? 'critical' : 'warning',
      title: '内存使用率过高',
      detail: `当前 ${round1(memPct)}%，已超过阈值 ${t.memoryPercent}%`,
    });
  }

  const diskList = Array.isArray(input?.disks) ? input.disks : [];
  for (let i = 0; i < diskList.length; i += 1) {
    const d = diskList[i];
    if (!d) continue;
    const pct = Number(d.usePercent);
    if (!Number.isFinite(pct) || pct <= t.diskPercent) continue;
    const rawName = String(d.name ?? '').trim();
    const name = rawName || '未知磁盘';
    out.push({
      // 没设备名的盘用下标兜底：两块无名盘不能共用一个 key，
      // 否则关掉其中一条会把另一条的提醒一起压住（而且刷新后下标也可能变，
      // 但无名盘本来就取不到稳定标识，宁可多弹一次）
      key: alertKey('disk', rawName || `#${i}`),
      kind: 'disk',
      name,
      percent: round1(pct),
      threshold: t.diskPercent,
      // 磁盘 >90% 时写入随时可能失败，标 critical
      level: pct >= 90 ? 'critical' : 'warning',
      title: `磁盘 ${name} 空间不足`,
      detail: `当前 ${round1(pct)}%，已超过阈值 ${t.diskPercent}%`,
    });
  }

  // 严重的排前面：一次弹出多条时，用户先看到最要紧的
  return out.sort((a, b) => (b.percent - b.threshold) - (a.percent - a.threshold));
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}
