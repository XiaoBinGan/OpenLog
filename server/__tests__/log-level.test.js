import { describe, it, expect } from 'vitest';

const {
  parseLogLevel, isAlertLevel, matchAlertLine, LEVELS,
} = await import('../log-level.js');

describe('parseLogLevel —— 日志等级识别', () => {
  it('方括号前缀', () => {
    expect(parseLogLevel('[ERROR] boom').level).toBe('ERROR');
    expect(parseLogLevel('[WARN] hmm').level).toBe('WARN');
    expect(parseLogLevel('[FATAL] dead').level).toBe('FATAL');
    expect(parseLogLevel('[INFO] ok').level).toBe('INFO');
  });

  it('裸前缀（本次 bug 的核心：旧实现只认 [ERROR]，这种全被当成 INFO）', () => {
    expect(parseLogLevel('ERROR plain failure 0').level).toBe('ERROR');
    expect(parseLogLevel('ERROR: colon style').level).toBe('ERROR');
    expect(parseLogLevel('WARN something mild').level).toBe('WARN');
    expect(parseLogLevel('FATAL cannot continue').level).toBe('FATAL');
  });

  it('JSON 结构化日志', () => {
    expect(parseLogLevel('{"level":"error","msg":"json failure"}').level).toBe('ERROR');
    expect(parseLogLevel('{"level":"ERROR","msg":"x"}').level).toBe('ERROR');
    expect(parseLogLevel('{"severity":"CRITICAL","message":"x"}').level).toBe('FATAL');
    expect(parseLogLevel('{"log":{"level":"warn"},"msg":"x"}').level).toBe('WARN');
    const r = parseLogLevel('{"level":"error","msg":"json failure"}');
    expect(r.content).toBe('json failure');
  });

  it('pino/bunyan 数字等级', () => {
    expect(parseLogLevel('{"level":50,"msg":"pino error"}').level).toBe('ERROR');
    expect(parseLogLevel('{"level":40,"msg":"pino warn"}').level).toBe('WARN');
    expect(parseLogLevel('{"level":30,"msg":"pino info"}').level).toBe('INFO');
  });

  it('时间戳在前', () => {
    expect(parseLogLevel('2026-10-26T18:35:14.532Z ERROR timestamped').level).toBe('ERROR');
    expect(parseLogLevel('2026-10-26 18:35:14,532 - root - ERROR - python logging').level).toBe('ERROR');
    expect(parseLogLevel('2026/10/26 18:35:14 [error] 12#0: nginx style').level).toBe('ERROR');
  });

  it('进程/模块包装前缀（vLLM、logback、syslog）', () => {
    expect(parseLogLevel('(APIServer pid=1) ERROR: vllm style failure').level).toBe('ERROR');
    expect(parseLogLevel('(EngineCore_0 pid=55) ERROR 2026-10-26 -- crash').level).toBe('ERROR');
    expect(parseLogLevel('18:35:14.532 [main] ERROR com.x.App - logback').level).toBe('ERROR');
    expect(parseLogLevel('Oct 26 18:35:14 host app[1]: ERROR syslog style').level).toBe('ERROR');
  });

  it('logfmt：level=error', () => {
    expect(parseLogLevel('level=error msg="logfmt"').level).toBe('ERROR');
    expect(parseLogLevel('time=1 level="warn" msg=x').level).toBe('WARN');
  });

  it('大写兜底：panic / TRACEBACK 之类', () => {
    expect(parseLogLevel('panic: runtime error: nil pointer').level).toBe('FATAL');
    expect(parseLogLevel('java.lang.RuntimeException: FATAL condition').level).toBe('FATAL');
  });

  it('不误报：普通输出、小写 error 文案、0 errors', () => {
    expect(parseLogLevel('normal output line').level).toBe('INFO');
    expect(parseLogLevel('INFO:     172.17.0.1:54416 - "GET /metrics HTTP/1.1" 200 OK').level).toBe('INFO');
    expect(parseLogLevel('0 errors found').level).toBe('INFO');
    expect(parseLogLevel('no error in this run').level).toBe('INFO');
    expect(parseLogLevel('').level).toBe('INFO');
    expect(parseLogLevel(null).level).toBe('INFO');
  });

  it('去掉前缀后的正文（给弹框展示用）', () => {
    expect(parseLogLevel('[ERROR] boom').content).toBe('boom');
    expect(parseLogLevel('ERROR: colon style').content).toBe('colon style');
    expect(parseLogLevel('2026-10-26T18:35:14Z ERROR msg here').content).toContain('msg here');
  });

  it('等级归一化：WARNING→WARN、CRITICAL→FATAL', () => {
    expect(parseLogLevel('[WARNING] x').level).toBe('WARN');
    expect(parseLogLevel('[CRITICAL] x').level).toBe('FATAL');
    expect(parseLogLevel('[SEVERE] x').level).toBe('ERROR');
  });

  it('LEVELS 常量覆盖所有归一化结果', () => {
    for (const line of ['[ERROR] a', '[WARN] b', '[FATAL] c', '[INFO] d', '[DEBUG] e', '[TRACE] f']) {
      expect(LEVELS).toContain(parseLogLevel(line).level);
    }
  });
});

describe('isAlertLevel / matchAlertLine', () => {
  it('ERROR / FATAL 需要告警，WARN 默认不告警', () => {
    expect(isAlertLevel('ERROR')).toBe(true);
    expect(isAlertLevel('FATAL')).toBe(true);
    expect(isAlertLevel('WARN')).toBe(false);
    expect(isAlertLevel('INFO')).toBe(false);
  });

  it('matchAlertLine 按配置等级匹配', () => {
    expect(matchAlertLine('ERROR x').matched).toBe(true);
    expect(matchAlertLine('WARN x').matched).toBe(false);
    expect(matchAlertLine('WARN x', ['ERROR', 'FATAL', 'WARN']).matched).toBe(true);
    expect(matchAlertLine('INFO x', ['ERROR']).matched).toBe(false);
  });
});