/**
 * agent-tools.js — 运维助手的「动手能力」：远程服务器上的定位、改代码、改配置。
 *
 * 背景：原来的助手只有读能力（docker_list / remote_read_file / remote_exec），
 * 定位得到问题也改不了，只能告诉用户「你去改一下第 42 行」。这个模块补上写能力，
 * 并给所有写操作加三道闸：
 *
 *   1. **风险分级**（classifyToolRisk）：read 直接跑；write / danger 必须用户确认；
 *   2. **自动备份**（.openlog-bak.<时间戳>）：写前备份，改错了能回滚；
 *   3. **精确替换**（applyStringEdit）：默认要求 old_string 唯一，避免「替换到别处」。
 *
 * 本模块不依赖 index.js / remote.js：命令执行通过参数注入，纯逻辑（路径校验、
 * 字符串替换、grep 命令拼装、风险分级）都是可单测的纯函数。
 */

/** 读写文件大小上限，防止把几百 MB 的文件塞进 LLM 上下文 */
import { classifyCommandRisk } from './security/command-risk.js';

export const MAX_READ_BYTES = 200 * 1024;
export const MAX_WRITE_BYTES = 512 * 1024;
/** grep 结果上限 */
export const MAX_GREP_MATCHES = 80;
/** 备份后缀 */
export const BACKUP_SUFFIX = '.openlog-bak';

// ─── 路径安全 ──────────────────────────────────────────────────────────────

/** 绝对路径、无 shell 元字符（我们用单引号包裹，但仍然拒绝危险字符） */
export function validateRemotePath(input) {
  const p = String(input || '').trim();
  if (!p) return { ok: false, error: '路径为空' };
  if (!p.startsWith('/')) return { ok: false, error: '必须是绝对路径（以 / 开头）' };
  if (p.includes('\0')) return { ok: false, error: '路径含非法字符' };
  if (/\n|\r/.test(p)) return { ok: false, error: '路径不能包含换行' };
  // 允许中文/空格/常见符号，拒绝会破坏引号的字符
  if (/['"`]/.test(p)) return { ok: false, error: '路径不能包含引号' };
  return { ok: true, path: p };
}

/** 单引号安全包裹（POSIX shell） */
export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/** 这些路径的写入即便用户确认也要额外提示（系统关键文件） */
export const SENSITIVE_PATH_PATTERNS = [
  /^\/etc\//,
  /^\/boot\//,
  /^\/sys\//,
  /^\/proc\//,
  /\/\.ssh\//,
  /^\/root\//,
  /^\/var\/lib\/docker\//,
];

export function isSensitivePath(path) {
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(String(path || '')));
}

// ─── 纯函数：字符串精确替换 ────────────────────────────────────────────────

/**
 * 在文本里做精确替换。
 *
 * 为什么不用 sed：sed 的表达式要转义、跨行替换难、还容易误伤。
 * 这里在 Node 侧算好，把整份新内容 base64 传过去覆盖写。
 *
 * @param {string} content 原内容
 * @param {string} oldString 要替换的原文
 * @param {string} newString 替换成
 * @param {boolean} [replaceAll] 是否替换全部（默认 false，要求唯一）
 * @returns {{ ok:boolean, content?:string, count?:number, error?:string }}
 */
export function applyStringEdit(content, oldString, newString, replaceAll = false) {
  const src = String(content ?? '');
  const from = String(oldString ?? '');
  const to = String(newString ?? '');

  if (!from) return { ok: false, error: 'old_string 不能为空' };
  if (from === to) return { ok: false, error: 'old_string 与 new_string 相同，没有变化' };

  // 统计出现次数
  let count = 0;
  let idx = src.indexOf(from);
  while (idx !== -1) {
    count += 1;
    idx = src.indexOf(from, idx + from.length);
  }

  if (count === 0) {
    return { ok: false, error: '文件里找不到 old_string（请先用 remote_read_file 确认原文，注意缩进和换行）' };
  }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      count,
      error: `old_string 在文件里出现了 ${count} 次，不唯一。请扩大上下文让它唯一，或显式设置 replace_all=true`,
    };
  }

  const next = replaceAll ? src.split(from).join(to) : src.replace(from, to);
  return { ok: true, content: next, count };
}

