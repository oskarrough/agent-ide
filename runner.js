// Connects this machine to one server and does the jobs it hands over. It never decides when to act.
// bun runner.js --server http://localhost:3000 [--name oskar-laptop] [--alias "Oskar's laptop"] [--dir ~/code/foo]
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

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

// Coding agent CLIs are whatever binaries this machine has, signed in with this user's logins.
const commands = {
  claude: (prompt, model) => ['claude', ['-p', ...(model ? ['--model', model] : []), prompt]],
  codex: (prompt, model) => ['codex', ['exec', '--skip-git-repo-check', '-s', 'workspace-write', ...(model ? ['-m', model] : []), prompt]],
  pi: (prompt, model) => ['pi', ['-p', ...(model ? ['--model', model] : []), prompt]],
};
const installed = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const clis = ['echo', ...Object.keys(commands).filter(installed)];
const children = new Set();

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

function run(bin, argv, cwd) {
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

async function reply(job) {
  const messages = await api(`/api/threads/${job.threadId}/events`);
  if (job.cli === 'echo' || !commands[job.cli]) return `${job.bot}${job.soul ? ` (${job.soul})` : ''} via ${name} (${folder(job.dir)}) heard: ${messages.at(-1)?.body ?? 'nothing'}`;
  const transcript = messages.filter((m) => m.type !== 'system').map((m) => `${m.author}: ${m.body}`).join('\n');
  const soul = job.soul ? `\n\n${job.soul}` : '';
  const [bin, argv] = commands[job.cli](`You are ${job.bot} in a group chat.${soul}\n\nReply to the conversation.\n\n${transcript}`, job.model);
  const { code, stdout, stderr } = await run(bin, argv, folder(job.dir));
  if (code !== 0) throw new Error(stderr || `${bin} exited ${code}`);
  return stdout;
}

// Commands run in a folder under --dir, never outside it.
function folder(dir) {
  const full = path.resolve(args.dir, dir || '.');
  if (full !== args.dir && !full.startsWith(args.dir + path.sep)) throw new Error(`${dir} is outside ${name}'s folder`);
  return full;
}

async function handle(job) {
  console.log(`${job.kind} for ${job.author} in ${job.threadId}`);
  let result;
  try {
    result = job.kind === 'exec' ? await run('sh', ['-c', job.command], folder(job.dir)) : { body: await reply(job) };
  } catch (error) { result = { error: error.message }; }
  await api(`/api/jobs/${job.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
}

function connect() {
  const query = new URLSearchParams({ runner: name, alias: args.alias, owner: args.owner, host: os.hostname(), clis: clis.join(',') });
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`);
  socket.onopen = () => console.log(`${name} online at ${server} with ${clis.join(', ')} in ${args.dir}`);
  socket.onmessage = ({ data }) => {
    const { job } = JSON.parse(data);
    if (job) handle(job).catch((error) => console.error(error.message));
  };
  socket.onclose = () => {
    console.log(`disconnected from ${server}; retrying…`);
    setTimeout(connect, 2000);
  };
  socket.onerror = () => {};
}

connect();
