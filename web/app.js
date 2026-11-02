import { planJob, kindOf } from './intent.js';

const $ = (id) => document.getElementById(id);
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

const state = { projects: [], convs: [], models: [], engine: null, conv: null, mode: 'chat', projectId: null, busy: false, apiTasks: 0, ctrl: null, adv: {}, attach: [], base: null };

// The sidebar logo animates (logo-working.png, an animated PNG) whenever something is running, so it's easy to tell the app is busy.
let gifMissing = false;
const isActive = (j) => ['queued', 'loading', 'running'].includes(j.status);
function isWorking() {
  return !!(state.busy || state.modelLoading || state.apiTasks > 0 || (state.transcripts || []).some(isActive) || (state.image?.jobs || []).some(isActive) || (state.vector?.jobs || []).some(isActive) || (state.threed?.jobs || []).some(isActive));
}
function updateBrand() {
  const img = $('brand-logo');
  if (!img) return;
  const working = isWorking();
  const want = working && !gifMissing ? '/logo-working.png' : '/logo.png';
  if (!img.src.endsWith(want)) img.src = want;
  img.classList.toggle('working', working);
}
$('brand-logo').onerror = () => {
  if ($('brand-logo').src.endsWith('/logo-working.png')) {
    gifMissing = true; // no animated version: just keep the still logo
    updateBrand();
  } else $('brand-logo').remove();
};
new Image().src = '/logo-working.png'; // preload so the switch is instant

