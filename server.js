import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AgentDoc, configure, createRegistry, defineDoc, defineExtension, defineTask, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { load } from './modules.js';
import { createRunners, messageText, remoteEnv, runnerProvider } from './remote.js';

/**
 * @typedef {{ runner: string, model: string, effort?: string, dir?: string }} To  An agent: a model on a runner, as pi
 *   there resolved it, `provider/id`. Named `provider/id@runner`.
 * @typedef {object} Message  The data of every thread entry: something said there.
 * @property {string} author  A human's name, or an agent's.
 * @property {string} body
 * @property {To[]} [to]  The agents it asks.
 * @property {number} [from]  The thread it came from.
 * @property {number[]} [re]  What it answers: messages here, or with `from`, posts in that thread.
 * @property {{ conversation: number, entry: number }} [answer]  On an agent's answer, the entry in its conversation it copies.
 * @property {true} [error]  On an agent's message when it gave no answer.
 * @property {{ runner: string, code: number | null, stdout: string, stderr: string, error?: string }} [shell]  What `$ cmd` printed.
 * @typedef {{ id: number, kind: 'agent-ide.message', data: Message }} Entry  A thread entry, as Pi keeps it and the API sends it.
 * @typedef {{ name: string, conversation: number, to: To | null, status: string }} Agent  An agent in a thread, in the API.
 * @typedef {{ agent: number, held: number[], steer: boolean }} Delivery  A Deliver task's input: the agent's
 *   conversation, and the thread messages its one input holds.
 * @typedef {{ author: string, command: string, to: To }} Command  A Shell task's input.
 */

const port = Number(process.env.PORT || 3000);
const file = process.env.DB_PATH || `agent-ide-${port}.sqlite`;
const KIND = 'agent-ide.message';
// Every runner that ever connected, and each model pi resolved on it, so they're known after a restart and offline.
const Runners = defineDoc({ kind: 'agent-ide.runners', version: 1, scope: 'session', initial: () => ({}) });
// `agents` maps each agent's name to its Pi conversation. `sent` maps an agent's `post` call to the thread it posted
// to, so a replayed call finds it.
const Thread = defineDoc({
  kind: 'agent-ide.thread', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ title: '', parent: null, createdAt: '', createdBy: '', hidden: false, reads: {}, sent: {}, agents: {} }),
});
// On an agent's conversation: the thread it answers in, its name there, and the thread messages it hasn't seen.
const AgentHome = defineDoc({ kind: 'agent-ide.agent', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ thread: 0, name: '', unseen: [] }) });
const ownerless = { ownership: { kind: 'ownerless' } };
const own = { ownership: { kind: 'conversation' } };
const finished = (status = 'completed') => ({ status: 'terminal', outcome: { status, result: null } });

