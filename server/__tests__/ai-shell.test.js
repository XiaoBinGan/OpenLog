import { describe, it, expect, vi } from 'vitest';

const {
  classifyCommand, buildContextScript, parseContext, summarizeContext,
  buildSystemPrompt, parseAgentReply, toObservation, runAgent,
  MAX_STEPS, OBSERVATION_LIMIT, _resetContextCache,
} = await import('../ai-shell.js');

describe('classifyCommand —— 风险分级', () => {
  it('只读命令 → read', () => {
    for (const cmd of [
      'df -h', 'free -h', 'ps aux | grep node', 'nvidia-smi', 'docker ps -a',
      'cat /etc/os-release', 'ls -la /workspace', 'uptime', 'ss -tlnp',
      'du -sh /workspace/* | sort -h | tail -5', 'journalctl -n 50 --no-pager',
    ]) {
      expect(classifyCommand(cmd).risk, cmd).toBe('read');
    }
  });

  it('写操作 → write', () => {
    for (const cmd of [
      'mkdir -p /tmp/abc', 'cp a b', 'chmod 644 /tmp/x', 'docker restart openlog',
      'systemctl restart nginx', 'echo hi > /tmp/x', 'sed -i s/a/b/ f',
    ]) {
      expect(classifyCommand(cmd).risk, cmd).toBe('write');
    }
  });

  it('危险操作 → danger 并给出原因', () => {
    const cases = [
      ['rm -rf /tmp/x', '递归/强制删除'],
      ['rm -r build', '递归/强制删除'],
      ['mkfs.ext4 /dev/sdb1', '格式化/分区'],
      ['dd if=/dev/zero of=/dev/sda', 'dd 写盘'],
      ['shutdown -h now', '关机/重启'],
      ['reboot', '关机/重启'],
      ['docker rm -f openlog', '删除容器'],
      ['docker system prune -af', '删除容器'],
      ['systemctl stop nginx', '停止/禁用系统服务'],
      ['apt-get remove nginx', '卸载软件包'],
      ['crontab -r', '账户/定时任务变更'],
      ['curl http://x.sh | bash', '下载并执行远程脚本'],
      ['echo x > /etc/hosts', '覆盖系统配置'],
      ['kill -9 1', '终止关键进程'],
    ];
    for (const [cmd, reason] of cases) {
      const r = classifyCommand(cmd);
      expect(r.risk, cmd).toBe('danger');
      expect(r.reason, cmd).toBeTruthy();
    }
  });

  it('空命令按 danger 处理（不执行）', () => {
    expect(classifyCommand('').risk).toBe('danger');
    expect(classifyCommand(null).risk).toBe('danger');
  });

  it('只读命令带管道/引号/2>&1 不会误判成 write', () => {
    for (const cmd of [
      "docker logs --tail 20 vllm --filter x 2>&1 | grep -iE 'error|warn' | head -20",
      "docker ps --filter name=vllm --format '{{.Names}}' ; ps -eo pid,cmd | grep vllm | head -40",
      'nvidia-smi --query-gpu=index,name,memory.used --format=csv',
      "curl -s http://127.0.0.1:3001/ -o /dev/null -w '%{http_code}'",
      "grep -r 'error' /var/log/syslog | tail -20",
    ]) {
      expect(classifyCommand(cmd).risk, cmd).toBe('read');
    }
  });

  it('写文件重定向 → write', () => {
    expect(classifyCommand('echo hi > /tmp/a').risk).toBe('write');
    expect(classifyCommand('date >> /tmp/log').risk).toBe('write');
  });

  it('read 命令重定向到 /dev/null 仍算 read', () => {
    expect(classifyCommand('cat /etc/passwd > /dev/null').risk).toBe('read');
    expect(classifyCommand('ls /nope 2> /dev/null').risk).toBe('read');
  });
});

