import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, DATA, readJson, writeJson } from './paths.js';
import * as engine from './engine.js';
import * as models from './models.js';
import * as pyenv from './pyenv.js';
import * as platform from './platform.js';
import { emit } from './events.js';

// Image mode: one job at a time through server/image_helper.py (diffusers, SDXL checkpoints).
// Runs in its own Python venv (data/image-env) so it can't disturb the Whisper setup.

const HELPER = path.join(ROOT, 'server', 'image_helper.py');
const DEV_PY = path.join(DATA, 'image-env', 'Scripts', 'python.exe'); // the venv made by hand during development
// the private Python from setup (data/python) if it has PyTorch + diffusers, else the dev venv
export const pyPath = () => (pyenv.pythonExe() && pyenv.hasModule('torch') && pyenv.hasModule('diffusers') ? pyenv.pythonExe() : DEV_PY);
const OUT = path.join(DATA, 'images');
fs.mkdirSync(OUT, { recursive: true });

const jobs = new Map();
const queue = [];
let running = null;

const summary = (j) => ({ id: j.id, status: j.status, error: j.error, created: j.created, prompt: j.spec.prompt, negative: j.spec.negative, model: j.modelName, width: j.spec.width, height: j.spec.height, steps: j.spec.steps, guidance: j.spec.guidance, seed: j.spec.seed, count: j.spec.count, strength: j.spec.init_image ? j.spec.strength : undefined, files: j.files, step: j.step, total: j.total, image: j.image });

export const installed = () => fs.existsSync(DEV_PY) || !!(pyenv.pythonExe() && pyenv.hasModule('torch') && pyenv.hasModule('diffusers'));

const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
const snap = (v) => Math.round(v / 64) * 64; // SDXL wants multiples of 64

export function submit(p) {
  if (!installed()) throw new Error('The image engine is not installed (data/image-env is missing)');
  const model = models.get(p.modelId);
  if (!model || model.kind !== 'image') throw new Error('Pick an image model (an SDXL .safetensors checkpoint)');
  if (!fs.existsSync(model.path)) throw new Error(`Model file is missing: ${model.path}`);
  if (!p.prompt?.trim()) throw new Error('Write a prompt first');
  // "image:<jobId>/<n>.png" refers to one of our own results, so a picture can be refined again
  const own = /^image:([\w-]+)\/(\d+\.png)$/.exec(p.initImage || '');
  if (own) p = { ...p, initImage: fileFor(own[1], own[2]) };
  if (p.initImage && !fs.existsSync(p.initImage)) throw new Error('Input image not found');

  const id = crypto.randomUUID().slice(0, 8);
  const outdir = path.join(OUT, id);
  const spec = {
    checkpoint: model.path,
    outdir,
    prompt: p.prompt.trim(),
    negative: (p.negative || '').trim(),
    width: snap(num(p.width, 1024, 512, 1536)),
    height: snap(num(p.height, 1024, 512, 1536)),
    steps: num(p.steps, 25, 5, 80),
    guidance: num(p.guidance, 6, 1, 20),
    seed: Math.trunc(num(p.seed, -1, -1, 2 ** 31 - 1)),
    count: Math.trunc(num(p.count, 1, 1, 8)),
    ...(p.initImage && { init_image: p.initImage, strength: num(p.strength, 0.6, 0.1, 1) }),
  };
  const job = { id, spec, modelName: model.name, status: 'queued', created: new Date().toISOString(), files: [] };
  job.finished = new Promise((r) => (job.resolve = r));
  jobs.set(id, job);
  queue.push(job);
  emit('image-job', summary(job));
  pump();
  return job;
}

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  try {
    job.status = 'loading';
    emit('image-job', summary(job));
    await engine.stop(); // free VRAM for the diffusion model
    await run(job);
    if (job.status !== 'cancelled') job.status = 'done';
  } catch (e) {
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.error = e.message;
    }
  } finally {
    fs.mkdirSync(job.spec.outdir, { recursive: true });
    writeJson(path.join(job.spec.outdir, 'meta.json'), summary(job));
    emit('image-job', summary(job));
    job.resolve(job);
    running = null;
    pump();
  }
}

function run(job) {
  fs.mkdirSync(job.spec.outdir, { recursive: true });
  const specFile = path.join(job.spec.outdir, 'spec.json');
  writeJson(specFile, job.spec);
  const child = spawn(pyPath(), ['-u', HELPER, specFile], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'], ...platform.spawnGroup() });
  job.child = child;
  let stderr = '';
  let helperError = '';
  child.stderr.on('data', (d) => (stderr += d));
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === 'ready') job.status = 'running';
      else if (m.type === 'step') Object.assign(job, { step: m.step, total: m.total, image: m.image });
      else if (m.type === 'image') job.files.push({ file: m.file, seed: m.seed });
      else if (m.type === 'error') helperError = m.message;
      if (m.type !== 'loading') emit('image-job', summary(job));
    }
  });
  return new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`Could not start the image engine: ${e.message}`)));
    child.on('close', (code) => {
      job.child = null;
      if (job.status === 'cancelled') return resolve();
      if (code === 0) return resolve();
      reject(new Error(helperError || stderr.trim().split('\n').slice(-3).join(' ') || `Image engine exited with code ${code}`));
    });
  });
}

export function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(job), 1);
    job.status = 'cancelled';
    emit('image-job', summary(job));
    job.resolve(job);
  } else if (job.child) {
    job.status = 'cancelled';
    platform.killTree(job.child.pid);
  }
  return true;
}

export function list() {
  const saved = fs.readdirSync(OUT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readJson(path.join(OUT, e.name, 'meta.json'), null))
    .filter(Boolean);
  const live = [...jobs.values()].map(summary);
  const ids = new Set(live.map((j) => j.id));
  return [...live, ...saved.filter((j) => !ids.has(j.id))].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

export function fileFor(id, file) {
  if (!/^[\w-]+$/.test(id) || !/^\d+\.png$/.test(file)) return null;
  const p = path.join(OUT, id, file);
  return fs.existsSync(p) ? p : null;
}

export function remove(id) {
  if (!/^[\w-]+$/.test(id) || jobs.get(id)?.child) return false;
  jobs.delete(id);
  fs.rmSync(path.join(OUT, id), { recursive: true, force: true });
  return true;
}

// don't leave a diffusion process holding the GPU if the server exits
process.on('exit', () => {
  for (const j of jobs.values()) j.child && platform.killTree(j.child.pid);
});
