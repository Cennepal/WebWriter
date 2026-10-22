'use strict';

/** Runs scheduled backups. Checks every 15 minutes which users are due. */

const { db, settings: settingsStore } = require('./db');
const backups = require('./backups');
const drive = require('./drive');
const config = require('./config');

const INTERVALS = { daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };
let running = false;

async function runDueBackups(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    const due = db
      .prepare(`SELECT s.user_id FROM user_settings s JOIN users u ON u.id = s.user_id
                WHERE u.disabled = 0 AND s.backup_schedule IN ('daily', 'weekly')`)
      .all();
    for (const { user_id: userId } of due) {
      const s = settingsStore.get(userId);
      const last = s.last_auto_backup_at ? Date.parse(s.last_auto_backup_at) : 0;
      if (now - last < INTERVALS[s.backup_schedule]) continue;
      try {
        const backup = await backups.create(userId, { kind: 'auto' });
        settingsStore.update(userId, { last_auto_backup_at: new Date(now).toISOString() });
        await backups.prune(userId, s.backup_keep || 10);
        if (s.drive_auto_upload && s.drive_tokens && config.google.enabled) {
          await drive.upload(userId, backup.name).catch(err => console.warn(`[scheduler] Drive upload failed for user ${userId}: ${err.message}`));
        }
        console.log(`[scheduler] Backup ${backup.name} created for user ${userId}`);
      } catch (err) {
        console.error(`[scheduler] Backup failed for user ${userId}:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

function start() {
  const tick = () => runDueBackups().catch(err => console.error('[scheduler]', err));
  setTimeout(tick, 60e3).unref();
  setInterval(tick, 15 * 60e3).unref();
}

module.exports = { start, runDueBackups };
