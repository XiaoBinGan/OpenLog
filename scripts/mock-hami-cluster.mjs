#!/usr/bin/env node
/**
 * 模拟 HAMi 集群 —— 一个假的 kube-apiserver，专门用来验证/演示 vGPU 分配视图。
 *
 * 为什么需要它：
 *   真要看 HAMi 数据得有一台装了 HAMi device-plugin 的 GPU 节点。没有机器的时候，
 *   无论是开发 UI、给客户演示、还是回归测试，都会因为「没有 GPU 集群」卡住。
 *   这个脚本用纯 node 起一个 HTTP 服务，按 K8s API 的形状返回：
 *     · 节点 capacity/allocatable 里的 nvidia.com/gpu | gpumem | gpucores
 *     · Pod 注解 hami.io/vgpu-devices-allocated / hami.io/vgpu-node-allocated
 *     · 若干 Warning 事件（显存不足导致 Pending、OOM CrashLoop）
 *   OpenLog 用普通 kubeconfig 连上来，走的是真 HTTP、真 JSON、真归一化链路，
 *   和连真集群没有区别（唯一区别是数据是这里写死的）。
 *
 * 用法：
 *   node scripts/mock-hami-cluster.mjs                # 监听 18445，打印可直接粘贴的 kubeconfig
 *   node scripts/mock-hami-cluster.mjs --port 18080
 *   node scripts/mock-hami-cluster.mjs --no-auth       # 不校验 token（排障用）
 *   node scripts/mock-hami-cluster.mjs --print-kubeconfig  # 只打印 kubeconfig 后退出
 *
 * 安全边界：
 *   只读。不写任何文件、不发起任何出站请求、只监听 127.0.0.1。
 *   token 是写死的 'mock-hami-token'，仅供本地使用，不要暴露到外网。
 */
import http from 'node:http';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(value('--port', '18445'));
const HOST = '127.0.0.1';
const TOKEN = 'mock-hami-token';
const AUTH = !flag('--no-auth');

