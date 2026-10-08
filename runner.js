import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { load } from './modules.js';
import { serveRunner } from './remote.js';

const { values: args } = parseArgs({ options: {
  server: { type: 'string', default: 'http://localhost:3000' },
  name: { type: 'string', default: os.hostname() },
  alias: { type: 'string', default: '' },
  dir: { type: 'string', default: process.cwd() },
  owner: { type: 'string', default: '' },
} });
const dir = path.resolve(args.dir);
const server = new URL(args.server).origin;
const name = args.name;

const piDir = path.join(os.homedir(), '.pi', 'agent');
const authFile = path.join(piDir, 'auth.json');

// Read fresh every time, so a token pi refreshed is the one we use, and the other way round.
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
const echo = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }] });
models.setProvider(echo.provider);

function defaultModel() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(piDir, 'settings.json'), 'utf8'));
    return settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : '';
  } catch { return ''; }
}

const modules = await load('runner', { status: true }, { name, server });

function connect() {
  const query = new URLSearchParams({ runner: name, alias: args.alias, owner: args.owner, host: os.hostname(), dir, model: defaultModel() });
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`);
  const runner = serveRunner({ name, dir, models, echo, send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
    onTell: (message) => { for (const m of modules) m.told?.(message); } });
  socket.onopen = () => console.log(`${name} online at ${server}, lending pi's logins and ${dir}`);
  socket.onmessage = ({ data }) => runner.receive(data);
  socket.onclose = () => {
    runner.stopAll();
    for (const m of modules) m.disconnected?.();
    console.log(`disconnected from ${server}; retrying…`);
    setTimeout(connect, 2000);
  };
  socket.onerror = () => {};
}

connect();
