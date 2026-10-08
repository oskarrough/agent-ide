import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AgentDoc, createRegistry, defineDoc, Harness, InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { load } from './modules.js';
import { createRunners, messageText, remoteEnv, runnerProvider } from './remote.js';

const port = Number(process.env.PORT || 3000);
const file = process.env.DB_PATH || `agent-ide-${port}.sqlite`;
// Every runner that ever connected, so its models resolve after a restart.
const Runners = defineDoc({ kind: 'agent-ide.runners', version: 1, scope: 'session', initial: () => ({}) });
// `started` maps an agent's tool call to the thread it started, so a replayed call finds it.
const Thread = defineDoc({
  kind: 'agent-ide.thread', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ title: '', parent: null, createdAt: '', createdBy: '', hidden: false, reads: {}, started: {} }),
});

const clients = new Set();
const runners = createRunners({ onChange: () => notify(null) });
const shells = new Map();
const page = await readFile(new URL('./client.html', import.meta.url));

const models = createModels();
const registry = createRegistry();
registry.install(CodingTools);
const storage = await openNodeSqliteStorage(file);
const harness = await Harness.open(storage, {
  models,
  registry,
  env: async ({ conversationId, cwd, read }) => {
    const runner = (await read.snapshot(AgentDoc, conversationId, context))?.model?.provider?.replace(/^runner:/, '');
    return runner ? remoteEnv(runners, runner, cwd) : undefined;
  },
  onReport: (error) => console.error('pi-durable:', error),
}, context);

const known = async () => (await harness.snapshot(Runners, context)) ?? {};
const thread = (id) => harness.snapshot(Thread, id, context);
const commit = (fn) => harness.commit(async (tx) => fn(tx), context);
const conversation = async (id) => {
  const found = await thread(id) && await harness.conversation(id, context);
  if (!found) throw Object.assign(new Error('Thread not found'), { status: 404 });
  return found;
};

