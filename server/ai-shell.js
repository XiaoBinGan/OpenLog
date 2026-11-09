/**
 * ai-shell.js — AI Shell 的「大脑 + 手」。
 *
 * 与旧实现（一次生成一条命令、执行完就结束）的区别：
 *  1. **环境上下文**：会话建立时采集一次服务器的真实信息（发行版/内核/CPU/内存/磁盘/
 *     GPU/Docker 容器/监听端口/可用工具），注入 system prompt —— 模型不再凭空猜
 *     「有没有 docker」「是不是 Ubuntu」。
 *  2. **多步 agent 循环**：模型给出命令 → 流式执行 → 把输出回灌 → 决定下一步，
 *     直到给出最终结论（最多 maxSteps 步）。失败时能看到报错并自行修正。
 *  3. **流式输出**：命令边跑边推给前端，不再「憋到结束」；可随时取消。
 *  4. **风险分级 + 确认**：命令分 read / write / danger 三档；danger 永远需要人工确认，
 *     write 在手动模式下需确认，read 才允许自动执行。
 *
 * 本模块不直接依赖 index.js，模型调用与命令执行都通过参数注入，便于单测。
 */

import { errorMessage } from './errors.js';
import { planBudget, fitAgentMessages, truncateTextToTokens } from './context-budget.js';
import { contentText, normalizeContent } from './vision-content.js';

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** agent 循环默认步数（长任务：给足步数，靠进度台账 + 上下文压缩控制住 token） */
export const MAX_STEPS = 24;
/** 用户可调的上限（前端「步数上限」下拉最大 64；再大没有意义且容易跑飞） */
export const MAX_STEPS_CAP = 64;
/** 单次任务默认时长上限（前端可调 5~60 分钟） */
export const MAX_WALL_MS = 20 * 60 * 1000;
/** 时长上限的硬天花板 */
export const MAX_WALL_CAP_MS = 60 * 60 * 1000;
/** 进度台账占用的 token 上限 */
const DIGEST_MAX_TOKENS = 1200;
/** 单条命令上限 */
export const COMMAND_TIMEOUT_MS = 120_000;
/** 回灌给模型的单条输出上限（字符） */
export const OBSERVATION_LIMIT = 6000;
/** 上下文缓存时长 */
export const CONTEXT_TTL_MS = 5 * 60 * 1000;

/** 用户请求里出现这些词 = 要求做修改（用于「只查不干」兜底） */
const ACTION_INTENT_RE = /(创建|新建|建一个|建个|删除|删掉|清理|清空|重启|启动|停止|安装|卸载|修改|改成|写入|追加|上传|下载|部署|复制|移动|重命名|mkdir|chmod|chown|kill|restart|install|remove|create|delete|write)/i;

// ─── 风险分级 ──────────────────────────────────────────────────────────────

/** 只读命令白名单（这里没有的、且不在危险表里的，都算 write） */
const READONLY_BASE = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'zgrep', 'du', 'df', 'free', 'ps', 'top',
  'htop', 'uptime', 'echo', 'pwd', 'whoami', 'id', 'uname', 'hostname', 'date', 'ss', 'netstat',
  'lsof', 'lscpu', 'lsblk', 'lsusb', 'lspci', 'iostat', 'vmstat', 'mpstat', 'stat', 'file', 'tree',
  'which', 'whereis', 'type', 'env', 'printenv', 'getconf', 'nproc', 'arch',
  'nvidia-smi', 'journalctl', 'systemctl', 'service', 'docker', 'podman', 'kubectl', 'pip', 'pip3',
  'python3', 'python', 'node', 'npm', 'git', 'curl', 'wget', 'sqlite3', 'jq', 'awk', 'sed', 'sort',
  'uniq', 'cut', 'tr', 'column', 'watch', 'find', 'locate', 'readlink', 'realpath', 'md5sum', 'sha256sum',
]);