/** 生成简短的变更预览（给用户确认弹框看） */
export function buildEditPreview(oldString, newString, replaceAll = false) {
  const from = String(oldString ?? '');
  const to = String(newString ?? '');
  const clip = (s, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return [
    `- ${clip(from).replace(/\n/g, '\n- ')}`,
    `+ ${clip(to).replace(/\n/g, '\n+ ')}`,
    replaceAll ? '（替换全部匹配）' : '',
  ].filter(Boolean).join('\n');
}

// ─── 纯函数：grep 命令拼装 ────────────────────────────────────────────────

/**
 * 拼一条 grep 命令（用于「错误定位」：在代码/配置/日志里找关键字）。
 * @param {{pattern:string, path:string, glob?:string, maxMatches?:number, context?:number, caseSensitive?:boolean}} opts
 */
export function buildGrepCommand({ pattern, path: targetPath, glob, maxMatches = MAX_GREP_MATCHES, context = 0, caseSensitive = false }) {
  const pat = String(pattern || '');
  if (!pat) return { ok: false, error: 'pattern 不能为空' };
  const pathCheck = validateRemotePath(targetPath || '/');
  if (!pathCheck.ok) return pathCheck;

  const parts = ['grep', '-rnI', '--color=never'];
  if (!caseSensitive) parts.push('-i');
  if (glob) parts.push(`--include=${shellQuote(glob)}`);
  if (context > 0) parts.push(`-C ${Math.min(5, Math.floor(context))}`);
  parts.push(`-m ${Math.max(1, Math.floor(maxMatches))}`);
  parts.push('-E', shellQuote(pat), shellQuote(pathCheck.path));
  parts.push('2>/dev/null', `| head -n ${maxMatches * (context > 0 ? 3 : 1)}`);

  return { ok: true, command: parts.join(' ') };
}

/** 拼「读文件」命令：整份 or 指定行区间 */
export function buildReadFileCommand(path, options = {}) {
  const check = validateRemotePath(path);
  if (!check.ok) return check;
  const { startLine, endLine } = options;
  if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
    const s = Math.max(1, Math.floor(startLine));
    const e = Math.max(s, Math.floor(endLine));
    // 只用一个 awk 完成「取行区间 + 加行号」，避免 sed | awk 的引号嵌套坑
    return {
      ok: true,
      command: `awk 'NR>=${s} && NR<=${e} {printf "%d\\t%s\\n", NR, $0}' ${shellQuote(check.path)}`,
    };
  }
  return {
    ok: true,
    command: `wc -c < ${shellQuote(check.path)} | awk '{print "BYTES:"$1}'; cat ${shellQuote(check.path)}`,
  };
}

// ─── 风险分级 ──────────────────────────────────────────────────────────────

/** 读类：直接执行 */
const READ_TOOLS = new Set([
  'remote_stat', 'remote_ls', 'remote_read_file', 'remote_grep',
  'remote_git_status', 'remote_git_diff',
  // 既有只读工具（chat.js 里的老工具，都是查询类，不该弹确认）
  'docker_list', 'docker_logs', 'docker_inspect', 'docker_health_check',
  'remote_servers', 'remote_system_stats', 'remote_list_files',
  'remote_read_file', 'remote_search_logs',
  'local_system_stats', 'local_log_files', 'local_read_log',
]);

/** 写类：需要用户确认（改了能回滚） */
const WRITE_TOOLS = new Set([
  'remote_write_file', 'remote_edit_file', 'remote_mkdir',
]);

/** 危险类：需要用户确认，且界面要红字强调 */
const DANGER_TOOLS = new Set([
  'remote_exec', 'remote_delete_file', 'remote_restart_service', 'remote_rollback_file',
  'docker_start', 'docker_stop', 'docker_restart', 'docker_exec',
]);

/**
 * 给一次工具调用分级。
 * @param {string} name
 * @param {object} args
 * @returns {{ risk:'read'|'write'|'danger', reason?:string }}
 */
