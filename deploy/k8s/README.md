# OpenLog 只读 Kubernetes 监控 —— 部署与排错

本目录提供 OpenLog 接入 Kubernetes 集群所需的**最小权限**资产：

| 文件 | 作用 |
|---|---|
| `rbac.yaml` | **前半段（默认安装）**：命名空间 `openlog`、只读 ServiceAccount `openlog-readonly`、只读 ClusterRole / ClusterRoleBinding，以及一个 `kubernetes.io/service-account-token` 类型的长期 token Secret（`openlog-readonly-token`）。**后半段（可选）**：可写 ServiceAccount `openlog-operator` + ClusterRole / 两个 Binding + token Secret `openlog-operator-token`，仅当需要扩缩容 / 重启 / 删 Pod 时才安装 |
| `make-kubeconfig.sh` | 从已部署的 ServiceAccount 生成 OpenLog 可用的 kubeconfig，输出到 stdout |
| `README.md` | 本文件：权限说明（只读 vs 可写）、部署步骤、403 排错、token 轮换 |

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

> 需要写能力（扩缩容 / 重启 / 删 Pod）时，不要放宽本节这个只读 ClusterRole，
> 而是另外安装下一节的 `openlog-operator`；下面的底线（secrets、`pods/exec`、节点写、RBAC 写）
> 在可写角色里同样一条都不放开。

---

## 二、只读 vs 可写（两个 ServiceAccount）

`rbac.yaml` 里有两套互不影响的凭据，**装哪套，集群里就只有哪套权限**：

- `openlog-readonly`（默认装）：只能看。任何写动作都会被 apiserver 直接拒绝。
- `openlog-operator`（**可选**，仅当需要扩缩容 / 重启工作负载 / 删 Pod 时才装）：只读能看的它都能看，
  另外只多出三个写动作 —— 改 `deployments` / `statefulsets` 的副本数、触发滚动重启、按名删单个 Pod。

### 2.1 两个 SA 的权限差异

| 能力 | `openlog-readonly`（默认） | `openlog-operator`（可选） |
|---|---|---|
| token Secret | `openlog-readonly-token` | `openlog-operator-token` |
| 绑定的 ClusterRole | `openlog-readonly` | `openlog-operator`（写）**+** `openlog-readonly`（读，复用同一角色，不复制规则） |
| `nodes`、`nodes/status` 读 | ✅ | ✅ |
| `pods`、`pods/status`、`pods/log` 读 | ✅ | ✅ |
| `namespaces`、`services`、`endpoints`、`events` 读 | ✅ | ✅ |
| `apps` 组 `deployments`/`statefulsets`/`daemonsets`/`replicasets` 读 | ✅ | ✅ |
| `batch` 组 `jobs`/`cronjobs`、`metrics.k8s.io` 读 | ✅ | ✅ |
| `deployments`/`statefulsets` 的 `patch`、`update` | ❌ | ✅ |
| `deployments/scale`、`statefulsets/scale` 的 `get`、`patch`、`update` | ❌ | ✅ |
| `pods` 的 `delete`（按名删单个 Pod） | ❌ | ✅ |
| `pods` 的 `deletecollection`（批量删） | ❌ | ❌ |
| `pods/exec`、`pods/attach`、`pods/portforward` | ❌ | ❌ |
| `secrets`、`configmaps` | ❌ | ❌ |
| `nodes` 写（cordon / drain / 改标签） | ❌ | ❌ |
| RBAC 写（`roles`/`rolebindings`/`clusterroles`/`clusterrolebindings`） | ❌ | ❌ |
| `namespaces`/`services`/`ingresses`/CRD 写 | ❌ | ❌ |

记法：**operator = 只读的全部 + 三个写动作**。三个写动作一一对应 OpenLog 的三个写端点：

| OpenLog 动作 | 端点 | 需要的 verb × resource |
|---|---|---|
| 扩缩容 | `POST /api/k8s/clusters/:id/workloads/:ns/:kind/:name/scale` | `patch`/`update` × `deployments`/`statefulsets`；`get`/`patch`/`update` × `.../scale` |
| 滚动重启 | `POST /api/k8s/clusters/:id/workloads/:ns/:kind/:name/restart` | `patch` × `deployments`/`statefulsets`（给 Pod 模板打 `kubectl.kubernetes.io/restartedAt` 注解，控制器滚动重建） |
| 删 Pod | `DELETE /api/k8s/clusters/:id/pods/:ns/:name` | `delete` × `pods` |

