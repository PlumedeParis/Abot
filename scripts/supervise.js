'use strict';

// Runs the bot for a limited time (one GitHub Actions job) and restarts it
// after a crash, with backoff. At the time limit it stops the bot cleanly.
//   KITBOT_RUN_MINUTES=340 node scripts/supervise.js [all|minecraft|discord]

const { spawn } = require('node:child_process');
const path = require('node:path');

const minutes = Math.max(1, Math.min(Number(process.env.KITBOT_RUN_MINUTES || 340), 345));
const maxRestarts = Number(process.env.KITBOT_MAX_RESTARTS || 5);
const deadline = Date.now() + minutes * 60000;
const log = (msg) => console.log(`[${new Date().toISOString()}] SUPERVISOR ${msg}`);
let child = null;
let restarts = 0;
let stopping = false;

function run() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping || Date.now() >= deadline) {
      log(`bot exited (${signal || code}); done`);
      process.exit(0);
    }
    if (code === 2) {
      log('setup problem (see the FATAL line above); not restarting');
      process.exit(1);
    }
    if (restarts >= maxRestarts) {
      log(`bot crashed ${restarts + 1} times; giving up`);
      process.exit(1);
    }
    const delay = Math.min(120000, 5000 * 2 ** restarts++);
    log(`bot exited (${signal || code}); restart ${restarts}/${maxRestarts} in ${delay / 1000}s`);
    setTimeout(run, delay);
  });
}

function stop(why) {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${why}`);
  if (!child) process.exit(0);
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child) child.kill('SIGKILL');
    process.exit(0);
  }, 100000).unref();
}

log(`running the bot for up to ${minutes} minutes`);
setTimeout(() => stop('time limit reached'), Math.max(0, deadline - Date.now()));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
run();
