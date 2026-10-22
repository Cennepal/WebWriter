/* Library page: search/sort, LiteWriter novels loaded in the background, new novel dialog */
(function () {
  'use strict';
  const { api, toast, busy, escapeHtml, icon, fmt, $, $$, enc } = window.WW;

  /* -------------------------------------------------------- search & sort */

  const search = $('[data-library-search]');
  const sort = $('[data-library-sort]');
  const SORT_KEY = 'ww.library.sort';
  try {
    if (sort && localStorage.getItem(SORT_KEY)) sort.value = localStorage.getItem(SORT_KEY);
  } catch {
    /* storage unavailable */
  }

  function applyFilters() {
    const q = (search?.value || '').trim().toLowerCase();
    const mode = sort?.value || 'updated';
    $$('.novel-grid').forEach(grid => {
      const cards = $$('[data-novel-card]', grid);
      cards.sort((a, b) => {
        if (mode === 'title') return a.dataset.title.localeCompare(b.dataset.title);
        if (mode === 'words') return Number(b.dataset.words) - Number(a.dataset.words);
        return (b.dataset.updated || '').localeCompare(a.dataset.updated || '');
      });
      cards.forEach(c => {
        c.hidden = Boolean(q) && !c.dataset.title.includes(q);
        grid.appendChild(c);
      });
    });
    const local = $('[data-sortable-grid]');
    const none = $('[data-no-results]');
    if (local && none) none.hidden = $$('[data-novel-card]:not([hidden])', local).length > 0 || !q;
  }
  search?.addEventListener('input', applyFilters);
  sort?.addEventListener('change', () => {
    try {
      localStorage.setItem(SORT_KEY, sort.value);
    } catch {
      /* ignore */
    }
    applyFilters();
  });
  applyFilters();

  /* ------------------------------------------------------- LiteWriter */

  const section = $('#remote-section');
  const grid = $('[data-remote-grid]');
  const status = $('[data-remote-status]');
  const message = $('[data-remote-message]');
  const refresh = $('[data-remote-refresh]');

  function relative(iso) {
    if (!iso) return '';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    const units = [['year', 31557600], ['month', 2629800], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [u, v] of units) if (s >= v) return `${Math.round(s / v)} ${u}${Math.round(s / v) === 1 ? '' : 's'} ago`;
    return 'just now';
  }

  function hue(text) {
    return [...String(text || '')].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 17);
  }

  function card(n) {
    const cover = n.coverUrl
      ? `<img src="${escapeHtml(n.coverUrl)}" alt="" loading="lazy">`
      : `<div class="cover-placeholder" style="--hue:${hue(n.title)}"><span class="cover-title">${escapeHtml(n.title)}</span><span class="cover-rule"></span></div>`;
    return `<a class="novel-card" href="/novels/remote/${enc(n.id)}" data-novel-card data-title="${escapeHtml(n.title.toLowerCase())}" data-words="${n.words}" data-updated="${escapeHtml(n.updatedAt || '')}">
      <div class="cover">${cover}</div>
      <div>
        <div class="novel-card-title">${escapeHtml(n.title)}</div>
        <div class="novel-card-meta">${fmt(n.words)} words · ${n.chapterCount} chapter${n.chapterCount === 1 ? '' : 's'}</div>
        <div class="novel-card-meta faint">${relative(n.updatedAt)}</div>
      </div></a>`;
  }

  function setStatus(kind, text) {
    if (!status) return;
    status.className = `status-pill ${kind}`;
    status.innerHTML = kind === 'loading' ? `<span class="spinner"></span>${escapeHtml(text)}` : `<span class="dot"></span>${escapeHtml(text)}`;
  }

  async function loadRemote(fresh) {
    if (!grid) return;
    setStatus('loading', fresh ? 'Refreshing…' : 'Connecting to your device…');
    if (refresh) refresh.disabled = true;
    try {
      const data = await api('GET', `/api/remote/novels${fresh ? '?fresh=1' : ''}`, undefined, { timeout: 120000 });
      message.hidden = true;
      grid.hidden = false;
      if (!data.novels.length) {
        grid.innerHTML = '';
        message.hidden = false;
        message.innerHTML = '<div class="empty"><h3>No novels found on the device</h3><p>The connection works, but LiteWriter does not have any novel folders yet.</p></div>';
      } else {
        grid.innerHTML = data.novels.map(card).join('');
        applyFilters();
      }
      setStatus('ok', `Connected · ${data.novels.length} novel${data.novels.length === 1 ? '' : 's'}`);
    } catch (err) {
      grid.hidden = true;
      grid.innerHTML = '';
      message.hidden = false;
      message.innerHTML = `<div class="alert alert-warning">${icon('alert')}<div><strong>Couldn't reach LiteWriter.</strong> ${escapeHtml(err.message)}<div style="margin-top:.5rem" class="row"><button class="btn btn-sm" type="button" data-remote-retry>${icon('refresh')}Try again</button><a class="btn btn-sm btn-ghost" href="/settings/litewriter">Connection settings</a></div></div></div>`;
      setStatus('err', 'Offline');
    } finally {
      if (refresh) refresh.disabled = false;
    }
  }

  if (section && section.dataset.remoteConfigured === '1') {
    loadRemote(false);
    refresh?.addEventListener('click', () => loadRemote(true));
    section.addEventListener('click', e => {
      if (e.target.closest('[data-remote-retry]')) loadRemote(true);
    });
  }

  /* -------------------------------------------------------- new novel */

  const form = $('[data-new-novel]');
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    try {
      const res = await busy(btn, () => api('POST', '/api/novels', new FormData(form)));
      if (res.warning) toast(res.warning, 'error');
      location.href = res.url;
    } catch (err) {
      toast(err.message, 'error');
    }
  });
})();
