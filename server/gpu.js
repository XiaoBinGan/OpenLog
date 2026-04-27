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
    return parseNVIDIAOutput(output);
  } catch (err) {
    console.warn('[GPU] NVIDIA 检测失败:', err.message);
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
    return parseAMDOutput(nameOut, memOut, utilOut, tempOut, powerOut);
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
  }));
}

// ─── 沐熙 GPU ──────────────────────────────────────────────────────────────

async function getMOXIGPUsLocal() {
  try {
    const output = await runCommand('muxi-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature,power.draw --format=csv,noheader');
    return parseMOXIOutput(output);
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
    };
  });
}

// ─── 华为昇腾 GPU ───────────────────────────────────────────────────────────

async function getHuaweiGPUsLocal() {
  try {
    const output = await runCommand('npu-smi info --query-gpu=index,name, memory.total,memory.used,utilization.gpu,temperature,power.draw --format=csv,noheader');
    return parseHuaweiOutput(output);
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
    };
  });
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
      results.push(...parseNVIDIAOutput(out));
    } catch {}

    // 检测 AMD
    try {
      const nameOut = await sshExec(ssh, 'rocm-smi --showproductname --csv 2>/dev/null');
      const memOut = await sshExec(ssh, 'rocm-smi --showmeminfo vram --csv 2>/dev/null');
      const utilOut = await sshExec(ssh, 'rocm-smi --showutilization --csv 2>/dev/null');
      const tempOut = await sshExec(ssh, 'rocm-smi --showtemp --csv 2>/dev/null');
      const powerOut = await sshExec(ssh, 'rocm-smi --showpower --csv 2>/dev/null');
      results.push(...parseAMDOutput(nameOut, memOut, utilOut, tempOut, powerOut));
    } catch {}

    // 检测沐熙
    try {
      const out = await sshExec(ssh, 'muxi-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature,power.draw --format=csv,noheader 2>/dev/null');
      results.push(...parseMOXIOutput(out));
    } catch {}

    // 检测华为昇腾
    try {
      const out = await sshExec(ssh, 'npu-smi info --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature,power.draw --format=csv,noheader 2>/dev/null');
      results.push(...parseHuaweiOutput(out));
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
  return {
    count: devices.length,
    totalMemory: totalMem,
    usedMemory: usedMem,
    freeMemory: totalMem - usedMem,
    avgUtilization: Math.round(avgUtil),
    maxTemperature: maxTemp,
    vendors: vendorSummary,
    devices,
  };
}
