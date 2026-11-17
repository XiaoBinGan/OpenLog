/**
 * server/__tests__/diagnosis-evidence.test.js
 *
 * 「没完成、没测指标的容器不要报错」这条规则的回归测试。
 *
 * 真实背景（生产 100.100.152.243 实测）：87 个容器里 42 个的 log driver 是 `none`，
 * /api/docker/health-check 报了 51 个问题容器、全部 state=exited：
 *   · 41 个的唯一"错误"是 HTTP 501「configured logging driver does not support reading」
 *   · 10 个连错误行都没有
 *   · 退出时间从 4 天前到 7 个月前
 * 也就是这些容器从来没有日志/指标被采集过，退出码属于历史考古。
 *
 * 这里测的是判定逻辑本身，不碰 docker。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseExitedAgoMs,
  isLogDriverUnreadable,
  classifyProblemEvidence,
  splitHealthProblems,
  DEFAULT_EXITED_STALE_HOURS,
} from '../diagnosis.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('parseExitedAgoMs —— 从 docker Status 文案读退出多久了', () => {
  it('解析常见单位', () => {
    expect(parseExitedAgoMs('Exited (2) 7 days ago')).toBe(7 * 86_400_000);
    expect(parseExitedAgoMs('Exited (1) 2 weeks ago')).toBe(2 * 604_800_000);
    expect(parseExitedAgoMs('Exited (137) 3 months ago')).toBe(3 * 2_592_000_000);
    expect(parseExitedAgoMs('Exited (0) 24 hours ago')).toBe(24 * 3_600_000);
    expect(parseExitedAgoMs('Exited (1) 5 minutes ago')).toBe(5 * 60_000);
    expect(parseExitedAgoMs('Exited (1) 30 seconds ago')).toBe(30_000);
    expect(parseExitedAgoMs('Exited (1) 1 second ago')).toBe(1_000);
    expect(parseExitedAgoMs('Exited (1) 2 years ago')).toBe(2 * 31_536_000_000);
  });

  it('"About an hour ago" / "Less than a second ago" 也认', () => {
    expect(parseExitedAgoMs('Exited (1) About an hour ago')).toBe(3_600_000);
    expect(parseExitedAgoMs('Exited (1) About a minute ago')).toBe(60_000);
    expect(parseExitedAgoMs('Exited (0) Less than a second ago')).toBe(0);
  });

  it('运行中的容器返回 0', () => {
    expect(parseExitedAgoMs('Up 5 days')).toBe(0);
    expect(parseExitedAgoMs('Up 21 hours (healthy)')).toBe(0);
  });

  it('解析不出来返回 null，不瞎猜', () => {
    expect(parseExitedAgoMs('Created')).toBeNull();
    expect(parseExitedAgoMs('Exited (1)')).toBeNull();
    expect(parseExitedAgoMs('')).toBeNull();
    expect(parseExitedAgoMs(null)).toBeNull();
    expect(parseExitedAgoMs(undefined)).toBeNull();
    expect(parseExitedAgoMs(123)).toBeNull();
  });
});

describe('isLogDriverUnreadable —— 501 是"我们读不出"，不是"容器报错"', () => {
  it('认 docker 的原始 501 文案', () => {
    expect(isLogDriverUnreadable(
      '读取日志失败: (HTTP code 501) unexpected - configured logging driver does not support reading',
    )).toBe(true);
  });

  it('几种写法都覆盖', () => {
    expect(isLogDriverUnreadable('logging driver does not support reading')).toBe(true);
    expect(isLogDriverUnreadable('(HTTP code 501) unexpected')).toBe(true);
  });

  it('真实容器错误不误判', () => {
    expect(isLogDriverUnreadable('读取日志失败: (HTTP code 404) no such container')).toBe(false);
    expect(isLogDriverUnreadable('OOMKilled')).toBe(false);
    expect(isLogDriverUnreadable('')).toBe(false);
    expect(isLogDriverUnreadable(null)).toBe(false);
  });
});

describe('classifyProblemEvidence —— 三类分流', () => {
  const staleHours = 24;
  const oldStatus = 'Exited (1) 3 months ago';
  const oldAgo = parseExitedAgoMs(oldStatus);

  it('退出超过阈值的算历史（stale）', () => {
    expect(classifyProblemEvidence({
      state: 'exited', exitType: 'error', status: oldStatus, exitedAgoMs: oldAgo,
      errors: ['real error'], logUnavailable: false,
    }, { staleHours })).toBe('stale');
  });

  it('刚退出的异常容器照样报（problem）', () => {
    expect(classifyProblemEvidence({
      state: 'exited', exitType: 'error', status: 'Exited (1) 10 minutes ago',
      exitedAgoMs: parseExitedAgoMs('Exited (1) 10 minutes ago'),
      errors: ['boom'], logUnavailable: false,
    }, { staleHours })).toBe('problem');
  });

  it('OOM / 段错误即使日志读不出来也不过滤', () => {
    const base = {
      state: 'exited', status: 'Exited (137) 2 hours ago',
      exitedAgoMs: parseExitedAgoMs('Exited (137) 2 hours ago'),
      errors: [], logUnavailable: true, logDriverUnreadable: true,
    };
    expect(classifyProblemEvidence({ ...base, exitType: 'oom' }, { staleHours })).toBe('problem');
    expect(classifyProblemEvidence({ ...base, exitType: 'segfault' }, { staleHours })).toBe('problem');
  });

  it('日志读不出来且无任何证据 → unobserved，不报', () => {
    expect(classifyProblemEvidence({
      state: 'exited', exitType: 'error', status: 'Exited (1) 5 minutes ago',
      exitedAgoMs: parseExitedAgoMs('Exited (1) 5 minutes ago'),
      errors: [], logUnavailable: true, logDriverUnreadable: true,
    }, { staleHours })).toBe('unobserved');
  });

  it('读到了真实错误行就打不过滤（有证据）', () => {
    expect(classifyProblemEvidence({
      state: 'exited', exitType: 'error', status: 'Exited (1) 5 minutes ago',
      exitedAgoMs: parseExitedAgoMs('Exited (1) 5 minutes ago'),
      errors: ['[t] panic: nil map'], logUnavailable: true, logDriverUnreadable: true,
    }, { staleHours })).toBe('problem');
  });

  it('运行中的容器永远算 problem，跟退出时长无关', () => {
    expect(classifyProblemEvidence({
      state: 'running', exitType: 'log', errors: [], logUnavailable: true, logDriverUnreadable: true,
    }, { staleHours })).toBe('problem');
  });

  it('staleHours=0 表示不过滤历史容器', () => {
    expect(classifyProblemEvidence({
      state: 'exited', exitType: 'error', status: oldStatus, exitedAgoMs: oldAgo,
      errors: ['real error'], logUnavailable: false,
    }, { staleHours: 0 })).toBe('problem');
  });

  it('ignoreUnobserved=false 时把未采集容器也报出来', () => {
    expect(classifyProblemEvidence({
      state: 'exited', exitType: 'error', status: 'Exited (1) 5 minutes ago',
      exitedAgoMs: 300_000, errors: [], logUnavailable: true, logDriverUnreadable: true,
    }, { staleHours, ignoreUnobserved: false })).toBe('problem');
  });

  it('空参数不炸，走默认阈值', () => {
    expect(DEFAULT_EXITED_STALE_HOURS).toBe(24);
    expect(() => classifyProblemEvidence(null)).not.toThrow();
    expect(classifyProblemEvidence(null)).toBe('problem');
  });

  it('退出时长未知（status 解析不出来）不当成历史', () => {
    expect(classifyProblemEvidence({
      state: 'exited', exitType: 'error', status: 'Exited (1)', exitedAgoMs: null,
      errors: ['x'], logUnavailable: false,
    }, { staleHours })).toBe('problem');
  });
});

describe('splitHealthProblems —— 分流并给出计数', () => {
  it('生产那 51 个噪音应当被清空', () => {
    const entries = [];
    // 41 个 501：日志驱动不支持读取，无其它证据
    for (let i = 0; i < 41; i += 1) {
      entries.push({
        name: `oneoff_${i}`, state: 'exited', exitType: 'error',
        status: 'Exited (1) 3 months ago', exitedAgoMs: parseExitedAgoMs('Exited (1) 3 months ago'),
        errors: [], logUnavailable: true, logDriverUnreadable: true,
      });
    }
    // 7 个 OOM，3 个月前
    for (let i = 0; i < 7; i += 1) {
      entries.push({
        name: `oom_${i}`, state: 'exited', exitType: 'oom',
        status: 'Exited (137) 7 months ago', exitedAgoMs: parseExitedAgoMs('Exited (137) 7 months ago'),
        errors: [], logUnavailable: false,
      });
    }
    // 3 个近期异常退出，带真实日志 → 只有这 3 个该留下
    for (let i = 0; i < 3; i += 1) {
      entries.push({
        name: `real_${i}`, state: 'exited', exitType: 'error',
        status: 'Exited (1) 1 hour ago', exitedAgoMs: parseExitedAgoMs('Exited (1) 1 hour ago'),
        errors: ['[t] panic: boom'], logUnavailable: false,
      });
    }

    const { problems, stale, unobserved, counts } = splitHealthProblems(entries, { staleHours: 24 });
    expect(problems.map(p => p.name)).toEqual(['real_0', 'real_1', 'real_2']);
    expect(stale).toHaveLength(48);
    expect(unobserved).toHaveLength(0);
    expect(counts).toEqual({ stale: 48, unobserved: 0 });
  });

  it('未采集容器进 unobserved 而不是 stale', () => {
    const { problems, unobserved, counts } = splitHealthProblems([{
      name: 'ghost', state: 'exited', exitType: 'error',
      status: 'Exited (2) 10 minutes ago', exitedAgoMs: parseExitedAgoMs('Exited (2) 10 minutes ago'),
      errors: [], logUnavailable: true, logDriverUnreadable: true,
    }], { staleHours: 24 });
    expect(problems).toHaveLength(0);
    expect(unobserved).toHaveLength(1);
    expect(counts.unobserved).toBe(1);
  });

  it('非数组输入不炸', () => {
    expect(() => splitHealthProblems(null)).not.toThrow();
    expect(splitHealthProblems(null).problems).toEqual([]);
    expect(splitHealthProblems(undefined).counts).toEqual({ stale: 0, unobserved: 0 });
  });
});

describe('源码约束 —— healthCheck 别再犯那两个 bug', () => {
  const dockerSrc = fs.readFileSync(path.join(ROOT, 'server', 'docker.js'), 'utf8');

  it('不用 logResult.logs（getContainerLogs 返回数组）', () => {
    expect(dockerSrc).not.toContain('logResult.logs');
  });

  it('getContainerLogs 真的接受第 4 个参数 tail', () => {
    expect(dockerSrc).toMatch(/export async function getContainerLogs\(sourceId, containerId, config = \{\}, opts = \{\}\)/);
    expect(dockerSrc).toContain('Math.min(Math.floor(tailNum), 5000)');
  });

  it('healthCheck 走 evidence 分类，unhealthy 来自过滤后的 problems', () => {
    expect(dockerSrc).toContain('classifyProblemEvidence(entry, filterOpts)');
    expect(dockerSrc).toContain('unhealthy: problemDetails.length');
    expect(dockerSrc).toContain('ignoredStale');
    expect(dockerSrc).toContain('ignoredUnobserved');
  });

  it('读不到日志不写进 errors（不把采集失败伪装成容器报错）', () => {
    expect(dockerSrc).not.toContain('errors: [`无法获取日志: ${errorMessage(err)}`]');
    expect(dockerSrc).toContain('logDriverUnreadable = isLogDriverUnreadable(msg)');
  });
});
