/**
 * 容器上下游链路推断（Lead 在生产 86 个容器上实测发现整段失效）
 *
 * 原实现永远返回空，三个判断依据全是死的：
 *   1. 读 `c.Networks` —— Docker list API 的字段叫 `NetworkSettings.Networks`
 *   2. 读 `c.labels.env` —— Docker 从不把环境变量写进 labels
 *   3. 读 `labels['depends-on']` —— compose v2 用 `com.docker.compose.depends_on`，且默认不写
 *
 * 生产实测：86 容器、抽样 8 个，上游/下游/同网全部 0。
 */
import { describe, it, expect } from 'vitest';
import {
  parseEndpoint, normalizeName, identityTokens, buildNode, envPairs,
  buildIndex, outgoingReferences, bestEvidence, analyzeTopology,
} from '../docker-topology.js';

const inspectOf = ({
  name = '/app', image = 'app:1', env = [], labels = {},
  networks = { bridge: { Aliases: null, IPAddress: '172.17.0.2' } },
  ports = {}, networkMode = 'default',
} = {}) => ({
  Name: name,
  Config: { Image: image, Env: env, Labels: labels },
  HostConfig: { NetworkMode: networkMode },
  NetworkSettings: { Networks: networks, Ports: ports },
});

const node = (over = {}) => buildNode(
  { id: over.id || 'id-' + Math.random().toString(16).slice(2, 8), names: over.names || ['app'], ports: [] },
  inspectOf(over.inspect || {}),
);

describe('parseEndpoint —— 从 env 值里抠 host/port', () => {
  it('各种 DSN', () => {
    expect(parseEndpoint('postgres://openlog:OpenlogPg_x@127.0.0.1:5432/openlog'))
      .toEqual({ scheme: 'postgres', host: '127.0.0.1', port: 5432 });
    expect(parseEndpoint('redis://cache:6379/0')).toEqual({ scheme: 'redis', host: 'cache', port: 6379 });
    expect(parseEndpoint('http://api:8080/x?y=1')).toEqual({ scheme: 'http', host: 'api', port: 8080 });
    expect(parseEndpoint('mysql://u:p@db-master:3306/app')).toMatchObject({ host: 'db-master', port: 3306 });
  });
  it('裸 host:port', () => {
    expect(parseEndpoint('db:5432')).toEqual({ scheme: null, host: 'db', port: 5432 });
  });
  it('没有端口也认（host 仍然有用）', () => {
    expect(parseEndpoint('postgres://u:p@pg-master/app')).toEqual({ scheme: 'postgres', host: 'pg-master', port: null });
  });
  it('不是地址就返回 null，不乱猜', () => {
    expect(parseEndpoint('3001')).toBe(null);
    expect(parseEndpoint('/app/data')).toBe(null);
    expect(parseEndpoint('true')).toBe(null);
    expect(parseEndpoint('')).toBe(null);
    expect(parseEndpoint(null)).toBe(null);
  });
});

describe('buildNode —— 从 Docker inspect 抽节点（关键是别读错字段）', () => {
  it('网络从 NetworkSettings.Networks 读，不是 c.Networks', () => {
    const n = node({ inspect: { networks: { bridge: { Aliases: ['alias1'], IPAddress: '172.17.0.5' }, nifi_default: { Aliases: null, IPAddress: '' } } } });
    expect(n.networks).toEqual(['bridge', 'nifi_default']);
    expect(n.aliases).toEqual(['alias1']);
    expect(n.containerIps).toEqual(['172.17.0.5']);
  });

  it('env 从 Config.Env 读，不是 labels', () => {
    const n = node({ inspect: { env: ['PORT=3001', 'OPENLOG_DATABASE_URL=postgres://u:p@127.0.0.1:5432/db'] } });
    expect(n.env).toHaveLength(2);
    expect(n.env[1]).toContain('5432');
    expect(n.labels).toEqual({});
  });

  it('发布端口从 NetworkSettings.Ports 读，容器端口对得上', () => {
    const n = node({ inspect: { ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } } });
    expect(n.publishedPorts).toEqual([{ hostIp: '127.0.0.1', hostPort: 5432, containerPort: 5432 }]);
  });

  it('compose label 抽出来', () => {
    const n = node({ inspect: { labels: { 'com.docker.compose.project': 'nifi', 'com.docker.compose.service': 'nifi', 'com.docker.compose.depends_on': 'db,redis' } } });
    expect(n).toMatchObject({ composeProject: 'nifi', composeService: 'nifi', composeDependsOn: 'db,redis' });
  });

  it('没网络信息时 networks 是空数组而不是崩', () => {
    const n = buildNode({ id: 'x', names: ['x'], ports: [] }, { Config: {}, NetworkSettings: {} });
    expect(n.networks).toEqual([]);
    expect(n.aliases).toEqual([]);
  });
});

