/**
 * GPU 监控模块
 * 支持本地和远程 GPU 检测，兼容：
 *   - NVIDIA GPU (nvidia-smi)
 *   - AMD GPU (rocm-smi / AMD ROCm)
 *   - 沐熙 GPU (muxi-smi)
 *   - 华为昇腾 GPU (npu-smi / ascend-toolkit)
 *
 * 统一输出格式，所有方法均为 async
 */

import { NodeSSH } from 'node-ssh';
import { getKv, setKv } from './db/index.js';

// ─── 类型定义 ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GPUProcessInfo
 * @property {string} gpuId        - GPU 编号
 * @property {string} gpuGI        - GPU GI (GPU Instance ID)
 * @property {string} ci           - CI (Compute Instance ID)
 * @property {number} pid          - 进程 PID
 * @property {string} type         - 进程类型: 'C' (Compute) | 'G' (Graphics) | 'X' (Other)
 * @property {string} processName  - 进程名称
 * @property {number} memoryUsed   - GPU 显存占用 (MB)
 */

/**
 * @typedef {Object} GPUDevice
 * @property {string} id           - GPU 编号 (0, 1, ...)
 * @property {string} name         - GPU 名称
 * @property {string} vendor       - 厂商: 'NVIDIA' | 'AMD' | 'MOXI' | 'HUAWEI' | 'UNKNOWN'
 * @property {string} driver       - 驱动版本
 * @property {string} cudaVersion  - CUDA 版本（仅 NVIDIA）
 * @property {number} memoryTotal  - 显存总量 (MB)
 * @property {number} memoryUsed   - 已用显存 (MB)
 * @property {number} memoryFree   - 空闲显存 (MB)
 * @property {number} utilization  - GPU 利用率 (%)
 * @property {number} temperature  - 温度 (°C)
 * @property {string} powerDraw    - 功耗 (W)
 * @property {string} powerLimit   - 功耗上限 (W)
 * @property {string} status       - 状态: 'ok' | 'warning' | 'critical' | 'unknown'
 * @property {GPUProcessInfo[]} processes - GPU 上运行的进程列表
 */

/**
 * @typedef {Object} GPUQueryOptions
 * @property {boolean} remote      - 是否远程查询
 * @property {string}  [host]      - 远程主机地址
 * @property {string}  [sshUser]   - SSH 用户名
 * @property {string}  [sshPassword]
 * @property {string}  [sshKeyPath]
 * @property {number}  [sshPort]
 */

// ─── 本地 GPU 检测 ──────────────────────────────────────────────────────────

/**
 * 检测本地可用 GPU 类型
 * @returns {Promise<string[]>}  厂商列表
 */
export async function detectLocalGPUVendors() {
  const vendors = [];

  try {
    await runCommand('nvidia-smi --query-gpu=name --format=csv,noheader');
    vendors.push('NVIDIA');
  } catch {}

  try {
    await runCommand('rocm-smi --showproductname');
    vendors.push('AMD');
  } catch {}

  try {
    await runCommand('muxi-smi --version');
    vendors.push('MOXI');
  } catch {}

  try {
    await runCommand('npu-smi info 2>/dev/null || ascend-toolkit-check 2>/dev/null || npuinfo64 2>/dev/null');
    vendors.push('HUAWEI');
  } catch {}

  return vendors;
}

/**
 * 获取本地所有 GPU 信息
 * @returns {Promise<GPUDevice[]>}
 */
export async function getLocalGPUs() {
  const vendors = await detectLocalGPUVendors();
  const results = [];

  if (vendors.includes('NVIDIA')) {
    results.push(...(await getNVIDIAGPUsLocal()));
  }
  if (vendors.includes('AMD')) {
    results.push(...(await getAMDGPUsLocal()));
  }
  if (vendors.includes('MOXI')) {
    results.push(...(await getMOXIGPUsLocal()));
  }
  if (vendors.includes('HUAWEI')) {
    results.push(...(await getHuaweiGPUsLocal()));
  }

  return results;
}

// ─── NVIDIA GPU ─────────────────────────────────────────────────────────────

