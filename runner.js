// Connects this machine to one server and lends it two things: model access with this machine's pi logins, and a folder
// to read, write and run commands in. It keeps no conversations; the server's Pi Durable harness does.
// bun runner.js --server http://localhost:3000 [--name oskar-laptop] [--alias "Oskar's laptop"] [--dir ~/code/foo]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { serveRunner } from './remote.js';

const { values: args } = parseArgs({ options: {
  server: { type: 'string', default: 'http://localhost:3000' },
  name: { type: 'string', default: os.hostname() },
  // A human-readable second name, set here so it survives a server restart. The name stays the key.
  alias: { type: 'string', default: '' },
  dir: { type: 'string', default: process.cwd() },
  owner: { type: 'string', default: os.userInfo().username },
} });
const dir = path.resolve(args.dir);
const server = new URL(args.server).origin;
const name = args.name;

const piDir = path.join(os.homedir(), '.pi', 'agent');
const authFile = path.join(piDir, 'auth.json');

// pi's auth.json, read fresh every time, so a token pi refreshed is the one we use, and one we refresh is the one pi uses.
const readAuth = () => { try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return {}; } };
let writing = Promise.resolve();
const credentials = {
  read: async (id) => readAuth()[id],
  list: async () => Object.entries(readAuth()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
  modify(id, change) {
    const done = writing.then(async () => {
      const next = await change(readAuth()[id]);
      if (next) fs.writeFileSync(authFile, JSON.stringify({ ...readAuth(), [id]: next }, null, 2), { mode: 0o600 });
      return readAuth()[id];
    });
    writing = done.catch(() => {});
    return done;
  },
  delete(id) {
    return this.modify(id, async () => undefined).then(() => {
      const { [id]: _, ...rest } = readAuth();
      fs.writeFileSync(authFile, JSON.stringify(rest, null, 2), { mode: 0o600 });
    });
  },
};

const models = builtinModels({ credentials });
// echo/echo is pi-ai's faux provider as a model: no login, answers at once, for testing the loop.
const echo = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }] });
models.setProvider(echo.provider);

// pi's default model, which the server uses when an entry names none.
function defaultModel() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(piDir, 'settings.json'), 'utf8'));
    return settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : '';
  } catch { return ''; }
}

// ── Program Status Protocol (OSC 7501) ──
// The runner tells its terminal how the threads its agents answer stand: one record per thread, by id, and its own
// root record. Messages are the agent's name, never what was asked or answered. Like pi: only when the terminal
// answers the query, or with PROGRAM_STATUS=1; PROGRAM_STATUS=0 turns it off.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
// Cut by characters so the limits hold in UTF-8: title 192 bytes, msg 2048.
const base64 = (text, max) => Buffer.from([...text.replace(CONTROL_CHARACTERS, ' ').trim()].slice(0, max).join('')).toString('base64');
function programStatus({ state, id, app, title, msg }) {
  const pairs = [`state=${state}`, id && `id=${id}`, app && `app=${app}`, title && `title=${base64(title, 48)}`, msg && `msg=${base64(msg, 500)}`];
  return `\x1b]7501;${pairs.filter(Boolean).join(':')}\x1b\\`;
}

// A terminal that speaks OSC 7501 answers its query before the device attributes every terminal answers.
function detectProgramStatus() {
  const override = process.env.PROGRAM_STATUS;
  if (override === '1' || override === '0') return Promise.resolve(override === '1');
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    let reply = '';
    const done = (supported) => {
      clearTimeout(timer);
      process.stdin.off('data', read).setRawMode(false).pause();
      resolve(supported);
    };
    const read = (chunk) => {
      reply += chunk;
      if (reply.includes('\x1b]7501;?')) done(true);
      else if (/\x1b\[\?[\d;]*c/.test(reply)) done(false);
    };
    const timer = setTimeout(() => done(false), 1000);
    process.stdin.setRawMode(true).setEncoding('utf8').on('data', read);
    process.stdout.write('\x1b]7501;?\x1b\\\x1b[c');
  });
}

const supported = await detectProgramStatus();
// Each report replaces its record whole, so a record is sent again only when it changed. Records not in `next` are cleared.
let reported = new Map();
function report(root, threads = []) {
  if (!supported) return;
  const next = new Map([['', programStatus({ state: root.state, app: 'agent-ide', msg: root.msg })]]);
  for (const t of threads) next.set(String(t.id), programStatus({ state: t.status, id: t.id, title: `#${t.id} ${t.title}`, msg: t.agent }));
  for (const id of reported.keys()) if (!next.has(id)) process.stdout.write(programStatus({ state: 'clear', id }));
  for (const [id, sequence] of next) if (reported.get(id) !== sequence) process.stdout.write(sequence);
  reported = next;
}

// A queued thread waits for an offline runner, so this one, online, never hears of one.
const statusOf = (threads) => {
  const working = threads.filter((t) => t.status === 'working').length;
  return { state: working ? 'working' : 'idle', msg: working ? `${name}: ${working} working` : `${name}: online at ${server}` };
};

function connect() {
  const query = new URLSearchParams({ runner: name, alias: args.alias, owner: args.owner, host: os.hostname(), dir, model: defaultModel() });
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`);
  const runner = serveRunner({ name, dir, models, echo, send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
    onStatus: (threads) => report(statusOf(threads), threads) });
  socket.onopen = () => console.log(`${name} online at ${server}, lending pi's logins and ${dir}`);
  socket.onmessage = ({ data }) => runner.receive(data);
  socket.onclose = () => {
    runner.stopAll();
    // Its threads go on without this runner; it hears again how they stand when it reconnects.
    report({ state: 'idle', msg: `${name}: offline, retrying ${server}` });
    console.log(`disconnected from ${server}; retrying…`);
    setTimeout(connect, 2000);
  };
  socket.onerror = () => {};
}

connect();
