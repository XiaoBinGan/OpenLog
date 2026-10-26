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

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** agent 循环最多步数 */
export const MAX_STEPS = 6;
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
 * @returns {Promise<{status:'done'|'cancelled'|'error'|'max_steps', steps:number, answer?:string}>}
 */
export async function runAgent(opts) {
  const {
    serverId, text, history = [], skillContent = '', skillName = '',
    autoRun = true, maxSteps = MAX_STEPS, signal, send, callModel, execStream, confirm,
    execContext = execStream,
  } = opts;

  const context = await getServerContext(serverId, (id, cmd) => execContext(id, cmd, { timeoutMs: 15_000 }));
  send({ type: 'context_ready', context: { summary: context.summary } });

  const messages = [
    { role: 'system', content: buildSystemPrompt({ context, skillContent, skillName, autoRun, maxSteps }) },
    ...history.filter(h => h && h.role && h.content),
    { role: 'user', content: typeof text === 'string' ? text : JSON.stringify(text) },
  ];

  let step = 0;
  let ranMutating = false;
  let nudged = false;
  try {
    while (step < maxSteps) {
      if (signal?.aborted) return { status: 'cancelled', steps: step };
      step += 1;
      send({ type: 'step_start', step });

      // 1) 让模型决定这一步做什么（流式 thinking）
      const reply = await callModel(messages, signal);
      const parsed = parseAgentReply(reply?.content || '');
      if (parsed.thought) send({ type: 'thought', step, content: parsed.thought });

      // 2) 结论：结束
      if (parsed.type === 'answer') {
        // 「只查不干」兜底：用户明确要求改东西，但全程没执行过任何写命令 —— 催一次
        const wantsAction = ACTION_INTENT_RE.test(String(text));
        if (wantsAction && !ranMutating && !nudged && step < maxSteps) {
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
        send({ type: 'final', step, content: '模型没有给出可执行的命令或结论，请补充更具体的需求。' });
        return { status: 'done', steps: step };
      }

      // 3) 风险分级 → 可能需要用户确认
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
          // 把拒绝也告诉模型，让它换方案
          messages.push({ role: 'assistant', content: `RUN: ${parsed.command}` });
          messages.push({ role: 'user', content: `用户拒绝执行这条命令${risk.reason ? `（风险：${risk.reason}）` : ''}，请换一种更安全的方式完成目标。` });
          continue;
        }
      }

      // 4) 流式执行
      send({ type: 'command_start', step, command: parsed.command });
      if (risk.risk !== 'read') ranMutating = true;
      const result = await execStream(serverId, parsed.command, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
        onStdout: (chunk) => send({ type: 'command_output', step, stream: 'stdout', data: chunk }),
        onStderr: (chunk) => send({ type: 'command_output', step, stream: 'stderr', data: chunk }),
      });
      if (signal?.aborted) return { status: 'cancelled', steps: step };
      send({ type: 'command_done', step, exitCode: result?.exitCode ?? (result?.success ? 0 : -1) });

      // 5) 观测回灌，进入下一轮
      messages.push({ role: 'assistant', content: `RUN: ${parsed.command}` });
      messages.push({ role: 'user', content: `[命令输出]\n${toObservation(parsed.command, result)}` });
    }
    send({ type: 'final', step, content: `已达到最大步数（${maxSteps} 步）仍未完成。可以让我继续，或把任务拆小一点。` });
    return { status: 'max_steps', steps: step };
  } catch (err) {
    if (signal?.aborted) return { status: 'cancelled', steps: step };
    const message = errorMessage(err);
    send({ type: 'error', step, error: message });
    return { status: 'error', steps: step, answer: message };
  }
}
