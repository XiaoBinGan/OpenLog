/**
 * server/datasource/discover.js —— 从 Docker 容器推断「可监控的数据源 / 接口服务」
 *
 * 背景：用户想在「数据库/接口」面板里切到别的机器看数据，但那些机器上并没有 OpenLog，
 * 自然没有我们的埋点。可行的替代是**从容器本身把连接条件挖出来**：
 *   - postgres / mysql / mariadb / redis / mongo 容器的 env 里通常就有账号密码和库名
 *     （POSTGRES_PASSWORD / MYSQL_ROOT_PASSWORD / MYSQL_DATABASE / MONGODB_URI…）
 *   - 端口映射能告诉我们「从宿主机哪个端口能连到它」
 *   - 有 Web 端口的容器可以反过来探它的 /openapi.json、/swagger.json，拿到接口清单
 *
 * 三条纪律（写进实现，不是口号）：
 *   1. **只推断、不自动连**。挖到密码也只给出「候选」，必须用户确认后才落库并连接。
 *   2. **密码不落日志、不原样回传**。返回值里密码字段一律打码，只在「保存」时单独提交。
 *   3. **不猜方言**。镜像不是已知数据库就老实说不知道，不要拿名字模糊匹配硬套。
 */

/** 已知数据库镜像 → 方言 + 默认端口 + 常见 env 键 */
const DB_IMAGES = [
  {
    dialect: 'postgres',
    match: /(^|\/)(postgres|postgresql|pgvector\/pgvector|timescale\/timescaledb|bitnami\/postgresql)(:|\/|$)/i,
    port: 5432,
    env: {
      user: ['POSTGRES_USER', 'PGUSER', 'POSTGRES_USERNAME'],
      password: ['POSTGRES_PASSWORD', 'PGPASSWORD'],
      database: ['POSTGRES_DB', 'PGDATABASE'],
    },
    url: ['DATABASE_URL', 'POSTGRES_URL', 'PG_URL'],
  },
  {
    dialect: 'mysql',
    match: /(^|\/)(mysql|mariadb|percona|bitnami\/mysql)(:|\/|$)/i,
    port: 3306,
    env: {
      user: ['MYSQL_USER', 'MYSQL_ROOT_USER', 'MARIADB_USER'],
      password: ['MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'MARIADB_ROOT_PASSWORD', 'MARIADB_PASSWORD'],
      database: ['MYSQL_DATABASE', 'MARIADB_DATABASE'],
    },
    url: ['MYSQL_URL', 'DATABASE_URL'],
  },
  {
    dialect: 'mysql',
    match: /(^|\/)(tidb|percona-server)(:|\/|$)/i,
    port: 4000,
    env: { user: ['MYSQL_USER'], password: ['MYSQL_PASSWORD'], database: ['MYSQL_DATABASE'] },
    url: ['DATABASE_URL'],
  },
  {
    dialect: 'redis',
    match: /(^|\/)(redis|valkey|keydb)(:|\/|$)/i,
    port: 6379,
    env: { user: [], password: ['REDIS_PASSWORD', 'REDIS_ROOT_PASSWORD'], database: [] },
    url: ['REDIS_URL'],
  },
  {
    dialect: 'mongo',
    match: /(^|\/)(mongo|mongodb)(:|\/|$)/i,
    port: 27017,
    env: { user: ['MONGO_INITDB_ROOT_USERNAME'], password: ['MONGO_INITDB_ROOT_PASSWORD'], database: ['MONGO_INITDB_DATABASE'] },
    url: ['MONGO_URL', 'MONGODB_URI'],
  },
];

/** 只有在「这套方言真的能采样」时才值得推荐；redis/mongo 目前只做连通性探测 */
const SAMPLABLE = new Set(['postgres', 'mysql']);

/** 打码：只留首尾各 1~2 个字符，中间固定用 `***`，连长度都不透露（长度也是信息） */
export function maskSecret(value) {
  const s = typeof value === 'string' ? value : '';
  if (!s) return '';
  if (s.length <= 4) return '****';
  if (s.length <= 8) return `${s.slice(0, 1)}***${s.slice(-1)}`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** 从 `k=v` 数组里建 map（Docker inspect 的 Config.Env 就是这种形状） */
export function envMap(env) {
  const out = {};
  for (const line of Array.isArray(env) ? env : []) {
    const i = String(line).indexOf('=');
    if (i <= 0) continue;
    out[String(line).slice(0, i).trim()] = String(line).slice(i + 1);
  }
  return out;
}

/** 解析 `postgres://user:pass@host:port/db` 这类连接串；解析不了返回 null */
export function parseDbUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  // 有些 env 里放的是 docker 内部主机名，带 __ 之类，URL 解析器照样能处理
  let u;
  try { u = new URL(s); } catch { return null; }
  const proto = u.protocol.replace(':', '').toLowerCase();
  const dialect = proto.startsWith('postgres') ? 'postgres'
    : proto.startsWith('mysql') ? 'mysql'
      : proto.startsWith('mongo') ? 'mongo'
        : proto.startsWith('redis') ? 'redis' : null;
  if (!dialect) return null;
  return {
    dialect,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    host: u.hostname || '',
    port: u.port ? Number(u.port) : null,
    database: u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '',
  };
}

/** 从端口映射里找「宿主机端口 → 容器端口」；没发布端口返回 null（只在内网可达） */
export function publishedPort(ports, containerPort) {
  for (const p of Array.isArray(ports) ? ports : []) {
    const priv = Number(p?.PrivatePort ?? p?.privatePort ?? NaN);
    const pub = Number(p?.PublicPort ?? p?.publicPort ?? NaN);
    if (Number.isFinite(priv) && Number.isFinite(pub) && priv === Number(containerPort)) return pub;
  }
  return null;
}

/** 容器里有没有 Web 端口（排除已知数据库端口），用于反向探 swagger */
export function guessWebPort(ports) {
  const DB_PORTS = new Set([5432, 3306, 6379, 27017, 4000, 1521, 1433, 9200, 5672, 9092]);
  for (const p of Array.isArray(ports) ? ports : []) {
    const priv = Number(p?.PrivatePort ?? p?.privatePort ?? NaN);
    const pub = Number(p?.PublicPort ?? p?.publicPort ?? NaN);
    if (!Number.isFinite(priv) || !Number.isFinite(pub)) continue;
    if (DB_PORTS.has(priv)) continue;
    if (priv >= 1024 || priv === 80 || priv === 8080 || priv === 3000 || priv === 8000) return { containerPort: priv, hostPort: pub };
  }
  return null;
}

/**
 * 从一个已 inspect 的容器推断数据库候选。
 *
 * @param {object} args
 * @param {object} args.container Docker list 的一行（需要一个稳定的 id/name）
 * @param {object} [args.inspect] `docker inspect` 的完整对象（有 Config.Env）
 * @param {string} [args.hostHint] 宿主机地址（真域名/IP），用于拼「从哪里连」
 * @param {string} [args.collection] 来源集合名（本机 / 某个 Docker 源），便于界面分组
 * @returns {Array<object>} 0~N 个候选（一个容器可能既有 URL 又有零散 env，但只出一条）
 */
export function discoverDbCandidate({ container, inspect, hostHint = '', collection = 'local' }) {
  const image = String(inspect?.Config?.Image || container?.image || container?.Image || '');
  const spec = DB_IMAGES.find((d) => d.match.test(image));
  if (!spec) return [];

  const env = envMap(inspect?.Config?.Env);
  // 优先级：完整 URL > 零散 env（URL 里通常账号库名都齐）
  let fromUrl = null;
  for (const key of spec.url) {
    const parsed = parseDbUrl(env[key]);
    if (parsed && parsed.dialect === spec.dialect) { fromUrl = parsed; break; }
  }

  const pick = (keys) => {
    for (const k of keys) if (env[k]) return env[k];
    return '';
  };

  const user = fromUrl?.user || pick(spec.env.user);
  const password = fromUrl?.password || pick(spec.env.password);
  const database = fromUrl?.database || pick(spec.env.database);
  const containerPort = fromUrl?.port || Number(spec.port);
  const ports = inspect?.NetworkSettings?.Ports
    ? Object.entries(inspect.NetworkSettings.Ports).flatMap(([priv, bindings]) => {
      const privPort = Number(String(priv).split('/')[0]);
      return (bindings || []).map((b) => ({ PrivatePort: privPort, PublicPort: Number(b.HostPort), IP: b.HostIp }));
    })
    : (container?.ports || []).map((p) => ({ PrivatePort: Number(p.privatePort), PublicPort: Number(p.publicPort), IP: p.ip }));
  const hostPort = publishedPort(ports, containerPort);
  // 本机容器常常不发布端口也能连（host 网络 / 同 docker 网桥），
  // 没有 hostHint 时退到「从端口绑定推断的本机地址」
  const effectiveHint = hostHint || hostFromPorts(ports);

  const name = String(inspect?.Name || (Array.isArray(container?.names) ? container.names[0] : '') || container?.names || '').replace(/^\//, '');
  // 从哪连：宿主机可达才填 host；否则留空并标明「仅容器网络可达」
  const netMode = String(inspect?.HostConfig?.NetworkMode || '');
  const isHostNet = netMode === 'host';
  const reachable = Boolean(effectiveHint) && (Boolean(hostPort) || isHostNet);

  return [{
    kind: 'db',
    id: `db:${collection}:${String(container?.id || name).slice(0, 12)}`,
    collection,
    dialect: spec.dialect,
    samplable: SAMPLABLE.has(spec.dialect),
    containerName: name,
    image,
    host: reachable ? effectiveHint : '',
    port: isHostNet ? containerPort : (hostPort || containerPort),
    user: user || '',
    // 密码只给打码版：界面要能让人确认「挖到的是哪一串」，但不能直接拿去登录
    passwordMasked: maskSecret(password),
    hasPassword: Boolean(password),
    database: database || '',
    fromUrl: Boolean(fromUrl),
    reachable,
    reason: reachable ? '' : '容器端口未发布到宿主机，OpenLog 连不进去（需要 --publish 或改用 host 网络）',
  }];
}

/**
 * 从一个容器推断「可能提供 HTTP 接口文档」的服务候选。
 * 只给候选，真正的 swagger 探测由 api-probe.js 做（它需要发网络请求）。
 */
export function discoverServiceCandidate({ container, inspect, hostHint = '', collection = 'local' }) {
  const image = String(inspect?.Config?.Image || container?.image || '');
  if (DB_IMAGES.some((d) => d.match.test(image))) return [];
  const ports = inspect?.NetworkSettings?.Ports
    ? Object.entries(inspect.NetworkSettings.Ports).flatMap(([priv, bindings]) => {
      const privPort = Number(String(priv).split('/')[0]);
      return (bindings || []).map((b) => ({ PrivatePort: privPort, PublicPort: Number(b.HostPort), IP: b.HostIp }));
    })
    : (container?.ports || []).map((p) => ({ PrivatePort: Number(p.privatePort), PublicPort: Number(p.publicPort), IP: p.ip }));
  const web = guessWebPort(ports);
  const name = String(inspect?.Name || (Array.isArray(container?.names) ? container.names[0] : '') || '').replace(/^\//, '');
  // hostHint 为空时用容器的发布 IP（0.0.0.0 要换成 127.0.0.1），否则给了也连不上
  const host = hostHint || hostFromPorts(ports);
  if (!web || !host) return [];
  return [{
    kind: 'service',
    id: `svc:${collection}:${String(container?.id || name).slice(0, 12)}`,
    collection,
    containerName: name,
    image,
    baseUrl: `http://${host}:${web.hostPort}`,
    containerPort: web.containerPort,
  }];
}

/** 从端口绑定里推断「宿主机自己的地址」：0.0.0.0/:: → 127.0.0.1 */
function hostFromPorts(ports) {
  for (const p of Array.isArray(ports) ? ports : []) {
    const ip = String(p?.IP ?? p?.ip ?? '').trim();
    if (ip === '0.0.0.0' || ip === '::' || ip === '[::]' || ip === '') return '127.0.0.1';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  }
  return '';
}

/** 给界面用的「去向」提示：告诉用户下一步该做什么，而不是只丢一堆字段 */
export function candidateHint(c) {
  if (c.kind === 'service') return '可以探测它的 /openapi.json 等文档地址，拿到接口清单与可用性';
  if (!c.samplable) return `${c.dialect} 目前只支持连通性探测，不采集慢查询/表体积`;
  if (!c.reachable) return c.reason || '连不进去';
  if (!c.hasPassword) return '未发现密码（可能是 trust 认证或密码在外部 secret 里），保存后可试连';
  return '端口已发布、凭据齐全，保存后即可采集';
}
