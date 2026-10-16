/**
 * 安全回归测试
 *
 * 这些用例把已修复的漏洞钉死，防止回归。每一条都对应一次真实发现的问题：
 *   1. 生产环境鉴权旁路（回环地址免鉴权 / X-Forwarded-For 伪造）
 *   2. WebSocket 零鉴权（四个 /ws 路径）
 *   3. 命令白名单绕过导致的任意命令执行（awk system()/find -exec/sed -i/sort -o …）
 *   4. 明文凭据端点
 *   5. 导出接口泄漏密码
 *
 * 服务以 NODE_ENV=production 启动，因此【没有】回环免鉴权后门 —— 这正是要测的。
 * 数据目录由 vitest.config.js 隔离到 /tmp，不会碰到生产库。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 递归列出 server/ 下的 .js 文件（跳过 __tests__）。 */
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const TOKEN = 'security-regression-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

/** 启动一个生产模式服务并等待就绪；返回 { proc, port } */
async function startServer({ port, extraEnv = {} }) {
  const proc = spawn('node', ['server/index.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      OPENLOG_TOKEN: TOKEN,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let log = '';
  proc.stdout.on('data', (d) => { log += d.toString(); });
  proc.stderr.on('data', (d) => { log += d.toString(); });

  // /api/auth/token 是公开路径，用就绪探测最稳（不受鉴权影响）。
  //
  // 但"端口上有东西应答"不等于"那是我们启动的服务"：如果端口被别的进程占着，
  // 新服务会 EADDRINUSE 直接退出，而探测会命中那个**陌生**服务并成功返回 200。
  // 随后所有带 token 的断言都会莫名其妙地 401（曾真实发生过：一个手工起的
  // 验收服务占着 30971，整套测试跑在了它上面）。
  // 所以这里必须核对拿到的 token 就是本次 spawn 传进去的那个。
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/token`);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.token === TOKEN) return { proc, port };
        // 端口被占用：有别的服务在应答，且它不是我们起的
        try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
        throw new Error(
          `端口 ${port} 上应答的服务不是本次启动的实例`
          + `（期望 token=${TOKEN}，实际=${String(body.token).slice(0, 12)}…）。`
          + `多半是该端口已被其他进程占用，本测试进程启动的服务因 EADDRINUSE 退出了。\n`
          + `子进程日志:\n${log}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('应答的服务不是本次启动的实例')) throw err;
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
  throw new Error(`服务未能在 30s 内就绪:\n${log}`);
}

function stopServer(proc) {
  if (!proc) return;
  try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* 已退出 */ } }, 3000).unref?.();
}

/** 用 ws 客户端探测 WebSocket 握手结果：返回 HTTP 状态码或 101 */
function wsHandshake(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const done = (value) => { try { socket.terminate(); } catch { /* 已关闭 */ } resolve(value); };
    const timer = setTimeout(() => done('TIMEOUT'), 5000);
    socket.on('open', () => { clearTimeout(timer); try { socket.close(); } catch { /* ignore */ } resolve(101); });
    socket.on('unexpected-response', (_req, res) => { clearTimeout(timer); done(res.statusCode); });
    socket.on('error', () => { clearTimeout(timer); done('ERROR'); });
  });
}

// ═══════════════════════════════════════════════════════════════════
// 默认配置：远程执行关闭
// ═══════════════════════════════════════════════════════════════════

