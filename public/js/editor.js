/* The writing view.
 *
 * Safety model: every keystroke is mirrored to a local draft (localStorage)
 * and autosaved to the server shortly after typing stops. Saves carry the
 * version the text was based on, so changes made elsewhere (another tab, or
 * the phone for LiteWriter novels) are never silently overwritten. Failed
 * saves are retried with backoff; the draft survives crashes and offline
 * periods and is offered back on the next visit.
 */
(function () {
  'use strict';
  const { api, toast, debounce, enc, fmt, $, $$, escapeHtml } = window.WW;
  const page = window.WW.pageData();

  const textarea = $('[data-text]');
  const statusEl = $('[data-status]');
  const statusText = $('[data-status-text]');
  const wordsEl = $('[data-words]');
  const sessionEl = $('[data-session-words]');
  const root = $('[data-editor-root]');

  const chapterUrl = `/api/chapters/${page.source}/${enc(page.id)}/${enc(page.book)}/${enc(page.chapter)}`;
  const draftKey = `ww.draft:${page.source}:${page.id}:${page.book}:${page.chapter}`;
  const csrf = document.querySelector('meta[name="csrf-token"]').content;

  const WORD_RE = /[\p{L}\p{N}]/u;
  const countWords = text => text.split(/\s+/).reduce((n, t) => n + (t && WORD_RE.test(t) ? 1 : 0), 0);

  let baseVersion = page.version;
  let savedContent = textarea.value;
  let savedWords = countWords(savedContent);
  const initialWords = savedWords;
  let wordsToday = page.wordsToday || 0;
  let saving = null;
  let retryTimer = null;
  let retryDelay = 2000;
  let conflictOpen = false;
  let lastSavedAt = null;
  let blocked = false; // unresolved conflict: stop autosaving until the writer decides

  const isDirty = () => textarea.value !== savedContent;

  /* --------------------------------------------------------------- status */

  function setStatus(kind, text) {
    statusEl.className = `ed-status ${kind}`;
    statusText.textContent = text;
    statusEl.title = lastSavedAt ? `Last saved ${lastSavedAt.toLocaleTimeString()}` : '';
  }

  function updateCounts() {
    const words = countWords(textarea.value);
    wordsEl.textContent = fmt(words);
    const delta = words - initialWords;
    sessionEl.textContent = delta ? `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))} this session` : '';
    if (page.dailyGoal > 0) {
      const today = Math.max(0, wordsToday + (words - savedWords));
      $('[data-goal]').hidden = false;
      $('[data-goal-bar]').style.width = `${Math.min(100, (today / page.dailyGoal) * 100)}%`;
      $('[data-goal-text]').textContent = today >= page.dailyGoal ? `${fmt(today)} — goal reached!` : `${fmt(today)} / ${fmt(page.dailyGoal)}`;
    }
  }

  /* ---------------------------------------------------------------- draft */

  function writeDraft() {
    try {
      if (isDirty()) localStorage.setItem(draftKey, JSON.stringify({ content: textarea.value, baseVersion, at: Date.now() }));
      else localStorage.removeItem(draftKey);
    } catch {
      /* storage full or unavailable */
    }
  }
  const writeDraftSoon = debounce(writeDraft, 400);

  function readDraft() {
    try {
      return JSON.parse(localStorage.getItem(draftKey) || 'null');
    } catch {
      return null;
    }
  }

  /* ----------------------------------------------------------------- save */

  async function save({ force = false } = {}) {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (saving) {
      await saving.catch(() => {});
      if (!isDirty() && !force) return true;
    }
    if (!isDirty() && !force) return true;
    if (blocked && !force) return false;
    const content = textarea.value;
    setStatus('saving', 'Saving…');
    saving = api('PUT', chapterUrl, { content, baseVersion, force }, { timeout: 45000 });
    try {
      const res = await saving;
      baseVersion = res.version || null;
      savedContent = content;
      savedWords = res.words;
      wordsToday = res.wordsToday;
      lastSavedAt = new Date();
      retryDelay = 2000;
      blocked = false;
      writeDraft();
      if (isDirty()) {
        setStatus('dirty', 'Unsaved changes');
        scheduleSave();
      } else setStatus('', 'Saved');
      updateCounts();
      return true;
    } catch (err) {
      if (err.status === 409) {
        blocked = true;
        setStatus('error', 'Not saved — conflict');
        openConflict();
      } else if (err.status === 401 || err.status === 403) {
        setStatus('error', 'Not saved — signed out');
        toast(err.message, 'error');
      } else {
        const secs = Math.round(retryDelay / 1000);
        setStatus('error', err.network ? `Offline — retrying in ${secs}s` : `Not saved — retrying in ${secs}s`);
        if (retryDelay === 2000) toast(`${err.message} Your text is kept in this browser and will be saved when possible.`, 'error');
        retryTimer = setTimeout(() => save(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
      return false;
    } finally {
      saving = null;
    }
  }

  const scheduleSave = debounce(() => save(), 1200);
  // Also save during long uninterrupted typing sessions.
  setInterval(() => {
    if (isDirty() && !saving && !blocked && !retryTimer) save();
  }, 20000);

  /* ------------------------------------------------------------- conflict */

  const conflictDialog = $('#conflict-dialog');

  async function openConflict() {
    if (conflictOpen) return;
    conflictOpen = true;
    writeDraft();
    let theirs = null;
    try {
      theirs = await api('GET', chapterUrl);
      $('[data-theirs]', conflictDialog).textContent = theirs.content || '(empty)';
    } catch (err) {
      $('[data-theirs]', conflictDialog).textContent = `Could not load the other version: ${err.message}`;
    }
    conflictDialog.returnValue = '';
    conflictDialog.showModal();
    conflictDialog.querySelector('button[value=mine]').focus();
    conflictDialog.addEventListener(
      'close',
      async () => {
        conflictOpen = false;
        const choice = conflictDialog.returnValue;
        if (choice === 'mine') {
          await save({ force: true });
        } else if (choice === 'theirs' && theirs) {
          textarea.value = theirs.content;
          savedContent = theirs.content;
          savedWords = theirs.words;
          baseVersion = theirs.version;
          blocked = false;
          autoGrow();
          updateCounts();
          setStatus('', 'Loaded the other version');
          toast('Loaded the other version. Your text is still in this browser as a draft — reload to get it back.', 'info', 8000);
        } else {
          setStatus('error', 'Not saved — conflict');
          statusEl.style.cursor = 'pointer';
          statusEl.onclick = () => openConflict();
        }
      },
      { once: true }
    );
  }

  /* --------------------------------------------------------- restore draft */

  (async function restoreDraft() {
    const draft = readDraft();
    if (!draft || draft.content === textarea.value) {
      if (draft) localStorage.removeItem(draftKey);
      return;
    }
    if (draft.baseVersion === page.version) {
      // The server copy has not changed since the draft was made: just carry on.
      textarea.value = draft.content;
      autoGrow();
      updateCounts();
      setStatus('dirty', 'Unsaved changes');
      toast('Restored unsaved changes from this browser.', 'success');
      scheduleSave();
      return;
    }
    const when = new Date(draft.at).toLocaleString();
    const ok = await window.WW.ask({
      title: 'Restore your unsaved draft?',
      message: `This browser has an unsaved version from ${when}, but the chapter has been changed since. Restoring it replaces the current text (you'll be asked before anything is overwritten).`,
      ok: 'Restore draft'
    });
    if (ok) {
      textarea.value = draft.content;
      autoGrow();
      updateCounts();
      setStatus('dirty', 'Unsaved changes');
      scheduleSave();
    } else {
      localStorage.removeItem(draftKey);
    }
  })();

  /* --------------------------------------------------------------- typing */

  const supportsFieldSizing = CSS.supports && CSS.supports('field-sizing', 'content');
  function autoGrow() {
    if (supportsFieldSizing) return;
    const y = window.scrollY;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
    window.scrollTo(0, y);
  }

  textarea.addEventListener('input', () => {
    autoGrow();
    updateCounts();
    writeDraftSoon();
    if (!blocked) {
      setStatus('dirty', 'Unsaved changes');
      scheduleSave();
    }
    if (typewriter) typewriterScroll();
  });

  /* Replace a range while keeping the browser's undo history where possible. */
  function replaceRange(start, end, text, selectStart, selectEnd) {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    if (!document.execCommand || !document.execCommand('insertText', false, text)) {
      textarea.setRangeText(text, start, end, 'end');
      textarea.dispatchEvent(new Event('input'));
    }
    if (selectStart !== undefined) textarea.setSelectionRange(selectStart, selectEnd ?? selectStart);
  }

  function wrap(marker) {
    const { selectionStart: s, selectionEnd: e, value } = textarea;
    const selected = value.slice(s, e);
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
      replaceRange(s, e, selected.slice(marker.length, -marker.length), s, e - marker.length * 2);
    } else if (value.slice(s - marker.length, s) === marker && value.slice(e, e + marker.length) === marker) {
      replaceRange(s - marker.length, e + marker.length, selected, s - marker.length, e - marker.length);
    } else {
      replaceRange(s, e, marker + selected + marker, s + marker.length, e + marker.length);
    }
  }

  function linePrefix(prefix) {
    const { selectionStart: s, value } = textarea;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const line = value.slice(lineStart, value.indexOf('\n', lineStart) === -1 ? value.length : value.indexOf('\n', lineStart));
    if (line.startsWith(prefix)) replaceRange(lineStart, lineStart + prefix.length, '', Math.max(lineStart, s - prefix.length));
    else {
      const existing = line.match(/^(#{1,6} |> )/);
      const cut = existing ? existing[0].length : 0;
      replaceRange(lineStart, lineStart + cut, prefix, s - cut + prefix.length);
    }
  }

  function sceneBreak() {
    const { selectionStart: s, value } = textarea;
    const before = value.slice(0, s);
    const lead = before.endsWith('\n\n') || !before ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const text = `${lead}* * *\n\n`;
    replaceRange(s, textarea.selectionEnd, text, s + text.length);
  }

  const MD = { bold: () => wrap('**'), italic: () => wrap('*'), heading: () => linePrefix('# '), quote: () => linePrefix('> '), break: sceneBreak };
  $$('[data-md]').forEach(btn => btn.addEventListener('click', () => MD[btn.dataset.md]()));

  /* -------------------------------------------------- typewriter scrolling */

  let typewriter = Boolean(page.typewriter);
  let mirror = null;
  function caretY() {
    if (!mirror) {
      mirror = document.createElement('div');
      document.body.appendChild(mirror);
    }
    const cs = getComputedStyle(textarea);
    Object.assign(mirror.style, {
      position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
      width: `${textarea.clientWidth}px`, font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, padding: cs.padding, top: '0', left: '-9999px'
    });
    mirror.textContent = textarea.value.slice(0, textarea.selectionEnd);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.appendChild(marker);
    return textarea.getBoundingClientRect().top + window.scrollY + marker.offsetTop;
  }
  function typewriterScroll() {
    const y = caretY();
    window.scrollTo({ top: Math.max(0, y - window.innerHeight * 0.45), behavior: 'auto' });
  }
  textarea.addEventListener('click', () => typewriter && typewriterScroll());

  /* ------------------------------------------------------------ shortcuts */

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'b' && document.activeElement === textarea) {
      e.preventDefault();
      MD.bold();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'i' && document.activeElement === textarea) {
      e.preventDefault();
      MD.italic();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggleFocus();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openDrawer();
    } else if (e.key === 'Escape') {
      closeDrawer();
      typo.hidden = true;
    }
  });

  /* ------------------------------------------------------- focus & screen */

  function toggleFocus(force) {
    const on = document.body.classList.toggle('focus-mode', force);
    try {
      localStorage.setItem('ww.focus', on ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (on) toast('Focus mode — move the mouse to the top or bottom edge to see the controls.', 'info', 2500);
  }
  try {
    if (localStorage.getItem('ww.focus') === '1') document.body.classList.add('focus-mode');
  } catch {
    /* ignore */
  }
  $('[data-focus-toggle]').addEventListener('click', () => toggleFocus());

  $('[data-fullscreen]').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => toast('Full screen is not available here.', 'error'));
  });
  document.addEventListener('fullscreenchange', () => {
    $('[data-fullscreen] use').setAttribute('href', document.fullscreenElement ? '#i-minimize' : '#i-maximize');
  });

  const top = $('[data-ed-top]');
  window.addEventListener('scroll', () => top.classList.toggle('scrolled', window.scrollY > 4), { passive: true });

  /* ----------------------------------------------------------- typography */

  const typo = $('[data-typo]');
  $('[data-typo-toggle]').addEventListener('click', e => {
    e.stopPropagation();
    typo.hidden = !typo.hidden;
  });
  document.addEventListener('click', e => {
    if (!typo.hidden && !typo.contains(e.target)) typo.hidden = true;
  });

  const FONT_STACKS = {
    serif: "'Literata', Georgia, Cambria, 'Times New Roman', serif",
    sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    mono: "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace"
  };
  const pendingPrefs = {};
  const persistPrefs = debounce(() => {
    api('POST', '/settings/writing/quick', { ...pendingPrefs }).catch(() => {});
  }, 600);
  function setPref(key, value) {
    pendingPrefs[key] = value;
    persistPrefs();
    autoGrow();
  }

  $$('[data-font]').forEach(btn =>
    btn.addEventListener('click', () => {
      $$('[data-font]').forEach(b => b.classList.toggle('active', b === btn));
      root.style.setProperty('--ed-font', FONT_STACKS[btn.dataset.font]);
      setPref('editor_font', btn.dataset.font);
    })
  );
  $('[data-size]').addEventListener('input', e => {
    root.style.setProperty('--ed-size', `${e.target.value}px`);
    $('[data-size-val]').textContent = `${e.target.value}px`;
    setPref('editor_size', Number(e.target.value));
  });
  $('[data-width]').addEventListener('input', e => {
    root.style.setProperty('--ed-width', e.target.value);
    $('[data-width-val]').textContent = e.target.value;
    setPref('editor_width', Number(e.target.value));
  });
  $('[data-lh]').addEventListener('input', e => {
    root.style.setProperty('--ed-lh', e.target.value);
    $('[data-lh-val]').textContent = e.target.value;
    setPref('editor_line_height', Number(e.target.value));
  });
  $('[data-typewriter]').addEventListener('change', e => {
    typewriter = e.target.checked;
    setPref('editor_typewriter', typewriter);
    if (typewriter) typewriterScroll();
  });

  /* ------------------------------------------------- chapters & navigation */

  const drawer = $('[data-drawer]');
  const backdrop = $('[data-drawer-backdrop]');
  const writeUrl = (book, chapter) => `/write/${page.source}/${enc(page.id)}/${enc(book)}/${enc(chapter)}`;

  function openDrawer() {
    drawer.classList.add('open');
    backdrop.classList.add('open');
    drawer.querySelector('.current')?.scrollIntoView({ block: 'center' });
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
  }
  $('[data-drawer-open]').addEventListener('click', openDrawer);
  $('[data-drawer-close]').addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  function setNav(el, target) {
    if (!target) return;
    el.hidden = false;
    el.href = writeUrl(target.book, target.chapter);
    el.title = target.chapter;
    $('[data-label]', el).textContent = target.chapter;
  }

  api('GET', `/api/novels/${page.source}/${enc(page.id)}`, undefined, { timeout: 60000 })
    .then(({ books }) => {
      const flat = [];
      const html = books
        .map(b => {
          const items = b.chapters
            .map(c => {
              if (!c.isSynopsis) flat.push({ book: b.name, chapter: c.name });
              const current = b.name === page.book && c.name === page.chapter;
              return `<a class="drawer-ch${current ? ' current' : ''}" href="${writeUrl(b.name, c.name)}" data-nav-link><span>${escapeHtml(c.isSynopsis ? 'Synopsis' : c.name)}</span><span class="w">${fmt(c.words)}</span></a>`;
            })
            .join('');
          const label = b.isMain ? (books.length > 1 ? 'Main' : 'Chapters') : b.name;
          return `<div class="drawer-book"><h4>${escapeHtml(label)}</h4>${items || '<p class="faint small" style="padding:0 .6rem">No chapters</p>'}</div>`;
        })
        .join('');
      $('[data-drawer-list]').innerHTML = html;
      const i = flat.findIndex(c => c.book === page.book && c.chapter === page.chapter);
      if (i > 0) setNav($('[data-prev]'), flat[i - 1]);
      if (i >= 0 && i < flat.length - 1) setNav($('[data-next]'), flat[i + 1]);
    })
    .catch(err => {
      $('[data-drawer-list]').innerHTML = `<p class="muted small" style="padding:1rem">Could not load chapters: ${escapeHtml(err.message)}</p>`;
    });

  // Save before leaving through any in-app link.
  document.addEventListener('click', async e => {
    const link = e.target.closest('a[href]');
    if (!link || link.target || e.metaKey || e.ctrlKey || e.shiftKey || link.hasAttribute('download')) return;
    if (!isDirty()) return;
    e.preventDefault();
    const ok = await save();
    if (ok || window.confirm('Your latest changes could not be saved yet. They are kept in this browser. Leave anyway?')) {
      location.href = link.href;
    }
  });

  window.addEventListener('beforeunload', e => {
    if (!isDirty()) return;
    writeDraft();
    // Best effort: hand the latest text to the server even as the page closes.
    if (!blocked && navigator.sendBeacon) {
      const body = JSON.stringify({ content: textarea.value, baseVersion, _csrf: csrf });
      if (navigator.sendBeacon(chapterUrl, new Blob([body], { type: 'text/plain' }))) return;
    }
    e.preventDefault();
    e.returnValue = '';
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && isDirty() && !blocked) save();
  });

  /* ------------------------------------------------------------------ go */

  autoGrow();
  updateCounts();
  if (!textarea.value) textarea.focus();
  else {
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }
})();
