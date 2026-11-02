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
import * as openscad from './openscad.js';
import * as image from './image.js';
import * as llm from './llm.js';
import { emit } from './events.js';

// 3D mode: makes STL files, one job at a time. Three ways in:
//   scad    the chat model writes an OpenSCAD script from your description and sizes; OpenSCAD turns it into a solid.
//           You can also paste or edit the script yourself ("code").
//   photos  outlines (silhouettes) from the front, the right side and above are carved into a solid at the sizes you give
//           (server/carve_helper.py)
//   sweep   for long rounded things (a banana, a carrot, a bone): the image model draws one side picture of the named
//           object, its outline gives the centre line and thickness, and a round solid is swept along it at a real
//           size (given, or asked of the chat model). server/sweep_helper.py

const HELPER = path.join(ROOT, 'server', 'carve_helper.py');
const SWEEP_HELPER = path.join(ROOT, 'server', 'sweep_helper.py');
const OUT = path.join(DATA, '3d');
fs.mkdirSync(OUT, { recursive: true });

const jobs = new Map();
const queue = [];
let running = null;

let carveAt = 0;
let carveCache = false;
// asking Python takes a moment, so remember the answer briefly (and forget it when something gets installed)
export function carveInstalled() {
  if (Date.now() - carveAt > 15000) {
    carveCache = !!(pyenv.pythonExe() && ['numpy', 'mcubes', 'PIL'].every((m) => pyenv.hasModule(m)));
    carveAt = Date.now();
  }
  return carveCache;
}
export const forgetInstalled = () => (carveAt = 0);

const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
const mm = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0 ? undefined : Math.min(2000, Number(v)));

const summary = (j) => ({
  id: j.id, status: j.status, stage: j.stage, error: j.error, created: j.created, method: j.spec.method,
  prompt: j.spec.prompt, object: j.spec.object, lengthUsed: j.spec.lengthUsed, refine: !!j.spec.baseJob, manual: !!j.spec.code, modelName: j.modelName,
  sizeAsked: j.spec.sizeMm, sizeText: j.spec.sizeText, views: j.spec.viewNames, quality: j.spec.quality,
  files: j.files, size: j.size, triangles: j.triangles, warning: j.warning, note: j.note,
});

export function status() {
  return { scad: openscad.installed(), carve: carveInstalled(), sweep: image.installed() };
}

// "make a 3D banana, 190 mm long" -> "banana": the name of the object for the picture prompt, without sizes and filler
const objectName = (t) => String(t || '')
  .replace(/\b\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)*(?:mm|millimet\w+|cm|centimet\w+|inch(?:es)?|in)\b(?:\s*(?:long|wide|tall|high|deep|across|in length))?/gi, '')
  .replace(/^\s*(?:please\s+)?(?:make|create|build|model|generate|design)\s+(?:me\s+)?/i, '')
  .replace(/\b(?:an?\s+)?(?:3d|stl)\b(?:\s+(?:model|file|print))?(?:\s+of)?/gi, '')
  .replace(/^\s*(?:an?|the)\s+/i, '')
  .replace(/[\s,;]+$/, '')
  .replace(/\s{2,}/g, ' ')
  .trim()
  .slice(0, 120);

// Everything 3D mode needs: OpenSCAD, then the Python carving tools. Skips what is already there.
export async function installAll() {
  if (!openscad.installed()) await openscad.install();
  if (!carveInstalled()) await pyenv.installFeature('carve');
  forgetInstalled();
}

