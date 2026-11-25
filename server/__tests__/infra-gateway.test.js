/**
 * server/infra/gateway.js 单测（B1）
 *
 * 覆盖四块：
 * 1. 渲染：单服务 / 多服务多端口 / 上游格式 / 空列表 / 无 expose / 确定性；
 * 2. 反例（真机事故的同源缺陷）：端口冲突、baseConfig 既有块抢端口、端口越界、
 *    服务名大写或下划线（DNS-1123）、重复服务名、大括号不匹配；
 * 3. 增量：unified diff 内容、归一化后无变化不触发写入、steps 是可执行的中文序列；
 * 4. 写入：幂等（same → changed:false，零写入）、PATCH/POST 路径与 reload 注解值、
 *    写失败与注解失败的中文可操作文案、client 缺方法、写开关。
 *
 * 全程假 client：不连接任何集群，也不执行 kubectl / docker / ssh。
 */
import { describe, it, expect, vi } from 'vitest';

import {
  renderGatewayConfig,
  planGatewayUpdate,
  applyGatewayConfig,
  detectPortConflicts,
  lintNginxConf,
  renderUnifiedDiff,
  normalizeConfigForCompare,
  REGION_BEGIN,
  REGION_END,
  SERVICE_MARKER,
  RELOAD_ANNOTATION,
  DEFAULT_CONFIG_KEY,
  BASE_CONFIG_OWNER,
} from '../infra/gateway.js';

const NS = 'inference';
const ENABLED = { OPENLOG_K8S_INFRA: '1' };

// ───────────────────────────── 夹具 ─────────────────────────────

/** 一个最小的 ModelService：网关端口 8007 → 容器端口 8000。 */
function makeService(overrides = {}) {
  return {
    name: 'qwen',
    namespace: NS,
    ports: [{ name: 'http', containerPort: 8000 }],
    expose: { gatewayPort: 8007 },
    ...overrides,
  };
}

/** 手工维护的既有 stream 配置（不是 OpenLog 渲染的，必须原样保留）。 */
function baseConfigWithForeignRoute() {
  return [
    'stream {',
    '    # 运维手工维护，不归 OpenLog 管',
    '    server {',
    '        listen 9100;',
    '        proxy_pass legacy-tool.inference.svc.cluster.local:9100;',
    '    }',
    '}',
  ].join('\n');
}

/** 统计某个子串在文本里出现的次数。 */
function countOf(text, needle) {
  return text.split(needle).length - 1;
}

/** 假 client：可配置 GET 结果、写方法行为，并记录所有调用。 */
function makeClient({ current = null, getError = null, patchImpl = null, postImpl = null } = {}) {
  const calls = { get: [], patch: [], post: [] };
  const client = {
    getJson: vi.fn(async (path) => {
      calls.get.push(path);
      if (getError) throw getError;
      return current;
    }),
    patchJson: vi.fn(async (path, body, options) => {
      calls.patch.push({ path, body, options });
      if (typeof patchImpl === 'function') return patchImpl(path, body, options, calls.patch.length);
      return {};
    }),
    postJson: vi.fn(async (path, body, options) => {
      calls.post.push({ path, body, options });
      if (typeof postImpl === 'function') return postImpl(path, body, options);
      return {};
    }),
  };
  return { client, calls };
}

/** 造一个 404 错误（模拟 ConfigMap 尚不存在）。 */
function notFound() {
  const error = new Error('Kubernetes API 资源不存在（HTTP 404）');
  error.status = 404;
  return error;
}

const FIXED_NOW = Date.parse('2026-01-02T03:04:05.000Z');

// ───────────────────────────── 1. 渲染 ─────────────────────────────

