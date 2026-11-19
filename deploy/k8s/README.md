# OpenLog 只读 Kubernetes 监控 —— 部署与排错

本目录提供 OpenLog 接入 Kubernetes 集群所需的**最小权限**资产：

| 文件 | 作用 |
|---|---|
| `rbac.yaml` | 命名空间 `openlog`、只读 ServiceAccount `openlog-readonly`、只读 ClusterRole / ClusterRoleBinding，以及一个 `kubernetes.io/service-account-token` 类型的长期 token Secret（`openlog-readonly-token`） |
| `make-kubeconfig.sh` | 从已部署的 ServiceAccount 生成 OpenLog 可用的 kubeconfig，输出到 stdout |
| `README.md` | 本文件：权限说明、部署步骤、403 排错、token 轮换 |

OpenLog 采用 **kubeconfig 直连 kube-apiserver**：不需要在节点上安装 agent，也不需要在 OpenLog
所在机器安装 kubectl（kubectl 仅用于生成 kubeconfig 这一次）。

---

## 一、RBAC 给什么 / 不给什么

### 1.1 给了什么（`verbs` 一律只有 `get`、`list`、`watch`）

| API 组 | 资源 | verbs |
|---|---|---|
| `""`（core） | `nodes`、`nodes/status` | get / list / watch |
| `""`（core） | `pods`、`pods/status`、`pods/log` | get / list / watch |
| `""`（core） | `namespaces`、`services`、`endpoints`、`events` | get / list / watch |
| `apps` | `deployments`、`statefulsets`、`daemonsets`、`replicasets` | get / list / watch |
| `batch` | `jobs`、`cronjobs` | get / list / watch |
| `metrics.k8s.io` | `nodes`、`pods` | get / list / watch |

对应 OpenLog 的功能：

- 节点列表 / 就绪状态 / 容量（capacity）→ `nodes`、`nodes/status`
- Pod 列表、重启次数、OOMKilled / CrashLoopBackOff 判定 → `pods`
- Pod 日志查看（`/api/k8s/clusters/:id/pods/:ns/:pod/logs`）→ `pods/log`
- 工作负载 desired / ready / available → `apps` 三个资源
- 事件面板 → `events`
- CPU / 内存实时用量（若扩展）→ `metrics.k8s.io`

> `pods/status`、`nodes/status` 在 apiserver 上实际只支持 `get`，写进规则里的 `list` / `watch`
> 是幂等式冗余，不会放大权限，保留是为了让排错时的报错与规则一一对应。

### 1.2 明确不给什么

- **不给 `secrets`**：`pods/log` 之外任何可能读到密钥材料的资源都没给，OpenLog 拿不到 Secret / ConfigMap。
- **不给任何写操作**：没有 `create`、`update`、`patch`、`delete`、`deletecollection`、`escalate`、`bind`、`impersonate`。
- **不给 `pods/exec`、`pods/attach`、`pods/portforward`**：无法进入容器。
- **不给 `persistentvolumeclaims`、`storageclasses`、`ingresses`、CRD 自定义资源** 等：当前 UI 用不到。
- **不给 `namespaces` 之外的 RBAC 资源**：无法自我提权（无 `rolebindings`、`clusterroles` 写权限）。
- ServiceAccount 设了 `automountServiceAccountToken: false`：即使有人在该 SA 下起 Pod，也不会自动挂载 token。

> 若后续需要 Ingress / PVC 面板，**追加**一条新的 `apiGroups` + `resources` 规则即可，
> 仍然只加 `get`/`list`/`watch`，不要放宽动词。

---

## 二、部署步骤

### 2.0 前置条件

- 一个可用的 kubeconfig（管理员或具备 `create clusterrole/clusterrolebinding/serviceaccount/secret` 的账号）。
- 目标集群能确认 apiserver 地址：`kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'`。

### 2.1 标准 Kubernetes（v1.24 及以上）

```bash
# 1) 应用 RBAC + SA + token Secret
kubectl apply -f deploy/k8s/rbac.yaml

# 2) 确认对象就绪
kubectl -n openlog get sa openlog-readonly
kubectl -n openlog get secret openlog-readonly-token

# 3) 等 token 被 kube-controller-manager 填充（k8s >= 1.24 不再自动签发，Secret 需要控制器异步填充）
kubectl -n openlog get secret openlog-readonly-token \
  -o jsonpath='{.data.token}' | head -c 24; echo
# 输出为空 = 还没填充，等 5~10 秒再试；直到打印出一串 base64

# 4) 生成 kubeconfig（注意 --server 用集群内可达地址）
bash deploy/k8s/make-kubeconfig.sh \
  --server https://127.0.0.1:6443 \
  --namespace openlog \
  --sa openlog-readonly \
  --secret openlog-readonly-token > /tmp/openlog-kubeconfig.yaml
chmod 600 /tmp/openlog-kubeconfig.yaml

# 5) 自检（用只读凭据访问一次 apiserver）
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml get --raw /version
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml get nodes
```

