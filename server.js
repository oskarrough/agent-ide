import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AgentDoc, configure, createRegistry, defineDoc, defineDocFamily, defineExtension, defineTask, Harness, watchEvents } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { load } from './modules.js';
import { WebSocketServer } from 'ws';
import { createRunners, messageText, remoteEnv, runnerBundle, runnerProvider } from './remote.js';

/**
 * @typedef {{ runner: string, model: string, effort?: string, dir?: string }} To  An agent, named `provider/id@runner`.
 * @typedef {object} Message  The data of every thread entry.
 * @property {string} author  A human's name, or an agent's.
 * @property {string} body
 * @property {To[]} [to]  The agents it asks.
 * @property {number} [from]  The thread it came from.
 * @property {number[]} [re]  What it answers: messages here, or with `from`, posts there.
 * @property {{ conversation: number, entry: number }} [answer]  The agent's entry it copies.
 * @property {true} [error]  The agent gave no answer.
 * @property {{ runner: string, code: number | null, stdout: string, stderr: string, error?: string }} [shell]  What `$ cmd` printed.
 * @typedef {{ id: number, kind: 'agent-ide.message', data: Message }} Entry
 * @typedef {{ name: string, conversation: number, to: To | null, status: string }} Agent
 * @typedef {{ agent: number, held: number[], steer: boolean }} Delivery  The thread messages one input to an agent holds.
 * @typedef {{ author: string, command: string, to: To }} Command
 */

