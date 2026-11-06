/**
 * server/routes/openapi.js —— 接口清单 JSON / 文档页 / 路由清单（契约第 5 节）
 *
 * ── 安全红线（接线的人必须先读这段）──────────────────────────────────────
 * 1) 文档页与 spec 会暴露**全部内部接口名**，其中包含
 *    `/api/remote/servers/:id/shell`、`/api/remote/servers/:id/files/op`（远程 shell、
 *    任意文件读写）这类高危能力。对未鉴权的人，这两份响应就是一张完整的入侵地图。
 *    因此它们**必须由外层鉴权保护**，且和别的 `/api/*` 一样属于「后台内部」接口。
 * 2) 本模块**不自己实现鉴权**：不重复造 token 校验，也不猜外层用的是 cookie 还是 bearer。
 *    它只在路由最前面 `router.use(deps.authGuard)`，把「谁有权限看文档」这个决定权
 *    留给持有 auth 中间件的那一层（server/index.js）。正确接线：
 *      app.use(authMiddleware);
 *      app.use(createOpenApiRouter({ spec: () => buildOpenApi(app) }));
 *    或显式 `createOpenApiRouter({ authGuard: authMiddleware, ... })` 做双保险。
 * 3) **绝对不要**把 `/api/openapi.json` / `/api/docs` 加进 `PUBLIC_PATHS`
 *    （server/index.js 的免鉴权白名单）。漏一次 = 内部攻击面全量外泄。
 * 4) 同理**不提供**「公开文档开关」(public docs toggle)：内部运维面板不存在
 *    「把接口文档发给外部」的合法场景，多一个开关只是多一个被打错的机会。
 *
 * ── 为什么 spec 是惰性函数而不是启动时算好的对象 ──────────────────────────
 * 路由挂载顺序决定了最终路径，启动早期算 spec 会漏掉后挂的 router；改成每次请求
 * 重新收集（spec() 内部走 collectRoutes），开发期加一个路由刷新页面就能看到，
 * 也不会把「接口清单」和「真实路由表」两份真值养到漂移。
 * 成本可以忽略：这条端点只给人和调试脚本点，没有高频调用。
 *
 * ── 为什么只有这里允许 500 ───────────────────────────────────────────────
 * 监控/文档类端点出错时，返回**没有数据**永远好过返回**错的数据**：
 * spec() 抛错说明路由栈反解失败，此时给出 200 + 空 paths 会被误当成
 * 「这个版本就是没接口」，进而让覆盖率页把 100% 的接口报成「从未被调用」。
 * 所以宁可 500 + { error }，让人立刻看到坏掉，也不静默降级。
 */
import express from 'express';
// 复用 #3 openapi 已交付的离线文档页（单文件零外部资源）。这里只读引用，不依赖它的内部实现；
// 之所以要 import 而不是让 Lead 每次手工传 renderDocsHtml，是因为「接线漏传 → 文档页降级成
// 一张朴素列表」这种 bug 只会在生产发现，而默认值正确就没有这个面。
import { renderDocsHtml as shippedDocsHtml } from '../openapi.js';

/** 从 spec.paths 反推路由清单时要认的方法名（排除 parameters/summary 等非方法键） */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

/**
 * 无注入 renderDocsHtml 时的兜底页：只把路径平铺出来，零外部资源。
 * 正常情况下会用 server/openapi.js 里那份带搜索/分组的好页面，
 * 这份只在「有人手搓 router 忘了传 renderDocsHtml」时兜底，保证不会白屏。
 * @param {object} spec OpenAPI 文档对象
 * @param {string} title 标题（已由调用方做过 escape）
 * @returns {string} 完整 HTML
 */
