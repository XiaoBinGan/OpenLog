import { describe, it, expect } from 'vitest';

/**
 * 1000 台服务器列表的筛选/窗口化逻辑。
 * 背景：原来 Remote 页直接渲染全部卡片，1000 台会一次挂载上千个组件，
 * 侧栏也根本没法浏览。现在先筛后窗口化，这里守住行为。
 */

const { filterServers, windowServers, countLabel, DEFAULT_VISIBLE_COUNT, LOAD_MORE_STEP } =
  await import('./serverList');

const makeServers = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `id-${i}`,
  name: `服务器-${i}`,
  host: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`,
  username: i % 2 ? 'deploy' : 'root',
  status: i % 10 === 0 ? 'error' : (i % 3 === 0 ? 'disconnected' : 'connected'),
}));

describe('filterServers —— 搜索与状态筛选', () => {
  const servers = makeServers(1000);

  it('不过滤时返回全部', () => {
    expect(filterServers(servers)).toHaveLength(1000);
  });

  it('按名称搜索', () => {
    expect(filterServers(servers, { search: '服务器-99' }).length).toBeGreaterThan(0);
  });

  it('按 IP 搜索', () => {
    const hit = filterServers(servers, { search: '10.0.0.1' });
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every(s => String(s.host).includes('10.0.0.1'))).toBe(true);
  });

  it('按用户名搜索（大小写不敏感）', () => {
    expect(filterServers(servers, { search: 'DEPLOY' }).every(s => s.username === 'deploy')).toBe(true);
  });

  it('状态筛选', () => {
    const connected = filterServers(servers, { status: 'connected' });
    expect(connected.length).toBeGreaterThan(0);
    expect(connected.every(s => s.status === 'connected')).toBe(true);
  });

  it('关键字 + 状态组合', () => {
    const out = filterServers(servers, { search: 'deploy', status: 'error' });
    expect(out.every(s => s.status === 'error' && s.username === 'deploy')).toBe(true);
  });

  it('空输入/脏输入不炸', () => {
    expect(filterServers([], {})).toEqual([]);
    expect(filterServers(null as any, {})).toEqual([]);
    expect(filterServers(servers, { search: '   ' })).toHaveLength(1000);
    expect(filterServers(servers, { search: '不存在的名字' })).toEqual([]);
  });
});

describe('windowServers —— 窗口化渲染', () => {
  const servers = makeServers(1000);

  it('默认只渲染 60 条（1000 台时不会一次挂载全部）', () => {
    const { visible, remaining, hasMore } = windowServers(servers, DEFAULT_VISIBLE_COUNT);
    expect(visible).toHaveLength(60);
    expect(remaining).toBe(940);
    expect(hasMore).toBe(true);
  });

  it('加载更多递增 120', () => {
    const { visible } = windowServers(servers, DEFAULT_VISIBLE_COUNT + LOAD_MORE_STEP);
    expect(visible).toHaveLength(180);
    expect(DEFAULT_VISIBLE_COUNT + LOAD_MORE_STEP).toBe(180);
  });

  it('少于窗口大小时全部渲染且无更多', () => {
    const { visible, hasMore, remaining } = windowServers(makeServers(10), 60);
    expect(visible).toHaveLength(10);
    expect(hasMore).toBe(false);
    expect(remaining).toBe(0);
  });

  it('窗口超过总数时安全', () => {
    const { visible, remaining } = windowServers(makeServers(5), 999999);
    expect(visible).toHaveLength(5);
    expect(remaining).toBe(0);
  });

  it('非法窗口值不返回多余数据', () => {
    expect(windowServers(servers, 0).visible).toEqual([]);
    expect(windowServers(servers, NaN).visible).toEqual([]);
    expect(windowServers(servers, -10).visible).toEqual([]);
  });

  it('窗口切片保持原顺序（不会打乱排序）', () => {
    const { visible } = windowServers(servers, 5);
    expect(visible.map(s => s.id)).toEqual(['id-0', 'id-1', 'id-2', 'id-3', 'id-4']);
  });
});

describe('countLabel', () => {
  it('未筛选显示总数，筛选后显示 筛选/总数', () => {
    expect(countLabel(1000, 1000)).toBe('(1000)');
    expect(countLabel(1000, 37)).toBe('(37/1000)');
    expect(countLabel(0, 0)).toBe('(0)');
  });
});