describe('安全回归 — 默认配置（OPENLOG_ENABLE_REMOTE_EXEC 未设置）', () => {
  const PORT = 30971;
  const BASE = `http://127.0.0.1:${PORT}`;
  let proc;

  beforeAll(async () => { ({ proc } = await startServer({ port: PORT })); }, 45000);
  afterAll(() => stopServer(proc));

  describe('HTTP 鉴权', () => {
    it('无 token → 401', async () => {
      expect((await fetch(`${BASE}/api/settings`)).status).toBe(401);
    });

    it('有效 token → 200', async () => {
      expect((await fetch(`${BASE}/api/settings`, { headers: AUTH })).status).toBe(200);
    });

    it('拒绝 ?token= 查询串（会泄漏进浏览器历史/代理日志）', async () => {
      const res = await fetch(`${BASE}/api/settings?token=${TOKEN}`);
      expect(res.status).toBe(401);
    });

    it('拒绝空 Bearer 与错误长度的 token', async () => {
      for (const bad of ['', 'Bearer ', 'Bearer wrong', 'Bearer x'.repeat(50)]) {
        const res = await fetch(`${BASE}/api/settings`, { headers: { Authorization: bad } });
        expect(res.status, `Authorization: ${JSON.stringify(bad)}`).toBe(401);
      }
    });

    it('X-Forwarded-For 伪造回环地址无法绕过', async () => {
      const res = await fetch(`${BASE}/api/settings`, {
        headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('CORS 来源白名单', () => {
    it('恶意来源不回显 ACAO', async () => {
      for (const origin of ['http://evil.example', 'http://localhost.evil.com', 'null']) {
        const res = await fetch(`${BASE}/api/settings`, { headers: { ...AUTH, Origin: origin } });
        expect(res.headers.get('access-control-allow-origin'), origin).toBeNull();
      }
    });

    it('IPv6 回环来源被正确接受（曾被带方括号的 hostname 判定误拒）', async () => {
      const res = await fetch(`${BASE}/api/settings`, {
        headers: { ...AUTH, Origin: 'http://[::1]:3011' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('http://[::1]:3011');
    });
  });

  describe('WebSocket 鉴权', () => {
    const paths = ['/ws', '/ws/shell/any-id', '/ws/aishell/any-id', '/ws/docker/logs/local/any-id'];

    it('无 token 的握手全部被 401 拒绝', async () => {
      for (const p of paths) {
        expect(await wsHandshake(`ws://127.0.0.1:${PORT}${p}`), p).toBe(401);
      }
    });

    it('带正确 ?token= 的握手成功升级到 101', async () => {
      for (const p of paths) {
        expect(await wsHandshake(`ws://127.0.0.1:${PORT}${p}?token=${TOKEN}`), p).toBe(101);
      }
    });
  });

  describe('远程命令执行端点默认关闭', () => {
    const ID = 'nonexistent-server-id';
    const post = (p, body) => fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    it('三个端点即使持有有效 token 也返回 403', async () => {
      expect((await post(`/api/remote/servers/${ID}/exec`, { command: 'ls' })).status).toBe(403);
      expect((await post(`/api/remote/servers/${ID}/shell`, { command: 'ls' })).status).toBe(403);
      expect((await post(`/api/remote/${ID}/aishell`, { prompt: 'ls' })).status).toBe(403);
    });

    it('闸门是最先执行的语句（返回的是「默认禁用」而非元字符错误）', async () => {
      const res = await post(`/api/remote/servers/${ID}/shell`, { command: 'ls; id' });
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toMatch(/OPENLOG_ENABLE_REMOTE_EXEC/);
    });

    it('无 token 时同样被鉴权拦在前面', async () => {
      const res = await fetch(`${BASE}/api/remote/servers/${ID}/shell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'ls' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('凭据不外泄', () => {
    it('明文密码端点已不存在', async () => {
      const res = await fetch(`${BASE}/api/remote/servers/any-id/password`, { headers: AUTH });
      expect(res.status).toBe(404);
    });

    it('导出接口不含 password 字段', async () => {
      const res = await fetch(`${BASE}/api/remote/export`, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toMatch(/password/i);
      expect(body).not.toMatch(/privateKey/i);
    });

    it('设置接口中的 API Key 以脱敏形式返回', async () => {
      const res = await fetch(`${BASE}/api/settings`, { headers: AUTH });
      const body = JSON.stringify(await res.json());
      // 脱敏形如 abcd***wxyz，不能出现完整密钥
      expect(body).not.toMatch(/"openaiApiKey":"[^*"]{20,}"/);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 显式开启远程执行：白名单之外的命令仍然被拒
// ═══════════════════════════════════════════════════════════════════

describe('安全回归 — 显式开启 OPENLOG_ENABLE_REMOTE_EXEC=1', () => {
  const PORT = 30972;
  const BASE = `http://127.0.0.1:${PORT}`;
  const ID = 'nonexistent-server-id';
  let proc;

  beforeAll(async () => {
    ({ proc } = await startServer({ port: PORT, extraEnv: { OPENLOG_ENABLE_REMOTE_EXEC: '1' } }));
  }, 45000);
  afterAll(() => stopServer(proc));

  const shell = (command) => fetch(`${BASE}/api/remote/servers/${ID}/shell`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });

  // 每一条都是曾在旧白名单下真实放行（= 任意命令执行或任意文件写入）的载荷
  const DANGEROUS = [
    "find / -exec id {} +",
    'find /tmp -name "*.log" -delete',
    "awk 'BEGIN{system(\"id\")}' /etc/hosts",
    "sed -n '1e id' /etc/hosts",
    'sed -i s/a/b/ /etc/hosts',
    'sort -o /etc/hosts /etc/hosts',
    'uniq /etc/hosts /tmp/out',
    'python3 -c "import os; os.system(\'id\')"',
    'node -e "require(\'child_process\').execSync(\'id\')"',
    'ip link set lo down',
    'journalctl --vacuum-time=1s',
    'dmesg -C',
    'date -s 2020-01-01',
    'hostname pwned',
    'nvidia-smi -pm 1',
    'docker ps',
    'sudo id',
    'xargs -I{} sh -c id',
    'tee /etc/hosts',
  ];

  it('危险命令全部 403', async () => {
    for (const command of DANGEROUS) {
      const res = await shell(command);
      expect(res.status, command).toBe(403);
    }
  });

  it('shell 元字符与命令链接全部 403', async () => {
    for (const command of ['ls; id', 'ls && id', 'ls | id', 'ls `id`', 'ls $(id)', 'ls > /tmp/x', 'ls\nid']) {
      const res = await shell(command);
      expect(res.status, command).toBe(403);
    }
  });

  it('只读白名单内的命令被放行（未连接时是 500，而不是 403）', async () => {
    for (const command of ['ls -la', 'df -h', 'tail -n 50 /var/log/syslog', 'grep ERROR /var/log/app.log']) {
      const res = await shell(command);
      expect(res.status, command).not.toBe(403);
    }
  });

  it('开关只接受精确值 "1"', async () => {
    // 用一个独立端口验证不接受 true/yes/01 等
    for (const value of ['true', 'yes', '01', 'TRUE', '1 ']) {
      const port = 30980 + Math.floor(Math.random() * 15);
      const { proc: p } = await startServer({ port, extraEnv: { OPENLOG_ENABLE_REMOTE_EXEC: value } });
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/remote/servers/${ID}/shell`, {
          method: 'POST',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'ls' }),
        });
        expect(res.status, `OPENLOG_ENABLE_REMOTE_EXEC=${JSON.stringify(value)}`).toBe(403);
      } finally {
        stopServer(p);
      }
    }
  }, 90000);
});

// ═══════════════════════════════════════════════════════════════════
// 凭据卫生 —— 静态扫描源码
//
// 曾经有 4 处把宿主机 SSH 密码明文硬编码在 server/index.js 里，
// 并用 `sshpass -p <password>` 传参（密码会出现在 ps 的进程列表里）。
// 这些用例确保它不会被重新引入。
// ═══════════════════════════════════════════════════════════════════

describe('凭据卫生（静态源码扫描）', () => {
  // 排除 __tests__：本文件自身必须以模式字面量的形式写出这些凭据才能扫描它们
  const sourceFiles = fs.readdirSync(SERVER_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js') && !f.includes('__tests__'))
    .map((f) => path.join(SERVER_DIR, f));

  it('扫描到了服务端源码', () => {
    expect(sourceFiles.length).toBeGreaterThan(5);
  });

  it('没有硬编码的凭据常量', () => {
    // 已知曾被硬编码的凭据，以及常见的口令字面量形态
    const forbidden = [
      /\u0053upremind0717/,
      /\u0073mai123/,
      /sshpass\s+-p\s+['"]?\S/,     // 密码走上 argv
      /password\s*[:=]\s*['"][^'"]{6,}['"]/i,
    ];
    const offenders = [];
    for (const file of sourceFiles) {
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        // 允许在注释里讨论这些反模式
        const hit = text.split('\n').find(
          (line) => pattern.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line),
        );
        if (hit) offenders.push(`${path.relative(PROJECT_ROOT, file)}: ${hit.trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('宿主机 SSH 凭据只从环境变量读取，未配置时功能关闭', async () => {
    const mod = await import('../gpu-host-ssh.js');
    // 测试环境未设置 OPENLOG_GPU_SSH_*，因此应判定为未配置
    expect(mod.isHostGpuSshConfigured()).toBe(false);
    // 未配置时不能返回任何数据（旧实现会拿硬编码凭据去连）
    await expect(mod.queryHostGpu()).resolves.toEqual([]);
  });
});

describe('助手知识库文件名消毒（路径穿越）', () => {
  /**
   * 原实现的 DELETE /api/assistant/memory/:name 直接做
   *   path.join(ASSISTANT_MEMORY_DIR, req.params.name + '.md')
   * 没有任何消毒，因此 name = "../pwned" 会解析到知识库目录之外，
   * 删除任意 .md 文件。下面既验证「危险输入被拦」，也验证
   * 「正常名字的解析结果仍在知识库目录内」。
   */
  const DIR = '/var/lib/openlog/assistant_memory';

  it('消毒结果永远解析在知识库目录内', async () => {
    const { sanitizeMemoryName } = await import('../routes/assistant-memory.js');
    const attacks = [
      '../pwned',
      '../../pwned',
      '..%2Fpwned',
      '....//....//etc/passwd',
      '/etc/passwd',
      '..\\..\\windows\\system32\\x',
      '.',
      '..',
      './../x',
    ];
    for (const raw of attacks) {
      const safe = sanitizeMemoryName(raw);
      if (safe === null) continue; // 直接拒绝也是正确结果
      const resolved = path.resolve(DIR, safe + '.md');
      expect(
        resolved.startsWith(path.resolve(DIR) + path.sep),
        `危险输入 ${JSON.stringify(raw)} 解析到了目录外: ${resolved}`,
      ).toBe(true);
      // 消毒结果里不能残留路径分隔符
      expect(safe).not.toMatch(/[/\\]/);
    }
  });

  it('空名字与纯点号被拒绝', async () => {
    const { sanitizeMemoryName } = await import('../routes/assistant-memory.js');
    for (const raw of ['', '   ', '.', '..', null, undefined]) {
      expect(sanitizeMemoryName(raw)).toBeNull();
    }
  });

  it('正常名字（含中文）保持可读且去掉 .md 后缀', async () => {
    const { sanitizeMemoryName } = await import('../routes/assistant-memory.js');
    expect(sanitizeMemoryName('deploy-notes')).toBe('deploy-notes');
    expect(sanitizeMemoryName('部署记录')).toBe('部署记录');
    expect(sanitizeMemoryName('notes.md')).toBe('notes');
    // 非法字符被替换而不是被丢弃
    expect(sanitizeMemoryName('a/b:c')).toBe('a-b-c');
  });

  it('写入与删除使用同一套消毒规则', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync(new URL('../routes/assistant-memory.js', import.meta.url), 'utf8'),
    );
    // POST 与 DELETE 都必须经过 sanitizeMemoryName
    const uses = src.match(/sanitizeMemoryName\(/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(3); // 1 处定义 + 写入 + 删除
    // 不允许再出现直接拼接 req.params.name 的写法
    expect(src).not.toMatch(/req\.params\.name\s*\+/);
  });
});

describe('回环来源判定（鉴权旁路 + 发放令牌共用同一份）', () => {
  /**
   * 这套判定原先有两份独立副本：index.js 的 isLoopbackAddress()（控制开发模式
   * 鉴权旁路与 WS 升级放行）和 /api/auth/token 路由里的内联判断（控制是否发放令牌）。
   * 两份分叉的代价是直接的安全缺口，现已合并到 security/loopback.js。
   */
  it('判定函数只有一个定义，且被两个调用点共用', () => {
    const files = jsFiles(SERVER_DIR);
    const defRe = /^(?:export\s+)?(?:const|let|function)\s+isLoopbackAddress\b/m;
    const owners = files.filter((f) => defRe.test(fs.readFileSync(f, 'utf8')));
    expect(owners.map((f) => path.relative(SERVER_DIR, f))).toHaveLength(1);
    expect(owners[0]).toContain('security');
  });

  /**
   * 上一条只保证「只有一个函数定义」。把调用点改回内联比较
   * （`ip !== '127.0.0.1'`）时它照样通过 —— 因为没有产生第二个**函数定义**，
   * 但策略其实已经分叉了。
   *
   * 所以这里检查两个调用点都**导入并实际调用**共享函数。
   * 只断言 import 不够：留着 import 却写内联比较同样会漏。
   * 也不能泛泛地禁止字面量 —— index.js 的 CORS 来源判断确实需要一个
   * 独立的 hostname 白名单（它还要处理带方括号的 '[::1]'），那是另一个关注点。
   */
  it('两个调用点都导入并实际调用共享函数，而不是各写一份内联比较', () => {
    for (const rel of ['index.js', 'routes/auth.js']) {
      const src = fs.readFileSync(path.join(SERVER_DIR, rel), 'utf8');
      expect(src, `${rel} 应从 security/loopback.js 导入 isLoopbackAddress`)
        .toMatch(/import\s*\{[^}]*isLoopbackAddress[^}]*\}\s*from\s*'\.\.?\/(?:security\/)?loopback\.js'/);
      expect(src, `${rel} 应实际调用 isLoopbackAddress()，而不是内联比较`)
        .toMatch(/isLoopbackAddress\s*\(/);
    }
  });

  it('本机来源被判定为回环', async () => {
    const { isLoopbackAddress } = await import('../security/loopback.js');
    for (const ok of ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(ok), `${ok} 应判为回环`).toBe(true);
    }
  });

  it('非本机来源被拒，包括「以 ::ffff: 开头但不是回环」的情况', async () => {
    const { isLoopbackAddress } = await import('../security/loopback.js');
    const bad = [
      '8.8.8.8', '192.168.1.10', '100.100.182.242',
      '::ffff:8.8.8.8',          // 剥掉前缀后是 8.8.8.8，不是回环
      '::ffff:192.168.1.1',
      '127.0.0.1.evil.com',      // 前缀匹配会误放行，精确比较不会
      'localhost.evil.com',
      '::ffff:127.0.0.1.evil.com',
      '127.0.0.2',               // 同一 /8 但非 127.0.0.1
      '', undefined, null,
    ];
    for (const addr of bad) {
      expect(isLoopbackAddress(addr), `${addr} 不应判为回环`).toBe(false);
    }
  });
});

describe('敏感文件不得被提交', () => {
  /**
   * 事故背景：`remote-servers.json` 曾被提交 3 次，里面是**base64 编码的明文 SSH 口令**
   * （base64 只是编码，可逆，等同于明文）。涉及 3 台主机、其中 1 台此前不在泄漏清单里。
   * `data/openlog.db` 也进过历史（那两次是空库，未含凭据，属侥幸）。
   *
   * 现在这些路径都在 .gitignore 里且未被跟踪。这个测试防止回退：
   * 只要有人把它们加回暂存区，或者 .gitignore 被改窄，就会红。
   */
  const SENSITIVE = [
    'settings.json',
    'remote-servers.json',
    '.env',
    'data/',
    'data/openlog.db',
    'data/.auth_token',
  ];

  const git = (args) => {
    try {
      return execSync(`git ${args}`, { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      // git ls-files --error-unmatch 在没有匹配时以非 0 退出，这是期望情况
      return err.stdout ?? '';
    }
  };

  it('这些路径都被 git 忽略', () => {
    for (const p of SENSITIVE) {
      // git check-ignore 命中时退出码为 0，未命中为 1
      let ignored = false;
      try {
        execSync(`git check-ignore -q "${p}"`, { cwd: PROJECT_ROOT, stdio: 'ignore' });
        ignored = true;
      } catch {
        ignored = false;
      }
      expect(ignored, `${p} 应被 .gitignore 覆盖`).toBe(true);
    }
  });

  it('这些路径都没有被 git 跟踪', () => {
    const tracked = git('ls-files').split('\n').filter(Boolean);
    for (const p of SENSITIVE) {
      // `.env.example` 是随仓库分发的模板（README 要求 cp 它），不是敏感文件；
      // 但 `.env.local` / `.env.production` 这类会带真实配置，仍必须拦截。
      const hit = tracked.filter((f) => f === p || (f.startsWith(p) && !f.endsWith('.example')));
      expect(hit, `${p} 不应出现在 git 索引中`).toEqual([]);
    }
  });

  it('凭据文件本身不得包含明文口令形态', async () => {
    const file = path.join(PROJECT_ROOT, 'remote-servers.json');
    if (!fs.existsSync(file)) return; // 全新克隆时不存在
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const servers = Array.isArray(parsed) ? parsed : (parsed.servers || []);
    for (const s of servers) {
      const pw = s.password;
      if (!pw) continue;
      // 允许的形态只有 AES-GCM 的 iv:tag:data
      const parts = String(pw).split(':');
      expect(parts.length, `${s.host} 的 password 应为 iv:tag:data 三段式`).toBeGreaterThanOrEqual(3);
      expect(/^[0-9a-f]+$/i.test(parts[0]), `${s.host} 的 iv 段应为 hex`).toBe(true);
      // 不应是可直接 base64 解出可打印字符串的短串
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(pw) && pw.length % 4 === 0) {
        const dec = Buffer.from(pw, 'base64').toString('utf8');
        expect(/^[\x20-\x7e]+$/.test(dec), `${s.host} 的 password 可被 base64 解出明文`).toBe(false);
      }
    }
  });
});

describe('命令安全策略只有一份定义', () => {
  /**
   * 这段策略原先内联在 index.js 的 remote 路由区块里，却被区块之外的
   * docker /exec 路由使用。抽出 remote 路由时若把它一起带走，
   * docker 那条路由会拿到 undefined。现在它住在 security/shell-command-policy.js，
   * 必须保证全项目只有这一份定义 —— 出现第二份就意味着策略分叉，
   * 改了一处、另一处仍是旧的。
   */
  const NAMES = [
    'SHELL_METACHAR_PATTERN', 'hasShellMetaChars', 'REMOTE_EXEC_ENABLED',
    'rejectUnlessRemoteExecEnabled', 'READONLY_COMMANDS', 'commandBaseName',
  ];

  it('每个策略符号在全项目只被定义一次', () => {
    const files = jsFiles(SERVER_DIR);
    for (const name of NAMES) {
      // 必须带 m 标志：^ 默认只匹配整个字符串开头，而这个文件以注释块开头
      const defRe = new RegExp(`^(?:export\\s+)?(?:const|let|function)\\s+${name}\\b`, 'm');
      const owners = files.filter((f) => defRe.test(fs.readFileSync(f, 'utf8')));
      expect(
        owners.map((f) => path.relative(SERVER_DIR, f)),
        `${name} 被定义了 ${owners.length} 次`,
      ).toHaveLength(1);
    }
  });

  it('策略模块导出 index.js 与 remote 路由所需的全部符号', async () => {
    const mod = await import('../security/shell-command-policy.js');
    for (const name of NAMES) {
      expect(mod, `缺少导出 ${name}`).toHaveProperty(name);
    }
    expect(mod.READONLY_COMMANDS).toBeInstanceOf(Array);
    // 有执行/写入逃逸口的命令不能出现在只读白名单里
    for (const dangerous of ['find', 'awk', 'sed', 'sort', 'uniq', 'date', 'hostname', 'dmesg', 'journalctl', 'ip', 'sh', 'bash']) {
      expect(mod.READONLY_COMMANDS, `${dangerous} 不应在只读白名单中`).not.toContain(dangerous);
    }
    // 取命令名要能剥掉路径前缀
    expect(mod.commandBaseName('  /bin/ls -la  ')).toBe('ls');
    expect(mod.hasShellMetaChars('ls; id')).toBe(true);
    expect(mod.hasShellMetaChars('ls -la')).toBe(false);
  });
});