async function collect(scan) {
  const items = [];
  let cursor;
  do {
    const page = await scan(cursor);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return items;
}

const threadIds = async () => (await collect((cursor) => commit((tx) => tx.scanConversations({}, 500, cursor)))).map((c) => c.id).sort((a, b) => b - a);

const agentName = (to) => to && `${to.model.split('/').pop()}@${to.runner}`;
const requestFor = (author, to, { key, from, re }) => new URLSearchParams({ author, ...to, ...(from ? { from } : {}), ...(re ? { re: re.join(',') } : {}), key }).toString();
function readRequest(requestId) {
  const { author, key, from, re, ...to } = Object.fromEntries(new URLSearchParams(requestId));
  return { requestId, author, key, from: from ? Number(from) : null, re: re ? re.split(',').map(Number) : null, to: to.runner && to.model ? to : null };
}
const heading = ({ author, from, re }) => from ? `${author}, ${re ? 'answering' : 'writing'} from thread ${from}: ` : `${author}: `;
const same = (a, b) => ['runner', 'model', 'effort', 'dir'].every((key) => (a?.[key] ?? '') === (b?.[key] ?? ''));
const user = (req) => req.headers['x-user'] || 'anon';
const userMessage = (text) => ({ role: 'user', content: text, timestamp: Date.now() });

function field(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function address(to) {
  if (!to) return null;
  const name = field(to.runner, 'to.runner');
  const runner = (await known())[name];
  if (!runner) throw new Error(`No runner ${name} has connected to this server`);
  const model = to.model?.trim() || runner.model;
  if (!model) throw new Error(`${name} has no default model in pi; name one as provider/model`);
  const clean = { runner: name, model };
  for (const key of ['effort', 'dir']) if (typeof to[key] === 'string' && to[key].trim()) clean[key] = to[key].trim();
  folder(runner, clean);
  return clean;
}

function folder(runner, to) {
  const cwd = path.resolve(runner.dir, to.dir || '.');
  if (cwd !== runner.dir && !cwd.startsWith(runner.dir + path.sep)) throw new Error(`${to.dir} is outside ${to.runner}'s folder`);
  return cwd;
}

async function agentOf(id) {
  const agent = await harness.snapshot(AgentDoc, id, context);
  const name = agent?.model?.provider?.match(/^runner:(.+)$/)?.[1];
  if (!name) return null;
  const runner = (await known())[name];
  const dir = runner && agent.cwd ? path.relative(runner.dir, agent.cwd) : '';
  return { runner: name, model: agent.model.modelId, ...(agent.thinkingLevel ? { effort: agent.thinkingLevel } : {}), ...(dir ? { dir } : {}) };
}

// A write asks nobody anything; Pi places it at the next boundary, never mid-run.
const write = async (threadId, entry, requestId) => (await conversation(threadId)).submit({ type: 'write', entry, requestId }, context);

async function ownInputs(id) {
  const records = await collect((cursor) => storage.scanSubmissions({ conversationId: id }, 500, cursor, context));
  return records.filter((r) => r.type === 'input' && r.requestId).map((record) => ({ ...readRequest(record.requestId), record })).sort((a, b) => a.record.id - b.record.id);
}

// A fork's inherited inputs were submitted to its source, up to the fork's entry.
async function inputs(id) {
  const { parent } = await commit((tx) => tx.conversation(id));
  const inherited = parent ? (await inputs(parent.conversationId)).filter((input) => input.record.entry <= parent.at) : [];
  return [...inherited, ...await ownInputs(id)];
}

async function entries(id) {
  const handle = await conversation(id);
  const asks = new Map();
  const replies = new Map();
  for (const input of await inputs(id)) {
    const { entry, answer } = input.record;
    if (entry !== undefined) asks.set(entry, input);
    if (answer !== undefined) replies.set(answer, [...(replies.get(answer) ?? []), entry]);
  }
  let asked = null;
  // The whole history: the view holds only the active context, which a compaction shortens.
  return (await collect((cursor) => handle.entries({}, 500, cursor, context))).reverse().map((entry) => {
    const input = asks.get(entry.id);
    if (input) asked = input;
    const author = input?.author ?? entry.data?.author
      ?? (['pi.assistant', 'pi.tool-result'].includes(entry.kind) ? agentName(asked?.to) : entry.kind.startsWith('pi.') ? 'pi' : 'server');
    const said = input && messageText(entry.model?.[0]);
    const wrote = input ? { requestId: input.requestId, from: input.from, body: said.startsWith(heading(input)) ? said.slice(heading(input).length) : said } : {};
    const re = input?.re ?? replies.get(entry.id);
    return { author, to: input?.to ?? entry.data?.to ?? null, ...wrote, ...(re ? { re } : {}), entry };
  });
}

const isResult = (entry) => (entry.kind === 'pi.assistant' && !['toolUse', 'aborted', 'error'].includes(entry.model?.[0]?.stopReason))
  || entry.kind === 'agent-ide.error' || entry.kind === 'agent-ide.shell';

// With no reader, as for a runner nobody owns, anyone's read counts.
async function status(id, row, agent, reader) {
  const live = await harness.snapshot(LiveDoc, id, context);
  const inbox = await harness.snapshot(InboxDoc, id, context);
  if (live?.run || inbox?.items?.some((item) => item.mode !== 'write')) return agent && !runners.isOnline(agent.runner) ? 'blocked' : 'working';
  if ([...shells.values()].some((run) => run.threadId === id)) return 'working';
  const seen = new Set(reader ? [row.reads[reader]] : Object.values(row.reads));
  const recent = (await (await harness.conversation(id, context)).entries({}, 50, undefined, context)).items;
  for (const entry of recent) {
    if (seen.has(entry.id)) return 'idle';
    if (isResult(entry)) return entry.kind === 'agent-ide.error' ? 'error' : 'done';
  }
  return 'idle';
}

async function threadList(reader) {
  const rows = [];
  for (const id of await threadIds()) {
    const row = await thread(id);
    if (!row || row.hidden) continue;
    const { reads, started, ...rest } = row;
    const agent = await agentOf(id);
    rows.push({ id, ...rest, agent, status: await status(id, row, agent, reader) });
  }
  return rows;
}

async function threadView(id, reader) {
  const view = await (await conversation(id)).viewState(context);
  const { conversation: record, docs } = view.value;
  view.dispose();
  const row = await thread(id);
  const agent = await agentOf(id);
  const running = [...shells.values()].filter((run) => run.threadId === id);
  return { id, ...row, agent, status: await status(id, row, agent, reader), conversation: record, docs, shells: running, entries: await entries(id) };
}

async function follow(id, requestId) {
  const record = await commit((tx) => tx.submissionByRequest(id, requestId));
  if (!record) return;
  const settled = await (await harness.submission(record.id, context)).wait(context);
  const row = await thread(id);
  const { from, re, to, key } = readRequest(requestId);
  const back = Boolean(from && !re && reply);
  if (settled.status === 'done' && !row.parent && !back) return;
  // One answer can settle several inputs at once; the first of them reports for all. A withdrawn input has no entry.
  let posts = settled.entry === undefined ? [] : [settled.entry];
  if (settled.status === 'done') {
    posts = (await ownInputs(id)).filter((input) => input.record.answer === settled.answer && input.from === from && !input.re === !re).map((input) => input.record.entry);
    if (posts[0] !== settled.entry) return;
  }
  const agent = agentName(to);
  let body;
  if (settled.status === 'done') {
    const answer = await commit((tx) => tx.entry(settled.answer));
    body = messageText(answer?.model?.[0]) || '(empty answer)';
  } else {
    body = `gave no answer: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ''}`;
    if (settled.reason !== 'aborted') await write(id, { kind: 'agent-ide.error', data: { text: `${agent} ${body}`, post: requestId } }, `error:${requestId}`);
  }
  if (back) return reply(from, id, agent, body, posts, key);
  const text = `${agent}: ${body.split('\n').find(Boolean)?.slice(0, 160)}`;
  if (row.parent) await write(row.parent, { kind: 'agent-ide.note', data: { author: agent, text: `${text} → thread:${id}`, thread: id }, model: [userMessage(`${text} (from thread ${id})`)] }, `report:${requestId}`);
}

async function shell(id, author, command, to, key) {
  const runner = (await known())[to.runner];
  const run = { threadId: id, author, to, command, stdout: '', stderr: '' };
  shells.set(key, run);
  notify(id);
  const result = await remoteEnv(runners, to.runner, folder(runner, to)).exec(command, {
    onOutput: (text, _context, info) => { run[info.stream] += text; notify(id); },
  }, context);
  const output = { code: result.ok ? result.value.exitCode : null, stdout: run.stdout.slice(-20000), stderr: run.stderr.slice(-20000), ...(result.ok ? {} : { error: result.error.message }) };
  const shown = [`exit ${output.code ?? output.error}`, output.stdout, output.stderr].filter(Boolean).join('\n');
  await write(id, { kind: 'agent-ide.shell', data: { author, to, command, ...output }, model: [userMessage(`${author} ran \`${command}\` on ${to.runner}:\n${shown}`)] }, `shell:${key}`);
  shells.delete(key);
  notify(id);
}

async function postEntry(id, author, input, { key = randomUUID(), from = null, re = null } = {}) {
  const handle = await conversation(id);
  const agent = await agentOf(id);
  const body = field(input.body, 'body');
  const command = body.match(/^\$\s+([\s\S]+)/)?.[1];
  const routed = route && !command;
  const given = 'to' in input ? await address(input.to) : routed ? null : agent;
  const to = routed ? await address(route({ body, to: given }, await inputs(id))) : given;
  if (command) {
    if (!to) throw new Error('Pick a runner to run the command on');
    shell(id, author, command, to, key).catch((error) => console.error(error));
    return { command, to };
  }
  if (!to) return write(id, { kind: 'agent-ide.chat', data: { author, body }, model: [userMessage(`${author}: ${body}`)] }, `chat:${key}`);
  const live = await harness.snapshot(LiveDoc, id, context);
  const inbox = await harness.snapshot(InboxDoc, id, context);
  const busy = live?.run || inbox?.items?.length;
  if (busy && !same(agent, to)) throw Object.assign(new Error(`${agentName(agent)} is working in this thread; wait, stop it, or ask it instead`), { status: 409 });
  if (!busy) {
    await handle.configure({
      model: { provider: `runner:${to.runner}`, modelId: to.model },
      thinkingLevel: to.effort ?? null,
      cwd: folder((await known())[to.runner], to),
      instructions: `You are ${agentName(to)} in thread ${id}, with humans and agents. Each message starts with who wrote it.`,
    }, context);
  }
  const requestId = requestFor(author, to, { key, from, re });
  const submission = await handle.submit({ type: 'input', content: `${heading({ author, from, re })}${body}`, requestId, whenBusy: input.steer ? 'steer' : 'followUp' }, context);
  follow(id, requestId).catch((error) => console.error(error));
  return { requestId, submission: submission.id, to };
}

async function createThread(author, { title, parent = null }, key) {
  if (parent !== null) {
    parent = Number(parent);
    await conversation(parent);
  }
  title = field(title, 'title');
  const id = await commit(async (tx) => {
    const started = parent && key ? ((await tx.doc(Thread, parent)).started ??= {}) : {};
    if (started[key]) return started[key];
    const created = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    Object.assign(await tx.doc(Thread, created.id), { title, parent, createdAt: new Date().toISOString(), createdBy: author });
    if (key) started[key] = created.id;
    return created.id;
  });
  if (parent) await write(parent, { kind: 'agent-ide.note', data: { author, text: `${author} handed off → thread:${id}`, thread: id } }, `handoff:${id}`);
  return { id };
}

async function forkThread(author, id, { at, title }) {
  const source = await conversation(id);
  const named = title?.trim() || `${(await thread(id)).title} (fork)`;
  const fork = await source.fork(Number(at), {
    ownership: { kind: 'ownerless' },
    init: async (tx, forkId) => {
      Object.assign(await tx.doc(Thread, forkId), { title: named, createdAt: new Date().toISOString(), createdBy: author });
    },
  }, context);
  return { id: fork.id };
}

const core = { models, runners, known, address, agentName, agentOf, heading, threadList, entries, createThread, postEntry, write, userMessage };
const modules = await load('server', { director: false, talk: true, status: true }, core);
for (const m of modules) if (m.extension) registry.install(m.extension);
const route = modules.find((m) => m.route)?.route;
const reply = modules.find((m) => m.reply)?.reply;

for (const name of Object.keys(await known())) models.setProvider(runnerProvider(runners, name));
harness.resume();
for (const id of await threadIds()) {
  if (!await thread(id)) continue;
  for (const { requestId } of await ownInputs(id)) follow(id, requestId).catch((error) => console.error(error));
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(value));
}

async function input(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200000) throw new Error('Request too large');
  }
  return JSON.parse(body || '{}');
}