describe('identityTokens —— 别人可能用哪个名字引用它', () => {
  it('容器名 / 服务名 / 别名 / 短 id 都算', () => {
    const n = { names: ['nifi'], aliases: ['nifi-alias'], composeProject: 'nifi', composeService: 'nifi', shortId: 'abc123def456' };
    const t = identityTokens(n);
    expect(t).toContain('nifi');
    expect(t).toContain('nifi-alias');
    expect(t).toContain('abc123def456');
  });
  it('单字符和纯数字 token 被排除（会误命中）', () => {
    expect(identityTokens({ names: ['a', '123', 'ok-name'] })).toEqual(['ok-name']);
  });
});

describe('analyzeTopology —— 真机场景', () => {
  /** 复刻生产实况：openlog 用 host 网络 + env 指向 127.0.0.1:5432；pg 发布 5432 */
  const openlog = node({
    id: 'openlog', names: ['openlog'],
    inspect: {
      env: ['PORT=3001', 'OPENLOG_DB_TYPE=postgres', 'OPENLOG_DATABASE_URL=postgres://openlog:pw@127.0.0.1:5432/openlog'],
      ports: {}, networks: { host: { Aliases: null, IPAddress: '' } }, networkMode: 'host',
    },
  });
  const pg = node({
    id: 'pg', names: ['openlog-pg'],
    inspect: { ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } },
  });
  const site = node({ id: 'site', names: ['openlog-site'], inspect: { ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '3003' }] } } });

  it('env 指向 127.0.0.1:唯一发布端口 → 建立下游关系，证据可读', () => {
    const topo = analyzeTopology([openlog, pg, site]);
    const bak = topo.get('openlog').downstream;
    expect(bak).toHaveLength(1);
    expect(bak[0].id).toBe('pg');
    expect(bak[0].confidence).toBe('medium');
    expect(bak[0].evidence.kind).toBe('env_published_port');
    expect(bak[0].evidence.detail).toContain('127.0.0.1:5432');
    // 反方向：pg 的上游是 openlog
    expect(topo.get('pg').upstream.map((x) => x.id)).toEqual(['openlog']);
  });

  it('端口有多台容器发布时不算证据（避免瞎连）', () => {
    const pg2 = node({ id: 'pg2', names: ['pg-replica'], inspect: { ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } } });
    const topo = analyzeTopology([openlog, pg, pg2]);
    expect(topo.get('openlog').downstream).toHaveLength(0);
  });

  it('env 里的主机名等于对方容器名 → 高置信度', () => {
    const api = node({ id: 'api', names: ['api'], inspect: { env: ['REDIS_URL=redis://cache:6379/0'], networks: { app_default: { Aliases: null, IPAddress: '172.18.0.3' } } } });
    const cache = node({ id: 'cache', names: ['cache'], inspect: { networks: { app_default: { Aliases: ['cache'], IPAddress: '172.18.0.4' } } } });
    const topo = analyzeTopology([api, cache]);
    const down = topo.get('api').downstream;
    expect(down).toHaveLength(1);
    expect(down[0].confidence).toBe('high');
    expect(down[0].evidence.kind).toBe('env_alias');
  });

  it('compose depends_on 是最强证据', () => {
    const web = node({ id: 'web', names: ['web'], inspect: { labels: { 'com.docker.compose.depends_on': 'db' } } });
    const db = node({ id: 'db', names: ['db'] });
    const topo = analyzeTopology([web, db]);
    expect(topo.get('web').downstream[0]).toMatchObject({ id: 'db', confidence: 'high' });
    expect(topo.get('web').downstream[0].evidence.kind).toBe('compose_depends_on');
  });

  it('老式 --link 也算高置信度依赖', () => {
    const web = node({ id: 'w2', names: ['web2'], inspect: {} });
    // 直接构造带 links 的节点（buildNode 从 HostConfig.Links 读）
    const withLinks = { ...web, links: ['/db2:/w2/db'] };
    const db2 = node({ id: 'db2', names: ['db2'] });
    const topo = analyzeTopology([withLinks, db2]);
    const down = topo.get('w2').downstream;
    expect(down).toHaveLength(1);
    expect(down[0].evidence.kind).toBe('docker_link');
    expect(down[0].confidence).toBe('high');
  });

  it('同网但无调用证据 → 只进 peers，不算上下游', () => {
    const a = node({ id: 'a', names: ['a'], inspect: { networks: { bridge: { Aliases: null, IPAddress: '172.17.0.2' } } } });
    const b = node({ id: 'b', names: ['b'], inspect: { networks: { bridge: { Aliases: null, IPAddress: '172.17.0.3' } } } });
    const topo = analyzeTopology([a, b]);
    expect(topo.get('a').upstream).toEqual([]);
    expect(topo.get('a').downstream).toEqual([]);
    expect(topo.get('a').peers.map((p) => p.id)).toEqual(['b']);
    expect(topo.get('a').peers[0].networks).toEqual(['bridge']);
  });

  it('自引用不会产生自己指向自己的边', () => {
    const self = node({ id: 's', names: ['s'], inspect: { env: ['SELF_URL=http://s:80'] } });
    const topo = analyzeTopology([self]);
    expect(topo.get('s').downstream).toEqual([]);
  });

  it('无关 env 值（端口号、路径、布尔）不会瞎连线', () => {
    const a = node({ id: 'a', names: ['a'], inspect: { env: ['PORT=3001', 'DATA_DIR=/app/data', 'DEBUG=true', 'UV_HTTP_TIMEOUT=500'] } });
    const b = node({ id: 'b', names: ['b'] });
    expect(analyzeTopology([a, b]).get('a').downstream).toEqual([]);
  });

  it('多条证据时取最强的一条展示，但全部保留', () => {
    const web = node({ id: 'w', names: ['web'], inspect: { labels: { 'com.docker.compose.depends_on': 'db' }, env: ['DB_URL=postgres://db:5432/x'] } });
    const db = node({ id: 'd', names: ['db'], inspect: { ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] } } });
    const down = analyzeTopology([web, db]).get('w').downstream[0];
    expect(down.evidence.kind).toBe('compose_depends_on');
    expect(down.allEvidence.length).toBe(2);
  });

  it('bestEvidence 排序稳定：high 优先，同级别按 kind 顺序', () => {
    const list = [
      { kind: 'env_container_ip', confidence: 'medium', detail: '', value: '' },
      { kind: 'env_alias', confidence: 'high', detail: '', value: '' },
      { kind: 'env_published_port', confidence: 'medium', detail: '', value: '' },
    ];
    expect(bestEvidence(list).map((e) => e.kind)).toEqual(['env_alias', 'env_published_port', 'env_container_ip']);
  });
});

