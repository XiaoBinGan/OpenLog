/**
 * client/src/utils/analysisNotice.test.ts
 *
 * AI 分析结果 → 通知中心。之前分析结果只在右下角浮层显示，不进通知列表，
 * 也就无法筛选/导出（用户要求「分析结果并入通知中心（可导出）」）。
 */
import { describe, it, expect } from 'vitest';
import { buildAnalysisNotice, analysisTargetName, clipAnalysis, ANALYSIS_STORE_CHARS } from './analysisNotice';

const log = { source: '/var/log/nginx/error.log', level: 'ERROR', message: 'connect() failed (111: Connection refused)' };

describe('analysisTargetName —— 可读的目标名', () => {
  it('日志路径取文件名', () => {
    expect(analysisTargetName({ log: { source: '/var/log/nginx/error.log' } })).toBe('error.log');
  });
  it('容器名/来源名直接用', () => {
    expect(analysisTargetName({ log: { source: 'openlog-api' } })).toBe('openlog-api');
    expect(analysisTargetName({ sourceName: '4090服务器' })).toBe('4090服务器');
  });
  it('都没有时给兜底名', () => {
    expect(analysisTargetName({})).toBe('日志');
  });
  it('Windows 路径也能取到文件名', () => {
    expect(analysisTargetName({ log: { source: 'C:\\logs\\app.log' } })).toBe('app.log');
  });
});

describe('clipAnalysis —— 分析正文截断（避免撑爆 localStorage）', () => {
  it('短文本原样返回', () => {
    expect(clipAnalysis('根因是连接池打满')).toBe('根因是连接池打满');
  });
  it('超长文本截断并标注', () => {
    const out = clipAnalysis('x'.repeat(ANALYSIS_STORE_CHARS + 500));
    expect(out.length).toBeLessThan(ANALYSIS_STORE_CHARS + 200);
    expect(out).toContain('已截断');
  });
  it('空值返回空串', () => {
    expect(clipAnalysis(null)).toBe('');
    expect(clipAnalysis(undefined)).toBe('');
  });
});

describe('buildAnalysisNotice —— 只把 done/error/skipped 转成通知', () => {
  it('pending 不生成通知（分析刚开始没必要进列表）', () => {
    expect(buildAnalysisNotice({ status: 'pending', log })).toBeNull();
  });

  it('done：info 类型，标题带目标名，描述是结论首行', () => {
    const n = buildAnalysisNotice({
      status: 'done',
      sourceId: 'srv-1',
      analysis: '## 🔍 根因分析\n后端连接池被打满，新连接全部超时。\n\n## 💡 修复建议\n1. 调大 max_connections',
      log,
    })!;
    expect(n.type).toBe('info');
    expect(n.message).toContain('error.log');
    expect(n.message).toContain('分析完成');
    expect(n.description).toContain('根因分析');
    expect(n.nav).toBe('/analysis-history');
  });

  it('done：完整分析正文进 errorContent（导出时能看到全文）', () => {
    const analysis = '## 根因分析\n连接池满\n## 修复建议\n调大连接数';
    const n = buildAnalysisNotice({ status: 'done', sourceId: 'srv-1', analysis, log })!;
    expect(n.meta.errorContent).toBe(analysis);
    expect(n.meta.errorType).toBe('AI 分析');
    expect(n.meta.sourceId).toBe('srv-1');
    expect(n.meta.level).toBe('ERROR');
  });

  it('error：error 类型，带失败原因和原始日志', () => {
    const n = buildAnalysisNotice({ status: 'error', sourceId: 's1', message: '分析失败: 401 Unauthorized', log })!;
    expect(n.type).toBe('error');
    expect(n.message).toContain('分析失败');
    expect(n.meta.errorContent).toContain('401 Unauthorized');
    expect(n.meta.errorContent).toContain('Connection refused');
  });

  it('skipped：warning 类型（通常是没配 LLM）', () => {
    const n = buildAnalysisNotice({ status: 'skipped', sourceId: 's1', message: '未配置 LLM，无法自动分析。', log })!;
    expect(n.type).toBe('warning');
    expect(n.message).toContain('跳过');
    expect(n.meta.errorContent).toContain('未配置 LLM');
  });

  it('同来源的多次分析合并成一条（group 稳定）', () => {
    const a = buildAnalysisNotice({ status: 'done', sourceId: 's1', analysis: 'A', log })!;
    const b = buildAnalysisNotice({ status: 'done', sourceId: 's1', analysis: 'B', log })!;
    expect(a.group).toBe(b.group);
    expect(a.group).toContain('s1');
  });

  it('不同来源不合并', () => {
    const a = buildAnalysisNotice({ status: 'done', sourceId: 's1', log: { source: 'a.log' } })!;
    const b = buildAnalysisNotice({ status: 'done', sourceId: 's2', log: { source: 'a.log' } })!;
    expect(a.group).not.toBe(b.group);
  });

  it('没有 analysis 时用原始日志兜底（导出不会空白）', () => {
    const n = buildAnalysisNotice({ status: 'done', sourceId: 's1', log })!;
    expect(n.meta.errorContent).toContain('Connection refused');
  });

  it('缺字段不崩', () => {
    expect(() => buildAnalysisNotice({})).not.toThrow();
    expect(buildAnalysisNotice({})).toBeNull();
  });
});
