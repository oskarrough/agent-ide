// Keeps every thread as a conversation in one Pi Durable harness. Runners lend it their models and folders.
// An agent is a model on a runner: `{ runner, model, effort?, dir? }`, named like gpt-6.1-sol@laptop.
// PORT=3000 DB_PATH=agent-ide-3000.sqlite [DIRECTOR=1] bun server.js
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { AgentDoc, createRegistry, defineDoc, defineExtension, defineTool, Harness, InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { createRunners, remoteEnv, runnerProvider } from './remote.js';

const port = Number(process.env.PORT || 3000);
const file = process.env.DB_PATH || `agent-ide-${port}.sqlite`;
// Every runner that has connected, by name, so their models still resolve after a restart.
const Runners = defineDoc({ kind: 'agent-ide.runners', version: 1, scope: 'session', initial: () => ({}) });
// What agent-ide adds to a conversation: a title, maybe a parent, how far each reader has read, and the threads its
// agent started, by the tool call that started them. Its agent is Pi's own (pi.agent), and the thread list is Pi's list of conversations.
const Thread = defineDoc({
  kind: 'agent-ide.thread', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ title: '', parent: null, createdAt: '', createdBy: '', hidden: false, reads: {}, started: {} }),
});

const clients = new Set();
const runners = createRunners({ onChange: () => notify(null) });
// `$ cmd` runs, by key, with their output so far. They become entries when they finish.
const shells = new Map();
// Who answers an entry with no `to`. Alone, the thread's last agent. The director, for multiplayer threads, decides instead.
const director = process.env.DIRECTOR ? await import('./director.js') : null;
const page = await readFile(new URL('./client.html', import.meta.url));

