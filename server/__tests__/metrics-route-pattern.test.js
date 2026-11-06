import { describe, it, expect } from 'vitest';
import {
  normalizeRoutePath,
  shouldSkipPath,
  MAX_ROUTES,
} from '../metrics/route-pattern.js';

/**
 * 样本全部抄自真实路由表 `server/routes/*.js`（docker.js / remote.js / analysis.js /
 * monitor.js / gpu.js / logs.js / skills.js / auth.js / settings.js / models.js），
 * 只把 `:param` 换成线上真实存在的值形态。
 */
const REAL_SAMPLES = [
  // server/routes/docker.js
  ['/api/docker/containers/local/4b53b00c8d2f1448d96a89b9ade4bc43/files', '/api/docker/containers/:sourceId/:containerId/files'],
  ['/api/docker/containers/local/4b53b00c8d2f1448d96a89b9ade4bc43/logs', '/api/docker/containers/:sourceId/:containerId/logs'],
  ['/api/docker/containers/local/4b53b00c8d2f1448d96a89b9ade4bc43/exec', '/api/docker/containers/:sourceId/:containerId/exec'],
  ['/api/docker/trace/local/4b53b00c8d2f1448d96a89b9ade4bc43', '/api/docker/trace/:sourceId/:containerId'],
  ['/api/docker/container/local/4b53b00c8d2f1448d96a89b9ade4bc43/analyze', '/api/docker/container/:sourceId/:containerId/analyze'],
  ['/api/docker/container/local/4b53b00c8d2f1448d96a89b9ade4bc43/diagnose', '/api/docker/container/:sourceId/:containerId/diagnose'],
  ['/api/docker/1/4b53b00c8d2f1448d96a89b9ade4bc43/restart', '/api/docker/:sourceId/:containerId/restart'],
  ['/api/docker/logs/batch', '/api/docker/logs/batch'],
  ['/api/docker/patrol/now', '/api/docker/patrol/now'],
  ['/api/docker/ping', '/api/docker/ping'],
  // server/routes/remote.js
  ['/api/remote/servers/3dcc7300-0fb0-4bf3-a1f3-4d1f547b88c6/files', '/api/remote/servers/:id/files'],
  ['/api/remote/servers/3dcc7300-0fb0-4bf3-a1f3-4d1f547b88c6/file/upload/init', '/api/remote/servers/:id/file/upload/init'],
  ['/api/remote/servers/3dcc7300-0fb0-4bf3-a1f3-4d1f547b88c6/file/read', '/api/remote/servers/:id/file/read'],
  ['/api/remote/servers/3dcc7300-0fb0-4bf3-a1f3-4d1f547b88c6/stats', '/api/remote/servers/:id/stats'],
  ['/api/remote/servers/stats', '/api/remote/servers/stats'],
  ['/api/remote/servers/batch/connect', '/api/remote/servers/batch/connect'],
  ['/api/remote/servers/203.0.113.10/stats', '/api/remote/servers/:host/stats'],
  ['/api/remote/3dcc7300-0fb0-4bf3-a1f3-4d1f547b88c6/aishell', '/api/remote/:id/aishell'],
  // server/routes/analysis.js / logs.js / skills.js
  ['/api/analysis/history/42', '/api/analysis/history/:id'],
  ['/api/analysis/history/brief', '/api/analysis/history/brief'],
  ['/api/logs/history', '/api/logs/history'],
  ['/api/logs/files', '/api/logs/files'],
  ['/api/skills/7', '/api/skills/:id'],
  // server/routes/monitor.js / db-info.js / gpu.js / settings.js / auth.js / models.js
  ['/api/monitor/stats', '/api/monitor/stats'],
  ['/api/monitor/db/history', '/api/monitor/db/history'],
  ['/api/db/info', '/api/db/info'],
  ['/api/gpu/remote-server/3', '/api/gpu/remote-server/:id'],
  ['/api/gpu/configs', '/api/gpu/configs'],
  ['/api/settings', '/api/settings'],
  ['/api/auth/token', '/api/auth/token'],
  ['/api/models/ollama', '/api/models/ollama'],
  // server/index.js 的 websocket 端点
  ['/ws/shell/3dcc7300-0fb0-4bf3-a1f3-4d1f547b88c6', '/ws/shell/:id'],
  ['/ws/aishell/3dcc7300-0fb0-4bf3-a1f3-4d1f547b88c6', '/ws/aishell/:id'],
  ['/ws/docker/logs/local/4b53b00c8d2f1448d96a89b9ade4bc43', '/ws/docker/logs/:sourceId/:containerId'],
];