const fmtSize = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(0) + ' MB');
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Minimal safe markdown: code fences, inline code, bold. Everything is escaped first.
function render(text) {
  const parts = text.split(/```(?:[\w+-]*\n)?/);
  return parts
    .map((p, i) =>
      i % 2
        ? `<pre><code>${esc(p.replace(/\n$/, ''))}</code></pre>`
        : esc(p.replace(/^\n+|\n+$/g, ''))
            .replace(/^#{1,6} +(.+)$/gm, '<b>$1</b>')
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>'),
    )
    .join('');
}

// ---- loading -------------------------------------------------------------

async function refresh() {
  [state.projects, state.convs, state.models, state.engine, state.settings, state.transcripts, state.image, state.vector, state.threed] = await Promise.all([
    api('/api/projects'), api('/api/conversations'), api('/api/models'), api('/api/engine'), api('/api/settings'), api('/api/transcribe'), api('/api/image'), api('/api/vector'), api('/api/3d'),
  ]);
  renderSidebar();
  renderModels();
  renderEngine();
  updateBrand();
}

// The sidebar has two separate lists: PROJECTS (folders you work in) and CHATS (conversations).
// Right-click either kind of item to remove it.
function renderSidebar() {
  saveSession();
  // ---- projects ----
  const pbox = $('project-list');
  pbox.innerHTML = '';
  const projectRow = (p) => {
    const row = document.createElement('div');
    const selected = (state.projectId ?? null) === p.id;
    row.className = 'proj' + (selected ? ' selected' : '') + (p.id === null ? ' all' : '');
    const label = document.createElement('span');
    label.className = 'proj-name';
    label.textContent = p.name;
    row.append(label);
    row.title = p.path || 'Show chats from every project';
    row.onclick = () => selectProject(p.id);
    if (p.id === null) {
      // "+" adds one project folder by hand (Settings > Project folders is for folders that CONTAIN projects)
      const plus = document.createElement('button');
      plus.className = 'proj-add';
      plus.textContent = '+';
      plus.title = 'Add a project folder';
      plus.setAttribute('aria-label', 'Add a project folder');
      plus.onclick = (e) => {
        e.stopPropagation();
        addProjectViaPicker();
      };
      row.append(plus);
    } else {
      row.oncontextmenu = (e) =>
        showContextMenu(e, [
          { label: BROWSE_LABEL, run: () => openProjectFolder(p) },
          { label: `Remove "${p.name}" from the list`, danger: true, run: () => removeProject(p) },
        ]);
    }
    return row;
  };
  pbox.append(projectRow({ id: null, name: 'All projects' }));
  for (const p of state.projects) pbox.append(projectRow(p));

  // ---- chats (for the current mode, and for the selected project if there is one) ----
  const sel = state.projects.find((p) => p.id === state.projectId);
  $('chat-scope').textContent = sel ? `in ${sel.name}` : 'all projects';
  const cbox = $('chat-list');
  cbox.innerHTML = '';
  if (!['chat', 'code'].includes(state.mode)) {
    cbox.innerHTML = '<div class="empty-note">Chats appear in Chat and Code modes.</div>';
    return;
  }
  const convs = state.convs.filter((c) => (c.mode || 'chat') === state.mode && (state.projectId == null || c.projectId === state.projectId));
  if (!convs.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = `No chats in ${state.mode} mode yet.`;
    // the chats might simply be in the other mode (Chat and Code keep separate lists)
    const other = state.mode === 'chat' ? 'code' : 'chat';
    const n = state.convs.filter((c) => (c.mode || 'chat') === other && (state.projectId == null || c.projectId === state.projectId)).length;
    if (n) {
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'link';
      a.textContent = `${n} in ${other} mode: show`;
      a.onclick = (e) => {
        e.preventDefault();
        setMode(other);
      };
      note.append(document.createElement('br'), a);
    }
    cbox.append(note);
  }
  for (const c of convs) {
    const row = document.createElement('div');
    row.className = 'conv' + (state.conv?.id === c.id ? ' active' : '');
    const main = document.createElement('div');
    main.className = 'conv-main';
    const t = document.createElement('span');
    t.className = 'conv-title';
    t.textContent = c.title;
    main.append(t);
    const proj = state.projects.find((p) => p.id === c.projectId);
    if (proj && state.projectId == null) {
      const tag = document.createElement('small');
      tag.className = 'conv-proj';
      tag.textContent = proj.name;
      main.append(tag);
    }
    row.append(main);
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Delete this chat';
    del.onclick = (e) => {
      e.stopPropagation();
      deleteChat(c);
    };
    row.append(del);
    row.onclick = () => openConv(c.id);
    row.oncontextmenu = (e) => showContextMenu(e, [{ label: 'Delete this chat', danger: true, run: () => deleteChat(c) }]);
    cbox.append(row);
  }
}

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
const BROWSE_LABEL = IS_MAC ? 'Browse (show in Finder)' : 'Browse (open in File Explorer)';

// Ask the operating system for a folder with its own "choose a folder" window. Resolves to a path or null.
async function pickFolder(title) {
  const r = await api('/api/pick-folder', { method: 'POST', body: { title } });
  return r.path;
}

async function openProjectFolder(p) {
  try {
    await api(`/api/projects/${p.id}/open`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
}

// The "+" next to All projects: choose one folder and add it as a project.
async function addProjectViaPicker() {
  try {
    setStatus('Choose the project folder in the window that opened…');
    const dir = await pickFolder('Choose a project folder');
    if (!dir) return;
    const proj = await api('/api/projects', { method: 'POST', body: { path: dir } });
    await refresh();
    selectProject(proj.id);
  } catch (e) {
    alert(e.message);
  } finally {
    setStatus('');
  }
}

function selectProject(id) {
  state.projectId = id;
  state.conv = null; // a different project means a fresh conversation
  closeIfNarrow();
  renderSidebar();
  renderMessages();
  $('input').focus();
}

async function removeProject(p) {
  if (!confirm(`Remove "${p.name}" from the list?\n\nThe folder and its files are not touched, and your chats stay.\n\n${p.path}`)) return;
  await api(`/api/projects/${p.id}`, { method: 'DELETE' });
  if (state.projectId === p.id) {
    state.projectId = null;
    state.conv = null;
  }
  await refresh();
  renderMessages();
}

async function deleteChat(c) {
  if (!confirm(`Delete this chat?\n\n"${c.title}"`)) return;
  await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
  if (state.conv?.id === c.id) state.conv = null;
  await refresh();
  renderMessages();
}

// A small right-click menu. items: [{ label, danger?, run }]
function showContextMenu(e, items) {
  e.preventDefault();
  closeContextMenu();
  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.className = 'ctx-menu';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.onclick = () => {
      closeContextMenu();
      it.run();
    };
    menu.append(b);
  }
  document.body.append(menu);
  // keep it on screen
  const { offsetWidth: w, offsetHeight: h } = menu;
  menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - w - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - h - 4)) + 'px';
  // dismiss on the next click or right-click elsewhere; the listeners are removed again when the menu closes
  const dismiss = () => closeContextMenu(true);
  document.addEventListener('click', dismiss);
  document.addEventListener('contextmenu', dismiss);
  menuCleanup = () => {
    document.removeEventListener('click', dismiss);
    document.removeEventListener('contextmenu', dismiss);
  };
  // the right-click that opened this menu is still bubbling; start listening after it has finished
  menuCleanup.pending = true;
  setTimeout(() => (menuCleanup.pending = false));
}
let menuCleanup = null;
function closeContextMenu(fromEvent) {
  if (fromEvent === true && menuCleanup && menuCleanup.pending) return; // ignore the very event that opened the menu
  document.getElementById('ctx-menu')?.remove();
  if (menuCleanup) menuCleanup();
  menuCleanup = null;
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeContextMenu());
window.addEventListener('blur', closeContextMenu);

// Each mode remembers its own model choice (Code and Chat usually want different models).
const modelKey = () => `modelId:${state.mode}`;
function savedModel() {
  try {
    return localStorage.getItem(modelKey()) || (state.mode === 'chat' ? localStorage.getItem('modelId') : null);
  } catch {
    return null;
  }
}
function rememberModel(id) {
  try {
    localStorage.setItem(modelKey(), id);
  } catch {
    /* storage can be unavailable; the choice still applies for this session */
  }
}

// GPU memory in bytes, from the engine's hardware report (e.g. "12288 MiB" or "16 GB unified memory")
function vramBytes() {
  const m = String(state.engine?.gpu?.memory || '').match(/([\d.]+)\s*(MiB|GiB|GB)/i);
  if (!m) return 0;
  return Number(m[1]) * (/mib/i.test(m[2]) ? 1048576 : 1073741824);
}

// For Code mode, the biggest language model that fits comfortably in GPU memory: the agent re-reads a
// long prompt every step, so a model that spills to the CPU makes it painfully slow.
function bestFitModel(llms) {
  const v = vramBytes();
  if (!v) return null;
  return llms.filter((m) => m.exists && m.size <= v * 0.55).sort((a, b) => b.size - a.size)[0] || null;
}

// For Vector and 3D: one answer at a time, so quality matters more than speed. Take the biggest model that still fits in
// GPU memory (bigger models design and draw far better), falling back to the first one when the memory is unknown.
function bestQualityModel(llms) {
  const v = vramBytes();
  const ok = llms.filter((m) => m.exists !== false);
  return (v ? ok.filter((m) => m.size <= v * 0.85).sort((a, b) => b.size - a.size)[0] : null) || ok[0] || null;
}

function updateCodeWarning() {
  const el = $('code-warn');
  if (!el) return;
  const m = state.models.find((x) => x.id === $('model-select').value);
  const v = vramBytes();
  const tooBig = state.mode === 'code' && m && v && m.size > v * 0.7;
  el.hidden = !tooBig;
  if (tooBig) {
    const better = bestFitModel(state.models.filter((x) => x.kind !== 'image'));
    el.textContent = `⚠ ${m.name} (${fmtSize(m.size)}) is too big for your ${fmtSize(v)} GPU, so Code mode will be very slow.` + (better ? ` ${better.name} is much faster.` : ' A smaller model is much faster.');
  }
}

function renderModels() {
  const sel = $('model-select');
  const llms = state.models.filter((m) => m.kind !== 'image');
  const fit = state.mode === 'code' ? bestFitModel(llms) : null;
  const want = state.conv?.modelId || savedModel() || fit?.id || sel.value;
  sel.innerHTML = '';
  if (!llms.length) sel.append(new Option('No models yet — open Settings', ''));
  for (const m of llms) sel.append(new Option(m.name + (m.exists ? '' : ' (missing)'), m.id));
  if (want && llms.some((m) => m.id === want)) sel.value = want;
  updateCodeWarning();
}

function renderEngine() {
  const e = state.engine;
  const pill = $('engine-pill');
  if (!e.installed) {
    pill.textContent = 'Engine not installed';
    pill.className = 'pill bad';
  } else if (e.loaded) {
    pill.textContent = `Loaded: ${e.loaded.name}`;
    pill.className = 'pill ok';
  } else {
    pill.textContent = `Engine ${e.meta.tag} (${e.meta.backend}) — idle`;
    pill.className = 'pill';
  }
  const box = $('engine-box');
  const gpu = e.gpu.vendor === 'none' ? 'No supported GPU detected' : `${e.gpu.name} (${e.gpu.memory})`;
  box.innerHTML = `<div class="item"><div>${e.installed ? `llama.cpp <b>${esc(e.meta.tag)}</b> · ${esc(e.meta.backend)}` : 'Not installed'}<br><small>${esc(gpu)}</small></div><div></div></div>`;
  const actions = box.querySelector('.item div:last-child');
  for (const b of ['cuda', 'vulkan', 'cpu']) {
    const btn = document.createElement('button');
    btn.textContent = (e.installed ? 'Reinstall ' : 'Install ') + b.toUpperCase() + (b === e.recommended ? ' ★' : '');
    btn.disabled = e.installing;
    btn.onclick = async () => {
      btn.disabled = true;
      await api('/api/engine/install', { method: 'POST', body: { backend: b } });
    };
    actions.append(btn, ' ');
  }
  const prog = document.createElement('div');
  prog.id = 'engine-progress';
  box.append(prog);
}

// ---- messages ------------------------------------------------------------

function renderMessages() {
  const box = $('messages');
  const ph = $('placeholder');
  const chatLike = state.mode === 'chat' || state.mode === 'code';
  const simple = SIMPLE_MODES.includes(state.mode) && !state.adv[state.mode];
  box.hidden = !chatLike;
  ph.hidden = chatLike;
  $('composer').parentElement.hidden = !chatLike && !simple;
  $('attach').hidden = false;
  $('mic-open').hidden = state.mode !== 'transcribe';
  renderAttachments();
  $('code-bar').hidden = state.mode !== 'code';
  $('input').placeholder = state.mode === 'code' ? 'Describe a task for the agent in this project…' : simple ? SIMPLE_HINTS[state.mode].placeholder : 'Message your local model…';
  if (state.mode === 'code') {
    const proj = state.projects.find((p) => p.id === state.projectId);
    $('code-project').textContent = proj ? `Project: ${proj.name}` : 'No project selected — click a project name in the sidebar';
    $('code-project').className = 'pill' + (proj ? ' ok' : ' bad');
    $('code-shell').checked = !!state.settings?.codeAllowShell;
    updateCodeWarning();
  }
  $('model-select').hidden = !chatLike;
  if (!['transcribe', 'image', 'vector', '3d'].includes(state.mode)) {
    delete ph.dataset.view; // so the transcribe/image forms are rebuilt next time
    ph.style.textAlign = '';
  }
  if (simple) return renderSimple(ph, state.mode);
  if (state.mode === 'image') return addBackLink(ph, renderImage(ph));
  if (state.mode === 'vector') return addBackLink(ph, renderVector(ph));
  if (state.mode === '3d') return addBackLink(ph, renderThreeD(ph));
  if (state.mode === 'transcribe') return addBackLink(ph, renderTranscribe(ph));
  if (!chatLike) {
    const text = {
      transcribe: 'Transcribe mode will load a Whisper model and turn audio/video into text and captions.',
      image: 'Image mode will load an image model for generation and editing.',
    }[state.mode];
    ph.innerHTML = `<h1>${esc(state.mode[0].toUpperCase() + state.mode.slice(1))} mode</h1><p>${esc(text)}</p><p>Coming in a later stage.</p>`;
    return;
  }
  box.innerHTML = '';
  if (!state.conv || !state.conv.messages.length) {
    box.innerHTML =
      state.mode === 'code'
        ? '<div class="empty"><h1>Code</h1><p>An agent that reads and edits files in the selected project. Local models are slow at this, so keep tasks small.</p></div>'
        : '<div class="empty"><h1>LLM Icarus</h1><p>Pick a model and start chatting. Everything runs on this PC.</p></div>';
    return;
  }
  for (const m of state.conv.messages) box.append(msgEl(m));
  box.scrollTop = box.scrollHeight;
}

// Reasoning is collapsed by default, like Claude Desktop's "thinking" section.
function thinkingEl(text) {
  const d = document.createElement('details');
  d.className = 'thinking';
  const s = document.createElement('summary');
  s.textContent = 'Thinking';
  const body = document.createElement('div');
  body.textContent = text;
  d.append(s, body);
  return d;
}

function msgEl(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  if (m.thinking) el.append(thinkingEl(m.thinking));
  if (m.steps?.length) {
    // agent run: tool calls in order, with the model's own text between them
    for (const s of m.steps) el.append(s.kind === 'tool' ? toolEl(s) : textEl(s.text));
    return el;
  }
  const b = document.createElement('div');
  b.className = 'body';
  if (m.role === 'user') b.textContent = m.content;
  else b.innerHTML = render(m.content);
  el.append(b);
  return el;
}

function textEl(text) {
  const b = document.createElement('div');
  b.className = 'body';
  b.innerHTML = render(text);
  return b;
}

function toolSummary(s) {
  const i = s.input || {};
  const target = i.file_path || i.path || i.pattern || i.command || '';
  return `${s.name}${target ? ' · ' + String(target).split(/[\\/]/).slice(-2).join('/') : ''}`;
}

function toolEl(s) {
  const d = document.createElement('details');
  d.className = 'tool';
  const sum = document.createElement('summary');
  sum.textContent = toolSummary(s);
  const body = document.createElement('pre');
  setToolBody(body, s.input, s.result);
  d.append(sum, body);
  return d;
}

function setToolBody(body, input, result) {
  body.textContent = JSON.stringify(input, null, 2) + (result ? `\n\n→ ${result.error ? '(error) ' : ''}${result.text}` : '');
}

async function openConv(id) {
  closeIfNarrow();
  state.conv = await api(`/api/conversations/${id}`);
  state.projectId = state.conv.projectId;
  if (state.conv.modelId) $('model-select').value = state.conv.modelId;
  renderSidebar();
  renderMessages();
}

async function newChat(projectId = state.projectId) {
  closeIfNarrow();
  state.projectId = projectId;
  state.conv = null;
  renderSidebar();
  renderMessages();
  $('input').focus();
}

async function send() {
  if (SIMPLE_MODES.includes(state.mode)) return sendSimple();
  const typed = $('input').value.trim();
  const dropped = state.attach.filter((a) => a.text != null);
  if ((!typed && !dropped.length) || state.busy) return;
  // dropped text and code files travel inside the message, each under its name
  const text = (typed || 'Please look at the attached file.') + dropped.map((a) => `\n\nFile: ${a.name}\n\`\`\`\n${a.text.replace(/\n$/, '')}\n\`\`\``).join('');
  const modelId = $('model-select').value;
  if (!modelId) return setStatus('Add a model first (Settings > Models).');
  if (!state.engine.installed) return setStatus('Install the engine first (Settings > Engines).');
  rememberModel(modelId);

  if (state.mode === 'code' && !state.projectId) return setStatus('Pick a project first: click a project name in the sidebar.');
  if (!state.conv) state.conv = await api('/api/conversations', { method: 'POST', body: { projectId: state.projectId, mode: state.mode, modelId } });
  $('input').value = '';
  state.attach = [];
  renderAttachments();
  autosize();
  state.busy = true;
  updateBrand();
  $('send').textContent = 'Stop';

  const box = $('messages');
  if (!state.conv.messages.length) box.innerHTML = '';
  state.conv.messages.push({ role: 'user', content: text });
  box.append(msgEl({ role: 'user', content: text }));
  const reply = { role: 'assistant', content: '', thinking: '' };
  const el = msgEl({ role: 'assistant', content: '' });
  box.append(el);
  const body = el.querySelector('.body');
  let thinkEl = null;

  state.ctrl = new AbortController();
  setStatus(`Loading ${$('model-select').selectedOptions[0].text} if needed…`);
  try {
    const res = await fetch(`/api/conversations/${state.conv.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, modelId }),
      signal: state.ctrl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'thinking') {
          if (!thinkEl) {
            thinkEl = thinkingEl('');
            el.insertBefore(thinkEl, body);
          }
          setStatus('Thinking…');
          reply.thinking += ev.text;
          thinkEl.lastChild.textContent = reply.thinking;
        } else if (ev.type === 'delta') {
          setStatus('');
          reply.content += ev.text;
          body.innerHTML = render(reply.content);
        } else if (ev.type === 'text') {
          // agent message: lives in its own block, before the next tool call
          body.remove();
          el.append(textEl(ev.text));
          setStatus('Agent working…');
        } else if (ev.type === 'tool') {
          body.remove();
          const t = toolEl({ name: ev.name, input: ev.input });
          t.dataset.id = ev.id;
          el.append(t);
          setStatus(`Running ${ev.name}…`);
        } else if (ev.type === 'tool-result') {
          const t = el.querySelector(`details[data-id="${ev.id}"]`);
          if (t) setToolBody(t.querySelector('pre'), JSON.parse(t.querySelector('pre').textContent.split('\n\n→')[0]), { text: ev.text, error: ev.error });
          setStatus('Agent working…');
        } else if (ev.type === 'error') {
          setStatus('Error: ' + ev.message);
        }
        box.scrollTop = box.scrollHeight;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('Error: ' + e.message);
  }
  state.busy = false;
  updateBrand();
  $('send').textContent = 'Send';
  if (/^(Agent working|Thinking|Running|Loading)/.test($('status-line').textContent)) setStatus('');
  const id = state.conv.id;
  await refresh();
  state.conv = await api(`/api/conversations/${id}`);
  renderSidebar();
}

function setStatus(t) {
  $('status-line').textContent = t;
}

function autosize() {
  const i = $('input');
  i.style.height = 'auto';
  i.style.height = Math.min(i.scrollHeight, 220) + 'px';
}

// ---- drop-a-file view for Transcribe, Image, Vector and 3D ------------------------
// These modes work like Chat: drop files into the box, type what you want, press Send. intent.js turns that into the
// request each mode needs. "Advanced options" opens the old form with every setting.

const SIMPLE_HINTS = {
  transcribe: { title: 'Transcribe', list: 'tr-list', msg: 'tr-msg', placeholder: 'Drop audio or video files here and press Send (add a language if you like: "in Spanish")', text: 'Drop in audio or video files to get the text and captions back. Or click the microphone to speak.' },
  image: { title: 'Image', list: 'im-list', msg: 'im-msg', placeholder: 'Describe a picture. Drop a picture here to change it instead.', text: 'Describe a picture, or drop one in and say what to change. You can add a size ("portrait", "1216x832") and "4 images".' },
  vector: { title: 'Vector', list: 'vc-list', msg: 'vc-msg', placeholder: 'Describe a drawing, or drop a picture to trace it', text: 'Describe a drawing and SDXL paints it and traces it, or drop a picture to trace it exactly. Add "black and white", "80 mm wide" or "remove the background" if you want them. You get SVG and EPS files.' },
  '3d': { title: '3D', list: 'td-list', msg: 'td-msg', placeholder: 'Describe a part with its sizes (40 x 20 x 10 mm), or drop front, side and top pictures', text: 'Describe a part with its sizes and the chat model designs it. Or drop pictures of an object (name them front, side and top, or drop them in that order) with its real size, for example "80 mm tall", and a solid is carved from them. For a long rounded thing such as a banana, a carrot or a bone, just name it ("a banana", or "a carrot 180 mm long"): the image model draws it and a solid is built from the picture, at a size the chat model knows if you give none. You get an STL file.' },
};
const SIMPLE_MODES = Object.keys(SIMPLE_HINTS);

function renderSimple(ph, mode) {
  ph.hidden = false;
  const h = SIMPLE_HINTS[mode];
  if (ph.dataset.view !== 'simple-' + mode) {
    ph.dataset.view = 'simple-' + mode;
    ph.style.textAlign = 'left';
    ph.innerHTML = `
      <div class="tr-wrap sv">
        <div class="sv-head"><h2>${h.title}</h2><button id="sv-adv" type="button" class="ghost">Advanced options</button></div>
        <p class="muted">${h.text}</p>
        <div id="sv-setup"></div>
        ${mode === 'vector' ? '<div id="vc-setup"></div>' : mode === '3d' ? '<div id="td-setup"></div>' : ''}
        <div id="${h.msg}" class="muted"></div>
        <div id="${h.list}" class="sv-feed"></div>
      </div>`;
    $('sv-adv').onclick = () => toAdvanced(mode);
  }
  ({ transcribe: renderTranscriptList, image: renderImageList, vector: renderVectorList, '3d': renderThreeDList })[mode]();
  if (mode === 'vector') renderVectorSetup();
  if (mode === '3d') renderThreeDSetup();
  simpleSetup(mode);
  ph.scrollTop = ph.scrollHeight;
}

// what is still missing for Transcribe and Image (Vector and 3D have their own install buttons)
async function simpleSetup(mode) {
  if (mode !== 'transcribe' && mode !== 'image') return;
  const c = await api('/api/components').catch(() => null);
  const box = $('sv-setup');
  if (!c || !box || state.mode !== mode) return;
  box.innerHTML = '';
  const need = mode === 'transcribe' ? (!c.whisper.installed && ['whisper', 'the speech-to-text tools']) : (!c.image.installed && ['image', 'the image tools']);
  if (need) {
    box.innerHTML = `<div class="tr-err">${esc(need[1])} are not installed yet (a download from the internet).</div>`;
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = `Install ${need[1]}`;
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = 'Installing… (progress is shown at the bottom)';
      try {
        await api('/api/components/install', { method: 'POST', body: { feature: need[0] } });
      } catch (e) {
        b.disabled = false;
        setStatus(e.message);
      }
    };
    box.append(b);
  } else if (mode === 'image' && !state.models.some((m) => m.kind === 'image')) {
    box.innerHTML = '<p class="muted">No image model yet. Open Advanced options to download SDXL, or add a checkpoint in Settings > Models.</p>';
  }
}

function toAdvanced(mode) {
  state.adv[mode] = true;
  renderMessages();
}

// the way back from an advanced screen
function addBackLink(ph) {
  const wrap = ph.querySelector('.tr-wrap');
  if (!wrap || wrap.querySelector('.sv-back')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sv-back ghost';
  b.textContent = '← Back to the simple view';
  b.onclick = () => {
    if (mic) stopDictation();
    state.adv[state.mode] = false;
    renderMessages();
  };
  wrap.prepend(b);
}

// ---- files dropped into the box ----

function renderAttachments() {
  const box = $('attach-chips');
  box.innerHTML = '';
  if (state.base && state.base.mode === state.mode) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `Editing ${esc(state.base.label)}: say what should change`;
    c.append(chipX(() => (state.base = null)));
    box.append(c);
  }
  for (const a of state.attach) {
    const c = document.createElement('span');
    c.className = 'chip';
    if (a.preview) c.innerHTML = `<img src="${esc(a.preview)}" alt="">`;
    c.append(document.createTextNode(a.name + (a.uploading ? ' (uploading…)' : '')));
    c.append(chipX(() => (state.attach = state.attach.filter((x) => x !== a))));
    box.append(c);
  }
  box.hidden = !box.children.length;
}

function chipX(remove) {
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'chip-x';
  x.textContent = '✕';
  x.title = 'Remove';
  x.onclick = () => {
    remove();
    renderAttachments();
  };
  return x;
}

const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|js|mjs|ts|tsx|jsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|html?|css|scss|csv|tsv|xml|ya?ml|toml|ini|cfg|log|sql|sh|bat|ps1|svg|tex|srt|vtt|scad|swift|kt|lua|r)$/i;

// Chat and Code: text and code files are read here and sent inside the message
async function addTextFiles(files) {
  for (const f of files) {
    if (!(f.type?.startsWith('text/') || TEXT_EXT.test(f.name || ''))) {
      setStatus(`${f.name}: Chat and Code take text and code files. Use Transcribe for audio or video, and Image, Vector or 3D for pictures.`);
      continue;
    }
    if (f.size > 150000 || state.attach.reduce((n, a) => n + (a.text?.length || 0), 0) + f.size > 300000) {
      setStatus(`${f.name} is too big to put in a message (150 KB per file, 300 KB in all). Paste the part you need instead.`);
      continue;
    }
    state.attach.push({ name: f.name, text: await f.text() });
    renderAttachments();
  }
}

async function addFiles(files) {
  if (state.adv[state.mode]) return setStatus('Switch back to the simple view to drop files.');
  if (state.mode === 'chat' || state.mode === 'code') return addTextFiles(files);
  for (const f of files) {
    const a = { name: f.name || 'pasted-picture.png', preview: f.type?.startsWith('image/') ? URL.createObjectURL(f) : null, uploading: true };
    state.attach.push(a);
    renderAttachments();
    // Send waits on `done`, so pressing it while a big file is still uploading just works
    a.done = (async () => {
      try {
        const res = await fetch('/api/upload?name=' + encodeURIComponent(a.name), { method: 'POST', body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        a.path = data.path;
        a.uploading = false;
      } catch (e) {
        state.attach = state.attach.filter((x) => x !== a);
        setStatus(`Could not add ${a.name}: ${e.message}`);
      }
      renderAttachments();
    })();
  }
}

// one of our own earlier results, used again as an input (path form understood by the server)
function attachResult(path, name, preview) {
  if (!state.attach.some((a) => a.path === path)) state.attach.push({ path, name, preview });
  renderAttachments();
  $('input').focus();
}

function setBase(mode, id, label) {
  state.base = { mode, id, label };
  renderAttachments();
  $('input').focus();
}

async function sendSimple() {
  const mode = state.mode;
  const text = $('input').value.trim();
  if (state.attach.some((a) => a.uploading)) {
    setStatus('Waiting for your file to finish uploading…');
    const pending = [...state.attach];
    await Promise.all(pending.map((a) => a.done));
    if (pending.some((a) => !a.path)) return; // the failure message is already showing
    setStatus('');
  }
  const llms = state.models.filter((m) => m.kind !== 'image');
  const imgs = state.models.filter((m) => m.kind === 'image');
  const ctx = { llmId: bestQualityModel(llms)?.id, imageModelId: imgs[0]?.id, sdxlReady: !!(state.image?.installed && imgs.length), base: state.base?.mode === mode ? state.base.id : null };
  const plan = planJob(mode, text, state.attach, ctx);
  if (plan.error) return setStatus(plan.error);
  setStatus('');
  try {
    for (const r of plan.requests) await api(r.url, { method: 'POST', body: r.body });
  } catch (e) {
    return setStatus(e.message);
  }
  $('input').value = '';
  autosize();
  state.attach = [];
  state.base = null;
  [state.transcripts, state.image, state.vector, state.threed] = await Promise.all([api('/api/transcribe'), api('/api/image'), api('/api/vector'), api('/api/3d')]);
  renderMessages();
}

// ---- transcribe mode -----------------------------------------------------

const LANGS = [['auto', 'Auto-detect'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ja', 'Japanese'], ['zh', 'Chinese']];
const live = {}; // job id -> latest transcribed lines while running

function renderTranscribe(ph) {
  ph.hidden = false;
  if (ph.dataset.view !== 'transcribe') {
    ph.dataset.view = 'transcribe';
    ph.style.textAlign = 'left';
    ph.innerHTML = `
      <div class="tr-wrap">
        <h2>Transcribe</h2>
        <p class="muted">Turns speech into text and an .srt caption file using Whisper large-v3 on your GPU: speak into your microphone, or give it an audio or video file. The chat model is unloaded while it runs.</p>
        <div class="mic-box">
          <div class="row">
            <button id="mic-go" class="primary">🎤 Start listening</button>
            <select id="mic-device" title="Which microphone to use"></select>
            <span class="mic-meter" title="Input level"><span id="mic-level"></span></span>
          </div>
          <div id="mic-msg" class="muted">Speak, then pause: each sentence appears a moment after you stop. Only the text is kept; the sound is never saved.</div>
          <div id="mic-text" class="mic-text" hidden></div>
          <div class="row" id="mic-actions" hidden><button id="mic-copy" type="button">Copy text</button></div>
        </div>
        <div class="row"><input id="tr-path" placeholder="Full path to an audio/video file, e.g. C:\\Users\\YourName\\Videos\\clip.mp4"></div>
        <div class="row">
          <select id="tr-lang">${LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select>
          <button id="tr-go" class="primary">Transcribe</button>
          <label class="ghost-label">or <input id="tr-file" type="file" accept="audio/*,video/*" hidden><button id="tr-pick" type="button">Upload a file…</button></label>
        </div>
        <div id="tr-msg" class="muted"></div>
        <div id="tr-list"></div>
      </div>`;
    $('tr-go').onclick = () => startTranscribe($('tr-path').value.trim());
    $('tr-pick').onclick = () => $('tr-file').click();
    $('tr-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      $('tr-msg').textContent = `Uploading ${f.name}…`;
      try {
        const res = await fetch('/api/transcribe/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        await startTranscribe(data.path);
      } catch (err) {
        $('tr-msg').textContent = 'Upload failed: ' + err.message;
      }
      e.target.value = '';
    };
    $('tr-path').addEventListener('keydown', (e) => e.key === 'Enter' && $('tr-go').click());
    $('mic-go').onclick = () => (mic ? stopDictation() : startDictation());
    $('mic-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText($('mic-text').textContent.replace(/ …$/, ''));
        $('mic-copy').textContent = 'Copied';
      } catch {
        $('mic-copy').textContent = 'Select the text and press Ctrl+C';
      }
      setTimeout(() => ($('mic-copy').textContent = 'Copy text'), 2000);
    };
    $('mic-device').onchange = () => {
      try {
        localStorage.setItem('micDevice', $('mic-device').value);
      } catch {
        /* storage blocked: the choice just is not remembered */
      }
    };
  }
  fillMicDevices();
  renderTranscriptList();
}

// ---- microphone dictation --------------------------------------------------
// The page listens, cuts speech into sentences at pauses, and sends each one as raw 16 kHz 16-bit audio to
// /api/dictate; the server keeps Whisper loaded between sentences, so each appears a moment after you stop speaking.

let mic = null; // the running session
const micMsg = (t) => $('mic-msg') && ($('mic-msg').textContent = t);
const MIC_FRAME = 320; // 20 ms at 16 kHz

async function fillMicDevices() {
  const sel = $('mic-device');
  if (!sel || !navigator.mediaDevices?.enumerateDevices) return;
  let saved = '';
  try {
    saved = localStorage.getItem('micDevice') || '';
  } catch {
    /* ignore */
  }
  const keep = sel.value || saved;
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  sel.innerHTML = '';
  sel.append(new Option('Default microphone', ''));
  inputs.filter((d) => d.deviceId && d.deviceId !== 'default').forEach((d, i) => sel.append(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function micError(e) {
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
    return 'Microphone access was blocked. Allow it when asked, and make sure Windows lets desktop apps use the microphone (Settings > Privacy & security > Microphone). Then click Start again.';
  }
  if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return 'No microphone was found. Plug one in or pick another from the list.';
  if (e.name === 'NotReadableError') return 'The microphone is being used by another program. Close it there and try again.';
  return e.message || String(e);
}

async function startDictation() {
  const btn = $('mic-go');
  btn.disabled = true;
  micMsg('Waiting for the microphone…');
  let stream;
  try {
    const dev = $('mic-device').value;
    stream = window.__micTestStream || (await navigator.mediaDevices.getUserMedia({ audio: { ...(dev && { deviceId: { exact: dev } }), echoCancellation: true, noiseSuppression: true, autoGainControl: true } }));
  } catch (e) {
    btn.disabled = false;
    return micMsg(micError(e));
  }
  fillMicDevices(); // the names show up once access is granted
  micMsg('Loading Whisper (this takes about 10 seconds)…');
  let sess;
  try {
    sess = await api('/api/dictate/start', { method: 'POST', body: { language: $('tr-lang').value } });
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    btn.disabled = false;
    return micMsg(e.message);
  }
  try {
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();
    await ctx.audioWorklet.addModule('/mic-worklet.js');
    const node = new AudioWorkletNode(ctx, 'mic-tap');
    ctx.createMediaStreamSource(stream).connect(node); // not connected to the speakers: no echo
    mic = { id: sess.id, stream, ctx, node, carry: new Float32Array(0), t: 0, noise: 0.005, speaking: false, buf: [], pre: [], silence: 0, voiced: 0, startT: 0, seq: 0, pending: 0, results: new Map(), nextShow: 0, text: [] };
    node.port.onmessage = (e) => micFeed(e.data);
    mic.beat = setInterval(() => fetch('/api/dictate').catch(() => {}), 60000); // lets the server know we are still here
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    await api(`/api/dictate/${sess.id}/stop`, { method: 'POST' }).catch(() => {});
    btn.disabled = false;
    return micMsg('Could not start listening: ' + e.message);
  }
  btn.disabled = false;
  btn.textContent = '■ Stop';
  $('mic-text').hidden = false;
  $('mic-text').textContent = '';
  $('mic-actions').hidden = true;
  micMsg('Listening… speak, then pause.');
}

function micFeed(block) {
  const m = mic;
  if (!m || m.stopping) return;
  const all = new Float32Array(m.carry.length + block.length);
  all.set(m.carry);
  all.set(block, m.carry.length);
  let i = 0;
  for (; i + MIC_FRAME <= all.length; i += MIC_FRAME) micFrame(m, all.subarray(i, i + MIC_FRAME));
  m.carry = all.slice(i);
}

// One 20 ms frame: loudness decides whether you are speaking; 0.7 s of quiet ends a sentence.
function micFrame(m, f) {
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  const rms = Math.sqrt(sum / f.length);
  m.t += 0.02;
  const bar = $('mic-level');
  if (bar) bar.style.width = Math.min(100, rms * 500) + '%';
  if (!m.speaking) m.noise = Math.min(0.03, Math.max(0.002, m.noise * 0.95 + rms * 0.05)); // learns the room's background level
  const loud = rms > Math.max(0.012, m.noise * 3);
  const frame = f.slice();
  if (loud) {
    if (!m.speaking) {
      m.speaking = true;
      m.buf = [...m.pre];
      m.startT = Math.max(0, m.t - 0.02 * (m.pre.length + 1));
      m.silence = 0;
      m.voiced = 0;
    }
    m.buf.push(frame);
    m.silence = 0;
    m.voiced++;
  } else if (m.speaking) {
    m.buf.push(frame);
    if (++m.silence >= 35) micEnd(m);
  } else {
    m.pre.push(frame); // keep the last 0.3 s so the start of a word is not clipped
    if (m.pre.length > 15) m.pre.shift();
  }
  if (m.speaking && m.buf.length >= 1250) micEnd(m); // 25 s without a pause: cut here anyway
}

function micEnd(m) {
  const frames = m.buf.slice(0, m.buf.length - Math.max(0, m.silence - 12)); // keep 0.25 s of the pause
  const voiced = m.voiced;
  Object.assign(m, { speaking: false, buf: [], pre: [], silence: 0, voiced: 0 });
  if (voiced < 10) return; // under 0.2 s of sound: a click or a cough
  const pcm = new Int16Array(frames.length * MIC_FRAME);
  frames.forEach((fr, k) => fr.forEach((v, j) => (pcm[k * MIC_FRAME + j] = Math.max(-1, Math.min(1, v)) * 32767)));
  const seq = m.seq++;
  m.pending++;
  showMic(m);
  fetch(`/api/dictate/${m.id}/chunk?seq=${seq}&offset=${m.startT.toFixed(2)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm.buffer })
    .then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      return j.text;
    })
    .catch((e) => {
      micMsg('One sentence could not be transcribed: ' + e.message);
      return '';
    })
    .then((text) => m.results.set(seq, text))
    .finally(() => {
      m.pending--;
      showMic(m);
    });
}

