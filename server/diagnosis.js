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

/**
 * 同一条诊断 toast 的去重键（前端也有一份等价实现，这里给后端推送用）。
 * 同一容器/来源只占一条，避免反复弹。
 */
export function diagnosisToastKey({ sourceId, containerName, source } = {}) {
  const origin = containerName || source || 'default';
  return `${sourceId || ''}::${origin}`;
}
