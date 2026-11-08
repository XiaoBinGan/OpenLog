/**
 * server/docker-topology.js —— 容器上下游链路推断（基于真实证据）
 *
 * ## 为什么要重写
 *
 * 原实现（`docker.js` 里的 `inferUpstreamDownstream`）在真机上**永远返回空**，
 * 因为它的三个判断依据全都取不到数据：
 *
 *   1. `c.Networks` —— Docker `/containers/json` 返回的字段叫
 *      `NetworkSettings.Networks`，`c.Networks` 恒为 undefined → 网络推断整段失效。
 *   2. `c.labels.env` —— Docker 从不把环境变量写进 labels，恒为空 → env 匹配失效。
 *   3. `labels['depends-on']` —— compose v2 用 `com.docker.compose.depends_on`
 *      且默认不写，实际几乎不存在。
 *
 * 实测：生产 86 个容器、8 个抽样全部「上游 0 / 下游 0 / 同网 0」。
 *
 * ## 现在依据什么推
 *
 * 只认**能在容器配置里看到的事实**，且每条边都带 evidence（证据）与 confidence：
 *
 *   高｜`compose_depends_on`  容器 label 明确声明依赖
 *   高｜`env_alias`           env 里的主机名等于对方的容器名 / compose 服务名 / 网络别名
 *   中｜`env_published_port`  env 指向 127.0.0.1:P，且**只有一台**容器发布了 P
 *   中｜`env_container_ip`    env 指向对方的容器 IP
 *
 * 同网但无调用证据 → 只进 `networkPeers`（同网），**不算上下游**。
 * 这条区分很重要：同一 bridge 网络里的容器互相可达是网络的属性，不是调用关系。
 *
 * ## 方向约定（与界面一致）
 *
 * A 的 env/label 引用 B（A 调用 B）：
 *   - A 是 B 的**上游**（调用方）
 *   - B 是 A 的**下游**（被调用方）
 */

/** 分析时忽略的「主机名」：本地回环、通配地址、以及明显不是服务名的基础设施地址 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]', '::', 'host.docker.internal']);

/** env 值里出现的这些主机名不值得当证据（太泛，容易误连） */
const GENERIC_HOSTS = new Set(['example.com', 'www.google.com', 'crates.io', 'github.com', 'registry.npmjs.org']);

/** 从 URL / DSN 里抠出 host 与 port；失败返回 null */
export function parseEndpoint(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  // 带 scheme 的 DSN：postgres://u:p@host:5432/db、redis://host:6379/0、http://host:8080/x
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@\s]*@)?(\[[^\]]+\]|[^/:?#\s]+)(?::(\d+))?/i.exec(s);
  if (m) {
    return { scheme: m[1].toLowerCase(), host: m[2], port: m[3] ? Number(m[3]) : null };
  }
  // 裸 host:port
  const hp = /^(\[[^\]]+\]|[a-z0-9][a-z0-9._-]*):(\d{1,5})$/i.exec(s);
  if (hp) return { scheme: null, host: hp[1], port: Number(hp[2]) };
  return null;
}

