// @vitest-environment jsdom
/**
 * 前端 XSS 防线的回归测试。
 *
 * 背景：client 里有 11 处 dangerouslySetInnerHTML，渲染的都是**不可信内容** ——
 * LLM 回复、容器日志、远程命令输出、用户上传的日志行。这些内容可以被
 * 服务器上的进程、被投毒的日志、或者模型自己产生。
 *
 * 修复方式是在源头 sanitize：markdown / ANSI 渲染函数内部调用 sanitizeHtml()，
 * 所以下游的 dangerouslySetInnerHTML 拿到的已经是干净字符串。
 *
 * 这个文件存在的意义是：sanitizeHtml 是**唯一**的那道闸门，
 * 一旦它的配置被放宽（比如为了支持某个标签而把 ALLOWED_TAGS 打开），
 * 11 个 sink 会同时失守。所以这里用真实攻击载荷钉住它。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeHtml, isSafeHref } from '../client/src/utils/sanitize';

/**
 * 每条：攻击载荷 → 结果里**不允许**出现的东西。
 *
 * 断言"危险子串不存在"而不是"等于某个精确字符串"，
 * 因为 DOMPurify 的输出形态可能随版本变化，但攻击面不该变化。
 */
const XSS_PAYLOADS: Array<[string, string[]]> = [
  ['<script>alert(1)</script>', ['<script', 'alert(1)']],
  ['<img src=x onerror=alert(1)>', ['onerror', 'alert(1)']],
  ['<img src=x ONERROR=alert(1)>', ['ONERROR', 'onerror', 'alert(1)']],
  ['<svg onload=alert(1)></svg>', ['onload', 'alert(1)']],
  ['<svg/onload=alert(1)>', ['onload', 'alert(1)']],
  ['<body onload=alert(1)>', ['onload', 'alert(1)']],
  ['<iframe src="javascript:alert(1)"></iframe>', ['<iframe', 'javascript:']],
  ['<a href="javascript:alert(1)">click</a>', ['javascript:']],
  ['<a href="JaVaScRiPt:alert(1)">click</a>', ['avascript:', 'alert(1)']],
  ['<a href="data:text/html,<script>alert(1)</script>">x</a>', ['<script', 'data:text/html']],
  ['<div onmouseover="alert(1)">hover</div>', ['onmouseover']],
  ['<form><button formaction="javascript:alert(1)">go</button></form>', ['formaction', 'javascript:']],
  ['<input onfocus=alert(1) autofocus>', ['onfocus', 'alert(1)']],
  ['<style>body{background:url("javascript:alert(1)")}</style>', ['<style', 'javascript:']],
  ['<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">', ['<object']],
  ['<embed src="javascript:alert(1)">', ['<embed', 'javascript:']],
  ['<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', ['<meta']],
  ['<base href="javascript:alert(1)//">', ['<base']],
  ['<link rel="stylesheet" href="javascript:alert(1)">', ['<link']],
  // mXSS：靠浏览器解析器重排绕过朴素的正则过滤
  [
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
    ['onerror', 'alert(1)'],
  ],
  ['<noscript><p title="</noscript><img src=x onerror=alert(1)>">', ['onerror', 'alert(1)']],
  // 事件处理器的大小写/空白变体
  ['<img src=x onerror\n=alert(1)>', ['onerror']],
  ['<img src=x onerror = "alert(1)">', ['onerror']],
  // 用 <a> 绕过协议白名单
  ['<a href="vbscript:msgbox(1)">x</a>', ['vbscript:']],
  ['<a href="  javascript:alert(1)">x</a>', ['javascript:']],
  ['<a href="java\tscript:alert(1)">x</a>', ['alert(1)']],
  // 协议相对 URL：DOMPurify 的 ALLOWED_URI_REGEXP **会放行**（它以 / 开头，
  // 走了"相对路径"分支），只有 sanitize.ts 自己的 isSafeHref hook 能拦住。
  // 缺了这条载荷时，把 hook 删掉整个测试套仍然全绿 —— 实测确认过。
  ['<a href="//evil.example/x">click</a>', ['evil.example']],
  ['<a href="\\\\evil.example\\x">click</a>', ['evil.example']],
];

describe('sanitizeHtml — 真实攻击载荷必须被清除', () => {
  for (const [payload, forbidden] of XSS_PAYLOADS) {
    it(`清除: ${payload.slice(0, 58)}`, () => {
      const out = sanitizeHtml(payload);
      for (const bad of forbidden) {
        expect(out.toLowerCase(), `载荷残留了 ${bad}`).not.toContain(bad.toLowerCase());
      }
    });
  }
});

