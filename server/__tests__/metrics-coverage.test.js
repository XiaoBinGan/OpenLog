import { describe, it, expect } from 'vitest';
import { buildCoverage } from '../metrics/route-coverage.js';

// 负责人 #10 coverage —— 契约 4.7 的对账逻辑单测。
// 只测纯函数，不碰 db / express / 其它组的模块。

describe('buildCoverage —— 接口清单 × 实际流量', () => {
  it('1. 完全命中：3 条 inventory 都有流量 → coverageRate 100', () => {
    const res = buildCoverage({
      inventory: [
        { method: 'GET', path: '/api/health' },
        { method: 'GET', path: '/api/docker/containers/:sourceId/:containerId/logs' },
        { method: 'POST', path: '/api/remote/servers/:id/files' },
      ],
      traffic: [
        { method: 'GET', route: '/api/health', calls: 9, lastSeenMs: 1700000000000 },
        { method: 'GET', route: '/api/docker/containers/:sourceId/:containerId/logs', calls: 4, lastSeenMs: 1700000000500 },
        { method: 'POST', route: '/api/remote/servers/:id/files', calls: 2, lastSeenMs: 1700000001000 },
      ],
      nowMs: 1700000100000,
    });

    expect(res.total).toBe(3);
    expect(res.used).toBe(3);
    expect(res.unused).toBe(0);
    expect(res.coverageRate).toBe(100);
    expect(res.unusedRoutes).toEqual([]);
    expect(res.unknownTraffic).toEqual([]);
    for (const row of res.rows) expect(row.used).toBe(true);
  });

  it('2. 部分命中：coverageRate 与 unusedRoutes 正确', () => {
    const res = buildCoverage({
      inventory: [
        { method: 'GET', path: '/api/a' },
        { method: 'GET', path: '/api/b' },
        { method: 'GET', path: '/api/c' },
        { method: 'GET', path: '/api/d' },
        { method: 'GET', path: '/api/e' },
      ],
      traffic: [
        { method: 'GET', route: '/api/a', calls: 1 },
        { method: 'GET', route: '/api/c', calls: 5 },
      ],
    });

    expect(res.total).toBe(5);
    expect(res.used).toBe(2);
    expect(res.unused).toBe(3);
    expect(res.coverageRate).toBe(40); // 2/5，保留 1 位小数的百分比数字
    expect(res.unusedRoutes).toEqual([
      { method: 'GET', path: '/api/b' },
      { method: 'GET', path: '/api/d' },
      { method: 'GET', path: '/api/e' },
    ]);
  });

  it('3. 参数名不同但结构相同 → 算命中（:id vs :sourceId / {id}）', () => {
    const res = buildCoverage({
      inventory: [
        { method: 'GET', path: '/api/remote/servers/:sourceId/files' },
        { method: 'GET', path: '/api/items/{itemId}' },
      ],
      traffic: [
        { method: 'GET', route: '/api/remote/servers/:id/files', calls: 7, lastSeenMs: 1234 },
        { method: 'GET', route: '/api/items/:id', calls: 3, lastSeenMs: 4321 },
      ],
    });

    expect(res.total).toBe(2);
    expect(res.used).toBe(2);
    expect(res.coverageRate).toBe(100);
    // 报告里保留 inventory 的原参数名，不被 traffic 的命名覆盖
    expect(res.rows.map((r) => r.path)).toEqual([
      '/api/remote/servers/:sourceId/files',
      '/api/items/{itemId}',
    ]);
    expect(res.rows[0].calls).toBe(7);
    expect(res.unknownTraffic).toEqual([]);
  });

  it('4. 段数不同 → 不算命中', () => {
    const res = buildCoverage({
      inventory: [{ method: 'GET', path: '/api/docker/containers/:id/logs' }],
      traffic: [
        { method: 'GET', route: '/api/docker/containers/:sourceId/:containerId/logs', calls: 30 },
        { method: 'GET', route: '/api/docker/containers', calls: 5 },
      ],
    });

    expect(res.used).toBe(0);
    expect(res.coverageRate).toBe(0);
    expect(res.unusedRoutes).toEqual([{ method: 'GET', path: '/api/docker/containers/:id/logs' }]);
    // 段数不同的两条流量都不该命中，全部进 unknownTraffic
    expect(res.unknownTraffic.map((u) => u.route).sort()).toEqual([
      '/api/docker/containers',
      '/api/docker/containers/:sourceId/:containerId/logs',
    ]);
  });

  it('5. 字面段不同（/api/a vs /api/b）→ 不算命中，且路径大小写敏感', () => {
    const lowerUpper = buildCoverage({
      inventory: [{ method: 'GET', path: '/api/Users' }],
      traffic: [{ method: 'GET', route: '/api/users', calls: 3 }],
    });
    expect(lowerUpper.used).toBe(0);
    expect(lowerUpper.coverageRate).toBe(0);
    expect(lowerUpper.unknownTraffic).toHaveLength(1);

    const res = buildCoverage({
      inventory: [{ method: 'GET', path: '/api/a' }],
      traffic: [{ method: 'GET', route: '/api/b', calls: 8 }],
    });
    expect(res.used).toBe(0);
    expect(res.rows[0].calls).toBe(0);
    expect(res.rows[0].lastSeenMs).toBe(null);
  });

  it('6. traffic 有、inventory 无 → 出现在 unknownTraffic', () => {
    const res = buildCoverage({
      inventory: [{ method: 'GET', path: '/api/known' }],
      traffic: [
        { method: 'GET', route: '/api/known', calls: 2 },
        { method: 'POST', route: '/api/ghost/run', calls: 11, lastSeenMs: 999 },
        // 同 method 同结构、只是参数名不同 → 与 /api/known/:id 无关（段数不同）
        { method: 'GET', route: '/api/known/:id', calls: 1 },
      ],
    });

    expect(res.total).toBe(1);
    expect(res.used).toBe(1);
    expect(res.unknownTraffic).toHaveLength(2);
    const ghost = res.unknownTraffic.find((u) => u.method === 'POST');
    expect(ghost).toMatchObject({ method: 'POST', route: '/api/ghost/run', calls: 11 });
    expect(ghost.lastSeenMs).toBe(999);
    // 每条 unknownTraffic 都只有 method/route/calls/lastSeenMs 这几个字段，形状稳定
    expect(Object.keys(ghost).sort()).toEqual(['calls', 'lastSeenMs', 'method', 'route']);
  });

  it('7. inventory 有重复 → 去重后 total 正确（参数名不同也算重复）', () => {
    const res = buildCoverage({
      inventory: [
        { method: 'GET', path: '/api/a' },
        { method: 'GET', path: '/api/a' },
        { method: 'GET', path: '/api/a/' }, // 尾部斜杠：归一化后同一条
        { method: 'GET', path: '/api/x/:id' },
        { method: 'GET', path: '/api/x/:seq' }, // 参数名不同：同一条模式
      ],
      traffic: [{ method: 'GET', route: '/api/a', calls: 4 }],
    });

    expect(res.total).toBe(2);
    expect(res.rows).toHaveLength(2);
    expect(res.used).toBe(1);
    expect(res.coverageRate).toBe(50);
    expect(res.unusedRoutes).toEqual([{ method: 'GET', path: '/api/x/:id' }]);
  });

  it('8. total=0 → coverageRate 0，不 NaN', () => {
    const empty = buildCoverage({ inventory: [], traffic: [] });
    expect(empty.total).toBe(0);
    expect(empty.used).toBe(0);
    expect(empty.coverageRate).toBe(0);
    expect(Number.isNaN(empty.coverageRate)).toBe(false);
    expect(empty.rows).toEqual([]);
    expect(empty.unusedRoutes).toEqual([]);
    expect(empty.unknownTraffic).toEqual([]);

    // 入参缺失也不能炸
    const missing = buildCoverage();
    expect(missing.total).toBe(0);
    expect(missing.coverageRate).toBe(0);
  });

  it('9. calls 累加正确（同一路由多条 traffic 求和）；lastSeenMs 取最大', () => {
    const res = buildCoverage({
      inventory: [{ method: 'GET', path: '/api/docker/containers/:sourceId/logs' }],
      traffic: [
        { method: 'GET', route: '/api/docker/containers/:sourceId/logs', calls: 3, lastSeenMs: 1000 },
        // 参数名不同但同一模式，也要并入同一条 inventory 的统计
        { method: 'GET', route: '/api/docker/containers/:id/logs', calls: 4, lastSeenMs: 5000 },
        { method: 'GET', route: '/api/docker/containers/:sourceId/logs', calls: 5, lastSeenMs: 3000 },
        { method: 'GET', route: '/api/docker/containers/:sourceId/logs', calls: 1 }, // 无 lastSeenMs
      ],
    });

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].calls).toBe(13);
    expect(res.rows[0].lastSeenMs).toBe(5000);
    expect(res.rows[0].used).toBe(true);
  });

  it('10. method 大小写：inventory "get" 与 traffic "GET" → 算命中', () => {
    const res = buildCoverage({
      inventory: [
        { method: 'get', path: '/api/a' },
        { method: 'Post', path: '/api/b' },
      ],
      traffic: [
        { method: 'GET', route: '/api/a', calls: 2 },
        { method: 'POST', route: '/api/b', calls: 1 },
      ],
    });

    expect(res.used).toBe(2);
    expect(res.coverageRate).toBe(100);
    expect(res.rows.map((r) => r.method)).toEqual(['GET', 'POST']);

    // method 不同（GET vs POST）不能互相顶替
    const cross = buildCoverage({
      inventory: [{ method: 'GET', path: '/api/a' }],
      traffic: [{ method: 'POST', route: '/api/a', calls: 9 }],
    });
    expect(cross.used).toBe(0);
    expect(cross.coverageRate).toBe(0);
    expect(cross.unknownTraffic).toEqual([
      { method: 'POST', route: '/api/a', calls: 9, lastSeenMs: null },
    ]);
  });
});
