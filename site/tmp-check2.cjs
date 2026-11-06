/* 临时自检 2：起本地静态服务器 + jsdom 走 http 源，验证静态托管取得到、localStorage 持久化。用完删除。 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve('D:/project/openlog/site');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('404'); }
  res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));

  const dom = await JSDOM.fromURL(base + '/index.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      if (!window.matchMedia) {
        window.matchMedia = function () {
          return { matches: false, addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {}, removeListener: function () {} };
        };
      }      Object.defineProperty(window.navigator, 'language', { get: () => 'en-US', configurable: true });
      Object.defineProperty(window.navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
    }
  });
  const w = dom.window;
  const d = w.document;
  await wait(1200);

  console.log('=== navigator=en-US 首访（应自动英文） ===');
  console.log('html lang:', d.documentElement.getAttribute('lang'));
  console.log('nav:', [...d.querySelectorAll('.nav-links a')].map((a) => norm(a.textContent)).join(' | '));
  console.log('hero h1:', norm(d.querySelector('.hero h1').textContent));
  console.log('chips:', [...d.querySelectorAll('.chips li')].map((x) => norm(x.textContent)).join(' | '));
  console.log('localStorage 写入:', w.localStorage.getItem('openlog_site_lang'));
  console.log('en 按钮 active:', d.querySelector('[data-lang="en"]').classList.contains('is-active'));

  console.log('\n=== 切到中文 ===');
  d.querySelector('[data-lang="zh"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(200);
  console.log('html lang:', d.documentElement.getAttribute('lang'));
  console.log('nav:', [...d.querySelectorAll('.nav-links a')].map((a) => norm(a.textContent)).join(' | '));
  console.log('hero h1:', norm(d.querySelector('.hero h1').textContent));
  console.log('localStorage:', w.localStorage.getItem('openlog_site_lang'));
  console.log('zh 按钮 active:', d.querySelector('[data-lang="zh"]').classList.contains('is-active'));

  console.log('\n=== 轮播 / cine（app.js 运行态） ===');
  console.log('deck caption 标题:', norm(d.querySelector('#deck-caption b').textContent));
  console.log('deck caption 描述:', norm(d.querySelector('#deck-caption span').textContent));
  console.log('deck 圆点数:', d.querySelectorAll('#deck-dots button').length,
    ' 首个 aria-label:', d.querySelector('#deck-dots button').getAttribute('aria-label'));
  console.log('cine 帧 steps em 数:', d.querySelectorAll('.cine-frame .steps li em').length);
  console.log('cine 提示:', norm(d.querySelector('#cine-hint').textContent));
  console.log('导航按钮 aria:', d.querySelector('#nav-burger').getAttribute('aria-label'));

  // 点下一张，caption 应跟着换
  d.querySelector('#deck-next').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(120);
  console.log('下一张 caption:', norm(d.querySelector('#deck-caption b').textContent));
  console.log('url path:', norm(d.querySelector('#url-path').textContent));

  console.log('\n=== 再切英文，验证卡片/表格/页脚 ===');
  d.querySelector('[data-lang="en"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(200);
  console.log('deck caption:', norm(d.querySelector('#deck-caption b').textContent));
  console.log('fde 卡片首行:', norm(d.querySelector('.fde-card-body .c-line').textContent));
  console.log('规模表格头:', [...d.querySelectorAll('.tbl .th span')].map((x) => norm(x.textContent)).join(' | '));
  console.log('roadmap 第三组:', norm(d.querySelectorAll('.road h3')[2].textContent));
  console.log('cta 按钮:', norm(d.querySelector('.cta-actions a').textContent));
  console.log('nav burger aria:', d.querySelector('#nav-burger').getAttribute('aria-label'));

  console.log('\n=== 二次加载（localStorage=en 已存） ===');
  const dom2 = await JSDOM.fromURL(base + '/index.html', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      // 复制 localStorage（jsdom 每个窗口独立，这里直接注入）
      if (!window.matchMedia) {
        window.matchMedia = function () {
          return { matches: false, addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {}, removeListener: function () {} };
        };
      }      Object.defineProperty(window.navigator, 'language', { get: () => 'zh-CN', configurable: true });
      window.localStorage.setItem('openlog_site_lang', 'en');
    }
  });
  await wait(1200);
  console.log('重复访问 html lang（应保持 en，覆盖 zh-CN 猜测）:', dom2.window.document.documentElement.getAttribute('lang'));
  console.log('nav 首项:', norm(dom2.window.document.querySelector('.nav-links a').textContent));

  console.log('\n=== 错误 ===');
  console.log(errors.length ? errors.slice(0, 5) : '无');

  server.close();
});