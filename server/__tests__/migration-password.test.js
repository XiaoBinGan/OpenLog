import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 迁移回归测试 —— 真实事故：
 * 旧版本把服务器存在 kv 里，且 password 字段**已经是密文**。
 * 第一次迁移时误用了 encryptPassword，导致密文被二次加密，
 * 部署后全部机器报 "All configured authentication methods failed"。
 *
 * 这里用「可识别的假密文」验证迁移不再二次加密。
 */
const kv = vi.hoisted(() => ({ store: new Map() }));

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    run: async () => ({ changes: 1 }),
    get: async () => ({ n: 0 }),
    all: async () => [],
    exec: async () => {},
  }),
  getDbType: () => 'sqlite',
  getKv: (k) => kv.store.get(k),
  setKv: (k, v) => { kv.store.set(k, JSON.parse(JSON.stringify(v))); },
}));

const store = await import('../remote-store.js');

beforeEach(() => {
  kv.store.clear();
  store._resetTableReady();
});

describe('旧 kv 迁移 —— 密码不能二次加密（真实事故回归）', () => {
  it('kv 里的密文原样进表，不叠加加密', () => {
    const legacyCipher = 'iv:tag:ciphertext-hex-abc'; // 旧版本存的就是这种格式
    // 迁移时 remote.js 传入的是恒等变换 (p) => p
    const row = store.serverToRow({ id: 's1', name: 'n', host: 'h', password: legacyCipher }, (p) => p);
    expect(row.password).toBe(legacyCipher);

    // 读回来解密一次就应该拿到明文
    const decryptOnce = (v) => (v === legacyCipher ? 'plain-password' : `unexpected:${v}`);
    const server = store.rowToServer(row, decryptOnce);
    expect(server.password).toBe('plain-password');
  });

  it('如果误用 encryptPassword，密码会被二次加密（反例说明为什么必须恒等）', () => {
    const legacyCipher = 'iv:tag:cipher';
    const fakeEncrypt = (p) => `enc(${p})`;
    const row = store.serverToRow({ id: 's1', password: legacyCipher }, fakeEncrypt);
    expect(row.password).toBe(`enc(${legacyCipher})`); // 这就是事故原因
  });

  it('迁移后旧 kv 被备份、原 key 清空', async () => {
    kv.store.set('remote_servers', [{ id: 's1', name: 'n', host: 'h', password: 'iv:tag:c' }]);
    await store.migrateLegacyKvServers((s) => store.serverToRow(s, (p) => p));
    expect(kv.store.get('remote_servers_legacy')).toHaveLength(1);
    expect(kv.store.get('remote_servers')).toEqual([]);
    // 备份里的密码仍是原始密文
    expect(kv.store.get('remote_servers_legacy')[0].password).toBe('iv:tag:c');
  });
});
