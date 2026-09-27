// Connects this machine to one server and replies in threads placed on it.
// node runner.js --server http://localhost:3000 [--name oskar-laptop] [--dir ~/code/foo]
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  server: { type: 'string', default: 'http://localhost:3000' },
  name: { type: 'string', default: os.hostname() },
  dir: { type: 'string', default: process.cwd() },
} });
const server = new URL(args.server).origin;
const name = args.name;

// Harnesses are whatever binaries this machine has, signed in with this user's logins.
const commands = {
  claude: (prompt, model) => ['claude', ['-p', ...(model ? ['--model', model] : []), prompt]],
  codex: (prompt, model) => ['codex', ['exec', '--skip-git-repo-check', ...(model ? ['-m', model] : []), prompt]],
  pi: (prompt, model) => ['pi', ['-p', ...(model ? ['--model', model] : []), prompt]],
};
const installed = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const harnesses = ['echo', ...Object.keys(commands).filter(installed)];
const busy = new Set();

async function api(path, options) {
  const response = await fetch(server + path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function run(harness, prompt, model) {
  const [bin, argv] = commands[harness](prompt, model);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd: args.dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${bin} exited ${code}`)));
  });
}

async function reply(thread, messages) {
  const last = messages.at(-1);
  if (thread.harness === 'echo' || !commands[thread.harness]) return `${name} (${args.dir}) heard: ${last.body}`;
  const transcript = messages.map((m) => `${m.author}: ${m.body}`).join('\n');
  return run(thread.harness, `You are ${thread.harness}@${name} in a group chat. Reply to the last message.\n\n${transcript}`, thread.model);
}

// A thread wants a turn when it is placed here and its newest message is from a human.
async function check(thread) {
  if (thread.runner !== name || busy.has(thread.id)) return;
  busy.add(thread.id);
  let replied = false;
  try {
    const messages = await api(`/api/threads/${thread.id}/events`);
    if (messages.at(-1)?.kind !== 'human') return;
    const author = `${thread.harness || 'echo'}@${name}`;
    console.log(`${author} replying in "${thread.title}"`);
    let body;
    try { body = await reply(thread, messages); } catch (error) { body = `error: ${error.message}`; }
    await api(`/api/threads/${thread.id}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author, kind: 'bot', body: body || '(empty reply)' }),
    });
    replied = true;
  } finally {
    busy.delete(thread.id);
  }
  // Messages that arrived while the harness ran get their own turn.
  if (replied) await checkAll(thread.id);
}

async function checkAll(threadId) {
  const threads = await api('/api/threads');
  await Promise.all(threads.filter((t) => threadId == null || t.id === threadId).map(check));
}

function connect() {
  const query = new URLSearchParams({ runner: name, host: os.hostname(), harnesses: harnesses.join(',') });
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`);
  socket.onopen = () => {
    console.log(`${name} online at ${server} with ${harnesses.join(', ')} in ${args.dir}`);
    checkAll().catch((error) => console.error(error.message));
  };
  socket.onmessage = ({ data }) => checkAll(JSON.parse(data).threadId).catch((error) => console.error(error.message));
  socket.onclose = () => {
    console.log(`disconnected from ${server}; retrying…`);
    setTimeout(connect, 2000);
  };
  socket.onerror = () => {};
}

connect();
