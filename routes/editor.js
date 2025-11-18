const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const { isValidFilename, isValidId } = require('../utils/validation');
const { updateNovelMeta } = require('../utils/novelManager');
const { getRemoteNovel, getRemoteChapter } = require('../utils/litewriterManager');

const novelsDir = path.join(__dirname, '../data/novels');

router.use(requireAuth);

// Helper to validate novel path
async function validateNovelPath(novelId) {
  if (!isValidId(novelId)) throw new Error('Invalid novel ID');
  const novelPath = path.join(novelsDir, novelId);
  if (!novelPath.startsWith(novelsDir)) throw new Error('Invalid path');
  try {
    await fs.access(novelPath);
    return novelPath;
  } catch {
    throw new Error('Novel not found');
  }
}

// Get editor page
router.get('/:novelId/:book/:chapter', async (req, res) => {
  try {
    const { novelId, book, chapter } = req.params;
    
    if (!isValidFilename(book) || !isValidFilename(chapter)) {
      return res.redirect('/novels');
    }

    const isRemote = req.query.remote === '1';
    
    if (isRemote) {
      // Fetch from LiteWriter
      const content = await getRemoteChapter(req.session.user.id, novelId, book, chapter);
      
      // Get novel info
      const { novel: meta } = await getRemoteNovel(req.session.user.id, novelId);
      
      // Get background settings - DO NOT override res.locals
      const backgroundSettings = res.locals.backgroundSettings;
      
      console.log('=== EDITOR RENDER (REMOTE) ===');
      console.log('Background Settings:', JSON.stringify(backgroundSettings, null, 2));
      console.log('Should show bg:', backgroundSettings.enabled && backgroundSettings.url && backgroundSettings.editorEnabled);
      
      res.render('editor', {
        novel: { id: novelId, ...meta },
        book,
        chapter,
        content,
        isRemote: true
        // DO NOT pass backgroundSettings - use res.locals
      });
    } else {
      // Local file
      const novelPath = await validateNovelPath(novelId);
      const chapterPath = path.join(novelPath, book, `${chapter}.md`);
      const metaPath = path.join(novelPath, 'meta.json');
      
      const content = await fs.readFile(chapterPath, 'utf8');
      const metaData = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(metaData);
      
      // Get background settings - DO NOT override res.locals
      const backgroundSettings = res.locals.backgroundSettings;
      
      console.log('=== EDITOR RENDER (LOCAL) ===');
      console.log('Background Settings:', JSON.stringify(backgroundSettings, null, 2));
      console.log('Should show bg:', backgroundSettings.enabled && backgroundSettings.url && backgroundSettings.editorEnabled);
      
      res.render('editor', {
        novel: { id: novelId, ...meta },
        book,
        chapter,
        content,
        isRemote: false
        // DO NOT pass backgroundSettings - use res.locals
      });
    }
  } catch (err) {
    console.error('Error loading editor:', err);
    res.redirect('/novels');
  }
});

// Save chapter content - LOCAL ONLY
router.post('/:novelId/:book/:chapter/save', async (req, res) => {
  try {
    const { novelId, book, chapter } = req.params;
    const { content } = req.body;
    
    if (!isValidFilename(book) || !isValidFilename(chapter)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    const novelPath = await validateNovelPath(novelId);
    const chapterPath = path.join(novelPath, book, `${chapter}.md`);
    await fs.writeFile(chapterPath, content);
    
    // Update novel meta and stats
    await updateNovelMeta(novelId);
    
    res.json({ success: true, saved: new Date().toISOString() });
  } catch (err) {
    console.error('Error saving chapter:', err);
    res.status(500).json({ error: 'Failed to save chapter' });
  }
});

// Get chapter content
router.get('/:novelId/:book/:chapter/content', async (req, res) => {
  try {
    const { novelId, book, chapter } = req.params;
    
    if (!isValidFilename(book) || !isValidFilename(chapter)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    const novelPath = await validateNovelPath(novelId);
    const chapterPath = path.join(novelPath, book, `${chapter}.md`);
    
    const content = await fs.readFile(chapterPath, 'utf8');
    
    res.json({ content });
  } catch (err) {
    console.error('Error loading chapter content:', err);
    res.status(500).json({ error: 'Failed to load chapter' });
  }
});

module.exports = router;
