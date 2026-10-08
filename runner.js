import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { ModelRuntime, resolveCliModel, SettingsManager } from '@earendil-works/pi-coding-agent';
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

// pi's own models and logins, as pi reads them; the logins never leave this machine.
const models = await ModelRuntime.create();
const echo = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }] });
models.registerNativeProvider(echo.provider);

// pi's settings as pi would read them in the runner's folder: its default model and thinking level.
const defaultModel = (settings = SettingsManager.create(dir)) =>
  settings.getDefaultProvider() && settings.getDefaultModel() ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}` : '';

// What `pi --model PATTERN` runs, by pi's own resolver; no pattern is pi's default model and thinking level.
function resolve(pattern) {
  const settings = SettingsManager.create(dir);
  const found = resolveCliModel({ cliModel: pattern || defaultModel(settings), modelRuntime: models });
  if (!found.model) throw new Error(found.error ?? `${name} has no default model in pi; name one`);
  return { model: found.model, thinkingLevel: found.thinkingLevel ?? (pattern ? undefined : settings.getDefaultThinkingLevel()) };
}

const modules = await load('runner', { status: true }, { name, server });

function connect() {
  const query = new URLSearchParams({ runner: name, alias: args.alias, owner: args.owner, host: os.hostname(), dir, model: defaultModel() });
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`);
  const runner = serveRunner({ name, dir, models, resolve, echo, send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
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
