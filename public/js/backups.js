/* Backups page */
(function () {
  'use strict';
  const { api, toast, ask, busy, $, enc } = window.WW;

  const create = $('[data-create-backup]');
  create?.addEventListener('click', async () => {
    let includeRemote = false;
    if (create.dataset.remote === '1') {
      includeRemote = await ask({
        title: 'Include LiteWriter novels?',
        message: 'WebWriter can also save a copy of the novels on your phone into this backup. This needs the device to be reachable and can take a moment.',
        ok: 'Yes, include them'
      });
    }
    try {
      const res = await busy(create, () => api('POST', '/backups', { includeRemote }, { timeout: 600000 }));
      toast(res.message, 'success');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const uploadBtn = $('[data-upload-backup]');
  const uploadInput = $('[data-upload-input]');
  uploadBtn?.addEventListener('click', () => uploadInput.click());
  uploadInput?.addEventListener('change', async () => {
    if (!uploadInput.files.length) return;
    const fd = new FormData();
    fd.append('backup', uploadInput.files[0]);
    try {
      const res = await busy(uploadBtn, () => api('POST', '/backups/upload', fd, { timeout: 600000 }));
      toast(res.message, 'success');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      uploadInput.value = '';
    }
  });

  document.addEventListener('click', async e => {
    const row = e.target.closest('tr[data-backup]');
    if (!row) return;
    const name = row.dataset.backup;
    const url = `/backups/file/${enc(name)}`;
    try {
      if (e.target.closest('[data-delete-backup]')) {
        if (!(await ask({ title: 'Delete this backup?', message: 'The file will be removed from the server.', ok: 'Delete', danger: true }))) return;
        await api('DELETE', url);
        row.remove();
        toast('Backup deleted.', 'success');
      } else if (e.target.closest('[data-restore]')) {
        const mode = e.target.closest('[data-restore]').dataset.restore;
        const ok = await ask({
          title: mode === 'replace' ? 'Replace your library?' : 'Restore this backup?',
          message:
            mode === 'replace'
              ? 'Your library will contain exactly the novels from this backup. Novels that are not in the backup will be removed. A safety backup is made first.'
              : 'Novels from the backup replace the matching novels in your library. Other novels are kept. A safety backup is made first.',
          ok: 'Restore',
          danger: mode === 'replace'
        });
        if (!ok) return;
        toast('Restoring…', 'info', 2000);
        const res = await api('POST', `${url}/restore`, { mode }, { timeout: 600000 });
        toast(res.message, 'success');
        setTimeout(() => location.reload(), 1200);
      } else if (e.target.closest('[data-drive-upload]')) {
        toast('Uploading to Google Drive…', 'info', 2000);
        const res = await api('POST', `${url}/drive`, {}, { timeout: 600000 });
        toast(res.message, 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
})();