export function submit(p) {
  const method = ['scad', 'photos', 'sweep'].includes(p.method) ? p.method : null;
  if (!method) throw new Error('Choose a method: scad, photos or sweep');
  const prompt = (p.prompt || '').trim();
  const sizeMm = { x: mm(p.sizeMm?.x), y: mm(p.sizeMm?.y), z: mm(p.sizeMm?.z) };
  const spec = {
    method, prompt, sizeMm,
    sizeText: (p.sizeText || '').trim().slice(0, 600),
    thinking: !!p.thinking,
    quality: Math.trunc(num(p.quality, 2, 1, 3)),
    background: ['auto', 'dark', 'light'].includes(p.background) ? p.background : 'auto',
  };
  let model = null;

  if (method === 'scad') {
    if (!openscad.installed()) throw new Error('OpenSCAD is not installed yet (the 3D screen or Settings > Engines can install it)');
    if (p.code && String(p.code).trim()) {
      spec.code = String(p.code);
    } else {
      if (!prompt) throw new Error('Describe the part you want');
      model = models.get(p.modelId);
      if (!model || model.kind === 'image') throw new Error('Pick a chat model to write the design');
      if (!fs.existsSync(model.path)) throw new Error(`Model file is missing: ${model.path}`);
      if (!engine.status().installed) throw new Error('The chat engine is not installed yet');
      spec.modelId = model.id;
      if (p.baseJob) {
        if (!/^[\w-]+$/.test(p.baseJob)) throw new Error('Unknown design to edit');
        const f = path.join(OUT, p.baseJob, 'model.scad');
        if (!fs.existsSync(f)) throw new Error('The design to edit was not found');
        spec.baseCode = fs.readFileSync(f, 'utf8');
        spec.baseJob = p.baseJob;
      }
    }
  } else if (method === 'sweep') {
    if (!image.installed()) throw new Error('The image tools are not installed yet (the Image screen can install them)');
    const picModel = p.imageModelId ? models.get(p.imageModelId) : models.list().find((m) => m.kind === 'image' && m.exists !== false);
    if (!picModel || picModel.kind !== 'image') throw new Error('There is no image (SDXL) model yet. Add one in Settings > Models');
    spec.imageModelId = picModel.id;
    spec.object = objectName(prompt);
    if (!spec.object) throw new Error('Name the object, for example "a banana"');
    const longest = Math.max(sizeMm.x || 0, sizeMm.y || 0, sizeMm.z || 0);
    if (longest) {
      spec.lengthMm = longest;
    } else {
      // no size given: the chat model is asked how big one usually is
      model = models.get(p.modelId);
      if (!model || model.kind === 'image') throw new Error('Give its size (for example "190 mm long") or pick a chat model, which can tell how big one usually is');
      if (!fs.existsSync(model.path)) throw new Error(`Model file is missing: ${model.path}`);
      if (!engine.status().installed) throw new Error('The chat engine is not installed yet');
      spec.modelId = model.id;
    }
  } else {
    if (!carveInstalled()) throw new Error('The 3D carving tools are not installed yet (the 3D screen or Settings > Engines can install them)');
    spec.views = {};
    spec.viewNames = [];
    for (const k of ['front', 'side', 'top']) {
      const f = p.views?.[k];
      if (!f) continue;
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error(`The ${k} picture was not found`);
      spec.views[k] = f;
      spec.viewNames.push(k);
    }
    if (!spec.viewNames.length) throw new Error('Add at least one picture: front, side or top');
    if (!sizeMm.x && !sizeMm.y && !sizeMm.z) spec.note = 'No size given';
  }

  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(OUT, id);
  const job = { id, dir, spec, modelName: model?.name, status: 'queued', created: new Date().toISOString(), files: {} };
  job.finished = new Promise((r) => (job.resolve = r));
  jobs.set(id, job);
  queue.push(job);
  emit('threed-job', summary(job));
  pump();
  return job;
}

const setStage = (job, status, stage) => {
  job.status = status;
  job.stage = stage;
  emit('threed-job', summary(job));
};

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  try {
    fs.mkdirSync(job.dir, { recursive: true });
    job.abort = new AbortController();
    await ({ scad: makeFromScad, photos: carveFromPictures, sweep: makeBySweep }[job.spec.method])(job);
    if (job.status !== 'cancelled') job.status = 'done';
  } catch (e) {
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.error = e.message;
    }
  } finally {
    job.stage = undefined;
    writeJson(path.join(job.dir, 'meta.json'), summary(job));
    emit('threed-job', summary(job));
    job.resolve(job);
    running = null;
    pump();
  }
}

