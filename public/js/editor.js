(function() {
  'use strict';

  let saveTimeout;
  let hasUnsavedChanges = false;
  let editorZoom = localStorage.getItem('editorZoom') || '1.1';

  document.addEventListener('DOMContentLoaded', function() {
    var saveIndicator = document.querySelector('.save-indicator');
    var saveStatus = document.getElementById('saveStatus');
    var editorTextarea = document.getElementById('editorTextarea');
    var editorToolbar = document.getElementById('editorToolbar');
    var toggleToolbarBtn = document.getElementById('toggleToolbarBtn');
    var boldBtn = document.getElementById('boldBtn');
    var italicBtn = document.getElementById('italicBtn');
    var headingBtn = document.getElementById('headingBtn');
    var linkBtn = document.getElementById('linkBtn');
    var quoteBtn = document.getElementById('quoteBtn');
    var listBtn = document.getElementById('listBtn');
    var zoomInBtn = document.getElementById('zoomInBtn');
    var zoomOutBtn = document.getElementById('zoomOutBtn');
    var zoomResetBtn = document.getElementById('zoomResetBtn');

    // Apply saved zoom
    if (editorTextarea) {
      editorTextarea.style.fontSize = editorZoom + 'rem';
      
      editorTextarea.addEventListener('input', function() {
        hasUnsavedChanges = true;
        if (saveIndicator) {
          saveIndicator.classList.add('unsaved');
        }
        if (saveStatus) {
          saveStatus.textContent = 'Unsaved';
        }
        
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(function() {
          saveContent();
        }, 3000);
      });
      
      editorTextarea.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          saveContent();
        }
        
        if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
          e.preventDefault();
          insertMarkdown('**', '**');
        }
        
        if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
          e.preventDefault();
          insertMarkdown('*', '*');
        }
        
        if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
          e.preventDefault();
          toggleToolbar();
        }
        
        if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
          e.preventDefault();
          zoomIn();
        }
        
        if ((e.ctrlKey || e.metaKey) && e.key === '-') {
          e.preventDefault();
          zoomOut();
        }
        
        if ((e.ctrlKey || e.metaKey) && e.key === '0') {
          e.preventDefault();
          resetZoom();
        }
      });
    }

    function saveContent() {
      if (!hasUnsavedChanges) return;
      
      var pathParts = window.location.pathname.split('/');
      var novelId = pathParts[2];
      var book = pathParts[3];
      var chapter = pathParts[4];
      
      var content = editorTextarea.value;
      
      // Use different endpoint based on remote status
      var saveUrl = window.isRemote 
        ? '/litewriter/novels/' + novelId + '/' + book + '/' + chapter + '/save'
        : '/editor/' + novelId + '/' + book + '/' + chapter + '/save';
      
      fetch(saveUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: content })
      })
      .then(function(response) {
        return response.json();
      })
      .then(function(data) {
        if (data.success) {
          hasUnsavedChanges = false;
          if (saveIndicator) {
            saveIndicator.classList.remove('unsaved');
          }
          if (saveStatus) {
            saveStatus.textContent = 'Saved';
          }
        }
      })
      .catch(function(err) {
        console.error('Error saving content:', err);
      });
    }

    function insertMarkdown(before, after) {
      var start = editorTextarea.selectionStart;
      var end = editorTextarea.selectionEnd;
      var text = editorTextarea.value;
      var selectedText = text.substring(start, end);
      
      var newText = text.substring(0, start) + before + selectedText + after + text.substring(end);
      editorTextarea.value = newText;
      
      editorTextarea.focus();
      editorTextarea.setSelectionRange(start + before.length, end + before.length);
      
      var event = new Event('input');
      editorTextarea.dispatchEvent(event);
    }

    function toggleToolbar() {
      if (editorToolbar) {
        editorToolbar.classList.toggle('collapsed');
        if (editorToolbar.classList.contains('collapsed')) {
          if (toggleToolbarBtn) toggleToolbarBtn.textContent = 'Show (Ctrl+H)';
        } else {
          if (toggleToolbarBtn) toggleToolbarBtn.textContent = 'Hide (Ctrl+H)';
        }
      }
    }

    function zoomIn() {
      editorZoom = (parseFloat(editorZoom) + 0.1).toFixed(1);
      if (parseFloat(editorZoom) > 3.0) editorZoom = '3.0';
      applyZoom();
    }

    function zoomOut() {
      editorZoom = (parseFloat(editorZoom) - 0.1).toFixed(1);
      if (parseFloat(editorZoom) < 0.6) editorZoom = '0.6';
      applyZoom();
    }

    function resetZoom() {
      editorZoom = '1.1';
      applyZoom();
    }

    function applyZoom() {
      editorTextarea.style.fontSize = editorZoom + 'rem';
      localStorage.setItem('editorZoom', editorZoom);
    }

    if (boldBtn) { boldBtn.addEventListener('click', function() { insertMarkdown('**', '**'); }); }
    if (italicBtn) { italicBtn.addEventListener('click', function() { insertMarkdown('*', '*'); }); }
    if (headingBtn) {
      headingBtn.addEventListener('click', function() {
        var start = editorTextarea.selectionStart;
        var text = editorTextarea.value;
        var lineStart = text.lastIndexOf('\n', start - 1) + 1;
        var newText = text.substring(0, lineStart) + '# ' + text.substring(lineStart);
        editorTextarea.value = newText;
        editorTextarea.setSelectionRange(start + 2, start + 2);
        editorTextarea.dispatchEvent(new Event('input'));
      });
    }
    if (linkBtn) { linkBtn.addEventListener('click', function() { insertMarkdown('[', '](url)'); }); }
    if (quoteBtn) {
      quoteBtn.addEventListener('click', function() {
        var start = editorTextarea.selectionStart;
        var text = editorTextarea.value;
        var lineStart = text.lastIndexOf('\n', start - 1) + 1;
        var newText = text.substring(0, lineStart) + '> ' + text.substring(lineStart);
        editorTextarea.value = newText;
        editorTextarea.setSelectionRange(start + 2, start + 2);
        editorTextarea.dispatchEvent(new Event('input'));
      });
    }
    if (listBtn) {
      listBtn.addEventListener('click', function() {
        var start = editorTextarea.selectionStart;
        var text = editorTextarea.value;
        var lineStart = text.lastIndexOf('\n', start - 1) + 1;
        var newText = text.substring(0, lineStart) + '- ' + text.substring(lineStart);
        editorTextarea.value = newText;
        editorTextarea.setSelectionRange(start + 2, start + 2);
        editorTextarea.dispatchEvent(new Event('input'));
      });
    }
    if (toggleToolbarBtn) { toggleToolbarBtn.addEventListener('click', function() { toggleToolbar(); }); }
    if (zoomInBtn) { zoomInBtn.addEventListener('click', function() { zoomIn(); }); }
    if (zoomOutBtn) { zoomOutBtn.addEventListener('click', function() { zoomOut(); }); }
    if (zoomResetBtn) { zoomResetBtn.addEventListener('click', function() { resetZoom(); }); }

    window.addEventListener('beforeunload', function(e) {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
        saveContent();
      }
    });

  });

})();
