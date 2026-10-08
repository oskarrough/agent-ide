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

/**
 * @typedef {{ runner: string, model: string, effort?: string, dir?: string }} To  An agent: a model on a runner, named `model@runner`.
 * @typedef {object} Message  The data of every thread entry: something said there.
 * @property {string} author  A human's name, or an agent's `model@runner`.
 * @property {string} body
 * @property {To[]} [to]  The agents it asks.
 * @property {number} [from]  The thread it came from.
 * @property {number[]} [re]  What it answers: messages here, or with `from`, posts in that thread.
 * @property {{ conversation: number, entry: number }} [answer]  On an agent's answer, the entry in its conversation it copies.
 * @property {true} [error]  On an agent's message when it gave no answer.
 * @property {{ runner: string, code: number | null, stdout: string, stderr: string, error?: string }} [shell]  What `$ cmd` printed.
 * @typedef {{ id: number, kind: 'agent-ide.message', data: Message }} Entry  A thread entry, as Pi keeps it and the API sends it.
 * @typedef {{ name: string, conversation: number, to: To | null, status: string }} Agent  An agent in a thread, in the API.
 */

const port = Number(process.env.PORT || 3000);
const file = process.env.DB_PATH || `agent-ide-${port}.sqlite`;
// Every runner that ever connected, so its models resolve after a restart.
const Runners = defineDoc({ kind: 'agent-ide.runners', version: 1, scope: 'session', initial: () => ({}) });
// `agents` maps each agent's name to its Pi conversation. `started` maps an agent's tool call to the thread it started,
// so a replayed call finds it.
const Thread = defineDoc({
  kind: 'agent-ide.thread', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ title: '', parent: null, createdAt: '', createdBy: '', hidden: false, reads: {}, started: {}, agents: {} }),
});
// On an agent's conversation: the thread it answers in, and its name there.
const AgentHome = defineDoc({ kind: 'agent-ide.agent', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ thread: 0, name: '' }) });
const ownerless = { ownership: { kind: 'ownerless' } };

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

// An agent's conversation has no Thread doc, so it never counts as a thread.
const threadIds = async () => {
  const all = (await collect((cursor) => commit((tx) => tx.scanConversations({}, 500, cursor)))).map((c) => c.id).sort((a, b) => b - a);
  return (await Promise.all(all.map(async (id) => (await thread(id)) && id))).filter(Boolean);
};

const agentName = (to) => to && `${to.model.split('/').pop()}@${to.runner}`;
const user = (req) => req.headers['x-user'] || 'anon';

