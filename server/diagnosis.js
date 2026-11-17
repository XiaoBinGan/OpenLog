/**
 * server/diagnosis.js — 容器诊断里的纯逻辑（无 IO、无 LLM，可单测）
 *
 * 抽出来的原因：这些规则决定「用户点诊断后看到什么」，是最容易出错、
 * 也最值得回归测试的部分，但原先埋在 routes/docker.js 里跟 express / dockerode
 * 缠在一起，没法单独测。
 */

/**
 * 退出码的人话解释。
 * @param {number|string} code docker 的 ExitCode
 * @returns {string}
 */
export function explainExitCode(code) {
  const n = Number(code);
  if (code === null || code === undefined || code === '' || Number.isNaN(n)) return '退出码未知';
  if (n === 0) return '退出码 0：正常退出';
  if (n === 137) return '退出码 137 = 128+9：被 SIGKILL 杀掉，最常见是 OOM（内存超限）或 docker stop';
  if (n === 139) return '退出码 139 = 128+11：段错误 SIGSEGV（原生代码/驱动问题）';
  if (n === 143) return '退出码 143 = 128+15：收到 SIGTERM（正常停止流程）';
  if (n === 1) return '退出码 1：通用错误退出，需要看日志定位';
  if (n === 125) return '退出码 125：docker 自身报错（参数/镜像问题），容器没真正启动';
  if (n === 126) return '退出码 126：命令不可执行（权限问题）';
  if (n === 127) return '退出码 127：找不到命令（镜像里没这个可执行文件）';
  if (n > 128) return `退出码 ${n} = 128+${n - 128}：收到信号 ${n - 128} 后退出`;
  return `退出码 ${n}：异常退出`;
}

/**
 * 没有模型 API Key 时的「规则诊断」正文。
 *
 * 关键决定：**不返回 400「未配置 API Key」**。用户点诊断是想知道容器怎么了，
 * 一句「没配 key」等于什么都没说。所以把已知事实（退出码含义、异常日志样本）
 * 整理成结论，并明确标注这是规则诊断、不是模型分析。
 *
 * @param {{title: string, lines: string[]}} opts
 * @returns {string}
 */
export function buildRuleDiagnosis({ title, lines }) {
  return [
    `## ${title}`,
    '',
    ...(Array.isArray(lines) ? lines.filter(Boolean) : []),
    '',
    '> 以上是**规则诊断**：根据退出码与异常日志关键字直接给出结论，没有调用模型。',
    '> 需要根因分析和修复建议，请在「设置」里填好 Base URL + API Key 后再点一次诊断。',
  ].join('\n');
}

/**
 * 把「巡检发现的日志异常」合并进健康检查报告。
 *
 * 修的 bug：AI 分析页明明巡检到容器日志报错，点「开始容器诊断」却说
 * 「所有容器正常」。原因是 healthCheck() 只统计 exited 容器的退出码，
 * 运行中容器的 ERROR 日志归 patrol 管 —— 两条链路各看一半，用户看到自相矛盾。
 *
 * 已存在于退出类问题里的容器不重复加（同一个容器不显示两遍）。
 *
 * @param {object} report docker.healthCheck() 的返回值（会被就地修改并返回）
 * @param {Array} patrolResults 巡检结果
 */
