/**
 * infra-audit.test.js —— AI Infra 审计持久化（B2）的验收测试
 *
 * 这个文件要证明五件事，少一件审计在生产上就不可信：
 *
 *   1. **条目形状是硬契约**：前端筛选器、排障面板、`stats()` 的键都贴着这 13 个字段写，
 *      少一个字段就是页面上多一块空白。所以先测 `buildAuditEntry` 的完整形状与映射。
 *   2. **能查**：actor / action / serviceKey 三种过滤 + 分页，且 `total` 是"过滤后总数"
 *      而不是"这一页的条数"（分页器拿它算页数，错了就翻不到最后一页）。
 *   3. **不会长胖也不会丢最近的**：环形保留按时间淘汰最旧的；同 id 重放是覆盖不是追加。
 *   4. **绝不吞完整 snapshot**：一次 apply 的 snapshot 是几十 KB 的集群对象原文，
 *      进了 KV 就会把 `loadKvCache()` 的启动读取拖死。这里断言落库字符串里连 "spec" 都没有。
 *   5. **审计失败不阻断运维**：KV 抛错 / 异步 reject / 读到 Promise 时，`record` 不抛、
 *      `recordApply` 返回 `{ ok:false }`，而调用方的 apply 结果依旧是成功的。
 *
 * 全部用注入的假 KV，不碰 db、不碰集群。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAuditStore,
  buildAuditEntry,
  recordApply,
  normalizeAuditEntry,
  AUDIT_KV_KEY,
  AUDIT_ACTIONS,
  DEFAULT_KEEP,
  DETAIL_MAX_CHARS,
} from '../infra/audit-store.js';

/* ────────────────────────── 夹具 ────────────────────────── */

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

/** 相对 T0 的 ISO 时间。 */
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

/**
 * 假 KV：`setKv` 同步更新内存并返回已解决的 Promise（与 `db.setKv` 语义一致：
 * 先更内存缓存，再异步落库）。
 */
function createFakeKv(initial = null) {
  const state = { raw: initial, sets: [] };
  return {
    state,
    getKv(key) {
      if (key !== AUDIT_KV_KEY) throw new Error(`意外的 KV key: ${key}`);
      return state.raw;
    },
    setKv(key, value) {
      expect(key).toBe(AUDIT_KV_KEY);
      state.sets.push(value);
      state.raw = value;
      return Promise.resolve();
    },
    /** 落库内容的字符串形态（"有没有把 snapshot 塞进来"就看它） */
    dump() {
      return JSON.stringify(state.raw ?? []);
    },
    entries() {
      return Array.isArray(state.raw) ? state.raw : [];
    },
  };
}

/** 一份正常的 applyService 返回值（成功更新）。 */
function okResult(overrides = {}) {
  return {
    ok: true,
    allowed: true,
    action: 'patch',
    steps: [
      { name: 'guard', ok: true, detail: '护栏通过（命名空间 inference，2 个对象）', ms: 3 },
      { name: 'dry-run', ok: true, detail: '服务端干跑通过：2/2 个对象需要变更', ms: 7 },
      { name: 'apply', ok: true, detail: '更新 2 个对象：Deployment/qwen、Service/qwen', ms: 12 },
    ],
    snapshot: { namespace: 'inference', capturedAt: at(0), objects: [] },
    rollbackAvailable: true,
    rollback: null,
    ...overrides,
  };
}

/** 一条合法条目（用来测"重放/淘汰/过滤"这类与构造无关的行为）。 */
function entry(overrides = {}) {
  return buildAuditEntry({
    service: { namespace: 'inference', name: 'qwen' },
    result: okResult(),
    actor: 'alice',
    forced: [],
    snapshotRef: `inference/qwen@${at(0)}`,
    now: T0,
    ...overrides,
  });
}

/* ────────────────────────── buildAuditEntry ────────────────────────── */