describe('renderGatewayConfig —— 渲染', () => {
  it('单服务：生成 server 块 + 一条路由，且带 BEGIN/END 区间标记', () => {
    const out = renderGatewayConfig({ services: [makeService()] });

    expect(out.routes).toEqual([{ port: 8007, upstream: 'qwen.inference.svc.cluster.local:8000' }]);
    expect(out.conflicts).toEqual([]);
    expect(out.nginxConf).toContain('server {');
    expect(out.nginxConf).toContain('listen 8007;');
    expect(out.nginxConf).toContain('proxy_pass qwen.inference.svc.cluster.local:8000;');
    expect(countOf(out.nginxConf, REGION_BEGIN)).toBe(1);
    expect(countOf(out.nginxConf, REGION_END)).toBe(1);
    // 归属标记：下次渲染靠它认领自己的块
    expect(out.nginxConf).toContain(`${SERVICE_MARKER} ${NS}/qwen`);
  });

  it('多服务多端口：路由按端口升序、块按端口排序，端口数量正确', () => {
    const out = renderGatewayConfig({
      services: [
        makeService({ name: 'gamma', expose: { gatewayPort: 8200 } }),
        makeService({ name: 'alpha', expose: { gatewayPort: 8007 } }),
        makeService({ name: 'beta', expose: { gatewayPort: 8100 } }),
      ],
    });

    expect(out.routes.map((route) => route.port)).toEqual([8007, 8100, 8200]);
    expect(out.routes.map((route) => route.upstream)).toEqual([
      'alpha.inference.svc.cluster.local:8000',
      'beta.inference.svc.cluster.local:8000',
      'gamma.inference.svc.cluster.local:8000',
    ]);
    expect(countOf(out.nginxConf, '\n    listen ')).toBe(3);
    expect(countOf(out.nginxConf, 'server {')).toBe(3);
    expect(out.conflicts).toEqual([]);
  });

  it('同输入两次渲染结果完全一致（确定性）', () => {
    const input = { services: [makeService(), makeService({ name: 'llama', expose: { gatewayPort: 8008 } })] };
    const first = renderGatewayConfig(input);
    const second = renderGatewayConfig(input);
    expect(second).toEqual(first);
    expect(second.nginxConf).toBe(first.nginxConf);
  });

  it('上游地址一律 <name>.<ns>.svc.cluster.local:<后端端口>，后端端口取容器端口', () => {
    const out = renderGatewayConfig({
      services: [makeService({ ports: [{ name: 'http', containerPort: 9000 }] })],
    });

    const route = out.routes[0];
    expect(route.upstream).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+\.svc\.cluster\.local:\d+$/);
    expect(route.upstream).toBe('qwen.inference.svc.cluster.local:9000');
    // listen 的是网关端口，不是容器端口
    expect(out.nginxConf).toContain('listen 8007;');
    expect(out.nginxConf).not.toContain('listen 9000;');
  });

  it('expose.upstreamPort 可覆盖后端端口（网关端口保持不变）', () => {
    const out = renderGatewayConfig({
      services: [makeService({ expose: { gatewayPort: 8007, upstreamPort: 8081 } })],
    });
    expect(out.routes[0]).toEqual({ port: 8007, upstream: 'qwen.inference.svc.cluster.local:8081' });
  });

  it('空服务列表：只有区间与说明注释，不产生任何 server 块', () => {
    const out = renderGatewayConfig({ services: [] });
    expect(out.routes).toEqual([]);
    expect(out.conflicts).toEqual([]);
    expect(out.nginxConf).toContain(REGION_BEGIN);
    expect(out.nginxConf).toContain(REGION_END);
    expect(out.nginxConf).not.toContain('server {');
    expect(out.nginxConf).not.toContain('\n    listen ');
  });

  it('没有 expose 的服务不注册网关（但也不影响其它服务）', () => {
    const out = renderGatewayConfig({
      services: [
        makeService({ name: 'no-gateway', expose: null }),
        makeService({ name: 'has-gateway', expose: { gatewayPort: 8010 } }),
      ],
    });
    expect(out.routes).toEqual([{ port: 8010, upstream: 'has-gateway.inference.svc.cluster.local:8000' }]);
    expect(out.nginxConf).not.toContain('no-gateway');
    expect(out.conflicts).toEqual([]);
  });

  it('expose 存在但没给 gatewayPort：按契约不生成路由', () => {
    const out = renderGatewayConfig({ services: [makeService({ expose: {} })] });
    expect(out.routes).toEqual([]);
    expect(out.nginxConf).not.toContain('\n    listen ');
  });
});

