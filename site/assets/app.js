/* OpenLog 官网交互：轮播图 + 滚动渐入 + 导航状态 */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    burger.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
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
  var meta = slides.map(function (s, i) {
    var cap = s.querySelector('figcaption');
    var b = cap && cap.querySelector('b');
    var span = cap && cap.querySelector('span');
    return {
      title: b ? b.textContent : 'OpenLog',
      desc: span ? span.textContent : '',
      path: paths[i] || '/dashboard'
    };
  });

  var index = 0;
  var AUTOPLAY_MS = 5600;
  var timer = null;
  var paused = false;

  var dots = meta.map(function (item, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-label', '第 ' + (i + 1) + ' 张：' + item.title);
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

  paint();
  setPaused(false);
})();