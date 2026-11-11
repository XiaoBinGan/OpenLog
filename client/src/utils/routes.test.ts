/**
 * 路由表与未知路径处理的单测。
 *
 * 为什么单独测这个：RTL（testing-library）没装，整棵 App 渲染不起来，
 * 但"哪些路径是真实路由"和"不存在的路径该去哪"完全可以当纯数据来测 ——
 * 把路由表抽出来，比渲染断言更稳，也更快。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.join(process.cwd(), 'client', 'src', 'App.tsx');
const src = fs.readFileSync(APP, 'utf8');

/** 从 App.tsx 抽出已注册的子路由路径 */
function declaredRoutes(): string[] {
  const out: string[] = [];
  const re = /<Route\s+path="([^"*]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe('路由表', () => {
  it('包含全部业务页面', () => {
    const routes = declaredRoutes();
    for (const p of [
      'dashboard', 'logs', 'remote', 'docker', 'analytics',
      'analysis-history', 'assistant', 'skills', 'monitor', 'gpu', 'settings',
    ]) {
      expect(routes).toContain(p);
    }
  });

  it('没有重复路由（重复会让后者永远不生效）', () => {
    const routes = declaredRoutes();
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('根路径重定向到监控页', () => {
    expect(src).toMatch(/<Route\s+index\s+element=\{<Navigate\s+to="\/monitor"\s+replace\s*\/>\}/);
  });
});

describe('未知路径兜底', () => {
  it('存在通配路由（否则未知路径渲染成空白页）', () => {
    // 没有这一条时，不存在的路径会匹配到 Layout 但没有子路由命中，
    // Outlet 渲染为 null —— 用户看到侧边栏加一片全白，既没提示也无可操作项。
    expect(src).toMatch(/<Route\s+path="\*"/);
  });

  it('通配路由导航到真实存在的页面，不是渲染空组件', () => {
    const star = src.match(/<Route\s+path="\*"\s+element=\{<Navigate\s+to="([^"]+)"/);
    expect(star).not.toBeNull();
    const target = star![1];
    expect(target.startsWith('/')).toBe(true);
    // 目标必须是已注册页面，否则会变成重定向循环
    expect(declaredRoutes()).toContain(target.replace(/^\//, ''));
  });

  it('用 replace 而不是 push（避免历史里堆一串坏路径，后退键变砖）', () => {
    expect(src).toMatch(/<Route\s+path="\*"\s+element=\{<Navigate\s+to="[^"]+"\s+replace\s*\/>\}/);
  });
});
