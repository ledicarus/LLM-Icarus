import * as engine from './engine.js';
import * as models from './models.js';
import * as store from './store.js';
import { runAgent } from './agent.js';

// Picks the right runner for the conversation's mode.
export function runTurn(conv, text, opts) {
  return conv.mode === 'code' ? runAgent(conv, text, opts) : runChat(conv, text, opts);
}

// Sends the conversation to the loaded model and streams the reply.
// onEvent receives { type: 'delta' | 'thinking', text } as they arrive.
// Returns the finished assistant text. Persists the conversation either way.
export async function runChat(conv, userText, { signal, onEvent = () => {} } = {}) {
  const model = models.get(conv.modelId);
  if (!model) throw new Error('Pick a model first');
  if (model.kind === 'image') throw new Error(`${model.name} is an image model; use Image mode`);
  if (!engine.status().installed) throw new Error('The engine is not installed yet');

  const { ctx, kvQuant } = store.settings();
  await engine.load(model, { ctx, kvQuant });

  conv.messages.push({ role: 'user', content: userText });
  if (conv.title === 'New chat') conv.title = userText.replace(/\s+/g, ' ').slice(0, 60);
  store.saveConversation(conv);

  const res = await fetch(`${engine.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: conv.messages.map(({ role, content }) => ({ role, content })),
      stream: true,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Engine error ${res.status}: ${await res.text()}`);

  let text = '';
  let thinking = '';
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let delta;
        try {
          delta = JSON.parse(payload).choices?.[0]?.delta;
        } catch {
          continue;
        }
        if (!delta) continue;
        if (delta.reasoning_content) {
          thinking += delta.reasoning_content;
          onEvent({ type: 'thinking', text: delta.reasoning_content });
        }
        if (delta.content) {
          text += delta.content;
          onEvent({ type: 'delta', text: delta.content });
        }
      }
    }
  } finally {
    // keep whatever arrived, even if the user hit Stop
    if (text || thinking) conv.messages.push({ role: 'assistant', content: text, ...(thinking && { thinking }) });
    store.saveConversation(conv);
  }
  return text;
}
