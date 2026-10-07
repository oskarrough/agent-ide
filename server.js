// Keeps every thread as a conversation in one Pi Durable harness. Runners lend it their models and folders.
// PORT=3000 DB_PATH=agent-ide-3000.sqlite [DIRECTOR=1] bun server.js
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
import { createRunners, remoteEnv, runnerProvider } from './remote.js';

const port = Number(process.env.PORT || 3000);
const file = process.env.DB_PATH || `agent-ide-${port}.sqlite`;
const HARNESSES = ['pi-durable', 'echo'];

// The server's own state: its threads, and every runner that has connected, so their models resolve after a restart.
const Server = defineDoc({ kind: 'agent-ide.server', version: 1, scope: 'session', initial: () => ({ threads: [], runners: {} }) });
// What agent-ide adds to a conversation: a title, maybe a parent, the agent it last asked,
// and how far each reader has read.
const Thread = defineDoc({
  kind: 'agent-ide.thread', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ title: '', parent: null, createdAt: '', createdBy: '', hidden: false, to: null, reads: {} }),
});

const clients = new Set();
const runners = createRunners({ onChange: () => notify(null) });
// `$ cmd` runs, by key, with their output so far. They become entries when they finish.
const execs = new Map();
// Who answers an entry with no `to`. Alone, the thread's last agent. The director, for multiplayer threads, decides instead.
const director = process.env.DIRECTOR ? await import('./director.js') : null;
const page = await readFile(new URL('./client.html', import.meta.url));

const models = createModels();
const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(await openNodeSqliteStorage(file), {
  models,
  registry,
  // A conversation's files and commands are on the runner whose model it uses, in the folder it was given.
  env: async ({ conversationId, cwd, read }) => {
    const runner = (await read.snapshot(AgentDoc, conversationId, context))?.model?.provider?.replace(/^runner:/, '');
    return runner ? remoteEnv(runners, runner, cwd) : undefined;
  },
  onReport: (error) => console.error('pi-durable:', error),
}, context);

const state = async () => (await harness.snapshot(Server, context)) ?? Server.definition.initial();
const thread = (id) => harness.snapshot(Thread, id, context);
const change = (fn) => harness.commit(async (tx) => fn(tx), context);
const conversation = async (id) => {
  const found = (await state()).threads.includes(id) && await harness.conversation(id, context);
  if (!found) throw Object.assign(new Error('Thread not found'), { status: 404 });
  return found;
};

for (const name of Object.keys((await state()).runners)) models.setProvider(runnerProvider(runners, name));
// Work the last process left unfinished carries on: answers, tool calls, retries.
harness.resume();

const agentName = (to) => to && `${to.harness}@${to.runner}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const user = (req) => req.headers['x-user'] || 'anon';
const userMessage = (text) => ({ role: 'user', content: text, timestamp: Date.now() });
const tail = (text) => text.slice(-20000);

function field(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

// A `to` says who should answer: a runner, a harness, and optionally a model, effort and folder.
async function address(to) {
  if (!to) return null;
  const clean = { runner: field(to.runner, 'to.runner'), harness: field(to.harness ?? 'pi-durable', 'to.harness') };
  for (const key of ['model', 'effort', 'dir']) if (typeof to[key] === 'string' && to[key].trim()) clean[key] = to[key].trim();
  const runner = (await state()).runners[clean.runner];
  if (!runner) throw new Error(`No runner ${clean.runner} has connected to this server`);
  if (!HARNESSES.includes(clean.harness)) throw new Error(`Harnesses are ${HARNESSES.join(' and ')}`);
  folder(runner, clean);
  return clean;
}

function folder(runner, to) {
  const cwd = path.resolve(runner.dir, to.dir || '.');
  if (cwd !== runner.dir && !cwd.startsWith(runner.dir + path.sep)) throw new Error(`${to.dir} is outside ${to.runner}'s folder`);
  return cwd;
}

// The conversation's agent, from a `to`: the model through the runner's provider, effort as thinking level, dir as cwd.
async function agentFor(to) {
  const runner = (await state()).runners[to.runner];
  const model = to.harness === 'echo' ? 'echo/echo' : to.model || runner.model;
  if (!model) throw new Error(`${to.runner} has no default model in pi; name one as provider/model`);
  return {
    model: { provider: `runner:${to.runner}`, modelId: model },
    thinkingLevel: to.effort ?? null,
    cwd: folder(runner, to),
    instructions: `You are ${agentName(to)} in a thread with humans and agents. Each person's message starts with their name.`,
  };
}

// An entry that asks nobody anything: written at the next boundary, so never into the middle of a run.
const write = async (threadId, entry, requestId) => (await conversation(threadId)).submit({ type: 'write', entry, requestId }, context);