function fallbackDocsHtml(spec, title) {
  const paths = (spec && spec.paths) || {};
  const rows = [];
  for (const p of Object.keys(paths).sort()) {
    for (const m of HTTP_METHODS) {
      if (paths[p] && paths[p][m]) rows.push(`<li><b>${m.toUpperCase()}</b> <code>${p}</code></li>`);
    }
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body><h1>${title}</h1><ul>${rows.join('') || '<li>（无路由）</li>'}</ul></body></html>`;
}

/**
 * 从 spec.paths 反推 [{ method, path }]（method 为大写，便于直接塞进 UI 表格）。
 * spec.paths[path] 里除了方法还有 `parameters` / `summary` / `$ref` 等键，只认 HTTP 方法。
 * @param {object} spec OpenAPI 文档对象
 * @returns {Array<{ method: string, path: string }>}
 */
function routesFromSpec(spec) {
  const paths = (spec && typeof spec.paths === 'object' && spec.paths) || {};
  const out = [];
  for (const path of Object.keys(paths)) {
    const item = paths[path];
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      if (Object.prototype.hasOwnProperty.call(item, method)) out.push({ method: method.toUpperCase(), path });
    }
  }
  // 排序放在这里而不是依赖 collectRoutes：两条来源（spec 反推 / deps.collectRoutes）
  // 出来的顺序一致，前端 diff 才不会天天报「顺序变了」。
  out.sort((a, b) => (a.path === b.path
    ? (a.method < b.method ? -1 : a.method > b.method ? 1 : 0)
    : (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  return out;
}

/**
 * 创建接口清单路由。
 *
 * @param {object} deps 依赖注入（全部通过参数传入，便于单测，不 import 全局 app）
 * @param {() => object} deps.spec 惰性产出 OpenAPI 文档对象；每次请求都会调用一次
 * @param {(spec: object) => string} [deps.renderDocsHtml] HTML 渲染器；默认用 server/openapi.js 里那份
 * @param {string} [deps.title] 仅兜底渲染器/默认 spec 用的标题
 * @param {string} [deps.version] 仅兜底渲染器/默认 spec 用的版本号
 * @param {(req: any, res: any, next: Function) => void} [deps.authGuard] 鉴权中间件；
 *        不传则完全依赖外层已鉴权的挂载点（见文件头「安全红线」）
 * @param {(app?: any) => Array<{ method: string, path: string }>} [deps.collectRoutes]
 *        可选：直接提供路由收集器（server/openapi.js 的 collectRoutes），
 *        `/api/openapi/routes` 就用它而不是从 spec.paths 反推
 * @returns {import('express').Router}
 */
export function createOpenApiRouter(deps = {}) {
  const d = deps || {};
  const { spec, renderDocsHtml, authGuard, collectRoutes } = d;
  const title = typeof d.title === 'string' && d.title ? d.title : 'OpenLog API';
  const version = typeof d.version === 'string' && d.version ? d.version : '1.0.0';

  // 创建期就把配置错误炸出来：spec 不是函数的话，每个请求都会变成 500，
  // 那样监控里只会看到一片 5xx，看不出是「接线漏了参数」。
  if (typeof spec !== 'function') {
    throw new TypeError('createOpenApiRouter: deps.spec 必须是 () => object 的函数');
  }
  if (collectRoutes != null && typeof collectRoutes !== 'function') {
    throw new TypeError('createOpenApiRouter: deps.collectRoutes 必须是函数或省略');
  }

  const router = express.Router();

  /** 取 spec；顺便校验返回值是个对象（返回 null/数组同样没法反解） */
  function resolveSpec() {
    const s = spec();
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new TypeError('spec() 必须返回 OpenAPI 文档对象');
    }
    return s;
  }

  /** 文档必须立刻反映新路由，通篇不许缓存 */
  function noStore(res) {
    res.setHeader('Cache-Control', 'no-store');
  }

  /** JSON 响应：显式写死 charset，避免中文标题在部分客户端被按 latin1 解 */
  function sendJson(res, payload, status = 200) {
    noStore(res);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).send(JSON.stringify(payload));
  }

  /**
   * 统一错误出口：只回 message，**不回 stack、不回 err 对象**。
   * stack 里带绝对路径、依赖版本、甚至环境变量快照，而这个端点本身就在
   * 鉴权后面 —— 但它输出的东西会被贴进工单/截图，不该带上这些。
   */
  function sendSpecError(res, err) {
    const msg = err && typeof err.message === 'string' && err.message ? err.message : 'spec 生成失败';
    sendJson(res, { error: msg.slice(0, 500) }, 500);
  }

  // 鉴权放在最前面：先过闸门再算 spec —— 否则未鉴权请求也会触发一次全路由遍历，
  // 等于把「服务有多少接口」用耗时侧信道漏出去。
  if (typeof authGuard === 'function') router.use(authGuard);

  /** GET /api/openapi.json —— spec 本体 */
  router.get('/api/openapi.json', (req, res) => {
    try {
      sendJson(res, resolveSpec());
    } catch (err) {
      sendSpecError(res, err);
    }
  });

  /**
   * GET /api/openapi/routes —— 给覆盖率页/调试用的扁平清单。
   * `deps.collectRoutes` 优先（直接读真实路由栈）；否则从 spec.paths 反推。
   */
  router.get('/api/openapi/routes', (req, res) => {
    try {
      const routes = typeof collectRoutes === 'function'
        ? collectRoutes()
        : routesFromSpec(resolveSpec());
      const list = (Array.isArray(routes) ? routes : []).map((r) => ({
        method: String(r && r.method ? r.method : '').toUpperCase(),
        path: String(r && r.path ? r.path : ''),
      }));
      sendJson(res, { count: list.length, routes: list });
    } catch (err) {
      sendSpecError(res, err);
    }
  });

  /**
   * GET /api/docs —— 单文件 HTML 文档页；`?format=json` 时等价于 openapi.json。
   * `?format=json` 存在的理由：文档页出问题（前端 JS 被 CSP 挡、内网代理乱改 HTML）
   * 时，同一个 URL 换个参数就能拿到机器可读的 spec，不用记第二条路径。
   */
  router.get('/api/docs', (req, res) => {
    const format = String((req.query && req.query.format) || '').toLowerCase();
    if (format === 'json') {
      try {
        sendJson(res, resolveSpec());
      } catch (err) {
        sendSpecError(res, err);
      }
      return;
    }

    try {
      const specObj = resolveSpec();
      const render = typeof renderDocsHtml === 'function'
        ? renderDocsHtml
        : (typeof shippedDocsHtml === 'function'
          ? shippedDocsHtml
          : (s) => fallbackDocsHtml(s, escapeHtml(title)));
      const html = render(specObj);
      noStore(res);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // 文档页里全是内部路径：不许浏览器猜 MIME，也不许被别的站点 iframe 进去截图
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.status(200).send(typeof html === 'string' ? html : String(html ?? ''));
    } catch (err) {
      sendSpecError(res, err);
    }
  });

  return router;
}

/** 兜底模板里唯一的动态文本就是标题，做最小转义 */
function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export default createOpenApiRouter;
