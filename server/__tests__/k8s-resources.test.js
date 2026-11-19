/**
 * server/k8s/resources.js 单测（增量 ① A3）
 *
 * 覆盖点对应契约里的归一化要求：
 * - 节点：Ready 条件、角色推导（master + control-plane 并存）、InternalIP、capacity 原文
 * - Pod：ready "n/m"、restarts 多容器累加、OOM（reason 与 exitCode 137 两条路径、lastState）、
 *        CrashLoopBackOff、容器 state/reason 取值
 * - 工作负载：Deployment / StatefulSet / DaemonSet 三套字段映射，缺字段按 0
 * - 事件：object 拼接、lastSeen 回退链、count 默认 1、倒序
 * - summary：节点/容器/工作负载/警告事件计数，podsUnhealthy 去重
 * - 容错：字段整块缺失、null、非数组输入都不能抛异常
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeNodes,
  normalizePods,
  normalizeWorkloads,
  normalizeEvents,
  summarize,
} from '../k8s/resources.js';

/** k3s 单节点 master 的真实形状（字段有裁剪，够覆盖归一化即可）。 */
function k3sNode(overrides = {}) {
  return {
    metadata: {
      name: 'k3s-master',
      creationTimestamp: '2026-01-02T03:04:05Z',
      labels: {
        'node-role.kubernetes.io/control-plane': 'true',
        'node-role.kubernetes.io/master': 'true',
        'kubernetes.io/role': 'master',
        'kubernetes.io/hostname': 'k3s-master',
      },
    },
    status: {
      capacity: { cpu: '8', memory: '16332160Ki', pods: '110' },
      addresses: [
        { type: 'Hostname', address: 'k3s-master' },
        { type: 'InternalIP', address: '10.0.0.11' },
        { type: 'ExternalIP', address: '203.0.113.9' },
      ],
      conditions: [
        { type: 'MemoryPressure', status: 'False' },
        { type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status' },
      ],
      nodeInfo: {
        kubeletVersion: 'v1.33.4+k3s1',
        osImage: 'Ubuntu 24.04.1 LTS',
        operatingSystem: 'linux',
        architecture: 'amd64',
      },
    },
    ...overrides,
  };
}

describe('normalizeNodes', () => {
  it('把 k3s 节点压成契约结构', () => {
    const [node] = normalizeNodes([k3sNode()]);

    expect(node.name).toBe('k3s-master');
    expect(node.ready).toBe(true);
    expect(node.roles).toEqual(['control-plane', 'master']); // master 不丢
    expect(node.version).toBe('v1.33.4+k3s1');
    expect(node.os).toBe('Ubuntu 24.04.1 LTS');
    expect(node.arch).toBe('amd64');
    expect(node.internalIP).toBe('10.0.0.11'); // 不是 ExternalIP
    expect(node.cpu).toBe('8'); // capacity 原文，不转数字
    expect(node.memory).toBe('16332160Ki');
    expect(node.pods).toBe('110');
    expect(node.created).toBe('2026-01-02T03:04:05Z');
    expect(node.conditions).toHaveLength(2);
    expect(node.conditions[1]).toEqual({
      type: 'Ready',
      status: 'True',
      reason: 'KubeletReady',
      message: 'kubelet is posting ready status',
    });
  });

  it('Ready 为 False 或缺失时 ready=false', () => {
    const notReady = k3sNode();
    notReady.status.conditions = [{ type: 'Ready', status: 'False' }];
    expect(normalizeNodes([notReady])[0].ready).toBe(false);

    // 只有别的条件，没有 Ready
    const noReady = k3sNode();
    noReady.status.conditions = [{ type: 'MemoryPressure', status: 'False' }];
    expect(normalizeNodes([noReady])[0].ready).toBe(false);
  });

  it('只有 kubernetes.io/role 标签时也能推出角色，且去重', () => {
    const worker = {
      metadata: { name: 'w-1', labels: { 'kubernetes.io/role': 'node' } },
      status: {},
    };
    expect(normalizeNodes([worker])[0].roles).toEqual(['node']);

    // 同一个角色既来自前缀标签又来自旧标签：只留一个
    const dup = {
      metadata: {
        name: 'w-2',
        labels: {
          'node-role.kubernetes.io/worker': '',
          'kubernetes.io/role': 'worker',
        },
      },
      status: {},
    };
    expect(normalizeNodes([dup])[0].roles).toEqual(['worker']);
  });

  it('字段整块缺失也不抛异常，字符串给空串', () => {
    const [node] = normalizeNodes([{ metadata: { name: 'bare' } }]);

    expect(node).toMatchObject({
      name: 'bare',
      ready: false,
      roles: [],
      version: '',
      os: '',
      arch: '',
      internalIP: '',
      cpu: '',
      memory: '',
      pods: '',
      created: '',
      conditions: [],
    });
  });

  it('空数组 / null / 非数组输入都返回空结果', () => {
    expect(normalizeNodes([])).toEqual([]);
    expect(normalizeNodes(null)).toEqual([]);
    expect(normalizeNodes(undefined)).toEqual([]);
    expect(normalizeNodes({ items: [] })).toEqual([]); // 误传整个 list 对象也不炸
  });
});

/** 构造一份 Pod，默认是单容器 Running 1/1。 */
function pod({
  metadata = { name: 'web-0', namespace: 'prod', creationTimestamp: '2026-02-01T00:00:00Z' },
  spec = { nodeName: 'k3s-master', containers: [{ name: 'web' }] },
  status = {},
} = {}) {
  return {
    metadata,
    spec,
    status: {
      phase: 'Running',
      podIP: '10.42.0.8',
      ...status,
    },
  };
}

describe('normalizePods', () => {
  it('基本字段 + ready "1/1"', () => {
    const [p] = normalizePods([
      pod({
        status: {
          containerStatuses: [{ name: 'web', ready: true, restartCount: 0, state: { running: { startedAt: 'x' } } }],
        },
      }),
    ]);

    expect(p).toMatchObject({
      namespace: 'prod',
      name: 'web-0',
      phase: 'Running',
      ready: '1/1',
      restarts: 0,
      node: 'k3s-master',
      ip: '10.42.0.8',
      created: '2026-02-01T00:00:00Z',
      oom: false,
      crashLoop: false,
    });
    expect(p.containers[0]).toEqual({ name: 'web', ready: true, restarts: 0, state: 'running' });
  });

  it('多容器：ready 是 "就绪数/总数"，restarts 是所有容器之和', () => {
    const [p] = normalizePods([
      pod({
        spec: { nodeName: 'n1', containers: [{ name: 'app' }, { name: 'sidecar' }, { name: 'proxy' }] },
        status: {
          containerStatuses: [
            { name: 'app', ready: true, restartCount: 3, state: { running: {} } },
            { name: 'sidecar', ready: false, restartCount: 7, state: { waiting: { reason: 'ContainerCreating' } } },
            { name: 'proxy', ready: true, restartCount: 0, state: { running: {} } },
          ],
        },
      }),
    ]);

    expect(p.ready).toBe('2/3');
    expect(p.restarts).toBe(10); // 3 + 7 + 0
    expect(p.containers.map((c) => c.restarts)).toEqual([3, 7, 0]);
    expect(p.containers[1]).toMatchObject({ ready: false, state: 'waiting', reason: 'ContainerCreating' });
  });

  it('OOM 两条判定路径：terminated.reason=OOMKilled 与 exitCode=137', () => {
    const byReason = normalizePods([
      pod({
        status: {
          containerStatuses: [
            {
              name: 'web',
              ready: false,
              restartCount: 1,
              state: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
            },
          ],
        },
      }),
    ])[0];
    expect(byReason.oom).toBe(true);
    expect(byReason.containers[0]).toEqual({
      name: 'web',
      ready: false,
      restarts: 1,
      state: 'terminated',
      reason: 'OOMKilled',
    });

    // 只有退出码 137（reason 被上游抹掉/是 Error 之类）
    const byExitCode = normalizePods([
      pod({
        status: {
          containerStatuses: [{ name: 'web', ready: false, restartCount: 2, state: { terminated: { exitCode: 137 } } }],
        },
      }),
    ])[0];
    expect(byExitCode.oom).toBe(true);
  });

  it('exitCode 137 之外的非 0 退出码不算 OOM', () => {
    const [p] = normalizePods([
      pod({
        status: {
          containerStatuses: [
            { name: 'web', ready: false, restartCount: 1, state: { terminated: { reason: 'Error', exitCode: 1 } } },
          ],
        },
      }),
    ]);
    expect(p.oom).toBe(false);
    expect(p.crashLoop).toBe(false);
  });

  it('lastState.terminated 里的 OOM 也算（当前已在 Creating/Running）', () => {
    const [p] = normalizePods([
      pod({
        status: {
          containerStatuses: [
            {
              name: 'web',
              ready: false,
              restartCount: 4,
              state: { waiting: { reason: 'CrashLoopBackOff' } },
              lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
            },
          ],
        },
      }),
    ]);
    expect(p.oom).toBe(true);
    expect(p.crashLoop).toBe(true);
    expect(p.containers[0]).toMatchObject({ state: 'waiting', reason: 'CrashLoopBackOff' });
  });

  it('CrashLoopBackOff 只认 waiting.reason', () => {
    const crash = normalizePods([
      pod({
        status: {
          containerStatuses: [
            { name: 'web', ready: false, restartCount: 9, state: { waiting: { reason: 'CrashLoopBackOff' } } },
          ],
        },
      }),
    ])[0];
    expect(crash.crashLoop).toBe(true);
    expect(crash.oom).toBe(false);

    // 普通错误退出但没进 CrashLoopBackOff
    const errorOnly = normalizePods([
      pod({
        status: {
          containerStatuses: [
            { name: 'web', ready: false, restartCount: 1, state: { terminated: { reason: 'Error', exitCode: 1 } } },
          ],
        },
      }),
    ])[0];
    expect(errorOnly.crashLoop).toBe(false);
  });

  it('没有容器状态时是 "0/1" 且 state 为 unknown，不抛异常', () => {
    const [p] = normalizePods([pod({ status: {} })]);
    expect(p.ready).toBe('0/1');
    expect(p.restarts).toBe(0);
    expect(p.containers).toEqual([]);
    expect(p.oom).toBe(false);
  });

  it('字段整块缺失（只有 metadata.name）也能出结果', () => {
    const [p] = normalizePods([{ metadata: { name: 'ghost' } }]);

    expect(p).toMatchObject({
      namespace: '',
      name: 'ghost',
      phase: 'Unknown',
      ready: '0/0',
      restarts: 0,
      node: '',
      ip: '',
      created: '',
      oom: false,
      crashLoop: false,
      containers: [],
    });
  });

  it('空数组 / null 输入返回空结果', () => {
    expect(normalizePods([])).toEqual([]);
    expect(normalizePods(null)).toEqual([]);
    expect(normalizePods(undefined)).toEqual([]);
  });
});

describe('normalizeWorkloads', () => {
  it('Deployment 用 status.replicas/readyReplicas/updatedReplicas/availableReplicas', () => {
    const [w] = normalizeWorkloads('Deployment', [
      {
        metadata: { name: 'api', namespace: 'prod', creationTimestamp: '2026-03-01T00:00:00Z' },
        status: { replicas: 3, readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2 },
      },
    ]);

    expect(w).toEqual({
      namespace: 'prod',
      name: 'api',
      kind: 'Deployment',
      desired: 3,
      ready: 2,
      upToDate: 3,
      available: 2,
      created: '2026-03-01T00:00:00Z',
    });
  });

  it('StatefulSet 的 upToDate 取 currentReplicas', () => {
    const [w] = normalizeWorkloads('StatefulSet', [
      {
        metadata: { name: 'db', namespace: 'prod' },
        status: { replicas: 3, readyReplicas: 3, currentReplicas: 2, availableReplicas: 1 },
      },
    ]);

    expect(w).toMatchObject({ kind: 'StatefulSet', desired: 3, ready: 3, upToDate: 2, available: 1 });
  });

  it('DaemonSet 用 desiredNumberScheduled/numberReady/updatedNumberScheduled/numberAvailable', () => {
    const [w] = normalizeWorkloads('DaemonSet', [
      {
        metadata: { name: 'node-agent', namespace: 'kube-system', creationTimestamp: '2026-03-02T00:00:00Z' },
        status: {
          desiredNumberScheduled: 5,
          numberReady: 4,
          updatedNumberScheduled: 3,
          numberAvailable: 2,
          // 干扰字段：Deployment 风格字段不该被 DaemonSet 读到
          replicas: 99,
          readyReplicas: 99,
        },
      },
    ]);

    expect(w).toEqual({
      namespace: 'kube-system',
      name: 'node-agent',
      kind: 'DaemonSet',
      desired: 5,
      ready: 4,
      upToDate: 3,
      available: 2,
      created: '2026-03-02T00:00:00Z',
    });
  });

  it('status 整块缺失时四个数字全部按 0', () => {
    const [w] = normalizeWorkloads('DaemonSet', [{ metadata: { name: 'idle', namespace: 'default' } }]);

    expect(w).toMatchObject({ desired: 0, ready: 0, upToDate: 0, available: 0, created: '' });
  });

  it('kind 大小写不敏感，输出统一成契约里的大驼峰', () => {
    const [w] = normalizeWorkloads('daemonset', [
      { metadata: { name: 'agent', namespace: 'kube-system' }, status: { desiredNumberScheduled: 2, numberReady: 2 } },
    ]);
    expect(w).toMatchObject({ kind: 'DaemonSet', desired: 2, ready: 2 });
  });

  it('空数组 / null 输入返回空结果', () => {
    expect(normalizeWorkloads('Deployment', [])).toEqual([]);
    expect(normalizeWorkloads('Deployment', null)).toEqual([]);
  });
});

describe('normalizeEvents', () => {
  it('object 拼成 Kind/namespace/name，count 默认 1', () => {
    const [e] = normalizeEvents([
      {
        metadata: { namespace: 'prod' },
        involvedObject: { kind: 'Pod', namespace: 'prod', name: 'web-0' },
        type: 'Warning',
        reason: 'BackOff',
        message: 'Back-off restarting failed container',
        lastTimestamp: '2026-04-01T10:00:00Z',
      },
    ]);

    expect(e).toEqual({
      namespace: 'prod',
      type: 'Warning',
      reason: 'BackOff',
      object: 'Pod/prod/web-0',
      message: 'Back-off restarting failed container',
      count: 1,
      lastSeen: '2026-04-01T10:00:00Z',
    });
  });

  it('lastSeen 回退链：lastTimestamp → eventTime → firstTimestamp', () => {
    const pick = (extra) =>
      normalizeEvents([
        { metadata: { namespace: 'prod' }, involvedObject: { kind: 'Pod', namespace: 'prod', name: 'x' }, ...extra },
      ])[0].lastSeen;

    expect(pick({ lastTimestamp: 'L', eventTime: 'E', firstTimestamp: 'F' })).toBe('L');
    expect(pick({ eventTime: 'E', firstTimestamp: 'F' })).toBe('E');
    expect(pick({ firstTimestamp: 'F' })).toBe('F');
    expect(pick({})).toBe('');
  });

  it('按 lastSeen 倒序（最新在前），无时间的排最后', () => {
    const events = normalizeEvents([
      {
        metadata: { namespace: 'prod' },
        involvedObject: { kind: 'Pod', namespace: 'prod', name: 'old' },
        lastTimestamp: '2026-04-01T09:00:00Z',
        count: 3,
      },
      {
        metadata: { namespace: 'prod' },
        involvedObject: { kind: 'Pod', namespace: 'prod', name: 'no-time' },
      },
      {
        metadata: { namespace: 'prod' },
        involvedObject: { kind: 'Node', namespace: '', name: 'k3s-master' },
        lastTimestamp: '2026-04-01T11:00:00Z',
      },
      {
        metadata: { namespace: 'prod' },
        involvedObject: { kind: 'Pod', namespace: 'prod', name: 'mid' },
        eventTime: '2026-04-01T10:00:00Z',
      },
    ]);

    expect(events.map((e) => e.object)).toEqual([
      'Node/k3s-master', // 集群级对象没有 namespace，空段被忽略
      'Pod/prod/mid',
      'Pod/prod/old',
      'Pod/prod/no-time',
    ]);
    expect(events[2].count).toBe(3);
  });

  it('字段缺失时给出安全默认值（type 兜底 Normal，不会被算成 Warning）', () => {
    const [e] = normalizeEvents([{}]);

    expect(e).toEqual({
      namespace: '',
      type: 'Normal',
      reason: '',
      object: '',
      message: '',
      count: 1,
      lastSeen: '',
    });
  });

  it('空数组 / null 输入返回空结果', () => {
    expect(normalizeEvents([])).toEqual([]);
    expect(normalizeEvents(null)).toEqual([]);
  });
});

describe('summarize', () => {
  it('统计节点、Pod、工作负载、警告事件', () => {
    const nodes = normalizeNodes([
      k3sNode(),
      { metadata: { name: 'w-1', labels: { 'kubernetes.io/role': 'node' } }, status: {} },
    ]);

    const pods = normalizePods([
      pod({
        metadata: { name: 'ok-0', namespace: 'prod' },
        status: { containerStatuses: [{ name: 'web', ready: true, restartCount: 0, state: { running: {} } }] },
      }),
      pod({
        metadata: { name: 'oom-0', namespace: 'prod' },
        status: {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'web',
              ready: false,
              restartCount: 6,
              state: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
            },
          ],
        },
      }),
      pod({
        metadata: { name: 'pending-0', namespace: 'prod' },
        status: { phase: 'Pending', containerStatuses: [] },
      }),
      pod({ metadata: { name: 'done-0', namespace: 'batch' }, status: { phase: 'Succeeded' } }),
    ]);

    const workloads = [
      ...normalizeWorkloads('Deployment', [
        { metadata: { name: 'api' }, status: { replicas: 3, readyReplicas: 3 } },
        { metadata: { name: 'worker' }, status: { replicas: 2, readyReplicas: 1 } },
      ]),
      ...normalizeWorkloads('DaemonSet', [
        { metadata: { name: 'agent' }, status: { desiredNumberScheduled: 3, numberReady: 2 } },
      ]),
    ];

    const events = normalizeEvents([
      { metadata: { namespace: 'prod' }, involvedObject: { kind: 'Pod', name: 'x' }, type: 'Warning', lastTimestamp: '2026-04-01T10:00:00Z' },
      { metadata: { namespace: 'prod' }, involvedObject: { kind: 'Pod', name: 'y' }, type: 'Warning', lastTimestamp: '2026-04-01T11:00:00Z' },
      { metadata: { namespace: 'prod' }, involvedObject: { kind: 'Pod', name: 'z' }, type: 'Normal', lastTimestamp: '2026-04-01T12:00:00Z' },
    ]);

    expect(summarize({ nodes, pods, workloads, events })).toEqual({
      nodes: 2,
      nodesReady: 1,
      pods: 4,
      podsRunning: 2, // ok-0、oom-0
      podsUnhealthy: 2, // oom-0（Running 但 OOM）+ pending-0；Succeeded 不算
      workloads: 3,
      workloadsUnready: 2, // worker 1/2、DaemonSet 2/3
      warningEvents: 2,
    });
  });

  it('同一个 Pod 同时 OOM 与 CrashLoop 只计一次（按 Pod 去重）', () => {
    const pods = normalizePods([
      pod({
        metadata: { name: 'bad-0', namespace: 'prod' },
        status: {
          phase: 'Running',
          containerStatuses: [
            { name: 'a', ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } },
            {
              name: 'b',
              ready: false,
              restartCount: 2,
              state: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
            },
          ],
        },
      }),
    ]);

    expect(pods[0]).toMatchObject({ oom: true, crashLoop: true, restarts: 7 });
    expect(summarize({ pods }).podsUnhealthy).toBe(1);
  });

  it('空输入与缺参都返回全 0', () => {
    const zero = {
      nodes: 0,
      nodesReady: 0,
      pods: 0,
      podsRunning: 0,
      podsUnhealthy: 0,
      workloads: 0,
      workloadsUnready: 0,
      warningEvents: 0,
    };

    expect(summarize({ nodes: [], pods: [], workloads: [], events: [] })).toEqual(zero);
    expect(summarize({})).toEqual(zero);
    expect(summarize()).toEqual(zero);
    expect(summarize({ nodes: null, pods: undefined })).toEqual(zero);
  });
});
