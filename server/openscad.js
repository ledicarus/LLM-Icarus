import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DATA } from './paths.js';
import { downloadTo } from './download.js';
import { emit } from './events.js';
import * as platform from './platform.js';

// OpenSCAD turns a short script into a solid (STL). It is downloaded once into data/openscad (about 21 MB on Windows,
// 27 MB on a Mac) and run as a separate program; it is GPL-licensed software, not part of LLM Icarus.
// 2021.01 is the last stable release; the daily snapshots are newer but their file names change every day.

const VERSION = '2021.01';
const DIR = path.join(DATA, 'openscad');
const URL_WIN = `https://files.openscad.org/OpenSCAD-${VERSION}-x86-64.zip`;
const URL_MAC = `https://files.openscad.org/OpenSCAD-${VERSION}.dmg`;
const status = (message, extra = {}) => emit('engine-status', { message, ...extra });

// Find the program inside whatever folder the archive unpacked to.
function find(dir, names, depth = 0) {
  if (!fs.existsSync(dir) || depth > 4) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && names.includes(e.name.toLowerCase())) return path.join(dir, e.name);
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const hit = find(path.join(dir, e.name), names, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// openscad.com is the console build on Windows: it reports errors on stderr, which the .exe does not
export const exePath = () =>
  platform.IS_WIN
    ? find(DIR, ['openscad.com']) || find(DIR, ['openscad.exe'])
    : find(path.join(DIR, 'OpenSCAD.app', 'Contents', 'MacOS'), ['openscad']);
export const installed = () => !!exePath();

export async function install() {
  fs.mkdirSync(DIR, { recursive: true });
  if (platform.IS_WIN) {
    const zip = path.join(DIR, 'openscad.zip');
    status(`Downloading OpenSCAD ${VERSION}...`);
    await downloadTo(URL_WIN, zip, `OpenSCAD ${VERSION}`);
    status('Unpacking OpenSCAD...');
    execFileSync(platform.tarPath(), ['-xf', zip, '-C', DIR], { timeout: 180000 });
    fs.rmSync(zip, { force: true });
  } else {
    const dmg = path.join(DIR, 'openscad.dmg');
    status(`Downloading OpenSCAD ${VERSION}...`);
    await downloadTo(URL_MAC, dmg, `OpenSCAD ${VERSION}`);
    status('Unpacking OpenSCAD...');
    const mount = path.join(DIR, 'mnt');
    fs.mkdirSync(mount, { recursive: true });
    try {
      execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { timeout: 120000 });
      fs.rmSync(path.join(DIR, 'OpenSCAD.app'), { recursive: true, force: true });
      execFileSync('cp', ['-R', path.join(mount, 'OpenSCAD.app'), DIR], { timeout: 120000 });
    } finally {
      try {
        execFileSync('hdiutil', ['detach', mount, '-force'], { timeout: 60000 });
      } catch {
        /* already gone */
      }
      fs.rmSync(mount, { recursive: true, force: true });
      fs.rmSync(dmg, { force: true });
    }
  }
  if (!installed()) throw new Error('OpenSCAD was unpacked, but its program was not found');
  status('OpenSCAD is installed', { done: true });
}

// Render a .scad file to a binary STL. Resolves with { log }; rejects with the error text OpenSCAD printed.
export function render(scadFile, stlFile, { timeoutMs = 240000, onChild } = {}) {
  return new Promise((resolve, reject) => {
    const exe = exePath();
    if (!exe) return reject(new Error('OpenSCAD is not installed'));
    const child = spawn(exe, ['-o', stlFile, '--export-format', 'binstl', scadFile], { stdio: ['ignore', 'pipe', 'pipe'], ...platform.spawnGroup() });
    onChild?.(child);
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const timer = setTimeout(() => {
      platform.killTree(child.pid);
      reject(new Error(`OpenSCAD took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped. Try a simpler shape or fewer curved parts.`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start OpenSCAD: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (/top level object is empty/i.test(log)) return reject(new Error('The script produced no solid (it drew nothing, or every part has zero size).'));
      const errors = log.split(/\r?\n/).filter((l) => /\b(ERROR|Parser error)\b/i.test(l));
      if (code !== 0 || errors.length) return reject(new Error((errors.join('\n') || log.trim().split(/\r?\n/).slice(-3).join('\n') || `OpenSCAD exited with code ${code}`).slice(0, 1500)));
      if (!fs.existsSync(stlFile) || fs.statSync(stlFile).size < 84) {
        const warn = log.split(/\r?\n/).filter((l) => /WARNING|empty/i.test(l)).join('\n');
        return reject(new Error(`OpenSCAD produced no solid.${warn ? '\n' + warn : ''}`.slice(0, 1500)));
      }
      resolve({ log });
    });
  });
}

// Size and triangle count of a binary STL: lets us tell the user how big the result really is.
export function stlInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(84);
    fs.readSync(fd, head, 0, 84, 0);
    const n = head.readUInt32LE(80);
    const size = fs.fstatSync(fd).size;
    if (84 + n * 50 !== size) return { triangles: null, size: null }; // not a binary STL (or damaged)
    const buf = Buffer.alloc(n * 50);
    fs.readSync(fd, buf, 0, buf.length, 84);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < n; t++) {
      const base = t * 50 + 12; // skip the normal
      for (let v = 0; v < 3; v++) {
        for (let a = 0; a < 3; a++) {
          const x = buf.readFloatLE(base + v * 12 + a * 4);
          if (x < lo[a]) lo[a] = x;
          if (x > hi[a]) hi[a] = x;
        }
      }
    }
    if (!n) return { triangles: 0, size: null };
    return { triangles: n, size: hi.map((h, i) => Math.round((h - lo[i]) * 100) / 100) };
  } finally {
    fs.closeSync(fd);
  }
}
