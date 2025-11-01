// Generate charts using Chart.js if available
document.addEventListener('DOMContentLoaded', () => {
  // Daily words chart
  const dailyWordsCanvas = document.getElementById('dailyWordsChart');
  if (dailyWordsCanvas && typeof Chart !== 'undefined') {
    const dailyData = JSON.parse(dailyWordsCanvas.dataset.daily || '{}');
    
    const dates = Object.keys(dailyData).sort().slice(-7);
    const words = dates.map(date => dailyData[date] || 0);
    
    new Chart(dailyWordsCanvas, {
      type: 'line',
      data: {
        labels: dates.map(d => new Date(d).toLocaleDateString('de-DE', { weekday: 'short' })),
        datasets: [{
          label: 'Words Written',
          data: words,
          borderColor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() + '20',
          tension: 0.4,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary')
            },
            grid: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--border')
            }
          },
          x: {
            ticks: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary')
            },
            grid: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--border')
            }
          }
        }
      }
    });
  }
  
  // Words by novel chart
  const novelWordsCanvas = document.getElementById('novelWordsChart');
  if (novelWordsCanvas && typeof Chart !== 'undefined') {
    const novelData = JSON.parse(novelWordsCanvas.dataset.novels || '[]');
    
    new Chart(novelWordsCanvas, {
      type: 'bar',
      data: {
        labels: novelData.map(n => n.name),
        datasets: [{
          label: 'Words',
          data: novelData.map(n => n.words),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary')
            },
            grid: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--border')
            }
          },
          x: {
            ticks: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary')
            },
            grid: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--border')
            }
          }
        }
      }
    });
  }
});