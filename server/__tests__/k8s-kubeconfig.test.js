import { describe, it, expect } from 'vitest';
import { parseKubeconfig, describeKubeconfig } from '../k8s/kubeconfig.js';

/**
 * 这里的 PEM / token 全是假值，只为验证「解码 + 归属 + 报错」这三件事：
 *   - k3s 默认签发客户端证书（client-certificate-data / client-key-data）→ mTLS
 *   - 只读 SA 场景用 token
 * 不放任何真实密钥，也不做任何网络请求。
 */
const toB64 = (value) => Buffer.from(value).toString('base64');

const FAKE_CA = 'fake-ca-pem';
const FAKE_CERT = 'fake-client-cert-pem';
const FAKE_KEY = 'fake-client-key-pem';

/** k3s 默认输出的 kubeconfig 结构（`- ` 顶格，客户端证书认证）。 */
function k3sKubeconfig({
  ca = toB64(FAKE_CA),
  server = 'https://127.0.0.1:6443',
  cert = toB64(FAKE_CERT),
  key = toB64(FAKE_KEY),
  insecure,
  namespace,
} = {}) {
  const clusterLines = [
    ca ? `    certificate-authority-data: ${ca}` : null,
    insecure === undefined ? null : `    insecure-skip-tls-verify: ${insecure}`,
    `    server: ${server}`,
  ].filter(Boolean);
  const contextLines = [
    '    cluster: default',
    namespace ? `    namespace: ${namespace}` : null,
    '    user: default',
  ].filter(Boolean);
  const userLines = [
    cert ? `    client-certificate-data: ${cert}` : null,
    key ? `    client-key-data: ${key}` : null,
  ].filter(Boolean);
  return `apiVersion: v1
clusters:
- cluster:
${clusterLines.join('\n')}
  name: default
contexts:
- context:
${contextLines.join('\n')}
  name: default
current-context: default
kind: Config
preferences: {}
users:
- name: default
  user:
${userLines.join('\n')}
`;
}

/** 多 cluster / 多 context / 两种认证方式混用的 kubeconfig。 */
function multiContextKubeconfig() {
  return `apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: ${toB64('prod-ca-pem')}
    server: https://prod.example:6443
  name: prod
- cluster:
    insecure-skip-tls-verify: true
    server: https://staging.example:6443
  name: staging
- cluster:
    server: https://dev.example:6443
  name: dev
contexts:
- context:
    cluster: prod
    namespace: openlog
    user: prod-admin
  name: prod
- context:
    cluster: staging
    namespace: staging-ns
    user: staging-sa
  name: staging
- context:
    cluster: dev
    user: dev-sa
  name: dev
current-context: prod
users:
- name: prod-admin
  user:
    client-certificate-data: ${toB64('prod-cert-pem')}
    client-key-data: ${toB64('prod-key-pem')}
- name: staging-sa
  user:
    token: staging-token-value
- name: dev-sa
  user:
    token: dev-token-value
`;
}

/** 最小可用的 token 认证 kubeconfig，用于错误分支拼装。 */
function tokenKubeconfig({
  server = 'https://10.0.0.10:6443',
  contextCluster = 'prod',
  contextUser = 'sa',
  userBody = '    token: abc',
  extraClusterLines = '',
} = {}) {
  return `apiVersion: v1
clusters:
- cluster:
    server: ${server}${extraClusterLines}
  name: prod
contexts:
- context:
    cluster: ${contextCluster}
    user: ${contextUser}
  name: default
current-context: default
users:
- name: sa
  user:
${userBody}
`;
}

