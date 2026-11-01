import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { emit } from './events.js';

// Download a file to dest (via a .part file), reporting progress as 'engine-progress' events.
export async function downloadTo(url, dest, label = path.basename(dest)) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'llm-icarus' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${label}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let last = 0;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => {
    done += c.length;
    const now = Date.now();
    if (now - last > 400) {
      last = now;
      emit('engine-progress', { file: label, done, total });
    }
  });
  try {
    await pipeline(src, fs.createWriteStream(part));
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  emit('engine-progress', { file: label, done: total || done, total: total || done });
  return dest;
}