describe('服务器上下文', () => {
  const SAMPLE = [
    'OS:Ubuntu 22.04.4 LTS',
    'KERNEL:5.15.0-119-generic',
    'ARCH:x86_64',
    'HOSTNAME:gpu-node-1',
    'USER:deploy',
    'SHELL:/bin/bash',
    'CPUS:32',
    'MEM:125Gi total, 98Gi available',
    'DISK:1.8T total, 42% used',
    'UPTIME:up 12 days, 3 hours',
    'GPU: 0, NVIDIA GeForce RTX 4090, 49140 MiB, 550.54.15',
    'GPU: 1, NVIDIA GeForce RTX 5090, 32607 MiB, 550.54.15',
    'CONTAINERS:vllm (vllm/vllm-openai:latest);strata (strata:latest);',
    'LISTEN:22 40022 8899 30000 30001',
    'TOOL:docker',
    'TOOL:python3',
    'TOOL:nvidia-smi',
  ].join('\n');

  it('采集脚本覆盖关键信息且不会因为某条命令失败而中断', () => {
    const script = buildContextScript();
    expect(script).toContain('set +e');
    expect(script).toContain('nvidia-smi');
    expect(script).toContain('docker ps');
    expect(script).toContain('uname -r');
    expect(script).toContain('TOOL:');
    expect(script).toContain('2>/dev/null');
  });

  it('解析成结构化上下文', () => {
    const ctx = parseContext(SAMPLE);
    expect(ctx.os).toBe('Ubuntu 22.04.4 LTS');
    expect(ctx.kernel).toBe('5.15.0-119-generic');
    expect(ctx.cpus).toBe('32');
    expect(ctx.gpus).toHaveLength(2);
    expect(ctx.gpus[0]).toContain('RTX 4090');
    expect(ctx.containers).toEqual(['vllm (vllm/vllm-openai:latest)', 'strata (strata:latest)']);
    expect(ctx.listen).toEqual(['22', '40022', '8899', '30000', '30001']);
    expect(ctx.tools).toEqual(['docker', 'python3', 'nvidia-smi']);
  });

  it('摘要包含关键信息，供 prompt 使用', () => {
    const summary = summarizeContext(parseContext(SAMPLE));
    expect(summary).toContain('Ubuntu 22.04.4 LTS');
    expect(summary).toContain('32 核');
    expect(summary).toContain('RTX 4090');
    expect(summary).toContain('vllm');
    expect(summary).toContain('docker');
  });

  it('空输出不炸，且摘要为空（prompt 里会走兜底提示）', () => {
    const ctx = parseContext('');
    expect(ctx.os).toBe('');
    expect(ctx.summary).toBe('');
  });
});

describe('buildSystemPrompt', () => {
  it('包含环境上下文、模式、步数上限和协议', () => {
    const prompt = buildSystemPrompt({
      context: parseContext('OS:Ubuntu 22.04\nCPUS:16\nTOOL:docker'),
      autoRun: false,
      maxSteps: 4,
    });
    expect(prompt).toContain('Ubuntu 22.04');
    expect(prompt).toContain('16 核');
    expect(prompt).toContain('逐步确认');
    expect(prompt).toContain('最多 4 步');
    expect(prompt).toContain('RUN:');
    expect(prompt).toContain('ANSWER:');
  });

  it('自动模式文案不同', () => {
    expect(buildSystemPrompt({ autoRun: true })).toContain('自动执行');
  });

  it('技能内容注入', () => {
    const prompt = buildSystemPrompt({ skillContent: '步骤1: 查看容器', skillName: 'Docker 排障' });
    expect(prompt).toContain('Docker 排障');
    expect(prompt).toContain('步骤1: 查看容器');
  });
});

