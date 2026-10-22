'use strict';

/**
 * Turn a fully loaded novel ({ novel, books, cover }) into downloadable files.
 * Works the same for local and LiteWriter novels.
 */

const crypto = require('crypto');
const archiver = require('archiver');
const docx = require('docx');
const md = require('./markdown');
const { escapeHtml, slugify } = require('./text');

const FORMATS = {
  epub: { label: 'EPUB e-book', ext: 'epub', type: 'application/epub+zip' },
  docx: { label: 'Word document', ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  html: { label: 'Web page (print to PDF)', ext: 'html', type: 'text/html; charset=utf-8' },
  md: { label: 'Markdown', ext: 'md', type: 'text/markdown; charset=utf-8' },
  txt: { label: 'Plain text', ext: 'txt', type: 'text/plain; charset=utf-8' },
  zip: { label: 'Original files (ZIP)', ext: 'zip', type: 'application/zip' }
};

/**
 * Flatten books/chapters into a reading order and apply export options.
 *   book:          only export this book
 *   chapter:       only export this chapter (requires book)
 *   synopsis:      include the synopsis as a foreword
 *   chapterTitles: add the chapter name as a heading (skipped if the chapter already starts with one)
 */
function prepare(full, { book, chapter, synopsis = false, chapterTitles = true } = {}) {
  const books = full.books.filter(b => !book || b.name === book);
  const showBookTitles = !book && books.filter(b => b.chapters.some(c => !c.isSynopsis)).length > 1;
  const sections = [];
  let synopsisText = '';
  for (const b of books) {
    let first = true;
    for (const ch of b.chapters) {
      if (ch.isSynopsis) {
        synopsisText = ch.content || '';
        continue;
      }
      if (chapter && ch.name !== chapter) continue;
      const startsWithHeading = /^\s*#{1,6}\s/.test(ch.content || '');
      sections.push({
        book: b.name,
        bookTitle: showBookTitles && first && !b.isMain ? b.name : null,
        title: ch.name,
        showTitle: chapterTitles && !startsWithHeading,
        content: ch.content || ''
      });
      first = false;
    }
  }
  const title = chapter ? `${full.novel.title} – ${chapter}` : book && book !== 'Main' ? `${full.novel.title} – ${book}` : full.novel.title;
  return {
    title,
    author: full.novel.author || '',
    language: full.novel.language || 'en',
    synopsis: synopsis && !chapter ? synopsisText.trim() : '',
    sections,
    cover: chapter ? null : full.cover
  };
}

function toMarkdown(doc) {
  const out = [`# ${doc.title}`];
  if (doc.author) out.push('', `*by ${doc.author}*`);
  if (doc.synopsis) out.push('', doc.synopsis);
  for (const s of doc.sections) {
    if (s.bookTitle) out.push('', '', `# ${s.bookTitle}`);
    out.push('');
    if (s.showTitle) out.push(`## ${s.title}`, '');
    out.push(s.content.trim());
  }
  return `${out.join('\n').trim()}\n`;
}

function toText(doc) {
  const out = [doc.title.toUpperCase()];
  if (doc.author) out.push(`by ${doc.author}`);
  if (doc.synopsis) out.push('', md.toPlainText(doc.synopsis));
  for (const s of doc.sections) {
    if (s.bookTitle) out.push('', '', '', s.bookTitle.toUpperCase(), '='.repeat(Math.min(60, s.bookTitle.length)));
    out.push('', '');
    if (s.showTitle) out.push(s.title, '-'.repeat(Math.min(60, s.title.length)), '');
    out.push(md.toPlainText(s.content));
  }
  return `${out.join('\n').trim()}\n`;
}

const BOOK_CSS = `
body { font-family: Georgia, 'Iowan Old Style', 'Palatino Linotype', serif; line-height: 1.6; margin: 0; }
h1, h2, h3 { font-weight: normal; text-align: center; line-height: 1.3; }
h1.book-title { margin: 3em 0 2em; font-size: 1.8em; }
h2.chapter-title { margin: 2em 0 1.5em; font-size: 1.5em; }
p { margin: 0; text-indent: 1.5em; text-align: justify; hyphens: auto; -webkit-hyphens: auto; }
h1 + p, h2 + p, h3 + p, hr + p, blockquote + p, .first { text-indent: 0; }
hr.scene-break { border: 0; text-align: center; margin: 1.2em 0; }
hr.scene-break::after { content: '* * *'; letter-spacing: 0.5em; }
blockquote { margin: 1em 2em; font-style: italic; }
blockquote p { text-indent: 0; }
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { font-size: 2.2em; margin-bottom: 0.5em; }
.title-page .author { font-size: 1.2em; font-style: italic; }
.synopsis { margin: 2em 0; font-style: italic; }
.synopsis p { text-indent: 0; margin-bottom: 0.8em; }
`;

function toHtmlDocument(doc) {
  const parts = [];
  parts.push(`<header class="title-page"><h1>${escapeHtml(doc.title)}</h1>${doc.author ? `<p class="author">${escapeHtml(doc.author)}</p>` : ''}</header>`);
  if (doc.synopsis) parts.push(`<section class="synopsis">${md.toHtml(doc.synopsis)}</section>`);
  for (const s of doc.sections) {
    if (s.bookTitle) parts.push(`<h1 class="book-title">${escapeHtml(s.bookTitle)}</h1>`);
    parts.push(`<section class="chapter">${s.showTitle ? `<h2 class="chapter-title">${escapeHtml(s.title)}</h2>` : ''}\n${md.toHtml(s.content, { headingOffset: 1 })}</section>`);
  }
  return `<!DOCTYPE html>
<html lang="${escapeHtml(doc.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<style>
${BOOK_CSS}
body { max-width: 36em; margin: 0 auto; padding: 3em 1.5em; font-size: 1.15em; color: #222; background: #fff; }
.chapter { margin-top: 4em; }
@media print {
  body { max-width: none; padding: 0; font-size: 12pt; }
  .chapter, h1.book-title { break-before: page; }
  .title-page { break-after: page; }
}
</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>
`;
}

function xhtmlPage(title, body, lang) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeHtml(lang)}" lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${body}
</body>
</html>
`;
}

function zipToBuffer(build) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', c => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.on('warning', reject);
    Promise.resolve(build(archive))
      .then(() => archive.finalize())
      .catch(reject);
  });
}

async function toEpub(doc) {
  const uid = `urn:uuid:${crypto.randomUUID()}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const lang = doc.language || 'en';
  const items = [];
  const spine = [];
  const nav = [];

  items.push({ id: 'title', href: 'title.xhtml', type: 'application/xhtml+xml' });
  spine.push('title');
  const titleBody = `<section class="title-page" epub:type="titlepage"><h1>${escapeHtml(doc.title)}</h1>${doc.author ? `<p class="author">${escapeHtml(doc.author)}</p>` : ''}</section>${doc.synopsis ? `<section class="synopsis">${md.toHtml(doc.synopsis)}</section>` : ''}`;
  const files = [{ name: 'OEBPS/title.xhtml', data: xhtmlPage(doc.title, titleBody, lang) }];

  doc.sections.forEach((s, i) => {
    const id = `ch${String(i + 1).padStart(3, '0')}`;
    const href = `${id}.xhtml`;
    items.push({ id, href, type: 'application/xhtml+xml' });
    spine.push(id);
    nav.push({ href, title: s.title, bookTitle: s.bookTitle });
    const body = `${s.bookTitle ? `<h1 class="book-title">${escapeHtml(s.bookTitle)}</h1>` : ''}<section epub:type="chapter">${s.showTitle ? `<h2 class="chapter-title">${escapeHtml(s.title)}</h2>` : ''}\n${md.toHtml(s.content, { headingOffset: 1 })}</section>`;
    files.push({ name: `OEBPS/${href}`, data: xhtmlPage(s.title, body, lang) });
  });

  let coverMeta = '';
  if (doc.cover) {
    items.push({ id: 'cover-image', href: `cover${doc.cover.ext}`, type: doc.cover.type, props: 'cover-image' });
    coverMeta = '<meta name="cover" content="cover-image" />';
    files.push({ name: `OEBPS/cover${doc.cover.ext}`, data: doc.cover.data });
    items.push({ id: 'cover', href: 'cover.xhtml', type: 'application/xhtml+xml' });
    spine.unshift('cover');
    files.push({
      name: 'OEBPS/cover.xhtml',
      data: xhtmlPage('Cover', `<div style="text-align:center"><img src="cover${doc.cover.ext}" alt="${escapeHtml(doc.title)}" style="max-width:100%;max-height:100%" /></div>`, lang)
    });
  }

  // Navigation document (EPUB 3) and NCX (for older readers), nested by book.
  const navList = [];
  let open = false;
  for (const n of nav) {
    if (n.bookTitle) {
      if (open) navList.push('</ol></li>');
      navList.push(`<li><a href="${n.href}">${escapeHtml(n.bookTitle)}</a><ol>`);
      open = true;
    }
    navList.push(`<li><a href="${n.href}">${escapeHtml(n.title)}</a></li>`);
  }
  if (open) navList.push('</ol></li>');
  items.push({ id: 'nav', href: 'nav.xhtml', type: 'application/xhtml+xml', props: 'nav' });
  files.push({ name: 'OEBPS/nav.xhtml', data: xhtmlPage('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navList.join('')}</ol></nav>`, lang) });

  items.push({ id: 'ncx', href: 'toc.ncx', type: 'application/x-dtbncx+xml' });
  files.push({
    name: 'OEBPS/toc.ncx',
    data: `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${uid}" /></head>
<docTitle><text>${escapeHtml(doc.title)}</text></docTitle>
<navMap>
${nav.map((n, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeHtml(n.title)}</text></navLabel><content src="${n.href}" /></navPoint>`).join('\n')}
</navMap>
</ncx>
`
  });

  items.push({ id: 'css', href: 'style.css', type: 'text/css' });
  files.push({ name: 'OEBPS/style.css', data: BOOK_CSS });

  files.push({
    name: 'OEBPS/content.opf',
    data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeHtml(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uid}</dc:identifier>
<dc:title>${escapeHtml(doc.title)}</dc:title>
<dc:language>${escapeHtml(lang)}</dc:language>
${doc.author ? `<dc:creator>${escapeHtml(doc.author)}</dc:creator>` : ''}
${doc.synopsis ? `<dc:description>${escapeHtml(md.toPlainText(doc.synopsis))}</dc:description>` : ''}
<meta property="dcterms:modified">${modified}</meta>
${coverMeta}
</metadata>
<manifest>
${items.map(i => `<item id="${i.id}" href="${i.href}" media-type="${i.type}"${i.props ? ` properties="${i.props}"` : ''} />`).join('\n')}
</manifest>
<spine toc="ncx">
${spine.map(id => `<itemref idref="${id}" />`).join('\n')}
</spine>
</package>
`
  });

  return zipToBuffer(archive => {
    // The mimetype entry must come first and be stored uncompressed.
    archive.append('application/epub+zip', { name: 'mimetype', store: true });
    archive.append(
      `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
</container>
`,
      { name: 'META-INF/container.xml' }
    );
    for (const f of files) archive.append(f.data, { name: f.name });
  });
}

