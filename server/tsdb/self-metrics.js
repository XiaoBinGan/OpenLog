/**
 * 自身指标采集 —— 把 OpenLog 已经在采的数据转成 Prometheus 暴露格式。
 *
 * 这是「融入而不是替代」的关键一步：做完这一步，现成的 Prometheus / Grafana
 * 就能抓 OpenLog，不需要装 exporter。
 *
 * 指标命名遵循 Prometheus 的约定：
 *   · counter 以 `_total` 结尾
 *   · 单位写进指标名（`_seconds`、`_bytes`），不带单位的裸名是坏习惯
 *   · 标签基数要低 —— 绝不能把 IP、容器 ID、文件名塞进标签，
 *     否则序列数会爆炸（这是 Prometheus 使用者最常踩的坑，导出侧要负责拦住）
 *
 * **字段形状以 /api/monitor/stats 的实际返回为准**，不是猜的：
 *   cpu     { load, cores: [...] }
 *   memory  { used, total, free, percent }
 *   disk    [{ name, used, total, usePercent }]
 *   network [{ iface, rx, tx }]
 *   gpus    [{ index, name, util, memUsed, memTotal, temp }]
 * 早期版本按「直觉形状」写（cpu.usage / disk.use / gpu.utilizationGpu），
 * 结果字段一个都对不上，/metrics 里一条系统指标都没有 —— 且不报错，
 * 因为每个字段都走了 `if (Number.isFinite(...))` 的静默跳过。
 */

/** 把名字里不合法的字符换成下划线（标签值不做这个处理） */
function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_:]/g, '_');
}

/**
 * 从系统指标构造 Prometheus 样本。
 *
 * @param {object} stats /api/monitor/stats 的形状
 * @param {object} [opts]
 * @param {number} [opts.timestamp]
 * @param {string} [opts.hostname] 多机采集时区分来源；单机留空以避免无谓的标签
 * @returns {Array<{name:string, labels:Object, value:number, help?:string, type?:string, timestamp:number}>}
 */
