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
