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

describe('配置读写（GET/PUT /api/settings）', () => {
  /**
   * 事故背景：`PUT /api/settings` 原本以
   *     res.json({ success: true, settings })
   * 结尾，其中 `settings` 是 index.js 的模块级绑定（let settings = null）。
   * 把这条路由搬到 routes/settings.js 后该绑定不复存在 —— 请求会走完所有副作用、
   * 配置已经写入磁盘，然后在最后一行抛 ReferenceError，返回 500。
   * 前端虽然会提示「保存失败」，配置其实已经改了。这类「副作用成功、响应失败」
   * 的不一致最难排查，所以在这里钉死。
   */
  it('PUT 必须返回 200（副作用已生效，响应不能失败）', async () => {
    const res = await put('/api/settings', { refreshInterval: '6000' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('PUT 的修改真的落到后续 GET 上', async () => {
    await put('/api/settings', { refreshInterval: '6300' });
    const res = await get('/api/settings');
    const data = await res.json();
    expect(data.refreshInterval).toBe('6300');
  });

  /**
   * GET 会脱敏 openaiApiKey，PUT 曾经原样回显整个对象（含明文 key）。
   * 同一个字段在两条路由上两种表现，只要各写一遍脱敏逻辑就一定会再次分叉。
   */
  it('PUT 响应中的 openaiApiKey 必须与 GET 一样脱敏，不得回显明文', async () => {
    const plaintext = 'sk-regression-abcdefghijklmnop';
    const res = await put('/api/settings', { openaiApiKey: plaintext });
    expect(res.status).toBe(200);

    const raw = await res.text();
    expect(raw).not.toContain(plaintext);

    const data = JSON.parse(raw);
    expect(data.settings.openaiApiKey).toContain('***');
    expect(data.settings.openaiApiKey).toMatch(/^sk-r\*\*\*/);

    // GET 也必须给同样的形态
    const getRes = await get('/api/settings');
    const getData = await getRes.json();
    expect(getData.openaiApiKey).toBe(data.settings.openaiApiKey);
  });

  it('带 *** 占位符的敏感值不会被写回配置', async () => {
    // 先放一个已知的真实 key
    const real = 'sk-regression-abcdefghijklmnop';
    await put('/api/settings', { openaiApiKey: real });
    const sanitizedReal = (await (await get('/api/settings')).json()).openaiApiKey;
    expect(sanitizedReal).toBe('sk-r***mnop');

    // 再写回一个**不同**的脱敏字符串。
    // 这里必须用一个与 sanitizedReal 不同的值 —— 否则无论守卫是否生效，
    // 读回来的都是同一个字符串，测试就成了同义反复。
    // （第一版正是用 sanitizedReal 自己写回，把守卫整个删掉它照样通过。）
    await put('/api/settings', { openaiApiKey: 'sk-WRONG***ZZZZ' });

    const after = (await (await get('/api/settings')).json()).openaiApiKey;
    // 守卫生效时真实 key 原封不动，读回来仍是 sk-r***mnop
    expect(after).toBe(sanitizedReal);
    expect(after).not.toContain('WRONG');
    expect(after).not.toContain('ZZZZ');
  });
});

// ──────────────────────────────────────────────────────────────
// API 的 HTTP 语义
// ──────────────────────────────────────────────────────────────
describe('API 的 HTTP 语义', () => {
  describe('未匹配的 API 路径必须返回 JSON，而不是 HTML', () => {
    // 背景：没有 JSON 404 中间件时，Express 默认处理器返回一份 HTML 错误页
    // （<title>Error</title>）。前端 apiFetch 会去 JSON.parse 这段 HTML，
    // 于是「路径写错了」被报成一句莫名其妙的解析错误。
    const CASES = ['/api', '/api/', '/api/nonexistent', '/api/does/not/exist', '/ws', '/ws/'];

    it.each(CASES)('%s 返回 404 + application/json', async (p) => {
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json(); // 解析失败会直接抛错，这本身就是断言
      expect(body.error).toBeTruthy();
      expect(body.error).toContain(p);
    });

    it('错误正文里带上了方法与路径，便于定位', async () => {
      const body = await (await get('/api/nope')).json();
      expect(body.error).toContain('GET');
      expect(body.error).toContain('/api/nope');
    });

    it('不存在的 API 路径不会返回 HTML 文档', async () => {
      const text = await (await get('/api/nope')).text();
      expect(text.toLowerCase()).not.toContain('<!doctype html');
      expect(text.toLowerCase()).not.toContain('<title>error</title>');
    });
  });

  describe('/api 与 /ws 的边界（曾经漏掉不带尾斜杠的写法）', () => {
    // 原实现的 SPA 守卫写的是 startsWith('/api/')，于是 `/api`（无尾斜杠）
    // 不匹配，掉进 SPA 兜底返回 HTML 首页 —— 实测确认过。
    // 现在两端共用 isApiPath()，这里钉住该函数不漏掉裸路径。

    it('裸 /api 被判定为 API 路径', async () => {
      const res = await get('/api');
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    it('裸 /ws 被判定为 API 路径', async () => {
      const res = await get('/ws');
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    it('形近路径不被误判（/apifoo、/api-docs 应走默认处理）', async () => {
      for (const p of ['/apifoo', '/api-docs']) {
        const res = await get(p);
        // 非 API 路径交由 Express 默认 404，正文不是我们那段中文提示
        const text = await res.text();
        expect(text, `${p} 不该被当成 API 路径`).not.toContain('接口不存在');
      }
    });

    it('static: SPA 兜底与 JSON 404 共用 isApiPath，而不是各自内联判断', async () => {
      const fs = await import('fs');
      const src = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'index.js'), 'utf8');
      // 两处都必须调用共享函数
      const calls = src.match(/isApiPath\(req\.path\)/g) || [];
      expect(calls.length, 'SPA 兜底与 JSON 404 都应使用 isApiPath').toBeGreaterThanOrEqual(2);
      // 且不应再残留内联的 startsWith('/api/') 守卫
      expect(src).not.toMatch(/startsWith\('\/api\/'\)\s*\|\|\s*req\.path\.startsWith/);
    });
  });

  describe('docker sourceId 白名单', () => {
    // 原实现找不到源时得到 config = {}，而 getDocker 对空配置默认
    // host=localhost, port=2375 —— 未知 sourceId 会**静默连本机 Docker**。
    it('未知 sourceId 返回 404，并说明是哪个源', async () => {
      const res = await get('/api/docker/containers/__no_such_source__/abc/logs');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('__no_such_source__');
    });

    it('未知 sourceId 不会再回落去连 localhost:2375', async () => {
      const res = await get('/api/docker/containers/__no_such_source__/x');
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain('ECONNREFUSED');
      expect(text).not.toContain('2375');
    });

    it('未知 sourceId 在 trace 路由上也返回 404', async () => {
      const res = await get('/api/docker/trace/__no_such_source__/x');
      expect(res.status).toBe(404);
    });

    it('合法 sourceId（配置里真实存在的那个）不受影响', async () => {
      // 注意：不能从 /api/docker/containers 取 —— 它只列 enabled 的源，
      // 而测试环境的默认源 enabled: false，返回的是 {"sources":[]}。
      // 白名单校验的是「源是否存在」，与 enabled 无关，所以看 settings。
      const settings = await (await get('/api/settings')).json();
      const realId = settings.dockerSources?.[0]?.id;
      expect(realId, '测试环境应至少有一个 docker 源').toBeTruthy();
      // 不该因为白名单而 404 —— 允许连不上（500），但不能是「源不存在」
      const res = await get(`/api/docker/containers/${realId}/__no_container__`);
      expect(res.status).not.toBe(404);
    });

    it('/api/docker/ping 仍可从 body 传任意 config（保存前试连用）', async () => {
      // 这个端点刻意不做 sourceId 白名单，必须保留
      const res = await post('/api/docker/ping', {
        sourceId: '__no_such_source__',
        config: { host: '127.0.0.1', port: 1 },
      });
      expect(res.status).toBe(200);
    });
  });
});

// ──────────────────────────────────────────────────────────────
// 注册顺序回归
// ──────────────────────────────────────────────────────────────
describe('中间件注册顺序', () => {
  /**
   * 踩过的坑：JSON 404 最初被放在 createRemoteRouter 之后，
   * 结果 /api/gpu/* 全部变成 404 —— GPU 路由是单独挂在文件末尾的
   * （`app.use(gpuRouter)`，甚至在 server.listen 之后）。
   *
   * 「最后一个路由挂载」不能靠猜，所以直接静态断言。
   */
  it('JSON 404 中间件必须排在所有路由挂载之后', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'index.js'), 'utf8');
    const lines = src.split('\n');

    const handlerAt = lines.findIndex((l) => l.includes('接口不存在: ${req.method}'));
    expect(handlerAt, '未找到 JSON 404 中间件').toBeGreaterThan(-1);

    // 所有路由挂载：app.use(xxxRouter) / app.use(gpuRouter) 等
    const mounts = [];
    lines.forEach((l, i) => {
      if (/^app\.use\([A-Za-z_$][\w$]*[Rr]outer\b/.test(l.trim()) || /^app\.use\(create\w+Router\(/.test(l.trim())) {
        mounts.push({ line: i, text: l.trim() });
      }
    });
    expect(mounts.length, '应该找到多个路由挂载').toBeGreaterThan(5);

    const after = mounts.filter((m) => m.line > handlerAt);
    expect(
      after.map((m) => `${m.line + 1}: ${m.text}`),
      'JSON 404 之后仍有路由挂载，那些路由会被 404 吞掉'
    ).toEqual([]);
  });

  it('/api/gpu/configs 没有被我挡住（实际请求验证）', async () => {
    const res = await get('/api/gpu/configs');
    expect(res.status).toBe(200);
    expect((await res.json()).configs).toBeDefined();
  });
});
