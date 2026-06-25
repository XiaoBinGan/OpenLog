import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDb,
  getDb,
  createSkill,
  getSkill,
  listSkills,
  updateSkill,
  deleteSkill,
  getAlertConfig,
  upsertAlertConfig,
  getKv,
  setKv,
  deleteKv,
} from '../db/index.js';

// 测试专用 ID 前缀，避免污染真实数据
const TEST_SKILL_ID = 'test-skill-001';
const TEST_MACHINE_ID = 'test-machine-alert';
const TEST_ALERT_CONFIG_ID = 'test-alert-cfg-001';
const TEST_KV_KEY = 'test_kv_key';

describe('DB 层测试', () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(() => {
    // 清理测试数据
    try {
      const db = getDb();
      db.run(`DELETE FROM skills WHERE id = ?`, TEST_SKILL_ID);
      db.run(`DELETE FROM skills WHERE id = ?`, TEST_SKILL_ID + '-updated');
      db.run(`DELETE FROM alert_configs WHERE id = ?`, TEST_ALERT_CONFIG_ID);
      db.run(`DELETE FROM kv_store WHERE key = ?`, TEST_KV_KEY);
    } catch {
      // 忽略清理错误
    }
  });

  describe('initDb()', () => {
    it('应该成功初始化数据库并返回 db 对象', async () => {
      const db = await initDb();
      expect(db).toBeDefined();
      expect(typeof db.run).toBe('function');
      expect(typeof db.get).toBe('function');
      expect(typeof db.all).toBe('function');
    });

    it('多次调用 initDb 应该返回同一个实例', async () => {
      const db1 = await initDb();
      const db2 = await initDb();
      expect(db1).toBe(db2);
    });

    it('getDb() 应该返回已初始化的 db', () => {
      const db = getDb();
      expect(db).toBeDefined();
    });
  });

  describe('Skills CRUD', () => {
    const testSkill = {
      id: TEST_SKILL_ID,
      name: 'Test Skill',
      command: 'echo "hello"',
      description: 'A test skill for unit testing',
      content: 'Test content here',
      category: '测试',
      is_default: 0,
    };

    it('createSkill: 创建成功应返回 changes > 0', () => {
      const result = createSkill(testSkill);
      expect(result.changes).toBeGreaterThan(0);
    });

    it('getSkill: 应该能获取刚创建的 skill', () => {
      const skill = getSkill(TEST_SKILL_ID);
      expect(skill).not.toBeNull();
      expect(skill.name).toBe('Test Skill');
      expect(skill.command).toBe('echo "hello"');
      expect(skill.category).toBe('测试');
      expect(skill.content).toBe('Test content here');
    });

    it('listSkills: 应该包含已创建的 skill', () => {
      const skills = listSkills();
      const found = skills.find(s => s.id === TEST_SKILL_ID);
      expect(found).toBeDefined();
      expect(found.name).toBe('Test Skill');
    });

    it('updateSkill: 更新后应返回 changes > 0', () => {
      const result = updateSkill(TEST_SKILL_ID, {
        ...testSkill,
        name: 'Updated Skill',
        description: 'Updated description',
      });
      expect(result.changes).toBeGreaterThan(0);

      // 验证更新后的值
      const updated = getSkill(TEST_SKILL_ID);
      expect(updated.name).toBe('Updated Skill');
      expect(updated.description).toBe('Updated description');
    });

    it('deleteSkill: 删除后 getSkill 应返回 null', () => {
      const result = deleteSkill(TEST_SKILL_ID);
      expect(result.changes).toBeGreaterThan(0);

      const deleted = getSkill(TEST_SKILL_ID);
      expect(deleted).toBeUndefined();
    });

    it('getSkill: 查询不存在的 skill 应返回 undefined', () => {
      const skill = getSkill('non-existent-id');
      expect(skill).toBeUndefined();
    });
  });

  describe('Alert Configs', () => {
    const testConfig = {
      id: TEST_ALERT_CONFIG_ID,
      machine_id: TEST_MACHINE_ID,
      enabled: true,
      patterns: 'ERROR,FATAL,Exception',
      severity_filter: 'error,fatal',
      cooldown_minutes: 10,
      webhook_url: 'https://hooks.example.com/alert',
    };

    beforeAll(() => {
      // 插入一个假机器记录以通过外键约束
      const db = getDb();
      db.run(
        `INSERT OR IGNORE INTO machines (id, type, name) VALUES (?, 'local', 'Test Machine')`,
        TEST_MACHINE_ID
      );
    });

    it('upsertAlertConfig: 创建成功应返回 changes > 0', () => {
      const result = upsertAlertConfig(testConfig);
      expect(result.changes).toBeGreaterThan(0);
    });

    it('getAlertConfig: 应该能获取刚创建的 alert config', () => {
      const config = getAlertConfig(TEST_MACHINE_ID);
      expect(config).not.toBeNull();
      expect(config.id).toBe(TEST_ALERT_CONFIG_ID);
      expect(config.machine_id).toBe(TEST_MACHINE_ID);
      expect(config.enabled).toBe(1);
      expect(config.patterns).toBe('ERROR,FATAL,Exception');
      expect(config.severity_filter).toBe('error,fatal');
      expect(config.cooldown_minutes).toBe(10);
      expect(config.webhook_url).toBe('https://hooks.example.com/alert');
    });

    it('upsertAlertConfig: 更新已存在的配置', () => {
      const updatedConfig = {
        ...testConfig,
        patterns: 'WARN,ERROR',
        cooldown_minutes: 15,
      };
      const result = upsertAlertConfig(updatedConfig);
      expect(result.changes).toBeGreaterThan(0);

      const config = getAlertConfig(TEST_MACHINE_ID);
      expect(config.patterns).toBe('WARN,ERROR');
      expect(config.cooldown_minutes).toBe(15);
    });

    it('getAlertConfig: 查询不存在的 machine 应返回 undefined', () => {
      const config = getAlertConfig('non-existent-machine');
      expect(config).toBeUndefined();
    });

    afterAll(() => {
      try {
        const db = getDb();
        db.run(`DELETE FROM alert_configs WHERE id = ?`, TEST_ALERT_CONFIG_ID);
        db.run(`DELETE FROM machines WHERE id = ?`, TEST_MACHINE_ID);
      } catch {
        // 忽略
      }
    });
  });

  describe('KV Store', () => {
    it('setKv: 设置字符串值成功', () => {
      const result = setKv(TEST_KV_KEY, 'hello world');
      expect(result.changes).toBeGreaterThan(0);
    });

    it('getKv: 获取刚设置的字符串值', () => {
      const value = getKv(TEST_KV_KEY);
      expect(value).toBe('hello world');
    });

    it('setKv: 设置对象值（应自动 JSON 序列化）', () => {
      setKv(TEST_KV_KEY, { name: 'test', count: 42, nested: { a: 1 } });
      const value = getKv(TEST_KV_KEY);
      expect(value).toEqual({ name: 'test', count: 42, nested: { a: 1 } });
    });

    it('setKv: 设置数组值', () => {
      setKv(TEST_KV_KEY, [1, 2, 3, 'four']);
      const value = getKv(TEST_KV_KEY);
      expect(value).toEqual([1, 2, 3, 'four']);
    });

    it('getKv: 不存在的 key 应返回 null', () => {
      const value = getKv('non_existent_key_12345');
      expect(value).toBeNull();
    });

    it('deleteKv: 删除后应返回 null', () => {
      setKv(TEST_KV_KEY, 'to be deleted');
      const delResult = deleteKv(TEST_KV_KEY);
      expect(delResult.changes).toBeGreaterThan(0);

      const value = getKv(TEST_KV_KEY);
      expect(value).toBeNull();
    });

    it('deleteKv: 删除不存在的 key 应返回 changes=0', () => {
      const result = deleteKv('never_existed_key');
      expect(result.changes).toBe(0);
    });
  });
});