// ---- OpenSCAD: the model writes the script ------------------------------------

const SYSTEM = `You are an expert CAD designer who writes OpenSCAD. Reply with ONE complete OpenSCAD script and nothing else: no explanation and no markdown fences.

Rules:
- Units are millimetres. Put every size in named variables at the top (for example body_w = 60;) so the design is easy to adjust. If sizes are given, use exactly those numbers.
- Build the part from cube, cylinder, sphere, linear_extrude of 2D shapes, and union / difference / intersection, with translate / rotate / scale / mirror. For round shapes set $fn = 64.
- Use only built-in OpenSCAD: no use or include, no imports, no text(), no external files or libraries.
- Make ONE solid part: every piece must overlap or touch another. Put it on the build plate: lowest point at z = 0, and centred on x = 0, y = 0 where that makes sense.
- To hollow something out (a box, cup, tray, tube), subtract a smaller inner shape from the outer shape: difference() { outer shape; translate(...) inner shape; }. The first child of difference() is what remains, everything after it is cut away. Leave a floor and walls of the thickness asked for, and make the inner shape extend past the open top.
- A hole or cut-out must be longer than the material it cuts (start below the surface and end above it) so difference() works cleanly.
- Before you answer, check each difference(): the shape being cut must overlap the solid, and something must be left over.
- Keep it simple and correct: a clean printable part is better than a complicated one that breaks.
- Start with one // comment line saying what the part is made of.

Example of the style, for "a small L bracket":
// L bracket: a base plate and an upright plate, with two screw holes in the base
base_w = 50; base_d = 30; t = 4; up_h = 35; hole_d = 5;
difference() {
  union() {
    translate([-base_w/2, -base_d/2, 0]) cube([base_w, base_d, t]);
    translate([-base_w/2, -base_d/2, 0]) cube([base_w, t, up_h]);
  }
  for (x = [-15, 15]) translate([x, 5, -1]) cylinder(d = hole_d, h = t + 2, $fn = 48);
}`;

