/**
 * #13 k8s-alerts 单测：server/routes/k8s-alerts.js
 *
 * 真实 express + http.createServer + 原生 fetch（项目惯例，见 db-monitor-route.test.js）。
 * 集群客户端一律注入假实现（`createClient`），时钟注入固定值（`now`）——
 * 这样窗口边界、ack 时间、newEvents 都是可复现的，测试不依赖当前时间。
 *
 * 覆盖两部分：
 *   纯函数 summarizeWarnings / parseWindow —— 聚合口径、排序、窗口、ack、坏数据
 *   路由 —— 200/400/404/502、只读（只打一次 /api/v1/events）、演示模式不连集群
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import {
  createK8sAlertsRouter,
  summarizeWarnings,
  parseWindow,
  resetAlertAcks,
} from '../routes/k8s-alerts.js';

/** 固定「现在」：窗口与 ack 时间都相对它算，避免用例随真实时钟漂移 */
const FIXED_NOW = Date.parse('2026-06-08T10:00:00.000Z');
const HOUR = 3_600_000;
const CLUSTER_ID = 'c-1';

/** 相对 FIXED_NOW 的「N 分钟前」，返回 ISO 字符串（与 normalizeEvents 的 lastSeen 同形） */
function ago(minutes) {
  return new Date(FIXED_NOW - minutes * 60_000).toISOString();
}

/** 最小可解析的 kubeconfig（token 认证 + 自签证书跳过校验） */
const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: ctx
clusters:
  - name: c1
    cluster:
      server: https://127.0.0.1:6443
      insecure-skip-tls-verify: true
contexts:
  - name: ctx
    context:
      cluster: c1
      user: u1
users:
  - name: u1
    user:
      token: test-token