export function mergePatrolProblems(report, patrolResults) {
  const list = Array.isArray(patrolResults) ? patrolResults : [];
  if (!report || typeof report !== 'object') return report;
  if (!Array.isArray(report.problems)) report.problems = [];
  if (list.length === 0) return report;

  const seen = new Set(report.problems.map(p => `${p?.sourceName || ''}|${p?.name || ''}`));
  for (const r of list) {
    const name = r?.containerName || (r?.containerId ? String(r.containerId).slice(0, 12) : 'unknown');
    const key = `${r?.sourceName || ''}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = r?.uniqueCount || r?.matchCount || 0;
    report.problems.push({
      name,
      image: r?.image || '',
      state: 'running',
      exitCode: null,
      exitType: 'log',
      status: `${count} 种异常日志`,
      errors: (r?.lines || [])
        .slice(-10)
        .map(l => `[${l?.level || 'ERROR'}] ${l?.content || l?.line || ''}`),
      sourceName: r?.sourceName || '',
    });
  }
  if (report.summary) report.summary.unhealthy = report.problems.length;
  return report;
}

// ─── 未纳入采集的容器：不该报错 ─────────────────────────────────────────────
//
// 修的 bug（用户报「将没有完成没测 metrics 的容器的报错过滤掉」）：
// 生产环境 /api/docker/health-check 报了 51 个「问题容器」，点开一看全是噪音：
//
//   · 41 个的"错误"是 `无法获取日志: 读取日志失败: (HTTP code 501) unexpected -
//     configured logging driver does not support reading` —— 那是**我们读不出日志**，
//     不是容器报错。实测该主机 87 个容器里 42 个的 log driver 是 `none`，
//     它们从创建那天起就没有任何日志/指标被采集过。
//   · 剩下 10 个连一行错误都没有（errors 为空），只有一个月前甚至七个月前的退出码。
//   · 51 个全部 state=exited，退出时间中位数在 3 个月前，最近的也在 4 天前。
//
// 也就是说：**这些容器从来没被"测"过**（没有日志、没有指标序列），它们的退出码
// 属于历史考古，不是当前故障；而 TSDB 侧只产出 openlog_docker_containers_total
// 这类聚合计数，没有 per-container 序列可以直接反查，所以「有没有被采集」只能用
// 「日志能不能读 + 退出多久了」这两个可观测量做代理。
//
// 分成三类，前两类不进 problems、不算 unhealthy，但都显式计数返回，不静默吞掉：
//   problem    —— 有证据的当前问题
//   stale      —— 退出超过 staleHours 的历史容器（默认 24h）
//   unobserved —— 日志读不出来且没有其它证据，等于没采集过

/** 退出超过多少小时算「历史容器」。生产实测最近一次退出是 4 天前。 */
export const DEFAULT_EXITED_STALE_HOURS = 24;

const AGE_UNIT_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,   // 30 天
  year: 31_536_000_000,   // 365 天
};

/**
 * 从 docker 的 Status 文案里解析「多久以前」。
 *
 * 输入是 docker API 原样返回的英文串（服务端生成，与客户端 locale 无关）：
 *   "Exited (2) 7 days ago" / "Exited (137) About an hour ago"
 *   "Exited (0) Less than a second ago" / "Up 5 days"
 *
 * @param {string} status
 * @returns {number|null} 毫秒；Up 中的容器返回 0；解析不出来返回 null
 */
export function parseExitedAgoMs(status) {
  if (!status || typeof status !== 'string') return null;
  const s = status.trim();
  if (/^Up\b/i.test(s)) return 0;
  const tail = s.replace(/^Exited\s*\(\s*\d+\s*\)\s*/i, '').trim();
  if (!tail) return null;
  if (/less than a second/i.test(tail)) return 0;
  const about = tail.match(/^about an?\s+(second|minute|hour|day|week|month|year)/i);
  if (about) return AGE_UNIT_MS[about[1].toLowerCase()] ?? null;
  const m = tail.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\b/i);
  if (m) {
    const unit = AGE_UNIT_MS[m[2].toLowerCase()];
    return unit === undefined ? null : Number(m[1]) * unit;
  }
  return null;
}

/**
 * 这条报错是不是「日志驱动不支持读取」这类**采集侧**问题（而不是容器报错）。
 *
 * docker 的 `local`/`journald`/`none`/`syslog` 等驱动都不支持 logs 读取，
 * 调用会返回 HTTP 501。历史上这串文案被直接塞进了 problems[].errors，
 * 于是 41 个只是「看不见」的容器被报成了「有错误」。
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isLogDriverUnreadable(message) {
  if (!message) return false;
  const s = String(message);
  return /logging driver does not support reading/i.test(s)
    || /configured logging driver/i.test(s)
    || /HTTP code 501/i.test(s);
}

/** @typedef {'problem'|'stale'|'unobserved'} ProblemKind */

/**
 * 判断一个已退出容器的异常退出该不该出现在「问题容器」里。
 *
 * @param {object} entry healthCheck 收集到的候选条目
 * @param {number|null} entry.exitedAgoMs 退出距今毫秒（parseExitedAgoMs 的结果）
 * @param {string[]} [entry.errors] 真实的错误日志行（不含「无法获取日志」这类伪错误）
 * @param {boolean} [entry.logUnavailable] 日志是否读不出来
 * @param {boolean} [entry.logDriverUnreadable] 是否属于日志驱动不支持读取
 * @param {string} [entry.state]
 * @param {string} [entry.exitType]
 * @param {{staleHours?: number, ignoreUnobserved?: boolean}} [opts]
 * @returns {ProblemKind}
 */
