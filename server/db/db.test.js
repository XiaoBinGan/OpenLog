/**
 * 数据库层测试 - 测试 SQLite CRUD 操作
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDb,
  getDb,
  getDbType,
  upsertMachine,
  getMachine,
  listMachines,
  deleteMachine,
  insertLogRecord,
  listLogRecords,
  insertAnalysis,
  listAnalysis,
  getKv,
  setKv,
  deleteKv,
  listKv,
  createSkill,
  getSkill,
  listSkills,
  updateSkill,
  deleteSkill,
  getAlertConfig,
  upsertAlertConfig,
  listAlertConfigs,
  closeDb,
} from './index.js';
import { v4 as uuidv4 } from 'uuid';

beforeAll(async () => {
  await initDb();
});

afterAll(() => {
  closeDb();
});

// ─── Machines CRUD ──────────────────────────────────────────
describe('Machines CRUD', () => {
  const machineId = uuidv4();

  it('should create a machine', () => {
    const result = upsertMachine({
      id: machineId,
      type: 'local',
      name: 'Test Machine',
      host: 'localhost',
      port: 22,
      ssh_user: 'test',
      log_path: '/var/log',
    });
    expect(result.changes).toBeGreaterThanOrEqual(0);
  });

  it('should get the created machine', () => {
    const machine = getMachine(machineId);
    expect(machine).toBeTruthy();
    expect(machine.name).toBe('Test Machine');
    expect(machine.type).toBe('local');
    expect(machine.host).toBe('localhost');
  });

  it('should list machines', () => {
    const machines = listMachines();
    expect(Array.isArray(machines)).toBe(true);
    expect(machines.length).toBeGreaterThanOrEqual(1);
    expect(machines.some(m => m.id === machineId)).toBe(true);
  });

  it('should update a machine via upsert', () => {
    upsertMachine({
      id: machineId,
      type: 'local',
      name: 'Updated Machine',
      host: '127.0.0.1',
      port: 2222,
      ssh_user: 'updated',
      log_path: '/tmp/logs',
    });
    const updated = getMachine(machineId);
    expect(updated.name).toBe('Updated Machine');
    expect(updated.host).toBe('127.0.0.1');
    expect(updated.port).toBe(2222);
  });

  it('should delete a machine', () => {
    const result = deleteMachine(machineId);
    expect(result.changes).toBeGreaterThanOrEqual(0);
    const deleted = getMachine(machineId);
    expect(deleted).toBeUndefined();
  });
});

// ─── Log Records CRUD ───────────────────────────────────────
describe('Log Records CRUD', () => {
  const machineId = uuidv4();
  const logId = uuidv4();

  beforeAll(() => {
    upsertMachine({
      id: machineId,
      type: 'local',
      name: 'LogTest Machine',
      host: 'localhost',
      port: 22,
      ssh_user: 'test',
      log_path: '/var/log',
    });
  });

  it('should insert a log record', () => {
    const result = insertLogRecord({
      id: logId,
      machine_id: machineId,
      source_type: 'file',
      source_name: 'app.log',
      content: 'Error: something went wrong',
      severity: 'ERROR',
      timestamp: Math.floor(Date.now() / 1000),
      parsed: { key: 'value' },
    });
    expect(result.changes).toBeGreaterThanOrEqual(0);
  });

  it('should list log records', () => {
    const records = listLogRecords({ machine_id: machineId });
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBeGreaterThanOrEqual(1);
    const record = records.find(r => r.id === logId);
    expect(record).toBeTruthy();
    expect(record.severity).toBe('ERROR');
    expect(record.source_name).toBe('app.log');
  });

  it('should filter by severity', () => {
    const records = listLogRecords({ machine_id: machineId, severity: 'INFO' });
    expect(records.length).toBe(0); // 我们只插入了 ERROR
  });

  it('should respect limit and offset', () => {
    const records = listLogRecords({ limit: 1, offset: 0 });
    expect(records.length).toBeLessThanOrEqual(1);
  });
});

// ─── Analysis Records CRUD ──────────────────────────────────
describe('Analysis Records CRUD', () => {
  const machineId = uuidv4();
  const logId = uuidv4();
  const analysisId = uuidv4();

  beforeAll(() => {
    upsertMachine({
      id: machineId,
      type: 'local',
      name: 'AnalysisTest Machine',
      host: 'localhost',
      port: 22,
      ssh_user: 'test',
      log_path: '/var/log',
    });
    insertLogRecord({
      id: logId,
      machine_id: machineId,
      source_type: 'file',
      source_name: 'analysis.log',
      content: 'Fatal error detected',
      severity: 'FATAL',
      timestamp: Math.floor(Date.now() / 1000),
      parsed: null,
    });
  });

  it('should insert an analysis', () => {
    const result = insertAnalysis({
      id: analysisId,
      log_record_id: logId,
      machine_id: machineId,
      diagnosis: 'Memory leak detected in module X',
      suggestion: 'Restart the service and increase memory limit',
      severity: 'CRITICAL',
      model: 'gpt-4',
      token_used: 150,
    });
    expect(result.changes).toBeGreaterThanOrEqual(0);
  });

  it('should list analyses', () => {
    const analyses = listAnalysis({ machine_id: machineId });
    expect(Array.isArray(analyses)).toBe(true);
    expect(analyses.length).toBeGreaterThanOrEqual(1);
    const a = analyses.find(r => r.id === analysisId);
    expect(a).toBeTruthy();
    expect(a.diagnosis).toContain('Memory leak');
    expect(a.model).toBe('gpt-4');
  });

  it('should list analyses by log_record_id', () => {
    const analyses = listAnalysis({ log_record_id: logId });
    expect(analyses.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── KV Store CRUD ──────────────────────────────────────────
describe('KV Store CRUD', () => {
  it('should set and get a string value', () => {
    setKv('test_key', 'hello world');
    const value = getKv('test_key');
    expect(value).toBe('hello world');
  });

  it('should set and get a JSON value', () => {
    const obj = { name: 'test', count: 42, nested: { deep: true } };
    setKv('test_json', obj);
    const value = getKv('test_json');
    expect(value).toEqual(obj);
  });

  it('should overwrite an existing key', () => {
    setKv('test_key', 'original');
    setKv('test_key', 'updated');
    expect(getKv('test_key')).toBe('updated');
  });

  it('should return null for non-existent key', () => {
    expect(getKv('nonexistent_key_xyz')).toBeNull();
  });

  it('should delete a key', () => {
    setKv('to_delete', 'bye');
    deleteKv('to_delete');
    expect(getKv('to_delete')).toBeNull();
  });

  it('should list KV entries with prefix', () => {
    setKv('prefix_test_1', 'a');
    setKv('prefix_test_2', 'b');
    const results = listKv('prefix_test');
    expect(results.length).toBeGreaterThanOrEqual(2);
    results.forEach(r => {
      expect(r.key).toMatch(/^prefix_test/);
    });
  });
});

// ─── Skills CRUD ────────────────────────────────────────────
describe('Skills CRUD', () => {
  const skillId = uuidv4();

  it('should create a skill', () => {
    const result = createSkill({
      id: skillId,
      name: 'Test Skill',
      command: 'echo hello',
      description: 'A test skill',
      content: 'Some content',
      category: '测试',
      is_default: false,
    });
    expect(result.changes).toBeGreaterThanOrEqual(0);
  });

  it('should get a skill by id', () => {
    const skill = getSkill(skillId);
    expect(skill).toBeTruthy();
    expect(skill.name).toBe('Test Skill');
    expect(skill.command).toBe('echo hello');
    expect(skill.category).toBe('测试');
  });

  it('should list skills', () => {
    const skills = listSkills();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThanOrEqual(1);
  });

  it('should update a skill', () => {
    updateSkill(skillId, {
      name: 'Updated Skill',
      command: 'echo updated',
      description: 'Updated description',
      content: 'Updated content',
      category: '已更新',
    });
    const updated = getSkill(skillId);
    expect(updated.name).toBe('Updated Skill');
    expect(updated.command).toBe('echo updated');
    expect(updated.category).toBe('已更新');
  });

  it('should delete a skill', () => {
    const result = deleteSkill(skillId);
    expect(result.changes).toBeGreaterThanOrEqual(0);
    expect(getSkill(skillId)).toBeUndefined();
  });
});

// ─── Alert Configs CRUD ─────────────────────────────────────
describe('Alert Configs CRUD', () => {
  const machineId = uuidv4();
  const configId = uuidv4();

  beforeAll(() => {
    upsertMachine({
      id: machineId,
      type: 'local',
      name: 'AlertTest Machine',
      host: 'localhost',
      port: 22,
      ssh_user: 'test',
      log_path: '/var/log',
    });
  });

  it('should upsert an alert config', () => {
    const result = upsertAlertConfig({
      id: configId,
      machine_id: machineId,
      enabled: true,
      patterns: '*.log',
      severity_filter: 'error',
      cooldown_minutes: 5,
      webhook_url: 'https://hooks.example.com/webhook',
    });
    expect(result.changes).toBeGreaterThanOrEqual(0);
  });

  it('should get alert config by machine_id', () => {
    const config = getAlertConfig(machineId);
    expect(config).toBeTruthy();
    expect(config.enabled).toBe(1);
    expect(config.patterns).toBe('*.log');
    expect(config.webhook_url).toBe('https://hooks.example.com/webhook');
  });

  it('should list alert configs', () => {
    const configs = listAlertConfigs();
    expect(Array.isArray(configs)).toBe(true);
    expect(configs.length).toBeGreaterThanOrEqual(1);
  });

  it('should update alert config via upsert', () => {
    upsertAlertConfig({
      id: configId,
      machine_id: machineId,
      enabled: false,
      patterns: '*.error.log',
      severity_filter: 'fatal',
      cooldown_minutes: 10,
      webhook_url: 'https://hooks.example.com/new-webhook',
    });
    const updated = getAlertConfig(machineId);
    expect(updated.enabled).toBe(0);
    expect(updated.patterns).toBe('*.error.log');
    expect(updated.webhook_url).toBe('https://hooks.example.com/new-webhook');
  });
});

// ─── Database Type ──────────────────────────────────────────
describe('Database Type', () => {
  it('should return sqlite as default type', () => {
    expect(getDbType()).toBe('sqlite');
  });
});