`;

function settingsWith({ id = CLUSTER_ID, kubeconfig = KUBECONFIG } = {}) {
  return { k8sClusters: [{ id, name: '测试集群', kubeconfig, context: '', enabled: true }] };
}

/**
 * 归一化形状的事件（summarizeWarnings 的主要输入）。
 * @param {{reason?:string,count?:number,lastSeen?:string|null,type?:string,object?:string}} [opts]
 */
function ev({ reason = 'BackOff', count = 1, lastSeen = ago(5), type = 'Warning', object = 'Pod/inference/pod-a' } = {}) {
  return { namespace: 'inference', type, reason, object, message: `${reason} on ${object}`, count, lastSeen };
}

/**
 * k8s 原始事件（路由链路里的事件就是这个形状，先经 resources.normalizeEvents）。
 * @param {{reason?:string,count?:number,lastSeen?:string,type?:string,name?:string,namespace?:string,kind?:string}} [opts]
 */
function rawEvent({
  reason = 'BackOff',
  count = 1,
  lastSeen = ago(5),
  type = 'Warning',
  name = 'pod-a',
  namespace = 'inference',
  kind = 'Pod',
} = {}) {
  return {
    type,
    reason,
    count,
    message: `${reason} on ${name}`,
    metadata: { name: `${name}.17f0a1b2c3d4`, namespace, creationTimestamp: lastSeen },
    involvedObject: { kind, namespace, name },
    lastTimestamp: lastSeen,
  };
}

/** 假集群客户端：只有 getJson（本路由契约上只该用它） */
function makeClient(itemsOrError) {
  if (itemsOrError instanceof Error) {
    return { getJson: vi.fn(async () => { throw itemsOrError; }) };
  }
  return { getJson: vi.fn(async () => ({ kind: 'EventList', apiVersion: 'v1', items: itemsOrError })) };
}

/** 起一个真 app（路由自己写全路径，所以直接 app.use，不加前缀） */
async function startApp({ settings = settingsWith(), createClient, now = () => FIXED_NOW } = {}) {
  const app = express();
  app.use(express.json());
  app.use(createK8sAlertsRouter({
    // 演示模式分支也走这里：settings 故意按需给，不影响
    ensureSettings: () => settings,
    createClient,
    now,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

beforeEach(() => {
  resetAlertAcks();
  delete process.env.OPENLOG_DEMO;
});

afterEach(() => {
  delete process.env.OPENLOG_DEMO;
  resetAlertAcks();
});

// ─── 纯函数：summary ──────────────────────────────────────────────────

describe('summarizeWarnings —— 聚合口径', () => {
  it('正常聚合：按 reason 分组，count 累加，objects 去重并按最近出现排序', () => {
    const out = summarizeWarnings([
      ev({ reason: 'BackOff', count: 46, lastSeen: ago(5), object: 'Pod/inference/vllm-canary-0' }),
      ev({ reason: 'BackOff', count: 4, lastSeen: ago(1), object: 'Pod/inference/vllm-canary-1' }),
      ev({ reason: 'FailedScheduling', count: 12, lastSeen: ago(18), object: 'Pod/inference/llama70b-0' }),
    ], { window: '1h', since: FIXED_NOW - HOUR, acks: new Map() });

    expect(out.window).toBe('1h');
    expect(out.since).toBe(new Date(FIXED_NOW - HOUR).toISOString());
    expect(out.byReason.map((g) => g.reason)).toEqual(['BackOff', 'FailedScheduling']);
    expect(out.byReason[0]).toEqual({
      reason: 'BackOff',
      count: 50,
      lastSeen: ago(1),
      objects: ['Pod/inference/vllm-canary-1', 'Pod/inference/vllm-canary-0'],
    });
    expect(out.byReason[1]).toMatchObject({ reason: 'FailedScheduling', count: 12, lastSeen: ago(18) });
    // total 是累计次数（46+4+12），newEvents 是没有 ack 记录的事件条数
    expect(out.total).toBe(62);
    expect(out.newEvents).toBe(3);
  });

  it('count 缺失 / 0 / 负数按 1 条算，字符串数字也能累加', () => {
    const out = summarizeWarnings([
      ev({ reason: 'Unhealthy', count: undefined }),
      ev({ reason: 'Unhealthy', count: 0 }),
      ev({ reason: 'Unhealthy', count: -3 }),
      ev({ reason: 'Unhealthy', count: '7' }),
    ], { since: FIXED_NOW - HOUR });

    expect(out.byReason).toHaveLength(1);
    expect(out.byReason[0].count).toBe(10); // 1 + 1 + 1 + 7
    expect(out.total).toBe(10);
  });

  it('排序：count 降序优先，同 count 按 lastSeen 倒序', () => {
    const out = summarizeWarnings([
      ev({ reason: 'A', count: 2, lastSeen: ago(10) }),
      ev({ reason: 'B', count: 9, lastSeen: ago(50) }),
      ev({ reason: 'C', count: 2, lastSeen: ago(1) }),
    ], { since: FIXED_NOW - HOUR });

    expect(out.byReason.map((g) => g.reason)).toEqual(['B', 'C', 'A']);
  });

  it('最多 20 组，但 total 统计窗口内全部次数（不受截断影响）', () => {
    const events = Array.from({ length: 25 }, (_, i) => ev({
      reason: `Reason${String(i).padStart(2, '0')}`,
      count: 1,
      lastSeen: ago(i + 1),
      object: `Pod/inference/pod-${i}`,
    }));
    const out = summarizeWarnings(events, { since: FIXED_NOW - HOUR });

    expect(out.byReason).toHaveLength(20);
    expect(out.byReason[0].reason).toBe('Reason00');
    expect(out.byReason[19].reason).toBe('Reason19');
    expect(out.total).toBe(25);
  });

  it('window 过滤：since 之前的 Warning 丢弃，之后的保留', () => {
    const out = summarizeWarnings([
      ev({ reason: 'Old', count: 5, lastSeen: ago(90) }),
      ev({ reason: 'Fresh', count: 2, lastSeen: ago(30) }),
    ], { since: FIXED_NOW - HOUR });

    expect(out.byReason.map((g) => g.reason)).toEqual(['Fresh']);
    expect(out.total).toBe(2);
    expect(out.newEvents).toBe(1);
  });

  it('非 Warning（Normal / 缺 type）不进入摘要', () => {
    const out = summarizeWarnings([
      ev({ reason: 'Scheduled', type: 'Normal' }),
      { ...ev({ reason: 'Pulled' }), type: undefined },
      ev({ reason: 'BackOff', count: 3 }),
    ], { since: FIXED_NOW - HOUR });

    expect(out.byReason.map((g) => g.reason)).toEqual(['BackOff']);
    expect(out.total).toBe(3);
  });
});

describe('summarizeWarnings —— ack 与 newEvents', () => {
  it('没有 ack 记录时全部算新；有 ack 时只算 ack 之后出现的', () => {
    const events = [
      ev({ reason: 'BackOff', lastSeen: ago(30), object: 'Pod/inference/a' }),
      ev({ reason: 'BackOff', lastSeen: ago(2), object: 'Pod/inference/b' }),
    ];

    expect(summarizeWarnings(events, { since: FIXED_NOW - HOUR }).newEvents).toBe(2);

    // 20 分钟前已确认：更新的事件才算「新」
    const ackedMs = FIXED_NOW - 20 * 60_000;
    expect(summarizeWarnings(events, { since: FIXED_NOW - HOUR, acks: new Map([['BackOff', ackedMs]]) }).newEvents).toBe(1);
  });

  it('ack 时间晚于所有事件 → newEvents 清零，count/lastSeen 不变', () => {
    const events = [ev({ reason: 'BackOff', count: 46, lastSeen: ago(5) })];
    const before = summarizeWarnings(events, { since: FIXED_NOW - HOUR });
    const after = summarizeWarnings(events, {
      since: FIXED_NOW - HOUR,
      acks: { BackOff: new Date(FIXED_NOW).toISOString() }, // 也支持普通对象形式
    });

    expect(before.newEvents).toBe(1);
    expect(after.newEvents).toBe(0);
    expect(after.total).toBe(before.total);
    expect(after.byReason).toEqual(before.byReason);
  });

  it('ack 只对同一个 reason 生效，其它 reason 仍算新', () => {
    const out = summarizeWarnings([
      ev({ reason: 'BackOff', lastSeen: ago(10) }),
      ev({ reason: 'Unhealthy', lastSeen: ago(10) }),
    ], { since: FIXED_NOW - HOUR, acks: new Map([['BackOff', FIXED_NOW]]) });

    expect(out.newEvents).toBe(1);
    expect(out.byReason.map((g) => g.reason).sort()).toEqual(['BackOff', 'Unhealthy']);
  });
});

describe('summarizeWarnings —— 坏数据不崩', () => {
  it('null / 数字 / 字符串 / 数组 / 空对象混在事件里不影响正常聚合', () => {
    const out = summarizeWarnings([
      null,
      undefined,
      42,
      'nope',
      [],
      {},
      { type: 'Warning' }, // 无 reason、无时间
      { type: 'Warning', reason: '   ', count: 'abc', lastSeen: '不是时间' },
      { type: 'Warning', reason: 'BackOff', count: 2, lastSeen: ago(2), object: 'Pod/inference/ok' },
    ], { since: FIXED_NOW - HOUR });

    // 没填 reason 的两条归到 Unknown
    expect(out.byReason.map((g) => g.reason).sort()).toEqual(['BackOff', 'Unknown']);
    expect(out.total).toBe(4); // Unknown 1+1，BackOff 2
    // 时间坏掉的事件无法证明「在 ack 之后」，不计入 newEvents
    expect(out.newEvents).toBe(1);
    expect(out.byReason.find((g) => g.reason === 'Unknown').lastSeen).toBe(null);
  });

  it('events 不是数组 / 是空对象 → 空摘要而不是抛错', () => {
    for (const input of [undefined, null, {}, 'x', 7, { items: [] }]) {
      const out = summarizeWarnings(input, { since: FIXED_NOW - HOUR });
      expect(out.byReason).toEqual([]);
      expect(out.total).toBe(0);
      expect(out.newEvents).toBe(0);
    }
    // 不传 since 时不做窗口过滤，since 回 null
    expect(summarizeWarnings([ev()]).since).toBe(null);
  });

  it('同时兼容 k8s 原始事件形状（involvedObject / lastTimestamp）', () => {
    const out = summarizeWarnings([
      rawEvent({ reason: 'BackOff', count: 5, lastSeen: ago(3), name: 'canary-0' }),
      rawEvent({ reason: 'FailedScheduling', count: 2, lastSeen: ago(9), name: 'llama70b-0' }),
    ], { since: FIXED_NOW - HOUR });

    expect(out.byReason.map((g) => g.reason)).toEqual(['BackOff', 'FailedScheduling']);
    expect(out.byReason[0].objects).toEqual(['Pod/inference/canary-0']);
    expect(out.total).toBe(7);
  });
});

// ─── 纯函数：window ───────────────────────────────────────────────────

describe('parseWindow', () => {
  it('解析单位并兜底非法值', () => {
    expect(parseWindow('30m')).toEqual({ window: '30m', ms: 1_800_000 });
    expect(parseWindow('1h')).toEqual({ window: '1h', ms: HOUR });
    expect(parseWindow('90s')).toEqual({ window: '90s', ms: 90_000 });
    expect(parseWindow('3600')).toEqual({ window: '3600s', ms: HOUR }); // 纯数字按秒
    expect(parseWindow(['15'])).toEqual({ window: '15s', ms: 15_000 }); // express 重复参数 → 数组
    expect(parseWindow(undefined)).toEqual({ window: '1h', ms: HOUR });
    expect(parseWindow('abc')).toEqual({ window: '1h', ms: HOUR });
    expect(parseWindow('0s')).toEqual({ window: '1h', ms: HOUR });
  });

  it('超大窗口夹到 30 天上限，标签同步改写', () => {
    expect(parseWindow('90d')).toEqual({ window: '30d', ms: 30 * 86_400_000 });
  });
});

// ─── 路由 ─────────────────────────────────────────────────────────────

describe('GET /api/k8s/clusters/:id/warning-digest', () => {
  it('真实路径：只读一次 /api/v1/events，返回契约字段', async () => {
    const items = [
      rawEvent({ reason: 'BackOff', count: 46, lastSeen: ago(5), name: 'vllm-canary-0' }),
      rawEvent({ reason: 'Unhealthy', count: 3, lastSeen: ago(35), name: 'grafana', namespace: 'monitoring' }),
    ];
    const client = makeClient(items);
    const { base, close } = await startApp({ settings: settingsWith(), createClient: () => client });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest?window=1h`);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.window).toBe('1h');
      expect(body.since).toBe(new Date(FIXED_NOW - HOUR).toISOString());
      expect(body.total).toBe(49);
      expect(body.newEvents).toBe(2);
      expect(body.byReason[0]).toEqual({
        reason: 'BackOff',
        count: 46,
        lastSeen: ago(5),
        objects: ['Pod/inference/vllm-canary-0'],
      });

      // 只读：整个请求只碰了事件列表这一个端点，且只有 getJson 一种方法
      expect(client.getJson).toHaveBeenCalledTimes(1);
      expect(client.getJson).toHaveBeenCalledWith('/api/v1/events');
      expect(Object.keys(client)).toEqual(['getJson']);
      expect(body.demo).toBeUndefined();
    } finally { await close(); }
  });

  it('window 参数生效：30m 窗口把 35 分钟前的告警过滤掉', async () => {
    const client = makeClient([
      rawEvent({ reason: 'BackOff', count: 46, lastSeen: ago(5) }),
      rawEvent({ reason: 'Unhealthy', count: 3, lastSeen: ago(35) }),
    ]);
    const { base, close } = await startApp({ createClient: () => client });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest?window=30m`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.window).toBe('30m');
      expect(body.since).toBe(new Date(FIXED_NOW - 1_800_000).toISOString());
      expect(body.byReason.map((g) => g.reason)).toEqual(['BackOff']);
      expect(body.total).toBe(46);
    } finally { await close(); }
  });

  it('集群不存在 → 404，且不创建客户端', async () => {
    const createClient = vi.fn(() => makeClient([]));
    const { base, close } = await startApp({ createClient });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/nope/warning-digest`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toContain('不存在');
      expect(createClient).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it('连不上 kube-apiserver（客户端抛错）→ 502，错误文案不空', async () => {
    const client = makeClient(new Error('connect ECONNREFUSED 127.0.0.1:6443'));
    const { base, close } = await startApp({ createClient: () => client });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest`);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
      expect(body.error).toContain('ECONNREFUSED');
    } finally { await close(); }
  });

  it('kubeconfig 坏掉也算「连不上」→ 502（不是 400，也不是 500）', async () => {
    const createClient = vi.fn(() => makeClient([]));
    const { base, close } = await startApp({
      settings: settingsWith({ kubeconfig: '' }),
      createClient,
    });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest`);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toContain('kubeconfig');
      expect(createClient).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it('事件列表形状异常（items 不是数组）→ 200 空摘要', async () => {
    const client = { getJson: vi.fn(async () => ({ kind: 'EventList', items: 'oops' })) };
    const { base, close } = await startApp({ createClient: () => client });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.byReason).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.newEvents).toBe(0);
    } finally { await close(); }
  });
});