export function classifyProblemEvidence(entry, opts = {}) {
  const e = entry || {};
  if (e.state === 'running') return 'problem';

  const raw = Number(opts.staleHours);
  const staleHours = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_EXITED_STALE_HOURS;
  const age = e.exitedAgoMs;
  if (staleHours > 0 && typeof age === 'number' && Number.isFinite(age) && age > staleHours * 3_600_000) {
    return 'stale';
  }

  const ignoreUnobserved = opts.ignoreUnobserved !== false;
  const errors = Array.isArray(e.errors) ? e.errors : [];
  // OOM / 段错误的退出码本身就是证据，即使日志读不出来也照报。
  const hasExitCodeEvidence = e.exitType === 'oom' || e.exitType === 'segfault';
  if (ignoreUnobserved && !hasExitCodeEvidence && errors.length === 0 && (e.logUnavailable || e.logDriverUnreadable)) {
    return 'unobserved';
  }
  return 'problem';
}

/**
 * 按证据强度把候选问题分成「要报的」和「过滤掉的」。
 *
 * @param {object[]} entries
 * @param {{staleHours?: number, ignoreUnobserved?: boolean}} [opts]
 * @returns {{problems: object[], stale: object[], unobserved: object[], counts: {stale: number, unobserved: number}}}
 */
export function splitHealthProblems(entries, opts = {}) {
  const problems = [];
  const stale = [];
  const unobserved = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const kind = classifyProblemEvidence(e, opts);
    if (kind === 'stale') stale.push(e);
    else if (kind === 'unobserved') unobserved.push(e);
    else problems.push(e);
  }
  return { problems, stale, unobserved, counts: { stale: stale.length, unobserved: unobserved.length } };
}

/**
 * 同一条诊断 toast 的去重键（前端也有一份等价实现，这里给后端推送用）。
 * 同一容器/来源只占一条，避免反复弹。
 */
export function diagnosisToastKey({ sourceId, containerName, source } = {}) {
  const origin = containerName || source || 'default';
  return `${sourceId || ''}::${origin}`;
}

// ─── 单容器诊断：容器事实 + 日志读取失败的解释 ────────────────────────────
//
// 修的 bug（2026-11-06）：「容器管理 → AI 智能诊断」点下去十几秒空白，
// 最后给出一段「容器可能已被强制终止/清理、退出码 undefined」的胡说。
//
// 三个原因：
//   1. 前端调用时**根本没带容器信息**（exitCode/exitType/image 全缺）→ 提示词里是
//      "退出码: undefined"，模型只能顺着这个空洞编故事；
//   2. 服务端也没有自己去 inspect 容器，把「没传」当成「不知道」；
//   3. 部分容器日志驱动不支持读取（HTTP 501），代码把失败吞掉，正文变成
//      "未获取到最近错误日志（容器可能已被清理）" —— 又一句误导。
//
// 对策：以**服务端 inspect** 为唯一事实来源（前端传只作兜底），
// 并且把「日志为什么读不到」讲成人话。

/**
 * 把 `docker inspect` 的结果压成诊断需要的事实。
 * 纯函数：不连 docker，测试直接喂 JSON。
 *
 * @param {object} info dockerode `container.inspect()` 的返回
 * @returns {object|null}
 */