// Owns an agent's conversation for its thread, so stopping the thread reaches the agent's work. Done at once.
const Anchor = defineTask({
  name: 'agent-ide.anchor', version: 1, initial: () => ({ phase: 'own' }),
  phases: { own: (task, rt, ctx) => rt.commit(() => finished(), ctx) },
  abort: (task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
});

// Asks an agent once: it waits for the runner, submits one input under a request id made from its own id, so a rerun
// finds it, and posts what came of it in the commit that ends it.
const Deliver = defineTask({
  name: 'agent-ide.deliver', version: 1, initial: () => ({ phase: 'ask' }),
  phases: {
    async ask({ id, conversationId: threadId, input: { agent, held, steer } }, rt, ctx) {
      const to = await agentOf(agent);
      await runners.online(to.runner, rt.signal);
      const content = (await messages(threadId)).filter((e) => held.includes(e.id)).map(said).join('\n\n');
      const handle = await rt.conversation(agent, ctx);
      const submission = await handle.submit({ type: 'input', content, requestId: requestOf(id, held), whenBusy: steer ? 'steer' : 'followUp' }, ctx);
      const settled = await submission.wait(ctx);
      const told = await outcome(threadId, agent, settled);
      await rt.commit(async (tx) => {
        for (const { thread, data, steer } of told) await post(tx, thread, data, { steer });
        if (settled.entry === undefined) await restore(tx, agent, held);
        return finished();
      }, ctx);
    },
  },
  // Withdraws its input if still queued. An input never placed gave the agent nothing.
  async abort({ id, input: { agent, held } }, rt, ctx) {
    let record = await storage.submissionByRequest(agent, requestOf(id, held), ctx);
    if (record?.status === 'queued') {
      await harness.abortSubmission(record.id, ctx, agent);
      record = await storage.submission(record.id, ctx);
    }
    await rt.commit(async (tx) => {
      if (record?.entry === undefined) await restore(tx, agent, held);
      return finished('aborted');
    }, ctx);
  },
});

// `$ cmd` in the runner's folder, as an effect sandwich: it commits that it began, runs, then posts what it printed.
// Reopened after it began, it posts that a restart interrupted it.
const Shell = defineTask({
  name: 'agent-ide.shell', version: 1, initial: () => ({ phase: 'run' }),
  phases: {
    async run({ id, conversationId: threadId, input }, rt, ctx) {
      await rt.commit(() => ({ status: 'running', checkpoint: { phase: 'interrupted' } }), ctx);
      const run = { threadId, author: input.author, to: input.to, command: input.command, stdout: '', stderr: '' };
      shells.set(id, run);
      notify(threadId);
      const env = remoteEnv(runners, input.to.runner, folder((await known())[input.to.runner], input.to));
      const result = await env.exec(input.command, { onOutput: (text, _context, info) => { run[info.stream] += text; notify(threadId); } }, ctx);
      const output = result.ok ? { code: result.value.exitCode } : { error: result.error.message };
      await rt.commit(async (tx) => (await printed(tx, threadId, input, { ...run, ...output }), finished()), ctx);
      shells.delete(id);
    },
    interrupted: ({ conversationId, input }, rt, ctx) =>
      rt.commit(async (tx) => (await printed(tx, conversationId, input, { error: 'interrupted by a restart' }), finished()), ctx),
  },
  async abort({ id, conversationId, input }, rt, ctx) {
    await rt.commit(async (tx) => (await printed(tx, conversationId, input, { ...shells.get(id), error: 'stopped' }), finished('aborted')), ctx);
    shells.delete(id);
  },
});

/** @param {Command} command */
function printed(tx, threadId, { author, command, to }, { code = null, stdout = '', stderr = '', error }) {
  const shell = { runner: to.runner, code, stdout: stdout.slice(-20000), stderr: stderr.slice(-20000), ...(error ? { error } : {}) };
  return post(tx, threadId, { author, body: `$ ${command}`, shell });
}

const clients = new Set();
const runners = createRunners({ onChange: () => notify(null) });
// What each running `$ cmd` has printed so far, by its task.
const shells = new Map();
const page = await readFile(new URL('./client.html', import.meta.url));

const models = createModels();
const registry = createRegistry();
registry.install(CodingTools);
registry.install(defineExtension({ name: 'agent-ide', tasks: [Anchor, Deliver, Shell] }));
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

const agentName = (to) => to && `${to.model}@${to.runner}`;
const user = (req) => req.headers['x-user'] || 'anon';

function field(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

// A model is whatever pi on the runner makes of it, as `pi --model` would. An offline runner can't resolve, so it
// takes only a model it resolved before.
async function address(to) {
  const name = field(to?.runner, 'to.runner');
  const runner = (await known())[name];
  if (!runner) throw new Error(`No runner ${name} has connected to this server`);
  const asked = typeof to.model === 'string' ? to.model.trim() : '';
  let model = runner.models?.[asked];
  let effort;
  if (!model) {
    if (!runners.isOnline(name)) throw new Error(`${name} is offline; name a model it has run, as provider/id`);
    ({ model, thinkingLevel: effort } = await runners.call(name, { op: 'resolve', model: asked }, {}));
    const ref = `${model.provider}/${model.id}`;
    if (!runner.models?.[ref]) {
      await commit(async (tx) => { (await tx.doc(Runners))[name].models[ref] = model; });
      models.setProvider(runnerProvider(runners, name, (await known())[name].models));
    }
  }
  const clean = { runner: name, model: `${model.provider}/${model.id}` };
  if (effort) clean.effort = effort;
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

// An agent is working while a delivery to it is live: queued, running, or copying its answer back.
/** @returns {Promise<Agent[]>} */
async function agentsIn(row, live) {
  return Promise.all(Object.entries(row.agents).map(async ([name, conversation]) => {
    const to = await agentOf(conversation);
    const busy = live.some((t) => t.kind === Deliver.definition.name && t.input.agent === conversation);
    return { name, conversation, to, status: !busy ? 'idle' : to && runners.isOnline(to.runner) ? 'working' : 'blocked' };
  }));
}
const liveTasks = async () => (await harness.inspect(context)).tasks.map((t) => t.record);

/** @returns {Promise<Entry[]>} */
async function messages(id) {
  const handle = await conversation(id);
  return (await collect((cursor) => handle.entries({ order: 'ascending' }, 500, cursor, context))).filter((e) => e.kind === KIND);
}
const lastAsked = async (id) => (await messages(id)).findLast((e) => e.data.to)?.data.to ?? [];

// An input's request id names its delivery and the thread messages it holds.
const requestOf = (task, held) => new URLSearchParams({ task, held }).toString();
const heldOf = (requestId) => new URLSearchParams(requestId).get('held')?.split(',').filter(Boolean).map(Number) ?? [];

function said({ data: m }) {
  const who = m.from ? `${m.author}, ${m.re ? 'answering' : 'writing'} from thread ${m.from}` : m.author;
  const output = m.shell ? `\n${[`exit ${m.shell.code ?? m.shell.error}`, m.shell.stdout, m.shell.stderr].filter(Boolean).join('\n')}` : '';
  return `${who}: ${m.body}${output}`;
}

/**
 * Writes a message into a thread, inside the caller's commit: it's unseen by every agent there but its own, and each
 * agent in its `to` gets a Deliver task holding all it hasn't seen. An agent's conversation is made the first time it's
 * asked here, owned by an Anchor in the thread. A new agent makes it read the thread, and a commit can't read after
 * it writes, so post first, or into a new thread (`empty`).
 * @param {Message} data
 */
async function post(tx, threadId, data, { steer = false, empty = false } = {}) {
  const row = await tx.doc(Thread, threadId);
  const to = data.to ?? [];
  const prior = !empty && to.some((t) => !row.agents[agentName(t)])
    ? (await collect((cursor) => tx.scanEntries({ conversationId: threadId, order: 'ascending' }, 500, cursor))).filter((e) => e.kind === KIND).map((e) => e.id)
    : [];
  const entry = await tx.appendEntry(threadId, { kind: KIND, data });
  for (const [name, agent] of Object.entries(row.agents)) if (name !== data.author || data.from) (await tx.doc(AgentHome, agent)).unseen.push(entry.id);
  for (const t of to) {
    const name = agentName(t);
    row.agents[name] ??= await newAgent(tx, threadId, name, [...prior, entry.id]);
    const agent = row.agents[name];
    await setUp(tx, agent, threadId, t);
    const home = await tx.doc(AgentHome, agent);
    const held = [...home.unseen];
    home.unseen = [];
    if (held.length) await tx.createTask(Deliver, { agent, held, steer }, { ...own, conversationId: threadId });
  }
  return { entry: entry.id, to };
}

// An agent's conversation in a thread, owned by an Anchor there, with the thread messages it hasn't seen.
async function newAgent(tx, threadId, name, unseen) {
  const anchor = await tx.createTask(Anchor, null, { ...own, conversationId: threadId });
  const { id } = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
  Object.assign(await tx.doc(AgentHome, id), { thread: threadId, name, unseen });
  return id;
}

const setUp = async (tx, agent, threadId, t) => configure(tx, agent, {
  model: { provider: `runner:${t.runner}`, modelId: t.model },
  thinkingLevel: t.effort ?? null,
  cwd: folder((await tx.doc(Runners))[t.runner], t),
  instructions: `You are ${agentName(t)} in thread ${threadId}, with humans and other agents. Messages come to you as "name: text". Only your final answer goes back to the thread.`,
});

// An input withdrawn before it was placed gave its agent nothing: its messages are unseen again.
async function restore(tx, agent, held) {
  const home = await tx.doc(AgentHome, agent);
  home.unseen = [...new Set([...home.unseen, ...held])].sort((a, b) => a - b);
}

// What a settled input posts, and where: its answer, with `re`, the messages it held that asked the agent, or an error.
// Inputs that share one answer post it once, by the first. Posts it answers get it back, else a child thread reports
// it to its parent. A stopped input posts nothing at all. It reads the thread after settling, for steers that joined.
async function outcome(threadId, agent, settled) {
  const done = settled.status === 'done';
  if (!done && settled.reason === 'aborted') return [];
  const group = done ? (await collect((cursor) => storage.scanSubmissions({ conversationId: agent }, 500, cursor, context))).filter((r) => r.answer === settled.answer) : [settled];
  if (group[0].id !== settled.id) return [];
  const { name } = await home(agent);
  const ids = new Set(group.flatMap((r) => heldOf(r.requestId)));
  const held = (await messages(threadId)).filter((e) => ids.has(e.id));
  const re = held.filter((e) => e.data.to?.some((t) => agentName(t) === name)).map((e) => e.id);
  const body = done ? messageText((await commit((tx) => tx.entry(settled.answer)))?.model?.[0]) || '(empty answer)'
    : `gave no answer: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ''}`;
  const result = done ? { answer: { conversation: agent, entry: settled.answer } } : { error: true };
  const told = [{ thread: threadId, data: { author: name, body, ...(re.length ? { re } : {}), ...result } }];
  const posts = held.filter((e) => e.data.from && !e.data.re);
  if (posts.length && reply) return [...told, ...(await reply(posts, threadId, name, body)).map((r) => ({ ...r, steer: true }))];
  const { parent } = await thread(threadId);
  if (parent) told.push({ thread: parent, data: { author: name, body: body.split('\n').find(Boolean)?.slice(0, 160) ?? '', from: threadId } });
  return told;
}

// With no reader, as for a runner nobody owns, anyone's read counts.
async function status(id, reads, agents, shell, reader) {
  if (shell || agents.some((a) => a.status === 'working')) return 'working';
  if (agents.some((a) => a.status === 'blocked')) return 'blocked';
  const seen = new Set(reader ? [reads[reader]] : Object.values(reads));
  const handle = await harness.conversation(id, context);
  let cursor;
  do {
    const page = await handle.entries({}, 50, cursor, context);
    for (const entry of page.items) {
      if (seen.has(entry.id)) return 'idle';
      if (entry.data?.answer || entry.data?.error || entry.data?.shell) return entry.data.error ? 'error' : 'done';
    }
    cursor = page.next;
  } while (cursor);
  return 'idle';
}

async function threadRow(id, reader, live) {
  const { reads, sent, ...row } = await thread(id);
  const agents = await agentsIn(row, live);
  const shell = live.some((t) => t.kind === Shell.definition.name && t.conversationId === id);
  return { id, ...row, agents, status: await status(id, reads, agents, shell, reader) };
}
const threadList = async (reader) => {
  const live = await liveTasks();
  return (await Promise.all((await threadIds()).map((id) => threadRow(id, reader, live)))).filter((row) => !row.hidden);
};
const threadView = async (id, reader) => ({
  ...await threadRow(id, reader, await liveTasks()), conversation: await commit((tx) => tx.conversation(id)),
  shells: [...shells.values()].filter((run) => run.threadId === id), entries: await messages(id),
});

const home = (conversationId) => harness.snapshot(AgentHome, conversationId, context);

// No `to` asks whom the thread last asked; with the director, whom the body @mentions. `$ cmd` starts a Shell task.
async function postEntry(id, author, input) {
  await conversation(id);
  const body = field(input.body, 'body');
  const command = body.match(/^\$\s+([\s\S]+)/)?.[1];
  const routed = route && !command;
  let to = 'to' in input ? await addresses(input.to) : routed ? [] : await lastAsked(id);
  if (routed) to = await addresses(route({ body, to }, (await Promise.all(Object.values((await thread(id)).agents).map(agentOf))).filter(Boolean)));
  if (command) {
    if (!to.length) throw new Error('Pick a runner to run the command on');
    await commit((tx) => tx.createTask(Shell, { author, command, to: to[0] }, { ...own, conversationId: id }));
    return { command, to: to[0] };
  }
  return commit((tx) => post(tx, id, { author, body, ...(to.length ? { to } : {}) }, { steer: input.steer === true }));
}

// A new thread, and with a parent, a hand-off message there. Inside the caller's commit.
async function startThread(tx, author, title, parent) {
  const { id } = await tx.createConversation(ownerless);
  Object.assign(await tx.doc(Thread, id), { title, parent, createdAt: new Date().toISOString(), createdBy: author });
  if (parent) await post(tx, parent, { author, body: `handed off → thread:${id}` });
  return id;
}

async function createThread(author, { title, parent = null }) {
  if (parent !== null) await conversation(parent = Number(parent));
  title = field(title, 'title');
  return { id: await commit((tx) => startThread(tx, author, title, parent)) };
}

// The thread messages an agent's conversation had seen by its entry `cut`: those held by every input placed by then.
async function seenBy(id, cut) {
  const records = await collect((cursor) => storage.scanSubmissions({ conversationId: id }, 500, cursor, context));
  const held = records.filter((r) => r.type === 'input' && r.entry !== undefined && r.entry <= cut).flatMap((r) => heldOf(r.requestId));
  const { parent } = await commit((tx) => tx.conversation(id));
  return parent ? [...held, ...await seenBy(parent.conversationId, Math.min(cut, parent.at))] : held;
}

// One commit forks the thread at an entry and each agent's conversation at its last answer up to there; an agent's
// unseen messages are those up to there it hadn't seen by that answer. An agent asked up to there with no answer yet
// starts a new conversation, having seen nothing.
async function forkThread(author, id, { at, title }) {
  const shown = (await messages(id)).filter((e) => e.id <= Number(at));
  const answers = {};
  const asked = {};
  for (const { data } of shown) {
    if (data.answer) answers[data.author] = data.answer;
    for (const t of data.to ?? []) asked[agentName(t)] = t;
  }
  const fresh = Object.entries(asked).filter(([name]) => !answers[name]);
  const agents = await Promise.all(Object.entries(answers).map(async ([name, { conversation: c, entry }]) => {
    const seen = new Set(await seenBy(c, entry));
    return { name, c, entry, unseen: shown.filter((e) => !seen.has(e.id) && (e.data.author !== name || e.data.from)).map((e) => e.id) };
  }));
  const named = title?.trim() || `${(await thread(id)).title} (fork)`;
  const fork = await (await conversation(id)).fork(Number(at), {
    ...ownerless,
    init: async (tx, forkId) => {
      const row = {};
      for (const { name, c, entry, unseen } of agents) {
        const anchor = await tx.createTask(Anchor, null, { ...own, conversationId: forkId });
        row[name] = (await tx.forkConversation(c, entry, { ownership: { kind: 'task', taskId: anchor } })).id;
        Object.assign(await tx.doc(AgentHome, row[name]), { thread: forkId, name, unseen });
      }
      for (const [name, t] of fresh) {
        row[name] = await newAgent(tx, forkId, name, shown.filter((e) => e.data.author !== name || e.data.from).map((e) => e.id));
        await setUp(tx, row[name], forkId, t);
      }
      Object.assign(await tx.doc(Thread, forkId), { title: named, createdAt: new Date().toISOString(), createdBy: author, agents: row });
    },
  }, context);
  return { id: fork.id };
}

const core = { Thread, models, runners, known, address, agentName, agentOf, conversation, thread, home, threadList, messages, lastAsked, field, startThread, post };
const modules = await load('server', { director: false, talk: true, status: true }, core);
for (const m of modules) if (m.extension) registry.install(m.extension);
const route = modules.find((m) => m.route)?.route;
const reply = modules.find((m) => m.reply)?.reply;

for (const [name, runner] of Object.entries(await known())) models.setProvider(runnerProvider(runners, name, runner.models));
harness.resume();

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
      return send(res, 200, Object.entries(await known()).map(([name, { models, ...runner }]) => ({ name, ...runner, models: Object.keys(models ?? {}), online: runners.isOnline(name), calls: runners.working(name) })));
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
      // Pi's abort of the thread reaches its tasks, and through each Anchor its agents' runs and queued inputs.
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
  const resolved = (await known())[name]?.models ?? {};
  const runner = { alias: q('alias'), owner: q('owner'), host: q('host'), dir: q('dir') || '/', model: q('model'), lastSeen: new Date().toISOString(), models: resolved };
  await commit(async (tx) => { (await tx.doc(Runners))[name] = runner; });
  if (!models.getProvider(`runner:${name}`)) models.setProvider(runnerProvider(runners, name, resolved));
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
