/**
 * 节点 GPU 实测数据采集（供 /api/k8s/clusters/:id/usage 的「实测」一半使用）。
 *
 * 为什么不用 HAMi 的 metrics：
 *   243 上的 HAMi v2.11.0 只暴露「分配」类指标（hami_gpu_memory_allocated_bytes /
 *   hami_gpu_core_allocated_ratio / hami_scheduler_allocations_total …），
 *   容器级 util 指标（hami_container_device_utilization_ratio）是 v1.x 的，v2 已移除。
 *   想回答「分配了 25 GiB、实际用了多少」只能从 nvidia-smi 拿。
 *
 * 数据来源：
 *   本机节点 → `gpu.getLocalGPUs()`（容器内 nvidia-smi，或 gpu-host-ssh 回落到宿主机）
 *   其它节点 → 按节点 InternalIP 匹配 settings 里的远程服务器，`gpu.getRemoteGPUs(...)`
 *
 * 对齐口径：以设备 UUID 为主键（HAMi 的 node-nvidia-register 也用 UUID）；
 * 本机拿不到 UUID 时退化为 `idx:<index>`，由调用方按 index 兜底匹配。
 *
 * 纯 IO 边界：本模块只采集与归一化，不判断 HTTP 语义；失败一律返回空 Map，不抛。
 */

const BYTES_PER_MIB = 1024 * 1024;

/** 把一台机器的 devices 归一成 Map<uuid(或 idx:N), { util, memUsed, memTotal, name, index }> */
export function indexDevicesByKey(devices) {
  const map = new Map();
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!d || typeof d !== 'object') continue;
    const uuid = typeof d.uuid === 'string' ? d.uuid.trim() : '';
    const key = uuid || (Number.isFinite(d.index) ? `idx:${d.index}` : '');
    if (!key || map.has(key)) continue;
    map.set(key, {
      util: toNumber(d.util),
      memUsed: toNumber(d.memUsed),
      memTotal: toNumber(d.memTotal),
      name: typeof d.name === 'string' ? d.name : '',
      index: Number.isFinite(d.index) ? d.index : null,
    });
  }
  return map;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isLocalIp(ip, localIps) {
  if (!ip) return false;
  const set = localIps instanceof Set ? localIps : new Set(localIps || []);
  return set.has(ip) || ip === '127.0.0.1' || ip === '::1';
}

/**
 * @param {object} opts
 * @param {Array<{name:string, internalIP?:string}>} opts.nodes   归一化后的 k8s 节点
 * @param {Array<{host:string, username?:string, port?:number}>} opts.servers  远程服务器（含凭据字段由 deps 提供）
 * @param {object} [opts.deps]  可注入（测试用）：{ getLocalGPUs, getRemoteGPUs, localIps }
 * @returns {Promise<Map<string, Map<string, object>>>}  nodeName → (uuid → 实测)
 */
export async function collectNodeGpuUsage({ nodes = [], servers = [], deps = {} } = {}) {
  const getLocalGPUs = deps.getLocalGPUs;
  const getRemoteGPUs = deps.getRemoteGPUs;
  const localIps = deps.localIps || [];
  const out = new Map();

  for (const node of Array.isArray(nodes) ? nodes : []) {
    const name = node?.name;
    if (!name) continue;
    const ip = node?.internalIP || '';

    try {
      if (isLocalIp(ip, localIps)) {
        if (typeof getLocalGPUs !== 'function') continue;
        const devices = await getLocalGPUs();
        const indexed = indexDevicesByKey(devices);
        if (indexed.size > 0) out.set(name, indexed);
        continue;
      }

      const server = (Array.isArray(servers) ? servers : []).find((s) => s && s.host === ip);
      if (!server || typeof getRemoteGPUs !== 'function') continue;
      const payload = await getRemoteGPUs(server);
      const devices = Array.isArray(payload) ? payload : payload?.devices;
      const indexed = indexDevicesByKey(devices);
      if (indexed.size > 0) out.set(name, indexed);
    } catch {
      // 单节点采集失败不影响其它节点；缺数据的那张卡会显示「未采到」
    }
  }

  return out;
}

/** 给 device 行找实测：优先 UUID，其次 index 兜底 */
export function lookupGpuUsage(nodeUsage, { uuid, index } = {}) {
  if (!(nodeUsage instanceof Map)) return null;
  if (uuid && nodeUsage.has(uuid)) return nodeUsage.get(uuid);
  if (Number.isFinite(index) && nodeUsage.has(`idx:${index}`)) return nodeUsage.get(`idx:${index}`);
  return null;
}

export { BYTES_PER_MIB };
