#!/usr/bin/env node
// Builds www/, the web bundle the Android and iPhone apps ship with: the same
// index.html GitHub Pages serves, plus the bundled vendor files and icons.
// Then run `npx cap sync` to copy it into android/ and ios/.
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');

// Make sure index.html and vendor/ are current
await import('node:child_process').then(({ execFileSync }) =>
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' }));

rmSync(www, { recursive: true, force: true });
mkdirSync(www);
writeFileSync(join(www, 'index.html'), build());
for (const f of ['manifest.json', 'icon-192.svg', 'icon-512.svg', 'vendor']) {
  cpSync(join(root, f), join(www, f), { recursive: true });
}
console.log('Built www/ for the apps');
