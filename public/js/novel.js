/* Novel page: structure management, drag & drop ordering, export, edit details */
(function () {
  'use strict';
  const { api, toast, ask, busy, enc, $, $$, escapeHtml } = window.WW;
  const page = window.WW.pageData();
  const base = `/api/novels/${page.source}/${enc(page.id)}`;
  const chapterApi = (book, chapter) => `${base}/books/${enc(book)}/chapters/${enc(chapter)}`;

  const fail = err => toast(err.message, 'error');
  const reload = () => location.reload();

  /* ------------------------------------------------------------ synopsis */

  const synopsis = $('[data-synopsis]');
  const synToggle = $('[data-synopsis-toggle]');
  if (synopsis && synToggle && synopsis.scrollHeight > synopsis.clientHeight + 4) {
    synToggle.hidden = false;
    synToggle.addEventListener('click', () => {
      const clamped = synopsis.classList.toggle('clamped');
      synToggle.textContent = clamped ? 'Show more' : 'Show less';
    });
  }

  /* -------------------------------------------------------------- export */

  const exportDialog = $('#export-dialog');
  const exportForm = $('[data-export-form]');
  exportForm?.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(exportForm);
    const params = new URLSearchParams({ format: fd.get('format') });
    if (fd.get('book')) params.set('book', fd.get('book'));
    if (!fd.get('titles')) params.set('titles', '0');
    if (fd.get('synopsis')) params.set('synopsis', '1');
    const a = document.createElement('a');
    a.href = `/export/${page.source}/${enc(page.id)}?${params}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    exportDialog.close();
    toast(page.source === 'remote' ? 'Preparing your export — fetching chapters from the device…' : 'Preparing your export…', 'info', 3000);
  });

  /* -------------------------------------------------------- edit details */

  const editForm = $('[data-edit-novel]');
  editForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(editForm);
    const btn = editForm.querySelector('[type=submit]');
    try {
      await busy(btn, async () => {
        await api('PATCH', base, {
          title: fd.get('title'),
          author: fd.get('author'),
          language: fd.get('language'),
          synopsis: fd.get('synopsis')
        });
        const cover = fd.get('cover');
        if (cover && cover.size) {
          const cfd = new FormData();
          cfd.append('cover', cover);
          await api('POST', `${base}/cover`, cfd);
        }
      });
      reload();
    } catch (err) {
      fail(err);
    }
  });

  /* ------------------------------------------------------------- ordering */

  function chapterOrder(list) {
    return $$('.chapter[data-chapter]:not(.synopsis)', list).map(li => li.dataset.chapter);
  }

  async function saveOrder(list) {
    await api('PUT', `${base}/order`, { chapters: { [list.dataset.book]: chapterOrder(list) } });
  }

  async function moveChapterBy(book, chapter, delta) {
    const list = $(`[data-chapter-list][data-book="${CSS.escape(book)}"]`);
    const items = $$('.chapter[data-chapter]:not(.synopsis)', list);
    const i = items.findIndex(li => li.dataset.chapter === chapter);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return;
    if (delta < 0) items[j].before(items[i]);
    else items[j].after(items[i]);
    try {
      await saveOrder(list);
    } catch (err) {
      fail(err);
      reload();
    }
  }

  function chooseBook(current) {
    const options = page.books.filter(b => b.name !== current);
    return new Promise(resolve => {
      const dlg = document.createElement('dialog');
      dlg.className = 'dialog';
      dlg.innerHTML = `<form method="dialog">
        <div class="dialog-header"><h2>Move to another book</h2></div>
        <div class="dialog-body"><div class="field"><label class="label" for="move-target">Book</label>
          <select class="select" id="move-target">${options.map(b => `<option value="${escapeHtml(b.name)}">${escapeHtml(b.label)}</option>`).join('')}</select></div></div>
        <div class="dialog-footer"><button class="btn" value="cancel">Cancel</button><button class="btn btn-primary" value="ok">Move</button></div></form>`;
      document.body.appendChild(dlg);
      dlg.addEventListener('close', () => {
        resolve(dlg.returnValue === 'ok' ? dlg.querySelector('select').value : null);
        dlg.remove();
      });
      dlg.showModal();
    });
  }

  /* -------------------------------------------------------------- actions */

  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, book, chapter } = el.dataset;
    e.preventDefault();
    try {
      switch (action) {
        case 'new-chapter': {
          const list = $(`[data-chapter-list][data-book="${CSS.escape(book)}"]`);
          const count = list ? chapterOrder(list).length : 0;
          const name = await ask({ title: 'New chapter', ok: 'Create', input: { label: 'Chapter name', value: `Chapter ${count + 1}` } });
          if (!name) return;
          const res = await api('POST', `${base}/books/${enc(book)}/chapters`, { name });
          location.href = res.url;
          break;
        }
        case 'new-book': {
          const name = await ask({ title: 'New book', ok: 'Create', input: { label: 'Book name', placeholder: 'e.g. Part Two' } });
          if (!name) return;
          await api('POST', `${base}/books`, { name });
          reload();
          break;
        }
        case 'rename-book': {
          const name = await ask({ title: 'Rename book', ok: 'Rename', input: { label: 'Book name', value: book } });
          if (!name || name === book) return;
          await api('PATCH', `${base}/books/${enc(book)}`, { name });
          reload();
          break;
        }
        case 'delete-book': {
          const list = $(`[data-chapter-list][data-book="${CSS.escape(book)}"]`);
          const n = list ? chapterOrder(list).length : 0;
          const ok = await ask({ title: `Delete “${book}”?`, message: n ? `This deletes the book and its ${n} chapter${n === 1 ? '' : 's'}. This cannot be undone.` : 'This book is empty.', ok: 'Delete book', danger: true, requireText: n ? book : null });
          if (!ok) return;
          await api('DELETE', `${base}/books/${enc(book)}`);
          reload();
          break;
        }
        case 'export-book': {
          $('#export-book').value = book;
          exportDialog.showModal();
          break;
        }
        case 'rename-chapter': {
          const name = await ask({ title: 'Rename chapter', ok: 'Rename', input: { label: 'Chapter name', value: chapter } });
          if (!name || name === chapter) return;
          await api('PATCH', chapterApi(book, chapter), { name });
          reload();
          break;
        }
        case 'delete-chapter': {
          const ok = await ask({ title: `Delete “${chapter}”?`, message: 'The chapter and its text will be deleted permanently.', ok: 'Delete', danger: true });
          if (!ok) return;
          await api('DELETE', chapterApi(book, chapter));
          reload();
          break;
        }
        case 'move-up':
        case 'move-down':
          await moveChapterBy(book, chapter, action === 'move-up' ? -1 : 1);
          break;
        case 'move-book': {
          const target = await chooseBook(book);
          if (!target) return;
          await api('PATCH', chapterApi(book, chapter), { book: target });
          reload();
          break;
        }
        case 'remove-cover': {
          await busy(el, () => api('DELETE', `${base}/cover`));
          reload();
          break;
        }
        case 'copy': {
          const res = await busy(el, () => api('POST', `${base}/copy`, {}, { timeout: 300000 }));
          toast('Copied to your library.', 'success');
          setTimeout(() => (location.href = res.url), 500);
          break;
        }
        case 'delete-novel': {
          const ok = await ask({ title: 'Delete this novel?', message: 'All books and chapters will be deleted permanently. Consider exporting or backing up first.', ok: 'Delete novel', danger: true, requireText: page.title });
          if (!ok) return;
          await api('DELETE', base);
          location.href = '/library';
          break;
        }
      }
    } catch (err) {
      fail(err);
    }
  });

  /* --------------------------------------------------------- drag & drop */

  if (!page.canEdit) return;
  let dragged = null;
  let fromList = null;

  function clearMarks() {
    $$('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    $$('.drop-into').forEach(el => el.classList.remove('drop-into'));
  }

  document.addEventListener('dragstart', e => {
    const li = e.target.closest && e.target.closest('.chapter[draggable="true"]');
    if (!li) return;
    dragged = li;
    fromList = li.closest('[data-chapter-list]');
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.chapter);
  });

  document.addEventListener('dragend', () => {
    dragged?.classList.remove('dragging');
    clearMarks();
    dragged = null;
  });

  document.addEventListener('dragover', e => {
    if (!dragged) return;
    const list = e.target.closest('[data-chapter-list]');
    if (!list) return;
    e.preventDefault();
    clearMarks();
    const target = e.target.closest('.chapter[data-chapter]:not(.synopsis)');
    if (target && target !== dragged) {
      const r = target.getBoundingClientRect();
      target.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    } else if (!target) list.classList.add('drop-into');
  });

  document.addEventListener('drop', async e => {
    if (!dragged) return;
    const list = e.target.closest('[data-chapter-list]');
    if (!list) return;
    e.preventDefault();
    const target = e.target.closest('.chapter[data-chapter]:not(.synopsis)');
    const before = target && target.classList.contains('drop-before');
    clearMarks();
    const item = dragged;
    const source = fromList;
    if (target && target !== item) {
      if (before) target.before(item);
      else target.after(item);
    } else if (!target) {
      list.querySelector('.chapter-empty')?.remove();
      list.appendChild(item);
    }
    try {
      if (list !== source) {
        await api('PATCH', chapterApi(source.dataset.book, item.dataset.chapter), { book: list.dataset.book });
        await saveOrder(list);
        reload();
      } else {
        await saveOrder(list);
      }
    } catch (err) {
      fail(err);
      reload();
    }
  });
})();
