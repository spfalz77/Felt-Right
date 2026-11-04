#!/usr/bin/env node
// Builds the deployable index.html (repo root) from the sources in src/.
//
// src/index.html is the page template. Lines of the form
//   /* @inline path */        → replaced with the contents of src/path
//   /* @inline-all js/[0-9]*.js */ → replaced with every matching file, in name order
// All app JS still runs as ONE classic <script>, exactly as before the split,
// so globals, hoisting and the inline onclick="..." handlers behave identically.
//
// Usage:
//   node scripts/build.mjs           write ./index.html
//   node scripts/build.mjs --check   fail if ./index.html is out of date

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const outFile = join(root, 'index.html');

// Read a source file, dropping exactly one trailing newline.
const read = (rel) => readFileSync(join(srcDir, rel), 'utf8').replace(/\n$/, '');

function globFiles(pattern) {
  const [dir, filePat] = pattern.split('/');
  const re = new RegExp('^' + filePat.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  return readdirSync(join(srcDir, dir)).filter((f) => re.test(f)).sort().map((f) => `${dir}/${f}`);
}

export function build() {
  const template = readFileSync(join(srcDir, 'index.html'), 'utf8');
  return template
    .split('\n')
    .map((line) => {
      let m = line.match(/^\/\* @inline (\S+) \*\/$/);
      if (m) return read(m[1]);
      m = line.match(/^\/\* @inline-all (\S+) \*\/$/);
      if (m) return globFiles(m[1]).map(read).join('\n');
      return line;
    })
    .join('\n');
}

const html = build();
if (process.argv.includes('--check')) {
  const current = readFileSync(outFile, 'utf8');
  if (current !== html) {
    console.error('index.html is out of date. Run: node scripts/build.mjs');
    process.exit(1);
  }
  console.log('index.html is up to date');
} else {
  writeFileSync(outFile, html);
  console.log(`Built index.html (${(html.length / 1024).toFixed(0)} KB)`);
}