describe('buildAuditEntry —— 条目形状与动作映射', () => {
  it('字段齐全，值可直接给前端/排障面板用', () => {
    const item = entry();

    // 13 个字段一个不多一个不少（多了就是有人往里塞 body 的前兆）
    expect(Object.keys(item).sort()).toEqual([
      'action', 'actor', 'at', 'error', 'forced', 'id', 'name',
      'namespace', 'ok', 'serviceKey', 'snapshotRef', 'steps', 'targets',
    ]);

    expect(item.id).toMatch(/^aud_[0-9a-f]{16}$/);
    expect(item.at).toBe(at(0)); // 规范 ISO
    expect(item.actor).toBe('alice');
    expect(item.action).toBe('update'); // apply 的 'patch' → 审计的 'update'
    expect(item.serviceKey).toBe('inference/qwen');
    expect(item.namespace).toBe('inference');
    expect(item.name).toBe('qwen');
    expect(item.targets).toEqual(['Deployment/qwen', 'Service/qwen']);
    expect(item.steps).toEqual([
      { name: 'guard', ok: true, detail: '护栏通过（命名空间 inference，2 个对象）' },
      { name: 'dry-run', ok: true, detail: '服务端干跑通过：2/2 个对象需要变更' },
      { name: 'apply', ok: true, detail: '更新 2 个对象：Deployment/qwen、Service/qwen' },
    ]);
    expect(item.ok).toBe(true);
    expect(item.error).toBeNull();
    expect(item.snapshotRef).toBe(`inference/qwen@${at(0)}`);
    expect(item.forced).toEqual([]);
  });

  it('被拒的变更记成 rejected，并把可操作的中文原因带上', () => {
    const item = buildAuditEntry({
      service: { namespace: 'inference', name: 'strata' },
      result: {
        ok: false,
        allowed: false,
        action: 'rejected',
        steps: [{ name: 'guard', ok: false, detail: '护栏未通过：对象不属于本系统管理', ms: 1 }],
        snapshot: { namespace: 'inference', objects: [] },
        error: '护栏未通过：对象不属于本系统管理',
      },
      actor: 'mallory',
      forced: [],
      snapshotRef: null,
      now: T0,
    });

    expect(item.action).toBe('rejected');
    expect(item.ok).toBe(false);
    expect(item.error).toContain('护栏未通过');
    expect(item.snapshotRef).toBeNull(); // 没走到写，不该有快照引用
  });

  it('回滚是独立动作，不会和 update 混在一起', () => {
    const item = buildAuditEntry({
      service: { namespace: 'inference', name: 'qwen' },
      result: { ok: true, action: 'rollback', steps: [{ name: 'rollback', ok: true, detail: '已恢复 2 个对象' }] },
      actor: 'alice',
      now: T0,
    });
    expect(item.action).toBe('rollback');
  });

  it('action 只可能是四值枚举：create / patch / noop / 失败 全部落在枚举内', () => {
    const cases = [
      { result: okResult({ action: 'create' }), want: 'create' },
      { result: okResult({ action: 'patch' }), want: 'update' },
      { result: okResult({ action: 'noop' }), want: 'update' },
      { result: okResult({ action: 'rejected', ok: false, error: '被拦' }), want: 'rejected' },
      { result: { ok: false, steps: [] }, want: 'rejected' }, // 没有 action 时按结果兜底
      { result: undefined, want: 'update' },
    ];
    for (const { result, want } of cases) {
      const item = buildAuditEntry({
        service: { namespace: 'inference', name: 'qwen' }, result, now: T0,
      });
      expect(item.action).toBe(want);
      expect(AUDIT_ACTIONS).toContain(item.action);
    }
  });

  it('targets 优先取真正要写进集群的对象（result.objects）', () => {
    const item = buildAuditEntry({
      service: { namespace: 'inference', name: 'qwen' },
      result: okResult({
        objects: [
          { kind: 'Deployment', metadata: { name: 'qwen' } },
          { kind: 'Service', metadata: { name: 'qwen' } },
          { kind: 'ConfigMap', metadata: { name: 'qwen-conf' } },
        ],
      }),
      now: T0,
    });
    expect(item.targets).toEqual(['Deployment/qwen', 'Service/qwen', 'ConfigMap/qwen-conf']);
  });

  it('没有 ref 时对快照取短指纹，body 依旧不进条目', () => {
    const item = buildAuditEntry({
      service: { namespace: 'inference', name: 'qwen' },
      result: okResult({ snapshot: { namespace: 'inference', objects: [{ body: { spec: { replicas: 1 } } }] } }),
      snapshotRef: null,
      now: T0,
    });
    expect(item.snapshotRef).toMatch(/^snap_[0-9a-f]{12}$/);
    expect(JSON.stringify(item)).not.toContain('spec');
  });
});

/* ────────────────────────── record / list 基本流 ────────────────────────── */

