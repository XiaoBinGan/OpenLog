/**
 * server/__tests__/remote-file-ops.test.js
 *
 * 远程文件操作（重命名 / 新建目录 / 删除 / 复制 / 移动 / 权限）的纯逻辑测试。
 *
 * 用户反馈：「远程服务器连接的操作窗口，文件支持修改但无法右键修改文件名等操作」
 * —— 之前后端根本没有 rename/delete/mkdir 接口，前端右键也没有菜单。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shellQuote, validateRemotePath, isProtectedPath, buildFileOpCommand, joinRenameTarget,
  FILE_OPS, PROTECTED_PATHS,
} from '../remote-file-ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('shellQuote —— 路径不能被拼成命令注入', () => {
  it('普通路径单引号包裹', () => {
    expect(shellQuote('/var/log/app.log')).toBe("'/var/log/app.log'");
  });
  it('路径里的单引号被转义', () => {
    expect(shellQuote("/tmp/it's.log")).toBe("'/tmp/it'\\''s.log'");
  });
  it('分号/反引号/$( ) 都留在引号内，不会被执行', () => {
    expect(shellQuote('/tmp/a; rm -rf /')).toBe("'/tmp/a; rm -rf /'");
    expect(shellQuote('/tmp/$(whoami)')).toBe("'/tmp/$(whoami)'");
    expect(shellQuote('/tmp/`id`')).toBe("'/tmp/`id`'");
  });
});

describe('validateRemotePath —— 只接受合法绝对路径', () => {
  it('正常路径通过并归一化', () => {
    expect(validateRemotePath('/var/log/app.log')).toEqual({ ok: true, path: '/var/log/app.log' });
    expect(validateRemotePath('//var//log//app.log')).toEqual({ ok: true, path: '/var/log/app.log' });
    expect(validateRemotePath('/var/log/dir/')).toEqual({ ok: true, path: '/var/log/dir' });
  });
  it('空 / 相对路径 / 换行 / NUL 被拒绝', () => {
    expect(validateRemotePath('').ok).toBe(false);
    expect(validateRemotePath('   ').ok).toBe(false);
    expect(validateRemotePath('var/log').ok).toBe(false);
    expect(validateRemotePath('/tmp/a\nrm -rf /').ok).toBe(false);
    expect(validateRemotePath('/tmp/a\u0000b').ok).toBe(false);
  });
  it('默认不允许操作根目录', () => {
    expect(validateRemotePath('/').ok).toBe(false);
    expect(validateRemotePath('/', { allowRoot: true })).toEqual({ ok: true, path: '/' });
  });
  it('异常输入不崩', () => {
    expect(validateRemotePath(null).ok).toBe(false);
    expect(validateRemotePath(undefined).ok).toBe(false);
  });
});

describe('isProtectedPath —— 关键系统目录', () => {
  it('/etc /usr /var /tmp 等直接被判定为受保护', () => {
    for (const p of ['/etc', '/usr', '/var', '/tmp', '/root', '/']) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });
  it('关键目录的子路径不算（/var/log/app 可以删）', () => {
    expect(isProtectedPath('/var/log/app.log')).toBe(false);
    expect(isProtectedPath('/tmp/openlog-test')).toBe(false);
  });
  it('末尾斜杠也能识别', () => {
    expect(isProtectedPath('/etc/')).toBe(true);
  });
  it('保护清单覆盖常见系统目录', () => {
    for (const p of ['/bin', '/boot', '/dev', '/proc', '/sys', '/home', '/opt', '/srv']) {
      expect(PROTECTED_PATHS).toContain(p);
    }
  });
});

describe('buildFileOpCommand —— 各操作的命令拼装', () => {
  it('rename：mv 源到目标', () => {
    const r = buildFileOpCommand({ op: 'rename', path: '/var/log/app.log', newPath: '/var/log/app.log.1' });
    expect(r).toEqual({ ok: true, command: "mv -- '/var/log/app.log' '/var/log/app.log.1'" });
  });

  it('move：同样用 mv（可跨目录）', () => {
    const r = buildFileOpCommand({ op: 'move', path: '/tmp/a', newPath: '/var/tmp/a' });
    expect(r.ok).toBe(true);
    expect(r.command).toContain('mv --');
  });

  it('mkdir：mkdir -p', () => {
    const r = buildFileOpCommand({ op: 'mkdir', path: '/tmp/newdir' });
    expect(r).toEqual({ ok: true, command: "mkdir -p -- '/tmp/newdir'" });
  });

  it('delete：rm -rf --', () => {
    const r = buildFileOpCommand({ op: 'delete', path: '/tmp/junk' });
    expect(r).toEqual({ ok: true, command: "rm -rf -- '/tmp/junk'" });
  });

  it('copy：cp -r --', () => {
    const r = buildFileOpCommand({ op: 'copy', path: '/tmp/a.txt', newPath: '/tmp/b.txt' });
    expect(r).toEqual({ ok: true, command: "cp -r -- '/tmp/a.txt' '/tmp/b.txt'" });
  });

  it('chmod：只接受八进制权限', () => {
    expect(buildFileOpCommand({ op: 'chmod', path: '/tmp/a.sh', mode: '755' }))
      .toEqual({ ok: true, command: "chmod 755 -- '/tmp/a.sh'" });
    expect(buildFileOpCommand({ op: 'chmod', path: '/tmp/a.sh', mode: 'u+x' }).ok).toBe(false);
    expect(buildFileOpCommand({ op: 'chmod', path: '/tmp/a.sh', mode: '777; rm -rf /' }).ok).toBe(false);
  });
});

describe('buildFileOpCommand —— 安全拦截', () => {
  it('删除关键系统目录被拒绝', () => {
    const r = buildFileOpCommand({ op: 'delete', path: '/etc' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('拒绝删除关键系统目录');
  });

  it('删除根本身被拒绝', () => {
    const r = buildFileOpCommand({ op: 'delete', path: '/' });
    expect(r.ok).toBe(false);
  });

  it('未知操作被拒绝', () => {
    expect(buildFileOpCommand({ op: 'exec', path: '/tmp/a' }).ok).toBe(false);
    expect(buildFileOpCommand({ op: '', path: '/tmp/a' }).ok).toBe(false);
    expect(FILE_OPS).not.toContain('exec');
  });

  it('源路径非法被拒绝（相对路径/换行）', () => {
    expect(buildFileOpCommand({ op: 'delete', path: 'etc/passwd' }).ok).toBe(false);
    expect(buildFileOpCommand({ op: 'delete', path: '/tmp/a\nrm -rf /' }).ok).toBe(false);
  });

  it('rename/move/copy 缺目标路径被拒绝', () => {
    for (const op of ['rename', 'move', 'copy']) {
      expect(buildFileOpCommand({ op, path: '/tmp/a' }).ok, op).toBe(false);
      expect(buildFileOpCommand({ op, path: '/tmp/a', newPath: '' }).ok, op).toBe(false);
    }
  });

  it('源和目标相同被拒绝', () => {
    const r = buildFileOpCommand({ op: 'rename', path: '/tmp/a', newPath: '/tmp/a' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('相同');
  });

  it('复制到关键系统目录被拒绝', () => {
    expect(buildFileOpCommand({ op: 'copy', path: '/tmp/a', newPath: '/etc' }).ok).toBe(false);
    // 子路径（/var/log/x）是正常业务目录，允许
    expect(buildFileOpCommand({ op: 'copy', path: '/tmp/a', newPath: '/var/log/x' }).ok).toBe(true);
  });

  it('注入尝试不会产生可执行的多余命令（整段都在引号内）', () => {
    const r = buildFileOpCommand({ op: 'delete', path: "/tmp/a'; rm -rf / #" });
    // 路径校验允许这种文件名（单引号是合法文件名字符），但整段必须作为**一个参数**交给 rm
    expect(r.ok).toBe(true);
    expect(r.command).toBe("rm -rf -- '/tmp/a'\\''; rm -rf / #'");
    // 命令以 rm -rf -- 开头，后面是被引号包住的单个参数
    expect(r.command.startsWith("rm -rf -- '")).toBe(true);
    expect(r.command.endsWith("'")).toBe(true);
  });
});

describe('joinRenameTarget —— 重命名时拼目标路径', () => {
  it('同目录下换名字', () => {
    expect(joinRenameTarget('/var/log/app.log', 'app.log.1')).toEqual({ ok: true, path: '/var/log/app.log.1' });
  });
  it('根目录下的文件', () => {
    expect(joinRenameTarget('/app.log', 'app2.log')).toEqual({ ok: true, path: '/app2.log' });
  });
  it('名字里带斜杠/.. 被拒绝（防止越权移动）', () => {
    expect(joinRenameTarget('/var/log/a', '../b').ok).toBe(false);
    expect(joinRenameTarget('/var/log/a', 'sub/b').ok).toBe(false);
    expect(joinRenameTarget('/var/log/a', '..').ok).toBe(false);
    expect(joinRenameTarget('/var/log/a', '.').ok).toBe(false);
    expect(joinRenameTarget('/var/log/a', '').ok).toBe(false);
  });
});

describe('接线 —— 服务端路由与 remote.js 真的接上了', () => {
  it('routes/remote.js 暴露 /file/op（rename/delete/mkdir…）', () => {
    const src = read('server/routes/remote.js');
    expect(src).toContain("router.post('/api/remote/servers/:id/file/op'");
    expect(src).toContain('remote.remoteFileOp');
  });

  it('remote.js 用纯函数拼命令并走 SSH', () => {
    const src = read('server/remote.js');
    expect(src).toContain('export async function remoteFileOp');
    expect(src).toContain("import { buildFileOpCommand } from './remote-file-ops.js'");
  });

  it('前端文件列表有右键菜单和重命名/删除/新建目录', () => {
    const src = read('client/src/pages/Remote.tsx');
    expect(src).toContain('onContextMenu');
    expect(src).toContain('重命名');
    expect(src).toContain('新建文件夹');
    expect(src).toContain("file/op");
  });
});
