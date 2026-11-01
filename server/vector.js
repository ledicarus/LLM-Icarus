import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, DATA, readJson, writeJson } from './paths.js';
import * as engine from './engine.js';
import * as models from './models.js';
import * as pyenv from './pyenv.js';
import * as platform from './platform.js';
import * as store from './store.js';
import * as image from './image.js';
import { emit } from './events.js';

// Vector mode: makes SVG and EPS files, one job at a time. Three ways in:
//   trace  a picture you give it is traced into curves (vtracer)
//   llm    the chat model writes the SVG from a description (and can edit its own earlier drawing)
//   sdxl   SDXL draws a flat illustration (optionally guided by a picture), which is then traced
// server/vector_helper.py does the tracing, the SVG clean-up and the EPS conversion.

const HELPER = path.join(ROOT, 'server', 'vector_helper.py');
const OUT = path.join(DATA, 'vector');
fs.mkdirSync(OUT, { recursive: true });

const jobs = new Map();
const queue = [];
let running = null;

let installedAt = 0;
let installedCache = false;
// asking Python takes a moment, so remember the answer briefly (and forget it when something gets installed)
export function installed() {
  if (Date.now() - installedAt > 15000) {
    installedCache = !!(pyenv.pythonExe() && pyenv.hasModule('vtracer') && pyenv.hasModule('svglib') && pyenv.hasModule('lxml'));
    installedAt = Date.now();
  }
  return installedCache;
}
export const forgetInstalled = () => (installedAt = 0);

const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
const ASPECTS = { square: [512, 512], wide: [768, 512], tall: [512, 768] };

const summary = (j) => ({
  id: j.id, status: j.status, stage: j.stage, error: j.error, created: j.created,
  method: j.spec.method, prompt: j.spec.prompt, refine: !!j.spec.baseJob, modelName: j.modelName,
  colormode: j.spec.colormode, detail: j.spec.detail, widthMm: j.spec.widthMm, files: j.files,
});

// "vector:<id>/<file>" and "image:<id>/<n>.png" name pictures this app made earlier; anything else is an uploaded path
function resolveRef(ref) {
  if (!ref) return null;
  let m = /^image:([\w-]+)\/(\d+\.png)$/.exec(ref);
  if (m) return image.fileFor(m[1], m[2]);
  m = /^vector:([\w-]+)\/(source\.png|reference\.png)$/.exec(ref);
  if (m) {
    const p = path.join(OUT, m[1], m[2]);
    return fs.existsSync(p) ? p : null;
  }
  return fs.existsSync(ref) && fs.statSync(ref).isFile() ? ref : null;
}

export function submit(p) {
  if (!installed()) throw new Error('The vector tools are not installed yet (Settings > Engines, or the Vector screen, can install them)');
  const method = ['trace', 'llm', 'sdxl'].includes(p.method) ? p.method : null;
  if (!method) throw new Error('Choose a method: trace, llm or sdxl');
  const prompt = (p.prompt || '').trim();
  const ref = resolveRef(p.reference);
  if (p.reference && !ref) throw new Error('The reference picture was not found');

  let model = null;
  let imageModel = null;
  let baseSvg = null;
  if (method === 'trace') {
    if (!ref) throw new Error('Tracing needs a picture: choose a reference image');
  } else if (method === 'llm') {
    if (!prompt) throw new Error('Describe what to draw');
    model = models.get(p.modelId);
    if (!model || model.kind === 'image') throw new Error('Pick a chat model to write the drawing');
    if (!fs.existsSync(model.path)) throw new Error(`Model file is missing: ${model.path}`);
    if (!engine.status().installed) throw new Error('The chat engine is not installed yet');
    if (p.baseJob) {
      if (!/^[\w-]+$/.test(p.baseJob)) throw new Error('Unknown drawing to edit');
      const f = path.join(OUT, p.baseJob, 'out.svg');
      if (!fs.existsSync(f)) throw new Error('The drawing to edit was not found');
      baseSvg = fs.readFileSync(f, 'utf8');
    }
  } else {
    if (!prompt) throw new Error('Describe what to draw');
    if (!image.installed()) throw new Error('SDXL needs the image tools (Image mode) installed');
    imageModel = models.get(p.imageModelId);
    if (!imageModel || imageModel.kind !== 'image') throw new Error('Pick an image (SDXL) model');
  }

  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(OUT, id);
  const spec = {
    method, prompt, dir,
    modelId: model?.id, imageModelId: imageModel?.id,
    ref, baseSvg, baseJob: p.baseJob || undefined,
    aspect: ASPECTS[p.aspect] ? p.aspect : 'square',
    thinking: !!p.thinking,
    strength: num(p.strength, 0.6, 0.2, 0.95),
    colormode: p.colormode === 'binary' ? 'binary' : 'color',
    detail: Math.trunc(num(p.detail, 3, 1, 5)),
    removeBackground: p.removeBackground ?? method !== 'trace',
    widthMm: p.widthMm ? num(p.widthMm, 100, 5, 5000) : null,
  };
  const job = { id, dir, spec, modelName: (model || imageModel)?.name, status: 'queued', created: new Date().toISOString(), files: {} };
  job.finished = new Promise((r) => (job.resolve = r));
  jobs.set(id, job);
  queue.push(job);
  emit('vector-job', summary(job));
  pump();
  return job;
}