// Who wrote each entry. A human input is a pi.user entry carrying `{ author, to, requestId }` as data (our patch to
// Pi Durable). The model's answers and tool results belong to the agent of the input before them. Which inputs an answer
// replies to comes from Pi's submission records: a run that took a steer or several follow-ups answers them all at once.
async function annotate(id, entries) {
  const inputs = entries.filter((entry) => entry.kind === 'pi.user' && entry.data?.requestId);
  const replies = new Map();
  await change(async (tx) => {
    for (const input of inputs) {
      const answer = (await tx.submissionByRequest(id, input.data.requestId))?.answer;
      if (answer !== undefined) replies.set(answer, [...(replies.get(answer) ?? []), input.id]);
    }
  });
  let asked = null;
  return entries.map((entry) => {
    if (entry.kind === 'pi.user' && entry.data) asked = entry.data;
    const author = entry.data?.author
      ?? (['pi.assistant', 'pi.tool-result'].includes(entry.kind) ? agentName(asked?.to) : entry.kind.startsWith('pi.') ? 'pi' : 'server');
    return { author, to: entry.data?.to ?? null, replyTo: replies.get(entry.id) ?? [], entry };
  });
}

// The whole history, oldest first: the view's entries are only the active context, which a compaction shortens.
async function history(handle) {
  const entries = [];
  let cursor;
  do {
    const page = await handle.entries({}, 500, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return entries.reverse();
}

const isResult = (entry) => (entry.kind === 'pi.assistant' && !['toolUse', 'aborted', 'error'].includes(entry.model?.[0]?.stopReason))
  || entry.kind === 'agent-ide.error' || entry.kind === 'agent-ide.shell';

// Where a thread stands for one reader. working and queued come from Pi's own pi.live and pi.inbox;
// queued means the runner it waits for is offline. done is a result the reader hasn't seen yet.
async function status(id, row, reader) {
  const live = await harness.snapshot(LiveDoc, id, context);
  const inbox = await harness.snapshot(InboxDoc, id, context);
  const waiting = live?.run || inbox?.items?.some((item) => item.mode !== 'write');
  if (waiting) return row.to && !runners.isOnline(row.to.runner) ? 'queued' : 'working';
  if ([...execs.values()].some((e) => e.threadId === id)) return 'working';
  const recent = (await (await harness.conversation(id, context)).entries({}, 50, undefined, context)).items;
  for (const entry of recent) {
    if (entry.id === row.reads[reader]) return 'idle';
    if (isResult(entry)) return entry.kind === 'agent-ide.error' ? 'failed' : 'done';
  }
  return 'idle';
}

async function threadList(reader) {
  const rows = [];
  for (const id of (await state()).threads) {
    const row = await thread(id);
    if (!row || row.hidden) continue;
    const { reads, ...rest } = row;
    rows.push({ id, ...rest, agent: agentName(row.to), status: await status(id, row, reader) });
  }
  return rows.reverse();
}

// A thread as the client sees it: our row, Pi's built-in docs (live answer, inbox, agent, usage), every entry with its author.
async function threadView(id, reader) {
  const handle = await conversation(id);
  const row = await thread(id);
  const view = await handle.viewState(context);
  const { conversation: record, docs } = view.value;
  view.dispose();
  const entries = await annotate(id, await history(handle));
  const shells = [...execs.values()].filter((e) => e.threadId === id);
  return { id, ...row, agent: agentName(row.to), status: await status(id, row, reader), conversation: record, docs, shells, entries };
}

// Waits for an input's answer, even across a restart, then reports it: to the parent thread, and as an error if there is none.
// The reports' request ids make it safe to follow an input twice.
async function follow(id, requestId, to) {
  const record = await change((tx) => tx.submissionByRequest(id, requestId));
  if (!record) return;
  const settled = await (await harness.submission(record.id, context)).wait(context);
  const row = await thread(id);
  if (settled.status === 'done' && !row.parent) return;
  const agent = agentName(to);
  let text;
  if (settled.status === 'done') {
    const answer = await change((tx) => tx.entry(settled.answer));
    const body = (answer?.model?.[0]?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('');
    text = `${agent}: ${body.split('\n').find(Boolean)?.slice(0, 160) || '(empty answer)'}`;
  } else {
    text = `${agent} gave no answer: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ''}`;
    await write(id, { kind: 'agent-ide.error', data: { text, post: requestId } }, `error:${requestId}`);
  }
  if (row.parent) await write(row.parent, { kind: 'agent-ide.note', data: { author: agent, text: `${text} → thread:${id}`, thread: id }, model: [userMessage(`${text} (from thread ${id})`)] }, `report:${requestId}`);
}

// After a restart, every human input is followed again: those placed, from their entries, and those still queued, from the inbox.
for (const id of (await state()).threads) {
  const inbox = (await harness.snapshot(InboxDoc, id, context))?.items ?? [];
  const placed = (await history(await harness.conversation(id, context))).filter((entry) => entry.kind === 'pi.user');
  for (const { data } of [...placed, ...inbox]) if (data?.requestId) follow(id, data.requestId, data.to).catch((error) => console.error(error));
}

// `$ cmd` runs through the runner's environment, like the agent's own bash, and lands as an entry with its output.
async function shell(id, author, command, to) {
  const runner = (await state()).runners[to.runner];
  const key = randomUUID();
  const run = { threadId: id, author, to, command, stdout: '', stderr: '' };
  execs.set(key, run);
  notify(id);
  const result = await remoteEnv(runners, to.runner, folder(runner, to)).exec(command, {
    onOutput: (text, _context, info) => { run[info.stream] += text; notify(id); },
  }, context);
  const output = { code: result.ok ? result.value.exitCode : null, stdout: tail(run.stdout), stderr: tail(run.stderr), ...(result.ok ? {} : { error: result.error.message }) };
  const shown = [`exit ${output.code ?? output.error}`, output.stdout, output.stderr].filter(Boolean).join('\n');
  await write(id, { kind: 'agent-ide.shell', data: { author, to, command, ...output }, model: [userMessage(`${author} ran \`${command}\` on ${to.runner}:\n${shown}`)] }, `shell:${key}`);
  execs.delete(key);
  notify(id);
}

// Posting an entry is the one thing you do. Who answers: the entry's `to`; with none, the thread's last agent, or the director.
// `to: null` means nobody. `$ cmd` runs on the runner instead of asking its agent. `steer: true` joins the running answer.
async function post(id, author, input) {
  const handle = await conversation(id);
  const row = await thread(id);
  const body = field(input.body, 'body');
  const command = body.match(/^\$\s+([\s\S]+)/)?.[1];
  const given = 'to' in input ? await address(input.to) : director && !command ? null : row.to;
  const asked = director && !command ? (await history(handle)).filter((e) => e.kind === 'pi.user' && e.data).map((e) => e.data) : [];
  const to = director && !command ? await address(director.route({ body, to: given }, asked)) : given;
  if (command) {
    if (!to) throw new Error('Pick a runner to run the command on');
    shell(id, author, command, to).catch((error) => console.error(error));
    return { command, to };
  }
  if (!to) return write(id, { kind: 'agent-ide.chat', data: { author, body }, model: [userMessage(`${author}: ${body}`)] });
  // One conversation runs one agent at a time. The same agent queues a follow-up; another has to wait its turn.
  const live = await harness.snapshot(LiveDoc, id, context);
  const inbox = await harness.snapshot(InboxDoc, id, context);
  const busy = live?.run || inbox?.items?.length;
  if (busy && !same(row.to, to)) throw Object.assign(new Error(`${agentName(row.to)} is working in this thread; wait, stop it, or ask it instead`), { status: 409 });
  if (!busy) await handle.configure(await agentFor(to), context);
  const requestId = randomUUID();
  await change(async (tx) => { (await tx.doc(Thread, id)).to = to; });
  const whenBusy = input.steer ? 'steer' : 'followUp';
  const submission = await handle.submit({ type: 'input', content: `${author}: ${body}`, data: { author, to, requestId }, requestId, whenBusy }, context);
  follow(id, requestId, to).catch((error) => console.error(error));
  return { requestId, submission: submission.id, to };
}

async function createThread(author, { title, parent = null }) {
  if (parent !== null) parent = Number(parent);
  if (parent !== null) await conversation(parent);
  const created = await harness.createConversation({
    ownership: { kind: 'ownerless' },
    init: async (tx, id) => {
      Object.assign(await tx.doc(Thread, id), { title: field(title, 'title'), parent, createdAt: new Date().toISOString(), createdBy: author });
      (await tx.doc(Server)).threads.push(id);
    },
  }, context);
  if (parent) await write(parent, { kind: 'agent-ide.note', data: { author, text: `${author} handed off → thread:${created.id}`, thread: created.id } }, `handoff:${created.id}`);
  return { id: created.id };
}

async function runnerList() {
  return Object.entries((await state()).runners).map(([name, runner]) => ({ name, ...runner, online: runners.isOnline(name), calls: runners.working(name) }));
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
      const { threads, runners: known } = await state();
      return send(res, 200, { port, file, director: Boolean(director), harnesses: HARNESSES, threads: threads.length, runners: Object.keys(known).length, work: await harness.inspect(context) });
    }
    if (req.method === 'GET' && route === '/api/runners') return send(res, 200, await runnerList());
    if (req.method === 'GET' && route === '/api/threads') return send(res, 200, await threadList(user(req)));
    if (req.method === 'POST' && route === '/api/threads') {
      send(res, 201, await createThread(user(req), await input(req)));
      return notify(null);
    }
    const match = /^\/api\/threads\/(\d+)(?:\/(entries|read|stop))?$/.exec(route);
    if (match) {
      // A thread's id is its conversation's id, a number.
      const id = Number(match[1]);
      const action = match[2];
      if (!action && req.method === 'GET') return send(res, 200, await threadView(id, user(req)));
      // Pi Durable keeps everything, so deleting only hides the thread.
      if (!action && req.method === 'DELETE') {
        await conversation(id);
        await change(async (tx) => { (await tx.doc(Thread, id)).hidden = true; });
        send(res, 200, { id });
        return notify(null);
      }
      if (action === 'entries' && req.method === 'POST') return send(res, 201, await post(id, user(req), await input(req)));
      // Reading a thread marks its newest entry, so its last result stops counting as done for you.
      if (action === 'read' && req.method === 'POST') {
        const newest = (await (await conversation(id)).entries({}, 1, undefined, context)).items[0]?.id;
        if (newest && (await thread(id)).reads[user(req)] !== newest) await change(async (tx) => { (await tx.doc(Thread, id)).reads[user(req)] = newest; });
        return send(res, 200, { read: newest ?? null });
      }
      // Anyone can stop the agent working in a thread: queued inputs are withdrawn and the run is aborted.
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

// Text frames from a client, which masks them. Pings get a pong; a close frame closes.
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

function broadcast(value) {
  const data = frame(JSON.stringify(value));
  for (const socket of clients) socket.write(data);
}

// Browsers hear which thread changed, at most every 100 ms per thread; `null` means the lists did.
const dirty = new Set();
let flushing;
function notify(threadId) {
  dirty.add(threadId);
  flushing ??= setTimeout(() => {
    flushing = undefined;
    for (const id of dirty) broadcast({ threadId: id });
    dirty.clear();
  }, 100);
}

// Every commit names the conversations it touched; those threads changed.
harness.subscribeCommits(({ changes }) => {
  for (const c of changes) {
    const id = c.record?.conversationId ?? (c.type === 'conversation' ? c.record?.id : undefined) ?? c.conversationId ?? c.record?.address?.conversationId;
    if (id) notify(id);
  }
});

// Browsers connect to /ws. A runner connects to /ws?runner=NAME&alias=…&harnesses=…&dir=…&model=… and is online while connected.
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
    change(async (tx) => { (await tx.doc(Server)).runners[name].lastSeen = new Date().toISOString(); }).catch(() => {});
    notify(null);
  };
  socket.on('end', () => socket.end());
  socket.on('close', close);
  socket.on('error', close);
  if (!name) {
    clients.add(socket);
    return readFrames(socket, () => {});
  }
  // A runner that reconnects under its name replaces its old socket; what the old one had is lost.
  if (sockets.has(name)) {
    sockets.get(name).destroy();
    runners.disconnect(name);
  }
  sockets.set(name, socket);
  const runner = {
    alias: url.searchParams.get('alias') || '', owner: url.searchParams.get('owner') || 'anon', host: url.searchParams.get('host') || '',
    harnesses: (url.searchParams.get('harnesses') || '').split(',').filter(Boolean), dir: url.searchParams.get('dir') || '/',
    model: url.searchParams.get('model') || '', lastSeen: new Date().toISOString(),
  };
  await change(async (tx) => { (await tx.doc(Server)).runners[name] = runner; });
  if (!models.getProvider(`runner:${name}`)) models.setProvider(runnerProvider(runners, name));
  readFrames(socket, (text) => runners.receive(text));
  runners.connect(name, (text) => socket.write(frame(text)));
  console.log(`runner ${name} online: ${runner.dir}, default model ${runner.model || 'none'}`);
  notify(null);
}

function urls(host) {
  if (host !== '0.0.0.0') return [host === '::1' ? '[::1]' : host];
  return Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4').map((a) => a.address);
}

for (const host of process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1']) {
  const server = http.createServer(handleRequest);
  server.on('upgrade', (req, socket) => upgrade(req, socket).catch((error) => { console.error(error); socket.destroy(); }));
  server.on('error', (error) => {
    if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) return;
    console.error(error);
    process.exit(1);
  });
  server.listen(port, host, () => { for (const address of urls(host)) console.log(`http://${address}:${port} on ${file}${director ? ' (director on)' : ''}`); });
}