// sentences can finish out of order: show them in the order they were spoken
function showMic(m) {
  while (m.results.has(m.nextShow)) {
    const t = m.results.get(m.nextShow);
    m.results.delete(m.nextShow++);
    if (t) m.text.push(t);
  }
  const box = $('mic-text');
  if (box) {
    box.textContent = m.text.join(' ') + (m.pending ? ' …' : '');
    box.scrollTop = box.scrollHeight;
  }
}

async function stopDictation() {
  const m = mic;
  if (!m) return;
  m.stopping = true;
  const btn = $('mic-go');
  if (btn) btn.disabled = true;
  micMsg('Finishing…');
  if (m.speaking) micEnd(m);
  clearInterval(m.beat);
  m.node.port.onmessage = null;
  m.node.disconnect();
  m.stream.getTracks().forEach((t) => t.stop());
  m.ctx.close().catch(() => {});
  while (m.pending) await new Promise((r) => setTimeout(r, 150));
  showMic(m);
  let res = null;
  try {
    res = await api(`/api/dictate/${m.id}/stop`, { method: 'POST' });
  } catch (e) {
    micMsg(e.message);
  }
  mic = null;
  if ($('mic-go')) {
    $('mic-go').disabled = false;
    $('mic-go').textContent = '🎤 Start listening';
    $('mic-level').style.width = '0';
    $('mic-actions').hidden = !m.text.length;
    if (res) micMsg(res.transcript ? `Saved in the list below as "${res.transcript.name}" (with .srt and .txt downloads).` : 'Nothing was heard.');
  }
  state.transcripts = await api('/api/transcribe');
  if (state.mode === 'transcribe') renderTranscriptList();
}

// closing or reloading the window must not leave the microphone session (and Whisper on the GPU) running
window.addEventListener('pagehide', () => {
  if (mic) navigator.sendBeacon(`/api/dictate/${mic.id}/stop`);
});

async function startTranscribe(path) {
  if (!path) return;
  $('tr-msg').textContent = '';
  try {
    await api('/api/transcribe', { method: 'POST', body: { path, language: $('tr-lang').value } });
    $('tr-path').value = '';
    state.transcripts = await api('/api/transcribe');
    renderTranscriptList();
  } catch (e) {
    $('tr-msg').textContent = e.message;
  }
}

function renderTranscriptList() {
  const box = $('tr-list');
  if (!box) return;
  box.innerHTML = '';
  for (const j of state.transcripts || []) {
    const el = document.createElement('div');
    el.className = 'tr-job';
    const active = ['queued', 'loading', 'running'].includes(j.status);
    const info = [j.language && `language: ${j.language}`, j.duration && `${Math.round(j.duration)} s`, j.device, j.segments != null && `${j.segments} lines`].filter(Boolean).join(' · ');
    el.innerHTML = `<div class="tr-head"><b>${esc(j.name)}</b><span class="pill ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'bad' : ''}">${esc(j.status)}${active && j.status === 'running' ? ` ${Math.round(j.percent || 0)}%` : ''}</span></div>
      <small class="muted">${esc(info)}</small>`;
    if (active) {
      el.insertAdjacentHTML('beforeend', `<div class="bar"><div style="width:${j.percent || 0}%"></div></div><div class="tr-live">${esc((live[j.id] || []).slice(-3).join('\n'))}</div>`);
      const stop = document.createElement('button');
      stop.textContent = 'Cancel';
      stop.onclick = () => api(`/api/transcribe/${j.id}/cancel`, { method: 'POST' });
      el.append(stop);
    } else if (j.status === 'error') {
      el.insertAdjacentHTML('beforeend', `<div class="tr-err">${esc(j.error || 'Failed')}</div>`);
    }
    if (j.status === 'done') {
      const actions = document.createElement('div');
      actions.className = 'row';
      actions.innerHTML = `<a href="/api/transcribe/${j.id}/file/srt?download=1"><button>Download .srt</button></a><a href="/api/transcribe/${j.id}/file/txt?download=1"><button>Download .txt</button></a>`;
      const view = document.createElement('details');
      view.innerHTML = '<summary>Show text</summary><pre class="tr-text">Loading…</pre>';
      view.ontoggle = async () => {
        if (!view.open) return;
        const r = await fetch(`/api/transcribe/${j.id}/file/txt`);
        view.querySelector('pre').textContent = r.ok ? await r.text() : '(text not available)';
      };
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm(`Delete the transcript of ${j.name}? (the original file is not touched)`)) return;
        await api(`/api/transcribe/${j.id}`, { method: 'DELETE' });
        state.transcripts = await api('/api/transcribe');
        renderTranscriptList();
      };
      actions.append(del);
      el.append(actions, view);
    }
    box.append(el);
  }
  if (!state.transcripts?.length) box.innerHTML = '<p class="muted">No transcripts yet.</p>';
}

