// The plumbing every example shares, so each one reads as its scenario: a server and runners started by PID
// on a free port (4001 and up) with a throwaway store, an API client, `until` to wait, `check` to say ok or FAIL.
// VERBOSE=1 shows the server's and runners' output.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { serveRunner } from '../remote.js';

export const repo = path.resolve(import.meta.dirname, '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const free = (port) => new Promise((resolve) => {
  const probe = net.createServer().once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});
export let port = 4001;
while (!(await free(port))) port++;
export const base = `http://127.0.0.1:${port}`;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-ide-example-'));
export const db = path.join(tmp, 'store.sqlite');
export const dir = path.join(tmp, 'folder');
mkdirSync(dir);

const procs = new Set();
process.on('exit', () => {
  for (const p of procs) p.kill();
  rmSync(tmp, { recursive: true, force: true });
});
process.on('SIGINT', () => process.exit(130));

// Starts `bun file args` in the repo, pointed at this example's port and store.
export function start(file, args = [], env = {}) {
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

// A runner.js lending its folder; resolves once the server sees it online, unless `wait: false`.
export async function runner(name, { args = [], env = {}, wait = true } = {}) {
  const p = start('runner.js', ['--server', base, '--name', name, '--dir', dir, ...args], env);
  if (wait) await until(() => api('GET', '/api/runners').then((r) => r.json.some((x) => x.name === name && x.online)));
  return p;
}

export async function api(method, route, body, user = 'oskar') {
  const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body && JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
export const view = async (id) => (await api('GET', `/api/threads/${id}`)).json;
export const answers = (v) => v.entries.filter((e) => e.entry.kind === 'pi.assistant');
export const brief = (v) => JSON.stringify(v?.entries.map((e) => [e.entry.id, e.author, e.entry.kind]));
export const kinds = (v) => v.entries.map((e) => `${e.author}/${e.entry.kind}`).join(', ');
// The text of an answer or a tool result.
export const messageText = (e) => (e.entry.model?.[0]?.content ?? []).filter?.((p) => p.type === 'text').map((p) => p.text).join('') ?? '';

// Polls fn until it returns something truthy, or gives up with null.
export async function until(fn, ms = 8000, every = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}

// The thread once it has at least n answers and isn't working or waiting for a runner.
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

// A runner in this process whose model is a script: route(request) says what it answers, by what it was told last.
// It's remote.js's own serveRunner, reconnecting like runner.js does.
export async function scriptedRunner(name, route) {
  const script = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }], tokensPerSecond: 200 });
  script.setResponses(Array.from({ length: 200 }, () => route));
  const models = createModels();
  models.setProvider(script.provider);
  let socket, closing = false;
  const connect = () => {
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${new URLSearchParams({ runner: name, dir, model: 'echo/echo' })}`);
    const r = serveRunner({ name, dir, models, echo: script, send: (t) => socket.readyState === WebSocket.OPEN && socket.send(t) });
    socket.onmessage = ({ data }) => r.receive(data);
    socket.onclose = () => { r.stopAll(); if (!closing) setTimeout(connect, 300); };
    socket.onerror = () => {};
  };
  connect();
  await until(() => api('GET', '/api/runners').then((r) => r.json.some((x) => x.name === name && x.online)));
  return { close: () => { closing = true; socket.close(); } };
}

// What a script says: text, or a tool call.
export const say = (t) => fauxAssistantMessage([fauxText(t)]);
export const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
// The text of a message the script was sent.
export const text = (m) => typeof m.content === 'string' ? m.content : m.content.flatMap((p) => p.type === 'text' ? [p.text] : []).join('');
