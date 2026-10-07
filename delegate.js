// Hands a task off from a thread: a child thread, and the task as its first entry, addressed to an agent.
// The server reports each answer back to the parent, so this script can exit right away.
// bun delegate.js --server URL --parent THREAD --runner laptop --harness codex [--model M] [--effort high] [--dir proj] [--user oskar] "task"
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  server: { type: 'string', default: 'http://localhost:3000' },
  parent: { type: 'string' },
  runner: { type: 'string' },
  harness: { type: 'string', default: 'pi-durable' },
  model: { type: 'string' },
  effort: { type: 'string' },
  dir: { type: 'string' },
  user: { type: 'string', default: 'anon' },
} });
const server = new URL(args.server).origin;
const task = positionals.join(' ');

async function post(path, value) {
  const response = await fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': args.user }, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

const { runner, harness, model, effort, dir } = args;
const child = await post('/api/threads', { title: task.slice(0, 60), parent: args.parent });
const asked = await post(`/api/threads/${child.id}/entries`, { body: task, to: { runner, harness, model, effort, dir } });
console.log(`handed off in thread ${child.id}, entry ${asked.id}`);
