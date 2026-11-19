#!/usr/bin/env bash
#
# make-kubeconfig.sh —— 为 OpenLog 生成「只读 ServiceAccount」的 kubeconfig
#
# 用途：
#   读取 deploy/k8s/rbac.yaml 创建好的长期 token Secret（kubernetes.io/service-account-token），
#   拼装成标准 kubeconfig 并输出到 stdout，供粘贴到 OpenLog「K8s 集群」页
#   （kubeconfig 直连 apiserver 模式：不依赖 kubectl、不在节点装 agent）。
#
# 用法：
#   bash make-kubeconfig.sh --server https://127.0.0.1:6443 [--namespace openlog] \
#        [--sa openlog-readonly] [--secret openlog-readonly-token]
#
# 参数：
#   --server     kube-apiserver 地址，必填，形如 https://127.0.0.1:6443
#   --namespace  ServiceAccount / Secret 所在命名空间，默认 openlog
#   --sa         ServiceAccount 名，默认 openlog-readonly（用于生成 user 名与错误提示）
#   --secret     长期 token Secret 名，默认 openlog-readonly-token
#
# 安全提示（务必阅读）：
#   * 输出 kubeconfig 中的 token 等同于「整个集群的只读权限」：可读取全部 Pod 日志、
#     节点信息、事件与工作负载定义。请按密码对待。
#   * 禁止把输出内容提交进 git 仓库、写进 issue / 聊天记录、或落到共享目录；
#     确需临时落盘时先 `umask 077`，并放到 ~/.kube 之外的临时位置，用完立即删除。
#   * 轮换：删除并重建该 Secret 后重新生成本 kubeconfig（见 deploy/k8s/README.md）。
#
# 退出码：
#   0  成功（kubeconfig 已写入 stdout）
#   1  依赖缺失 / Secret 不存在 / token 或 CA 为空 / 解码失败
#   2  参数错误
#
set -euo pipefail

PROG_NAME="make-kubeconfig.sh"

# err <退出码> <首行信息> [补充行...]
# 所有错误统一写 stderr，避免污染 stdout 上的 kubeconfig
err() {
  local code="$1"
  shift
  printf '%s: 错误：%s\n' "$PROG_NAME" "$1" >&2
  shift || true
  if [ "$#" -gt 0 ]; then
    printf '%s\n' "$@" >&2
  fi
  exit "$code"
}

usage() {
  cat <<'USAGE'
用法:
  bash make-kubeconfig.sh --server https://127.0.0.1:6443 [--namespace openlog] \
       [--sa openlog-readonly] [--secret openlog-readonly-token]

说明:
  需要本机已安装 kubectl，且当前 kubeconfig 有权读取 <namespace>/<secret>。
  生成的 kubeconfig 输出到 stdout，只含 CA + token 认证（不含客户端证书）。

选项:
  --server     kube-apiserver 地址，必填，如 https://127.0.0.1:6443
  --namespace  ServiceAccount / Secret 所在命名空间，默认 openlog
  --sa         ServiceAccount 名，默认 openlog-readonly
  --secret     长期 token Secret 名，默认 openlog-readonly-token
  -h, --help   显示本帮助
USAGE
}

SERVER=""
NAMESPACE="openlog"
SA_NAME="openlog-readonly"
SECRET_NAME="openlog-readonly-token"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server)
      [ "$#" -ge 2 ] || err 2 "--server 需要一个值（如 https://127.0.0.1:6443）"
      SERVER="$2"; shift 2 ;;
    --server=*)
      SERVER="${1#*=}"; shift ;;
    --namespace)
      [ "$#" -ge 2 ] || err 2 "--namespace 需要一个值"
      NAMESPACE="$2"; shift 2 ;;
    --namespace=*)
      NAMESPACE="${1#*=}"; shift ;;
    --sa)
      [ "$#" -ge 2 ] || err 2 "--sa 需要一个值"
      SA_NAME="$2"; shift 2 ;;
    --sa=*)
      SA_NAME="${1#*=}"; shift ;;
    --secret)
      [ "$#" -ge 2 ] || err 2 "--secret 需要一个值"
      SECRET_NAME="$2"; shift 2 ;;
    --secret=*)
      SECRET_NAME="${1#*=}"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      err 2 "未知参数：$1" "用 --help 查看用法。" ;;
  esac
done

[ -n "$SERVER" ] || err 2 "缺少必填参数 --server" "例如：--server https://127.0.0.1:6443"
case "$SERVER" in
  http://*|https://*) : ;;
  *) err 2 "--server 必须以 http:// 或 https:// 开头，当前值：$SERVER" ;;
esac
[ -n "$NAMESPACE" ] || err 2 "--namespace 不能为空"
[ -n "$SA_NAME" ] || err 2 "--sa 不能为空"
[ -n "$SECRET_NAME" ] || err 2 "--secret 不能为空"

command -v kubectl >/dev/null 2>&1 || err 1 \
  "未找到 kubectl，请先安装 kubectl 并确保它在 PATH 中" \
  "k3s 环境可直接使用 /usr/local/bin/kubectl 或 'k3s kubectl'。"

