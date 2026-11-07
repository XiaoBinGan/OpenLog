/**
 * server/routes/datasource.js —— 数据源登记 / 自动发现 / 试连 / 探测
 *
 * 这条路由解决的就是「切机器看数据」：因为远程主机上没有 OpenLog 进程，
 * 接口流量指标拿不到；能做的是
 *   ① 把远程的**数据库连接**登记进来 → 切到它就能看池/表体积/慢查询
 *   ② 从 Docker 容器里**自动挖出**连接条件（env + 端口映射）
 *   ③ 对 HTTP 服务**探 swagger/openapi** → 拿接口清单与存活
 *
 * 全部只读、全部要用户确认。挖到密码不回传明文（只回打码），保存时才单独提交。
 */
import express from 'express';
import { discoverDbCandidate, discoverServiceCandidate, candidateHint } from '../datasource/discover.js';
import { probeExternalDb } from '../datasource/db-probe.js';
import { probeApiDocs, SPEC_PATHS } from '../datasource/api-probe.js';

const errText = (e) => String(e?.message || e);

/**
 * @param {object} deps
 * @param {object} deps.store            createDatasourceStore 实例
 * @param {Function} deps.listContainers (sourceId, config) => Promise<容器[]>
 * @param {Function} deps.inspectContainer (sourceId, id, config) => Promise<inspect|null>
 * @param {Function} [deps.getDockerConfig] () => 传给上面两个函数的 config（Docker 源配置）
 * @param {Function} [deps.hostHintFor]  (sourceId) => 宿主机地址
 * @param {Function} [deps.probeDb]      注入探测实现（测试用）
 * @param {Function} [deps.probeDocs]    注入文档探测实现（测试用）
 * @param {Function} [deps.fetchImpl]    注入 fetch（测试用）
 * @param {Function} [deps.enabled]
 */