function onTranscribeEvent(ev) {
  if (ev.type === 'transcribe-segment') {
    (live[ev.id] ||= []).push(ev.text);
    const j = state.transcripts.find((x) => x.id === ev.id);
    if (j) {
      j.percent = ev.percent;
      j.status = 'running';
    }
  } else {
    const i = state.transcripts.findIndex((x) => x.id === ev.id);
    const job = { ...ev };
    delete job.type;
    if (i >= 0) state.transcripts[i] = job;
    else state.transcripts.unshift(job);
    if (ev.status === 'loading') setStatus('Whisper is loading…');
    if (ev.status === 'done' || ev.status === 'error') setStatus('');
    if (state.engine) state.engine.loaded = null;
  }
  updateBrand();
  if (state.mode === 'transcribe') renderTranscriptList();
}

// ---- image mode ----------------------------------------------------------

const SDXL_BASE = 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors';
const SIZES = [['1024x1024', 'Square 1024×1024'], ['832x1216', 'Portrait 832×1216'], ['1216x832', 'Landscape 1216×832'], ['768x768', 'Small square 768×768 (faster)']];
let initImage = null; // { path, name } chosen for image-to-image

function renderImage(ph) {
  ph.hidden = false;
  const imageModels = state.models.filter((m) => m.kind === 'image');
  if (ph.dataset.view !== 'image') {
    ph.dataset.view = 'image';
    ph.style.textAlign = 'left';
    ph.innerHTML = `
      <div class="tr-wrap">
        <h2>Image</h2>
        <p class="muted">Generate or edit pictures with an SDXL checkpoint on your GPU. The chat model is unloaded while it runs.</p>
        <div id="im-setup"></div>
        <div class="row"><select id="im-model"></select></div>
        <textarea id="im-prompt" rows="3" placeholder="Describe the picture…" class="wide"></textarea>
        <div class="row">
          <select id="im-size">${SIZES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select>
          <select id="im-count">${[1, 2, 4].map((n) => `<option value="${n}">${n} image${n > 1 ? 's' : ''}</option>`).join('')}</select>
          <button id="im-go" class="primary">Generate</button>
        </div>
        <div class="row">
          <input id="im-file" type="file" accept="image/*" hidden>
          <button id="im-pick" type="button">Edit an existing image…</button>
          <span id="im-init" class="muted"></span>
        </div>
        <div id="im-strength-row" class="row" hidden><label class="muted">Change amount <input id="im-strength" type="range" min="0.2" max="0.95" step="0.05" value="0.6"> <span id="im-strength-val">0.6</span></label></div>
        <details><summary class="muted">Advanced</summary>
          <textarea id="im-neg" rows="2" class="wide" placeholder="Negative prompt (what to avoid)"></textarea>
          <div class="row"><label class="muted">Steps <input id="im-steps" type="number" min="5" max="80" value="25" class="num"></label>
          <label class="muted">Guidance <input id="im-guid" type="number" min="1" max="20" step="0.5" value="6" class="num"></label>
          <label class="muted">Seed <input id="im-seed" type="number" value="-1" class="num"> <small>(-1 = random)</small></label></div>
        </details>
        <div id="im-msg" class="muted"></div>
        <div id="im-list"></div>
      </div>`;
    $('im-go').onclick = generateImage;
    $('im-pick').onclick = () => $('im-file').click();
    $('im-strength').oninput = (e) => ($('im-strength-val').textContent = e.target.value);
    $('im-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      $('im-msg').textContent = `Uploading ${f.name}…`;
      try {
        const res = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setInitImage(data.path, f.name);
        $('im-msg').textContent = '';
      } catch (err) {
        $('im-msg').textContent = 'Upload failed: ' + err.message;
      }
      e.target.value = '';
    };
  }
  const sel = $('im-model');
  const keep = sel.value;
  sel.innerHTML = '';
  for (const m of imageModels) sel.append(new Option(m.name, m.id));
  if (keep && imageModels.some((m) => m.id === keep)) sel.value = keep;
  $('im-setup').innerHTML = '';
  if (!state.image?.installed) {
    $('im-setup').innerHTML = '<div class="tr-err">The image engine (data/image-env) is not installed.</div>';
  } else if (!imageModels.length) {
    const box = $('im-setup');
    box.innerHTML = '<p class="muted">No image model yet. Add an SDXL checkpoint (.safetensors) from Settings > Models, or get the official one:</p>';
    const b = document.createElement('button');
    b.textContent = 'Download SDXL base 1.0 (6.9 GB, Hugging Face)';
    b.onclick = async () => {
      if (!confirm('Download sd_xl_base_1.0.safetensors (6.9 GB) from huggingface.co/stabilityai? It uses the CreativeML OpenRAIL++-M license.')) return;
      await api('/api/models/download', { method: 'POST', body: { url: SDXL_BASE } });
      box.textContent = 'Downloading… progress is shown in Settings > Models.';
    };
    box.append(b);
  }
  renderImageList();
}

function setInitImage(path, name) {
  initImage = path ? { path, name } : null;
  $('im-init').textContent = initImage ? `Editing: ${initImage.name}` : '';
  $('im-strength-row').hidden = !initImage;
  if (initImage) {
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Back to generating from text';
    x.onclick = () => setInitImage(null);
    $('im-init').append(' ', x);
  }
}

async function generateImage() {
  const [width, height] = $('im-size').value.split('x').map(Number);
  $('im-msg').textContent = '';
  try {
    await api('/api/image', {
      method: 'POST',
      body: {
        modelId: $('im-model').value, prompt: $('im-prompt').value, negative: $('im-neg').value, width, height,
        steps: +$('im-steps').value, guidance: +$('im-guid').value, seed: +$('im-seed').value, count: +$('im-count').value,
        ...(initImage && { initImage: initImage.path, strength: +$('im-strength').value }),
      },
    });
    state.image = await api('/api/image');
    renderImageList();
  } catch (e) {
    $('im-msg').textContent = e.message;
  }
}

function renderImageList() {
  const box = $('im-list');
  if (!box) return;
  box.innerHTML = '';
  for (const j of state.image?.jobs || []) {
    const el = document.createElement('div');
    el.className = 'tr-job';
    const active = ['queued', 'loading', 'running'].includes(j.status);
    const pct = j.total ? Math.round(((j.image || 0) + (j.step || 0) / j.total) / j.count * 100) : 0;
    el.innerHTML = `<div class="tr-head"><span>${esc(j.prompt)}</span><span class="pill ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'bad' : ''}">${esc(j.status)}${j.status === 'running' ? ` ${pct}%` : ''}</span></div>
      <small class="muted">${esc(j.model || '')} · ${j.width}×${j.height} · ${j.steps} steps${j.strength ? ` · edit ${j.strength}` : ''}</small>`;
    if (active) {
      el.insertAdjacentHTML('beforeend', `<div class="bar"><div style="width:${pct}%"></div></div>`);
      const stop = document.createElement('button');
      stop.textContent = 'Cancel';
      stop.onclick = () => api(`/api/image/${j.id}/cancel`, { method: 'POST' });
      el.append(stop);
    } else if (j.status === 'error') {
      el.insertAdjacentHTML('beforeend', `<div class="tr-err">${esc(j.error || 'Failed')}</div>`);
    }
    if (j.files?.length) {
      const grid = document.createElement('div');
      grid.className = 'im-grid';
      for (const f of j.files) {
        const cell = document.createElement('div');
        cell.innerHTML = `<a href="/api/image/${j.id}/${f.file}" target="_blank"><img src="/api/image/${j.id}/${f.file}" alt=""></a><small class="muted">seed ${f.seed}</small>`;
        const edit = document.createElement('button');
        edit.textContent = 'Edit this';
        edit.onclick = () => {
          if (!$('im-init')) {
            attachResult(`image:${j.id}/${f.file}`, `${j.id}/${f.file}`, `/api/image/${j.id}/${f.file}`);
            $('input').value = j.prompt;
            return autosize();
          }
          setInitImage(`image:${j.id}/${f.file}`, `${j.id}/${f.file}`);
          $('im-prompt').value = j.prompt;
          $('im-prompt').focus();
        };
        const dl = document.createElement('a');
        dl.href = `/api/image/${j.id}/${f.file}?download=1`;
        dl.innerHTML = '<button>Save</button>';
        cell.append(edit, dl);
        grid.append(cell);
      }
      el.append(grid);
    }
    if (!active) {
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm('Delete this image set?')) return;
        await api(`/api/image/${j.id}`, { method: 'DELETE' });
        state.image = await api('/api/image');
        renderImageList();
      };
      el.append(del);
    }
    box.append(el);
  }
  if (!state.image?.jobs?.length) box.innerHTML = '<p class="muted">No images yet.</p>';
}

function onImageEvent(ev) {
  const job = { ...ev };
  delete job.type;
  const jobs = (state.image ||= { installed: true, jobs: [] }).jobs;
  const i = jobs.findIndex((x) => x.id === ev.id);
  if (i >= 0) jobs[i] = job;
  else jobs.unshift(job);
  if (state.engine && ['loading', 'running'].includes(ev.status)) state.engine.loaded = null;
  updateBrand();
  if (state.mode === 'image') renderImageList();
}

// ---- vector mode ----------------------------------------------------------

let vcRef = null; // { path, name }: a reference picture for tracing, or to guide SDXL
let vcBase = null; // id of an earlier drawing the chat model should edit

function renderVector(ph) {
  ph.hidden = false;
  if (ph.dataset.view !== 'vector') {
    ph.dataset.view = 'vector';
    ph.style.textAlign = 'left';
    ph.innerHTML = `
      <div class="tr-wrap">
        <h2>Vector</h2>
        <p class="muted">Make drawings for Illustrator, Inkscape, cutters and print shops: SVG and EPS files, from a description or from a picture.</p>
        <div id="vc-setup"></div>
        <div class="row"><label class="muted">How <select id="vc-method">
          <option value="sdxl">Describe it: SDXL paints it, then it is traced (best for illustrations and logos)</option>
          <option value="llm">Describe it: the chat model writes the shapes (only for very simple icons; crude otherwise)</option>
          <option value="trace">Trace a picture (an exact copy of your image)</option>
        </select></label></div>
        <textarea id="vc-prompt" rows="3" class="wide" placeholder="Describe the drawing…"></textarea>
        <div id="vc-base" class="muted"></div>
        <div class="row" id="vc-ref-row">
          <input id="vc-file" type="file" accept="image/*" hidden>
          <button id="vc-pick" type="button">Choose a reference picture…</button>
          <span id="vc-ref" class="muted"></span>
        </div>
        <div class="row" id="vc-llm-row">
          <label class="muted">Model <select id="vc-model"></select></label>
          <label class="muted">Shape <select id="vc-aspect"><option value="square">Square</option><option value="wide">Wide</option><option value="tall">Tall</option></select></label>
          <label class="muted" title="The model reasons before it draws: slower, but the drawings are noticeably better"><input type="checkbox" id="vc-think" checked> Think longer</label>
        </div>
        <div class="row" id="vc-sdxl-row">
          <label class="muted">Image model <select id="vc-imodel"></select></label>
          <label class="muted" id="vc-strength-label">Follow the picture <input id="vc-strength" type="range" min="0.2" max="0.95" step="0.05" value="0.6"> <span id="vc-strength-val">0.6</span></label>
        </div>
        <div class="row" id="vc-trace-row">
          <label class="muted">Colors <select id="vc-colors"><option value="color">Full color</option><option value="binary">Black and white</option></select></label>
          <label class="muted">Detail <input id="vc-detail" type="range" min="1" max="5" step="1" value="3"> <span id="vc-detail-val">3</span></label>
          <label class="muted"><input type="checkbox" id="vc-nobg"> Remove the white background</label>
        </div>
        <div class="row">
          <label class="muted">EPS width in mm <input id="vc-width" type="number" min="5" max="5000" placeholder="(as drawn)" class="num"></label>
          <button id="vc-go" class="primary">Create</button>
        </div>
        <div id="vc-msg" class="muted"></div>
        <div id="vc-list"></div>
      </div>`;
    $('vc-method').onchange = updateVectorForm;
    $('vc-go').onclick = createVector;
    $('vc-pick').onclick = () => $('vc-file').click();
    $('vc-strength').oninput = (e) => ($('vc-strength-val').textContent = e.target.value);
    $('vc-detail').oninput = (e) => ($('vc-detail-val').textContent = e.target.value);
    $('vc-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      $('vc-msg').textContent = `Uploading ${f.name}…`;
      try {
        const res = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setVectorRef(data.path, f.name);
        $('vc-msg').textContent = '';
      } catch (err) {
        $('vc-msg').textContent = 'Upload failed: ' + err.message;
      }
      e.target.value = '';
    };
  }
  const fill = (id, list) => {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = '';
    for (const m of list) sel.append(new Option(m.name, m.id));
    if (keep && list.some((m) => m.id === keep)) sel.value = keep;
  };
  const vcLlms = state.models.filter((m) => m.kind !== 'image');
  const vcHadChoice = !!$('vc-model').value;
  fill('vc-model', vcLlms);
  if (!vcHadChoice && bestQualityModel(vcLlms)) $('vc-model').value = bestQualityModel(vcLlms).id;
  fill('vc-imodel', state.models.filter((m) => m.kind === 'image'));
  // without SDXL set up, start on the method that works with just a chat model
  if (!ph.dataset.methodChosen) {
    ph.dataset.methodChosen = '1';
    if (!(state.image?.installed && state.models.some((m) => m.kind === 'image'))) $('vc-method').value = 'llm';
  }
  renderVectorSetup();
  updateVectorForm();
  renderVectorList();
}

