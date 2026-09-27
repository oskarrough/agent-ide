// A fake director: when a human posts, ask the thread's default bot to reply.
// It only uses the public API; stop it and threads stay silent until someone calls reply.
// bun director.js --server http://localhost:3000 [--bot codex=laptop:codex --bot claude=box:claude:haiku]
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  server: { type: 'string', default: 'http://localhost:3000' },
  bot: { type: 'string', multiple: true, default: [] },
} });
// Each --bot is name=runner:harness[:model].
const bots = args.bot.map((spec) => {
  const [bot, rest] = spec.split('=');
  const [runner, harness, model] = rest.split(':');
  return { bot, runner, harness, model };
});
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
// With --bot: an @mention picks the bot, otherwise bots take turns. Without: the thread's default.
function choose(thread, entries) {
  if (bots.length) {
    const mentioned = bots.find((b) => entries.at(-1).body.includes(`@${b.bot}`));
    if (mentioned) return mentioned;
    const previous = entries.findLast((e) => bots.some((b) => b.bot === e.author));
    return bots[(bots.findIndex((b) => b.bot === previous?.author) + 1) % bots.length];
  }
  if (!thread.runner) return null;
  return { bot: thread.harness || 'echo', runner: thread.runner, harness: thread.harness, model: thread.model };
}

async function consider(threadId) {
  const [threads, entries] = await Promise.all([api('/api/threads'), api(`/api/threads/${threadId}/events`)]);
  const thread = threads.find((t) => t.id === threadId);
  const last = entries.at(-1);
  // Child threads belong to whoever started them, not to the director.
  if (!thread || thread.parent || !last || last.kind !== 'human' || last.type !== 'chat' || handled.has(last.id)) return;
  handled.add(last.id);
  const turn = choose(thread, entries);
  if (!turn) return;
  console.log(`${turn.bot} via ${turn.runner} replies to ${last.author} in "${thread.title}"`);
  await post(`/api/threads/${threadId}/reply`, turn, last.author).catch((error) => console.error(error.message));
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
