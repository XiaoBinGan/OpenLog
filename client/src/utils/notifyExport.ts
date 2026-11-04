/**
 * client/src/utils/notifyExport.ts —— 告警通知导出（Markdown / Excel）
 *
 * 需求（用户原话）：「需要再消息通知里加上导出的功能，这样就能将哪台机器
 * 什么服务什么容器报了什么错、报错内容都能够直接导出了；因为是给程序员看的，
 * 所以导出支持 md 或者 Excel」。
 *
 * 所以每一行都要能回答四个问题：**哪台机器 / 哪个服务（容器）/ 什么错 / 报错内容**。
 * 这里全是纯函数（不碰 DOM），方便单测；真正的下载动作放在组件里。
 *
 * 注：不引入 exceljs 这类重依赖（离线安装包要能小），Excel 用最小 XLSX 写入器：
 * 只有一个 sheet、单元格用 inlineStr、ZIP 用 store（不压缩）。Excel/WPS 都能正常打开。
 */

import { formatNotificationTime, type NotificationItem } from './notifications';

export interface ExportRow {
  index: number;
  time: string;
  ts: number;
  level: string;
  machine: string;
  sourceId: string;
  container: string;
  containerId: string;
  errorType: string;
  content: string;
  nav: string;
}

/**
 * 把通知整理成导出用的行。
 * 老数据（没有 meta 的）从文案里兜底解析：message 形如「🐳 openlog-site · ERROR」。
 */
export function buildExportRows(items: NotificationItem[], now = Date.now()): ExportRow[] {
  return (items || []).map((n, i) => {
    const message = String(n.message || '');
    const parsed = message.match(/🐳\s*(.+?)\s*·\s*(\S+)/);
    const containerFromMsg = parsed ? parsed[1].trim() : '';
    const levelFromMsg = parsed ? parsed[2].trim() : '';
    const level = n.level || levelFromMsg || levelFromType(n.type);
    const container = n.containerName || containerFromMsg || '';
    const content = n.errorContent || n.description || '';
    return {
      index: i + 1,
      time: formatFullTime(n.ts, now),
      ts: n.ts,
      level,
      machine: n.sourceName || (n.sourceId === 'local' ? '本机 Docker' : '') || '',
      sourceId: n.sourceId || '',
      container,
      containerId: n.containerId || '',
      errorType: n.errorType || '',
      content,
      nav: n.nav || '',
    };
  });
}

function levelFromType(type: string): string {
  if (type === 'error') return 'ERROR';
  if (type === 'warning') return 'WARNING';
  return 'INFO';
}

/** 导出用时间：YYYY-MM-DD HH:mm:ss（Excel/MD 都通用） */
export function formatFullTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  const date = `${sameYear ? '' : `${d.getFullYear()}-`}${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 导出文件名：openlog-alerts-20261104-1800.md */
export function exportFileName(ext: 'md' | 'xlsx' | 'csv', now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `openlog-alerts-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

// ─── Markdown ─────────────────────────────────────────────────────────────

