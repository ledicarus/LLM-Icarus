import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirs, DATA, readJson, writeJson } from './paths.js';
import { emit } from './events.js';

const REGISTRY = path.join(DATA, 'models.json');
const OLLAMA_ROOT = path.join(os.homedir(), '.ollama', 'models');

const read = () => readJson(REGISTRY, []);

// 'llm' = .gguf language model, 'image' = .safetensors Stable Diffusion/SDXL checkpoint
export const kindOf = (p) => (p.toLowerCase().endsWith('.safetensors') ? 'image' : 'llm');

export function list() {
  return read().map((m) => ({ ...m, kind: m.kind || kindOf(m.path), exists: fs.existsSync(m.path) }));
}

export function get(id) {
  return read().find((m) => m.id === id);
}

function add(entry) {
  const previous = read().find((m) => m.path === entry.path);
  const all = read().filter((m) => m.path !== entry.path);
  // re-adding the same file (for example after an update) keeps its id, so chats that use it stay linked
  const model = { id: previous?.id ?? crypto.randomUUID().slice(0, 8), addedAt: new Date().toISOString(), kind: kindOf(entry.path), ...entry };
  all.push(model);
  writeJson(REGISTRY, all);
  return model;
}

export function remove(id, deleteFile) {
  const all = read();
  const m = all.find((x) => x.id === id);
  if (!m) return false;
  writeJson(REGISTRY, all.filter((x) => x.id !== id));
  // only ever delete files that live in our own models folder
  if (deleteFile && path.dirname(m.path) === dirs.models) fs.rmSync(m.path, { force: true });
  return true;
}

// Register a .gguf that already exists on disk (kept in place, not copied).
export function addPath(file, name) {
  file = path.resolve(file);
  if (!fs.existsSync(file) || !/\.(gguf|safetensors)$/i.test(file)) throw new Error('Not a .gguf or .safetensors file that exists');
  return add({ name: name || path.basename(file).replace(/\.(gguf|safetensors)$/i, ''), path: file, size: fs.statSync(file).size, source: 'local' });
}

// ---- Ollama import -------------------------------------------------------

export function scanOllama() {
  const base = path.join(OLLAMA_ROOT, 'manifests', 'registry.ollama.ai', 'library');
  const out = [];
  if (!fs.existsSync(base)) return out;
  for (const name of fs.readdirSync(base)) {
    for (const tag of fs.readdirSync(path.join(base, name))) {
      const manifest = readJson(path.join(base, name, tag), null);
      const layer = manifest?.layers?.find((l) => l.mediaType === 'application/vnd.ollama.image.model');
      if (!layer) continue;
      const blob = path.join(OLLAMA_ROOT, 'blobs', layer.digest.replace(':', '-'));
      if (fs.existsSync(blob)) out.push({ name: `${name}:${tag}`, path: blob, size: layer.size });
    }
  }
  return out;
}

export function importOllama(name) {
  const m = scanOllama().find((x) => x.name === name);
  if (!m) throw new Error(`Ollama model not found: ${name}`);
  return add({ name: m.name, path: m.path, size: m.size, source: 'ollama' });
}

// ---- Link downloads (Hugging Face / GitHub) ------------------------------

const isGguf = (s) => /\.(gguf|safetensors)$/i.test(s); // any model file we can use (name kept for history)

