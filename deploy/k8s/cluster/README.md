# 集群编排清单（两节点 k3s + HAMi）

来源：243（node1，RTX 4090 + 5090）与 154.225（node2，2× Tesla T4）实测跑通的配置。

| 文件 | 内容 |
|---|---|
| `10-hami-workloads.yaml` | namespace `inference` + StatefulSet `msrk`（6 个 reranker，HAMi 显存/算力配额）+ `strata` / `llama-cpp`（node2，各占一张 T4） |
| `15-reranker-pods.yaml` | 6 个 reranker 的裸 Pod 版本（需要固定 hostPort 时用；与 10 里的 StatefulSet 二选一） |
| `20-node1-services.yaml` | 从 docker 迁入的 5 个服务：adapter-ops / yolo-curtain / curtain-detect / openlog-site / ms-reranker7 |
| `30-node1-gateway.yaml` | hostNetwork + nginx stream 网关，把 18100-18105、38000/8000/8012/8007/3003 转到各 Service |

## 关键约定

- 所有 GPU 工作负载都声明了 `nvidia.com/gpumem` **和** `nvidia.com/gpucores`
  （只写 gpumem 等于"限显存不限算力"，同卡邻居会被互相拖慢）
- 节点必须打 `gpu=on` 标签，HAMi device-plugin 的 DaemonSet 靠它选节点
- 用 `nodeSelector: kubernetes.io/hostname` 把服务钉在有 hostPath 数据的节点上
- 端口统一走网关，不用 hostPort —— 实测这台机器上 CNI portmap 的 DNAT 规则会被清掉

## 已知约束

- node2 是 Ubuntu 18.04（cgroup v1），k8s 1.31+ 的 kubelet 拒绝启动，
  因此 node2 的 k3s agent 固定在 **v1.30.6**（与 server v1.33 存在 minor skew），
  并需要给 `system:node:node2` 补一条只读 nodes 的 ClusterRole。
  长期方案：升级到 Ubuntu 20.04+（cgroup v2），两台跑同版本。

## 应用顺序

```bash
kubectl label node <gpu-node> gpu=on --overwrite
kubectl apply -f 10-hami-workloads.yaml
kubectl apply -f 20-node1-services.yaml
kubectl apply -f 30-node1-gateway.yaml
```

## 实测结论（2026-11-23，243 + 154.225）

### HAMi 能力验证

| 验证项 | 结果 | 证据 |
|---|---|---|
| 显存隔离 | ✅ | 配额 4096 MiB 的容器内 `nvidia-smi` 显示 `memory.total=4096`，真实卡 32607 MiB |
| 显存超卖拦截 | ✅ | 申请 32 GiB（两卡剩余不足）→ Pending，事件 `CardInsufficientMemory` |
| 同卡多租户 | ✅ | 3 个 reranker 共卡，各锁 5888 MiB，互不越界 |
| 故障隔离 | ✅ | 配额 4 GiB 的进程申请 12 GiB → `HAMI-core OOM 13289652224 / 4294967296`，容器被杀，**同卡邻居仍 Running** |
| 算力准入 | ✅ | 算力配额占满时新 Pod → Pending，事件 `CardInsufficientCore` |
| 算力限流（运行态） | ⚠️ 弱 | 3000×4096² matmul：配额 10 点 12.95 s vs 不限 10.26 s，仅慢 26%，**远小于名义 10 倍** |

### 关于算力限流的那条 ⚠️

`nvidia.com/gpucores` 在**调度准入**上是硬约束（占满就排不上），但运行时限流在
RTX 4090/5090 上对"单个长 kernel"负载效果不明显（HAMi-core 用时间片注入，
大 matmul 的 kernel 粒度太粗）。若需要硬性算力隔离，建议：
- 用更小的 `gpucores`（如 5）+ 多租户并发压力下观察
- 或改用 MPS / time-slicing 方案
- 或接受「gpucores 主要作为调度配额，而非运行时限速」这一现实

### 版本 skew

node2 是 Ubuntu 18.04（cgroup v1），k8s 1.31+ 的 kubelet 拒绝启动 → node2 固定在
k3s **v1.30.6**，并给 `system:node:node2` 补了只读 nodes 的 ClusterRole
（1.33 收紧了节点自读权限，1.30 的 flannel 需要 `list nodes`）。

长期方案：升级到 Ubuntu 20.04+（cgroup v2），两台跑同版本 k3s，可移除该 ClusterRole。
