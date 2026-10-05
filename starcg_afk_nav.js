/*
 * starcg_afk_nav.js - the site menu shared by the pages of this fork.
 *
 * New file in the fork; the only change to an upstream page is ONE script line before </body>:
 *     <script src="starcg_afk_nav.js"></script>
 * - Pages that already have a header menu (.header-nav: price checker, pet, character) get the two links
 *   they lack: 「⏱ 掛機追蹤」 and 「🗡 傷害計算機」.
 * - The damage calculator has no header at all, so it gets a slim menu bar listing every tool.
 * Plain DOM, no data-i18n attribute, so a language switch never rewrites the links.
 * The links are file names, so they work from the local server, from file:// and from the Vercel deploy
 * (where the deploy script maps / to the price checker and index.html to the renamed damage calculator).
 */
(function () {
  'use strict';

  var PAGES = [
    { id: 'price', href: 'StarCG_PriceChecker.html', text: '🏪 市場查價器' },
    { id: 'afk', href: 'StarCG_AfkTracker.html', text: '⏱ 掛機追蹤' },
    { id: 'pet', href: 'StarCG_PetCalculator.html', text: '🐾 寵物成長模擬' },
    { id: 'char', href: 'StarCG_CharacterCalculator.html', text: '⚔️ 角色能力計算' },
    { id: 'damage', href: 'index.html', text: '🗡 傷害計算機' }
  ];
  var GUIDE = { href: 'https://guide.starcg.net/', text: '📖 官方攻略網' };

  function byId(id) {
    for (var i = 0; i < PAGES.length; i++) if (PAGES[i].id === id) return PAGES[i];
    return null;
  }

  function hasLink(nav, page) {
    if (nav.querySelector('[data-site-nav="' + page.id + '"]')) return true;
    var anchors = nav.querySelectorAll('a');
    for (var i = 0; i < anchors.length; i++) {
      if (anchors[i].getAttribute('href') === page.href) return true;
    }
    return false;
  }

  function addToHeaderNav(nav) {
    var peer = nav.querySelector('a');
    var before = nav.querySelector('a[target="_blank"]') || nav.querySelector('.lang-switcher');
    ['afk', 'damage'].forEach(function (id) {
      var page = byId(id);
      if (hasLink(nav, page)) return;
      var a = document.createElement('a');
      a.href = page.href;
      a.setAttribute('data-site-nav', id);
      a.className = peer ? peer.className : 'header-link';
      a.textContent = page.text;
      nav.insertBefore(a, before);
    });
  }

  function addMenuBar() {
    if (!document.body || document.querySelector('.sitenav')) return;
    var style = document.createElement('style');
    style.textContent =
      '.sitenav{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 8px;' +
      'max-width:1200px;margin:0 auto 14px;padding:8px 12px;border:1px solid var(--border-color,#dce4ec);' +
      'border-radius:14px;background:var(--bg-card,#fff);box-shadow:0 1px 4px rgba(0,0,0,.05);' +
      'font:14px/1.4 -apple-system,BlinkMacSystemFont,"PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif}' +
      '.sitenav a{color:var(--text-secondary,#7f8c8d);text-decoration:none;white-space:nowrap;' +
      'padding:6px 12px;border-radius:999px;transition:color .15s,background .15s}' +
      '.sitenav a:hover{color:var(--accent-gold,#e67e22);background:rgba(230,126,34,.08)}' +
      '.sitenav a:focus-visible{outline:2px solid var(--accent-blue,#3498db);outline-offset:2px}' +
      '.sitenav a[aria-current="page"]{color:#fff;background:var(--accent-gold,#e67e22);font-weight:600}';
    document.head.appendChild(style);

    var bar = document.createElement('nav');
    bar.className = 'sitenav';
    bar.setAttribute('aria-label', '站內導覽');
    // only the damage calculator reaches this branch (it is the one page without .header-nav)
    var current = document.getElementById('attack') ? 'damage' : '';
    PAGES.forEach(function (page) {
      var a = document.createElement('a');
      a.href = page.href;
      a.setAttribute('data-site-nav', page.id);
      a.textContent = page.text;
      if (page.id === current) a.setAttribute('aria-current', 'page');
      bar.appendChild(a);
    });
    var guide = document.createElement('a');
    guide.href = GUIDE.href;
    guide.target = '_blank';
    guide.rel = 'noopener noreferrer';
    guide.textContent = GUIDE.text;
    bar.appendChild(guide);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  var nav = document.querySelector('.header-nav');
  if (nav) addToHeaderNav(nav);
  else addMenuBar();
})();
