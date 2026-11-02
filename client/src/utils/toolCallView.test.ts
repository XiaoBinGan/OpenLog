/**
 * client/src/utils/toolCallView.test.ts
 *
 * 用户反馈：运维助手的工具调用只显示一个小 chip，看不到执行了什么、输出了什么，
 * 体验远不如 AI Shell 的步骤卡。这里锁住步骤卡的「摘要 / 输出 / 状态 / 耗时」逻辑。
 */
import { describe, it, expect } from 'vitest';
import {
  toolLabel, toolCallStatus, toolCallSummary, toolCallOutput,
  toolCallExitCode, durationLabel, hasDetails,
} from './toolCallView';

describe('toolLabel —— 工具名转人话', () => {
  it('已知工具用中文，未知工具原样显示', () => {
    expect(toolLabel('remote_exec')).toBe('执行命令');
    expect(toolLabel('remote_grep')).toBe('搜索');
    expect(toolLabel('some_new_tool')).toBe('some_new_tool');
    expect(toolLabel('')).toBe('工具');
  });
});

describe('toolCallSummary —— 一步的摘要', () => {
  it('命令优先（压缩空白 + 截断）', () => {
    expect(toolCallSummary({ tool: 'remote_exec', args: { command: 'df   -h\n&& free -m' } }))
      .toBe('df -h && free -m');
  });

  it('没有命令时依次用路径 / 搜索词 / 服务器', () => {
    expect(toolCallSummary({ tool: 'remote_read_file', args: { filePath: '/var/log/a.log' } })).toBe('/var/log/a.log');
    expect(toolCallSummary({ tool: 'remote_ls', args: { path: '/etc' } })).toBe('/etc');
    expect(toolCallSummary({ tool: 'remote_grep', args: { pattern: 'ERROR' } })).toBe('/ERROR/');
    expect(toolCallSummary({ tool: 'remote_system_stats', args: { serverId: 'srv-1' } })).toBe('srv-1');
  });

  it('空参数返回空串，不崩', () => {
    expect(toolCallSummary({ tool: 'docker_list', args: {} })).toBe('');
    expect(toolCallSummary(null)).toBe('');
  });

  it('长命令截断到 160 字符', () => {
    const out = toolCallSummary({ tool: 'remote_exec', args: { command: 'a'.repeat(500) } });
    expect(out.length).toBe(160);
  });
});

describe('toolCallStatus —— 状态归类', () => {
  it('running / done / error / aborted', () => {
    expect(toolCallStatus({ tool: 'x', status: 'running' })).toBe('running');
    expect(toolCallStatus({ tool: 'x', status: 'done', result: {} })).toBe('ok');
    expect(toolCallStatus({ tool: 'x', status: 'done', result: { error: 'boom' } })).toBe('failed');
    expect(toolCallStatus({ tool: 'x', status: 'aborted' })).toBe('aborted');
  });

  it('没有 status 但有结果也算完成', () => {
    expect(toolCallStatus({ tool: 'x', result: { ok: 1 } })).toBe('ok');
  });
});

describe('toolCallOutput —— 可展示输出', () => {
  it('运行中优先显示流式输出（AI Shell 式边跑边看）', () => {
    const out = toolCallOutput({ tool: 'remote_exec', status: 'running', liveOutput: 'line1\nline2' });
    expect(out.text).toBe('line1\nline2');
    expect(out.kind).toBe('stdout');
  });

  it('完成后显示 stdout+stderr', () => {
    const out = toolCallOutput({
      tool: 'remote_exec', status: 'done',
      result: { stdout: 'out', stderr: 'err', exitCode: 1 },
    });
    expect(out.text).toContain('out');
    expect(out.text).toContain('err');
  });

  it('docker_exec 的 output 字段也能显示', () => {
    expect(toolCallOutput({ tool: 'docker_exec', result: { output: 'container out', exitCode: 0 } }).text)
      .toBe('container out');
  });

  it('读文件结果显示 content', () => {
    const out = toolCallOutput({ tool: 'remote_read_file', result: { content: '# log\nboom' } });
    expect(out.text).toContain('boom');
    expect(out.kind).toBe('content');
  });

  it('错误优先显示 error 文本', () => {
    expect(toolCallOutput({ tool: 'x', result: { error: '权限不足' } }).text).toBe('权限不足');
  });

  it('超过 limit 截断并标记', () => {
    const out = toolCallOutput({ tool: 'x', result: { stdout: 'a'.repeat(100) } }, 10);
    expect(out.text.length).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it('超大结果被后端截断时显示 preview', () => {
    const out = toolCallOutput({ tool: 'x', result: { truncated: true, preview: '{"a":1}' } });
    expect(out.text).toContain('"a":1');
  });

  it('空输入不崩', () => {
    expect(toolCallOutput(null)).toEqual({ text: '', truncated: false, kind: 'none' });
    expect(toolCallOutput({ tool: 'x', result: null }).kind).toBe('none');
  });
});

describe('toolCallExitCode / durationLabel / hasDetails', () => {
  it('退出码只取数字', () => {
    expect(toolCallExitCode({ tool: 'x', result: { exitCode: 137 } })).toBe(137);
    expect(toolCallExitCode({ tool: 'x', result: { exitCode: '0' } })).toBeNull();
    expect(toolCallExitCode({ tool: 'x', result: null })).toBeNull();
  });

  it('耗时格式化', () => {
    expect(durationLabel(320)).toBe('320ms');
    expect(durationLabel(1500)).toBe('1.5s');
    expect(durationLabel(45200)).toBe('45s');
    expect(durationLabel(undefined)).toBeNull();
    expect(durationLabel(-1)).toBeNull();
  });

  it('有输出或 diff 预览才展示展开按钮', () => {
    expect(hasDetails({ tool: 'x', result: { stdout: 'a' } })).toBe(true);
    expect(hasDetails({ tool: 'x', result: { preview: '+1 -1' } })).toBe(true);
    expect(hasDetails({ tool: 'x', result: {} })).toBe(false);
    expect(hasDetails(null)).toBe(false);
  });
});