export function systemStatsToSamples(stats, opts = {}) {
  const ts = Number.isFinite(opts.timestamp) ? Number(opts.timestamp) : Date.now();
  const host = opts.hostname ? { host: String(opts.hostname) } : {};
  const out = [];
  const push = (name, labels, value, help, type) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    out.push({
      name: sanitizeName(name),
      labels: { ...host, ...(labels || {}) },
      value: v,
      help: help || '',
      type: type || 'gauge',
      timestamp: ts,
    });
  };

  const cpu = stats?.cpu;
  if (cpu) {
    // 整体 CPU 使用率：stats 只给每核数组，没有整体值。
    // 这里算平均 —— 与 top 的 %CPU 口径一致（简单平均，不按核的负载加权）。
    const cores = Array.isArray(cpu.cores) ? cpu.cores : null;
    if (cores && cores.length) {
      const avg = cores.reduce((a, b) => a + Number(b || 0), 0) / cores.length;
      push('openlog_cpu_usage_percent', {}, avg, 'CPU 平均使用率（百分比）');
      cores.forEach((v, i) => {
        push('openlog_cpu_core_usage_percent', { core: String(i) }, Number(v), '单核 CPU 使用率（百分比）');
      });
    } else if (Number.isFinite(Number(cpu.usage))) {
      push('openlog_cpu_usage_percent', {}, Number(cpu.usage), 'CPU 使用率（百分比）');
    }
    if (Number.isFinite(Number(cpu.load))) {
      push('openlog_cpu_load_percent', {}, Number(cpu.load), 'CPU 负载（百分比，与界面同口径）');
    }
    for (const [k, label] of [['load1', '1 分钟'], ['load5', '5 分钟'], ['load15', '15 分钟']]) {
      if (Number.isFinite(Number(cpu[k]))) push(`openlog_load_${k}`, {}, Number(cpu[k]), `${label}平均负载`);
    }
  }

  const mem = stats?.memory;
  if (mem) {
    push('openlog_memory_total_bytes', {}, Number(mem.total), '内存总量（字节）');
    push('openlog_memory_used_bytes', {}, Number(mem.used), '已用内存（字节）');
    push('openlog_memory_free_bytes', {}, Number(mem.free ?? mem.available), '空闲内存（字节）');
    push('openlog_memory_usage_percent', {}, Number(mem.percent), '内存使用率（百分比）');
  }

  const disks = stats?.disk ?? stats?.disks;
  if (Array.isArray(disks)) {
    for (const d of disks) {
      // 磁盘用挂载点/盘符当标签：一台机器几个到几十个，基数低
      const mount = String(d.mount || d.name || d.fs || d.device || 'unknown');
      push('openlog_disk_total_bytes', { mount }, Number(d.total ?? d.size), '磁盘总量（字节）');
      push('openlog_disk_used_bytes', { mount }, Number(d.used), '磁盘已用（字节）');
      push('openlog_disk_usage_percent', { mount }, Number(d.usePercent ?? d.use), '磁盘使用率（百分比）');
    }
  }

  const net = stats?.network ?? stats?.networks;
  if (Array.isArray(net)) {
    for (const n of net) {
      const iface = String(n.iface || n.name || 'unknown');
      // rx/tx 是累计字节数（界面显示为速率，但底层是累计）
      push('openlog_network_receive_bytes_total', { iface }, Number(n.rx ?? n.rx_sec), '网卡累计接收字节', 'counter');
      push('openlog_network_transmit_bytes_total', { iface }, Number(n.tx ?? n.tx_sec), '网卡累计发送字节', 'counter');
    }
  }

  const gpus = stats?.gpus ?? stats?.gpu;
  if (Array.isArray(gpus)) {
    for (const g of gpus) {
      // GPU 用序号当标签而不是 UUID/名称：名称会随驱动升级变化，序号稳定
      const idx = String(g.index ?? g.id ?? '0');
      push('openlog_gpu_utilization_percent', { gpu: idx }, Number(g.util ?? g.utilizationGpu), 'GPU 利用率（百分比）');
      // memUsed / memTotal 在 stats 里是 MiB，转成字节以符合 Prometheus 约定
      if (Number.isFinite(Number(g.memUsed))) {
        push('openlog_gpu_memory_used_bytes', { gpu: idx }, Number(g.memUsed) * 1024 * 1024, 'GPU 显存已用（字节）');
      }
      if (Number.isFinite(Number(g.memTotal))) {
        push('openlog_gpu_memory_total_bytes', { gpu: idx }, Number(g.memTotal) * 1024 * 1024, 'GPU 显存总量（字节）');
      }
      push('openlog_gpu_temperature_celsius', { gpu: idx }, Number(g.temp ?? g.temperatureGpu), 'GPU 温度（摄氏度）');
    }
  }

  const proc = stats?.processes;
  if (Number.isFinite(Number(proc?.total ?? proc?.count))) {
    push('openlog_processes_total', {}, Number(proc?.total ?? proc?.count), '进程总数');
  }

  const uptime = stats?.uptime ?? stats?.system?.uptime;
  if (Number.isFinite(Number(uptime))) {
    push('openlog_system_uptime_seconds', {}, Number(uptime), '系统运行时长（秒）', 'counter');
  }

  // 容量告警（界面上的强制确认弹窗）也暴露出来 —— 这样「弹窗出现过几次」
  // 在 Prometheus 里能画成趋势，而不是只能靠人记
  if (Array.isArray(stats?.capacityAlerts)) {
    for (const a of stats.capacityAlerts) {
      const key = String(a.key || a.type || 'unknown');
      push('openlog_capacity_alert', { key, level: String(a.level || 'warning') }, 1, '容量告警是否触发（1=触发）');
    }
  }

  return out;
}

/**
 * 从容器列表构造样本。
 *
 * **只输出计数，不给每个容器一条序列** —— 容器 ID 基数高，
 * 而且容器会频繁重建，把它当标签会产生大量短命序列。
 * 需要看单个容器时用 /api/docker/containers，不要走指标。
 *
 * @param {Array<object>} containers
 * @param {number} [timestamp]
 */