/** 表格单元格里不能有换行/竖线 */
function mdCell(s: string): string {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * 生成 Markdown 报告：
 *   - 开头是概览表（一行一条告警，程序员 scan 用）
 *   - 后面是逐条明细（报错内容用代码块包起来，保留原始格式）
 */
export function toMarkdown(items: NotificationItem[], opts: { now?: number; title?: string } = {}): string {
  const now = opts.now ?? Date.now();
  const rows = buildExportRows(items, now);
  const lines: string[] = [];
  lines.push(`# ${opts.title || 'OpenLog 告警导出'}`);
  lines.push('');
  lines.push(`- 导出时间：${formatFullTime(now, now)}`);
  lines.push(`- 告警数量：${rows.length} 条`);
  lines.push('');
  if (rows.length === 0) {
    lines.push('> 没有告警记录。');
    return lines.join('\n') + '\n';
  }
  lines.push('## 概览');
  lines.push('');
  lines.push('| # | 时间 | 级别 | 机器 | 容器 | 错误类型 | 摘要 |');
  lines.push('|---|------|------|------|------|----------|------|');
  for (const r of rows) {
    const summary = mdCell(r.content.split('\n')[0] || '').slice(0, 120);
    lines.push(`| ${r.index} | ${r.time} | ${mdCell(r.level)} | ${mdCell(r.machine)} | ${mdCell(r.container)} | ${mdCell(r.errorType)} | ${summary} |`);
  }
  lines.push('');
  lines.push('## 明细');
  for (const r of rows) {
    lines.push('');
    lines.push(`### ${r.index}. ${r.level}${r.errorType ? ` · ${r.errorType}` : ''}${r.container ? ` · ${r.container}` : ''}`);
    lines.push('');
    lines.push(`- **时间**：${r.time}`);
    lines.push(`- **机器**：${r.machine || '未记录'}${r.sourceId ? `（${r.sourceId}）` : ''}`);
    lines.push(`- **容器**：${r.container || '未记录'}${r.containerId ? `（${r.containerId}）` : ''}`);
    if (r.errorType) lines.push(`- **错误类型**：${r.errorType}`);
    if (r.content) {
      lines.push('- **报错内容**：');
      lines.push('');
      lines.push('```');
      lines.push(r.content.replace(/```/g, '`\u200b``'));
      lines.push('```');
    }
    if (r.nav) lines.push(`- **打开**：\`${r.nav}\``);
  }
  return lines.join('\n') + '\n';
}

// ─── CSV（顺带提供：Excel 双击也能直接看）─────────────────────────────────

function csvCell(s: string): string {
  const v = String(s ?? '');
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(items: NotificationItem[], now = Date.now()): string {
  const rows = buildExportRows(items, now);
  const header = ['序号', '时间', '级别', '机器', '来源ID', '容器', '容器ID', '错误类型', '报错内容', '打开链接'];
  const lines = [header.map(h => csvCell(h)).join(',')];
  for (const r of rows) {
    lines.push([r.index, r.time, r.level, r.machine, r.sourceId, r.container, r.containerId, r.errorType, r.content, r.nav]
      .map(v => csvCell(String(v))).join(','));
  }
  // BOM：Excel 打开 UTF-8 CSV 不乱码
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ─── XLSX（最小写入器）────────────────────────────────────────────────────

const XLSX_HEADERS = ['序号', '时间', '级别', '机器', '来源ID', '容器', '容器ID', '错误类型', '报错内容', '打开链接'];

/** 去掉 XML 1.0 不允许的控制字符（日志里偶发 \u0000 会让 Excel 打不开文件） */
function stripInvalidXmlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const allowed = code === 0x09 || code === 0x0A || code === 0x0D || code >= 0x20;
    if (allowed) out += ch;
  }
  return out;
}

function xmlEscape(s: string): string {
  return stripInvalidXmlChars(String(s ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0 → A, 25 → Z, 26 → AA */
export function colName(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function sheetXml(rows: string[][]): string {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
  rows.forEach((cells, r) => {
    parts.push(`<row r="${r + 1}">`);
    cells.forEach((value, c) => {
      const ref = `${colName(c)}${r + 1}`;
      parts.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`);
    });
    parts.push('</row>');
  });
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="告警列表" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

// ── ZIP（store，无压缩）──
let crcTable: Uint32Array | null = null;
function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) crcTable = makeCrcTable();
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = (crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

interface ZipEntry { name: string; data: Uint8Array }

/** 最小 ZIP 写入（method=0 store）；Excel 对 store 完全兼容 */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: number[] = [];
  const central: number[] = [];
  const push = (arr: number[]) => chunks.push(...arr);
  const u16 = (v: number) => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = (v: number) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

  let offset = 0;
  const d = new Date();
  const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xFFFF;
  const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const localOffset = offset;
    const header = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    push(header);
    chunks.push(...nameBytes);
    push([...entry.data]);
    offset += header.length + nameBytes.length + entry.data.length;
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(dosTime), ...u16(dosDate), ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(localOffset));
    central.push(...nameBytes);
  }
  const cdOffset = offset;
  const cdSize = central.length;
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(cdOffset), ...u16(0)];
  return new Uint8Array([...chunks, ...central, ...eocd]);
}

/**
 * 生成 .xlsx 文件内容（Uint8Array）。
 * 一个 sheet「告警列表」，表头 + 每条告警一行。
 */
export function toXlsx(items: NotificationItem[], now = Date.now()): Uint8Array {
  const rows = buildExportRows(items, now);
  const table: string[][] = [XLSX_HEADERS];
  for (const r of rows) {
    table.push([
      String(r.index), r.time, r.level, r.machine, r.sourceId,
      r.container, r.containerId, r.errorType, r.content, r.nav,
    ]);
  }
  const enc = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: enc.encode(WORKBOOK) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', data: enc.encode(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml(table)) },
  ]);
}
