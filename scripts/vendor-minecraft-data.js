'use strict';

// Builds vendor/minecraft-data: the minecraft-data package with only the Java
// Edition 1.21.x data. The full package is about 430 MB (334 MB of it Bedrock
// data), which does not fit on small free hosts. Files are loaded lazily, so
// the missing versions only matter if the bot is configured for one of them.
//   node scripts/vendor-minecraft-data.js <path to a full minecraft-data package>

const fs = require('node:fs');
const path = require('node:path');

const src = path.resolve(process.argv[2] || '');
const out = path.resolve(__dirname, '..', 'vendor', 'minecraft-data');
const VERSIONS = /^1\.21(\.|$)/;

if (!fs.existsSync(path.join(src, 'data.js'))) {
  console.error('Usage: node scripts/vendor-minecraft-data.js <path to a full minecraft-data package>');
  process.exit(1);
}

const dataPaths = JSON.parse(fs.readFileSync(path.join(src, 'minecraft-data/data/dataPaths.json'), 'utf8'));
// The common folders and schemas are loaded as soon as the package is required.
const dirs = new Set(['pc/common', 'bedrock/common']);
const versions = Object.keys(dataPaths.pc).filter((v) => VERSIONS.test(v));
for (const v of versions) for (const d of Object.values(dataPaths.pc[v])) dirs.add(d);

fs.rmSync(out, { recursive: true, force: true });
const copy = (rel) => fs.cpSync(path.join(src, rel), path.join(out, rel), { recursive: true });
for (const f of ['index.js', 'data.js', 'index.d.ts', 'lib', 'minecraft-data/schemas', 'minecraft-data/data/dataPaths.json']) copy(f);
for (const d of dirs) copy(`minecraft-data/data/${d}`);

// No scripts: the package must install as is.
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
const trimmed = { name: pkg.name, version: pkg.version, description: `${pkg.description} (Java Edition ${versions[0]}-${versions[versions.length - 1]} only, for VoidKits)`, main: pkg.main, types: 'index.d.ts', license: pkg.license, dependencies: {} };
fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(trimmed, null, 2)}\n`);
console.log(`vendor/minecraft-data ${pkg.version}: ${versions.join(', ')} (${dirs.size} data folders)`);
