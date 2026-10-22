'use strict';

require('dotenv').config();

const config = require('./lib/config');
const { createApp } = require('./lib/app');
const scheduler = require('./lib/scheduler');
const { db } = require('./lib/db');

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`WebWriter ${config.version} is running on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});

scheduler.start();

function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
