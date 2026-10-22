'use strict';

const { db, settings: settingsStore } = require('./db');

function todayFor(userId, date = new Date()) {
  const tz = settingsStore.get(userId).timezone;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
}

const logStmt = db.prepare(`
  INSERT INTO writing_log (user_id, day, novel_key, novel_title, words_added, words_removed)
  VALUES (@user_id, @day, @novel_key, @novel_title, @added, @removed)
  ON CONFLICT(user_id, day, novel_key) DO UPDATE SET
    words_added = words_added + excluded.words_added,
    words_removed = words_removed + excluded.words_removed,
    novel_title = excluded.novel_title
`);

/** Record the effect of one save on today's word log. */
function recordSave(userId, { source, novelId, title, previousWords, words }) {
  const delta = (words || 0) - (previousWords || 0);
  if (!delta) return;
  logStmt.run({
    user_id: userId,
    day: todayFor(userId),
    novel_key: `${source}:${novelId}`,
    novel_title: title || '',
    added: Math.max(0, delta),
    removed: Math.max(0, -delta)
  });
}

function wordsToday(userId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(words_added - words_removed), 0) AS net FROM writing_log WHERE user_id = ? AND day = ?')
    .get(userId, todayFor(userId));
  return Math.max(0, row.net);
}

function shiftDay(day, delta) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function summary(userId, days = 30) {
  const today = todayFor(userId);
  const from = shiftDay(today, -(days - 1));
  const rows = db
    .prepare(`SELECT day, SUM(words_added) AS added, SUM(words_removed) AS removed
              FROM writing_log WHERE user_id = ? AND day >= ? GROUP BY day`)
    .all(userId, from);
  const byDay = new Map(rows.map(r => [r.day, r]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = shiftDay(today, -i);
    const r = byDay.get(day);
    series.push({ day, net: r ? Math.max(0, r.added - r.removed) : 0, added: r ? r.added : 0 });
  }

  // Streak: consecutive days (ending today or yesterday) with net words written.
  const activeDays = new Set(
    db.prepare('SELECT day FROM writing_log WHERE user_id = ? GROUP BY day HAVING SUM(words_added - words_removed) > 0').all(userId).map(r => r.day)
  );
  let streak = 0;
  let cursor = activeDays.has(today) ? today : shiftDay(today, -1);
  while (activeDays.has(cursor)) {
    streak++;
    cursor = shiftDay(cursor, -1);
  }

  const totals = db
    .prepare(`SELECT COALESCE(SUM(words_added - words_removed), 0) AS net, COUNT(DISTINCT day) AS days
              FROM writing_log WHERE user_id = ?`)
    .get(userId);
  const best = db
    .prepare(`SELECT day, SUM(words_added - words_removed) AS net FROM writing_log WHERE user_id = ?
              GROUP BY day ORDER BY net DESC LIMIT 1`)
    .get(userId);
  const byNovel = db
    .prepare(`SELECT novel_key, MAX(novel_title) AS title, SUM(words_added - words_removed) AS net
              FROM writing_log WHERE user_id = ? AND day >= ? GROUP BY novel_key ORDER BY net DESC LIMIT 8`)
    .all(userId, from)
    .filter(r => r.net > 0);

  const last7 = series.slice(-7).reduce((s, d) => s + d.net, 0);
  const prev7 = series.slice(-14, -7).reduce((s, d) => s + d.net, 0);

  return {
    today: series[series.length - 1].net,
    series,
    streak,
    last7,
    prev7,
    totalLogged: Math.max(0, totals.net),
    activeDays: totals.days,
    best: best && best.net > 0 ? best : null,
    byNovel
  };
}

module.exports = { recordSave, wordsToday, summary, todayFor };