const setStage = (job, status, stage) => {
  job.status = status;
  job.stage = stage;
  emit('vector-job', summary(job));
};

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  try {
    fs.mkdirSync(job.dir, { recursive: true });
    job.abort = new AbortController();
    await work(job);
    if (job.status !== 'cancelled') job.status = 'done';
  } catch (e) {
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.error = e.message;
    }
  } finally {
    job.stage = undefined;
    writeJson(path.join(job.dir, 'meta.json'), summary(job));
    emit('vector-job', summary(job));
    job.resolve(job);
    running = null;
    pump();
  }
}

async function work(job) {
  const s = job.spec;
  if (s.ref) {
    // keep a copy next to the results so the drawing can be reused later even if the original moves
    const ext = path.extname(s.ref).toLowerCase() === '.png' ? '.png' : path.extname(s.ref) || '.png';
    fs.copyFileSync(s.ref, path.join(job.dir, `reference${ext}`));
    if (ext === '.png') job.files.reference = 'reference.png';
  }
  if (s.method === 'trace') {
    setStage(job, 'running', 'tracing');
    await runHelper(job, { action: 'trace', input: s.ref });
  } else if (s.method === 'sdxl') {
    await drawWithSdxl(job);
    setStage(job, 'running', 'tracing');
    await runHelper(job, { action: 'trace', input: path.join(job.dir, 'source.png') });
  } else {
    await writeWithModel(job);
  }
}

// ---- SDXL: draw a flat illustration, then trace it ----------------------------

async function drawWithSdxl(job) {
  const s = job.spec;
  setStage(job, 'running', 'drawing');
  const ij = image.submit({
    modelId: s.imageModelId,
    prompt: `${s.prompt}, flat vector illustration, clean bold shapes, solid colors, simple, no gradients, no shadows, plain white background`,
    negative: 'photograph, photo, realistic, gradient, shadow, texture, noise, blurry, text, letters, watermark, signature, frame, border',
    width: 1024, height: 1024, steps: 28, guidance: 7, count: 1,
    ...(s.ref && { initImage: s.ref, strength: s.strength }),
  });
  job.imageJob = ij;
  await ij.finished;
  job.imageJob = null;
  if (job.status === 'cancelled') return;
  if (ij.status !== 'done') throw new Error(ij.error || 'SDXL did not produce a picture');
  const png = image.fileFor(ij.id, '0.png');
  if (!png) throw new Error('SDXL finished but its picture is missing');
  fs.copyFileSync(png, path.join(job.dir, 'source.png'));
  job.files.source = 'source.png';
}

// ---- the chat model writes the SVG ---------------------------------------------

const SYSTEM = (w, h) => `You are an expert vector illustrator who writes SVG by hand. Reply with ONE complete SVG document and nothing else: no explanation, no markdown fences.

How to work:
1. Before the <svg>, write ONE XML comment planning the drawing: what the subject is made of, which basic shape each part uses, and the colors. For example <!-- plan: house = tan rect body, red triangle roof, brown door, two blue windows, sun top right -->
2. Then write the SVG. Draw the parts in order from back to front, so later shapes cover earlier ones.

Rules:
- Start the SVG with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"> and end it with </svg>. The canvas is ${w} by ${h}: use all of it, centered, with a small margin.
- Use only <path>, <rect>, <circle>, <ellipse>, <line>, <polyline>, <polygon> and <g>. Give every shape an explicit fill (and a stroke where needed) as #rrggbb colors. Use 3 to 6 harmonious colors, with a darker and a lighter tone for shading.
- No gradients, filters, masks, patterns, images, text, CSS or scripts: they cannot be saved to EPS.
- Round, organic things (fruit, animals, clouds, flowers) need curves: build the outline as a closed <path> of 4 to 8 cubic Bezier segments (C) that follows the real silhouette point by point, and close it with Z. Do not use a plain circle or ellipse for the whole subject. Add small details on top (highlight, stem, eye, spots), each in a contrasting color.
- Draw the subject you were asked for, not the example below. The example only shows the file format.
- Keep it clean and bold, like a good flat icon, with at most about 60 shapes.

Example of the style, for "a little house":
<!-- plan: sky square, sun, tan house body, red roof, brown door, two windows -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#cfe8ff"/>
<circle cx="415" cy="95" r="44" fill="#ffd54a"/>
<rect x="120" y="230" width="272" height="190" fill="#e9c9a0"/>
<polygon points="96,236 256,108 416,236" fill="#c0392b"/>
<rect x="226" y="320" width="60" height="100" fill="#7b4a2a"/>
<rect x="150" y="268" width="52" height="52" fill="#8ecae6" stroke="#ffffff" stroke-width="6"/>
<rect x="310" y="268" width="52" height="52" fill="#8ecae6" stroke="#ffffff" stroke-width="6"/>
</svg>`;