/** 危险操作：即使 autoRun 也必须人工确认 */
const DANGER_RULES = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\b|--recursive|--force)/, reason: '递归/强制删除' },
  { re: /\b(mkfs|mke2fs|wipefs|fdisk|parted|sgdisk)\b/, reason: '格式化/分区' },
  { re: /\bdd\b[^|]*\bof=/, reason: 'dd 写盘' },
  { re: /\b(shred|truncate)\b/, reason: '擦除/截断文件' },
  { re: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/, reason: '关机/重启' },
  { re: /\bkill(all)?\s+(-9\s+)?1(\s|$)/, reason: '终止关键进程' },
  { re: /\b(iptables\s+-F|nft\s+flush|ufw\s+disable|setenforce\s+0)/, reason: '清空/关闭防火墙' },
  { re: /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|network\s+rm)\b/, reason: '删除容器/镜像/卷' },
  { re: /\bpodman\s+(rm|rmi|system\s+prune|volume\s+rm)\b/, reason: '删除容器/镜像/卷' },
  { re: /\bsystemctl\s+(stop|disable|mask|kill)\b/, reason: '停止/禁用系统服务' },
  { re: /\b(apt|apt-get|yum|dnf|apk|pacman|zypper)\s+(remove|purge|autoremove|erase)\b/, reason: '卸载软件包' },
  { re: /\b(crontab\s+-r|userdel|groupdel|passwd\s+[^ ]|chpasswd)\b/, reason: '账户/定时任务变更' },
  { re: /(>|>>)\s*\/(etc|boot|sys|proc)\//, reason: '覆盖系统配置' },
  { re: /(>|>>)\s*~?\/?\.ssh\//, reason: '覆盖 SSH 配置/密钥' },
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)?[0-7]*777\b|\bchown\s+-R\s+[^ ]+\s+\/(\s|$)/, reason: '批量提权/改属主' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|d)?sh\b/, reason: '下载并执行远程脚本' },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, reason: 'fork 炸弹' },
  { re: /\b(eval|exec)\b\s+["']/, reason: '动态执行字符串' },
  { re: /\bmv\s+\S+\s+\/(\s|$)/, reason: '移动文件到根目录' },
];

const WRITE_HINTS = [
  /\b(rm|mv|cp|mkdir|rmdir|touch|ln|chmod|chown|install|tee|patch)\b/,
  /\bsed\s+-i\b/,
  /\b(docker|podman|systemctl|service|kubectl)\s+(start|stop|restart|reload|rm|run|exec|apply|delete|set)\b/,
  /\b(apt|apt-get|yum|dnf|apk|pip|pip3|npm|pnpm)\s+(install|add|upgrade|update)\b/,
  /\bkill\b/,
];

/**
 * 去掉引号里的内容（避免 `grep 'a|b'` 被当成管道分割）
 */
function stripQuoted(input) {
  return String(input || '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
}

/**
 * 找出「真的会写文件」的重定向（`> file` / `>> file`），排除 `2>&1`、`>/dev/null`。
 * @returns {string[]}
 */
function writeRedirects(command) {
  const text = stripQuoted(command);
  const out = [];
  for (const m of text.matchAll(/(?:^|[^0-9&])>{1,2}\s*([^\s;&|]+)/g)) {
    const target = m[1];
    if (target === '/dev/null' || target.startsWith('&')) continue;
    out.push(m[0]);
  }
  return out;
}

/**
 * 去掉 fd 重定向（`2>&1`、`2>/dev/null`、`&> /dev/null`）。
 * 它们不影响命令是否只读，但 `&1` 会被管道切段逻辑拆出个 `1` 造成误判。
 */
function stripFdRedirects(input) {
  return String(input || '')
    .replace(/\d*>>?\s*&\s*\d+/g, ' ')
    .replace(/\d*>>?\s*\/dev\/null/g, ' ')
    .replace(/&>\s*\S+/g, ' ');
}

/**
 * 命令风险分级。
 * @returns {{ risk: 'read'|'write'|'danger', reason?: string }}
 */
export function classifyCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { risk: 'danger', reason: '空命令' };

  for (const rule of DANGER_RULES) {
    if (rule.re.test(cmd)) return { risk: 'danger', reason: rule.reason };
  }

  // 先把「会写文件」的重定向摘出来：写重定向本身就是写操作
  const redirects = writeRedirects(cmd);
  let normalized = cmd;
  if (redirects.length > 0) {
    for (const r of redirects) normalized = normalized.split(r).join(' ');
  }
  normalized = stripFdRedirects(normalized);

  // 再按未加引号的 ; && || | 切段，只读命令可以链式组合（ps aux | grep x | head）
  const noQuote = stripQuoted(normalized);
  const segments = noQuote.split(/[;&|]+/).map(s => s.trim()).filter(Boolean);
  const bases = segments.map(s => s.split(/\s+/)[0].split('/').pop().toLowerCase()).filter(Boolean);
  const allReadonly = bases.length > 0 && bases.every(b => READONLY_BASE.has(b));

  if (redirects.length > 0) return { risk: 'write', reason: '重定向写入文件' };
  // 即使是白名单命令（docker / systemctl / service …），带写操作动词也算 write
  const hasWriteHint = WRITE_HINTS.some(re => re.test(cmd));
  if (allReadonly && !hasWriteHint) return { risk: 'read' };

  return { risk: 'write' };
}

// ─── 服务器上下文 ──────────────────────────────────────────────────────────

/** 采集脚本：一次 SSH 拿全环境信息，全部失败也允许（2>/dev/null） */
export function buildContextScript() {
  return `set +e
echo "OS:$( (lsb_release -ds 2>/dev/null || cat /etc/os-release 2>/dev/null | sed -n 's/^PRETTY_NAME=//p' | tr -d '"' | head -1) )"
echo "KERNEL:$(uname -r 2>/dev/null)"
echo "ARCH:$(uname -m 2>/dev/null)"
echo "HOSTNAME:$(hostname 2>/dev/null)"
echo "USER:$(whoami 2>/dev/null)"
echo "SHELL:$(getent passwd "$(whoami 2>/dev/null)" 2>/dev/null | cut -d: -f7)"
echo "CPUS:$(nproc 2>/dev/null)"
echo "MEM:$(free -h 2>/dev/null | awk '/^Mem:/{print $2" total, "$7" available"}')"
echo "DISK:$(df -h / 2>/dev/null | awk 'NR==2{print $2" total, "$5" used"}')"
echo "UPTIME:$(uptime -p 2>/dev/null || uptime 2>/dev/null)"
nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader 2>/dev/null | sed 's/^/GPU: /'
echo "CONTAINERS:$(docker ps --format '{{.Names}} ({{.Image}})' 2>/dev/null | head -20 | tr '\\n' ';')"
echo "LISTEN:$(ss -tlnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\\n' ' ')"
echo "DISK_FREE:$(df -h /workspace 2>/dev/null | awk 'NR==2{print $4}')"
for t in docker podman kubectl python3 pip3 node npm git systemctl journalctl nvidia-smi tmux nginx; do
  if command -v "$t" >/dev/null 2>&1; then echo "TOOL:$t"; fi
done
`;
}

/**
 * 解析采集脚本输出。
 * @returns {{ os:string, kernel:string, arch:string, hostname:string, user:string, shell:string,
 *            cpus:string, mem:string, disk:string, uptime:string, gpus:string[], containers:string[],
 *            listen:string[], tools:string[], summary:string }}
 */
export function parseContext(stdout) {
  const ctx = {
    os: '', kernel: '', arch: '', hostname: '', user: '', shell: '',
    cpus: '', mem: '', disk: '', uptime: '',
    gpus: [], containers: [], listen: [], tools: [],
  };
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    if (key === 'GPU') { if (value) ctx.gpus.push(value); continue; }
    if (key === 'CONTAINERS') {
      ctx.containers = value.split(';').map(s => s.trim()).filter(Boolean);
      continue;
    }
    if (key === 'LISTEN') { ctx.listen = value.split(/\s+/).filter(Boolean); continue; }
    if (key === 'TOOL') { if (value) ctx.tools.push(value); continue; }
    if (key === 'DISK_FREE') continue;
    const field = key.toLowerCase();
    if (field in ctx && typeof ctx[field] === 'string') ctx[field] = value;
  }
  ctx.summary = summarizeContext(ctx);
  return ctx;
}

