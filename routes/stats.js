'use strict';

const express = require('express');
const { requireUser } = require('../lib/auth');
const library = require('../lib/library');
const stats = require('../lib/stats');
const { db, settings } = require('../lib/db');

const router = express.Router();
router.use(requireUser);

router.get('/', async (req, res) => {
  const summary = stats.summary(req.user.id, 30);
  const novels = await library.listNovels(req.user.id);
  // Word totals for LiteWriter novels come from the per-file cache, so this
  // page never has to wait for the device.
  const remote = db
    .prepare(`SELECT substr(path, 2, instr(substr(path, 2), '/') - 1) AS novel, SUM(words) AS words
              FROM remote_file_cache WHERE user_id = ? AND instr(substr(path, 2), '/') > 0
                AND path NOT LIKE '%/Synopsis.md' AND path NOT LIKE '%/Intro.md'
              GROUP BY novel ORDER BY words DESC`)
    .all(req.user.id);
  res.render('stats', {
    title: 'Statistics',
    summary,
    novels,
    remote,
    dailyGoal: settings.get(req.user.id).daily_goal
  });
});

module.exports = router;
