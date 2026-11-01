import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.CLUI_DATA_DIR || path.join(ROOT, 'data');
export const WEB = path.join(ROOT, 'web');

export const dirs = {
  engine: path.join(DATA, 'engine'),
  models: path.join(DATA, 'models'),
  chats: path.join(DATA, 'chats'),
};

for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
