const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { requireAuth } = require('../middleware/auth');
const Database = require('../database/db');

const db = new Database();
db.initialize();

// Configure multer for background image uploads
const storage = multer.diskStorage({
  destination: async function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../public/backgrounds');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'bg-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp|svg/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const settings = await db.getUserSettings(req.session.user.id);
    res.render('settings', { settings });
  } catch (err) {
    console.error('Error loading settings:', err);
    res.render('settings', { settings: { 
      theme: 'dark', 
      backup_schedule: 'daily', 
      litewriter_enabled: 0,
      background_enabled: 0,
      background_opacity: 0.3,
      background_editor_enabled: 0
    }});
  }
});

router.post('/theme', async (req, res) => {
  try {
    const { theme } = req.body;
    
    await db.updateUserSettings(req.session.user.id, { theme });
    req.session.theme = theme;
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating theme:', err);
    res.status(500).json({ error: 'Failed to update theme' });
  }
});

router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    const user = await db.findUserByUsername(req.session.user.username);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const validPassword = await bcrypt.compare(currentPassword, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(user.id, hashedPassword);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error changing password:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

router.post('/litewriter', async (req, res) => {
  try {
    const { enabled, url, username, password } = req.body;
    
    await db.updateUserSettings(req.session.user.id, {
      litewriter_enabled: enabled,
      litewriter_url: url,
      litewriter_username: username,
      litewriter_password: password
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating LiteWriter settings:', err);
    res.status(500).json({ error: 'Failed to update LiteWriter settings' });
  }
});

router.post('/background', upload.single('background'), async (req, res) => {
  try {
    const { enabled, opacity, editorEnabled, url } = req.body;
    
    let backgroundUrl = url || '';
    
    if (req.file) {
      backgroundUrl = `/backgrounds/${req.file.filename}`;
    }
    
    await db.updateUserSettings(req.session.user.id, {
      background_enabled: enabled === 'true' || enabled === true,
      background_url: backgroundUrl,
      background_opacity: parseFloat(opacity) || 0.3,
      background_editor_enabled: editorEnabled === 'true' || editorEnabled === true
    });
    
    res.json({ success: true, backgroundUrl });
  } catch (err) {
    console.error('Error updating background settings:', err);
    res.status(500).json({ error: 'Failed to update background settings' });
  }
});

module.exports = router;
