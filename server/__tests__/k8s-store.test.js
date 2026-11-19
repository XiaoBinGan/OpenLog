/**
 * k8s-store.test.js —— server/k8s/store.js 的纯逻辑测试（A4）。
 *
 * 只测内存行为：不联网、不读写文件、不依赖其它 agent 的模块。
 * 重点覆盖：视图脱敏、id/name 默认值、更新时保留旧 kubeconfig、入参不可变、
 * 坏 kubeconfig 降级不抛异常。
 */

import { describe, it, expect } from 'vitest';

import {
  K8S_CLUSTERS_KEY,
  listClusters,
  toView,
  upsertCluster,
  getClusterRecord,
  deleteCluster,
  maskKubeconfig,
} from '../k8s/store.js';

/** 一份客户端证书认证的 kubeconfig（base64 是假的，只用于形状） */
const CERT_KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: Q0EtREFUQQ==
    server: https://127.0.0.1:6443
  name: default
contexts:
- context:
    cluster: default
    user: default
    namespace: kube-system
  name: default
current-context: default
users:
- name: default
  user:
    client-certificate-data: Q0VSVC1EQVRB
    client-key-data: S0VZPERBVEE=
`;

/** 一份 token 认证的 kubeconfig（JSON 形式，顺带覆盖 JSON 分支） */
const TOKEN_KUBECONFIG = JSON.stringify({
  apiVersion: 'v1',
  kind: 'Config',
  clusters: [{ name: 'c1', cluster: { server: 'https://10.0.0.9:6443', 'insecure-skip-tls-verify': true } }],
  contexts: [{ name: 'ctx1', context: { cluster: 'c1', user: 'u1', namespace: 'default' } }],
  'current-context': 'ctx1',
  users: [{ name: 'u1', user: { token: 'eyJhbGciOiJSUzI1NiJ9.secret' } }],
});

const EMPTY_SETTINGS = { theme: 'dark', k8sClusters: [] };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('listClusters', () => {
  it('空 settings / 缺字段 / 非数组都返回空列表', () => {
    expect(listClusters()).toEqual([]);
    expect(listClusters({})).toEqual([]);
    expect(listClusters({ k8sClusters: null })).toEqual([]);
    expect(listClusters({ k8sClusters: 'oops' })).toEqual([]);
    expect(listClusters(EMPTY_SETTINGS)).toEqual([]);
  });

  it('把 record 映射成视图，且绝不下发 kubeconfig 明文', () => {
    const { settings } = upsertCluster(EMPTY_SETTINGS, {
      name: 'prod',
      kubeconfig: CERT_KUBECONFIG,
    });

    const clusters = listClusters(settings);
    expect(clusters).toHaveLength(1);

    const view = clusters[0];
    expect(view.name).toBe('prod');
    expect(view.server).toBe('https://127.0.0.1:6443');
    expect(view.context).toBe('default');
    expect(view.authType).toBe('cert');
    expect(view.enabled).toBe(true);
    expect(view.hasKubeconfig).toBe(true);
    expect(view.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(view.updatedAt).toBeTruthy();

    // 明文 / base64 片段都不允许出现
    expect(view).not.toHaveProperty('kubeconfig');
    const serialized = JSON.stringify(clusters);
    expect(serialized).not.toContain('Q0VSVC1EQVRB');
    expect(serialized).not.toContain('client-certificate-data');
    expect(serialized).not.toContain('S0VZPERBVEE=');
  });

  it('跳过数组里的非法元素，不影响其它记录', () => {
    const settings = {
      k8sClusters: [null, 'x', { id: 'a', name: 'A', kubeconfig: TOKEN_KUBECONFIG, enabled: true }],
    };
    const clusters = listClusters(settings);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].id).toBe('a');
  });
});

describe('toView', () => {
  it('识别 token 认证与 JSON 形式的 kubeconfig', () => {
    const view = toView({ id: 'i1', name: 'n1', kubeconfig: TOKEN_KUBECONFIG, enabled: true });
    expect(view.server).toBe('https://10.0.0.9:6443');
    expect(view.context).toBe('ctx1');
    expect(view.authType).toBe('token');
  });

  it('显式 context 优先于 current-context', () => {
    const view = toView({
      id: 'i1',
      name: 'n1',
      kubeconfig: CERT_KUBECONFIG,
      context: 'staging',
      enabled: true,
    });
    expect(view.context).toBe('staging');
  });

  it('坏 kubeconfig 不抛异常，降级为 server 空 / authType token', () => {
    // 有文本但解析不出 key：仍然算「有 kubeconfig」，只是摘要是空的
    for (const broken of ['这不是 kubeconfig', '{{{', 'clusters:\n- cluster: {}\n']) {
      const view = toView({ id: 'i1', name: 'n1', kubeconfig: broken, enabled: true });
      expect(view.server).toBe('');
      expect(view.authType).toBe('token');
      expect(view.hasKubeconfig).toBe(true);
    }
    // 压根没有文本：hasKubeconfig=false
    for (const empty of [undefined, null, '', '  ', 123, {}]) {
      const view = toView({ id: 'i1', name: 'n1', kubeconfig: empty, enabled: true });
      expect(view.server).toBe('');
      expect(view.authType).toBe('token');
      expect(view.hasKubeconfig).toBe(false);
    }
  });

  it('record 缺字段也能出视图', () => {
    expect(toView(undefined)).toEqual({
      id: '',
      name: '',
      context: '',
      server: '',
      enabled: true,
      authType: 'token',
      hasKubeconfig: false,
    });
  });

  it('enabled=false 原样透出', () => {
    const view = toView({ id: 'i', name: 'n', kubeconfig: CERT_KUBECONFIG, enabled: false });
    expect(view.enabled).toBe(false);
  });
});

describe('upsertCluster 新增', () => {
  it('生成 uuid，name 为空时默认 cluster-<id 前 8 位>', () => {
    const { record, settings } = upsertCluster(EMPTY_SETTINGS, { kubeconfig: CERT_KUBECONFIG });

    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(record.name).toBe(`cluster-${record.id.slice(0, 8)}`);
    expect(record.enabled).toBe(true);
    expect(record.kubeconfig).toBe(CERT_KUBECONFIG);

    expect(settings[K8S_CLUSTERS_KEY]).toHaveLength(1);
    expect(settings[K8S_CLUSTERS_KEY][0]).toEqual(record);
    // 其它 settings 字段保留
    expect(settings.theme).toBe('dark');
  });

  it('name 只含空白也走默认名；context 规范化（去空格）', () => {
    const { record } = upsertCluster(EMPTY_SETTINGS, {
      name: '   ',
      kubeconfig: CERT_KUBECONFIG,
      context: '  ctx-a  ',
    });
    expect(record.name).toBe(`cluster-${record.id.slice(0, 8)}`);
    expect(record.context).toBe('ctx-a');
  });

  it('kubeconfig 为空或全空白时抛中文错误', () => {
    expect(() => upsertCluster(EMPTY_SETTINGS, { name: 'x' })).toThrow('kubeconfig 不能为空');
    expect(() => upsertCluster(EMPTY_SETTINGS, { name: 'x', kubeconfig: '' })).toThrow('kubeconfig 不能为空');
    expect(() => upsertCluster(EMPTY_SETTINGS, { name: 'x', kubeconfig: '   ' })).toThrow('kubeconfig 不能为空');
    expect(() => upsertCluster(EMPTY_SETTINGS, {})).toThrow('kubeconfig 不能为空');
  });

  it('每次新增生成不同 id，enabled 可显式置 false', () => {
    const first = upsertCluster(EMPTY_SETTINGS, { kubeconfig: CERT_KUBECONFIG });
    const second = upsertCluster(first.settings, { kubeconfig: TOKEN_KUBECONFIG, enabled: false });
    expect(first.record.id).not.toBe(second.record.id);
    expect(second.record.enabled).toBe(false);
    expect(second.settings[K8S_CLUSTERS_KEY]).toHaveLength(2);
  });
});

describe('upsertCluster 更新', () => {
  it('按 id 更新，kubeconfig 省略时沿用旧值', () => {
    const created = upsertCluster(EMPTY_SETTINGS, {
      name: 'old',
      kubeconfig: CERT_KUBECONFIG,
      context: 'default',
    });
    const id = created.record.id;

    const updated = upsertCluster(created.settings, { id, name: 'new' });
    expect(updated.record.id).toBe(id);
    expect(updated.record.name).toBe('new');
    expect(updated.record.kubeconfig).toBe(CERT_KUBECONFIG);
    expect(updated.record.context).toBe('default');
    expect(updated.settings[K8S_CLUSTERS_KEY]).toHaveLength(1);
    expect(updated.settings[K8S_CLUSTERS_KEY][0].name).toBe('new');
  });

  it('kubeconfig 传空串等同省略，不重新校验', () => {
    const created = upsertCluster(EMPTY_SETTINGS, { name: 'a', kubeconfig: TOKEN_KUBECONFIG });
    const updated = upsertCluster(created.settings, {
      id: created.record.id,
      name: 'b',
      kubeconfig: '',
    });
    expect(updated.record.kubeconfig).toBe(TOKEN_KUBECONFIG);
  });

  it('只有新 kubeconfig 才替换', () => {
    const created = upsertCluster(EMPTY_SETTINGS, { name: 'a', kubeconfig: TOKEN_KUBECONFIG });
    const updated = upsertCluster(created.settings, {
      id: created.record.id,
      kubeconfig: CERT_KUBECONFIG,
    });
    expect(updated.record.kubeconfig).toBe(CERT_KUBECONFIG);
    // name 未提供时保留旧名
    expect(updated.record.name).toBe('a');
    expect(toView(updated.record).authType).toBe('cert');
  });

  it('enabled 未提供时保持原值', () => {
    const created = upsertCluster(EMPTY_SETTINGS, {
      name: 'a',
      kubeconfig: CERT_KUBECONFIG,
      enabled: false,
    });
    const updated = upsertCluster(created.settings, { id: created.record.id, name: 'b' });
    expect(updated.record.enabled).toBe(false);

    const toggled = upsertCluster(updated.settings, { id: created.record.id, enabled: true });
    expect(toggled.record.enabled).toBe(true);
  });

  it('未知 id 视为新增（id 重新生成），不会污染已有记录', () => {
    const created = upsertCluster(EMPTY_SETTINGS, { name: 'a', kubeconfig: TOKEN_KUBECONFIG });
    const result = upsertCluster(created.settings, {
      id: 'does-not-exist',
      name: 'b',
      kubeconfig: CERT_KUBECONFIG,
    });
    expect(result.record.id).not.toBe('does-not-exist');
    expect(result.settings[K8S_CLUSTERS_KEY]).toHaveLength(2);
    expect(result.settings[K8S_CLUSTERS_KEY][0].id).toBe(created.record.id);
  });

  it('空 context 表示回到 current-context', () => {
    const created = upsertCluster(EMPTY_SETTINGS, {
      name: 'a',
      kubeconfig: CERT_KUBECONFIG,
      context: 'staging',
    });
    const updated = upsertCluster(created.settings, { id: created.record.id, context: '' });
    expect(updated.record.context).toBe('');
    expect(toView(updated.record).context).toBe('default');
  });
});

describe('getClusterRecord', () => {
  it('按 id 返回原始 record（含明文，供服务端内部使用）', () => {
    const created = upsertCluster(EMPTY_SETTINGS, { name: 'a', kubeconfig: CERT_KUBECONFIG });
    const found = getClusterRecord(created.settings, created.record.id);
    expect(found).toBe(created.record);
    expect(found.kubeconfig).toBe(CERT_KUBECONFIG);
  });

  it('不存在 / 非法入参返回 undefined', () => {
    expect(getClusterRecord(EMPTY_SETTINGS, 'nope')).toBeUndefined();
    expect(getClusterRecord(EMPTY_SETTINGS)).toBeUndefined();
    expect(getClusterRecord(undefined, 'x')).toBeUndefined();
  });
});

describe('deleteCluster', () => {
  it('删除不存在的 id：removed=false 且列表不变', () => {
    const created = upsertCluster(EMPTY_SETTINGS, { name: 'a', kubeconfig: CERT_KUBECONFIG });
    const result = deleteCluster(created.settings, 'missing-id');
    expect(result.removed).toBe(false);
    expect(result.settings[K8S_CLUSTERS_KEY]).toHaveLength(1);
    expect(result.settings[K8S_CLUSTERS_KEY][0].id).toBe(created.record.id);
    // 返回新对象，不复用入参数组
    expect(result.settings).not.toBe(created.settings);
    expect(result.settings[K8S_CLUSTERS_KEY]).not.toBe(created.settings[K8S_CLUSTERS_KEY]);
  });

  it('删除已存在的 id：removed=true，只删目标', () => {
    const first = upsertCluster(EMPTY_SETTINGS, { name: 'a', kubeconfig: CERT_KUBECONFIG });
    const second = upsertCluster(first.settings, { name: 'b', kubeconfig: TOKEN_KUBECONFIG });

    const result = deleteCluster(second.settings, first.record.id);
    expect(result.removed).toBe(true);
    expect(result.settings[K8S_CLUSTERS_KEY]).toHaveLength(1);
    expect(result.settings[K8S_CLUSTERS_KEY][0].id).toBe(second.record.id);
  });

  it('空 settings 删除也不炸', () => {
    expect(deleteCluster({}, 'x')).toEqual({ removed: false, settings: { [K8S_CLUSTERS_KEY]: [] } });
  });
});

describe('maskKubeconfig', () => {
  it('YAML：*-data 与 token 的值都变成 ***', () => {
    const text = `users:
