/**
 * OpenLog API 冒烟测试
 * 覆盖 20 个核心路由 200 + 3 个参数校验 400
 * 通过子进程启动 server，用 node fetch 测试
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3098;
const BASE = `http://localhost:${PORT}`;

let serverProc;

// ── 辅助函数 ──────────────────────────────────────────────────
async function get(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { method: 'GET', ...opts });
  return res;
}

async function post(path, body, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(body),
    ...opts,
  });
  return res;
}

async function put(path, body, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(body),
    ...opts,
  });
  return res;
}

async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  return res;
}

// ── 启动 / 关闭 Server ────────────────────────────────────────
beforeAll(async () => {
  serverProc = spawn('node', ['server/index.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // 收集启动日志用于排查
  let startupLog = '';
  serverProc.stdout.on('data', (d) => { startupLog += d.toString(); });
  serverProc.stderr.on('data', (d) => { startupLog += d.toString(); });

  // 轮询等待 server 就绪
  const maxWait = 30000;
  const start = Date.now();
  let ready = false;

  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${BASE}/api/logs`);
      if (res.status === 200) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!ready) {
    console.error('Server 启动日志:\n', startupLog);
    throw new Error(`Server 未能在 ${maxWait}ms 内就绪`);
  }
}, 45000);

afterAll(() => {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    // 确保子进程被清理
    setTimeout(() => {
      try { serverProc.kill('SIGKILL'); } catch {}
    }, 3000);
  }
});

// ═══════════════════════════════════════════════════════════════
// 20 个核心路由 — 返回 200
// ═══════════════════════════════════════════════════════════════

describe('核心路由 200 冒烟测试', () => {

  describe('日志模块 (logs)', () => {
    it('GET /api/logs — 返回日志列表', async () => {
      const res = await get('/api/logs');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('logs');
      expect(Array.isArray(data.logs)).toBe(true);
    });

    it('GET /api/logs/history — 返回持久化日志', async () => {
      const res = await get('/api/logs/history');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('logs');
    });

    it('GET /api/logs/files — 返回日志文件列表', async () => {
      const res = await get('/api/logs/files');
      expect(res.status).toBe(200);
    });
  });

  describe('监控模块 (monitor)', () => {
    it('GET /api/monitor/stats — 返回系统状态', async () => {
      const res = await get('/api/monitor/stats');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('cpu');
      expect(data).toHaveProperty('memory');
    });

    it('GET /api/monitor/history — 返回监控历史', async () => {
      const res = await get('/api/monitor/history');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('设置模块 (settings)', () => {
    it('GET /api/settings — 返回当前设置', async () => {
      const res = await get('/api/settings');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('model');
    });

    it('PUT /api/settings — 更新设置', async () => {
      const res = await put('/api/settings', { refreshInterval: '5000' });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });

  describe('技能模块 (skills)', () => {
    it('GET /api/skills — 返回技能列表', async () => {
      const res = await get('/api/skills');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('skills');
    });
  });

  describe('告警模块 (alerts)', () => {
    it('GET /api/alerts — 返回告警配置', async () => {
      const res = await get('/api/alerts');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('configs');
    });
  });

  describe('远程服务器模块 (remote)', () => {
    it('GET /api/remote/servers — 返回远程服务器列表', async () => {
      const res = await get('/api/remote/servers');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('servers');
    });
  });

  describe('机器管理模块 (machines)', () => {
    it('GET /api/machines — 返回机器列表', async () => {
      const res = await get('/api/machines');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('machines');
    });
  });

  describe('分析模块 (analysis)', () => {
    it('GET /api/analysis/status — 返回分析队列状态', async () => {
      const res = await get('/api/analysis/status');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('queues');
    });

    it('GET /api/analysis/history — 返回分析历史', async () => {
      const res = await get('/api/analysis/history');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('records');
    });

    it('GET /api/analysis/history/brief — 返回分析摘要', async () => {
      const res = await get('/api/analysis/history/brief');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('records');
    });
  });

  describe('助手内存模块 (assistant)', () => {
    it('GET /api/assistant/memory — 返回助手内存文件', async () => {
      const res = await get('/api/assistant/memory');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('files');
    });
  });

  describe('Docker 模块 (docker)', () => {
    it('GET /api/docker/patrol — 返回巡检缓存', async () => {
      const res = await get('/api/docker/patrol');
      expect(res.status).toBe(200);
    });

    it('GET /api/docker/patrol/last — 返回最后一次巡检', async () => {
      const res = await get('/api/docker/patrol/last');
      expect(res.status).toBe(200);
    });

    it('POST /api/docker/patrol/reset — 重置巡检检查点', async () => {
      const res = await post('/api/docker/patrol/reset', {});
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });

  describe('GPU 模块 (gpu)', () => {
    it('GET /api/gpu/configs — 返回 GPU 配置', async () => {
      const res = await get('/api/gpu/configs');
      expect(res.status).toBe(200);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 3 个参数校验 — 返回 400
// ═══════════════════════════════════════════════════════════════

describe('参数校验 400 测试', () => {
  it('POST /api/skills — 缺少 name 字段应返回 400', async () => {
    const res = await post('/api/skills', { command: 'test' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('POST /api/chat — 缺少 messages 应返回 400', async () => {
    const res = await post('/api/chat', {});
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('PUT /api/alerts — 缺少 machine_id 应返回 400', async () => {
    const res = await put('/api/alerts', { enabled: true });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});
