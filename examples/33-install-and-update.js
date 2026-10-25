// `curl -fsSL <server>/runner.sh | sh` installs a runner from the server and starts it. When the server is deployed
// with a different runner, the installed one updates itself once it's idle, and answers again. A runner started from
// a checkout is told it's outdated, and carries on.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, appendFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answered, api, base, check, db, dir, done, repo, runner, server, until } from './lib.js';

const tmp = path.dirname(db);
const HOME = path.join(tmp, 'installed-home');
mkdirSync(HOME);
const installed = path.join(HOME, '.agent-ide', 'runner');
const procs = [];
process.on('exit', () => { for (const p of procs) try { process.kill(-p.pid); } catch {} });
const start = (command, args, options) => {
  const p = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${args[0]}] ${d}`));
  p.stderr.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${args[0]} err] ${d}`));
  procs.push(p);
  return p;
};
const runnerOf = async (name) => (await api('GET', '/api/runners')).json.find((r) => r.name === name);
const ask = async (id, n) => {
  await api('POST', `/api/threads/${id}/entries`, { body: `hello ${n}`, to: { runner: 'fresh', model: 'echo/echo' } });
  return (await answered(id, n, 20000))?.entries.at(-1).data.body ?? '';
};

let srv = await server();
const port = new URL(base).port;
start('sh', ['-c', `curl -fsSL ${base}/runner.sh | sh -s -- --dir ${dir} --name fresh`], { env: { ...process.env, HOME } });
check(await until(async () => (await runnerOf('fresh'))?.online, 60000), 'the curl line installs a runner and connects it');
const before = readFileSync(path.join(installed, 'version'), 'utf8');
check(!(await runnerOf('fresh')).outdated, 'it runs the server\'s own runner');
const { json: { id } } = await api('POST', '/api/threads', { title: 'installed' });
check((await ask(id, 1)).includes('echo@fresh heard'), 'an agent on it answers');

// A deploy: the server again, from a copy whose runner differs by one line.
const deployed = path.join(tmp, 'deployed');
mkdirSync(deployed);
for (const f of readdirSync(repo).filter((f) => /\.(js|html|json)$/.test(f))) cpSync(path.join(repo, f), path.join(deployed, f));
symlinkSync(path.join(repo, 'node_modules'), path.join(deployed, 'node_modules'));
appendFileSync(path.join(deployed, 'remote.js'), '// deployed\n');
srv.kill('SIGTERM');
await new Promise((r) => srv.on('exit', r));
srv = start(process.execPath, ['server.js'], { cwd: deployed, env: { ...process.env, PORT: port, HOST: '127.0.0.1', DB_PATH: db } });

const updated = await until(async () => {
  const r = await runnerOf('fresh');
  return r?.online && !r.outdated && readFileSync(path.join(installed, 'remote.js'), 'utf8').includes('// deployed');
}, 60000);
check(updated, 'after the deploy the runner fetches the new one, restarts and reconnects');
check(readFileSync(path.join(installed, 'version'), 'utf8') !== before, 'its version is the deployed one');
check((await ask(id, 2)).includes('echo@fresh heard'), 'and it answers again, in the same thread');

await runner('checkout');
await new Promise((r) => setTimeout(r, 2000));
const checkout = await runnerOf('checkout');
check(checkout?.outdated && checkout.online, 'a runner from a checkout is outdated, and stays up');
done();
