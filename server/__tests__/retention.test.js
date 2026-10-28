import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 保留策略与 WAL checkpoint —— 之前完全缺失：
 * `logPersistenceMaxAge` 只在手动端点里用到，没有定时任务，
 * 开了日志持久化 + 几千台机器时 log_records 会无限增长。
 *
 * 用独立临时库跑，不碰真实数据。
 */
const TMP = path.join(os.tmpdir(), `openlog-retention-${Date.now()}`);

let db;
let dbApi;

beforeAll(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  process.env.OPENLOG_DATA_DIR = TMP;
  dbApi = await import('../db/index.js');
  db = await dbApi.initDb();
  // log_records 有外键指向 machines
  dbApi.upsertMachine({ id: 'm1', type: 'docker', name: '机器1', host: 'h', port: 22, ssh_user: 'u', log_path: '/var/log' });
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const nowSec = () => Math.floor(Date.now() / 1000);

describe('pruneOldRecords —— 日志保留', () => {
  it('删掉超过保留天数的日志，保留新日志', async () => {
    const oldMs = (nowSec() - 10 * 86400) * 1000;   // 10 天前
    const newMs = nowSec() * 1000;                  // 现在
    for (let i = 0; i < 5; i++) {
      dbApi.insertLogRecord({ id: `old-${i}`, machine_id: 'm1', source_type: 'docker', source_name: 'c', content: 'x', severity: 'error', timestamp: oldMs });
      dbApi.insertLogRecord({ id: `new-${i}`, machine_id: 'm1', source_type: 'docker', source_name: 'c', content: 'y', severity: 'error', timestamp: newMs });
    }
    const res = await dbApi.pruneOldRecords({ logDays: 7 });
    expect(res.logs).toBe(5);
    const remaining = await dbApi.listLogRecords({ limit: 100 });
    expect(remaining).toHaveLength(5);
    expect(remaining.every(r => String(r.id).startsWith('new-'))).toBe(true);
  });

  it('保留天数为 0 时不动（显式关闭）', async () => {
    const before = (await dbApi.listLogRecords({ limit: 1000 })).length;
    await dbApi.pruneOldRecords({ logDays: 0, analysisDays: 0 });
    const after = (await dbApi.listLogRecords({ limit: 1000 })).length;
    expect(after).toBe(before);
  });

  it('timestamp 为空的旧记录用 created_at 兜底清理', async () => {
    // 直接插一条 timestamp 为 NULL 的记录（模拟历史数据）
    await db.run(
      `INSERT INTO log_records (id, machine_id, source_type, source_name, content, severity, timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      'null-ts', 'm1', 'docker', 'c', 'z', 'error', nowSec() - 30 * 86400,
    );
    const res = await dbApi.pruneOldRecords({ logDays: 7 });
    expect(res.logs).toBeGreaterThanOrEqual(1);
    const rows = await dbApi.listLogRecords({ limit: 1000 });
    expect(rows.some(r => r.id === 'null-ts')).toBe(false);
  });

  it('同时清理过期分析记录', async () => {
    // analysis_records 有外键指向 log_records（且 ON DELETE CASCADE），
    // 所以这里用一条「新日志」+「老分析」，单独验证分析的保留天数。
    const nowMs = nowSec() * 1000;
    dbApi.insertLogRecord({ id: 'log-for-analysis', machine_id: 'm1', source_type: 'docker', source_name: 'c', content: 'q', severity: 'error', timestamp: nowMs });
    await db.run(
      `INSERT INTO analysis_records (id, log_record_id, machine_id, diagnosis, suggestion, severity, model, token_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'a-old', 'log-for-analysis', 'm1', 'd', 's', 'error', 'm', 10, nowSec() - 40 * 86400,
    );
    const res = await dbApi.pruneOldRecords({ logDays: 7, analysisDays: 30 });
    expect(res.analyses).toBeGreaterThanOrEqual(1);
    const left = await db.get(`SELECT COUNT(*) AS n FROM analysis_records WHERE id = 'a-old'`);
    expect(Number(left.n)).toBe(0);
  });
});

describe('checkpoint —— WAL 收敛', () => {
  it('SQLite 下执行成功', async () => {
    const ok = await dbApi.checkpoint();
    expect(ok).toBe(true);
  });
});
