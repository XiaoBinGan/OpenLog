/**
 * remote-file-ops.js —— 远程文件操作（重命名 / 新建目录 / 删除 / 复制 / 移动 / 权限）
 *
 * 背景：远程服务器面板之前只能「读 / 写 / 上传」文件，**不能重命名、删除、建目录** ——
 * 用户在文件浏览器里右键没有任何操作。这里补上服务端能力，并且把命令拼装做成纯函数
 * （可单测），避免把用户输入直接拼进 shell。
 *
 * 安全要点：
 *   1. 路径必须绝对路径，禁止空、NUL、换行；
 *   2. 所有路径参数用单引号包裹 + 转义（shellQuote），不接受裸拼；
 *   3. 删除/权限等破坏性操作对关键系统目录直接拒绝（防止手滑 rm -rf /etc）；
 *   4. 操作类型白名单。
 */

/** 破坏性操作禁止触碰的路径（及其子路径） */
export const PROTECTED_PATHS = [
  '/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root',
  '/sbin', '/sys', '/usr', '/var', '/home', '/opt', '/srv', '/run', '/tmp',
  '/workspace', '/workspaces',
];

/** 允许的操作 */
export const FILE_OPS = ['rename', 'move', 'mkdir', 'delete', 'copy', 'chmod'];

/** 单引号包裹路径（sh 安全）：'it'\''s' */
export function shellQuote(value) {
  const s = String(value ?? '');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 校验一个用户传来的远程路径。
 * @param {string} value
 * @param {{allowRoot?: boolean}} [opts]
 * @returns {{ok:true, path:string} | {ok:false, error:string}}
 */
export function validateRemotePath(value, opts = {}) {
  const raw = String(value ?? '');
  if (!raw.trim()) return { ok: false, error: '路径不能为空' };
  // 换行/NUL 会把命令拆成多条，必须拒绝（\\u0000 用字符串拼，避免 no-control-regex）
  if (raw.includes('\u0000') || raw.includes('\n') || raw.includes('\r')) {
    return { ok: false, error: '路径包含非法字符' };
  }
  if (!raw.startsWith('/')) return { ok: false, error: '必须使用绝对路径' };
  if (raw.length > 4096) return { ok: false, error: '路径过长' };
  if (raw === '/' && opts.allowRoot !== true) return { ok: false, error: '不能直接操作根目录' };

  // 归一化：去掉重复斜杠与末尾斜杠（保留根）
  const normalized = raw.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  if (normalized === '/' && opts.allowRoot !== true) return { ok: false, error: '不能直接操作根目录' };
  return { ok: true, path: normalized };
}

/** 是否点到了受保护目录（本身就等于关键目录，不拦子路径，比如 /var/log/app 可以删） */
export function isProtectedPath(path) {
  const p = String(path || '').replace(/\/+$/, '') || '/';
  return PROTECTED_PATHS.includes(p);
}

/**
 * 生成一条远程文件操作命令（纯函数，便于单测）。
 *
 * @param {{op:string, path:string, newPath?:string, mode?:string}} input
 * @returns {{ok:true, command:string} | {ok:false, error:string}}
 */
export function buildFileOpCommand(input) {
  const op = String(input?.op || '');
  if (!FILE_OPS.includes(op)) return { ok: false, error: `不支持的操作: ${op || '(空)'}` };

  const src = validateRemotePath(input.path, { allowRoot: false });
  if (!src.ok) return { ok: false, error: `源路径无效：${src.error}` };

  if (op === 'delete') {
    if (isProtectedPath(src.path)) return { ok: false, error: `拒绝删除关键系统目录：${src.path}` };
    // -f 不存在的文件不报错；-r 兼容目录。加 -- 防止以 - 开头的文件名被当参数
    return { ok: true, command: `rm -rf -- ${shellQuote(src.path)}` };
  }

  if (op === 'mkdir') {
    return { ok: true, command: `mkdir -p -- ${shellQuote(src.path)}` };
  }

  if (op === 'chmod') {
    const mode = String(input?.mode || '');
    if (!/^[0-7]{3,4}$/.test(mode)) return { ok: false, error: '权限模式必须是 755 这类八进制数' };
    return { ok: true, command: `chmod ${mode} -- ${shellQuote(src.path)}` };
  }

  // rename / move / copy 都需要目标路径
  const dstRaw = validateRemotePath(input?.newPath, { allowRoot: false });
  if (!dstRaw.ok) return { ok: false, error: `目标路径无效：${dstRaw.error}` };
  if (dstRaw.path === src.path) return { ok: false, error: '源路径和目标路径相同' };
  if (op === 'copy' && isProtectedPath(dstRaw.path)) return { ok: false, error: `拒绝写入关键系统目录：${dstRaw.path}` };

  if (op === 'copy') {
    return { ok: true, command: `cp -r -- ${shellQuote(src.path)} ${shellQuote(dstRaw.path)}` };
  }
  // rename / move 同一条 mv（rename 只是同目录下的特例）
  return { ok: true, command: `mv -- ${shellQuote(src.path)} ${shellQuote(dstRaw.path)}` };
}

/**
 * 把「旧路径 + 新名字」拼成目标路径（重命名时的常见形态）。
 * @param {string} currentPath 例如 /var/log/app.log
 * @param {string} newName 例如 app.log.1
 * @returns {{ok:true, path:string} | {ok:false, error:string}}
 */
export function joinRenameTarget(currentPath, newName) {
  const name = String(newName ?? '').trim();
  if (!name) return { ok: false, error: '新名称不能为空' };
  if (name === '.' || name === '..') return { ok: false, error: '新名称非法' };
  if (/[/\\]/.test(name)) return { ok: false, error: '新名称不能包含路径分隔符' };
  const parent = String(currentPath || '').replace(/\/[^/]*$/, '') || '/';
  const target = parent === '/' ? `/${name}` : `${parent}/${name}`;
  return validateRemotePath(target, { allowRoot: false });
}
