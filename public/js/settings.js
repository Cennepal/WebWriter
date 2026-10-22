/* Settings, backups schedule and other simple forms */
(function () {
  'use strict';
  const { api, toast, busy, $, $$, escapeHtml, icon } = window.WW;

  function formPayload(form) {
    if (form.enctype === 'multipart/form-data') {
      const fd = new FormData(form);
      $$('input[type=checkbox]', form).forEach(cb => fd.set(cb.name, cb.checked ? 'true' : 'false'));
      return fd;
    }
    const data = {};
    new FormData(form).forEach((v, k) => (data[k] = v));
    $$('input[type=checkbox]', form).forEach(cb => (data[cb.name] = cb.checked));
    return data;
  }

  $$('form[data-settings-form]').forEach(form => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      try {
        const res = await busy(btn, () => api('POST', form.getAttribute('action'), formPayload(form)));
        toast(res.message || 'Saved', 'success');
        if (form.hasAttribute('data-reset')) form.reset();
        if (res.reload) setTimeout(() => location.reload(), 500);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  $$('input[type=range][data-range], input[type=range][data-range-percent]').forEach(input => {
    const out = $(`[data-range-out="${input.id}"]`);
    const show = () => {
      if (out) out.textContent = input.hasAttribute('data-range-percent') ? `${Math.round(input.value * 100)}%` : input.value;
    };
    input.addEventListener('input', show);
  });

  const detect = $('[data-detect-tz]');
  detect?.addEventListener('click', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const select = $('[data-tz-select]');
    if (tz && select) {
      select.value = tz;
      toast(`Detected ${tz}. Don't forget to save.`, 'info');
    }
  });

  const lwForm = $('[data-litewriter-form]');
  const testBtn = $('[data-test-connection]');
  testBtn?.addEventListener('click', async () => {
    const out = $('[data-test-result]');
    out.innerHTML = '';
    try {
      const res = await busy(testBtn, () => api('POST', '/settings/litewriter/test', formPayload(lwForm), { timeout: 60000 }));
      out.innerHTML = `<div class="alert alert-success" style="margin:1rem 0 0">${icon('check')}<div>${escapeHtml(res.message)}</div></div>`;
    } catch (err) {
      out.innerHTML = `<div class="alert alert-error" style="margin:1rem 0 0">${icon('alert')}<div>${escapeHtml(err.message)}</div></div>`;
    }
  });
})();