function docxRuns(text, base = {}) {
  return md.parseInline(text).map(r => new docx.TextRun({ text: r.text, bold: r.bold || base.bold, italics: r.italic || base.italics, strike: r.strike }));
}

function docxBlocks(text) {
  const out = [];
  let first = true;
  for (const b of md.parseBlocks(text)) {
    switch (b.type) {
      case 'break':
        out.push(new docx.Paragraph({ alignment: docx.AlignmentType.CENTER, spacing: { before: 240, after: 240 }, children: [new docx.TextRun('*   *   *')] }));
        first = true;
        break;
      case 'heading':
        out.push(new docx.Paragraph({ heading: b.level <= 1 ? docx.HeadingLevel.HEADING_2 : docx.HeadingLevel.HEADING_3, children: docxRuns(b.text) }));
        first = true;
        break;
      case 'quote':
        out.push(new docx.Paragraph({ indent: { left: 720, right: 720 }, children: docxRuns(b.text, { italics: true }) }));
        break;
      case 'item':
        out.push(new docx.Paragraph({ bullet: { level: 0 }, children: docxRuns(b.text) }));
        break;
      default:
        out.push(new docx.Paragraph({ indent: first ? undefined : { firstLine: 360 }, children: docxRuns(b.text) }));
        first = false;
    }
  }
  return out;
}

