/**
 * log-level.js — 从一行容器日志里识别日志等级。
 *
 * 背景（真实 bug）：原来只认 `[ERROR] xxx` 这一种前缀，
 * 于是这些非常常见的格式全都被当成 INFO，巡检/实时告警永远不触发：
 *
 *   ERROR plain failure                     ← 裸前缀
 *   {"level":"error","msg":"...."}          ← JSON（Python/Node/Go 结构化日志）
 *   2026-10-26T18:35:14Z ERROR msg           ← 时间戳在前
 *   (APIServer pid=1) ERROR: msg             ← vLLM / uvicorn 包装前缀
 *   level=error msg="..."                    ← logfmt（Go logrus）
 *   Oct 26 18:35:14 host app[1]: ERROR msg   ← syslog
 *   2026-10-26 18:35:14,532 - root - ERROR - msg   ← Python logging
 *   18:35:14.532 [main] ERROR com.x.App - msg ← logback
 *   2026/10/26 18:35:14 [error] 12#0: msg    ← nginx
 *
 * 这个模块是纯函数，方便单测；docker.js 的容器日志解析与文件日志扫描共用它。
 */

/** 归一化后的等级（用于和设置里的 containerPatrolLevels 比较） */
export const LEVELS = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

/** 这些等级被视为「异常」，用于实时告警 */
export const ALERT_LEVELS = new Set(['FATAL', 'ERROR']);

/** 各种写法 → 归一化等级 */
const LEVEL_ALIASES = {
  FATAL: 'FATAL',
  CRITICAL: 'FATAL',
  CRIT: 'FATAL',
  PANIC: 'FATAL',
  EMERG: 'FATAL',
  EMERGENCY: 'FATAL',
  ALERT: 'FATAL',
  ERROR: 'ERROR',
  ERR: 'ERROR',
  SEVERE: 'ERROR',
  WARNING: 'WARN',
  WARN: 'WARN',
  NOTICE: 'INFO',
  INFO: 'INFO',
  INFORMATION: 'INFO',
  DEBUG: 'DEBUG',
  TRACE: 'TRACE',
  VERBOSE: 'TRACE',
};

/** 等级词（长的在前，避免 ERROR 抢先匹配 ERRORGROUP 之类） */
const LEVEL_WORD_SOURCE = Object.keys(LEVEL_ALIASES)
  .sort((a, b) => b.length - a.length)
  .join('|');

function normalizeLevel(word) {
  if (!word) return null;
  return LEVEL_ALIASES[String(word).toUpperCase()] || null;
}

/** 从 JSON 对象里取等级（支持常见字段名，含嵌套的 log.level） */
function levelFromJsonObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.level, obj.Level, obj.LEVEL,
    obj.severity, obj.severityText, obj.severity_text,
    obj.lvl, obj.log_level, obj.logLevel,
    obj.log?.level, obj.log?.severity,
  ];
  for (const value of candidates) {
    if (typeof value === 'string') {
      const level = normalizeLevel(value.trim());
      if (level) return level;
    }
    // 部分库用数字等级（syslog/pino/bunyan）：50=error 40=warn 30=info 20=debug 10=trace
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value >= 50) return 'ERROR';
      if (value >= 40) return 'WARN';
      if (value >= 30) return 'INFO';
      if (value >= 20) return 'DEBUG';
      if (value >= 10) return 'TRACE';
    }
  }
  return null;
}

/**
 * 解析一行日志的等级。
 * @param {string} line
 * @returns {{ level: string, content: string }}
 *   level 为归一化等级；content 为去掉等级前缀后的正文
 */