/** Docker 名称 / compose service 的常见规范化：去前缀斜杠、转小写 */
export function normalizeName(value) {
  return String(value ?? '').trim().replace(/^\//, '').toLowerCase();
}

/**
 * 一台容器的「身份 token」：别人可能用哪个名字来引用它。
 * 顺序有意义 —— 越具体越靠前，命中越可信。
 */
export function identityTokens(node) {
  const tokens = new Set();
  for (const n of node.names || []) if (n) tokens.add(normalizeName(n));
  if (node.name) tokens.add(normalizeName(node.name));
  if (node.composeService) tokens.add(normalizeName(node.composeService));
  if (node.composeProject && node.composeService) {
    tokens.add(normalizeName(`${node.composeProject}-${node.composeService}-1`));
    tokens.add(normalizeName(`${node.composeProject}_${node.composeService}_1`));
  }
  for (const alias of node.aliases || []) if (alias) tokens.add(normalizeName(alias));
  if (node.shortId) tokens.add(normalizeName(node.shortId));
  // 单字符/纯数字 token 不要：会误命中 env 里的普通值
  return [...tokens].filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

/**
 * 从 inspect 结果抽出一个「可分析节点」。
 *
 * 只取判断链路需要的东西：名字、别名、网络、env、发布端口、容器 IP、compose label。
 * 密码类 env 不进内存（我们只需要它的 host/port 部分，且 parseEndpoint 之后原值就丢了）。
 */
export function buildNode(container, inspect) {
  const cfg = inspect?.Config || {};
  const labels = cfg.Labels || container?.labels || {};
  const env = Array.isArray(cfg.Env) ? cfg.Env : [];
  const netSettings = inspect?.NetworkSettings?.Networks || {};
  // 真字段是 NetworkSettings.Networks；container.Networks 是常见误写，兼容一下
  const netsSrc = Object.keys(netSettings).length ? netSettings : (inspect?.Networks || {});
  const aliases = [];
  const networks = [];
  for (const [netName, net] of Object.entries(netsSrc)) {
    networks.push(netName);
    for (const a of net?.Aliases || []) aliases.push(a);
  }
  const names = (container?.names || (inspect?.Name ? [String(inspect.Name).replace(/^\//, '')] : [])).map(normalizeName);

  const publishedPorts = [];
  const portMap = inspect?.NetworkSettings?.Ports;
  if (portMap && typeof portMap === 'object') {
    for (const [priv, bindings] of Object.entries(portMap)) {
      const privPort = Number(String(priv).split('/')[0]);
      for (const b of bindings || []) {
        if (b?.HostPort) publishedPorts.push({ hostIp: b.HostIp || '0.0.0.0', hostPort: Number(b.HostPort), containerPort: privPort });
      }
    }
  } else {
    for (const p of container?.ports || []) {
      if (p?.publicPort) publishedPorts.push({ hostIp: p.ip || '0.0.0.0', hostPort: Number(p.publicPort), containerPort: Number(p.privatePort) });
    }
  }

  const containerIps = [];
  for (const net of Object.values(netsSrc)) {
    if (net?.IPAddress) containerIps.push(String(net.IPAddress));
  }

  // 老式 --link / compose links：[{"/db:/app/db": "db"}] 或 ["/db:/app/db"]，都是明确的依赖声明
  const links = [];
  const rawLinks = inspect?.HostConfig?.Links;
  if (Array.isArray(rawLinks)) {
    for (const l of rawLinks) {
      if (typeof l === 'string') links.push(l);
      else if (l && typeof l === 'object') links.push(...Object.keys(l));
    }
  }

  return {
    id: container?.id || inspect?.Id,
    shortId: String(container?.id || inspect?.Id || '').slice(0, 12),
    // 容器状态：停掉的容器没法 exec，读连接表时要跳过（否则每台都记一次失败）
    state: String(container?.state || inspect?.State?.Status || ''),
    names,
    aliases,
    networks,
    env,
    labels,
    publishedPorts,
    containerIps,
    links,
    composeProject: labels['com.docker.compose.project'] || '',
    composeService: labels['com.docker.compose.service'] || '',
    composeDependsOn: labels['com.docker.compose.depends_on'] || labels['depends-on'] || '',
    networkMode: inspect?.HostConfig?.NetworkMode || '',
    image: cfg.Image || container?.image || '',
  };
}

/** 把 env 拆成 [{key, value}]；只要第一种 '=' 之前 */
export function envPairs(env) {
  const out = [];
  for (const line of Array.isArray(env) ? env : []) {
    const i = String(line).indexOf('=');
    if (i <= 0) continue;
    out.push({ key: String(line).slice(0, i), value: String(line).slice(i + 1) });
  }
  return out;
}

/**
 * 建全局索引：token → 节点 id 集合，发布端口 → 节点 id 集合。
 * 用于把 env 里的引用快速解析到具体容器。
 */
export function buildIndex(nodes) {
  const byToken = new Map();
  for (const node of nodes) {
    for (const t of identityTokens(node)) {
      if (!byToken.has(t)) byToken.set(t, new Set());
      byToken.get(t).add(node.id);
    }
  }
  const byHostPort = new Map();
  for (const node of nodes) {
    for (const p of node.publishedPorts || []) {
      if (!byHostPort.has(p.hostPort)) byHostPort.set(p.hostPort, new Set());
      byHostPort.get(p.hostPort).add(node.id);
    }
  }
  const byIp = new Map();
  for (const node of nodes) {
    for (const ip of node.containerIps || []) {
      if (!byIp.has(ip)) byIp.set(ip, new Set());
      byIp.get(ip).add(node.id);
    }
  }
  return { byToken, byHostPort, byIp };
}

/**
 * 分析一台容器调用了谁（出边：我 → 我依赖的）。
 *
 * @returns {Map<string, {evidence: Array<{kind:string, confidence:'high'|'medium', detail:string, value:string}>}>}
 *          目标容器 id → 证据列表（同一对容器可能有多条证据，取最强的展示）
 */
export function outgoingReferences(node, nodes, index) {
  const out = new Map();
  const add = (targetId, evidence) => {
    if (!targetId || targetId === node.id) return;
    if (!out.has(targetId)) out.set(targetId, { evidence: [] });
    const bucket = out.get(targetId).evidence;
    // 同 kind 同 value 的去重，避免一条 env 重复计入
    if (!bucket.some((e) => e.kind === evidence.kind && e.value === evidence.value)) bucket.push(evidence);
  };

  // ① compose 显式依赖：最强证据
  for (const dep of String(node.composeDependsOn || '').split(',')) {
    const t = normalizeName(dep.trim());
    if (!t) continue;
    for (const id of index.byToken.get(t) || []) {
      add(id, { kind: 'compose_depends_on', confidence: 'high', detail: `compose 声明 depends_on: ${dep.trim()}`, value: dep.trim() });
    }
  }

  // ①b 老式 --link："<目标容器>:<别名>" 也是明确声明
  for (const link of node.links || []) {
    const target = normalizeName(String(link).split(':')[0]);
    if (!target) continue;
    for (const id of index.byToken.get(target) || []) {
      add(id, { kind: 'docker_link', confidence: 'high', detail: `--link 声明依赖 ${link}`, value: link });
    }
  }

  // ② env 引用：把每个值当 URL / host:port 解析，再按 token / 端口 / IP 解析到容器
  for (const { key, value } of envPairs(node.env)) {
    if (!value) continue;
    const ep = parseEndpoint(value);
    if (!ep) continue;
    const host = normalizeName(ep.host);
    if (!host) continue;

    // 2a. 主机名直接等于对方的身份 token —— 最可靠
    let matched = false;
    for (const id of index.byToken.get(host) || []) {
      add(id, { kind: 'env_alias', confidence: 'high', detail: `${key} 指向主机名 ${host}`, value: host });
      matched = true;
    }
    if (matched) continue;
    // 别名去掉常见后缀再试一次（db.internal → db）
    const trimmed = host.split('.')[0];
    if (trimmed && trimmed !== host && !LOOPBACK_HOSTS.has(trimmed)) {
      for (const id of index.byToken.get(trimmed) || []) {
        add(id, { kind: 'env_alias', confidence: 'high', detail: `${key} 指向主机名 ${ep.host}（按 ${trimmed} 匹配）`, value: ep.host });
        matched = true;
      }
    }
    if (matched || GENERIC_HOSTS.has(host)) continue;

    // 2b. 回环地址 + 端口：本机发布的端口对应唯一一台容器时才算证据
    if (LOOPBACK_HOSTS.has(host) && ep.port) {
      const ids = index.byHostPort.get(ep.port);
      if (ids && ids.size === 1) {
        const [id] = ids;
        add(id, { kind: 'env_published_port', confidence: 'medium', detail: `${key} 指向 127.0.0.1:${ep.port}，该端口由它发布`, value: `${host}:${ep.port}` });
      }
      continue;
    }

    // 2c. 直接指向容器 IP
    const ids = index.byIp.get(ep.host);
    if (ids) {
      for (const id of ids) add(id, { kind: 'env_container_ip', confidence: 'medium', detail: `${key} 指向容器 IP ${ep.host}`, value: ep.host });
    }
  }

  return out;
}

/** 证据强度排序：high 在前；同级按 kind 固定顺序，保证输出稳定 */
const KIND_ORDER = ['live_tcp', 'compose_depends_on', 'docker_link', 'env_alias', 'env_published_port', 'env_container_ip'];
export function bestEvidence(evidenceList) {
  const rank = (e) => (e.confidence === 'high' ? 0 : 1) * 10 + KIND_ORDER.indexOf(e.kind);
  return [...evidenceList].sort((a, b) => rank(a) - rank(b));
}

/**
 * 全量分析：返回每台容器的上游/下游/同网。
 *
 * @param {Array<object>} nodes  buildNode() 的结果
 * @returns {Map<string, {upstream: Array, downstream: Array, peers: Array}>}
 */
export function analyzeTopology(nodes) {
  const index = buildIndex(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map();
  for (const n of nodes) result.set(n.id, { upstream: [], downstream: [], peers: [] });

  // 出边：A 引用 B → A 是 B 的上游，B 是 A 的下游
  for (const node of nodes) {
    const refs = outgoingReferences(node, nodes, index);
    for (const [targetId, { evidence }] of refs) {
      const sorted = bestEvidence(evidence);
      const confidence = sorted[0].confidence;
      // A 的下游 += B
      result.get(node.id).downstream.push({
        id: targetId, direction: 'downstream', confidence,
        evidence: sorted[0], allEvidence: sorted,
      });
      // B 的上游 += A
      const up = result.get(targetId);
      if (up) {
        up.upstream.push({
          id: node.id, direction: 'upstream', confidence,
          evidence: { ...sorted[0], detail: `${byId.get(node.id)?.names?.[0] || node.shortId} ${sorted[0].detail}` },
          allEvidence: sorted,
        });
      }
    }
  }

  // 同网但无调用关系：只进 peers。
  //
  // 只算**运行中**的容器：生产上 host 网络的「同网」有 14 台，其中 13 台是 exited 的
  // 历史容器。把它们算成「同网」会让用户以为有 14 个活着的邻居，而实际只有 1 个。
  // 已退出的容器单独计数（stoppedPeers），用来解释「这台机器上还躺着一堆旧容器」。
  const netMembers = new Map();
  const isRunning = (n) => String(n.state || '').toLowerCase() === 'running';
  for (const n of nodes) {
    for (const net of n.networks || []) {
      if (!netMembers.has(net)) netMembers.set(net, []);
      netMembers.get(net).push(n.id);
    }
  }
  for (const n of nodes) {
    const bucket = result.get(n.id);
    const seen = new Set([n.id, ...bucket.upstream.map((x) => x.id), ...bucket.downstream.map((x) => x.id)]);
    const peerIds = new Set();
    const stopped = new Set();
    for (const net of n.networks || []) {
      for (const id of netMembers.get(net) || []) {
        if (seen.has(id)) continue;
        const peer = byId.get(id);
        if (peer && isRunning(peer)) peerIds.add(id);
        else stopped.add(id);
      }
    }
    bucket.peers = [...peerIds].map((id) => ({
      id,
      networks: n.networks.filter((net) => (netMembers.get(net) || []).includes(id)),
    }));
    bucket.stoppedPeerCount = stopped.size;
  }

  // 去重 + 稳定排序（按容器名）
  for (const [, bucket] of result) {
    const dedupe = (arr) => {
      const m = new Map();
      for (const x of arr) if (!m.has(x.id)) m.set(x.id, x);
      return [...m.values()].sort((a, b) => String(byId.get(a.id)?.names?.[0] || '').localeCompare(String(byId.get(b.id)?.names?.[0] || '')));
    };
    bucket.upstream = dedupe(bucket.upstream);
    bucket.downstream = dedupe(bucket.downstream);
    bucket.peers.sort((a, b) => String(byId.get(a.id)?.names?.[0] || '').localeCompare(String(byId.get(b.id)?.names?.[0] || '')));
  }
  return result;
}