async function toDocx(doc) {
  const children = [
    new docx.Paragraph({ heading: docx.HeadingLevel.TITLE, alignment: docx.AlignmentType.CENTER, spacing: { before: 2400 }, children: [new docx.TextRun(doc.title)] })
  ];
  if (doc.author) children.push(new docx.Paragraph({ alignment: docx.AlignmentType.CENTER, children: [new docx.TextRun({ text: doc.author, italics: true, size: 28 })] }));
  if (doc.synopsis) {
    children.push(new docx.Paragraph({ text: '' }));
    children.push(...docxBlocks(doc.synopsis));
  }
  doc.sections.forEach(s => {
    if (s.bookTitle) {
      children.push(new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_1, alignment: docx.AlignmentType.CENTER, pageBreakBefore: true, children: [new docx.TextRun(s.bookTitle)] }));
    }
    const titlePara = new docx.Paragraph({
      heading: docx.HeadingLevel.HEADING_2,
      alignment: docx.AlignmentType.CENTER,
      pageBreakBefore: !s.bookTitle,
      spacing: { after: 360 },
      children: [new docx.TextRun(s.showTitle ? s.title : '')]
    });
    children.push(titlePara);
    children.push(...docxBlocks(s.content));
  });

  const document = new docx.Document({
    creator: doc.author || 'WebWriter',
    title: doc.title,
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24 }, paragraph: { spacing: { line: 360 } } }
      }
    },
    sections: [{ properties: {}, children }]
  });
  return docx.Packer.toBuffer(document);
}

