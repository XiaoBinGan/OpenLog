/**
 * server/metrics/route-coverage.js —— 接口清单 × 实际流量对账（契约 4.7，负责人 #10 coverage）
 *
 * 用途：告诉你「哪些接口在统计窗口里一次都没被调用过」（僵尸接口 / 前端写错路径 / 文档写了没人用），
 * 以及反向的「流量里有、清单里没有」的路由（说明 OpenAPI 收集器漏了路由）。
 *
 * 设计约束：
 * - 纯逻辑，无 IO、无 express、无 db。所有输入通过参数传入，便于单测。
 * - 只做字符串结构与集合运算，不依赖 route-pattern.js / openapi.js（避免并行开发时互相阻塞）。
 */

/**
 * 把一条路径切成「段」并标注参数位。
 * 归一化规则（inventory 与 traffic 共用这一个函数，绝不写两套）：
 *   - 丢掉 query / hash；
 *   - 忽略尾部斜杠（多个也忽略），忽略连续斜杠产生的空段；
 *   - ':param'（Express）与 '{param}'（OpenAPI）都算参数段；
 *   - 参数段本身不参与字面比较，只记一个通配标记。
 *
 * 为什么参数名不参与比较：
 *   inventory 来自 OpenAPI（'{sourceId}'），traffic 来自指标表（req.route.path 的 ':sourceId'），
 *   而同一个物理路由在不同代码路径上可能被命名成 ':id' / ':serverId' / ':sourceId'。
 *   参数名是**开发者随手起的标识**，不是路由语义的一部分；真正决定「是不是同一个接口」的是
 *   段数、非参数段字面量、以及参数出现在第几段。若把参数名纳入比较，改个变量名就会让
 *   覆盖率统计凭空多出一堆「僵尸接口」，这个报表立刻失去意义。
 *   注意：路径本身仍然大小写敏感（Linux 与多数反向代理都区分大小写），只有 method 统一大写。
 *
 * @param {string} rawPath 原始路径，如 '/api/docker/containers/:sourceId/logs'
 * @returns {{ segments: Array<{ param: boolean, text: string }>, key: string }}
 *   segments 供逐段比对；key 供去重（参数位统一替换成 '\u0000*'，因此 ':id' 与 ':sourceId' 同 key）
 */
function toPattern(rawPath) {
  let p = typeof rawPath === 'string' ? rawPath : '';
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  p = p.trim().replace(/\/+$/, '');
  if (p === '') return { segments: [], key: '' };

  const segments = p
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      const isParam = s.startsWith(':') || (/^\{[^}]*\}$/.test(s) && s.length > 2);
      return isParam ? { param: true, text: '' } : { param: false, text: s };
    });

  const key = segments.map((s) => (s.param ? '\u0000*' : s.text)).join('/');
  return { segments, key };
}

/**
 * 两个模式是否指向同一个接口。
 * 判定：段数相同 + 逐段「非参数段字面相等」+「参数段位置对应通配」。
 * 只要有一侧是参数段就算通配（宁可命中也不要漏判）：traffic 万一带着未归一化的真实路径
 * （如 /api/remote/servers/3f2b.../files），也应该能匹配到模板 /api/remote/servers/:id/files，
 * 否则这条流量会被误报成 unknownTraffic。
 *
 * @param {{ segments: Array<{ param: boolean, text: string }> }} a
 * @param {{ segments: Array<{ param: boolean, text: string }> }} b
 * @returns {boolean}
 */
function samePattern(a, b) {
  if (a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.segments.length; i += 1) {
    const sa = a.segments[i];
    const sb = b.segments[i];
    if (sa.param || sb.param) continue; // 参数段（任意一侧）→ 该位置视为通配
    if (sa.text !== sb.text) return false; // 字面段必须完全相等（大小写敏感）
  }
  return true;
}

/**
 * 保留 1 位小数的百分比数字。
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number}
 */