export function classifyToolRisk(name, args = {}) {
  if (DANGER_TOOLS.has(name)) {
    // 命令执行类工具：按命令内容分级。
    // 只读查询（ls/cat/grep/ps/curl GET/docker ps/nginx -T…）不改变系统状态，
    // 直接执行 —— 否则一次排查要弹十几次确认框，人被点烦了就会盲点「批准」，
    // 反而削弱了确认机制的意义。写操作/破坏性命令仍然必须确认。
    if (name === 'remote_exec' || name === 'docker_exec') {
      const cmd = String(args.command || '');
      const verdict = classifyCommandRisk(cmd);
      if (verdict.readonly) return { risk: 'read', reason: verdict.reason };
      if (/(rm\s+-[a-zA-Z]*[rf]|mkfs|dd\s+[^|]*of=|shutdown|reboot|>\/etc\/|iptables\s+-F)/.test(cmd)) {
        return { risk: 'danger', reason: '疑似破坏性命令' };
      }
      return { risk: 'danger', reason: verdict.reason || '会改变系统状态' };
    }
    if (name === 'remote_delete_file') return { risk: 'danger', reason: '删除文件' };
    if (name === 'remote_restart_service') return { risk: 'danger', reason: '重启系统服务' };
    return { risk: 'danger', reason: '会改变运行状态' };
  }
  if (WRITE_TOOLS.has(name)) {
    const target = args.filePath || args.path || '';
    if (isSensitivePath(target)) return { risk: 'danger', reason: `写入系统关键路径 ${target}` };
    return { risk: 'write', reason: `修改文件 ${target || ''}`.trim() };
  }
  if (READ_TOOLS.has(name)) return { risk: 'read' };
  return { risk: 'write', reason: '未知工具按写操作处理' };
}

