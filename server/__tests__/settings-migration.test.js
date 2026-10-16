import { describe, it, expect } from 'vitest';
import { migrateWatchSourceFields, FIELD_ALIASES } from '../settings-migrations.js';

/**
 * 事故背景：数据库里的 watchSources 是旧字段名（logPath / watchFiles），
 * 而前端与 startSourceWatcher 一直读新名（path / pattern）。
 * 结果是 source.path === undefined → mkdirSync(undefined) 抛错 → return，
 * **日志监控静默不启动**。
 *
 * 迁移的契约是「补新名、留旧名」：
 * 补新名让当前代码能跑，留旧名让回退到旧版本时仍然能跑。
 */
describe('watchSources 字段名迁移', () => {
  const legacy = () => ({
    logPath: '/legacy',
    watchFiles: '*.log',
    watchSources: [
      { id: 'default', name: '本地', enabled: true, logPath: '/Users/supre/logs', watchFiles: '*.log' },
    ],
  });

  it('把旧名补成新名', () => {
    const out = migrateWatchSourceFields(legacy());
    expect(out.watchSources[0].path).toBe('/Users/supre/logs');
    expect(out.watchSources[0].pattern).toBe('*.log');
  });

  it('保留旧名 —— 回退到旧版本时仍然能工作', () => {
    const out = migrateWatchSourceFields(legacy());
    expect(out.watchSources[0].logPath).toBe('/Users/supre/logs');
    expect(out.watchSources[0].watchFiles).toBe('*.log');
  });

  it('不覆盖已经配置好的新名', () => {
    const out = migrateWatchSourceFields({
      watchSources: [{ id: 'a', path: '/new', logPath: '/old', pattern: '*.new', watchFiles: '*.old' }],
    });
    expect(out.watchSources[0].path).toBe('/new');
    expect(out.watchSources[0].pattern).toBe('*.new');
  });

  it('没有可迁移字段时返回原引用（调用方据此跳过写库）', () => {
    const input = { watchSources: [{ id: 'a', path: '/p', pattern: '*.log' }] };
    expect(migrateWatchSourceFields(input)).toBe(input);
  });

  it('幂等：迁移两次结果一致，且第二次返回同一引用', () => {
    const once = migrateWatchSourceFields(legacy());
    const twice = migrateWatchSourceFields(once);
    expect(twice).toBe(once); // 第二次不该再改
    expect(twice.watchSources[0].path).toBe('/Users/supre/logs');
  });

  it('不修改入参（纯函数）', () => {
    const input = legacy();
    const snapshot = JSON.stringify(input);
    migrateWatchSourceFields(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('对畸形输入不抛错、原样返回', () => {
    for (const bad of [null, undefined, 42, 'str', {}, { watchSources: null }, { watchSources: 'x' }]) {
      expect(() => migrateWatchSourceFields(bad)).not.toThrow();
      expect(migrateWatchSourceFields(bad)).toBe(bad);
    }
  });

  it('数组里的非对象元素原样保留', () => {
    const input = { watchSources: [null, 'x', 7] };
    expect(migrateWatchSourceFields(input)).toBe(input);
  });

  it('只补字符串类型的旧值，不把 undefined/null/数字当路径', () => {
    const out = migrateWatchSourceFields({
      watchSources: [
        { id: 'a', logPath: undefined, watchFiles: undefined },
        { id: 'b', logPath: null, watchFiles: null },
        { id: 'c', logPath: 123, watchFiles: 456 },
      ],
    });
    // 三项都不该被迁移，因此应返回原引用
    expect(out.watchSources.every((w) => w.path === undefined)).toBe(true);
  });

  it('空字符串是合法路径值，会被迁移（由 startSourceWatcher 单独校验非空）', () => {
    const out = migrateWatchSourceFields({ watchSources: [{ id: 'a', logPath: '' }] });
    expect(out.watchSources[0].path).toBe('');
  });

  it('每个旧名都映射到一个新名，且没有重复', () => {
    const olds = FIELD_ALIASES.map(([o]) => o);
    const news = FIELD_ALIASES.map(([, n]) => n);
    expect(new Set(olds).size).toBe(olds.length);
    expect(new Set(news).size).toBe(news.length);
    // 与前端 Settings.tsx / startSourceWatcher 实际使用的名字对齐
    expect(news).toContain('path');
    expect(news).toContain('pattern');
  });
});

describe('startSourceWatcher 必须拒绝空目录', () => {
  /**
   * 迁移只是把历史数据修好；如果用户手动把目录清空，仍要给出可理解的报错，
   * 而不是让 mkdirSync(undefined) 抛出底层 TypeError。
   */
  it('index.js 在调用 mkdirSync 之前校验 logDir 是非空字符串', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const SERVER = fileURLToPath(new URL('..', import.meta.url));
    const src = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');

    const fnStart = src.indexOf('function startSourceWatcher(');
    expect(fnStart, '未找到 startSourceWatcher').toBeGreaterThan(-1);
    const body = src.slice(fnStart, fnStart + 900);

    // 校验必须出现在 mkdirSync 之前
    const guardAt = body.search(/typeof logDir !== 'string'/);
    const mkdirAt = body.search(/fs\.mkdirSync\(/);
    expect(guardAt, '缺少 logDir 类型校验').toBeGreaterThan(-1);
    expect(mkdirAt, '未找到 mkdirSync').toBeGreaterThan(-1);
    expect(guardAt, '校验必须早于 mkdirSync').toBeLessThan(mkdirAt);
  });
});