describe('record + list —— 基本流与查询', () => {
  let kv;
  let store;

  beforeEach(() => {
    kv = createFakeKv();
    store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv, now: () => T0 + 1000 });
  });

  it('记一条就能查回来，KV 里只有 infra_audit 一个键', () => {
    const item = entry();
    const res = store.record(item);

    expect(res.ok).toBe(true);
    expect(res.id).toBe(item.id);
    expect(res.total).toBe(1);
    expect(kv.state.sets).toHaveLength(1);
    expect(kv.entries()).toHaveLength(1);
    expect(kv.entries()[0].id).toBe(item.id);

    const page = store.list();
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual(item);
  });

  it('按 actor 过滤', () => {
    store.record(entry({ actor: 'alice', now: T0 }));
    store.record(entry({ actor: 'bob', now: T0 + 1000 }));
    store.record(entry({ actor: 'bob', now: T0 + 2000 }));

    expect(store.list().total).toBe(3);
    expect(store.list({ actor: 'bob' }).total).toBe(2);
    expect(store.list({ actor: 'bob' }).items.every((item) => item.actor === 'bob')).toBe(true);
    expect(store.list({ actor: 'nobody' })).toMatchObject({ total: 0, items: [] });
  });

  it('按 action 过滤（rejected 是最常被单独翻的一类）', () => {
    store.record(entry({ now: T0 }));
    store.record(buildAuditEntry({
      service: { namespace: 'inference', name: 'strata' },
      result: { ok: false, action: 'rejected', steps: [], error: '护栏未通过：归属标签不符' },
      actor: 'mallory',
      now: T0 + 1000,
    }));

    const rejected = store.list({ action: 'rejected' });
    expect(rejected.total).toBe(1);
    expect(rejected.items[0].ok).toBe(false);
    expect(rejected.items[0].actor).toBe('mallory');
    expect(store.list({ action: 'create' }).total).toBe(0);
  });

  it('按 serviceKey 过滤，且能和 actor 叠加', () => {
    store.record(entry({ now: T0 }));
    store.record(buildAuditEntry({
      service: { namespace: 'infra-test', name: 'strata' },
      result: okResult({ action: 'create' }),
      actor: 'alice',
      now: T0 + 1000,
    }));
    store.record(buildAuditEntry({
      service: { namespace: 'infra-test', name: 'strata' },
      result: okResult({ action: 'create' }),
      actor: 'bob',
      now: T0 + 2000,
    }));

    expect(store.list({ serviceKey: 'infra-test/strata' }).total).toBe(2);
    expect(store.list({ serviceKey: 'infra-test/strata', actor: 'bob' }).total).toBe(1);
    expect(store.list({ serviceKey: 'inference/qwen' }).items[0].serviceKey).toBe('inference/qwen');
  });

  it('分页：limit/offset 切片，total 仍是过滤后的总数', () => {
    for (let i = 0; i < 5; i += 1) store.record(entry({ now: T0 + i * 1000 }));

    const first = store.list({ limit: 2 });
    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(first.items[0].at).toBe(at(4000)); // 最新在前
    expect(first.items[1].at).toBe(at(3000));

    const second = store.list({ limit: 2, offset: 2 });
    expect(second.total).toBe(5);
    expect(second.items.map((item) => item.at)).toEqual([at(2000), at(1000)]);

    const last = store.list({ limit: 2, offset: 4 });
    expect(last.items).toHaveLength(1);
    expect(last.items[0].at).toBe(at(0));

    // offset 越界：空页但 total 不变，分页器不会算出负页数
    expect(store.list({ limit: 2, offset: 99 })).toMatchObject({ total: 5, items: [] });
  });

  it('空 store：list 返回空页、stats 返回零值（不抛、不崩前端）', () => {
    expect(store.list()).toMatchObject({ total: 0, items: [] });
    expect(store.stats()).toEqual({
      total: 0,
      byAction: { create: 0, update: 0, rollback: 0, rejected: 0 },
      byActor: [],
      lastAt: null,
    });
  });

  it('存储里是脏数据时按"能用的才算"处理，不让整个查询炸掉', () => {
    kv.state.raw = [
      { id: 'x1', at: at(0), actor: 'alice', action: 'update' },
      { actor: 'no-id' }, // 缺 id → 跳过
      { id: 'x2', at: 'not-a-date' }, // 非法时间 → 跳过
      'garbage',
    ];
    const page = store.list();
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe('x1');
  });
});

/* ────────────────────────── 环形保留 / 幂等 / 统计 ────────────────────────── */