> `/scale` 是独立子资源，`deployments` 本体的 verbs **不会**覆盖它，所以规则里单独列了一条。

### 2.2 怎么切换（只读 ⇄ 可写）

**默认状态（只读）**：kubeconfig 用 `openlog-readonly` 那份，页面上不会出现写按钮，
手工打写接口会得到 `403`。

> 说明：`kubectl apply -f deploy/k8s/rbac.yaml` 会把文件里两段对象一起装上，也就是集群里会**存在**
> `openlog-operator` 这个 SA 和它的 token Secret —— 但只要 OpenLog 用的还是只读 kubeconfig、
> `OPENLOG_K8S_WRITE` 也没开，它就是一串没人使用的凭据。若连这串凭据都不想留在集群里，
> 用下面「只想装只读」的截断方式安装。

**打开可写（三步，缺一步都不生效）**：

```bash
# 1) 安装 operator 段（同一份文件里，apply 整份即可）
kubectl apply -f deploy/k8s/rbac.yaml

# 2) 等 token 填充后，用 operator 的 SA + Secret 生成 kubeconfig
kubectl -n openlog get secret openlog-operator-token -o jsonpath='{.data.token}' | head -c 24; echo
bash deploy/k8s/make-kubeconfig.sh --server https://127.0.0.1:6443 \
  --sa openlog-operator --secret openlog-operator-token > /tmp/openlog-operator-kubeconfig.yaml
chmod 600 /tmp/openlog-operator-kubeconfig.yaml
kubectl --kubeconfig /tmp/openlog-operator-kubeconfig.yaml auth can-i --list   # 自检

# 3) 在 OpenLog 侧：把该集群的 kubeconfig 换成上面这份，并设服务端环境变量
#    deploy/deploy.env 里追加（deploy.sh 只透传白名单变量，必须走 EXTRA_ENV）：
#      EXTRA_ENV="OPENLOG_K8S_WRITE=1"
#    然后重新部署使容器重建：bash deploy/deploy.sh
```

**只想装只读、连 operator 的 SA 都不想留在集群里**：

```bash
# 按「以下为可选」分隔线截断，只 apply 前半段
awk '/^# ===== 以下为可选/{exit} {print}' deploy/k8s/rbac.yaml | kubectl apply -f -
```

**关闭可写（回退）**：把 kubeconfig 换回只读那份 → 去掉 `EXTRA_ENV` 里的 `OPENLOG_K8S_WRITE=1`
→ 重新部署 → 再把集群侧的 operator 凭据删掉（顺序别反，否则 OpenLog 会先撞 403）：

```bash
kubectl delete clusterrolebinding openlog-operator openlog-operator-readonly
kubectl delete clusterrole openlog-operator
kubectl delete sa openlog-operator -n openlog
kubectl delete secret openlog-operator-token -n openlog
```

> 删掉 operator 不会影响只读：`ClusterRole openlog-readonly`、它的 Binding、SA 与 token Secret 都没动过。

### 2.3 `OPENLOG_K8S_WRITE=1` 到底管什么

- 它是**应用层的闸门**，不是权限来源。权限永远来自集群侧 RBAC；开关只决定 OpenLog 愿不愿意发出写请求。
- 未设 / `0` / 空（默认）：写端点在 OpenLog 进程里就被拦下，返回
  `403 { "error": "写操作未启用（OPENLOG_K8S_WRITE=1 后生效）", "readOnly": true }`，
  **请求根本不会到达 apiserver**。
- 设为 `1`：写端点放行。此时能不能成还要看 kubeconfig 对应的 SA 有没有那个 verb ——
  用只读 kubeconfig 仍然会被 apiserver 回 `forbidden`（这是集群侧拒绝，与应用层 403 不是一回事，
  错误里会带 `deployments.apps is forbidden` 之类的字样）。
- 只影响写端点（scale / restart / delete pod）；读端点行为完全不变。
- 演示模式 `OPENLOG_DEMO=1` 下写操作返回 `409`，与这个开关无关，也不会去连真集群。
- 该变量在进程启动时读取一次，改了必须重启 OpenLog 容器（重新部署）才生效。

