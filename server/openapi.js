/**
 * server/openapi.js —— 接口清单（OpenAPI 3.0）+ 离线单文件文档页（契约 4.8）
 *
 * 为什么直接从活的路由栈摊平，而不手写一份 spec：
 * 1) 项目 96 个手写路由散在 server/routes/*.js，全部用 `app.use(createXRouter(...))` 挂载，
 *    没有任何声明式清单；手写清单会腐烂，从运行时反解则永远跟代码一致，接口清单和
 *    覆盖率（4.7）也就能共用同一份真值。
 * 2) Express 4 路由表是递归结构：`app._router.stack` 里既有 route 层（`.route.path` +
 *    `.route.methods`），也有挂载 router 的中间件层（`.handle.stack`）。真实路径 = 父前缀 +
 *    子路径，必须递归下钻逐层拼前缀，否则 `/api` 下的接口全丢前缀，覆盖率统计直接错。
 * 3) `app.use(prefix, router)` 的 prefix 在 Express 4 里不落 `layer.path`，只能从
 *    `layer.regexp.source` 反解 —— 这是唯一可靠来源（Express 5 才改回 layer.path，故两条路都留）。
 * 4) 中间件层（cors/jsonParser/鉴权/error handler）既无 `route` 也无 `handle.stack`，一律跳过，
 *    否则「每个请求都过一遍中间件」会被当成接口，清单注水。
 */

/** router.all() 在 methods 里只有 _all，展开成这些方法 */
const ALL_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
/** 递归深度上限：防止 router 自挂自己把进程打爆 */
const MAX_DEPTH = 20;

/**
 * 把 express 的 ':id' 路径转成 OpenAPI 的 '{id}'。
 * @param {string} path express 路由路径，如 '/a/:id/b'
 * @returns {string} '/a/{id}/b'
 */
export function expressPathToOpenApi(path) {
  if (typeof path !== 'string' || path.trim() === '') return '/';
  let p = path.trim();
  if (!p.startsWith('/')) p = '/' + p;
  // '*' / '/a/*' 是 express 的「吞掉剩余任意段」；OpenAPI 没有通配符，只能落成一个命名路径参数，
  // 名字取 path（与 layer.keys 里通配 key 的惯例一致）。
  p = p.replace(/\*+/g, '{path}');
  // ':id?' 与 ':id(\d+)' 一律降级成普通参数：OpenAPI 的 path 里不能出现 '?' 和裸正则
  p = p.replace(/:([A-Za-z0-9_]+)\([^)]*\)/g, '{$1}');
  p = p.replace(/:([A-Za-z0-9_]+)\??/g, '{$1}');
  return p.replace(/\/{2,}/g, '/');
}

/**
 * 从路由栈里收集 [{ method, path }]（docs 与覆盖率共用）。
 * 同 method+path 只留一条，按 path 升序、同 path 内按 method 升序。
 * @param {any} app express 应用实例
 * @returns {Array<{ method: string, path: string }>}
 */
export function collectRoutes(app) {
  const seen = new Map();
  walk(rootStack(app), '', seen, 0);
  const list = [...seen.values()];
  list.sort((a, b) => (a.path === b.path
    ? compareStr(a.method, b.method)
    : compareStr(a.path, b.path)));
  return list;
}

/**
 * 产出最小可用的 OpenAPI 3.0 文档对象（每路径每方法一个 operation）。
 * @param {any} app express 应用实例
 * @param {{ title?: string, version?: string, serverUrl?: string }} [opts]
 * @returns {object} OpenAPI 3.0 文档
 */
export function buildOpenApi(app, opts = {}) {
  const { title = 'OpenLog API', version = '1.0.0', serverUrl = '/' } = opts || {};
  const paths = {};
  for (const { method, path } of collectRoutes(app)) {
    if (!paths[path]) paths[path] = {};
    // summary 用 method + path：没有 schema 也要能一眼定位，UI 不用再拼一次
    paths[path][method.toLowerCase()] = {
      summary: `${method} ${path}`,
      responses: { 200: { description: 'OK' } },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title, version },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
    security: [{ bearerAuth: [] }],
  };
}

/**
 * 极小 HTML 文档页：单文件、内联 CSS/JS、零外部资源（离线双击就能开）。
 * 左侧按 `/api` 第二段分组，右侧方法徽章+路径，顶部搜索框纯前端过滤。
 * @param {object} spec OpenAPI 文档对象
 * @returns {string} 完整 HTML 字符串
 */
