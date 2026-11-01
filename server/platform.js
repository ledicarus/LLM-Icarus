import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';

// Everything that differs between Windows and macOS lives here, so the rest of the server
// doesn't need to care which one it is running on.

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

export const exeName = (name) => (IS_WIN ? `${name}.exe` : name);

// Options that make a child process easy to stop together with everything it started.
export const spawnGroup = () => (IS_WIN ? { windowsHide: true } : { detached: true });

// Stop a process and its children.
export function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) return execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  try {
    process.kill(-pid, 'SIGKILL'); // the whole process group (children were spawned detached)
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// bsdtar reads .zip and .tar.gz. On Windows use the system copy by full path, because a GNU tar
// earlier on PATH (Git Bash) misreads "C:" as a remote host.
export const tarPath = () => (IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

// Folders to look for projects in on first run.
export function defaultProjectRoots() {
  const home = os.homedir();
  const candidates = IS_WIN
    ? [path.join(home, 'source', 'repos'), path.join(home, 'GitHub'), path.join(home, 'Documents', 'GitHub')]
    : [path.join(home, 'Developer'), path.join(home, 'Projects'), path.join(home, 'GitHub'), path.join(home, 'Documents', 'GitHub'), path.join(home, 'code')];
  return candidates.filter((d) => fs.existsSync(d));
}

// Where the Claude Code CLI normally lives.
export function claudeCliPath() {
  const home = os.homedir();
  const options = IS_WIN
    ? [path.join(home, '.local', 'bin', 'claude.exe')]
    : [path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return options.find((p) => fs.existsSync(p)) || options[0];
}

// What kind of GPU do we have? { vendor: 'nvidia' | 'apple' | 'none', name, memory?, driver? }
export function detectGpu() {
  if (IS_MAC) {
    try {
      const brand = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8', timeout: 5000 }).trim();
      const mem = Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8', timeout: 5000 }).trim());
      if (ARCH === 'arm64') return { vendor: 'apple', name: brand || 'Apple Silicon', memory: `${Math.round(mem / 2 ** 30)} GB unified memory` };
      return { vendor: 'none', name: brand || 'Intel Mac' };
    } catch {
      return { vendor: ARCH === 'arm64' ? 'apple' : 'none', name: 'Mac' };
    }
  }
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { encoding: 'utf8', timeout: 5000 }).trim();
    const [name, mem, driver] = out.split('\n')[0].split(',').map((s) => s.trim());
    return { vendor: 'nvidia', name, memory: mem, driver };
  } catch {
    return { vendor: 'none' };
  }
}

// Which build of llama.cpp suits this machine.
export function recommendedBackend(gpu) {
  if (IS_MAC) return 'metal';
  return gpu.vendor === 'nvidia' ? 'cuda' : 'vulkan';
}

// Pick the llama.cpp release files for a backend. Returns [] when this release has none.
export function pickEngineAssets(assets, backend) {
  const find = (re) => assets.find((a) => re.test(a.name));
  if (IS_MAC) {
    const a = find(new RegExp(`^llama-.*-bin-macos-${ARCH}\\.tar\\.gz$`));
    return a ? [a] : [];
  }
  if (backend === 'cuda') {
    // prefer the newest CUDA 13 build, fall back to 12.x; the runtime DLLs ship as a separate zip
    for (const ver of ['13\\.\\d+', '12\\.\\d+']) {
      const main = find(new RegExp(`^llama-.*-bin-win-cuda-${ver}-x64\\.zip$`));
      const rt = find(new RegExp(`^cudart-llama-bin-win-cuda-${ver}-x64\\.zip$`));
      if (main) return [main, rt].filter(Boolean);
    }
    return [];
  }
  if (backend === 'vulkan') return [find(/^llama-.*-bin-win-vulkan-x64\.zip$/)].filter(Boolean);
  if (backend === 'cpu') return [find(/^llama-.*-bin-win-cpu-x64\.zip$/)].filter(Boolean);
  return [];
}

// Whisper large-v3 is the most accurate but needs an NVIDIA GPU to be quick; everywhere else the
// "turbo" variant is several times faster on the CPU with a small accuracy cost.
export const defaultWhisperModel = () => (detectGpu().vendor === 'nvidia' ? 'large-v3' : 'large-v3-turbo');

// Show a folder in File Explorer (Windows) or Finder (macOS).
export function openFolder(dir) {
  const [cmd, args] = IS_WIN ? ['explorer.exe', [dir]] : ['open', [dir]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// Show the system "choose a folder" window and return the chosen path, or null if it was cancelled.
// (The app runs in a browser view, which cannot hand us real folder paths, so the server asks the OS.)
let picking = null;
export function pickFolder(title = 'Choose a folder') {
  if (picking) return picking; // one picker at a time: a second click just waits for the first
  const clean = String(title).replace(/["\r\n]/g, ' ').slice(0, 120);
  picking = new Promise((resolve, reject) => {
    // cancelling the window is not an error: both scripts then exit normally with no output
    const done = (err, stdout) => {
      picking = null;
      if (err) return reject(new Error(`Could not show the folder picker: ${err.message}`));
      resolve(String(stdout || '').trim() || null);
    };
    if (IS_WIN) {
      // An invisible always-on-top window owns the dialog so it opens in front of the app window.
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$owner = New-Object System.Windows.Forms.Form',
        "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.StartPosition = 'CenterScreen'; $owner.Show()",
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$f.Description = $env:ICARUS_PICK_TITLE',
        '$f.ShowNewFolderButton = $true',
        'if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }',
        '$owner.Close()',
      ].join('\n');
      execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: { ...process.env, ICARUS_PICK_TITLE: clean }, windowsHide: true, encoding: 'utf8' },
        done,
      );
    } else {
      const script = `try\nPOSIX path of (choose folder with prompt "${clean}")\non error\nreturn ""\nend try`;
      execFile('osascript', ['-e', script], { encoding: 'utf8' }, done);
    }
  });
  return picking;
}

// Our private Python lives in <data>/python: python.exe on Windows, bin/python3 on macOS.
export const privatePythonRelPath = () => (IS_WIN ? 'python.exe' : path.join('bin', 'python3'));
