/* OpenLog 官网交互：轮播图 + 滚动渐入 + 导航状态 */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- i18n 辅助（i18n.js 缺席时退回中文硬编码） ---------- */
  function T(key, fallback) {
    var i18n = window.OpenLogI18n;
    var v = i18n && i18n.t ? i18n.t(key) : '';
    return v || fallback || '';
  }
  function TP(key, vars, fallback) {
    var i18n = window.OpenLogI18n;
    var v = i18n && i18n.format ? i18n.format(key, vars) : '';
    return v || fallback || '';
  }
  function syncAria() {
    if (window.OpenLogI18n && window.OpenLogI18n.refreshAria) window.OpenLogI18n.refreshAria();
  }

  /* ---------- 导航滚动状态 ---------- */
  var nav = document.getElementById('nav');
  function onScroll() {
    if (!nav) return;
    nav.classList.toggle('scrolled', window.scrollY > 8);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- 移动端导航菜单 ---------- */
  var burger = document.getElementById('nav-burger');
  var navLinks = document.getElementById('nav-links');
  function setMenu(open) {
    if (!nav || !burger) return;
    nav.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncAria();
  }
  if (nav && burger && navLinks) {
    burger.addEventListener('click', function () {
      setMenu(!nav.classList.contains('open'));
    });
    Array.prototype.forEach.call(navLinks.querySelectorAll('a'), function (a) {
      a.addEventListener('click', function () { setMenu(false); });
    });
    document.addEventListener('click', function (e) {
      if (nav.classList.contains('open') && !nav.contains(e.target)) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setMenu(false);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 860) setMenu(false);
    });
  }

  /* ---------- 滚动渐入 ---------- */
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window && !prefersReduced) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    reveals.forEach(function (el, i) {
      el.style.transitionDelay = Math.min(i % 6, 5) * 45 + 'ms';
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- 沉浸式滚动叙事（scrollytelling） ---------- */
  (function cinematics() {
    var root = document.getElementById('cine');
    if (!root) return;
    var track = document.getElementById('cine-track');
    var steps = Array.prototype.slice.call(root.querySelectorAll('.cine-step'));
    var frames = Array.prototype.slice.call(root.querySelectorAll('.cine-frame'));
    var segs = Array.prototype.slice.call(root.querySelectorAll('.cine-seg i'));
    var countEl = document.getElementById('cine-count');
    var ghost = document.getElementById('cine-ghost');
    var hint = document.getElementById('cine-hint');
    var total = Math.min(steps.length, frames.length);
    if (!track || !total) return;

    /* 尊重系统「减少动效」：样式已退回普通长列表，这里不再接管滚动 */
    if (prefersReduced) {
      root.classList.add('cine-static');
      return;
    }

    var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
    var smoothstep = function (t) { return t * t * (3 - 2 * t); };
    var pad2 = function (n) { return n < 10 ? '0' + n : '' + n; };

    var vh = window.innerHeight;
    var start = 0;
    var span = 1;
    var raf = 0;
    var lastText = '';
    var lastActive = -1;

    function scrolled() {
      return window.pageYOffset || document.documentElement.scrollTop || 0;
    }

    function measure() {
      vh = window.innerHeight || document.documentElement.clientHeight;
      start = track.getBoundingClientRect().top + scrolled();
      span = Math.max(1, track.offsetHeight - vh);
    }

    function paint() {
      raf = 0;
      var p = clamp((scrolled() - start) / span, 0, 1);
      var raw = p * total;
      var active = Math.min(total - 1, Math.floor(raw));

      root.style.setProperty('--p', p.toFixed(4));

      for (var k = 0; k < total; k++) {
        /* d = 0→1 表示第 k 幕正在播放；边界处 9% 的窗口做交叉溶解 */
        var d = raw - k;
        var fadeIn = k === 0 ? 1 : smoothstep(clamp((d + 0.035) / 0.09, 0, 1));
        var fadeOut = k === total - 1 ? 1 : 1 - smoothstep(clamp((d - 0.945) / 0.09, 0, 1));
        var fade = Math.min(fadeIn, fadeOut);
        var step = steps[k];
        var fr = frames[k];

        if (fade <= 0.004) {
          if (step.style.visibility !== 'hidden') {
            step.style.visibility = 'hidden';
            step.style.opacity = '0';
            fr.style.visibility = 'hidden';
            fr.style.opacity = '0';
          }
          continue;
        }

        var e = smoothstep(clamp(d / 0.42, 0, 1));
        var o = fade.toFixed(3);

        if (step.style.visibility !== 'visible') {
          step.style.visibility = 'visible';
          fr.style.visibility = 'visible';
        }
        step.style.opacity = o;
        step.style.transform = 'translate3d(0,' + ((1 - e) * 22).toFixed(2) + 'px,0)';

        fr.style.opacity = o;
        fr.style.transform =
          'translate3d(0,' + ((1 - e) * 30).toFixed(2) + 'px,0) ' +
          'scale(' + (0.955 + 0.045 * e).toFixed(4) + ') ' +
          'rotateY(' + ((1 - e) * -4).toFixed(2) + 'deg)';
      }

      for (var s = 0; s < segs.length; s++) {
        segs[s].style.width = (clamp(raw - s, 0, 1) * 100).toFixed(2) + '%';
      }

      if (active !== lastActive) {
        lastActive = active;
        if (ghost) ghost.textContent = pad2(active + 1);
      }

      var hintOpacity = p < 0.9
        ? 1 - clamp(p * 2.4, 0, 1) * 0.72
        : clamp(0.28 + ((p - 0.9) / 0.1) * 0.72, 0, 1);
      var text = p < 0.9
        ? T('cine_hint', '继续滚动 ↓')
        : T('cine_hint_done', '15 秒 · 从告警到可回滚的变更');
      if (countEl) countEl.textContent = pad2(active + 1) + ' / ' + pad2(total);
      if (hint) {
        hint.style.opacity = hintOpacity.toFixed(2);
        if (text !== lastText) { lastText = text; hint.textContent = text; }
      }
    }

    function onScroll() {
      if (!raf) raf = requestAnimationFrame(paint);
    }

    function remeasure() {
      measure();
      if (!raf) raf = requestAnimationFrame(paint);
    }

    measure();
    paint();

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', remeasure, { passive: true });
    window.addEventListener('orientationchange', remeasure, { passive: true });
    window.addEventListener('load', remeasure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);
    /* 首屏字体/图片落位后再校准一次锚点 */
    setTimeout(remeasure, 700);
  })();

  /* ---------- 轮播图 ---------- */
  var deck = document.getElementById('deck');
  var track = document.getElementById('track');
  if (!deck || !track) return;

  var slides = Array.prototype.slice.call(track.querySelectorAll('.slide'));
  var total = slides.length;
  if (!total) return;

  var viewport = deck.querySelector('.deck-viewport');
  var dotsBox = document.getElementById('deck-dots');
  var counter = document.getElementById('deck-counter');
  var captionTitle = deck.querySelector('#deck-caption b');
  var captionText = deck.querySelector('#deck-caption span');
  var urlPath = document.getElementById('url-path');
  var progress = document.getElementById('deck-progress');
  var btnPrev = document.getElementById('deck-prev');
  var btnNext = document.getElementById('deck-next');

  var paths = ['/logs', '/metrics/gpu', '/docker', '/remote', '/assistant', '/dashboard'];
  function readMeta() {
    return slides.map(function (s, i) {
      var cap = s.querySelector('figcaption');
      var b = cap && cap.querySelector('b');
      var span = cap && cap.querySelector('span');
      return {
        title: b ? b.textContent : 'OpenLog',
        desc: span ? span.textContent : '',
        path: paths[i] || '/dashboard'
      };
    });
  }
  function dotLabel(i) {
    return TP('deck_dot_tpl', { n: i + 1, title: meta[i].title }, '第 ' + (i + 1) + ' 张：' + meta[i].title);
  }
  var meta = readMeta();

  var index = 0;
  var AUTOPLAY_MS = 5600;
  var timer = null;
  var paused = false;

  var dots = meta.map(function (item, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-label', dotLabel(i));
    b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    b.addEventListener('click', function () { go(i, true); });
    dotsBox.appendChild(b);
    return b;
  });

  function restartProgress() {
    if (!progress) return;
    progress.style.animation = 'none';
    /* 强制重排以重启动画 */
    void progress.offsetWidth;
    progress.style.animation = '';
  }

  function paint() {
    track.style.transform = 'translateX(' + (-index * 100) + '%)';
    dots.forEach(function (d, i) {
      d.setAttribute('aria-selected', i === index ? 'true' : 'false');
    });
    if (counter) counter.textContent = (index + 1) + ' / ' + total;
    var item = meta[index];
    if (captionTitle) captionTitle.textContent = item.title;
    if (captionText) captionText.textContent = item.desc;
    if (urlPath) urlPath.textContent = item.path;
    slides.forEach(function (s, i) {
      s.setAttribute('aria-hidden', i === index ? 'false' : 'true');
    });
    restartProgress();
  }

  function go(next, byUser) {
    index = ((next % total) + total) % total;
    paint();
    if (byUser) schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (paused || prefersReduced) return;
    timer = setTimeout(function () {
      go(index + 1, false);
      schedule();
    }, AUTOPLAY_MS);
  }

  function setPaused(value) {
    if (paused === value) return;
    paused = value;
    deck.classList.toggle('paused', paused);
    if (paused) {
      clearTimeout(timer);
    } else {
      schedule();
    }
  }

  if (btnPrev) btnPrev.addEventListener('click', function () { go(index - 1, true); });
  if (btnNext) btnNext.addEventListener('click', function () { go(index + 1, true); });

  /* 悬停 / 键盘聚焦时暂停自动播放 */
  deck.addEventListener('mouseenter', function () { setPaused(true); });
  deck.addEventListener('mouseleave', function () { setPaused(false); });
  deck.addEventListener('focusin', function () { setPaused(true); });
  deck.addEventListener('focusout', function () { setPaused(false); });

  /* 键盘左右方向键 */
  deck.setAttribute('tabindex', '0');
  deck.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1, true); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1, true); }
  });

  /* 触摸 / 指针滑动 */
  if (viewport) {
    var startX = 0, startY = 0, dragging = false;
    viewport.addEventListener('pointerdown', function (e) {
      dragging = true; startX = e.clientX; startY = e.clientY;
    });
    viewport.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy)) {
        go(index + (dx < 0 ? 1 : -1), true);
      }
    });
    viewport.addEventListener('pointercancel', function () { dragging = false; });
  }

  /* 标签页不可见时停表 */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) setPaused(true);
    else setPaused(false);
  });

  /* 单张时隐藏控制条 */
  if (total < 2) {
    var bar = deck.querySelector('.deck-controls');
    if (bar) bar.style.display = 'none';
  }

  /* 语言切换后：重读译文标题，同步 caption / 圆点 / 计数器 */
  document.addEventListener('openlog:lang', function () {
    meta = readMeta();
    dots.forEach(function (d, i) { d.setAttribute('aria-label', dotLabel(i)); });
    paint();
  });

  paint();
  setPaused(false);
})();