function extractCode(text) {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:openscad|scad|c\+\+|cpp)?\s*\n([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  if (!t) throw new Error('The model did not write any OpenSCAD. Try again, or describe the part more simply.');
  return t;
}

async function askModel(job, messages) {
  const s = job.spec;
  const model = models.get(s.modelId);
  const { ctx, kvQuant } = store.settings();
  setStage(job, 'loading', 'loading the model');
  // thinking uses a lot of room: give the model a bigger window for it (the default 8192 tokens runs out)
  await engine.load(model, { ctx: Math.max(ctx, s.thinking ? 16384 : 8192), kvQuant, reasoning: s.thinking ? 'on' : 'off' });
  if (job.status === 'cancelled') return '';
  setStage(job, 'running', 'designing');
  const { text, thinking, finish } = await llm.complete(messages, { temperature: 0.4, maxTokens: s.thinking ? 12000 : 4000, signal: job.abort.signal });
  // keep the raw answer next to the result: when a design goes wrong this shows what the model actually said
  job.replies = (job.replies || 0) + 1;
  fs.writeFileSync(path.join(job.dir, `reply-${job.replies}.txt`), `${thinking ? `[thinking]\n${thinking}\n\n[answer]\n` : ''}${text}`);
  if (!text.trim() && finish === 'length') {
    throw new Error('The model ran out of room while thinking, before it wrote the design. Turn off "Think longer", or ask for something simpler.');
  }
  return text;
}

const sizeSentence = (s) => {
  const { x, y, z } = s.sizeMm;
  const parts = [];
  if (x) parts.push(`${x} mm wide (x)`);
  if (y) parts.push(`${y} mm deep (y)`);
  if (z) parts.push(`${z} mm tall (z)`);
  return [parts.length ? `Overall size: ${parts.join(', ')}.` : '', s.sizeText ? `Known measurements (mm): ${s.sizeText}` : ''].filter(Boolean).join('\n');
};

async function makeFromScad(job) {
  const s = job.spec;
  const scadFile = path.join(job.dir, 'model.scad');
  const stlFile = path.join(job.dir, 'out.stl');
  let code;
  let messages;
  if (s.code) {
    code = s.code;
  } else {
    const sizes = sizeSentence(s);
    messages = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: s.baseCode
          ? `Here is the current OpenSCAD script:\n${s.baseCode}\n\nChange it as follows: ${s.prompt}${sizes ? '\n' + sizes : ''}\n\nReply with the complete updated script only.`
          : `Design this part: ${s.prompt}${sizes ? '\n' + sizes : ''}`,
      },
    ];
    code = extractCode(await askModel(job, messages));
  }
  for (let attempt = 0; ; attempt++) {
    if (job.status === 'cancelled') return;
    fs.writeFileSync(scadFile, code);
    job.files.scad = 'model.scad';
    try {
      setStage(job, 'running', 'building the solid');
      await openscad.render(scadFile, stlFile, { onChild: (c) => (job.child = c) });
      break;
    } catch (e) {
      job.child = null;
      if (job.status === 'cancelled') return;
      if (s.code || attempt >= 1) throw new Error(`OpenSCAD could not build this script:\n${e.message}`);
      // one repair attempt: show the model what OpenSCAD said
      messages.push({ role: 'assistant', content: code }, { role: 'user', content: `OpenSCAD reported:\n${e.message}\nFix the script and reply with the complete corrected script only.` });
      code = extractCode(await askModel(job, messages));
    }
  }
  job.child = null;
  job.files.stl = 'out.stl';
  const info = openscad.stlInfo(stlFile);
  job.size = info.size;
  job.triangles = info.triangles;
  // tell the user when the model did not respect the sizes they gave
  if (info.size) {
    const off = [];
    [['x', 0, 'width'], ['y', 1, 'depth'], ['z', 2, 'height']].forEach(([k, i, name]) => {
      const want = s.sizeMm[k];
      if (want && Math.abs(info.size[i] - want) / want > 0.06) off.push(`${name} is ${info.size[i]} mm, not ${want} mm`);
    });
    if (off.length) job.warning = `The design does not match the size you asked for: ${off.join('; ')}. Edit the script or ask the model to fix it.`;
  }
}

// ---- carving a solid from outlines ---------------------------------------------

async function carveFromPictures(job) {
  const s = job.spec;
  setStage(job, 'running', 'carving');
  await runHelper(job, HELPER, pyenv.pythonExe(), { views: s.views, size_mm: s.sizeMm, quality: s.quality, background: s.background, smooth: true });
}

// ---- sweeping a solid along the outline of a generated picture ------------------

const PICTURE_NEGATIVE = 'many, several, pile, bunch, group, pieces, slices, cut open, text, table, shelf, hand, shadow, reflection, pattern, background objects';
const pictureWords = (object) => `one single ${object}, seen from the side, isolated on a plain pure white background, product photo, soft even lighting, the entire object in frame, centered, nothing else in the picture`;

