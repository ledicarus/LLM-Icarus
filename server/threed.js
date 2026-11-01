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
import { emit } from './events.js';

// 3D mode: makes STL files, one job at a time. Two ways in:
//   scad    the chat model writes an OpenSCAD script from your description and sizes; OpenSCAD turns it into a solid.
//           You can also paste or edit the script yourself ("code").
//   photos  outlines (silhouettes) from the front, the right side and above are carved into a solid at the sizes you give
//           (server/carve_helper.py)

const HELPER = path.join(ROOT, 'server', 'carve_helper.py');
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
  prompt: j.spec.prompt, refine: !!j.spec.baseJob, manual: !!j.spec.code, modelName: j.modelName,
  sizeAsked: j.spec.sizeMm, sizeText: j.spec.sizeText, views: j.spec.viewNames, quality: j.spec.quality,
  files: j.files, size: j.size, triangles: j.triangles, warning: j.warning, note: j.note,
});

export function status() {
  return { scad: openscad.installed(), carve: carveInstalled() };
}

// Everything 3D mode needs: OpenSCAD, then the Python carving tools. Skips what is already there.
export async function installAll() {
  if (!openscad.installed()) await openscad.install();
  if (!carveInstalled()) await pyenv.installFeature('carve');
  forgetInstalled();
}

export function submit(p) {
  const method = ['scad', 'photos'].includes(p.method) ? p.method : null;
  if (!method) throw new Error('Choose a method: scad or photos');
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
    await (job.spec.method === 'scad' ? makeFromScad(job) : carveFromPictures(job));
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
  const res = await fetch(`${engine.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature: 0.4, max_tokens: s.thinking ? 12000 : 4000, stream: false }),
    signal: job.abort.signal,
  });
  if (!res.ok) throw new Error(`Engine error ${res.status}: ${await res.text()}`);
  const choice = (await res.json()).choices?.[0];
  const text = choice?.message?.content || '';
  // keep the raw answer next to the result: when a design goes wrong this shows what the model actually said
  job.replies = (job.replies || 0) + 1;
  const thinking = choice?.message?.reasoning_content;
  fs.writeFileSync(path.join(job.dir, `reply-${job.replies}.txt`), `${thinking ? `[thinking]\n${thinking}\n\n[answer]\n` : ''}${text}`);
  if (!text.trim() && choice?.finish_reason === 'length') {
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
  const specFile = path.join(job.dir, 'spec.json');
  writeJson(specFile, { outdir: job.dir, views: s.views, size_mm: s.sizeMm, quality: s.quality, background: s.background, smooth: true });
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
      else if (m.type === 'info') Object.assign(job, { size: m.size, triangles: m.triangles, note: m.note || undefined, sizeUsed: m.sizeUsed });
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

const FILES = /^(out\.stl|model\.scad)$/;
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