async function getNVIDIAGPUsLocal() {
  try {
    const output = await runCommand(
      'nvidia-smi --query-gpu=index,name,driver_version,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits'
    );
    const devices = parseNVIDIAOutput(output);
    
    // 获取进程信息
    const processes = await getNvidiaProcessesLocal();
    
    // 直接返回所有进程，不做 GPU 过滤（因为总线地址无法可靠匹配索引）
    // 前端可以根据进程数据的 gpuId 显示
    devices.forEach(device => {
      device.processes = processes; // 显示所有进程
    });
    
    return devices;
  } catch (err) {
    console.warn('[GPU] NVIDIA 检测失败:', err.message);
    return [];
  }
}

/**
 * 获取本地 NVIDIA GPU 进程信息
 * @returns {Promise<GPUProcessInfo[]>}
 */
async function getNvidiaProcessesLocal() {
  try {
    const output = await runCommand(
      'nvidia-smi --query-compute-apps=gpu_bus_id,gpu_instance_id,compute_instance_id,pid,process_name,used_memory --format=csv,noheader,nounits'
    );
    return parseNVIDIAProcessOutput(output);
  } catch (err) {
    // 没有进程运行时会报错，返回空数组
    return [];
  }
}

function parseNVIDIAOutput(output) {
  return output.trim().split('\n').map(line => {
    const [id, name, driver, util, memUsed, memTotal, temp, powerDraw, powerLimit] = line.split(',').map(s => s.trim());
    return {
      id,
      name,
      vendor: 'NVIDIA',
      driver: driver || '',
      cudaVersion: '',
      memoryTotal: Number(memTotal) || 0,
      memoryUsed: Number(memUsed) || 0,
      memoryFree: (Number(memTotal) || 0) - (Number(memUsed) || 0),
      utilization: Number(util) || 0,
      temperature: Number(temp) || 0,
      powerDraw: powerDraw ? `${powerDraw}W` : '',
      powerLimit: powerLimit ? `${powerLimit}W` : '',
      status: getGPUStatus(Number(temp) || 0, Number(util) || 0),
      processes: [],
    };
  });
}

/**
 * 解析 NVIDIA 进程输出
 * nvidia-smi --query-compute-apps 输出格式:
 * gpu_bus_id, gpu_instance_id, compute_instance_id, pid, process_name, used_memory
 * 
 * 需要将 gpu_bus_id 映射到 GPU index
 */
function parseNVIDIAProcessOutput(output, gpuBusIdToIndex = null) {
  if (!output || !output.trim()) return [];
  
  const lines = output.trim().split('\n').filter(Boolean);
  return lines.map(line => {
    const parts = line.split(',').map(s => s.trim());
    const [gpuBusId, gpuGI, ci, pid, processName, memUsed] = parts;
    
    // 如果有映射表，转换 bus_id 到 gpu index
    const gpuId = gpuBusIdToIndex ? (gpuBusIdToIndex[gpuBusId] || gpuBusId) : gpuBusId;
    
    return {
      gpuId: String(gpuId),
      gpuGI: gpuGI || 'N/A',
      ci: ci || 'N/A',
      pid: Number(pid) || 0,
      type: 'C', // Compute 类型
      processName: processName || 'unknown',
      memoryUsed: Number(memUsed) || 0,
    };
  });
}

// ─── AMD GPU ────────────────────────────────────────────────────────────────

async function getAMDGPUsLocal() {
  try {
    const [nameOut, memOut, utilOut, tempOut, powerOut] = await Promise.all([
      runCommand('rocm-smi --showproductname --csv').catch(() => ''),
      runCommand('rocm-smi --showmeminfo vram --csv').catch(() => ''),
      runCommand('rocm-smi --showutilization --csv').catch(() => ''),
      runCommand('rocm-smi --showtemp --csv').catch(() => ''),
      runCommand('rocm-smi --showpower --csv').catch(() => ''),
    ]);
    const devices = parseAMDOutput(nameOut, memOut, utilOut, tempOut, powerOut);
    
    // AMD GPU 进程信息 (如果支持)
    try {
      const processOut = await runCommand('rocm-smi --showpids --csv 2>/dev/null');
      const processes = parseAMDProcessOutput(processOut);
      devices.forEach(device => {
        device.processes = processes.filter(p => p.gpuId === device.id);
      });
    } catch {
      // AMD 进程查询不支持时忽略
    }
    
    return devices;
  } catch (err) {
    console.warn('[GPU] AMD 检测失败:', err.message);
    return [];
  }
}