const UUID_A = '3dcc7300-0fb0-4bf3-a1f3-4d1f547b88c6';
const UUID_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('normalizeRoutePath —— 真实路由样本（≥20 条）', () => {
  it('样本表至少 20 条', () => {
    expect(REAL_SAMPLES.length).toBeGreaterThanOrEqual(20);
  });

  for (const [input, expected] of REAL_SAMPLES) {
    it(`${input} -> ${expected}`, () => {
      expect(normalizeRoutePath(input)).toBe(expected);
    });
  }
});

describe('normalizeRoutePath —— 基数控制核心断言', () => {
  it('同一个 uuid 换成另一个 uuid，归一化结果必须完全相同', () => {
    const pairs = [
      `/api/remote/servers/${UUID_A}/files`,
      `/api/remote/servers/${UUID_A}/file/upload/chunk`,
      `/api/remote/${UUID_A}/aishell`,
      `/ws/shell/${UUID_A}`,
    ];
    for (const a of pairs) {
      const b = a.split(UUID_A).join(UUID_B);
      expect(b).not.toBe(a);
      expect(normalizeRoutePath(a)).toBe(normalizeRoutePath(b));
    }
  });

  it('容器 id 换成另一个容器 id，结果也完全相同', () => {
    const a = '/api/docker/containers/local/4b53b00c8d2f1448d96a89b9ade4bc43/files';
    const b = '/api/docker/containers/remote-2/ffffffffffffffffffffffffffffffff/files';
    expect(normalizeRoutePath(a)).toBe(normalizeRoutePath(b));
  });

  it('500 个不同 uuid 的路径，归一化后 distinct 结果必须是 1', () => {
    const set = new Set();
    for (let i = 0; i < 500; i += 1) {
      const uuid = [
        i.toString(16).padStart(8, '0'),
        (i * 7 + 1).toString(16).padStart(4, '0').slice(0, 4),
        '4bf3',
        'a1f3',
        (i * 131 + 9).toString(16).padStart(12, '0').slice(0, 12),
      ].join('-');
      set.add(normalizeRoutePath(`/api/remote/servers/${uuid}/files`));
    }
    expect(set.size).toBe(1);
    expect([...set][0]).toBe('/api/remote/servers/:id/files');
  });

  it('500 个不同容器 id + 数字主键混排，distinct 也是 1', () => {
    const set = new Set();
    for (let i = 0; i < 500; i += 1) {
      const hex = i.toString(16).padStart(32, 'a');
      set.add(normalizeRoutePath(`/api/docker/containers/local/${hex}/logs`));
      set.add(normalizeRoutePath(`/api/skills/${i + 1}`));
    }
    // 两条模板：容器日志一条 + skills/:id 一条
    expect(set.size).toBe(2);
    expect(set.has('/api/docker/containers/:sourceId/:containerId/logs')).toBe(true);
    expect(set.has('/api/skills/:id')).toBe(true);
  });

  it('纯 hex（24 位以上）、短 hex（12-23 位）都收进 :id', () => {
    expect(normalizeRoutePath('/api/x/4b53b00c8d2f1448d96a89b9ade4bc43')).toBe('/api/x/:id');
    expect(normalizeRoutePath('/api/x/4b53b00c8d2f')).toBe('/api/x/:id');
  });

  it('随机长 token（>40 且无常见词）收进 :id', () => {
    const token = 'Zx9_Qw8-Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8Vc7Xz6Qw5Er4Ty3Ui2Op1As0';
    expect(token.length).toBeGreaterThan(40);
    expect(normalizeRoutePath(`/api/x/${token}`)).toBe('/api/x/:id');
  });

  it('语义段（history / files / brief）原样保留', () => {
    expect(normalizeRoutePath('/api/monitor/db/history')).toBe('/api/monitor/db/history');
    expect(normalizeRoutePath('/api/remote/servers/stats')).toBe('/api/remote/servers/stats');
  });

  it('域名样式：/servers/ 之后用 :host，其它位置用 :id', () => {
    expect(normalizeRoutePath('/api/remote/servers/example.com/files')).toBe('/api/remote/servers/:host/files');
    expect(normalizeRoutePath('/api/gpu/probe/example.com')).toBe('/api/gpu/probe/:id');
    expect(normalizeRoutePath('/api/remote/servers/203.0.113.10/stats')).toBe('/api/remote/servers/:host/stats');
  });

  it('中文等非 ASCII 段原样保留', () => {
    expect(normalizeRoutePath('/api/assistant/memory/巡检结论')).toBe('/api/assistant/memory/巡检结论');
  });
});