随后打开 OpenLog →「K8s 集群」页 → 新增集群 → 粘贴 kubeconfig 全文（含 `current-context`）→ 测试连通。
测试成功后立刻 `rm -f /tmp/openlog-kubeconfig.yaml`（OpenLog 内部已存储，不需要本地副本）。

### 2.2 k3s（v1.33）

k3s 与标准 k8s 的差异只在「用哪个 kubectl」和「apiserver 地址」：

```bash
# k3s 自带 kubectl：/usr/local/bin/kubectl，或 k3s kubectl
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml   # 需要 sudo 读；不要在普通用户下长期保留

sudo kubectl apply -f deploy/k8s/rbac.yaml     # 或 sudo k3s kubectl apply -f ...

# 等 token 填充（k3s 的 kube-controller-manager 在 k3s server 进程内，通常 1~10 秒）
sudo kubectl -n openlog get secret openlog-readonly-token -o jsonpath='{.data.token}'; echo

# 生成 kubeconfig：server 用「OpenLog 所在机器能访问到的地址」
sudo bash deploy/k8s/make-kubeconfig.sh \
  --server https://127.0.0.1:6443 \
  --namespace openlog > /tmp/openlog-kubeconfig.yaml
```

k3s 要点：

1. **apiserver 地址不是 `127.0.0.1:6443` 的情况**：k3s 默认把 apiserver 暴露在节点 IP 的 6443
   端口，`/etc/rancher/k3s/k3s.yaml` 里写的是 `127.0.0.1`。若 OpenLog 跑在另一台机器上，
   `--server` 要改成 `https://<节点IP或域名>:6443`，否则 OpenLog 连不上（表现为
   `ECONNREFUSED` / `ETIMEDOUT`，而不是 403）。
2. **证书 SAN**：k3s 的 apiserver 证书默认包含节点 IP 与 `kubernetes.default.svc` 等 SAN，
   用节点 IP 访问通常 OK；用自建域名访问需要在 k3s 启动参数里追加
   `--tls-san=<域名>`，否则 TLS 校验失败（OpenLog 报证书不匹配）。
3. **`metrics.k8s.io`**：k3s 默认内置 metrics-server，`kubectl top nodes` 可用即说明规则有效；
   若集群未装 metrics-server，对该组的 `kubectl auth can-i` 会因 API 组不存在而报错，属正常。
4. **网络策略 / 防火墙**：打开 6443 给 OpenLog 所在主机；若 OpenLog 与集群跨网，优先走
   内网地址，不要用公网暴露 apiserver。

### 2.3 Docker / 容器化部署的 OpenLog

容器内没有 kubectl，也不需要：把上一步生成的 kubeconfig 文本直接粘贴到 OpenLog 的
「K8s 集群」设置里（保存在 OpenLog 自己的 settings 中，读取时默认打码）。

---

## 三、403 排错对照表

OpenLog 报「权限不足」时会带上 `forbidden` 与所需 verb/resource。按下表补齐对应规则
（仍然只加 `get`/`list`/`watch`）：

| 现象 / 报错关键字 | 缺失的 verb × resource | 需要加的规则（示例） |
|---|---|---|
| 集群测试失败，`nodes is forbidden` | `list` × `nodes` | `apiGroups: [""]` / `resources: ["nodes"]` / `verbs: ["get","list","watch"]` |
| 节点页空白或 403，`nodes/status` | `get` × `nodes/status` | 同上，追加 `nodes/status` |
| Pod 列表 403，`pods is forbidden` | `list` × `pods` | `resources: ["pods"]` |
| Pod 详情 403，涉及 `pods/status` | `get` × `pods/status` | `resources: ["pods/status"]` |
| 看日志 403，`pods/log is forbidden` | `get` × `pods/log` | `resources: ["pods/log"]`（**注意**：`get pods` 不会自动包含 log 子资源） |
| 工作负载 403，`deployments.apps` | `list` × `deployments`（apps 组） | `apiGroups: ["apps"]` / `resources: ["deployments"]` |
| `statefulsets` / `daemonsets` / `replicasets` 403 | `list` × 对应资源 | 追加到同一 `apiGroups: ["apps"]` 规则 |
| 事件面板空/403，`events is forbidden` | `list` × `events` | `resources: ["events"]` |
| 命名空间下拉框为空，`namespaces is forbidden` | `list` × `namespaces` | `resources: ["namespaces"]` |
| Service / Endpoint 相关 403 | `list` × `services` / `endpoints` | 追加 `resources: ["services","endpoints"]` |
| `jobs.batch` / `cronjobs.batch` 403 | `list` × `jobs` / `cronjobs` | `apiGroups: ["batch"]` |
| 用量指标 403，`metrics.k8s.io` | `list` × `nodes`/`pods`（metrics 组） | `apiGroups: ["metrics.k8s.io"]` |
| 报 `the server could not find the requested resource`（不是 403） | API 组不存在 | 集群没装 metrics-server，不是权限问题 |
| 报 `Unauthorized`（401）而不是 403 | token 无效/过期 | 重新 `make-kubeconfig.sh`，见第四节轮换 |