const NOW = new Date('2026-06-08T09:48:37.000Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** 设备 UUID（固定值，保证多次请求一致） */
const GPU = {
  a0: 'GPU-3f2a9c1e-77b4-4d21-9a8e-1b2c3d4e5f60',
  a1: 'GPU-9b1c8d2f-11aa-4c33-8b44-5d6e7f8a9b01',
  a2: 'GPU-4d7e8f90-22bb-4c55-9d66-7e8f90a1b2c3',
  a3: 'GPU-5e8f90a1-33cc-4d66-8e77-9fab01c2d3e4',
  b0: 'GPU-6fab01c2-44dd-4e77-9f88-0abc12d3e4f5',
  b1: 'GPU-70bc12d3-55ee-4f88-a099-1bcd23e4f506',
};

function node(name, { cards, memMiB, cores, ip, products, ready = true, reason, message }) {
  return {
    metadata: {
      name,
      uid: `uid-${name}`,
      creationTimestamp: ago(60 * 24 * 30),
      labels: {
        'kubernetes.io/hostname': name,
        'node-role.kubernetes.io/control-plane': '',
        'gpu': 'on',
        'hami.io/node-handshake': 'Requesting',
      },
    },
    spec: { taints: [] },
    status: {
      conditions: ready
        ? [
            { type: 'Ready', status: 'True', lastHeartbeatTime: ago(1), lastTransitionTime: ago(600) },
            { type: 'MemoryPressure', status: 'False', lastHeartbeatTime: ago(1) },
            { type: 'DiskPressure', status: 'False', lastHeartbeatTime: ago(1) },
            { type: 'PIDPressure', status: 'False', lastHeartbeatTime: ago(1) },
          ]
        : [
            { type: 'Ready', status: 'False', reason, message, lastHeartbeatTime: ago(1), lastTransitionTime: ago(30) },
          ],
      addresses: [
        { type: 'InternalIP', address: ip },
        { type: 'Hostname', address: name },
      ],
      // HAMi device-plugin 汇报的扩展资源：gpumem 单位 MiB，gpucores 是「百分比点」总和
      capacity: {
        cpu: '64', memory: '131981756Ki', pods: '110', 'ephemeral-storage': '1952861234Ki',
        'nvidia.com/gpu': String(cards),
        'nvidia.com/gpumem': String(memMiB),
        'nvidia.com/gpucores': String(cores),
      },
      allocatable: {
        cpu: '64', memory: '131981756Ki', pods: '110', 'ephemeral-storage': '1952861234Ki',
        'nvidia.com/gpu': String(cards),
        'nvidia.com/gpumem': String(memMiB),
        'nvidia.com/gpucores': String(cores),
      },
      nodeInfo: {
        kubeletVersion: 'v1.31.4+k3s1',
        osImage: 'Ubuntu 22.04.4 LTS',
        kernelVersion: '5.15.0-113-generic',
        containerRuntimeVersion: 'containerd://1.7.20-k3s1',
        architecture: 'amd64',
        operatingSystem: 'linux',
      },
      daemonEndpoints: { kubeletEndpoint: { Port: 10250 } },
      ...(products ? { images: products.map((p) => ({ names: [p] })) } : {}),
    },
  };
}

const nodes = {
  apiVersion: 'v1', kind: 'NodeList', metadata: {},
  items: [
    node('gpu-4090-a', { cards: 4, memMiB: 98304, cores: 400, ip: '10.20.30.11', products: ['vllm/vllm-openai:latest'] }),
    node('gpu-t4-b', {
      cards: 2, memMiB: 32768, cores: 200, ip: '10.20.30.12', products: ['python:3.11'],
      ready: false, reason: 'KubeletNotReady', message: 'PLEG is not healthy: pleg was last seen active 6m ago',
    }),
  ],
};

/** 组装一个 Pod；vgpu 为空表示没有 vGPU 分配（未调度或纯 CPU 负载） */
function pod({ ns, name, nodeName, phase = 'Running', vgpu, cores = {}, restarts = 0, oom = false, crash = false, image }) {
  const containers = [{ name: 'main', image: image || 'vllm/vllm-openai:latest' }];
  const containerStatuses = containers.map((c) => ({
    name: c.name,
    image: c.image,
    ready: phase === 'Running' && !crash,
    restartCount: restarts,
    ...(crash
      ? { state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 40s restarting failed container' } },
          ...(oom ? { lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } } : {}) }
      : phase === 'Running'
        ? { state: { running: { startedAt: ago(180) } }, containerID: `containerd://${name}-cid` }
        : { state: { waiting: { reason: 'ContainerCreating' } } }),
  }));
  const annotations = {};
  if (vgpu) {
    annotations['hami.io/vgpu-devices-allocated'] = vgpu;
    annotations['hami.io/vgpu-node-allocated'] = `${nodeName},0,NVIDIA`;
  }
  return {
    metadata: {
      name, namespace: ns, uid: `uid-${ns}-${name}`,
      creationTimestamp: ago(240),
      labels: { app: name.replace(/-\d+$/, ''), 'pod-template-hash': 'cbfbbd684' },
      annotations,
      ownerReferences: [{ kind: 'ReplicaSet', name: `${name.replace(/-\w+$/, '')}-cbfbbd684`, uid: 'uid-rs' }],
    },
    spec: {
      nodeName: nodeName || undefined,
      containers,
      ...(cores.cpu || cores.memory
        ? { containers: [{ ...containers[0], resources: { requests: { ...(cores.cpu ? { cpu: cores.cpu } : {}), ...(cores.memory ? { memory: cores.memory } : {}) } } }] }
        : {}),
    },
    status: {
      phase,
      podIP: phase === 'Running' ? `10.42.0.${Math.floor(Math.random() * 0) + 7}` : undefined,
      hostIP: nodeName === 'gpu-4090-a' ? '10.20.30.11' : nodeName === 'gpu-t4-b' ? '10.20.30.12' : undefined,
      startTime: phase === 'Running' ? ago(180) : undefined,
      containerStatuses,
      conditions: [{ type: 'Ready', status: phase === 'Running' && !crash ? 'True' : 'False' }],
    },
  };
}

