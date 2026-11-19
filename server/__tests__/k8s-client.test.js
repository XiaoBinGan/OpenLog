import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import https from 'node:https';
import { createK8sClient } from '../k8s/client.js';

/**
 * createK8sClient 的单测：完全不依赖 kubeconfig.js（那是别的 agent 的模块），
 * 直接把「解析结果」构造成对象喂进来。
 *
 * 传输层用 node:https 起一个**自签证书**的本地服务（随机端口）：
 * - 自签证书正好可以把 insecureSkipTlsVerify 的两种行为都测到（true 能连、false 连不上）；
 * - 同一张证书同时充当客户端证书和信任的 CA，就能验证 mTLS 确实把 cert/key 发出去了；
 * - 不 stub node:https，测的是真实 socket 行为（超时、状态码、头）。
 */

// 测试专用自签证书（CN=127.0.0.1，SAN=IP:127.0.0.1）。仅用于本地回环，不当任何生产凭证。
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUBh66CfH4/w/L5t/nuL7NwdmeytYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTExODE1MjgzNVoXDTM2MTEx
NTE1MjgzNVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA0VKBvAhb/zJVviIUeumlmJNsPj4g4dhc7ji06I3JCudt
adEXLhWIPwAq8QHtzaAknW8jPvGPhlqS2PrEkNXcYyqMj7XAvvKs06FsxtMD81PI
XuBN9shwEA6Ba8q3pPCUkp0vI87yGUurEkhwqJxofj5WNqCFz4PyQLZBiGos2sJb
yc4p6CrxQVPy+T+axwWehBi0HOvM64MVDPXRjwOMjV7VIXi7CIDy2MdMCxY9oGv6
OwqvHVaLetppOfEQKKJ0sm/srD3QJMeCelaolB8e4u6MYUqAkIWhcYqzSpJQarJg
wwpUgPcNZYH9DFzurXptyqtWFJgfysjiT5+5oPlGLQIDAQABo28wbTAdBgNVHQ4E
FgQUvXTQiwF1PfF7qrhR5nrfEHsONycwHwYDVR0jBBgwFoAUvXTQiwF1PfF7qrhR
5nrfEHsONycwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAFuI9/PK5ZAlVwZ4ATFGUBSrAIsIbD1/
4kHcWRz+7uetBFDy8tk5tRSxQMkrTrf+QMowog4LIRh0T22D8q7ol1CB74reqC2R
GJwz182F5dSdqGhKowaRnf8O7pdh0fdeQcc+qNI+WJIy4qWfvFSa/aXqAuF2UdRv
4YfwKvSeaOgZjUmjdgiR8dWvagIOsh/d7ACl6TRZ775Qi3ioTK8hk7A/e7BonYOT
mLDoHrA3K3v7Zprl54rmtE8E1yLeXmWOKRP+Fe670wXbCBG+RPPoUtt7iIZL41Xk
VRg7lP8at1ucfqlfGSYJG7u0otBq1VsbY+8C+brNtJhyVqrAFXL7QiI=
-----END CERTIFICATE-----`;

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDRUoG8CFv/MlW+
IhR66aWYk2w+PiDh2FzuOLTojckK521p0RcuFYg/ACrxAe3NoCSdbyM+8Y+GWpLY
+sSQ1dxjKoyPtcC+8qzToWzG0wPzU8he4E32yHAQDoFryrek8JSSnS8jzvIZS6sS
SHConGh+PlY2oIXPg/JAtkGIaizawlvJzinoKvFBU/L5P5rHBZ6EGLQc68zrgxUM
9dGPA4yNXtUheLsIgPLYx0wLFj2ga/o7Cq8dVot62mk58RAoonSyb+ysPdAkx4J6
VqiUHx7i7oxhSoCQhaFxirNKklBqsmDDClSA9w1lgf0MXO6tem3Kq1YUmB/KyOJP
n7mg+UYtAgMBAAECggEABXp6lUSFvd/gIR4MuavQTvY6zMU9AJQ0WHLI/1Yopx2n
/i9AA0+CdZ2oQg8KHYnds3YjbsQNPNe1hLLJfr3uKvVD4QYBga3hypcsvOZsccul
UKBfwf/8eNscVYkkdc9rIAw3neEOco2JsGyPcEZJsNYqVPsuDWCXcEyk2fBndKE5
9YykHPh7RmUGLsJhoQIInBW2ZszytyRKUfolawX0lFRcgkdgFTFOmyNwpiJ/2Qcn
/fDBvxrqa5iPLl2NBSUio9PSMpOqy62R6/h6eLnImtYXnaBWr0AlBLLb+BWdnIqw
AErcM0ewu+yc8lJf548MPW48ztailklNkGkfruyUKQKBgQD5fFoRLWMjhoD1MZDf
91+/QItNjkeEAvfE5e8vDu8v6xdiJGc5tfPvt2CS2fnCczFPM/so0iOhejxC/ZiU
ffakulTSRVPY2+KQ0ipDjlSFVcTxVdEgl/El9ld6nHcr8HbPELc7nR9MKaZkBZZu
jPHMwQjntKnNiAIavQAs/3e1xQKBgQDWybBLYhMs24Chpp0/NjuNO9Fiv9eDI7iB
B21omoP8LSCOd4HpHYJVaY50mcAPo28gUrryaICOqPlfvsrTPzA6ie2nKM8evztY
L2iDcGRaGj+W+4LhZOxZoAIhcWLdaUkba2CRbN666TJLKlLMZ0j3h+cf+FxBLvrj
0tjY2lS9SQKBgQCZqzWS5QDujdd6r4gL28P2+luTbrKwJl/UwMgdlTZQrp5djgyi
6GcTXUE30tlbIzbZESx/jUfzG2Zo4OkNdbTo6/h498jYhz+7cigkKlP3OMgw2moQ
iGY5us1RMXTZ9KhJjINATdxMPk9FxodNGrWJJ9FDXu1EMqURMR8dmFF0/QKBgQC+
x/9TthWaLo6fB0N9NkrHNG7T69sdnMjxsws3cqfxgpP8d6Jo0dFG1K+4WikCuwSm
DVYIo1ItZWG77dhysxm/pWv2ooT2pp2rwtBuj5JThiUdkuG6Gs7k/P9nfTN3v2E0
fbgU9EMSerg1k65f6Q4i8BAXkZ9ANt6bJll+pM/IIQKBgG4BEuIbImAbOZ9KRFwj
GjRhKq0hNLm/sFrtphlI3dzWN7/FYKq92ivAo22/2QM4/e/De5131Mg/f4KDfjgj
CZArD6tpOyTK6XXe9eb4FULdfJMb2LJl3a9VT1u8Be7qBK/kb8nqI0u9SxAKTnhE
N2j2CCkrH2oCEY7psgRJquI1
-----END PRIVATE KEY-----`;

