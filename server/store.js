import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dirs, DATA, readJson, writeJson } from './paths.js';
import { defaultProjectRoots, IS_WIN, IS_MAC } from './platform.js';

const PROJECTS = path.join(DATA, 'projects.json');
const SETTINGS = path.join(DATA, 'settings.json');

const newId = () => crypto.randomUUID().slice(0, 8);

// ---- settings ------------------------------------------------------------

export function settings() {
  const saved = readJson(SETTINGS, {});
  return { ctx: 8192, codeCtx: 32768, codeAllowShell: false, codeThinking: true, kvQuant: 'q8_0', ignoredProjects: [], ...saved, projectRoots: saved.projectRoots ?? defaultProjectRoots() };
}

export function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  writeJson(SETTINGS, next);
  return next;
}

// ---- projects ------------------------------------------------------------
// A project is a folder. Most come from "project folders" (settings.projectRoots): every subfolder of those is a
// project and carries { root }. Others are added by hand ({ manual: true }).

// Windows and macOS file names are case-insensitive, so compare paths that way there.
const same = (a, b) => (IS_WIN || IS_MAC ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
const SKIP_DIRS = /^(\$|\.|System Volume Information$|node_modules$)/; // hidden, system and recycle-bin folders

// Add the subfolders of one project folder to list. Returns how many were new.
function scanRootInto(list, root) {
  const ignored = settings().ignoredProjects;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0; // missing or unreadable: leave what we have
  }
  let added = 0;
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.test(e.name)) continue;
    const p = path.join(root, e.name);
    if (list.some((x) => same(x.path, p)) || ignored.some((x) => same(x, p))) continue;
    list.push({ id: newId(), name: e.name, path: p, root: path.resolve(root) });
    added++;
  }
  return added;
}

export function projects() {
  let list = readJson(PROJECTS, null);
  let changed = false;
  if (!list) {
    list = [];
    for (const r of settings().projectRoots) scanRootInto(list, r); // first run
    changed = true;
  }
  // lists saved by older versions have no "root": ones sitting directly inside a project folder came from it
  const roots = settings().projectRoots.map((r) => path.resolve(r));
  if (list.some((p) => p.root === undefined && p.manual === undefined)) {
    // An older version did not remember projects removed by hand, so a rescan would bring them back. Folders that are
    // inside a project folder but missing from this list were removed on purpose: remember that before anything rescans.
    const s = settings();
    const missing = [];
    for (const r of roots) {
      let entries = [];
      try {
        entries = fs.readdirSync(r, { withFileTypes: true });
      } catch {
        /* folder gone: nothing to remember */
      }
      for (const e of entries) {
        const p = path.join(r, e.name);
        if (e.isDirectory() && !SKIP_DIRS.test(e.name) && !list.some((x) => same(x.path, p)) && !s.ignoredProjects.some((x) => same(x, p))) missing.push(p);
      }
    }
    if (missing.length) saveSettings({ ignoredProjects: [...s.ignoredProjects, ...missing] });
  }
  for (const p of list) {
    if (p.root === undefined && p.manual === undefined) {
      const parent = roots.find((r) => same(r, path.dirname(p.path)));
      if (parent) p.root = parent;
      else p.manual = true;
      changed = true;
    }
  }
  if (changed) writeJson(PROJECTS, list);
  return list;
}

export function addProject(p) {
  p = path.resolve(p);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('Folder does not exist');
  const s = settings();
  if (s.ignoredProjects.some((x) => same(x, p))) saveSettings({ ignoredProjects: s.ignoredProjects.filter((x) => !same(x, p)) });
  const list = projects();
  const found = list.find((x) => same(x.path, p));
  if (found) return found;
  const proj = { id: newId(), name: path.basename(p) || p, path: p, manual: true };
  list.push(proj);
  writeJson(PROJECTS, list);
  return proj;
}

export function removeProject(id) {
  const list = projects();
  const p = list.find((x) => x.id === id);
  if (!p) return;
  // one that came from a project folder would come back at the next scan, so remember that it was removed
  if (p.root) {
    const s = settings();
    saveSettings({ ignoredProjects: [...s.ignoredProjects, p.path] });
  }
  writeJson(PROJECTS, list.filter((x) => x.id !== id));
}

// ---- project folders (the places we look for projects) ----

export function projectRoots() {
  const list = projects();
  return settings().projectRoots.map((r) => ({
    path: r,
    exists: fs.existsSync(r),
    count: list.filter((p) => p.root && same(p.root, path.resolve(r))).length,
  }));
}

export function addRoot(p) {
  p = path.resolve(p);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('That folder does not exist');
  const s = settings();
  const already = s.projectRoots.some((r) => same(path.resolve(r), p));
  // adding a folder again is a fresh start for it: forget projects that were hidden by hand
  saveSettings({
    projectRoots: already ? s.projectRoots : [...s.projectRoots, p],
    ignoredProjects: s.ignoredProjects.filter((x) => !same(path.dirname(x), p)),
  });
  const list = projects();
  const added = scanRootInto(list, p);
  writeJson(PROJECTS, list);
  return { added, already, roots: projectRoots() };
}

export function removeRoot(p) {
  p = path.resolve(p);
  const s = settings();
  saveSettings({ projectRoots: s.projectRoots.filter((r) => !same(path.resolve(r), p)) });
  const before = projects();
  const after = before.filter((x) => !(x.root && same(x.root, p))); // projects added by hand stay
  writeJson(PROJECTS, after);
  return { removed: before.length - after.length, roots: projectRoots() };
}

// Look again in every project folder for new subfolders (also done each time the server starts).
export function rescanRoots() {
  const list = projects();
  let added = 0;
  for (const r of settings().projectRoots) added += scanRootInto(list, r);
  if (added) writeJson(PROJECTS, list);
  return added;
}

// ---- conversations -------------------------------------------------------

const convFile = (id) => path.join(dirs.chats, `${id.replace(/[^\w-]/g, '')}.json`);

export function listConversations() {
  return fs
    .readdirSync(dirs.chats)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dirs.chats, f), null))
    .filter(Boolean)
    .map(({ id, title, projectId, mode, modelId, updated, created }) => ({ id, title, projectId, mode, modelId, updated, created }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export function getConversation(id) {
  return readJson(convFile(id), null);
}

export function createConversation({ projectId = null, mode = 'chat', modelId = null, title = 'New chat' } = {}) {
  const now = new Date().toISOString();
  const conv = { id: newId(), title, projectId, mode, modelId, created: now, updated: now, messages: [] };
  writeJson(convFile(conv.id), conv);
  return conv;
}

export function saveConversation(conv) {
  conv.updated = new Date().toISOString();
  writeJson(convFile(conv.id), conv);
  return conv;
}

export function deleteConversation(id) {
  fs.rmSync(convFile(id), { force: true });
}
