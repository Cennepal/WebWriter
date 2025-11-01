const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');

const novelsDir = path.join(__dirname, '../data/novels');

router.use(requireAuth);

// Get editor page
router.get('/:novelId/:book/:chapter', async (req, res) => {
  try {
    const { novelId, book, chapter } = req.params;
    const isRemote = req.query.remote === '1';
    
    if (isRemote) {
      // Fetch from LiteWriter
      const resp = await axios.get(
        `${req.protocol}://${req.get('host')}/litewriter/novels/${novelId}/${book}/${chapter}/content`,
        { headers: { cookie: req.headers.cookie } }
      );
      
      const content = resp.data.content;
      
      // Get novel info
      const novelResp = await axios.get(
        `${req.protocol}://${req.get('host')}/litewriter/novels/${novelId}`,
        { headers: { cookie: req.headers.cookie } }
      );
      
      const meta = novelResp.data.novel;
      
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
      const chapterPath = path.join(novelsDir, novelId, book, `${chapter}.md`);
      const metaPath = path.join(novelsDir, novelId, 'meta.json');
      
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
    
    const chapterPath = path.join(novelsDir, novelId, book, `${chapter}.md`);
    await fs.writeFile(chapterPath, content);
    
    // Update novel meta
    const metaPath = path.join(novelsDir, novelId, 'meta.json');
    const metaData = await fs.readFile(metaPath, 'utf8');
    const meta = JSON.parse(metaData);
    meta.lastModified = new Date().toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    
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
    const chapterPath = path.join(novelsDir, novelId, book, `${chapter}.md`);
    
    const content = await fs.readFile(chapterPath, 'utf8');
    
    res.json({ content });
  } catch (err) {
    console.error('Error loading chapter content:', err);
    res.status(500).json({ error: 'Failed to load chapter' });
  }
});

module.exports = router;