describe('parseKubeconfig — k3s 风格（客户端证书 / mTLS）', () => {
  const resolved = () => parseKubeconfig(k3sKubeconfig());

  it('解析出 server、contextName，认证方式为 cert', () => {
    const r = resolved();
    expect(r.server).toBe('https://127.0.0.1:6443');
    expect(r.contextName).toBe('default');
    expect(r.authType).toBe('cert');
  });

  it('把 *-data 从 base64 解码成 PEM 文本', () => {
    const r = resolved();
    expect(r.ca).toBe(FAKE_CA);
    expect(r.cert).toBe(FAKE_CERT);
    expect(r.key).toBe(FAKE_KEY);
  });

  it('证书认证时不带 token 字段，insecure 默认为 false', () => {
    const r = resolved();
    expect(r.token).toBeUndefined();
    expect(r).not.toHaveProperty('token');
    expect(r.insecureSkipTlsVerify).toBe(false);
  });

  it('没有 namespace 时不返回 namespace 字段', () => {
    const r = resolved();
    expect(r.name).toBeUndefined();
    expect(r).not.toHaveProperty('namespace');
  });

  it('带 namespace 时原样保留', () => {
    const r = parseKubeconfig(k3sKubeconfig({ namespace: 'kube-system' }));
    expect(r.namespace).toBe('kube-system');
  });

  it('缺少 certificate-authority-data 时没有 ca 字段（交给系统根证书）', () => {
    const r = parseKubeconfig(k3sKubeconfig({ ca: '' }));
    expect(r).not.toHaveProperty('ca');
    expect(r.authType).toBe('cert');
  });

  it('换行拆开的 base64（块标量形式）也能解码', () => {
    // 有些工具导出时会把长 base64 折行；解码前要先把空白剔掉
    const wrapped = toB64(FAKE_CA).replace(/(.{4})/g, '$1\n      ').trim();
    const text = `clusters:
- name: default
  cluster:
    certificate-authority-data: |
      ${wrapped}
    server: https://127.0.0.1:6443
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
users:
- name: default
  user:
    client-certificate-data: ${toB64(FAKE_CERT)}
    client-key-data: ${toB64(FAKE_KEY)}
`;
    expect(parseKubeconfig(text).ca).toBe(FAKE_CA);
  });
});

describe('parseKubeconfig — token 认证', () => {
  const text = `apiVersion: v1
clusters:
- name: prod
  cluster:
    insecure-skip-tls-verify: true
    server: https://10.0.0.10:6443
contexts:
- name: prod
  context:
    cluster: prod
    namespace: openlog
    user: openlog-sa
current-context: prod
users:
- name: openlog-sa
  user:
    token: eyJhbGciOiJSUzI1NiJ9.fake-sa-token
`;

  it('返回 authType=token 与 token 原文', () => {
    const r = parseKubeconfig(text);
    expect(r.authType).toBe('token');
    expect(r.token).toBe('eyJhbGciOiJSUzI1NiJ9.fake-sa-token');
  });

  it('token 认证时没有 cert / key 字段', () => {
    const r = parseKubeconfig(text);
    expect(r).not.toHaveProperty('cert');
    expect(r).not.toHaveProperty('key');
  });

  it('insecure-skip-tls-verify: true 被识别', () => {
    expect(parseKubeconfig(text).insecureSkipTlsVerify).toBe(true);
  });

  it('单引号包裹的 token 保留其中的特殊字符', () => {
    const r = parseKubeconfig(tokenKubeconfig({ userBody: "    token: 'a#b:c/d='" }));
    expect(r.token).toBe('a#b:c/d=');
  });

  it('双引号包裹并带转义的 token 正确反解', () => {
    const r = parseKubeconfig(tokenKubeconfig({ userBody: '    token: "line1\\nline2"' }));
    expect(r.token).toBe('line1\nline2');
  });

  it('证书与 token 同时存在时以证书为准（对齐 apiserver 的 x509 先于 bearer）', () => {
    const r = parseKubeconfig(tokenKubeconfig({
      userBody: `    token: abc
    client-certificate-data: ${toB64(FAKE_CERT)}
    client-key-data: ${toB64(FAKE_KEY)}`,
    }));
    expect(r.authType).toBe('cert');
    expect(r.cert).toBe(FAKE_CERT);
    expect(r.key).toBe(FAKE_KEY);
    expect(r.token).toBe('abc');
  });

  it('证书残缺但 token 可用时不报错，改用 token 认证', () => {
    const r = parseKubeconfig(tokenKubeconfig({
      userBody: `    token: abc
    client-certificate-data: ${toB64(FAKE_CERT)}`,
    }));
    expect(r.authType).toBe('token');
    expect(r).not.toHaveProperty('cert');
  });
});

describe('parseKubeconfig — 多 context 选择', () => {
  it('不传 context 时取 current-context', () => {
    const r = parseKubeconfig(multiContextKubeconfig());
    expect(r.contextName).toBe('prod');
    expect(r.server).toBe('https://prod.example:6443');
    expect(r.authType).toBe('cert');
    expect(r.namespace).toBe('openlog');
  });

  it('显式 context 覆盖 current-context 并取对应的 cluster / user', () => {
    const text = multiContextKubeconfig();
    const r = parseKubeconfig(text, 'staging');
    expect(r.contextName).toBe('staging');
    expect(r.server).toBe('https://staging.example:6443');
    expect(r.authType).toBe('token');
    expect(r.token).toBe('staging-token-value');
    expect(r.namespace).toBe('staging-ns');
    expect(r.insecureSkipTlsVerify).toBe(true);
  });

  it('context 切换后不会串用上一个 context 的凭据', () => {
    const text = multiContextKubeconfig();
    const dev = parseKubeconfig(text, 'dev');
    expect(dev.token).toBe('dev-token-value');
    expect(dev).not.toHaveProperty('cert');
    expect(dev).not.toHaveProperty('namespace');
    expect(dev.insecureSkipTlsVerify).toBe(false);
  });

  it('context 传空串时回退到 current-context', () => {
    expect(parseKubeconfig(multiContextKubeconfig(), '   ').contextName).toBe('prod');
  });
});