// ─── 工具定义（给 OpenAI function calling） ────────────────────────────────

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'remote_stat',
      description: '查看远程文件/目录的属性（大小、修改时间、权限、是否目录）',
      parameters: { type: 'object', properties: { serverId: { type: 'string' }, path: { type: 'string', description: '绝对路径' } }, required: ['serverId', 'path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_ls',
      description: '列远程目录内容（含权限/大小/时间，按修改时间倒序）',
      parameters: { type: 'object', properties: { serverId: { type: 'string' }, path: { type: 'string', description: '绝对路径，默认 /' } }, required: ['serverId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_read_file',
      description: '读远程文件内容（带行号）。可指定行区间；超 200KB 会截断并提示',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
          filePath: { type: 'string' },
          startLine: { type: 'number', description: '起始行（1-based，可选）' },
          endLine: { type: 'number', description: '结束行（可选）' },
        },
        required: ['serverId', 'filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_grep',
      description: '在远程目录/文件里搜索内容（错误定位最常用）：返回 文件:行号:内容',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
          pattern: { type: 'string', description: '正则（grep -E）' },
          path: { type: 'string', description: '搜索目录或文件，绝对路径' },
          glob: { type: 'string', description: '只搜匹配的文件，如 *.py / *.yaml' },
          context: { type: 'number', description: '上下文行数，0-5' },
          caseSensitive: { type: 'boolean' },
        },
        required: ['serverId', 'pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_edit_file',
      description: '精确替换远程文件里的片段（改代码/改配置）。old_string 必须唯一；写前自动备份',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
          filePath: { type: 'string' },
          oldString: { type: 'string', description: '要替换的原文（含缩进，必须与文件完全一致）' },
          newString: { type: 'string', description: '替换后的内容' },
          replaceAll: { type: 'boolean', description: '是否替换所有匹配（默认 false，要求唯一）' },
        },
        required: ['serverId', 'filePath', 'oldString', 'newString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_write_file',
      description: '整份写入远程文件（新建或覆盖）。写前自动备份原文件',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
          filePath: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['serverId', 'filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_rollback_file',
      description: '用最近一次自动备份回滚远程文件',
      parameters: { type: 'object', properties: { serverId: { type: 'string' }, filePath: { type: 'string' } }, required: ['serverId', 'filePath'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_git_status',
      description: '查看远程仓库状态（git status --short + 当前分支 + 最近提交）',
      parameters: { type: 'object', properties: { serverId: { type: 'string' }, repoPath: { type: 'string', description: '仓库根目录' } }, required: ['serverId', 'repoPath'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_git_diff',
      description: '查看远程仓库改动（git diff，可指定文件）',
      parameters: { type: 'object', properties: { serverId: { type: 'string' }, repoPath: { type: 'string' }, filePath: { type: 'string', description: '只看某个文件（可选）' } }, required: ['serverId', 'repoPath'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_restart_service',
      description: '⚠️ 重启远程 systemd 服务（如 nginx / docker / openlog），需要确认',
      parameters: { type: 'object', properties: { serverId: { type: 'string' }, service: { type: 'string', description: '服务名，如 nginx' } }, required: ['serverId', 'service'] },
    },
  },
];

// ─── 执行器 ────────────────────────────────────────────────────────────────

/**
 * 执行 agent 工具。
 *
 * @param {string} name
 * @param {object} args
 * @param {object} ctx
 * @param {(serverId:string, command:string) => Promise<{stdout?:string,stderr?:string,exitCode?:number,error?:string}>} ctx.exec
 * @param {(serverId:string) => Promise<void>} [ctx.ensureConnected]
 * @returns {Promise<object>} 结果对象（出错返回 { error }）
 */
export async function executeAgentTool(name, args, ctx) {
  const { exec, ensureConnected } = ctx;
  const serverId = args.serverId;
  if (!serverId) return { error: '缺少 serverId（先调用 remote_servers 查可用服务器）' };

  const run = async (command) => {
    if (ensureConnected) await ensureConnected(serverId);
    const r = await exec(serverId, command);
    if (r?.error) throw new Error(r.error);
    return r;
  };

  try {
    switch (name) {
      case 'remote_stat': {
        const p = validateRemotePath(args.path);
        if (!p.ok) return p;
        const r = await run(`if [ -d ${shellQuote(p.path)} ]; then echo DIR; stat -c 'size=%s mtime=%y mode=%a owner=%U:%G' ${shellQuote(p.path)}; elif [ -e ${shellQuote(p.path)} ]; then echo FILE; stat -c 'size=%s mtime=%y mode=%a owner=%U:%G' ${shellQuote(p.path)}; else echo MISSING; fi`);
        const out = String(r.stdout || '');
        return {
          path: p.path,
          exists: !out.includes('MISSING'),
          isDirectory: out.startsWith('DIR'),
          raw: out.trim(),
        };
      }
      case 'remote_ls': {
        const p = validateRemotePath(args.path || '/');
        if (!p.ok) return p;
        const r = await run(`ls -laht --time-style=+'%Y-%m-%d %H:%M' ${shellQuote(p.path)} 2>&1 | head -n 120`);
        return { path: p.path, listing: String(r.stdout || '').trim() };
      }
      case 'remote_read_file': {
        const p = validateRemotePath(args.filePath);
        if (!p.ok) return p;
        const cmd = buildReadFileCommand(p.path, { startLine: args.startLine, endLine: args.endLine });
        if (!cmd.ok) return cmd;
        const r = await run(cmd.command);
        let content = String(r.stdout || '');
        let truncated = false;
        const bytesMatch = content.match(/^BYTES:(\d+)\n/);
        if (bytesMatch) {
          const bytes = Number(bytesMatch[1]);
          content = content.slice(bytesMatch[0].length);
          if (bytes > MAX_READ_BYTES) {
            content = content.slice(0, MAX_READ_BYTES);
            truncated = true;
          }
        }
        return {
          path: p.path,
          bytes: bytesMatch ? Number(bytesMatch[1]) : Buffer.byteLength(content),
          truncated,
          content,
          ...(truncated ? { note: `文件超过 ${Math.round(MAX_READ_BYTES / 1024)}KB，已截断；请用 startLine/endLine 分段读` } : {}),
        };
      }
      case 'remote_grep': {
        const cmd = buildGrepCommand({ pattern: args.pattern, path: args.path, glob: args.glob, context: args.context, caseSensitive: args.caseSensitive });
        if (!cmd.ok) return cmd;
        const r = await run(cmd.command);
        const text = String(r.stdout || '').trim();
        return {
          pattern: args.pattern,
          path: args.path,
          matchCount: text ? text.split('\n').length : 0,
          matches: text || '(无匹配)',
        };
      }
      case 'remote_edit_file': {
        const p = validateRemotePath(args.filePath);
        if (!p.ok) return p;
        const read = await run(`cat ${shellQuote(p.path)} 2>&1`);
        if (read.exitCode !== 0) return { error: `读取失败: ${read.stderr || read.stdout}` };
        const original = String(read.stdout || '');
        if (Buffer.byteLength(original) > MAX_WRITE_BYTES) {
          return { error: `文件超过 ${Math.round(MAX_WRITE_BYTES / 1024)}KB，拒绝在线编辑（请用 remote_exec 配合 sed 等工具）` };
        }
        const edited = applyStringEdit(original, args.oldString, args.newString, args.replaceAll);
        if (!edited.ok) return { error: edited.error, count: edited.count };

        const backup = await run(`cp -p ${shellQuote(p.path)} ${shellQuote(p.path + BACKUP_SUFFIX + '.' + Date.now())} && echo OK`);
        const written = await writeFileRemote(run, p.path, edited.content);
        if (!written.ok) return { error: written.error };
        return {
          success: true,
          path: p.path,
          replacements: edited.count,
          backupCreated: backup.exitCode === 0,
          preview: buildEditPreview(args.oldString, args.newString, args.replaceAll),
          note: '已备份原文件；如需回滚可调用 remote_rollback_file',
        };
      }
      case 'remote_write_file': {
        const p = validateRemotePath(args.filePath);
        if (!p.ok) return p;
        const content = String(args.content ?? '');
        if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
          return { error: `内容超过 ${Math.round(MAX_WRITE_BYTES / 1024)}KB，拒绝写入` };
        }
        // 存在才备份
        const exists = await run(`test -e ${shellQuote(p.path)} && echo YES || echo NO`);
        const hadFile = String(exists.stdout || '').includes('YES');
        if (hadFile) {
          await run(`cp -p ${shellQuote(p.path)} ${shellQuote(p.path + BACKUP_SUFFIX + '.' + Date.now())} 2>/dev/null; mkdir -p $(dirname ${shellQuote(p.path)})`);
        } else {
          await run(`mkdir -p $(dirname ${shellQuote(p.path)})`);
        }
        const written = await writeFileRemote(run, p.path, content);
        if (!written.ok) return { error: written.error };
        return { success: true, path: p.path, bytes: Buffer.byteLength(content), backupCreated: hadFile };
      }
      case 'remote_rollback_file': {
        const p = validateRemotePath(args.filePath);
        if (!p.ok) return p;
        const find = await run(`ls -1t ${shellQuote(p.path + BACKUP_SUFFIX)}.* 2>/dev/null | head -n 1`);
        const backupPath = String(find.stdout || '').trim();
        if (!backupPath) return { error: '没有找到自动备份，无法回滚' };
        const r = await run(`cp -p ${shellQuote(backupPath)} ${shellQuote(p.path)} && echo OK`);
        return { success: r.exitCode === 0, path: p.path, restoredFrom: backupPath };
      }
      case 'remote_git_status': {
        const p = validateRemotePath(args.repoPath);
        if (!p.ok) return p;
        const r = await run(`cd ${shellQuote(p.path)} && git rev-parse --abbrev-ref HEAD 2>&1 && echo '---STATUS---' && git status --short 2>&1 | head -n 80 && echo '---LOG---' && git log --oneline -5 2>&1`);
        return { repoPath: p.path, output: String(r.stdout || '').trim() };
      }
      case 'remote_git_diff': {
        const p = validateRemotePath(args.repoPath);
        if (!p.ok) return p;
        let cmd = `cd ${shellQuote(p.path)} && git diff`;
        if (args.filePath) {
          const fp = validateRemotePath(args.filePath);
          if (!fp.ok) return fp;
          cmd += ` -- ${shellQuote(fp.path)}`;
        }
        cmd += ' | head -n 400';
        const r = await run(cmd);
        return { repoPath: p.path, diff: String(r.stdout || '').trim() || '(无未提交改动)' };
      }
      case 'remote_restart_service': {
        const svc = String(args.service || '').trim();
        if (!/^[\w@.-]+$/.test(svc)) return { error: '服务名不合法' };
        const r = await run(`sudo -n systemctl restart ${shellQuote(svc)} 2>&1 || systemctl restart ${shellQuote(svc)} 2>&1; systemctl is-active ${shellQuote(svc)} 2>&1`);
        return { service: svc, output: String(r.stdout || '').trim(), exitCode: r.exitCode };
      }
      default:
        return { error: `未知 agent 工具: ${name}` };
    }
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * 把内容写到远程文件：base64 走标准输入，避免 shell 转义问题。
 * 先写临时文件再 mv，避免写一半留下损坏文件。
 */
async function writeFileRemote(run, remotePath, content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const quoted = shellQuote(remotePath);
  const cmd = [
    `printf '%s' ${shellQuote(b64)} | base64 -d > ${quoted}.openlog-tmp`,
    `&& mv ${quoted}.openlog-tmp ${quoted}`,
    `&& echo WRITTEN`,
  ].join(' ');
  const r = await run(cmd);
  if (!String(r.stdout || '').includes('WRITTEN')) {
    return { ok: false, error: r.stderr || '写入失败' };
  }
  return { ok: true };
}

export default { AGENT_TOOLS, executeAgentTool, classifyToolRisk, applyStringEdit };

/** 所有 agent 工具名，供执行器分派 */
export const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map(t => t.function.name));
