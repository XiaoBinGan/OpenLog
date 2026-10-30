import { describe, it, expect } from 'vitest';

/**
 * 内置技能（is_default=1）的守卫。
 *
 * 背景：内置技能原先硬编码在 scripts/init-db.js，且「库里已有内置技能就整体跳过」，
 * 于是**新增内置技能对已部署实例永不生效**。现在清单落在 server/default-skills.js，
 * 启动时按 id 幂等补齐。
 *
 * 用户要求：把「应用部署与发布」作为系统默认技能加上。
 */

const { BUILTIN_SKILLS, BUILTIN_SKILL_IDS } = await import('../default-skills.js');

describe('内置技能清单', () => {
  it('至少包含原有 8 个排障技能 + 部署技能', () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(9);
  });

  it('id 唯一且非空', () => {
    const ids = BUILTIN_SKILLS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of BUILTIN_SKILLS) {
      expect(s.id, s.name).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.name?.length, s.id).toBeGreaterThan(0);
      expect(s.command?.length, s.name).toBeGreaterThan(0);
      expect(s.category?.length, s.name).toBeGreaterThan(0);
    }
  });

  it('全部标记为内置（界面不可改/删）', () => {
    for (const s of BUILTIN_SKILLS) expect(s.is_default, s.name).toBe(1);
    expect(BUILTIN_SKILL_IDS.size).toBe(BUILTIN_SKILLS.length);
  });

  it('每个技能都有四段式 Markdown 结构（Purpose/Workflow/Constraints/Output）', () => {
    for (const s of BUILTIN_SKILLS) {
      for (const section of ['# Purpose', '# Workflow', '# Constraints', '# Output']) {
        expect(s.content, `${s.name} 缺 ${section}`).toContain(section);
      }
    }
  });

  it('部署技能存在且是可执行的 runbook', () => {
    const deploy = BUILTIN_SKILLS.find(s => s.name === '应用部署与发布');
    expect(deploy, '缺少部署技能').toBeTruthy();
    expect(deploy.category).toBe('部署');
    expect(deploy.command).toContain('deploy/deploy.sh');

    const c = deploy.content;
    // 关键步骤一个都不能少
    expect(c).toContain('deploy/MANUAL.md');       // 以目标机手册为准
    expect(c).toContain('deploy/deploy.env');      // 读配置但不改
    expect(c).toContain('last-deploy.json');       // 找上一个回滚点
    expect(c).toContain('docker load');            // 有镜像包优先导入，避免慢构建
    expect(c).toContain('--no-build');
    expect(c).toContain('/api/db/info');           // 健康检查
    expect(c).toContain('/api/auth/token');        // 回环取 token
    expect(c).toContain('docker logs');            // 验证日志
    expect(c).toMatch(/回滚/);
    // 约束必须写清风险和预算
    expect(c).toMatch(/预算|10 分钟|30 轮/);
    expect(c).toMatch(/备份/);
    expect(c).toMatch(/不改|只读/);
  });
});

describe('ensureBuiltinSkills —— 幂等补齐（老库也能拿到新技能）', () => {
  it('是 db 层导出的函数', async () => {
    const db = await import('../db/index.js');
    expect(typeof db.ensureBuiltinSkills).toBe('function');
  });

  it('服务端启动时会调用它（否则老实例拿不到新技能）', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const src = readFileSync(path.join(root, 'server/index.js'), 'utf8');
    expect(src).toContain('ensureBuiltinSkills(BUILTIN_SKILLS)');
  });

  it('init-db 与 server 共用同一份清单（避免两份定义分叉）', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const src = readFileSync(path.join(root, 'scripts/init-db.js'), 'utf8');
    // 动态 import 的形式是 await import('...')，不是 from '...'
    expect(src).toContain("'../server/default-skills.js'");
    // 不应再有硬编码的技能 id
    expect(src).not.toContain("b6da56e1-c0f7-49d6-9677-ca9d4e55b7ee");
  });
});
