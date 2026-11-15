import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createNotifier, buildWebhookPayload, toAlertmanagerAlert,
  alertInstanceKey, splitByState, receiverId, NOTIFY_KIND,
} from '../tsdb/notify.js';

const T0 = 1_700_000_000_000;

const mkAlert = (over = {}) => ({
  name: 'HighCPU',
  labels: { instance: 'a', job: 'node' },
  annotations: { summary: 'CPU 高' },
  value: 0.95,
  state: 'firing',
  activeAt: T0,
  ...over,
});

describe('Alertmanager 兼容格式', () => {
  it('单条告警转成标准形状', () => {
    const a = toAlertmanagerAlert(mkAlert());
    expect(a.status).toBe('firing');
    expect(a.labels.alertname).toBe('HighCPU');
    expect(a.labels.instance).toBe('a');
    expect(a.annotations.value).toBe('0.95');
    expect(a.startsAt).toMatch(/^\d{4}-/);
    expect(a.endsAt).toBe('0001-01-01T00:00:00Z');
  });

  it('恢复时 status=resolved 且 endsAt 有时间', () => {
    const a = toAlertmanagerAlert(mkAlert(), T0 + 60_000);
    expect(a.status).toBe('resolved');
    expect(a.endsAt).not.toBe('0001-01-01T00:00:00Z');
  });

  it('value 放进 annotations 而不是 labels（否则序列爆炸）', () => {
    const a = toAlertmanagerAlert(mkAlert({ value: 123.456 }));
    expect(a.labels.value).toBeUndefined();
    expect(a.annotations.value).toBe('123.456');
  });

  it('payload 带 groupLabels / commonLabels / text', () => {
    const p = buildWebhookPayload([mkAlert()]);
    expect(p.version).toBe('4');
    expect(p.status).toBe('firing');
    expect(p.alerts).toHaveLength(1);
    expect(p.commonLabels.alertname).toBe('HighCPU');
    expect(p.groupLabels.job).toBe('node');
    expect(p.text).toContain('告警触发');
    expect(p.text).toContain('CPU 高');
  });

  it('多条告警合并成一个 payload', () => {
    const p = buildWebhookPayload([
      mkAlert({ labels: { instance: 'a', job: 'node' } }),
      mkAlert({ labels: { instance: 'b', job: 'node' } }),
    ]);
    expect(p.alerts).toHaveLength(2);
    expect(p.text).toContain('2 条');
  });

  it('恢复 payload 的标题不同', () => {
    const p = buildWebhookPayload([mkAlert()], { resolvedAt: T0 + 1000 });
    expect(p.status).toBe('resolved');
    expect(p.text).toContain('已恢复');
  });

  it('空告警列表不崩', () => {
    const p = buildWebhookPayload([]);
    expect(p.alerts).toEqual([]);
    expect(p.text).toContain('0 条');
  });
});

describe('告警实例去重键', () => {
  it('标签顺序无关', () => {
    const a = alertInstanceKey({ name: 'X', labels: { a: '1', b: '2' } });
    const b = alertInstanceKey({ name: 'X', labels: { b: '2', a: '1' } });
    expect(a).toBe(b);
  });

  it('不同实例不同键（这是关键：按实例去重而不是按规则）', () => {
    const a = alertInstanceKey({ name: 'X', labels: { instance: 'a' } });
    const b = alertInstanceKey({ name: 'X', labels: { instance: 'b' } });
    expect(a).not.toBe(b);
  });

  it('不同规则名不同键', () => {
    expect(alertInstanceKey({ name: 'A', labels: {} })).not.toBe(alertInstanceKey({ name: 'B', labels: {} }));
  });
});

