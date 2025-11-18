const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/db');

// Login page - LOAD BACKGROUND SETTINGS EVEN WITHOUT USER
router.get('/login', async (req, res) => {
  // Try to get any user's background settings for the login page
  // We'll use user ID 1 (admin) as default for login background
  let backgroundSettings = {
    enabled: false,
    url: '',
    opacity: 0.3,
    editorEnabled: false
  };
  
  try {
    const settings = await db.getUserSettings(1); // Get admin's settings
    backgroundSettings = {
      enabled: settings.background_enabled || false,
      url: settings.background_url || '',
      opacity: settings.background_opacity || 0.3,
      editorEnabled: settings.background_editor_enabled || false
    };
  } catch (err) {
    // Ignore error, use defaults
  }
  
  res.render('login', { error: null, backgroundSettings });
});

// Login POST
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await db.findUserByUsername(username);

    if (!user) {
      let backgroundSettings = {
        enabled: false,
        url: '',
        opacity: 0.3,
        editorEnabled: false
      };
      
      try {
        const settings = await db.getUserSettings(1);
        backgroundSettings = {
          enabled: settings.background_enabled || false,
          url: settings.background_url || '',
          opacity: settings.background_opacity || 0.3,
          editorEnabled: settings.background_editor_enabled || false
        };
      } catch (err) {
        // Ignore
      }
      
      return res.render('login', { error: 'Invalid username or password', backgroundSettings });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      let backgroundSettings = {
        enabled: false,
        url: '',
        opacity: 0.3,
        editorEnabled: false
      };
      
      try {
        const settings = await db.getUserSettings(1);
        backgroundSettings = {
          enabled: settings.background_enabled || false,
          url: settings.background_url || '',
          opacity: settings.background_opacity || 0.3,
          editorEnabled: settings.background_editor_enabled || false
        };
      } catch (err) {
        // Ignore
      }
      
      return res.render('login', { error: 'Invalid username or password', backgroundSettings });
    }

    req.session.user = {
      id: user.id,
      username: user.username
    };

    const settings = await db.getUserSettings(user.id);
    req.session.theme = settings.theme || 'dark';

    // Explicitly save session before redirect to ensure cookie is set
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.render('login', { error: 'Login session error', backgroundSettings: { enabled: false, url: '', opacity: 0.3, editorEnabled: false } });
      }
      res.redirect('/novels');
    });
  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { error: 'An error occurred during login', backgroundSettings: { enabled: false, url: '', opacity: 0.3, editorEnabled: false } });
  }
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/auth/login');
});

module.exports = router;
