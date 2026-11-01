#!/usr/bin/env node
// Sends prompts to a running LLM Icarus app on this computer and prints the reply.
//   node icarus.mjs status
//   node icarus.mjs models
//   node icarus.mjs projects
//   node icarus.mjs ask "prompt" [--model NAME_OR_ID] [--project NAME_OR_ID] [--mode chat|code] [--conversation ID] [--timeout MINUTES]
// Set ICARUS_PORT if the app is not on the default port (3210).

const BASE = `http://127.0.0.1:${process.env.ICARUS_PORT || 3210}`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function call(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, options);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') fail('Timed out waiting for LLM Icarus. The task may still be running in the app.', 3);
    fail(`Could not reach LLM Icarus at ${BASE}. It is not running (or the app was closed or restarted mid-task). Ask the user to open LLM Icarus, then try again.`, 2);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) fail(`LLM Icarus answered ${res.status}: ${body?.error || text}`);
  return body;
}

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

// Match by exact id, then exact name, then a unique partial name.
function pick(list, wanted, what) {
  const w = String(wanted).toLowerCase();
  const found =
    list.find((x) => x.id === wanted) || list.find((x) => x.name.toLowerCase() === w) || (() => {
      const partial = list.filter((x) => x.name.toLowerCase().includes(w));
      return partial.length === 1 ? partial[0] : null;
    })();
  if (!found) fail(`No ${what} matches "${wanted}". Available: ${list.map((x) => x.name).join(', ')}`);
  return found;
}

if (command === 'status') {
  const e = await call('/api/engine');
  console.log(JSON.stringify({ running: true, engineInstalled: e.installed, loadedModel: e.loaded?.name ?? null, gpu: e.gpu?.name ?? null }, null, 2));
} else if (command === 'models') {
  const list = await call('/api/models');
  for (const m of list.filter((x) => x.kind !== 'image' && x.exists !== false)) console.log(`${m.id}  ${m.name}  (${(m.size / 1e9).toFixed(1)} GB)`);
} else if (command === 'projects') {
  for (const p of await call('/api/projects')) console.log(`${p.id}  ${p.name}  ${p.path}`);
} else if (command === 'ask') {
  const prompt = positional.join(' ').trim();
  if (!prompt) fail('Usage: icarus.mjs ask "your prompt" [--model NAME] [--project NAME] [--mode chat|code] [--conversation ID]');
  const body = { prompt, mode: flags.mode || (flags.project ? 'code' : 'chat') };
  if (flags.model) body.modelId = pick((await call('/api/models')).filter((x) => x.kind !== 'image'), flags.model, 'model').id;
  else if (!flags.conversation) {
    // default to the model that is already loaded, so nothing has to be swapped
    const e = await call('/api/engine');
    if (e.loaded?.modelId) body.modelId = e.loaded.modelId;
  }
  if (flags.project) body.projectId = pick(await call('/api/projects'), flags.project, 'project').id;
  if (body.mode === 'code' && !body.projectId && !flags.conversation) fail('Code mode needs --project (run "projects" to list them).');
  if (flags.conversation) body.conversationId = flags.conversation;
  const minutes = Number(flags.timeout) || 30;
  const out = await call('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(minutes * 60000),
  });
  console.log(out.reply);
  console.error(`(conversation ${out.conversationId})`);
} else {
  fail('Commands: status | models | projects | ask "prompt" [--model] [--project] [--mode chat|code] [--conversation] [--timeout MINUTES]');
}
