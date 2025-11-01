const fs = require('fs').promises;
const path = require('path');

/**
 * Count words in a text string
 */
function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

/**
 * Format bytes to human readable size
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Format date to readable string
 */
function formatDate(date) {
  return new Date(date).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Sanitize filename
 */
function sanitizeFilename(filename) {
  return filename.replace(/[^a-z0-9_\-\.]/gi, '_').toLowerCase();
}

/**
 * Ensure directory exists
 */
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }
}

/**
 * Delete directory recursively
 */
async function deleteDir(dirPath) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (err) {
    console.error(`Error deleting directory ${dirPath}:`, err);
  }
}

/**
 * Copy file
 */
async function copyFile(source, destination) {
  await fs.copyFile(source, destination);
}

/**
 * Read JSON file
 */
async function readJSON(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  return JSON.parse(data);
}

/**
 * Write JSON file
 */
async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

module.exports = {
  countWords,
  formatBytes,
  formatDate,
  sanitizeFilename,
  ensureDir,
  deleteDir,
  copyFile,
  readJSON,
  writeJSON
};