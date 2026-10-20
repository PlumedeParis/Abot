'use strict';

// Validates a settings file without connecting anywhere.
//   node scripts/validate-config.js                      -> config.json (or KITBOT_CONFIG / KITBOT_CONFIG_JSON)
//   node scripts/validate-config.js config.example.json --allow-placeholders

const path = require('node:path');
const { loadSettings } = require('../src/config');

const args = process.argv.slice(2);
const allowPlaceholders = args.includes('--allow-placeholders');
const file = args.find((a) => !a.startsWith('--'));
const env = { ...process.env };
if (file) {
  env.KITBOT_CONFIG = path.resolve(file);
  delete env.KITBOT_CONFIG_JSON;
}

try {
  const { errors, source } = loadSettings(env, { allowPlaceholders });
  const label = source === 'KITBOT_CONFIG_JSON' ? 'KITBOT_CONFIG_JSON' : path.relative(process.cwd(), source);
  if (errors.length) {
    console.error(`Configuration ${label} is invalid:\n - ${errors.join('\n - ')}`);
    process.exit(1);
  }
  console.log(`Configuration ${label} is valid${allowPlaceholders ? ' (placeholders allowed)' : ''}.`);
} catch (e) {
  console.error(`Could not read configuration: ${e.message}`);
  process.exit(1);
}