export function renderDocsHtml(spec) {
  const s = spec || {};
  const info = s.info || {};
  const title = esc(info.title || 'API');
  const version = esc(info.version || '');
  const serverUrl = esc((s.servers && s.servers[0] && s.servers[0].url) || '/');
  const groups = groupBySegment(s.paths || {});
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  const nav = groups.map((g) => `      <a href="#g-${g.id}">${esc(g.name)}<em>${g.items.length}</em></a>`).join('\n');
  const body = groups.map((g) => {
    // data-k 一次性塞进 method/path/分组，前端只做一次 indexOf，不用再解析 DOM
    const rows = g.items.map((it) => `        <li class="item" data-k="${esc((it.method + ' ' + it.path + ' ' + g.name).toLowerCase())}"><span class="m ${it.method.toLowerCase()}">${it.method}</span><code>${esc(it.path)}</code></li>`).join('\n');
    return `    <section class="grp" id="g-${g.id}">\n      <h2>${esc(g.name)}<em>${g.items.length}</em></h2>\n      <ul>\n${rows}\n      </ul>\n    </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 接口文档</title>
<style>
:root{--bg:#0f1420;--fg:#e6edf7;--dim:#8b9bb4;--line:#222c3d;--card:#151d2b;--acc:#4da3ff}
*{box-sizing:border-box}[hidden]{display:none !important}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:9;display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:14px 20px;background:#0b1120;border-bottom:1px solid var(--line)}
header h1{margin:0;font-size:16px;font-weight:600}header .ver{color:var(--dim);font-size:12px;margin-left:6px}header .srv{color:var(--dim);font-size:12px}
#q{flex:1;min-width:200px;max-width:420px;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:13px;outline:none}
#q:focus{border-color:var(--acc)}#hit{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
.layout{display:flex;align-items:flex-start}
#nav{position:sticky;top:57px;width:190px;flex:0 0 190px;max-height:calc(100vh - 57px);overflow:auto;padding:14px 8px 40px;border-right:1px solid var(--line)}
#nav a{display:flex;justify-content:space-between;gap:8px;padding:5px 10px;border-radius:6px;color:var(--dim);text-decoration:none;font-size:13px}
#nav a:hover{background:var(--card);color:var(--fg)}#nav em{color:var(--dim);font-style:normal;font-size:11px}
main{flex:1;min-width:0;padding:14px 20px 60px}.grp{margin:0 0 26px}
.grp h2{display:flex;align-items:center;gap:8px;margin:14px 0 8px;font-size:13px;font-weight:600;color:var(--acc);text-transform:lowercase}
.grp h2 em{color:var(--dim);font-style:normal;font-weight:400;font-size:11px}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.item{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:7px;border:1px solid transparent}
.item:hover{background:var(--card);border-color:var(--line)}
.m{flex:0 0 58px;text-align:center;padding:2px 6px;border-radius:5px;font-size:10.5px;font-weight:700;letter-spacing:.5px;background:#1d2838;color:#9fb3cd}
.m.get{background:#102b1d;color:#5fd39b}.m.post{background:#122a45;color:#6fb6ff}.m.put{background:#2c2612;color:#e0c169}
.m.patch{background:#2a1f38;color:#bb92f0}.m.delete{background:#331619;color:#f08a94}
.m.head,.m.options{background:#20262f;color:#93a1b5}
code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
footer{padding:10px 20px 30px;color:var(--dim);font-size:12px}
@media(max-width:720px){#nav{display:none}main{padding:12px}}
</style>
</head>
<body>
<header>
  <h1>${title}<span class="ver">v${version}</span></h1>
  <input id="q" type="search" placeholder="搜索路径 / 方法 / 分组" autocomplete="off" spellcheck="false">
  <span id="hit">${total}</span><span class="srv">${serverUrl}</span>
</header>
<div class="layout">
  <nav id="nav">
${nav}
  </nav>
  <main id="list">
${body}
  </main>
</div>
<footer>需鉴权：请求头 Authorization: Bearer &lt;token&gt;。本页为离线单文件渲染，无外部依赖。</footer>
<script>
(function(){
  var q=document.getElementById('q'),hit=document.getElementById('hit');
  var items=[].slice.call(document.querySelectorAll('.item'));
  var secs=[].slice.call(document.querySelectorAll('.grp'));
  function apply(){
    var v=(q.value||'').trim().toLowerCase(),n=0;
    items.forEach(function(el){var ok=!v||el.getAttribute('data-k').indexOf(v)>=0;el.hidden=!ok;if(ok)n++;});
    secs.forEach(function(sec){
      var vis=!!sec.querySelector('.item:not([hidden])');sec.hidden=!vis;
      var a=document.querySelector('#nav a[href="#'+sec.id+'"]');if(a)a.hidden=!vis;
    });
    hit.textContent=v?(n+' / '+items.length):String(items.length);
  }
  q.addEventListener('input',apply);
  q.addEventListener('keydown',function(e){if(e.key==='Escape'){q.value='';apply();}});
  apply();
})();
</script>
</body>
</html>`;
}

// ───────────────────────────── 内部实现 ─────────────────────────────

/**
 * 取根路由栈：Express 4 在 `app._router`，Express 5 挪到 `app.router`。
 * 注意 Express 4 里**读** `app.router` 会直接抛 "'app.router' is deprecated"，
 * 而空 app（还没挂任何路由）的 `_router` 就是 undefined —— 兜底分支会被走到，必须包 try。
 */
function rootStack(app) {
  if (!app) return [];
  if (app._router && Array.isArray(app._router.stack)) return app._router.stack;
  try {
    const r = app.router;
    if (r && Array.isArray(r.stack)) return r.stack;
  } catch { /* Express 4 的弃用 getter：忽略 */ }
  return [];
}

/** 递归遍历一层路由栈，prefix 是该层所在的挂载前缀 */
function walk(stack, prefix, seen, depth) {
  if (!Array.isArray(stack) || depth > MAX_DEPTH) return;
  for (const layer of stack) {
    if (!layer) continue;
    // ① route 层：真正定义了 method + path
    if (layer.route) {
      const methods = methodsOf(layer.route);
      const rawPaths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const rawPath of rawPaths) {
        const full = expressPathToOpenApi(joinPaths(prefix, rawPath));
        for (const method of methods) {
          const key = method + ' ' + full;          // Map key 即去重键：同 method+path 只留第一条
          if (!seen.has(key)) seen.set(key, { method, path: full });
        }
      }
      continue;
    }
    // ② 挂载子 router / 子 app 的层：递归下钻，前缀 = 父前缀 + 本层挂载路径
    const sub = layer.handle?.stack || layer.handle?._router?.stack;
    if (Array.isArray(sub)) walk(sub, joinPaths(prefix, mountPathOf(layer)), seen, depth + 1);
    // ③ 其余层（cors/jsonParser/鉴权/error handler）无 route 也无子栈 —— 直接忽略
  }
}

/** route.methods 形如 {get:true}；_all 展开成常见方法列表 */
function methodsOf(route) {
  const raw = route?.methods || {};
  if (raw._all) return ALL_METHODS.map((m) => m.toUpperCase());
  return Object.keys(raw).filter((m) => raw[m] && !m.startsWith('_')).map((m) => m.toUpperCase());
}

/** 拼前缀；prefix 空表示挂在根上，子路径 '/' 时不留多余斜杠 */
function joinPaths(prefix, rawPath) {
  const head = prefix && prefix !== '/' ? prefix.replace(/\/+$/, '') : '';
  let tail = typeof rawPath === 'string' && rawPath !== '' ? rawPath : '/';
  if (!tail.startsWith('/')) tail = '/' + tail;
  if (head && tail === '/') return head;
  return head + tail;
}

/**
 * 反解挂载前缀：`app.use('/api', r)` 在 Express 4 里只剩 layer.regexp，
 * 形如 /^\/api\/?(?=\/|$)/。去掉锚点和尾部「可选斜杠+前瞻」，再按 layer.keys 回填参数名。
 */
function mountPathOf(layer) {
  if (typeof layer.path === 'string' && layer.path) return normalizeMount(layer.path); // Express 5 直接给
  const src = layer?.regexp?.source;
  if (!src) return '';
  let s = String(src).replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  if (s === '' || s === '\\/' || s === '(?:.*)' || s === '(.*)') return ''; // 挂根上：无前缀
  let ki = 0;
  // express 把 :name 编译成 (?:([^\/]+?))，按 keys 顺序换成 :name 交给后面统一转换
  s = s.replace(/\(\?:\(([^)]*)\)\)\??/g, () => paramName(layer.keys, ki++));
  s = s.replace(/\\(.)/g, '$1'); // 反转义 \/ \- \. 等
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '');
}

