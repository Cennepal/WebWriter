/* WebWriter — shared client helpers (exposed as window.WW) */
(function () {
  'use strict';

  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** fetch() wrapper: sends the CSRF token, parses JSON, throws readable errors. */
  async function api(method, url, body, { timeout = 60000 } = {}) {
    const headers = { 'X-CSRF-Token': csrf(), Accept: 'application/json' };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: ctrl.signal });
    } catch (err) {
      const e = new Error(err.name === 'AbortError' ? 'The server took too long to answer.' : 'Could not reach the server. Are you offline?');
      e.network = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) {
      const e = new Error(data.error || `Request failed (${res.status})`);
      e.status = res.status;
      e.code = data.code;
      if (res.status === 401) setTimeout(() => (location.href = `/login?next=${encodeURIComponent(location.pathname)}`), 1500);
      throw e;
    }
    return data;
  }

  function icon(name) {
    return `<svg class="icon"><use href="#i-${name}"/></svg>`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function toast(message, type = 'info', ms = 4000) {
    const host = $('#toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<div>${escapeHtml(message)}</div>`;
    host.appendChild(el);
    const remove = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    el.addEventListener('click', remove);
    setTimeout(remove, type === 'error' ? Math.max(ms, 7000) : ms);
  }

  /** Disable a button and show a spinner while a promise runs. */
  async function busy(btn, fn) {
    if (!btn) return fn();
    if (btn.getAttribute('aria-busy') === 'true') return undefined;
    const html = btn.innerHTML;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${btn.textContent.trim() ? `<span>${escapeHtml(btn.textContent.trim())}</span>` : ''}`;
    try {
      return await fn();
    } finally {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      btn.innerHTML = html;
    }
  }

  /**
   * Promise-based replacement for confirm()/prompt().
   * Resolves to false when cancelled, true when confirmed, or the input value.
   */
  function ask({ title = 'Are you sure?', message = '', ok = 'OK', danger = false, input = null, requireText = null }) {
    const dlg = $('#confirm-dialog');
    if (!dlg) return Promise.resolve(window.confirm(message || title));
    $('[data-title]', dlg).textContent = title;
    $('[data-message]', dlg).textContent = message;
    $('[data-message]', dlg).hidden = !message;
    const okBtn = $('[data-ok]', dlg);
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? 'btn-danger btn-solid' : 'btn-primary'}`;
    const wrap = $('[data-input-wrap]', dlg);
    const field = $('[data-input]', dlg);
    const wantsInput = Boolean(input || requireText);
    wrap.hidden = !wantsInput;
    if (wantsInput) {
      $('[data-input-label]', dlg).textContent = requireText ? `Type “${requireText}” to confirm` : input.label || '';
      field.value = requireText ? '' : input.value || '';
      field.placeholder = requireText ? requireText : input.placeholder || '';
    }
    const validate = () => {
      okBtn.disabled = (requireText && field.value !== requireText) || (input && !requireText && !field.value.trim());
    };
    field.oninput = validate;
    // Enter should confirm, not hit the first (Cancel) button.
    field.onkeydown = e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!okBtn.disabled) dlg.close('ok');
      }
    };
    validate();
    return new Promise(resolve => {
      dlg.addEventListener(
        'close',
        () => {
          if (dlg.returnValue !== 'ok') return resolve(false);
          resolve(input && !requireText ? field.value.trim() : true);
        },
        { once: true }
      );
      dlg.returnValue = '';
      dlg.showModal();
      if (wantsInput) {
        field.focus();
        field.select();
      } else okBtn.focus();
    });
  }

  /* ------------------------------------------------------------ dialogs */

  document.addEventListener('click', e => {
    const opener = e.target.closest('[data-open-dialog]');
    if (opener) {
      e.preventDefault();
      const dlg = document.getElementById(opener.dataset.openDialog);
      if (dlg) {
        closeMenus();
        dlg.showModal();
        const first = dlg.querySelector('input:not([type=hidden]):not([type=radio]), textarea');
        if (first) first.focus();
      }
      return;
    }
    if (e.target.closest('[data-close]')) {
      e.target.closest('dialog')?.close();
      return;
    }
    // Clicking the backdrop closes a dialog.
    if (e.target instanceof HTMLDialogElement && e.target.classList.contains('dialog')) {
      const r = e.target.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
    }
  });

  /* -------------------------------------------------------------- menus */

  function closeMenus(except) {
    $$('details.menu[open]').forEach(d => d !== except && d.removeAttribute('open'));
  }
  document.addEventListener('toggle', e => {
    if (e.target.matches && e.target.matches('details.menu') && e.target.open) closeMenus(e.target);
  }, true);
  document.addEventListener('click', e => {
    const menu = e.target.closest('details.menu');
    if (!menu) closeMenus();
    else if (e.target.closest('.menu-item')) setTimeout(() => menu.removeAttribute('open'), 0);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenus();
  });

  /* -------------------------------------------------------------- theme */

  const order = ['system', 'light', 'dark'];
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    const html = document.documentElement;
    const next = order[(order.indexOf(html.dataset.theme) + 1) % order.length];
    html.dataset.theme = next;
    toast(`Theme: ${next === 'system' ? 'follow system' : next}`, 'info', 1500);
    api('POST', '/settings/theme', { theme: next }).catch(() => {});
  });

  /* ---------------------------------------------------------- nav + misc */

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-nav-toggle]');
    if (t) $('#nav')?.classList.toggle('open');
    const reload = e.target.closest('[data-reload]');
    if (reload) {
      e.preventDefault();
      location.reload();
    }
  });

  // Buttons that simply POST somewhere and report the result.
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-post]');
    if (!btn) return;
    e.preventDefault();
    try {
      const res = await busy(btn, () => api('POST', btn.dataset.post, {}));
      toast(res.message || 'Done', 'success');
      if (btn.hasAttribute('data-reload-after')) setTimeout(() => location.reload(), 600);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Fill hidden timezone fields on login/setup/join forms.
  $$('form[data-tz-form] input[name="tz"]').forEach(input => {
    try {
      input.value = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      input.value = '';
    }
  });

  // Flash messages from the server.
  const flash = $('#flash-data');
  if (flash) {
    try {
      JSON.parse(flash.textContent).forEach(f => toast(f.message, f.type === 'error' ? 'error' : 'success'));
    } catch {
      /* ignore */
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function pageData() {
    const el = $('#page-data');
    return el ? JSON.parse(el.textContent) : {};
  }

  const enc = encodeURIComponent;
  const fmt = n => new Intl.NumberFormat('en-US').format(Math.round(n || 0));

  window.WW = { api, toast, ask, busy, debounce, escapeHtml, icon, pageData, enc, fmt, $, $$ };
})();