function parseAMDOutput(nameOut, memOut, utilOut, tempOut, powerOut) {
  const names = nameOut.split('\n').filter(l => l.trim() && !l.includes('GPU') && !l.includes('Device')).map(l => l.split(',')[0]?.trim()).filter(Boolean);
  const memUsedArr = (memOut.match(/Used\s*:\s*(\d+)/g) || []).map(s => {
    const m = s.match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  });
  const memTotalArr = (memOut.match(/Total\s*:\s*(\d+)/g) || []).map(s => {
    const m = s.match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  });
  const utilArr = (utilOut.match(/(\d+)%/g) || []).map(s => Number(s.replace('%', '')));
  const tempArr = (tempOut.match(/(\d+)/g) || []).filter(s => Number(s) < 200).slice(0, names.length);
  const powerArr = (powerOut.match(/(\d+)/g) || []).filter(s => Number(s) < 2000).slice(0, names.length);

  return names.map((name, i) => ({
    id: String(i),
    name,
    vendor: 'AMD',
    driver: '',
    cudaVersion: '',
    memoryTotal: memTotalArr[i] || 0,
    memoryUsed: memUsedArr[i] || 0,
    memoryFree: (memTotalArr[i] || 0) - (memUsedArr[i] || 0),
    utilization: utilArr[i] || 0,
    temperature: tempArr[i] || 0,
    powerDraw: powerArr[i] ? `${powerArr[i]}W` : '',
    powerLimit: '',
    status: getGPUStatus(tempArr[i] || 0, utilArr[i] || 0),
    processes: [],
  }));
}

function parseAMDProcessOutput(output) {
  // AMD rocm-smi --showpids 输出格式各异，这里做简单解析
  if (!output || !output.trim()) return [];
  // TODO: 根据实际输出格式解析
  return [];
}

// ─── 沐熙 GPU ──────────────────────────────────────────────────────────────

async function getMOXIGPUsLocal() {
  try {
    const output = await runCommand('muxi-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature,power.draw --format=csv,noheader');
    const devices = parseMOXIOutput(output);
    
    // 沐熙 GPU 进程信息
    try {
      const processOut = await runCommand('muxi-smi --show-processes --format=csv,noheader 2>/dev/null');
      const processes = parseMOXIProcessOutput(processOut);
      devices.forEach(device => {
        device.processes = processes.filter(p => p.gpuId === device.id);
      });
    } catch {
      // 不支持时忽略
    }
    
    return devices;
  } catch (err) {
    console.warn('[GPU] 沐熙检测失败，尝试 muxiinfo:', err.message);
    try {
      const output = await runCommand('muxiinfo --query-gpu=all --format=csv');
      return parseMOXIOutput(output);
    } catch {
      return [];
    }
  }
}

function parseMOXIOutput(output) {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split(',').map(s => s.trim());
    const [id, name, memUsed, memTotal, util, temp, power] = parts;
    return {
      id,
      name: name || 'MUXI GPU',
      vendor: 'MOXI',
      driver: '',
      cudaVersion: '',
      memoryTotal: Number(memTotal) || 0,
      memoryUsed: Number(memUsed) || 0,
      memoryFree: (Number(memTotal) || 0) - (Number(memUsed) || 0),
      utilization: Number(util) || 0,
      temperature: Number(temp) || 0,
      powerDraw: power ? `${power}W` : '',
      powerLimit: '',
      status: getGPUStatus(Number(temp) || 0, Number(util) || 0),
      processes: [],
    };
  });
}

function parseMOXIProcessOutput(output) {
  if (!output || !output.trim()) return [];
  // TODO: 根据实际输出格式解析
  return [];
}

// ─── 华为昇腾 GPU ───────────────────────────────────────────────────────────

