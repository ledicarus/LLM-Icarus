import * as engine from './engine.js';

// One question to the loaded chat model. The answer is streamed and collected: a plain request that waits for the whole
// answer gives up after 5 minutes (Node's fetch limit), and a slow model thinking through a design can take far longer.
// Returns { text, thinking, finish }.
export async function complete(messages, { maxTokens = 4000, temperature = 0.4, signal } = {}) {
  const res = await fetch(`${engine.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature, max_tokens: maxTokens, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`Engine error ${res.status}: ${await res.text()}`);
  let text = '';
  let thinking = '';
  let finish = '';
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = ev.choices?.[0];
      if (!choice) continue;
      text += choice.delta?.content || '';
      thinking += choice.delta?.reasoning_content || '';
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return { text, thinking, finish };
}