快速定位命令（用只读凭据执行，最省事）：

```bash
# 总体检索：列出当前 SA 能做什么
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml auth can-i --list

# 逐项验证
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml auth can-i list pods -A
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml auth can-i get pods/log -A
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml auth can-i list nodes
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml auth can-i list deployments.apps -A
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml auth can-i list events -A

# 反向确认「不该有」的权限（应全部为 no）
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml auth can-i get secrets -A
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml auth can-i delete pods -A
kubectl --kubeconfig /tmp/openlog-kubeconfig.yaml auth can-i create pods/exec -n openlog
```

若 `auth can-i --list` 显示完全没有任何 `openlog-readonly` 规则，说明 **ClusterRoleBinding 没生效**
（名字写错、或在 `kubectl apply` 之前 SA 还没建好，可先删后重建）：

```bash
kubectl get clusterrolebinding openlog-readonly -o yaml
kubectl auth whoami   # 用只读凭据执行，确认身份是 system:serviceaccount:openlog:openlog-readonly
```

---

## 四、token 轮换

长期 token Secret 一旦泄露（例如 kubeconfig 被误提交），立即轮换。轮换**不需要改 RBAC**，
因为 SA 与 ClusterRoleBinding 保持不变，只换 Secret 里的 token。

### 方式 A：删旧 Secret，原地重建（推荐，Secret 名不变）

```bash
# 1) 删除旧 token Secret（OpenLog 里现存的 kubeconfig 立即失效，先接受短暂中断）
kubectl -n openlog delete secret openlog-readonly-token

# 2) 重新应用，控制器会为新 Secret 签发新 token（同名前缀，名字不变）
kubectl apply -f deploy/k8s/rbac.yaml

# 3) 等 token 填充
kubectl -n openlog get secret openlog-readonly-token -o jsonpath='{.data.token}'; echo

# 4) 重新生成 kubeconfig，粘贴回 OpenLog「K8s 集群」页并测试
bash deploy/k8s/make-kubeconfig.sh --server https://127.0.0.1:6443 > /tmp/new-kubeconfig.yaml
```

> 注意：**先删后建**会让旧 token 立刻失效。若不能接受中断，先按方式 B 建新名字的 Secret、
> 新 kubeconfig 验证通过后再删旧的。

### 方式 B：新建一个不同名字的 Secret 并行切换

```bash
# 1) 复制 Secret 定义，把 name 改成 openlog-readonly-token-v2 后 apply
sed 's/openlog-readonly-token$/openlog-readonly-token-v2/' deploy/k8s/rbac.yaml |
  kubectl apply -f - --dry-run=client -o yaml > /tmp/rotate.yaml   # 只取 Secret 段亦可
kubectl apply -f /tmp/rotate.yaml

# 2) 用新 Secret 生成 kubeconfig 并验证
bash deploy/k8s/make-kubeconfig.sh --server https://127.0.0.1:6443 \
  --secret openlog-readonly-token-v2 > /tmp/new-kubeconfig.yaml
kubectl --kubeconfig /tmp/new-kubeconfig.yaml get --raw /version

# 3) OpenLog 里替换 kubeconfig，测试通过后删除旧 Secret
kubectl -n openlog delete secret openlog-readonly-token
```

### 轮换周期建议

- 常规：每 90 天一次，与人员变动、事故复盘同步执行。
- 一旦 kubeconfig 出现在 git / 日志 / 聊天记录中：立即执行，不等到周期。
- OpenLog 侧删除集群配置不会吊销 token，**轮换必须在集群侧做**（删 Secret）。

---

## 五、安全清单

- [ ] `openlog-readonly-token` 的明文 token 从未出现在仓库、CI 日志、聊天记录中。
- [ ] 生成的 kubeconfig 临时文件权限 `600`，用后删除。
- [ ] 确认 `kubectl auth can-i get secrets -A` 返回 `no`。
- [ ] 确认 `kubectl auth can-i delete pods -A` 返回 `no`。
- [ ] OpenLog 只在内网可达 apiserver；6443 不对公网开放。
- [ ] 已记录轮换周期与负责人。