async function getHuaweiGPUsLocal() {
  try {
    const output = await runCommand('npu-smi info --query-gpu=index,name, memory.total,memory.used,utilization.gpu,temperature,power.draw --format=csv,noheader');
    const devices = parseHuaweiOutput(output);
    
    // 华为昇腾进程信息
    try {
      const processOut = await runCommand('npu-smi info --query-processes --format=csv,noheader 2>/dev/null');
      const processes = parseHuaweiProcessOutput(processOut);
      devices.forEach(device => {
        device.processes = processes.filter(p => p.gpuId === device.id);
      });
    } catch {
      // 不支持时忽略
    }
    
    return devices;
  } catch (err) {
    console.warn('[GPU] 华为昇腾检测失败，尝试 npuinfo64:', err.message);
    try {
      const output = await runCommand('npuinfo64 --query-gpu=all --format=csv');
      return parseHuaweiOutput(output);
    } catch {
      return [];
    }
  }
}

function parseHuaweiOutput(output) {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split(',').map(s => s.trim());
    const [id, name, memTotal, memUsed, util, temp, power] = parts;
    return {
      id,
      name: name || 'Huawei Ascend',
      vendor: 'HUAWEI',
      driver: '',
      cudaVersion: '',
      memoryTotal: Number(memTotal) || 0,
      memoryUsed: Number(memUsed) || 0,
      memoryFree: (Number(memTotal) || 0) - (Number(memUsed) || 0),
      utilization: Number(util) || 0,
      temperature: Number(temp) || 0,
      powerDraw: power ? `${power}W` : '',
      powerLimit: '',
      status: getGPUStatus(Number(temp) || 0, Number(util) || 0),
      processes: [],
    };
  });
}

function parseHuaweiProcessOutput(output) {
  if (!output || !output.trim()) return [];
  // TODO: 根据实际输出格式解析
  return [];
}

// ─── 远程 GPU 检测 ──────────────────────────────────────────────────────────

/**
 * 获取远程服务器所有 GPU 信息
 * @param {string}   host
 * @param {string}   sshUser
 * @param {string}   [sshPassword]
 * @param {string}   [sshKeyPath]
 * @param {number}   [sshPort]
 * @returns {Promise<GPUDevice[]>}
 */
export async function getRemoteGPUs(host, sshUser, sshPassword, sshKeyPath, sshPort = 22) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host,
      port: sshPort,
      username: sshUser,
      password: sshPassword || undefined,
      privateKeyPath: sshKeyPath || undefined,
      timeout: 10000,
    });

    const results = [];

    // 检测 NVIDIA
    try {
      const out = await sshExec(ssh, 'nvidia-smi --query-gpu=index,name,driver_version,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits');
      const devices = parseNVIDIAOutput(out);
      
      // 获取 NVIDIA 进程信息
      try {
        const processOut = await sshExec(ssh, 'nvidia-smi --query-compute-apps=gpu_bus_id,gpu_instance_id,compute_instance_id,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null');
        
        // 获取 gpu_bus_id 到 index 的映射
        const busIdOut = await sshExec(ssh, 'nvidia-smi --query-gpu=index,gpu_bus_id --format=csv,noheader,nounits');
        const busIdToIndex = {};
        busIdOut.trim().split('\n').forEach(line => {
          const [idx, busId] = line.split(',').map(s => s.trim());
          busIdToIndex[busId] = idx;
        });
        
        const processes = parseNVIDIAProcessOutput(processOut, busIdToIndex);
        devices.forEach(device => {
          device.processes = processes.filter(p => p.gpuId === device.id);
        });
      } catch {
        // 进程查询失败时忽略
      }
      
      results.push(...devices);
    } catch {}

    // 检测 AMD
    try {
      const nameOut = await sshExec(ssh, 'rocm-smi --showproductname --csv 2>/dev/null');
      const memOut = await sshExec(ssh, 'rocm-smi --showmeminfo vram --csv 2>/dev/null');
      const utilOut = await sshExec(ssh, 'rocm-smi --showutilization --csv 2>/dev/null');
      const tempOut = await sshExec(ssh, 'rocm-smi --showtemp --csv 2>/dev/null');
      const powerOut = await sshExec(ssh, 'rocm-smi --showpower --csv 2>/dev/null');
      const devices = parseAMDOutput(nameOut, memOut, utilOut, tempOut, powerOut);
      
      // AMD 进程信息
      try {
        const processOut = await sshExec(ssh, 'rocm-smi --showpids --csv 2>/dev/null');
        const processes = parseAMDProcessOutput(processOut);
        devices.forEach(device => {
          device.processes = processes.filter(p => p.gpuId === device.id);
        });
      } catch {}
      
      results.push(...devices);
    } catch {}

    // 检测沐熙
    try {
      const out = await sshExec(ssh, 'muxi-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature,power.draw --format=csv,noheader 2>/dev/null');
      const devices = parseMOXIOutput(out);
      
      // 沐熙进程信息
      try {
        const processOut = await sshExec(ssh, 'muxi-smi --show-processes --format=csv,noheader 2>/dev/null');
        const processes = parseMOXIProcessOutput(processOut);
        devices.forEach(device => {
          device.processes = processes.filter(p => p.gpuId === device.id);
        });
      } catch {}
      
      results.push(...devices);
    } catch {}

    // 检测华为昇腾
    try {
      const out = await sshExec(ssh, 'npu-smi info --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature,power.draw --format=csv,noheader 2>/dev/null');
      const devices = parseHuaweiOutput(out);
      
      // 华为进程信息
      try {
        const processOut = await sshExec(ssh, 'npu-smi info --query-processes --format=csv,noheader 2>/dev/null');
        const processes = parseHuaweiProcessOutput(processOut);
        devices.forEach(device => {
          device.processes = processes.filter(p => p.gpuId === device.id);
        });
      } catch {}
      
      results.push(...devices);
    } catch {}

    return results;
  } finally {
    ssh.dispose();
  }
}

