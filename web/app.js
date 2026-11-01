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

const state = { projects: [], convs: [], models: [], engine: null, conv: null, mode: 'chat', projectId: null, busy: false, apiTasks: 0, ctrl: null };

// The sidebar logo animates (logo-working.png, an animated PNG) whenever something is running, so it's easy to tell the app is busy.
let gifMissing = false;
const isActive = (j) => ['queued', 'loading', 'running'].includes(j.status);
function isWorking() {
  return !!(state.busy || state.modelLoading || state.apiTasks > 0 || (state.transcripts || []).some(isActive) || (state.image?.jobs || []).some(isActive));
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
  [state.projects, state.convs, state.models, state.engine, state.settings, state.transcripts, state.image] = await Promise.all([
    api('/api/projects'), api('/api/conversations'), api('/api/models'), api('/api/engine'), api('/api/settings'), api('/api/transcribe'), api('/api/image'),
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
  box.hidden = !chatLike;
  ph.hidden = chatLike;
  $('composer').parentElement.hidden = !chatLike;
  $('code-bar').hidden = state.mode !== 'code';
  $('input').placeholder = state.mode === 'code' ? 'Describe a task for the agent in this project…' : 'Message your local model…';
  if (state.mode === 'code') {
    const proj = state.projects.find((p) => p.id === state.projectId);
    $('code-project').textContent = proj ? `Project: ${proj.name}` : 'No project selected — click a project name in the sidebar';
    $('code-project').className = 'pill' + (proj ? ' ok' : ' bad');
    $('code-shell').checked = !!state.settings?.codeAllowShell;
    updateCodeWarning();
  }
  $('model-select').hidden = !chatLike;
  if (!['transcribe', 'image'].includes(state.mode)) {
    delete ph.dataset.view; // so the transcribe/image forms are rebuilt next time
    ph.style.textAlign = '';
  }
  if (state.mode === 'image') return renderImage(ph);
  if (state.mode === 'transcribe') return renderTranscribe(ph);
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
  const text = $('input').value.trim();
  if (!text || state.busy) return;
  const modelId = $('model-select').value;
  if (!modelId) return setStatus('Add a model first (Settings > Models).');
  if (!state.engine.installed) return setStatus('Install the engine first (Settings > Engines).');
  rememberModel(modelId);

  if (state.mode === 'code' && !state.projectId) return setStatus('Pick a project first: click a project name in the sidebar.');
  if (!state.conv) state.conv = await api('/api/conversations', { method: 'POST', body: { projectId: state.projectId, mode: state.mode, modelId } });
  $('input').value = '';
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
        <p class="muted">Turns audio or video into text and an .srt caption file using Whisper large-v3 on your GPU. The chat model is unloaded while it runs.</p>
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
  }
  renderTranscriptList();
}

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

// ---- settings dialog -----------------------------------------------------

// To add a settings page: add a <section id="tab-NAME" class="tab-panel" hidden> in index.html and an entry here.
// `show` runs each time the tab is opened (refresh whatever it displays there).
const SETTINGS_TABS = [
  { id: 'folders', title: 'Project folders', show: renderFolderTab },
  { id: 'models', title: 'Models', show: refreshModelDialog },
  { id: 'engines', title: 'Engines', show: renderEngineTab },
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
      `<p class="muted">To install Whisper or the image tools, open <b>${IS_MAC ? 'Download components.command' : 'LLM Icarus - Download components'}</b> ${IS_MAC ? 'from the LLM Icarus folder in Application Support' : 'from the Start menu'}.</p>`;
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
    for (const [key, title] of [['whisper', 'Transcribe: Whisper'], ['image', 'Image: diffusers']]) {
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
  state.mode = mode;
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

// live progress from the server
const es = new EventSource('/api/events');
es.onmessage = async (e) => {
  const ev = JSON.parse(e.data);
  const bar = (label, done, total) => `${esc(label)}<div class="bar"><div style="width:${total ? Math.min(100, (done / total) * 100) : 0}%"></div></div><small>${fmtSize(done)}${total ? ' / ' + fmtSize(total) : ''}</small>`;
  if (ev.type === 'transcribe-job' || ev.type === 'transcribe-segment') return onTranscribeEvent(ev);
  if (ev.type === 'image-job') return onImageEvent(ev);
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
  if (saved && ['chat', 'code', 'transcribe', 'image'].includes(saved.mode)) {
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