/** 把结构化的上下文压成一段给模型看的文字 */
export function summarizeContext(ctx) {
  if (!ctx) return '';
  const lines = [];
  if (ctx.os) lines.push(`系统: ${ctx.os}${ctx.arch ? ` (${ctx.arch})` : ''}${ctx.kernel ? `, 内核 ${ctx.kernel}` : ''}`);
  if (ctx.hostname) lines.push(`主机: ${ctx.hostname}（登录用户 ${ctx.user || '?'}，shell ${ctx.shell || '?'}）`);
  if (ctx.cpus || ctx.mem) lines.push(`资源: ${ctx.cpus || '?'} 核 CPU，内存 ${ctx.mem || '?'}${ctx.disk ? `，根分区 ${ctx.disk}` : ''}`);
  if (ctx.uptime) lines.push(`运行时长: ${ctx.uptime}`);
  if (ctx.gpus.length) lines.push(`GPU: ${ctx.gpus.join(' | ')}`);
  if (ctx.containers.length) lines.push(`运行中的容器: ${ctx.containers.join(' | ')}`);
  if (ctx.listen.length) lines.push(`监听端口: ${ctx.listen.join(' ')}`);
  if (ctx.tools.length) lines.push(`已安装工具: ${ctx.tools.join(', ')}`);
  return lines.join('\n');
}

const contextCache = new Map(); // serverId → { ctx, ts }

/**
 * 取服务器上下文（带缓存）。
 * @param {string} serverId
 * @param {(id:string, cmd:string) => Promise<{stdout?:string, error?:string}>} exec
 */
export async function getServerContext(serverId, exec) {
  const cached = contextCache.get(serverId);
  if (cached && Date.now() - cached.ts < CONTEXT_TTL_MS) return cached.ctx;
  try {
    const res = await exec(serverId, buildContextScript());
    const ctx = parseContext(res?.stdout || '');
    contextCache.set(serverId, { ctx, ts: Date.now() });
    return ctx;
  } catch {
    const empty = parseContext('');
    contextCache.set(serverId, { ctx: empty, ts: Date.now() });
    return empty;
  }
}

