import { describe, it, expect, vi } from 'vitest';

const {
  validateRemotePath, shellQuote, isSensitivePath,
  applyStringEdit, buildEditPreview,
  buildGrepCommand, buildReadFileCommand,
  classifyToolRisk, executeAgentTool, AGENT_TOOLS, AGENT_TOOL_NAMES,
  MAX_READ_BYTES, MAX_WRITE_BYTES, BACKUP_SUFFIX,
} = await import('../agent-tools.js');

describe('路径校验 —— 防命令注入', () => {
  it('接受正常绝对路径（含中文/空格）', () => {
    for (const p of ['/etc/nginx/nginx.conf', '/data/my app/config.yaml', '/home/deploy/部署/配置.yml', '/a/b-c_d.e']) {
      expect(validateRemotePath(p).ok, p).toBe(true);
    }
  });

  it('拒绝相对路径 / 空 / 引号 / 换行', () => {
    expect(validateRemotePath('').ok).toBe(false);
    expect(validateRemotePath('relative/path').ok).toBe(false);
    expect(validateRemotePath("/a/'b").ok).toBe(false);
    expect(validateRemotePath('/a/"b').ok).toBe(false);
    expect(validateRemotePath('/a/`id`').ok).toBe(false);
    expect(validateRemotePath('/a/b\nrm -rf /').ok).toBe(false);
  });

  it('shellQuote 转义单引号', () => {
    expect(shellQuote('/tmp/a b')).toBe("'/tmp/a b'");
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
  });

  it('识别系统关键路径', () => {
    expect(isSensitivePath('/etc/nginx/nginx.conf')).toBe(true);
    expect(isSensitivePath('/root/.ssh/authorized_keys')).toBe(true);
    expect(isSensitivePath('/boot/grub/grub.cfg')).toBe(true);
    expect(isSensitivePath('/workspace/app/config.yaml')).toBe(false);
  });
});

describe('applyStringEdit —— 精确替换', () => {
  const src = 'line1\nlisten 80;\nline3\nlisten 80;\n';

  it('唯一匹配才替换（默认）', () => {
    const r = applyStringEdit(src, 'line1', 'line-one');
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.content).toBe('line-one\nlisten 80;\nline3\nlisten 80;\n');
  });

  it('多处匹配默认拒绝，并告诉调用方有几处', () => {
    const r = applyStringEdit(src, 'listen 80;', 'listen 8080;');
    expect(r.ok).toBe(false);
    expect(r.count).toBe(2);
    expect(r.error).toContain('出现了 2 次');
  });

  it('replaceAll 时全部替换', () => {
    const r = applyStringEdit(src, 'listen 80;', 'listen 8080;', true);
    expect(r.ok).toBe(true);
    expect(r.content.match(/listen 8080;/g)).toHaveLength(2);
  });

  it('找不到原文时明确报错（提示模型先读文件）', () => {
    const r = applyStringEdit(src, 'does not exist', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('找不到 old_string');
  });

  it('空 oldString / 无变化都拒绝', () => {
    expect(applyStringEdit(src, '', 'x').ok).toBe(false);
    expect(applyStringEdit(src, 'line1', 'line1').ok).toBe(false);
  });

  it('支持多行/缩进匹配', () => {
    const code = 'def f():\n    return 1\n';
    const r = applyStringEdit(code, 'def f():\n    return 1', 'def f():\n    return 2');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('return 2');
  });
});

describe('buildEditPreview —— 变更预览', () => {
  it('输出 diff 风格预览', () => {
    const p = buildEditPreview('a = 1', 'a = 2');
    expect(p).toContain('- a = 1');
    expect(p).toContain('+ a = 2');
  });

  it('replaceAll 带提示', () => {
    expect(buildEditPreview('x', 'y', true)).toContain('替换全部');
  });

  it('长文本截断', () => {
    const p = buildEditPreview('a'.repeat(500), 'b');
    expect(p.length).toBeLessThan(400);
    expect(p).toContain('…');
  });
});