/** Raw files in the LiteWriter-compatible layout. */
async function toZip(full) {
  const root = slugify(full.novel.title);
  return zipToBuffer(archive => {
    for (const b of full.books) {
      for (const ch of b.chapters) {
        const name = b.isMain ? `${root}/${ch.file}` : `${root}/${b.dir}/${ch.file}`;
        archive.append(ch.content || '', { name });
      }
    }
    if (full.cover) archive.append(full.cover.data, { name: `${root}/cover${full.cover.ext}` });
  });
}

/** Build an export. Returns { buffer, filename, type }. */
async function exportNovel(full, format, options = {}) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown export format: ${format}`);
  const doc = prepare(full, options);
  let buffer;
  switch (format) {
    case 'md':
      buffer = Buffer.from(toMarkdown(doc));
      break;
    case 'txt':
      buffer = Buffer.from(toText(doc));
      break;
    case 'html':
      buffer = Buffer.from(toHtmlDocument(doc));
      break;
    case 'epub':
      buffer = await toEpub(doc);
      break;
    case 'docx':
      buffer = await toDocx(doc);
      break;
    case 'zip':
      buffer = await toZip(full);
      break;
  }
  return { buffer, filename: `${slugify(doc.title)}.${spec.ext}`, type: spec.type };
}

module.exports = { FORMATS, exportNovel, prepare, zipToBuffer };