/** 测试用：清空上下文缓存 */
export function _resetContextCache() {
  contextCache.clear();
}

// ─── Prompt ────────────────────────────────────────────────────────────────

/**
 * 构造 system prompt。
 *
 * 协议刻意用纯文本（THOUGHT/RUN/ANSWER）而不是 tool calling：
 * 本地 7B-14B 模型对 function calling 的支持很不稳定，纯文本协议在任何
 * OpenAI 兼容端点上都能跑。
 */
export function buildSystemPrompt({ context, skillContent = '', skillName = '', autoRun = true, maxSteps = MAX_STEPS } = {}) {
  const ctxText = context ? summarizeContext(context) : '';
  const mode = autoRun ? '自动执行（只读命令会直接跑，写操作会先问你）' : '逐步确认（每条命令都要你点执行）';

  const skillBlock = skillContent
    ? `\n## 用户选中的技能：${skillName}\n\n以下是该技能的标准操作流程，遇到相关任务时优先遵循：\n\n${skillContent}\n`
    : '';

  return `你是 OpenLog 的 AI Shell，一名经验丰富的 Linux 运维工程师。你**直接操作**下面这台远程服务器，通过执行命令来完成任务，而不是教用户怎么做。

## 服务器环境（实时采集）
${ctxText || '（未能采集到环境信息，请先用 uname -a / cat /etc/os-release 之类命令自行确认）'}
${skillBlock}
## 你的工作方式
每一步只输出一个动作，严格用下面的格式（不要输出 markdown 代码块，不要多余解释）：

需要执行命令时：
THOUGHT: <一句话说明为什么执行这条命令>
RUN: <单条 shell 命令>

任务完成、或无需命令即可回答时：
ANSWER: <给用户的最终回答，中文，简洁，可以分点>

## 规则
- 当前模式：${mode}
- 最多 ${maxSteps} 步。要善用管道（|）、grep、head 把输出压到几十行以内。
- 命令必须能在一次 SSH exec 里跑完（不要用 top/vim 这类需要交互的程序，用 top -bn1、ps 代替）。
- 不要重复已经执行过且成功的命令；失败时先读报错再改参数。
- **答案只能来自你实际执行过的命令输出**：没执行过的信息绝对不要写进 ANSWER，不要编造数字或时间。
- **用户要求做修改（创建/删除/重启/安装/改配置）时，必须真的执行对应命令，不能只检查现状就交差**；
  执行后用一条命令验证结果，再给 ANSWER。
- 用户只问概念/知识时直接 ANSWER，不要为了跑命令而跑命令。
- 危险操作（删除、格式化、重启、停服务）除非用户明确要求，否则不要主动做。
- ANSWER 要直接回答用户的问题，不要答非所问；先给结论，再给关键依据。
- 回答用中文。命令本身保持原样。`;
}

// ─── 模型回复解析 ──────────────────────────────────────────────────────────

/**
 * 解析模型一步输出。
 * @returns {{ type:'run'|'answer'|'unknown', thought?:string, command?:string, answer?:string }}
 */