describe('真实生产数据的端到端形状', () => {
  it('复刻生产 86 容器里最关键的 3 条边', () => {
    const openlog = node({
      id: 'openlog', names: ['openlog'],
      inspect: {
        env: ['PORT=3001', 'OPENLOG_DATABASE_URL=postgres://openlog:OpenlogPg_uxkcg33995@127.0.0.1:5432/openlog'],
        networks: { host: { Aliases: null, IPAddress: '' } }, networkMode: 'host',
      },
    });
    const pg = node({ id: 'pg', names: ['openlog-pg'], inspect: { ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } } });
    const site = node({ id: 'site', names: ['openlog-site'], inspect: { ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '3003' }] } } });
    const nifi = node({ id: 'nifi', names: ['nifi'], inspect: { labels: { 'com.docker.compose.project': 'nifi', 'com.docker.compose.service': 'nifi' }, ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } } });

    const topo = analyzeTopology([openlog, pg, site, nifi]);
    expect(topo.get('openlog').downstream.map((x) => x.id)).toEqual(['pg']);
    expect(topo.get('pg').upstream.map((x) => x.id)).toEqual(['openlog']);
    // host 网络的 openlog 与 bridge 的其它容器不同网，peers 应为空 —— 这是事实，不是缺陷
    expect(topo.get('openlog').peers).toEqual([]);
    // site / nifi 之间没有调用证据，不产生上下游
    expect(topo.get('site').upstream).toEqual([]);
    expect(topo.get('nifi').upstream).toEqual([]);
  });
});