describe('buildGrepCommand —— 搜索命令拼装', () => {
  it('基本搜索命令安全引用', () => {
    const r = buildGrepCommand({ pattern: 'ERROR', path: '/var/log/app' });
    expect(r.ok).toBe(true);
    expect(r.command).toContain('grep -rnI');
    expect(r.command).toContain("'ERROR'");
    expect(r.command).toContain("'/var/log/app'");
  });

  it('支持 glob / 大小写 / 上下文', () => {
    const r = buildGrepCommand({ pattern: 'timeout', path: '/app', glob: '*.py', context: 2, caseSensitive: true });
    expect(r.command).toContain("--include='*.py'");
    expect(r.command).toContain('-C 2');
    expect(r.command).not.toContain('-i ');
  });

  it('pattern 含引号不破坏命令', () => {
    const r = buildGrepCommand({ pattern: "it's broken", path: '/app' });
    expect(r.command).toContain("'it'\\''s broken'");
  });

  it('空 pattern / 非法路径拒绝', () => {
    expect(buildGrepCommand({ pattern: '', path: '/app' }).ok).toBe(false);
    expect(buildGrepCommand({ pattern: 'x', path: 'rel/path' }).ok).toBe(false);
  });
});

describe('buildReadFileCommand —— 读文件命令', () => {
  it('整份读取带字节数', () => {
    const r = buildReadFileCommand('/app/config.yaml');
    expect(r.command).toContain('BYTES:');
    expect(r.command).toContain("cat '/app/config.yaml'");
  });

  it('行区间用 awk 带行号，且单引号成对（回归：曾经引号嵌套导致远端 bash 语法错误）', () => {
    const r = buildReadFileCommand('/app/big.log', { startLine: 100, endLine: 150 });
    expect(r.command).toContain('awk');
    expect(r.command).toContain('NR>=100 && NR<=150');
    expect(r.command).toContain('NR, $0');
    // 引号必须成对，否则 bash 报 "unexpected EOF while looking for matching"
    const quotes = (r.command.match(/'/g) || []).length;
    expect(quotes % 2).toBe(0);
  });

  it('非法路径拒绝', () => {
    expect(buildReadFileCommand('rel').ok).toBe(false);
  });
});

describe('classifyToolRisk —— 风险分级', () => {
  it('读类自动执行', () => {
    for (const name of [
      'remote_stat', 'remote_ls', 'remote_read_file', 'remote_grep', 'remote_git_status', 'remote_git_diff',
      // ????????????????
      'docker_list', 'docker_logs', 'docker_inspect', 'docker_health_check',
      'remote_servers', 'remote_system_stats', 'remote_list_files', 'remote_search_logs',
      'local_system_stats', 'local_log_files', 'local_read_log',
    ]) {
      expect(classifyToolRisk(name, {}).risk, name).toBe('read');
    }
  });

  it('写文件是 write，改 /etc 升级为 danger', () => {
    expect(classifyToolRisk('remote_edit_file', { filePath: '/workspace/app/main.py' }).risk).toBe('write');
    expect(classifyToolRisk('remote_write_file', { filePath: '/workspace/app/cfg.yml' }).risk).toBe('write');
    expect(classifyToolRisk('remote_edit_file', { filePath: '/etc/nginx/nginx.conf' }).risk).toBe('danger');
  });

  it('任意命令/删除/重启服务都是 danger', () => {
    expect(classifyToolRisk('remote_exec', { command: 'ls' }).risk).toBe('danger');
    expect(classifyToolRisk('remote_exec', { command: 'rm -rf /tmp/x' }).reason).toContain('破坏性');
    expect(classifyToolRisk('remote_delete_file', {}).risk).toBe('danger');
    expect(classifyToolRisk('remote_restart_service', {}).risk).toBe('danger');
    expect(classifyToolRisk('docker_restart', {}).risk).toBe('danger');
  });

  it('未知工具按 write 保守处理', () => {
    expect(classifyToolRisk('some_new_tool', {}).risk).toBe('write');
  });

  it('AGENT_TOOL_NAMES 与定义一致', () => {
    expect(AGENT_TOOL_NAMES.size).toBe(AGENT_TOOLS.length);
    expect(AGENT_TOOL_NAMES.has('remote_edit_file')).toBe(true);
  });
});

// ─── 执行器（注入假 exec） ──────────────────────────────────────────────────

/** 造一个假远程 shell：按命令关键字返回预设输出，并记录调用 */
function fakeExec(handlers) {
  const calls = [];
  const exec = vi.fn(async (serverId, command) => {
    calls.push({ serverId, command });
    for (const [re, out] of handlers) {
      if (re.test(command)) return typeof out === 'function' ? out(command) : out;
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  });
  return { exec, calls };
}

describe('executeAgentTool —— 读写执行', () => {
  it('remote_read_file 返回内容与字节数', async () => {
    const { exec } = fakeExec([[/BYTES:/, { stdout: 'BYTES:11\nhello world', exitCode: 0 }]]);
    const r = await executeAgentTool('remote_read_file', { serverId: 's1', filePath: '/app/a.txt' }, { exec });
    expect(r.content).toBe('hello world');
    expect(r.bytes).toBe(11);
    expect(r.truncated).toBe(false);
  });

  it('remote_read_file 超大文件截断并提示', async () => {
    const big = 'x'.repeat(MAX_READ_BYTES + 1000);
    const { exec } = fakeExec([[/BYTES:/, { stdout: `BYTES:${big.length}\n${big}`, exitCode: 0 }]]);
    const r = await executeAgentTool('remote_read_file', { serverId: 's1', filePath: '/app/big.log' }, { exec });
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(r.note).toContain('截断');
  });

  it('remote_grep 返回匹配数与内容', async () => {
    const { exec } = fakeExec([[/grep -rnI/, { stdout: '/app/a.py:3:ERROR boom\n/app/b.py:9:ERROR bang', exitCode: 0 }]]);
    const r = await executeAgentTool('remote_grep', { serverId: 's1', pattern: 'ERROR', path: '/app' }, { exec });
    expect(r.matchCount).toBe(2);
    expect(r.matches).toContain('a.py:3');
  });

  it('remote_edit_file 唯一匹配时备份 + 写入', async () => {
    const { exec, calls } = fakeExec([
      [/cat '/, { stdout: 'port = 8080\nhost = 0.0.0.0\n', exitCode: 0 }],
      [/cp -p '/, { stdout: 'OK', exitCode: 0 }],
      [/WRITTEN/, { stdout: 'WRITTEN', exitCode: 0 }],
    ]);
    const r = await executeAgentTool('remote_edit_file', {
      serverId: 's1', filePath: '/app/cfg.py', oldString: 'port = 8080', newString: 'port = 9090',
    }, { exec });
    expect(r.success).toBe(true);
    expect(r.replacements).toBe(1);
    expect(r.backupCreated).toBe(true);
    // 备份文件名带 BACKUP_SUFFIX
    expect(calls.some(c => c.command.includes(BACKUP_SUFFIX))).toBe(true);
  });

  it('remote_edit_file 多处匹配拒绝执行（不写文件）', async () => {
    const { exec, calls } = fakeExec([[/cat '/, { stdout: 'x=1\nx=1\n', exitCode: 0 }]]);
    const r = await executeAgentTool('remote_edit_file', {
      serverId: 's1', filePath: '/app/cfg.py', oldString: 'x=1', newString: 'x=2',
    }, { exec });
    expect(r.error).toContain('出现了 2 次');
    expect(calls.some(c => /WRITTEN/.test(c.command))).toBe(false);
  });

  it('remote_write_file 新建文件（不备份）', async () => {
    const { exec } = fakeExec([
      [/test -e /, { stdout: 'NO', exitCode: 0 }],
      [/WRITTEN/, { stdout: 'WRITTEN', exitCode: 0 }],
    ]);
    const r = await executeAgentTool('remote_write_file', {
      serverId: 's1', filePath: '/app/new.txt', content: 'hello',
    }, { exec });
    expect(r.success).toBe(true);
    expect(r.backupCreated).toBe(false);
    expect(r.bytes).toBe(5);
  });

  it('remote_write_file 覆盖已有文件会备份', async () => {
    const { exec, calls } = fakeExec([
      [/test -e /, { stdout: 'YES', exitCode: 0 }],
      [/WRITTEN/, { stdout: 'WRITTEN', exitCode: 0 }],
    ]);
    const r = await executeAgentTool('remote_write_file', {
      serverId: 's1', filePath: '/app/old.txt', content: 'v2',
    }, { exec });
    expect(r.backupCreated).toBe(true);
    expect(calls.some(c => c.command.includes(BACKUP_SUFFIX))).toBe(true);
  });

  it('remote_rollback_file 用最近备份恢复', async () => {
    const { exec, calls } = fakeExec([
      [/ls -1t /, { stdout: '/app/a.txt.openlog-bak.123\n', exitCode: 0 }],
      [/cp -p '/, { stdout: 'OK', exitCode: 0 }],
    ]);
    const r = await executeAgentTool('remote_rollback_file', { serverId: 's1', filePath: '/app/a.txt' }, { exec });
    expect(r.success).toBe(true);
    expect(r.restoredFrom).toContain('openlog-bak');
    expect(calls.some(c => /cp -p '.+openlog-bak/.test(c.command))).toBe(true);
  });

  it('没有备份时回滚给出明确错误', async () => {
    const { exec } = fakeExec([[/ls -1t /, { stdout: '', exitCode: 0 }]]);
    const r = await executeAgentTool('remote_rollback_file', { serverId: 's1', filePath: '/app/a.txt' }, { exec });
    expect(r.error).toContain('没有找到自动备份');
  });

  it('缺少 serverId 时给出可操作提示', async () => {
    const r = await executeAgentTool('remote_read_file', { filePath: '/a' }, { exec: vi.fn() });
    expect(r.error).toContain('serverId');
  });

  it('exec 抛错时返回 error 而不是崩溃', async () => {
    const exec = vi.fn(async () => { throw new Error('SSH 断开'); });
    const r = await executeAgentTool('remote_ls', { serverId: 's1', path: '/app' }, { exec });
    expect(r.error).toContain('SSH 断开');
  });

  it('非法路径不会执行任何命令', async () => {
    const exec = vi.fn();
    const r = await executeAgentTool('remote_read_file', { serverId: 's1', filePath: 'relative' }, { exec });
    expect(r.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('remote_git_status / diff', async () => {
    const { exec } = fakeExec([[/git /, { stdout: 'main\n---STATUS---\n M a.py\n', exitCode: 0 }]]);
    const st = await executeAgentTool('remote_git_status', { serverId: 's1', repoPath: '/app' }, { exec });
    expect(st.output).toContain('main');
    const df = await executeAgentTool('remote_git_diff', { serverId: 's1', repoPath: '/app' }, { exec });
    expect(df.diff).toContain('M a.py');
  });

  it('remote_restart_service 校验服务名', async () => {
    const exec = vi.fn(async () => ({ stdout: 'active', exitCode: 0 }));
    const bad = await executeAgentTool('remote_restart_service', { serverId: 's1', service: 'nginx; rm -rf /' }, { exec });
    expect(bad.error).toContain('不合法');
    expect(exec).not.toHaveBeenCalled();
    const ok = await executeAgentTool('remote_restart_service', { serverId: 's1', service: 'nginx' }, { exec });
    expect(ok.service).toBe('nginx');
  });
});