describe('环形保留、幂等重放与统计', () => {
  it('超出 keep 按时间淘汰最旧的', () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv, keep: 3, now: () => T0 });

    for (let i = 0; i < 5; i += 1) store.record(entry({ now: T0 + i * 1000 }));

    expect(kv.entries()).toHaveLength(3);
    expect(store.list().total).toBe(3);
    // 留下的是 t=2s/3s/4s 这三条，最旧的两条被淘汰
    expect(store.list().items.map((item) => item.at)).toEqual([at(4000), at(3000), at(2000)]);
  });

  it('默认 keep 是 500', () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });
    expect(DEFAULT_KEEP).toBe(500);
    // 604 条灌进去（同一条 id 不行，所以每条都换时间）
    for (let i = 0; i < 504; i += 1) store.record(entry({ now: T0 + i * 1000 }));
    expect(kv.entries().length).toBe(500);
    expect(store.list({ limit: 500 }).items[0].at).toBe(at(503 * 1000));
  });

  it('幂等重放：同 id 覆盖而不是追加（重试一次不会留下两条变更）', () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });

    const item = entry();
    const first = store.record(item);
    const second = store.record({ ...item, steps: [{ name: 'apply', ok: true, detail: '重放写回的版本' }] });

    expect(first.id).toBe(second.id);
    expect(store.list().total).toBe(1);
    expect(kv.entries()).toHaveLength(1);
    expect(kv.entries()[0].steps).toHaveLength(1);
    expect(kv.entries()[0].steps[0].detail).toBe('重放写回的版本');
  });

  it('buildAuditEntry 派生的 id 是内容指纹：同一份结果重放得到同一个 id', () => {
    const a = entry();
    const b = entry();
    const c = entry({ now: T0 + 1 });
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it('stats：总数 / 按动作 / 按人（降序）/ 最后时间', () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });

    store.record(entry({ actor: 'alice', now: T0 }));
    store.record(buildAuditEntry({
      service: { namespace: 'inference', name: 'qwen' },
      result: okResult({ action: 'create' }),
      actor: 'alice',
      now: T0 + 1000,
    }));
    store.record(buildAuditEntry({
      service: { namespace: 'inference', name: 'strata' },
      result: { ok: false, action: 'rejected', steps: [], error: '被护栏拦下' },
      actor: 'bob',
      now: T0 + 2000,
    }));

    const stats = store.stats();
    expect(stats.total).toBe(3);
    expect(stats.byAction).toEqual({ create: 1, update: 1, rollback: 0, rejected: 1 });
    expect(stats.byActor).toEqual([
      { actor: 'alice', count: 2 },
      { actor: 'bob', count: 1 },
    ]);
    expect(stats.lastAt).toBe(at(2000));
  });

  it('clear 清空且不抛错', () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });
    store.record(entry());
    expect(store.clear()).toEqual({ ok: true, total: 0, error: null });
    expect(store.list().total).toBe(0);
    expect(kv.entries()).toEqual([]);
  });
});

/* ────────────────────────── snapshot 绝不入库 ────────────────────────── */

describe('snapshot 不入库（只留 ref）', () => {
  it('完整 snapshot body 只留指纹，KV 字符串里连 "spec" 都没有', () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });

    const bulkySnapshot = {
      namespace: 'inference',
      capturedAt: at(0),
      objects: [
        {
          ref: { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'inference', name: 'strata' },
          existed: true,
          body: {
            metadata: { name: 'strata', labels: { 'openlog.io/managed': 'true' } },
            spec: {
              replicas: 1,
              template: {
                spec: {
                  containers: [{
                    name: 'strata',
                    image: 'evil:1',
                    resources: { limits: { 'hami.io/vgpu-memory': 8192 } },
                  }],
                },
              },
            },
          },
        },
      ],
    };

    const item = buildAuditEntry({
      service: { namespace: 'inference', name: 'strata' },
      result: okResult({ action: 'patch', snapshot: bulkySnapshot }),
      actor: 'alice',
      forced: [],
      snapshotRef: null,
      now: T0,
    });
    store.record(item);

    const dump = kv.dump();
    expect(dump).not.toContain('spec');
    expect(dump).not.toContain('evil:1');
    expect(dump).not.toContain('vgpu-memory');
    expect(dump.length).toBeLessThan(2000); // 一条审计就该是这个量级
    expect(kv.entries()[0].snapshotRef).toMatch(/^snap_[0-9a-f]{12}$/);
  });

  it('调用方手滑把 snapshot / body / objects 塞进条目顶层，也会被白名单丢掉', () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });

    const item = {
      ...entry(),
      snapshot: { objects: [{ body: { spec: { replicas: 9 } } }] },
      body: { spec: { replicas: 9 } },
      objects: [{ spec: { replicas: 9 } }],
      steps: [{ name: 'apply', ok: true, detail: '更新 1 个对象' }],
    };
    expect(store.record(item).ok).toBe(true);

    const stored = kv.entries()[0];
    expect(stored.snapshot).toBeUndefined();
    expect(stored.body).toBeUndefined();
    expect(stored.objects).toBeUndefined();
    expect(kv.dump()).not.toContain('spec');
    expect(Object.keys(stored).sort()).toEqual(Object.keys(entry()).sort());
  });

  it('超长说明被截断（审计要能读，不是要存日志全文）', () => {
    const long = 'x'.repeat(2000);
    const item = normalizeAuditEntry({
      ...entry(),
      steps: [{ name: 'apply', ok: true, detail: long }],
      error: long,
    });
    expect(item.ok).toBe(true);
    expect(item.value.steps[0].detail.length).toBeLessThanOrEqual(DETAIL_MAX_CHARS);
    expect(item.value.steps[0].detail.endsWith('...')).toBe(true);
    expect(item.value.error.length).toBeLessThanOrEqual(DETAIL_MAX_CHARS);
  });
});

