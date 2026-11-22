/**
 * demo-assistant.test.js —— 演示模式：助手侧最后一批空白面板
 *
 * 覆盖：
 *   读  GET  /api/machines             → server/routes/skills.js
 *       GET  /api/alerts               → server/routes/skills.js
 *       GET  /api/assistant/memory     → server/routes/assistant-memory.js
 *   写  PUT  /api/alerts
 *       POST /api/assistant/memory
 *       DELETE /api/assistant/memory/:name
 *   流  POST /api/chat（演示下固定回复，SSE）
 *
 * 这个文件要证明四件事，少一件演示模式就不算做对：
 *   1. **演示下真实依赖一次都不碰**：`listMachines` / `listAlertConfigs` /
 *      知识库目录的 `fs.readdirSync` / `fs.writeFileSync` / `fs.unlinkSync` /
 *      OpenAI 客户端的 `chat.completions.create` 全部 spy，断言 0 次调用。
 *      演示实例没有真机也没有模型，任何一次「顺手」的真实调用都会在别人机器上
 *      连 SSH、读 /var、或者卡在等模型超时。
 *   2. **形状没被演示数据带歪**：machines 的行是 `listMachines()` 的列
 *      （epoch 秒的 created_at/updated_at、`ssh_user` 而不是 `username`），
 *      alert_configs 的 `enabled` 是 1/0（INTEGER 列）、`patterns` 是一整串，
 *      记忆文件是 `{name, path, content, updatedAt}`（updatedAt 是毫秒）。
 *      形状错了不会立刻报错，只会在真实数据回来时白屏。
 *   3. **写操作必须 409**：演示里「保存成功」是谎言 —— 刷新就没、重启就没。
 *   4. **关掉开关逐字节回到原行为**：真实依赖被调用、响应里没有 `demo` 字段、
 *      写操作真的落库、chat 真的走 LLM 分支。演示的每条 guard 都是「只多不少」。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// ─── 真实依赖打桩（演示模式下应保持 0 次调用）─────────────────────────────

/**
 * LLM 客户端：chat.js 在真实分支里 `await import('openai')` 之后 new 出来用。
 * 演示分支连 import 都不该走到，所以 `create` 必须 0 次 —— 这也是「不连模型」
 * 唯一能被断言的观测点。
 */
const llm = vi.hoisted(() => ({
  create: vi.fn(async () => (async function* () {
    yield { choices: [{ delta: { content: '真实分支：这是模型返回的正文。' } }] };
    yield { choices: [{ delta: {} }] };
  })()),
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    constructor() {
      this.chat = { completions: { create: llm.create } };
    }
  },
}));

vi.mock('../db/index.js', () => ({
  // skills.js 的完整具名导入面：少一个导出，模块链接阶段就会炸
  listSkills: vi.fn(async () => [{ id: 'real-skill', name: '真实技能', command: 'uptime' }]),
  createSkill: vi.fn(async () => {}),
  getSkill: vi.fn(async () => null),
  updateSkill: vi.fn(async () => {}),
  deleteSkill: vi.fn(async () => {}),
  listMachines: vi.fn(async () => ([
    { id: 'real-machine-1', type: 'local', name: '真机', host: '127.0.0.1', port: null, ssh_user: null, log_path: null, created_at: 1, updated_at: 2 },
  ])),
  listAlertConfigs: vi.fn(async () => ([
    { id: 'real-alert-1', machine_id: 'real-machine-1', enabled: 1, patterns: 'real', severity_filter: 'ERROR', cooldown_minutes: 5, webhook_url: '', created_at: 1, updated_at: 2 },
  ])),
  getAlertConfig: vi.fn(async () => null),
  upsertAlertConfig: vi.fn(async () => {}),
}));

import * as db from '../db/index.js';
import skillsRouter from '../routes/skills.js';
import assistantMemoryRouter, { ASSISTANT_MEMORY_DIR } from '../routes/assistant-memory.js';
import createChatRouter from '../routes/chat.js';
import { demoMachines, demoAlertConfigs, demoMemoryFiles, demoChatReply } from '../demo/fixtures-assistant.js';

