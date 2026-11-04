/**
 * server/__tests__/patrol-cache.test.js
 *
 * 巡检缓存「幽灵异常」bug 的回归测试。
 *
 * 原实现：`if (results.length > 0) lastPatrolResults = results`
 *   —— 容器异常被修好、巡检返回空之后，旧异常永远留在缓存里，
 *   于是 /api/docker/patrol/last、健康诊断、通知列表持续报已不存在的问题。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatrolResults } from '../patrol-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('applyPatrolResults —— 缓存更新规则', () => {
  const old = [{ containerName: 'api', uniqueCount: 3 }];

  it('巡检成功但没异常 → 覆盖成空（问题修好后不能再报）', () => {
    expect(applyPatrolResults(old, [])).toEqual([]);
  });

  it('巡检成功有异常 → 用新结果覆盖', () => {
    const fresh = [{ containerName: 'db', uniqueCount: 1 }];
    expect(applyPatrolResults(old, fresh)).toEqual(fresh);
  });

  it('巡检失败 → 保留上一次数据（不能把「查不到」当「没问题」）', () => {
    expect(applyPatrolResults(old, [], { succeeded: false })).toEqual(old);
    expect(applyPatrolResults(old, null, { succeeded: false })).toEqual(old);
  });

  it('异常输入不崩', () => {
    expect(applyPatrolResults(null, [])).toEqual([]);
    expect(applyPatrolResults(undefined, undefined)).toEqual([]);
  });
});

describe('接线 —— 两处巡检都必须「成功即覆盖」', () => {
  const index = read('server/index.js');
  const dockers = read('server/routes/docker.js');

  it('定时巡检（index.js）用 applyPatrolResults 覆盖缓存', () => {
    expect(index).toContain("import { applyPatrolResults } from './patrol-cache.js'");
    expect(index).toContain('lastPatrolResults = applyPatrolResults(lastPatrolResults, results)');
    // 旧的「只在非空时覆盖」不能再出现在 setLastPatrolResults 附近
    expect(index).not.toMatch(/if \(results\.length > 0\) \{\s*lastPatrolResults = results/);
  });

  it('手动巡检（routes/docker.js）同样覆盖', () => {
    expect(dockers).toContain("import { applyPatrolResults } from '../patrol-cache.js'");
    expect(dockers).toContain('setLastPatrolResults(applyPatrolResults(getLastPatrolResults(), results))');
    expect(dockers).not.toMatch(/if \(results\.length > 0\) \{\s*setLastPatrolResults\(results\)/);
  });
});
