import { describe, it, expect, vi } from 'vitest';

const { tokenizeCommand, createExecDemuxer } = await import('../docker.js');

/** 构造一个 docker 多路复用帧 */
function frame(text, streamType = 1) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('tokenizeCommand —— 引号感知切分（不再 cmd.split(" ")）', () => {
  it('普通命令', () => {
    expect(tokenizeCommand('ls -al /app')).toEqual(['ls', '-al', '/app']);
  });

  it('双引号里的空格不被切开（原来 cat "/var/log/my app.log" 会失败）', () => {
    expect(tokenizeCommand('cat "/var/log/my app.log"')).toEqual(['cat', '/var/log/my app.log']);
  });

  it('单引号同样保留', () => {
    expect(tokenizeCommand("grep 'hello world' file")).toEqual(['grep', 'hello world', 'file']);
  });

  it('连续空格/制表符不产生空参数', () => {
    expect(tokenizeCommand('  ls   -la  ')).toEqual(['ls', '-la']);
  });

  it('反斜杠转义空格', () => {
    expect(tokenizeCommand('cat /a\\ b.log')).toEqual(['cat', '/a b.log']);
  });

  it('空命令返回空数组', () => {
    expect(tokenizeCommand('')).toEqual([]);
    expect(tokenizeCommand('   ')).toEqual([]);
    expect(tokenizeCommand(null)).toEqual([]);
  });

  it('引号中的 $ 不做变量展开（不经 shell）', () => {
    expect(tokenizeCommand('echo "$HOME"')).toEqual(['echo', '$HOME']);
  });
});

describe('createExecDemuxer —— 去掉 docker 帧头（真实 bug：输出里混 \\u0001\\u0000…）', () => {
  it('单帧解析出纯文本', () => {
    const demux = createExecDemuxer();
    const out = demux.push(frame('assistant_memory\nclient\n'));
    expect(out).toBe('assistant_memory\nclient\n');
    expect(out.includes('\u0001')).toBe(false);
  });

  it('多帧拼接，stdout/stderr 都能取到', () => {
    const demux = createExecDemuxer();
    const buf = Buffer.concat([frame('out1\n', 1), frame('err1\n', 2), frame('out2\n', 1)]);
    expect(demux.push(buf)).toBe('out1\nerr1\nout2\n');
  });

  it('帧被 chunk 切断时也能正确拼接（保留残余字节）', () => {
    const demux = createExecDemuxer();
    const full = Buffer.concat([frame('hello\n'), frame('world\n')]);
    let out = '';
    for (let i = 0; i < full.length; i++) out += demux.push(full.slice(i, i + 1));
    out += demux.flush();
    expect(out).toBe('hello\nworld\n');
    expect(demux.pending()).toBe(0);
  });

  it('纯 TTY 输出（无帧头）原样返回', () => {
    const demux = createExecDemuxer();
    expect(demux.push(Buffer.from('total 4\ndrwxr-xr-x app\n'))).toBe('total 4\ndrwxr-xr-x app\n');
  });

  it('空 chunk 安全', () => {
    const demux = createExecDemuxer();
    expect(demux.push(Buffer.alloc(0))).toBe('');
  });

  it('中文输出不乱码', () => {
    const demux = createExecDemuxer();
    expect(demux.push(frame('容器名\t状态\n'))).toBe('容器名\t状态\n');
  });
});

describe('execInContainer 路由顺序 —— 不能被通配路由遮蔽（真实 bug）', () => {
  it('exec 路由注册在 /:containerId/:op 之前', async () => {
    const createDockerRouter = (await import('../routes/docker.js')).default;
    const router = createDockerRouter({
      ensureSettings: () => ({ dockerSources: [] }),
      broadcast: vi.fn(),
      addAnalysisRecord: vi.fn(),
      buildHostExecMap: () => ({}),
      stripThinking: (t) => t,
      getLastPatrolResults: () => [],
      setLastPatrolResults: vi.fn(),
    });
    const layers = router.stack
      .filter((l) => l.route)
      .map((l) => l.route.path);
    const execIdx = layers.indexOf('/api/docker/:sourceId/:containerId/exec');
    const genericIdx = layers.indexOf('/api/docker/:sourceId/:containerId/:op');
    expect(execIdx, 'exec 路由存在').toBeGreaterThanOrEqual(0);
    expect(genericIdx, '通配路由存在').toBeGreaterThanOrEqual(0);
    expect(execIdx, 'exec 必须在通配路由之前注册，否则被 default 分支返回 400').toBeLessThan(genericIdx);
  });
});

describe('命令安全策略（容器内执行）', () => {
  it('只读白名单包含面板示例里的命令', async () => {
    const { READONLY_COMMANDS } = await import('../security/shell-command-policy.js');
    for (const cmd of ['ls', 'cat', 'ps', 'head', 'tail', 'grep', 'pwd']) {
      expect(READONLY_COMMANDS, cmd).toContain(cmd);
    }
  });

  it('带元字符的命令一律拒绝（含 ; | && 反引号 $( ）', async () => {
    const { hasShellMetaChars } = await import('../security/shell-command-policy.js');
    for (const cmd of ['ls; id', 'ls | cat', 'ls && id', '`id`', 'x=$(id)', 'cat a > b']) {
      expect(hasShellMetaChars(cmd), cmd).toBe(true);
    }
  });

  it('取命令名支持路径形式', async () => {
    const { commandBaseName } = await import('../security/shell-command-policy.js');
    expect(commandBaseName('/bin/ls -al')).toBe('ls');
    expect(commandBaseName('  cat /etc/hosts')).toBe('cat');
  });
});
