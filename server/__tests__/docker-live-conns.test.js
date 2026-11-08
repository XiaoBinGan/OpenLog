/**
 * live-conns 测试：从 /proc/net/tcp 文本到「容器 A → 容器 B」的边
 *
 * 这份数据比 env 更强：env 只说明「配置上打算连谁」，连接表说明「此刻真的连着」。
 */
import { describe, it, expect } from 'vitest';
import { hexToIp, hexToPort, parseProcNetTcp, mapConnectionsToEdges, buildPortOwnerMap, outboundFrom, isLikelyHostSide } from '../docker-live-conns.js';

/** 复刻真实 /proc/net/tcp 片段（生产抓的） */
const REAL = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000    70        0 624008390 1 0000000000000000 100 0 0 10 0
   1: 050011AC:1538 010011AC:90B8 01 00000000:00000000 02:000AE629 00000000    70        0 730652954 2 0000000000000000 20 4 31 10 -1
  38: 010011AC:90B8 050011AC:1538 01 00000000:00000000 00:00000000 00000000     0        0 730561386 1 0000000000000000 20 4 30 10 -1
  25: 0100007F:C504 0100007F:1538 01 00000000:00000000 00:00000000 00000000     0        0 730673152 1 0000000000000000 20 4 30 10 -1`;

describe('hexToIp —— 内核是小端十六进制', () => {
  it('IPv4 反序还原', () => {
    expect(hexToIp('0100007F')).toBe('127.0.0.1');
    expect(hexToIp('050011AC')).toBe('172.17.0.5');
    expect(hexToIp('010011AC')).toBe('172.17.0.1');
    expect(hexToIp('00000000')).toBe('0.0.0.0');
  });
  it('IPv6 按 4 组小端还原', () => {
    // /proc/net/tcp6 的 32 个 hex 拆成 8 个 16 位组；::1 在这里记作 ...0001
    const v6 = hexToIp('00000000000000000000000001000000');
    expect(v6).toMatch(/:1$/);
    expect(v6.split(':')).toHaveLength(8);
  });
  it('长度不对返回 null', () => {
    expect(hexToIp('1234')).toBe(null);
    expect(hexToIp('')).toBe(null);
    expect(hexToIp(null)).toBe(null);
  });
});

describe('hexToPort', () => {
  it('十六进制转十进制', () => {
    expect(hexToPort('1538')).toBe(5432);
    expect(hexToPort('1F90')).toBe(8080);
    expect(hexToPort('0050')).toBe(80);
  });
  it('0 是合法端口，不能当成缺失', () => {
    expect(hexToPort('0000')).toBe(0);
  });
  it('越界/非法返回 null', () => {
    expect(hexToPort('FFFFF')).toBe(null);
    expect(hexToPort('zzzz')).toBe(null);
  });
});

describe('parseProcNetTcp', () => {
  it('默认只留 ESTABLISHED（0A 是 LISTEN，不要）', () => {
    const conns = parseProcNetTcp(REAL);
    expect(conns).toHaveLength(3);
    expect(conns.every((c) => c.state === '01')).toBe(true);
  });

  it('解析出正确的两端地址与端口', () => {
    const conns = parseProcNetTcp(REAL);
    expect(conns[0]).toMatchObject({
      localIp: '172.17.0.5', localPort: 5432,
      remoteIp: '172.17.0.1', remotePort: 37048,
    });
  });

  it('establishedOnly=false 会把 LISTEN 也算进来', () => {
    const all = parseProcNetTcp(REAL, { establishedOnly: false });
    expect(all.length).toBe(4);
    expect(all.some((c) => c.state === '0A')).toBe(true);
  });

  it('脏数据不崩：表头、空行、缺列、非数字 sl', () => {
    const messy = `  sl  local_address rem_address   st
   
  abc 0100007F:0050 00000000:0000 01
   1: 0100007F:0050
   2: 坏数据 00000000:0000 01`;
    expect(() => parseProcNetTcp(messy)).not.toThrow();
    expect(parseProcNetTcp(messy)).toEqual([]);
  });

  it('空输入返回空数组', () => {
    expect(parseProcNetTcp('')).toEqual([]);
    expect(parseProcNetTcp(null)).toEqual([]);
  });
});

describe('mapConnectionsToEdges —— 连接 → 容器依赖边', () => {
  const ipToId = new Map([
    ['172.17.0.5', 'pg'],
    ['172.17.0.2', 'supremind'],
    ['172.17.0.7', 'strata'],
  ]);

  it('容器 IP 直连 → 建立 client → server 的边', () => {
    const conns = [
      // supremind(172.17.0.2):40000 → pg(172.17.0.5):5432
      { localIp: '172.17.0.5', localPort: 5432, remoteIp: '172.17.0.2', remotePort: 40000, state: '01' },
    ];
    const edges = mapConnectionsToEdges(conns, ipToId);
    expect(edges.get('supremind').get('pg').count).toBe(1);
  });

  it('多条连接累加计数（并发越高越可信）', () => {
    const mk = (rp) => ({ localIp: '172.17.0.5', localPort: 5432, remoteIp: '172.17.0.2', remotePort: rp, state: '01' });
    const edges = mapConnectionsToEdges([mk(1), mk(2), mk(3)], ipToId);
    expect(edges.get('supremind').get('pg').count).toBe(3);
  });

  it('自己连自己不算（同一容器两端）', () => {
    const conns = [{ localIp: '172.17.0.5', localPort: 5432, remoteIp: '172.17.0.5', remotePort: 50000, state: '01' }];
    const edges = mapConnectionsToEdges(conns, ipToId);
    expect(edges.size).toBe(0);
  });

  it('回环 + 端口归属：靠 portToId 把 127.0.0.1 连接归到 host 网络容器', () => {
    const conns = [{ localIp: '127.0.0.1', localPort: 5432, remoteIp: '127.0.0.1', remotePort: 51000, state: '01' }];
    const portToId = new Map([[5432, 'pg'], [51000, 'openlog']]);
    const edges = mapConnectionsToEdges(conns, new Map(), { portToId });
    expect(edges.get('openlog').get('pg').count).toBe(1);
  });

  it('解析不到归属的连接直接跳过，不瞎猜', () => {
    const conns = [{ localIp: '203.0.113.9', localPort: 443, remoteIp: '198.51.100.7', remotePort: 55000, state: '01' }];
    expect(mapConnectionsToEdges(conns, ipToId).size).toBe(0);
  });

  it('空输入不炸', () => {
    expect(mapConnectionsToEdges([], ipToId).size).toBe(0);
    expect(mapConnectionsToEdges(null, ipToId).size).toBe(0);
    expect(mapConnectionsToEdges([], null).size).toBe(0);
  });
});

describe('buildPortOwnerMap', () => {
  it('发布端口 → 容器 id', () => {
    const map = buildPortOwnerMap([
      { id: 'pg', publishedPorts: [{ hostPort: 5432, containerPort: 5432 }] },
      { id: 'site', publishedPorts: [{ hostPort: 3003, containerPort: 80 }] },
      { id: 'none', publishedPorts: [] },
    ]);
    expect(map.get(5432)).toBe('pg');
    expect(map.get(3003)).toBe('site');
    expect(map.has(80)).toBe(false); // 容器内端口不算发布端口
  });
});


describe('outboundFrom —— 用单台容器自己的连接表判断它连了谁', () => {
  const ipToId = new Map([['172.17.0.5', 'pg'], ['172.17.0.7', 'strata']]);
  const allIds = new Set(['pg', 'strata', 'app', 'openlog']);
  const conn = (remoteIp, remotePort) => ({ localIp: '172.17.0.2', localPort: 40000, remoteIp, remotePort, state: '01' });

  it('对端是容器 IP → 直接命中', () => {
    const out = outboundFrom('app', [conn('172.17.0.5', 5432)], ipToId, { allIds });
    expect(out.get('pg').count).toBe(1);
  });

  it('多条连接累加', () => {
    const out = outboundFrom('app', [conn('172.17.0.5', 5432), conn('172.17.0.5', 5433)], ipToId, { allIds });
    expect(out.get('pg').count).toBe(2);
  });

  it('自己连自己不算依赖（同容器内多进程）', () => {
    const out = outboundFrom('app', [conn('172.17.0.2', 9000)], new Map([['172.17.0.2', 'app']]), { allIds });
    expect(out.size).toBe(0);
  });

  it('对端是宿主机侧 + 端口归属唯一 → 归到那个容器', () => {
    const portToId = new Map([[5432, 'pg']]);
    const out = outboundFrom('openlog', [conn('127.0.0.1', 5432)], new Map(), { portToId, allIds });
    expect(out.get('pg').count).toBe(1);
  });

  it('对端是宿主机侧且只有一台 host 容器 → 归给它', () => {
    const out = outboundFrom('app', [conn('172.17.0.1', 39999)], new Map(), { soleHostId: 'openlog', allIds });
    expect(out.get('openlog').count).toBe(1);
  });

  it('对端是公网地址 → 跳过，不瞎连', () => {
    const out = outboundFrom('app', [conn('93.184.216.34', 443)], ipToId, { allIds });
    expect(out.size).toBe(0);
  });

  it('空输入不炸', () => {
    expect(outboundFrom('app', [], ipToId).size).toBe(0);
    expect(outboundFrom('app', null, ipToId).size).toBe(0);
    expect(outboundFrom('app', [conn('172.17.0.5', 5432)], null).size).toBe(0);
  });
});

describe('isLikelyHostSide', () => {
  it('回环与网关地址算宿主机侧', () => {
    expect(isLikelyHostSide('127.0.0.1')).toBe(true);
    expect(isLikelyHostSide('172.17.0.1')).toBe(true);
    expect(isLikelyHostSide('10.0.0.1')).toBe(true);
  });
  it('普通容器 IP 不算', () => {
    expect(isLikelyHostSide('172.17.0.5')).toBe(false);
    expect(isLikelyHostSide('172.18.0.2')).toBe(false);
  });
});