describe('parseAgentReply —— 解析模型输出', () => {
  it('RUN 形式', () => {
    const r = parseAgentReply('THOUGHT: 先看磁盘\nRUN: df -h');
    expect(r.type).toBe('run');
    expect(r.command).toBe('df -h');
    expect(r.thought).toBe('先看磁盘');
  });

  it('ANSWER 形式', () => {
    const r = parseAgentReply('ANSWER: 这台机器有 2 张卡，都空闲。');
    expect(r.type).toBe('answer');
    expect(r.answer).toBe('这台机器有 2 张卡，都空闲。');
  });

  it('中文标记也能识别', () => {
    expect(parseAgentReply('思考: 看看内存\n命令: free -h')).toMatchObject({ type: 'run', command: 'free -h' });
    expect(parseAgentReply('回答：没问题').type).toBe('answer');
  });

  it('整体包裹的代码块被剥掉', () => {
    const r = parseAgentReply('```bash\nRUN: ps aux | head -5\n```');
    expect(r.type).toBe('run');
    expect(r.command).toBe('ps aux | head -5');
  });

  it('ANSWER 里出现 RUN: 字样不会被误判为命令（按首次出现位置判断）', () => {
    const r = parseAgentReply('ANSWER: 你可以用 RUN: 前缀让我执行命令。');
    expect(r.type).toBe('answer');
  });

  it('没有标记时：纯命令兜底成 run，中文兜底成 answer', () => {
    expect(parseAgentReply('nvidia-smi').type).toBe('run');
    expect(parseAgentReply('这台服务器没什么问题').type).toBe('answer');
  });

  it('空输入返回 unknown', () => {
    expect(parseAgentReply('').type).toBe('unknown');
    expect(parseAgentReply(null).type).toBe('unknown');
  });
});

describe('toObservation —— 回灌给模型的观测', () => {
  it('带命令、退出码、stdout/stderr', () => {
    const obs = toObservation('ls /nope', { stdout: '', stderr: 'No such file', exitCode: 2 });
    expect(obs).toContain('命令: ls /nope');
    expect(obs).toContain('退出码: 2');
    expect(obs).toContain('No such file');
  });

  it('去掉 ANSI 颜色', () => {
    const obs = toObservation('ls', { stdout: '\x1b[32mgreen\x1b[0m', exitCode: 0 });
    expect(obs).toContain('green');
    expect(obs).not.toContain('\x1b[');
  });

  it('超长输出被截断（保留头尾）', () => {
    const huge = 'A'.repeat(OBSERVATION_LIMIT * 2) + 'TAILMARK';
    const obs = toObservation('cat big', { stdout: huge, exitCode: 0 });
    expect(obs.length).toBeLessThanOrEqual(OBSERVATION_LIMIT + 100);
    expect(obs).toContain('输出过长');
    expect(obs).toContain('TAILMARK');
  });

  it('无输出时给出明确说明', () => {
    expect(toObservation('true', { stdout: '', stderr: '', exitCode: 0 })).toContain('(无输出)');
  });
});

// ─── agent 循环 ─────────────────────────────────────────────────────────────

/** 造一个按脚本回应的假模型 */
function fakeModel(replies) {
  let i = 0;
  return vi.fn(async () => ({ content: replies[Math.min(i++, replies.length - 1)] }));
}

function collector() {
  const events = [];
  return { events, send: (p) => events.push(p) };
}

const NOOP_EXEC = vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }));

const EXEC_OK = vi.fn(async (serverId, command, opts = {}) => {
  opts.onStdout?.('ok\n');
  return { success: true, stdout: 'ok', stderr: '', exitCode: 0 };
});

