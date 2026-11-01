// Builds dist/LLM-Icarus-macOS-<version>.zip on any OS (including Windows).
//   node installer/build-mac.js
//
// Windows can't mark files "executable", so this writes the zip itself and records Unix
// permissions (0755 for scripts) in the zip's attributes; macOS honours them when unzipping.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TOP = 'LLM-Icarus-macOS';

const entries = []; // { name, data, mode }
const isScript = (n) => /\.(sh|command)$/.test(n);
function add(zipPath, data, mode) {
  if (isScript(zipPath) || /\.(js|py|json|html|css|txt|md|plist)$/.test(zipPath)) {
    // text files: force Unix line endings (scripts with CRLF fail on macOS)
    data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  }
  entries.push({ name: `${TOP}/${zipPath}`, data, mode });
}
function addTree(srcDir, zipDir, skip = () => false) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, e.name);
    const dest = `${zipDir}/${e.name}`;
    if (skip(dest, e)) continue;
    if (e.isDirectory()) addTree(src, dest, skip);
    else add(dest, fs.readFileSync(src), isScript(e.name) ? 0o755 : 0o644);
  }
}

// ---- contents -----------------------------------------------------------------
const mac = path.join(ROOT, 'mac');
add('Install LLM Icarus.command', fs.readFileSync(path.join(mac, 'Install LLM Icarus.command')), 0o755);
add('Uninstall LLM Icarus.command', fs.readFileSync(path.join(mac, 'Uninstall LLM Icarus.command')), 0o755);
add('READ ME FIRST.txt', fs.readFileSync(path.join(mac, 'READ ME FIRST.txt')), 0o644);
add('TESTING-MAC.md', fs.readFileSync(path.join(ROOT, 'TESTING-MAC.md')), 0o644);

addTree(path.join(ROOT, 'server'), 'app/server', (d, e) => e.name === '__pycache__');
addTree(path.join(ROOT, 'web'), 'app/web');
addTree(path.join(ROOT, 'claude-skill'), 'app/claude-skill'); // optional Claude Code skill; see READ ME FIRST
add('app/API.md', fs.readFileSync(path.join(ROOT, 'API.md')), 0o644);
add('app/CHANGELOG.md', fs.readFileSync(path.join(ROOT, 'CHANGELOG.md')), 0o644);
add('app/start.sh', fs.readFileSync(path.join(mac, 'start.sh')), 0o755);
add('app/stop.sh', fs.readFileSync(path.join(mac, 'stop.sh')), 0o755);
add('app/package.json', fs.readFileSync(path.join(ROOT, 'package.json')), 0o644);
add('app/THIRD_PARTY_NOTICES.txt', fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.txt')), 0o644);

// ---- zip writer ---------------------------------------------------------------
const crc32 =
  zlib.crc32 ||
  ((buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  });

const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

const chunks = [];
const central = [];
let offset = 0;
for (const e of entries) {
  const name = Buffer.from(e.name, 'utf8');
  const comp = zlib.deflateRawSync(e.data, { level: 9 });
  const crc = crc32(e.data) >>> 0;

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4); // version needed
  lh.writeUInt16LE(0x0800, 6); // UTF-8 names
  lh.writeUInt16LE(8, 8); // deflate
  lh.writeUInt16LE(dosTime, 10);
  lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(e.data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  chunks.push(lh, name, comp);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, spec 2.0 (so the mode bits are honoured)
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(dosTime, 12);
  ch.writeUInt16LE(dosDate, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(e.data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38); // external attributes: regular file + permissions
  ch.writeUInt32LE(offset, 42);
  central.push(ch, name);

  offset += lh.length + name.length + comp.length;
}
const cdSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cdSize, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', `LLM-Icarus-macOS-${version}.zip`);
fs.writeFileSync(out, Buffer.concat([...chunks, ...central, end]));
console.log(`Built ${out}  (${(fs.statSync(out).size / 1e6).toFixed(2)} MB, ${entries.length} files)`);