describe('POST /api/k8s/clusters/:id/warning-digest/ack', () => {
  it('记录 ack 时间；随后 GET 的 newEvents 清零', async () => {
    const client = makeClient([rawEvent({ reason: 'BackOff', count: 46, lastSeen: ago(5) })]);
    const { base, close } = await startApp({ createClient: () => client });
    try {
      const before = await (await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest`)).json();
      expect(before.newEvents).toBe(1);

      const ackRes = await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'BackOff' }),
      });
      expect(ackRes.status).toBe(200);
      const acked = await ackRes.json();
      expect(acked).toEqual({ ok: true, ackedAt: new Date(FIXED_NOW).toISOString() });

      const after = await (await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest`)).json();
      expect(after.newEvents).toBe(0);
      expect(after.total).toBe(46); // 累计次数不受 ack 影响
      expect(after.byReason[0].count).toBe(46);
    } finally { await close(); }
  });

  it('ack 只影响同集群同一个 reason', async () => {
    const client = makeClient([
      rawEvent({ reason: 'BackOff', lastSeen: ago(5) }),
      rawEvent({ reason: 'Unhealthy', lastSeen: ago(6) }),
    ]);
    const { base, close } = await startApp({ createClient: () => client });
    try {
      await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'BackOff' }),
      });
      const body = await (await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest`)).json();
      expect(body.newEvents).toBe(1); // 只剩 Unhealthy
    } finally { await close(); }
  });

  it('无 body / body 里没有 reason → 400', async () => {
    const { base, close } = await startApp({ createClient: () => makeClient([]) });
    try {
      const noBody = await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest/ack`, { method: 'POST' });
      expect(noBody.status).toBe(400);
      expect((await noBody.json()).error).toContain('reason');

      const emptyReason = await fetch(`${base}/api/k8s/clusters/${CLUSTER_ID}/warning-digest/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '   ' }),
      });
      expect(emptyReason.status).toBe(400);
    } finally { await close(); }
  });

  it('集群不存在 → 404（ack 也不给写本地状态）', async () => {
    const { base, close } = await startApp({ createClient: () => makeClient([]) });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/nope/warning-digest/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'BackOff' }),
      });
      expect(res.status).toBe(404);
    } finally { await close(); }
  });
});

describe('演示模式（OPENLOG_DEMO=1）', () => {
  it('返回 fixture 风格的空摘要 + demo:true，且完全不连集群', async () => {
    process.env.OPENLOG_DEMO = '1';
    const createClient = vi.fn(() => makeClient([rawEvent({ reason: 'BackOff' })]));
    // kubeconfig 故意给空：只要它试图连集群就会变成 502
    const { base, close } = await startApp({
      settings: settingsWith({ kubeconfig: '' }),
      createClient,
    });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/demo-k3s-infer/warning-digest?window=1h`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.demo).toBe(true);
      expect(body.window).toBe('1h');
      expect(body.since).toBe(new Date(FIXED_NOW - HOUR).toISOString());
      expect(body.byReason).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.newEvents).toBe(0);
      expect(createClient).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it('演示集群 id 不存在 → 404（带 demo 标记）', async () => {
    process.env.OPENLOG_DEMO = '1';
    const { base, close } = await startApp({ createClient: () => makeClient([]) });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/real-prod/warning-digest`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.demo).toBe(true);
      expect(body.error).toContain('不存在');
    } finally { await close(); }
  });

  it('演示模式 ack 只改内存，返回 ok + demo 标记', async () => {
    process.env.OPENLOG_DEMO = '1';
    const { base, close } = await startApp({ createClient: () => makeClient([]) });
    try {
      const res = await fetch(`${base}/api/k8s/clusters/demo-k3s-infer/warning-digest/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'BackOff' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        demo: true,
        ok: true,
        ackedAt: new Date(FIXED_NOW).toISOString(),
      });
    } finally { await close(); }
  });
});

describe('createK8sAlertsRouter 工厂约束', () => {
  it('缺 ensureSettings → 立刻 TypeError（不要挂上去才炸）', () => {
    expect(() => createK8sAlertsRouter()).toThrow(TypeError);
    expect(() => createK8sAlertsRouter({})).toThrow(/ensureSettings/);
  });
});
