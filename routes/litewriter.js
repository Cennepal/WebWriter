const express = require('express');
const router = express.Router();
const { createClient } = require('webdav');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const db = require('../database/db');
const { getWebDavClient, getRemoteNovels, getRemoteNovel, getRemoteChapter, countWords } = require('../utils/litewriterManager');

router.use(requireAuth);

/**
 * Proxy cover images from WebDAV
 */
router.get('/cover/:novelId/:filename', async (req, res) => {
  try {
    const { client } = await getWebDavClient(req.session.user.id);
    const novelId = decodeURIComponent(req.params.novelId);
    const filename = req.params.filename;
    
    const coverPath = `/${novelId}/${filename}`;
    
    // Get the image as a buffer
    const imageBuffer = await client.getFileContents(coverPath, { format: 'binary' });
    
    // Set content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml'
    };
    
    res.setHeader('Content-Type', contentTypes[ext] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
    res.send(Buffer.from(imageBuffer));
  } catch (err) {
    console.error('Error proxying cover image:', err);
    res.redirect('/images/default-cover.svg');
  }
});

/**
 * List top-level novels (directories) and map them to our structure.
 */
router.get('/novels', async (req, res) => {
  try {
    const novels = await getRemoteNovels(req.session.user.id);
    res.json({ novels });
  } catch (err) {
    console.error('Error fetching LiteWriter (WebDAV) novels:', err && err.message ? err.message : err);
    res.status(500).json({ error: err.message || 'Failed to fetch LiteWriter novels' });
  }
});

/**
 * Get single novel structure (Main + books)
 */
router.get('/novels/:id', async (req, res) => {
  try {
    const result = await getRemoteNovel(req.session.user.id, req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Error fetching LiteWriter novel structure:', err && err.message ? err.message : err);
    res.status(500).json({ error: err.message || 'Failed to fetch novel structure' });
  }
});

/**
 * Get chapter content (reads from WebDAV)
 */
router.get('/novels/:novelId/:book/:chapter/content', async (req, res) => {
  try {
    const { novelId, book, chapter } = req.params;
    const content = await getRemoteChapter(req.session.user.id, novelId, book, chapter);
    res.json({ content });
  } catch (err) {
    console.error('Error fetching LiteWriter chapter content:', err && err.message ? err.message : err);
    res.status(500).json({ error: err.message || 'Failed to fetch chapter content' });
  }
});

/**
 * Save chapter content (writes back to LiteWriter WebDAV)
 */
router.post('/novels/:novelId/:book/:chapter/save', async (req, res) => {
  try {
    const { client } = await getWebDavClient(req.session.user.id);
    const novelIdRaw = decodeURIComponent(req.params.novelId);
    const { book, chapter } = req.params;
    const content = req.body.content;

    let filePath;
    if (book === 'Main') {
      // Try to determine if file is .md or .txt by checking existence
      try {
        filePath = `/${novelIdRaw}/${chapter}.md`;
        await client.stat(filePath);
        // File exists as .md
      } catch (err) {
        // Try .txt
        try {
          filePath = `/${novelIdRaw}/${chapter}.txt`;
          await client.stat(filePath);
          // File exists as .txt
        } catch (err2) {
          // File doesn't exist, default to .md
          filePath = `/${novelIdRaw}/${chapter}.md`;
        }
      }
    } else {
      // Subdirectory - same logic
      try {
        filePath = `/${novelIdRaw}/${book}/${chapter}.md`;
        await client.stat(filePath);
      } catch (err) {
        try {
          filePath = `/${novelIdRaw}/${book}/${chapter}.txt`;
          await client.stat(filePath);
        } catch (err2) {
          // Default to .md
          filePath = `/${novelIdRaw}/${book}/${chapter}.md`;
        }
      }
    }

    // write content as UTF-8 text
    await client.putFileContents(filePath, content, { overwrite: true });

    res.json({ success: true, saved: new Date().toISOString() });
  } catch (err) {
    console.error('Error saving LiteWriter chapter:', err && err.message ? err.message : err);
    res.status(500).json({ error: err.message || 'Failed to save chapter' });
  }
});

// Test connection endpoint
router.get('/test-connection', async (req, res) => {
  try {
    const { client } = await getWebDavClient(req.session.user.id);
    
    // Try to list root directory
    const rootItems = await client.getDirectoryContents('/');
    
    res.json({ 
      success: true, 
      message: 'Successfully connected to LiteWriter',
      directoriesFound: rootItems.filter(i => i.type === 'directory').length
    });
  } catch (err) {
    console.error('LiteWriter connection test failed:', err && err.message ? err.message : err);
    res.status(500).json({ 
      success: false, 
      error: err.message || 'Failed to connect to LiteWriter' 
    });
  }
});

// Helper function
// countWords is imported from utils/litewriterManager

module.exports = router;