export function containersToSamples(containers, timestamp) {
  const ts = Number.isFinite(timestamp) ? Number(timestamp) : Date.now();
  const list = Array.isArray(containers) ? containers : [];
  const byState = { running: 0, exited: 0, paused: 0, restarting: 0, other: 0 };
  for (const c of list) {
    const state = String(c.state || c.status || '').toLowerCase();
    if (state.includes('running') || state === 'up') byState.running += 1;
    else if (state.includes('exited') || state.includes('dead')) byState.exited += 1;
    else if (state.includes('paused')) byState.paused += 1;
    else if (state.includes('restarting')) byState.restarting += 1;
    else byState.other += 1;
  }
  const out = [
    { name: 'openlog_docker_containers_total', labels: {}, value: list.length, help: '容器总数', type: 'gauge', timestamp: ts },
  ];
  for (const [state, n] of Object.entries(byState)) {
    out.push({
      name: 'openlog_docker_containers_by_state',
      labels: { state },
      value: n,
      help: '按状态分组的容器数量',
      type: 'gauge',
      timestamp: ts,
    });
  }
  return out;
}

/**
 * 从 TSDB 统计构造样本 —— 用于监控「监控系统自己」。
 *
 * 为什么重要：TSDB 写不进去的时候，所有业务指标都会静默停止更新，
 * 而「数据没更新」这件事本身需要一个指标来暴露。
 */
export function tsdbStatsToSamples(stats, timestamp) {
  const ts = Number.isFinite(timestamp) ? Number(timestamp) : Date.now();
  const out = [];
  const push = (name, labels, value, help, type) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    out.push({ name, labels: labels || {}, value: v, help, type: type || 'gauge', timestamp: ts });
  };
  push('openlog_tsdb_series_total', {}, stats?.seriesCount, '时序序列总数', 'gauge');
  push('openlog_tsdb_samples_total', {}, stats?.sampleCount, '时序采样点总数', 'gauge');
  push('openlog_tsdb_ready', {}, stats?.ready ? 1 : 0, 'TSDB 是否就绪（1=就绪）', 'gauge');
  if (stats?.sampleCount > 0) {
    push('openlog_tsdb_oldest_sample_timestamp_seconds', {}, Math.floor(Number(stats.oldestMs) / 1000), '最旧采样点的时间戳', 'gauge');
  }
  return out;
}

/**
 * 从抓取器统计构造样本。
 */
export function scraperStatsToSamples(stats, timestamp) {
  const ts = Number.isFinite(timestamp) ? Number(timestamp) : Date.now();
  const out = [];
  const push = (name, labels, value, help, type) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    out.push({ name, labels: labels || {}, value: v, help, type: type || 'counter', timestamp: ts });
  };
  push('openlog_scrape_rounds_total', {}, stats?.rounds, '抓取轮次总数');
  push('openlog_scrape_targets_total', {}, stats?.scrapes, '累计抓取次数');
  push('openlog_scrape_failures_total', {}, stats?.failures, '累计抓取失败次数');
  push('openlog_scrape_samples_written_total', {}, stats?.samples, '累计写入的采样点数');
  push('openlog_scrape_targets_configured', {}, stats?.targetCount, '配置的目标数', 'gauge');
  return out;
}

/**
 * 合并多组样本，并按「同名指标去重 + 跳过非法值」清理。
 *
 * 为什么需要清理：Prometheus 抓取时同一指标同一标签组合出现两次会被拒绝或覆盖，
 * 而我们的多个来源（系统指标 / 容器 / 自身）可能产生重名。
 */
export function mergeSamples(...groups) {
  const seen = new Set();
  const out = [];
  for (const g of groups) {
    for (const s of Array.isArray(g) ? g : []) {
      if (!s || !s.name) continue;
      const v = Number(s.value);
      if (!Number.isFinite(v)) continue;
      const key = `${s.name}\u0000${JSON.stringify(s.labels || {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}