// Turns whatever the user pasted into either { url, source } for one file, or
// { choices: [{ name, size, url }] } when a GitHub repo/release offers several .gguf files.
export async function resolveSource(input) {
  input = input.trim();
  const bad = () => new Error('Paste a link to a .gguf file or a GitHub repo/release, or use org/repo/file.gguf (Hugging Face)');

  if (!/^https?:\/\//i.test(input)) {
    // shorthand: org/repo/file.gguf  (Hugging Face)
    const parts = input.split('/');
    if (parts.length >= 3 && isGguf(input)) {
      const [org, repo, ...file] = parts;
      return { source: 'huggingface', url: `https://huggingface.co/${org}/${repo}/resolve/main/${file.join('/')}?download=true` };
    }
    throw bad();
  }

  const u = new URL(input);
  if (u.protocol !== 'https:') throw new Error('Only https links are supported');
  const host = u.hostname.toLowerCase();

  if (host === 'huggingface.co') {
    return { source: 'huggingface', url: input.replace('/blob/', '/resolve/').split('?')[0] + '?download=true' };
  }

  if (host === 'raw.githubusercontent.com' || host === 'media.githubusercontent.com') {
    if (!isGguf(u.pathname)) throw bad();
    return { source: 'github', url: input.split('?')[0] };
  }

  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repo, kind, ...rest] = u.pathname.split('/').filter(Boolean);
    if (!owner || !repo) throw bad();
    // direct file: /blob/branch/path/model.gguf  ->  /raw/...  (also follows git-lfs)
    if (kind === 'blob' && isGguf(u.pathname)) {
      return { source: 'github', url: `https://github.com/${owner}/${repo}/raw/${rest.join('/')}` };
    }
    if ((kind === 'raw' || kind === 'releases') && isGguf(u.pathname)) return { source: 'github', url: input.split('?')[0] };
    // repo, /releases, or /releases/tag/<tag>: list the release's .gguf assets
    const api = kind === 'releases' && rest[0] === 'tag' && rest[1]
      ? `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(rest[1])}`
      : `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const res = await fetch(api, { headers: { 'User-Agent': 'llm-icarus', Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${owner}/${repo}. It needs a public release containing .gguf files, or paste a direct link to one.`);
    const release = await res.json();
    const choices = (release.assets || [])
      .filter((a) => isGguf(a.name))
      .map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
    if (!choices.length) throw new Error(`No .gguf files in ${owner}/${repo} release ${release.tag_name}. Paste a direct link to the file instead.`);
    if (choices.length === 1) return { source: 'github', url: choices[0].url };
    return { choices };
  }

  throw new Error('Only huggingface.co and github.com links are supported');
}

const active = new Map();

export async function downloadUrl({ url, source }) {
  const fileName = decodeURIComponent(new URL(url).pathname.split('/').pop());
  if (!isGguf(fileName)) throw new Error('That link is not a .gguf or .safetensors file');
  const dest = path.join(dirs.models, fileName);
  const part = dest + '.part';
  const key = fileName;
  if (active.has(key)) throw new Error('Already downloading that file');
  const ctrl = new AbortController();
  active.set(key, ctrl);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'llm-icarus' } });
    if (!res.ok) throw new Error(`The download returned ${res.status} (gated or private files need a login, which isn't supported yet)`);
    const total = Number(res.headers.get('content-length')) || 0;
    let done = 0;
    let last = 0;
    const src = Readable.fromWeb(res.body);
    src.on('data', (c) => {
      done += c.length;
      const now = Date.now();
      if (now - last > 400) {
        last = now;
        emit('download-progress', { file: fileName, done, total });
      }
    });
    await pipeline(src, fs.createWriteStream(part));
    fs.renameSync(part, dest);
    emit('download-progress', { file: fileName, done: total, total, finished: true });
    return add({ name: fileName.replace(/\.(gguf|safetensors)$/i, ''), path: dest, size: fs.statSync(dest).size, source, url });
  } catch (e) {
    fs.rmSync(part, { force: true });
    emit('download-progress', { file: fileName, error: e.message });
    throw e;
  } finally {
    active.delete(key);
  }
}

export function cancelDownload(file) {
  active.get(file)?.abort();
}

// ---- update checks ---------------------------------------------------------

// Has the file behind a downloaded model changed upstream? We only know the link it came from, so ask the server for the
// file's current size (a HEAD request: no download) and compare it with what we have. Models added from disk or imported
// from Ollama have no link and can't be checked here.
export async function checkUpdates() {
  const out = [];
  for (const m of list()) {
    if (!m.url) {
      out.push({ id: m.id, name: m.name, status: 'no-source' });
      continue;
    }
    try {
      const res = await fetch(m.url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'llm-icarus' } });
      const remote = Number(res.headers.get('content-length')) || 0;
      if (!res.ok || !remote) out.push({ id: m.id, name: m.name, status: 'unknown', note: res.ok ? 'The server did not report a size.' : `The server answered ${res.status}.` });
      else out.push({ id: m.id, name: m.name, status: remote === m.size ? 'current' : 'changed', local: m.size, remote });
    } catch (e) {
      out.push({ id: m.id, name: m.name, status: 'unknown', note: e.message });
    }
  }
  return out;
}

// Download a model again from its original link, replacing the file (the caller unloads it first).
export async function updateModel(id) {
  const m = get(id);
  if (!m?.url) throw new Error('This model has no download link to update from');
  return downloadUrl({ url: m.url, source: m.source });
}
