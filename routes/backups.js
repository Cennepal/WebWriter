const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const extract = require('extract-zip');
const { requireAuth } = require('../middleware/auth');
const db = require('../database/db');
const { google } = require('googleapis');

router.use(requireAuth);

const BACKUPS_DIR = path.join(__dirname, '..', 'data', 'backups');

// Ensure backups directory exists
fs.mkdir(BACKUPS_DIR, { recursive: true }).catch(console.error);

// Get Google OAuth2 client
function getOAuth2Client() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth credentials not configured');
  }
  
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL || 'http://localhost:3000'}/backups/google/callback`
  );
}

// Render backups page
router.get('/', async (req, res) => {
  try {
    const files = await fs.readdir(BACKUPS_DIR);
    const backups = [];
    
    for (const file of files) {
      if (file.endsWith('.zip')) {
        const stats = await fs.stat(path.join(BACKUPS_DIR, file));
        backups.push({
          name: file,
          size: stats.size,
          created: stats.mtime
        });
      }
    }
    
    // Sort by date, newest first
    backups.sort((a, b) => b.created - a.created);
    
    // Get cloud backup settings
    const settings = await db.getUserSettings(req.session.user.id);
    const cloudSettings = {
      googleDriveEnabled: settings.google_drive_enabled === 1,
      autoBackupEnabled: settings.auto_backup_enabled === 1,
      backupSchedule: settings.backup_schedule || 'daily'
    };
    
    res.render('backups', { 
      backups,
      cloudSettings,
      successMessage: req.query.success,
      errorMessage: req.query.error
    });
  } catch (err) {
    console.error('Error loading backups:', err);
    res.render('backups', { 
      backups: [],
      cloudSettings: {
        googleDriveEnabled: false,
        autoBackupEnabled: false,
        backupSchedule: 'daily'
      },
      errorMessage: 'Failed to load backups'
    });
  }
});

// Create backup
router.post('/create', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}.zip`;
    const backupPath = path.join(BACKUPS_DIR, backupName);
    
    const output = require('fs').createWriteStream(backupPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      res.json({ success: true, backup: backupName });
    });
    
    archive.on('error', (err) => {
      throw err;
    });
    
    archive.pipe(output);
    
    // Add novels directory
    const novelsDir = path.join(__dirname, '..', 'data', 'novels');
    try {
      await fs.access(novelsDir);
      archive.directory(novelsDir, 'novels');
    } catch (err) {
      console.log('No novels directory to backup');
    }
    
    // Add database
    const dbPath = path.join(__dirname, '..', 'database', 'users.db');
    archive.file(dbPath, { name: 'users.db' });
    
    await archive.finalize();
  } catch (err) {
    console.error('Error creating backup:', err);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// Download backup
router.get('/download/:name', async (req, res) => {
  try {
    const backupPath = path.join(BACKUPS_DIR, req.params.name);
    await fs.access(backupPath);
    res.download(backupPath);
  } catch (err) {
    console.error('Error downloading backup:', err);
    res.status(404).send('Backup not found');
  }
});

// Delete backup
router.post('/delete/:name', async (req, res) => {
  try {
    const backupPath = path.join(BACKUPS_DIR, req.params.name);
    await fs.unlink(backupPath);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting backup:', err);
    res.status(500).json({ error: 'Failed to delete backup' });
  }
});

// Restore backup
router.post('/restore/:name', async (req, res) => {
  try {
    const backupPath = path.join(BACKUPS_DIR, req.params.name);
    const tempDir = path.join(__dirname, '..', 'temp', `restore-${Date.now()}`);
    
    await fs.mkdir(tempDir, { recursive: true });
    await extract(backupPath, { dir: tempDir });
    
    // Restore novels
    const novelsSource = path.join(tempDir, 'novels');
    const novelsTarget = path.join(__dirname, '..', 'data', 'novels');
    try {
      await fs.access(novelsSource);
      await fs.rm(novelsTarget, { recursive: true, force: true });
      await fs.rename(novelsSource, novelsTarget);
    } catch (err) {
      console.log('No novels to restore');
    }
    
    // Restore database
    const dbSource = path.join(tempDir, 'users.db');
    const dbTarget = path.join(__dirname, '..', 'database', 'users.db');
    try {
      await fs.access(dbSource);
      await fs.copyFile(dbSource, dbTarget);
    } catch (err) {
      console.log('No database to restore');
    }
    
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error restoring backup:', err);
    res.status(500).json({ error: 'Failed to restore backup' });
  }
});

// Google Drive OAuth initiation
router.get('/google/auth', (req, res) => {
  try {
    const oauth2Client = getOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive.file'],
      prompt: 'consent'
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('Error initiating Google auth:', err);
    res.redirect('/backups?error=' + encodeURIComponent(err.message));
  }
});

// Google Drive OAuth callback
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    
    // Save tokens to database
    await db.updateUserSettings(req.session.user.id, {
      google_drive_token: JSON.stringify(tokens),
      google_drive_enabled: 1
    });
    
    res.redirect('/backups?success=' + encodeURIComponent('Google Drive connected successfully'));
  } catch (err) {
    console.error('Error in Google callback:', err);
    res.redirect('/backups?error=' + encodeURIComponent('Failed to connect Google Drive'));
  }
});

// Disconnect Google Drive
router.post('/google/disconnect', async (req, res) => {
  try {
    await db.updateUserSettings(req.session.user.id, {
      google_drive_token: null,
      google_drive_enabled: 0,
      auto_backup_enabled: 0
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error disconnecting Google Drive:', err);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// Update cloud backup schedule
router.post('/cloud-schedule', async (req, res) => {
  try {
    const { schedule, enabled } = req.body;
    
    await db.updateUserSettings(req.session.user.id, {
      backup_schedule: schedule,
      auto_backup_enabled: enabled ? 1 : 0
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating cloud schedule:', err);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// Upload backup to Google Drive
router.post('/upload-to-drive/:name', async (req, res) => {
  try {
    const settings = await db.getUserSettings(req.session.user.id);
    if (!settings.google_drive_enabled || !settings.google_drive_token) {
      return res.status(400).json({ error: 'Google Drive not connected' });
    }
    
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(JSON.parse(settings.google_drive_token));
    
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const backupPath = path.join(BACKUPS_DIR, req.params.name);
    
    const fileMetadata = {
      name: req.params.name,
      mimeType: 'application/zip'
    };
    
    const media = {
      mimeType: 'application/zip',
      body: require('fs').createReadStream(backupPath)
    };
    
    await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id'
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error uploading to Drive:', err);
    res.status(500).json({ error: 'Failed to upload to Google Drive' });
  }
});

module.exports = router;
