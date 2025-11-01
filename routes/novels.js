const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');

const upload = multer({ dest: 'uploads/' });
const novelsDir = path.join(__dirname, '../data/novels');

router.use(requireAuth);

// Get all novels
router.get('/', async (req, res) => {
  try {
    await fs.mkdir(novelsDir, { recursive: true });
    const novels = [];
    const entries = await fs.readdir(novelsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const novelPath = path.join(novelsDir, entry.name);
        const metaPath = path.join(novelPath, 'meta.json');

        try {
          const metaData = await fs.readFile(metaPath, 'utf8');
          const meta = JSON.parse(metaData);

          // Read synopsis from Synopsis.md file
          const synopsisPath = path.join(novelPath, 'Main', 'Synopsis.md');
          let synopsis = meta.synopsis || '';
          try {
            synopsis = await fs.readFile(synopsisPath, 'utf8');
          } catch (err) {
            // If Synopsis.md doesn't exist, use meta.synopsis
          }

          const stats = await getNovelStats(novelPath);

          novels.push({
            id: entry.name,
            ...meta,
            synopsis: synopsis,
            wordCount: stats.wordCount,
            bookCount: stats.bookCount,
            remote: false
          });
        } catch (err) {
          console.error(`Error reading novel ${entry.name}:`, err);
        }
      }
    }

    // Fetch LiteWriter (remote) novels and append as separate section
    let liteNovels = [];
    try {
      // call route we created above to fetch remote novels
      const resp = await axios.get(`${req.protocol}://${req.get('host')}/litewriter/novels`, {
        headers: { cookie: req.headers.cookie } // pass session cookie so litewriter route can auth
      });
      liteNovels = resp.data && resp.data.novels ? resp.data.novels : [];
    } catch (err) {
      // don't block: show no remote novels if error
      console.warn('Could not load LiteWriter novels:', err && err.message ? err.message : err);
    }

    novels.sort((a, b) => new Date(b.lastModified || b.created) - new Date(a.lastModified || a.created));

    res.render('novels', { novels, liteNovels });
  } catch (err) {
    console.error('Error loading novels:', err);
    res.render('novels', { novels: [], liteNovels: [] });
  }
});

// Get all novels as JSON
router.get('/api/list', async (req, res) => {
  try {
    await fs.mkdir(novelsDir, { recursive: true });
    const novels = [];
    const entries = await fs.readdir(novelsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const novelPath = path.join(novelsDir, entry.name);
        const metaPath = path.join(novelPath, 'meta.json');
        
        try {
          const metaData = await fs.readFile(metaPath, 'utf8');
          const meta = JSON.parse(metaData);
          
          // Read synopsis from Synopsis.md file
          const synopsisPath = path.join(novelPath, 'Main', 'Synopsis.md');
          let synopsis = meta.synopsis || '';
          try {
            synopsis = await fs.readFile(synopsisPath, 'utf8');
          } catch (err) {
            // If Synopsis.md doesn't exist, use meta.synopsis
          }
          
          const stats = await getNovelStats(novelPath);
          
          novels.push({
            id: entry.name,
            ...meta,
            synopsis: synopsis,
            wordCount: stats.wordCount,
            bookCount: stats.bookCount
          });
        } catch (err) {
          console.error(`Error reading novel ${entry.name}:`, err);
        }
      }
    }
    
    novels.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    
    res.json({ novels });
  } catch (err) {
    console.error('Error loading novels:', err);
    res.status(500).json({ error: 'Failed to load novels' });
  }
});

// Get single novel - UPDATED to handle remote novels
router.get('/:id', async (req, res) => {
  try {
    const isRemote = req.query.remote === '1';
    
    if (isRemote) {
      // Fetch from LiteWriter
      const resp = await axios.get(`${req.protocol}://${req.get('host')}/litewriter/novels/${req.params.id}`, {
        headers: { cookie: req.headers.cookie }
      });
      
      const { novel, structure } = resp.data;
      
      res.render('novel-detail', { 
        novel,
        structure,
        isRemote: true
      });
    } else {
      // Local novel
      const novelPath = path.join(novelsDir, req.params.id);
      const metaPath = path.join(novelPath, 'meta.json');
      
      const metaData = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(metaData);
      
      // Read synopsis from Synopsis.md file
      const synopsisPath = path.join(novelPath, 'Main', 'Synopsis.md');
      let synopsis = meta.synopsis || '';
      try {
        synopsis = await fs.readFile(synopsisPath, 'utf8');
      } catch (err) {
        // If Synopsis.md doesn't exist, use meta.synopsis
      }
      
      const structure = await getNovelStructure(novelPath);
      
      res.render('novel-detail', { 
        novel: { id: req.params.id, ...meta, synopsis: synopsis },
        structure,
        isRemote: false
      });
    }
  } catch (err) {
    console.error('Error loading novel:', err);
    res.redirect('/novels');
  }
});

