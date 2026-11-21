/**
 * server/demo/mode.js —— 演示模式开关与响应包装
 *
 * 演示模式（OPENLOG_DEMO=1）下，路由不连真实 SSH / Docker / K8s，也不写库，
 * 而是把 server/demo/fixtures.js 里的常量表当成「刚采集到的数据」返回。
 *
 * 这里只放三样东西，全部是纯函数/常量：
 *   isDemoMode()    —— 读环境变量（`=== '1'`，其它任何值都算关闭）
 *   DEMO_DISABLED   —— 写操作被禁用时的统一响应体（配 409）
 *   demoJson()      —— 给对象响应挂 `demo: true` 标记
 *
 * 为什么标记要挂在**每个**响应上，而不只是挂在 /api/demo：
 * 前端可能只刷新某一个面板（比如 30 秒轮询的 /api/remote/servers/:id/stats），
 * 这时它读不到 /api/demo 的最新状态；响应自带标记，前端就能对单条数据判定来源。
 *
 * 约定（不要改）：
 * - 关闭演示模式时行为与原来完全一致 —— 这三个导出都不参与真实链路。
 * - 不做任何 IO、不读设置、不引用其它模块。
 */

/**
 * 当前是否处于演示模式。
 *
 * 只认字面量 `'1'`：`OPENLOG_DEMO=true` / `'yes'` 一律视为关闭。
 * 这样误设环境变量不会让线上实例悄悄变成假数据 —— 「静默变成假数据」
 * 比「演示模式没开」危险得多。
 *
 * @returns {boolean}
 */
export function isDemoMode() {
  return process.env.OPENLOG_DEMO === '1';
}

/**
 * 演示模式下写操作的统一响应体（由路由配 409 状态码返回）。
 *
 * 前端按 `error` 展示提示、按 `demo` 抑制「重试」按钮（重试也永远不会成功）。
 * 用冻结对象，避免某条路由顺手往里塞字段后影响其它路由。
 */
export const DEMO_DISABLED = Object.freeze({
  demo: true,
  error: '演示模式：该操作已被禁用',
});

/**
 * 给演示响应挂上 `demo: true` 标记。
 *
 * @param {object} payload 与真实路由 `res.json(...)` 完全同形的数据
 * @returns {object} `{ demo: true, ...payload }`
 *
 * 注意数组响应（`GET /api/logs/files` 在真实实现里直接 `res.json(files)`，
 * 响应体就是数组）无法承载字段 —— JSON 序列化会丢掉数组上的自定义属性。
 * 这类端点原样返回数组即可，演示标记由 `GET /api/demo` 与页面横幅负责，
 * 前端不要指望每个响应都有 `demo` 字段。
 */
export function demoJson(payload) {
  if (Array.isArray(payload)) return payload;
  return { demo: true, ...payload };
}
