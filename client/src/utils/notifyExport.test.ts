/**
 * client/src/utils/notifyExport.test.ts
 *
 * 通知导出（Markdown / Excel）的数据逻辑测试。
 *
 * 用户要求：「将哪台机器什么服务什么容器报了什么错、报错内容都能够直接导出；
 * 因为是给程序员看的，所以支持 md 或者 Excel」。
 * 所以这里重点验证四个字段齐全，且生成的 md/xlsx 结构正确。
 */
import { describe, it, expect } from 'vitest';
import {
  buildExportRows, toMarkdown, toCsv, toXlsx, exportFileName, formatFullTime, colName, crc32,
} from './notifyExport';
import type { NotificationItem } from './notifications';

const NOW = new Date('2026-11-04T18:00:00').getTime();

const item = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: 'n1',
  type: 'error',
  message: '🐳 openlog-api · ERROR',
  description: 'panic: runtime error: invalid memory address',
  ts: new Date('2026-11-04T17:30:00').getTime(),
  read: false,
  ...over,
});

const fullItem = item({
  sourceId: 'srv-4090',
  sourceName: '4090服务器',
  containerName: 'openlog-api',
  containerId: 'abc123def456',
  level: 'ERROR',
  errorType: '日志异常',
  errorContent: 'panic: runtime error: invalid memory address\n\ngoroutine 1 [running]:',
  nav: '/docker?sourceId=srv-4090&containerId=abc123def456&openLog=1',
});

describe('buildExportRows —— 机器/容器/错误/内容 四要素', () => {
  it('结构化 meta 完整时四个字段都能填上', () => {
    const [r] = buildExportRows([fullItem], NOW);
    expect(r.machine).toBe('4090服务器');
    expect(r.container).toBe('openlog-api');
    expect(r.containerId).toBe('abc123def456');
    expect(r.level).toBe('ERROR');
    expect(r.errorType).toBe('日志异常');
    expect(r.content).toContain('panic: runtime error');
    expect(r.time).toBe('11-04 17:30:00');
  });

  it('老数据（无 meta）从文案里兜底解析出容器和级别', () => {
    const [r] = buildExportRows([item()], NOW);
    expect(r.container).toBe('openlog-api'); // 从「🐳 openlog-api · ERROR」解析
    expect(r.level).toBe('ERROR');
    expect(r.content).toBe('panic: runtime error: invalid memory address');
  });

  it('local 源显示为「本机 Docker」', () => {
    const [r] = buildExportRows([item({ sourceId: 'local' })], NOW);
    expect(r.machine).toBe('本机 Docker');
  });

  it('什么都没记录时字段为空但字段本身存在（导出表头不歪）', () => {
    const [r] = buildExportRows([item({ message: '普通提示', description: undefined })], NOW);
    expect(r.machine).toBe('');
    expect(r.container).toBe('');
    expect(r.content).toBe('');
    expect(r.level).toBe('ERROR'); // 由 type=error 推出
  });

  it('序号从 1 开始递增', () => {
    const rows = buildExportRows([item({ id: 'a' }), item({ id: 'b' })], NOW);
    expect(rows.map(r => r.index)).toEqual([1, 2]);
  });

  it('空列表不崩', () => {
    expect(buildExportRows([], NOW)).toEqual([]);
    expect(buildExportRows(null as any, NOW)).toEqual([]);
  });
});

describe('formatFullTime / exportFileName', () => {
  it('同年省略年份，跨年带年份', () => {
    expect(formatFullTime(new Date('2026-11-04T09:05:03').getTime(), NOW)).toBe('11-04 09:05:03');
    expect(formatFullTime(new Date('2025-12-31T23:59:59').getTime(), NOW)).toBe('2025-12-31 23:59:59');
  });

  it('文件名带日期时间与扩展名', () => {
    expect(exportFileName('md', NOW)).toBe('openlog-alerts-20261104-1800.md');
    expect(exportFileName('xlsx', NOW)).toBe('openlog-alerts-20261104-1800.xlsx');
  });
});

