// Connects this machine to one server and answers the entries addressed to it. It never decides when to act.
// bun runner.js --server http://localhost:3000 [--name oskar-laptop] [--alias "Oskar's laptop"] [--dir ~/code/foo]
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openDurable } from './durable.js';

const { values: args } = parseArgs({ options: {
  server: { type: 'string', default: 'http://localhost:3000' },
  name: { type: 'string', default: os.hostname() },
  // A human-readable second name, set here so it survives a server restart. The name stays the key.
  alias: { type: 'string', default: '' },
  dir: { type: 'string', default: process.cwd() },
  owner: { type: 'string', default: os.userInfo().username },
} });
args.dir = path.resolve(args.dir);
const server = new URL(args.server).origin;
const name = args.name;

// One-shot harnesses are whatever coding agent binaries this machine has, signed in with this user's logins.
// Each answer is a fresh process that gets the whole thread as its prompt.
const oneShot = {
  claude: (prompt, { model, effort }) => ['claude', ['-p', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), prompt]],
  codex: (prompt, { model, effort }) => ['codex', ['exec', '--skip-git-repo-check', '-s', 'workspace-write', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), prompt]],
  pi: (prompt, { model, effort }) => ['pi', ['-p', ...(model ? ['--model', model] : []), ...(effort ? ['--thinking', effort] : []), prompt]],
};
const installed = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
// shell runs the entry as a command; echo repeats it, for testing.
const harnesses = ['pi-durable', 'shell', 'echo', ...Object.keys(oneShot).filter(installed)];
const children = new Set();
// Entries this runner is answering. The server sends them again after a reconnect; they are answered once.
const answering = new Set();

// Stopping the runner stops its work too, rather than leaving agents running for nobody.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const child of children) child.kill();
  process.exit(0);
});

async function api(path, options) {
  const response = await fetch(server + path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
const post = (path, value) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': name }, body: JSON.stringify(value) });

function execute(bin, argv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      children.delete(child);
      resolve({ code, stdout: stdout.trim().slice(-20000), stderr: stderr.trim().slice(-20000) });
    });
  });
}

// pi-durable runs in this process, on one file per runner, and finishes after a restart what it started before it.
const durable = await openDurable({
  file: path.join(os.homedir(), '.agent-ide', `${name}.sqlite`),
  finish: (entryId, result) => post(`/api/entries/${entryId}/reply`, result).catch((error) => console.error(error.message)),
  live: (entryId, progress) => post(`/api/entries/${entryId}/live`, progress).catch(() => {}),
});

// What the harness says back. pi-durable answers with its steps; shell with a command's output; the rest with text.
async function respond(asked) {
  const { harness, dir } = asked.to;
  const me = `${harness}@${name}`;
  if (harness === 'shell') return execute('sh', ['-c', asked.body], folder(dir));
  if (harness === 'echo') return { body: `${me} in ${folder(dir)} heard: ${asked.body}` };
  const entries = await api(`/api/threads/${asked.threadId}/entries`);
  if (harness === 'pi-durable') return durable.reply(asked, entries, me, folder(dir));
  if (!oneShot[harness]) throw new Error(`${name} has no harness ${harness}`);
  const transcript = entries.filter((e) => ['chat', 'exec'].includes(e.kind)).map((e) => `${e.author}: ${e.body}`).join('\n');
  const [bin, argv] = oneShot[harness](`You are ${me} in a chat with humans and agents. Answer the last entry.\n\n${transcript}`, asked.to);
  const { code, stdout, stderr } = await execute(bin, argv, folder(dir));
  if (code !== 0) throw new Error(stderr || `${bin} exited ${code}`);
  return { body: stdout };
}

// Commands run in a folder under --dir, never outside it.
function folder(dir) {
  const full = path.resolve(args.dir, dir || '.');
  if (full !== args.dir && !full.startsWith(args.dir + path.sep)) throw new Error(`${dir} is outside ${name}'s folder`);
  return full;
}

async function handle(asked) {
  if (answering.has(asked.id)) return;
  answering.add(asked.id);
  console.log(`${asked.to.harness} answers ${asked.author} in ${asked.threadId}`);
  let result;
  try { result = await respond(asked); } catch (error) { result = { error: error.message }; }
  await post(`/api/entries/${asked.id}/reply`, result).finally(() => answering.delete(asked.id));
}

function connect() {
  const query = new URLSearchParams({ runner: name, alias: args.alias, owner: args.owner, host: os.hostname(), harnesses: harnesses.join(',') });
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`);
  socket.onopen = () => console.log(`${name} online at ${server} with ${harnesses.join(', ')} in ${args.dir}`);
  socket.onmessage = ({ data }) => {
    const { entry } = JSON.parse(data);
    if (entry) handle(entry).catch((error) => console.error(error.message));
  };
  socket.onclose = () => {
    console.log(`disconnected from ${server}; retrying…`);
    setTimeout(connect, 2000);
  };
  socket.onerror = () => {};
}

connect();
