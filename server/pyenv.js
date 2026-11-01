import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { DATA } from './paths.js';
import { downloadTo } from './download.js';
import { emit } from './events.js';
import * as platform from './platform.js';

// A private, self-contained Python in <data>/python, used by Transcribe (faster-whisper) and
// Image (PyTorch + diffusers). Nothing is installed system-wide.
//   Windows: the official "embeddable" build from python.org, plus pip via get-pip.py
//   macOS:   a relocatable build from astral-sh/python-build-standalone (pip included)

const WIN_PY_VERSION = '3.11.9'; // last 3.11 release that ships a Windows embeddable package
const PY_DIR = path.join(DATA, 'python');
const PY_EXE = path.join(PY_DIR, platform.privatePythonRelPath());
const status = (message, extra = {}) => emit('engine-status', { message, ...extra });

export const pythonExe = () => (fs.existsSync(PY_EXE) ? PY_EXE : null);

function runPython(args, { label } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY_EXE, args, {
      cwd: PY_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
      windowsHide: true,
    });
    let tail = '';
    let last = 0;
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail = (tail + '\n' + line).slice(-1500);
        const now = Date.now();
        if (now - last > 250) {
          last = now;
          status(`${label ? label + ': ' : ''}${line.trim().slice(0, 140)}`);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${label || 'python'} failed (exit ${code}):${tail}`))));
  });
}

const hasPip = () => fs.existsSync(path.join(PY_DIR, 'Lib', 'site-packages', 'pip')) || fs.readdirSync(path.join(PY_DIR, 'lib'), { withFileTypes: true }).some((e) => e.isDirectory() && fs.existsSync(path.join(PY_DIR, 'lib', e.name, 'site-packages', 'pip')));

async function ensurePythonWindows() {
  if (!pythonExe()) {
    status(`Downloading Python ${WIN_PY_VERSION}...`);
    const zip = path.join(PY_DIR, 'python-embed.zip');
    await downloadTo(`https://www.python.org/ftp/python/${WIN_PY_VERSION}/python-${WIN_PY_VERSION}-embed-amd64.zip`, zip, `Python ${WIN_PY_VERSION}`);
    status('Unpacking Python...');
    execFileSync(platform.tarPath(), ['-xf', zip, '-C', PY_DIR], { timeout: 120000 });
    fs.rmSync(zip, { force: true });
  }
  // the embeddable build ignores site-packages until "import site" is enabled in its ._pth file
  const pth = fs.readdirSync(PY_DIR).find((f) => /^python\d+\._pth$/.test(f));
  if (!pth) throw new Error('Python ._pth file not found');
  let text = fs.readFileSync(path.join(PY_DIR, pth), 'utf8');
  text = text.replace(/^#\s*import site/m, 'import site');
  if (!/site-packages/.test(text)) text = text.replace(/\r?\n?$/, '\r\nLib\\site-packages\r\n');
  fs.writeFileSync(path.join(PY_DIR, pth), text);
  fs.mkdirSync(path.join(PY_DIR, 'Lib', 'site-packages'), { recursive: true });

  status('Installing pip...');
  const getPip = path.join(PY_DIR, 'get-pip.py');
  await downloadTo('https://bootstrap.pypa.io/get-pip.py', getPip, 'get-pip.py');
  await runPython([getPip, '--no-warn-script-location', '--progress-bar', 'off'], { label: 'pip' });
  fs.rmSync(getPip, { force: true });
}

// The macOS Python build for this CPU, from a python-build-standalone release's asset list.
export const PBS_RELEASE_API = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest';
export function pickMacPythonAsset(assets, arch = platform.ARCH) {
  const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return (assets || []).find((a) => new RegExp(`^cpython-3\\.11\\.\\d+\\+\\d+-${triple}-install_only\\.tar\\.gz$`).test(a.name));
}

async function ensurePythonMac() {
  status('Looking up a standalone Python build...');
  const rel = await (await fetch(PBS_RELEASE_API, { headers: { 'User-Agent': 'llm-icarus' } })).json();
  const asset = pickMacPythonAsset(rel.assets);
  if (!asset) throw new Error('No Python 3.11 build for this Mac in the latest python-build-standalone release');
  const tgz = path.join(DATA, 'python-download.tar.gz');
  status(`Downloading ${asset.name}...`);
  await downloadTo(asset.browser_download_url, tgz, 'Python 3.11');
  status('Unpacking Python...');
  fs.rmSync(PY_DIR, { recursive: true, force: true });
  fs.mkdirSync(PY_DIR, { recursive: true });
  execFileSync(platform.tarPath(), ['-xzf', tgz, '-C', PY_DIR, '--strip-components=1'], { timeout: 300000 }); // archive has a top-level python/ folder
  fs.rmSync(tgz, { force: true });
  if (!pythonExe()) throw new Error('Python was unpacked but bin/python3 is missing');
}

