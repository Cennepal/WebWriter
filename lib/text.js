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

/*
 * Book and chapter names vs. file names
 *
 * Writers should be able to call a chapter "Chapter 3: Why?" even though
 * most file systems refuse \ / : * ? " < > | in file names. When we create a
 * file, those characters are stored as Unicode look-alikes (":" becomes "꞉"),
 * and turned back into the real characters when names are shown. Existing
 * files are always found by their exact name too, so files created by
 * LiteWriter (which may contain the plain characters) keep working.
 */
const TO_FILE = { '\\': '⧹', '/': '⧸', ':': '꞉', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
const FROM_FILE = Object.fromEntries(Object.entries(TO_FILE).map(([a, b]) => [b, a]));
const DOT_LEADER = '․';

/** The file name (without extension) a name is stored under. Never contains a path separator. */
function toFileName(name) {
  return String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, c => TO_FILE[c])
    .replace(/^\.+|\.+$/g, dots => DOT_LEADER.repeat(dots.length));
}

/** The name shown for a file name (without extension). */
function fromFileName(fileName) {
  return String(fileName)
    .replace(/[⧹⧸꞉＊？＂＜＞｜]/g, c => FROM_FILE[c])
    .replace(new RegExp(`^${DOT_LEADER}+|${DOT_LEADER}+$`, 'g'), d => '.'.repeat(d.length));
}

/** File names to try, in order, when looking for an existing book or chapter. */
function fileNameCandidates(name) {
  const encoded = toFileName(name);
  const literal = String(name);
  const literalOk = literal !== encoded && !literal.includes('/') && !literal.includes('\0') && literal !== '.' && literal !== '..';
  return literalOk ? [encoded, literal] : [encoded];
}

/** Validate a name that refers to an existing book or chapter (taken as is). */
function checkName(raw, what = 'Name') {
  const name = String(raw ?? '');
  if (!name.trim()) throw badRequest(`${what} cannot be empty.`);
  if (name.length > 255 || name.includes('\0')) throw badRequest(`${what} is not valid.`);
  return name;
}

/** Validate a name for a new (or renamed) book or chapter. Any printable character is fine. */
function newName(raw, what = 'Name') {
  const name = String(raw ?? '').normalize('NFC').trim();
  if (!name) throw badRequest(`${what} cannot be empty.`);
  if (name.length > 120) throw badRequest(`${what} is too long (max 120 characters).`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw badRequest(`${what} cannot contain line breaks or tabs.`);
  return name;
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
  newName,
  toFileName,
  fromFileName,
  fileNameCandidates,
  isValidId,
  slugify,
  escapeHtml,
  formatBytes,
  mapLimit
};