function extractSvg(text) {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = t.search(/<svg[\s>]/i);
  const close = t.toLowerCase().lastIndexOf('</svg>');
  if (open < 0) throw new Error('The model did not produce an SVG. Try again, or describe the drawing more simply.');
  if (close < open) throw new Error('The model ran out of room before finishing the SVG. Try a simpler description.');
  return t.slice(open, close + 6);
}

async function askModel(job, messages) {
  const s = job.spec;
  const model = models.get(s.modelId);
  const { ctx, kvQuant } = store.settings();
  setStage(job, 'loading', 'loading the model');
  await engine.load(model, { ctx: Math.max(ctx, s.thinking ? 16384 : 8192), kvQuant, reasoning: s.thinking ? 'on' : 'off' });
  if (job.status === 'cancelled') return '';
  setStage(job, 'running', 'drawing');
  const res = await fetch(`${engine.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature: 0.5, max_tokens: s.thinking ? 12000 : 6000, stream: false }),
    signal: job.abort.signal,
  });
  if (!res.ok) throw new Error(`Engine error ${res.status}: ${await res.text()}`);
  const choice = (await res.json()).choices?.[0];
  const text = choice?.message?.content || '';
  if (!text.trim() && choice?.finish_reason === 'length') {
    throw new Error('The model ran out of room while thinking, before it drew anything. Turn off "Think longer", or ask for something simpler.');
  }
  return text;
}

async function writeWithModel(job) {
  const s = job.spec;
  const [w, h] = ASPECTS[s.aspect];
  const messages = [
    { role: 'system', content: SYSTEM(w, h) },
    {
      role: 'user',
      content: s.baseSvg
        ? `Here is the current drawing:\n${s.baseSvg}\n\nChange it as follows: ${s.prompt}\n\nReply with the complete updated SVG only.`
        : `Draw: ${s.prompt}`,
    },
  ];
  let svg = extractSvg(await askModel(job, messages));
  for (let attempt = 0; ; attempt++) {
    if (job.status === 'cancelled') return;
    fs.writeFileSync(path.join(job.dir, 'model.svg'), svg);
    try {
      setStage(job, 'running', 'converting');
      await runHelper(job, { action: 'convert', input: path.join(job.dir, 'model.svg') });
      return;
    } catch (e) {
      if (attempt >= 1) throw new Error(`The model's SVG could not be converted: ${e.message}`);
      // one repair attempt: show the model what went wrong
      messages.push({ role: 'assistant', content: svg }, { role: 'user', content: `That SVG failed to convert: ${e.message}\nFix the problem and reply with the complete corrected SVG only.` });
      svg = extractSvg(await askModel(job, messages));
    }
  }
}

// ---- the Python helper ---------------------------------------------------------

function runHelper(job, extra) {
  const s = job.spec;
  const spec = {
    outdir: job.dir, colormode: s.colormode, detail: s.detail, remove_background: s.removeBackground, width_mm: s.widthMm,
    ...extra,
  };
  const specFile = path.join(job.dir, `spec-${extra.action}.json`);
  writeJson(specFile, spec);
  const child = spawn(pyenv.pythonExe(), ['-u', HELPER, specFile], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'], ...platform.spawnGroup() });
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
      if (m.type === 'stage') setStage(job, 'running', m.name);
      else if (m.type === 'file') job.files[m.kind] = m.file;
      else if (m.type === 'error') helperError = m.message;
    }
  });
  return new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`Could not start the vector tools: ${e.message}`)));
    child.on('close', (code) => {
      job.child = null;
      if (job.status === 'cancelled' || code === 0) return resolve();
      reject(new Error((helperError || stderr.trim().split('\n').slice(-2).join(' ') || `The vector tools exited with code ${code}`).replace(/^\w*Error: /, '')));
    });
  });
}

export function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(job), 1);
    job.status = 'cancelled';
    emit('vector-job', summary(job));
    job.resolve(job);
  } else if (['loading', 'running'].includes(job.status)) {
    job.status = 'cancelled';
    job.abort?.abort();
    if (job.child) platform.killTree(job.child.pid);
    if (job.imageJob) image.cancel(job.imageJob.id);
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

const FILES = /^(out\.svg|out\.eps|source\.png|reference\.png)$/;
export function fileFor(id, file) {
  if (!/^[\w-]+$/.test(id) || !FILES.test(file)) return null;
  const p = path.join(OUT, id, file);
  return fs.existsSync(p) ? p : null;
}

export function remove(id) {
  if (!/^[\w-]+$/.test(id) || ['loading', 'running'].includes(jobs.get(id)?.status)) return false;
  jobs.delete(id);
  fs.rmSync(path.join(OUT, id), { recursive: true, force: true });
  return true;
}

process.on('exit', () => {
  for (const j of jobs.values()) j.child && platform.killTree(j.child.pid);
});