const pods = {
  apiVersion: 'v1', kind: 'PodList', metadata: {},
  items: [
    pod({ ns: 'inference', name: 'vllm-qwen27b-0', nodeName: 'gpu-4090-a', vgpu: `${GPU.a0},12288,40` }),
    pod({ ns: 'inference', name: 'sglang-router-6c8f7d9b-2xk4p', nodeName: 'gpu-4090-a', vgpu: `${GPU.a0},4096,10:;${GPU.a1},8192,20` }),
    pod({ ns: 'inference', name: 'embedding-bge-m3-0', nodeName: 'gpu-4090-a', vgpu: `${GPU.a2},8192,20` }),
    // 跨节点：卡在另一台（节点已 NotReady，正好演示「卡在坏节点上」）
    pod({ ns: 'batch', name: 'rerank-t4-0', nodeName: 'gpu-t4-b', vgpu: `${GPU.b0},4096,10`, image: 'python:3.11' }),
    // 没分配到 vGPU：显存不足，Pending
    pod({ ns: 'inference', name: 'vllm-llama70b-0', nodeName: undefined, phase: 'Pending', cores: { memory: '200Gi' } }),
    // CrashLoop + OOM，占用显存但没有注解（模拟「崩了但分配还在」）
    pod({ ns: 'inference', name: 'vllm-canary-0', nodeName: 'gpu-4090-a', vgpu: `${GPU.a3},12288,30`, restarts: 7, crash: true, oom: true }),
    // 纯 CPU 负载（没有 GPU）
    pod({ ns: 'infra', name: 'redis-cache-7d9f-abc12', nodeName: 'gpu-4090-a', image: 'redis:7-alpine' }),
  ],
};

const events = {
  apiVersion: 'v1', kind: 'EventList', metadata: {},
  items: [
    {
      metadata: { name: 'vllm-llama70b-0.17f1', namespace: 'inference' },
      type: 'Warning', reason: 'FailedScheduling', count: 23,
      message: '0/2 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 1 Insufficient nvidia.com/gpumem.',
      involvedObject: { kind: 'Pod', namespace: 'inference', name: 'vllm-llama70b-0' },
      source: { component: 'default-scheduler' },
      firstTimestamp: ago(42), lastTimestamp: ago(2),
    },
    {
      metadata: { name: 'vllm-canary-0.3b2c', namespace: 'inference' },
      type: 'Warning', reason: 'BackOff', count: 18,
      message: 'Back-off restarting failed container main in pod vllm-canary-0_inference',
      involvedObject: { kind: 'Pod', namespace: 'inference', name: 'vllm-canary-0' },
      source: { component: 'kubelet' },
      firstTimestamp: ago(88), lastTimestamp: ago(1),
    },
    {
      metadata: { name: 'gpu-t4-b.9a1', namespace: 'default' },
      type: 'Warning', reason: 'NodeNotReady',
      message: 'Node gpu-t4-b status is now: NodeNotReady',
      involvedObject: { kind: 'Node', name: 'gpu-t4-b' },
      source: { component: 'node-controller' },
      firstTimestamp: ago(30), lastTimestamp: ago(1),
    },
    // Normal 事件：用来验证 overview 只回 Warning
    {
      metadata: { name: 'vllm-qwen27b-0.5d', namespace: 'inference' },
      type: 'Normal', reason: 'Scheduled',
      message: 'Successfully assigned inference/vllm-qwen27b-0 to gpu-4090-a',
      involvedObject: { kind: 'Pod', namespace: 'inference', name: 'vllm-qwen27b-0' },
      lastTimestamp: ago(240),
    },
  ],
};

const workloads = (kind, items) => ({ apiVersion: 'apps/v1', kind: `${kind}List`, metadata: {}, items });
const deployments = workloads('Deployment', [
  { metadata: { name: 'vllm-qwen27b', namespace: 'inference', creationTimestamp: ago(1440) },
    spec: { replicas: 1, selector: { matchLabels: { app: 'vllm-qwen27b' } } },
    status: { replicas: 1, readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 } },
  { metadata: { name: 'sglang-router', namespace: 'inference', creationTimestamp: ago(1440) },
    spec: { replicas: 2, selector: { matchLabels: { app: 'sglang-router' } } },
    status: { replicas: 2, readyReplicas: 1, updatedReplicas: 2, availableReplicas: 1 } },
  { metadata: { name: 'vllm-llama70b', namespace: 'inference', creationTimestamp: ago(60) },
    spec: { replicas: 1, selector: { matchLabels: { app: 'vllm-llama70b' } } },
    status: { replicas: 1, readyReplicas: 0, updatedReplicas: 1, availableReplicas: 0 } },
  { metadata: { name: 'redis-cache', namespace: 'infra', creationTimestamp: ago(9000) },
    spec: { replicas: 1, selector: { matchLabels: { app: 'redis-cache' } } },
    status: { replicas: 1, readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 } },
]);
const statefulsets = workloads('StatefulSet', [
  { metadata: { name: 'embedding-bge-m3', namespace: 'inference', creationTimestamp: ago(2880) },
    spec: { replicas: 1, serviceName: 'embedding-bge-m3' },
    status: { replicas: 1, readyReplicas: 1, currentReplicas: 1, updatedReplicas: 1, availableReplicas: 1 } },
]);
const daemonsets = workloads('DaemonSet', [
  { metadata: { name: 'hami-device-plugin', namespace: 'kube-system', creationTimestamp: ago(43200) },
    status: { desiredNumberScheduled: 2, currentNumberScheduled: 2, numberReady: 1, numberAvailable: 1, updatedNumberScheduled: 2 } },
  { metadata: { name: 'nvidia-device-plugin-daemonset', namespace: 'kube-system', creationTimestamp: ago(43200) },
    status: { desiredNumberScheduled: 2, currentNumberScheduled: 2, numberReady: 1, numberAvailable: 1, updatedNumberScheduled: 2 } },
]);