describe('toMarkdown —— 概览表 + 明细，报错内容保留原文', () => {
  const md = toMarkdown([fullItem, item({ id: 'n2', message: '🐳 cache · WARNING', description: 'cache miss rate high' })], { now: NOW });

  it('带标题、导出时间、条数', () => {
    expect(md).toContain('# OpenLog 告警导出');
    expect(md).toContain('告警数量：2 条');
  });

  it('概览表含 时间/级别/机器/容器/错误类型 列', () => {
    expect(md).toContain('| # | 时间 | 级别 | 机器 | 容器 | 错误类型 | 摘要 |');
    expect(md).toContain('4090服务器');
    expect(md).toContain('openlog-api');
    expect(md).toContain('日志异常');
  });

  it('明细用代码块保留报错原文（多行不被压平）', () => {
    expect(md).toContain('### 1. ERROR · 日志异常 · openlog-api');
    expect(md).toContain('```');
    expect(md).toContain('panic: runtime error: invalid memory address');
  });

  it('机器 ID / 容器 ID / 打开链接都写进去（程序员能直接定位）', () => {
    expect(md).toContain('srv-4090');
    expect(md).toContain('abc123def456');
    expect(md).toContain('/docker?sourceId=srv-4090');
  });

  it('表格里的竖线和换行被转义（否则表格会散架）', () => {
    const weird = item({ id: 'x', description: 'a | b\nc' });
    const out = toMarkdown([weird], { now: NOW });
    // 概览表单元格：换行压成空格、竖线转义
    expect(out).toContain('a \\| b');
  });

  it('报错内容里的 ``` 不会提前闭合代码块', () => {
    const withFence = item({ id: 'f', description: 'code:\n```js\nx\n```' });
    const out = toMarkdown([withFence], { now: NOW });
    const fences = (out.match(/^```$/gm) || []).length;
    expect(fences).toBe(2); // 只有我们自己加的一对
  });

  it('空列表给出明确说明', () => {
    expect(toMarkdown([], { now: NOW })).toContain('没有告警记录');
  });
});

describe('toCsv —— Excel 双击可看', () => {
  it('带 BOM 和表头，报错内容正确转义', () => {
    const csv = toCsv([fullItem], NOW);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('序号,时间,级别,机器');
    expect(csv).toContain('"panic: runtime error: invalid memory address');
  });

  it('字段里的逗号被引号包住', () => {
    const csv = toCsv([item({ id: 'c', description: 'a,b' })], NOW);
    expect(csv).toContain('"a,b"');
  });
});

describe('toXlsx —— 最小 XLSX（真实可打开的 zip 结构）', () => {
  const bytes = toXlsx([fullItem, item({ id: 'n2' })], NOW);

  it('是 ZIP 头（PK\\x03\\x04）', () => {
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4B);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });

  it('包含 xlsx 必需部件', () => {
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('xl/workbook.xml');
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(text).toContain('xl/styles.xml');
    expect(text).toContain('_rels/.rels');
  });

  it('sheet 里含表头和每条告警的数据', () => {
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('告警列表');
    expect(text).toContain('机器');
    expect(text).toContain('报错内容');
    expect(text).toContain('4090服务器');
    expect(text).toContain('openlog-api');
    expect(text).toContain('panic: runtime error');
  });

  it('XML 特殊字符被转义（否则 Excel 报文件损坏）', () => {
    const danger = item({ id: 'd', description: '<script>&"x"' });
    const text = new TextDecoder().decode(toXlsx([danger], NOW));
    expect(text).toContain('&lt;script&gt;&amp;&quot;x&quot;');
    expect(text).not.toContain('<script>');
  });

  it('控制字符被去掉（日志里偶发 \\u0000 会让 Excel 打不开）', () => {
    const dirty = item({ id: 'z', description: 'a\u0000b\u0007c' });
    const text = new TextDecoder().decode(toXlsx([dirty], NOW));
    expect(text).toContain('abc');
  });

  it('空列表也能生成合法 xlsx', () => {
    const empty = toXlsx([], NOW);
    expect(empty[0]).toBe(0x50);
    const text = new TextDecoder().decode(empty);
    expect(text).toContain('告警列表');
  });
});

describe('colName / crc32', () => {
  it('列名 A..Z, AA..', () => {
    expect(colName(0)).toBe('A');
    expect(colName(25)).toBe('Z');
    expect(colName(26)).toBe('AA');
    expect(colName(27)).toBe('AB');
  });

  it('crc32 对已知输入正确', () => {
    // "123456789" 的标准 CRC32 = 0xCBF43926
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926);
  });
});