export async function ensurePython() {
  fs.mkdirSync(PY_DIR, { recursive: true });
  if (pythonExe()) {
    try {
      if (hasPip()) return;
    } catch {
      /* fall through and repair */
    }
  }
  if (platform.IS_WIN) await ensurePythonWindows();
  else await ensurePythonMac();
}

const pipInstall = (pkgs, { index } = {}, label) =>
  runPython(['-m', 'pip', 'install', '--no-warn-script-location', '--progress-bar', 'off', ...(index ? ['--index-url', index] : []), ...pkgs], { label });

// feature: 'whisper' | 'image'
export async function installFeature(feature) {
  const gpu = platform.detectGpu();
  // check before downloading anything big
  if (feature === 'image') {
    if (platform.IS_MAC && platform.ARCH !== 'arm64') throw new Error('Image generation needs an Apple Silicon Mac (M1 or newer); this Intel Mac is not supported.');
    if (!platform.IS_MAC && gpu.vendor !== 'nvidia') throw new Error('Image generation needs an NVIDIA GPU (none was detected), so it was not installed.');
  }
  await ensurePython();
  if (feature === 'whisper') {
    status('Installing Whisper (faster-whisper)...');
    // NVIDIA GPUs need the CUDA 12 math libraries; on a Mac, Whisper runs on the CPU
    const cuda = !platform.IS_MAC && gpu.vendor === 'nvidia';
    await pipInstall(['faster-whisper', ...(cuda ? ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12==9.*'] : [])], {}, 'whisper');
  } else if (feature === 'image') {
    if (platform.IS_MAC) {
      status('Installing PyTorch (Apple GPU support is built in)...');
      await pipInstall(['torch', 'torchvision'], {}, 'pytorch');
    } else {
      status('Installing PyTorch with CUDA (about 3 GB)...');
      await pipInstall(['torch', 'torchvision'], { index: 'https://download.pytorch.org/whl/cu128' }, 'pytorch');
    }
    status('Installing diffusers...');
    await pipInstall(['diffusers', 'transformers', 'accelerate', 'safetensors', 'pillow'], {}, 'diffusers');
  } else throw new Error(`Unknown feature: ${feature}`);
}

// Is a Python module importable in our private Python?
export function hasModule(name) {
  if (!pythonExe()) return false;
  try {
    execFileSync(PY_EXE, ['-c', `import importlib.util,sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(name)}) else 1)`], { cwd: PY_DIR, timeout: 30000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Pre-download the Whisper weights so the first transcription doesn't have to.
export async function fetchWhisperModel(model = 'large-v3') {
  if (!hasModule('faster_whisper')) throw new Error('Install Whisper first');
  status(`Downloading the Whisper ${model} model...`);
  await runPython(['-c', `from faster_whisper.utils import download_model; download_model(${JSON.stringify(model)})`], { label: 'whisper model' });
}

// ---- update checks ---------------------------------------------------------

// Version of a pip package as seen by a given Python, or null if it is not installed there.
export function installedVersion(python, pkg) {
  try {
    return execFileSync(python, ['-c', `import importlib.metadata as m; print(m.version(${JSON.stringify(pkg)}))`], {
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

// Newest released version of a package on PyPI.
export async function latestVersion(pkg) {
  const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, { headers: { 'User-Agent': 'llm-icarus' } });
  if (!res.ok) throw new Error(`PyPI answered ${res.status} for ${pkg}`);
  return (await res.json()).info.version;
}

// Upgrade a package in OUR private Python. (A Python the user supplied is theirs to manage.)
export async function updatePackage(pkg) {
  if (!pythonExe()) throw new Error('LLM Icarus has no private Python of its own on this computer, so it will not change the Python you use.');
  status(`Updating ${pkg}...`);
  await pipInstall(['--upgrade', pkg], {}, pkg);
  status(`${pkg} is up to date`, { done: true });
}