// ─── 文件系统 spy（知识库读写的真实依赖）───────────────────────────────────
// 用 spyOn 而不是 vi.mock('fs')：真实分支要能照常读写，这里只需要记录次数。
const fsSpies = {
  readdirSync: vi.spyOn(fs, 'readdirSync'),
  writeFileSync: vi.spyOn(fs, 'writeFileSync'),
  unlinkSync: vi.spyOn(fs, 'unlinkSync'),
};

// ─── 助手路由的注入依赖 ────────────────────────────────────────────────────

/** 真实分支用的设置：指向一个没人监听的端口，窗口探测会立刻 ECONNREFUSED 并被忽略 */
const REAL_SETTINGS = {
  openaiApiKey: 'sk-demo-test',
  openaiBaseUrl: 'http://127.0.0.1:59599/v1',
  model: 'demo-test-model',
  thinkingEnabled: false,
  dockerSources: [],
};

const executeAssistantTool = vi.fn(async () => ({ ok: true }));
const buildAssistantContext = vi.fn(() => '（演示上下文）');

const app = express();
app.use(express.json());
app.use(skillsRouter);
app.use(assistantMemoryRouter);
app.use(createChatRouter({
  ensureSettings: () => REAL_SETTINGS,
  buildAssistantContext,
  executeAssistantTool,
}));

let server;
let base;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

/** 统一请求助手：返回 { status, body, contentType, text } */
async function api(pathname, init) {
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text, contentType: res.headers.get('content-type') || '' };
}

const postChat = (messages = [{ role: 'user', content: '为什么 msrk-5 一直 Pending？' }]) =>
  api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages }),
  });

/** 把 SSE 文本解析成事件数组（丢掉 [DONE] 与注释帧） */
function parseSSE(text) {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.replace(/^data:\s?/, '').trim())
    .filter((d) => d && d !== '[DONE]')
    .map((d) => { try { return JSON.parse(d); } catch { return null; } })
    .filter(Boolean);
}

/** SSE 里所有正文增量拼起来（与前端 Assistant.tsx 的 acc 一致） */
const sseText = (text) => parseSSE(text).filter((e) => e.content).map((e) => e.content).join('');

/** 真实依赖的 spy 清单：演示模式下这些必须是 0 次 */
const realSpies = () => [
  db.listMachines, db.listAlertConfigs, db.getAlertConfig, db.upsertAlertConfig,
  fsSpies.readdirSync, fsSpies.writeFileSync, fsSpies.unlinkSync,
  llm.create, executeAssistantTool,
];

