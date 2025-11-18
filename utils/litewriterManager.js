const { createClient } = require('webdav');
const path = require('path');
const db = require('../database/db');

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

function countWords(text) {
  if (!text) return 0;
  return text.toString().trim().split(/\s+/).filter(w => w.length > 0).length;
}

async function getRemoteNovels(userId) {
  try {
    const { client } = await getWebDavClient(userId);

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

    return novels;
  } catch (err) {
    // If not configured, return empty array instead of throwing
    if (err.message === 'LiteWriter (WebDAV) not configured') {
      return [];
    }
    throw err;
  }
}

async function getRemoteNovel(userId, novelIdRaw) {
  const { client } = await getWebDavClient(userId);
  const novelId = decodeURIComponent(novelIdRaw);
  const novelPath = `/${novelId}`.replace(/\/+/g, '/');

  // list novel root
  const contents = await client.getDirectoryContents(novelPath);
  const files = contents.filter(c => c.type === 'file').map(f => path.basename(f.filename));
  const subdirs = contents.filter(c => c.type === 'directory').map(d => path.basename(d.filename));

  // cover & synopsis - proxy through our app
  let cover = '/images/default-cover.svg';
  const coverFile = files.find(f => /cover\.(jpg|jpeg|png|svg|webp)$/i.test(f));
  if (coverFile) {
    cover = `/litewriter/cover/${encodeURIComponent(novelId)}/${coverFile}`;
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

  return {
    novel: {
      id: encodeURIComponent(novelId),
      title: decodeURIComponent(novelId).replace(/_/g, ' '),
      cover,
      synopsis,
      remote: true
    },
    structure
  };
}

async function getRemoteChapter(userId, novelIdRaw, book, chapter) {
  const { client } = await getWebDavClient(userId);
  const novelId = decodeURIComponent(novelIdRaw);

  let filePath;
  if (book === 'Main') {
    // Root file - need to check if it's .md or .txt
    // Try .md first, then .txt
    try {
      filePath = `/${novelId}/${chapter}.md`;
      const data = await client.getFileContents(filePath, { format: 'text' });
      const content = typeof data === 'string' ? data : data.toString();
      return content;
    } catch (err) {
      // Try .txt
      filePath = `/${novelId}/${chapter}.txt`;
      const data = await client.getFileContents(filePath, { format: 'text' });
      const content = typeof data === 'string' ? data : data.toString();
      return content;
    }
  } else {
    // Subdirectory file - try .md first, then .txt
    try {
      filePath = `/${novelId}/${book}/${chapter}.md`;
      const data = await client.getFileContents(filePath, { format: 'text' });
      const content = typeof data === 'string' ? data : data.toString();
      return content;
    } catch (err) {
      filePath = `/${novelId}/${book}/${chapter}.txt`;
      const data = await client.getFileContents(filePath, { format: 'text' });
      const content = typeof data === 'string' ? data : data.toString();
      return content;
    }
  }
}

module.exports = {
  getWebDavClient,
  getRemoteNovels,
  getRemoteNovel,
  getRemoteChapter,
  countWords
};
