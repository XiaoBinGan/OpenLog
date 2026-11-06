/**
 * 接口埋点中间件（只写内存注册表，绝不写库 —— 落库是 api-store 的职责）
 *
 * 为什么必须挂在「限流 / 鉴权」之前：
 *   401 与 429 也是接口健康度的一部分 —— 401 暴涨说明前端令牌失效、整片客户端掉线，
 *   429 暴涨说明有客户端在打爆限流。若埋点挂在鉴权之后，这两类请求在进入埋点时已被短路，
 *   统计里只剩「活得下来」的流量，错误率与 QPS 会被系统性低估 —— 也就是错误率失真。
 *   埋点只读 req.path / res.statusCode，不碰身份信息，前置挂载不会泄露任何东西。
 *
 * 为什么用 res.on('finish') 而不是 'close'：
 *   'close' 在客户端中途掐断连接时也会触发，那时 statusCode 还是默认 200，
 *   会把中断请求记成成功；'finish' 只在响应真正写完时触发，statusCode 才可信。
 *
 * 为什么延迟用 process.hrtime.bigint()：
 *   单调时钟，NTP 校时跳变不会算出负数或天文数字（见契约第 2 节）。
 */

/** 默认开关：环境变量显式写成 off 才旁路，其余一律记录 */
const defaultEnabled = () => process.env.OPENLOG_METRICS !== 'off';

/** 默认归一化：原样返回。真实接线由 Lead 注入 route-pattern.js 的 normalizeRoutePath（此处不 import） */
const identityNormalize = (p) => p;

/**
 * 拼路由模板。优先 baseUrl + req.route.path（模板形态，基数最低）；
 * 拿不到时回落到 normalize(req.path)。
 * Express 在子路由交还控制权后会把 req.baseUrl 还原成 ''，而 finish 通常发生在
 * 处理函数栈内（baseUrl 还在）。极端情况下用 req.path 尾部对齐把前缀补回来；
 * 带参数的模板（含 ':'）不做这种推断，宁可留给 normalize 兜底。
 */
function joinRoute(base, routePath, fullPath) {
  if (base) return base + routePath;
  if (!routePath.includes(':') && fullPath.endsWith(routePath)) return fullPath;
  return routePath;
}

/**
 * 创建 Express 埋点中间件。
 * @param {object} opts 配置
 * @param {{ record: (route: string, method: string, statusCode: number, durationMs: number) => void }} opts.registry
 *   目标注册表；测试传 `{ record(){} , dropped: 0 }` 这样的 stub 即可
 * @param {() => boolean} [opts.enabled] 是否启用，默认 `process.env.OPENLOG_METRICS !== 'off'`
 * @param {(p: string) => string} [opts.normalize] 路径归一化，默认原样返回；真实接线传 normalizeRoutePath
 * @param {((p: string) => boolean) | null} [opts.shouldSkip] 跳过判定，默认 null；真实接线传 shouldSkipPath
 * @returns {((req: any, res: any, next: Function) => void) & { dropped: number }}
 *   中间件；`dropped` 是埋点自身的失败次数（不影响请求，仅用于观测）
 */
export function createApiMetricsMiddleware(opts = {}) {
  const { registry } = opts;
  if (!registry || typeof registry.record !== 'function') {
    throw new TypeError('createApiMetricsMiddleware: opts.registry.record 必须是函数');
  }
  const isEnabled = typeof opts.enabled === 'function' ? opts.enabled : defaultEnabled;
  const normalize = typeof opts.normalize === 'function' ? opts.normalize : identityNormalize;
  const shouldSkip = typeof opts.shouldSkip === 'function' ? opts.shouldSkip : null;

  /** 埋点自身失败计数：吞掉异常，但要让上层能看出「有东西在坏」 */
  function drop() {
    apiMetricsMiddleware.dropped += 1;
  }

  /**
   * 中间件主体。严禁抛异常、严禁改 req/res 已有字段（只用闭包变量存起始时间）。
   */
  function apiMetricsMiddleware(req, res, next) {
    let startNs;
    try {
      if (!isEnabled()) return next();
      startNs = process.hrtime.bigint();
    } catch {
      drop();
      return next();
    }

    const onFinish = () => {
      try {
        const fullPath = typeof req.path === 'string' ? req.path : '';
        if (shouldSkip && shouldSkip(fullPath)) return;

        const routePath = req.route && req.route.path;
        const first = Array.isArray(routePath) ? routePath[0] : routePath;
        const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
        // 只取请求行里的 path 部分：req.path 天然不含 query，header / body 一概不碰
        //
        // 通配路由（SPA 兜底的 `app.get('*')`）不能记成 `*`：那会把所有落到前端兜底的
        // 请求合并成一条「GET *」，既看不出是哪个接口，也会掩盖真实的 404。
        // 这类情况回退到归一化后的真实路径。
        const isWildcard = typeof first === 'string' && first.includes('*');
        const route = typeof first === 'string' && first && !isWildcard
          ? joinRoute(base, first, fullPath)
          : normalize(fullPath);

        const method = String(req.method || 'GET').toUpperCase();
        const statusCode = Number.isFinite(res.statusCode) ? res.statusCode : 0;
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        const durationMs = Math.max(0, Math.round(elapsedMs * 10) / 10); // 毫秒，保留 1 位小数

        registry.record(route || '/', method, statusCode, durationMs);
      } catch {
        drop(); // 埋点自己坏了，绝不许影响正在返回的请求
      }
    };

    try {
      res.on('finish', onFinish);
    } catch {
      drop();
    }
    return next();
  }

  apiMetricsMiddleware.dropped = 0;
  return apiMetricsMiddleware;
}