- name: default
  user:
    client-certificate-data: Q0VSVC1EQVRB
    client-key-data: S0VZPERBVEE=
    certificate-authority-data: Q0EtREFUQQ==
    token: eyJhbGciOiJSUzI1NiJ9.secret
`;
    const masked = maskKubeconfig(text);

    expect(masked).not.toContain('Q0VSVC1EQVRB');
    expect(masked).not.toContain('S0VZPERBVEE=');
    expect(masked).not.toContain('Q0EtREFUQQ==');
    expect(masked).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(masked).toContain('client-certificate-data: ***');
    expect(masked).toContain('client-key-data: ***');
    expect(masked).toContain('certificate-authority-data: ***');
    expect(masked).toContain('token: ***');
    // 非敏感字段与缩进保留
    expect(masked).toContain('- name: default');
  });

  it('JSON：带引号的形式也打码', () => {
    const masked = maskKubeconfig(TOKEN_KUBECONFIG);
    expect(masked).not.toContain('eyJhbGciOiJSUzI1NiJ9.secret');
    expect(masked).toMatch(/"token"\s*:\s*"\*\*\*"/);
    // 非敏感字段保留
    expect(masked).toContain('https://10.0.0.9:6443');
    // 打码后仍是合法 JSON
    const parsed = JSON.parse(masked);
    expect(parsed.users[0].user.token).toBe('***');
  });

  it('对空值 / 非字符串安全返回', () => {
    expect(maskKubeconfig('')).toBe('');
    expect(maskKubeconfig(undefined)).toBe('');
    expect(maskKubeconfig(null)).toBe('');
    expect(maskKubeconfig(123)).toBe('');
  });

  it('不破坏普通文本', () => {
    const plain = 'apiVersion: v1\nkind: Config\ncurrent-context: default\n';
    expect(maskKubeconfig(plain)).toBe(plain);
  });
});

describe('不可变性', () => {
  it('upsert / delete 不修改入参（深冻结也不抛）', () => {
    const settings = {
      theme: 'dark',
      k8sClusters: [
        Object.freeze({
          id: 'fixed-id',
          name: 'fixed',
          kubeconfig: CERT_KUBECONFIG,
          context: '',
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    };
    const snapshot = clone(settings);
    Object.freeze(settings.k8sClusters[0]);
    Object.freeze(settings.k8sClusters);
    Object.freeze(settings);

    const updated = upsertCluster(settings, { id: 'fixed-id', name: 'renamed' });
    expect(updated.record.name).toBe('renamed');
    expect(updated.settings[K8S_CLUSTERS_KEY][0].name).toBe('renamed');
    expect(settings).toEqual(snapshot);
    expect(settings.k8sClusters[0].name).toBe('fixed');

    const removed = deleteCluster(settings, 'fixed-id');
    expect(removed.removed).toBe(true);
    expect(settings).toEqual(snapshot);

    const listed = listClusters(settings);
    expect(listed[0]).not.toHaveProperty('kubeconfig');
    expect(settings).toEqual(snapshot);
  });

  it('连续两次 upsert 基于同一快照时互不影响（纯函数）', () => {
    const base = { k8sClusters: [] };
    const a = upsertCluster(base, { name: 'a', kubeconfig: CERT_KUBECONFIG });
    const b = upsertCluster(base, { name: 'b', kubeconfig: TOKEN_KUBECONFIG });
    expect(a.settings[K8S_CLUSTERS_KEY]).toHaveLength(1);
    expect(b.settings[K8S_CLUSTERS_KEY]).toHaveLength(1);
    expect(base.k8sClusters).toEqual([]);
  });
});