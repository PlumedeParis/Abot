'use strict';

// Checks the settings (built-in defaults, config.json or KITBOT_CONFIG_JSON).
//   node scripts/validate-config.js [file]

const path = require('node:path');
const { loadSettings } = require('../src/config');

const env = { ...process.env };
if (process.argv[2]) {
  env.KITBOT_CONFIG = path.resolve(process.argv[2]);
  delete env.KITBOT_CONFIG_JSON;
}
try {
  const { errors, source } = loadSettings(env);
  if (errors.length) {
    console.error(`Settings from ${source} are invalid:\n - ${errors.join('\n - ')}`);
    process.exit(1);
  }
  console.log(`Settings from ${source} are valid.`);
} catch (e) {
  console.error(`Could not read the settings: ${e.message}`);
  process.exit(1);
}
