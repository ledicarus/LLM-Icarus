// Quick environment check:  node server/selftest.js
// Prints what LLM Icarus detects on this computer and which downloads it would pick, without
// installing anything. Useful for testing on a new machine (for example a Mac).
import fs from 'node:fs';
import os from 'node:os';
import * as platform from './platform.js';
import { pickMacPythonAsset, PBS_RELEASE_API } from './pyenv.js';

const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`);
const get = async (url) => (await fetch(url, { headers: { 'User-Agent': 'llm-icarus' } })).json();

console.log('LLM Icarus self-check\n');
line('Platform / CPU', `${process.platform} / ${process.arch}`);
line('Node.js', process.version);
line('OS', `${os.type()} ${os.release()}`);
line('Memory', `${Math.round(os.totalmem() / 2 ** 30)} GB`);
const gpu = platform.detectGpu();
line('GPU', `${gpu.vendor}${gpu.name ? ` (${gpu.name}${gpu.memory ? `, ${gpu.memory}` : ''})` : ''}`);
line('Engine build wanted', platform.recommendedBackend(gpu));
line('Whisper model default', platform.defaultWhisperModel());
line('Claude CLI (Code mode)', `${platform.claudeCliPath()}  ${fs.existsSync(platform.claudeCliPath()) ? '[found]' : '[not found; Code mode needs it]'}`);
line('Project folders found', platform.defaultProjectRoots().join(', ') || '(none; add folders in the app)');
line('Ollama models folder', fs.existsSync(`${os.homedir()}/.ollama/models`) ? 'found (can be reused)' : 'not found');

try {
  const releases = await get('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10');
  let picked = null;
  for (const r of releases) {
    const a = platform.pickEngineAssets(r.assets, platform.recommendedBackend(gpu));
    if (a.length) { picked = { tag: r.tag_name, assets: a }; break; }
  }
  line('llama.cpp download', picked ? `${picked.tag}: ${picked.assets.map((a) => `${a.name} (${(a.size / 1e6).toFixed(0)} MB)`).join(' + ')}` : 'NONE FOUND  <-- problem');
  if (platform.IS_MAC) {
    const py = pickMacPythonAsset((await get(PBS_RELEASE_API)).assets);
    line('Python download', py ? `${py.name} (${(py.size / 1e6).toFixed(0)} MB)` : 'NONE FOUND  <-- problem');
  }
} catch (e) {
  line('Network check', `failed: ${e.message}`);
}
