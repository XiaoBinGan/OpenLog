/**
 * 链路编排的三处易错点（这函数我改了 4 次、每次都在生产上才发现 bug）
 *
 * 1. **缓存指纹碰撞**：原来用 `ids.join(',').length` 当指纹，
 *    两个不同容器集合只要 id 总长度相同就会命中同一份缓存 → 返回另一批容器的拓扑。
 * 2. **证据不升级**：真实 TCP 连接读到后，因为边已存在就跳过，
 *    更强的 `live_tcp` 证据被丢掉，面板一直显示较弱的 env 推断。
 * 3. **对停掉的容器 exec**：77 台里 66 台是 exited，逐台 exec 只会刷假失败。
 */
import { describe, it, expect, vi } from 'vitest';
import { applyLiveEdges, topologyKey, readLiveConnections } from '../docker.js';

describe('topologyKey —— 缓存指纹必须对 id 集合取摘要', () => {
  it('不同容器集合不会碰撞（旧的 join(",").length 方案会）', () => {
    const a = topologyKey('local', [{ id: 'aaaa1111222' }, { id: 'bbbb3333444' }]);
    const b = topologyKey('local', [{ id: 'cccc5555666' }, { id: 'dddd7777888' }]);
    expect(a).not.toBe(b);
  });

  it('同一集合、顺序不同 → 指纹相同（缓存可以复用）', () => {
    const a = topologyKey('local', [{ id: 'x1' }, { id: 'y1' }]);
    const b = topologyKey('local', [{ id: 'y1' }, { id: 'x1' }]);
    expect(a).toBe(b);
  });

  it('不同 source 不共享缓存', () => {
    expect(topologyKey('local', [{ id: 'a' }])).not.toBe(topologyKey('remote-1', [{ id: 'a' }]));
  });

  it('容器数量变化 → 指纹变化', () => {
    expect(topologyKey('local', [{ id: 'a' }])).not.toBe(topologyKey('local', [{ id: 'a' }, { id: 'b' }]));
  });
});

describe('applyLiveEdges —— 真实连接证据要能升级已有边', () => {
  const nodes = [
    { id: 'openlog', names: ['openlog'] },
    { id: 'pg', names: ['openlog-pg'] },
  ];
  const emptyBucket = () => ({ upstream: [], downstream: [], peers: [] });
  const makeTopo = () => new Map([['openlog', emptyBucket()], ['pg', emptyBucket()]]);

  it('没有边时新建，标 live_tcp + high', () => {
    const topo = makeTopo();
    applyLiveEdges(topo, new Map([['openlog', new Map([['pg', { count: 4, sample: {} }]])]]), nodes);
    const down = topo.get('openlog').downstream;
    expect(down).toHaveLength(1);
    expect(down[0]).toMatchObject({ id: 'pg', confidence: 'high' });
    expect(down[0].evidence.kind).toBe('live_tcp');
    expect(down[0].evidence.detail).toContain('4 条');
    // 反方向也要建
    expect(topo.get('pg').upstream[0]).toMatchObject({ id: 'openlog', confidence: 'high' });
  });

  it('已有较弱证据的边 → 升级为 live_tcp，旧证据保留在 allEvidence', () => {
    const topo = makeTopo();
    const old = { kind: 'env_published_port', confidence: 'medium', detail: 'env 指向 5432', value: '5432' };
    topo.get('openlog').downstream.push({ id: 'pg', direction: 'downstream', confidence: 'medium', evidence: old, allEvidence: [old] });
    topo.get('pg').upstream.push({ id: 'openlog', direction: 'upstream', confidence: 'medium', evidence: old, allEvidence: [old] });

    applyLiveEdges(topo, new Map([['openlog', new Map([['pg', { count: 2, sample: {} }]])]]), nodes);

    const down = topo.get('openlog').downstream;
    expect(down).toHaveLength(1); // 不重复添加
    expect(down[0].evidence.kind).toBe('live_tcp');
    expect(down[0].confidence).toBe('high');
    expect(down[0].allEvidence.map((e) => e.kind)).toEqual(['live_tcp', 'env_published_port']);
  });

  it('成为上下游的容器要从 peers 里剔除', () => {
    const topo = makeTopo();
    topo.get('openlog').peers = [{ id: 'pg', networks: ['bridge'] }];
    topo.get('pg').peers = [{ id: 'openlog', networks: ['bridge'] }];
    applyLiveEdges(topo, new Map([['openlog', new Map([['pg', { count: 1, sample: {} }]])]]), nodes);
    expect(topo.get('openlog').peers).toEqual([]);
    expect(topo.get('pg').peers).toEqual([]);
  });

  it('edges 里出现未知容器 id 时跳过，不炸', () => {
    const topo = makeTopo();
    expect(() => applyLiveEdges(topo, new Map([['ghost', new Map([['pg', { count: 1 }]])]]), nodes)).not.toThrow();
    expect(() => applyLiveEdges(topo, new Map([['openlog', new Map([['ghost', { count: 1 }]])]]), nodes)).not.toThrow();
    expect(topo.get('openlog').downstream).toEqual([]);
  });

  it('空 edges 不改变任何东西', () => {
    const topo = makeTopo();
    applyLiveEdges(topo, new Map(), nodes);
    expect(topo.get('openlog')).toEqual(emptyBucket());
  });
});