export function createDatasourceRouter(deps = {}) {
  const router = express.Router();
  const store = deps.store;
  const isOn = () => { try { return deps.enabled ? Boolean(deps.enabled()) : true; } catch { return false; } };
  const cfg = () => { try { return deps.getDockerConfig ? deps.getDockerConfig() : {}; } catch { return {}; } };

  if (!store) {
    // 依赖缺失时全部端点返回可用性标记，而不是 500（面板要能显示「未接入」）
    router.use((req, res) => res.status(200).json({ available: false, reason: 'datasource store 未接入' }));
    return router;
  }

  /** 1. 已登记的数据源列表（密码只回打码） */
  router.get('/api/monitor/datasources', async (req, res) => {
    const items = await store.list();
    return res.json({ available: true, items });
  });

  /**
   * 2. 自动发现：扫本机 + 所有 Docker 源里的容器，挖出数据库连接条件与服务候选。
   *
   * 注意：这里只读容器元信息（env / 端口），**不连任何东西**。
   * 用户看到候选后自己勾选保存，才会真的去建连接。
   */
  router.get('/api/monitor/datasources/discover', async (req, res) => {
    if (!isOn()) return res.json({ enabled: false });
    const sources = [{ id: 'local', label: '本机', hostHint: req.query.hostHint || '' }];
    let remoteSources = [];
    try {
      // dockerSources 是「取当前配置的函数」（配置会热更新），不是数组
      if (typeof deps.dockerSources === 'function') remoteSources = deps.dockerSources();
      else if (Array.isArray(deps.dockerSources)) remoteSources = deps.dockerSources;
    } catch { /* 拿不到就只扫本机 */ }
    for (const s of Array.isArray(remoteSources) ? remoteSources : []) {
      sources.push({ id: s.id, label: s.label || s.id, hostHint: deps.hostHintFor ? deps.hostHintFor(s.id) : '' });
    }

    const dbCandidates = [];
    const serviceCandidates = [];
    const errors = [];

    for (const src of sources) {
      let containers = [];
      // 每个源要用**它自己的**传输配置（socket / TCP / SSH 隧道），
      // 统一传空对象会让本机 Socket 也去连 2375 然后 ECONNREFUSED。
      let srcConfig = {};
      try {
        // getDockerConfig 可能是 async（内部要 resolve SSH 隧道），统一 await
        srcConfig = (await (deps.getDockerConfig ? deps.getDockerConfig(src.id) : {})) || {};
      } catch (err) {
        errors.push(`[${src.label}] Docker 配置无效: ${errText(err)}`);
        continue;
      }
      try {
        containers = await deps.listContainers(src.id, srcConfig);
      } catch (err) {
        errors.push(`[${src.label}] 容器列表失败: ${errText(err)}`);
        continue;
      }
      if (!Array.isArray(containers)) {
        if (containers?.error) errors.push(`[${src.label}] ${containers.error}`);
        continue;
      }
      for (const c of containers) {
        // 只 inspect 运行中的（停了的容器 env 也可能有用，但端口信息不可信）
        if (String(c.state || '').toLowerCase() !== 'running') continue;
        let inspect = null;
        try { inspect = await deps.inspectContainer(src.id, c.id, srcConfig); } catch { /* 单个容器拿不到就算了 */ }
        // 宿主机地址：优先显式配置，其次用容器源自身的 host
        const hint = src.hostHint || String(c?.labels?.host || '');
        try {
          dbCandidates.push(...discoverDbCandidate({ container: c, inspect, hostHint: hint, collection: src.id }));
          serviceCandidates.push(...discoverServiceCandidate({ container: c, inspect, hostHint: hint, collection: src.id }));
        } catch (err) {
          errors.push(`[${src.label}] ${c.shortId || c.id} 推断失败: ${errText(err)}`);
        }
      }
    }

    return res.json({
      available: true,
      scannedSources: sources.length,
      dbCandidates: dbCandidates.map((c) => ({ ...c, hint: candidateHint(c) })),
      serviceCandidates: serviceCandidates.map((c) => ({ ...c, hint: candidateHint(c) })),
      errors,
    });
  });

  /** 3. 保存 / 更新一个数据源（密码字段单独提交；不传表示不改） */
  router.put('/api/monitor/datasources/:id', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const out = await store.upsert({ ...body, id: req.params.id });
    if (!out.ok) return res.status(200).json({ ok: false, error: out.error });
    return res.json({ ok: true, item: await store.get(req.params.id) });
  });

  /** 4. 删除 */
  router.delete('/api/monitor/datasources/:id', async (req, res) => {
    const ok = await store.remove(req.params.id);
    return res.json({ ok, deleted: ok ? req.params.id : null });
  });

  /**
   * 5. 试连 / 采样一个已登记的数据源。
   *
   * 数据库：真连一次，采版本/大小/连接数/表体积；
   * 服务：真探一次文档地址。
   * 两种结果都会写回 last_status，界面能显示「上次什么时候试过、结果如何」。
   */
  router.post('/api/monitor/datasources/:id/probe', async (req, res) => {
    const secret = await store.getSecret(req.params.id);
    if (!secret) return res.json({ ok: false, error: '数据源不存在' });

    try {
      let result;
      if (secret.kind === 'service') {
        const probeDocs = deps.probeDocs || probeApiDocs;
        result = await probeDocs({ baseUrl: secret.baseUrl, fetchImpl: deps.fetchImpl });
        await store.recordProbe(secret.id, { ok: result.ok, ms: result.ms, error: result.ok ? null : result.error });
        return res.json({ ok: result.ok, kind: 'service', ...result });
      }
      const probeDb = deps.probeDb || probeExternalDb;
      result = await probeDb({
        dialect: secret.dialect, host: secret.host, port: secret.port,
        user: secret.user, password: secret.password, database: secret.database,
      });
      await store.recordProbe(secret.id, { ok: result.ok, ms: result.ms, error: result.ok ? null : result.error });
      return res.json({ ok: result.ok, kind: 'db', ...result });
    } catch (err) {
      await store.recordProbe(req.params.id, { ok: false, ms: null, error: errText(err) });
      return res.json({ ok: false, error: errText(err) });
    }
  });

  /**
   * 6. 试连「还没保存」的临时参数（界面上填完先点测试，不想先落库）
   * 密码从 body 直接拿，不落库、不打日志。
   */
  router.post('/api/monitor/datasources/test', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      if (b.kind === 'service' || b.baseUrl) {
        const probeDocs = deps.probeDocs || probeApiDocs;
        const r = await probeDocs({ baseUrl: String(b.baseUrl || ''), fetchImpl: deps.fetchImpl });
        return res.json({ ok: r.ok, kind: 'service', ...r });
      }
      const probeDb = deps.probeDb || probeExternalDb;
      const r = await probeDb({
        dialect: b.dialect, host: String(b.host || ''), port: Number(b.port) || null,
        user: String(b.user || ''), password: String(b.password || ''), database: String(b.database || ''),
      });
      return res.json({ ok: r.ok, kind: 'db', ...r });
    } catch (err) {
      return res.json({ ok: false, error: errText(err) });
    }
  });

  /** 7. 探测候选服务的文档地址（从 discover 拿到 baseUrl 后调这个） */
  router.post('/api/monitor/datasources/probe-docs', async (req, res) => {
    const baseUrl = String(req.body?.baseUrl || '');
    const probeDocs = deps.probeDocs || probeApiDocs;
    try {
      const r = await probeDocs({ baseUrl, fetchImpl: deps.fetchImpl, paths: Array.isArray(req.body?.paths) ? req.body.paths : SPEC_PATHS });
      return res.json(r);
    } catch (err) {
      return res.json({ ok: false, error: errText(err) });
    }
  });

  return router;
}

export default createDatasourceRouter;
