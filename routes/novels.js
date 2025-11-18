const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { isValidFilename, isValidId } = require('../utils/validation');
const { getNovelStats, updateNovelMeta, getNovelStructure } = require('../utils/novelManager');
const { getRemoteNovels, getRemoteNovel } = require('../utils/litewriterManager');

const upload = multer({ dest: 'uploads/' });
const novelsDir = path.join(__dirname, '../data/novels');

router.use(requireAuth);

// Helper to validate novel path
async function validateNovelPath(novelId) {
  if (!isValidId(novelId)) throw new Error('Invalid novel ID');
  const novelPath = path.join(novelsDir, novelId);
  // Ensure path is within novelsDir
  if (!novelPath.startsWith(novelsDir)) throw new Error('Invalid path');
  try {
    await fs.access(novelPath);
    return novelPath;
  } catch {
    throw new Error('Novel not found');
  }
}

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

          // Use cached stats if available, otherwise calculate
          let stats = { wordCount: meta.wordCount || 0, bookCount: meta.bookCount || 0 };
          if (meta.wordCount === undefined || meta.bookCount === undefined) {
             stats = await getNovelStats(novelPath);
             // Update meta with stats
             meta.wordCount = stats.wordCount;
             meta.bookCount = stats.bookCount;
             await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
          }

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
      if (req.session.user) {
        liteNovels = await getRemoteNovels(req.session.user.id);
      }
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
      const { novel, structure } = await getRemoteNovel(req.session.user.id, req.params.id);
      
      res.render('novel-detail', { 
        novel,
        structure,
        isRemote: true
      });
    } else {
      // Local novel
      const novelPath = await validateNovelPath(req.params.id);
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
    if (!title) return res.status(400).json({ error: 'Title is required' });

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
      lastModified: new Date().toISOString(),
      wordCount: 0,
      bookCount: 1
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
    const novelPath = await validateNovelPath(req.params.id);
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
    if (!isValidFilename(name)) return res.status(400).json({ error: 'Invalid book name' });

    const novelPath = await validateNovelPath(req.params.id);
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
    if (!isValidFilename(book)) return res.status(400).json({ error: 'Invalid book name' });
    
    // Prevent deleting Main book
    if (book === 'Main') {
      return res.status(400).json({ error: 'Cannot delete Main book' });
    }
    
    const novelPath = await validateNovelPath(id);
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
    const { id, book } = req.params;
    if (!isValidFilename(name)) return res.status(400).json({ error: 'Invalid chapter name' });
    if (!isValidFilename(book)) return res.status(400).json({ error: 'Invalid book name' });

    const novelPath = await validateNovelPath(id);
    const chapterPath = path.join(novelPath, book, `${name}.md`);
    
    await fs.writeFile(chapterPath, '');
    
    await updateNovelMeta(id);
    
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
    if (!isValidFilename(book)) return res.status(400).json({ error: 'Invalid book name' });
    if (!isValidFilename(chapter)) return res.status(400).json({ error: 'Invalid chapter name' });
    
    // Prevent deleting Synopsis from Main book
    if (book === 'Main' && chapter === 'Synopsis') {
      return res.status(400).json({ error: 'Cannot delete Synopsis' });
    }
    
    const novelPath = await validateNovelPath(id);
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
    const novelPath = await validateNovelPath(req.params.id);
    await fs.rm(novelPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting novel:', err);
    res.status(500).json({ error: 'Failed to delete novel' });
  }
});

module.exports = router;