function renderVectorSetup() {
  const box = $('vc-setup');
  if (!box) return;
  box.innerHTML = '';
  if (!state.vector?.installed) {
    box.innerHTML = '<div class="tr-err">The vector tools are not installed yet (about 40 MB, from the internet).</div>';
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = 'Install the vector tools';
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = 'Installing… (progress is shown at the bottom)';
      try {
        await api('/api/components/install', { method: 'POST', body: { feature: 'vector' } });
      } catch (e) {
        b.disabled = false;
        b.textContent = 'Install the vector tools';
        $('vc-msg').textContent = e.message;
      }
    };
    box.append(b);
  }
}

function updateVectorForm() {
  const method = $('vc-method').value;
  const hasLlm = state.models.some((m) => m.kind !== 'image');
  const hasImg = state.models.some((m) => m.kind === 'image');
  $('vc-prompt').hidden = method === 'trace';
  $('vc-llm-row').hidden = method !== 'llm';
  $('vc-sdxl-row').hidden = method !== 'sdxl';
  $('vc-strength-label').hidden = !vcRef;
  $('vc-trace-row').hidden = method === 'llm';
  $('vc-ref-row').hidden = method === 'llm';
  $('vc-pick').textContent = method === 'trace' ? 'Choose the picture to trace…' : 'Use a reference picture (optional)…';
  $('vc-base').textContent = '';
  if (method === 'llm' && vcBase) {
    $('vc-base').innerHTML = `Editing drawing ${esc(vcBase)}. <button id="vc-unbase" type="button">Start a new drawing instead</button>`;
    $('vc-unbase').onclick = () => {
      vcBase = null;
      updateVectorForm();
    };
  }
  $('vc-prompt').placeholder = method === 'llm' && vcBase ? 'What should change? For example: make the star bigger and the background dark blue' : 'Describe the drawing…';
  const hints = [];
  if (method === 'llm' && !hasLlm) hints.push('Add a chat model first (Settings > Models).');
  if (method === 'sdxl' && (!hasImg || !state.image?.installed)) hints.push('SDXL needs the image tools and an SDXL model: set them up in Image mode first.');
  if (method === 'trace' && !vcRef) hints.push('Choose a picture to trace.');
  $('vc-msg').textContent = hints.join(' ');
}

function setVectorRef(path, name) {
  vcRef = path ? { path, name } : null;
  const span = $('vc-ref');
  span.textContent = vcRef ? `Using: ${vcRef.name}` : '';
  if (vcRef) {
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Remove the picture';
    x.onclick = () => {
      setVectorRef(null);
      updateVectorForm();
    };
    span.append(' ', x);
  }
  updateVectorForm();
}

async function createVector() {
  const method = $('vc-method').value;
  const msg = $('vc-msg');
  msg.textContent = '';
  try {
    const body = {
      method,
      prompt: $('vc-prompt').value,
      reference: method === 'llm' ? undefined : vcRef?.path,
      modelId: $('vc-model').value,
      imageModelId: $('vc-imodel').value,
      aspect: $('vc-aspect').value,
      thinking: $('vc-think').checked,
      strength: +$('vc-strength').value,
      colormode: $('vc-colors').value,
      detail: +$('vc-detail').value,
      // SDXL paints on a white page, so that is always dropped; for a traced picture it is your choice
      removeBackground: method === 'sdxl' ? true : $('vc-nobg').checked,
      widthMm: $('vc-width').value ? +$('vc-width').value : undefined,
      baseJob: method === 'llm' ? vcBase || undefined : undefined,
    };
    await api('/api/vector', { method: 'POST', body });
    state.vector = await api('/api/vector');
    vcBase = null;
    renderVector($('placeholder'));
  } catch (e) {
    msg.textContent = e.message;
  }
}

function renderVectorList() {
  const box = $('vc-list');
  if (!box) return;
  box.innerHTML = '';
  const stages = { tracing: 'Tracing the picture…', converting: 'Making the EPS…', drawing: 'Drawing…', 'loading the model': 'Loading the model…' };
  const how = { llm: 'written by the chat model', sdxl: 'painted by SDXL, then traced', trace: 'traced from a picture' };
  for (const j of state.vector?.jobs || []) {
    const el = document.createElement('div');
    el.className = 'tr-job';
    const active = ['queued', 'loading', 'running'].includes(j.status);
    el.innerHTML = `<div class="tr-head"><span>${esc(j.prompt || (j.method === 'trace' ? 'Traced picture' : 'Drawing'))}${j.refine ? ' <small class="muted">(edit)</small>' : ''}</span><span class="pill ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'bad' : ''}">${esc(active ? stages[j.stage] || j.status : j.status)}</span></div>
      <small class="muted">${esc(how[j.method] || '')}${j.modelName ? ' · ' + esc(j.modelName) : ''}${j.method !== 'llm' ? ` · ${j.colormode === 'binary' ? 'black and white' : 'color'} · detail ${j.detail}` : ''}${j.widthMm ? ` · ${j.widthMm} mm wide` : ''}</small>`;
    if (active) {
      const stop = document.createElement('button');
      stop.textContent = 'Cancel';
      stop.onclick = () => api(`/api/vector/${j.id}/cancel`, { method: 'POST' });
      el.append(stop);
    } else if (j.status === 'error') {
      el.insertAdjacentHTML('beforeend', `<div class="tr-err">${esc(j.error || 'Failed')}</div>`);
    }
    if (j.files?.svg) {
      const row = document.createElement('div');
      row.className = 'vc-result';
      row.innerHTML = `<a href="/api/vector/${j.id}/out.svg" target="_blank" class="vc-preview"><img src="/api/vector/${j.id}/out.svg" alt="The drawing"></a>`;
      const side = document.createElement('div');
      side.className = 'vc-actions';
      const link = (label, href) => {
        const a = document.createElement('a');
        a.href = href;
        a.innerHTML = `<button type="button">${label}</button>`;
        return a;
      };
      side.append(link('Save SVG', `/api/vector/${j.id}/out.svg?download=1`));
      if (j.files.eps) side.append(link('Save EPS', `/api/vector/${j.id}/out.eps?download=1`));
      if (j.method === 'llm') {
        const edit = document.createElement('button');
        edit.textContent = 'Edit with the model';
        edit.onclick = () => {
          if (!$('vc-method')) return setBase('vector', j.id, 'the drawing');
          $('vc-method').value = 'llm';
          vcBase = j.id;
          updateVectorForm();
          $('vc-prompt').value = '';
          $('vc-prompt').focus();
        };
        side.append(edit);
      }
      const pic = j.files.source || j.files.reference;
      if (pic) {
        const again = document.createElement('button');
        again.textContent = 'Trace this picture again';
        again.onclick = async () => {
          if (!$('vc-method')) return attachResult(`vector:${j.id}/${pic}`, `${j.id}/${pic}`, `/api/vector/${j.id}/${pic}`);
          $('vc-method').value = 'trace';
          setVectorRef(`vector:${j.id}/${pic}`, `${j.id}/${pic}`);
        };
        side.append(again);
      }
      row.append(side);
      el.append(row);
    }
    if (!active) {
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm('Delete this drawing and its files?')) return;
        await api(`/api/vector/${j.id}`, { method: 'DELETE' });
        state.vector = await api('/api/vector');
        renderVectorList();
      };
      el.append(del);
    }
    box.append(el);
  }
  if (!state.vector?.jobs?.length) box.innerHTML = '<p class="muted">No drawings yet.</p>';
}

function onVectorEvent(ev) {
  const job = { ...ev };
  delete job.type;
  const jobs = (state.vector ||= { installed: true, jobs: [] }).jobs;
  const i = jobs.findIndex((x) => x.id === ev.id);
  if (i >= 0) jobs[i] = job;
  else jobs.unshift(job);
  updateBrand();
  if (state.mode === 'vector') renderVectorList();
}

// ---- 3D mode ---------------------------------------------------------------

// A small viewer for STL files that draws on a plain canvas (no libraries, works everywhere): each triangle is shaded
// by how much it faces the light and drawn far to near.
const meshCache = new Map(); // job id -> parsed mesh

function parseStl(buf) {
  const dv = new DataView(buf);
  let n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  let tris;
  if (buf.byteLength === 84 + n * 50) {
    tris = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) tris[i * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
  } else {
    // a text STL
    const nums = [...new TextDecoder().decode(buf).matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)];
    n = Math.floor(nums.length / 3);
    tris = new Float32Array(n * 9);
    for (let i = 0; i < n * 3; i++) for (let k = 0; k < 3; k++) tris[i * 3 + k] = parseFloat(nums[i][k + 1]);
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) for (let a = 0; a < 3; a++) {
    const v = tris[i * 3 + a];
    if (v < lo[a]) lo[a] = v;
    if (v > hi[a]) hi[a] = v;
  }
  const center = lo.map((l, a) => (l + hi[a]) / 2);
  const radius = Math.max(1e-6, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i * 9;
    const ux = tris[t + 3] - tris[t], uy = tris[t + 4] - tris[t + 1], uz = tris[t + 5] - tris[t + 2];
    const vx = tris[t + 6] - tris[t], vy = tris[t + 7] - tris[t + 1], vz = tris[t + 8] - tris[t + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[i * 3] = nx / l; normals[i * 3 + 1] = ny / l; normals[i * 3 + 2] = nz / l;
  }
  return { n, tris, normals, center, radius, size: hi.map((h, a) => h - lo[a]) };
}

async function loadMesh(id) {
  if (!meshCache.has(id)) {
    const res = await fetch(`/api/3d/${id}/out.stl`);
    if (!res.ok) throw new Error('The solid could not be loaded');
    meshCache.set(id, parseStl(await res.arrayBuffer()));
  }
  return meshCache.get(id);
}

const SHADES = Array.from({ length: 32 }, (_, i) => {
  const k = 0.22 + (0.78 * i) / 31;
  return `rgb(${Math.round(104 * k + 12)},${Math.round(156 * k + 14)},${Math.round(232 * k + 8)})`;
});

