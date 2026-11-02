import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WEB, DATA } from './paths.js';
import * as events from './events.js';
import * as engine from './engine.js';
import * as models from './models.js';
import * as store from './store.js';
import { runTurn } from './chat.js';
import * as transcribe from './transcribe.js';
import * as image from './image.js';
import * as vector from './vector.js';
import * as threed from './threed.js';
import * as dictate from './dictate.js';
import * as openscad from './openscad.js';
import * as platform from './platform.js';
import * as pyenv from './pyenv.js';
import * as appupdate from './appupdate.js';
import { pipeline } from 'node:stream/promises';

let apiTasks = 0; // prompts from /api/tasks currently running (drives the animated logo)

// A stray error in one request or helper process shouldn't take the whole app down: record it and keep serving.
const logCrash = (kind) => (e) => {
  try {
    fs.appendFileSync(path.join(DATA, 'crash.log'), `${new Date().toISOString()} ${kind}: ${e?.stack || e}\n`);
  } catch {
    /* nothing more to do */
  }
  console.error(kind, e);
};
process.on('uncaughtException', logCrash('uncaughtException'));
process.on('unhandledRejection', logCrash('unhandledRejection'));

const PORT = Number(process.env.PORT) || 3210;
const HOST = '127.0.0.1'; // local only; never exposed to the network

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });

let shuttingDown = false;

