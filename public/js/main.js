// Theme management
const themeToggle = document.getElementById('themeToggle');
const html = document.documentElement;

// Load saved theme
const savedTheme = localStorage.getItem('theme') || 'dark';
html.setAttribute('data-theme', savedTheme);

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const currentTheme = html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    html.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    
    // Save to server
    fetch('/settings/theme', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ theme: newTheme })
    }).catch(err => console.error('Error saving theme:', err));
  });
}

// Modal management - Make globally accessible
window.openModal = function(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');
  }
};

window.closeModal = function(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
  }
};

// Close modal on outside click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    e.target.classList.remove('active');
  }
});

// Close modal on escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.active').forEach(modal => {
      modal.classList.remove('active');
    });
  }
});

// Show notification - Make globally accessible
window.showNotification = function(message, type) {
  type = type || 'success';
  const notification = document.createElement('div');
  notification.className = 'notification notification-' + type;
  notification.textContent = message;
  notification.style.cssText = 
    'position: fixed;' +
    'top: 2rem;' +
    'right: 2rem;' +
    'background: var(--' + (type === 'success' ? 'success' : 'danger') + ');' +
    'color: white;' +
    'padding: 1rem 1.5rem;' +
    'border-radius: 6px;' +
    'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);' +
    'z-index: 10000;' +
    'animation: slideIn 0.3s ease;';
  
  document.body.appendChild(notification);
  
  setTimeout(function() {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(function() {
      notification.remove();
    }, 300);
  }, 3000);
};

// Add animations
const style = document.createElement('style');
style.textContent = 
  '@keyframes slideIn {' +
    'from { transform: translateX(100%); opacity: 0; }' +
    'to { transform: translateX(0); opacity: 1; }' +
  '}' +
  '@keyframes slideOut {' +
    'from { transform: translateX(0); opacity: 1; }' +
    'to { transform: translateX(100%); opacity: 0; }' +
  '}';
document.head.appendChild(style);