describe('readLiveConnections —— 只读运行中容器', () => {
  /** 假 docker：只记录被 exec 的容器，返回 /proc/net/tcp 文本 */
  function fakeDocker(tcpText) {
    const execd = [];
    const dockerFor = () => ({
      getContainer: (id) => ({
        exec: async () => {
          execd.push(id);
          return {
            start: async () => {
              const { PassThrough } = require('node:stream');
              const s = new PassThrough();
              process.nextTick(() => { s.write(tcpText); s.end(); });
              return s;
            },
          };
        },
      }),
    });
    return { dockerFor, execd };
  }

  const TCP = `  sl  local_address rem_address   st
   0: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000    70 0
   1: 0200A8C0:9C40 050011AC:1538 01 00000000:00000000 00:00000000 00000000     0 0`;

  it('exited 容器不 exec（77 台里 66 台是停的，逐台 exec 只会刷假失败）', async () => {
    const { dockerFor, execd } = fakeDocker(TCP);
    const nodes = [
      { id: 'run1', state: 'running', containerIps: ['192.168.0.2'], publishedPorts: [] },
      { id: 'dead1', state: 'exited', containerIps: [], publishedPorts: [] },
      { id: 'dead2', state: 'exited', containerIps: [], publishedPorts: [] },
    ];
    const r = await readLiveConnections('local', nodes, {}, dockerFor);
    expect(execd).toEqual(['run1']);
    expect(r.candidates).toBe(1);
  });

  it('没有运行中容器 → 不 exec，candidates 为 0', async () => {
    const { dockerFor, execd } = fakeDocker(TCP);
    const r = await readLiveConnections('local', [{ id: 'd', state: 'exited' }], {}, dockerFor);
    expect(execd).toEqual([]);
    expect(r.candidates).toBe(0);
    expect(r.edges.size).toBe(0);
  });

  it('exec 抛错只记 skipped，不影响其它容器', async () => {
    let n = 0;
    const dockerFor = () => ({
      getContainer: () => ({
        exec: async () => { n += 1; if (n === 1) throw new Error('exec boom'); return { start: async () => { const { PassThrough } = require('node:stream'); const s = new PassThrough(); process.nextTick(() => { s.write(TCP); s.end(); }); return s; } }; },
      }),
    });
    const nodes = [
      { id: 'a', state: 'running', containerIps: ['192.168.0.2'], publishedPorts: [] },
      { id: 'b', state: 'running', containerIps: [], publishedPorts: [] },
    ];
    const r = await readLiveConnections('local', nodes, {}, dockerFor);
    expect(r.skipped).toBe(1);
    expect(r.candidates).toBe(2);
  });
});