/* ────────────────────────── 非法条目 ────────────────────────── */

describe('非法条目被拒（缺 id / 缺 at）', () => {
  let kv;
  let store;

  beforeEach(() => {
    kv = createFakeKv();
    store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });
  });

  it('缺 id → ok:false + 中文原因，且一条都没落库', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = store.record({ at: at(0), actor: 'alice', action: 'update' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('缺少 id');
    expect(kv.state.sets).toHaveLength(0);
    expect(store.list().total).toBe(0);
    console.warn.mockRestore();
  });

  it('缺 at / at 非法 → 拒绝（没有时间就无法排序与淘汰）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of [{ id: 'a1' }, { id: 'a1', at: 'yesterday' }, { id: 'a1', at: {} }]) {
      const res = store.record(bad);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('at');
    }
    expect(store.list().total).toBe(0);
    console.warn.mockRestore();
  });

  it('非对象条目被拒，且 normalize 不抛', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(() => normalizeAuditEntry(bad)).not.toThrow();
      expect(normalizeAuditEntry(bad).ok).toBe(false);
      expect(store.record(bad).ok).toBe(false);
    }
    console.warn.mockRestore();
  });
});

/* ────────────────────────── 排序 ────────────────────────── */

describe('时间排序', () => {
  it('乱序写入后 list 仍是最新在前', () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });
    for (const offset of [2000, 0, 4000, 1000, 3000]) store.record(entry({ now: T0 + offset }));

    expect(store.list().items.map((item) => item.at)).toEqual([
      at(4000), at(3000), at(2000), at(1000), at(0),
    ]);
    expect(kv.entries().map((item) => item.at)).toEqual([
      at(4000), at(3000), at(2000), at(1000), at(0),
    ]);
  });
});

/* ────────────────────────── 审计失败不阻断运维 ────────────────────────── */