export function parseAgentReply(raw) {
  let text = String(raw || '').trim();
  if (!text) return { type: 'unknown' };

  // 去掉整体包裹的代码块
  text = text.replace(/^```(?:bash|sh|shell|text)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // ANSWER 优先（避免答案里出现 RUN: 字样被误判；取第一次出现的位置）
  const answerMatch = text.match(/(?:^|\n)\s*(?:ANSWER|回答|答案|结论)\s*[:：]\s*([\s\S]*)$/i);
  const runMatch = text.match(/(?:^|\n)\s*(?:RUN|运行|命令|执行)\s*[:：]\s*([\s\S]*)$/i);

  const answerIdx = answerMatch ? text.search(/(?:^|\n)\s*(?:ANSWER|回答|答案|结论)\s*[:：]/i) : -1;
  const runIdx = runMatch ? text.search(/(?:^|\n)\s*(?:RUN|运行|命令|执行)\s*[:：]/i) : -1;

  if (answerIdx >= 0 && (runIdx < 0 || answerIdx < runIdx)) {
    return { type: 'answer', answer: answerMatch[1].trim() };
  }
  if (runIdx >= 0) {
    const thoughtMatch = text.match(/(?:^|\n)\s*(?:THOUGHT|思考|想法)\s*[:：]\s*([^\n]*)/i);
    // 命令取 RUN: 之后的第一段：到空行或下一个标记为止；去掉代码块的 ``` 行
    const body = runMatch[1]
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !/^```/.test(l));
    const command = (body[0] || '').replace(/^`+|`+$/g, '').trim();
    return {
      type: command ? 'run' : 'unknown',
      thought: thoughtMatch ? thoughtMatch[1].trim() : undefined,
      command,
    };
  }

  // 兜底：模型只回了一条命令（没有 RUN: 前缀）
  const firstLine = text.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
  if (firstLine && !/[\u4e00-\u9fa5]/.test(firstLine) && /^[\w./~-]+/.test(firstLine)) {
    return { type: 'run', command: firstLine.replace(/^`+|`+$/g, '') };
  }

  return { type: 'answer', answer: text };
}

// ─── 输出清洗 ──────────────────────────────────────────────────────────────

/** 回灌给模型的观测：去掉 ANSI、限制长度 */
export function toObservation(command, result, limit = OBSERVATION_LIMIT) {
  // 去掉 ANSI 转义序列（SGR 颜色等），避免污染模型上下文
  const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g');
  const strip = (s) => String(s || '').replace(ANSI_RE, '');
  let out = strip(result?.stdout || '').trim();
  let err = strip(result?.stderr || '').trim();
  const exit = result?.exitCode ?? 0;

  let body = `命令: ${command}\n退出码: ${exit}`;
  if (out) body += `\nstdout:\n${out}`;
  if (err) body += `\nstderr:\n${err}`;
  if (!out && !err) body += '\n(无输出)';
  if (result?.error) body += `\n错误: ${result.error}`;

  if (body.length > limit) {
    const head = body.slice(0, Math.floor(limit * 0.6));
    const tail = body.slice(-Math.floor(limit * 0.3));
    body = `${head}\n…（输出过长，已省略 ${body.length - limit} 字）…\n${tail}`;
  }
  return body;
}

// ─── 进度台账（长任务的关键）────────────────────────────────────────────

/** 粗略估 token（与 context-budget 的估算口径一致，避免循环依赖） */
function estimateAgentTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let wide = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) > 0x2e80) wide += 1;
  }
  return Math.ceil(wide + (s.length - wide) / 3.5);
}

/** 把结果里的关键行挑出来（进度台账只留「看了什么、成没成」，不留大段输出） */
function keyLines(result, limit = 2, lineChars = 90) {
  const pick = (s) => String(s || '')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, limit)
    .map(l => (l.length > lineChars ? `${l.slice(0, lineChars)}…` : l));
  const out = pick(result?.stdout);
  if (out.length === 0) {
    const err = pick(result?.stderr);
    return err.length > 0 ? err : ['(无输出)'];
  }
  return out;
}

/** 拼出台账文本（受 token 上限约束，超了丢最老的条目） */
export function renderDigest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const lines = entries.map((e) => {
    const head = `#${e.step} \`${e.command}\` → exit ${e.exitCode}`;
    return e.lines?.length ? `${head} | ${e.lines.join(' / ')}` : head;
  });
  // 从最老开始丢，直到放得下
  while (lines.length > 1 && estimateAgentTokens(lines.join('\n')) > DIGEST_MAX_TOKENS) lines.shift();
  return lines.join('\n');
}

/** 台账加一条；超 token 上限就丢最老的（保留最近进度） */
export function appendDigest(digest, entry) {
  const next = [...(digest || []), entry];
  while (next.length > 1 && estimateAgentTokens(renderDigest(next)) > DIGEST_MAX_TOKENS) next.shift();
  while (next.length > 60) next.shift();
  return next;
}

// ─── agent 循环 ────────────────────────────────────────────────────────────

/**
 * 跑一次 agent 任务。
 *
 * @param {object} opts
 * @param {string} opts.serverId
 * @param {string} opts.text 用户任务
 * @param {Array<{role:string, content:string}>} [opts.history] 之前的对话
 * @param {string} [opts.skillContent]
 * @param {string} [opts.skillName]
 * @param {boolean} [opts.autoRun]
 * @param {number} [opts.maxSteps]
 * @param {AbortSignal} [opts.signal]
 * @param {(payload:object)=>void} opts.send 事件推送
 * @param {(messages:object[], signal:AbortSignal)=>Promise<{content:string}>} opts.callModel
 * @param {(serverId:string, command:string, opts:object)=>Promise<object>} opts.execStream
 * @param {(state:{risk:string, command:string, thought?:string})=>Promise<boolean>} [opts.confirm]
 * @param {number} [opts.windowTokens] 模型上下文窗口（探测得到；不传按 8192 保守处理）
 * @param {object} [opts.resume] 上次中断（max_steps）时的状态：继续跑时带上，进度不丢
 * @returns {Promise<{status:'done'|'cancelled'|'error'|'max_steps'|'timeout', steps:number, answer?:string, resumeState?:object}>}
 */
