/**
 * security/command-risk.js — 判断一条 Shell 命令是不是「只读」（可以免确认执行）。
 *
 * 背景（真实反馈）：运维助手每跑一条 `cat` / `ls` / `grep` / `ps` / `nginx -T` 都要弹一次
 * 确认框，一轮排查十几条查询，用户要点十几次「批准」。只读命令不改变系统状态，
 * 不该反复打断人。
 *
 * 判定原则是**保守**：
 *   - 只有「每一段管道/分号串联的子命令都在只读白名单里」才判只读；
 *   - 任何写文件重定向（`>` / `>>`，除 `/dev/null`）、`tee`、`sed -i`、
 *     `find -exec/-delete`、`awk system()`、`xargs`、`sudo`、命令替换（`$(...)`/反引号）
 *     一律判非只读；
 *   - 解析不了的一律判非只读（宁可多问一次，不可误放行）。
 *
 * ⚠️ 这不是安全边界，是 UX 优化。它只决定「要不要弹确认框」，
 * 真正的边界仍然是 token 鉴权 + 写操作确认 + 审计日志。
 */

/**
 * 只读命令名单（命令名，不带路径）。
 *
 * 注意与 security/shell-command-policy.js 的 `READONLY_COMMANDS` 区分：
 * 那边的名单用于「REST 直接执行」，因此必须排除 find/awk/sed 这类带逃逸口的命令；
 * 这里的名单只用于「要不要弹确认框」，允许 find/awk/sed 但逐个检查参数（见 ARG_GUARDS）。
 */
const READONLY_COMMAND_NAMES = new Set([
  // 文件查看
  'ls', 'll', 'la', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file',
  'readlink', 'realpath', 'dirname', 'basename', 'strings', 'od', 'xxd', 'hexdump',
  'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'du', 'df', 'tree',
  // 搜索
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  // 进程 / 系统信息
  'ps', 'pstree', 'pgrep', 'pidof', 'top', 'uptime', 'free', 'vmstat', 'iostat',
  'mpstat', 'nproc', 'lscpu', 'lsblk', 'lsmod', 'lsusb', 'lspci', 'lsof',
  'uname', 'hostname', 'hostnamectl', 'id', 'who', 'w', 'whoami', 'groups',
  'last', 'lastlog', 'tty', 'getent', 'locale', 'timedatectl', 'date', 'cal',
  'env', 'printenv', 'which', 'whereis', 'type', 'tty', 'ulimit', 'getconf',
  // 网络（只读）
  'ss', 'netstat', 'ping', 'ping6', 'traceroute', 'tracepath', 'dig', 'nslookup', 'host', 'mtr',
  // 文本处理（只输出到 stdout）
  'echo', 'printf', 'sort', 'uniq', 'cut', 'tr', 'paste', 'join', 'comm',
  'diff', 'cmp', 'column', 'nl', 'fold', 'fmt', 'rev', 'expand', 'unexpand',
  'jq', 'yq', 'xmllint', 'iconv',
  // 其他只读
  'true', 'false', 'test', '[', 'cd', 'pwd', 'sleep', 'yes', 'watch',
  'base64', 'numfmt', 'seq',
  // 本身可能有写操作，靠 ARG_GUARDS 逐条检查参数
  'find', 'sed', 'awk', 'gawk', 'mawk', 'sort', 'uniq', 'tail', 'date', 'hostname',
  'dmesg', 'journalctl', 'sysctl', 'ss', 'mount', 'systemctl', 'service',
  'docker', 'git', 'nginx', 'apachectl', 'httpd', 'kubectl', 'crictl',
  'curl', 'ip', 'nvidia-smi', 'node', 'python', 'python3', 'npm', 'env', 'command',
  'timeout', 'nice', 'ionice', 'stdbuf', 'nohup',
]);

/**
 * 单独做参数检查的命令：命令本身可能只读，但某些参数会写文件 / 执行子进程。
 * 返回 null 表示通过；返回字符串表示拒绝原因。
 */
