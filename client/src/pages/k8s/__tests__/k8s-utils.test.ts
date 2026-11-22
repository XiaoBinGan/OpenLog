/**
 * K8s 页面纯函数测试。
 *
 * 这些函数错了**不会报错**，只会显示成另一回事（Pod 明明挂了显示绿色、
 * 统计卡数字对不上表格、日志路径把 namespace 里的斜杠吃掉），
 * 所以按表驱动的方式把每个分支都钉死。
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_NAMESPACES,
  LOG_TAIL,
  MISSING,
  buildStatCards,
  clusterApiPath,
  deriveSummary,
  ensureOverview,
  errorText,
  filterPods,
  formatAge,
  formatCores,
  formatMib,
  gpuPodsByNode,
  hasHamiData,
  isPodReady,
  isPodUnhealthy,
  listNamespaces,
  nodeRolesLabel,
  podKey,
  podLogsPath,
  podMarkers,
  podSeverity,
  sortPods,
  usagePercent,
  vgpuLabel,
  warningEvents,
  withPodVgpu,
} from '../utils';
import type { K8sEvent, K8sGpuOverview, K8sNode, K8sPod, K8sWorkload } from '../types';

function pod(over: Partial<K8sPod> = {}): K8sPod {
  return {
    namespace: 'default',
    name: 'pod',
    phase: 'Running',
    ready: '1/1',
    restarts: 0,
    node: 'node-1',
    ip: '10.0.0.1',
    created: '2026-01-01T00:00:00Z',
    oom: false,
    crashLoop: false,
    containers: [{ name: 'main', ready: true, restarts: 0, state: 'running' }],
    ...over,
  };
}

function node(over: Partial<K8sNode> = {}): K8sNode {
  return {
    name: 'node-1',
    ready: true,
    roles: ['control-plane', 'master'],
    version: 'v1.33.1+k3s1',
    os: 'linux',
    arch: 'amd64',
    internalIP: '10.0.0.10',
    cpu: '4',
    memory: '8123456Ki',
    pods: '110',
    created: '2026-01-01T00:00:00Z',
    conditions: [],
    ...over,
  };
}

function workload(over: Partial<K8sWorkload> = {}): K8sWorkload {
  return {
    namespace: 'default',
    name: 'web',
    kind: 'Deployment',
    desired: 3,
    ready: 3,
    upToDate: 3,
    available: 3,
    created: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function event(over: Partial<K8sEvent> = {}): K8sEvent {
  return {
    namespace: 'default',
    type: 'Warning',
    reason: 'BackOff',
    object: 'pod/web-1',
    message: 'Back-off restarting failed container',
    count: 3,
    lastSeen: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('isPodReady', () => {
  it('"1/1" 视为就绪', () => {
    expect(isPodReady(pod({ ready: '1/1' }))).toBe(true);
  });

  it('"1/2" 视为未就绪', () => {
    expect(isPodReady(pod({ ready: '1/2' }))).toBe(false);
  });

  it('"0/0" 不算就绪（没有容器不是"全就绪"）', () => {
    expect(isPodReady(pod({ ready: '0/0' }))).toBe(false);
  });

  it('ready 缺失时退回容器 ready 标记', () => {
    expect(
      isPodReady(pod({ ready: '', containers: [
        { name: 'a', ready: true, restarts: 0, state: 'running' },
        { name: 'b', ready: false, restarts: 0, state: 'running' },
      ] })),
    ).toBe(false);
    expect(
      isPodReady(pod({ ready: '', containers: [{ name: 'a', ready: true, restarts: 0, state: 'running' }] })),
    ).toBe(true);
  });

  it('ready 和容器都没有时按 phase 兜底', () => {
    expect(isPodReady(pod({ ready: '', containers: [], phase: 'Running' }))).toBe(true);
    expect(isPodReady(pod({ ready: '', containers: [], phase: 'Pending' }))).toBe(false);
    expect(isPodReady(pod({ ready: '', containers: [], phase: 'Succeeded' }))).toBe(true);
  });

  it('容忍 "1 / 1" 这种带空格写法', () => {
    expect(isPodReady(pod({ ready: '1 / 1' }))).toBe(true);
  });
});

describe('isPodUnhealthy / podSeverity', () => {
  it('Running + 就绪 = 健康', () => {
    expect(isPodUnhealthy(pod())).toBe(false);
    expect(podSeverity(pod())).toBe('ok');
  });

  it('OOM 与 CrashLoop 都算异常且是 error 档', () => {
    expect(isPodUnhealthy(pod({ oom: true }))).toBe(true);
    expect(podSeverity(pod({ oom: true }))).toBe('error');
    expect(podSeverity(pod({ crashLoop: true }))).toBe('error');
  });

  it('CrashLoop 即使 phase 还是 Running 也算异常', () => {
    expect(isPodUnhealthy(pod({ phase: 'Running', crashLoop: true }))).toBe(true);
  });

  it('未就绪算 warn', () => {
    expect(podSeverity(pod({ ready: '1/2' }))).toBe('warn');
  });

  it('Failed 算 error；Succeeded 即使 ready 是 0/1 也算健康（Job 跑完不是故障）', () => {
    expect(podSeverity(pod({ phase: 'Failed' }))).toBe('error');
    expect(podSeverity(pod({ phase: 'Succeeded', ready: '0/1' }))).toBe('ok');
    expect(isPodUnhealthy(pod({ phase: 'Succeeded', ready: '0/1' }))).toBe(false);
  });

  it('Pending 既不是 Running 也不是 Succeeded，算异常', () => {
    expect(isPodUnhealthy(pod({ phase: 'Pending', ready: '0/1' }))).toBe(true);
  });
});

describe('podMarkers', () => {
  it('健康 Pod 没有任何标记', () => {
    expect(podMarkers(pod())).toEqual([]);
  });

  it('OOM + CrashLoop + 重启数依次出现', () => {
    expect(podMarkers(pod({ oom: true, crashLoop: true, restarts: 7 }))).toEqual([
      'OOMKilled',
      'CrashLoopBackOff',
      '重启 7 次',
    ]);
  });

  it('Running 但未就绪时补「未就绪」', () => {
    expect(podMarkers(pod({ ready: '1/2' }))).toContain('未就绪');
  });

  it('其它容器 reason 去重后附加（不重复 OOMKilled / CrashLoopBackOff）', () => {
    const markers = podMarkers(
      pod({
        oom: true,
        restarts: 2,
        ready: '1/1',
        containers: [
          { name: 'a', ready: false, restarts: 2, state: 'waiting', reason: 'OOMKilled' },
          { name: 'b', ready: false, restarts: 1, state: 'waiting', reason: 'ImagePullBackOff' },
          { name: 'c', ready: false, restarts: 1, state: 'waiting', reason: 'ImagePullBackOff' },
        ],
      }),
    );
    expect(markers).toEqual(['OOMKilled', '重启 2 次', 'ImagePullBackOff']);
  });
});

describe('listNamespaces / filterPods', () => {
  const pods = [
    pod({ namespace: 'kube-system', name: 'coredns' }),
    pod({ namespace: 'default', name: 'web-1' }),
    pod({ namespace: 'default', name: 'web-2', node: 'node-2' }),
  ];

  it('去重并按字母排序', () => {
    expect(listNamespaces(pods)).toEqual(['default', 'kube-system']);
  });

  it('ALL_NAMESPACES（空串）返回全部', () => {
    expect(filterPods(pods, ALL_NAMESPACES)).toHaveLength(3);
    expect(filterPods(pods)).toHaveLength(3);
  });

  it('按 namespace 过滤', () => {
    const filtered = filterPods(pods, 'kube-system');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('coredns');
  });

  it('关键字按 name / node 匹配，忽略大小写', () => {
    expect(filterPods(pods, ALL_NAMESPACES, 'WEB-1')).toHaveLength(1);
    expect(filterPods(pods, ALL_NAMESPACES, 'node-2')).toHaveLength(1);
    expect(filterPods(pods, ALL_NAMESPACES, '  ')).toHaveLength(3);
  });
});

describe('sortPods', () => {
  it('error → warn → ok，其次按重启数与名字', () => {
    const rows = [
      pod({ name: 'ok-a' }),
      pod({ name: 'warn-a', ready: '1/2' }),
      pod({ name: 'err-a', oom: true }),
      pod({ name: 'ok-b', restarts: 5 }),
    ];
    expect(sortPods(rows).map((p) => p.name)).toEqual(['err-a', 'warn-a', 'ok-b', 'ok-a']);
  });

  it('不修改入参', () => {
    const rows = [pod({ name: 'b' }), pod({ name: 'a' })];
    const before = rows.map((p) => p.name);
    sortPods(rows);
    expect(rows.map((p) => p.name)).toEqual(before);
  });
});

describe('deriveSummary', () => {
  it('统计口径与契约一致', () => {
    const summary = deriveSummary({
      nodes: [node(), node({ name: 'node-2', ready: false })],
      pods: [
        pod(),
        pod({ name: 'p2', phase: 'Pending', ready: '0/1' }),
        pod({ name: 'p3', oom: true }),
        pod({ name: 'p4', phase: 'Succeeded', ready: '0/1' }),
      ],
      workloads: [workload(), workload({ name: 'api', ready: 1, desired: 3 })],
      events: [event(), event({ type: 'Normal', reason: 'Started' })],
    });
    expect(summary).toEqual({
      nodes: 2,
      nodesReady: 1,
      pods: 4,
      podsRunning: 2,
      podsUnhealthy: 2,
      workloads: 2,
      workloadsUnready: 1,
      warningEvents: 1,
    });
  });

  it('缺字段时按空数组处理', () => {
    expect(deriveSummary({})).toMatchObject({ nodes: 0, pods: 0, workloads: 0, warningEvents: 0 });
  });
});

describe('ensureOverview', () => {
  it('null / undefined 返回 null', () => {
    expect(ensureOverview(null)).toBeNull();
    expect(ensureOverview(undefined)).toBeNull();
  });

  it('缺 summary 时本地重算', () => {
    const overview = ensureOverview({ nodes: [node()], pods: [pod()] });
    expect(overview?.summary).toMatchObject({ nodes: 1, nodesReady: 1, pods: 1, podsRunning: 1 });
  });

  it('数组字段缺失兜成空数组', () => {
    const overview = ensureOverview({ cluster: { version: 'v1.33.1', server: 'https://x:6443', context: 'k3s' } });
    expect(overview).toMatchObject({
      nodes: [],
      pods: [],
      workloads: [],
      events: [],
      cluster: { version: 'v1.33.1', server: 'https://x:6443', context: 'k3s' },
    });
  });

  it('保留服务端给出的 summary', () => {
    const summary = { nodes: 9, nodesReady: 8, pods: 1, podsRunning: 1, podsUnhealthy: 0, workloads: 0, workloadsUnready: 0, warningEvents: 0 };
    expect(ensureOverview({ summary })?.summary).toEqual(summary);
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');

  it('按秒/分/时/天/年分档', () => {
    expect(formatAge('2026-01-02T00:00:00Z', now)).toBe('0s');
    expect(formatAge('2026-01-01T23:59:30Z', now)).toBe('30s');
    expect(formatAge('2026-01-01T23:55:00Z', now)).toBe('5m');
    expect(formatAge('2026-01-01T21:00:00Z', now)).toBe('3h');
    expect(formatAge('2025-12-31T00:00:00Z', now)).toBe('2d');
    expect(formatAge('2024-01-02T00:00:00Z', now)).toBe('2y');
  });

  it('解析不了 / 空串 / 未来时间都返回「—」', () => {
    expect(formatAge('', now)).toBe('—');
    expect(formatAge('not-a-date', now)).toBe('—');
    expect(formatAge('2026-01-03T00:00:00Z', now)).toBe('—');
  });
});

describe('nodeRolesLabel', () => {
  it('过滤 <none> 与空值，全空时显示 worker', () => {
    expect(nodeRolesLabel(['control-plane', 'master'])).toBe('control-plane, master');
    expect(nodeRolesLabel(['<none>'])).toBe('worker');
    expect(nodeRolesLabel([])).toBe('worker');
    expect(nodeRolesLabel(['', '  '])).toBe('worker');
  });
});

describe('路径拼装', () => {
  it('clusterApiPath 会对 id 编码', () => {
    expect(clusterApiPath('a b', '/overview')).toBe('/api/k8s/clusters/a%20b/overview');
  });

  it('podLogsPath 编码 namespace / pod，并带上 tail', () => {
    expect(podLogsPath('cid', { namespace: 'kube-system', pod: 'coredns-7d8f' })).toBe(
      '/api/k8s/clusters/cid/pods/kube-system/coredns-7d8f/logs?tail=200',
    );
  });

  it('pod 名里的斜杠必须编码', () => {
    expect(podLogsPath('cid', { namespace: 'ns', pod: 'a/b' }, 50)).toBe(
      '/api/k8s/clusters/cid/pods/ns/a%2Fb/logs?tail=50',
    );
  });

  it('tail 被夹到 [1, 5000] 且取整', () => {
    expect(podLogsPath('cid', { namespace: 'ns', pod: 'p' }, 0)).toContain('tail=1');
    expect(podLogsPath('cid', { namespace: 'ns', pod: 'p' }, -5)).toContain('tail=1');
    expect(podLogsPath('cid', { namespace: 'ns', pod: 'p' }, 99999)).toContain('tail=5000');
    expect(podLogsPath('cid', { namespace: 'ns', pod: 'p' }, 12.7)).toContain('tail=12');
    expect(podLogsPath('cid', { namespace: 'ns', pod: 'p' }, Number.NaN)).toContain(`tail=${LOG_TAIL}`);
  });
});

describe('podKey / errorText / warningEvents', () => {
  it('podKey 用 namespace/name', () => {
    expect(podKey({ namespace: 'default', name: 'web-1' })).toBe('default/web-1');
  });

  it('errorText 优先取 Error.message', () => {
    expect(errorText(new Error('权限不足：需要 nodes 的 list'))).toBe('权限不足：需要 nodes 的 list');
    expect(errorText('字符串错误')).toBe('字符串错误');
    expect(errorText(new Error('   '))).toBe('请求失败，请查看服务端日志');
    expect(errorText(null)).toBe('请求失败，请查看服务端日志');
  });

  it('warningEvents 只保留 Warning（大小写不敏感）', () => {
    const events = [event(), event({ type: 'Normal' }), event({ type: 'warning' })];
    expect(warningEvents(events)).toHaveLength(2);
  });
});

describe('buildStatCards', () => {
  it('四张卡的数值与色调', () => {
    const cards = buildStatCards({
      nodes: 3,
      nodesReady: 2,
      pods: 10,
      podsRunning: 8,
      podsUnhealthy: 2,
      workloads: 4,
      workloadsUnready: 1,
      warningEvents: 5,
    });
    expect(cards.map((c) => c.key)).toEqual(['nodes', 'pods', 'workloads', 'events']);
    expect(cards[0]).toMatchObject({ value: '2/3', tone: 'error', hint: '1 个未就绪' });
    expect(cards[1]).toMatchObject({ value: '10', tone: 'warn', hint: '8 Running · 2 异常' });
    expect(cards[2]).toMatchObject({ value: '4', tone: 'warn', hint: '1 个副本不足' });
    expect(cards[3]).toMatchObject({ value: '5', tone: 'error' });
  });

  it('全健康时是 ok，没有节点时是 neutral', () => {
    const cards = buildStatCards({
      nodes: 0,
      nodesReady: 0,
      pods: 0,
      podsRunning: 0,
      podsUnhealthy: 0,
      workloads: 0,
      workloadsUnready: 0,
      warningEvents: 0,
    });
    expect(cards[0]).toMatchObject({ value: '0/0', tone: 'neutral' });
    expect(cards[3]).toMatchObject({ value: '0', tone: 'ok', hint: '暂无告警' });
  });
});
// ─── HAMi vGPU 纯函数 ─────────────────────────────────────────────────────
// 这些函数决定「卡片上显示什么」：单位换算、百分比夹取、缺字段兜「—」。
// 算错了不会报错，只会显示成另一回事（56 GiB 显示成 57344 MiB、NaN%、undefined%），
// 所以逐条钉死。
describe('HAMi vGPU · 格式化', () => {
  it('formatMib：整 GiB 不带小数，非整带一位，缺失/负数给「—」', () => {
    expect(formatMib(98304)).toBe('96 GiB');
    expect(formatMib(12288)).toBe('12 GiB');
    expect(formatMib(1536)).toBe('1.5 GiB');
    expect(formatMib(512)).toBe('512 MiB');
    expect(formatMib(0)).toBe('0 MiB');
    expect(formatMib(null)).toBe(MISSING);
    expect(formatMib(undefined)).toBe(MISSING);
    expect(formatMib(-1)).toBe(MISSING);
    expect(formatMib(Number.NaN)).toBe(MISSING);
  });

  it('formatCores：算力点按百分比展示，缺失给「—」', () => {
    expect(formatCores(40)).toBe('40%');
    expect(formatCores(10)).toBe('10%');
    expect(formatCores(0)).toBe('0%');
    expect(formatCores(undefined)).toBe(MISSING);
    expect(formatCores(Number.NaN)).toBe(MISSING);
  });

  it('usagePercent：夹在 0..100，总量为 0 时给 null（不画进度条）', () => {
    expect(usagePercent(57344, 98304)).toBe(58);
    expect(usagePercent(16384, 98304)).toBe(17);
    expect(usagePercent(0, 98304)).toBe(0);
    expect(usagePercent(98304, 98304)).toBe(100);
    // 异常数据：已分配 > 总量、总量 0、字段缺失
    expect(usagePercent(196608, 98304)).toBe(100);
    expect(usagePercent(10, 0)).toBeNull();
    expect(usagePercent(undefined, 100)).toBeNull();
    expect(usagePercent(10, undefined)).toBeNull();
  });

  it('vgpuLabel：Pod 表格那一列是「显存 · 算力」', () => {
    const vgpu = {
      hasVgpu: true,
      devices: [{ id: 'GPU-3f2a', memMiB: 12288, cores: 40 }],
      totalMemMiB: 12288,
      totalCores: 40,
      nodeName: 'node-1',
    };
    expect(vgpuLabel(vgpu)).toBe('12 GiB · 40%');
    // 合计缺失时按设备重算
    expect(vgpuLabel({ ...vgpu, totalMemMiB: 0, totalCores: 0 })).toBe('12 GiB · 40%');
    expect(vgpuLabel({ hasVgpu: false, devices: [], totalMemMiB: 0, totalCores: 0, nodeName: null })).toBe(MISSING);
    expect(vgpuLabel(null)).toBe(MISSING);
    expect(vgpuLabel(undefined)).toBe(MISSING);
    // 坏字段不产生 NaN
    expect(vgpuLabel({ hasVgpu: true, devices: [], totalMemMiB: Number.NaN, totalCores: undefined } as never)).toBe(MISSING);
  });
});

describe('HAMi vGPU · gpu 段', () => {
  const gpu = (over: Partial<K8sGpuOverview> = {}): K8sGpuOverview => ({
    hasHami: true,
    nodes: [
      { name: 'node-1', count: 4, memMiB: 98304, cores: 400, allocatedMemMiB: 16384, allocatedCores: 50, podCount: 2 },
    ],
    pods: [
      {
        namespace: 'inference',
        name: 'vllm-qwen27b-0',
        nodeName: 'node-1',
        devices: [{ id: 'GPU-a', memMiB: 12288, cores: 40 }],
        totalMemMiB: 12288,
        totalCores: 40,
        phase: 'Running',
      },
      {
        namespace: 'inference',
        name: 'sglang-router',
        nodeName: 'node-1',
        devices: [{ id: 'GPU-a', memMiB: 4096, cores: 10 }],
        totalMemMiB: 4096,
        totalCores: 10,
        phase: 'Running',
      },
    ],
    totals: { gpuCount: 4, memMiB: 98304, cores: 400, allocatedMemMiB: 16384, allocatedCores: 50, podCount: 2 },
    warnings: [],
    ...over,
  });

  it('hasHamiData：只有 hasHami === true 才算有 HAMi', () => {
    expect(hasHamiData(gpu())).toBe(true);
    expect(hasHamiData(gpu({ hasHami: false }))).toBe(false);
    expect(hasHamiData(null)).toBe(false);
    expect(hasHamiData(undefined)).toBe(false);
  });

  it('gpuPodsByNode：按节点分组，节点顺序跟 nodes 一致，缺 nodeName 归到「—」', () => {
    const groups = gpuPodsByNode(
      gpu({
        nodes: [
          { name: 'node-1', count: 4, memMiB: 98304, cores: 400, allocatedMemMiB: 16384, allocatedCores: 50, podCount: 2 },
          { name: 'node-2', count: 2, memMiB: 49152, cores: 200, allocatedMemMiB: 0, allocatedCores: 0, podCount: 0 },
        ],
        pods: [
          ...gpu().pods,
          // 有分配但节点没上报（nodeName 为 null）
          { namespace: 'batch', name: 'orphan', nodeName: null, devices: [], totalMemMiB: 1024, totalCores: 5, phase: 'Running' },
        ],
      }),
    );
    expect(groups.map((group) => group.node)).toEqual(['node-1', 'node-2', MISSING]);
    expect(groups[0].pods.map((pod) => pod.name)).toEqual(['vllm-qwen27b-0', 'sglang-router']);
    expect(groups[1].pods).toEqual([]);
    expect(groups[2].pods.map((pod) => pod.name)).toEqual(['orphan']);
    expect(gpuPodsByNode(null)).toEqual([]);
  });

  it('withPodVgpu：服务端只给 gpu.pods 时也能补齐 Pod 的 vgpu', () => {
    const pods = [pod({ namespace: 'inference', name: 'vllm-qwen27b-0' }), pod({ namespace: 'x', name: 'y' })];
    const merged = withPodVgpu(pods, gpu());
    expect(merged[0].vgpu).toMatchObject({ hasVgpu: true, totalMemMiB: 12288, totalCores: 40 });
    // 没有分配的 Pod 保持原样（表格显示「—」）
    expect(merged[1].vgpu).toBeUndefined();
    // 没有 HAMi 时原数组原样返回（引用相等，避免无意义的重渲染）
    expect(withPodVgpu(pods, gpu({ hasHami: false }))).toBe(pods);
  });

  it('ensureOverview：保留 gpu 段；缺字段时给 null，不编造数据', () => {
    expect(ensureOverview({ nodes: [], pods: [], gpu: gpu() })?.gpu?.hasHami).toBe(true);
    expect(ensureOverview({ nodes: [], pods: [] })?.gpu).toBeNull();
    expect(ensureOverview({ nodes: [], pods: [], gpu: 'nonsense' as never })?.gpu).toBeNull();
  });
});
