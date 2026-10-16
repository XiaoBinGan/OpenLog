/**
 * gpu-host-ssh.js — 容器内查询宿主机 GPU
 *
 * 背景：容器里通常没有 nvidia-smi。原来的实现把宿主机 SSH 凭据【明文硬编码】在
 * server/index.js 里（4 处），并且用 `sshpass -p <password>` 传密码 ——
 * 那会让密码出现在 `ps` 的进程列表里，同机任何用户都能看到。
 *
 * 现在：
 *   1. 凭据只从环境变量读取。未配置时此功能整体关闭（返回空数组），
 *      不再有任何源码内置的后备值。
 *   2. 用 `sshpass -e`（从 SSHPASS 环境变量读取）而不是 `-p`，
 *      密码不再出现在 argv 中。
 *   3. 用 execFileSync + 参数数组，不经过 shell，远端命令不会被本地 shell 解释。
 *
 * 环境变量：
 *   OPENLOG_GPU_SSH_HOST      默认 127.0.0.1
 *   OPENLOG_GPU_SSH_PORT      默认 40022
 *   OPENLOG_GPU_SSH_USER      默认 deploy
 *   OPENLOG_GPU_SSH_PASSWORD  密码（与 KEY_PATH 二选一）
 *   OPENLOG_GPU_SSH_KEY_PATH  私钥路径（优先于密码）
 *   OPENLOG_GPU_SSH_STRICT    known_hosts 策略，默认 accept-new
 */
import { execFileSync } from 'child_process';

const SSH_HOST = process.env.OPENLOG_GPU_SSH_HOST || '127.0.0.1';
const SSH_PORT = process.env.OPENLOG_GPU_SSH_PORT || '40022';
const SSH_USER = process.env.OPENLOG_GPU_SSH_USER || 'deploy';
const SSH_PASSWORD = process.env.OPENLOG_GPU_SSH_PASSWORD || '';
const SSH_KEY_PATH = process.env.OPENLOG_GPU_SSH_KEY_PATH || '';
// `no` 会无条件接受任何主机密钥，等于放弃中间人防护。
// accept-new 在首次连接时记录、之后校验，是能自动工作的最安全选项。
const SSH_STRICT = process.env.OPENLOG_GPU_SSH_STRICT || 'accept-new';

const CONNECT_TIMEOUT_S = '3';
const QUERY_TIMEOUT_MS = 5000;

/** 是否配置了宿主机 SSH 凭据。未配置时所有查询直接返回空结果。 */
export function isHostGpuSshConfigured() {
  return Boolean(SSH_KEY_PATH || SSH_PASSWORD);
}

/**
 * 启动时调用一次：生产环境下若未配置，明确告警。
 * 这是行为变更 —— 以前凭据是硬编码的，现在必须显式提供。
 */
export function warnIfUnconfigured() {
  if (isHostGpuSshConfigured()) return;
  console.warn(
    '⚠️  [GPU] 未配置宿主机 SSH 凭据（OPENLOG_GPU_SSH_PASSWORD 或 OPENLOG_GPU_SSH_KEY_PATH）。'
    + '容器内若无 nvidia-smi，GPU 查询将无法回落到宿主机。'
    + '（原实现把凭据明文硬编码在源码里，已移除。）'
  );
}

function sshArgs(remoteCommand) {
  return [
    '-o', `StrictHostKeyChecking=${SSH_STRICT}`,
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    '-o', 'BatchMode=no',
    '-p', String(SSH_PORT),
    `${SSH_USER}@${SSH_HOST}`,
    remoteCommand,
  ];
}

/** 执行一条远端命令，返回 stdout（失败抛错）。密码走环境变量，不进 argv。 */
function runRemote(remoteCommand) {
  if (SSH_KEY_PATH) {
    return execFileSync('ssh', ['-i', SSH_KEY_PATH, ...sshArgs(remoteCommand)], {
      timeout: QUERY_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }
  // sshpass -e 从 SSHPASS 读取密码；绝不要改成 `-p <password>`。
  return execFileSync('sshpass', ['-e', 'ssh', ...sshArgs(remoteCommand)], {
    timeout: QUERY_TIMEOUT_MS,
    encoding: 'utf8',
    env: { ...process.env, SSHPASS: SSH_PASSWORD },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const QUERY_GPUS = 'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,'
  + 'memory.total,temperature.gpu --format=csv,noheader,nounits';
const QUERY_PROCS = 'nvidia-smi --query-compute-apps=pid,process_name,used_memory '
  + '--format=csv,noheader,nounits';

function parseGpuLines(out) {
  return out.split('\n').filter(Boolean).map((line) => {
    const [idx, name, util, memUsed, memTotal, temp] = line.split(',').map((s) => s.trim());
    return {
      index: parseInt(idx) || 0,
      name: name || '',
      util: parseFloat(util) || 0,
      memUsed: parseInt(memUsed) || 0,
      memTotal: parseInt(memTotal) || 0,
      temp: parseFloat(temp) || 0,
      processes: [],
    };
  });
}

/**
 * 通过 SSH 查询宿主机 GPU，带进程信息。
 * 未配置凭据、或 SSH 失败时返回 []（调用方据此保持原有回落行为）。
 */
export async function queryHostGpu() {
  if (!isHostGpuSshConfigured()) return [];

  let devices;
  try {
    devices = parseGpuLines(runRemote(QUERY_GPUS));
  } catch {
    return []; // 宿主机不可达或没有 nvidia-smi
  }
  if (devices.length === 0) return [];

  // 进程信息是锦上添花，失败不影响 GPU 基本状态
  try {
    const procMap = new Map();
    for (const line of runRemote(QUERY_PROCS).split('\n').filter(Boolean)) {
      // 该查询不含 gpu_index，全部归入 GPU 0（单卡场景）
      const [pid, name, mem] = line.split(',').map((s) => s.trim());
      const bucket = procMap.get('0') || [];
      bucket.push({ pid: parseInt(pid) || 0, name: name || '', usedMemory: parseInt(mem) || 0 });
      procMap.set('0', bucket);
    }
    for (const device of devices) {
      device.processes = procMap.get(String(device.index)) || [];
    }
  } catch { /* 进程查询失败无所谓 */ }

  return devices;
}

export default { isHostGpuSshConfigured, warnIfUnconfigured, queryHostGpu };
