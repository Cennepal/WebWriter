(function() {
  'use strict';

  // Make these functions globally accessible
  window.showPrompt = function(message, label, callback) {
    var promptModal = document.getElementById('promptModal');
    var promptTitle = document.getElementById('promptTitle');
    var promptLabel = document.getElementById('promptLabel');
    var promptInput = document.getElementById('promptInput');
    var promptOkBtn = document.getElementById('promptOkBtn');
    var promptCancelBtn = document.getElementById('promptCancelBtn');
    var closePromptBtn = document.getElementById('closePromptBtn');
    
    promptTitle.textContent = message;
    promptLabel.textContent = label;
    promptInput.value = '';
    
    promptModal.classList.add('active');
    setTimeout(function() {
      promptInput.focus();
    }, 100);
    
    function handleOk() {
      var value = promptInput.value.trim();
      promptModal.classList.remove('active');
      cleanup();
      if (value) {
        callback(value);
      }
    }
    
    function handleCancel() {
      promptModal.classList.remove('active');
      cleanup();
    }
    
    function cleanup() {
      promptOkBtn.removeEventListener('click', handleOk);
      promptCancelBtn.removeEventListener('click', handleCancel);
      closePromptBtn.removeEventListener('click', handleCancel);
      promptInput.removeEventListener('keypress', handleKeypress);
    }
    
    function handleKeypress(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleOk();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    }
    
    promptOkBtn.addEventListener('click', handleOk);
    promptCancelBtn.addEventListener('click', handleCancel);
    closePromptBtn.addEventListener('click', handleCancel);
    promptInput.addEventListener('keypress', handleKeypress);
  };
  
  window.showConfirm = function(message, callback) {
    var confirmModal = document.getElementById('confirmModal');
    var confirmMessage = document.getElementById('confirmMessage');
    var confirmOkBtn = document.getElementById('confirmOkBtn');
    var confirmCancelBtn = document.getElementById('confirmCancelBtn');
    var closeConfirmBtn = document.getElementById('closeConfirmBtn');
    
    confirmMessage.textContent = message;
    confirmModal.classList.add('active');
    
    function handleOk() {
      confirmModal.classList.remove('active');
      cleanup();
      callback();
    }
    
    function handleCancel() {
      confirmModal.classList.remove('active');
      cleanup();
    }
    
    function cleanup() {
      confirmOkBtn.removeEventListener('click', handleOk);
      confirmCancelBtn.removeEventListener('click', handleCancel);
      closeConfirmBtn.removeEventListener('click', handleCancel);
    }
    
    confirmOkBtn.addEventListener('click', handleOk);
    confirmCancelBtn.addEventListener('click', handleCancel);
    closeConfirmBtn.addEventListener('click', handleCancel);
  };

  document.addEventListener('DOMContentLoaded', function() {
    
    var editNovelBtn = document.getElementById('editNovelBtn');
    var deleteNovelBtn = document.getElementById('deleteNovelBtn');
    var createBookBtn = document.getElementById('createBookBtn');
    var editNovelModal = document.getElementById('editNovelModal');
    var closeEditNovelBtn = document.getElementById('closeEditNovelBtn');
    var cancelEditNovelBtn = document.getElementById('cancelEditNovelBtn');
    var editNovelForm = document.getElementById('editNovelForm');
    
    // Edit novel button
    if (editNovelBtn) {
      editNovelBtn.addEventListener('click', function() {
        editNovelModal.classList.add('active');
      });
    }
    
    if (closeEditNovelBtn) {
      closeEditNovelBtn.addEventListener('click', function() {
        editNovelModal.classList.remove('active');
      });
    }
    
    if (cancelEditNovelBtn) {
      cancelEditNovelBtn.addEventListener('click', function() {
        editNovelModal.classList.remove('active');
      });
    }
    
    // Edit novel form
    if (editNovelForm) {
      editNovelForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        var formData = new FormData(editNovelForm);
        
        fetch('/novels/' + window.novelId + '/update', {
          method: 'POST',
          body: formData
        })
        .then(function(response) {
          return response.json();
        })
        .then(function(data) {
          if (data.success) {
            window.showNotification('Novel updated successfully!');
            editNovelModal.classList.remove('active');
            setTimeout(function() {
              window.location.reload();
            }, 1000);
          } else {
            window.showNotification('Failed to update novel', 'error');
          }
        })
        .catch(function(err) {
          console.error('Error updating novel:', err);
          window.showNotification('Failed to update novel', 'error');
        });
      });
    }
    
    // Preview edit cover
    var editCoverInput = document.getElementById('editCoverInput');
    var editCoverPreview = document.getElementById('editCoverPreview');
    
    if (editCoverInput && editCoverPreview) {
      editCoverInput.addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (file) {
          var reader = new FileReader();
          reader.onload = function(e) {
            editCoverPreview.src = e.target.result;
          };
          reader.readAsDataURL(file);
        }
      });
    }
    
    // Delete novel
    if (deleteNovelBtn) {
      deleteNovelBtn.addEventListener('click', function() {
        window.showConfirm('Are you sure you want to delete this novel? This action cannot be undone.', function() {
          fetch('/novels/' + window.novelId, {
            method: 'DELETE'
          })
          .then(function(response) {
            return response.json();
          })
          .then(function(data) {
            if (data.success) {
              window.showNotification('Novel deleted successfully');
              setTimeout(function() {
                window.location.href = '/novels';
              }, 1000);
            } else {
              window.showNotification('Failed to delete novel', 'error');
            }
          })
          .catch(function(err) {
            console.error('Error deleting novel:', err);
            window.showNotification('Failed to delete novel', 'error');
          });
        });
      });
    }
    
    // Create book
    if (createBookBtn) {
      createBookBtn.addEventListener('click', function() {
        window.showPrompt('Enter book name:', 'Book Name', function(name) {
          if (!name) return;
          
          fetch('/novels/' + window.novelId + '/books/create', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: name })
          })
          .then(function(response) {
            return response.json();
          })
          .then(function(data) {
            if (data.success) {
              window.showNotification('Book created successfully');
              setTimeout(function() {
                location.reload();
              }, 1000);
            } else {
              window.showNotification('Failed to create book', 'error');
            }
          })
          .catch(function(err) {
            console.error('Error creating book:', err);
            window.showNotification('Failed to create book', 'error');
          });
        });
      });
    }
    
    // Delete book buttons
    var deleteBookBtns = document.querySelectorAll('.delete-book-btn');
    deleteBookBtns.forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var book = this.getAttribute('data-book');
        
        if (book === 'Main') {
          window.showNotification('Cannot delete Main book', 'error');
          return;
        }
        
        window.showConfirm('Are you sure you want to delete the book "' + book + '" and all its chapters?', function() {
          fetch('/novels/' + window.novelId + '/books/' + encodeURIComponent(book), {
            method: 'DELETE'
          })
          .then(function(response) {
            return response.json();
          })
          .then(function(data) {
            if (data.success) {
              window.showNotification('Book deleted successfully');
              setTimeout(function() {
                location.reload();
              }, 1000);
            } else {
              window.showNotification(data.error || 'Failed to delete book', 'error');
            }
          })
          .catch(function(err) {
            console.error('Error deleting book:', err);
            window.showNotification('Failed to delete book', 'error');
          });
        });
      });
    });
    
    // Create chapter buttons
    var createChapterBtns = document.querySelectorAll('.create-chapter-btn');
    createChapterBtns.forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var book = this.getAttribute('data-book');
        
        window.showPrompt('Enter chapter name:', 'Chapter Name', function(name) {
          if (!name) return;
          
          fetch('/novels/' + window.novelId + '/books/' + encodeURIComponent(book) + '/chapters/create', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: name })
          })
          .then(function(response) {
            return response.json();
          })
          .then(function(data) {
            if (data.success) {
              window.showNotification('Chapter created successfully');
              setTimeout(function() {
                location.reload();
              }, 1000);
            } else {
              window.showNotification('Failed to create chapter', 'error');
            }
          })
          .catch(function(err) {
            console.error('Error creating chapter:', err);
            window.showNotification('Failed to create chapter', 'error');
          });
        });
      });
    });
    
    // Delete chapter buttons
    var deleteChapterBtns = document.querySelectorAll('.delete-chapter-btn');
    deleteChapterBtns.forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var book = this.getAttribute('data-book');
        var chapter = this.getAttribute('data-chapter');
        
        if (book === 'Main' && chapter === 'Synopsis') {
          window.showNotification('Cannot delete Synopsis', 'error');
          return;
        }
        
        window.showConfirm('Are you sure you want to delete the chapter "' + chapter + '"?', function() {
          fetch('/novels/' + window.novelId + '/books/' + encodeURIComponent(book) + '/chapters/' + encodeURIComponent(chapter), {
            method: 'DELETE'
          })
          .then(function(response) {
            return response.json();
          })
          .then(function(data) {
            if (data.success) {
              window.showNotification('Chapter deleted successfully');
              setTimeout(function() {
                location.reload();
              }, 1000);
            } else {
              window.showNotification(data.error || 'Failed to delete chapter', 'error');
            }
          })
          .catch(function(err) {
            console.error('Error deleting chapter:', err);
            window.showNotification('Failed to delete chapter', 'error');
          });
        });
      });
    });
    
    // Toggle book sections
    var bookHeaders = document.querySelectorAll('.book-header');
    bookHeaders.forEach(function(header) {
      header.addEventListener('click', function(e) {
        if (e.target.closest('button')) {
          return;
        }
        
        var chaptersList = header.nextElementSibling;
        if (chaptersList && chaptersList.classList.contains('chapters-list')) {
          var isHidden = chaptersList.style.display === 'none';
          chaptersList.style.display = isHidden ? 'block' : 'none';
        }
      });
    });

  });

})();
