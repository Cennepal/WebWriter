const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { requireAuth } = require('../middleware/auth');

const novelsDir = path.join(__dirname, '../data/novels');

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const stats = await generateAnalytics();
    res.render('analytics', { stats });
  } catch (err) {
    console.error('Error loading analytics:', err);
    res.render('analytics', { stats: getDefaultStats() });
  }
});

async function generateAnalytics() {
  const stats = {
    totalWords: 0,
    totalBooks: 0,
    totalChapters: 0,
    wordsByNovel: [],
    dailyWords: {},
    weeklyTrend: 0
  };
  
  try {
    const novels = await fs.readdir(novelsDir, { withFileTypes: true });
    
    for (const novel of novels) {
      if (novel.isDirectory()) {
        const novelPath = path.join(novelsDir, novel.name);
        const metaPath = path.join(novelPath, 'meta.json');
        
        try {
          const metaData = await fs.readFile(metaPath, 'utf8');
          const meta = JSON.parse(metaData);
          
          let novelWords = 0;
          const books = await fs.readdir(novelPath, { withFileTypes: true });
          
          for (const book of books) {
            if (book.isDirectory()) {
              stats.totalBooks++;
              const bookPath = path.join(novelPath, book.name);
              const chapters = await fs.readdir(bookPath);
              
              for (const chapter of chapters) {
                if (chapter.endsWith('.md')) {
                  stats.totalChapters++;
                  const chapterPath = path.join(bookPath, chapter);
                  const content = await fs.readFile(chapterPath, 'utf8');
                  const wordCount = countWords(content);
                  novelWords += wordCount;
                  
                  const chapterStats = await fs.stat(chapterPath);
                  const dateKey = chapterStats.mtime.toISOString().split('T')[0];
                  stats.dailyWords[dateKey] = (stats.dailyWords[dateKey] || 0) + wordCount;
                }
              }
            }
          }
          
          stats.totalWords += novelWords;
          stats.wordsByNovel.push({
            name: meta.title,
            words: novelWords
          });
        } catch (err) {
          console.error(`Error processing novel ${novel.name}:`, err);
        }
      }
    }
    
    // Calculate weekly trend
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    
    let thisWeek = 0;
    let lastWeek = 0;
    
    Object.entries(stats.dailyWords).forEach(([date, words]) => {
      const dateObj = new Date(date);
      if (dateObj >= sevenDaysAgo) {
        thisWeek += words;
      } else if (dateObj >= fourteenDaysAgo) {
        lastWeek += words;
      }
    });
    
    stats.weeklyTrend = lastWeek > 0 ? thisWeek - lastWeek : thisWeek;
    
  } catch (err) {
    console.error('Error generating analytics:', err);
  }
  
  return stats;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function getDefaultStats() {
  return {
    totalWords: 0,
    totalBooks: 0,
    totalChapters: 0,
    wordsByNovel: [],
    dailyWords: {},
    weeklyTrend: 0
  };
}

module.exports = router;