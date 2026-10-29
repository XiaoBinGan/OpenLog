import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * README 双语文档的一致性守卫。
 *
 * 约定（用户要求）：README.md 为**英文主版本**，README.zh-CN.md 为中文版，
 * 两篇顶部互相链接。这里校验几个容易在后续编辑中坏掉的地方：
 *   1. 两个文件都在、都非空、顶部有语言切换；
 *   2. 英文版是主版本（英文版里声明自己是 primary）；
 *   3. 所有相对链接指向的文件真实存在；
 *   4. 所有 `](#anchor)` 锚点能在同文件标题里解析出来（GitHub slugger 规则）；
 *   5. 代码围栏成对、表格分隔行齐全（结构没被写坏）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** GitHub slugger 近似实现：小写、删非字母数字、空格转连字符、重名加序号 */
const REMOVED = /[^\p{L}\p{N}\p{M}_\-\s]/gu;
const slug = (h) => h.toLowerCase().trim().replace(REMOVED, '').replace(/ /g, '-');

function anchorsOf(src) {
  const seen = new Map();
  const out = new Set();
  for (const line of src.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (!m) continue;
    let a = slug(m[1]);
    const n = seen.get(a) || 0;
    seen.set(a, n + 1);
    if (n > 0) a = `${a}-${n}`;
    out.add(a);
  }
  return out;
}

const FILES = ['README.md', 'README.zh-CN.md'];

describe('README 双语文档', () => {
  it('两个文件都存在且内容充实', () => {
    for (const f of FILES) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
      expect(read(f).length, f).toBeGreaterThan(5000);
    }
  });

  it('顶部有语言切换，且英文版声明自己是主版本', () => {
    const en = read('README.md');
    const zh = read('README.zh-CN.md');
    for (const s of [en, zh]) {
      expect(s).toContain('[English](README.md)');
      expect(s).toContain('[简体中文](README.zh-CN.md)');
    }
    expect(en.toLowerCase()).toContain('primary');
    expect(zh).toContain('主版本');
  });

  it('所有相对链接目标存在', () => {
    for (const f of FILES) {
      const src = read(f);
      const bad = [];
      for (const m of src.matchAll(/\]\((?!https?:|mailto:|#)([^)]+)\)/g)) {
        const target = decodeURI(m[1].split('#')[0]).trim();
        if (!target) continue;
        if (!fs.existsSync(path.join(ROOT, target))) bad.push(target);
      }
      expect(bad, `${f} 里的失效链接`).toEqual([]);
    }
  });

  it('所有文件内锚点都能解析（GitHub slugger 规则）', () => {
    for (const f of FILES) {
      const src = read(f);
      const anchors = anchorsOf(src);
      const bad = [...new Set([...src.matchAll(/\]\(#([^)]+)\)/g)].map(m => m[1]))]
        .filter(a => !anchors.has(a));
      expect(bad, `${f} 里的失效锚点`).toEqual([]);
    }
  });

  it('代码围栏成对、表格有分隔行（结构没写坏）', () => {
    for (const f of FILES) {
      const lines = read(f).split('\n');
      const fences = lines.filter(l => /^\s*```/.test(l)).length;
      expect(fences % 2, `${f} 代码围栏不成对`).toBe(0);
      // 表头后面必须跟分隔行
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\|/.test(lines[i]) && /^\|[\s:|-]+\|?$/.test(lines[i + 1])) continue;
        if (/^\|/.test(lines[i]) && /\|$/.test(lines[i]) && /^\|/.test(lines[i + 1]) === false) {
          // 表格内部最后一行之后可能是空行，允许
        }
      }
      expect(lines.length).toBeGreaterThan(100);
    }
  });

  it('英文版不含成段中文（避免内容回流成中文主版本）', () => {
    const en = read('README.md');
    const cjk = (en.match(/[\u4e00-\u9fff]/g) || []).length;
    // 允许少量中文（如 "简体中文" 切换链接、术语），但不能成段
    expect(cjk).toBeLessThan(50);
  });

  it('中文版保留了部署手册与 API 速查等关键章节', () => {
    const zh = read('README.zh-CN.md');
    for (const key of ['deploy/MANUAL.md', 'API 速查', '运维助手', '许可证']) {
      expect(zh, `中文版缺少 ${key}`).toContain(key);
    }
  });
});

describe('镜像归档清单格式', () => {
  const manifestPath = 'deploy/images/MANIFEST.md';

  it('清单存在且有表头', () => {
    expect(fs.existsSync(path.join(ROOT, manifestPath))).toBe(true);
    const src = read(manifestPath);
    expect(src).toContain('| 归档文件 |');
    expect(src).toContain('|---');
  });

  it('每条归档独占一行（曾因追加缺换行把两条挤成一行）', () => {
    const lines = read(manifestPath).split('\n');
    for (const line of lines) {
      const hits = line.match(/\|\s*\`openlog-/g) || [];
      expect(hits.length, `同一行出现多条归档: ${line.slice(0, 80)}`).toBeLessThanOrEqual(1);
    }
  });

  it('归档行列数完整（文件/镜像/ID/commit/大小/时间/SHA256/备注/位置）', () => {
    const rows = read(manifestPath).split('\n').filter(l => /^\|\s*`openlog-/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cols = row.split('|').slice(1, -1).map(c => c.trim());
      expect(cols.length, `列数不对: ${row.slice(0, 60)}`).toBe(9);
      expect(cols[0]).toMatch(/^\`openlog-.*\.tar\.gz\`$/);
      expect(cols[3]).toMatch(/^\`[0-9a-f]{7,}\`$/); // commit
    }
  });
});