describe('parseKubeconfig — JSON 输入', () => {
  const jsonDoc = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: 'c1', cluster: { server: 'https://json.example:6443', 'insecure-skip-tls-verify': true } }],
    contexts: [{ name: 'ctx1', context: { cluster: 'c1', user: 'u1', namespace: 'json-ns' } }],
    'current-context': 'ctx1',
    users: [{ name: 'u1', user: { token: 'json-token' } }],
  };

  it('以 { 开头时走 JSON.parse', () => {
    const r = parseKubeconfig(JSON.stringify(jsonDoc));
    expect(r.server).toBe('https://json.example:6443');
    expect(r.token).toBe('json-token');
    expect(r.namespace).toBe('json-ns');
    expect(r.insecureSkipTlsVerify).toBe(true);
    expect(r.contextName).toBe('ctx1');
  });

  it('JSON 里的 base64 同样被解码', () => {
    const doc = structuredClone(jsonDoc);
    doc.clusters[0].cluster['certificate-authority-data'] = toB64(FAKE_CA);
    expect(parseKubeconfig(JSON.stringify(doc)).ca).toBe(FAKE_CA);
  });

  it('非法 JSON 给出中文错误', () => {
    expect(() => parseKubeconfig('{"clusters": }')).toThrow(/不是合法的 JSON/);
  });
});

describe('parseKubeconfig — YAML 子集细节', () => {
  it('序列项缩进写法（- 在父键下方）与顶格写法等价', () => {
    const indented = `apiVersion: v1
clusters:
  - name: prod
    cluster:
      server: https://indented.example:6443
contexts:
  - name: prod
    context:
      cluster: prod
      user: sa
current-context: prod
users:
  - name: sa
    user:
      token: indented-token
`;
    const r = parseKubeconfig(indented);
    expect(r.server).toBe('https://indented.example:6443');
    expect(r.token).toBe('indented-token');
  });

  it('行内注释不影响取值', () => {
    const text = `clusters:
- name: prod
  cluster:
    server: https://commented.example:6443   # 注释
contexts:
- name: prod
  context:
    cluster: prod
    user: sa
current-context: prod
users:
- name: sa
  user:
    token: token # 值里的注释
`;
    expect(parseKubeconfig(text).server).toBe('https://commented.example:6443');
    expect(parseKubeconfig(text).token).toBe('token');
  });

  it('server 末尾的斜杠被去掉，避免拼出 //api/v1', () => {
    const r = parseKubeconfig(tokenKubeconfig({ server: 'https://slash.example:6443/' }));
    expect(r.server).toBe('https://slash.example:6443');
  });

  it('块标量（|）形式的值也能取到', () => {
    const text = `clusters:
- name: prod
  cluster:
    server: |
      https://block.example:6443
contexts:
- name: prod
  context:
    cluster: prod
    user: sa
current-context: prod
users:
- name: sa
  user:
    token: |
      block-token
`;
    const r = parseKubeconfig(text);
    expect(r.server).toBe('https://block.example:6443');
    expect(r.token).toBe('block-token');
  });

  it('Tab 缩进给出中文错误', () => {
    expect(() => parseKubeconfig('clusters:\n\t- name: prod\n')).toThrow(/缩进不能使用 Tab/);
  });
});