describe('抑制与静默', () => {
  const evalResult = {
    alerts: [
      mkAlert({ name: 'HostDown', labels: { instance: 'a' } }),
      mkAlert({ name: 'HighCPU', labels: { instance: 'a' } }),
      mkAlert({ name: 'HighCPU', labels: { instance: 'b' } }),
    ],
    fired: [],
    resolved: [],
  };

  it('抑制：HostDown 存在时压掉同实例的 HighCPU', () => {
    const { firing } = splitByState(evalResult, {
      inhibitRules: [{
        sourceMatch: { alertname: 'HostDown' },
        targetMatch: { alertname: 'HighCPU' },
        equal: ['instance'],
      }],
    }, T0);
    expect(firing.map((a) => a.name).sort()).toEqual(['HighCPU', 'HostDown']);
    expect(firing.find((a) => a.name === 'HighCPU').labels.instance).toBe('b');
  });

  it('静默：时间窗内压制', () => {
    const { firing } = splitByState(evalResult, {
      silences: [{ matchers: { alertname: 'HighCPU' }, startsAt: T0 - 1000, endsAt: T0 + 1000 }],
    }, T0);
    expect(firing.map((a) => a.name)).toEqual(['HostDown']);
  });

  it('静默过期后恢复', () => {
    const { firing } = splitByState(evalResult, {
      silences: [{ matchers: { alertname: 'HighCPU' }, startsAt: T0 + 5000, endsAt: T0 + 9000 }],
    }, T0);
    expect(firing).toHaveLength(3);
  });

  it('非 firing 状态不进 firing 列表', () => {
    const { firing } = splitByState({
      alerts: [mkAlert({ state: 'pending' }), mkAlert({ state: 'firing' })],
      fired: [],
      resolved: [],
    }, {}, T0);
    expect(firing).toHaveLength(1);
  });
});

