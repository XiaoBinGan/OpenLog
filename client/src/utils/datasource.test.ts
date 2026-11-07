/**
 * client/src/utils/datasource.test.ts —— 数据源面板纯逻辑
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeDatasource, normalizeDatasourceList, normalizeDiscover, candidateToPayload,
  describeTarget, summarizeProbe, probeNotes, attemptedPaths, relativeTime, dataNatureLabel,
} from './datasource';

describe('normalizeDatasource', () => {
  it('完整字段保真', () => {
    const d = normalizeDatasource({
      id: 'db:local:abc', kind: 'db', collection: 'local', label: 'my-pg', dialect: 'postgres',
      host: '10.0.0.1', port: 5432, user: 'u', database: 'app', enabled: true,
      hasPassword: true, passwordMasked: 'Su***7-', lastProbeMs: 12, lastStatus: 'ok', lastProbeAt: 1000, createdAt: 5,
    });
    expect(d).toMatchObject({ id: 'db:local:abc', dialect: 'postgres', port: 5432, lastStatus: 'ok' });
  });

  it('脏数据落地：非对象/缺字段/port 非数字', () => {
    expect(normalizeDatasource(null).id).toBe('unknown');
    const d = normalizeDatasource({ id: 'x', port: 'abc', enabled: 'yes' });
    expect(d.port).toBe(null);
    expect(d.enabled).toBe(true); // 只有显式 false 才算关闭
    expect(normalizeDatasource({ id: 'y', enabled: false }).enabled).toBe(false);
  });

  it('列表过滤掉没有 id 的条目', () => {
    const list = normalizeDatasourceList([{ id: 'a' }, {}, null, { id: 'b' }]);
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
    expect(normalizeDatasourceList(null)).toEqual([]);
  });
});

describe('normalizeDiscover', () => {
  it('可连的候选排前面', () => {
    const r = normalizeDiscover({
      dbCandidates: [
        { id: '1', reachable: false, containerName: 'a' },
        { id: '2', reachable: true, containerName: 'b' },
      ],
      serviceCandidates: [{ id: 's1' }],
      errors: ['x'],
      scannedSources: 3,
    });
    expect(r.dbCandidates.map((c) => c.id)).toEqual(['2', '1']);
    expect(r.serviceCandidates).toHaveLength(1);
    expect(r.errors).toEqual(['x']);
    expect(r.scannedSources).toBe(3);
  });

  it('字段缺失/非数组都给空，不炸', () => {
    const r = normalizeDiscover({ dbCandidates: 'nope', serviceCandidates: null });
    expect(r.dbCandidates).toEqual([]);
    expect(r.serviceCandidates).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});

describe('candidateToPayload', () => {
  it('db 候选 → 保存载荷（不含密码明文）', () => {
    const p = candidateToPayload({
      kind: 'db', id: 'db:local:a', collection: 'local', dialect: 'postgres', samplable: true,
      containerName: 'pg', image: 'postgres:16', host: 'h', port: 15432, user: 'u',
      passwordMasked: 'Su***7-', hasPassword: true, database: 'app', fromUrl: false, reachable: true, reason: '',
    });
    expect(p).toMatchObject({ kind: 'db', host: 'h', port: 15432, user: 'u', database: 'app' });
    expect(p.password).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('Su***7-');
  });

  it('service 候选 → 带 baseUrl，不带数据库字段', () => {
    const p = candidateToPayload({
      kind: 'service', id: 'svc:local:a', collection: 'local', containerName: 'api', image: 'x:1',
      baseUrl: 'http://h:8080', containerPort: 8080,
    });
    expect(p).toMatchObject({ kind: 'service', baseUrl: 'http://h:8080' });
    expect(p.dialect).toBeUndefined();
  });
});

describe('describeTarget', () => {
  const base = normalizeDatasource({ id: 'a' });
  it('db 显示 host:port/db', () => {
    expect(describeTarget({ ...base, kind: 'db', host: 'h', port: 5432, database: 'app' })).toBe('h:5432/app');
  });
  it('缺字段时明确说缺什么，不显示成奇怪的空串', () => {
    expect(describeTarget({ ...base, kind: 'db' })).toContain('未填主机');
  });
  it('service 显示 baseUrl', () => {
    expect(describeTarget({ ...base, kind: 'service', baseUrl: 'http://h:1' })).toBe('http://h:1');
  });
});

describe('summarizeProbe', () => {
  it('失败 → 原文原因（不吞成「失败」两个字）', () => {
    const s = summarizeProbe({ ok: false, error: '连接被拒绝：端口没有在监听' });
    expect(s.ok).toBe(false);
    expect(s.text).toContain('连接被拒绝');
  });

  it('db 成功 → 版本 / 连接数 / 表数 / 权限不足项数', () => {
    const s = summarizeProbe({
      ok: true, ms: 20, version: 'PostgreSQL 16.3', conns: { total: 7, active: 2 },
      tables: [{ relname: 'a' }, { relname: 'b' }], unavailable: ['x: 权限不足'],
    });
    expect(s.text).toContain('PostgreSQL 16.3');
    expect(s.text).toContain('连接 2/7');
    expect(s.text).toContain('2 张表');
    expect(s.text).toContain('1 项权限不足');
  });

  it('文档探测成功 → 标题/版本/接口数/命中地址/耗时', () => {
    const s = summarizeProbe({
      ok: true, ms: 33, found: '/openapi.json',
      summary: { title: 'Pet API', version: '1.2.0', endpoints: [{ method: 'GET', path: '/pets' }] },
    });
    expect(s.text).toBe('Pet API v1.2.0 · 1 个接口 · /openapi.json · 33ms');
  });

  it('找到文档但拿不到清单 → 如实说，不假装成功', () => {
    const s = summarizeProbe({ ok: true, found: '/docs', ms: 10, summary: null });
    expect(s.text).toContain('拿不到接口清单');
  });
});

describe('probeNotes / attemptedPaths', () => {
  it('部分成功时的权限不足说明会带出来', () => {
    expect(probeNotes({ ok: true, unavailable: ['连接数: 权限不足'], error: '' })).toEqual(['连接数: 权限不足']);
    expect(probeNotes({ ok: false, error: '连不上', unavailable: [] })).toEqual([]);
  });
  it('尝试过的地址列表可读', () => {
    const out = attemptedPaths({ attempts: [{ path: '/a', status: 404 }, { path: '/b', status: null, error: 'timeout' }] });
    expect(out).toEqual(['/a → HTTP 404', '/b → timeout']);
  });
});

describe('relativeTime', () => {
  it('各档位', () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime(now - 30_000, now)).toBe('刚刚');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 天前');
  });
});

describe('dataNatureLabel', () => {
  it('两类数据的区别必须能被界面说清', () => {
    expect(dataNatureLabel('spec')).toContain('不含调用量');
    expect(dataNatureLabel('traffic')).toContain('埋点');
  });
});
