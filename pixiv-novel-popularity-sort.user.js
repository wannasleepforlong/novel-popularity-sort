// ==UserScript==
// @name         Pixiv Novel Tag — Sort by Popularity (free)
// @namespace    https://github.com/local/pixiv-novel-popsort
// @version      1.2.0
// @description  Adds a "Sort by popularity" button on Pixiv novel tag/search pages. Fetches results via the site's own AJAX API and re-sorts by bookmark count client-side — no Premium required.
// @author       you
// @match        https://www.pixiv.net/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CSS = `
  #pnps-fab{position:fixed;right:18px;bottom:18px;z-index:2147483646;
    background:#0096fa;color:#fff;border:none;border-radius:24px;
    padding:11px 16px;font:600 13px/1 system-ui,sans-serif;cursor:pointer;
    box-shadow:0 2px 10px rgba(0,0,0,.25);display:none}
  #pnps-fab:hover{background:#0085e0}
  #pnps-panel{position:fixed;inset:0 0 0 auto;width:min(480px,100vw);z-index:2147483647;
    background:#fff;color:#111;box-shadow:-4px 0 24px rgba(0,0,0,.25);
    display:none;flex-direction:column;font:13px/1.45 system-ui,sans-serif}
  @media (prefers-color-scheme: dark){#pnps-panel{background:#16171b;color:#e7e7ea}}
  #pnps-panel.open{display:flex}
  #pnps-head{padding:12px 14px;border-bottom:1px solid rgba(128,128,128,.25);
    display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  #pnps-head b{font-size:14px;margin-right:auto}
  #pnps-head button{border:none;border-radius:6px;padding:6px 10px;cursor:pointer;
    font:600 12px system-ui,sans-serif;background:#0096fa;color:#fff}
  #pnps-head .ghost{background:rgba(128,128,128,.18);color:inherit}
  #pnps-head input{width:52px;padding:5px 6px;border-radius:6px;
    border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit}
  #pnps-status{padding:8px 14px;font-size:12px;opacity:.8;border-bottom:1px solid rgba(128,128,128,.15)}
  #pnps-list{overflow:auto;flex:1;padding:4px 0}
  .pnps-row{display:flex;gap:10px;padding:9px 14px;border-bottom:1px solid rgba(128,128,128,.12);align-items:flex-start}
  .pnps-rank{font-weight:700;opacity:.5;min-width:26px;text-align:right;padding-top:2px}
  .pnps-thumb{width:48px;height:48px;object-fit:cover;border-radius:6px;background:rgba(128,128,128,.2);flex:0 0 auto}
  .pnps-body{min-width:0;flex:1}
  .pnps-title{font-weight:600;color:inherit;text-decoration:none;display:block;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pnps-title:hover{text-decoration:underline}
  .pnps-meta{font-size:11.5px;opacity:.7;margin-top:2px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pnps-bm{color:#0096fa;font-weight:700}
  .pnps-tags{font-size:11px;opacity:.55;margin-top:3px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  `;

  const NOVEL_URL = id => `https://www.pixiv.net/novel/show.php?id=${id}`;

  function isNovelSearchPage() {
    // matches /tags/<tag>/novels  (with optional /en or other lang prefix)
    return /\/tags\/[^/]+\/novels/.test(location.pathname);
  }

  // Pull the tag out of the path, regardless of language prefix.
  function currentTag() {
    const m = location.pathname.match(/\/tags\/([^/]+)\/novels/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function langPrefix() {
    const m = location.pathname.match(/^\/([a-z]{2})\//);
    return m ? m[1] : 'en';
  }

  // Build the AJAX query, carrying over the filters already in the page URL
  // (mode, s_mode, length filters, etc.) so the result set matches the page.
  function buildQuery(tag, page) {
    const enc = encodeURIComponent(tag);
    const cur = new URLSearchParams(location.search);
    const q = new URLSearchParams();
    q.set('word', tag);
    // carry over everything except the page number
    for (const [k, v] of cur.entries()) if (k !== 'p') q.set(k, v);
    if (!q.has('s_mode')) q.set('s_mode', 's_tag_full'); // tag-page default: exact tag
    q.set('p', String(page));
    q.set('lang', langPrefix());
    return `/ajax/search/novels/${enc}?${q.toString()}`;
  }

  async function fetchPage(tag, page) {
    const res = await fetch(buildQuery(tag, page), {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
    const json = await res.json();
    if (json.error) throw new Error(json.message || 'Pixiv API error');
    const novel = json.body && json.body.novel;
    if (!novel) throw new Error('Unexpected response shape');
    return { data: novel.data || [], total: novel.total || 0 };
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function collectAll(tag, maxPages, onProgress) {
    const HARD_CAP = 500; // safety ceiling so a huge tag can't loop forever
    const first = await fetchPage(tag, 1);
    const pageSize = Math.max(1, first.data.length || 24);
    const totalPages = Math.min(maxPages, HARD_CAP, Math.ceil(first.total / pageSize) || 1);

    const byId = new Map();
    const add = arr => arr.forEach(n => {
      if (n && n.id && n.title && !byId.has(n.id)) byId.set(n.id, n);
    });
    add(first.data);
    onProgress(byId.size, first.total, 1, totalPages);

    for (let p = 2; p <= totalPages; p++) {
      await sleep(250); // be polite to the server
      try {
        const { data } = await fetchPage(tag, p);
        if (!data.length) break;              // reached the end of results
        add(data);
      } catch (e) {
        // Pixiv caps how deep search paging goes; stop and keep what we have.
        console.warn('[pnps] stopped early at page', p, '-', e.message);
        break;
      }
      onProgress(byId.size, first.total, p, totalPages);
    }

    const list = [...byId.values()];
    list.sort((a, b) => (b.bookmarkCount || 0) - (a.bookmarkCount || 0));
    return { list, total: first.total };
  }

  // ---- UI ----
  function ensureStyle() {
    if (document.getElementById('pnps-style')) return;
    const s = document.createElement('style');
    s.id = 'pnps-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function buildPanel() {
    if (document.getElementById('pnps-panel')) return;

    const fab = document.createElement('button');
    fab.id = 'pnps-fab';
    fab.textContent = '★ Sort by popularity';
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'pnps-panel';
    panel.innerHTML = `
      <div id="pnps-head">
        <b>Popularity sort</b>
        <label>Pages <input id="pnps-pages" type="number" min="1" max="50" value="6"></label>
        <label title="Scan every page in the tag">All <input id="pnps-all" type="checkbox"></label>
        <button id="pnps-run">Scan &amp; sort</button>
        <button id="pnps-close" class="ghost">Close</button>
      </div>
      <div id="pnps-status">Click “Scan &amp; sort”. Each page ≈ 24 novels; more pages = slower.</div>
      <div id="pnps-list"></div>`;
    document.body.appendChild(panel);

    const $ = sel => panel.querySelector(sel);
    const open = () => panel.classList.add('open');
    const close = () => panel.classList.remove('open');

    fab.addEventListener('click', open);
    $('#pnps-close').addEventListener('click', close);
    $('#pnps-run').addEventListener('click', run);
    $('#pnps-all').addEventListener('change', e => {
      $('#pnps-pages').disabled = e.target.checked;
    });

    async function run() {
      const tag = currentTag();
      if (!tag) { $('#pnps-status').textContent = 'Not on a novel tag page.'; return; }
      const all = $('#pnps-all').checked;
      const maxPages = all ? Infinity : Math.max(1, Math.min(50, parseInt($('#pnps-pages').value, 10) || 6));
      const list = $('#pnps-list');
      const status = $('#pnps-status');
      list.innerHTML = '';
      $('#pnps-run').disabled = true;

      try {
        const { list: novels, total } = await collectAll(
          tag, maxPages,
          (got, tot, p, pp) => {
            status.textContent = `Fetched ${got} novels — page ${p}/${pp} (tag has ${tot} total)`;
          }
        );
        status.textContent = `${novels.length} novels, sorted by bookmarks (of ${total} total in tag).`;
        render(list, novels);
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        console.error('[pnps]', e);
      } finally {
        $('#pnps-run').disabled = false;
      }
    }

    function render(container, novels) {
      const frag = document.createDocumentFragment();
      novels.forEach((n, i) => {
        const row = document.createElement('div');
        row.className = 'pnps-row';
        const thumb = n.url
          ? `<img class="pnps-thumb" loading="lazy" src="${n.url}" onerror="this.style.visibility='hidden'">`
          : `<div class="pnps-thumb"></div>`;
        const chars = n.textCount ? ` · ${n.textCount.toLocaleString()} chars` : '';
        const tags = (n.tags || []).slice(0, 6).join(' / ');
        row.innerHTML = `
          <div class="pnps-rank">${i + 1}</div>
          ${thumb}
          <div class="pnps-body">
            <a class="pnps-title" href="${NOVEL_URL(n.id)}" target="_blank" rel="noopener"></a>
            <div class="pnps-meta">
              <span class="pnps-bm">❤ ${(n.bookmarkCount || 0).toLocaleString()}</span>
              · <span class="pnps-author"></span>${chars}
            </div>
            <div class="pnps-tags"></div>
          </div>`;
        // set text via textContent to avoid HTML injection from titles/names
        row.querySelector('.pnps-title').textContent = n.title;
        row.querySelector('.pnps-author').textContent = n.userName || '';
        row.querySelector('.pnps-tags').textContent = tags;
        frag.appendChild(row);
      });
      container.appendChild(frag);
    }
  }

  function toggleFab() {
    const fab = document.getElementById('pnps-fab');
    if (fab) fab.style.display = isNovelSearchPage() ? 'block' : 'none';
  }

  function init() {
    ensureStyle();
    buildPanel();
    toggleFab();
  }

  // Pixiv is a single-page app — watch for in-app navigation.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      toggleFab();
    }
  }, 800);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