describe('发送器', () => {
  let fetchMock;
  const okReceiver = { id: 'r1', name: 'test', url: 'http://hook', enabled: true };

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  });

  it('firing 告警会发出', async () => {
    const n = createNotifier({ getReceivers: () => [okReceiver], fetchImpl: fetchMock, now: () => T0, log: () => {} });
    const r = await n.dispatch({
      alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' }, value: 0.95 }], resolved: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(1);
  });

  it('未配置接收器时静默跳过（不是错误）', async () => {
    const n = createNotifier({ getReceivers: () => [], fetchImpl: fetchMock, now: () => T0, log: () => {} });
    const r = await n.dispatch({ alerts: [mkAlert()], fired: [], resolved: [] });
    expect(r.suppressed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('接收器 enabled=false 时不发', async () => {
    const n = createNotifier({
      getReceivers: () => [{ ...okReceiver, enabled: false }], fetchImpl: fetchMock, now: () => T0, log: () => {},
    });
    const r = await n.dispatch({ alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }], resolved: [] });
    expect(r.suppressed).toBe(true);
  });

  it('发送失败只记录，不抛错', async () => {
    const failFetch = vi.fn(async () => ({ ok: false, status: 500 }));
    const n = createNotifier({ getReceivers: () => [okReceiver], fetchImpl: failFetch, now: () => T0, log: () => {} });
    const r = await n.dispatch({ alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }], resolved: [] });
    expect(r.failed).toBe(1);
    expect(n.stats().failures).toBe(1);
  });

  it('网络异常也不抛', async () => {
    const throwFetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const n = createNotifier({ getReceivers: () => [okReceiver], fetchImpl: throwFetch, now: () => T0, log: () => {} });
    await expect(n.dispatch({ alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }], resolved: [] })).resolves.toBeTruthy();
  });

  it('repeatIntervalMs 内不重发', async () => {
    let clock = T0;
    const n = createNotifier({
      getReceivers: () => [{ ...okReceiver, repeatIntervalMs: 60_000 }],
      fetchImpl: fetchMock, now: () => clock, log: () => {},
    });
    // 第一次（在 fired 里 → 必发）
    await n.dispatch({ alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }], resolved: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 30 秒后，不在 fired 里 → 不重发
    clock = T0 + 30_000;
    await n.dispatch({ alerts: [mkAlert()], fired: [], resolved: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 61 秒后 → 重发
    clock = T0 + 61_000;
    await n.dispatch({ alerts: [mkAlert()], fired: [], resolved: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('**恢复通知会发**', async () => {
    const n = createNotifier({ getReceivers: () => [okReceiver], fetchImpl: fetchMock, now: () => T0, log: () => {} });
    // 先 firing
    await n.dispatch({ alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }], resolved: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 再恢复
    await n.dispatch({ alerts: [], fired: [], resolved: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' }, state: 'firing' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.status).toBe('resolved');
  });

  it('没通知过 firing 的不发恢复', async () => {
    const n = createNotifier({ getReceivers: () => [okReceiver], fetchImpl: fetchMock, now: () => T0, log: () => {} });
    await n.dispatch({ alerts: [], fired: [], resolved: [{ name: 'X', labels: { a: '1' } }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sendResolved=false 时不发恢复', async () => {
    const n = createNotifier({
      getReceivers: () => [{ ...okReceiver, sendResolved: false }], fetchImpl: fetchMock, now: () => T0, log: () => {},
    });
    await n.dispatch({ alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }], resolved: [] });
    const before = fetchMock.mock.calls.length;
    await n.dispatch({ alerts: [], fired: [], resolved: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }] });
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('多个接收器都发', async () => {
    const n = createNotifier({
      getReceivers: () => [okReceiver, { id: 'r2', name: 'b', url: 'http://hook2', enabled: true }],
      fetchImpl: fetchMock, now: () => T0, log: () => {},
    });
    const r = await n.dispatch({ alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }], resolved: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.sent).toBe(2);
  });

  it('sendTest 能单独验证通道', async () => {
    const n = createNotifier({ fetchImpl: fetchMock, now: () => T0, log: () => {} });
    expect(await n.sendTest(okReceiver)).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.alerts[0].labels.alertname).toBe('OpenLogTestAlert');
  });

  it('reset 清空去重状态', async () => {
    const n = createNotifier({
      getReceivers: () => [{ ...okReceiver, repeatIntervalMs: 3_600_000 }],
      fetchImpl: fetchMock, now: () => T0, log: () => {},
    });
    await n.dispatch({ alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }], resolved: [] });
    n.reset();
    await n.dispatch({ alerts: [mkAlert()], fired: [], resolved: [] });
    // reset 后既不在 active 也不在 sentAt —— 不重发，因为不在 fired 里
    expect(n.stats().activeAlerts).toBe(1);
  });

  it('自定义 headers 会带上（有些通道要）', async () => {
    const n = createNotifier({
      getReceivers: () => [{ ...okReceiver, headers: { 'X-Custom': 'v' } }],
      fetchImpl: fetchMock, now: () => T0, log: () => {},
    });
    await n.dispatch({ alerts: [mkAlert()], fired: [{ name: 'HighCPU', labels: { instance: 'a', job: 'node' } }], resolved: [] });
    expect(fetchMock.mock.calls[0][1].headers['X-Custom']).toBe('v');
  });
});

describe('receiverId', () => {
  it('同样配置生成同样 id', () => {
    expect(receiverId({ name: 'a', url: 'http://x' })).toBe(receiverId({ name: 'a', url: 'http://x' }));
  });

  it('不同配置不同 id', () => {
    expect(receiverId({ name: 'a', url: 'http://x' })).not.toBe(receiverId({ name: 'b', url: 'http://x' }));
  });

  it('固定长度', () => {
    expect(receiverId({ name: 'a', url: 'http://x' })).toHaveLength(12);
  });
});

describe('NOTIFY_KIND', () => {
  it('两种类型', () => {
    expect(NOTIFY_KIND.FIRING).toBe('firing');
    expect(NOTIFY_KIND.RESOLVED).toBe('resolved');
  });
});