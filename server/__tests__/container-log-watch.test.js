import { describe, it, expect, vi } from 'vitest';

const {
  ContainerLogWatcher, collectAlerts, alertSignature, demuxDockerLogBuffer,
  DEFAULT_SIGNATURE_COOLDOWN_MS, FIRST_SEEN_LOOKBACK_MS,
} = await import('../container-log-watch.js');

/** 构造 docker logs 的 8 字节帧格式 */
function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1, 0); // stdout
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('demuxDockerLogBuffer', () => {
  it('拆出时间戳 + 正文', () => {
    const raw = Buffer.concat([
      frame('2026-10-26T18:35:14.532Z ERROR first\n'),
      frame('2026-10-26T18:35:15.001Z INFO second\n'),
    ]);
    const lines = demuxDockerLogBuffer(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0].timestamp).toBe('2026-10-26T18:35:14.532Z');
    expect(lines[0].line).toBe('ERROR first');
    expect(lines[1].line).toBe('INFO second');
  });

  it('多行堆栈沿用上一条时间戳', () => {
    const raw = Buffer.concat([
      frame('2026-10-26T18:35:14.532Z Traceback (most recent call last):\n'),
      frame('  File "x.py", line 3, in <module>\n'),
    ]);
    const lines = demuxDockerLogBuffer(raw);
    expect(lines).toHaveLength(2);
    expect(lines[1].timestamp).toBe('2026-10-26T18:35:14.532Z');
  });

  it('空 buffer / 畸形帧不炸', () => {
    expect(demuxDockerLogBuffer(Buffer.alloc(0))).toEqual([]);
    expect(demuxDockerLogBuffer(Buffer.from([1, 2, 3]))).toEqual([]);
    expect(demuxDockerLogBuffer('not a buffer')).toEqual([]);
  });
});

describe('alertSignature —— 去重签名', () => {
  it('忽略时间戳/IP/端口/UUID，保留错误模式', () => {
    const a = alertSignature('2026-10-26 18:35:14 ERROR connect to 192.168.1.10:8080 failed req_abc123');
    const b = alertSignature('2026-10-27 09:00:01 ERROR connect to 10.0.0.5:9090 failed req_def456');
    expect(a).toBe(b);
    expect(a).toContain('connect to');
  });

  it('不同错误模式签名不同', () => {
    expect(alertSignature('ERROR disk full')).not.toBe(alertSignature('ERROR permission denied'));
  });
});

