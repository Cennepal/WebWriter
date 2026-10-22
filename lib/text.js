'use strict';

/** An error that carries an HTTP status and a message that is safe to show to users. */
class AppError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.expose = true;
    if (extra) Object.assign(this, extra);
  }
}

const badRequest = msg => new AppError(400, msg);
const notFound = (msg = 'Not found') => new AppError(404, msg);
const conflict = (msg, extra) => new AppError(409, msg, extra);

const WORD_RE = /[\p{L}\p{N}]/u;

/** Count words the way writers expect: tokens separated by whitespace that contain a letter or digit. */
function countWords(text) {
  if (!text) return 0;
  let count = 0;
  for (const token of String(text).split(/\s+/)) {
    if (token && WORD_RE.test(token)) count++;
  }
  return count;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const naturalCompare = (a, b) => collator.compare(a, b);

const RESERVED_NAMES = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3']);

/**
 * Validate a book or chapter name. These become file and directory names
 * (both locally and on the LiteWriter device), so anything that could escape
 * the novel directory or break common file systems is rejected. Unicode is
 * welcome: "Kapitel 3 – Über den Fluss" is a perfectly good chapter name.
 */
function checkName(raw, what = 'Name') {
  const name = String(raw ?? '').normalize('NFC').trim();
  if (!name) throw badRequest(`${what} cannot be empty.`);
  if (name.length > 120) throw badRequest(`${what} is too long (max 120 characters).`);
  if (name === '.' || name === '..' || name.startsWith('.')) throw badRequest(`${what} cannot start with a dot.`);
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw badRequest(`${what} cannot contain any of these characters: \\ / : * ? " < > |`);
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) throw badRequest(`${what} is a reserved name.`);
  return name;
}

/** Like checkName but returns null instead of throwing (for route params). */
function safeName(raw) {
  try {
    return checkName(raw);
  } catch {
    return null;
  }
}

function isValidId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/** A filesystem friendly slug, used for download file names. */
function slugify(text, fallback = 'novel') {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
  return slug || fallback;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Run async work over items with bounded parallelism, preserving order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = {
  AppError,
  badRequest,
  notFound,
  conflict,
  countWords,
  naturalCompare,
  checkName,
  safeName,
  isValidId,
  slugify,
  escapeHtml,
  formatBytes,
  mapLimit
};
