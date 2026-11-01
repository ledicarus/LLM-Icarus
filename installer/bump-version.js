// Version scheme:  MAJOR.BUILD.M-D-YY   for example 0.2.11-1-26
//   MAJOR  goes up by 1 only with --release, when a release is posted to GitHub (0 until the first one)
//   BUILD  goes up by 1 each time a new installer is made; --release resets it to 0
//   third  is today's date: month-day-year, no leading zeros (November 1, 2026 -> 11-1-26)
// Writes the new version into package.json, which the installer builds read.
//   node installer/bump-version.js            new installer      0.2.x -> 0.3.x
//   node installer/bump-version.js --release  new GitHub release 0.556.x -> 1.0.x
// (BUMP_FILE overrides the file, for testing.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.env.BUMP_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const release = process.argv.includes('--release');
const text = fs.readFileSync(file, 'utf8');
const current = JSON.parse(text).version;
const m = /^(\d+)\.(\d+)\./.exec(current);
if (!m) throw new Error(`Version "${current}" does not look like MAJOR.BUILD.date`);

const d = new Date();
const [major, build] = release ? [Number(m[1]) + 1, 0] : [Number(m[1]), Number(m[2]) + 1];
const next = `${major}.${build}.${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
// Move the "Unreleased" notes under a heading for this version.
const log = path.join(path.dirname(file), 'CHANGELOG.md');
if (!process.env.BUMP_FILE && fs.existsSync(log)) {
  const notes = fs.readFileSync(log, 'utf8');
  const m2 = /## Unreleased\r?\n([\s\S]*?)(?=\r?\n## )/.exec(notes);
  if (!m2) console.warn('CHANGELOG.md has no "## Unreleased" section; add one and describe this build there.');
  else {
    if (!m2[1].trim()) console.warn('WARNING: CHANGELOG.md has nothing under "## Unreleased". Describe what changed in this build.');
    const heading = `## ${next} (${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })})`;
    fs.writeFileSync(log, notes.replace('## Unreleased', `## Unreleased\n\n${heading}`));
  }
}
fs.writeFileSync(file, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`));
console.log(`Version ${current} -> ${next}`);