const handleRequest = async (req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-user' });
    return res.end();
  }
  if (req.method === 'GET' && route === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  try {
    if (req.method === 'GET' && route === '/api/server') {
      return send(res, 200, { port, file, modules: modules.map((m) => m.name), threads: (await threadIds()).length, runners: Object.keys(await known()).length, work: await harness.inspect(context) });
    }
    if (req.method === 'GET' && route === '/api/runners') {
      return send(res, 200, Object.entries(await known()).map(([name, runner]) => ({ name, ...runner, online: runners.isOnline(name), calls: runners.working(name) })));
    }
    if (req.method === 'GET' && route === '/api/threads') return send(res, 200, await threadList(user(req)));
    if (req.method === 'POST' && route === '/api/threads') {
      send(res, 201, await createThread(user(req), await input(req)));
      return notify(null);
    }
    const match = /^\/api\/threads\/(\d+)(?:\/(entries|read|stop|fork))?$/.exec(route);
    if (match) {
      const id = Number(match[1]);
      const action = match[2];
      if (!action && req.method === 'GET') return send(res, 200, await threadView(id, user(req)));
      if (!action && req.method === 'DELETE') {
        await conversation(id);
        await commit(async (tx) => { (await tx.doc(Thread, id)).hidden = true; });
        send(res, 200, { id });
        return notify(null);
      }
      if (action === 'entries' && req.method === 'POST') return send(res, 201, await postEntry(id, user(req), await input(req)));
      if (action === 'fork' && req.method === 'POST') {
        send(res, 201, await forkThread(user(req), id, await input(req)));
        return notify(null);
      }
      if (action === 'read' && req.method === 'POST') {
        const newest = (await (await conversation(id)).entries({}, 1, undefined, context)).items[0]?.id;
        if (newest && (await thread(id)).reads[user(req)] !== newest) await commit(async (tx) => { (await tx.doc(Thread, id)).reads[user(req)] = newest; });
        return send(res, 200, { read: newest ?? null });
      }
      if (action === 'stop' && req.method === 'POST') {
        await (await conversation(id)).abort(context);
        return send(res, 200, { stopped: id });
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    send(res, error.status ?? 400, { error: error.message });
  }
};

function frame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function readFrames(socket, onText) {
  let buffer = Buffer.alloc(0);
  let parts = [];
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = buffer[0] & 0x80;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = buffer[1] & 0x80;
      const mask = masked && buffer.subarray(offset, offset + 4);
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (opcode === 8) return socket.end();
      if (opcode === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (opcode === 10) continue;
      parts.push(payload);
      if (fin) {
        onText(Buffer.concat(parts).toString());
        parts = [];
      }
    }
  });
}