// ───────────────────────── 2. 反例（事故同源） ─────────────────────────

describe('renderGatewayConfig —— 端口冲突与非法输入', () => {
  it('两个服务抢同一端口：进 conflicts，配置里只保留第一个并写明「冲突，已跳过」', () => {
    const out = renderGatewayConfig({
      services: [
        makeService({ name: 'qwen', expose: { gatewayPort: 8007 } }),
        makeService({ name: 'llama', expose: { gatewayPort: 8007 } }),
      ],
    });

    expect(out.conflicts).toEqual([{ port: 8007, owners: ['qwen', 'llama'] }]);
    expect(countOf(out.nginxConf, 'listen 8007;')).toBe(1);
    expect(out.nginxConf).toContain('冲突，已跳过 llama');
    // 被跳过的服务不能出现在 routes 里，否则调用方会以为它已上线
    expect(out.routes).toEqual([{ port: 8007, upstream: 'qwen.inference.svc.cluster.local:8000' }]);
    expect(out.nginxConf).not.toContain('proxy_pass llama');
  });

  it('保留 baseConfig 里不属于 infra 管理的既有 server 块（不整体覆盖别人的路由）', () => {
    const out = renderGatewayConfig({
      services: [makeService()],
      baseConfig: baseConfigWithForeignRoute(),
    });

    expect(out.nginxConf).toContain('listen 9100;');
    expect(out.nginxConf).toContain('proxy_pass legacy-tool.inference.svc.cluster.local:9100;');
    expect(out.nginxConf).toContain('运维手工维护，不归 OpenLog 管');
    expect(out.nginxConf).toContain('listen 8007;');
    expect(out.conflicts).toEqual([]);
    expect(out.routes).toHaveLength(1);
  });

  it('baseConfig 里的旧生成区间被整段替换：不残留旧端口与旧上游', () => {
    const first = renderGatewayConfig({ services: [makeService()] }).nginxConf;
    const second = renderGatewayConfig({
      services: [makeService({ name: 'qwen2', expose: { gatewayPort: 8008 } })],
      baseConfig: first,
    }).nginxConf;

    expect(countOf(second, REGION_BEGIN)).toBe(1);
    expect(countOf(second, REGION_END)).toBe(1);
    expect(second).toContain('listen 8008;');
    expect(second).toContain('proxy_pass qwen2.inference.svc.cluster.local:8000;');
    expect(second).not.toContain('listen 8007;');
    expect(second).not.toContain('qwen.inference.svc.cluster.local');
  });

  it('把渲染结果再喂回 baseConfig：输出逐字节相同（否则每轮都会判定有变化、反复 reload）', () => {
    const first = renderGatewayConfig({ services: [makeService()], baseConfig: baseConfigWithForeignRoute() }).nginxConf;
    const second = renderGatewayConfig({ services: [makeService()], baseConfig: first }).nginxConf;
    const third = renderGatewayConfig({ services: [makeService()], baseConfig: second }).nginxConf;

    expect(second).toBe(first);
    expect(third).toBe(second);
    expect(planGatewayUpdate({ desired: { nginxConf: second }, current: first }).changed).toBe(false);
  });

  it('整份 nginx.conf 作为 baseConfig 时，生成区间落在 stream 块内部且大括号仍配平', () => {
    const fullFile = [
      'worker_processes auto;',
      'events { worker_connections 1024; }',
      'stream {',
      '    server {',
      '        listen 9100;',
      '        proxy_pass legacy.inference.svc.cluster.local:9100;',
      '    }',
      '}',
      '',
    ].join('\n');

    const out = renderGatewayConfig({ services: [makeService()], baseConfig: fullFile });
    expect(out.nginxConf).toContain('worker_processes auto;');
    expect(out.nginxConf).toContain('listen 9100;');
    expect(lintNginxConf(out.nginxConf).ok).toBe(true);
    // 生成区间必须在 stream 的收尾大括号之前（否则 nginx 报 "server directive is not allowed here"）
    expect(out.nginxConf.indexOf(REGION_END)).toBeLessThan(out.nginxConf.lastIndexOf('}'));
  });

  it('baseConfig 既有 server 块占着同一端口：报冲突且不生成重复 listen', () => {
    const out = renderGatewayConfig({
      services: [makeService({ expose: { gatewayPort: 9100 } })],
      baseConfig: baseConfigWithForeignRoute(),
    });

    expect(out.conflicts).toEqual([{ port: 9100, owners: [BASE_CONFIG_OWNER, 'qwen'] }]);
    expect(countOf(out.nginxConf, 'listen 9100;')).toBe(1);
    expect(out.nginxConf).toContain(`已被 ${BASE_CONFIG_OWNER} 里的既有 server 块占用`);
    expect(out.routes).toEqual([]);
  });

  it('端口越界（0 / 70000 / 非整数）直接拒绝渲染', () => {
    for (const gatewayPort of [0, 70000, -1, 8007.5, '8007']) {
      expect(() => renderGatewayConfig({
        services: [makeService({ expose: { gatewayPort } })],
      })).toThrow(/1\.\.65535/);
    }
    // 边界值仍然合法
    const out = renderGatewayConfig({ services: [makeService({ expose: { gatewayPort: 65535 } })] });
    expect(out.routes[0].port).toBe(65535);
  });

  it('服务名含大写或下划线时拒绝（DNS-1123）：否则 nginx 启动即 host not found in upstream', () => {
    for (const name of ['Qwen', 'qwen_7b', '-qwen', 'qwen-', '']) {
      expect(() => renderGatewayConfig({ services: [makeService({ name })] })).toThrow(/DNS-1123/);
    }
    expect(() => renderGatewayConfig({ services: [makeService({ namespace: 'Inference' })] })).toThrow(/DNS-1123/);
  });

  it('同一 ns/name 重复出现时拒绝（会生成两个同端口的块）', () => {
    expect(() => renderGatewayConfig({
      services: [makeService(), makeService()],
    })).toThrow(/重复服务/);
  });

  it('services 不是数组时给中文错误而不是 TypeError', () => {
    expect(() => renderGatewayConfig({ services: { name: 'qwen' } })).toThrow(/services 必须是数组/);
  });

  it('detectPortConflicts 独立可用：无冲突返回空数组，跳过没有 expose 的条目', () => {
    expect(detectPortConflicts([])).toEqual([]);
    expect(detectPortConflicts([
      makeService({ name: 'a', expose: null }),
      makeService({ name: 'b', expose: { gatewayPort: 8007 } }),
      { name: 'c', namespace: NS },
    ])).toEqual([]);
    expect(detectPortConflicts([
      makeService({ name: 'a', expose: { gatewayPort: 8007 } }),
      makeService({ name: 'b', expose: { gatewayPort: 8007 } }),
      makeService({ name: 'c', expose: { gatewayPort: 8008 } }),
      makeService({ name: 'd', expose: { gatewayPort: 8008 } }),
    ])).toEqual([
      { port: 8007, owners: ['a', 'b'] },
      { port: 8008, owners: ['c', 'd'] },
    ]);
  });
});

