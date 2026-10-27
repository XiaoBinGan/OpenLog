/**
 * agent-audit.js — 运维助手写操作的审计流水。
 *
 * 背景：我们直接用现有 SSH 账号（通常有 sudo / docker 权限），没有做权限隔离。
 * 那么「谁在什么时候改了哪个文件、跑过什么命令」就必须可查 —— 出事时能定位，
 * 也能配合 `remote_rollback_file` 找回原文件。
 *
 * 存储：内存环形缓冲 + 落 SQLite kv（重启不丢），最多保留 300 条。
 * 只记元数据，不记完整文件内容（避免把配置里的密钥复制一份到库里）。
 */

import { getKv, setKv } from './db/index.js';

export const MAX_AUDIT_ENTRIES = 300;
const KV_KEY = 'agent_audit_log';

/** 进程内缓存（懒加载，避免每次查询都读库） */
let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    const stored = getKv(KV_KEY);
    cache = Array.isArray(stored) ? stored : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  try {
    setKv(KV_KEY, cache || []);
  } catch {
    // 落库失败不能影响主流程：审计是旁路，不是关键路径
  }
}

/**
 * 记一条审计。
 * @param {object} entry
 * @param {string} entry.tool        工具名
 * @param {string} [entry.action]    'approved' | 'denied' | 'executed' | 'failed'
 * @param {string} [entry.serverId]
 * @param {string} [entry.serverName]
 * @param {string} [entry.filePath]
 * @param {string} [entry.command]
 * @param {string} [entry.summary]   一句话说明（不放大段内容）
 * @param {boolean} [entry.success]
 * @param {number} [entry.timestamp] 默认 now
 */
export function recordAgentAction(entry) {
  const list = loadCache();
  const record = {
    id: `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: entry?.timestamp ?? Date.now(),
    tool: String(entry?.tool || 'unknown'),
    action: String(entry?.action || 'executed'),
    serverId: entry?.serverId ? String(entry.serverId) : undefined,
    serverName: entry?.serverName ? String(entry.serverName) : undefined,
    filePath: entry?.filePath ? String(entry.filePath).slice(0, 500) : undefined,
    command: entry?.command ? String(entry.command).slice(0, 500) : undefined,
    summary: entry?.summary ? String(entry.summary).slice(0, 300) : undefined,
    success: entry?.success === undefined ? undefined : Boolean(entry.success),
  };
  list.unshift(record);
  if (list.length > MAX_AUDIT_ENTRIES) list.length = MAX_AUDIT_ENTRIES;
  persist();
  return record;
}

/**
 * 读最近的操作记录（新的在前）。
 * @param {number} [limit]
 * @param {string} [serverId] 只看某台服务器
 */
export function listAgentActions(limit = 50, serverId) {
  let list = loadCache();
  if (serverId) list = list.filter(x => x.serverId === serverId);
  return list.slice(0, Math.max(1, Math.min(limit, MAX_AUDIT_ENTRIES)));
}

/** 测试用：清空 */
export function _resetAgentAudit() {
  cache = [];
  persist();
}

/** 测试用：注入缓存（避免测试触发落库） */
export function _setCacheForTest(list) {
  cache = Array.isArray(list) ? list : [];
}
