const path = require('path');

function isValidFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  // Allow alphanumeric, spaces, dashes, underscores, dots
  // Disallow .. and slashes
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false;
  return /^[a-zA-Z0-9 \-_.]+$/.test(filename);
}

function isValidId(id) {
  if (!id || typeof id !== 'string') return false;
  return /^[a-zA-Z0-9\-_]+$/.test(id);
}

module.exports = { isValidFilename, isValidId };
