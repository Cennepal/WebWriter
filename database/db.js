const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;

class Database {
  constructor() {
    this.dbPath = path.join(__dirname, 'users.db');
    this.db = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, async (err) => {
        if (err) {
          reject(err);
        } else {
          try {
            await this.createTablesAndMigrate();
            await this.createDefaultUser();
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }

  createTablesAndMigrate() {
    const db = this.db;
    return new Promise((resolve, reject) => {
      db.serialize(async () => {
        db.run(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS user_settings (
            user_id INTEGER PRIMARY KEY,
            theme TEXT DEFAULT 'dark',
            backup_schedule TEXT DEFAULT 'daily',
            google_drive_token TEXT,
            google_drive_refresh_token TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
          )
        `, async (err) => {
          if (err) {
            return reject(err);
          }

          try {
            const wantedColumns = [
              { name: 'litewriter_enabled', type: 'INTEGER', default: 0 },
              { name: 'litewriter_url', type: 'TEXT', default: "''" },
              { name: 'litewriter_username', type: 'TEXT', default: "''" },
              { name: 'litewriter_password', type: 'TEXT', default: "''" },
              { name: 'background_enabled', type: 'INTEGER', default: 0 },
              { name: 'background_url', type: 'TEXT', default: "''" },
              { name: 'background_opacity', type: 'REAL', default: 0.3 },
              { name: 'background_editor_enabled', type: 'INTEGER', default: 0 },
              { name: 'cloud_backup_schedule', type: 'TEXT', default: "'manual'" }
            ];

            db.all(`PRAGMA table_info(user_settings)`, (err, rows) => {
              if (err) {
                console.error('Failed to read table info for user_settings:', err);
                return reject(err);
              }

              const existing = new Set(rows.map(r => r.name));
              const addColumnTasks = [];
              
              for (const col of wantedColumns) {
                if (!existing.has(col.name)) {
                  addColumnTasks.push(new Promise((resolveAdd, rejectAdd) => {
                    const sql = `ALTER TABLE user_settings ADD COLUMN ${col.name} ${col.type} DEFAULT ${col.default}`;
                    db.run(sql, (err) => {
                      if (err) {
                        console.warn(`Could not add column ${col.name}:`, err.message);
                        return rejectAdd(err);
                      }
                      console.log(`Added missing column user_settings.${col.name}`);
                      resolveAdd();
                    });
                  }));
                }
              }

              Promise.all(addColumnTasks)
                .then(() => resolve())
                .catch((err) => {
                  console.warn('One or more migrations failed:', err && err.message ? err.message : err);
                  resolve();
                });
            });
          } catch (ex) {
            console.error('Migration error:', ex);
            resolve();
          }
        });
      });
    });
  }

  async createDefaultUser() {
    const db = this.db;
    
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE username = ?', ['admin'], async (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (row) {
          db.get('SELECT * FROM user_settings WHERE user_id = ?', [row.id], (err, settingsRow) => {
            if (err) {
              console.warn('Failed to check user_settings for admin:', err);
              return resolve();
            }
            if (!settingsRow) {
              db.run(
                `INSERT INTO user_settings (user_id, theme, litewriter_enabled, background_enabled) VALUES (?, ?, ?, ?)`,
                [row.id, 'dark', 0, 0],
                (err) => {
                  if (err) console.warn('Failed to create default settings for admin:', err);
                  resolve();
                }
              );
            } else {
              resolve();
            }
          });
          return;
        }
        
        try {
          const hashedPassword = await bcrypt.hash('admin', 10);
          
          db.run(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            ['admin', hashedPassword],
            function(err) {
              if (err) {
                if (err.code === 'SQLITE_CONSTRAINT') {
                  console.log('Admin user was created by another process');
                  resolve();
                } else {
                  reject(err);
                }
              } else {
                const userId = this.lastID;
                
                db.run(
                  'INSERT INTO user_settings (user_id, theme, litewriter_enabled, background_enabled) VALUES (?, ?, ?, ?)',
                  [userId, 'dark', 0, 0],
                  (err) => {
                    if (err) {
                      console.error('Error creating user settings:', err);
                      resolve();
                    } else {
                      console.log('Admin user created successfully');
                      resolve();
                    }
                  }
                );
              }
            }
          );
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async findUserByUsername(username) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM users WHERE username = ?',
        [username],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async getUserSettings(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM user_settings WHERE user_id = ?',
        [userId],
        (err, row) => {
          if (err) reject(err);
          else {
            const safe = Object.assign({
              theme: 'dark',
              backup_schedule: 'daily',
              cloud_backup_schedule: 'manual',
              litewriter_enabled: 0,
              litewriter_url: '',
              litewriter_username: '',
              litewriter_password: '',
              background_enabled: 0,
              background_url: '',
              background_opacity: 0.3,
              background_editor_enabled: 0
            }, row || {});
            resolve(safe);
          }
        }
      );
    });
  }

  async updateUserSettings(userId, settings) {
    return new Promise((resolve, reject) => {
      const {
        theme,
        backup_schedule,
        cloud_backup_schedule,
        google_drive_token,
        google_drive_refresh_token,
        litewriter_enabled,
        litewriter_url,
        litewriter_username,
        litewriter_password,
        background_enabled,
        background_url,
        background_opacity,
        background_editor_enabled
      } = settings;
      
      this.db.get('SELECT * FROM user_settings WHERE user_id = ?', [userId], (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (row) {
          const updates = [];
          const values = [];
          
          if (theme !== undefined) { updates.push('theme = ?'); values.push(theme); }
          if (backup_schedule !== undefined) { updates.push('backup_schedule = ?'); values.push(backup_schedule); }
          if (cloud_backup_schedule !== undefined) { updates.push('cloud_backup_schedule = ?'); values.push(cloud_backup_schedule); }
          if (google_drive_token !== undefined) { updates.push('google_drive_token = ?'); values.push(google_drive_token); }
          if (google_drive_refresh_token !== undefined) { updates.push('google_drive_refresh_token = ?'); values.push(google_drive_refresh_token); }
          if (litewriter_enabled !== undefined) { updates.push('litewriter_enabled = ?'); values.push(litewriter_enabled ? 1 : 0); }
          if (litewriter_url !== undefined) { updates.push('litewriter_url = ?'); values.push(litewriter_url); }
          if (litewriter_username !== undefined) { updates.push('litewriter_username = ?'); values.push(litewriter_username); }
          if (litewriter_password !== undefined) { updates.push('litewriter_password = ?'); values.push(litewriter_password); }
          if (background_enabled !== undefined) { updates.push('background_enabled = ?'); values.push(background_enabled ? 1 : 0); }
          if (background_url !== undefined) { updates.push('background_url = ?'); values.push(background_url); }
          if (background_opacity !== undefined) { updates.push('background_opacity = ?'); values.push(background_opacity); }
          if (background_editor_enabled !== undefined) { updates.push('background_editor_enabled = ?'); values.push(background_editor_enabled ? 1 : 0); }
          
          if (updates.length === 0) {
            resolve();
            return;
          }
          
          values.push(userId);
          const sql = `UPDATE user_settings SET ${updates.join(', ')} WHERE user_id = ?`;
          this.db.run(sql, values, (err) => {
            if (err) reject(err);
            else resolve();
          });
        } else {
          this.db.run(
            `INSERT INTO user_settings (user_id, theme, backup_schedule, cloud_backup_schedule, google_drive_token, google_drive_refresh_token, litewriter_enabled, litewriter_url, litewriter_username, litewriter_password, background_enabled, background_url, background_opacity, background_editor_enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              userId,
              theme || 'dark',
              backup_schedule || 'daily',
              cloud_backup_schedule || 'manual',
              google_drive_token || null,
              google_drive_refresh_token || null,
              (litewriter_enabled ? 1 : 0),
              litewriter_url || '',
              litewriter_username || '',
              litewriter_password || '',
              (background_enabled ? 1 : 0),
              background_url || '',
              background_opacity !== undefined ? background_opacity : 0.3,
              (background_editor_enabled ? 1 : 0)
            ],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        }
      });
    });
  }

  async updateUserPassword(userId, hashedPassword) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE users SET password = ? WHERE id = ?',
        [hashedPassword, userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

const instance = new Database();
module.exports = instance;
