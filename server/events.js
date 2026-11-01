// Tiny server-sent-events broadcaster used for download/install progress.
// The setup CLI (server/setup.js) subscribes with onEmit() to print the same progress to a console.
const clients = new Set();
const listeners = new Set();

export function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function onEmit(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(type, data) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) res.write(msg);
  for (const fn of listeners) fn({ type, ...data });
}
