import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { ModelRuntime, resolveCliModel, resolveModelScopeWithDiagnostics, SettingsManager } from '@earendil-works/pi-coding-agent';
import { load } from './modules.js';
import { serveRunner } from './remote.js';

const { values: args } = parseArgs({ options: {
  server: { type: 'string', default: 'http://localhost:3000' },
  name: { type: 'string', default: os.hostname() },
  alias: { type: 'string', default: '' },
  dir: { type: 'string', default: process.cwd() },
  owner: { type: 'string', default: '' },
  allow: { type: 'string', multiple: true, default: [] },
} });
const dir = path.resolve(args.dir);
const server = new URL(args.server).origin;
const name = args.name;

// pi's own models and logins, as pi reads them; the logins never leave this machine.
const models = await ModelRuntime.create();
const echo = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }] });
models.registerNativeProvider(echo.provider);

// What `pi --model pattern` runs; no pattern is pi's default model and thinking level, from its settings in the folder.
function resolve(pattern) {
  const settings = SettingsManager.create(dir);
  const asked = pattern ? { cliModel: pattern } : { cliProvider: settings.getDefaultProvider(), cliModel: settings.getDefaultModel() };
  const found = resolveCliModel({ ...asked, modelRuntime: models });
  if (!found.model) throw new Error(found.error ?? `${name} has no default model in pi; name one`);
  return { model: found.model, thinkingLevel: found.thinkingLevel ?? (pattern ? undefined : settings.getDefaultThinkingLevel()) };
}
const defaultModel = () => { try { const { model } = resolve(''); return { model: `${model.provider}/${model.id}` }; } catch (error) { return { error: error.message }; } };

// The models pi has enabled here, as `pi --models` expands them.
async function offers() {
  const patterns = SettingsManager.create(dir).getEnabledModels() ?? [];
  const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, models);
  return [...new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`))];
}

const modules = await load('runner', { status: true }, { name, server });

async function connect() {
  const { model, error } = defaultModel();
  const query = new URLSearchParams({ runner: name, alias: args.alias, owner: args.owner, host: os.hostname(), dir, model: model ?? '', modelError: error ?? '' });
  if (error) console.log(`pi's default model doesn't resolve: ${error}`);
  for (const ref of await offers().catch(() => [])) query.append('offer', ref);
  for (const who of args.allow) query.append('allow', who);
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`);
  const runner = serveRunner({ name, dir, models, resolve, echo, send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
    onTell: (message) => { for (const m of modules) m.told?.(message); } });
  const from = args.owner ? `, to ${[args.owner, ...args.allow].join(', ')}` : '';
  socket.onopen = () => console.log(`${name} online at ${server}, lending pi's logins and ${dir}${from}`);
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
