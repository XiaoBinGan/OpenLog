/**
 * server/__tests__/perf-ux.test.js
 *
 * 本轮优化的「接线」回归测试（源码扫描）：
 *   1. 路由懒加载：首屏包从 1.04MB 拆成 shell + 每页 chunk
 *   2. 轮询可见性：页面隐藏时暂停（不再空转）
 *   3. 会话持久化：运维助手 + AI Shell 都落盘，且带体积控制
 *   4. 巡检缓存：问题修好后不再报「幽灵异常」
 *   5. 通知中心：筛选/搜索/导出都接上
 *   6. AI Shell：步数/时长上限可调
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('1. 路由懒加载 —— 首屏不再背 1.04MB 单包', () => {
  const app = read('client/src/App.tsx');

  it('所有页面用 React.lazy 动态 import', () => {
    expect(app).toContain("import { lazy } from 'react'");
    for (const page of ['Dashboard', 'Logs', 'Analytics', 'Assistant', 'Monitor', 'Docker', 'Settings', 'Remote', 'Skills', 'GPU', 'AnalysisHistory']) {
      expect(app).toMatch(new RegExp(`const ${page} = lazy\\(\\(\\) => import\\('\\./pages/${page}'\\)\\)`));
    }
  });

  it('Layout 保持静态引入（它是外壳，首屏必须有）', () => {
    expect(app).toContain("import Layout from './components/Layout'");
    // 不能再静态 import 页面（否则又会打进首屏）
    expect(app).not.toMatch(/^import (Dashboard|Logs|Docker|Settings|Remote|Assistant) from/m);
  });

  it('Suspense 放在 Layout 的 Outlet 上（外壳/顶栏不闪）', () => {
    const layout = read('client/src/components/Layout.tsx');
    expect(layout).toContain('Suspense');
    expect(layout).toMatch(/<Suspense[^>]*>[\s\S]{0,200}<Outlet \/>/);
  });
});

describe('2. 轮询可见性 —— 页面隐藏时暂停', () => {
  const polling = read('client/src/utils/polling.ts');

  it('提供 createPoller 且监听 visibilitychange', () => {
    expect(polling).toContain('export function createPoller');
    expect(polling).toContain('visibilitychange');
    expect(polling).toContain('pauseWhenHidden');
  });

  it('顶栏 / 监控页 / GPU / 远程上下文都用上了（不再裸 setInterval）', () => {
    const files = [
      'client/src/components/GlobalStatusBar.tsx',
      'client/src/pages/Monitor.tsx',
      'client/src/pages/GPU.tsx',
      'client/src/contexts/RemoteContext.tsx',
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, `${f} 应使用 usePolling`).toContain('usePolling');
    }
  });

  it('顶栏不再重复拉服务器列表（DeviceContext 已经拉过了）', () => {
    const bar = read('client/src/components/GlobalStatusBar.tsx');
    expect(bar).not.toContain('setInterval(refreshDevices');
  });
});

describe('3. 会话持久化 —— 刷新/误关不丢', () => {
  it('存储工具带体积控制（截断工具结果、限制条数、配额降级）', () => {
    const util = read('client/src/utils/conversationStorage.ts');
    expect(util).toContain('export function compactMessagesForStorage');
    expect(util).toContain('export function compactTurnsForStorage');
    expect(util).toContain('export function saveJsonSafe');
    expect(util).toContain('slimToolResult');
  });

  it('运维助手保存时先裁剪（原来裸 setItem 会静默丢失整个会话）', () => {
    const ctx = read('client/src/contexts/AssistantContext.tsx');
    expect(ctx).toContain('compactMessagesForStorage');
    expect(ctx).toContain('saveJsonSafe');
    expect(ctx).not.toMatch(/function persist\(s: AssistantStore\) \{\s*try \{ localStorage\.setItem/);
  });

  it('AI Shell 任务记录按服务器落盘，并可一键清空', () => {
    const term = read('client/src/components/AIShellTerminal.tsx');
    expect(term).toContain('aishell.turns.');
    expect(term).toContain('compactTurnsForStorage');
    expect(term).toContain('setTurns([])');
  });
});

describe('4. 巡检缓存 —— 不再报已修复的异常', () => {
  it('两处巡检都「成功即覆盖」', () => {
    const cache = read('server/patrol-cache.js');
    expect(cache).toContain('export function applyPatrolResults');
    const index = read('server/index.js');
    expect(index).toContain('lastPatrolResults = applyPatrolResults(lastPatrolResults, results)');
    const dockers = read('server/routes/docker.js');
    expect(dockers).toContain('setLastPatrolResults(applyPatrolResults(getLastPatrolResults(), results))');
  });
});

describe('5. 通知中心 —— 筛选/搜索/导出', () => {
  const bell = read('client/src/components/NotificationCenter.tsx');

  it('有筛选（级别/机器/未读）和搜索', () => {
    expect(bell).toContain('filterNotifications');
    expect(bell).toContain('listNotificationSources');
    expect(bell).toContain('unreadOnly');
    expect(bell).toContain('搜索（报错内容/容器名）');
  });

  it('导出跟随筛选结果', () => {
    expect(bell).toContain('filteredNotifications.filter(n => selected.has(n.id))');
    expect(bell).toContain('导出当前筛选的');
  });

  it('筛选是纯函数（可单测）', () => {
    const utils = read('client/src/utils/notifications.ts');
    expect(utils).toContain('export function filterNotifications');
    expect(utils).toContain('export function listNotificationSources');
    expect(utils).toContain('export function isFilterActive');
  });
});

describe('6. AI Shell —— 步数/时长上限可调', () => {
  const shell = read('client/src/components/AIShellTerminal.tsx');
  const server = read('server/ai-shell.js');
  const index = read('server/index.js');

  it('前端有步数/时长下拉并随任务下发', () => {
    expect(shell).toContain('步数上限');
    expect(shell).toContain('aishell.maxSteps');
    expect(shell).toContain('maxWallMs: maxWallMin * 60_000');
  });

  it('服务端有默认值与硬上限（24 / 64 步，20 / 60 分钟）', () => {
    expect(server).toContain('export const MAX_STEPS = 24');
    expect(server).toContain('export const MAX_STEPS_CAP = 64');
    expect(server).toContain('export const MAX_WALL_MS = 20 * 60 * 1000');
    expect(server).toContain('export const MAX_WALL_CAP_MS = 60 * 60 * 1000');
    expect(index).toContain('MAX_STEPS_CAP');
    expect(index).toContain('MAX_WALL_CAP_MS');
  });

  it('小窗口不再额外砍步数（长任务靠台账 + 压缩）', () => {
    expect(server).not.toContain('SMALL_WINDOW_MAX_STEPS');
  });
});

describe('7. 容器列表短缓存 —— 合并并发尖峰', () => {
  it('3 秒缓存 + 操作后失效 + 支持强制刷新', () => {
    const dockers = read('server/routes/docker.js');
    expect(dockers).toContain('createShortCache({ ttlMs: 3000 })');
    expect(dockers).toContain("cached(containersCache, 'containers'");
    expect(dockers).toContain("containersCache.invalidate('containers')");
    expect(dockers).toContain("refresh === '1'");
  });
});

describe('8. AI 分析结果并入通知中心（可筛选 / 可导出）', () => {
  const toast = read('client/src/contexts/ToastContext.tsx');
  const aiToast = read('client/src/components/AIAnalysisToast.tsx');
  const notice = read('client/src/utils/analysisNotice.ts');

  it('ToastContext 提供「只进列表不弹窗」的 notify', () => {
    expect(toast).toContain('notify: (type: ToastType');
    expect(toast).toContain('const notify = useCallback');
    expect(toast).toContain('pushToNotifications({');
  });

  it('AI 分析事件转成通知（done/error/skipped；pending 不记）', () => {
    expect(notice).toContain('export function buildAnalysisNotice');
    expect(notice).toContain("if (status !== 'done' && status !== 'error' && status !== 'skipped') return null");
    expect(notice).toContain("errorType: 'AI 分析'");
    expect(notice).toContain("const nav = '/analysis-history'");
    expect(aiToast).toContain("import { useToast } from '../contexts/ToastContext'");
    expect(aiToast).toContain('buildAnalysisNotice(data)');
    expect(aiToast).toContain('notify(notice.type, notice.message');
  });

  it('分析正文有长度上限（否则 localStorage 会被撑爆）', () => {
    expect(notice).toContain('export const ANALYSIS_STORE_CHARS');
    expect(notice).toContain('已截断');
  });
});

describe('9. AMD / 沐熙 / 华为 GPU 进程解析（不再是 TODO 桩）', () => {
  const gpu = read('server/gpu.js');
  it('三种厂商都有真正的解析函数', () => {
    expect(gpu).toContain('export function parseAMDProcessOutput');
    expect(gpu).toContain('export function parseVendorProcessCsv');
    expect(gpu).toContain('function parseMOXIProcessOutput');
    expect(gpu).toContain('function parseHuaweiProcessOutput');
    expect(gpu).not.toContain('TODO: 根据实际输出格式解析');
  });
  it('AMD 本地/远程都在拿不到进程时回落到纯文本输出', () => {
    expect(gpu).toContain("rocm-smi --showpids 2>/dev/null");
  });
});
