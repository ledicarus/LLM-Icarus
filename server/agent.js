import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dirs } from './paths.js';
import * as platform from './platform.js';
import * as engine from './engine.js';
import * as models from './models.js';
import * as store from './store.js';

// Code mode: runs the Claude Code CLI headless inside the project folder, pointed at our own
// llama-server (which speaks the Anthropic Messages API). Same agent as `claude-local`,
// minus Ollama.

const claudePath = () => store.settings().claudePath || platform.claudeCliPath();

// Extra instructions for small local models, which tend to answer from guesswork or ask permission instead of
// using their tools (for example: "I don't see a readme.md here, want me to search?" when README.md was right there).
const LOCAL_AGENT_GUIDANCE = [
  'You are a coding assistant working inside the user\'s project folder on their own computer, using tools.',
  'Rules:',
  '1. Act, do not ask. When the user names a file or a task, use your tools right away. Never ask permission to use a tool, and never ask whether to search.',
  '2. Never say a file does not exist without checking. First try Read with the name the user gave (file names are not case sensitive on this computer, so "readme.md" finds README.md). If that fails, use Glob with a pattern such as "**/*readme*" and read what it finds.',
  '3. Never guess what a file contains. Read it.',
  '4. Read large files in pieces using offset and limit rather than all at once.',
  '5. When you are done, answer briefly and plainly, based only on what you actually read or did.',
].join('\n');

// People type file names in any case ("readme.md"), and a small model then decides the file does not exist without even
// trying. Rewrite names in the request to match the real file names in the project's top-level folder.
function fixFileNameCase(text, dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return text;
  }
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  return text.replace(/[\w.-]+\.\w{1,6}/g, (token) => {
    const real = byLower.get(token.toLowerCase());
    return real && real !== token ? real : token;
  });
}

const truncate = (s, n = 4000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text || '').join('\n');
  return '';
}

export async function runAgent(conv, userText, { signal, onEvent = () => {} } = {}) {
  const project = store.projects().find((p) => p.id === conv.projectId);
  if (!project) throw new Error('Code mode needs a project: pick one in the sidebar first');
  if (!fs.existsSync(project.path)) throw new Error(`Project folder is missing: ${project.path}`);
  const model = models.get(conv.modelId);
  if (!model) throw new Error('Pick a model first');
  if (!engine.status().installed) throw new Error('The engine is not installed yet');
  const exe = claudePath();
  if (!fs.existsSync(exe)) throw new Error(`Claude Code CLI not found at ${exe} (set "claudePath" in data/settings.json)`);

  // Claude Code's system prompt plus tool definitions is ~4k tokens, so it needs more context than chat.
  // Thinking is off by default here: on a 12 GB card the extra tokens make each agent step crawl.
  const { codeCtx, kvQuant, codeAllowShell, codeThinking } = store.settings();
  await engine.load(model, { ctx: codeCtx, kvQuant, reasoning: codeThinking ? 'on' : 'off' });

  conv.messages.push({ role: 'user', content: userText });
  if (conv.title === 'New chat') conv.title = userText.replace(/\s+/g, ' ').slice(0, 60);
  store.saveConversation(conv);

  const shellTools = platform.IS_WIN ? ['Bash', 'PowerShell'] : ['Bash'];
  const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...(codeAllowShell ? shellTools : [])];
  const args = [
    '-p', fixFileNameCase(userText, project.path),
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', tools.join(','),
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',
    '--append-system-prompt', LOCAL_AGENT_GUIDANCE,
    ...(codeAllowShell ? ['--allowedTools', shellTools.join(',')] : []),
    ...(conv.sessionId ? ['--resume', conv.sessionId] : []),
  ];

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // Give the agent its own empty config dir so it doesn't inherit the user's personal
  // CLAUDE.md, hooks, skills, plugins or login (a global "write HANDOFF.md" rule leaked in before).
  const configDir = path.join(dirs.engine, '..', 'agent-home');
  fs.mkdirSync(configDir, { recursive: true });
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: path.resolve(configDir),
    ANTHROPIC_BASE_URL: engine.baseUrl(),
    ANTHROPIC_AUTH_TOKEN: 'local',
    ANTHROPIC_MODEL: 'local',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'local',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'local',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'local',
    CLAUDE_CODE_SUBAGENT_MODEL: 'local',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(codeCtx),
    // A big file read can swallow the whole context window (a 95 KB HANDOFF.md is about 24k tokens). Cap each read so
    // the agent is told to read it in pieces instead.
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: String(Math.max(2000, Math.floor(codeCtx / 6))),
    // Claude Code asks for a huge reply budget by default, which can't fit in a small local context.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(8192, Math.floor(codeCtx / 4))),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });

  const child = spawn(exe, args, { cwd: project.path, env, stdio: ['ignore', 'pipe', 'pipe'], ...platform.spawnGroup() });
  const kill = () => platform.killTree(child.pid);
  signal?.addEventListener('abort', kill);

  const steps = [];
  const pendingTools = new Map();
  let finalText = '';
  let errorText = '';
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  const handle = (msg) => {
    if (msg.type === 'system' && msg.subtype === 'init') {
      conv.sessionId = msg.session_id;
    } else if (msg.type === 'assistant') {
      for (const part of msg.message?.content || []) {
        if (part.type === 'text' && part.text) {
          finalText += (finalText ? '\n\n' : '') + part.text;
          steps.push({ kind: 'text', text: part.text });
          onEvent({ type: 'text', text: part.text });
        } else if (part.type === 'thinking' && part.thinking) {
          onEvent({ type: 'thinking', text: part.thinking });
        } else if (part.type === 'tool_use') {
          const step = { kind: 'tool', name: part.name, input: part.input, result: null };
          pendingTools.set(part.id, step);
          steps.push(step);
          onEvent({ type: 'tool', id: part.id, name: part.name, input: part.input });
        }
      }
    } else if (msg.type === 'user') {
      for (const part of msg.message?.content || []) {
        if (part.type !== 'tool_result') continue;
        const text = truncate(resultText(part.content));
        const step = pendingTools.get(part.tool_use_id);
        if (step) step.result = { text, error: !!part.is_error };
        onEvent({ type: 'tool-result', id: part.tool_use_id, text, error: !!part.is_error });
      }
    } else if (msg.type === 'result') {
      if (msg.is_error) errorText = msg.result || 'The agent stopped with an error';
      else if (msg.result && !finalText) finalText = msg.result;
    }
  };

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore non-JSON noise */
      }
    }
  });

  let spawnError = null;
  const code = await new Promise((resolve) => {
    child.on('error', (e) => {
      spawnError = e;
      resolve(-1);
    });
    child.on('close', resolve);
  });
  signal?.removeEventListener('abort', kill);

  conv.messages.push({ role: 'assistant', content: finalText, ...(steps.length && { steps }) });
  store.saveConversation(conv);

  if (spawnError) throw new Error(`Could not start the agent: ${spawnError.message} (project path too long? Windows limits it to 260 characters)`);
  if (signal?.aborted) return finalText;
  if (errorText) throw new Error(errorText);
  if (code !== 0 && !finalText) throw new Error(`Agent exited with code ${code}. ${stderr.slice(-500)}`);
  return finalText;
}
