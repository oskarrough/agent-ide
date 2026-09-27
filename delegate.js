// A coding run is not a new verb: create a child thread, ask a bot to reply there, report back to the parent.
// bun delegate.js --server URL --parent THREAD --runner laptop --harness codex [--dir proj] [--user oskar] "task"
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  server: { type: 'string', default: 'http://localhost:3000' },
  parent: { type: 'string' },
  runner: { type: 'string' },
  harness: { type: 'string', default: 'codex' },
  model: { type: 'string' },
  dir: { type: 'string', default: '.' },
  user: { type: 'string', default: 'anon' },
} });
const server = new URL(args.server).origin;
const task = positionals.join(' ');
const bot = args.harness;

async function post(path, value) {
  const response = await fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': args.user }, body: JSON.stringify(value) });
  return { ok: response.ok, value: await response.json() };
}

const { value: child } = await post('/api/threads', { title: task.slice(0, 60), parent: args.parent });
await post(`/api/threads/${args.parent}/events`, { author: bot, kind: 'bot', body: `On it in thread:${child.id}` });
await post(`/api/threads/${child.id}/events`, { author: args.user, body: task });
const { ok, value: entry } = await post(`/api/threads/${child.id}/reply`, { bot, runner: args.runner, harness: args.harness, model: args.model, dir: args.dir });
const result = (entry.body ?? entry.entry?.body ?? entry.error).split('\n').find(Boolean).slice(0, 160);
await post(`/api/threads/${args.parent}/events`, { author: bot, kind: 'bot', body: `${ok ? 'Done' : 'Failed'}: ${result} → thread:${child.id}` });
console.log(ok ? 'done' : 'failed', child.id);
