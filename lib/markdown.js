'use strict';

/**
 * A deliberately small Markdown dialect tuned for fiction.
 *
 * Phone writing apps (LiteWriter included) usually treat every line break as
 * a new paragraph, so unlike CommonMark each non-empty line is its own
 * paragraph. Supported: headings, scene breaks (*** --- * * * #), block
 * quotes, list items, **bold**, *italic* / _italic_ and ~~strikethrough~~.
 */

const { escapeHtml } = require('./text');

const SCENE_BREAK_RE = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|#|~{3,}|◇+|⁂)\s*$/;

function parseBlocks(text) {
  const blocks = [];
  for (const rawLine of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (SCENE_BREAK_RE.test(line)) {
      blocks.push({ type: 'break' });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, '') });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: 'quote', text: quote[1] });
      continue;
    }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (item) {
      blocks.push({ type: 'item', text: item[1] });
      continue;
    }
    blocks.push({ type: 'paragraph', text: line.trim() });
  }
  return blocks;
}

/**
 * Split inline text into runs: [{ text, bold, italic, strike }].
 * Unmatched markers are kept as literal characters.
 */
function parseInline(text) {
  const runs = [];
  const state = { bold: false, italic: false, strike: false };
  let buf = '';
  const flush = () => {
    if (buf) runs.push({ text: buf, ...state });
    buf = '';
  };
  const s = String(text || '');
  const hasClosing = (marker, from) => s.indexOf(marker, from) !== -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && /[*_~\\#>]/.test(s[i + 1])) {
      buf += s[++i];
      continue;
    }
    if (s.startsWith('**', i) || s.startsWith('__', i)) {
      const marker = s.substr(i, 2);
      if (state.bold || hasClosing(marker, i + 2)) {
        flush();
        state.bold = !state.bold;
        i++;
        continue;
      }
    }
    if (s.startsWith('~~', i) && (state.strike || hasClosing('~~', i + 2))) {
      flush();
      state.strike = !state.strike;
      i++;
      continue;
    }
    if (ch === '*' || ch === '_') {
      const prev = s[i - 1];
      const next = s[i + 1];
      // Underscores inside words (snake_case) are literal.
      const intraword = ch === '_' && prev && next && /[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next);
      if (!intraword && (state.italic || (next && next !== ' ' && hasClosing(ch, i + 1)))) {
        flush();
        state.italic = !state.italic;
        continue;
      }
    }
    buf += ch;
  }
  flush();
  return runs;
}

function inlineToHtml(text) {
  return parseInline(text)
    .map(r => {
      let html = escapeHtml(r.text);
      if (r.strike) html = `<del>${html}</del>`;
      if (r.italic) html = `<em>${html}</em>`;
      if (r.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join('');
}

function inlineToPlain(text) {
  return parseInline(text).map(r => r.text).join('');
}

/** Render to (X)HTML-compatible markup (self-closing tags so it works in EPUB). */
function toHtml(text, { headingOffset = 0 } = {}) {
  const out = [];
  let list = false;
  for (const b of parseBlocks(text)) {
    if (b.type !== 'item' && list) {
      out.push('</ul>');
      list = false;
    }
    switch (b.type) {
      case 'break':
        out.push('<hr class="scene-break" />');
        break;
      case 'heading': {
        const level = Math.min(6, b.level + headingOffset);
        out.push(`<h${level}>${inlineToHtml(b.text)}</h${level}>`);
        break;
      }
      case 'quote':
        out.push(`<blockquote><p>${inlineToHtml(b.text)}</p></blockquote>`);
        break;
      case 'item':
        if (!list) {
          out.push('<ul>');
          list = true;
        }
        out.push(`<li>${inlineToHtml(b.text)}</li>`);
        break;
      default:
        out.push(`<p>${inlineToHtml(b.text)}</p>`);
    }
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

function toPlainText(text) {
  const out = [];
  for (const b of parseBlocks(text)) {
    switch (b.type) {
      case 'break':
        out.push('', '* * *', '');
        break;
      case 'heading':
        out.push('', inlineToPlain(b.text).toUpperCase(), '');
        break;
      case 'quote':
        out.push(`    ${inlineToPlain(b.text)}`);
        break;
      case 'item':
        out.push(`  • ${inlineToPlain(b.text)}`);
        break;
      default:
        out.push(inlineToPlain(b.text));
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { parseBlocks, parseInline, toHtml, toPlainText, inlineToHtml, inlineToPlain };