const port = Number(process.env.PORT || 3000);
const file = process.env.DB_PATH || `agent-ide-${port}.sqlite`;
const KIND = 'agent-ide.message';
// An agent's input in its conversation; `held` names the thread messages it gave.
const DELIVERY = 'agent-ide.delivery';
// Our docs are small, so every change stores the whole doc and a read replays nothing.
const base = () => true;
// Every runner that ever connected, with the models pi resolved on it.
const Runners = defineDoc({ kind: 'agent-ide.runners', version: 1, scope: 'session', checkpointWhen: base, initial: () => ({}) });
// `agents`: name → Pi conversation.
const Thread = defineDoc({
  kind: 'agent-ide.thread', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', checkpointWhen: base,
  initial: () => ({ title: '', parent: null, createdAt: '', hidden: false, reads: {}, agents: {} }),
});
// On an agent's conversation: its thread, its name there, and the messages it hasn't seen.
const AgentHome = defineDoc({ kind: 'agent-ide.agent', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', checkpointWhen: base, initial: () => ({ thread: 0, name: '', unseen: [] }) });
// By request id: the command a request made and what it answered, written in the commit that did the work.
const Receipts = defineDocFamily({ kind: 'agent-ide.receipt', version: 1, scope: 'session', family: true, checkpointWhen: base, initial: () => ({ receipt: null }) });
const now = () => new Date().toISOString();
const ownerless = { ownership: { kind: 'ownerless' } };
const own = { ownership: { kind: 'conversation' } };
const finished = (status = 'completed') => ({ status: 'terminal', outcome: { status, result: null } });

// Owns an agent's conversation, so stopping the thread stops the agent.
const Anchor = defineTask({
  name: 'agent-ide.anchor', version: 1, initial: () => ({ phase: 'own' }),
  phases: { own: (task, rt, ctx) => rt.commit(() => finished(), ctx) },
  abort: (task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
});

// Asks an agent once, under its own id as request id so a rerun finds the input, and posts the outcome as it ends.
const Deliver = defineTask({
  name: 'agent-ide.deliver', version: 1, initial: () => ({ phase: 'ask' }),
  phases: {
    async ask({ id, conversationId: threadId, input: { agent, held, steer } }, rt, ctx) {
      const to = await agentOf(agent);
      await runners.online(to.runner, rt.signal);
      const all = await messages(threadId);
      const mine = all.filter((e) => held.includes(e.id));
      const content = catchUp ? await catchUp(threadId, mine, all, agent) : mine.map(said).join('\n\n');
      const handle = await rt.conversation(agent, ctx);
      const entry = { kind: DELIVERY, data: { held } };
      const submission = await handle.submit({ type: 'input', content, entry, requestId: String(id), whenBusy: steer ? 'steer' : 'followUp' }, ctx);
      const settled = await submission.wait(ctx);
      const told = await outcome(threadId, agent, settled, held);
      await rt.commit(async (tx) => {
        for (const { thread, data, steer } of told) await post(tx, thread, data, { steer });
        if (settled.entry === undefined) await restore(tx, agent, held);
        return finished();
      }, ctx);
    },
  },
  // Pi's abort of the thread withdrew its input if still queued.
  abort: ({ id, input: { agent, held } }, rt, ctx) => rt.commit(async (tx) => {
    if ((await tx.submissionByRequest(agent, String(id)))?.entry === undefined) await restore(tx, agent, held);
    return finished('aborted');
  }, ctx),
});

// `$ cmd` as an effect sandwich: commit, run, post. Reopened mid-run, it says a restart interrupted it.
const Shell = defineTask({
  name: 'agent-ide.shell', version: 1, initial: () => ({ phase: 'run' }),
  phases: {
    async run({ id, conversationId: threadId, input }, rt, ctx) {
      await rt.commit(() => ({ status: 'running', checkpoint: { phase: 'interrupted' } }), ctx);
      const run = { threadId, author: input.author, to: input.to, command: input.command, stdout: '', stderr: '' };
      shells.set(id, run);
      notify();
      const env = remoteEnv(runners, input.to.runner, folder((await known())[input.to.runner], input.to));
      const result = await env.exec(input.command, { onOutput: (text, _context, info) => { run[info.stream] += text; notify(); } }, ctx);
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
const runners = createRunners({ onChange: notify });
// What each running `$ cmd` has printed so far.
const shells = new Map();
const page = await readFile(new URL('./client.html', import.meta.url));
// The runner this server ships, and the launcher that fetches it: `curl -fsSL <server>/runner.sh | sh -s -- --dir ~/code`.
const bundle = await runnerBundle(import.meta.dirname);
const launcher = await readFile(new URL('./launcher.js', import.meta.url));

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
// A storage error closes the harness for good; exit, so a supervisor can restart.
harness.closed.then((end) => end.reason === 'failed' && (console.error('pi-durable: storage failed, exiting:', end.error), process.exit(1)));
// A stop closes the harness, so the tasks it cuts off wait to resume, and Pi doesn't count them as crashed.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => harness.close(context).finally(() => process.exit(0)));

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

// An agent's conversation has no Thread doc.
const threadIds = async () => {
  const all = (await collect((cursor) => commit((tx) => tx.scanConversations({}, 500, cursor)))).map((c) => c.id).sort((a, b) => b - a);
  return (await Promise.all(all.map(async (id) => (await thread(id)) && id))).filter(Boolean);
};

const agentName = (to) => to && `${to.model}@${to.runner}`;
// `model@runner`, or a bare runner for its default model.
const agentTo = (name) => {
  const at = name.lastIndexOf('@');
  return { runner: name.slice(at + 1), model: at < 0 ? '' : name.slice(0, at) };
};
// A person's name as one line of printable text, so no author can write a speaker line of their own.
const speaker = (name) => [...String(name ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 40).join('').trim() || 'anon';
const user = (req) => speaker(req.headers['x-user']);

function field(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

// A model is what `pi --model` makes of it on the runner; offline, only one it resolved before.
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

// A runner with an owner takes work from its owner and the names it allows: people, or `@runner` for the agents there.
// `by` is a person, or `@runner` for an agent. Offline, the runner's last word holds.
async function reach(to, by) {
  for (const { runner: name } of to) {
    const { owner, allow = [] } = (await known())[name];
    if (owner && by !== owner && by !== `@${name}` && !allow.includes(by)) {
      throw Object.assign(new Error(`${name} takes work only from ${[owner, ...allow].join(', ')}`), { status: 403 });
    }
  }
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

// Working while a delivery to it is live.
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

function said({ data: m }) {
  const who = m.from ? `${m.author}, ${m.re ? 'answering' : 'writing'} from thread ${m.from}` : m.author;
  const output = m.shell ? `\n${[`exit ${m.shell.code ?? m.shell.error}`, m.shell.stdout, m.shell.stderr].filter(Boolean).join('\n')}` : '';
  return `${who}: ${m.body}${output}`;
}

/**
 * Writes a message, inside the caller's commit, and gives each agent it asks a Deliver task with all it hasn't seen.
 * A new agent reads the thread, which a commit can't do after writing: post first, or pass `empty` for a new thread.
 * @param {Message} data
 */
async function post(tx, threadId, data, { steer = false, empty = false } = {}) {
  const row = await tx.doc(Thread, threadId);
  const to = data.to ?? [];
  const prior = !empty && to.some((t) => !row.agents[agentName(t)])
    ? (await collect((cursor) => tx.scanEntries({ conversationId: threadId, order: 'ascending' }, 500, cursor))).filter((e) => e.kind === KIND).map((e) => e.id)
    : [];
  const entry = await tx.appendEntry(threadId, { kind: KIND, data });
  for (const m of posted) await m(tx, threadId, entry);
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

// Owned by an Anchor in the thread; with `from`, Pi's fork of another agent's conversation at an entry.
async function newAgent(tx, threadId, name, unseen, from) {
  const anchor = await tx.createTask(Anchor, null, { ...own, conversationId: threadId });
  const ownership = { ownership: { kind: 'task', taskId: anchor } };
  const { id } = from ? await tx.forkConversation(from.conversation, from.entry, ownership) : await tx.createConversation(ownership);
  Object.assign(await tx.doc(AgentHome, id), { thread: threadId, name, unseen });
  return id;
}

const setUp = async (tx, agent, threadId, t) => configure(tx, agent, {
  model: { provider: `runner:${t.runner}`, modelId: t.model },
  thinkingLevel: t.effort ?? null,
  cwd: folder((await tx.doc(Runners))[t.runner], t),
  instructions: `You are ${agentName(t)} in thread ${threadId}, with humans and other agents. Messages come to you as "name: text". Only your final answer goes back to the thread.`,
});

// An input withdrawn before it was placed: its messages are unseen again.
async function restore(tx, agent, held) {
  const home = await tx.doc(AgentHome, agent);
  home.unseen = [...new Set([...home.unseen, ...held])].sort((a, b) => a - b);
}

// What a settled input posts, and where. Inputs sharing one answer post it once, by the first; posts get it back,
// else a child thread tells its parent. Reads the thread after settling, for steers that joined.
async function outcome(threadId, agent, settled, mine) {
  const done = settled.status === 'done';
  if (!done && settled.reason === 'aborted') return [];
  const group = done ? (await collect((cursor) => storage.scanSubmissions({ conversationId: agent }, 500, cursor, context))).filter((r) => r.answer === settled.answer) : [settled];
  if (group[0].id !== settled.id) return [];
  const { name } = await home(agent);
  const ids = new Set(done ? (await commit((tx) => Promise.all(group.map((r) => tx.entry(r.entry))))).flatMap((e) => e.data.held) : mine);
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

// With no reader, anyone's read counts. A stopped `$ cmd` is no result.
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
      if (entry.data?.shell?.error === 'stopped') continue;
      if (entry.data?.answer || entry.data?.error || entry.data?.shell) return entry.data.error || entry.data.shell?.error ? 'error' : 'done';
    }
    cursor = page.next;
  } while (cursor);
  return 'idle';
}

async function threadRow(id, reader, live) {
  const { reads, ...row } = await thread(id);
  const agents = await agentsIn(row, live);
  const shell = live.some((t) => t.kind === Shell.definition.name && t.conversationId === id);
  return { id, ...row, agents, shells: [...shells.values()].filter((run) => run.threadId === id), status: await status(id, reads, agents, shell, reader),
    conversation: await storage.conversation(id, context) };
}
const threadList = async (reader) => {
  const live = await liveTasks();
  return (await Promise.all((await threadIds()).map((id) => threadRow(id, reader, live)))).filter((row) => !row.hidden);
};
const threadView = async (id, reader) => ({ ...await threadRow(id, reader, await liveTasks()), entries: await messages(id) });

const home = (conversationId) => harness.snapshot(AgentHome, conversationId, context);

// Does `work` once per request id, or every time without one; a retry gets the first result.
const once = (requestId, command, work) => commit(async (tx) => {
  if (requestId === undefined) return work(tx);
  if (typeof requestId !== 'string' || !requestId || requestId.length > 128) throw new Error('requestId must be a string of 1 to 128 characters');
  const doc = await tx.doc(Receipts, requestId, null);
  if (doc.receipt) {
    if (doc.receipt.command !== command) throw new Error(`requestId ${requestId} was used for ${doc.receipt.command}`);
    return JSON.parse(JSON.stringify(doc.receipt.result));
  }
  const result = await work(tx);
  doc.receipt = { command, result };
  return result;
});

// No `to` asks whom the thread last asked, or with the director, whom the body @mentions.
async function postEntry(id, author, input) {
  await conversation(id);
  const body = field(input.body, 'body');
  const command = body.match(/^\$\s+([\s\S]+)/)?.[1];
  const routed = route && !command;
  let to = 'to' in input ? await addresses(input.to) : routed ? [] : await lastAsked(id);
  if (routed) to = await addresses(route({ body, to }, (await Promise.all(Object.values((await thread(id)).agents).map(agentOf))).filter(Boolean)));
  if (command && !to.length) throw new Error('Pick a runner to run the command on');
  await reach(to, author);
  return once(input.requestId, `post ${id}`, async (tx) => command
    ? (await tx.createTask(Shell, { author, command, to: to[0] }, { ...own, conversationId: id }), { command, to: to[0] })
    : post(tx, id, { author, body, ...(to.length ? { to } : {}) }, { steer: input.steer === true }));
}

// Inside the caller's commit.
async function startThread(tx, author, title, parent) {
  const { id } = await tx.createConversation(ownerless);
  Object.assign(await tx.doc(Thread, id), { title, parent, createdAt: now() });
  if (parent) await post(tx, parent, { author, body: `handed off → thread:${id}` });
  return id;
}

async function createThread(author, { title, parent = null, requestId }) {
  if (parent !== null) await conversation(parent = Number(parent));
  title = field(title, 'title');
  return once(requestId, 'create thread', async (tx) => ({ id: await startThread(tx, author, title, parent) }));
}

// The thread messages an agent had seen by its entry `cut`, a fork's parent's included.
async function seenBy(id, cut) {
  const handle = await harness.conversation(id, context);
  const entries = await collect((cursor) => handle.entries({ maxEntryId: cut, order: 'ascending' }, 500, cursor, context));
  return entries.filter((e) => e.kind === DELIVERY).flatMap((e) => e.data.held);
}

// Forks the thread at `at`, and each agent at its last answer up to there. One asked but unanswered starts fresh.
async function forkThread(id, { at, title }) {
  const shown = (await messages(id)).filter((e) => e.id <= Number(at));
  const answers = {};
  const asked = {};
  for (const { data } of shown) {
    if (data.answer) answers[data.author] = data.answer;
    for (const t of data.to ?? []) asked[agentName(t)] = t;
  }
  const fresh = Object.entries(asked).filter(([name]) => !answers[name]);
  const agents = await Promise.all(Object.entries(answers).map(async ([name, answer]) => {
    const seen = new Set(await seenBy(answer.conversation, answer.entry));
    return { name, answer, unseen: shown.filter((e) => !seen.has(e.id) && (e.data.author !== name || e.data.from)).map((e) => e.id) };
  }));
  const named = title?.trim() || `${(await thread(id)).title} (fork)`;
  const fork = await (await conversation(id)).fork(Number(at), {
    ...ownerless,
    init: async (tx, forkId) => {
      const row = {};
      for (const { name, answer, unseen } of agents) row[name] = await newAgent(tx, forkId, name, unseen, answer);
      for (const [name, t] of fresh) {
        row[name] = await newAgent(tx, forkId, name, shown.filter((e) => e.data.author !== name || e.data.from).map((e) => e.id));
        await setUp(tx, row[name], forkId, t);
      }
      Object.assign(await tx.doc(Thread, forkId), { title: named, createdAt: now(), agents: row });
    },
  }, context);
  return { id: fork.id };
}

const core = { speaker, models, runners, known, address, reach, agentName, agentTo, agentOf, conversation, thread, home, threadList, messages, lastAsked, field, startThread, post, said, seenBy, commit, collect, once };
const modules = await load('server', { director: false, talk: true, status: true, memory: false, matrix: false, context: true }, core);
for (const m of modules) if (m.extension) registry.install(m.extension);
const hook = (name) => modules.find((m) => m[name])?.[name];
const posted = modules.flatMap((m) => m.posted ?? []);
const [route, reply, catchUp] = ['route', 'reply', 'catchUp'].map(hook);

for (const [name, runner] of Object.entries(await known())) models.setProvider(runnerProvider(runners, name, runner.models));
harness.resume();

async function input(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200000) throw new Error('Request too large');
  }
  return JSON.parse(body || '{}');
}

async function hideThread(id) {
  await conversation(id);
  await commit(async (tx) => { (await tx.doc(Thread, id)).hidden = true; });
  return { id };
}

async function markRead(id, reader) {
  const newest = (await (await conversation(id)).entries({}, 1, undefined, context)).items[0]?.id;
  if (newest && (await thread(id)).reads[reader] !== newest) await commit(async (tx) => { (await tx.doc(Thread, id)).reads[reader] = newest; });
  return { read: newest ?? null };
}

async function conversationView(id) {
  const view = await (await harness.conversation(id, context))?.viewState(context);
  if (!view) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  view.dispose();
  return view.value;
}

// As the README lists them; a module may serve GET /api/threads/:id/<its name>.
const routes = [
  ['GET /api/server', async () => ({ port, file, modules: modules.map((m) => m.name), threads: (await threadIds()).length, runners: Object.keys(await known()).length, work: await harness.inspect(context) })],
  ['GET /api/runners', async () => Object.entries(await known()).map(([name, { models, offers, ...runner }]) => ({ name, ...runner, offers: offers ?? [], models: Object.keys(models ?? {}), online: runners.isOnline(name), calls: runners.working(name), outdated: Boolean(runner.version) && runner.version !== bundle.version }))],
  ['GET /runner/bundle', () => bundle],
  ['GET /api/threads', (req) => threadList(user(req))],
  ['POST /api/threads', async (req) => createThread(user(req), await input(req))],
  ['GET /api/threads/:id', (req, id) => threadView(id, user(req))],
  ['DELETE /api/threads/:id', (req, id) => hideThread(id)],
  ['POST /api/threads/:id/entries', async (req, id) => postEntry(id, user(req), await input(req))],
  ['POST /api/threads/:id/fork', async (req, id) => forkThread(id, await input(req))],
  ['POST /api/threads/:id/read', (req, id) => markRead(id, user(req))],
  // Pi's abort of the thread reaches its tasks, and through each Anchor its agents.
  ['POST /api/threads/:id/stop', async (req, id) => {
    await (await conversation(id)).abort(context);
    return { stopped: id };
  }],
  ['GET /api/conversations/:id', (req, id) => conversationView(id)],
  ...modules.filter((m) => m.serve).map((m) => [`GET /api/threads/:id/${m.name}`, (req, id, url) => m.serve(id, url.searchParams)]),
].map(([key, handle]) => [new RegExp(`^${key.replace(':id', '(\\d+)')}$`), handle]);

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(value));
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-user' });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (req.method === 'GET' && url.pathname === '/runner/launcher.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(launcher);
  }
  if (req.method === 'GET' && url.pathname === '/runner.sh') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(runnerScript(`${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${String(req.headers.host).replace(/[^\w.:\[\]-]/g, '')}`));
  }
  const key = `${req.method} ${url.pathname}`;
  for (const [pattern, handle] of routes) {
    const match = pattern.exec(key);
    if (!match) continue;
    try {
      send(res, req.method === 'POST' ? 201 : 200, await handle(req, match[1] && Number(match[1]), url));
    } catch (error) {
      send(res, error.status ?? 400, { error: error.message });
    }
    return;
  }
  send(res, 404, { error: 'Not found' });
}

// Finds bun or Node, then hands over to the launcher, which keeps the runner up to date with this server.
const runnerScript = (server) => `#!/bin/sh
# Lends this machine to the agent-ide server at ${server}:
#   curl -fsSL ${server}/runner.sh | sh -s -- --dir ~/code [--name laptop] [--read-only] [--no-update]
set -e
if command -v bun >/dev/null 2>&1; then run=bun; elif command -v node >/dev/null 2>&1; then run=node; else
  echo "agent-ide's runner needs bun (curl -fsSL https://bun.sh/install | bash) or Node.js 24 or newer"; exit 1
fi
mkdir -p "$HOME/.agent-ide"
curl -fsSL "${server}/runner/launcher.js" -o "$HOME/.agent-ide/launcher.js"
echo "Next time, without curl: $run ~/.agent-ide/launcher.js ${server} $*"
exec "$run" "$HOME/.agent-ide/launcher.js" "${server}" "$@"
`;

// A launched runner whose version differs is asked to update once per connection, when it has no calls open, so
// nothing it's doing is cut off. Threads that need it meanwhile wait for it, as for any offline runner.
const outdated = new Map();
function nudge() {
  for (const [name, socket] of outdated) {
    if (sockets.get(name) !== socket) outdated.delete(name);
    else if (!runners.working(name).length) {
      outdated.delete(name);
      runners.tell(name, { op: 'update' });
    }
  }
}

// Browsers hear that something changed, at most every 100 ms, and refresh their lists.
let flushing;
function notify() {
  flushing ??= setTimeout(() => {
    flushing = undefined;
    nudge();
    for (const socket of clients) socket.send('{}');
    for (const m of modules) m.changed?.();
  }, 100);
}
harness.subscribeCommits(() => notify());

// A browser watches one thread: Pi's agent events of its conversation and of each agent's, each stream snapshot first.
// An agent's snapshots leave out its entries, which the thread has no use for. One socket's watches go in turn.
const watch = (socket, id) => socket.watches = (socket.watches ?? Promise.resolve()).then(() => rewatch(socket, id)).catch(() => {});
async function rewatch(socket, id) {
  const old = socket.watching;
  socket.watching = undefined;
  for (const stream of old?.streams.values() ?? []) (await stream).stop();
  if (typeof id === 'number' && await thread(id)) await follow(socket, socket.watching = { thread: id, streams: new Map() });
}
// Starts a stream for the thread and for each agent not followed yet; the post that asks a new agent is a thread event,
// which follows it from the commit that made it.
async function follow(socket, w) {
  const agents = Object.entries((await thread(w.thread)).agents).map(([name, c]) => [c, name]);
  for (const [c, agent] of [[w.thread], ...agents]) {
    if (w.streams.has(c) || socket.watching !== w) continue;
    const send = (events) => socket.watching === w && socket.send(JSON.stringify({ thread: w.thread, ...(agent ? { agent } : {}),
      events: agent ? events.map((e) => e.type === 'snapshot' ? { ...e, entries: [] } : e) : events }));
    const stream = watchEvents(harness, c, context);
    w.streams.set(c, stream);
    const { snapshot, start } = await stream;
    send([snapshot]);
    start(async (events) => (send(events), agent || follow(socket, w).catch(() => {})));
  }
}

const sockets = new Map();
const wss = new WebSocketServer({ noServer: true });
async function upgrade(req, raw, head) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return raw.destroy();
  const socket = await new Promise((resolve) => wss.handleUpgrade(req, raw, head, resolve));
  const name = url.searchParams.get('runner');
  const close = () => {
    clients.delete(socket);
    watch(socket, null);
    if (!name || sockets.get(name) !== socket) return;
    sockets.delete(name);
    runners.disconnect(name);
    console.log(`runner ${name} offline`);
  };
  socket.on('close', close);
  socket.on('error', close);
  // A frame that doesn't parse is dropped, so one bad client never stops the server.
  const listen = (handle) => socket.on('message', (data) => {
    try { handle(data.toString()); } catch (error) { console.error(`dropped a frame from ${name ?? 'a browser'}: ${error.message}`); }
  });
  if (!name) {
    listen((text) => watch(socket, JSON.parse(text).watch));
    return clients.add(socket);
  }
  // A reconnecting runner replaces its old socket, whose calls fail.
  if (sockets.has(name)) {
    sockets.get(name).terminate();
    runners.disconnect(name);
  }
  sockets.set(name, socket);
  const q = (param) => url.searchParams.get(param) || '';
  const resolved = (await known())[name]?.models ?? {};
  const runner = { alias: q('alias'), owner: q('owner') && speaker(q('owner')), allow: url.searchParams.getAll('allow').map(speaker), host: q('host'), dir: q('dir') || '/', readOnly: q('readOnly') === '1', version: q('version'), model: q('model'), modelError: q('modelError'), offers: url.searchParams.getAll('offer'), models: resolved };
  await commit(async (tx) => { (await tx.doc(Runners))[name] = runner; });
  if (!models.getProvider(`runner:${name}`)) models.setProvider(runnerProvider(runners, name, resolved));
  listen(runners.receive);
  runners.connect(name, (text) => socket.send(text));
  if (runner.version && runner.version !== bundle.version) {
    outdated.set(name, socket);
    notify();
  }
  console.log(`runner ${name} online: ${runner.dir}${runner.readOnly ? ' (read-only)' : ''}, default model ${runner.model || `none (${runner.modelError || 'not set'})`}${runner.owner ? `, work from ${[runner.owner, ...runner.allow].join(', ')}` : ''}`);
}

// RUNNER=~/code lends this machine too: its own runner.js, one more process, which stops with the server.
let lent;
function lend(url) {
  if (!process.env.RUNNER || lent) return;
  lent = spawn(process.execPath, [new URL('./runner.js', import.meta.url).pathname, '--server', url, '--dir', process.env.RUNNER], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => lent.kill(signal));
}

for (const host of process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1']) {
  const server = http.createServer(handleRequest);
  server.on('upgrade', (req, socket, head) => upgrade(req, socket, head).catch((error) => { console.error(error); socket.destroy(); }));
  server.on('error', (error) => {
    if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) return;
    console.error(error);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const addresses = host === '0.0.0.0' ? Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4').map((a) => a.address) : [host === '::1' ? '[::1]' : host];
    for (const address of addresses) console.log(`http://${address}:${server.address().port} on ${file}, modules: ${modules.map((m) => m.name).join(', ') || 'none'}`);
    lend(`http://${host === '0.0.0.0' ? '127.0.0.1' : addresses[0]}:${server.address().port}`);
  });
}
