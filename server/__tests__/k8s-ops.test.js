/**
 * routes/k8s-ops.js + k8s/audit.js 测试（A4，契约见 /tmp/hami-k8s-contract.md）
 *
 * 测什么：**路由语义与安全闸门**。真实 apiserver 不在测试范围内 ——
 * 传输层通过 `createK8sOpsRouter` 的注入点换成假实现，断言 method / URL / body
 * 与客户端真实会发出的请求一致（K8s 写端点的行为由集群侧保证）。
 *
 * 覆盖：
 *   1. 写开关（403）三个端点各一，且闸门优先于「集群不存在」与入参校验
 *   2. 演示模式（409）优先于 403
 *   3. replicas 0..1000 整数校验（含边界 0 / 1000）
 *   4. kind 白名单、namespace/name 的 DNS-1123 校验
 *   5. 成功路径：scale / restart / delete 的 PATCH-DELETE URL、body、content-type
 *   6. 审计：写入字段、actor 推断、失败留痕、环形缓冲 200 条上限、limit / _reset
 *   7. 集群 404、kubeconfig 缺失 400、上游 5xx→502、上游 404→404
 *
 * 注意：本文件会改 OPENLOG_K8S_WRITE / OPENLOG_DEMO，用 beforeEach 重置、
 * afterAll 还原，避免影响同 worker 内的其它用例。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';

import { createK8sOpsRouter } from '../routes/k8s-ops.js';
import * as audit from '../k8s/audit.js';

// ── 可变测试状态 ──────────────────────────────────────────────────
/** 写请求记录（断言 URL/method/body 用） */
const h = {
  writes: [],
  reads: [],
  settings: { k8sClusters: [] },
  /** 写请求要抛的错误（模拟上游失败） */
  writeError: null,
  /** 写请求的成功响应体（默认 {}） */
  writeBody: { ok: true },
  /** scale 前读到的旧副本数 */
  readValue: undefined,
  readError: null,
};

const KUBECONFIG_TEXT = [
  'apiVersion: v1',
  'kind: Config',
  'current-context: k3s',
  'clusters:',
  '- name: k3s',
  '  cluster:',
  '    server: https://127.0.0.1:6443',
  'users:',
  '- name: admin',
  '  user:',
  '    token: fake-token',
].join('\n');

const RESOLVED = Object.freeze({
  server: 'https://127.0.0.1:6443',
  authType: 'token',
  token: 'fake-token',
  insecureSkipTlsVerify: true,
  contextName: 'k3s',
});

/** 假传输层：记录请求并按配置返回/抛错 */
async function fakeRequest(resolved, options) {
  h.writes.push({
    server: resolved?.server,
    token: resolved?.token,
    method: options?.method,
    path: options?.path,
    body: options?.body,
    contentType: options?.contentType,
  });
  if (h.writeError) throw h.writeError;
  return { statusCode: 200, headers: {}, body: JSON.stringify(h.writeBody) };
}

/** 假读传输层（scale 前读旧副本数） */
async function fakeReadJson(resolved, path) {
  h.reads.push({ server: resolved?.server, path });
  if (h.readError) throw h.readError;
  return h.readValue;
}

/** 构造带 status 的上游错误（模拟 kubeRequest 抛出的形状） */
function upstreamError(status) {
  const err = new Error(`Kubernetes API 请求失败（HTTP ${status}）`);
  err.status = status;
  err.upstream = true;
  return err;
}

// ── 服务 ─────────────────────────────────────────────────────────

const router = createK8sOpsRouter({
  ensureSettings: () => h.settings,
  getClusterRecord: (settings, id) => (settings.k8sClusters || []).find((c) => c.id === id),
  parseKubeconfig: (text, contextName) => {
    if (typeof text !== 'string' || !text.includes('server')) throw new Error('缺少 server 字段');
    return { ...RESOLVED, contextName: contextName || 'k3s' };
  },
  request: fakeRequest,
  readJson: fakeReadJson,
  // 审计走真实模块：断言「路由确实写了审计」而不是「路由调了个 mock」
});

let server;
let base;

