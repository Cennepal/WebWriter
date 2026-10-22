/* User & invite management */
(function () {
  'use strict';
  const { api, toast, ask, busy, $ } = window.WW;

  const form = $('[data-invite-form]');
  const dialog = $('#invite-dialog');
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = $('[data-invite-submit]');
    try {
      const res = await busy(btn, () =>
        api('POST', '/admin/invites', {
          note: fd.get('note'),
          expiresInDays: Number(fd.get('expiresInDays')),
          maxUses: Number(fd.get('maxUses')),
          role: fd.get('admin') ? 'admin' : 'user'
        })
      );
      $('[data-invite-fields]').hidden = true;
      $('[data-invite-result]').hidden = false;
      $('[data-invite-link]').value = res.link;
      btn.hidden = true;
      $('[data-invite-link]').select();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  dialog?.addEventListener('close', () => {
    if (!$('[data-invite-result]').hidden) location.reload();
  });
  $('[data-copy-invite]')?.addEventListener('click', async () => {
    const input = $('[data-invite-link]');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    toast('Invite link copied.', 'success', 2000);
  });

  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-user-action]');
    const inviteBtn = e.target.closest('[data-invite-action]');
    try {
      if (btn) {
        const row = btn.closest('tr');
        const id = row.dataset.userId;
        const name = row.dataset.username;
        const action = btn.dataset.userAction;
        let res;
        if (action === 'role') {
          res = await api('POST', `/admin/users/${id}/role`, { role: btn.dataset.value });
        } else if (action === 'disabled') {
          const disabled = btn.dataset.value === 'true';
          if (disabled && !(await ask({ title: `Disable ${name}?`, message: 'They will be signed out and cannot sign in until you enable the account again. Their novels are kept.', ok: 'Disable', danger: true }))) return;
          res = await api('POST', `/admin/users/${id}/disabled`, { disabled });
        } else if (action === 'reset') {
          if (!(await ask({ title: `Reset ${name}'s password?`, message: 'A temporary password is generated. They have to choose a new one the next time they sign in.', ok: 'Reset password' }))) return;
          res = await api('POST', `/admin/users/${id}/reset-password`, {});
          await ask({ title: 'Temporary password', message: `Give ${name} this password: ${res.password}  — it is only shown once.`, ok: 'Done' });
          location.reload();
          return;
        } else if (action === 'delete') {
          const ok = await ask({ title: `Delete ${name}?`, message: 'This permanently deletes the account together with all of its novels and backups.', ok: 'Delete user', danger: true, requireText: name });
          if (!ok) return;
          res = await api('DELETE', `/admin/users/${id}`, { confirm: name });
        }
        if (res) {
          toast(res.message || 'Done', 'success');
          setTimeout(() => location.reload(), 600);
        }
      } else if (inviteBtn) {
        const id = inviteBtn.closest('tr').dataset.inviteId;
        if (inviteBtn.dataset.inviteAction === 'revoke') await busy(inviteBtn, () => api('POST', `/admin/invites/${id}/revoke`, {}));
        else await api('DELETE', `/admin/invites/${id}`);
        location.reload();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
})();