// Create new novel
router.post('/create', upload.single('cover'), async (req, res) => {
  try {
    const { title, synopsis } = req.body;
    const novelId = Date.now().toString();
    const novelPath = path.join(novelsDir, novelId);
    
    await fs.mkdir(novelPath, { recursive: true });
    
    const mainBookPath = path.join(novelPath, 'Main');
    await fs.mkdir(mainBookPath, { recursive: true });
    
    // Create synopsis file
    const synopsisPath = path.join(mainBookPath, 'Synopsis.md');
    await fs.writeFile(synopsisPath, synopsis || '');
    
    // Handle cover image
    let coverPath = '/images/default-cover.svg';
    if (req.file) {
      const ext = path.extname(req.file.originalname);
      const newPath = path.join(novelPath, `cover${ext}`);
      await fs.rename(req.file.path, newPath);
      coverPath = `/data/novels/${novelId}/cover${ext}`;
    }
    
    const meta = {
      title,
      cover: coverPath,
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    };
    
    await fs.writeFile(
      path.join(novelPath, 'meta.json'),
      JSON.stringify(meta, null, 2)
    );
    
    res.json({ success: true, novelId });
  } catch (err) {
    console.error('Error creating novel:', err);
    res.status(500).json({ error: 'Failed to create novel' });
  }
});

// Update novel meta
router.post('/:id/update', upload.single('cover'), async (req, res) => {
  try {
    const novelPath = path.join(novelsDir, req.params.id);
    const metaPath = path.join(novelPath, 'meta.json');
    
    const metaData = await fs.readFile(metaPath, 'utf8');
    const meta = JSON.parse(metaData);
    
    if (req.body.title) meta.title = req.body.title;
    
    if (req.body.synopsis !== undefined) {
      // Update Synopsis.md file
      const synopsisPath = path.join(novelPath, 'Main', 'Synopsis.md');
      await fs.writeFile(synopsisPath, req.body.synopsis);
    }
    
    if (req.file) {
      const ext = path.extname(req.file.originalname);
      const newPath = path.join(novelPath, `cover${ext}`);
      await fs.rename(req.file.path, newPath);
      meta.cover = `/data/novels/${req.params.id}/cover${ext}`;
    }
    
    meta.lastModified = new Date().toISOString();
    
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating novel:', err);
    res.status(500).json({ error: 'Failed to update novel' });
  }
});

// Create new book
router.post('/:id/books/create', async (req, res) => {
  try {
    const { name } = req.body;
    const novelPath = path.join(novelsDir, req.params.id);
    const bookPath = path.join(novelPath, name);
    
    await fs.mkdir(bookPath, { recursive: true });
    
    // Update last modified
    await updateNovelMeta(req.params.id);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error creating book:', err);
    res.status(500).json({ error: 'Failed to create book' });
  }
});

// Delete book
router.delete('/:id/books/:book', async (req, res) => {
  try {
    const { id, book } = req.params;
    
    // Prevent deleting Main book
    if (book === 'Main') {
      return res.status(400).json({ error: 'Cannot delete Main book' });
    }
    
    const novelPath = path.join(novelsDir, id);
    const bookPath = path.join(novelPath, book);
    
    // Delete the book directory and all its contents
    await fs.rm(bookPath, { recursive: true, force: true });
    
    // Update last modified
    await updateNovelMeta(id);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting book:', err);
    res.status(500).json({ error: 'Failed to delete book' });
  }
});

// Create new chapter
router.post('/:id/books/:book/chapters/create', async (req, res) => {
  try {
    const { name } = req.body;
    const novelPath = path.join(novelsDir, req.params.id);
    const chapterPath = path.join(novelPath, req.params.book, `${name}.md`);
    
    await fs.writeFile(chapterPath, '');
    
    await updateNovelMeta(req.params.id);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error creating chapter:', err);
    res.status(500).json({ error: 'Failed to create chapter' });
  }
});

// Delete chapter
router.delete('/:id/books/:book/chapters/:chapter', async (req, res) => {
  try {
    const { id, book, chapter } = req.params;
    
    // Prevent deleting Synopsis from Main book
    if (book === 'Main' && chapter === 'Synopsis') {
      return res.status(400).json({ error: 'Cannot delete Synopsis' });
    }
    
    const novelPath = path.join(novelsDir, id);
    const chapterPath = path.join(novelPath, book, `${chapter}.md`);
    
    // Delete the chapter file
    await fs.unlink(chapterPath);
    
    // Update last modified
    await updateNovelMeta(id);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting chapter:', err);
    res.status(500).json({ error: 'Failed to delete chapter' });
  }
});

// Delete novel
router.delete('/:id', async (req, res) => {
  try {
    const novelPath = path.join(novelsDir, req.params.id);
    await fs.rm(novelPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting novel:', err);
    res.status(500).json({ error: 'Failed to delete novel' });
  }
});

// Helper functions
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

function countWords(text) {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

async function updateNovelMeta(novelId) {
  const metaPath = path.join(novelsDir, novelId, 'meta.json');
  const metaData = await fs.readFile(metaPath, 'utf8');
  const meta = JSON.parse(metaData);
  meta.lastModified = new Date().toISOString();
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
}

module.exports = router;