/** 记录每个请求的原始信息，供断言 query / method / header。 */
const seen = [];

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function handle(req, res) {
  const url = new URL(req.url, 'https://127.0.0.1');
  const p = url.pathname;
  seen.push({ method: req.method, path: p, search: url.search, authorization: req.headers.authorization ?? null });

  if (p === '/version') {
    return sendJson(res, {
      major: '1', minor: '33',
      version: 'v1.33.4+k3s1',
      gitVersion: 'v1.33.4+k3s1',
      platform: 'linux/amd64',
      buildDate: '2025-01-01T00:00:00Z',
    });
  }
  if (p === '/api/v1/nodes') {
    return sendJson(res, { kind: 'NodeList', apiVersion: 'v1', items: [{ metadata: { name: 'k3s-1' } }] });
  }
  if (p === '/api/v1/namespaces/default/pods') {
    return sendJson(res, {
      kind: 'PodList',
      items: [{ metadata: { name: 'web-0', namespace: 'default' }, status: { phase: 'Running' } }],
    });
  }
  if (p === '/api/v1/namespaces/default/pods/web-0/log') {
    const body = 'line1\nline2\nline3';
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
    return res.end(body);
  }
  // 401：token 失效
  if (p === '/api/v1/namespaces/default/pods/unauth') {
    seen[seen.length - 1].headers = req.headers;
    return sendJson(res, { kind: 'Status', message: 'Unauthorized' }, 401);
  }
  // 403：LIST deployments 缺权限
  if (p === '/apis/apps/v1/namespaces/default/deployments') {
    return sendJson(res, { kind: 'Status', message: 'deployments is forbidden' }, 403);
  }
  // 403：GET 单个 pod 缺权限
  if (p === '/api/v1/namespaces/default/pods/denied') {
    return sendJson(res, { kind: 'Status', message: 'pods "denied" is forbidden' }, 403);
  }
  // 404
  if (p === '/api/v1/namespaces/default/configmaps/missing') {
    return sendJson(res, { kind: 'Status', message: 'configmaps "missing" not found' }, 404);
  }
  // 500：响应体超过 200 字符，用来验回显截断
  if (p === '/api/v1/namespaces/default/services/boom') {
    return sendJson(res, { kind: 'Status', message: `internal-error ${'x'.repeat(300)}` }, 500);
  }
  // 200 但不是 JSON
  if (p === '/api/v1/namespaces/default/pods/not-json') {
    const body = '<html>proxy error</html>';
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(body);
  }
  // 永不响应：用来测超时
  if (p === '/hang') return undefined;

  return sendJson(res, { kind: 'Status', message: `unknown path ${p}` }, 404);
}