describe('存储层故障时审计不阻断运维', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setKv 同步抛错：record 不抛、返回 {ok:false,error}、调用方的 apply 仍然成功', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createAuditStore({
      getKv: () => null,
      setKv: () => { throw new Error('database is locked'); },
    });

    const item = entry();
    let res;
    expect(() => { res = store.record(item); }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('审计写入失败');
    expect(res.error).toContain('database is locked');
    expect(warn).toHaveBeenCalled();

    // 关键：apply 的结果不受影响，recordApply 只吞掉失败
    const applied = okResult();
    const hit = await recordApply({
      store, service: { namespace: 'inference', name: 'qwen' }, result: applied, actor: 'alice', now: T0,
    });
    expect(applied.ok).toBe(true);
    expect(hit.ok).toBe(false);
    expect(hit.id).toBeNull(); // 没入库就不该回填 auditId
    expect(hit.error).toContain('审计写入失败');
  });

  it('setKv 返回 rejected Promise：record 同步不抛，write 结算为失败', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createAuditStore({
      getKv: () => null,
      setKv: () => Promise.reject(new Error('disk full')),
    });

    const res = store.record(entry());
    expect(res.ok).toBe(true); // 同步阶段没发现问题
    const settled = await res.write; // 但异步失败必须能被看见
    expect(settled.ok).toBe(false);
    expect(settled.error).toContain('disk full');
    expect(warn).toHaveBeenCalled();

    const hit = await recordApply({
      store, service: { namespace: 'inference', name: 'qwen' }, result: okResult(), actor: 'alice', now: T0,
    });
    expect(hit.ok).toBe(false);
    expect(hit.error).toContain('disk full');
  });

  it('getKv 抛错：list 返回空页并带 error，record 不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createAuditStore({
      getKv: () => { throw new Error('kv read failed'); },
      setKv: () => Promise.resolve(),
    });

    const page = store.list();
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
    expect(page.error).toContain('kv read failed');
    expect(store.stats().total).toBe(0);

    const res = store.record(entry());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('审计读取失败');
    expect(warn).toHaveBeenCalled();
  });

  it('异步 getKv（返回 Promise）时明确报错，绝不把历史审计覆盖成空表', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sets = [];
    const store = createAuditStore({
      getKv: () => Promise.resolve([{ id: 'legacy', at: at(0) }]),
      setKv: (key, value) => { sets.push(value); return Promise.resolve(); },
    });

    const res = store.record(entry());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('同步 getKv');
    expect(sets).toHaveLength(0); // 一次写都没发出去
    expect(store.list()).toMatchObject({ total: 0, items: [] });
    expect(store.list().error).toContain('同步 getKv');
    expect(warn).toHaveBeenCalled();
  });

  it('store 未注入：recordApply 返回 {ok:false} 而不是把 apply 带走', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hit = await recordApply({
      store: null, service: { namespace: 'inference', name: 'qwen' }, result: okResult(), actor: 'alice', now: T0,
    });
    expect(hit.ok).toBe(false);
    expect(hit.id).toBeNull();
    expect(hit.entry.id).toMatch(/^aud_/); // 条目还是构造出来了，便于排障时手工补录
    expect(hit.error).toContain('审计存储未就绪');
  });
});

/* ────────────────────────── recordApply 端到端 ────────────────────────── */

describe('recordApply —— 路由层直接可用的入口', () => {
  it('把一次成功的 apply 落成一条可查询的审计', async () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });

    const hit = await recordApply({
      store,
      service: { namespace: 'inference', name: 'strata' },
      result: okResult({
        action: 'create',
        objects: [
          { kind: 'Deployment', metadata: { name: 'strata' } },
          { kind: 'Service', metadata: { name: 'strata' } },
        ],
        snapshot: { namespace: 'inference', objects: [] },
      }),
      actor: 'alice',
      forced: ['BIG_CHANGE'],
      snapshotRef: `inference/strata@${at(0)}`,
      now: T0,
    });

    expect(hit.ok).toBe(true);
    expect(hit.id).toMatch(/^aud_[0-9a-f]{16}$/);
    expect(hit.entry.action).toBe('create');
    expect(hit.entry.forced).toEqual(['BIG_CHANGE']);
    expect(hit.entry.targets).toEqual(['Deployment/strata', 'Service/strata']);

    const page = store.list({ actor: 'alice', action: 'create' });
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe(hit.id);
    expect(page.items[0].steps).toHaveLength(3);
  });

  it('默认时钟走 store.now（不显式传 now 也能排序）', async () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv, now: () => T0 });

    const first = await recordApply({
      store, service: { namespace: 'inference', name: 'qwen' }, result: okResult(), actor: 'alice',
    });
    expect(first.ok).toBe(true);
    expect(first.entry.at).toBe(at(0));
    expect(store.stats().lastAt).toBe(at(0));
  });

  it('rejected 也要留痕（"有人想改不属于自己的对象"是最需要翻的一类）', async () => {
    const kv = createFakeKv();
    const store = createAuditStore({ getKv: kv.getKv, setKv: kv.setKv });

    const hit = await recordApply({
      store,
      service: { namespace: 'infra-test', name: 'strata' },
      result: {
        ok: false,
        allowed: false,
        action: 'rejected',
        steps: [{ name: 'guard', ok: false, detail: '护栏未通过：对象不属于本系统管理', ms: 1 }],
        snapshot: { namespace: 'infra-test', objects: [] },
        error: '护栏未通过：对象不属于本系统管理',
      },
      actor: 'mallory',
      forced: [],
      snapshotRef: null,
      now: T0,
    });

    expect(hit.ok).toBe(true); // 审计本身成功
    expect(hit.entry.action).toBe('rejected');
    expect(hit.entry.ok).toBe(false);
    const page = store.list({ action: 'rejected' });
    expect(page.total).toBe(1);
    expect(page.items[0].error).toContain('护栏未通过');
  });
});
