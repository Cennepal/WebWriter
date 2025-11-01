const express = require('express');
const router = express.Router();
const { createClient } = require('webdav');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const Database = require('../database/db');

const db = new Database();
db.initialize();

router.use(requireAuth);

/**
 * Helper: returns authenticated WebDAV client and settings or throws if not configured.
 */
async function getWebDavClient(userId) {
  const settings = await db.getUserSettings(userId);
  if (!settings.litewriter_enabled || !settings.litewriter_url) {
    throw new Error('LiteWriter (WebDAV) not configured');
  }

  const baseUrl = settings.litewriter_url.replace(/\/$/, '');
  const username = settings.litewriter_username || undefined;
  const password = settings.litewriter_password || undefined;

  const client = createClient(baseUrl, {
    username,
    password
  });

  return { client, baseUrl, settings };
}

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
    const { client, baseUrl } = await getWebDavClient(req.session.user.id);

    // list root
    const rootItems = await client.getDirectoryContents('/');
    // filter directories only
    const dirItems = rootItems.filter(i => i.type === 'directory');

    const novels = [];

    for (const dir of dirItems) {
      const novelId = path.basename(dir.filename);
      const novelPath = dir.filename.replace(/^\//, '');

      try {
        // list novel root files and subdirs
        const contents = await client.getDirectoryContents(novelPath === '' ? '/' : `/${novelPath}`);

        const files = contents.filter(c => c.type === 'file').map(f => path.basename(f.filename));
        const subdirs = contents.filter(c => c.type === 'directory').map(d => path.basename(d.filename));

        // cover detection - proxy through our app
        let cover = '/images/default-cover.svg';
        const coverFile = files.find(f => /cover\.(jpg|jpeg|png|svg|webp)$/i.test(f));
        if (coverFile) {
          cover = `/litewriter/cover/${encodeURIComponent(novelId)}/${coverFile}`;
        }

        // synopsis: try Synopsis.md first, then fallback to Intro.md
        let synopsis = '';
        if (files.includes('Synopsis.md')) {
          try {
            const filePath = `/${novelPath}/Synopsis.md`.replace(/\/+/g, '/');
            const data = await client.getFileContents(filePath, { format: 'text' });
            synopsis = typeof data === 'string' ? data : data.toString();
          } catch (err) {
            synopsis = '';
          }
        } else if (files.includes('Intro.md')) {
          try {
            const filePath = `/${novelPath}/Intro.md`.replace(/\/+/g, '/');
            const data = await client.getFileContents(filePath, { format: 'text' });
            synopsis = typeof data === 'string' ? data : data.toString();
          } catch (err) {
            synopsis = '';
          }
        }

        // word count: count words in root .md/.txt files and subdir .md/.txt files
        let wordCount = 0;
        for (const f of files) {
          if (f.endsWith('.md') || f.endsWith('.txt')) {
            try {
              const filePath = `/${novelPath}/${f}`.replace(/\/+/g, '/');
              const content = await client.getFileContents(filePath, { format: 'text' });
              wordCount += countWords(typeof content === 'string' ? content : content.toString());
            } catch (err) {
              // skip
            }
          }
        }

        for (const sub of subdirs) {
          try {
            const subContents = await client.getDirectoryContents(`/${novelPath}/${sub}`);
            for (const sf of subContents.filter(s => s.type === 'file').map(s => path.basename(s.filename))) {
              if (sf.endsWith('.md') || sf.endsWith('.txt')) {
                try {
                  const filePath = `/${novelPath}/${sub}/${sf}`.replace(/\/+/g, '/');
                  const content = await client.getFileContents(filePath, { format: 'text' });
                  wordCount += countWords(typeof content === 'string' ? content : content.toString());
                } catch (err) {
                  // skip
                }
              }
            }
          } catch (err) {
            // skip subdir
          }
        }

        novels.push({
          id: encodeURIComponent(novelId),
          title: decodeURIComponent(novelId).replace(/_/g, ' '),
          cover,
          synopsis,
          wordCount,
          bookCount: subdirs.length > 0 ? subdirs.length : 1, // At least 1 for Main
          remote: true
        });
      } catch (err) {
        console.error(`Error loading LiteWriter novel ${novelId}:`, err.message);
      }
    }

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
    const { client, baseUrl } = await getWebDavClient(req.session.user.id);
    const novelIdRaw = decodeURIComponent(req.params.id);
    const novelPath = `/${novelIdRaw}`.replace(/\/+/g, '/');

    // list novel root
    const contents = await client.getDirectoryContents(novelPath);
    const files = contents.filter(c => c.type === 'file').map(f => path.basename(f.filename));
    const subdirs = contents.filter(c => c.type === 'directory').map(d => path.basename(d.filename));

    // cover & synopsis - proxy through our app
    let cover = '/images/default-cover.svg';
    const coverFile = files.find(f => /cover\.(jpg|jpeg|png|svg|webp)$/i.test(f));
    if (coverFile) {
      cover = `/litewriter/cover/${encodeURIComponent(novelIdRaw)}/${coverFile}`;
    }

    // Try Synopsis.md first, fallback to Intro.md
    let synopsis = '';
    if (files.includes('Synopsis.md')) {
      try {
        const data = await client.getFileContents(`${novelPath}/Synopsis.md`, { format: 'text' });
        synopsis = typeof data === 'string' ? data : data.toString();
      } catch (err) { 
        synopsis = ''; 
      }
    } else if (files.includes('Intro.md')) {
      try {
        const data = await client.getFileContents(`${novelPath}/Intro.md`, { format: 'text' });
        synopsis = typeof data === 'string' ? data : data.toString();
      } catch (err) { 
        synopsis = ''; 
      }
    }

    const structure = [];

    // Main book: ALL .md and .txt files in root (not just Synopsis/Intro)
    const mainChapters = [];
    
    // Add Synopsis first if it exists
    if (files.includes('Synopsis.md')) {
      mainChapters.push({
        name: 'Synopsis',
        file: 'Synopsis.md',
        wordCount: countWords(synopsis),
        lastModified: new Date()
      });
    } else if (files.includes('Intro.md')) {
      // If Synopsis doesn't exist but Intro does, add Intro
      mainChapters.push({
        name: 'Intro',
        file: 'Intro.md',
        wordCount: countWords(synopsis),
        lastModified: new Date()
      });
    }
    
    // Add all other .md and .txt files in root
    for (const f of files) {
      if ((f.endsWith('.md') || f.endsWith('.txt')) && f !== 'Synopsis.md' && f !== 'Intro.md') {
        try {
          const data = await client.getFileContents(`${novelPath}/${f}`, { format: 'text' });
          const content = typeof data === 'string' ? data : data.toString();
          mainChapters.push({
            name: f.replace(/\.(md|txt)$/, ''),
            file: f,
            wordCount: countWords(content),
            lastModified: new Date()
          });
        } catch (err) { 
          console.error(`Error reading file ${f}:`, err.message);
        }
      }
    }

    // Only add Main book if there are chapters
    if (mainChapters.length > 0) {
      structure.push({ name: 'Main', chapters: mainChapters });
    }

    // Subdirectories as books
    for (const sub of subdirs) {
      try {
        const subContents = await client.getDirectoryContents(`${novelPath}/${sub}`);
        const chapters = [];
        
        for (const s of subContents.filter(s => s.type === 'file').map(s => path.basename(s.filename))) {
          if (s.endsWith('.md') || s.endsWith('.txt')) {
            try {
              const data = await client.getFileContents(`${novelPath}/${sub}/${s}`, { format: 'text' });
              const content = typeof data === 'string' ? data : data.toString();
              chapters.push({
                name: s.replace(/\.(md|txt)$/, ''),
                file: s,
                wordCount: countWords(content),
                lastModified: new Date()
              });
            } catch (err) { 
              console.error(`Error reading file ${sub}/${s}:`, err.message);
            }
          }
        }
        
        if (chapters.length > 0) {
          structure.push({ name: sub, chapters });
        }
      } catch (err) {
        console.error(`Error loading subdirectory ${sub}:`, err.message);
      }
    }

    res.json({
      novel: {
        id: encodeURIComponent(novelIdRaw),
        title: decodeURIComponent(novelIdRaw).replace(/_/g, ' '),
        cover,
        synopsis,
        remote: true
      },
      structure
    });
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
    const { client } = await getWebDavClient(req.session.user.id);
    const novelIdRaw = decodeURIComponent(req.params.novelId);
    const { book, chapter } = req.params;

    let filePath;
    if (book === 'Main') {
      // Root file - need to check if it's .md or .txt
      // Try .md first, then .txt
      try {
        filePath = `/${novelIdRaw}/${chapter}.md`;
        const data = await client.getFileContents(filePath, { format: 'text' });
        const content = typeof data === 'string' ? data : data.toString();
        return res.json({ content });
      } catch (err) {
        // Try .txt
        filePath = `/${novelIdRaw}/${chapter}.txt`;
        const data = await client.getFileContents(filePath, { format: 'text' });
        const content = typeof data === 'string' ? data : data.toString();
        return res.json({ content });
      }
    } else {
      // Subdirectory file - try .md first, then .txt
      try {
        filePath = `/${novelIdRaw}/${book}/${chapter}.md`;
        const data = await client.getFileContents(filePath, { format: 'text' });
        const content = typeof data === 'string' ? data : data.toString();
        return res.json({ content });
      } catch (err) {
        filePath = `/${novelIdRaw}/${book}/${chapter}.txt`;
        const data = await client.getFileContents(filePath, { format: 'text' });
        const content = typeof data === 'string' ? data : data.toString();
        return res.json({ content });
      }
    }
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
function countWords(text) {
  if (!text) return 0;
  return text.toString().trim().split(/\s+/).filter(w => w.length > 0).length;
}

module.exports = router;