describe('sanitizeHtml — 正常内容必须保留', () => {
  it('保留基本排版标签', () => {
    const html = '<p>hello <strong>bold</strong> <em>italic</em> <code>x=1</code></p>';
    const out = sanitizeHtml(html);
    expect(out).toContain('<strong>');
    expect(out).toContain('<em>');
    expect(out).toContain('<code>');
    expect(out).toContain('hello');
  });

  it('保留表格（LLM 回复与巡检报告会用）', () => {
    const html = '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
    const out = sanitizeHtml(html);
    expect(out).toContain('<table>');
    expect(out).toContain('<th>');
    expect(out).toContain('<td>');
  });

  it('保留 https 链接', () => {
    const out = sanitizeHtml('<a href="https://example.com/a?b=1">link</a>');
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(out).toContain('link');
  });

  it('保留 markdown 生成的列表与代码块', () => {
    const out = sanitizeHtml('<ul><li>a</li></ul><pre><code>echo hi</code></pre>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>');
    expect(out).toContain('<pre>');
  });

  it('剥掉事件处理器但保留元素本身（KEEP_CONTENT）', () => {
    const out = sanitizeHtml('<span onclick="alert(1)">kept</span>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('kept');
  });
});

describe('sanitizeHtml — 边界输入 fail closed', () => {
  it('空输入返回空串', () => {
    expect(sanitizeHtml('')).toBe('');
  });

  it('非字符串输入返回空串', () => {
    // @ts-expect-error 故意传错类型
    expect(sanitizeHtml(null)).toBe('');
    // @ts-expect-error 故意传错类型
    expect(sanitizeHtml(undefined)).toBe('');
    // @ts-expect-error 故意传错类型
    expect(sanitizeHtml(123)).toBe('');
  });

  it('纯文本原样保留（不会把内容吃掉）', () => {
    expect(sanitizeHtml('just text 中文')).toBe('just text 中文');
  });
});

describe('isSafeHref — 挡住 DOMPurify 自己会放行的协议相对 URL', () => {
  it('放行同源引用与显式 http(s)/mailto/tel', () => {
    for (const ok of [
      'https://example.com/a?b=1', 'http://example.com', 'mailto:a@b.c', 'tel:+1234',
      '/root/relative', 'path/relative', '?query=1', '#fragment',
    ]) {
      expect(isSafeHref(ok), `${ok} 应放行`).toBe(true);
    }
  });

  it('拒绝协议相对 URL（外站，用于钓鱼与 referrer/token 泄漏）', () => {
    for (const bad of ['//evil.example/x', '\\\\evil.example\\x', '//evil.example', '\\\\evil.example']) {
      expect(isSafeHref(bad), `${bad} 应拒绝`).toBe(false);
    }
  });

  it('拒绝危险协议与空值', () => {
    for (const bad of [
      'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)',
      'file:///etc/passwd', 'blob:https://x/y', '', '   ',
    ]) {
      expect(isSafeHref(bad), `${bad} 应拒绝`).toBe(false);
    }
  });

  it('大小写与前后空白不影响判定', () => {
    expect(isSafeHref('  HTTPS://example.com  ')).toBe(true);
    expect(isSafeHref('  JAVASCRIPT:alert(1)  ')).toBe(false);
  });
});

describe('sanitizeHtml — 所有 dangerouslySetInnerHTML 的输入都经过它', () => {
  /**
   * 静态兜底：允许的 sink 形态是 `__html: <某个渲染函数>(...)`，
   * 而这些渲染函数的返回值都必须经过 sanitizeHtml。
   * 直接写 `__html: someRawString` 是禁止的。
   */
  const ALLOWED_RENDERERS = [
    'ansiToHtml', 'renderMarkdown', 'toMarkdownHtml', 'simpleMarkdown', 'formatContent',
  ];

  it('client/src 下没有直接把原始字符串塞进 __html 的地方', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

    function walk(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return /\.(tsx|ts)$/.test(e.name) ? [p] : [];
      });
    }

    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, 'client', 'src'))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/__html:\s*([^,}]+)/g)) {
        const expr = m[1].trim();
        // 允许：渲染函数调用、字符串字面量（如 '&nbsp;'）、或已经 sanitize 的表达式
        const ok = ALLOWED_RENDERERS.some((r) => expr.includes(r))
          || /^'[^']*'$/.test(expr)
          || expr.includes('sanitizeHtml');
        if (!ok) {
          offenders.push(`${path.relative(ROOT, file)}: __html: ${expr}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
