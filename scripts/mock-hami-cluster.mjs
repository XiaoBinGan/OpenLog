#!/usr/bin/env node
/**
 * 模拟 HAMi 集群 —— 一个假的 kube-apiserver，专门用来验证/演示 vGPU 分配视图。
 *
 * 为什么需要它：
 *   真要看 HAMi 数据得有一台装了 HAMi device-plugin 的 GPU 节点。没有机器的时候，
 *   无论是开发 UI、给客户演示、还是回归测试，都会因为「没有 GPU 集群」卡住。
 *   这个脚本用纯 node 起一个 HTTP 服务，按 K8s API 的形状返回数据。
 *   OpenLog 用普通 kubeconfig 连上来，走的是真 HTTP、真 JSON、真归一化链路，
 *   和连真集群没有区别（唯一区别是数据是这里写死的）。
 *
 * 数据形状严格照 **243 真机**（见 /tmp/hami-real-format.md），不是凭记忆编的：
 *   · 节点注解 `hami.io/node-nvidia-register` = JSON 数组，每项一张**物理卡**：
 *     `{id,index,count,devmem,devcore,type,numa,mode,health}`，
 *     `count` = 这张卡切成的 vGPU 槽位数，`devmem` = 该卡显存 MiB，`type` = 型号；
 *   · 节点 capacity `nvidia.com/gpu` = Σcount（本例 20），
 *     **没有** `nvidia.com/gpumem` / `nvidia.com/gpucores`（真机就是没有，容量只能靠 register）；
 *   · Pod 注解 `hami.io/vgpu-devices-allocated` 是**四段**：
 *     `GPU-<uuid>,NVIDIA,<memMiB>,<cores>:;`，多卡用 `:;` 拼接；
 *   · Pod 注解 `hami.io/vgpu-node` = 节点名（243 上只有这个，没有 vgpu-node-allocated）。
 *   分配量与容量自洽：每张卡上所有 Pod 的显存之和 ≤ 该卡 devmem。
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

/**
 * 设备 UUID（固定值，保证多次请求一致）。
 * 前两个直接取自 243 的实测 payload，方便和真机日志对照。
 */
const GPU = {
  a5090: 'GPU-6b12533d-bcfb-25b6-bafe-5a8d5bd85d07',
  a4090: 'GPU-86d14e75-1e54-3aed-e483-6652a4c30653',
  t4: 'GPU-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
};

/**
 * 物理卡清单（= 节点 `hami.io/node-nvidia-register` 的内容）。
 * 字段名与真机一字不差：`count` 是槽位数、`devmem` 是显存 MiB、`devcore` 是算力点。
 */
const CARDS = {
  // 243：RTX 5090 32607 MiB + RTX 4090 49140 MiB，两张卡各切 10 份
  gpu4090a: [
    {
      id: GPU.a5090, index: 1, count: 10, devmem: 32607, devcore: 100,
      type: 'NVIDIA GeForce RTX 5090', numa: 1, mode: 'hami-core', health: true,
    },
    {
      id: GPU.a4090, count: 10, devmem: 49140, devcore: 100,
      type: 'NVIDIA GeForce RTX 4090', mode: 'hami-core', health: true,
    },
  ],
  // 第二台（NotReady）：单张 T4，4 槽位 —— 用来验证「Pod 卡在坏节点上」的展示
  gput4b: [
    {
      id: GPU.t4, index: 0, count: 4, devmem: 15360, devcore: 100,
      type: 'Tesla T4', numa: 0, mode: 'hami-core', health: true,
    },
  ],
};

/** 槽位合计 = capacity 里的 `nvidia.com/gpu`（真机的算法）。 */
const slotsOf = (cards) => cards.reduce((sum, card) => sum + card.count, 0);