if ! kubectl version --client >/dev/null 2>&1; then
  err 1 "kubectl 无法正常执行（kubectl version --client 失败），请检查安装是否完整"
fi

# 兼容 GNU base64 与 macOS/BSD base64 的解码封装
b64_decode() {
  local data="$1"
  if printf '%s' "$data" | base64 --decode >/dev/null 2>&1; then
    printf '%s' "$data" | base64 --decode
  elif printf '%s' "$data" | base64 -D >/dev/null 2>&1; then
    printf '%s' "$data" | base64 -D
  elif printf '%s' "$data" | base64 -d >/dev/null 2>&1; then
    printf '%s' "$data" | base64 -d
  else
    return 1
  fi
}

# 读取 Secret 中某字段的 base64 原文（失败即退出并给出中文原因）
# stdout 与 stderr 分开收集：kubectl 的告警（如弃用提示）走 stderr，
# 若混进 stdout 会污染 base64 取值。
read_secret_field() {
  local field="$1" out="" err_file out_err=""
  err_file="$(mktemp "${TMPDIR:-/tmp}/openlog-kc-XXXXXX")" || err 1 "无法创建临时文件（检查 TMPDIR 是否可写）"
  # shellcheck disable=SC2064
  trap "rm -f '$err_file'" EXIT

  if out="$(kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" \
        -o jsonpath="{.data.${field}}" 2>"$err_file")"; then
    rm -f "$err_file"
    trap - EXIT
  else
    out_err="$(cat "$err_file" 2>/dev/null || true)"
    rm -f "$err_file"
    trap - EXIT
    err 1 "读取 Secret ${NAMESPACE}/${SECRET_NAME} 的 ${field} 字段失败" \
      "kubectl 输出：${out_err:-（无输出）}" \
      "常见原因：Secret 不存在（先 kubectl apply -f deploy/k8s/rbac.yaml）、命名空间或 Secret 名写错、当前 kubeconfig 无权读取该命名空间。"
  fi

  # base64 不含空白字符，去掉残留换行/空格避免污染
  printf '%s' "$out" | tr -d '[:space:]'
}

TOKEN_B64="$(read_secret_field token)"
[ -n "$TOKEN_B64" ] || err 1 \
  "Secret ${NAMESPACE}/${SECRET_NAME} 的 token 字段为空" \
  "k8s >= 1.24 由 kube-controller-manager 异步填充 token，通常几秒内完成；k3s 上偶发需要更久。" \
  "排查：kubectl -n ${NAMESPACE} get secret ${SECRET_NAME} -o yaml" \
  "并确认 annotation kubernetes.io/service-account.name 等于 ${SA_NAME}。"

TOKEN="$(b64_decode "$TOKEN_B64")" || err 1 "token 字段 base64 解码失败，Secret 内容可能已损坏"
[ -n "$TOKEN" ] || err 1 "token 解码后为空，请删除并重建 Secret ${NAMESPACE}/${SECRET_NAME}"

CA_B64_RAW="$(read_secret_field 'ca\.crt')"
[ -n "$CA_B64_RAW" ] || err 1 \
  "Secret ${NAMESPACE}/${SECRET_NAME} 中没有 ca.crt，无法校验 apiserver 证书" \
  "若 Secret 刚创建，请稍等后重试；若集群确实缺失 CA，可从管理员 kubeconfig 复制 certificate-authority-data 手工补全。"
CA_PEM="$(b64_decode "$CA_B64_RAW")" || err 1 "ca.crt 字段 base64 解码失败"
[ -n "$CA_PEM" ] || err 1 "ca.crt 解码后为空"

# 重新编码为单行 base64，嵌入 kubeconfig 的 certificate-authority-data
CA_B64_ONE_LINE="$(printf '%s' "$CA_PEM" | base64 | tr -d '\r\n')"
[ -n "$CA_B64_ONE_LINE" ] || err 1 "CA 重新编码失败"

CLUSTER_NAME="openlog"
CONTEXT_NAME="openlog"

# 提示信息走 stderr，stdout 只保留 kubeconfig 本体
{
  printf '%s: 生成 kubeconfig（namespace=%s, serviceaccount=%s, secret=%s）\n' \
    "$PROG_NAME" "$NAMESPACE" "$SA_NAME" "$SECRET_NAME"
  printf '%s: 警告：该 token 等同集群只读权限，请勿提交进仓库或分享\n' "$PROG_NAME"
} >&2

cat <<EOF
apiVersion: v1
kind: Config
preferences: {}
clusters:
  - name: ${CLUSTER_NAME}
    cluster:
      server: ${SERVER}
      certificate-authority-data: ${CA_B64_ONE_LINE}
users:
  - name: ${SA_NAME}
    user:
      token: '${TOKEN}'
contexts:
  - name: ${CONTEXT_NAME}
    context:
      cluster: ${CLUSTER_NAME}
      user: ${SA_NAME}
      namespace: ${NAMESPACE}
current-context: ${CONTEXT_NAME}
EOF
