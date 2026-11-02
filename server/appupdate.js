import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, readJson } from './paths.js';
import { emit } from './events.js';

// Updating LLM Icarus itself (Windows installed copy): look up the newest GitHub release, download its installer with
// progress, and hand it to the app window (installer/IcarusApp.cs), which closes the app, runs the installer quietly and
// starts the new version. Everything else (other systems, a source checkout, a browser tab) only gets told that a new
// version exists, with a link.

const REPO = 'ledicarus/LLM-Icarus';
// CLUI_UPDATE_API lets a test point the check at a fake release; the real thing only ever talks to github.com
const API = process.env.CLUI_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const OFFICIAL = !process.env.CLUI_UPDATE_API;
const DIR = path.join(DATA, 'updates');
const ASSET = /^LLM-Icarus-Setup-[\w.\-]+\.exe$/;

// installers from earlier updates are not needed once the app has started (one may still be locked while it finishes: try again next time)
try {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { force: true });
} catch {
  /* no updates folder yet, or a file is still in use */
}

export const version = () => String(readJson(path.join(ROOT, 'package.json'), {}).version || '0.0.0');

// only an installed Windows copy can replace itself (a source checkout or the Mac package cannot)
export const canSelfUpdate = () => process.platform === 'win32' && fs.existsSync(path.join(ROOT, 'unins000.exe'));

// "2.0.11-1-26" -> [2, 0]: the release number and the build count since it. The date part is ignored.
function parts(v) {
  const m = /^v?(\d+)\.(\d+)\./.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export function isNewer(latest, current) {
  const a = parts(latest);
  const b = parts(current);
  if (!a || !b) return false;
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

let cached = null;
let cachedAt = 0;

export async function check({ force } = {}) {
  if (!force && cached && Date.now() - cachedAt < 10 * 60000) return cached;
  const current = version();
  let rel;
  try {
    const res = await fetch(API, { headers: { 'User-Agent': 'llm-icarus', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return (cached = { current, latest: null, newer: false, canSelfUpdate: canSelfUpdate() });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    rel = await res.json();
  } catch (e) {
    return { current, error: e.message };
  }
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const asset = (rel.assets || []).find((a) => ASSET.test(a.name) && a.browser_download_url);
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest || '');
  cachedAt = Date.now();
  cached = {
    current,
    latest,
    newer: isNewer(latest, current),
    title: rel.name || `LLM Icarus ${latest}`,
    notes: String(rel.body || '').replace(/\r/g, '').trim().slice(0, 1800),
    page: rel.html_url,
    asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url, sha256: sha ? sha[1].toLowerCase() : undefined } : undefined,
    canSelfUpdate: canSelfUpdate(),
  };
  return cached;
}

// ---- downloading ---------------------------------------------------------------

// idle | downloading | ready | error
let state = { phase: 'idle' };
let abort = null;

const set = (patch) => {
  state = { ...state, ...patch };
  emit('app-update', state);
};

export const status = () => state;

// the installer the app window may run: only a finished download sitting in our own updates folder
export function readyInstaller() {
  if (state.phase !== 'ready' || !state.path) return null;
  const p = path.resolve(state.path);
  return path.dirname(p) === path.resolve(DIR) && ASSET.test(path.basename(p)) && fs.existsSync(p) ? p : null;
}

export async function download() {
  if (state.phase === 'downloading') return state;
  if (!canSelfUpdate()) throw new Error('This copy of LLM Icarus cannot update itself. Download the new version from its release page instead.');
  const info = await check({ force: true });
  if (info.error) throw new Error(`Could not look up the new version: ${info.error}`);
  if (!info.newer) throw new Error('You already have the newest version.');
  const a = info.asset;
  if (!a) throw new Error('The new release has no Windows installer attached.');
  if (OFFICIAL && !a.url.startsWith(`https://github.com/${REPO}/releases/download/`)) throw new Error('The installer is not from the LLM Icarus release page, so it was not downloaded.');

  fs.mkdirSync(DIR, { recursive: true });
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { force: true }); // older downloads are not needed any more
  const file = path.join(DIR, a.name);
  const part = file + '.part';
  abort = new AbortController();
  set({ phase: 'downloading', version: info.latest, received: 0, total: a.size || 0, error: undefined, path: undefined });
  run(a, file, part, abort).catch(() => {});
  return state;
}

async function run(a, file, part, ctl) {
  let out;
  try {
    const res = await fetch(a.url, { headers: { 'User-Agent': 'llm-icarus' }, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) throw new Error(`The download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || a.size || 0;
    const hash = crypto.createHash('sha256');
    out = fs.createWriteStream(part);
    let received = 0;
    let last = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      received += chunk.length;
      if (Date.now() - last > 200) {
        last = Date.now();
        set({ received, total });
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (a.size && received !== a.size) throw new Error('The download is incomplete. Check your connection and try again.');
    if (a.sha256 && hash.digest('hex') !== a.sha256) throw new Error('The downloaded file does not match the checksum published on GitHub, so it was thrown away.');
    fs.renameSync(part, file);
    set({ phase: 'ready', received, total, path: file });
  } catch (e) {
    if (out) await new Promise((r) => { out.once('close', r); out.destroy(); setTimeout(r, 500); }); // release the file before deleting it
    fs.rmSync(part, { force: true });
    if (ctl.signal.aborted) set({ phase: 'idle', received: 0, total: 0 });
    else set({ phase: 'error', error: e.message });
  } finally {
    abort = null;
  }
}

export function cancel() {
  abort?.abort();
  if (state.phase === 'ready') set({ phase: 'idle', path: undefined });
  return state;
}
