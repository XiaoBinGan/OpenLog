/**
 * 自动发现：从容器 env / 端口映射推断数据库连接条件
 *
 * 这是「切机器能看到数据」的核心。真实性靠的是：**env 和端口就是容器自己的事实**，
 * 不是我们编的。这里逐条锁住推断规则，包括「推断不出来时要老实说」。
 */
import { describe, it, expect } from 'vitest';
import {
  discoverDbCandidate, discoverServiceCandidate, maskSecret, envMap,
  parseDbUrl, publishedPort, guessWebPort, candidateHint,
} from '../datasource/discover.js';

const container = (over = {}) => ({
  id: 'a1b2c3d4e5f6a7b8',
  shortId: 'a1b2c3d4e5f6',
  names: ['my-pg'],
  image: 'postgres:16-alpine',
  state: 'running',
  ports: [{ privatePort: 5432, publicPort: 15432, ip: '0.0.0.0' }],
  ...over,
});

const inspectOf = (env, { name = '/my-pg', image = 'postgres:16-alpine', ports = { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '15432' }] }, networkMode = 'bridge' } = {}) => ({
  Name: name,
  Config: { Image: image, Env: env },
  HostConfig: { NetworkMode: networkMode },
  NetworkSettings: { Ports: ports },
});

describe('maskSecret —— 密码只给「够辨认」，不能拿去登录', () => {
  it('短串全打码，长串只留首尾', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('abc')).toBe('****');
    expect(maskSecret('abcd')).toBe('****');
    expect(maskSecret('abcde')).toBe('a***e');
    expect(maskSecret('secret123')).toBe('se***23');
    expect(maskSecret('fake-password-01')).toBe('Su***7-');
  });
  it('打码结果永远不含完整原文（长度 8 以上）', () => {
    const pw = 'fake-password-01';
    const m = maskSecret(pw);
    expect(m).not.toContain(pw);
    expect(m.length).toBeLessThan(pw.length);
  });
});

describe('envMap / parseDbUrl', () => {
  it('env 数组转 map，忽略没有等号的行', () => {
    expect(envMap(['A=1', 'B=x=y', 'BROKEN', '', null])).toEqual({ A: '1', B: 'x=y' });
  });
  it('解析 postgres / mysql / redis / mongo 连接串', () => {
    expect(parseDbUrl('postgres://u:p@db:5432/app')).toMatchObject({ dialect: 'postgres', user: 'u', password: 'p', host: 'db', port: 5432, database: 'app' });
    expect(parseDbUrl('mysql://root:pw@host:3306/x')).toMatchObject({ dialect: 'mysql', port: 3306, database: 'x' });
    expect(parseDbUrl('redis://:pw@cache:6379/0')).toMatchObject({ dialect: 'redis', password: 'pw', host: 'cache' });
    expect(parseDbUrl('mongodb://a:b@m:27017/d')).toMatchObject({ dialect: 'mongo' });
  });
  it('百分号编码的密码会解码；非数据库协议返回 null', () => {
    expect(parseDbUrl('postgres://u:p%40ss@h:5432/d')?.password).toBe('p@ss');
    expect(parseDbUrl('http://example.com/x')).toBe(null);
    expect(parseDbUrl('这不是URL')).toBe(null);
    expect(parseDbUrl('')).toBe(null);
  });
});

describe('publishedPort / guessWebPort', () => {
  it('只在精确匹配容器端口时返回宿主端口', () => {
    const ports = [{ PrivatePort: 5432, PublicPort: 15432 }, { PrivatePort: 8080, PublicPort: 8081 }];
    expect(publishedPort(ports, 5432)).toBe(15432);
    expect(publishedPort(ports, 5433)).toBe(null);
    expect(publishedPort(null, 5432)).toBe(null);
  });
  it('挑 Web 端口时跳过数据库端口', () => {
    expect(guessWebPort([{ PrivatePort: 5432, PublicPort: 15432 }, { PrivatePort: 8080, PublicPort: 18080 }]))
      .toEqual({ containerPort: 8080, hostPort: 18080 });
    expect(guessWebPort([{ PrivatePort: 6379, PublicPort: 16379 }])).toBe(null);
  });
});