function expectNoRealDependencyCalls() {
  const called = realSpies()
    .map((spy, i) => [i, spy?.mock?.calls?.length || 0])
    .filter(([, n]) => n > 0);
  expect(called, `演示模式下不该调用真实依赖（索引→次数）: ${JSON.stringify(called)}`).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════
// 1) 三个读端点：fixture + demo:true + 非空，真实依赖 0 次
// ═════════════════════════════════════════════════════════════
describe('演示模式 · 三个空白列表补上数据', () => {
  beforeEach(() => { vi.stubEnv('OPENLOG_DEMO', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('GET /api/machines — 3 台日志机器，字段与 listMachines() 的行一致', async () => {
    const r = await api('/api/machines');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.machines).toHaveLength(3);

    // 名字与演示服务器一致（远程页面看到的是同一批机器）
    expect(r.body.machines.map((m) => m.name)).toEqual(['4090×4', '4卡T4', '双卡T4']);

    for (const m of r.body.machines) {
      // 列名必须是 machines 表的列，一个不多一个不少
      expect(Object.keys(m).sort()).toEqual([
        'created_at', 'host', 'id', 'log_path', 'name', 'port', 'ssh_user', 'type', 'updated_at',
      ]);
      expect(typeof m.id).toBe('string');
      expect(typeof m.host).toBe('string');
      expect(m.port).toBe(22);
      // 时间列是 epoch 秒（不是毫秒、不是 ISO 串）
      expect(Number.isInteger(m.created_at)).toBe(true);
      expect(Number.isInteger(m.updated_at)).toBe(true);
      expect(m.created_at).toBeLessThan(m.updated_at);
      expect(m.created_at).toBeLessThan(1e11);
    }

    // 确定性：同一端点连打两次，字节级一致
    const again = await api('/api/machines');
    expect(again.body).toEqual(r.body);

    expect(db.listMachines).toHaveBeenCalledTimes(0);
    expectNoRealDependencyCalls();
  });

  it('GET /api/alerts — 三台机器各一条规则，patterns/severity/cooldown/enabled 齐全', async () => {
    const r = await api('/api/alerts');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.configs).toHaveLength(3);

    for (const c of r.body.configs) {
      expect(Object.keys(c).sort()).toEqual([
        'cooldown_minutes', 'created_at', 'enabled', 'id', 'machine_id',
        'patterns', 'severity_filter', 'updated_at', 'webhook_url',
      ]);
      expect(typeof c.patterns).toBe('string');
      expect(c.patterns.length).toBeGreaterThan(0);
      expect(['ERROR', 'WARN', 'INFO']).toContain(c.severity_filter);
      expect(Number.isInteger(c.cooldown_minutes)).toBe(true);
      // INTEGER 列查出来就是 1/0，不是 true/false
      expect([0, 1]).toContain(c.enabled);
    }

    // 每台机器一条：machine_id 必须与 /api/machines 的 id 一致（前端按这个 join）
    const machines = await api('/api/machines');
    expect(r.body.configs.map((c) => c.machine_id).sort())
      .toEqual(machines.body.machines.map((m) => m.id).sort());

    // 用户点名要的那几类模式确实在
    const allPatterns = r.body.configs.map((c) => c.patterns).join(',');
    expect(allPatterns).toContain('OutOfMemoryError');
    expect(allPatterns).toContain('CUDA out of memory');
    expect(allPatterns).toContain('Xid');

    // 至少一条停用（真实运维里断线机器先关规则）
    expect(r.body.configs.some((c) => c.enabled === 0)).toBe(true);

    expect(db.listAlertConfigs).toHaveBeenCalledTimes(0);
    expectNoRealDependencyCalls();
  });

  it('GET /api/assistant/memory — 2~3 个记忆文件，字段照真实返回（updatedAt 是毫秒）', async () => {
    const r = await api('/api/assistant/memory');
    expect(r.status).toBe(200);
    expect(r.body.demo).toBe(true);
    expect(r.body.files.length).toBeGreaterThanOrEqual(2);
    expect(r.body.files.length).toBeLessThanOrEqual(3);

    for (const f of r.body.files) {
      expect(Object.keys(f).sort()).toEqual(['content', 'name', 'path', 'updatedAt']);
      expect(typeof f.name).toBe('string');
      expect(f.name.endsWith('.md')).toBe(false); // 真实返回是去掉后缀的 name
      expect(f.path).toBe(`/srv/openlog/assistant_memory/${f.name}.md`);
      expect(f.content.length).toBeGreaterThan(20);
      // mtimeMs 是毫秒
      expect(f.updatedAt).toBeGreaterThan(1e12);
    }

    // 与真实实现同序：新 → 旧
    const times = r.body.files.map((f) => f.updatedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // 演示实例不该读知识库目录
    expect(fsSpies.readdirSync).toHaveBeenCalledTimes(0);
    expectNoRealDependencyCalls();
  });
});

// ═════════════════════════════════════════════════════════════
// 2) 写操作：一律 409 + DEMO_DISABLED
// ═════════════════════════════════════════════════════════════
describe('演示模式 · 写操作返回 409 DEMO_DISABLED', () => {
  beforeEach(() => { vi.stubEnv('OPENLOG_DEMO', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('PUT /api/alerts — 不查也不写，直接 409', async () => {
    const r = await api('/api/alerts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_id: 'srv-4090-a', enabled: true, patterns: 'Xid',
        severity_filter: 'ERROR', cooldown_minutes: 5,
      }),
    });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ demo: true, error: '演示模式：该操作已被禁用' });
    expect(db.getAlertConfig).toHaveBeenCalledTimes(0);
    expect(db.upsertAlertConfig).toHaveBeenCalledTimes(0);
  });

  it('POST /api/assistant/memory — 不落盘', async () => {
    const r = await api('/api/assistant/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '演示写不进去', content: '# hi' }),
    });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ demo: true, error: '演示模式：该操作已被禁用' });
    expect(fsSpies.writeFileSync).toHaveBeenCalledTimes(0);
  });

  it('DELETE /api/assistant/memory/:name — 不删盘（否则刷新后文件「自己回来」）', async () => {
    const r = await api(`/api/assistant/memory/${encodeURIComponent('值班交接-0608')}`, { method: 'DELETE' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ demo: true, error: '演示模式：该操作已被禁用' });
    expect(fsSpies.unlinkSync).toHaveBeenCalledTimes(0);
  });
});