async function route(req, res, url) {
  const { pathname } = url;
  // While the model is being unloaded after /api/shutdown the process lingers for a few seconds. Say so (503) instead of
  // looking healthy, otherwise a window opened right then would connect to a server that is about to disappear.
  if (shuttingDown) return json(res, 503, { error: 'LLM Icarus is shutting down' });
  const m = req.method;
  let match;

  if (pathname === '/api/events') return events.addClient(res);

  // Used by start.ps1 when the app window is closed: unload the model, then exit.
  if (pathname === '/api/shutdown' && m === 'POST') {
    shuttingDown = true; // from now on answer 503, so a launcher knows this server is on its way out
    json(res, 200, { ok: true });
    engine.stop().finally(() => setTimeout(() => process.exit(0), 200));
    return;
  }

  // --- this app: its version, and updating it from the newest GitHub release ---
  if (pathname === '/api/version' && m === 'GET') return json(res, 200, { version: appupdate.version(), canSelfUpdate: appupdate.canSelfUpdate() });
  if (pathname === '/api/app-update' && m === 'GET') return json(res, 200, appupdate.status());
  if (pathname === '/api/app-update/check' && m === 'POST') {
    const { auto } = await readBody(req);
    if (auto && store.settings().checkAppUpdates === false) return json(res, 200, { disabled: true });
    return json(res, 200, await appupdate.check({ force: !auto }));
  }
  if (pathname === '/api/app-update/download' && m === 'POST') {
    try {
      return json(res, 202, await appupdate.download());
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (pathname === '/api/app-update/cancel' && m === 'POST') return json(res, 200, appupdate.cancel());
  // asked by the app window (not the page) before it runs an installer: the path of the finished download, or nothing
  if (pathname === '/api/app-update/installer-path' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(appupdate.readyInstaller() || '');
  }

  // --- engine ---
  if (pathname === '/api/engine' && m === 'GET') return json(res, 200, engine.status());
  if (pathname === '/api/engine/install' && m === 'POST') {
    const { backend } = await readBody(req);
    engine.install(backend).catch(() => {}); // progress + errors arrive over /api/events
    return json(res, 202, { started: true });
  }
  if (pathname === '/api/engine/unload' && m === 'POST') {
    await engine.stop();
    return json(res, 200, engine.status());
  }

  // --- models ---
  if (pathname === '/api/models' && m === 'GET') return json(res, 200, models.list());
  if (pathname === '/api/models/ollama' && m === 'GET') return json(res, 200, models.scanOllama());
  if (pathname === '/api/models/import-ollama' && m === 'POST') {
    const { name } = await readBody(req);
    return json(res, 200, models.importOllama(name));
  }
  if (pathname === '/api/models/add-path' && m === 'POST') {
    const { path: p, name } = await readBody(req);
    return json(res, 200, models.addPath(p, name));
  }
  if (pathname === '/api/models/download' && m === 'POST') {
    // body: { url } = whatever was pasted, or { direct, source } = a choice picked from an earlier { choices } reply
    const { url: pasted, direct, source } = await readBody(req);
    const target = direct ? await models.resolveSource(direct) : await models.resolveSource(pasted);
    if (target.choices) return json(res, 200, { choices: target.choices });
    models.downloadUrl(direct ? { ...target, source: source || target.source } : target).catch(() => {}); // progress + errors arrive over /api/events
    return json(res, 202, { started: true });
  }
  if ((match = pathname.match(/^\/api\/models\/([\w-]+)$/)) && m === 'DELETE') {
    const del = url.searchParams.get('deleteFile') === '1';
    return json(res, 200, { removed: models.remove(match[1], del) });
  }

  // --- projects & settings ---
  if (pathname === '/api/projects' && m === 'GET') return json(res, 200, store.projects());
  if (pathname === '/api/projects' && m === 'POST') {
    const { path: p } = await readBody(req);
    return json(res, 200, store.addProject(p));
  }
  if ((match = pathname.match(/^\/api\/projects\/([\w-]+)$/)) && m === 'DELETE') {
    store.removeProject(match[1]);
    return json(res, 200, { ok: true });
  }
  // show a project's folder in File Explorer / Finder (only folders that are in the project list)
  if ((match = pathname.match(/^\/api\/projects\/([\w-]+)\/open$/)) && m === 'POST') {
    const proj = store.projects().find((p) => p.id === match[1]);
    if (!proj) return json(res, 404, { error: 'Not found' });
    if (!fs.existsSync(proj.path)) return json(res, 400, { error: `That folder no longer exists: ${proj.path}` });
    platform.openFolder(proj.path);
    return json(res, 200, { ok: true });
  }

  // --- project folders: places we search for projects (every subfolder becomes a project) ---
  if (pathname === '/api/project-roots' && m === 'GET') return json(res, 200, store.projectRoots());
  if (pathname === '/api/project-roots' && m === 'POST') {
    const { path: p } = await readBody(req);
    return json(res, 200, store.addRoot(p));
  }
  if (pathname === '/api/project-roots' && m === 'DELETE') return json(res, 200, store.removeRoot(url.searchParams.get('path') || ''));
  if (pathname === '/api/project-roots/rescan' && m === 'POST') {
    const added = store.rescanRoots();
    return json(res, 200, { added, roots: store.projectRoots() });
  }
  // the system "choose a folder" window; resolves to { path } or { path: null } when cancelled
  if (pathname === '/api/pick-folder' && m === 'POST') {
    const { title } = await readBody(req);
    return json(res, 200, { path: await platform.pickFolder(title || 'Choose a folder') });
  }

  // --- update checks (only when asked: these look up the internet) ---
  if (pathname === '/api/updates/engines' && m === 'GET') {
    const looked = async (fn) => fn().catch((e) => ({ error: e.message }));
    const pkg = async (python, name, priv) => {
      const installed = pyenv.installedVersion(python, name);
      if (!installed) return { installed: null, note: 'not installed' };
      const latest = await pyenv.latestVersion(name);
      return { package: name, installed, latest, updateAvailable: installed !== latest, canUpdate: priv };
    };
    const [chat, whisper, imageTools, vectorTools] = await Promise.all([
      looked(() => engine.checkUpdate()),
      looked(() => { const p = transcribe.pickPython(); return pkg(p.python, 'faster-whisper', p.source === 'private'); }),
      looked(() => { const py = image.pyPath(); return pkg(py, 'diffusers', py === pyenv.pythonExe()); }),
      looked(() => (pyenv.pythonExe() ? pkg(pyenv.pythonExe(), 'vtracer', true) : { installed: null, note: 'not installed' })),
    ]);
    return json(res, 200, { chat, whisper, image: imageTools, vector: vectorTools });
  }
  if (pathname === '/api/updates/package' && m === 'POST') {
    const { name } = await readBody(req);
    const pkgName = { whisper: 'faster-whisper', image: 'diffusers', vector: 'vtracer' }[name];
    if (!pkgName) return json(res, 400, { error: 'Unknown component' });
    pyenv.updatePackage(pkgName).catch((e) => events.emit('engine-status', { message: `Update failed: ${e.message}`, error: true })); // progress arrives over /api/events
    return json(res, 202, { started: true });
  }
  if (pathname === '/api/updates/models' && m === 'GET') return json(res, 200, await models.checkUpdates());
  if ((match = pathname.match(/^\/api\/models\/([\w-]+)\/update$/)) && m === 'POST') {
    const model = models.get(match[1]);
    if (!model) return json(res, 404, { error: 'Not found' });
    if (engine.status().loaded?.path === model.path) await engine.stop(); // a loaded file cannot be replaced
    models.updateModel(model.id).catch(() => {}); // progress arrives over /api/events
    return json(res, 202, { started: true });
  }

  // status of the engines behind each mode, for Settings > Engines
  if (pathname === '/api/components' && m === 'GET') {
    return json(res, 200, { chat: engine.status(), whisper: transcribe.status(), image: { installed: image.installed() }, vector: { installed: vector.installed() }, threed: threed.status() });
  }
  // install one of the Python-based parts from inside the app; progress arrives over /api/events as engine-status
  if (pathname === '/api/components/install' && m === 'POST') {
    const { feature } = await readBody(req);
    if (!['whisper', 'image', 'vector', 'threed'].includes(feature)) return json(res, 400, { error: 'Unknown component' });
    // 3D = OpenSCAD (a download) plus the carving tools (pip)
    (feature === 'threed' ? threed.installAll() : pyenv.installFeature(feature))
      .then(() => {
        vector.forgetInstalled();
        threed.forgetInstalled();
        events.emit('engine-status', { message: 'Installed.', done: true, feature });
      })
      .catch((e) => events.emit('engine-status', { message: `Install failed: ${e.message.split('\n')[0]}`, error: true, feature }));
    return json(res, 202, { started: true });
  }
  if (pathname === '/api/settings' && m === 'GET') return json(res, 200, store.settings());
  if (pathname === '/api/settings' && m === 'POST') return json(res, 200, store.saveSettings(await readBody(req)));

  // --- conversations ---
  if (pathname === '/api/conversations' && m === 'GET') return json(res, 200, store.listConversations());
  if (pathname === '/api/conversations' && m === 'POST') return json(res, 200, store.createConversation(await readBody(req)));
  if ((match = pathname.match(/^\/api\/conversations\/([\w-]+)$/))) {
    const conv = store.getConversation(match[1]);
    if (!conv) return json(res, 404, { error: 'Not found' });
    if (m === 'GET') return json(res, 200, conv);
    if (m === 'DELETE') {
      store.deleteConversation(conv.id);
      return json(res, 200, { ok: true });
    }
    if (m === 'PATCH') {
      const { title, modelId, projectId, mode } = await readBody(req);
      Object.assign(conv, { ...(title && { title }), ...(modelId && { modelId }), ...(projectId !== undefined && { projectId }), ...(mode && { mode }) });
      return json(res, 200, store.saveConversation(conv));
    }
  }

  // Send a message in a conversation and stream the reply (used by the UI).
  if ((match = pathname.match(/^\/api\/conversations\/([\w-]+)\/send$/)) && m === 'POST') {
    const conv = store.getConversation(match[1]);
    if (!conv) return json(res, 404, { error: 'Not found' });
    const { text, modelId } = await readBody(req);
    if (modelId) conv.modelId = modelId;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    const send = (o) => !res.writableEnded && res.write(`data: ${JSON.stringify(o)}\n\n`);
    try {
      await runTurn(conv, text, { signal: ctrl.signal, onEvent: send });
      send({ type: 'done' });
    } catch (e) {
      if (e.name !== 'AbortError') send({ type: 'error', message: e.message });
    }
    return res.end();
  }

  // Hand a prompt to the app from outside (scripts, Claude Code, etc.), wait for the reply.
  //   POST /api/tasks { prompt, modelId?, projectId?, mode?, conversationId? }
  if (pathname === '/api/tasks' && m === 'POST') {
    const { prompt, modelId, projectId, mode, conversationId } = await readBody(req);
    if (!prompt) return json(res, 400, { error: 'prompt is required' });
    const conv = conversationId
      ? store.getConversation(conversationId)
      : store.createConversation({ projectId: projectId ?? null, mode: mode || 'chat', modelId: modelId || models.list()[0]?.id });
    if (!conv) return json(res, 404, { error: 'conversation not found' });
    if (modelId) conv.modelId = modelId;
    events.emit('api-tasks', { count: ++apiTasks });
    try {
      if (!conversationId) {
        // show it in the sidebar right away, already named after the prompt
        if (conv.title === 'New chat') conv.title = prompt.replace(/\s+/g, ' ').slice(0, 60);
        events.emit('chats-changed', {});
      }
      const reply = await runTurn(conv, prompt);
      events.emit('chats-changed', {});
      return json(res, 200, { conversationId: conv.id, reply });
    } catch (e) {
      // don't leave an empty "New chat" behind when the request never got going
      if (!conversationId && !conv.messages.length) store.deleteConversation(conv.id);
      throw e;
    } finally {
      events.emit('api-tasks', { count: --apiTasks });
    }
  }

  // --- transcribe ---
  if (pathname === '/api/transcribe' && m === 'GET') return json(res, 200, transcribe.list());
  if ((pathname === '/api/transcribe/upload' || pathname === '/api/upload') && m === 'POST') {
    const dest = transcribe.uploadPath(url.searchParams.get('name'));
    await pipeline(req, fs.createWriteStream(dest));
    return json(res, 200, { path: dest });
  }
  if (pathname === '/api/transcribe' && m === 'POST') {
    // { path, language?, model?, wait? }  wait=true holds the request until the transcript is finished
    const { path: src, language, model, wait } = await readBody(req);
    const job = transcribe.submit({ src, language, model });
    if (!wait) return json(res, 202, { id: job.id });
    await job.finished;
    return json(res, job.status === 'done' ? 200 : 500, { id: job.id, status: job.status, error: job.error, text: job.text.join('\n') });
  }
  if ((match = pathname.match(/^\/api\/transcribe\/([\w-]+)\/cancel$/)) && m === 'POST') return json(res, 200, { ok: transcribe.cancel(match[1]) });
  if ((match = pathname.match(/^\/api\/transcribe\/([\w-]+)$/)) && m === 'DELETE') return json(res, 200, { removed: transcribe.remove(match[1]) });
  if ((match = pathname.match(/^\/api\/transcribe\/([\w-]+)\/file\/(srt|txt)$/)) && m === 'GET') {
    const f = transcribe.fileFor(match[1], match[2]);
    if (!f) return json(res, 404, { error: 'Not found' });
    const dl = url.searchParams.get('download') === '1';
    res.writeHead(200, { 'Content-Type': f.type, ...(dl && { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` }) });
    return fs.createReadStream(f.file).pipe(res);
  }

  // --- microphone dictation: start a session, send each spoken sentence as raw 16 kHz mono 16-bit audio, then stop ---
  if (pathname === '/api/dictate' && m === 'GET') return json(res, 200, { active: dictate.active(), whisper: transcribe.status().installed });
  if (pathname === '/api/dictate/start' && m === 'POST') return json(res, 200, await dictate.start(await readBody(req)));
  if ((match = pathname.match(/^\/api\/dictate\/([\w-]+)\/chunk$/)) && m === 'POST') {
    const parts = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 4_000_000) throw new Error('That audio clip is too long');
      parts.push(c);
    }
    return json(res, 200, await dictate.chunk(match[1], Number(url.searchParams.get('seq')) || 0, Number(url.searchParams.get('offset')) || 0, Buffer.concat(parts)));
  }
  if ((match = pathname.match(/^\/api\/dictate\/([\w-]+)\/stop$/)) && m === 'POST') return json(res, 200, { transcript: await dictate.stop(match[1]) });

  // --- image ---
  if (pathname === '/api/image' && m === 'GET') return json(res, 200, { installed: image.installed(), jobs: image.list() });
  if (pathname === '/api/image' && m === 'POST') {
    // { prompt, negative?, modelId, width?, height?, steps?, guidance?, seed?, count?, initImage?, strength?, wait? }
    const body = await readBody(req);
    const job = image.submit(body);
    if (!body.wait) return json(res, 202, { id: job.id });
    await job.finished;
    return json(res, job.status === 'done' ? 200 : 500, { id: job.id, status: job.status, error: job.error, files: job.files.map((f) => `/api/image/${job.id}/${f.file}`) });
  }
  if ((match = pathname.match(/^\/api\/image\/([\w-]+)\/cancel$/)) && m === 'POST') return json(res, 200, { ok: image.cancel(match[1]) });
  if ((match = pathname.match(/^\/api\/image\/([\w-]+)$/)) && m === 'DELETE') return json(res, 200, { removed: image.remove(match[1]) });
  if ((match = pathname.match(/^\/api\/image\/([\w-]+)\/(\d+\.png)$/)) && m === 'GET') {
    const f = image.fileFor(match[1], match[2]);
    if (!f) return json(res, 404, { error: 'Not found' });
    const dl = url.searchParams.get('download') === '1';
    res.writeHead(200, { 'Content-Type': 'image/png', ...(dl && { 'Content-Disposition': `attachment; filename="${match[1]}-${match[2]}"` }) });
    return fs.createReadStream(f).pipe(res);
  }

  // --- vector (SVG + EPS) ---
  if (pathname === '/api/vector' && m === 'GET') return json(res, 200, { installed: vector.installed(), jobs: vector.list() });
  if (pathname === '/api/vector' && m === 'POST') {
    // { method: 'trace'|'llm'|'sdxl', prompt?, reference?, modelId?, imageModelId?, baseJob?, aspect?, thinking?, strength?,
    //   colormode?, detail?, removeBackground?, widthMm?, wait? }
    const body = await readBody(req);
    const job = vector.submit(body);
    if (!body.wait) return json(res, 202, { id: job.id });
    await job.finished;
    const base = `/api/vector/${job.id}`;
    return json(res, job.status === 'done' ? 200 : 500, { id: job.id, status: job.status, error: job.error, svg: `${base}/out.svg`, eps: `${base}/out.eps` });
  }
  if ((match = pathname.match(/^\/api\/vector\/([\w-]+)\/cancel$/)) && m === 'POST') return json(res, 200, { ok: vector.cancel(match[1]) });
  if ((match = pathname.match(/^\/api\/vector\/([\w-]+)$/)) && m === 'DELETE') return json(res, 200, { removed: vector.remove(match[1]) });
  if ((match = pathname.match(/^\/api\/vector\/([\w-]+)\/([\w.]+)$/)) && m === 'GET') {
    const f = vector.fileFor(match[1], match[2]);
    if (!f) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(f);
    const dl = url.searchParams.get('download') === '1';
    res.writeHead(200, {
      'Content-Type': { '.svg': 'image/svg+xml', '.eps': 'application/postscript', '.png': 'image/png' }[ext],
      'X-Content-Type-Options': 'nosniff',
      // a drawing written by a model is untrusted: it must never run script, even when opened on its own in a tab
      ...(ext === '.svg' && { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" }),
      ...(dl && { 'Content-Disposition': `attachment; filename="icarus-${match[1]}${ext}"` }),
    });
    return fs.createReadStream(f).pipe(res);
  }

  // --- 3D (STL) ---
  if (pathname === '/api/3d' && m === 'GET') return json(res, 200, { ...threed.status(), jobs: threed.list() });
  if (pathname === '/api/3d' && m === 'POST') {
    // { method: 'scad'|'photos', prompt?, sizeMm?: {x,y,z}, sizeText?, modelId?, thinking?, baseJob?, code?,
    //   views?: {front,side,top: picture paths}, quality?, background?, wait? }
    const body = await readBody(req);
    const job = threed.submit(body);
    if (!body.wait) return json(res, 202, { id: job.id });
    await job.finished;
    const base = `/api/3d/${job.id}`;
    return json(res, job.status === 'done' ? 200 : 500, { id: job.id, status: job.status, error: job.error, stl: job.files.stl ? `${base}/out.stl` : undefined, scad: job.files.scad ? `${base}/model.scad` : undefined, picture: job.files.picture ? `${base}/picture.png` : undefined, size: job.size, triangles: job.triangles, warning: job.warning });
  }
  if ((match = pathname.match(/^\/api\/3d\/([\w-]+)\/cancel$/)) && m === 'POST') return json(res, 200, { ok: threed.cancel(match[1]) });
  if ((match = pathname.match(/^\/api\/3d\/([\w-]+)$/)) && m === 'DELETE') return json(res, 200, { removed: threed.remove(match[1]) });
  if ((match = pathname.match(/^\/api\/3d\/([\w-]+)\/([\w.]+)$/)) && m === 'GET') {
    const f = threed.fileFor(match[1], match[2]);
    if (!f) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(f);
    const dl = url.searchParams.get('download') === '1';
    res.writeHead(200, {
      'Content-Type': ext === '.stl' ? 'model/stl' : ext === '.png' ? 'image/png' : 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...(dl && { 'Content-Disposition': `attachment; filename="icarus-${match[1]}${ext}"` }),
    });
    return fs.createReadStream(f).pipe(res);
  }

  // --- static web UI ---
  if (m === 'GET') {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.join(WEB, rel);
    if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
  }
  json(res, 404, { error: 'Not found' });
}

http
  .createServer(async (req, res) => {
    try {
      // Block other websites from driving this server (CSRF / DNS rebinding).
      const allowed = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
      const origin = req.headers.origin;
      if (!allowed.includes(req.headers.host) || (origin && !allowed.includes(new URL(origin).host))) {
        return json(res, 403, { error: 'Forbidden' });
      }
      await route(req, res, new URL(req.url, `http://${HOST}`));
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    }
  })
  .listen(PORT, HOST, () => console.log(`LLM Icarus running at http://${HOST}:${PORT}`));

// pick up project folders that appeared since last time
try {
  store.rescanRoots();
} catch (e) {
  console.error('Project folder scan failed:', e.message);
}