describe('discoverDbCandidate —— postgres', () => {
  it('env 齐 + 端口已发布 → 可连，密码打码，能拼出 host', () => {
    const [c] = discoverDbCandidate({
      container: container(),
      inspect: inspectOf(['POSTGRES_USER=openlog', 'POSTGRES_PASSWORD=fake-password-01', 'POSTGRES_DB=openlog']),
      hostHint: '203.0.113.10',
    });
    expect(c).toMatchObject({
      kind: 'db', dialect: 'postgres', samplable: true, reachable: true,
      host: '203.0.113.10', port: 15432, user: 'openlog', database: 'openlog',
      hasPassword: true, collection: 'local',
    });
    expect(c.passwordMasked).not.toContain('fake-password-01');
    expect(c.id).toBe('db:local:a1b2c3d4e5f6');
  });

  it('优先用完整 URL（一条就够，不用零散 env）', () => {
    const [c] = discoverDbCandidate({
      container: container(),
      inspect: inspectOf(['DATABASE_URL=postgres://appuser:apppw@127.0.0.1:5432/appdb', 'POSTGRES_PASSWORD=ignored']),
      hostHint: '10.0.0.5',
    });
    expect(c.fromUrl).toBe(true);
    expect(c.user).toBe('appuser');
    expect(c.database).toBe('appdb');
    // URL 里给的是 127.0.0.1，但仍然用宿主端口映射算出对外端口
    expect(c.port).toBe(15432);
  });

  it('端口没发布 → reachable=false，并且给出人话原因（不假装能连）', () => {
    const [c] = discoverDbCandidate({
      container: container({ ports: [] }),
      inspect: inspectOf(['POSTGRES_PASSWORD=pw'], { ports: {} }),
      hostHint: '1.2.3.4',
    });
    expect(c.reachable).toBe(false);
    expect(c.reason).toContain('未发布到宿主机');
    expect(candidateHint(c)).toContain('连不进去');
  });

  it('host 网络模式：不需要端口发布也能连', () => {
    const [c] = discoverDbCandidate({
      container: container({ ports: [] }),
      inspect: inspectOf(['POSTGRES_PASSWORD=pw'], { ports: {}, networkMode: 'host' }),
      hostHint: '1.2.3.4',
    });
    expect(c.reachable).toBe(true);
    expect(c.host).toBe('1.2.3.4');
    expect(c.port).toBe(5432);
  });

  it('镜像不是数据库 → 空数组（绝不拿名字模糊匹配硬套）', () => {
    expect(discoverDbCandidate({ container: container({ image: 'nginx:alpine' }), inspect: inspectOf([], { image: 'nginx:alpine' }), hostHint: 'h' })).toEqual([]);
    expect(discoverDbCandidate({ container: container({ image: 'my-postgres-backup:1.0' }), inspect: inspectOf([], { image: 'my-postgres-backup:1.0' }), hostHint: 'h' })).toEqual([]);
  });

  it('识别常见变体镜像（pgvector / timescaledb / mariadb）', () => {
    for (const image of ['pgvector/pgvector:pg16', 'timescale/timescaledb:latest-pg16', 'mariadb:11', 'bitnami/postgresql:16']) {
      const out = discoverDbCandidate({ container: container({ image }), inspect: inspectOf(['X=1'], { image }), hostHint: 'h' });
      expect(out.length, image).toBe(1);
    }
  });

  it('没有密码也能给出候选，但提示「可能是 trust 认证」', () => {
    const [c] = discoverDbCandidate({ container: container(), inspect: inspectOf(['POSTGRES_USER=u']), hostHint: 'h' });
    expect(c.hasPassword).toBe(false);
    expect(c.passwordMasked).toBe('');
    expect(candidateHint(c)).toContain('未发现密码');
  });
});

describe('discoverDbCandidate —— mysql', () => {
  it('MYSQL_ROOT_PASSWORD 也会被抓到', () => {
    const [c] = discoverDbCandidate({
      container: container({ image: 'mysql:8', ports: [{ privatePort: 3306, publicPort: 13306 }] }),
      inspect: inspectOf(['MYSQL_ROOT_PASSWORD=rootpw', 'MYSQL_DATABASE=shop', 'MYSQL_USER=app'], {
        image: 'mysql:8', ports: { '3306/tcp': [{ HostIp: '0.0.0.0', HostPort: '13306' }] },
      }),
      hostHint: 'h',
    });
    expect(c).toMatchObject({ dialect: 'mysql', samplable: true, port: 13306, user: 'app', database: 'shop', hasPassword: true });
  });
});

describe('discoverDbCandidate —— redis / mongo 只做候选，标注不可采样', () => {
  it('redis 不进 samplable，hint 说清楚', () => {
    const [c] = discoverDbCandidate({
      container: container({ image: 'redis:7', ports: [{ privatePort: 6379, publicPort: 16379 }] }),
      inspect: inspectOf(['REDIS_PASSWORD=rpw'], { image: 'redis:7', ports: { '6379/tcp': [{ HostIp: '0.0.0.0', HostPort: '16379' }] } }),
      hostHint: 'h',
    });
    expect(c.dialect).toBe('redis');
    expect(c.samplable).toBe(false);
    expect(candidateHint(c)).toContain('只支持连通性探测');
  });
});

describe('discoverServiceCandidate —— 哪些容器值得去探 swagger', () => {
  it('有 Web 端口的非数据库容器 → 给 baseUrl', () => {
    const [c] = discoverServiceCandidate({
      container: container({ image: 'my-api:1.0', ports: [{ privatePort: 8080, publicPort: 18080 }] }),
      inspect: inspectOf([], { image: 'my-api:1.0', ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '18080' }] } }),
      hostHint: '10.0.0.9',
    });
    expect(c).toMatchObject({ kind: 'service', baseUrl: 'http://10.0.0.9:18080', containerPort: 8080 });
  });
  it('数据库容器不会被当成 Web 服务', () => {
    expect(discoverServiceCandidate({ container: container(), inspect: inspectOf(['POSTGRES_PASSWORD=p']), hostHint: 'h' })).toEqual([]);
  });
  it('没有 hostHint 时不给候选（给了也连不上）', () => {
    expect(discoverServiceCandidate({ container: container({ image: 'x:1' }), inspect: inspectOf([], { image: 'x:1' }), hostHint: '' })).toEqual([]);
  });
});
