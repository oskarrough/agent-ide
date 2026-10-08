// What every example shares: a server and runners on a free port with a throwaway store. VERBOSE=1 shows their output.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { messageText as text, serveRunner } from '../remote.js';

export const repo = path.resolve(import.meta.dirname, '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const free = (port) => new Promise((resolve) => {
  const probe = net.createServer().once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});
let port = 4001;
while (!(await free(port))) port++;
export const base = `http://127.0.0.1:${port}`;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-ide-example-'));
export const db = path.join(tmp, 'store.sqlite');
export const dir = path.join(tmp, 'folder');
mkdirSync(dir);
// Runners get a home of their own, so no pi logins; 11-real-model lends them the real one.
const home = path.join(tmp, 'home');
mkdirSync(home);

const procs = new Set();
process.on('exit', () => {
  for (const p of procs) p.kill();
  rmSync(tmp, { recursive: true, force: true });
});
process.on('SIGINT', () => process.exit(130));

function start(file, args = [], env = {}) {
  const p = spawn('bun', [file, ...args], { cwd: repo, env: { ...process.env, PORT: String(port), DB_PATH: db, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${file}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${file} err] ${d}`));
  procs.add(p);
  p.on('exit', () => procs.delete(p));
  return p;
}

export async function server(env = {}) {
  const p = start('server.js', [], env);
  await until(() => api('GET', '/api/server').then((r) => r.status === 200));
  return p;
}

export async function runner(name, { args = [], env = {}, wait = true } = {}) {
  const p = start('runner.js', ['--server', base, '--name', name, '--dir', dir, ...args], { HOME: home, ...env });
  if (wait) await until(() => api('GET', '/api/runners').then((r) => r.json.some((x) => x.name === name && x.online)));
  return p;
}

export async function api(method, route, body, user = 'oskar') {
  const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body && JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
export const view = async (id) => (await api('GET', `/api/threads/${id}`)).json;
// An agent's own Pi conversation in a thread: its entries and docs.
export const conversationOf = async (v, name) => (await api('GET', `/api/conversations/${v.agents.find((a) => a.name === name)?.conversation}`)).json;
export const answers = (v) => v.entries.filter((e) => e.data.answer);
export const brief = (v) => JSON.stringify(v?.entries.map((e) => [e.id, e.data.author, e.data.body.slice(0, 40)]));
export { text };

export async function until(fn, ms = 8000, every = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}

export const answered = (id, n = 1, ms) => until(async () => {
  const v = await view(id);
  return answers(v).length >= n && !['working', 'blocked'].includes(v.status) ? v : null;
}, ms);

let failed = 0;
export function check(ok, what, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` ${extra}`}`);
  if (!ok) failed++;
}
export function done() {
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
}

// A runner in this process, reconnecting like runner.js, whose only model, echo/echo, answers route(request).
export async function scriptedRunner(name, route, { onTell } = {}) {
  const script = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }], tokensPerSecond: 200 });
  script.setResponses(Array.from({ length: 200 }, () => route));
  const models = createModels();
  models.setProvider(script.provider);
  let socket, closing = false;
  const connect = () => {
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${new URLSearchParams({ runner: name, dir, model: 'echo/echo' })}`);
    const r = serveRunner({ name, dir, models, resolve: () => ({ model: script.getModel() }), echo: script, send: (t) => socket.readyState === WebSocket.OPEN && socket.send(t), onTell });
    socket.onmessage = ({ data }) => r.receive(data);
    socket.onclose = () => { r.stopAll(); if (!closing) setTimeout(connect, 300); };
    socket.onerror = () => {};
  };
  connect();
  await until(() => api('GET', '/api/runners').then((r) => r.json.some((x) => x.name === name && x.online)));
  return { close: () => { closing = true; socket.close(); } };
}

export const say = (t) => fauxAssistantMessage([fauxText(t)]);
export const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