// view: { az, el, zoom } in radians. `step` > 1 draws every nth triangle (used while dragging a big model).
function drawMesh(canvas, mesh, view, step = 1) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!mesh || !mesh.n) return;
  const ca = Math.cos(view.az), sa = Math.sin(view.az), ce = Math.cos(view.el), se = Math.sin(view.el);
  const s = (0.44 * Math.min(W, H) / mesh.radius) * view.zoom;
  const [cx, cy, cz] = mesh.center;
  const { tris, normals, n } = mesh;
  const BUCKETS = 600;
  const keep = [];
  const depth = new Float32Array(n);
  const sx = new Float32Array(n * 3), sy = new Float32Array(n * 3);
  const level = new Uint8Array(n);
  for (let i = 0; i < n; i += step) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    const ny1 = nx * sa + ny * ca;
    const nd = -ny1 * ce + nz * se; // toward the viewer
    if (nd <= 0) continue; // facing away
    const nxp = nx * ca - ny * sa;
    const nup = nz * ce + ny1 * se;
    const lit = Math.max(0, nxp * -0.35 + nup * 0.55 + nd * 0.76);
    level[i] = Math.min(31, Math.round(31 * Math.min(1, 0.12 + lit)));
    let d = 0;
    for (let v = 0; v < 3; v++) {
      const x = tris[i * 9 + v * 3] - cx, y = tris[i * 9 + v * 3 + 1] - cy, z = tris[i * 9 + v * 3 + 2] - cz;
      const xp = x * ca - y * sa;
      const y1 = x * sa + y * ca;
      sx[i * 3 + v] = W / 2 + xp * s;
      sy[i * 3 + v] = H / 2 - (z * ce + y1 * se) * s;
      d += -y1 * ce + z * se;
    }
    depth[i] = d / 3;
    keep.push(i);
  }
  // counting sort by depth, far to near
  const r = mesh.radius;
  const bucket = (d) => Math.max(0, Math.min(BUCKETS - 1, Math.floor(((d + r) / (2 * r)) * BUCKETS)));
  const counts = new Uint32Array(BUCKETS + 1);
  for (const i of keep) counts[bucket(depth[i]) + 1]++;
  for (let b = 0; b < BUCKETS; b++) counts[b + 1] += counts[b];
  const order = new Uint32Array(keep.length);
  for (const i of keep) order[counts[bucket(depth[i])]++] = i;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 0.8;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const col = SHADES[level[i]];
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(sx[i * 3], sy[i * 3]);
    ctx.lineTo(sx[i * 3 + 1], sy[i * 3 + 1]);
    ctx.lineTo(sx[i * 3 + 2], sy[i * 3 + 2]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

const THUMB_VIEW = { az: -0.65, el: 0.5, zoom: 1 };
const fmtSize3d = (s) => (s ? s.map((v) => +v.toFixed(1)).join(' × ') + ' mm' : '');
let viewerJob = null;
let viewerView = null;
let viewerRaf = 0;

async function openViewer(j) {
  const dlg = $('viewer-dialog');
  viewerJob = j;
  viewerView = { ...THUMB_VIEW };
  $('viewer-title').textContent = (j.prompt || 'Carved from pictures').slice(0, 70);
  $('viewer-info').textContent = 'Loading…';
  $('viewer-save').href = `/api/3d/${j.id}/out.stl?download=1`;
  if (!dlg.open) dlg.showModal();
  try {
    const mesh = await loadMesh(j.id);
    $('viewer-info').textContent = `${fmtSize3d(j.size || mesh.size)} · ${mesh.n.toLocaleString()} triangles`;
    drawMesh($('viewer-canvas'), mesh, viewerView);
  } catch (e) {
    $('viewer-info').textContent = e.message;
  }
}

function redrawViewer(dragging) {
  if (viewerRaf || !viewerJob) return;
  viewerRaf = requestAnimationFrame(() => {
    viewerRaf = 0;
    const mesh = meshCache.get(viewerJob.id);
    if (mesh) drawMesh($('viewer-canvas'), mesh, viewerView, dragging && mesh.n > 25000 ? 3 : 1);
  });
}

{
  const cv = $('viewer-canvas');
  let drag = null;
  cv.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY };
    cv.setPointerCapture(e.pointerId);
  };
  cv.onpointermove = (e) => {
    if (!drag || !viewerView) return;
    viewerView.az += (e.clientX - drag.x) * 0.01;
    viewerView.el = Math.max(-1.55, Math.min(1.55, viewerView.el + (e.clientY - drag.y) * 0.01));
    drag = { x: e.clientX, y: e.clientY };
    redrawViewer(true);
  };
  cv.onpointerup = () => {
    drag = null;
    redrawViewer(false);
  };
  cv.onwheel = (e) => {
    e.preventDefault();
    if (!viewerView) return;
    viewerView.zoom = Math.max(0.3, Math.min(6, viewerView.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    redrawViewer(false);
  };
  $('viewer-reset').onclick = () => {
    viewerView = { ...THUMB_VIEW };
    redrawViewer(false);
  };
  $('viewer-close').onclick = () => $('viewer-dialog').close();
}

let tdViews = {}; // front / side / top -> { path, name }
let tdBase = null; // id of an earlier design the chat model should edit

function renderThreeD(ph) {
  ph.hidden = false;
  if (ph.dataset.view !== '3d') {
    ph.dataset.view = '3d';
    ph.style.textAlign = 'left';
    ph.innerHTML = `
      <div class="tr-wrap">
        <h2>3D</h2>
        <p class="muted">Make STL files for 3D printing and CAD: from a description with exact sizes, or by carving a solid from pictures.</p>
        <div id="td-setup"></div>
        <div class="row"><label class="muted">How <select id="td-method">
          <option value="scad">Describe it: the chat model designs it (OpenSCAD), at the sizes you give</option>
          <option value="photos">From pictures: carve a solid from front, side and top outlines</option>
          <option value="sweep">A long rounded thing (banana, carrot, bone): the image model draws it and a solid is built from the picture</option>
        </select></label></div>
        <div id="td-scad">
          <textarea id="td-prompt" rows="3" class="wide" placeholder="Describe the part… for example: a rectangular pen holder with a flat base and four walls"></textarea>
          <div id="td-base" class="muted"></div>
          <div class="row">
            <label class="muted">Model <select id="td-model"></select></label>
            <label class="muted td-scad-only" title="The model reasons before it designs: slower, but the designs are noticeably better"><input type="checkbox" id="td-think" checked> Think longer</label>
          </div>
          <textarea id="td-sizetext" rows="2" class="wide td-scad-only" placeholder="Other measurements, for example: wall 3 mm, hole diameter 8 mm, handle 120 mm long"></textarea>
          <details class="td-scad-only"><summary class="muted">Write the OpenSCAD yourself instead</summary>
            <textarea id="td-code" rows="9" class="wide mono" spellcheck="false" placeholder="cube([20, 20, 5]);"></textarea>
            <small class="muted">If this box has code, it is built as it is and the description is ignored. "Open the script" on a result fills it in so you can adjust it.</small>
          </details>
        </div>
        <div id="td-photos" hidden>
          <p class="muted">Give outlines of the object seen straight-on, on a plain background (or cut out with a transparent background): the <b>front</b>, the <b>right side</b> (front on the left), and from <b>above</b> (front edge at the bottom). Two or three pictures work best. Holes and hollows that don't show in an outline can't be recovered.</p>
          <div id="td-views"></div>
          <div class="row">
            <label class="muted">Detail <select id="td-quality"><option value="1">Draft (fast)</option><option value="2" selected>Normal</option><option value="3">Fine (slower)</option></select></label>
            <label class="muted">Background <select id="td-bg"><option value="auto">Find it automatically</option><option value="light">Light background, dark object</option><option value="dark">Dark background, light object</option></select></label>
          </div>
        </div>
        <div class="row">
          <label class="muted">Width (X) mm <input id="td-x" type="number" min="1" max="2000" class="num"></label>
          <label class="muted">Depth (Y) mm <input id="td-y" type="number" min="1" max="2000" class="num"></label>
          <label class="muted">Height (Z) mm <input id="td-z" type="number" min="1" max="2000" class="num"></label>
          <button id="td-go" class="primary">Create</button>
        </div>
        <div id="td-msg" class="muted"></div>
        <div id="td-list"></div>
      </div>`;
    $('td-method').onchange = updateThreeDForm;
    $('td-go').onclick = createThreeD;
    $('td-views').append(
      ...[['front', 'Front'], ['side', 'Right side'], ['top', 'Top']].map(([k, label]) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<input type="file" accept="image/*" hidden id="td-file-${k}"><button type="button" id="td-pick-${k}">${label} picture…</button><span class="muted" id="td-name-${k}"></span>`;
        return row;
      }),
    );
    for (const k of ['front', 'side', 'top']) {
      $(`td-pick-${k}`).onclick = () => $(`td-file-${k}`).click();
      $(`td-file-${k}`).onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        $('td-msg').textContent = `Uploading ${f.name}…`;
        try {
          const res = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          tdViews[k] = { path: data.path, name: f.name };
          renderThreeDViews();
          $('td-msg').textContent = '';
        } catch (err) {
          $('td-msg').textContent = 'Upload failed: ' + err.message;
        }
        e.target.value = '';
      };
    }
  }
  const sel = $('td-model');
  const keep = sel.value;
  sel.innerHTML = '';
  const llms = state.models.filter((m) => m.kind !== 'image');
  for (const m of llms) sel.append(new Option(m.name, m.id));
  if (keep && llms.some((m) => m.id === keep)) sel.value = keep;
  else if (bestQualityModel(llms)) sel.value = bestQualityModel(llms).id;
  renderThreeDViews();
  renderThreeDSetup();
  updateThreeDForm();
  renderThreeDList();
}

function renderThreeDViews() {
  for (const k of ['front', 'side', 'top']) {
    const span = $(`td-name-${k}`);
    if (!span) return;
    const v = tdViews[k];
    span.textContent = v ? v.name : '';
    if (v) {
      const x = document.createElement('button');
      x.textContent = '✕';
      x.title = 'Remove this picture';
      x.onclick = () => {
        delete tdViews[k];
        renderThreeDViews();
      };
      span.append(' ', x);
    }
  }
}

function renderThreeDSetup() {
  const box = $('td-setup');
  if (!box) return;
  box.innerHTML = '';
  const st = state.threed || {};
  if (st.scad && st.carve) return;
  const missing = [!st.scad && 'OpenSCAD (about 21 MB)', !st.carve && 'the carving tools (about 60 MB)'].filter(Boolean).join(' and ');
  box.innerHTML = `<div class="tr-err">Not installed yet: ${esc(missing)}.</div>`;
  const b = document.createElement('button');
  b.className = 'primary';
  b.textContent = 'Install the 3D tools';
  b.onclick = async () => {
    b.disabled = true;
    b.textContent = 'Installing… (progress is shown at the bottom)';
    try {
      await api('/api/components/install', { method: 'POST', body: { feature: 'threed' } });
    } catch (e) {
      b.disabled = false;
      b.textContent = 'Install the 3D tools';
      $('td-msg').textContent = e.message;
    }
  };
  box.append(b);
}

function updateThreeDForm() {
  const method = $('td-method').value;
  $('td-scad').hidden = method === 'photos';
  $('td-photos').hidden = method !== 'photos';
  document.querySelectorAll('.td-scad-only').forEach((el) => (el.hidden = method === 'sweep'));
  $('td-base').textContent = '';
  if (method === 'scad' && tdBase) {
    $('td-base').innerHTML = `Editing design ${esc(tdBase)}. <button id="td-unbase" type="button">Start a new design instead</button>`;
    $('td-unbase').onclick = () => {
      tdBase = null;
      updateThreeDForm();
    };
  }
  $('td-prompt').placeholder = method === 'sweep' ? 'Name the object, for example: a banana. Add its length (190 mm long) or leave it out and the chat model says how big one usually is' : method === 'scad' && tdBase ? 'What should change? For example: make the walls thicker and add a hole in the base' : 'Describe the part… for example: a rectangular pen holder with a flat base and four walls';
  const hints = [];
  if (!state.models.some((m) => m.kind !== 'image') && method === 'scad') hints.push('Add a chat model first (Settings > Models).');
  if (method === 'sweep' && !(state.image?.installed && state.models.some((m) => m.kind === 'image'))) hints.push('This needs the image tools and an image model (the Image screen sets them up).');
  $('td-msg').textContent = hints.join(' ');
}

async function createThreeD() {
  const method = $('td-method').value;
  const msg = $('td-msg');
  msg.textContent = '';
  const size = (id) => ($(id).value ? +$(id).value : undefined);
  try {
    const body = {
      method,
      sizeMm: { x: size('td-x'), y: size('td-y'), z: size('td-z') },
      ...(method === 'sweep'
        ? { prompt: $('td-prompt').value, modelId: $('td-model').value, imageModelId: state.models.find((m) => m.kind === 'image')?.id }
        : method === 'scad'
        ? { prompt: $('td-prompt').value, sizeText: $('td-sizetext').value, modelId: $('td-model').value, thinking: $('td-think').checked, baseJob: tdBase || undefined, code: $('td-code').value.trim() || undefined }
        : { views: Object.fromEntries(Object.entries(tdViews).map(([k, v]) => [k, v.path])), quality: +$('td-quality').value, background: $('td-bg').value }),
    };
    await api('/api/3d', { method: 'POST', body });
    state.threed = await api('/api/3d');
    tdBase = null;
    renderThreeD($('placeholder'));
  } catch (e) {
    msg.textContent = e.message;
  }
}

function renderThreeDList() {
  const box = $('td-list');
  if (!box) return;
  box.innerHTML = '';
  const stages = { loading: 'Loading the model…', designing: 'Designing…', 'building the solid': 'Building the solid…', carving: 'Carving…', 'reading the pictures': 'Reading the pictures…', 'building the surface': 'Building the surface…' };
  const how = { scad: 'designed by the chat model (OpenSCAD)', photos: 'carved from pictures', sweep: 'built from a picture the image model drew' };
  const stageText = (s) => stages[s] || (s ? s[0].toUpperCase() + s.slice(1) + '…' : '');
  for (const j of state.threed?.jobs || []) {
    const el = document.createElement('div');
    el.className = 'tr-job';
    const active = ['queued', 'loading', 'running'].includes(j.status);
    const title = j.method === 'photos' ? `Carved from ${(j.views || []).join(', ')} picture${(j.views || []).length === 1 ? '' : 's'}` : j.method === 'sweep' ? j.object || j.prompt || 'Shape' : j.manual ? 'Your OpenSCAD script' : j.prompt || 'Design';
    el.innerHTML = `<div class="tr-head"><span>${esc(title)}${j.refine ? ' <small class="muted">(edit)</small>' : ''}</span><span class="pill ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'bad' : ''}">${esc(active ? stageText(j.stage) || j.status : j.status)}</span></div>
      <small class="muted">${esc(how[j.method] || '')}${j.modelName ? ' · ' + esc(j.modelName) : ''}${j.size ? ' · ' + esc(fmtSize3d(j.size)) : ''}${j.triangles ? ' · ' + j.triangles.toLocaleString() + ' triangles' : ''}</small>`;
    if (j.note) el.insertAdjacentHTML('beforeend', `<div class="muted">${esc(j.note)}</div>`);
    if (j.warning) el.insertAdjacentHTML('beforeend', `<div class="warn">${esc(j.warning)}</div>`);
    if (active) {
      const stop = document.createElement('button');
      stop.textContent = 'Cancel';
      stop.onclick = () => api(`/api/3d/${j.id}/cancel`, { method: 'POST' });
      el.append(stop);
    } else if (j.status === 'error') {
      el.insertAdjacentHTML('beforeend', `<div class="tr-err">${esc(j.error || 'Failed')}</div>`);
    }
    if (j.files?.stl) {
      const row = document.createElement('div');
      row.className = 'vc-result';
      const thumb = document.createElement('canvas');
      thumb.width = 240;
      thumb.height = 180;
      thumb.className = 'td-thumb';
      thumb.title = 'Click to open the 3D view';
      thumb.onclick = () => openViewer(j);
      row.append(thumb);
      if (j.files.picture) {
        const pic = document.createElement('img');
        pic.src = `/api/3d/${j.id}/picture.png`;
        pic.className = 'td-thumb';
        pic.title = 'The picture the shape was taken from';
        pic.style.objectFit = 'cover';
        row.append(pic);
      }
      loadMesh(j.id).then((mesh) => drawMesh(thumb, mesh, THUMB_VIEW)).catch(() => {});
      const side = document.createElement('div');
      side.className = 'vc-actions';
      const btn = (label, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = fn;
        return b;
      };
      const link = (label, href) => {
        const a = document.createElement('a');
        a.href = href;
        a.innerHTML = `<button type="button">${label}</button>`;
        return a;
      };
      side.append(btn('View in 3D', () => openViewer(j)), link('Save STL', `/api/3d/${j.id}/out.stl?download=1`));
      if (j.method === 'sweep') {
        // the picture is a roll of the dice: draw a new one at the same size
        side.append(btn('Try another picture', async () => {
          try {
            await api('/api/3d', { method: 'POST', body: { method: 'sweep', prompt: j.prompt, sizeMm: { y: j.lengthUsed }, imageModelId: state.models.find((m) => m.kind === 'image')?.id } });
            state.threed = await api('/api/3d');
            renderThreeDList();
          } catch (e) {
            $('td-msg').textContent = e.message;
          }
        }));
      }
      if (j.warning && j.files.scad && j.sizeAsked) {
        // the design missed the size you asked for: wrap the same script in OpenSCAD's resize() so it hits it exactly
        side.append(
          btn('Scale it to the size I asked for', async () => {
            const { x, y, z } = j.sizeAsked;
            const code = await (await fetch(`/api/3d/${j.id}/model.scad`)).text();
            try {
              await api('/api/3d', { method: 'POST', body: { method: 'scad', sizeMm: j.sizeAsked, code: `// scaled to ${x || '-'} x ${y || '-'} x ${z || '-'} mm\nresize([${x || 0}, ${y || 0}, ${z || 0}]) {\n${code}\n}\n` } });
              state.threed = await api('/api/3d');
              renderThreeDList();
            } catch (e) {
              $('td-msg').textContent = e.message;
            }
          }),
        );
      }
      if (j.files.scad) {
        side.append(link('Save script', `/api/3d/${j.id}/model.scad?download=1`));
        side.append(
          btn('Open the script', async () => {
            if (!$('td-method')) toAdvanced('3d'); // the script box lives on the advanced screen
            $('td-method').value = 'scad';
            $('td-code').value = await (await fetch(`/api/3d/${j.id}/model.scad`)).text();
            $('td-code').closest('details').open = true;
            updateThreeDForm();
            $('td-code').focus();
          }),
        );
        if (!j.manual) {
          side.append(
            btn('Edit with the model', () => {
              if (!$('td-method')) return setBase('3d', j.id, 'the design');
              $('td-method').value = 'scad';
              tdBase = j.id;
              updateThreeDForm();
              $('td-prompt').value = '';
              $('td-prompt').focus();
            }),
          );
        }
      }
      row.append(side);
      el.append(row);
    }
    if (!active) {
      el.append(
        (() => {
          const del = document.createElement('button');
          del.textContent = 'Delete';
          del.onclick = async () => {
            if (!confirm('Delete this solid and its files?')) return;
            await api(`/api/3d/${j.id}`, { method: 'DELETE' });
            meshCache.delete(j.id);
            state.threed = await api('/api/3d');
            renderThreeDList();
          };
          return del;
        })(),
      );
    }
    box.append(el);
  }
  if (!state.threed?.jobs?.length) box.innerHTML = '<p class="muted">Nothing here yet.</p>';
}

