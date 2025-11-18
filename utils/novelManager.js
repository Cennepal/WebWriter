const fs = require('fs').promises;
const path = require('path');

const novelsDir = path.join(__dirname, '../data/novels');

function countWords(text) {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

async function getNovelStats(novelPath) {
  let wordCount = 0;
  let bookCount = 0;
  
  const entries = await fs.readdir(novelPath, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      bookCount++;
      const bookPath = path.join(novelPath, entry.name);
      const files = await fs.readdir(bookPath);
      
      for (const file of files) {
        if (file.endsWith('.md')) {
          const content = await fs.readFile(path.join(bookPath, file), 'utf8');
          wordCount += countWords(content);
        }
      }
    }
  }
  
  return { wordCount, bookCount };
}

async function updateNovelMeta(novelId) {
  const novelPath = path.join(novelsDir, novelId);
  const metaPath = path.join(novelPath, 'meta.json');
  
  const metaData = await fs.readFile(metaPath, 'utf8');
  const meta = JSON.parse(metaData);
  
  const stats = await getNovelStats(novelPath);
  
  meta.lastModified = new Date().toISOString();
  meta.wordCount = stats.wordCount;
  meta.bookCount = stats.bookCount;
  
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
}

async function getNovelStructure(novelPath) {
  const structure = [];
  const entries = await fs.readdir(novelPath, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const bookPath = path.join(novelPath, entry.name);
      const chapters = [];
      
      const files = await fs.readdir(bookPath);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const filePath = path.join(bookPath, file);
          const stats = await fs.stat(filePath);
          const content = await fs.readFile(filePath, 'utf8');
          
          chapters.push({
            name: file.replace('.md', ''),
            file: file,
            wordCount: countWords(content),
            lastModified: stats.mtime
          });
        }
      }
      
      chapters.sort((a, b) => {
        if (a.name === 'Synopsis') return -1;
        if (b.name === 'Synopsis') return 1;
        return 0;
      });
      
      structure.push({
        name: entry.name,
        chapters
      });
    }
  }
  
  structure.sort((a, b) => {
    if (a.name === 'Main') return -1;
    if (b.name === 'Main') return 1;
    return a.name.localeCompare(b.name);
  });
  
  return structure;
}

module.exports = {
  getNovelStats,
  updateNovelMeta,
  getNovelStructure,
  countWords
};
