// A coding run is not a new verb: create a child thread pinned to where a bot works, ask the bot to reply there. The server reports back to the parent.
// bun delegate.js --server URL --parent THREAD --bot coder [--runner laptop] [--cli codex] [--model M] [--dir proj] [--user oskar] "task"
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  server: { type: 'string', default: 'http://localhost:3000' },
  parent: { type: 'string' },
  bot: { type: 'string' },
  runner: { type: 'string' },
  cli: { type: 'string' },
  model: { type: 'string' },
  dir: { type: 'string' },
  user: { type: 'string', default: 'anon' },
} });
const server = new URL(args.server).origin;
const task = positionals.join(' ');

async function post(path, value) {
  const response = await fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': args.user }, body: JSON.stringify(value) });
  return { ok: response.ok, value: await response.json() };
}

// The job runs as a registered bot; runner, cli, model and folder default to the bot's.
const bot = (await (await fetch(`${server}/api/bots`)).json()).find((b) => b.name === args.bot);
if (!bot) throw new Error(`No bot named ${args.bot} on ${server}; register one first`);
const pin = { runner: args.runner || bot.runner, cli: args.cli || bot.cli, model: args.model || bot.model, dir: args.dir || bot.dir };
// The child is a job: pinned to that runner, cli and folder, so later replies there run there too.
const { value: child } = await post('/api/threads', { title: task.slice(0, 60), parent: args.parent, ...pin });
await post(`/api/threads/${args.parent}/events`, { author: bot.name, kind: 'bot', body: `On it in thread:${child.id}` });
await post(`/api/threads/${child.id}/events`, { author: args.user, body: task });
// The server posts the result back to the parent when the job ends, even if it had to wait for its runner.
const { ok, value } = await post(`/api/threads/${child.id}/reply`, { bot: bot.name });
console.log(value.queued ? 'waiting for runner' : ok ? 'done' : 'failed', child.id);