export function describeContainerFacts(info) {
  if (!info || typeof info !== 'object') return null;
  const st = info.State || {};
  const name = String(info.Name || '').replace(/^\//, '');
  const rawCode = st.ExitCode;
  const exitCode = Number.isInteger(rawCode) ? rawCode : null;
  const oomKilled = Boolean(st.OOMKilled);
  const running = st.Running === true || st.Status === 'running' || st.Status === 'restarting';

  let exitType = 'error';
  if (running) exitType = 'running';
  else if (oomKilled || exitCode === 137) exitType = 'oom';
  else if (exitCode === 0) exitType = 'normal';
  else if (exitCode === 139) exitType = 'segfault';
  else if (exitCode === 143) exitType = 'terminated';

  return {
    id: String(info.Id || '').slice(0, 12),
    name: name || String(info.Id || '').slice(0, 12),
    image: String(info.Config?.Image || info.Image || ''),
    state: String(st.Status || 'unknown'),
    exitCode,
    oomKilled,
    restartCount: Number.isInteger(info.RestartCount) ? info.RestartCount : null,
    startedAt: String(st.StartedAt || ''),
    finishedAt: String(st.FinishedAt || ''),
    running,
    exitType,
    exitLabel: labelOfExit(exitType, exitCode),
  };
}

/** 与前端 getExitLabel 对齐的口径 */
function labelOfExit(exitType, exitCode) {
  switch (exitType) {
    case 'running': return '运行中（本次是运行态诊断）';
    case 'oom': return '💀 OOM 内存溢出 / 被 SIGKILL';
    case 'segfault': return '💥 段错误';
    case 'terminated': return '🛑 被终止';
    case 'normal': return '✅ 正常退出';
    default: return exitCode === null ? '❌ 异常退出（退出码未知）' : `❌ 异常退出(${exitCode})`;
  }
}

/**
 * 把「读日志失败」翻译成人话。
 *
 * 典型输入：`(HTTP code 501) unexpected - configured logging driver does not support reading`
 * —— 不是容器被删了，而是这个容器的日志驱动（local/journald/none）不支持 API 读取。
 *
 * @param {unknown} err
 * @returns {string} 空串表示没有错误
 */
export function explainLogReadFailure(err) {
  const msg = String(err?.message || err || '').trim();
  if (!msg) return '';
  if (/501|does not support reading|logging driver/i.test(msg)) {
    return '该容器的日志驱动不支持通过 API 读取（Docker 501）。日志可能走了 local/journald/none 驱动，'
      + '可改用容器内文件日志，或把日志驱动改成 json-file 后再诊断。';
  }
  if (/no such container|404/i.test(msg)) {
    return '容器已不存在（可能已被删除），拿不到日志。';
  }
  if (/permission denied|EACCES/i.test(msg)) {
    return '没有权限读取该容器日志（Docker socket 权限不足）。';
  }
  if (/timeout|ETIMEDOUT/i.test(msg)) {
    return '读取容器日志超时（Docker 守护进程响应慢）。';
  }
  return `读取容器日志失败：${msg.slice(0, 200)}`;
}

/**
 * 拼单容器诊断的提示词。
 *
 * 关键：把「拿不到的东西」明确写清楚（日志读不到 + 原因），
 * 而不是只写一句"未获取到最近错误日志"让模型自己猜。
 *
 * @param {{facts: object, errorLines?: Array, logFailure?: string}} input
 * @returns {string}
 */
export function buildContainerDiagnosisPrompt({ facts, errorLines = [], logFailure = '' }) {
  const f = facts || {};
  const lines = [];
  lines.push(`- 容器名: ${f.name || '未知'}`);
  lines.push(`- 镜像: ${f.image || '未知'}`);
  lines.push(`- 当前状态: ${f.state || '未知'}`);
  if (f.running) {
    lines.push('- 退出码: 无（容器正在运行，本次是运行态诊断，不要假设它已经退出）');
  } else {
    const code = f.exitCode === null || f.exitCode === undefined ? '未知' : f.exitCode;
    lines.push(`- 退出码: ${code}（${f.exitLabel || ''}）`);
  }
  if (typeof f.restartCount === 'number') lines.push(`- 重启次数: ${f.restartCount}`);
  if (f.oomKilled) lines.push('- OOMKilled: 是（Docker 记录的内存溢出被杀）');
  if (f.finishedAt && f.finishedAt !== '0001-01-01T00:00:00Z') lines.push(`- 结束时间: ${f.finishedAt}`);

  const errs = (Array.isArray(errorLines) ? errorLines : []).slice(-10);
  if (errs.length > 0) {
    lines.push(`- 最近 ${errs.length} 条 ERROR/FATAL 日志:`);
    for (const l of errs) {
      lines.push(`  [${l.level || 'ERROR'}] ${String(l.content || l.line || '').slice(0, 300)}`);
    }
  } else if (logFailure) {
    lines.push(`- 日志情况: ${logFailure}`);
    lines.push('  （注意：这是拿不到日志，不代表容器没有报错，也不代表容器已被清理）');
  } else {
    lines.push('- 日志情况: 最近日志里没有 ERROR/FATAL 级别的内容');
  }

  const goal = f.running
    ? `### 🔍 当前健康判断（基于上述状态与日志，判断是否有隐患）
### 💡 值得关注的信号（没有就直说没有）
### 🛡️ 建议的下一步检查（2-3 条具体命令或配置项）`
    : `### 🔴 退出原因（结合退出码和日志综合判断最可能的根因）
### 💡 修复建议（给出 2-3 条具体操作步骤）
### 🛡️ 预防措施（如何避免再次发生）`;

  return `你是资深运维工程师，正在对单个 Docker 容器做${f.running ? '运行态健康' : '异常退出'}诊断。

## 容器信息
${lines.join('\n')}

## 诊断要求（用中文回答）：
${goal}

硬性要求：
- 直接给结论，不要自我介绍、不要复述任务、不要说「作为资深运维工程师」这类开头。
- 只依据上述真实信息推理。信息缺失时直接说明「缺少 X，无法判断 Y」，不要编造退出码、日志内容或未发生的事件。`;
}