function normalizeMount(p) {
  let s = String(p).trim();
  if (!s || s === '/' || s === '*') return '';
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '');
}

/** 通配 key 的 name 是数字 0，给它一个可读名字 */
function paramName(keys, i) {
  const k = keys && keys[i];
  return ':' + ((k && typeof k.name === 'string' && k.name) || 'p' + i);
}

/** 稳定字典序，不用 localeCompare（locale 会影响不同机器上的输出顺序） */
function compareStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 分组：`/api/logs/xxx` 取 `/api` 后的第二段（logs），其余路径取第一段。
 * 按业务域分栏比按字母铺平 96 条更好找，也天然对齐 routes/*.js 的文件名。
 */
function groupBySegment(paths) {
  const map = new Map();
  for (const [path, ops] of Object.entries(paths)) {
    const segs = String(path).split('/').filter(Boolean);
    const name = segs[0] === 'api' ? (segs[1] || 'root') : (segs[0] || 'root');
    if (!map.has(name)) map.set(name, []);
    for (const method of Object.keys(ops || {})) map.get(name).push({ method: method.toUpperCase(), path });
  }
  const byKey = (a, b) => (a.path === b.path ? compareStr(a.method, b.method) : compareStr(a.path, b.path));
  return [...map.entries()]
    .map(([name, items]) => ({ id: name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'), name, items: items.sort(byKey) }))
    .sort((a, b) => compareStr(a.name, b.name));
}

/** HTML 文本转义：路径里可能出现 '<' 等字符，别让文档页被注入 */
function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
