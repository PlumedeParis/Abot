'use strict';

// Runs the bot for a bounded amount of time (one GitHub Actions job) and
// restarts it after a crash, with backoff and a restart limit. When the time is
// up, the bot receives SIGTERM and shuts down cleanly before the job ends.
// This does NOT start new workflow runs: when the job ends, the bot stops.
//
//   KITBOT_RUN_MINUTES=300 node scripts/supervise.js

const { spawn } = require('node:child_process');
const path = require('node:path');

const minutes = Math.max(1, Math.min(Number(process.env.KITBOT_RUN_MINUTES || 300), 340));
const maxRestarts = Number(process.env.KITBOT_MAX_RESTARTS || 5);
const deadline = Date.now() + minutes * 60000;
let child = null;
let restarts = 0;
let stopping = false;

const log = (msg) => console.log(`[${new Date().toISOString()}] SUPERVISOR ${msg}`);

function run() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping || Date.now() >= deadline) {
      log(`bot exited (${signal || code}); run finished`);
      process.exit(0);
    }
    if (code === 1 && restarts === 0 && Date.now() - startedAt < 15000) {
      log('bot failed during startup (check configuration and secrets); not restarting');
      process.exit(1);
    }
    if (restarts >= maxRestarts) {
      log(`bot crashed ${restarts + 1} times; giving up`);
      process.exit(1);
    }
    const delay = Math.min(120000, 5000 * 2 ** restarts);
    restarts++;
    log(`bot exited unexpectedly (${signal || code}); restart ${restarts}/${maxRestarts} in ${delay / 1000}s`);
    setTimeout(run, delay);
  });
}

function stop(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  if (child) child.kill('SIGTERM');
  else process.exit(0);
  setTimeout(() => {
    if (child) child.kill('SIGKILL');
    process.exit(0);
  }, 100000).unref();
}

const startedAt = Date.now();
log(`running the bot for up to ${minutes} minutes`);
setTimeout(() => stop('time limit reached'), deadline - Date.now());
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
run();