beforeAll(async () => {
  const app = express();
  // 刻意**不**装 app 级 express.json()：router 自带 body 解析，顺带验证模块可独立挂载
  app.use(router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

function seedCluster(overrides = {}) {
  h.settings = {
    k8sClusters: [{
      id: 'c-1',
      name: 'k3s 测试集群',
      kubeconfig: KUBECONFIG_TEXT,
      context: 'k3s',
      enabled: true,
      ...overrides,
    }],
  };
  return h.settings.k8sClusters[0];
}

const ORIGINAL_WRITE = process.env.OPENLOG_K8S_WRITE;
const ORIGINAL_DEMO = process.env.OPENLOG_DEMO;

beforeEach(() => {
  h.writes = [];
  h.reads = [];
  h.writeError = null;
  h.writeBody = { ok: true };
  h.readValue = undefined;
  h.readError = null;
  seedCluster();
  audit._reset();
  // 默认：写关闭、非演示
  delete process.env.OPENLOG_K8S_WRITE;
  delete process.env.OPENLOG_DEMO;
});

afterEach(() => {
  delete process.env.OPENLOG_K8S_WRITE;
  delete process.env.OPENLOG_DEMO;
});

afterAll(() => {
  if (ORIGINAL_WRITE === undefined) delete process.env.OPENLOG_K8S_WRITE;
  else process.env.OPENLOG_K8S_WRITE = ORIGINAL_WRITE;
  if (ORIGINAL_DEMO === undefined) delete process.env.OPENLOG_DEMO;
  else process.env.OPENLOG_DEMO = ORIGINAL_DEMO;
});

function enableWrite() {
  process.env.OPENLOG_K8S_WRITE = '1';
}

async function request(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, body: json, text };
}

const SCALE_PATH = '/api/k8s/clusters/c-1/workloads/default/deployments/web/scale';
const RESTART_PATH = '/api/k8s/clusters/c-1/workloads/default/statefulsets/db/restart';
const DELETE_PATH = '/api/k8s/clusters/c-1/pods/app/web-0';

// ═══ 1. 写开关（403）═════════════════════════════════════════════════

describe('写开关未开启 → 403', () => {
  it('scale 返回 403 + readOnly，且不发任何上游请求', async () => {
    const res = await request('POST', SCALE_PATH, { replicas: 3 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: '写操作未启用（设置 OPENLOG_K8S_WRITE=1 后生效）',
      readOnly: true,
    });
    expect(h.writes).toHaveLength(0);
  });

  it('restart 返回 403', async () => {
    const res = await request('POST', RESTART_PATH);
    expect(res.status).toBe(403);
    expect(res.body.readOnly).toBe(true);
    expect(h.writes).toHaveLength(0);
  });

  it('delete pod 返回 403', async () => {
    const res = await request('DELETE', DELETE_PATH);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('OPENLOG_K8S_WRITE');
    expect(h.writes).toHaveLength(0);
  });

  it('OPENLOG_K8S_WRITE 只认字面量 "1"（"true" 仍然是 403）', async () => {
    process.env.OPENLOG_K8S_WRITE = 'true';
    const res = await request('POST', SCALE_PATH, { replicas: 3 });
    expect(res.status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });

  it('闸门优先于集群 404 与入参 400', async () => {
    // 集群不存在 + replicas 非法，仍然必须是 403（否则闸门形状就不稳定了）
    const missing = await request('POST', '/api/k8s/clusters/nope/workloads/default/deployments/web/scale', { replicas: -1 });
    expect(missing.status).toBe(403);
    expect(missing.body).toEqual({
      error: '写操作未启用（设置 OPENLOG_K8S_WRITE=1 后生效）',
      readOnly: true,
    });
  });

  it('被拦下的请求也留审计（result=blocked）', async () => {
    await request('POST', SCALE_PATH, { replicas: 3 });
    const entries = audit.listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'scale',
      cluster: 'c-1',
      target: 'default/deployments/web',
      result: 'blocked',
    });
    expect(entries[0].detail).toContain('写操作未启用');
  });

  it('三个端点的 blocked 审计各自记对 action 与 target', async () => {
    await request('POST', RESTART_PATH);
    await request('DELETE', DELETE_PATH);
    await request('POST', SCALE_PATH, { replicas: 3 });

    // 新的在前
    const [scaleEntry, deleteEntry, restartEntry] = audit.listAudit();
    expect(restartEntry).toMatchObject({ action: 'restart', target: 'default/statefulsets/db' });
    expect(deleteEntry).toMatchObject({ action: 'delete-pod', target: 'app/pods/web-0', cluster: 'c-1' });
    expect(scaleEntry).toMatchObject({ action: 'scale', target: 'default/deployments/web' });
    expect(audit.listAudit().every((e) => e.result === 'blocked')).toBe(true);
  });

  it('坏 JSON body 也先撞闸门（闸门在 body 解析之前）→ 403', async () => {
    const res = await request('POST', SCALE_PATH, '{oops', { 'Content-Type': 'application/json' });
    expect(res.status).toBe(403);
    expect(res.body.readOnly).toBe(true);
  });
});

// ═══ 2. 演示模式（409，优先于 403）══════════════════════════════════

describe('演示模式 → 409（优先于 403）', () => {
  it('未开写 + 演示 → 409，不是 403', async () => {
    process.env.OPENLOG_DEMO = '1';
    const res = await request('POST', SCALE_PATH, { replicas: 3 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ demo: true, error: '演示模式：该操作已被禁用' });
  });

  it('开了写 + 演示 → 仍然是 409（演示优先）', async () => {
    enableWrite();
    process.env.OPENLOG_DEMO = '1';
    const res = await request('POST', RESTART_PATH);
    expect(res.status).toBe(409);
    expect(h.writes).toHaveLength(0);
  });

  it('演示模式下 delete 也是 409，且不触达集群', async () => {
    enableWrite();
    process.env.OPENLOG_DEMO = '1';
    const res = await request('DELETE', DELETE_PATH);
    expect(res.status).toBe(409);
    expect(res.body.demo).toBe(true);
    expect(h.writes).toHaveLength(0);
  });
});

// ═══ 3. replicas 校验 ════════════════════════════════════════════════

describe('replicas 校验（0..1000 整数）', () => {
  beforeEach(enableWrite);

  it.each([
    ['负数', -1],
    ['超上限', 1001],
    ['小数', 1.5],
    ['字符串', '3'],
    ['null', null],
    ['缺失', undefined],
  ])('%s → 400，不发上游请求', async (_label, value) => {
    const payload = value === undefined ? {} : { replicas: value };
    const res = await request('POST', SCALE_PATH, payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('replicas');
    expect(h.writes).toHaveLength(0);
  });

  it('非法 replicas 也留审计（result=error）', async () => {
    await request('POST', SCALE_PATH, { replicas: 99999 });
    const entries = audit.listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('error');
    expect(entries[0].detail).toContain('replicas');
  });
});

// ═══ 4. kind 白名单与命名校验 ════════════════════════════════════════

describe('kind 白名单', () => {
  beforeEach(enableWrite);

  it.each(['daemonsets', 'Deployment', 'pods'])('kind=%s → 400', async (kind) => {
    const path = `/api/k8s/clusters/c-1/workloads/default/${kind}/web/scale`;
    const res = await request('POST', path, { replicas: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('kind');
    expect(h.writes).toHaveLength(0);
  });

  it('kind 段为空（双斜杠）时路由不匹配 → 404，不会误进写逻辑', async () => {
    const res = await request('POST', '/api/k8s/clusters/c-1/workloads/default//web/scale', { replicas: 1 });
    expect(res.status).toBe(404);
    expect(h.writes).toHaveLength(0);
  });
});

describe('namespace / name 的 DNS-1123 校验', () => {
  beforeEach(enableWrite);

  it('namespace 含下划线 → 400', async () => {
    const res = await request('POST', '/api/k8s/clusters/c-1/workloads/Bad_NS/deployments/web/scale', { replicas: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('命名空间');
  });

  it('name 以连字符开头 → 400', async () => {
    const res = await request('POST', '/api/k8s/clusters/c-1/workloads/default/deployments/-web/scale', { replicas: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('名称');
  });

  it('name 超过 63 字符 → 400', async () => {
    const name = 'a'.repeat(64);
    const res = await request('POST', `/api/k8s/clusters/c-1/workloads/default/deployments/${name}/restart`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('63');
  });

  it('Pod 名称非法 → 400（delete 端点）', async () => {
    const res = await request('DELETE', '/api/k8s/clusters/c-1/pods/default/Web_0');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Pod 名称');
  });
});

// ═══ 5. 成功路径（断言 method / URL / body）══════════════════════════

describe('POST .../scale 成功路径', () => {
  beforeEach(enableWrite);

  it('PATCH Scale 子资源，body 是 autoscaling/v1 Scale', async () => {
    h.readValue = { spec: { replicas: 2 } };
    h.writeBody = { apiVersion: 'autoscaling/v1', kind: 'Scale', spec: { replicas: 5 } };

    const res = await request('POST', SCALE_PATH, { replicas: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      action: 'scale',
      target: 'default/deployments/web',
      replicas: 5,
      previousReplicas: 2,
    });
    expect(typeof res.body.auditId).toBe('string');

    // 传输层收到的请求
    expect(h.writes).toHaveLength(1);
    const [write] = h.writes;
    expect(write.method).toBe('PATCH');
    expect(write.path).toBe('/apis/apps/v1/namespaces/default/deployments/web/scale');
    expect(write.contentType).toBe('application/merge-patch+json');
    expect(write.body).toEqual({
      apiVersion: 'autoscaling/v1',
      kind: 'Scale',
      metadata: { name: 'web', namespace: 'default' },
      spec: { replicas: 5 },
    });
    expect(write.server).toBe('https://127.0.0.1:6443');

    // 旧副本数是走只读客户端（client.js）读的 scale 子资源
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0].path).toBe('/apis/apps/v1/namespaces/default/deployments/web/scale');
  });

  it('边界值 0（缩容到零）与 1000 都放行', async () => {
    h.writeBody = { spec: { replicas: 0 } };
    const zero = await request('POST', SCALE_PATH, { replicas: 0 });
    expect(zero.status).toBe(200);
    expect(h.writes[0].body.spec.replicas).toBe(0);

    h.writes = [];
    h.writeBody = { spec: { replicas: 1000 } };
    const max = await request('POST', SCALE_PATH, { replicas: 1000 });
    expect(max.status).toBe(200);
    expect(h.writes[0].body.spec.replicas).toBe(1000);
  });

  it('读旧副本数失败不阻塞写操作', async () => {
    h.readError = new Error('读超时');
    h.writeBody = { spec: { replicas: 4 } };
    const res = await request('POST', SCALE_PATH, { replicas: 4 });
    expect(res.status).toBe(200);
    expect(res.body.previousReplicas).toBeUndefined();
    expect(h.writes).toHaveLength(1);
  });
});

describe('POST .../restart 成功路径', () => {
  beforeEach(enableWrite);

  it('PATCH 工作负载，只打 openlog/restartedAt 注解', async () => {
    const res = await request('POST', RESTART_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'restart', target: 'default/statefulsets/db' });
    expect(res.body.restartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(h.writes).toHaveLength(1);
    const [write] = h.writes;
    expect(write.method).toBe('PATCH');
    expect(write.path).toBe('/apis/apps/v1/namespaces/default/statefulsets/db');
    expect(write.contentType).toBe('application/merge-patch+json');
    expect(write.body).toEqual({
      spec: { template: { metadata: { annotations: { 'openlog/restartedAt': res.body.restartedAt } } } },
    });
    // 不该顺手改 replicas / image
    expect(Object.keys(write.body)).toEqual(['spec']);
    expect(Object.keys(write.body.spec)).toEqual(['template']);
  });
});

describe('DELETE .../pods/:name 成功路径', () => {
  beforeEach(enableWrite);

  it('DELETE Pod，带 gracePeriodSeconds=30', async () => {
    h.writeBody = { kind: 'Status', status: 'Success' };
    const res = await request('DELETE', DELETE_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      action: 'delete-pod',
      target: 'app/pods/web-0',
      gracePeriodSeconds: 30,
    });

    expect(h.writes).toHaveLength(1);
    const [write] = h.writes;
    expect(write.method).toBe('DELETE');
    expect(write.path).toBe('/api/v1/namespaces/app/pods/web-0');
    expect(write.contentType).toBe('application/json');
    expect(write.body).toEqual({ apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds: 30 });
  });
});

// ═══ 6. 审计 ═════════════════════════════════════════════════════════

describe('审计记录', () => {
  beforeEach(enableWrite);

  it('成功操作写入完整字段（含 actor 与 detail）', async () => {
    h.readValue = { spec: { replicas: 1 } };
    h.writeBody = { spec: { replicas: 3 } };
    await request('POST', SCALE_PATH, { replicas: 3 }, { 'X-OpenLog-Actor': 'alice' });

    const [entry] = audit.listAudit();
    expect(entry).toMatchObject({
      action: 'scale',
      cluster: 'c-1',
      target: 'default/deployments/web',
      actor: 'alice',
      result: 'ok',
    });
    expect(entry.detail).toBe('replicas 1 → 3');
    expect(entry.id).toMatch(/^k8s-audit-/);
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('没有 X-OpenLog-Actor 时 actor 退化为 local', async () => {
    await request('POST', RESTART_PATH);
    expect(audit.listAudit()[0].actor).toBe('local');
  });

  it('带 Bearer 令牌的请求 actor 记为 api-token', async () => {
    await request('DELETE', DELETE_PATH, undefined, { Authorization: 'Bearer some-token' });
    expect(audit.listAudit()[0].actor).toBe('api-token');
  });

  it('环形缓冲上限 200：写 250 条只保留最新 200，新的在前', () => {
    for (let i = 0; i < 250; i += 1) {
      audit.recordAudit({ action: 'scale', cluster: 'c-1', target: `n-${i}`, actor: 'local', result: 'ok' });
    }
    const entries = audit.listAudit();
    expect(entries).toHaveLength(200);
    expect(entries[0].target).toBe('n-249');
    expect(entries[199].target).toBe('n-50');
    expect(audit.auditCount()).toBe(200);
  });

  it('listAudit(limit) 夹在 1..200，_reset 清空', () => {
    for (let i = 0; i < 5; i += 1) {
      audit.recordAudit({ action: 'restart', cluster: 'c-1', target: `w-${i}` });
    }
    expect(audit.listAudit(2)).toHaveLength(2);
    expect(audit.listAudit(0)).toHaveLength(5);
    expect(audit.listAudit(9999)).toHaveLength(5);

    audit._reset();
    expect(audit.listAudit()).toHaveLength(0);
    expect(audit.auditCount()).toBe(0);
  });

  it('recordAudit 归一化：未知 result 回落 ok，detail 对象序列化并截断', () => {
    const entry = audit.recordAudit({
      action: 'scale',
      cluster: 'c-1',
      target: 'default/deployments/web',
      result: 'bogus',
      detail: { note: 'x'.repeat(900) },
    });
    expect(entry.result).toBe('ok');
    expect(entry.detail.startsWith('{"note"')).toBe(true);
    expect(entry.detail.length).toBeLessThanOrEqual(501); // 500 + 省略号
  });

  it('listAuditByCluster 只返回该集群的记录', () => {
    audit.recordAudit({ action: 'scale', cluster: 'c-1', target: 'a' });
    audit.recordAudit({ action: 'scale', cluster: 'c-2', target: 'b' });
    expect(audit.listAuditByCluster('c-2').map((e) => e.target)).toEqual(['b']);
    expect(audit.listAuditByCluster('')).toHaveLength(2);
  });
});

// ═══ 7. 集群与上游错误 ═══════════════════════════════════════════════

describe('集群解析与上游错误', () => {
  beforeEach(enableWrite);

  it('集群 id 不存在 → 404，不发上游请求', async () => {
    const res = await request('POST', '/api/k8s/clusters/nope/workloads/default/deployments/web/scale', { replicas: 2 });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('集群不存在');
    expect(h.writes).toHaveLength(0);
  });

  it('集群没配置 kubeconfig → 400', async () => {
    seedCluster({ kubeconfig: '  ' });
    const res = await request('POST', RESTART_PATH);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('kubeconfig');
    expect(h.writes).toHaveLength(0);
  });

  it('上游 5xx → 502，且审计记 error', async () => {
    h.writeError = upstreamError(500);
    const res = await request('POST', SCALE_PATH, { replicas: 2 });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('HTTP 500');
    const [entry] = audit.listAudit();
    expect(entry.result).toBe('error');
    expect(entry.detail).toContain('HTTP 500');
  });

  it('上游 404（工作负载已被删）→ 404', async () => {
    h.writeError = upstreamError(404);
    const res = await request('DELETE', DELETE_PATH);
    expect(res.status).toBe(404);
  });

  it('上游 403（RBAC 权限不足）折成 502，避免与写开关的 403 混淆', async () => {
    h.writeError = upstreamError(403);
    const res = await request('POST', RESTART_PATH);
    expect(res.status).toBe(502);
    expect(res.body.readOnly).toBeUndefined();
  });

  it('请求体不是合法 JSON → 400 且响应仍是 JSON', async () => {
    const res = await request('POST', SCALE_PATH, '{oops', { 'Content-Type': 'application/json' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('JSON');
  });
});
