// A fake director: @mentioned bots reply, in order; otherwise the last bot to speak in the thread answers.
// It only uses the public API; stop it and threads stay silent until someone calls reply.
// bun director.js --server http://localhost:3000
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { server: { type: 'string', default: 'http://localhost:3000' } } });
const server = new URL(args.server).origin;
const handled = new Set();

async function api(path, options) {
  const response = await fetch(server + path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
const post = (path, value, user) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': user }, body: JSON.stringify(value) });

// Who speaks next. Swap this function to change the policy.
// A job's bot answers on the job's runner, so steering a job is just posting in it.
function choose(bots, entries) {
  const last = entries.at(-1);
  const mentioned = bots.filter((b) => new RegExp(`@${b.name}\\b`).test(last.body)).map((b) => b.name);
  if (mentioned.length) return mentioned;
  const previous = entries.findLast((e) => e.kind === 'bot' && e.type === 'chat');
  return previous ? [previous.author] : [];
}

async function consider(threadId) {
  const [bots, entries] = await Promise.all([api('/api/bots'), api(`/api/threads/${threadId}/events`)]);
  const last = entries.at(-1);
  if (!last || last.kind !== 'human' || last.type !== 'chat' || handled.has(last.id)) return;
  handled.add(last.id);
  // One at a time, so the second bot hears the first.
  for (const bot of choose(bots, entries)) {
    console.log(`${bot} replies to ${last.author} in ${threadId}`);
    await post(`/api/threads/${threadId}/reply`, { bot }, last.author).catch((error) => console.error(error.message));
  }
}

function connect() {
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws`);
  socket.onopen = () => console.log(`directing ${server}`);
  socket.onmessage = ({ data }) => {
    const { threadId } = JSON.parse(data);
    if (threadId) consider(threadId).catch((error) => console.error(error.message));
  };
  socket.onclose = () => setTimeout(connect, 2000);
  socket.onerror = () => {};
}

connect();
