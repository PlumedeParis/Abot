'use strict';

// Syntax-checks every JavaScript file (used by CI in addition to the tests).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = [];
for (const dir of ['src', 'scripts', 'test']) {
  for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.js')) files.push(path.join(dir, f));
}
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`${f}:\n${e.stderr.toString()}`);
  }
}
for (const f of ['config.example.json', 'package.json']) JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
console.log(failed ? `${failed} file(s) failed the syntax check.` : `${files.length} files OK.`);
process.exit(failed ? 1 : 0);