function rate1(numerator, denominator) {
  if (!denominator) return 0; // total=0 时必须给 0，不能出现 NaN
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * 接口清单 × 实际流量 = 覆盖率。
 *
 * @param {object} opts
 * @param {Array<{ method: string, path: string }>} opts.inventory
 *   OpenAPI 收集到的路由模板，如 { method: 'GET', path: '/api/docker/containers/:sourceId/logs' }
 * @param {Array<{ method: string, route: string, calls: number, lastSeenMs?: number }>} opts.traffic
 *   指标表聚合后的流量，如 { method: 'GET', route: '/api/docker/containers/:sourceId/logs', calls: 12 }
 * @param {number} [opts.nowMs] 统计窗口截止时间（epoch 毫秒）。保留位：当前判定只看传入的聚合流量，
 *   将来要按「最近 N 天」二次过滤时在这里用，避免改签名。
 * @returns {{
 *   total: number, used: number, unused: number, coverageRate: number,
 *   unusedRoutes: Array<{ method: string, path: string }>,
 *   rows: Array<{ method: string, path: string, calls: number, lastSeenMs: number|null, used: boolean }>,
 *   unknownTraffic: Array<{ method: string, route: string, calls: number, lastSeenMs: number|null }>
 * }}
 */
export function buildCoverage({ inventory, traffic, nowMs } = {}) {
  void nowMs; // 见 JSDoc：签名保留，判定暂不依赖时间窗口

  const invList = Array.isArray(inventory) ? inventory : [];
  const trfList = Array.isArray(traffic) ? traffic : [];

  // ---- 1. inventory 去重：同一 method + 同一模式（参数名不同也算同一条）只保留第一次出现的 ----
  // 保留首次出现的原样（method 大写化，path 保留原参数名），这样报表里显示的是清单里的写法。
  const seen = new Set();
  const invEntries = [];
  for (const item of invList) {
    if (!item || typeof item !== 'object') continue;
    const method = String(item.method ?? '').trim().toUpperCase();
    const rawPath = typeof item.path === 'string' ? item.path : '';
    const pattern = toPattern(rawPath);
    const dedupeKey = `${method} ${pattern.key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    invEntries.push({ method, path: rawPath, pattern });
  }

  // ---- 2. traffic 预处理 + 按 method+模式 聚合（同一路由多条记录求和 / lastSeen 取最大）----
  // 指标表按分钟分桶，所以同一路由天然会出现多行；这里先聚合，命中 inventory 时直接取用。
  const trfMap = new Map(); // 'METHOD key' -> { method, route, calls, lastSeenMs, pattern }
  for (const item of trfList) {
    if (!item || typeof item !== 'object') continue;
    const method = String(item.method ?? '').trim().toUpperCase();
    const route = typeof item.route === 'string' ? item.route : '';
    const pattern = toPattern(route);
    const aggKey = `${method} ${pattern.key}`;
    const calls = Number.isFinite(Number(item.calls)) ? Number(item.calls) : 0;
    const lastSeen = Number.isFinite(Number(item.lastSeenMs)) ? Number(item.lastSeenMs) : null;

    const hit = trfMap.get(aggKey);
    if (!hit) {
      trfMap.set(aggKey, { method, route, calls, lastSeenMs: lastSeen, pattern });
    } else {
      hit.calls += calls;
      if (lastSeen !== null && (hit.lastSeenMs === null || lastSeen > hit.lastSeenMs)) hit.lastSeenMs = lastSeen;
    }
  }

  // ---- 3. 对账 ----
  const matchedTrafficKeys = new Set();
  const rows = invEntries.map((entry) => {
    let calls = 0;
    let lastSeenMs = null;
    // 直接按聚合 key 命中算快路径；参数名不同导致 key 不同时（:id vs :sourceId）退化到逐条模式比对。
    for (const [aggKey, trf] of trfMap) {
      if (!samePattern(entry.pattern, trf.pattern)) continue;
      if (trf.method !== entry.method) continue;
      matchedTrafficKeys.add(aggKey);
      calls += trf.calls;
      if (trf.lastSeenMs !== null && (lastSeenMs === null || trf.lastSeenMs > lastSeenMs)) lastSeenMs = trf.lastSeenMs;
    }
    return { method: entry.method, path: entry.path, calls, lastSeenMs, used: calls > 0 };
  });

  const used = rows.filter((r) => r.used).length;
  const total = rows.length;
  const unusedRoutes = rows.filter((r) => !r.used).map((r) => ({ method: r.method, path: r.path }));

  // ---- 4. 反向对账：有流量但清单里没有 → 收集器漏了路由（这是最值得修的一类问题）----
  const unknownTraffic = [];
  for (const [aggKey, trf] of trfMap) {
    if (matchedTrafficKeys.has(aggKey)) continue;
    unknownTraffic.push({ method: trf.method, route: trf.route, calls: trf.calls, lastSeenMs: trf.lastSeenMs });
  }

  return {
    total,
    used,
    unused: unusedRoutes.length,
    coverageRate: rate1(used, total),
    unusedRoutes,
    rows,
    unknownTraffic,
  };
}