describe('collectAlerts —— 命中/去重/冷却', () => {
  const line = (text) => ({ timestamp: new Date().toISOString(), line: text });

  it('只上报配置等级内的行', () => {
    const state = {};
    const { events } = collectAlerts([
      line('INFO all good'),
      line('ERROR boom'),
      line('WARN mild'),
      line('[FATAL] dead'),
    ], state, { levels: ['ERROR', 'FATAL'], now: 1000 });
    expect(events.map(e => e.level)).toEqual(['ERROR', 'FATAL']);
  });

  it('同一签名在冷却期内只报一次', () => {
    const state = {};
    const first = collectAlerts([line('ERROR same pattern')], state, { now: 1000, cooldownMs: 60000 });
    const second = collectAlerts([line('ERROR same pattern')], state, { now: 2000, cooldownMs: 60000 });
    const later = collectAlerts([line('ERROR same pattern')], state, { now: 1000 + 61000, cooldownMs: 60000 });
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(0);
    expect(second.dropped).toBe(1);
    expect(later.events).toHaveLength(1);
  });

  it('WARN 行在配置包含 WARN 时会上报', () => {
    const { events } = collectAlerts([line('WARN mild')], {}, { levels: ['ERROR', 'WARN'], now: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('WARN');
  });

  it('签名 Map 不会无限增长（超过 500 会清理过期项）', () => {
    const state = {};
    for (let i = 0; i < 600; i++) {
      collectAlerts([line(`ERROR unique pattern ${i}`)], state, { now: 1000 + i, cooldownMs: 10 });
    }
    expect(state.sigCooldown.size).toBeLessThanOrEqual(501);
  });
});

describe('ContainerLogWatcher —— 实时监听', () => {
  function makeSources(containers) {
    return [{ sourceId: 'local', sourceName: '本地 Docker', config: {}, containers }];
  }

  it('首次发现容器只看最近几秒，避免刷历史错误', async () => {
    const now = Date.now();
    const fetchLogs = vi.fn(async () => frame('2026-10-26T18:35:14Z ERROR old'));
    const w = new ContainerLogWatcher({
      listRunningSources: async () => makeSources([{ id: 'abc123456789', shortId: 'abc123', name: 'svc' }]),
      fetchLogs,
      onAlert: () => {},
      intervalMs: 1000,
    });
    w.start();
    await w.tick();
    const sinceSec = fetchLogs.mock.calls[0][2];
    // since 应接近 now - 5s（允许几秒误差）
    expect(Math.abs(sinceSec * 1000 - (now - FIRST_SEEN_LOOKBACK_MS))).toBeLessThan(5000);
    w.stop();
  });

  it('命中 ERROR 时回调带容器信息与日志正文', async () => {
    const alerts = [];
    const w = new ContainerLogWatcher({
      listRunningSources: async () => makeSources([{ id: 'abc123456789', shortId: 'abc123', name: 'vllm' }]),
      fetchLogs: async () => Buffer.concat([
        frame('2026-10-26T18:35:14Z ERROR boom happened\n'),
        frame('2026-10-26T18:35:15Z INFO normal\n'),
      ]),
      onAlert: (a) => alerts.push(a),
      intervalMs: 1000,
    });
    w.start();
    await w.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      sourceId: 'local', containerName: 'vllm', containerId: 'abc123', level: 'ERROR',
    });
    expect(alerts[0].content).toContain('boom');
    w.stop();
  });

  it('单轮单容器最多推 5 条，其余合并为 suppressed 计数', async () => {
    const alerts = [];
    const lines = Array.from({ length: 8 }, (_, i) => frame(`2026-10-26T18:35:${10 + i}Z ERROR distinct failure ${i}\n`));
    const w = new ContainerLogWatcher({
      listRunningSources: async () => makeSources([{ id: 'idxxxx', shortId: 'id', name: 'svc' }]),
      fetchLogs: async () => Buffer.concat(lines),
      onAlert: (a) => alerts.push(a),
      intervalMs: 1000,
    });
    w.start();
    await w.tick();
    expect(alerts).toHaveLength(5);
    expect(alerts[4].suppressed).toBe(3);
    w.stop();
  });

  it('不命中等级时静默', async () => {
    const alerts = [];
    const w = new ContainerLogWatcher({
      listRunningSources: async () => makeSources([{ id: 'x', shortId: 'x', name: 'svc' }]),
      fetchLogs: async () => frame('2026-10-26T18:35:14Z INFO normal\n'),
      onAlert: (a) => alerts.push(a),
      intervalMs: 1000,
    });
    w.start();
    await w.tick();
    expect(alerts).toHaveLength(0);
    w.stop();
  });

  it('某个源/容器报错不影响其他容器', async () => {
    const alerts = [];
    const errors = [];
    const w = new ContainerLogWatcher({
      listRunningSources: async () => makeSources([
        { id: 'bad', shortId: 'bad', name: 'bad-svc' },
        { id: 'good', shortId: 'good', name: 'good-svc' },
      ]),
      fetchLogs: async (source, container) => {
        if (container.id === 'bad') throw new Error('docker API 挂起');
        return frame('2026-10-26T18:35:14Z ERROR good failed\n');
      },
      onAlert: (a) => alerts.push(a),
      onError: (m) => errors.push(m),
      intervalMs: 1000,
    });
    w.start();
    await w.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].containerName).toBe('good-svc');
    expect(errors.some(e => e.includes('docker API 挂起'))).toBe(true);
    w.stop();
  });

  it('容器消失后清理检查点，不再轮询它', async () => {
    let containers = [{ id: 'c1', shortId: 'c1', name: 'svc' }];
    const fetchLogs = vi.fn(async () => Buffer.concat([]));
    const w = new ContainerLogWatcher({
      listRunningSources: async () => makeSources(containers),
      fetchLogs,
      onAlert: () => {},
      intervalMs: 1000,
    });
    w.start();
    await w.tick();
    expect(w.checkpoints.size).toBe(1);
    containers = [];
    await w.tick();
    expect(w.checkpoints.size).toBe(0);
    w.stop();
  });

  it('start/stop 幂等且 stop 后不再 tick', async () => {
    const listRunningSources = vi.fn(async () => []);
    const w = new ContainerLogWatcher({ listRunningSources, fetchLogs: async () => Buffer.concat([]) });
    w.start(); w.start();
    // start() 会立刻跑一次 tick（异步），等它落定再停
    await w.tick();
    w.stop(); w.stop();
    expect(w.isRunning).toBe(false);
    listRunningSources.mockClear();
    await w.tick(); // running=false 时应直接返回
    expect(listRunningSources).not.toHaveBeenCalled();
  });

  it('listRunningSources 抛错时走 onError，不崩溃', async () => {
    const errors = [];
    const w = new ContainerLogWatcher({
      listRunningSources: async () => { throw new Error('docker 不可达'); },
      fetchLogs: async () => Buffer.concat([]),
      onError: (m) => errors.push(m),
      intervalMs: 1000,
    });
    w.start();
    await w.tick();
    expect(errors.join(' ')).toContain('docker 不可达');
    w.stop();
  });

  it('默认冷却时间 60s', () => {
    expect(DEFAULT_SIGNATURE_COOLDOWN_MS).toBe(60000);
  });
});

describe('???? ?? ??????????', () => {
  it('isSelfLogLine ?? OpenLog ???????', async () => {
    const mod = await import('../container-log-watch.js');
    expect(mod.isSelfLogLine('[LogWatch] ?? openlog [ERROR] x')).toBe(true);
    expect(mod.isSelfLogLine('[Patrol] ?? y')).toBe(true);
    expect(mod.isSelfLogLine('ERROR real app failure')).toBe(false);
  });

  it('collectAlerts ????????????????', async () => {
    const mod = await import('../container-log-watch.js');
    const state = {};
    const { events } = mod.collectAlerts([
      { timestamp: 't', line: '[LogWatch] ?? openlog [ERROR] boom' },
      { timestamp: 't', line: 'ERROR real failure' },
    ], state, { now: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].content).toContain('real failure');
  });
});
