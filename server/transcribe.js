import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, DATA, readJson, writeJson } from './paths.js';
import * as engine from './engine.js';
import * as store from './store.js';
import * as pyenv from './pyenv.js';
import * as platform from './platform.js';
import { emit } from './events.js';

// Transcribe mode: one job at a time through server/whisper_helper.py (faster-whisper).
// The language model is unloaded first so Whisper has the GPU to itself.

const HELPER = path.join(ROOT, 'server', 'whisper_helper.py');
const OUT = path.join(DATA, 'transcripts');
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const jobs = new Map(); // in-memory state for this run of the server
const queue = [];
let running = null;

const summary = (j) => ({ id: j.id, name: j.name, source: j.source, status: j.status, percent: j.percent, language: j.language, duration: j.duration, error: j.error, created: j.created, device: j.device, segments: j.segments, base: j.base });

export function uploadPath(name) {
  const safe = path.basename(name || 'upload').replace(/[^\w.\- ]/g, '_');
  return path.join(UPLOADS, `${crypto.randomUUID().slice(0, 8)}-${safe}`);
}

export function submit({ src, language = 'auto', model = platform.defaultWhisperModel() }) {
  src = path.resolve(src);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error(`File not found: ${src}`);
  if (!/^[\w.-]+$/.test(model)) throw new Error('Invalid model name');
  if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new Error('Invalid language code');
  const id = crypto.randomUUID().slice(0, 8);
  const job = { id, name: path.basename(src), source: src, model, language, requestedLanguage: language, status: 'queued', percent: 0, created: new Date().toISOString(), text: [] };
  job.finished = new Promise((resolve) => (job.resolve = resolve));
  jobs.set(id, job);
  queue.push(job);
  emit('transcribe-job', summary(job));
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
    emit('transcribe-job', summary(job));
    await engine.stop();
    await run(job);
    job.status = 'done';
    job.percent = 100;
  } catch (e) {
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.error = e.message;
    }
  } finally {
    writeJson(path.join(OUT, job.id, 'meta.json'), summary(job));
    emit('transcribe-job', summary(job));
    job.resolve(job);
    running = null;
    pump();
  }
}

// Which Python runs Whisper: a path set in settings, else our private one (installed by setup) if it has Whisper,
// else whatever `python` is on PATH.
export function pickPython() {
  const set = store.settings().pythonPath;
  if (set) return { python: set, source: 'settings' };
  if (pyenv.pythonExe() && pyenv.hasModule('faster_whisper')) return { python: pyenv.pythonExe(), source: 'private' };
  return { python: platform.IS_WIN ? 'python' : 'python3', source: 'system' };
}

// For the Settings > Engines tab: can Whisper run here?
export function status() {
  const { python, source } = pickPython();
  try {
    execFileSync(python, ['-c', 'import faster_whisper'], { stdio: 'ignore', timeout: 30000 });
    return { installed: true, source };
  } catch {
    return { installed: false, source };
  }
}

function run(job) {
  const outdir = path.join(OUT, job.id);
  fs.mkdirSync(outdir, { recursive: true });
  const py = pickPython().python;
  const args = ['-u', HELPER, job.source, outdir, '--model', job.model, '--language', job.requestedLanguage];
  const child = spawn(py, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'], ...platform.spawnGroup() });
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
      if (m.type === 'loading') job.status = 'loading';
      else if (m.type === 'info') {
        Object.assign(job, { language: m.language, duration: m.duration, device: m.device, status: 'running' });
        emit('transcribe-job', summary(job));
      } else if (m.type === 'segment') {
        job.percent = m.percent;
        job.text.push(m.text);
        emit('transcribe-segment', { id: job.id, start: m.start, end: m.end, text: m.text, percent: m.percent });
      } else if (m.type === 'done') Object.assign(job, { segments: m.segments, base: m.base });
      else if (m.type === 'error') helperError = m.message;
    }
  });

  return new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`Could not start Python (${py}): ${e.message}. Set "pythonPath" in data/settings.json.`)));
    child.on('close', (code) => {
      job.child = null;
      if (job.status === 'cancelled') return reject(new Error('Cancelled'));
      if (code === 0) return resolve();
      reject(new Error(helperError || stderr.trim().split('\n').slice(-3).join(' ') || `Whisper exited with code ${code}`));
    });
  });
}

export function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(job), 1);
    job.status = 'cancelled';
    emit('transcribe-job', summary(job));
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

export function get(id) {
  return jobs.get(id);
}

// Returns { file, type } for a finished transcript's srt/txt, or null.
export function fileFor(id, ext) {
  if (!/^[\w-]+$/.test(id) || !['srt', 'txt'].includes(ext)) return null;
  const dir = path.join(OUT, id);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta?.base) return null;
  const file = path.join(dir, `${meta.base}.${ext}`);
  return fs.existsSync(file) ? { file, name: `${meta.base}.${ext}`, type: ext === 'srt' ? 'application/x-subrip' : 'text/plain; charset=utf-8' } : null;
}

export function remove(id) {
  if (!/^[\w-]+$/.test(id) || jobs.get(id)?.child) return false;
  jobs.delete(id);
  fs.rmSync(path.join(OUT, id), { recursive: true, force: true });
  return true;
}

// don't leave a Whisper process running if the server exits
process.on('exit', () => {
  for (const j of jobs.values()) j.child && platform.killTree(j.child.pid);
});
