/**
 * server/__tests__/diagnosis.test.js
 *
 * 回归背景（用户报的三个问题）：
 *   1. 容器健康分析在没配模型 Key 时直接报「未配置 API Key」，等于什么都没说
 *   2. AI 分析页巡检到日志报错，点「开始容器诊断」却说「没有异常容器」
 *   3. 容器反复报错会不停弹新的 toast
 *
 * 这里把三件事的核心纯逻辑锁住：退出码解释、规则诊断正文、巡检结果合并。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  explainExitCode, buildRuleDiagnosis, mergePatrolProblems, diagnosisToastKey,
} from '../diagnosis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

describe('explainExitCode —— 退出码翻译成人话', () => {
  it('137 说明是 SIGKILL（OOM 最常见）', () => {
    expect(explainExitCode(137)).toContain('SIGKILL');
    expect(explainExitCode(137)).toContain('OOM');
  });

  it('139 段错误 / 143 SIGTERM / 1 通用错误', () => {
    expect(explainExitCode(139)).toContain('SIGSEGV');
    expect(explainExitCode(143)).toContain('SIGTERM');
    expect(explainExitCode(1)).toContain('通用错误');
  });

  it('125/126/127 是 docker 与命令层面的错误', () => {
    expect(explainExitCode(125)).toContain('docker');
    expect(explainExitCode(126)).toContain('权限');
    expect(explainExitCode(127)).toContain('找不到命令');
  });

  it('>128 按「128+信号」解释，未知值不崩', () => {
    expect(explainExitCode(200)).toContain('128+72');
    expect(() => explainExitCode(null)).not.toThrow();
    expect(explainExitCode(null)).toContain('未知');
    expect(explainExitCode(undefined)).toContain('未知');
    expect(explainExitCode('')).toContain('未知');
  });
});

describe('buildRuleDiagnosis —— 没配 Key 也要给出结论', () => {
  const text = buildRuleDiagnosis({
    title: '容器 api 异常退出诊断（规则诊断）',
    lines: ['- 镜像: web:1.0', '- 退出码 137 = 128+9：被 SIGKILL 杀掉'],
  });

  it('带标题和事实行', () => {
    expect(text).toContain('容器 api 异常退出诊断');
    expect(text).toContain('web:1.0');
    expect(text).toContain('SIGKILL');
  });

  it('明确标注是规则诊断，不是模型分析', () => {
    expect(text).toContain('规则诊断');
    expect(text).toContain('没有调用模型');
  });

  it('给出下一步（去哪配 Key）', () => {
    expect(text).toContain('API Key');
    expect(text).toContain('设置');
  });

  it('过滤空行，不报错', () => {
    expect(() => buildRuleDiagnosis({ title: 'x', lines: [null, '', 'a'] })).not.toThrow();
    expect(buildRuleDiagnosis({ title: 'x', lines: [null, '', 'a'] })).toContain('a');
  });
});

describe('mergePatrolProblems —— 巡检到的日志异常要进健康报告', () => {
  const emptyReport = () => ({
    summary: { total: 3, running: 3, unhealthy: 0 },
    problems: [],
    running: [],
  });

  it('把日志异常容器并进 problems，并更新 unhealthy 计数', () => {
    const report = mergePatrolProblems(emptyReport(), [
      {
        containerName: 'api',
        sourceName: '本机',
        image: 'web:1.0',
        uniqueCount: 2,
        matchCount: 5,
        lines: [
          { level: 'ERROR', content: 'boom' },
          { level: 'FATAL', content: 'dead' },
        ],
      },
    ]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({
      name: 'api', sourceName: '本机', exitType: 'log', state: 'running',
    });
    expect(report.problems[0].errors.join('\n')).toContain('boom');
    expect(report.problems[0].errors.join('\n')).toContain('[FATAL]');
    expect(report.summary.unhealthy).toBe(1);
  });

  it('同一个容器已经在退出类问题里就不再重复添加', () => {
    const report = emptyReport();
    report.problems.push({ name: 'api', sourceName: '本机', exitType: 'error' });
    mergePatrolProblems(report, [{ containerName: 'api', sourceName: '本机', lines: [] }]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].exitType).toBe('error');
  });

  it('没有巡检结果时原样返回（不误报）', () => {
    const report = emptyReport();
    expect(mergePatrolProblems(report, [])).toBe(report);
    expect(report.problems).toHaveLength(0);
    expect(() => mergePatrolProblems(report, null)).not.toThrow();
  });

  it('巡检结果缺字段也不崩', () => {
    const report = emptyReport();
    expect(() => mergePatrolProblems(report, [{}, null])).not.toThrow();
    expect(report.problems.length).toBeGreaterThanOrEqual(1);
  });
});

describe('diagnosisToastKey —— 同一容器只占一条 toast', () => {
  it('来源+容器名一致则键一致', () => {
    expect(diagnosisToastKey({ sourceId: 's1', containerName: 'api' }))
      .toBe(diagnosisToastKey({ sourceId: 's1', containerName: 'api' }));
  });
  it('不同容器键不同', () => {
    expect(diagnosisToastKey({ sourceId: 's1', containerName: 'a' }))
      .not.toBe(diagnosisToastKey({ sourceId: 's1', containerName: 'b' }));
  });
});

describe('源码约束 —— 别再退回「未配置 API Key」死路', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'docker.js'), 'utf8');

  it('三个诊断端点都不再用 400 拒绝（改为规则诊断）', () => {
    expect(src).not.toContain("res.status(400).json({ error: '未配置 API Key' })");
  });

  it('health-check 合并了巡检结果', () => {
    expect(src).toContain('mergePatrolProblems(await docker.healthCheck(sources), getLastPatrolResults())');
  });

  it('规则诊断走 SSE，前端 readSSEStream 能直接消费', () => {
    expect(src).toContain('sseText(res, buildRuleDiagnosis(');
  });
});