function node(name, { cards, ip, products, ready = true, reason, message }) {
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
      annotations: {
        // 真机形态：JSON 字符串数组，一张物理卡一项（容量/型号/槽位的唯一来源）
        'hami.io/node-nvidia-register': JSON.stringify(cards),
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
      // 真机只报 nvidia.com/gpu（= Σcount 槽位）；gpumem / gpucores **不存在**
      capacity: {
        cpu: '64', memory: '131981756Ki', pods: '110', 'ephemeral-storage': '1952861234Ki',
        'nvidia.com/gpu': String(slotsOf(cards)),
      },
      allocatable: {
        cpu: '64', memory: '131981756Ki', pods: '110', 'ephemeral-storage': '1952861234Ki',
        'nvidia.com/gpu': String(slotsOf(cards)),
      },
      nodeInfo: {
        kubeletVersion: 'v1.33.13+k3s1',
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
    node('gpu-4090-a', { cards: CARDS.gpu4090a, ip: '10.20.30.11', products: ['vllm/vllm-openai:latest'] }),
    node('gpu-t4-b', {
      cards: CARDS.gput4b, ip: '10.20.30.12', products: ['python:3.11'],
      ready: false, reason: 'KubeletNotReady', message: 'PLEG is not healthy: pleg was last seen active 6m ago',
    }),
  ],
};

/**
 * 真机四段注解：`GPU-<uuid>,NVIDIA,<memMiB>,<cores>`，多卡用 `:;` 拼接、末尾带 `:;`。
 * @param {Array<{id:string, memMiB:number, cores:number}>} allocs 该 Pod 占的每段分配
 */
function devicesAnnotation(allocs) {
  return `${allocs.map((a) => `${a.id},NVIDIA,${a.memMiB},${a.cores}`).join(':;')}:;`;
}

/** 组装一个 Pod；vhgpu（alloc 数组）为空表示没有 vGPU 分配（未调度或纯 CPU 负载） */
function pod({ ns, name, nodeName, phase = 'Running', alloc, cores = {}, restarts = 0, oom = false, crash = false, image }) {
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
  if (alloc && alloc.length > 0) {
    annotations['hami.io/vgpu-devices-allocated'] = devicesAnnotation(alloc);
    // 真机（243）只有这个注解；vgpu-node-allocated 是新版 HAMi 才写的，mock 不伪造它
    annotations['hami.io/vgpu-node'] = nodeName;
    annotations['hami.io/bind-phase'] = 'success';
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

/**
 * 分配自洽表（sum ≤ 各卡 devmem）：
 *   5090（32607）：24576 + 4096 = 28672
 *   4090（49140）：8192 + 8192 + 12288 = 28672
 *   T4  （15360）：4096
 */
const pods = {
  apiVersion: 'v1', kind: 'PodList', metadata: {},
  items: [
    pod({ ns: 'inference', name: 'vllm-qwen27b-0', nodeName: 'gpu-4090-a',
      alloc: [{ id: GPU.a5090, memMiB: 24576, cores: 50 }] }),
    // 跨两张卡：验证 `:;` 多段拼接（旧的三段格式这里会解析错）
    pod({ ns: 'inference', name: 'sglang-router-6c8f7d9b-2xk4p', nodeName: 'gpu-4090-a',
      alloc: [{ id: GPU.a5090, memMiB: 4096, cores: 10 }, { id: GPU.a4090, memMiB: 8192, cores: 20 }] }),
    pod({ ns: 'inference', name: 'embedding-bge-m3-0', nodeName: 'gpu-4090-a',
      alloc: [{ id: GPU.a4090, memMiB: 8192, cores: 20 }] }),
    // 跨节点：卡在另一台（节点已 NotReady，正好演示「卡在坏节点上」）
    pod({ ns: 'batch', name: 'rerank-t4-0', nodeName: 'gpu-t4-b',
      alloc: [{ id: GPU.t4, memMiB: 4096, cores: 25 }], image: 'python:3.11' }),
    // 没分配到 vGPU：显存不足，Pending
    pod({ ns: 'inference', name: 'vllm-llama70b-0', nodeName: undefined, phase: 'Pending', cores: { memory: '200Gi' } }),
    // CrashLoop + OOM，占用显存（分配还在，注解也还在 —— 这是排查时最想看到的那一行）
    pod({ ns: 'inference', name: 'vllm-canary-0', nodeName: 'gpu-4090-a',
      alloc: [{ id: GPU.a4090, memMiB: 12288, cores: 30 }], restarts: 7, crash: true, oom: true }),
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
      message: '0/2 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 1 Insufficient nvidia.com/gpu.',
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
  '/version': { major: '1', minor: '33', gitVersion: 'v1.33.13+k3s1', platform: 'linux/amd64' },
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

/** 四段注解 → 每段分配（`uuid,NVIDIA,mem,cores`），给启动摘要用。 */
function parseAlloc(annotation) {
  return annotation
    .split(/[;:]/)
    .filter(Boolean)
    .map((segment) => segment.split(','))
    // 四段才是真机格式；三段/两段是旧版本，这里只为摘要统计，按位取即可
    .map((parts) => ({ id: parts[0], memMiB: Number(parts[2]) || 0, cores: Number(parts[3]) || 0 }));
}

server.listen(PORT, HOST, () => {
  const cards = nodes.items.flatMap((n) => JSON.parse(n.metadata.annotations['hami.io/node-nvidia-register']));
  const physical = cards.length;
  const slots = cards.reduce((sum, card) => sum + card.count, 0);
  const vram = cards.reduce((sum, card) => sum + card.devmem, 0);
  const gpuPods = pods.items.filter((p) => p.metadata.annotations['hami.io/vgpu-devices-allocated']);
  const allocatedMiB = gpuPods.reduce((sum, p) => {
    const allocs = parseAlloc(p.metadata.annotations['hami.io/vgpu-devices-allocated']);
    return sum + allocs.reduce((s, a) => s + a.memMiB, 0);
  }, 0);
  process.stdout.write(`模拟 HAMi 集群已启动：http://${HOST}:${PORT}${AUTH ? '（Bearer ' + TOKEN + '）' : '（未开启鉴权）'}\n`);
  process.stdout.write(`  ${nodes.items.length} 个节点 · ${physical} 张物理卡 · ${slots} 个 vGPU 槽位 · ${vram} MiB 显存\n`);
  process.stdout.write(`  卡型：${[...new Set(cards.map((card) => card.type))].join(' / ')}\n`);
  process.stdout.write(`  ${pods.items.length} 个 Pod（${gpuPods.length} 个带 vGPU 分配，已分配 ${allocatedMiB} MiB）\n`);
  process.stdout.write(`  ${events.items.filter((e) => e.type === 'Warning').length} 条 Warning 事件\n\n`);
  process.stdout.write('把这段 kubeconfig 粘贴到「K8s 集群」页面即可：\n\n');
  process.stdout.write(kubeconfig());
  process.stdout.write('\n');
});