const routes = {
  '/version': { major: '1', minor: '31', gitVersion: 'v1.31.4+k3s1', platform: 'linux/amd64' },
  '/api/v1/nodes': nodes,
  '/api/v1/pods': pods,
  '/api/v1/events': events,
  '/apis/apps/v1/deployments': deployments,
  '/apis/apps/v1/statefulsets': statefulsets,
  '/apis/apps/v1/daemonsets': daemonsets,
};

const POD_LOGS = [
  '[INFO] 06-08 09:41:07 Starting vLLM server (model=Qwen2.5-27B-Instruct, tp=1)',
  '[INFO] 06-08 09:41:52 GPU KV cache size: 132,480 tokens',
  '[INFO] 06-08 09:42:03 Avg prompt throughput: 812.4 tokens/s, Avg generation throughput: 96.1 tokens/s',
  '[WARN] 06-08 09:46:18 Preemption: recompute 8 sequences (kv cache 96.4% full)',
  '[INFO] 06-08 09:47:41 Avg prompt throughput: 1204.8 tokens/s, Avg generation throughput: 143.7 tokens/s',
];

function kubeconfig() {
  return `apiVersion: v1
kind: Config
clusters:
- name: mock-hami
  cluster:
    server: http://${HOST}:${PORT}
contexts:
- name: mock-hami
  context:
    cluster: mock-hami
    user: mock-hami
current-context: mock-hami
users:
- name: mock-hami
  user:
    token: ${TOKEN}
`;
}

if (flag('--print-kubeconfig')) {
  process.stdout.write(kubeconfig());
  process.exit(0);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (AUTH) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7).trim() !== TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'Unauthorized', code: 401,
        message: 'Unauthorized',
      }));
    }
  }

  // Pod 日志
  const logMatch = url.match(/^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/);
  if (logMatch) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(POD_LOGS.join('\n') + '\n');
  }

  const body = routes[url];
  if (body) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NotFound', code: 404, message: `not found: ${url}` }));
});

server.listen(PORT, HOST, () => {
  const ready = pods.items.filter((p) => p.metadata.annotations['hami.io/vgpu-devices-allocated']);
  const allocatedMiB = ready.reduce((sum, p) => {
    const spec = p.metadata.annotations['hami.io/vgpu-devices-allocated'];
    return sum + spec.split(/[;:]/).filter(Boolean).reduce((s, d) => s + (Number(d.split(',')[1]) || 0), 0);
  }, 0);
  process.stdout.write(`模拟 HAMi 集群已启动：http://${HOST}:${PORT}${AUTH ? '（Bearer ' + TOKEN + '）' : '（未开启鉴权）'}\n`);
  process.stdout.write(`  ${nodes.items.length} 个节点 · 6 张卡 · 131072 MiB 显存 · 600 点算力\n`);
  process.stdout.write(`  ${pods.items.length} 个 Pod（${ready.length} 个带 vGPU 分配，已分配 ${allocatedMiB} MiB）\n`);
  process.stdout.write(`  ${events.items.filter((e) => e.type === 'Warning').length} 条 Warning 事件\n\n`);
  process.stdout.write('把这段 kubeconfig 粘贴到「K8s 集群」页面即可：\n\n');
  process.stdout.write(kubeconfig());
  process.stdout.write('\n');
});