一句话：**`kubeconfig=operator` + `OPENLOG_K8S_WRITE=1`**，两者都到位才真正能写。

### 2.4 最小权限建议

1. 只需要排障写能力的集群才装 operator；其余集群保持只读 kubeconfig，别图省事全量铺开。
2. **优先收窄到命名空间**：生产上把可写 ClusterRole 换成只在业务命名空间生效的 Role。

   ```bash
   NS=<业务命名空间>
   kubectl -n "$NS" create role openlog-operator \
     --verb=get,list,watch,patch,update --resource=deployments,statefulsets
   kubectl -n "$NS" create role openlog-operator-scale \
     --verb=get,patch,update --resource=deployments/scale,statefulsets/scale
   kubectl -n "$NS" create role openlog-operator-pods \
     --verb=get,list,watch,delete --resource=pods
   kubectl -n "$NS" create rolebinding openlog-operator \
     --role=openlog-operator --serviceaccount=openlog:openlog-operator
   kubectl -n "$NS" create rolebinding openlog-operator-scale \
     --role=openlog-operator-scale --serviceaccount=openlog:openlog-operator
   kubectl -n "$NS" create rolebinding openlog-operator-pods \
     --role=openlog-operator-pods --serviceaccount=openlog:openlog-operator
   # 再撤掉集群级的那份写权限（只读 ClusterRole 保留，页面照常能看全部 ns）
   kubectl delete clusterrolebinding openlog-operator
   kubectl delete clusterrole openlog-operator
   ```

   注意：`openlog-operator` 仍绑着只读 ClusterRole，所以「看」还是全集群；写只在这个 ns 生效。
   若连读也要收窄，把 `openlog-operator-readonly` 那条 Binding 也改成 RoleBinding。
3. 一个集群一份 kubeconfig，不跨集群复用、不交叉粘贴。
4. 开写前用 operator kubeconfig 复核一遍「该有的有、不该有的没有」：

   ```bash
   K=--kubeconfig=/tmp/openlog-operator-kubeconfig.yaml
   kubectl $K auth can-i patch deployments -n "$NS"      # yes
   kubectl $K auth can-i update statefulsets/scale -n "$NS"   # yes
   kubectl $K auth can-i delete pods -n "$NS"            # yes
   kubectl $K auth can-i deletecollection pods -n "$NS"  # no
   kubectl $K auth can-i get secrets -A                  # no
   kubectl $K auth can-i create pods/exec -n "$NS"       # no
   kubectl $K auth can-i delete nodes                    # no
   kubectl $K auth can-i create clusterrolebindings.rbac.authorization.k8s.io   # no
   ```
5. 打开 apiserver 审计日志；OpenLog 自身对每个写操作也会记一条审计（返回里的 `auditId`），两边对得上。
6. 排障结束后把 kubeconfig 换回只读、去掉 `OPENLOG_K8S_WRITE`，能长期不开就不长期开。

### 2.5 风险提示：开了写权限就等于把集群变更能力交出去

- **能造成的破坏**：改副本数可以把节点打满（比如 `replicas: 0` 造成业务中断，或调大到调度不下的量把集群压垮）；
  重启会整批滚动重建 Pod；删 Pod 可能踩到单点（StatefulSet 的有状态副本、单副本 Deployment）。
- **凭据是长期有效的**：`openlog-operator-token` 没有过期时间，泄露即等于把那三个写动作交给对方，
  轮换只能删 Secret 重建（见第五节）。请不要把它贴进聊天工具、日志、issue 或提交进仓库。
- **权限被"转发"**：能登进 OpenLog 的人就能用这份 kubeconfig 写集群。开写之前先确认 OpenLog 自己的
  访问令牌（`OPENLOG_TOKEN`）发给了谁、有没有暴露在公网。
- **建议**：只在需要的那几个命名空间开写；apiserver 只对内网开放；按需临时开、用完就关；
  共享集群 / 生产集群上默认不开。

---

## 三、部署步骤

### 3.0 前置条件

- 一个可用的 kubeconfig（管理员或具备 `create clusterrole/clusterrolebinding/serviceaccount/secret` 的账号）。
- 目标集群能确认 apiserver 地址：`kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'`。

### 3.1 标准 Kubernetes（v1.24 及以上）

