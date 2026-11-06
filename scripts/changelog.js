#!/usr/bin/env node
/**
 * Small CHANGELOG helper used by the release workflow.
 *
 *   node scripts/changelog.js release 1.2.3 [notes.md]
 *       Turns "## [Unreleased]" into "## [1.2.3] - YYYY-MM-DD" (keeping an empty Unreleased section on top)
 *       and writes the body of that section to notes.md (default: stdout).
 *
 *   node scripts/changelog.js notes 1.2.3 [notes.md]
 *       Only extracts the notes of an existing version section.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'CHANGELOG.md');
const [cmd, version, out] = process.argv.slice(2);
if (!['release', 'notes'].includes(cmd) || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('usage: changelog.js <release|notes> <x.y.z> [out-file]');
  process.exit(2);
}

let text = fs.readFileSync(file, 'utf8');
const escaped = version.replace(/\./g, '\\.');

if (cmd === 'release') {
  if (new RegExp(`^## \\[${escaped}\\]`, 'm').test(text)) {
    console.error(`CHANGELOG already contains ${version}`);
    process.exit(1);
  }
  if (!/^## \[Unreleased\]/m.test(text)) {
    console.error('CHANGELOG has no "## [Unreleased]" section');
    process.exit(1);
  }
  const date = new Date().toISOString().slice(0, 10);
  text = text.replace(/^## \[Unreleased\][^\n]*\n/m, `## [Unreleased]\n\n## [${version}] - ${date}\n`);
  fs.writeFileSync(file, text);
}

const m = text.match(new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm'));
let notes = (m ? m[1] : '').trim();
if (!notes) notes = '_No changelog entries for this version._';
if (out) fs.writeFileSync(out, notes + '\n');
else process.stdout.write(notes + '\n');