// ───────────────────────────── 3. 增量计划 ─────────────────────────────

describe('planGatewayUpdate —— 增量与 diff', () => {
  const desired = renderGatewayConfig({ services: [makeService()] });

  it('同配置（含 CRLF 与行尾空格）判定无变化：changed=false、diff 为空', () => {
    const current = desired.nginxConf.replace(/\n/g, '  \r\n');
    const plan = planGatewayUpdate({ desired, current });

    expect(plan.changed).toBe(false);
    expect(plan.diff).toBe('');
    expect(plan.conflicts).toEqual([]);
    expect(plan.steps.join('\n')).toContain('无实质变化');
  });

  it('空现状 → 判定有变化，并给出 unified 头与整段新增行', () => {
    const plan = planGatewayUpdate({ desired, current: '' });
    expect(plan.changed).toBe(true);
    expect(plan.diff.startsWith('--- current/nginx.conf\n+++ desired/nginx.conf\n')).toBe(true);
  });

  it('端口变化体现在 diff 里：旧 listen 行被删、新 listen 行被加', () => {
    const next = renderGatewayConfig({ services: [makeService({ expose: { gatewayPort: 8008 } })] });
    const plan = planGatewayUpdate({ desired: next, current: desired.nginxConf });

    expect(plan.changed).toBe(true);
    expect(plan.diff).toMatch(/^--- current\/nginx\.conf$/m);
    expect(plan.diff).toMatch(/^\+\+\+ desired\/nginx\.conf$/m);
    expect(plan.diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    expect(plan.diff).toContain('-    listen 8007;');
    expect(plan.diff).toContain('+    listen 8008;');
    // 上游没变，因此 proxy_pass 只作为上下文行出现（前缀是一个空格）
    expect(plan.diff).toContain('\n     proxy_pass qwen.inference.svc.cluster.local:8000;');
  });

  it('冲突透传到 plan，并作为第一条 ⚠ 提示排在 steps 最前面', () => {
    const conflicting = renderGatewayConfig({
      services: [
        makeService({ name: 'qwen', expose: { gatewayPort: 8007 } }),
        makeService({ name: 'llama', expose: { gatewayPort: 8007 } }),
      ],
    });
    const plan = planGatewayUpdate({ desired: conflicting, current: '' });

    expect(plan.conflicts).toEqual([{ port: 8007, owners: ['qwen', 'llama'] }]);
    expect(plan.steps[0]).toContain('⚠ 存在 1 处端口冲突');
    expect(plan.steps[0]).toContain('bind() failed (98: Address in use)');
  });

  it('steps 是可执行的中文序列：预检上游 → 备份 → 写 ConfigMap → reload → 回滚', () => {
    const plan = planGatewayUpdate({ desired, current: '' });
    const text = plan.steps.join('\n');

    expect(plan.steps.length).toBeGreaterThanOrEqual(6);
    expect(text).toContain('host not found in upstream');
    expect(text).toContain('备份现状');
    expect(text).toContain('applyGatewayConfig');
    expect(text).toContain(RELOAD_ANNOTATION);
    expect(text).toContain('双写');
    // 编号连续，前端可以直接渲染成有序列表
    plan.steps.forEach((step, index) => {
      if (step.startsWith('⚠')) return;
      expect(step.startsWith(`${index + 1}. `)).toBe(true);
    });
  });

  it('desired 缺失时抛中文错误（提示先调用 renderGatewayConfig）', () => {
    expect(() => planGatewayUpdate({ desired: null, current: '' })).toThrow(/renderGatewayConfig/);
    expect(() => planGatewayUpdate({ desired: { nginxConf: '   ' }, current: '' })).toThrow(/renderGatewayConfig/);
  });

  it('renderUnifiedDiff 对相同文本返回空串，归一化能吃掉尾随空格', () => {
    expect(renderUnifiedDiff('a\nb', 'a\nb')).toBe('');
    expect(normalizeConfigForCompare('a  \r\nb\t\r\n\r\n')).toBe('a\nb');
  });
});

// ───────────────────────────── 4. 写入 ─────────────────────────────

describe('applyGatewayConfig —— 写入与幂等', () => {
  const desired = renderGatewayConfig({ services: [makeService()] });
  const conf = desired.nginxConf;

  it('幂等：ConfigMap 内容相同 → ok:true changed:false，且一次写请求都不发', async () => {
    const { client, calls } = makeClient({ current: { data: { [DEFAULT_CONFIG_KEY]: conf } } });
    const result = await applyGatewayConfig({
      client,
      namespace: 'infra',
      configMapName: 'nginx-gateway',
      nginxConf: conf,
      opts: { env: ENABLED },
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.action).toBe('noop');
    expect(calls.get).toEqual(['/api/v1/namespaces/infra/configmaps/nginx-gateway']);
    expect(client.patchJson).not.toHaveBeenCalled();
    expect(client.postJson).not.toHaveBeenCalled();
  });

  it('归一化后无差异也算幂等（CRLF / 行尾空格不触发 reload）', async () => {
    const { client } = makeClient({ current: { data: { [DEFAULT_CONFIG_KEY]: conf.replace(/\n/g, '\r\n') } } });
    const result = await applyGatewayConfig({
      client, namespace: 'infra', configMapName: 'nginx-gateway', nginxConf: conf, opts: { env: ENABLED },
    });

    expect(result.changed).toBe(false);
    expect(client.patchJson).not.toHaveBeenCalled();
  });

  it('有变化：PATCH ConfigMap（merge-patch）+ 给 Deployment 打 reload 注解', async () => {
    const { client, calls } = makeClient({ current: { data: { [DEFAULT_CONFIG_KEY]: '# old config\n' } } });
    const result = await applyGatewayConfig({
      client,
      namespace: 'infra',
      configMapName: 'nginx-gateway',
      nginxConf: conf,
      opts: { env: ENABLED, deploymentName: 'gateway-nginx', now: () => FIXED_NOW },
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.action).toBe('patched');

    // 第一次 patch：ConfigMap（路径带 fieldManager，body 只带 data 键）
    expect(calls.patch).toHaveLength(2);
    expect(calls.patch[0].path).toBe('/api/v1/namespaces/infra/configmaps/nginx-gateway?fieldManager=openlog-infra');
    expect(calls.patch[0].body).toEqual({ data: { [DEFAULT_CONFIG_KEY]: conf } });
    expect(calls.patch[0].options).toEqual({ contentType: 'application/merge-patch+json' });

    // 第二次 patch：Deployment 注解，值就是注入时钟的 ISO 时间
    expect(calls.patch[1].path).toBe('/apis/apps/v1/namespaces/infra/deployments/gateway-nginx');
    expect(calls.patch[1].body).toEqual({ metadata: { annotations: { [RELOAD_ANNOTATION]: '2026-01-02T03:04:05.000Z' } } });
    expect(calls.patch[1].options).toEqual({ contentType: 'application/merge-patch+json' });
    expect(result.reloadAnnotation).toBe('2026-01-02T03:04:05.000Z');
    expect(result.steps.map((step) => step.name)).toEqual(['读取 ConfigMap', '写入 ConfigMap', '触发 reload']);
  });

  it('ConfigMap 不存在（404）：走 POST 创建，再打 reload 注解', async () => {
    const { client, calls } = makeClient({ getError: notFound() });
    const result = await applyGatewayConfig({
      client,
      namespace: 'infra',
      configMapName: 'nginx-gateway',
      nginxConf: conf,
      opts: { env: ENABLED, deploymentName: 'gateway-nginx', now: () => FIXED_NOW },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('created');
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].path).toBe('/api/v1/namespaces/infra/configmaps?fieldManager=openlog-infra');
    expect(calls.post[0].body).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'nginx-gateway', namespace: 'infra' },
      data: { [DEFAULT_CONFIG_KEY]: conf },
    });
    expect(calls.post[0].options).toEqual({ contentType: 'application/json' });
    expect(calls.patch.map((call) => call.path)).toEqual(['/apis/apps/v1/namespaces/infra/deployments/gateway-nginx']);
  });

  it('opts.skipReload：只写 ConfigMap，不打注解', async () => {
    const { client } = makeClient({ current: { data: {} } });
    const result = await applyGatewayConfig({
      client,
      namespace: 'infra',
      configMapName: 'nginx-gateway',
      nginxConf: conf,
      opts: { env: ENABLED, skipReload: true },
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.reloadAnnotation).toBeNull();
    expect(client.patchJson).toHaveBeenCalledTimes(1);
  });

  it('ConfigMap 写入失败：中文可操作文案，并说明线上仍运行旧配置', async () => {
    const failure = new Error('Kubernetes API 请求失败（HTTP 500）');
    failure.status = 500;
    failure.body = JSON.stringify({ message: 'etcdserver: request timed out' });
    const { client } = makeClient({
      current: { data: { [DEFAULT_CONFIG_KEY]: '# old\n' } },
      patchImpl: () => { throw failure; },
    });

    const result = await applyGatewayConfig({
      client, namespace: 'infra', configMapName: 'nginx-gateway', nginxConf: conf, opts: { env: ENABLED },
    });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.action).toBe('rejected');
    expect(result.error).toContain('ConfigMap 写入失败');
    expect(result.error).toContain('线上仍运行旧配置');
    expect(result.error).toContain('etcdserver: request timed out');
    // 写失败后不应该再给 Deployment 打注解
    expect(client.patchJson).toHaveBeenCalledTimes(1);
  });

  it('读取 ConfigMap 失败（非 404）：拒绝写入，不把「读不到」当成「没有」', async () => {
    const failure = new Error('Kubernetes API 权限不足，缺少对 configmaps 的 GET 权限（HTTP 403）');
    failure.status = 403;
    const { client } = makeClient({ getError: failure });

    const result = await applyGatewayConfig({
      client, namespace: 'infra', configMapName: 'nginx-gateway', nginxConf: conf, opts: { env: ENABLED },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('读取 ConfigMap');
    expect(result.error).toContain('旧配置');
    expect(client.patchJson).not.toHaveBeenCalled();
    expect(client.postJson).not.toHaveBeenCalled();
  });

  it('reload 注解失败：ok:false 但 changed:true，并给出 rollout restart 的补救命令', async () => {
    let round = 0;
    const { client } = makeClient({
      current: { data: { [DEFAULT_CONFIG_KEY]: '# old\n' } },
      patchImpl: () => {
        round += 1;
        if (round === 2) {
          const error = new Error('Kubernetes API 资源不存在（HTTP 404）');
          error.status = 404;
          throw error;
        }
        return {};
      },
    });

    const result = await applyGatewayConfig({
      client,
      namespace: 'infra',
      configMapName: 'nginx-gateway',
      nginxConf: conf,
      opts: { env: ENABLED, deploymentName: 'gateway-nginx' },
    });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.action).toBe('configmap-written');
    expect(result.error).toContain('ConfigMap 已写入');
    expect(result.error).toContain('reload 注解失败');
    expect(result.error).toContain('kubectl -n infra rollout restart deployment/gateway-nginx');
  });

  it('client 缺 getJson：明确报错，不再尝试任何写入', async () => {
    const client = { patchJson: vi.fn(), postJson: vi.fn() };
    const result = await applyGatewayConfig({
      client, namespace: 'infra', configMapName: 'nginx-gateway', nginxConf: conf, opts: { env: ENABLED },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('缺少 getJson');
    expect(client.patchJson).not.toHaveBeenCalled();
  });

  it('client 缺 patchJson（且有变化）：明确报错，写请求被取消', async () => {
    const client = { getJson: vi.fn(async () => ({ data: { [DEFAULT_CONFIG_KEY]: '# old\n' } })) };
    const result = await applyGatewayConfig({
      client, namespace: 'infra', configMapName: 'nginx-gateway', nginxConf: conf, opts: { env: ENABLED },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('缺少 patchJson');
    expect(result.error).toContain('旧配置');
  });

  it('写开关未开启（OPENLOG_K8S_INFRA != 1）：零 API 调用', async () => {
    const { client, calls } = makeClient({ current: null });
    const result = await applyGatewayConfig({
      client, namespace: 'infra', configMapName: 'nginx-gateway', nginxConf: conf, opts: { env: {} },
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('rejected');
    expect(result.error).toContain('OPENLOG_K8S_INFRA=1');
    expect(calls.get).toEqual([]);
  });

  it('配置自检失败（大括号不匹配 / 上游含大写）时拒绝写入', async () => {
    const { client, calls } = makeClient({ current: null });

    const broken = await applyGatewayConfig({
      client,
      namespace: 'infra',
      configMapName: 'nginx-gateway',
      nginxConf: 'server {\n    listen 8007;\n',
      opts: { env: ENABLED },
    });
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain('大括号不匹配');

    const badCase = await applyGatewayConfig({
      client,
      namespace: 'infra',
      configMapName: 'nginx-gateway',
      nginxConf: 'server {\n    listen 8007;\n    proxy_pass Qwen.inference.svc.cluster.local:8000;\n}',
      opts: { env: ENABLED },
    });
    expect(badCase.ok).toBe(false);
    expect(badCase.error).toContain('不是合法 DNS 名称');

    expect(calls.get).toEqual([]);
  });

  it('namespace / configMapName 非法时在本地拒绝（不浪费一次集群往返）', async () => {
    const { client, calls } = makeClient({ current: null });

    expect((await applyGatewayConfig({
      client, namespace: 'Infra', configMapName: 'nginx-gateway', nginxConf: conf, opts: { env: ENABLED },
    })).error).toContain('namespace 不合法');

    expect((await applyGatewayConfig({
      client, namespace: 'infra', configMapName: 'Nginx Gateway', nginxConf: conf, opts: { env: ENABLED },
    })).error).toContain('configMapName 不合法');

    expect(calls.get).toEqual([]);
  });
});

// ───────────────────────────── 5. 自检函数 ─────────────────────────────

describe('lintNginxConf', () => {
  it('合法配置通过，空配置与不配平的配置被拒', () => {
    expect(lintNginxConf('server {\n    listen 8007;\n    proxy_pass a.b.svc.cluster.local:8000;\n}').ok).toBe(true);
    expect(lintNginxConf('').ok).toBe(false);
    expect(lintNginxConf('server { listen 8007;').errors.join()).toContain('大括号不匹配');
    expect(lintNginxConf('server { listen 8007; } }').errors.join()).toContain('大括号不匹配');
  });

  it('区间标记不成对 / 重复出现都会被拦下（否则下次渲染会追加第二段、重复 bind 端口）', () => {
    const orphan = lintNginxConf(`${REGION_BEGIN}\nserver { listen 8007; }`);
    expect(orphan.ok).toBe(false);
    expect(orphan.errors.join()).toContain('不成对');

    const twice = lintNginxConf([
      REGION_BEGIN,
      'server { listen 8007; }',
      REGION_END,
      REGION_BEGIN,
      'server { listen 8007; }',
      REGION_END,
    ].join('\n'));
    expect(twice.ok).toBe(false);
    expect(twice.errors.join()).toContain('只能有一段');
  });

  it('上游下划线 / 端口越界都会被指出来', () => {
    const result = lintNginxConf('server {\n    listen 8007;\n    proxy_pass bad_host.inference.svc.cluster.local:8000;\n}');
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('不是合法 DNS 名称');

    const badPort = lintNginxConf('server {\n    listen 99999;\n    proxy_pass a.b.svc.cluster.local:8000;\n}');
    expect(badPort.ok).toBe(false);
    expect(badPort.errors.join()).toContain('不是合法端口');
  });
});