function onThreedEvent(ev) {
  const job = { ...ev };
  delete job.type;
  const jobs = (state.threed ||= { scad: true, carve: true, jobs: [] }).jobs;
  const i = jobs.findIndex((x) => x.id === ev.id);
  if (i >= 0) jobs[i] = job;
  else jobs.unshift(job);
  updateBrand();
  if (state.mode === '3d') renderThreeDList();
}

// ---- settings dialog -----------------------------------------------------

// To add a settings page: add a <section id="tab-NAME" class="tab-panel" hidden> in index.html and an entry here.
// `show` runs each time the tab is opened (refresh whatever it displays there).
const SETTINGS_TABS = [
  { id: 'folders', title: 'Project folders', show: renderFolderTab },
  { id: 'models', title: 'Models', show: refreshModelDialog },
  { id: 'engines', title: 'Engines', show: renderEngineTab },
  { id: 'app', title: 'App', show: renderAppTab },
];
let settingsTab = 'folders';

function showSettingsTab(id) {
  settingsTab = SETTINGS_TABS.some((t) => t.id === id) ? id : SETTINGS_TABS[0].id;
  const bar = $('settings-tabs');
  bar.innerHTML = '';
  for (const t of SETTINGS_TABS) {
    const b = document.createElement('button');
    b.textContent = t.title;
    b.setAttribute('role', 'tab');
    b.className = t.id === settingsTab ? 'active' : '';
    b.onclick = () => showSettingsTab(t.id);
    bar.append(b);
    $('tab-' + t.id).hidden = t.id !== settingsTab;
  }
  SETTINGS_TABS.find((t) => t.id === settingsTab).show();
}

function openSettings(tab = settingsTab) {
  $('settings-dialog').showModal();
  showSettingsTab(tab);
}

// -- Project folders tab --

async function renderFolderTab() {
  let roots;
  try {
    roots = await api('/api/project-roots');
  } catch (e) {
    $('root-msg').textContent = e.message;
    return;
  }
  const box = $('root-list');
  box.innerHTML = roots.length ? '' : '<div class="empty-note">No folders yet. Add one above.</div>';
  for (const r of roots) {
    const row = document.createElement('div');
    row.className = 'item';
    const info = document.createElement('div');
    const count = r.exists ? `${r.count} project${r.count === 1 ? '' : 's'} found` : 'folder not found';
    info.innerHTML = `${esc(r.path)}<br><small class="${r.exists ? '' : 'bad-text'}">${count}</small>`;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Stop searching this folder';
    x.setAttribute('aria-label', `Stop searching ${r.path}`);
    x.onclick = async () => {
      if (!confirm(`Stop searching "${r.path}"?\n\nIts ${r.count} project${r.count === 1 ? '' : 's'} will leave the sidebar. Nothing on disk is touched, and projects you added by hand stay.`)) return;
      try {
        const res = await api('/api/project-roots?path=' + encodeURIComponent(r.path), { method: 'DELETE' });
        $('root-msg').textContent = `Removed. ${res.removed} project${res.removed === 1 ? '' : 's'} left the sidebar.`;
        await afterRootsChanged();
      } catch (e) {
        $('root-msg').textContent = e.message;
      }
    };
    row.append(info, x);
    box.append(row);
  }
}

// the project list changed on the server: bring the sidebar and this tab up to date
async function afterRootsChanged() {
  await refresh();
  if (state.projectId && !state.projects.some((p) => p.id === state.projectId)) {
    state.projectId = null;
    state.conv = null;
  }
  renderSidebar();
  renderMessages();
  await renderFolderTab();
}

$('root-browse').onclick = async () => {
  const b = $('root-browse');
  b.disabled = true;
  $('root-msg').textContent = 'Choose a folder in the window that opened…';
  try {
    const dir = await pickFolder('Choose a folder that contains your projects');
    if (dir) $('root-path').value = dir;
    $('root-msg').textContent = dir ? 'Now click Add.' : '';
  } catch (e) {
    $('root-msg').textContent = e.message;
  } finally {
    b.disabled = false;
  }
};

$('root-add').onclick = async () => {
  const p = $('root-path').value.trim();
  if (!p) {
    $('root-msg').textContent = 'Type a folder address, or click Browse.';
    return;
  }
  try {
    const r = await api('/api/project-roots', { method: 'POST', body: { path: p } });
    $('root-path').value = '';
    const found = `${r.added} new project${r.added === 1 ? '' : 's'}`;
    $('root-msg').textContent = r.already ? `That folder was already in the list. Found ${found}.` : `Added. Found ${found}.`;
    await afterRootsChanged();
  } catch (e) {
    $('root-msg').textContent = e.message;
  }
};
$('root-path').addEventListener('keydown', (e) => e.key === 'Enter' && $('root-add').click());

$('root-rescan').onclick = async () => {
  try {
    const r = await api('/api/project-roots/rescan', { method: 'POST' });
    $('root-msg').textContent = r.added ? `Found ${r.added} new project${r.added === 1 ? '' : 's'}.` : 'No new projects.';
    await afterRootsChanged();
  } catch (e) {
    $('root-msg').textContent = e.message;
  }
};

// -- Engines tab (the chat engine's box is filled by renderEngine) --

async function renderEngineTab() {
  await refresh();
  const box = $('component-box');
  box.textContent = 'Checking…';
  try {
    const c = await api('/api/components');
    const card = (title, ok, detail) =>
      `<div class="item"><div>${esc(title)}<br><small>${esc(detail)}</small></div><span class="pill ${ok ? 'ok' : ''}">${ok ? 'Ready' : 'Not installed'}</span></div>`;
    box.innerHTML =
      card('Transcribe: Whisper', c.whisper.installed, c.whisper.installed ? `Uses ${c.whisper.source === 'private' ? 'its own private' : 'the system'} Python` : 'Needed for Transcribe mode') +
      card('Image: PyTorch + diffusers', c.image.installed, c.image.installed ? 'Ready for SDXL checkpoints' : 'Needed for Image mode (NVIDIA or Apple Silicon)') +
      card('Vector: tracing + EPS tools', c.vector.installed, c.vector.installed ? 'Ready: traces pictures and writes SVG and EPS files' : 'Needed for Vector mode (about 40 MB)') +
      card('3D: OpenSCAD + carving tools', c.threed.scad && c.threed.carve, c.threed.scad && c.threed.carve ? 'Ready: designs parts and carves solids from pictures' : `Needed for 3D mode (about 80 MB): ${[!c.threed.scad && 'OpenSCAD', !c.threed.carve && 'carving tools'].filter(Boolean).join(' and ')} missing`) +
      `<p class="muted">To install Whisper or the image tools, open <b>${IS_MAC ? 'Download components.command' : 'LLM Icarus - Download components'}</b> ${IS_MAC ? 'from the LLM Icarus folder in Application Support' : 'from the Start menu'}.</p>`;
    if (!c.vector.installed) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = 'Install the vector tools';
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = 'Installing… (progress is shown at the bottom)';
        try {
          await api('/api/components/install', { method: 'POST', body: { feature: 'vector' } });
        } catch (e) {
          b.disabled = false;
          alert(e.message);
        }
      };
      box.append(b);
    }
    if (!(c.threed.scad && c.threed.carve)) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = 'Install the 3D tools';
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = 'Installing… (progress is shown at the bottom)';
        try {
          await api('/api/components/install', { method: 'POST', body: { feature: 'threed' } });
        } catch (e) {
          b.disabled = false;
          alert(e.message);
        }
      };
      box.append(b);
    }
  } catch (e) {
    box.textContent = e.message;
  }
}

// "Check for updates" on the Engines tab: only looks things up when you click it.
function updateRow(title, lines, button) {
  const row = document.createElement('div');
  row.className = 'update-row';
  const info = document.createElement('div');
  info.innerHTML = `<b>${esc(title)}</b>` + lines.map((l) => `<small class="${l.cls || ''}">${esc(l.text)}</small>`).join('');
  row.append(info);
  if (button) {
    const b = document.createElement('button');
    b.textContent = button.label;
    b.className = 'primary';
    b.onclick = async () => {
      b.disabled = true;
      try {
        await button.run();
      } catch (e) {
        alert(e.message);
        b.disabled = false;
      }
    };
    row.append(b);
  }
  return row;
}

$('engines-check').onclick = async () => {
  const b = $('engines-check');
  const msg = $('engines-check-msg');
  const box = $('engine-updates');
  b.disabled = true;
  msg.textContent = 'Checking…';
  box.innerHTML = '';
  try {
    const r = await api('/api/updates/engines');
    const fail = (title, err) => updateRow(title, [{ text: `Could not check: ${err}` }]);
    // chat engine
    const c = r.chat;
    if (c.error) box.append(fail('Chat and Code engine (llama.cpp)', c.error));
    else if (!c.installed) box.append(updateRow('Chat and Code engine (llama.cpp)', [{ text: `Not installed. The latest is ${c.latest}.` }], { label: 'Install', run: () => api('/api/engine/install', { method: 'POST', body: { backend: c.backend } }) }));
    else if (c.updateAvailable) {
      box.append(updateRow('Chat and Code engine (llama.cpp)', [{ text: `Installed ${c.installed}`, cls: '' }, { text: `Newer version available: ${c.latest}`, cls: 'new' }], {
        label: 'Update',
        run: async () => {
          await api('/api/engine/install', { method: 'POST', body: { backend: c.backend } });
          msg.textContent = 'Updating… progress is shown under "Chat and Code engine" below.';
        },
      }));
    } else box.append(updateRow('Chat and Code engine (llama.cpp)', [{ text: `Up to date (${c.installed})`, cls: 'ok' }]));
    // python tools
    for (const [key, title] of [['whisper', 'Transcribe: Whisper'], ['image', 'Image: diffusers'], ['vector', 'Vector: vtracer']]) {
      const p = r[key];
      if (p.error) box.append(fail(title, p.error));
      else if (!p.installed) box.append(updateRow(title, [{ text: 'Not installed' }]));
      else if (!p.updateAvailable) box.append(updateRow(title, [{ text: `Up to date (${p.package} ${p.installed})`, cls: 'ok' }]));
      else {
        const lines = [{ text: `Installed ${p.package} ${p.installed}` }, { text: `Newer version available: ${p.latest}`, cls: 'new' }];
        if (p.canUpdate) {
          box.append(updateRow(title, lines, {
            label: 'Update',
            run: async () => {
              await api('/api/updates/package', { method: 'POST', body: { name: key } });
              msg.textContent = `Updating ${p.package}… this can take a minute.`;
            },
          }));
        } else {
          lines.push({ text: `This uses a Python you installed yourself, so update it there: pip install --upgrade ${p.package}` });
          box.append(updateRow(title, lines));
        }
      }
    }
    msg.textContent = 'Checked just now.';
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    b.disabled = false;
  }
};

// "Check for updates" on the Models tab: for downloaded models, asks the download site whether the file has changed.
state.modelUpdates = {};
$('models-check').onclick = async () => {
  const b = $('models-check');
  const msg = $('models-check-msg');
  b.disabled = true;
  msg.textContent = 'Checking…';
  try {
    const r = await api('/api/updates/models');
    state.modelUpdates = Object.fromEntries(r.map((x) => [x.id, x]));
    const n = r.filter((x) => x.status === 'changed').length;
    const skipped = r.filter((x) => x.status === 'no-source').length;
    msg.textContent = (n ? `${n} update${n === 1 ? '' : 's'} available.` : 'Nothing new.') + (skipped ? ` ${skipped} model${skipped === 1 ? ' was' : 's were'} added from disk or Ollama and can't be checked.` : '');
    await refreshModelDialog();
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    b.disabled = false;
  }
};

$('open-settings').onclick = () => openSettings();
$('close-settings').onclick = () => $('settings-dialog').close();

// -- Models tab --

async function refreshModelDialog() {
  await refresh();
  const list = $('model-list');
  list.innerHTML = state.models.length ? '' : '<small>No models yet. Import from Ollama or download one below.</small>';
  for (const m of state.models) {
    const row = document.createElement('div');
    row.className = 'item';
    // after "Check for updates", say what was found for this model
    const u = state.modelUpdates?.[m.id];
    const badge = !u ? '' : u.status === 'current' ? ' · ✓ up to date' : u.status === 'changed' ? ` · <span class="badge-new">update available (${fmtSize(u.remote)})</span>` : u.status === 'no-source' ? ' · can’t check (no download link)' : ' · couldn’t check';
    row.innerHTML = `<div>${esc(m.name)}<br><small>${fmtSize(m.size)} · ${m.kind === 'image' ? 'image model · ' : ''}${esc(m.source)}${m.exists ? '' : ' · file missing'}${badge}</small></div>`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (u?.status === 'changed') {
      const up = document.createElement('button');
      up.textContent = 'Update';
      up.className = 'primary';
      up.onclick = async () => {
        if (!confirm(`Download the new version of ${m.name} (${fmtSize(u.remote)}) and replace the current file?\n\nIf this model is loaded it will be unloaded first.`)) return;
        up.disabled = true;
        try {
          await api(`/api/models/${m.id}/update`, { method: 'POST' });
          $('models-check-msg').textContent = `Downloading ${m.name}… progress is shown below.`;
        } catch (e) {
          alert(e.message);
          up.disabled = false;
        }
      };
      actions.append(up);
    }
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.onclick = async () => {
      const own = m.source === 'huggingface' || m.source === 'github';
      const delFile = own && confirm(`Also delete the downloaded file for ${m.name} from disk?`);
      await api(`/api/models/${m.id}?deleteFile=${delFile ? 1 : 0}`, { method: 'DELETE' });
      refreshModelDialog();
    };
    actions.append(del);
    row.append(actions);
    list.append(row);
  }
  const ol = await api('/api/models/ollama');
  const have = new Set(state.models.map((m) => m.path));
  const avail = ol.filter((o) => !have.has(o.path));
  const box = $('ollama-box');
  box.innerHTML = avail.length ? '<h3>Found in Ollama (reused in place, no copy)</h3>' : '';
  for (const o of avail) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div>${esc(o.name)}<br><small>${fmtSize(o.size)}</small></div>`;
    const b = document.createElement('button');
    b.textContent = 'Import';
    b.onclick = async () => {
      await api('/api/models/import-ollama', { method: 'POST', body: { name: o.name } });
      refreshModelDialog();
    };
    row.append(b);
    box.append(row);
  }
}

$('hf-go').onclick = async () => {
  const url = $('hf-url').value.trim();
  if (!url) return;
  try {
    const r = await api('/api/models/download', { method: 'POST', body: { url } });
    if (r.choices) return showChoices(r.choices);
    $('hf-url').value = '';
  } catch (e) {
    alert(e.message);
  }
};

// A GitHub repo/release with several .gguf files: let the user pick which one to download.
function showChoices(choices) {
  const box = $('download-box');
  box.innerHTML = '<h3>This release has several models. Pick one:</h3>';
  for (const c of choices) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div>${esc(c.name)}<br><small>${fmtSize(c.size)}</small></div>`;
    const b = document.createElement('button');
    b.textContent = 'Download';
    b.onclick = async () => {
      box.textContent = 'Starting…';
      try {
        await api('/api/models/download', { method: 'POST', body: { direct: c.url, source: 'github' } });
        $('hf-url').value = '';
      } catch (e) {
        box.textContent = '';
        alert(e.message);
      }
    };
    row.append(b);
    box.append(row);
  }
}
$('path-go').onclick = async () => {
  try {
    await api('/api/models/add-path', { method: 'POST', body: { path: $('path-url').value.trim() } });
    $('path-url').value = '';
    refreshModelDialog();
  } catch (e) {
    alert(e.message);
  }
};

