/**
 * 导出回归测试（2026-11-06 用户报「Excel 无法导出 / 机器要显示 IP」）
 *
 * 两个 bug：
 *   1. zipStore 用 push(...大数组) 铺字节 → 150 条通知起就
 *      RangeError: Maximum call stack size exceeded，导出静默失败；
 *   2. 「机器」列只有机器名（「4090服务器」），用户要的是 IP。
 */
import { describe, it, expect } from 'vitest';
import { buildExportRows, toXlsx, toCsv, toMarkdown, zipStore, crc32 } from './notifyExport';
import type { NotificationItem } from '../contexts/ToastContext';

const NOW = new Date('2026-11-04T17:30:00').getTime();

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1', type: 'error', message: '普通提示', ts: NOW, read: false, ...over,
  } as NotificationItem;
}

/** 造 n 条「真实体量」的告警：报错原文都带多行，体积和线上接近 */
function bulk(n: number, host = '203.0.113.10'): NotificationItem[] {
  return Array.from({ length: n }, (_, i) => item({
    id: `n${i}`,
    message: `🐳 openlog-pg · ERROR`,
    description: 'ERROR [db] connection refused',
    ts: NOW - i * 1000,
    sourceId: 'srv-a',
    sourceName: '4090服务器',
    sourceHost: host,
    containerName: 'openlog-pg',
    containerId: 'abc123def456',
    level: 'ERROR',
    errorType: '日志异常',
    errorContent: `ERROR [db] FATAL: connection refused to db:5432 (pool exhausted)\n  at pg.js:120\n  at pool.js:44\n  retry 3/5 failed`,
    nav: '/docker?sourceId=srv-a&containerId=abc123def456&openLog=1',
  }));
}

describe('Excel 导出不再因数据量大而崩（回归）', () => {
  it('10 条正常产出 xlsx', () => {
    const bytes = toXlsx(bulk(10), NOW);
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
  });

  it('150 条（旧实现从这里开始崩）能正常导出', () => {
    expect(() => toXlsx(bulk(150), NOW)).not.toThrow();
  });

  it('500 条 / 2000 条都能导出（通知上限 200，留足余量）', () => {
    const b500 = toXlsx(bulk(500), NOW);
    expect(b500.length).toBeGreaterThan(100_000);
    expect(() => toXlsx(bulk(2000), NOW)).not.toThrow();
  });

  it('超长报错内容（单条 1 万字）也不崩', () => {
    const big = [item({
      sourceHost: '10.0.0.1', sourceName: 'srv', level: 'ERROR',
      errorContent: 'E'.repeat(10_000),
    })];
    expect(() => toXlsx(big, NOW)).not.toThrow();
  });

  it('zipStore 偏移计算正确（自己解一遍能读回所有部件）', () => {
    const enc = new TextEncoder();
    const parts = [
      { name: 'a.txt', data: enc.encode('hello') },
      { name: 'dir/b.xml', data: enc.encode('<x/>') },
    ];
    const zip = zipStore(parts);
    // 局部文件头签名
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    // EOCD 在末尾 22 字节，条目数应 = 2
    const eocd = zip.length - 22;
    const dv = new DataView(zip.buffer);
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
    // 中央目录偏移处应是中央目录签名
    const cdOffset = dv.getUint32(eocd + 16, true);
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);
    // 两个部件的名字都能在字节里找到
    const text = new TextDecoder('latin1').decode(zip);
    expect(text).toContain('a.txt');
    expect(text).toContain('dir/b.xml');
  });

  it('crc32 对已知输入结果稳定（避免手改后悄悄错位）', () => {
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686);
  });
});

describe('「机器」列改成 IP（用户要求）', () => {
  it('有 sourceHost 时机器列是 IP', () => {
    const [r] = buildExportRows([item({ sourceName: '4090服务器', sourceHost: '203.0.113.10' })], NOW);
    expect(r.machine).toBe('203.0.113.10');
    expect(r.machineName).toBe('4090服务器');
  });

  it('local 源也给出 IP，而不是「本机 Docker」', () => {
    const [r] = buildExportRows([item({ sourceId: 'local', sourceHost: '203.0.113.10' })], NOW);
    expect(r.machine).toBe('203.0.113.10');
  });

  it('老通知没有 host 时退回机器名（不出现空白列）', () => {
    const [r] = buildExportRows([item({ sourceName: '4090服务器' })], NOW);
    expect(r.machine).toBe('4090服务器');
    expect(r.machineName).toBe('4090服务器');
  });

  it('什么都没有时至少给出 sourceId，不退化成空', () => {
    const [r] = buildExportRows([item({ sourceId: 'srv-x' })], NOW);
    expect(r.machine).toBe('srv-x');
  });

  it('CSV 表头是「机器IP,机器名」', () => {
    const csv = toCsv([item({ sourceHost: '10.0.0.5', sourceName: '双卡T4' })], NOW);
    expect(csv).toContain('序号,时间,级别,机器IP,机器名');
    expect(csv).toContain('10.0.0.5');
    expect(csv).toContain('双卡T4');
  });

  it('Markdown 概览表与明细都写出 IP', () => {
    const md = toMarkdown([item({ sourceHost: '10.0.0.5', sourceName: '双卡T4', sourceId: 'srv-b' })], { now: NOW });
    expect(md).toContain('| 机器 IP | 机器名 |');
    expect(md).toContain('10.0.0.5');
    expect(md).toContain('- **机器**：10.0.0.5（双卡T4）');
  });

  it('xlsx 表头含机器IP/机器名两列，数据行含 IP', () => {
    const text = new TextDecoder().decode(toXlsx([item({ sourceHost: '10.0.0.5', sourceName: '双卡T4' })], NOW));
    expect(text).toContain('机器IP');
    expect(text).toContain('机器名');
    expect(text).toContain('10.0.0.5');
  });
});

describe('导出失败必须有可见反馈（接线）', () => {
  it('NotificationCenter 捕获异常后弹 toast，不再只 console.error', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('client/src/components/NotificationCenter.tsx', 'utf8');
    expect(src).toContain('toastError(`导出失败');
    expect(src).toContain('toastWarning(\'没有可导出的通知\')');
  });
});
