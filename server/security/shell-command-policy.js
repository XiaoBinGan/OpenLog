/**
 * security/shell-command-policy.js — 远程命令执行的共享安全策略
 *
 * 这段逻辑原先内联在 server/index.js 的 remote 路由区块里，
 * 却被区块之外的 docker `/api/docker/:sourceId/:containerId/exec` 路由使用
 * —— 依靠函数提升和「只在请求时才读 const」侥幸能跑。抽出 remote 路由时
 * 会把定义一起带走并打断 docker 路由，因此先把它提成独立模块，两边共同 import。
 *
 * ⚠️ 这不是安全边界。
 * 「元字符过滤 + 命令名白名单」挡不住命令自身提供的逃逸口：
 *   find / -exec id {} +        → 执行任意子进程
 *   awk 'BEGIN{system("id")}'   → 执行任意子进程
 *   sed '1e id' /  /  sed -i    → 执行任意子进程 / 原地改写文件
 *   sort -o /etc/hosts ...      → 写任意文件
 *   date -s / hostname / dmesg -C / journalctl --vacuum-* / ip link set
 *                               → 修改系统状态、销毁日志
 * 真正的边界是「默认关闭」（见 REMOTE_EXEC_ENABLED）与鉴权。
 */

// 拒绝 shell 元字符与命令链接（必须在白名单检查之前执行）
export const SHELL_METACHAR_PATTERN = /[;`|&<>\n\r]|\$\(|\$\{/;

export function hasShellMetaChars(command) {
  return typeof command === 'string' && SHELL_METACHAR_PATTERN.test(command);
}

/**
 * REST 远程命令执行开关。
 *
 * 前端界面并不使用 REST 命令执行端点（UI 走 WS 终端 /ws/shell 与
 * WS AI Shell /ws/aishell），因此默认关闭；确需外部脚本调用时显式开启：
 *     OPENLOG_ENABLE_REMOTE_EXEC=1
 *
 * 注意这是**模块加载时**求值 —— 与抽取前一致。改动环境变量需要重启进程。
 */
export const REMOTE_EXEC_ENABLED = process.env.OPENLOG_ENABLE_REMOTE_EXEC === '1';

if (REMOTE_EXEC_ENABLED) {
  console.warn(
    '⚠️  [安全] OPENLOG_ENABLE_REMOTE_EXEC=1：REST 远程命令执行端点已开启。' +
    '白名单不是安全边界，持有 token 的调用方可以以 SSH 用户身份执行命令。'
  );
}

/** 开关关闭时写 403 并返回 true（调用方应 `if (rejectUnlessRemoteExecEnabled(res)) return;`）。 */
export function rejectUnlessRemoteExecEnabled(res) {
  if (REMOTE_EXEC_ENABLED) return false;
  res.status(403).json({
    error: 'REST 远程命令执行端点已默认禁用。确需使用时请设置环境变量 OPENLOG_ENABLE_REMOTE_EXEC=1 后重启服务。',
  });
  return true;
}

/**
 * 容器内命令执行开关（Docker 页面「容器内执行命令」面板）。
 *
 * 与 REST 远程执行分开是刻意的：
 *   - REST 远程执行（SSH）默认关闭，面向外部脚本，白名单挡不住逃逸口；
 *   - 容器内执行是**页面功能**，只能跑只读白名单命令、且禁止 shell 元字符，
 *     单独一个开关可以「开面板但不开 SSH 远程执行」。
 *
 * 开启方式：OPENLOG_ENABLE_CONTAINER_EXEC=1（或 OPENLOG_ENABLE_REMOTE_EXEC=1 一并开启）。
 * 不设则面板会明确提示「容器内命令执行未启用」，而不是莫名其妙的 400。
 */
export const CONTAINER_EXEC_ENABLED =
  process.env.OPENLOG_ENABLE_CONTAINER_EXEC === '1' || REMOTE_EXEC_ENABLED;

if (CONTAINER_EXEC_ENABLED) {
  console.warn(
    '⚠️  [安全] 容器内命令执行已开启（只读白名单 + 禁止元字符）。' +
    '持有 token 的调用方可 in 容器内查看文件与进程。'
  );
}

/** 开关关闭时写 403 并返回 true（调用方应 `if (rejectUnlessContainerExecEnabled(res)) return;`）。 */
export function rejectUnlessContainerExecEnabled(res) {
  if (CONTAINER_EXEC_ENABLED) return false;
  res.status(403).json({
    error: '容器内命令执行未启用。设置环境变量 OPENLOG_ENABLE_CONTAINER_EXEC=1 后重启服务即可使用（仅允许只读命令）。',
  });
  return true;
}

// 仅保留真正只读、且没有执行/写入逃逸口的命令。
// 已移除：find、awk、sed（可执行任意子进程 / 改写文件）
//          sort、uniq（-o 与第二参数可写文件）
//          date、hostname、dmesg、journalctl、ip、nvidia-smi（可改系统状态）
export const READONLY_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'du', 'df', 'free', 'ps', 'top',
  'uptime', 'echo', 'pwd', 'whoami', 'id', 'uname', 'ss', 'ping', 'lsof',
  'lscpu', 'lsblk', 'iostat', 'vmstat', 'netstat', 'stat',
];

/** 取命令名：抹掉前后空白、按空白切分、去掉路径前缀（/bin/ls → ls）。 */
export function commandBaseName(command) {
  return String(command).trim().split(/\s+/)[0].split('/').pop();
}
