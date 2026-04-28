/**
 * DocMind 管理器 — 启动/停止 Python FastAPI 服务
 */
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOCMIND_DIR = path.join(__dirname, 'docmind');
const VENV_PYTHON = path.join(DOCMIND_DIR, 'venv', 'bin', 'python3');
const RUN_SCRIPT = path.join(DOCMIND_DIR, 'run.py');
const PID_FILE = path.join(__dirname, '..', 'data', 'docmind.pid');
const DB_DIR = path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DB_DIR, 'docmind_uploads');
const LOG_DIR = path.join(__dirname, '..', 'logs');

let proc = null;

function log(...args) {
  console.log(`[DocMind]`, ...args);
}

function ensureDataDir() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getPid() {
  try {
    if (fs.existsSync(PID_FILE)) {
      return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
    }
  } catch {}
  return null;
}

function savePid(pid) {
  fs.writeFileSync(PID_FILE, String(pid));
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function start() {
  ensureDataDir();
  
  const existingPid = getPid();
  if (existingPid && isRunning(existingPid)) {
    log(`已在运行 (PID ${existingPid})`);
    return;
  }

  // 检查 venv
  if (!fs.existsSync(VENV_PYTHON)) {
    log('⚠️  venv 未找到，尝试创建...');
    try {
      execSync(`python3 -m venv "${DOCMIND_DIR}/venv"`, { cwd: DOCMIND_DIR, stdio: 'pipe' });
      execSync(`"${path.join(DOCMIND_DIR, 'venv', 'bin', 'pip')}" install -q fastapi uvicorn python-multipart pydantic pydantic-settings sqlalchemy aiosqlite python-docx pypdf2 httpx openai anthropic aiofiles httpx-python`,
        { cwd: DOCMIND_DIR, stdio: 'pipe' });
      log('✅ venv 初始化完成');
    } catch (e) {
      log('❌ venv 初始化失败:', e.message);
      return;
    }
  }

  const env = { ...process.env };
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';

  proc = spawn(VENV_PYTHON, [RUN_SCRIPT], {
    cwd: DOCMIND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.stdout.on('data', d => process.stdout.write(`[DocMind] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[DocMind ERR] ${d}`));

  proc.on('error', err => log('启动失败:', err.message));
  proc.on('exit', (code, sig) => {
    log(`进程退出 (${code}/${sig})`);
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  });

  savePid(proc.pid);
  log(`🚀 已启动 (PID ${proc.pid})，监听 localhost:8000`);
}

export function stop() {
  const pid = getPid();
  if (!pid) { log('未运行'); return; }
  try {
    process.kill(pid, 'SIGTERM');
    log(`已停止 PID ${pid}`);
  } catch (e) {
    log('停止失败:', e.message);
  }
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
}

export function status() {
  const pid = getPid();
  if (pid && isRunning(pid)) {
    return { running: true, pid };
  }
  return { running: false };
}

// 自动启动
start();