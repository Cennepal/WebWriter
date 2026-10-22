'use strict';

const { settings: settingsStore } = require('./db');
const { formatBytes } = require('./text');

const ACCENTS = {
  ember: { label: 'Ember', color: '#e8590c' },
  ocean: { label: 'Ocean', color: '#1c7ed6' },
  forest: { label: 'Forest', color: '#2b8a3e' },
  plum: { label: 'Plum', color: '#9c36b5' },
  rose: { label: 'Rose', color: '#d6336c' },
  slate: { label: 'Slate', color: '#495057' }
};

const EDITOR_FONTS = {
  serif: { label: 'Serif', stack: "'Iowan Old Style', 'Charter', 'Palatino Linotype', 'Book Antiqua', Georgia, Cambria, serif" },
  sans: { label: 'Sans-serif', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  mono: { label: 'Monospace', stack: "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace" }
};

/** Only allow our own uploads or http(s) images, and make the value safe inside CSS url("..."). */
function backgroundCss(url) {
  if (!url) return '';
  if (!url.startsWith('/uploads/backgrounds/') && !/^https?:\/\//i.test(url)) return '';
  return `url("${url.replace(/["\\\n\r()]/g, c => encodeURIComponent(c))}")`;
}

function prefsFor(userId) {
  const s = settingsStore.get(userId);
  return {
    theme: ['light', 'dark'].includes(s.theme) ? s.theme : 'system',
    accent: ACCENTS[s.accent] ? s.accent : 'ember',
    timezone: s.timezone,
    background: {
      enabled: Boolean(s.background_enabled && backgroundCss(s.background_url)),
      url: s.background_url,
      css: backgroundCss(s.background_url),
      dim: s.background_dim,
      inEditor: Boolean(s.background_in_editor)
    },
    editor: {
      font: EDITOR_FONTS[s.editor_font] ? s.editor_font : 'serif',
      fontStack: (EDITOR_FONTS[s.editor_font] || EDITOR_FONTS.serif).stack,
      size: s.editor_size,
      width: s.editor_width,
      lineHeight: s.editor_line_height,
      spellcheck: Boolean(s.editor_spellcheck),
      typewriter: Boolean(s.editor_typewriter)
    },
    dailyGoal: s.daily_goal
  };
}

const DEFAULT_PREFS = {
  theme: 'system',
  accent: 'ember',
  background: { enabled: false, url: '', css: '', dim: 0.7, inEditor: false },
  editor: { font: 'serif', fontStack: EDITOR_FONTS.serif.stack, size: 19, width: 42, lineHeight: 1.8, spellcheck: true, typewriter: false },
  dailyGoal: 0
};

function locals(req, res, next) {
  res.locals.path = req.path;
  res.locals.prefs = req.user ? prefsFor(req.user.id) : DEFAULT_PREFS;
  res.locals.title = '';
  res.locals.flash = (req.session && req.session.flash) || [];
  if (req.session && req.session.flash) delete req.session.flash;
  req.flash = (type, message) => {
    req.session.flash = [...(req.session.flash || []), { type, message }];
  };
  next();
}

/** Make sure the error page can render even if the request failed before the usual middleware ran. */
function ensureLocals(req, res) {
  const l = res.locals;
  if (l.user === undefined) l.user = null;
  if (!l.prefs) l.prefs = DEFAULT_PREFS;
  if (!l.flash) l.flash = [];
  if (l.path === undefined) l.path = req.path;
  if (!l.csrfToken) l.csrfToken = () => (req.session && req.session.csrf) || '';
}

const numberFormat = new Intl.NumberFormat('en-US');

function relativeTime(iso) {
  if (!iso) return 'never';
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (Number.isNaN(diff)) return '';
  if (diff < 45) return 'just now';
  const units = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2629800],
    ['year', 31557600]
  ];
  let unit = units[0];
  for (const u of units) if (Math.abs(diff) >= u[1]) unit = u;
  const value = Math.round(diff / unit[1]);
  return `${value} ${unit[0]}${value === 1 ? '' : 's'} ago`;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const helpers = {
  num: n => numberFormat.format(Math.round(n || 0)),
  relativeTime,
  formatDate,
  formatBytes,
  ACCENTS,
  EDITOR_FONTS,
  /** Safely embed data in a <script type="application/json"> block. */
  json: value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'),
  /** A stable hue for generated covers. */
  hue: text => [...String(text || '')].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 17),
  /** Build an app URL from segments, encoding each one. */
  url: (...parts) => `/${parts.map(p => encodeURIComponent(p)).join('/')}`
};

module.exports = { locals, ensureLocals, helpers, prefsFor, ACCENTS, EDITOR_FONTS };