// Browsers hear which thread changed, at most every 100 ms; `null` means the lists did.
const dirty = new Set();
let flushing;
function notify(threadId) {
  dirty.add(threadId);
  flushing ??= setTimeout(() => {
    flushing = undefined;
    for (const id of dirty) {
      const data = frame(JSON.stringify({ threadId: id }));
      for (const socket of clients) socket.write(data);
    }
    dirty.clear();
    for (const m of modules) m.changed?.();
  }, 100);
}

harness.subscribeCommits(({ changes }) => {
  for (const c of changes) {
    const id = c.record?.conversationId ?? (c.type === 'conversation' ? c.record?.id : undefined) ?? c.conversationId ?? c.record?.address?.conversationId;
    if (id) notify(id);
  }
});

const sockets = new Map();
async function upgrade(req, socket) {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) return socket.destroy();
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const name = url.searchParams.get('runner');
  const close = () => {
    clients.delete(socket);
    if (!name || sockets.get(name) !== socket) return;
    sockets.delete(name);
    runners.disconnect(name);
    console.log(`runner ${name} offline`);
    commit(async (tx) => { (await tx.doc(Runners))[name].lastSeen = new Date().toISOString(); }).catch(() => {});
    notify(null);
  };
  socket.on('end', () => socket.end());
  socket.on('close', close);
  socket.on('error', close);
  if (!name) {
    clients.add(socket);
    return readFrames(socket, () => {});
  }
  // A runner reconnecting under its name replaces its old socket; the old one's calls fail.
  if (sockets.has(name)) {
    sockets.get(name).destroy();
    runners.disconnect(name);
  }
  sockets.set(name, socket);
  const q = (param) => url.searchParams.get(param) || '';
  const runner = { alias: q('alias'), owner: q('owner'), host: q('host'), dir: q('dir') || '/', model: q('model'), lastSeen: new Date().toISOString() };
  await commit(async (tx) => { (await tx.doc(Runners))[name] = runner; });
  if (!models.getProvider(`runner:${name}`)) models.setProvider(runnerProvider(runners, name));
  readFrames(socket, (text) => runners.receive(text));
  runners.connect(name, (text) => socket.write(frame(text)));
  console.log(`runner ${name} online: ${runner.dir}, default model ${runner.model || 'none'}`);
  notify(null);
}

for (const host of process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1']) {
  const server = http.createServer(handleRequest);
  server.on('upgrade', (req, socket) => upgrade(req, socket).catch((error) => { console.error(error); socket.destroy(); }));
  server.on('error', (error) => {
    if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) return;
    console.error(error);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const addresses = host === '0.0.0.0' ? Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4').map((a) => a.address) : [host === '::1' ? '[::1]' : host];
    for (const address of addresses) console.log(`http://${address}:${port} on ${file}, modules: ${modules.map((m) => m.name).join(', ') || 'none'}`);
  });
}
