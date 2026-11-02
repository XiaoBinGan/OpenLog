/**
 * client/src/utils/toolCallView.ts —— 工具调用在对话里的展示逻辑（纯函数，可单测）
 *
 * 背景：运维助手的工具调用原来只渲染成一个小 chip + tooltip，用户看不到
 * 「到底执行了什么命令、输出了什么」，体验远不如 AI Shell 的步骤卡。
 * 这里把「摘要 / 输出 / 状态 / 耗时」的提取逻辑抽出来，组件只管画。
 */

export interface ToolCallLike {
  tool: string;
  args?: any;
  status?: string;
  result?: any;
  durationMs?: number;
  liveOutput?: string;
}

const TOOL_LABELS: Record<string, string> = {
  remote_stat: '查看文件属性',
  remote_ls: '列目录',
  remote_read_file: '读文件',
  remote_grep: '搜索',
  remote_edit_file: '改文件',
  remote_write_file: '写文件',
  remote_rollback_file: '回滚文件',
  remote_git_status: 'git status',
  remote_git_diff: 'git diff',
  remote_restart_service: '重启服务',
  remote_servers: '列服务器',
  remote_exec: '执行命令',
  remote_system_stats: '系统状态',
  remote_search_logs: '搜日志',
  docker_list: '列容器',
  docker_logs: '容器日志',
  docker_exec: '容器内执行',
  docker_inspect: '容器详情',
  docker_health_check: '容器体检',
  local_system_stats: '本机状态',
  local_log_files: '本地日志',
  local_read_log: '读本地日志',
};

/** 给用户看的中文工具名（未知工具原样显示） */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] || tool || '工具';
}

/** 状态：running / ok / failed / aborted */
export function toolCallStatus(tc: ToolCallLike | null | undefined): 'running' | 'ok' | 'failed' | 'aborted' {
  const status = String(tc?.status || '');
  if (status === 'running') return 'running';
  if (status === 'aborted') return 'aborted';
  const err = tc?.result?.error;
  if (err) return 'failed';
  if (status === 'done' || status === 'ok' || tc?.result != null) return 'ok';
  return 'running';
}

/**
 * 一句话摘要：优先命令原文，其次路径/搜索词/服务器。
 * @returns 空串表示没有可展示的摘要
 */
export function toolCallSummary(tc: ToolCallLike | null | undefined): string {
  const a = tc?.args || {};
  if (a.command) return String(a.command).replace(/\s+/g, ' ').slice(0, 160);
  if (a.filePath) return String(a.filePath);
  if (a.path) return String(a.path);
  if (a.pattern) return `/${String(a.pattern).slice(0, 80)}/`;
  if (a.containerId) return String(a.containerId).slice(0, 20);
  if (a.serverId) return String(a.serverId).slice(0, 20);
  if (a.service) return String(a.service);
  const keys = Object.keys(a);
  if (keys.length === 0) return '';
  try {
    return JSON.stringify(a).slice(0, 120);
  } catch {
    return '';
  }
}

export interface ToolCallOutput {
  text: string;
  truncated: boolean;
  /** 输出是什么：stdout/stderr/content/json */
  kind: 'stdout' | 'stderr' | 'content' | 'json' | 'none';
}

/**
 * 取这一步的可展示输出。
 *
 * 运行中优先返回流式片段（liveOutput），跑完返回结果里的 stdout/content；
 * 超过 limit 就截断并标记，前端加「已截断」提示。
 */
export function toolCallOutput(tc: ToolCallLike | null | undefined, limit = 8000): ToolCallOutput {
  if (!tc) return { text: '', truncated: false, kind: 'none' };
  const live = String(tc.liveOutput || '');
  if (live && (tc.status === 'running' || tc.result == null)) {
    return cap(live, limit, 'stdout');
  }
  const r = tc.result;
  if (r == null) return { text: '', truncated: false, kind: 'none' };
  if (typeof r === 'string') return cap(r, limit, 'content');
  if (r.error) return cap(String(r.error), limit, 'stderr');
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return cap(out, limit, r.stdout ? 'stdout' : 'stderr');
  }
  if (typeof r.output === 'string') return cap(r.output, limit, 'stdout');
  if (typeof r.content === 'string') return cap(r.content, limit, 'content');
  if (r.truncated && typeof r.preview === 'string') return cap(r.preview, limit, 'json');
  try {
    return cap(JSON.stringify(r, null, 2), limit, 'json');
  } catch {
    return { text: '', truncated: false, kind: 'none' };
  }
}

function cap(text: string, limit: number, kind: ToolCallOutput['kind']): ToolCallOutput {
  const s = String(text || '');
  if (s.length <= limit) return { text: s, truncated: false, kind };
  return { text: s.slice(0, limit), truncated: true, kind };
}

/** 结果里的退出码（exec 类工具才有） */
export function toolCallExitCode(tc: ToolCallLike | null | undefined): number | null {
  const r = tc?.result;
  if (!r || typeof r !== 'object') return null;
  const code = r.exitCode ?? r.code;
  return typeof code === 'number' ? code : null;
}

/** 耗时展示：<1s 显示毫秒，>=1s 显示秒 */
export function durationLabel(ms?: number): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** 这一步是否有可展开的详情（输出 / diff 预览 / 错误） */
export function hasDetails(tc: ToolCallLike | null | undefined): boolean {
  if (!tc) return false;
  if (tc.result?.preview) return true;
  const out = toolCallOutput(tc, 2000);
  const text = out.text.trim();
  // 空对象/空数组的 JSON dump 不算「有详情」，避免每步都挂个没用的展开按钮
  if (!text || text === '{}' || text === '[]' || text === 'null') return false;
  return true;
}