async function makeBySweep(job) {
  const s = job.spec;
  let lengthMm = s.lengthMm;
  if (!lengthMm) {
    const model = models.get(s.modelId);
    const { ctx, kvQuant } = store.settings();
    setStage(job, 'loading', 'loading the model');
    await engine.load(model, { ctx: Math.max(ctx, 8192), kvQuant, reasoning: 'off' });
    if (job.status === 'cancelled') return;
    setStage(job, 'running', 'asking the model how big it is');
    const { text } = await llm.complete([
      { role: 'system', content: 'You answer with one number only, no words.' },
      { role: 'user', content: `What is the typical length in millimetres, measured along its body from one end to the other, of one ${s.object}? Reply with just the number.` },
    ], { maxTokens: 200, temperature: 0, signal: job.abort.signal });
    const n = Number(/\d+(?:[.,]\d+)?/.exec(text)?.[0].replace(',', '.'));
    if (!(n >= 5 && n <= 3000)) throw new Error(`The model could not say how big a ${s.object} is. Give the size yourself, for example "190 mm long".`);
    lengthMm = n;
    job.note = `Size: the model's typical ${s.object} is ${n} mm long`;
  }
  s.lengthUsed = lengthMm;

  // the image model draws a few candidates; the helper picks the cleanest single object
  const count = s.quality === 1 ? 2 : s.quality === 2 ? 4 : 6;
  const pj = image.submit({ modelId: s.imageModelId, prompt: pictureWords(s.object), negative: PICTURE_NEGATIVE, width: 1024, height: 768, count });
  job.imageJob = pj;
  const tick = setInterval(() => {
    if (job.status === 'cancelled') return;
    const where = pj.status === 'queued' ? 'waiting for the image model' : pj.image != null ? `drawing the picture (${pj.image + 1} of ${count})` : 'loading the image model';
    if (job.stage !== where) setStage(job, 'running', where);
  }, 1500);
  setStage(job, 'running', 'loading the image model');
  try {
    await pj.finished;
  } finally {
    clearInterval(tick);
    job.imageJob = null;
  }
  if (job.status === 'cancelled') return;
  if (pj.status !== 'done') throw new Error(pj.error || 'The picture could not be drawn');
  const pictures = pj.files.map((f) => image.fileFor(pj.id, f.file)).filter(Boolean);
  try {
    setStage(job, 'running', 'measuring the outline');
    await runHelper(job, SWEEP_HELPER, image.pyPath(), { images: pictures, length_mm: lengthMm, object: s.object });
  } catch (e) {
    // keep the pictures that were rejected, so it is possible to see what the image model drew
    pictures.forEach((f, i) => fs.copyFileSync(f, path.join(job.dir, `rejected-${i + 1}.png`)));
    throw e;
  } finally {
    image.remove(pj.id); // the chosen picture is kept in this job; the rest should not clutter the Image list
  }
}

// Runs a Python helper that reads a spec file and reports progress as JSON lines on stdout.
async function runHelper(job, helper, python, spec) {
  const specFile = path.join(job.dir, 'spec.json');
  writeJson(specFile, { outdir: job.dir, ...spec });
  const child = spawn(python, ['-u', helper, specFile], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'], ...platform.spawnGroup() });
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
      else if (m.type === 'info') Object.assign(job, { size: m.size, triangles: m.triangles, note: [job.note, m.note].filter(Boolean).join('. ') || undefined, sizeUsed: m.sizeUsed });
      else if (m.type === 'file') job.files[m.kind] = m.file;
      else if (m.type === 'error') helperError = m.message;
    }
  });
  await new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`Could not start the carving tools: ${e.message}`)));
    child.on('close', (code) => {
      job.child = null;
      if (job.status === 'cancelled' || code === 0) return resolve();
      reject(new Error(helperError || stderr.trim().split('\n').slice(-2).join(' ') || `The carving tools exited with code ${code}`));
    });
  });
}

export function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(job), 1);
    job.status = 'cancelled';
    emit('threed-job', summary(job));
    job.resolve(job);
  } else if (['loading', 'running'].includes(job.status)) {
    job.status = 'cancelled';
    job.abort?.abort();
    if (job.imageJob) image.cancel(job.imageJob.id);
    if (job.child) platform.killTree(job.child.pid);
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

const FILES = /^(out\.stl|model\.scad|picture\.png)$/;
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
