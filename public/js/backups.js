(function() {
  'use strict';

  document.addEventListener('DOMContentLoaded', function() {
    
    var createBackupBtn = document.getElementById('createBackupBtn');
    
    if (createBackupBtn) {
      createBackupBtn.addEventListener('click', function() {
        this.disabled = true;
        this.textContent = 'Creating...';
        var btn = this;
        
        fetch('/backups/create', {
          method: 'POST'
        })
        .then(function(response) {
          return response.json();
        })
        .then(function(data) {
          btn.disabled = false;
          btn.textContent = 'Create Backup';
          
          if (data.success) {
            window.showNotification('Backup created successfully');
            setTimeout(function() {
              location.reload();
            }, 1000);
          } else {
            window.showNotification('Failed to create backup', 'error');
          }
        })
        .catch(function(err) {
          console.error('Error creating backup:', err);
          btn.disabled = false;
          btn.textContent = 'Create Backup';
          window.showNotification('Failed to create backup', 'error');
        });
      });
    }
    
    var restoreBackupBtns = document.querySelectorAll('.restore-backup-btn');
    restoreBackupBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var backupName = this.getAttribute('data-backup');
        
        window.showConfirm('Are you sure you want to restore this backup? This will overwrite all current data!', function() {
          btn.disabled = true;
          btn.textContent = 'Restoring...';
          
          fetch('/backups/restore/' + backupName, {
            method: 'POST'
          })
          .then(function(response) {
            return response.json();
          })
          .then(function(data) {
            btn.disabled = false;
            btn.textContent = 'Restore';
            
            if (data.success) {
              window.showNotification('Backup restored successfully. Please refresh the page.');
              setTimeout(function() {
                location.reload();
              }, 2000);
            } else {
              window.showNotification('Failed to restore backup', 'error');
            }
          })
          .catch(function(err) {
            console.error('Error restoring backup:', err);
            btn.disabled = false;
            btn.textContent = 'Restore';
            window.showNotification('Failed to restore backup', 'error');
          });
        });
      });
    });
    
    var deleteBackupBtns = document.querySelectorAll('.delete-backup-btn');
    deleteBackupBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var backupName = this.getAttribute('data-backup');
        
        window.showConfirm('Are you sure you want to delete this backup?', function() {
          fetch('/backups/' + backupName, {
            method: 'DELETE'
          })
          .then(function(response) {
            return response.json();
          })
          .then(function(data) {
            if (data.success) {
              window.showNotification('Backup deleted successfully');
              setTimeout(function() {
                location.reload();
              }, 1000);
            } else {
              window.showNotification('Failed to delete backup', 'error');
            }
          })
          .catch(function(err) {
            console.error('Error deleting backup:', err);
            window.showNotification('Failed to delete backup', 'error');
          });
        });
      });
    });
    
    var uploadDriveBtns = document.querySelectorAll('.upload-drive-btn');
    uploadDriveBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var backupName = this.getAttribute('data-backup');
        this.disabled = true;
        this.textContent = 'Uploading...';
        var originalBtn = this;
        
        fetch('/backups/google-drive/upload/' + backupName, {
          method: 'POST'
        })
        .then(function(response) {
          return response.json();
        })
        .then(function(data) {
          originalBtn.disabled = false;
          originalBtn.textContent = 'Upload to Drive';
          
          if (data.success) {
            window.showNotification('Uploaded to Google Drive successfully');
          } else {
            if (data.helpUrl) {
              window.showNotification(data.error, 'error');
              setTimeout(function() {
                if (confirm(data.error + '\n\nWould you like to open Google Cloud Console to enable the API?')) {
                  window.open(data.helpUrl, '_blank');
                }
              }, 500);
            } else {
              window.showNotification(data.error || 'Failed to upload to Google Drive', 'error');
            }
          }
        })
        .catch(function(err) {
          console.error('Error uploading to Google Drive:', err);
          originalBtn.disabled = false;
          originalBtn.textContent = 'Upload to Drive';
          window.showNotification('Failed to upload to Google Drive', 'error');
        });
      });
    });

  });

})();
