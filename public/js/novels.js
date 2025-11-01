(function() {
  'use strict';

  document.addEventListener('DOMContentLoaded', function() {
    
    var openCreateNovelBtn = document.getElementById('openCreateNovelBtn');
    var closeCreateNovelBtn = document.getElementById('closeCreateNovelBtn');
    var cancelCreateNovelBtn = document.getElementById('cancelCreateNovelBtn');
    var createNovelModal = document.getElementById('createNovelModal');
    
    if (openCreateNovelBtn) {
      openCreateNovelBtn.addEventListener('click', function() {
        createNovelModal.classList.add('active');
      });
    }
    
    if (closeCreateNovelBtn) {
      closeCreateNovelBtn.addEventListener('click', function() {
        createNovelModal.classList.remove('active');
      });
    }
    
    if (cancelCreateNovelBtn) {
      cancelCreateNovelBtn.addEventListener('click', function() {
        createNovelModal.classList.remove('active');
      });
    }

    // Create novel form
    var createNovelForm = document.getElementById('createNovelForm');
    if (createNovelForm) {
      createNovelForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        var formData = new FormData(createNovelForm);
        
        fetch('/novels/create', {
          method: 'POST',
          body: formData
        })
        .then(function(response) {
          return response.json();
        })
        .then(function(data) {
          if (data.success) {
            window.showNotification('Novel created successfully!');
            createNovelModal.classList.remove('active');
            createNovelForm.reset();
            
            // Reload novels dynamically
            loadNovels();
          } else {
            window.showNotification('Failed to create novel', 'error');
          }
        })
        .catch(function(err) {
          console.error('Error creating novel:', err);
          window.showNotification('Failed to create novel', 'error');
        });
      });
    }

    // Preview cover image
    var coverInput = document.getElementById('coverInput');
    var coverPreview = document.getElementById('coverPreview');

    if (coverInput && coverPreview) {
      coverInput.addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (file) {
          var reader = new FileReader();
          reader.onload = function(e) {
            coverPreview.src = e.target.result;
            coverPreview.style.display = 'block';
          };
          reader.readAsDataURL(file);
        }
      });
    }

  });

  // Load novels dynamically
  function loadNovels() {
    fetch('/novels/api/list')
      .then(function(response) {
        return response.json();
      })
      .then(function(data) {
        var novelsGrid = document.getElementById('novelsGrid');
        var emptyState = document.getElementById('emptyState');
        
        if (data.novels.length === 0) {
          novelsGrid.innerHTML = '';
          emptyState.style.display = 'block';
        } else {
          emptyState.style.display = 'none';
          novelsGrid.innerHTML = data.novels.map(function(novel) {
            return '<a href="/novels/' + novel.id + '" class="novel-card card">' +
              '<img src="' + novel.cover + '" alt="' + novel.title + '" class="novel-cover">' +
              '<h3 class="novel-title">' + novel.title + '</h3>' +
              '<div class="novel-stats">' +
                '<span>📝 ' + (novel.wordCount || 0) + ' words</span>' +
                '<span>📚 ' + (novel.bookCount || 0) + ' books</span>' +
              '</div>' +
              '<p class="novel-synopsis">' + novel.synopsis + '</p>' +
            '</a>';
          }).join('');
        }
      })
      .catch(function(err) {
        console.error('Error loading novels:', err);
      });
  }

})();