export async function runAgent(opts) {
  const {
    serverId, text, history = [], skillContent = '', skillName = '',
    autoRun = true, maxSteps = MAX_STEPS, signal, send, callModel, execStream, confirm,
    execContext = execStream,
    windowTokens,
    resume,
    maxWallMs,
    /** 本轮附带的图片（OpenAI vision parts）；只在第一条 user 消息里用 */
    images = [],
  } = opts;

  // ── 上下文预算（小窗口模型的关键）────────────────────────────────────
  // 16k 及以下的模型：system + 历史 + 每步最多几千字符的命令输出，几步就超窗；
  // 很多引擎超窗不报错而是静默截断，模型就会忘任务/乱造命令。这里先算预算，
  // 再按窗口收缩「单条命令输出上限」，并每步裁剪消息（步数不砍死，靠进度台账保连续性）。
  const win = Number(windowTokens) > 0 ? Number(windowTokens) : 8192;
  const isSmallWindow = win <= 16_384;
  const observationLimit = isSmallWindow ? 1800 : (win <= 32_768 ? 3200 : OBSERVATION_LIMIT);
  // 步数上限由前端可调（默认 24，硬上限 64）。小窗口不再额外砍半 —— 长任务靠台账 + 压缩撑着，
  // 砍步数只会让用户「任务做一半就停」。
  const requestedSteps = Math.floor(Number(maxSteps));
  const effectiveMaxSteps = Math.min(
    Math.max(1, Number.isFinite(requestedSteps) && requestedSteps > 0 ? requestedSteps : MAX_STEPS),
    MAX_STEPS_CAP,
  );
  // 时长上限同样可调（默认 20 分钟，硬上限 60 分钟）
  const requestedWall = Number(maxWallMs);
  const wallLimitMs = Math.min(
    Math.max(60_000, Number.isFinite(requestedWall) && requestedWall > 0 ? requestedWall : MAX_WALL_MS),
    MAX_WALL_CAP_MS,
  );

  // ── 进度台账：长任务的核心 ────────────────────────────────────────────
  // 上下文被压缩后，模型会忘掉「前面查过什么、哪条路失败了」。这里把每一步压成一行
  // （步号 + 命令 + 退出码 + 关键输出），钉在 system prompt 里 —— 即使历史被裁掉，
  // 模型仍然知道自己干到哪了，不会重复执行、也不会把已经确认的结论再查一遍。
  let digest = Array.isArray(resume?.digest) ? [...resume.digest] : [];
  let ranMutating = resume?.ranMutating === true;

  const context = await getServerContext(serverId, (id, cmd) => execContext(id, cmd, { timeoutMs: 15_000 }));
  send({ type: 'context_ready', context: { summary: context.summary } });

  // system prompt（可能包含用户选中的技能，内容可能非常大）
  let skillText = skillContent;
  let baseSystem = buildSystemPrompt({ context, skillContent: skillText, skillName, autoRun, maxSteps: effectiveMaxSteps });
  let plan = planBudget({
    windowTokens: win,
    maxOutputTokens: 1200,
    fixedTokens: estimateAgentTokens(baseSystem),
  });

  // system 自己就吃掉大半个窗口（典型原因：选中的技能文档很长）→ 截断技能再重算，
  // 否则消息再怎么压都放不下，引擎只会静默截断，模型直接开始胡说。
  if (skillText && estimateAgentTokens(baseSystem) > plan.promptBudget * 0.85) {
    const targetSystem = Math.max(512, Math.floor(plan.promptBudget * 0.6));
    const excess = estimateAgentTokens(baseSystem) - targetSystem;
    const cutSkill = truncateTextToTokens(skillText, Math.max(128, estimateAgentTokens(skillText) - excess));
    if (cutSkill.truncated) {
      skillText = cutSkill.text;
      baseSystem = buildSystemPrompt({ context, skillContent: skillText, skillName, autoRun, maxSteps: effectiveMaxSteps });
      plan = planBudget({ windowTokens: win, maxOutputTokens: 1200, fixedTokens: estimateAgentTokens(baseSystem) });
      send({
        type: 'context_trimmed',
        windowTokens: plan.windowTokens,
        promptBudget: plan.promptBudget,
        tokens: estimateAgentTokens(baseSystem),
        compressed: 0,
        dropped: 0,
        message: `技能内容约 ${estimateAgentTokens(skillContent)} tokens，超过模型窗口能容纳的范围，已截断技能说明（保留开头和结尾）`,
      });
    }
  }

  const systemContent = () => {
    if (digest.length === 0) return baseSystem;
    return `${baseSystem}

## 已执行步骤（进度台账，按顺序；被上下文压缩后仍然保留）
${renderDigest(digest)}

下一步请基于上面的进度继续：不要重复已经成功执行过的命令，不要重新查已经确认过的结论；已经完成就给出 ANSWER。`;
  };

  let messages;
  if (resume?.messages?.length) {
    // 继续上次任务：沿用原来的对话（system 会按最新台账重建）
    messages = [{ role: 'system', content: systemContent() }, ...resume.messages.filter(m => m?.role !== 'system')];
    messages.push({ role: 'user', content: '继续完成这个任务：从上次的进度接着做，不要重复已经执行过的步骤。' });
  } else {
    // 图片只挂在**本轮**这条 user 消息上；history 里即使残留图片 part 也剥成文字，
    // 否则每步重发一遍图片，几步就把小窗口模型的上下文吃光。
    const historyText = history
      .filter(h => h && h.role && h.content)
      .map(h => ({ ...h, content: contentText(h.content) }));
    const userText = typeof text === 'string' ? text : JSON.stringify(text);
    const userParts = Array.isArray(images) && images.length > 0
      ? normalizeContent([{ type: 'text', text: userText }, ...images])
      : null;
    messages = [
      { role: 'system', content: systemContent() },
      ...historyText,
      {
        role: 'user',
        // 校验失败（图片过大/格式不对）就退回纯文本，不让整轮任务失败
        content: userParts && userParts.ok ? userParts.content : userText,
      },
    ];
  }

  send({
    type: 'context_budget',
    windowTokens: plan.windowTokens,
    promptBudget: plan.promptBudget,
    outputTokens: plan.outputTokens,
    observationLimit,
    maxSteps: effectiveMaxSteps,
    warnings: plan.warnings,
  });

  /** 每步请求模型前裁剪一次（返回是否发生了裁剪） */
  let trimmedTimes = 0;
  const fitBeforeCall = () => {
    messages[0] = { ...messages[0], content: systemContent() };
    const fit = fitAgentMessages(messages, { promptBudget: plan.promptBudget });
    if (fit.messages !== messages) {
      for (let i = messages.length - 1; i >= 0; i--) messages.pop();
      messages.push(...fit.messages);
      trimmedTimes += 1;
      send({
        type: 'context_trimmed',
        windowTokens: plan.windowTokens,
        promptBudget: plan.promptBudget,
        tokens: fit.tokens,
        dropped: fit.dropped,
        compressed: fit.compressed,
        message: `模型窗口约 ${plan.windowTokens} tokens，已压缩 ${fit.compressed} 条较早命令输出${fit.dropped ? `、丢弃 ${fit.dropped} 条最老对话` : ''}（进度台账已保留，任务不会丢）`,
      });
    }
  };
  fitBeforeCall();

  /** 步数/时长用尽时保存状态，前端点「继续」可以从这里接着跑 */
  const makeResumeState = () => ({
    messages: messages.slice(1).filter(m => m?.role !== 'system').slice(-12),
    digest,
    ranMutating,
    stepsDone: step,
  });

  let step = Number(resume?.stepsDone) || 0;
  /** 本次运行的步数上限 = 已有步数 + 本次允许的新步数（继续时能接着跑，而不是立刻又停） */
  const stepLimit = step + effectiveMaxSteps;
  let nudged = false;
  /** 已经执行过的命令（用于发现原地打转） */
  const executedCommands = new Map();
  const startedAt = Date.now();

  try {
    while (step < stepLimit) {
      if (signal?.aborted) return { status: 'cancelled', steps: step };
      if (Date.now() - startedAt > wallLimitMs) {
        send({ type: 'agent_paused', steps: step, reason: 'time', digest });
        return {
          status: 'max_steps',
          steps: step,
          answer: `任务已执行 ${step} 步、超过 ${Math.round(wallLimitMs / 60000)} 分钟上限，先停在这里。可以点「继续」接着跑（或把「时长」调大）。`,
          resumeState: makeResumeState(),
        };
      }
      step += 1;
      send({ type: 'step_start', step });

      // 1) 让模型决定这一步做什么（流式 thinking）
      fitBeforeCall();
      const reply = await callModel(messages, signal);
      const parsed = parseAgentReply(reply?.content || '');
      if (parsed.thought) send({ type: 'thought', step, content: parsed.thought });

      // 2) 结论：结束
      if (parsed.type === 'answer') {
        // 「只查不干」兜底：用户明确要求改东西，但全程没执行过任何写命令 —— 催一次
        const wantsAction = ACTION_INTENT_RE.test(String(text));
        if (wantsAction && !ranMutating && !nudged && step < stepLimit) {
          nudged = true;
          send({ type: 'nudge', step, content: '要求执行修改但还没动手，促使模型继续' });
          messages.push({ role: 'assistant', content: `ANSWER: ${parsed.answer || ''}` });
          messages.push({
            role: 'user',
            content: '注意：这个任务要求实际执行修改操作，但你还没有执行任何写命令。请继续完成（先执行对应命令，再验证结果）；确实无法完成时说明具体原因。',
          });
          continue;
        }
        send({ type: 'final', step, content: parsed.answer || '' });
        return { status: 'done', steps: step, answer: parsed.answer || '' };
      }
      if (parsed.type !== 'run' || !parsed.command) {
        // 模型输出既不是命令也不是明确 ANSWER 时，宁可把它当回答显示，也不要静默丢弃内容
        const fallback = String(reply?.content || '').trim();
        send({
          type: 'final',
          step,
          content: fallback
            ? fallback.replace(/```[a-zA-Z]*\n?/g, '').trim()
            : '模型没有给出可执行的命令或结论，请补充更具体的需求。',
        });
        return { status: 'done', steps: step, answer: fallback || undefined };
      }

      // 3) 防原地打转：同一条命令重复执行没有意义（上下文压缩后模型容易忘）
      const cmdKey = String(parsed.command).replace(/\s+/g, ' ').trim();
      const prevStep = executedCommands.get(cmdKey);
      if (prevStep) {
        messages.push({ role: 'assistant', content: `RUN: ${parsed.command}` });
        messages.push({
          role: 'user',
          content: `这条命令在第 ${prevStep} 步已经执行过了，不要重复执行。请基于上面已有的输出换一个思路或参数；如果信息已经够了，直接给 ANSWER。`,
        });
        send({ type: 'progress', step, message: '检测到重复命令，已提醒模型换思路' });
        continue;
      }

      // 4) 风险分级 → 可能需要用户确认
      const risk = classifyCommand(parsed.command);
      send({ type: 'command_ready', step, command: parsed.command, risk: risk.risk, reason: risk.reason || null });
      const needConfirm = risk.risk === 'danger' || (risk.risk === 'write' && !autoRun);
      if (needConfirm) {
        if (!confirm) {
          send({ type: 'command_rejected', step, command: parsed.command, reason: '需要确认但当前会话不支持确认' });
          return { status: 'done', steps: step };
        }
        const allowed = await confirm({ risk: risk.risk, command: parsed.command, thought: parsed.thought });
        if (!allowed) {
          send({ type: 'command_rejected', step, command: parsed.command, reason: '用户拒绝执行' });
          // 拒绝要明确：不要再绕道用别的命令达成同一目的
          messages.push({ role: 'assistant', content: `RUN: ${parsed.command}` });
          messages.push({
            role: 'user',
            content: `用户拒绝执行这条命令${risk.reason ? `（风险：${risk.reason}）` : ''}。不要再尝试用其它命令达成同样的目的；如果这个目标必须修改服务器状态，请直接说明需要用户手动处理，并给出建议步骤。`,
          });
          digest = appendDigest(digest, { step, command: parsed.command, exitCode: '拒绝', lines: ['用户拒绝执行'] });
          continue;
        }
      }

      // 5) 流式执行
      send({ type: 'command_start', step, command: parsed.command });
      if (risk.risk !== 'read') ranMutating = true;
      const result = await execStream(serverId, parsed.command, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
        onStdout: (chunk) => send({ type: 'command_output', step, stream: 'stdout', data: chunk }),
        onStderr: (chunk) => send({ type: 'command_output', step, stream: 'stderr', data: chunk }),
      });
      if (signal?.aborted) return { status: 'cancelled', steps: step };
      const exitCode = result?.exitCode ?? (result?.success ? 0 : -1);
      send({ type: 'command_done', step, exitCode });

      // 6) 观测回灌 + 记进度台账（台账钉在 system 里，历史被压缩也不会丢）
      messages.push({ role: 'assistant', content: `RUN: ${parsed.command}` });
      messages.push({ role: 'user', content: `[命令输出]\n${toObservation(parsed.command, result, observationLimit)}` });
      executedCommands.set(cmdKey, step);
      digest = appendDigest(digest, {
        step,
        command: parsed.command,
        exitCode,
        lines: keyLines(result),
      });
      send({ type: 'progress', step, digest: renderDigest(digest) });
    }
    // 步数用尽：保存进度，前端点「继续」可以从这里接着跑
    const historyText = digest.length
      ? `已执行 ${step} 步（最多 ${effectiveMaxSteps} 步）。进度：\n${renderDigest(digest)}`
      : `已执行 ${step} 步（最多 ${effectiveMaxSteps} 步）。`;
    send({ type: 'agent_paused', steps: step, reason: 'steps', digest });
    return {
      status: 'max_steps',
      steps: step,
      answer: `${historyText}\n\n任务还没结束 —— 点「继续」可以接着跑（进度已保存，不会从头再来）。`,
      resumeState: makeResumeState(),
    };
  } catch (err) {
    if (signal?.aborted) return { status: 'cancelled', steps: step };
    const message = errorMessage(err);
    send({ type: 'error', step, error: message });
    return { status: 'error', steps: step, answer: message, resumeState: makeResumeState() };
  }
}
