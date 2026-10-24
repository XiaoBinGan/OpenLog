import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'crypto';

// 顶层 await import：模块本身在「未设置 OPENLOG_SECRET_KEY」时加载，
// 模拟旧的 dotenv 顺序问题（import 求值早于入口的 dotenv.config()）。
const { _cryptoInternals } = await import('../remote.js');

const LEGACY_KEY = crypto.scryptSync('openlog-remote-secret-salt-v2', 'openlog', 32);

function decryptWithKey(cipher, key) {
  const [ivHex, tagHex, dataHex] = cipher.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

const ORIGINAL = process.env.OPENLOG_SECRET_KEY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OPENLOG_SECRET_KEY;
  else process.env.OPENLOG_SECRET_KEY = ORIGINAL;
});

describe('SSH 密码加密密钥按需解析（回归：dotenv 加载顺序）', () => {
  it('未设置 OPENLOG_SECRET_KEY → 用源码内置 legacy 密钥', () => {
    delete process.env.OPENLOG_SECRET_KEY;
    expect(_cryptoInternals.getEncryptionKeySource()).toBe('legacy');

    const cipher = _cryptoInternals.encryptPassword('pw-legacy');
    expect(_cryptoInternals.decryptPassword(cipher)).toBe('pw-legacy');
    // legacy 密钥能解开，说明确实用了内置种子（兼容旧数据）
    expect(decryptWithKey(cipher, LEGACY_KEY)).toBe('pw-legacy');
  });

  it('模块加载后再设置 OPENLOG_SECRET_KEY 也立即生效', () => {
    delete process.env.OPENLOG_SECRET_KEY;
    expect(_cryptoInternals.getEncryptionKeySource()).toBe('legacy');

    // 模拟 dotenv 在模块加载之后才注入环境变量
    process.env.OPENLOG_SECRET_KEY = 'unit-test-secret';
    expect(_cryptoInternals.getEncryptionKeySource()).toBe('env');

    const cipher = _cryptoInternals.encryptPassword('pw-env');
    expect(_cryptoInternals.decryptPassword(cipher)).toBe('pw-env');
    // 关键回归点：旧实现在 import 时固化密钥，legacy 也能解开；
    // 现在必须解不开（否则说明 .env 的 OPENLOG_SECRET_KEY 没生效）。
    expect(() => decryptWithKey(cipher, LEGACY_KEY)).toThrow();
  });

  it('从 legacy 切到 env 密钥后，仍能解开历史 legacy 密文（触发迁移）', () => {
    delete process.env.OPENLOG_SECRET_KEY;
    const legacyCipher = _cryptoInternals.encryptPassword('pw-old');

    process.env.OPENLOG_SECRET_KEY = 'unit-test-secret';
    expect(_cryptoInternals.getEncryptionKeySource()).toBe('env');
    // 新密钥解不开 → 自动回退 legacy 并标记重新加密
    expect(_cryptoInternals.decryptPassword(legacyCipher)).toBe('pw-old');
  });
});
