/**
 * 演示模式状态（后端 `GET /api/demo` → `{ demo: boolean }`）。
 *
 * 为什么做成「模块级缓存 + 订阅」而不是每个组件各发一次请求：
 * 顶部横幅（Layout）、Docker / Remote / K8s 三个页面都要读同一个开关。
 * 各读各的会在每次切页时重复打 `/api/demo`，而且三处状态不同步。
 * 这里把「读一次」收敛到模块作用域：
 *   - 拿到响应就永久缓存，本次会话不再请求；
 *   - 请求失败 / 字段缺失按「非演示」处理，且**不缓存**（下次挂载重试）——
 *     后端还没上 `/api/demo` 时客户端表现与改动前完全一致：没有横幅、按钮照常可用；
 *   - `loaded === false`（还没加载完）时对外同样是「非演示」：
 *     宁可多一次点击，也不要误把真实环境禁成只读。
 *
 * 用法：
 *   const { demo, loaded } = useDemoMode();
 *   if (demo) { toast.warning(DEMO_DISABLED_HINT); return; }
 */

import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '../api/client';

export interface DemoSnapshot {
  /** 后端明确报告 demo === true 时才为 true。 */
  demo: boolean;
  /** 是否已经拿到 /api/demo 的确定结果（失败不算加载完）。 */
  loaded: boolean;
}

/** 演示模式下写操作的统一提示文案（横幅与禁用提示共用一份字面量）。 */
export const DEMO_DISABLED_HINT = '演示模式：该操作已被禁用';
export const DEMO_BANNER_TEXT = '演示数据 · 未连接任何真实服务器（OPENLOG_DEMO=1）';

const INITIAL: DemoSnapshot = { demo: false, loaded: false };

let snapshot: DemoSnapshot = INITIAL;
/** 已拿到确定结果：此后不再请求。 */
let settled = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: DemoSnapshot): void {
  snapshot = next;
  settled = true;
  for (const listener of listeners) listener();
}

/**
 * 拉取（或复用）演示状态。并发调用共享同一个 in-flight Promise，
 * 因此横幅和页面同时挂载也只会有一次请求。
 */
export function loadDemoMode(): Promise<void> {
  if (settled) return Promise.resolve();
  if (inflight) return inflight;

  inflight = apiFetch<{ demo?: unknown }>('/api/demo')
    .then((data) => {
      // 必须严格 demo === true；字段缺失或类型不对都按非演示
      emit({ demo: data?.demo === true, loaded: true });
    })
    .catch(() => {
      // 静默：后端还是旧版本（没有这个接口）或网络抖动 → 不显示横幅、不禁用按钮。
      // 不 emit、不置 settled，下次挂载会重试一次。
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

const getSnapshot = (): DemoSnapshot => snapshot;

export function useDemoMode(): DemoSnapshot {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void loadDemoMode();
  }, []);
  return state;
}

/** 测试用：把模块缓存重置回「未加载」。 */
export function __resetDemoModeForTests(): void {
  snapshot = INITIAL;
  settled = false;
  inflight = null;
  listeners.clear();
}