describe('parseKubeconfig — 错误分支（中文且说清原因）', () => {
  it('空内容', () => {
    expect(() => parseKubeconfig('')).toThrow(/kubeconfig 内容为空/);
    expect(() => parseKubeconfig('   \n\t ')).toThrow(/kubeconfig 内容为空/);
    expect(() => parseKubeconfig(undefined)).toThrow(/kubeconfig 内容为空/);
  });

  it('顶层不是对象', () => {
    expect(() => parseKubeconfig('[1, 2]')).toThrow(/顶层必须是对象/);
    expect(() => parseKubeconfig('plain-scalar')).toThrow(/顶层必须是对象/);
  });

  it('既没有 current-context 也没有指定 context', () => {
    const text = `clusters:
- name: prod
  cluster:
    server: https://noctx.example:6443
`;
    expect(() => parseKubeconfig(text)).toThrow(/没有 current-context/);
  });

  it('找不到指定的 context，并列出可用 context', () => {
    const err = () => parseKubeconfig(multiContextKubeconfig(), 'nope');
    expect(err).toThrow(/找不到 context "nope"/);
    expect(err).toThrow(/prod、staging、dev/);
  });

  it('context 指向不存在的 cluster', () => {
    const text = tokenKubeconfig({ contextCluster: 'missing-cluster' });
    expect(() => parseKubeconfig(text)).toThrow(/指向的 cluster "missing-cluster" 不存在/);
    expect(() => parseKubeconfig(text)).toThrow(/可用的 cluster：prod/);
  });

  it('context 指向不存在的 user', () => {
    const text = tokenKubeconfig({ contextUser: 'missing-user' });
    expect(() => parseKubeconfig(text)).toThrow(/指向的 user "missing-user" 不存在/);
    expect(() => parseKubeconfig(text)).toThrow(/可用的 user：sa/);
  });

  it('context 没有指定 user 也没有任何凭据', () => {
    const text = tokenKubeconfig({ contextUser: '' });
    expect(() => parseKubeconfig(text)).toThrow(/没有指定 user/);
  });

  it('user 既没有 token 也没有客户端证书', () => {
    const text = tokenKubeconfig({ userBody: '    foo: bar' });
    expect(() => parseKubeconfig(text)).toThrow(/既没有 token 也没有客户端证书/);
  });

  it('只有 client-certificate-data 没有 client-key-data', () => {
    const text = tokenKubeconfig({
      userBody: `    client-certificate-data: ${toB64(FAKE_CERT)}`,
    });
    expect(() => parseKubeconfig(text)).toThrow(/客户端证书不完整：缺少 client-key-data/);
  });

  it('只有 client-key-data 没有 client-certificate-data', () => {
    const text = tokenKubeconfig({
      userBody: `    client-key-data: ${toB64(FAKE_KEY)}`,
    });
    expect(() => parseKubeconfig(text)).toThrow(/客户端证书不完整：缺少 client-certificate-data/);
  });

  it('cluster 的 server 为空', () => {
    const text = `clusters:
- name: prod
  cluster:
    certificate-authority-data: ${toB64(FAKE_CA)}
contexts:
- name: prod
  context:
    cluster: prod
    user: sa
current-context: prod
users:
- name: sa
  user:
    token: t
`;
    expect(() => parseKubeconfig(text)).toThrow(/server 为空/);
  });

  it('*-data 不是合法 base64 时直接报错，不静默返回空串', () => {
    const text = k3sKubeconfig({ ca: '这显然不是 base64!!' });
    expect(() => parseKubeconfig(text)).toThrow(/certificate-authority-data 不是合法的 base64/);
  });
});

describe('describeKubeconfig — 列表摘要不含任何密钥', () => {
  const certText = k3sKubeconfig({ namespace: 'openlog' });

  it('只返回 server / contextName / authType / namespace 四个字段', () => {
    const desc = describeKubeconfig(certText);
    expect(Object.keys(desc).sort()).toEqual(['authType', 'contextName', 'namespace', 'server']);
  });

  it('字段值与 parseKubeconfig 一致', () => {
    const resolved = parseKubeconfig(certText);
    const desc = describeKubeconfig(certText);
    expect(desc.server).toBe(resolved.server);
    expect(desc.contextName).toBe(resolved.contextName);
    expect(desc.authType).toBe(resolved.authType);
    expect(desc.namespace).toBe('openlog');
  });

  it('摘要里不出现 token、证书、base64 原文或 PEM', () => {
    const json = JSON.stringify(describeKubeconfig(multiContextKubeconfig(), 'staging'));
    expect(json).not.toContain('staging-token-value');
    expect(json).not.toContain(toB64('staging-token-value'));
    const certJson = JSON.stringify(describeKubeconfig(certText));
    for (const secret of [FAKE_CERT, FAKE_KEY, FAKE_CA, toB64(FAKE_CERT), toB64(FAKE_KEY)]) {
      expect(certJson).not.toContain(secret);
    }
    expect(certJson).not.toContain('certificate-authority-data');
  });

  it('没有 namespace 时返回 null（字段形状稳定，便于前端直接渲染）', () => {
    expect(describeKubeconfig(tokenKubeconfig()).namespace).toBeNull();
  });

  it('token 认证的摘要只暴露 authType=token', () => {
    const desc = describeKubeconfig(tokenKubeconfig());
    expect(desc.authType).toBe('token');
    expect(JSON.stringify(desc)).not.toContain('abc');
  });

  it('解析失败时抛出与 parseKubeconfig 相同的中文错误', () => {
    expect(() => describeKubeconfig('clusters: []', 'ghost')).toThrow(/找不到 context "ghost"/);
  });
});