const ARG_GUARDS = {
  find: (args) => {
    const bad = args.find(a => /^(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fls)$/.test(a));
    return bad ? `find 的 ${bad} 会写文件或执行子进程` : null;
  },
  sed: (args) => {
    if (args.some(a => a === '-i' || a === '--in-place' || /^-[a-zA-Z]*i/.test(a))) return 'sed -i 会原地改写文件';
    // sed 脚本里的 w(写文件) / e(执行命令) 指令
    const script = args.filter(a => !a.startsWith('-')).join(' ');
    if (/(^|[;{}\n])\s*\d*(,\d*)?\s*[we]\s+\S/.test(script)) return 'sed 的 w/e 指令会写文件或执行命令';
    return null;
  },
  awk: (args) => {
    const program = args.join(' ');
    if (/system\s*\(/.test(program)) return 'awk system() 会执行子进程';
    if (/\|\s*["']/.test(program)) return 'awk 管道到 shell 会执行子进程';
    if (/(print|printf)\s*[^;|]*>>?\s*["']/.test(program)) return 'awk print > 会写文件';
    return null;
  },
  sort: (args) => (args.some(a => a === '-o' || a === '--output' || /^-o/.test(a)) ? 'sort -o 会写文件' : null),
  uniq: (args) => {
    const positional = args.filter(a => !a.startsWith('-'));
    return positional.length > 1 ? 'uniq 的第二个参数会写文件' : null;
  },
  tail: (args) => (args.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--follow') ? 'tail -f 会一直挂住' : null),
  date: (args) => (args.some(a => a === '-s' || a === '--set') ? 'date -s 会修改系统时间' : null),
  hostname: (args) => (args.length > 0 ? 'hostname 带参数会改名' : null),
  dmesg: (args) => (args.some(a => /^-[cC]$/.test(a) || a === '--clear' || a === '--read-clear') ? 'dmesg -C 会清空内核日志' : null),
  journalctl: (args) => (args.some(a => /^--(vacuum|rotate|flush|sync|relinquish)/.test(a)) ? 'journalctl 会销毁/轮转日志' : null),
  sysctl: (args) => (args.some(a => a === '-w' || a === '--write' || a === '-p') ? 'sysctl 写参数会改内核状态' : null),
  ss: (args) => (args.includes('-K') ? 'ss -K 会断开连接' : null),
  mount: (args) => (args.length > 0 ? 'mount 带参数会改变挂载' : null),
  systemctl: (args) => {
    const sub = args.find(a => !a.startsWith('-')) || '';
    const readonly = ['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files',
      'list-timers', 'list-sockets', 'show', 'cat', 'help', 'get-default', 'show-environment'];
    if (readonly.includes(sub)) return null;
    return `systemctl ${sub || ''} 会改变服务状态`.trim();
  },
  service: (args) => (args.some(a => a === '--status-all' || a === 'status') ? null : 'service 非 status 会改变服务状态'),
  docker: (args) => {
    // 形如 docker <sub>；compose <sub>
    const sub = args.find(a => !a.startsWith('-')) || '';
    const second = args.filter(a => !a.startsWith('-'))[1] || '';
    const readonly = ['ps', 'images', 'logs', 'inspect', 'stats', 'version', 'info',
      'top', 'port', 'diff', 'history', 'search', 'events'];
    if (readonly.includes(sub)) return null;
    if (sub === 'system' && second === 'df') return null;
    if ((sub === 'network' || sub === 'volume' || sub === 'container' || sub === 'image' || sub === 'node' || sub === 'service')
      && ['ls', 'inspect', 'ps'].includes(second)) return null;
    if (sub === 'compose' && ['ps', 'logs', 'config', 'top', 'version'].includes(second)) return null;
    return `docker ${sub} ${second} 会改变容器/镜像状态`.replace(/\s+/g, ' ').trim();
  },
  git: (args) => {
    const sub = args.find(a => !a.startsWith('-')) || '';
    const readonly = ['status', 'log', 'diff', 'show', 'branch', 'remote', 'config',
      'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'blame', 'describe', 'tag',
      'stash', 'reflog', 'shortlog', 'whatchanged', 'grep', 'cat-file', 'count-objects', 'show-ref'];
    if (!readonly.includes(sub)) return `git ${sub} 可能修改仓库`;
    // 部分子命令的写操作
    if (sub === 'branch' && args.some(a => /^-[dDmMcC]$/.test(a))) return 'git branch -d/-m 会修改分支';
    if (sub === 'tag' && args.some(a => /^-[dDfa]$/.test(a))) return 'git tag -d/-f 会修改标签';
    if (sub === 'stash' && args.some(a => ['apply', 'pop', 'drop', 'clear', 'save', 'push'].includes(a))) return 'git stash 改动工作区';
    if (sub === 'config') {
      const rest = args.slice(args.indexOf('config') + 1);
      const hasWriteFlag = rest.some(a => ['--set', '--unset', '--unset-all', '--add', '--replace-all', '-e', '--edit', '--rename-section', '--remove-section'].includes(a));
      if (hasWriteFlag) return 'git config 写配置';
      // 只读形式：git config --get x / --list / -l / --get-regexp，或 `git config <key>`（只读值）
      const positional = rest.filter(a => !a.startsWith('-'));
      const readFlag = rest.some(a => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a));
      if (!readFlag && positional.length >= 2) return 'git config 写配置';
    }
    if (sub === 'remote' && args.some(a => ['add', 'remove', 'rename', 'set-url'].includes(a))) return 'git remote 写配置';
    return null;
  },
  nginx: (args) => (args.some(a => ['-t', '-T', '-v', '-V'].includes(a)) ? null : 'nginx 非 -t/-T 会启停服务'),
  apachectl: (args) => (args.some(a => ['-t', '-S', '-M', '-v', '-V'].includes(a)) ? null : 'apachectl 非 -t/-S 会启停服务'),
  httpd: (args) => (args.some(a => ['-t', '-S', '-M', '-v', '-V'].includes(a)) ? null : 'httpd 非 -t/-S 会启停服务'),
  kubectl: (args) => {
    const sub = args.find(a => !a.startsWith('-')) || '';
    return ['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'api-versions'].includes(sub)
      ? null : `kubectl ${sub} 可能修改集群状态`;
  },
  crictl: (args) => {
    const sub = args.find(a => !a.startsWith('-')) || '';
    return ['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'pods', 'imagefsinfo'].includes(sub)
      ? null : `crictl ${sub} 可能修改容器状态`;
  },
  curl: (args) => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^(-o|--output)$/.test(a)) {
        const target = args[i + 1] || '';
        if (target !== '/dev/null') return `curl 写入文件 ${target}`;
      }
      if (/^-o[^/]/.test(a) && !a.startsWith('-o/dev/null')) return 'curl -o 写入文件';
      if (/^(-O|--remote-name|--remote-name-all)$/.test(a)) return 'curl -O 写入文件';
      if (/^(-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|-T|--upload-file)$/.test(a)) return 'curl 会发送写请求/上传文件';
      if (/^(-X|--request)$/.test(a) && !/^GET$/i.test(args[i + 1] || '')) return `curl ${args[i + 1]} 非 GET`;
      if (/^(-X|--request)(POST|PUT|DELETE|PATCH)/i.test(a)) return 'curl 会发送写请求';
      if (/^(--create-dirs|--create-file-mode)$/.test(a)) return 'curl 会创建文件';
    }
    return null;
  },
  ip: (args) => {
    const joined = args.join(' ');
    if (/\b(set|add|del|delete|flush|change|replace|exec|monitor)\b/.test(joined)) return 'ip 会修改网络配置';
    return /show|list|get|addr|route|link|neigh/.test(joined) ? null : 'ip 参数无法判定为只读';
  },
  nvidia_smi: () => null,
  'nvidia-smi': (args) => {
    const bad = args.find(a => /^(-c|--compute-mode|-pl|--power-limit|-r|--gpu-reset|--reset)$/.test(a));
    return bad ? `nvidia-smi ${bad} 会修改 GPU 状态` : null;
  },
  node: (args) => (args.length && !args.every(a => /^(-v|--version|-e\s*''|--help)$/.test(a)) ? 'node 带脚本会执行代码' : null),
  python: (args) => (args.length ? 'python 带脚本会执行代码' : null),
  python3: (args) => (args.length && !args.every(a => /^(-V|--version|-h|--help)$/.test(a)) ? 'python3 带脚本会执行代码' : null),
  npm: (args) => (args.every(a => /^(-v|--version|-h|--help)$/.test(a)) ? null : 'npm 可能安装/修改文件'),
  env: (args) => {
    // env 后面跟命令会执行它：只允许纯 KEY=VALUE 或空
    const extra = args.filter(a => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && !a.startsWith('-'));
    return extra.length ? `env 会执行命令 ${extra[0]}` : null;
  },
  command: (args) => (args.includes('-v') || args.includes('-V') ? null : 'command 会执行命令'),
  timeout: () => null, // timeout 本身只包装，后续由递归解析处理
};

/** 允许的写重定向目标（丢弃输出，不算写文件） */
const NULL_TARGET_RE = /^(?:\/dev\/null|&1|&2|&>\/dev\/null)$/;

/** 顶层包装器：直接剥掉后继续看真正的命令 */
const WRAPPERS = new Set(['timeout', 'nice', 'ionice', 'stdbuf', 'nohup']);

/** 出现即判非只读（任意位置） */
const ABSOLUTE_BLOCKLIST = [
  { re: /\$\(/, reason: '命令替换 $(...) 可以执行任意命令' },
  { re: /`[^`]*`/, reason: '反引号命令替换可以执行任意命令' },
];

/** 解析失败/判为非只读时的默认原因 */
const GENERIC_REASON = '可能修改系统状态';

/**
 * 按引号感知地切分命令（不在引号内的 ; && || | 换行处切）。
 * @returns {string[]} 片段
 */
export function splitCommandSegments(command) {
  const s = String(command ?? '');
  const segments = [];
  let buf = '';
  let quote = null;      // ' or "
  let escaped = false;

  const push = () => {
    const t = buf.trim();
    if (t) segments.push(t);
    buf = '';
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { buf += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { buf += ch; escaped = true; continue; }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === '\n' || ch === ';') { push(); continue; }
    if (ch === '&' && s[i + 1] === '&') { push(); i++; continue; }
    if (ch === '|' && s[i + 1] === '|') { push(); i++; continue; }
    if (ch === '|') { push(); continue; }
    buf += ch;
  }
  push();
  return segments;
}

/**
 * 引号感知分词。
 * @returns {string[]} 不含引号的 token
 */
export function tokenizeSegment(segment) {
  const s = String(segment ?? '');
  const tokens = [];
  let buf = '';
  let quote = null;
  let escaped = false;
  let has = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { buf += ch; escaped = false; has = true; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      buf += ch; has = true; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has) { tokens.push(buf); buf = ''; has = false; }
      continue;
    }
    buf += ch; has = true;
  }
  if (has) tokens.push(buf);
  return tokens;
}

/** 去掉 token 里的重定向；返回 { tokens, writeTarget } */
function stripRedirects(tokens) {
  const out = [];
  let writeTarget = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // 形如 > /dev/null、2> /dev/null、>> file
    const bare = t.match(/^(\d*|&)(>>?)(\|?)$/);
    if (bare) {
      const target = (tokens[i + 1] || '').replace(/^['"]|['"]$/g, '');
      // > 和 >> 都是写文件；只有 /dev/null、&1、&2 这种丢弃输出的才算无害
      if (!NULL_TARGET_RE.test(target)) writeTarget = target;
      i++; // 跳过目标
      continue;
    }
    // 形如 >/dev/null、2>&1、>>file
    const inline = t.match(/^(\d*|&)(>>?)(.+)$/);
    if (inline) {
      const target = inline[3];
      if (inline[2] === '>' && !NULL_TARGET_RE.test(target)) writeTarget = target;
      continue;
    }
    // < 输入重定向：只允许 /dev/null
    if (/^<$/.test(t)) { i++; continue; }
    if (/^<.+/.test(t)) {
      const target = t.slice(1);
      if (!NULL_TARGET_RE.test(target)) writeTarget = target;
      continue;
    }
    out.push(t);
  }
  return { tokens: out, writeTarget };
}

/**
 * 判断一条命令是否只读（可免确认执行）。
 * @param {string} command
 * @returns {{ readonly: boolean, reason?: string }}
 */
export function classifyCommandRisk(command) {
  const raw = String(command ?? '').trim();
  if (!raw) return { readonly: false, reason: '命令为空' };
  if (raw.length > 4000) return { readonly: false, reason: '命令过长' };

  for (const { re, reason } of ABSOLUTE_BLOCKLIST) {
    if (re.test(raw)) return { readonly: false, reason };
  }

  const segments = splitCommandSegments(raw);
  if (segments.length === 0) return { readonly: false, reason: '命令为空' };

  for (const segment of segments) {
    const verdict = classifySegment(segment);
    if (!verdict.readonly) return verdict;
  }
  return { readonly: true, reason: '只读查询命令' };
}

/** 单个子命令片段 */
function classifySegment(segment) {
  let tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return { readonly: true };

  // 剥掉环境变量前缀（FOO=bar cmd）
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  if (tokens.length === 0) return { readonly: true };

  // 拒绝 sudo / su / doas 等提权包装
  const head = tokens[0];
  if (/^(sudo|su|doas|pkexec)$/.test(head)) return { readonly: false, reason: `${head} 会提权` };

  // 剥掉 timeout/nice 等包装器（timeout 需要跳掉时长参数）
  let guard = 0;
  while (tokens.length && WRAPPERS.has(tokens[0]) && guard++ < 4) {
    const wrapper = tokens[0];
    tokens = tokens.slice(1);
    if (wrapper === 'timeout') {
      // timeout [-s SIG] DURATION cmd...
      if (tokens[0] === '-s') tokens = tokens.slice(2);
      else if (tokens[0] && /^-/.test(tokens[0])) tokens = tokens.slice(1);
      tokens = tokens.slice(1); // 时长
    } else {
      while (tokens.length && /^-/.test(tokens[0])) tokens = tokens.slice(1);
    }
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  }
  if (tokens.length === 0) return { readonly: false, reason: '缺少实际命令' };

  const { tokens: clean, writeTarget } = stripRedirects(tokens);
  if (writeTarget) return { readonly: false, reason: `重定向写入 ${writeTarget}` };
  if (clean.length === 0) return { readonly: false, reason: '缺少实际命令' };

  const name = clean[0].split('/').pop();
  const args = clean.slice(1);

  if (!READONLY_COMMAND_NAMES.has(name)) {
    return { readonly: false, reason: `命令 ${name} 不在只读白名单` };
  }

  // 逻辑/控制关键字：包在 if/while 里的不当作只读
  if (['if', 'while', 'until', 'for', 'case', 'do', 'then', 'else', 'fi', 'done', '{', '}', '!'].includes(name)) {
    return { readonly: false, reason: '包含控制结构' };
  }
  if (name === '[' && !segment.trim().endsWith(']')) {
    return { readonly: false, reason: 'test 语法不完整' };
  }

  // 命令替换可能藏在参数里（如 echo $(rm -rf /)）
  for (const a of args) {
    if (a.includes('$(') || a.includes('`')) return { readonly: false, reason: '参数含命令替换' };
  }

  const guardFn = ARG_GUARDS[name === '-' ? 'sed' : name] || ARG_GUARDS[name.replace(/-/g, '_')];
  if (guardFn) {
    const reason = guardFn(args);
    if (reason) return { readonly: false, reason };
  }

  return { readonly: true };
}

export default { classifyCommandRisk, splitCommandSegments, tokenizeSegment };