/**
 * 通用 GPU 查询入口
 * 根据配置自动选择本地或远程方式
 * @param {GPUQueryOptions} options
 */
export async function getGPUs(options = {}) {
  if (options.remote && options.host && options.sshUser) {
    return getRemoteGPUs(options.host, options.sshUser, options.sshPassword, options.sshKeyPath, options.sshPort);
  }
  return getLocalGPUs();
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 运行本地命令（Promise 封装）
 */
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    import('child_process').then(({ execSync }) => {
      try {
        const out = execSync(cmd, { timeout: 8000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        resolve(out);
      } catch (err) {
        reject(new Error(err.stderr || err.message));
      }
    });
  });
}

/**
 * SSH 远程执行命令
 */
async function sshExec(ssh, command) {
  const result = await ssh.execCommand(command, { timeout: 10000 });
  if (result.code !== 0 && result.stderr) {
    throw new Error(result.stderr);
  }
  return result.stdout || '';
}

/**
 * 根据温度和利用率判断 GPU 状态
 */
function getGPUStatus(temperature, utilization) {
  if (temperature >= 90 || utilization >= 95) return 'critical';
  if (temperature >= 80 || utilization >= 80) return 'warning';
  return 'ok';
}

// ─── 数据库持久化 ──────────────────────────────────────────────────────────

/**
 * 从数据库加载 GPU 配置
 */
export function loadGPUConfigs() {
  try {
    const stored = getKv('gpu_configs');
    return stored || [];
  } catch {
    return [];
  }
}

/**
 * 保存 GPU 配置到数据库
 */
export function saveGPUConfigs(configs) {
  return setKv('gpu_configs', configs);
}

/**
 * 汇总信息（供前端展示）
 */
export function getGPUSummary(devices) {
  if (!devices.length) return null;
  const totalMem = devices.reduce((s, d) => s + d.memoryTotal, 0);
  const usedMem = devices.reduce((s, d) => s + d.memoryUsed, 0);
  const avgUtil = devices.reduce((s, d) => s + d.utilization, 0) / devices.length;
  const maxTemp = Math.max(...devices.map(d => d.temperature));
  const vendorSummary = devices.reduce((acc, d) => {
    acc[d.vendor] = (acc[d.vendor] || 0) + 1;
    return acc;
  }, {});
  
  // 汇总所有进程
  const allProcesses = devices.flatMap(d => d.processes || []);
  
  return {
    count: devices.length,
    totalMemory: totalMem,
    usedMemory: usedMem,
    freeMemory: totalMem - usedMem,
    avgUtilization: Math.round(avgUtil),
    maxTemperature: maxTemp,
    vendors: vendorSummary,
    devices,
    processCount: allProcesses.length,
    processes: allProcesses,
  };
}