```bash
# 1) 应用 RBAC + SA + token Secret
#    文件后半段是可选的 operator 可写套件；不需要写操作时按 2.2 的 awk 截断方式只装只读部分
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

### 3.2 k3s（v1.33）

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

### 3.3 Docker / 容器化部署的 OpenLog

容器内没有 kubectl，也不需要：把上一步生成的 kubeconfig 文本直接粘贴到 OpenLog 的
「K8s 集群」设置里（保存在 OpenLog 自己的 settings 中，读取时默认打码）。

---

## 四、403 排错对照表

OpenLog 报「权限不足」时会带上 `forbidden` 与所需 verb/resource。按下表补齐对应规则
（读相关的补齐方式仍然只加 `get`/`list`/`watch`；写相关的报错见表格最后几行，规则在第二节）：

> 先分清两种 403：**应用层**的 `403` 是 `{"error":"写操作未启用（OPENLOG_K8S_WRITE=1 后生效）","readOnly":true}`
> （OpenLog 自己拦的，跟 RBAC 无关）；**apiserver 层**的 403 带 `forbidden` 与 verb/resource（RBAC 缺权限）。

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
| 报 `Unauthorized`（401）而不是 403 | token 无效/过期 | 重新 `make-kubeconfig.sh`，见第五节轮换 |
| 写操作 403，body 是 `{"error":"写操作未启用（OPENLOG_K8S_WRITE=1 后生效）","readOnly":true}` | 不是 RBAC 问题 | 服务端开关没开：`EXTRA_ENV="OPENLOG_K8S_WRITE=1"` 后重新部署（见 2.3） |
| 扩缩容 403，`deployments.apps "x" is forbidden: ... on resource "deployments"`，verb 是 `patch`/`update` | `patch`/`update` × `deployments`/`statefulsets` | 装 operator 段，kubeconfig 换成 `openlog-operator` 那份 |
| 扩缩容 403，`deployments.apps/scale is forbidden` | `get`/`patch`/`update` × `deployments/scale` | 子资源要单独授权，自己写 Role 时最容易漏这条 |
| 删 Pod 403，`pods "x" is forbidden: ... verb "delete"` | `delete` × `pods` | `pods` 规则要给 `delete`（operator 段已含） |

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

## 五、token 轮换

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
- 装了可写套件时，`openlog-operator-token` 走同一套流程，只换名字：
  `kubectl -n openlog delete secret openlog-operator-token && kubectl apply -f deploy/k8s/rbac.yaml`，
  再 `make-kubeconfig.sh --sa openlog-operator --secret openlog-operator-token` 重新生成并在 OpenLog 里替换。
  可写凭据泄露的处置优先级高于只读：先换掉，再查审计日志里这段时间的写操作（返回的 `auditId` 可对账）。

---

## 六、安全清单

- [ ] `openlog-readonly-token` 的明文 token 从未出现在仓库、CI 日志、聊天记录中。
- [ ] 生成的 kubeconfig 临时文件权限 `600`，用后删除。
- [ ] 确认 `kubectl auth can-i get secrets -A` 返回 `no`。
- [ ] 确认 `kubectl auth can-i delete pods -A` 返回 `no`（若装了可写套件，这条改用**只读**那份 kubeconfig 验证，
      并用 operator kubeconfig 确认能改的只有需要的那几个命名空间）。
- [ ] OpenLog 只在内网可达 apiserver；6443 不对公网开放。
- [ ] 已记录轮换周期与负责人。

装了可写套件（`openlog-operator`）时额外确认：

- [ ] 确实需要写操作才装；排障结束是否已回退（换回只读 kubeconfig、去掉 `OPENLOG_K8S_WRITE`、删掉 operator 凭据）。
- [ ] `openlog-operator-token` 的 kubeconfig 同样按密码对待，未进仓库 / 日志 / 聊天记录。
- [ ] `kubectl --kubeconfig <operator> auth can-i deletecollection pods -A` 返回 `no`。
- [ ] `kubectl --kubeconfig <operator> auth can-i get secrets -A` 返回 `no`。
- [ ] `kubectl --kubeconfig <operator> auth can-i create pods/exec -n <ns>` 返回 `no`。
- [ ] `kubectl --kubeconfig <operator> auth can-i delete nodes` 返回 `no`。
- [ ] 能登 OpenLog 的人都是应该能改集群工作负载的人（或已收窄到开发 / 排障用的命名空间）。