const models = createModels();
const registry = createRegistry();
registry.install(CodingTools);
// Agents talk to other threads through tools that run here, on the server, defined further down.
registry.install(threadTools());
const storage = await openNodeSqliteStorage(file);
const harness = await Harness.open(storage, {
  models,
  registry,
  // A conversation's files and commands are on the runner whose model it uses, in the folder it was given.
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

// Every thread, newest first: Pi's conversations that carry our thread doc.
async function threadIds() {
  const ids = [];
  let cursor;
  do {
    const page = await commit((tx) => tx.scanConversations({}, 500, cursor));
    ids.push(...page.items.map((record) => record.id));
    cursor = page.next;
  } while (cursor);
  return ids.sort((a, b) => b - a);
}

for (const name of Object.keys(await known())) models.setProvider(runnerProvider(runners, name));
// Work the last process left unfinished carries on: answers, tool calls, retries.
harness.resume();

const agentName = (to) => to && `${to.model.split('/').pop()}@${to.runner}`;
// An input's request id says who wrote it and who should answer, as URL params: author=oskar&runner=laptop&model=…&key=….
// An input written in another thread says so with `from`, like an email's From. A post asks for an answer back there;
// an answer says what it answers with `re`, the post's entry, and asks for nothing, so two threads never ping-pong.
// Pi Durable keeps the request id on the input's submission record, beside the entry the input became. A request id
// repeated finds the first input.
const requestFor = (author, to, { key, from, re }) => new URLSearchParams({ author, ...to, ...(from ? { from } : {}), ...(re ? { re } : {}), key }).toString();
function readRequest(requestId) {
  const { author, key, from, re, ...to } = Object.fromEntries(new URLSearchParams(requestId));
  return { requestId, author, from: from ? Number(from) : null, re: re ? Number(re) : null, to: to.runner && to.model ? to : null };
}
// What the model reads before an input's body, rendered from the request id: who wrote it, and where, if not here.
const heading = ({ author, from, re }) => from ? `${author}, ${re ? 'answering' : 'writing'} from thread ${from}: ` : `${author}: `;
const same = (a, b) => ['runner', 'model', 'effort', 'dir'].every((key) => (a?.[key] ?? '') === (b?.[key] ?? ''));
const user = (req) => req.headers['x-user'] || 'anon';
const userMessage = (text) => ({ role: 'user', content: text, timestamp: Date.now() });
const tail = (text) => text.slice(-20000);

function field(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

// A `to` names an agent: a runner, a model on it (the runner's default if left out), and optionally effort and a folder.
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

// A `to` as Pi's agent: the model through the runner's provider, effort as thinking level, dir as cwd.
async function agentFor(to, id) {
  return {
    model: { provider: `runner:${to.runner}`, modelId: to.model },
    thinkingLevel: to.effort ?? null,
    cwd: folder((await known())[to.runner], to),
    instructions: `You are ${agentName(to)} in thread ${id}, with humans and agents. Each message starts with who wrote it, and the thread they wrote from if it isn't this one.`,
  };
}

// And back: the thread's agent is whatever Pi's agent doc says, read as a `to`.
async function agentOf(id) {
  const agent = await harness.snapshot(AgentDoc, id, context);
  const name = agent?.model?.provider?.match(/^runner:(.+)$/)?.[1];
  if (!name) return null;
  const runner = (await known())[name];
  const dir = runner && agent.cwd ? path.relative(runner.dir, agent.cwd) : '';
  return { runner: name, model: agent.model.modelId, ...(agent.thinkingLevel ? { effort: agent.thinkingLevel } : {}), ...(dir ? { dir } : {}) };
}

// An entry that asks nobody anything: written at the next boundary, so never into the middle of a run.
const write = async (threadId, entry, requestId) => (await conversation(threadId)).submit({ type: 'write', entry, requestId }, context);

// The human inputs submitted to this thread itself, oldest first, read from Pi's submission records: its request id, and its entry once placed.
async function ownInputs(id) {
  const found = [];
  let cursor;
  do {
    const page = await storage.scanSubmissions({ conversationId: id }, 500, cursor, context);
    for (const record of page.items) if (record.type === 'input' && record.requestId) found.push({ ...readRequest(record.requestId), record });
    cursor = page.next;
  } while (cursor);
  return found.sort((a, b) => a.record.id - b.record.id);
}

// Every human input in a thread's history. A fork's inherited entries were submitted to the thread it came from,
// so its inputs are that thread's, placed up to the fork's entry, then its own.
async function inputs(id) {
  const { parent } = await commit((tx) => tx.conversation(id));
  const inherited = parent ? (await inputs(parent.conversationId)).filter((input) => input.record.entry <= parent.at) : [];
  return [...inherited, ...await ownInputs(id)];
}

const messageText = (message) => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('');

// Who wrote each entry. A human input's author and `to` come from its request id. The model's answers and tool results
// belong to the agent of the input before them. An answer replies to every input its run took: a steer, several follow-ups.
async function annotate(id, entries) {
  const asks = new Map();
  const replies = new Map();
  for (const input of await inputs(id)) {
    const { entry, answer } = input.record;
    if (entry !== undefined) asks.set(entry, input);
    if (answer !== undefined) replies.set(answer, [...(replies.get(answer) ?? []), entry]);
  }
  let asked = null;
  return entries.map((entry) => {
    const input = asks.get(entry.id);
    if (input) asked = input;
    const author = input?.author ?? entry.data?.author
      ?? (['pi.assistant', 'pi.tool-result'].includes(entry.kind) ? agentName(asked?.to) : entry.kind.startsWith('pi.') ? 'pi' : 'server');
    const said = input && messageText(entry.model?.[0]);
    const wrote = input ? { requestId: input.requestId, from: input.from, re: input.re, body: said.startsWith(heading(input)) ? said.slice(heading(input).length) : said } : {};
    return { author, to: input?.to ?? entry.data?.to ?? null, ...wrote, replyTo: replies.get(entry.id) ?? [], entry };
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
async function status(id, row, agent, reader) {
  const live = await harness.snapshot(LiveDoc, id, context);
  const inbox = await harness.snapshot(InboxDoc, id, context);
  const waiting = live?.run || inbox?.items?.some((item) => item.mode !== 'write');
  if (waiting) return agent && !runners.isOnline(agent.runner) ? 'queued' : 'working';
  if ([...shells.values()].some((run) => run.threadId === id)) return 'working';
  const recent = (await (await harness.conversation(id, context)).entries({}, 50, undefined, context)).items;
  for (const entry of recent) {
    if (entry.id === row.reads[reader]) return 'idle';
    if (isResult(entry)) return entry.kind === 'agent-ide.error' ? 'failed' : 'done';
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

// A thread as the client sees it: our row, Pi's built-in docs (live answer, inbox, agent, usage), every entry with its author.
async function threadView(id, reader) {
  const handle = await conversation(id);
  const row = await thread(id);
  const view = await handle.viewState(context);
  const { conversation: record, docs } = view.value;
  view.dispose();
  const entries = await annotate(id, await history(handle));
  const agent = await agentOf(id);
  const running = [...shells.values()].filter((run) => run.threadId === id);
  return { id, ...row, agent, status: await status(id, row, agent, reader), conversation: record, docs, shells: running, entries };
}

// Waits for an input's answer, even across a restart, then reports it. An agent's post is answered back in the thread it
// came from, as an input that wakes that thread's agent. Anyone else's gets a note in the parent thread.
// No answer is also an error entry here. The reports' request ids make it safe to follow an input twice.
async function follow(id, requestId) {
  const record = await commit((tx) => tx.submissionByRequest(id, requestId));
  if (!record) return;
  const settled = await (await harness.submission(record.id, context)).wait(context);
  const row = await thread(id);
  const { from, re, to } = readRequest(requestId);
  const back = from && !re;
  if (settled.status === 'done' && !row.parent && !back) return;
  const agent = agentName(to);
  let body;
  if (settled.status === 'done') {
    const answer = await commit((tx) => tx.entry(settled.answer));
    body = messageText(answer?.model?.[0]) || '(empty answer)';
  } else {
    body = `gave no answer: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ''}`;
    await write(id, { kind: 'agent-ide.error', data: { text: `${agent} ${body}`, post: requestId } }, `error:${requestId}`);
  }
  if (back) return reply(from, id, agent, body, record.entry);
  const text = `${agent}: ${body.split('\n').find(Boolean)?.slice(0, 160)}`;
  if (row.parent) await write(row.parent, { kind: 'agent-ide.note', data: { author: agent, text: `${text} → thread:${id}`, thread: id }, model: [userMessage(`${text} (from thread ${id})`)] }, `report:${requestId}`);
}

// An answer to an agent's post goes back to that agent as an input from whoever answered. It steers: an idle agent wakes,
// a working one reads it between tool calls instead of after it's done. If another agent has the thread by now, it waits there as a note.
async function reply(threadId, answeredIn, agent, body, post) {
  const text = body.slice(0, 8000);
  const key = `re:${post}`;
  try {
    await postEntry(threadId, agent, { body: text, to: await agentOf(threadId), steer: true }, { key, from: answeredIn, re: post });
  } catch (error) {
    if (error.status !== 409) throw error;
    const said = `${heading({ author: agent, from: answeredIn, re: post })}${text}`;
    await write(threadId, { kind: 'agent-ide.note', data: { author: agent, text: `${said} → thread:${answeredIn}`, thread: answeredIn }, model: [userMessage(said)] }, key);
  }
}

// After a restart, every human input is followed again, placed or still queued. A fork's inherited ones are its source's to follow.
for (const id of await threadIds()) {
  if (!await thread(id)) continue;
  for (const { requestId } of await ownInputs(id)) follow(id, requestId).catch((error) => console.error(error));
}

// `$ cmd` runs through the runner's environment, like the agent's own bash, and lands as an entry with its output.
async function shell(id, author, command, to, key) {
  const runner = (await known())[to.runner];
  const run = { threadId: id, author, to, command, stdout: '', stderr: '' };
  shells.set(key, run);
  notify(id);
  const result = await remoteEnv(runners, to.runner, folder(runner, to)).exec(command, {
    onOutput: (text, _context, info) => { run[info.stream] += text; notify(id); },
  }, context);
  const output = { code: result.ok ? result.value.exitCode : null, stdout: tail(run.stdout), stderr: tail(run.stderr), ...(result.ok ? {} : { error: result.error.message }) };
  const shown = [`exit ${output.code ?? output.error}`, output.stdout, output.stderr].filter(Boolean).join('\n');
  await write(id, { kind: 'agent-ide.shell', data: { author, to, command, ...output }, model: [userMessage(`${author} ran \`${command}\` on ${to.runner}:\n${shown}`)] }, `shell:${key}`);
  shells.delete(key);
  notify(id);
}

// Posting an entry is the one thing you do. Who answers: the entry's `to`; with none, the thread's last agent, or the director.
// `to: null` means nobody. `$ cmd` runs on the runner instead of asking its agent. `steer: true` joins the running answer.
// The key makes a post repeatable: posted again with the same key, it finds the first. An agent posts with `from`, its own
// thread, and an answer going back adds `re`.
async function postEntry(id, author, input, { key = randomUUID(), from = null, re = null } = {}) {
  const handle = await conversation(id);
  const agent = await agentOf(id);
  const body = field(input.body, 'body');
  const command = body.match(/^\$\s+([\s\S]+)/)?.[1];
  const given = 'to' in input ? await address(input.to) : director && !command ? null : agent;
  const asked = director && !command ? await inputs(id) : [];
  const to = director && !command ? await address(director.route({ body, to: given }, asked)) : given;
  if (command) {
    if (!to) throw new Error('Pick a runner to run the command on');
    shell(id, author, command, to, key).catch((error) => console.error(error));
    return { command, to };
  }
  if (!to) return write(id, { kind: 'agent-ide.chat', data: { author, body }, model: [userMessage(`${author}: ${body}`)] }, `chat:${key}`);
  // One conversation runs one agent at a time. The same agent queues a follow-up; another has to wait its turn.
  const live = await harness.snapshot(LiveDoc, id, context);
  const inbox = await harness.snapshot(InboxDoc, id, context);
  const busy = live?.run || inbox?.items?.length;
  if (busy && !same(agent, to)) throw Object.assign(new Error(`${agentName(agent)} is working in this thread; wait, stop it, or ask it instead`), { status: 409 });
  if (!busy) await handle.configure(await agentFor(to, id), context);
  const requestId = requestFor(author, to, { key, from, re });
  const whenBusy = input.steer ? 'steer' : 'followUp';
  const submission = await handle.submit({ type: 'input', content: `${heading({ author, from, re })}${body}`, requestId, whenBusy }, context);
  follow(id, requestId).catch((error) => console.error(error));
  return { requestId, submission: submission.id, to };
}

// A thread an agent starts is keyed by its tool call in the parent's `started`, so a replayed call finds the first one.
async function createThread(author, { title, parent = null }, key) {
  if (parent !== null) parent = Number(parent);
  if (parent !== null) await conversation(parent);
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

// The tools an agent uses to talk to other threads. They run on the server and post the way a human does, as the
// agent, with its own thread as `from`. A tool call's task id keys what it creates and posts, so a replay after a
// restart finds the thread and the post it made the first time.
function threadTools() {
  const post = defineTool({
    name: 'post',
    description: 'Post to another thread, or start a new child thread of this one by leaving out `thread`. '
      + 'Whoever answers, their answer comes to you here as a message, even mid-turn; don\'t read the thread to check for it.',
    parameters: Type.Object({
      thread: Type.Optional(Type.Number({ description: 'The thread to post to. Leave out to start a new one.' })),
      title: Type.Optional(Type.String({ description: 'The new thread\'s title' })),
      body: Type.String(),
      to: Type.Optional(Type.String({ description: 'Who should answer: an agent like model@runner or provider/model@runner, a runner for its default model, or "nobody". Leave out for the thread\'s agent; in a new thread, yourself.' })),
    }),
    replay: 'safe',
    execute: async (args, api) => {
      const from = api.conversationId;
      const me = await agentOf(from);
      const key = `call:${api.taskId}`;
      if (args.thread === from) throw new Error('That is your own thread; just answer');
      // A replayed call would run it twice, and its output would never reach you. You have bash.
      if (/^\$\s/.test(args.body)) throw new Error('Run commands with your own bash tool, not as a post');
      const id = args.thread ?? (await createThread(agentName(me), { title: args.title, parent: from }, key)).id;
      const to = args.to === undefined ? (args.thread === undefined ? { to: me } : {}) : { to: args.to === 'nobody' ? null : await named(args.to) };
      const posted = await postEntry(id, agentName(me), { body: args.body, ...to }, { key, from });
      const who = posted?.to ? agentName(posted.to) : 'nobody';
      return { content: [{ type: 'text', text: `Posted to thread ${id} for ${who}.${posted?.to ? ' Its answer will come to you here on its own; carry on, or end your turn.' : ''}` }], details: { thread: id } };
    },
  });
  const read = defineTool({
    name: 'read',
    description: 'Read a thread\'s latest entries, or list every thread by leaving out `thread`. Answers to your own posts come to you; no need to read for them.',
    parameters: Type.Object({
      thread: Type.Optional(Type.Number()),
      last: Type.Optional(Type.Number({ description: 'How many entries, 20 by default' })),
    }),
    replay: 'safe',
    execute: async (args, api) => {
      const me = agentName(await agentOf(api.conversationId));
      const lines = [];
      if (args.thread === undefined) {
        for (const row of await threadList(me)) {
          const parts = [`#${row.id} ${row.title}`, row.parent && `child of #${row.parent}`, row.agent && agentName(row.agent), row.status, row.id === api.conversationId && '(yours)'];
          lines.push(parts.filter(Boolean).join(', '));
        }
      } else {
        const entries = await annotate(args.thread, await history(await conversation(args.thread)));
        for (const { author, to, from, body, entry } of entries.filter((e) => e.entry.kind !== 'pi.system').slice(-(args.last ?? 20))) {
          const text = body ?? (messageText(entry.model?.[0]) || entry.data?.text || (entry.data?.command ? `$ ${entry.data.command}` : ''));
          const content = entry.model?.[0]?.content;
          const calls = Array.isArray(content) ? content.filter((p) => p.type === 'toolCall').map((p) => ` [${p.name} ${JSON.stringify(p.arguments)}]`).join('') : '';
          lines.push(`#${entry.id} ${author}${from ? ` from thread ${from}` : ''}${to ? ` to ${agentName(to)}` : ''}: ${text.slice(0, 2000)}${calls}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') || 'Nothing yet.' }] };
    },
  });
  return defineExtension({ name: 'agent-ide.threads', tools: [post, read] });
}

// An agent's name as a `to`: model@runner, provider/model@runner, or a runner for its default model.
async function named(name) {
  const at = name.lastIndexOf('@');
  const runner = name.slice(at + 1);
  const model = at < 0 ? '' : name.slice(0, at);
  if (!model || model.includes('/')) return address({ runner, model });
  const found = models.getProvider(`runner:${runner}`)?.getModels().find((m) => m.id.split('/').pop() === model);
  if (!found) throw new Error(`${runner} has no model ${model}; name it as provider/model@${runner}`);
  return address({ runner, model: found.id });
}

// A fork is a new thread that starts from one entry of another, with the agent it had then. Pi's conversation record
// keeps where it came from; it isn't a child, so nothing in it reports back. Pi starts it idle: no answer, no queue.
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

async function runnerList() {
  return Object.entries(await known()).map(([name, runner]) => ({ name, ...runner, online: runners.isOnline(name), calls: runners.working(name) }));
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
      return send(res, 200, { port, file, director: Boolean(director), threads: (await threadIds()).length, runners: Object.keys(await known()).length, work: await harness.inspect(context) });
    }
    if (req.method === 'GET' && route === '/api/runners') return send(res, 200, await runnerList());
    if (req.method === 'GET' && route === '/api/threads') return send(res, 200, await threadList(user(req)));
    if (req.method === 'POST' && route === '/api/threads') {
      send(res, 201, await createThread(user(req), await input(req)));
      return notify(null);
    }
    const match = /^\/api\/threads\/(\d+)(?:\/(entries|read|stop|fork))?$/.exec(route);
    if (match) {
      // A thread's id is its conversation's id, a number.
      const id = Number(match[1]);
      const action = match[2];
      if (!action && req.method === 'GET') return send(res, 200, await threadView(id, user(req)));
      // Pi Durable keeps everything, so deleting only hides the thread.
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
      // Reading a thread marks its newest entry, so its last result stops counting as done for you.
      if (action === 'read' && req.method === 'POST') {
        const newest = (await (await conversation(id)).entries({}, 1, undefined, context)).items[0]?.id;
        if (newest && (await thread(id)).reads[user(req)] !== newest) await commit(async (tx) => { (await tx.doc(Thread, id)).reads[user(req)] = newest; });
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

// Browsers connect to /ws. A runner connects to /ws?runner=NAME&alias=…&dir=…&model=… and is online while connected.
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
  // A runner that reconnects under its name replaces its old socket; what the old one had is lost.
  if (sockets.has(name)) {
    sockets.get(name).destroy();
    runners.disconnect(name);
  }
  sockets.set(name, socket);
  const runner = {
    alias: url.searchParams.get('alias') || '', owner: url.searchParams.get('owner') || 'anon', host: url.searchParams.get('host') || '',
    dir: url.searchParams.get('dir') || '/',
    model: url.searchParams.get('model') || '', lastSeen: new Date().toISOString(),
  };
  await commit(async (tx) => { (await tx.doc(Runners))[name] = runner; });
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
