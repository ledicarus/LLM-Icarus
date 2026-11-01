#!/usr/bin/env node
// Sends prompts to a running LLM Icarus app on this computer and prints the reply.
//   node icarus.mjs status
//   node icarus.mjs models
//   node icarus.mjs projects
//   node icarus.mjs ask "prompt" [--model NAME_OR_ID] [--project NAME_OR_ID] [--mode chat|code] [--conversation ID] [--timeout MINUTES]
// Set ICARUS_PORT if the app is not on the default port (3210).

import fs from 'node:fs';
import path from 'node:path';

const BASE = `http://127.0.0.1:${process.env.ICARUS_PORT || 3210}`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function call(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, options);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') fail('Timed out waiting for LLM Icarus. The task may still be running in the app.', 3);
    fail(`Could not reach LLM Icarus at ${BASE}. It is not running (or the app was closed or restarted mid-task). Ask the user to open LLM Icarus, then try again.`, 2);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) fail(`LLM Icarus answered ${res.status}: ${body?.error || text}`);
  return body;
}

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

// Match by exact id, then exact name, then a unique partial name.
function pick(list, wanted, what) {
  const w = String(wanted).toLowerCase();
  const found =
    list.find((x) => x.id === wanted) || list.find((x) => x.name.toLowerCase() === w) || (() => {
      const partial = list.filter((x) => x.name.toLowerCase().includes(w));
      return partial.length === 1 ? partial[0] : null;
    })();
  if (!found) fail(`No ${what} matches "${wanted}". Available: ${list.map((x) => x.name).join(', ')}`);
  return found;
}

