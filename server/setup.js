// Command-line setup for LLM Icarus. The installer runs this to download the parts that make
// it work, and the "Download components" shortcut runs it again later.
//
//   node server/setup.js --engine[=cuda|vulkan|cpu|metal] --whisper --image --whisper-model --model <link> ...
//   node server/setup.js --interactive      (asks about each part, y/n)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { dirs } from './paths.js';
import { onEmit } from './events.js';
import * as engine from './engine.js';
import * as models from './models.js';
import * as pyenv from './pyenv.js';
import * as platform from './platform.js';
import * as threed from './threed.js';
import * as openscad from './openscad.js';

const threedDone = () => openscad.installed() && threed.carveInstalled();

export const STARTER_MODEL = 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf';
export const SMALL_MODEL = 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf';
export const SDXL_MODEL = 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors';

// ---- console progress -------------------------------------------------------

const mb = (n) => (n / 1e6).toFixed(0);
const lastPct = new Map();
onEmit((ev) => {
  if (ev.type === 'engine-status') console.log(`  ${ev.message}`);
  else if (ev.type === 'engine-progress' || ev.type === 'download-progress') {
    if (ev.error) return console.log(`  ! ${ev.error}`);
    if (!ev.total) return;
    const pct = Math.floor((ev.done / ev.total) * 100);
    if (pct >= (lastPct.get(ev.file) ?? -10) + 5 || pct === 100) {
      lastPct.set(ev.file, pct);
      console.log(`  ${ev.file}: ${pct}%  (${mb(ev.done)} / ${mb(ev.total)} MB)`);
    }
  }
});

// ---- steps ------------------------------------------------------------------

async function installModel(link, label) {
  const target = await models.resolveSource(link);
  if (target.choices) throw new Error('That link points to several files; give a direct link to one file.');
  const file = decodeURIComponent(new URL(target.url).pathname.split('/').pop());
  const dest = path.join(dirs.models, file);
  if (fs.existsSync(dest)) {
    if (!models.list().some((m) => m.path === dest)) models.addPath(dest);
    console.log(`  ${label || file} is already downloaded.`);
    return;
  }
  await models.downloadUrl(target);
}

const steps = {
  engine: { title: 'Chat & Code engine (llama.cpp)', done: () => engine.status().installed, run: (arg) => engine.install(arg === true ? undefined : arg) },
  whisper: { title: 'Transcribe: Python + Whisper', done: () => pyenv.hasModule('faster_whisper'), run: () => pyenv.installFeature('whisper') },
  image: { title: 'Image generation: PyTorch + diffusers', done: () => pyenv.hasModule('torch') && pyenv.hasModule('diffusers'), run: () => pyenv.installFeature('image') },
  vector: { title: 'Vector: tracing + EPS tools (~40 MB)', done: () => pyenv.hasModule('vtracer') && pyenv.hasModule('svglib'), run: () => pyenv.installFeature('vector') },
  threed: { title: '3D: OpenSCAD + carving tools (~80 MB)', done: () => threedDone(), run: () => threed.installAll() },
  'whisper-model': { title: 'Whisper speech model (1.6-3 GB)', done: () => false, run: () => pyenv.fetchWhisperModel(platform.defaultWhisperModel()) },
  'starter-model': { title: 'Starter chat/code model: Qwen3-8B (~5 GB)', done: () => models.list().some((m) => /Qwen3-8B/i.test(m.name)), run: () => installModel(STARTER_MODEL, 'Qwen3-8B') },
  'starter-small': { title: 'Small starter model: Qwen3-4B (~2.5 GB, for Macs with 8 GB memory)', done: () => models.list().some((m) => /Qwen3-4B/i.test(m.name)), run: () => installModel(SMALL_MODEL, 'Qwen3-4B') },
  'sdxl-model': { title: 'SDXL base image model (~7 GB)', done: () => models.list().some((m) => m.kind === 'image'), run: () => installModel(SDXL_MODEL, 'SDXL base') },
};

async function runSteps(wanted) {
  const failures = [];
  let n = 0;
  for (const [name, arg] of wanted) {
    const s = steps[name];
    n++;
    console.log(`\n[${n}/${wanted.length}] ${s.title}`);
    try {
      await s.run(arg);
      console.log('  done.');
    } catch (e) {
      failures.push(`${s.title}: ${e.message}`);
      console.log(`  FAILED: ${e.message.split('\n')[0]}`);
    }
  }
  console.log('\n----------------------------------------');
  if (failures.length) {
    console.log('Some parts did not install:');
    for (const f of failures) console.log(`  - ${f.split('\n')[0]}`);
    console.log('You can retry from the "Download components" shortcut, or from Settings inside the app.');
  } else console.log('All selected parts are installed.');
  return failures.length;
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const wanted = [];
  console.log('LLM Icarus: download components\n(Enter = skip, y = download)\n');
  for (const [name, s] of Object.entries(steps)) {
    const have = s.done();
    const ans = (await rl.question(`${s.title}${have ? '  [already installed]' : ''}\n  Download${have ? ' again' : ''}? (y/N) `)).trim().toLowerCase();
    if (ans === 'y' || ans === 'yes') wanted.push([name, true]);
  }
  rl.close();
  if (!wanted.length) return console.log('\nNothing selected.');
  return runSteps(wanted);
}

// ---- main -------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help')) {
  console.log('Usage: node server/setup.js [--engine[=cuda|vulkan|cpu]] [--whisper] [--image] [--vector] [--threed] [--whisper-model] [--starter-model] [--starter-small] [--sdxl-model] [--model <link>] | --interactive');
  process.exit(0);
}
let failed = 0;
if (argv.includes('--interactive')) {
  failed = (await interactive()) || 0;
} else {
  const wanted = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--engine')) wanted.push(['engine', a.includes('=') ? a.split('=')[1] : true]);
    else if (a === '--model') {
      const link = argv[++i];
      steps[`model:${link}`] = { title: `Model: ${link}`, run: () => installModel(link) };
      wanted.push([`model:${link}`, true]);
    } else if (a.startsWith('--') && steps[a.slice(2)]) wanted.push([a.slice(2), true]);
    else console.log(`Ignoring unknown option ${a}`);
  }
  // heavy-weight order: Python parts before their models
  const order = ['engine', 'whisper', 'whisper-model', 'image', 'vector', 'threed', 'starter-model', 'starter-small', 'sdxl-model'];
  wanted.sort((x, y) => (order.indexOf(x[0]) + 1 || 99) - (order.indexOf(y[0]) + 1 || 99));
  failed = await runSteps(wanted);
}
process.exit(failed ? 1 : 0);
