import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, DATA } from './paths.js';
import * as engine from './engine.js';
import * as platform from './platform.js';
import * as transcribe from './transcribe.js';
import { emit } from './events.js';

// Microphone dictation. The browser listens, cuts what you say into sentences (pauses mark the cuts) and sends each as
// raw audio. Whisper stays loaded in server/whisper_live.py between sentences, so text appears a moment after you stop
// speaking. Only the text is kept: the audio is deleted as soon as Whisper has read it.

const HELPER = path.join(ROOT, 'server', 'whisper_live.py');
const TMP = path.join(DATA, 'uploads', 'dictation');
fs.mkdirSync(TMP, { recursive: true });

let session = null; // one microphone session at a time

// The page checks in every minute while it is listening (and each sentence counts too). If it stops doing that (the window
// was killed, the page crashed), the session is ended here so Whisper does not keep the GPU, and file jobs can run again.
export const active = () => {
  if (session) session.lastSeen = Date.now();
  return session ? { id: session.id, status: session.status } : null;
};
setInterval(() => {
  if (session && session.status === 'listening' && Date.now() - session.lastSeen > 180000) stop(session.id).catch(() => {});
}, 30000).unref();

export async function start({ language = 'auto', model = platform.defaultWhisperModel() } = {}) {
  if (session) throw new Error('Already listening. Stop the current session first.');
  if (!/^[\w.-]+$/.test(model)) throw new Error('Invalid model name');
  if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new Error('Invalid language code');
  if (!transcribe.status().installed) throw new Error('Whisper is not installed yet (Settings > Engines)');
  if (transcribe.isBusy()) throw new Error('A file is being transcribed right now. Wait for it to finish, or cancel it, then start listening.');
  transcribe.block(true); // file jobs wait while the microphone has Whisper
  const s = { id: crypto.randomUUID().slice(0, 8), status: 'loading', language, pending: new Map(), lines: [], started: Date.now(), lastSeen: Date.now(), device: null, lastEnd: 0, detected: null };
  session = s;
  try {
    emit('dictate-status', { id: s.id, status: 'loading' });
    await engine.stop(); // Whisper gets the GPU to itself
    const py = transcribe.pickPython().python;
    const child = spawn(py, ['-u', HELPER, '--model', model], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'], ...platform.spawnGroup() });
    s.child = child;
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    let ready;
    const ready$ = new Promise((resolve, reject) => (ready = { resolve, reject }));
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
        if (m.type === 'ready') {
          s.device = m.device;
          ready.resolve();
        } else if (m.type === 'result' || (m.type === 'error' && m.seq !== undefined)) {
          const p = s.pending.get(m.seq);
          if (!p) continue;
          s.pending.delete(m.seq);
          if (m.type === 'error') p.reject(new Error(m.message));
          else p.resolve(m);
        } else if (m.type === 'error') ready.reject(new Error(m.message));
      }
    });
    child.on('error', (e) => ready.reject(new Error(`Could not start Python (${py}): ${e.message}`)));
    child.on('close', (code) => {
      const why = new Error(stderr.trim().split('\n').slice(-3).join(' ') || `Whisper stopped (exit ${code})`);
      ready.reject(why);
      for (const p of s.pending.values()) p.reject(why);
      s.pending.clear();
      s.exited = true;
    });
    await Promise.race([ready$, new Promise((_, no) => setTimeout(() => no(new Error('Whisper took too long to load')), 300000))]);
    s.status = 'listening';
    emit('dictate-status', { id: s.id, status: 'listening', device: s.device });
    return { id: s.id, device: s.device };
  } catch (e) {
    cleanup(s);
    throw e;
  }
}

function cleanup(s) {
  if (s.child && !s.exited) platform.killTree(s.child.pid);
  if (session === s) session = null;
  transcribe.block(false);
  emit('dictate-status', { id: s.id, status: 'stopped' });
}

// One sentence of raw 16 kHz mono 16-bit audio. Resolves with the text Whisper heard.
export async function chunk(id, seq, offsetSec, pcm) {
  const s = session;
  if (!s || s.id !== id) throw new Error('Not listening (the session ended)');
  if (s.exited) throw new Error('Whisper stopped unexpectedly');
  s.lastSeen = Date.now();
  if (!(pcm.length >= 3200)) return { text: '', segments: [] }; // under 0.1 s: nothing to hear
  const file = path.join(TMP, `${id}-${seq}.pcm`);
  fs.writeFileSync(file, pcm);
  const result = new Promise((resolve, reject) => s.pending.set(seq, { resolve, reject }));
  s.child.stdin.write(JSON.stringify({ seq, file, offset: offsetSec, language: s.language }) + '\n');
  let r;
  try {
    r = await result;
  } finally {
    fs.rmSync(file, { force: true });
  }
  s.lines.push(...r.segments);
  if (r.language && !s.detected) s.detected = r.language;
  if (r.segments.length) s.lastEnd = Math.max(s.lastEnd, r.segments[r.segments.length - 1].end);
  return { text: r.segments.map((x) => x.text).join(' '), segments: r.segments };
}

// Ends the session and saves what was heard as a transcript (shown in the Transcribe list). Returns that transcript, or
// null when nothing was said.
export async function stop(id) {
  const s = session;
  if (!s || s.id !== id) return null;
  // let sentences that are still being transcribed finish
  const deadline = Date.now() + 30000;
  while (s.pending.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  const lines = [...s.lines].sort((a, b) => a.start - b.start);
  const info = { device: s.device, language: s.detected || (s.language !== 'auto' ? s.language : undefined), duration: (Date.now() - s.started) / 1000 };
  try {
    s.child?.stdin.write(JSON.stringify({ quit: true }) + '\n');
  } catch {
    /* already gone */
  }
  cleanup(s);
  if (!lines.length) return null;
  const when = new Date(s.started).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return transcribe.saveFinished({ name: `Microphone ${when}`, source: 'microphone', lines, ...info });
}

process.on('exit', () => session?.child && platform.killTree(session.child.pid));
