import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Live readings of this PC for the performance sidebar: processor load, real clock speed, temperature, memory, and the
// graphics card. Nothing runs until the page asks (GET /api/sysmon) and everything stops again a little after the page
// stops asking, so a closed sidebar costs nothing.
//   Windows  one `typeperf` process streams the performance counters (load, speed relative to base, thermal zone), and
//            `nvidia-smi` streams the graphics card. Without the counters it falls back to Node's own CPU times.
//   Others   Node's CPU times and memory only.

const IDLE_STOP_MS = 20000;
let lastAsk = 0;
let timer = null;
const children = new Set();

const state = { cpu: null, clockGHz: null, tempC: null, ramUsedGB: null, ramTotalGB: null, gpu: null, me: null }; // me = what LLM Icarus itself uses
let counters = { util: null, perf: null, zones: [] }; // which typeperf columns are which

// ---- Node's own numbers (always available) ----------------------------------

let prevTimes = null;
function sampleNode() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  if (prevTimes && total > prevTimes.total) state.cpu = Math.max(0, Math.min(100, (1 - (idle - prevTimes.idle) / (total - prevTimes.total)) * 100));
  prevTimes = { idle, total };
  state.ramTotalGB = os.totalmem() / 1073741824;
  state.ramUsedGB = (os.totalmem() - os.freemem()) / 1073741824;
  state.baseGHz = (cpus[0]?.speed || 0) / 1000;
}

// ---- Windows performance counters ----------------------------------------------

const UTIL = '\\Processor Information(_Total)\\% Processor Utility';
const PERF = '\\Processor Information(_Total)\\% Processor Performance';
const THERMAL = '\\Thermal Zone Information(*)\\Temperature';

// quoted CSV fields from typeperf: "a","b","c"
const fields = (line) => line.replace(/^"|"$/g, '').split('","');

function startTypeperf(withThermal) {
  const args = [UTIL, PERF, ...(withThermal ? [THERMAL] : []), '-si', '1'];
  const child = spawn('typeperf', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  let buf = '';
  let gotData = false;
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('"')) continue;
      const f = fields(line);
      if (f[0].startsWith('(PDH-CSV')) {
        // the header names the columns, in the order we asked for them
        counters = { util: null, perf: null, zones: [] };
        f.forEach((name, i) => {
          if (/Processor Utility$/i.test(name)) counters.util = i;
          else if (/Processor Performance$/i.test(name)) counters.perf = i;
          else if (/Thermal Zone Information\(.*\)\\Temperature$/i.test(name)) counters.zones.push(i);
        });
        continue;
      }
      const num = (i) => (i === null || i === undefined ? NaN : parseFloat(f[i]));
      const util = num(counters.util);
      const perf = num(counters.perf);
      if (Number.isFinite(util)) state.cpu = Math.max(0, Math.min(100, util));
      if (Number.isFinite(perf) && state.baseGHz) state.clockGHz = (perf / 100) * state.baseGHz;
      const temps = counters.zones.map(num).filter((k) => Number.isFinite(k) && k > 200 && k < 450).map((k) => k - 273.15); // kelvin
      if (temps.length) state.tempC = Math.max(...temps);
      gotData = true;
    }
  });
  child.on('close', () => {
    children.delete(child);
    if (!timer) return;
    // no data at all: this PC lacks a counter (or uses another language): try without the thermal zone, then give up
    if (!gotData && withThermal) startTypeperf(false);
    else if (!gotData) counters = { util: null, perf: null, zones: [] };
  });
  child.on('error', () => children.delete(child));
}

// ---- NVIDIA graphics card --------------------------------------------------------

function startNvidia() {
  const q = 'name,utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.sm,power.draw';
  const child = spawn('nvidia-smi', [`--query-gpu=${q}`, '--format=csv,noheader,nounits', '-lms', '1000'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const f = line.split(',').map((s) => s.trim());
      if (f.length < 7) continue;
      const n = (s) => (Number.isFinite(parseFloat(s)) ? parseFloat(s) : null);
      state.gpu = { name: f[0], util: n(f[1]), tempC: n(f[2]), memUsedMB: n(f[3]), memTotalMB: n(f[4]), clockMHz: n(f[5]), powerW: n(f[6]) };
    }
  });
  child.on('close', () => children.delete(child));
  child.on('error', () => children.delete(child)); // no NVIDIA tools: the graphics bars stay empty
}

// ---- what LLM Icarus itself is using (Windows) ---------------------------------------
// server/sysmon_win.ps1 adds up the server, the model engine, the helpers and the app window once a second.

const PROBE =path.join(path.dirname(fileURLToPath(import.meta.url)), 'sysmon_win.ps1');
let prevMe = null;

function startProbe() {
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROBE, '-RootPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const now = Date.now();
      let cpu = state.me?.cpu ?? 0;
      if (prevMe && m.cpuSec >= prevMe.cpuSec && now > prevMe.t) cpu = Math.min(100, ((m.cpuSec - prevMe.cpuSec) / ((now - prevMe.t) / 1000) / os.cpus().length) * 100);
      else if (prevMe) cpu = 0; // a process ended: its time left the total
      prevMe = { cpuSec: m.cpuSec, t: now };
      state.me = {
        cpu,
        ramGB: m.ramBytes / 1073741824,
        gpu: m.gpu,
        vramMB: m.vramBytes / 1048576,
        pids: m.pids,
        names: m.names,
      };
    }
  });
  child.on('close', () => children.delete(child));
  child.on('error', () => children.delete(child));
}

// ---- starting and stopping --------------------------------------------------------

function start() {
  if (timer) return;
  prevTimes = null;
  sampleNode();
  timer = setInterval(() => {
    sampleNode();
    if (Date.now() - lastAsk > IDLE_STOP_MS) stop();
  }, 1000);
  timer.unref?.();
  prevMe = null;
  if (process.platform === 'win32') {
    startTypeperf(true);
    startProbe();
  }
  startNvidia();
}

function stop() {
  clearInterval(timer);
  timer = null;
  for (const c of children) c.kill();
  children.clear();
  Object.assign(state, { cpu: null, clockGHz: null, tempC: null, gpu: null, me: null });
}

export function read() {
  lastAsk = Date.now();
  start();
  return { ...state, cores: os.cpus().length, platform: process.platform };
}

process.on('exit', () => {
  for (const c of children) c.kill();
});
