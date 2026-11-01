import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirs, readJson, writeJson } from './paths.js';
import { emit } from './events.js';
import * as platform from './platform.js';

const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10';
const BIN_DIR = path.join(dirs.engine, 'bin');
const META = path.join(dirs.engine, 'engine.json');
const PORT = 8081;

let proc = null;
let loaded = null; // { modelId, path, ctx }
let installing = false;

// ---- hardware detection --------------------------------------------------

// GPU detection and release-file choice differ per OS; see platform.js
export const detectGpu = platform.detectGpu;
const recommendedBackend = platform.recommendedBackend;

// ---- install -------------------------------------------------------------

const pickAssets = (release, backend) => platform.pickEngineAssets(release.assets, backend);

async function download(asset, dest) {
  const res = await fetch(asset.browser_download_url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${asset.name}`);
  const total = Number(res.headers.get('content-length')) || asset.size;
  let done = 0;
  let last = 0;
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (now - last > 300) {
      last = now;
      emit('engine-progress', { file: asset.name, done, total });
    }
  });
  await pipeline(src, fs.createWriteStream(dest));
  emit('engine-progress', { file: asset.name, done: total, total });
}

// The newest llama.cpp release that has files for this computer.
async function findRelease(backend) {
  const res = await fetch(RELEASES_API, { headers: { 'User-Agent': 'llm-icarus' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when looking up llama.cpp releases`);
  for (const release of await res.json()) {
    const assets = pickAssets(release, backend);
    if (assets.length) return { release, assets };
  }
  throw new Error(`No recent llama.cpp release has a ${backend} build for ${platform.IS_MAC ? `macOS (${platform.ARCH})` : 'Windows'}`);
}

// Is there a newer llama.cpp than the one installed? (Looks only; installing is install().)
export async function checkUpdate() {
  const meta = readJson(META, null);
  const backend = meta?.backend || recommendedBackend(detectGpu());
  const { release } = await findRelease(backend);
  return { installed: meta?.tag || null, latest: release.tag_name, backend, published: release.published_at, updateAvailable: !!meta && meta.tag !== release.tag_name };
}

export async function install(backend) {
  if (installing) throw new Error('An engine install is already running');
  installing = true;
  try {
    await stop();
    backend = backend || recommendedBackend(detectGpu());
    emit('engine-status', { message: `Looking up latest llama.cpp (${backend})...` });
    const { release, assets } = await findRelease(backend);

    const tmp = path.join(dirs.engine, 'tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const stage = path.join(dirs.engine, 'bin.new');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });

    for (const asset of assets) {
      const zip = path.join(tmp, asset.name);
      await download(asset, zip);
      emit('engine-status', { message: `Extracting ${asset.name}...` });
      execFileSync(platform.tarPath(), ['-xf', zip, '-C', stage], { timeout: 300000 }); // reads .zip and .tar.gz
    }
    fs.rmSync(BIN_DIR, { recursive: true, force: true });
    fs.renameSync(stage, BIN_DIR);
    fs.rmSync(tmp, { recursive: true, force: true });

    const exe = findServerExe();
    if (!exe) throw new Error(`${platform.exeName('llama-server')} not found after extracting`);
    if (!platform.IS_WIN) fs.chmodSync(exe, 0o755); // make sure the server binary is executable
    writeJson(META, { tag: release.tag_name, backend, installedAt: new Date().toISOString() });
    emit('engine-status', { message: `Installed llama.cpp ${release.tag_name} (${backend})`, done: true });
    return status();
  } catch (e) {
    emit('engine-status', { message: `Engine install failed: ${e.message}`, error: true });
    throw e;
  } finally {
    installing = false;
  }
}

function findServerExe() {
  if (!fs.existsSync(BIN_DIR)) return null;
  const stack = [BIN_DIR];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === platform.exeName('llama-server')) return p;
    }
  }
  return null;
}

export function status() {
  const meta = readJson(META, null);
  return {
    installed: !!(meta && findServerExe()),
    installing,
    meta,
    gpu: detectGpu(),
    recommended: recommendedBackend(detectGpu()),
    loaded,
    running: !!proc,
  };
}

// ---- run -----------------------------------------------------------------

export async function stop() {
  if (!proc) return;
  const p = proc;
  proc = null;
  loaded = null;
  await new Promise((resolve) => {
    p.once('exit', resolve);
    p.kill();
    setTimeout(resolve, 5000);
  });
}

async function waitHealthy(timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!proc) throw new Error('llama-server exited while loading the model (see data/engine/llama-server.log)');
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error('Timed out waiting for the model to load');
}

export async function load(model, { ctx = 8192, kvQuant = 'q8_0', reasoning = 'auto' } = {}) {
  if (loaded && loaded.modelId === model.id && loaded.ctx === ctx && loaded.reasoning === reasoning && proc) return loaded;
  const exe = findServerExe();
  if (!exe) throw new Error('Engine is not installed yet');
  await stop();
  emit('engine-status', { message: `Loading ${model.name}...` });
  const log = fs.openSync(path.join(dirs.engine, 'llama-server.log'), 'w');
  // One slot (we serve one chat at a time) and a quantized KV cache keep more of the model in VRAM.
  const args = ['-m', model.path, '--host', '127.0.0.1', '--port', String(PORT), '-c', String(ctx), '--jinja', '-np', '1'];
  if (reasoning !== 'auto') args.push('--reasoning', reasoning);
  if (kvQuant && kvQuant !== 'f16') args.push('-fa', 'on', '-ctk', kvQuant, '-ctv', kvQuant);
  proc = spawn(exe, args, { cwd: path.dirname(exe), stdio: ['ignore', log, log], windowsHide: true });
  const mine = proc;
  mine.once('exit', () => {
    if (proc === mine) {
      proc = null;
      loaded = null;
      emit('engine-status', { message: 'Model unloaded' });
    }
  });
  await waitHealthy();
  loaded = { modelId: model.id, name: model.name, path: model.path, ctx, reasoning };
  emit('engine-status', { message: `${model.name} ready`, done: true });
  return loaded;
}

export const baseUrl = () => `http://127.0.0.1:${PORT}`;

process.on('exit', () => proc && proc.kill());
