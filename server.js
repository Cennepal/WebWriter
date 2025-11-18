require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const path = require('path');
const db = require('./database/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy - required for secure cookies behind Nginx
// 'true' trusts the X-Forwarded-* headers from the reverse proxy
app.set('trust proxy', true);

if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set. Using a default secret. This is not secure for production.');
}

// Initialize database
db.initialize().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static('public'));

// Serve data directory for novel covers
app.use('/data', express.static(path.join(__dirname, 'data')));

// Session configuration with SQLite store
const sessionsDb = new Database(path.join(__dirname, 'database/sessions.db'));
app.use(session({
  store: new SqliteStore({
    client: sessionsDb,
    expired: {
      clear: true,
      intervalMs: 900000 // 15 minutes
    }
  }),
  secret: process.env.SESSION_SECRET || 'default-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    sameSite: 'lax'
  }
}));

// Make user available in all views
app.use(async (req, res, next) => {
  if (req.session.user) {
    res.locals.user = req.session.user;
    
    // Get user settings for theme and background
    try {
      const settings = await db.getUserSettings(req.session.user.id);
      res.locals.theme = settings.theme || 'dark';
      res.locals.backgroundSettings = {
        enabled: settings.background_enabled === 1,
        url: settings.background_url || '',
        opacity: settings.background_opacity || 0.3,
        editorEnabled: settings.background_editor_enabled === 1
      };
    } catch (err) {
      console.error('Error loading user settings:', err);
      res.locals.theme = 'dark';
      res.locals.backgroundSettings = {
        enabled: false,
        url: '',
        opacity: 0.3,
        editorEnabled: false
      };
    }
  } else {
    res.locals.user = null;
    res.locals.theme = 'dark';
    res.locals.backgroundSettings = {
      enabled: false,
      url: '',
      opacity: 0.3,
      editorEnabled: false
    };
  }
  next();
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/novels', require('./routes/novels'));
app.use('/editor', require('./routes/editor'));
app.use('/analytics', require('./routes/analytics'));
app.use('/backups', require('./routes/backups'));
app.use('/settings', require('./routes/settings'));
app.use('/litewriter', require('./routes/litewriter'));

// Root route
app.get('/', (req, res) => {
  if (req.session.user) {
    res.redirect('/novels');
  } else {
    res.redirect('/auth/login');
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('Page not found');
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).send('Something went wrong!');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  sessionsDb.close();
  process.exit(0);
});

// Start server - bind to 0.0.0.0 for both IPv4 and IPv6 compatibility
app.listen(PORT, '0.0.0.0', () => {
  console.log(`WebWriter is running on http://0.0.0.0:${PORT}`);
});