if (command === 'status') {
  const e = await call('/api/engine');
  console.log(JSON.stringify({ running: true, engineInstalled: e.installed, loadedModel: e.loaded?.name ?? null, gpu: e.gpu?.name ?? null }, null, 2));
} else if (command === 'models') {
  const list = await call('/api/models');
  for (const m of list.filter((x) => x.kind !== 'image' && x.exists !== false)) console.log(`${m.id}  ${m.name}  (${(m.size / 1e9).toFixed(1)} GB)`);
} else if (command === 'projects') {
  for (const p of await call('/api/projects')) console.log(`${p.id}  ${p.name}  ${p.path}`);
} else if (command === 'ask') {
  const prompt = positional.join(' ').trim();
  if (!prompt) fail('Usage: icarus.mjs ask "your prompt" [--model NAME] [--project NAME] [--mode chat|code] [--conversation ID]');
  const body = { prompt, mode: flags.mode || (flags.project ? 'code' : 'chat') };
  if (flags.model) body.modelId = pick((await call('/api/models')).filter((x) => x.kind !== 'image'), flags.model, 'model').id;
  else if (!flags.conversation) {
    // default to the model that is already loaded, so nothing has to be swapped
    const e = await call('/api/engine');
    if (e.loaded?.modelId) body.modelId = e.loaded.modelId;
  }
  if (flags.project) body.projectId = pick(await call('/api/projects'), flags.project, 'project').id;
  if (body.mode === 'code' && !body.projectId && !flags.conversation) fail('Code mode needs --project (run "projects" to list them).');
  if (flags.conversation) body.conversationId = flags.conversation;
  const minutes = Number(flags.timeout) || 30;
  const out = await call('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(minutes * 60000),
  });
  console.log(out.reply);
  console.error(`(conversation ${out.conversationId})`);
} else if (command === 'vector') {
  const prompt = positional.join(' ').trim();
  const method = flags.method || (flags.image && !prompt ? 'trace' : 'sdxl');
  if (!['sdxl', 'llm', 'trace'].includes(method)) fail('--method must be sdxl, llm or trace');
  if (method !== 'trace' && !prompt) fail('Describe the drawing: icarus.mjs vector "a fox head logo" [--method sdxl|llm] [--image reference.png] [--out folder]');
  if (method === 'trace' && !flags.image) fail('Tracing needs --image <picture>');
  const all = await call('/api/models');
  const body = { method, prompt, wait: true };
  if (flags.image) body.reference = path.resolve(flags.image);
  if (method === 'sdxl') {
    const images = all.filter((x) => x.kind === 'image' && x.exists !== false);
    if (!images.length) fail('No image (SDXL) model is installed. Add one in LLM Icarus first.');
    body.imageModelId = (flags.model ? pick(images, flags.model, 'image model') : images[0]).id;
  } else if (method === 'llm') {
    const chat = all.filter((x) => x.kind !== 'image' && x.exists !== false);
    const loaded = (await call('/api/engine')).loaded?.modelId;
    body.modelId = flags.model ? pick(chat, flags.model, 'model').id : loaded || chat[0]?.id;
    if (flags.edit) body.baseJob = flags.edit;
  }
  if (flags.colors) body.colormode = flags.colors === 'bw' ? 'binary' : flags.colors;
  if (flags.detail) body.detail = Number(flags.detail);
  if (flags['width-mm']) body.widthMm = Number(flags['width-mm']);
  const out = await call('/api/vector', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((Number(flags.timeout) || 30) * 60000),
  });
  const dir = path.resolve(flags.out || '.');
  fs.mkdirSync(dir, { recursive: true });
  for (const [ext, url] of [['svg', out.svg], ['eps', out.eps]]) {
    const file = path.join(dir, `icarus-${out.id}.${ext}`);
    fs.writeFileSync(file, Buffer.from(await (await fetch(BASE + url)).arrayBuffer()));
    console.log(file);
  }
  console.error(`(drawing ${out.id}; pass --edit ${out.id} with --method llm to change it)`);
} else if (command === '3d') {
  const prompt = positional.join(' ').trim();
  const photos = !!(flags.front || flags.side || flags.top);
  if (!photos && !prompt && !flags.code) fail('Describe the part: icarus.mjs 3d "a pen holder" --size 80x60x100  (or give --front/--side/--top pictures, or --code file.scad)');
  const body = { method: photos ? 'photos' : 'scad', prompt, wait: true };
  if (flags.size) {
    const [x, y, z] = String(flags.size).toLowerCase().split('x').map(Number);
    body.sizeMm = { x: x || undefined, y: y || undefined, z: z || undefined };
  }
  if (flags.details) body.sizeText = flags.details;
  if (photos) {
    body.views = {};
    for (const k of ['front', 'side', 'top']) if (flags[k]) body.views[k] = path.resolve(flags[k]);
    if (flags.quality) body.quality = Number(flags.quality);
  } else if (flags.code) {
    body.code = fs.readFileSync(path.resolve(flags.code), 'utf8');
  } else {
    const chat = (await call('/api/models')).filter((x) => x.kind !== 'image' && x.exists !== false);
    const loaded = (await call('/api/engine')).loaded?.modelId;
    body.modelId = flags.model ? pick(chat, flags.model, 'model').id : loaded || chat[0]?.id;
    body.thinking = flags.think !== 'off';
    if (flags.edit) body.baseJob = flags.edit;
  }
  const out = await call('/api/3d', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((Number(flags.timeout) || 30) * 60000),
  });
  const dir = path.resolve(flags.out || '.');
  fs.mkdirSync(dir, { recursive: true });
  for (const [ext, url] of [['stl', out.stl], ['scad', out.scad]]) {
    if (!url) continue;
    const file = path.join(dir, `icarus-${out.id}.${ext}`);
    fs.writeFileSync(file, Buffer.from(await (await fetch(BASE + url)).arrayBuffer()));
    console.log(file);
  }
  console.error(`(solid ${out.id}; size ${JSON.stringify(out.size)} mm, ${out.triangles} triangles)`);
  if (out.warning) console.error('WARNING: ' + out.warning);
} else {
  fail('Commands: status | models | projects | ask "prompt" [...] | vector "description" [...] | 3d "description" [--size WxDxH] [--front f.png --side s.png --top t.png] [--out folder]');
}