const client = (overrides = {}) => createK8sClient({
  server: `https://127.0.0.1:${port}`,
  authType: 'token',
  token: 'test-token-abc',
  insecureSkipTlsVerify: true,
  contextName: 'test',
  ...overrides,
});

let server;
let port;
let mtlsServer;
let mtlsPort;

beforeAll(async () => {
  server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  // 要求客户端证书的服务：cert 同时当客户端证书和信任 CA，用来验证 mTLS 真的发了证书。
  mtlsServer = https.createServer(
    { cert: TLS_CERT, key: TLS_KEY, requestCert: true, ca: TLS_CERT, rejectUnauthorized: true },
    (req, res) => {
      const peer = req.socket.getPeerCertificate();
      sendJson(res, { peerCN: (peer && peer.subject && peer.subject.CN) || null });
    },
  );
  await new Promise((resolve) => mtlsServer.listen(0, '127.0.0.1', resolve));
  mtlsPort = mtlsServer.address().port;
});

afterAll(async () => {
  await Promise.all([server, mtlsServer].filter(Boolean).map((s) => new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

describe('createK8sClient — 正常读取', () => {
  it('getJson 返回解析后的 JSON，并把 query 原样传给 apiserver', async () => {
    const api = client();
    const data = await api.getJson('/api/v1/namespaces/default/pods', {
      query: { labelSelector: 'app=web', limit: 20 },
    });
    expect(data.kind).toBe('PodList');
    expect(data.items[0].metadata.name).toBe('web-0');

    const last = seen[seen.length - 1];
    expect(last.path).toBe('/api/v1/namespaces/default/pods');
    const params = new URLSearchParams(last.search);
    expect(params.get('labelSelector')).toBe('app=web');
    expect(params.get('limit')).toBe('20');
  });

  it('query 里的空值被丢弃，path 可以不带前导斜杠', async () => {
    const api = client();
    await api.getJson('api/v1/nodes', { query: { limit: undefined, pretty: '', fieldSelector: null } });
    const last = seen[seen.length - 1];
    expect(last.path).toBe('/api/v1/nodes');
    expect(last.search).toBe('');
  });

  it('request 返回 { statusCode, headers, body }，并支持自定义 method', async () => {
    const api = client();
    const res = await api.request('/api/v1/nodes', { method: 'post' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body).kind).toBe('NodeList');
    expect(seen[seen.length - 1].method).toBe('POST');
  });

  it('getText 原样返回纯文本（Pod 日志）', async () => {
    const api = client();
    const text = await api.getText('/api/v1/namespaces/default/pods/web-0/log', { query: { tail: 200 } });
    expect(text).toBe('line1\nline2\nline3');
    expect(new URLSearchParams(seen[seen.length - 1].search).get('tail')).toBe('200');
  });

  it('apiServerVersion 只返回 version / gitVersion / platform', async () => {
    const api = client();
    const version = await api.apiServerVersion();
    expect(version).toEqual({
      version: 'v1.33.4+k3s1',
      gitVersion: 'v1.33.4+k3s1',
      platform: 'linux/amd64',
    });
    expect(Object.keys(version).sort()).toEqual(['gitVersion', 'platform', 'version']);
  });
});

describe('createK8sClient — 状态码与错误文案', () => {
  it('401 → 鉴权失败', async () => {
    const api = client();
    const err = await api.getJson('/api/v1/namespaces/default/pods/unauth').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.message).toContain('鉴权失败');
    expect(err.message).toContain('401');
  });

  it('403 LIST → 提示缺少对 deployments 的 LIST 权限', async () => {
    const api = client();
    const err = await api.getJson('/apis/apps/v1/namespaces/default/deployments').catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.message).toContain('权限不足');
    expect(err.message).toContain('deployments');
    expect(err.message).toContain('LIST');
  });

  it('403 GET → 提示缺少对 pods 的 GET 权限', async () => {
    const api = client();
    const err = await api.getJson('/api/v1/namespaces/default/pods/denied').catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.message).toContain('权限不足');
    expect(err.message).toContain('pods');
    expect(err.message).toContain('GET');
    expect(err.message).not.toContain('LIST');
  });

  it('404 → 资源不存在', async () => {
    const api = client();
    const err = await api.getJson('/api/v1/namespaces/default/configmaps/missing').catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toContain('资源不存在');
    expect(err.message).toContain('configmaps');
  });

  it('其它非 2xx → 带状态码 + 响应体前 200 字符（超出部分截断）', async () => {
    const api = client();
    const err = await api.getJson('/api/v1/namespaces/default/services/boom').catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toContain('HTTP 500');
    expect(err.message).toContain('internal-error');
    // 服务端返回了 300+ 个 x，错误信息里不能全塞进去
    expect(err.message).not.toContain('x'.repeat(201));
    // 原始响应体仍然完整挂在错误对象上，供路由层/日志使用
    expect(err.body.length).toBeGreaterThan(300);
  });

  it('200 但不是 JSON → 抛中文 JSON 解析错误', async () => {
    const api = client();
    const err = await api.getJson('/api/v1/namespaces/default/pods/not-json').catch((e) => e);
    expect(err.message).toContain('不是合法 JSON');
    expect(err.message).toContain('proxy error');
  });
});

describe('createK8sClient — 超时', () => {
  it('自定义 timeoutMs → 中文超时错误，且错误带 ETIMEDOUT', async () => {
    const api = client();
    const started = Date.now();
    const err = await api.request('/hang', { timeoutMs: 100 }).catch((e) => e);
    const elapsed = Date.now() - started;

    expect(err.code).toBe('ETIMEDOUT');
    expect(err.message).toBe('Kubernetes API 超时（0.1s）');
    expect(elapsed).toBeLessThan(3000);
  });

  it('2500ms → 文案按秒格式化（默认 10s 走同一套格式化）', async () => {
    const api = client();
    const err = await api.request('/hang', { timeoutMs: 2500 }).catch((e) => e);
    expect(err.message).toBe('Kubernetes API 超时（2.5s）');
  }, 8000);
});

describe('createK8sClient — 认证与 TLS', () => {
  it('token 认证：请求带 Authorization: Bearer', async () => {
    const api = client({ authType: 'token', token: 'test-token-abc' });
    await api.apiServerVersion();
    expect(seen[seen.length - 1].authorization).toBe('Bearer test-token-abc');
  });

  it('没有 token 时不发送 Authorization 头', async () => {
    const api = client({ authType: 'cert', token: undefined, cert: TLS_CERT, key: TLS_KEY, insecureSkipTlsVerify: true });
    await api.getJson('/api/v1/nodes');
    expect(seen[seen.length - 1].authorization).toBeNull();
  });

  it('insecureSkipTlsVerify: true → 接受自签证书（rejectUnauthorized=false）', async () => {
    const api = client({ insecureSkipTlsVerify: true });
    const data = await api.getJson('/api/v1/nodes');
    expect(data.items).toHaveLength(1);
  });

  it('insecureSkipTlsVerify: false → 自签证书校验失败，抛中文连接错误', async () => {
    const api = client({ insecureSkipTlsVerify: false });
    const err = await api.getJson('/api/v1/nodes').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('连接失败');
    expect(err.cause).toBeTruthy();
  });

  it('mTLS：cert/key 真的作为客户端证书发出（服务端 requestCert 通过）', async () => {
    const api = createK8sClient({
      server: `https://127.0.0.1:${mtlsPort}`,
      authType: 'cert',
      cert: TLS_CERT,
      key: TLS_KEY,
      insecureSkipTlsVerify: true,
      contextName: 'mtls',
    });
    const data = await api.getJson('/whoami');
    expect(data.peerCN).toBe('127.0.0.1');
  });

  it('mTLS：不带 cert/key 时服务端拒绝握手', async () => {
    const api = createK8sClient({
      server: `https://127.0.0.1:${mtlsPort}`,
      authType: 'cert',
      insecureSkipTlsVerify: true,
      contextName: 'mtls-no-cert',
    });
    const err = await api.getJson('/whoami').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('连接失败');
  });
});

describe('createK8sClient — 参数校验', () => {
  it('缺少 server 时同步抛中文错误', () => {
    expect(() => createK8sClient({})).toThrow('缺少 apiserver 地址');
    expect(() => createK8sClient(null)).toThrow('不能为空');
  });

  it('空 path 被拒绝', async () => {
    const api = client();
    const err = await api.request('').catch((e) => e);
    expect(err.message).toContain('path 不能为空');
  });
});
