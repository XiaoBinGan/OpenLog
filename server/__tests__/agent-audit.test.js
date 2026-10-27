import { describe, it, expect, beforeEach, vi } from 'vitest';

// 审计模块落库依赖 db：用内存 kv 替身，避免测试真的建库
const kv = vi.hoisted(() => ({ store: new Map() }));
vi.mock('../db/index.js', () => ({
  getKv: (k) => kv.store.get(k),
  setKv: (k, v) => { kv.store.set(k, JSON.parse(JSON.stringify(v))); },
}));

const {
  recordAgentAction, listAgentActions, MAX_AUDIT_ENTRIES, _resetAgentAudit,
} = await import('../agent-audit.js');

beforeEach(() => {
  kv.store.clear();
  _resetAgentAudit();
});

describe('recordAgentAction —— 审计记录', () => {
  it('记录写操作的关键信息', () => {
    const r = recordAgentAction({
      tool: 'remote_edit_file',
      action: 'executed',
      serverId: 'srv-1',
      serverName: '4090服务器',
      filePath: '/app/config.yaml',
      summary: 'listen 80 → 8080',
      success: true,
    });
    expect(r.id).toMatch(/^audit-/);
    expect(r.tool).toBe('remote_edit_file');
    expect(r.serverName).toBe('4090服务器');
    expect(r.filePath).toBe('/app/config.yaml');
    expect(typeof r.timestamp).toBe('number');
  });

  it('最新记录排在最前', () => {
    recordAgentAction({ tool: 'a', action: 'executed' });
    recordAgentAction({ tool: 'b', action: 'denied' });
    const list = listAgentActions();
    expect(list[0].tool).toBe('b');
    expect(list[1].tool).toBe('a');
  });

  it('超长内容被截断，不把大段文件塞进审计', () => {
    const r = recordAgentAction({
      tool: 'remote_write_file',
      command: 'x'.repeat(2000),
      summary: 'y'.repeat(2000),
      filePath: '/a/' + 'z'.repeat(2000),
    });
    expect(r.command.length).toBeLessThanOrEqual(500);
    expect(r.summary.length).toBeLessThanOrEqual(300);
    expect(r.filePath.length).toBeLessThanOrEqual(500);
  });

  it('环形缓冲：超过上限只保留最近 N 条', () => {
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 25; i++) {
      recordAgentAction({ tool: `t${i}`, action: 'executed' });
    }
    const list = listAgentActions(MAX_AUDIT_ENTRIES + 100);
    expect(list.length).toBe(MAX_AUDIT_ENTRIES);
    expect(list[0].tool).toBe(`t${MAX_AUDIT_ENTRIES + 24}`);
  });

  it('可按服务器过滤 + limit 生效', () => {
    recordAgentAction({ tool: 'a', serverId: 's1' });
    recordAgentAction({ tool: 'b', serverId: 's2' });
    recordAgentAction({ tool: 'c', serverId: 's1' });
    const s1 = listAgentActions(10, 's1');
    expect(s1.map(x => x.tool)).toEqual(['c', 'a']);
    expect(listAgentActions(1).length).toBe(1);
  });

  it('落库失败不影响主流程（审计是旁路）', async () => {
    const mod = await import('../db/index.js');
    const spy = vi.spyOn(mod, 'setKv').mockImplementation(() => { throw new Error('db locked'); });
    expect(() => recordAgentAction({ tool: 'x' })).not.toThrow();
    spy.mockRestore();
  });

  it('拒绝操作也会留痕', () => {
    recordAgentAction({ tool: 'remote_write_file', action: 'denied', summary: '用户拒绝' });
    expect(listAgentActions()[0].action).toBe('denied');
  });
});