export function parseLogLevel(line) {
  const raw = typeof line === 'string' ? line : String(line ?? '');
  if (!raw.trim()) return { level: 'INFO', content: raw };

  // 1) JSON 结构化日志：整行或行内第一个 {...}
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const level = levelFromJsonObject(JSON.parse(trimmed));
      if (level) {
        const msg = (() => {
          try {
            const obj = JSON.parse(trimmed);
            const text = obj.msg ?? obj.message ?? obj.text ?? obj.log;
            return typeof text === 'string' ? text : trimmed;
          } catch { return trimmed; }
        })();
        return { level, content: msg };
      }
    } catch { /* 不是合法 JSON，继续按文本解析 */ }
  }

  // 2) 括号包裹：[ERROR] / [error] / [WARN]  (可选带时间戳前缀)
  let m = raw.match(
    new RegExp(`^(?:\\[[^\\]]*\\]\\s*)*?[\\s]*(?:([\\w:./-]+[T ][\\d:.+-]+)\\s+)?\\[\\s*(${LEVEL_WORD_SOURCE})\\s*\\]\\s*:?\\s*`, 'i'),
  );
  if (m) {
    const level = normalizeLevel(m[2]);
    if (level) return { level, content: raw.slice(m[0].length) };
  }

  // 3) 行首就是等级词（可带冒号）："ERROR: xxx" / "WARN xxx"
  m = raw.match(new RegExp(`^\\s*(${LEVEL_WORD_SOURCE})\\s*:?\\s+`, 'i'));
  if (m) {
    const level = normalizeLevel(m[1]);
    if (level) return { level, content: raw.slice(m[0].length) };
  }

  // 4) 时间戳 / 主机名 / 进程前缀之后再出现等级词
  //    覆盖：ISO 时间戳、syslog 时间、nginx 时间、logback "[main]"、"(APIServer pid=1)"、
  //    "18:35:14.532"、"2026-10-26 18:35:14,532 - root -"
  m = raw.match(
    new RegExp(
      `^(?:\\[[^\\]]*\\]\\s*)*` +                        // 开头的 [xxx]
      `(?:[\\w./-]*\\d{1,4}[-/:]\\d{1,2}[-/:]\\d{1,4}[T ][\\d:.,+-]+\\S*\\s+)?` + // 时间戳
      `(?:\\[?\\s*\\d{1,3}:\\d{1,3}\\s*\\]?\\s+)?` +      // nginx "12#0:"
      `(?:[A-Za-z0-9_.-]+\\[\\d+\\]\\s*:?\\s+)?` +        // syslog "app[123]:"
      `(?:\\([^)]*\\)\\s*)?` +                          // "(APIServer pid=1)"
      `(?:[\\w.-]+\\s+-\\s+)*` +                        // python "- root -"
      `(?:::?\\s*)?` +
      `(${LEVEL_WORD_SOURCE})\\b\\s*:?\\s*`,
      'i',
    ),
  );
  if (m) {
    const level = normalizeLevel(m[1]);
    if (level) return { level, content: raw.slice(m[0].length) };
  }

  // 5) logfmt：level=error / lvl="ERROR"
  m = raw.match(new RegExp(`(?:^|\\s)(?:level|lvl|severity|log_level)=["']?(${LEVEL_WORD_SOURCE})["']?`, 'i'));
  if (m) {
    const level = normalizeLevel(m[1]);
    if (level) return { level, content: raw };
  }

  // 6) 兜底：整行里出现独立的大写等级词（ERROR / FATAL / CRITICAL）
  //    只接受全大写，避免 "0 errors" / "no error found" 之类误报
  m = raw.match(/\b(ERROR|FATAL|CRITICAL|PANIC)\b/);
  if (m) {
    const level = normalizeLevel(m[1]);
    if (level) return { level, content: raw };
  }
  m = raw.match(/\b(WARNING|WARN)\b/);
  if (m) {
    const level = normalizeLevel(m[1]);
    if (level) return { level, content: raw };
  }

  // 7) 真·无等级信息（裸请求行、普通输出）
  return { level: 'INFO', content: raw };
}

/** 该等级是否需要弹框告警 */
export function isAlertLevel(level) {
  return ALERT_LEVELS.has(String(level || '').toUpperCase());
}

/**
 * 判断一行日志是否命中「异常」。
 * @param {string} line
 * @param {string[]} [levels] 命中哪些等级算异常，默认 ERROR + FATAL
 */
export function matchAlertLine(line, levels = ['ERROR', 'FATAL']) {
  const parsed = parseLogLevel(line);
  const wanted = new Set((levels || []).map(l => normalizeLevel(l) || String(l).toUpperCase()));
  return { ...parsed, matched: wanted.has(parsed.level) };
}