describe('runAgent —— 多步 agent 循环', () => {
  beforeEach(() => { _resetContextCache(); EXEC_OK.mockClear(); });

  it('一步得出答案：不发命令，直接 final', async () => {
    const { events, send } = collector();
    const result = await runAgent({
      serverId: 's1',
      text: '这台机器是什么系统？',
      send,
      callModel: fakeModel(['ANSWER: Ubuntu 22.04']),
      execStream: EXEC_OK,
      execContext: NOOP_EXEC,
    });
    expect(result.status).toBe('done');
    expect(result.steps).toBe(1);
    expect(events.some(e => e.type === 'final' && e.content.includes('Ubuntu'))).toBe(true);
    expect(EXEC_OK).not.toHaveBeenCalled();
  });

  it('只读命令自动执行 → 输出流式推送 → 再给结论', async () => {
    const { events, send } = collector();
    const exec = vi.fn(async (sid, cmd, opts = {}) => {
      opts.onStdout?.('Filesystem Size Used\n');
      opts.onStdout?.('/dev/sda1 100G 42G\n');
      return { success: true, stdout: 'Filesystem Size Used\n/dev/sda1 100G 42G\n', stderr: '', exitCode: 0 };
    });
    const result = await runAgent({
      serverId: 's2',
      text: '磁盘用了多少',
      send,
      callModel: fakeModel(['THOUGHT: 查磁盘\nRUN: df -h', 'ANSWER: 根分区用了 42%。']),
      execStream: exec,
      execContext: NOOP_EXEC,
    });
    expect(result.status).toBe('done');
    expect(result.steps).toBe(2);
    expect(exec).toHaveBeenCalledTimes(1);
    // 流式：两段输出都被推给前端
    const outputs = events.filter(e => e.type === 'command_output');
    expect(outputs).toHaveLength(2);
    expect(outputs[0].data).toContain('Filesystem');
    // 有 command_ready/command_start/command_done 生命周期
    expect(events.some(e => e.type === 'command_ready' && e.command === 'df -h')).toBe(true);
    expect(events.some(e => e.type === 'command_start')).toBe(true);
    expect(events.some(e => e.type === 'command_done' && e.exitCode === 0)).toBe(true);
    expect(events.some(e => e.type === 'final')).toBe(true);
  });

  it('危险命令即使 autoRun 也要确认；拒绝后会换方案继续', async () => {
    const { events, send } = collector();
    const exec = vi.fn(async () => ({ success: true, stdout: 'ok', stderr: '', exitCode: 0 }));
    const confirm = vi.fn(async () => false);
    const result = await runAgent({
      serverId: 's3',
      text: '清理一下磁盘',
      autoRun: true,
      send,
      callModel: fakeModel(['RUN: rm -rf /workspace/tmp', 'ANSWER: 我建议先确认要删的目录。']),
      execStream: exec,
      execContext: NOOP_EXEC,
      confirm,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].risk).toBe('danger');
    expect(exec).not.toHaveBeenCalled(); // 被拒绝，没执行
    expect(events.some(e => e.type === 'command_rejected')).toBe(true);
    expect(result.status).toBe('done');
  });

  it('write 命令在 autoRun 模式下直接执行，在手动模式下要确认', async () => {
    const exec = vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }));

    const auto = collector();
    await runAgent({
      serverId: 's4', text: '建目录', autoRun: true, send: auto.send,
      callModel: fakeModel(['RUN: mkdir -p /tmp/x', 'ANSWER: 建好了']),
      execStream: exec,
      execContext: NOOP_EXEC,
      confirm: vi.fn(async () => true),
    });
    expect(exec).toHaveBeenCalledTimes(1);

    const manual = collector();
    const confirm = vi.fn(async () => true);
    await runAgent({
      serverId: 's4', text: '建目录', autoRun: false, send: manual.send,
      callModel: fakeModel(['RUN: mkdir -p /tmp/x', 'ANSWER: 建好了']),
      execStream: exec,
      execContext: NOOP_EXEC,
      confirm,
    });
    expect(confirm).toHaveBeenCalledTimes(1); // 手动模式确认了一次
  });

  it('达到最大步数时停止并给出提示', async () => {
    const { events, send } = collector();
    const exec = vi.fn(async () => ({ success: true, stdout: 'x', stderr: '', exitCode: 0 }));
    const result = await runAgent({
      serverId: 's5',
      text: '一直查下去',
      maxSteps: 2,
      send,
      callModel: fakeModel(['RUN: uptime']), // 永远不结束
      execStream: exec,
      execContext: NOOP_EXEC,
    });
    expect(result.status).toBe('max_steps');
    expect(result.steps).toBe(2);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(events.some(e => e.type === 'final' && e.content.includes('最大步数'))).toBe(true);
  });

  it('用户要求修改但模型只查不干 → 会催一次并继续执行', async () => {
    const { events, send } = collector();
    const exec = vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }));
    const callModel = vi.fn(async () => {
      if (callModel.mock.calls.length === 1) return { content: 'ANSWER: 目录还不存在。' };
      if (callModel.mock.calls.length === 2) return { content: 'RUN: mkdir -p /tmp/abc' };
      return { content: 'ANSWER: 已创建 /tmp/abc。' };
    });
    const result = await runAgent({
      serverId: 's-nudge',
      text: '帮我创建 /tmp/abc 目录',
      autoRun: true,
      send,
      callModel,
      execStream: exec,
      execContext: NOOP_EXEC,
    });
    expect(events.some(e => e.type === 'nudge')).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('done');
    expect(result.answer).toContain('已创建');
  });

  it('取消后停止执行', async () => {
    const { events, send } = collector();
    const controller = new AbortController();
    const exec = vi.fn(async (sid, cmd, opts = {}) => {
      controller.abort();
      return { success: false, error: '已取消', cancelled: true, stdout: '', stderr: '', exitCode: -1 };
    });
    const result = await runAgent({
      serverId: 's6',
      text: '跑个长命令',
      send,
      signal: controller.signal,
      callModel: fakeModel(['RUN: sleep 100']),
      execStream: exec,
      execContext: NOOP_EXEC,
    });
    expect(result.status).toBe('cancelled');
    expect(events.some(e => e.type === 'final')).toBe(false);
  });

  it('模型报错时通过 error 事件传出', async () => {
    const { events, send } = collector();
    const result = await runAgent({
      serverId: 's7',
      text: 'x',
      send,
      callModel: vi.fn(async () => { throw new Error('LLM 超时'); }),
      execStream: EXEC_OK,
      execContext: NOOP_EXEC,
    });
    expect(result.status).toBe('error');
    expect(events.some(e => e.type === 'error' && e.error.includes('LLM 超时'))).toBe(true);
  });

  it('会话开始时会推送采集到的环境摘要', async () => {
    const { events, send } = collector();
    await runAgent({
      serverId: 's8',
      text: 'x',
      send,
      callModel: fakeModel(['ANSWER: ok']),
      execStream: NOOP_EXEC,
      execContext: vi.fn(async () => ({ success: true, stdout: 'OS:Ubuntu 22.04\nCPUS:8\n', stderr: '', exitCode: 0 })),
    });
    const ctxEvent = events.find(e => e.type === 'context_ready');
    expect(ctxEvent).toBeTruthy();
    expect(ctxEvent.context.summary).toContain('Ubuntu 22.04');
  });

  it('失败的命令输出会回灌给模型用于自我修正', async () => {
    const { events, send } = collector();
    const callModel = vi.fn(async (messages) => {
      // 第二次调用时应该能看到上次的 stderr
      if (callModel.mock.calls.length === 2) {
        const last = messages[messages.length - 1].content;
        expect(last).toContain('No such file');
      }
      return callModel.mock.calls.length === 1
        ? { content: 'RUN: ls /nope' }
        : { content: 'ANSWER: 目录不存在' };
    });
    const result = await runAgent({
      serverId: 's9',
      text: '看看 /nope',
      send,
      callModel,
      execStream: vi.fn(async () => ({ success: false, stdout: '', stderr: 'ls: /nope: No such file or directory', exitCode: 2 })),
      execContext: NOOP_EXEC,
    });
    expect(result.status).toBe('done');
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(events.some(e => e.type === 'command_done' && e.exitCode === 2)).toBe(true);
  });
});