function field(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function address(to) {
  const name = field(to?.runner, 'to.runner');
  const runner = (await known())[name];
  if (!runner) throw new Error(`No runner ${name} has connected to this server`);
  const model = to.model?.trim() || runner.model;
  if (!model) throw new Error(`${name} has no default model in pi; name one as provider/model`);
  const clean = { runner: name, model };
  for (const key of ['effort', 'dir']) if (typeof to[key] === 'string' && to[key].trim()) clean[key] = to[key].trim();
  folder(runner, clean);
  return clean;
}
const addresses = (to) => Promise.all((to === null ? [] : [to].flat()).map(address));

function folder(runner, to) {
  const cwd = path.resolve(runner.dir, to.dir || '.');
  if (cwd !== runner.dir && !cwd.startsWith(runner.dir + path.sep)) throw new Error(`${to.dir} is outside ${to.runner}'s folder`);
  return cwd;
}

// What an agent's conversation runs with is Pi's own agent setting.
async function agentOf(id) {
  const agent = await harness.snapshot(AgentDoc, id, context);
  const name = agent?.model?.provider?.match(/^runner:(.+)$/)?.[1];
  if (!name) return null;
  const runner = (await known())[name];
  const dir = runner && agent.cwd ? path.relative(runner.dir, agent.cwd) : '';
  return { runner: name, model: agent.model.modelId, ...(agent.thinkingLevel ? { effort: agent.thinkingLevel } : {}), ...(dir ? { dir } : {}) };
}

/** @returns {Promise<Agent[]>} */
async function agentsIn(row) {
  return Promise.all(Object.entries(row.agents).map(async ([name, conversation]) => {
    const to = await agentOf(conversation);
    const live = await harness.snapshot(LiveDoc, conversation, context);
    const inbox = await harness.snapshot(InboxDoc, conversation, context);
    const busy = live?.run || inbox?.items?.some((item) => item.mode !== 'write');
    return { name, conversation, to, status: !busy ? 'idle' : to && runners.isOnline(to.runner) ? 'working' : 'blocked' };
  }));
}

// The one place a thread changes: a passive write, keyed so a repeat finds the first. A thread never runs.
async function say(threadId, data, requestId) {
  const submission = await (await conversation(threadId)).submit({ type: 'write', entry: { kind: 'agent-ide.message', data }, requestId }, context);
  return (await submission.wait(context)).entry;
}

/** @returns {Promise<Entry[]>} */
async function messages(id) {
  const handle = await conversation(id);
  return (await collect((cursor) => handle.entries({ order: 'ascending' }, 500, cursor, context))).filter((e) => e.kind === 'agent-ide.message');
}

// An agent's inputs, each naming in its request id the newest thread entry it holds, `upto`, and those that asked the
// agent, `re`. A fork inherits its source's inputs up to the fork's entry, unless `own`.
async function inputs(id, own) {
  const records = await collect((cursor) => storage.scanSubmissions({ conversationId: id }, 500, cursor, context));
  const mine = records.filter((r) => r.type === 'input' && r.requestId).map((record) => {
    const params = new URLSearchParams(record.requestId);
    return { requestId: record.requestId, upto: Number(params.get('upto')), re: params.get('re') ? params.get('re').split(',').map(Number) : [], record };
  });
  const { parent } = own ? {} : await commit((tx) => tx.conversation(id));
  return parent ? [...(await inputs(parent.conversationId)).filter((i) => i.record.entry <= parent.at), ...mine] : mine;
}

function said({ data: m }) {
  const who = m.from ? `${m.author}, ${m.re ? 'answering' : 'writing'} from thread ${m.from}` : m.author;
  const output = m.shell ? `\n${[`exit ${m.shell.code ?? m.shell.error}`, m.shell.stdout, m.shell.stderr].filter(Boolean).join('\n')}` : '';
  return `${who}: ${m.body}${output}`;
}

// Sends the agent's conversation, made the first time it's asked here, every message it hasn't seen, but its own.
async function ask(threadId, to, steer) {
  const name = agentName(to);
  const id = await commit(async (tx) => {
    const row = await tx.doc(Thread, threadId);
    if (row.agents[name]) return row.agents[name];
    const created = await tx.createConversation(ownerless);
    Object.assign(await tx.doc(AgentHome, created.id), { thread: threadId, name });
    return row.agents[name] = created.id;
  });
  const handle = await harness.conversation(id, context);
  await handle.configure({
    model: { provider: `runner:${to.runner}`, modelId: to.model },
    thinkingLevel: to.effort ?? null,
    cwd: folder((await known())[to.runner], to),
    instructions: `You are ${name} in thread ${threadId}, with humans and other agents. Messages come to you as "name: text". Only your final answer goes back to the thread.`,
  }, context);
  const seen = Math.max(0, ...(await inputs(id)).filter((i) => i.record.status !== 'unanswered' || i.record.entry !== undefined).map((i) => i.upto));
  const news = (await messages(threadId)).filter((e) => e.id > seen && (e.data.author !== name || e.data.from));
  if (!news.length) return;
  const re = news.filter((e) => e.data.to?.some((t) => agentName(t) === name)).map((e) => e.id);
  const requestId = new URLSearchParams({ upto: news.at(-1).id, re }).toString();
  await handle.submit({ type: 'input', content: news.map(said).join('\n\n'), requestId, whenBusy: steer ? 'steer' : 'followUp' }, context);
  follow(threadId, id, requestId).catch((error) => console.error(error));
}

// Asks for one thread run one at a time, so no two inputs hold the same message.
const queues = new Map();
const serial = (id, fn) => queues.set(id, (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)).get(id);

// With no reader, as for a runner nobody owns, anyone's read counts.
async function status(id, reads, agents, reader) {
  if (agents.some((a) => a.status === 'working') || [...shells.values()].some((run) => run.threadId === id)) return 'working';
  if (agents.some((a) => a.status === 'blocked')) return 'blocked';
  const seen = new Set(reader ? [reads[reader]] : Object.values(reads));
  for (const entry of (await (await harness.conversation(id, context)).entries({}, 50, undefined, context)).items) {
    if (seen.has(entry.id)) return 'idle';
    if (entry.data?.answer || entry.data?.error || entry.data?.shell) return entry.data.error ? 'error' : 'done';
  }
  return 'idle';
}

async function threadRow(id, reader) {
  const { reads, started, ...row } = await thread(id);
  const agents = await agentsIn(row);
  return { id, ...row, agents, status: await status(id, reads, agents, reader) };
}
const threadList = async (reader) => (await Promise.all((await threadIds()).map((id) => threadRow(id, reader)))).filter((row) => !row.hidden);
const threadView = async (id, reader) => ({
  ...await threadRow(id, reader), conversation: await commit((tx) => tx.conversation(id)),
  shells: [...shells.values()].filter((run) => run.threadId === id), entries: await messages(id),
});

const home = (conversationId) => harness.snapshot(AgentHome, conversationId, context);

// Copies an agent's final answer into the thread. One answer can settle several inputs; the first of them speaks for all.
async function follow(threadId, conversationId, requestId) {
  const record = await commit((tx) => tx.submissionByRequest(conversationId, requestId));
  const settled = await (await harness.submission(record.id, context)).wait(context);
  const done = settled.status === 'done';
  const together = (await inputs(conversationId, true)).filter((i) => done ? i.record.answer === settled.answer : i.record.id === settled.id);
  if (together[0].record.id !== settled.id) return;
  const name = agentName(await agentOf(conversationId));
  const re = [...new Set(together.flatMap((i) => i.re))];
  const body = done ? messageText((await commit((tx) => tx.entry(settled.answer)))?.model?.[0]) || '(empty answer)'
    : `gave no answer: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ''}`;
  const key = `${conversationId}:${settled.id}`;
  if (done || settled.reason !== 'aborted') {
    const outcome = done ? { answer: { conversation: conversationId, entry: settled.answer } } : { error: true };
    await say(threadId, { author: name, body, ...(re.length ? { re } : {}), ...outcome }, `answer:${key}`);
  }
  const posts = (await messages(threadId)).filter((e) => re.includes(e.id) && e.data.from && !e.data.re);
  if (posts.length && reply) return reply(posts, threadId, name, body, key);
  const { parent } = await thread(threadId);
  if (parent) await say(parent, { author: name, body: body.split('\n').find(Boolean)?.slice(0, 160) ?? '', from: threadId }, `report:${key}`);
}

async function shell(id, author, command, to, key) {
  const runner = (await known())[to.runner];
  const run = { threadId: id, author, to, command, stdout: '', stderr: '' };
  shells.set(key, run);
  notify(id);
  const result = await remoteEnv(runners, to.runner, folder(runner, to)).exec(command, {
    onOutput: (text, _context, info) => { run[info.stream] += text; notify(id); },
  }, context);
  const output = { runner: to.runner, code: result.ok ? result.value.exitCode : null, stdout: run.stdout.slice(-20000), stderr: run.stderr.slice(-20000), ...(result.ok ? {} : { error: result.error.message }) };
  await say(id, { author, body: `$ ${command}`, shell: output }, `shell:${key}`);
  shells.delete(key);
  notify(id);
}

// No `to` asks whom the thread last asked; with the director, whom the body @mentions.
async function postEntry(id, author, input, { key = randomUUID(), from = null, re = null } = {}) {
  await conversation(id);
  const body = field(input.body, 'body');
  const command = body.match(/^\$\s+([\s\S]+)/)?.[1];
  const routed = route && !command;
  let to = 'to' in input ? await addresses(input.to) : routed ? [] : (await messages(id)).findLast((e) => e.data.to)?.data.to ?? [];
  if (routed) to = await addresses(route({ body, to }, (await agentsIn(await thread(id))).map((a) => a.to).filter(Boolean)));
  if (command) {
    if (!to.length) throw new Error('Pick a runner to run the command on');
    shell(id, author, command, to[0], key).catch((error) => console.error(error));
    return { command, to: to[0] };
  }
  const message = { author, body, ...(to.length ? { to } : {}), ...(from ? { from } : {}), ...(re ? { re } : {}) };
  return serial(id, async () => {
    const entry = await say(id, message, `post:${key}`);
    for (const agent of to) await ask(id, agent, input.steer);
    return { entry, to };
  });
}

async function createThread(author, { title, parent = null }, key) {
  if (parent !== null) await conversation(parent = Number(parent));
  title = field(title, 'title');
  const id = await commit(async (tx) => {
    const started = parent && key ? ((await tx.doc(Thread, parent)).started ??= {}) : {};
    if (started[key]) return started[key];
    const created = await tx.createConversation(ownerless);
    Object.assign(await tx.doc(Thread, created.id), { title, parent, createdAt: new Date().toISOString(), createdBy: author });
    if (key) started[key] = created.id;
    return created.id;
  });
  if (parent) await say(parent, { author, body: `handed off → thread:${id}` }, `handoff:${id}`);
  return { id };
}

// One commit forks the thread at an entry and each agent's conversation at its last answer up to there; an agent
// catches up on the rest when next asked.
async function forkThread(author, id, { at, title }) {
  const answers = {};
  for (const { data } of (await messages(id)).filter((e) => e.id <= Number(at) && e.data.answer)) answers[data.author] = data.answer;
  const named = title?.trim() || `${(await thread(id)).title} (fork)`;
  const fork = await (await conversation(id)).fork(Number(at), {
    ...ownerless,
    init: async (tx, forkId) => {
      const agents = {};
      for (const [name, { conversation: c, entry }] of Object.entries(answers)) {
        agents[name] = (await tx.forkConversation(c, entry, ownerless)).id;
        Object.assign(await tx.doc(AgentHome, agents[name]), { thread: forkId, name });
      }
      Object.assign(await tx.doc(Thread, forkId), { title: named, createdAt: new Date().toISOString(), createdBy: author, agents });
    },
  }, context);
  return { id: fork.id };
}

const core = { models, runners, known, address, agentName, agentOf, thread, home, threadList, messages, createThread, postEntry };
const modules = await load('server', { director: false, talk: true, status: true }, core);
for (const m of modules) if (m.extension) registry.install(m.extension);
const route = modules.find((m) => m.route)?.route;
const reply = modules.find((m) => m.reply)?.reply;

for (const name of Object.keys(await known())) models.setProvider(runnerProvider(runners, name));
harness.resume();
for (const id of await threadIds()) {
  for (const conversation of Object.values((await thread(id)).agents)) {
    for (const { requestId } of await inputs(conversation, true)) follow(id, conversation, requestId).catch((error) => console.error(error));
  }
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
    const raw = /^\/api\/conversations\/(\d+)$/.exec(route);
    if (raw && req.method === 'GET') {
      const view = await (await harness.conversation(Number(raw[1]), context))?.viewState(context);
      if (!view) return send(res, 404, { error: 'Conversation not found' });
      send(res, 200, view.value);
      return view.dispose();
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
        await conversation(id);
        for (const c of Object.values((await thread(id)).agents)) await (await harness.conversation(c, context)).abort(context);
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
    if (id) home(id).then((agent) => notify(agent?.thread ?? id), () => {});
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