// ---- sidebar toggle ------------------------------------------------------

const NARROW = 760;
const isNarrow = () => window.innerWidth <= NARROW;
let sidebarChoice = null; // 'open' | 'closed' once the user has picked; otherwise follows the window width
try {
  sidebarChoice = localStorage.getItem('sidebar');
} catch {
  /* storage can be unavailable; the toggle still works for this session */
}
function applySidebar() {
  const open = sidebarChoice ? sidebarChoice === 'open' : !isNarrow();
  $('app').classList.toggle('sb-collapsed', !open);
}
function setSidebar(open, remember = true) {
  if (remember) {
    sidebarChoice = open ? 'open' : 'closed';
    try {
      localStorage.setItem('sidebar', sidebarChoice);
    } catch {
      /* ignore */
    }
  }
  applySidebar();
}
$('toggle-sidebar').onclick = () => setSidebar($('app').classList.contains('sb-collapsed'));
$('close-sidebar').onclick = () => setSidebar(false);
window.addEventListener('resize', applySidebar);
applySidebar();
// on a narrow window the sidebar floats over the chat, so close it once something is picked
const closeIfNarrow = () => {
  if (!isNarrow()) return;
  sidebarChoice = null; // follow the window width again (closed when narrow); the saved preference is kept
  applySidebar();
};

// ---- resizable sidebar ---------------------------------------------------

const SB_MIN = 200;
const SB_MAX = 520;
const SB_DEFAULT = 270;
function setSidebarWidth(px, save = false) {
  const w = Math.max(SB_MIN, Math.min(SB_MAX, Math.round(px)));
  document.documentElement.style.setProperty('--sb-width', w + 'px');
  if (save) {
    try {
      localStorage.setItem('sbWidth', String(w));
    } catch {
      /* ignore */
    }
  }
  return w;
}
try {
  const saved = Number(localStorage.getItem('sbWidth'));
  if (saved) setSidebarWidth(saved);
} catch {
  /* ignore */
}
$('sb-resizer').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const bar = $('sb-resizer');
  bar.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  let width = null;
  const move = (ev) => {
    width = setSidebarWidth(ev.clientX - $('app').getBoundingClientRect().left);
  };
  const up = () => {
    document.body.classList.remove('resizing');
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    bar.removeEventListener('pointercancel', up);
    if (width !== null) setSidebarWidth(width, true); // remember it
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
});
$('sb-resizer').addEventListener('dblclick', () => setSidebarWidth(SB_DEFAULT, true)); // double-click: back to normal

// ---- wiring --------------------------------------------------------------

$('attach').onclick = () => $('attach-file').click();
$('attach-file').onchange = (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
};
$('mic-open').onclick = () => {
  state.adv.transcribe = true; // the microphone lives on the advanced Transcribe screen
  renderMessages();
  $('mic-go')?.click();
};
$('input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length && !state.adv[state.mode]) {
    e.preventDefault();
    addFiles(files);
  }
});
// dropping a file anywhere in the window: use it, and never let the window navigate to it
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('dragleave', (e) => {
  if (hasFiles(e) && --dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dropping');
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  addFiles([...e.dataTransfer.files]);
});

$('new-chat').onclick = () => newChat();
$('send').onclick = () => (state.busy ? state.ctrl?.abort() : send());
$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
function setMode(mode) {
  if (mic && mode !== 'transcribe') stopDictation(); // never leave the microphone on in the background
  state.mode = mode;
  state.attach = []; // files and "editing" choices belong to the mode they were made in
  state.base = null;
  for (const x of $('modes').children) x.classList.toggle('active', x.dataset.mode === mode);
  if (state.conv && state.conv.mode !== state.mode) state.conv = null; // each conversation belongs to one mode
  renderModels(); // each mode has its own remembered model
  renderSidebar();
  renderMessages();
}
$('modes').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) setMode(b.dataset.mode);
};
$('model-select').onchange = () => {
  if ($('model-select').value) rememberModel($('model-select').value);
  updateCodeWarning();
};
$('code-shell').onchange = async (e) => {
  if (e.target.checked && !confirm('Let the agent run shell commands (Bash/PowerShell) in the project folder without asking each time? It can change or delete files outside what you asked for.')) {
    e.target.checked = false;
    return;
  }
  state.settings = await api('/api/settings', { method: 'POST', body: { codeAllowShell: e.target.checked } });
};

// ---- this app's version, and updating it ----------------------------------------
// Only the Windows app window (WebView2) can restart itself to run an installer; anywhere else the dialog just points to
// the release page.

const inAppWindow = !!window.chrome?.webview;
let upOffer = null; // the release being offered

async function showVersion() {
  try {
    state.version = await api('/api/version');
    $('app-version').textContent = `Version ${state.version.version}`;
  } catch {
    /* the label is a nicety */
  }
}

function upShow({ title, body, buttons, progress }) {
  $('up-title').textContent = title;
  $('up-body').innerHTML = body;
  const bar = $('up-bar');
  bar.hidden = progress === undefined;
  if (progress !== undefined) {
    if (progress === null) bar.removeAttribute('value');
    else bar.value = progress;
  }
  const box = $('up-buttons');
  box.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.textContent = b.label;
    if (b.primary) el.className = 'primary';
    el.onclick = b.run;
    box.append(el);
  }
  if (!$('update-dialog').open) $('update-dialog').showModal();
}

const upClose = () => $('update-dialog').close();

function showUpdateOffer(info) {
  upOffer = info;
  const canInstall = info.canSelfUpdate && inAppWindow && info.asset;
  const mb = info.asset?.size ? ` (${(info.asset.size / 1048576).toFixed(0)} MB)` : '';
  upShow({
    title: 'A new version is available',
    body: `<p>LLM Icarus <b>${esc(info.latest)}</b> is ready. You have ${esc(info.current)}.</p>` +
      (canInstall ? `<p class="muted">It downloads${esc(mb)} and installs itself, then LLM Icarus restarts. Your chats, models and settings are kept.</p>` : `<p class="muted">This copy cannot install it by itself. Open the release page to download the installer.</p>`) +
      (info.notes ? `<div class="notes">${esc(info.notes)}</div>` : ''),
    buttons: [
      { label: 'Not now', run: upClose },
      canInstall ? { label: 'Install now', primary: true, run: startUpdateDownload } : { label: 'Open the release page', primary: true, run: () => { window.open(info.page, '_blank'); upClose(); } },
    ],
  });
}

async function startUpdateDownload() {
  upShow({ title: 'Downloading the update', body: '<p>Starting…</p>', progress: null, buttons: [{ label: 'Cancel', run: cancelUpdateDownload }] });
  try {
    await api('/api/app-update/download', { method: 'POST' });
  } catch (e) {
    showUpdateError(e.message);
  }
}

async function cancelUpdateDownload() {
  try {
    await api('/api/app-update/cancel', { method: 'POST' });
  } catch {
    /* closing the dialog is enough */
  }
  upClose();
}

function showUpdateError(message) {
  upShow({
    title: 'The update could not be installed',
    body: `<p>${esc(message)}</p>`,
    buttons: [{ label: 'Close', run: upClose }, { label: 'Try again', primary: true, run: startUpdateDownload }],
  });
}

function onAppUpdateEvent(ev) {
  if (!$('update-dialog').open) return;
  if (ev.phase === 'downloading') {
    const pct = ev.total ? Math.min(100, (ev.received / ev.total) * 100) : null;
    upShow({
      title: 'Downloading the update',
      body: `<p>LLM Icarus ${esc(ev.version || '')}: ${fmtSize(ev.received || 0)}${ev.total ? ' of ' + fmtSize(ev.total) : ''}${pct !== null ? ` (${Math.round(pct)}%)` : ''}</p>`,
      progress: pct,
      buttons: [{ label: 'Cancel', run: cancelUpdateDownload }],
    });
  } else if (ev.phase === 'ready') {
    upShow({
      title: 'Update downloaded',
      body: '<p>LLM Icarus will now restart to finish installing the update.</p>',
      progress: 100,
      buttons: [{ label: 'OK', primary: true, run: (e) => {
        e.target.disabled = true;
        $('up-body').innerHTML = '<p>Restarting…</p>';
        window.chrome.webview.postMessage('install-update'); // the app window closes the app, runs the installer and starts the new version
      } }],
    });
  } else if (ev.phase === 'error') {
    showUpdateError(ev.error || 'Something went wrong.');
  } else if (ev.phase === 'idle') {
    upClose();
  }
}

// no Escape while a download or restart is in progress: use the buttons
$('update-dialog').addEventListener('cancel', (e) => {
  if (!['Not now', 'Close'].some((l) => [...$('up-buttons').children].some((b) => b.textContent === l))) e.preventDefault();
});

async function startupUpdateCheck() {
  try {
    const info = await api('/api/app-update/check', { method: 'POST', body: { auto: true } });
    if (info.newer && !$('update-dialog').open) showUpdateOffer(info);
  } catch {
    /* offline or GitHub is busy: try again next start */
  }
}

async function renderAppTab() {
  const v = state.version?.version || '';
  $('app-info').textContent = `Version ${v}`;
  $('app-auto').checked = state.settings?.checkAppUpdates !== false;
  $('app-auto').onchange = async (e) => {
    state.settings = await api('/api/settings', { method: 'POST', body: { checkAppUpdates: e.target.checked } });
  };
  $('app-check').onclick = async () => {
    const b = $('app-check');
    const msg = $('app-check-msg');
    b.disabled = true;
    msg.textContent = 'Checking…';
    try {
      const info = await api('/api/app-update/check', { method: 'POST', body: {} });
      if (info.error) msg.textContent = `Could not check: ${info.error}`;
      else if (info.newer) {
        msg.textContent = `Version ${info.latest} is available.`;
        showUpdateOffer(info);
      } else msg.textContent = info.latest ? 'You have the newest version.' : 'No releases were found.';
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
}

// live progress from the server
const es = new EventSource('/api/events');
es.onmessage = async (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'app-update') return onAppUpdateEvent(ev);
  const bar = (label, done, total) => `${esc(label)}<div class="bar"><div style="width:${total ? Math.min(100, (done / total) * 100) : 0}%"></div></div><small>${fmtSize(done)}${total ? ' / ' + fmtSize(total) : ''}</small>`;
  if (ev.type === 'transcribe-job' || ev.type === 'transcribe-segment') return onTranscribeEvent(ev);
  if (ev.type === 'image-job') return onImageEvent(ev);
  if (ev.type === 'vector-job') return onVectorEvent(ev);
  if (ev.type === 'threed-job') return onThreedEvent(ev);
  if (ev.type === 'api-tasks') {
    // prompts handed in from outside the window are running (count of them)
    state.apiTasks = ev.count;
    return updateBrand();
  }
  if (ev.type === 'chats-changed') {
    // a chat was started from outside the window (the /api/tasks entry point)
    state.convs = await api('/api/conversations');
    return renderSidebar();
  }
  if (ev.type === 'engine-progress') {
    const p = $('engine-progress');
    if (p) p.innerHTML = bar(ev.file, ev.done, ev.total);
  } else if (ev.type === 'engine-status') {
    state.modelLoading = !(ev.done || ev.error); // model loading / engine installing
    updateBrand();
    setStatus(ev.message);
    const p = $('engine-progress');
    if (p && !state.busy) p.textContent = ev.message;
    if (ev.done || ev.error) {
      state.engine = await api('/api/engine');
      renderEngine();
      if (ev.feature) {
        [state.image, state.vector, state.threed] = await Promise.all([api('/api/image'), api('/api/vector'), api('/api/3d')]);
        if (SIMPLE_MODES.includes(state.mode)) renderMessages();
        if ($('settings-dialog').open && settingsTab === 'engines') renderEngineTab();
      }
    }
  } else if (ev.type === 'download-progress') {
    const d = $('download-box');
    if (ev.error) d.textContent = `Download failed: ${ev.error}`;
    else if (ev.finished) {
      d.textContent = `Finished ${ev.file}`;
      state.modelUpdates = {}; // whatever was reported before is out of date now
      refreshModelDialog();
    } else d.innerHTML = bar(ev.file, ev.done, ev.total);
  }
};

// ---- remember where you were ----------------------------------------------
// The mode, project and chat you had open are saved as you go and reopened at the next start.

let sessionReady = false; // don't save while the page is still starting up (it would overwrite what we are about to restore)
function loadSession() {
  try {
    return JSON.parse(localStorage.getItem('session') || 'null');
  } catch {
    return null;
  }
}
function saveSession() {
  if (!sessionReady) return;
  try {
    localStorage.setItem('session', JSON.stringify({ mode: state.mode, projectId: state.projectId, convId: state.conv?.id ?? null }));
  } catch {
    /* storage can be unavailable; the app still works */
  }
}

async function restoreSession() {
  const saved = loadSession();
  let mode = 'chat';
  let projectId = null;
  let convId = null;
  if (saved && ['chat', 'code', 'transcribe', 'image', 'vector', '3d'].includes(saved.mode)) {
    mode = saved.mode;
    projectId = state.projects.some((p) => p.id === saved.projectId) ? saved.projectId : null;
    convId = state.convs.some((c) => c.id === saved.convId) ? saved.convId : null;
  } else if (state.convs[0]) {
    // nothing saved yet (first start after this was added): pick up the most recent chat (the server sorts newest first)
    mode = state.convs[0].mode || 'chat';
    projectId = state.convs[0].projectId;
    convId = state.convs[0].id;
  }
  state.projectId = projectId;
  setMode(mode);
  const c = convId && state.convs.find((x) => x.id === convId);
  if (c && (c.mode || 'chat') === mode) await openConv(convId);
  sessionReady = true;
  saveSession();
}

await refresh();
await restoreSession();
showVersion();
setTimeout(startupUpdateCheck, 2000); // after the window has settled; never holds up the app