// ═════════════════════════════════════════════════════════════
// 3) POST /api/chat：固定回复，SSE，不连模型
// ═════════════════════════════════════════════════════════════
describe('演示模式 · POST /api/chat 返回固定演示回复', () => {
  beforeEach(() => { vi.stubEnv('OPENLOG_DEMO', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('200 + SSE，正文显式标注演示、含 [demo] 尾标，LLM 0 次调用', async () => {
    const r = await postChat();

    // 未配模型也不再 400/500 —— 这正是改动前的问题
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/event-stream');
    expect(r.text).toContain('data: [DONE]');

    const text = sseText(r.text);
    expect(text).toBe(demoChatReply());
    // 第一句就说清楚这是演示，不是真答案
    expect(text).toContain('演示模式');
    // 结尾标记：前端只看文本也能识别
    expect(text.trimEnd().endsWith('[demo]')).toBe(true);
    // 用户要求的三条示例结论都在
    expect(text).toContain('reranker-perf/msrk-5');
    expect(text).toContain('FailedScheduling');
    expect(text).toContain('137');
    expect(text).toContain('23.4 / 24 GiB');
    expect(text).toContain('hami-scheduler');

    // 首帧是既有事件类型 provider_notice（前端不改造就能看到提示条）
    const events = parseSSE(r.text);
    const notice = events.find((e) => e.type === 'provider_notice');
    expect(notice).toBeTruthy();
    expect(notice.demo).toBe(true);
    expect(notice.message).toContain('演示模式');

    // 帧格式与真实链路一致：只有 {content} 增量，没有自定义 type
    const customTypes = events
      .filter((e) => e.type && e.type !== 'provider_notice')
      .map((e) => e.type);
    expect(customTypes).toEqual([]);

    // 不连模型、不发工具调用
    expect(llm.create).toHaveBeenCalledTimes(0);
    expect(executeAssistantTool).toHaveBeenCalledTimes(0);
    // 也不读知识库（会话历史/记忆副作用在演示下不落地）
    expect(fsSpies.readdirSync).toHaveBeenCalledTimes(0);
    expect(fsSpies.writeFileSync).toHaveBeenCalledTimes(0);
    expectNoRealDependencyCalls();
  });

  it('确定性：同一问题两次请求，正文逐字节相同', async () => {
    const a = await postChat();
    const b = await postChat();
    expect(sseText(a.text)).toBe(sseText(b.text));
    expect(a.text).toBe(b.text);
  });

  it('不同问题也回同一段（演示不假装按问题推理）', async () => {
    const a = await postChat([{ role: 'user', content: '磁盘满了吗' }]);
    const b = await postChat([{ role: 'user', content: 'GPU 温度正常吗' }]);
    expect(sseText(a.text)).toBe(sseText(b.text));
  });

  it('入参校验保持原样：空 messages 仍然 400（不是被演示分支吃掉）', async () => {
    const r = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('messages required');
    expect(llm.create).toHaveBeenCalledTimes(0);
  });
});

// ═════════════════════════════════════════════════════════════
// 4) 关掉开关：逐字节回到真实分支
// ═════════════════════════════════════════════════════════════
describe('关闭演示模式 · 真实分支照旧', () => {
  beforeEach(() => { vi.stubEnv('OPENLOG_DEMO', '0'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('GET /api/machines — 走 listMachines()，响应里没有 demo 字段', async () => {
    const r = await api('/api/machines');
    expect(r.status).toBe(200);
    expect(db.listMachines).toHaveBeenCalledTimes(1);
    expect(r.body.demo).toBeUndefined();
    expect(r.body.machines).toEqual([
      { id: 'real-machine-1', type: 'local', name: '真机', host: '127.0.0.1', port: null, ssh_user: null, log_path: null, created_at: 1, updated_at: 2 },
    ]);
  });

  it('GET /api/alerts — 走 listAlertConfigs()', async () => {
    const r = await api('/api/alerts');
    expect(r.status).toBe(200);
    expect(db.listAlertConfigs).toHaveBeenCalledTimes(1);
    expect(r.body.demo).toBeUndefined();
    expect(r.body.configs).toHaveLength(1);
    expect(r.body.configs[0].id).toBe('real-alert-1');
  });

  it('GET /api/assistant/memory — 真的读目录', async () => {
    const r = await api('/api/assistant/memory');
    expect(r.status).toBe(200);
    expect(fsSpies.readdirSync).toHaveBeenCalled();
    expect(r.body.demo).toBeUndefined();
    expect(Array.isArray(r.body.files)).toBe(true);
    // 不再返回演示文件（除非磁盘上真有同名文件，那种情况不会出现在干净仓里）
    const demoNames = demoMemoryFiles().map((f) => f.name);
    expect(r.body.files.some((f) => demoNames.includes(f.name))).toBe(false);
  });

  it('PUT /api/alerts — 真的落库', async () => {
    const r = await api('/api/alerts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_id: 'real-machine-1', enabled: true, patterns: 'Xid',
        severity_filter: 'ERROR', cooldown_minutes: 7,
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.demo).toBeUndefined();
    expect(db.getAlertConfig).toHaveBeenCalledWith('real-machine-1');
    expect(db.upsertAlertConfig).toHaveBeenCalledTimes(1);
    expect(db.upsertAlertConfig.mock.calls[0][0]).toMatchObject({ machine_id: 'real-machine-1', cooldown_minutes: 7 });
  });

  it('POST /api/assistant/memory — 真的写盘', async () => {
    const r = await api('/api/assistant/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'demo-test-should-not-exist', content: '# tmp' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.demo).toBeUndefined();
    expect(fsSpies.writeFileSync).toHaveBeenCalledTimes(1);
    // 清理：删掉刚写的临时文件（不留在仓里）
    expect(r.body.name).toBe('demo-test-should-not-exist.md');
    try { fs.unlinkSync(path.join(ASSISTANT_MEMORY_DIR, r.body.name)); } catch { /* 忽略 */ }
    expect(fs.existsSync(path.join(ASSISTANT_MEMORY_DIR, r.body.name))).toBe(false);
  });

  it('POST /api/chat — 走真实 LLM 分支（客户端 create 被调用，正文来自模型）', async () => {
    const r = await postChat();
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/event-stream');
    expect(llm.create).toHaveBeenCalled();

    const text = sseText(r.text);
    expect(text).toContain('真实分支：这是模型返回的正文。');
    expect(text).not.toContain('[demo]');
    expect(text).not.toContain('演示模式');

    // 没走演示分支：不应该出现 provider_notice 的演示提示
    const notice = parseSSE(r.text).find((e) => e.type === 'provider_notice' && e.demo === true);
    expect(notice).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════
// 5) fixture 自身的契约（纯函数、确定性）
// ═════════════════════════════════════════════════════════════
describe('fixtures-assistant 契约', () => {
  it('纯函数：调两次 deepEqual，且调用方 mutate 不污染常量表', () => {
    expect(demoMachines()).toEqual(demoMachines());
    const first = demoMachines();
    first[0].name = '被改了';
    expect(demoMachines()[0].name).toBe('4090×4');

    expect(demoAlertConfigs()).toEqual(demoAlertConfigs());
    expect(demoMemoryFiles()).toEqual(demoMemoryFiles());
    expect(demoChatReply()).toBe(demoChatReply());
  });
});