describe('normalizeRoutePath —— query / fragment 丢弃', () => {
  it('?token=secret 不能出现在结果里', () => {
    const out = normalizeRoutePath('/api/logs/history?token=secret&limit=10');
    expect(out).toBe('/api/logs/history');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('?');
  });

  it('uuid 后面带 query 也能归一', () => {
    expect(normalizeRoutePath(`/api/remote/servers/${UUID_A}/files?token=abc&path=/root`))
      .toBe('/api/remote/servers/:id/files');
  });

  it('fragment 被丢弃', () => {
    expect(normalizeRoutePath('/api/settings#section-2')).toBe('/api/settings');
  });
});

describe('normalizeRoutePath —— 尾部斜杠 / 空路径', () => {
  it("'' 与 '/' 都回到根", () => {
    expect(normalizeRoutePath('')).toBe('/');
    expect(normalizeRoutePath('/')).toBe('/');
  });

  it("'///' 回到根", () => {
    expect(normalizeRoutePath('///')).toBe('/');
  });

  it('尾部斜杠被去掉', () => {
    expect(normalizeRoutePath('/api/settings/')).toBe('/api/settings');
    expect(normalizeRoutePath('/api/docker/containers/')).toBe('/api/docker/containers');
  });

  it('中间的空段被压掉', () => {
    expect(normalizeRoutePath('/api//docker///ping')).toBe('/api/docker/ping');
  });
});

describe('normalizeRoutePath —— 异常输入不崩 + 截断', () => {
  it('5KB 随机串不抛异常', () => {
    const junk = Array.from({ length: 5000 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[i % 36]).join('');
    expect(() => normalizeRoutePath(`/api/${junk}`)).not.toThrow();
    const out = normalizeRoutePath(`/api/${junk}`);
    expect(typeof out).toBe('string');
    expect(out.startsWith('/api/')).toBe(true);
  });

  it('非字符串输入不崩', () => {
    expect(normalizeRoutePath(null)).toBe('/');
    expect(normalizeRoutePath(undefined)).toBe('/');
    expect(normalizeRoutePath(123)).toBe('/');
    expect(normalizeRoutePath({})).toBe('/');
  });

  it('超长路径被截断并追加 /__truncated__', () => {
    const long = `/api/${Array.from({ length: 40 }, () => 'history').join('/')}`;
    const out = normalizeRoutePath(long);
    expect(long.length).toBeGreaterThan(200);
    expect(out.endsWith('/__truncated__')).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });
});

describe('shouldSkipPath —— 静态资源', () => {
  const skipped = [
    '/assets/index-8f3a2b.js',
    '/static/css/app.css',
    '/main.js',
    '/app.css',
    '/vendor.js.map',
    '/logo.png',
    '/icons/state.svg',
    '/favicon.ico',
    '/favicon.svg',
    '/__vite/client',
    '/__vite_ping',
    '/fonts/inter.woff',
    '/assets/index-8f3a2b.js?v=3',
  ];
  for (const p of skipped) {
    it(`跳过 ${p}`, () => {
      expect(shouldSkipPath(p)).toBe(true);
    });
  }

  const kept = [
    '/api/docker/containers/local/4b53b00c8d2f1448d96a89b9ade4bc43/files',
    '/api/monitor/stats',
    '/api/monitor/db/history',
    '/ws/shell/' + UUID_A,
    '/ws',
  ];
  for (const p of kept) {
    it(`保留 ${p}`, () => {
      expect(shouldSkipPath(p)).toBe(false);
    });
  }
});

describe('shouldSkipPath —— SPA 路由（非 /api 非 /ws）', () => {
  for (const p of ['/', '/docker', '/settings', '/monitor', '/chat/123', '/login', '/index.html']) {
    it(`跳过 SPA 路由 ${p}`, () => {
      expect(shouldSkipPath(p)).toBe(true);
    });
  }

  it('空/非字符串视为跳过', () => {
    expect(shouldSkipPath('')).toBe(true);
    expect(shouldSkipPath(null)).toBe(true);
    expect(shouldSkipPath(undefined)).toBe(true);
  });
});

describe('MAX_ROUTES', () => {
  it('等于契约值 300', () => {
    expect(MAX_ROUTES).toBe(300);
  });
});
