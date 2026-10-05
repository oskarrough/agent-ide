// Replies through pi-durable: one durable conversation per thread, kept on this runner, signed in with pi's own logins.
// The server still owns the thread. This conversation is the bot's working memory of it, and survives a runner crash.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { AssistantEntry, createRegistry, defineDoc, Harness } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';

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

// Which conversation holds each thread, how far into the thread it has read, and replies still owed to the server.
const Runner = defineDoc({
  kind: 'agent-ide.runner',
  version: 1,
  scope: 'session',
  initial: () => ({ threads: {}, seen: {}, pending: {} }),
});

// "anthropic/claude-sonnet-5-5", or a bare model id on pi's default provider.
function modelOf(model) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(piDir, 'settings.json'), 'utf8')); } catch {}
  const [provider, modelId] = model?.includes('/') ? model.split(/\/(.*)/s) : [settings.defaultProvider, model || settings.defaultModel];
  if (!provider || !modelId) throw new Error('No model: pass provider/model, or set a default in pi');
  return { provider, modelId };
}

function text(entry) {
  return (entry?.model ?? []).flatMap((message) => message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('').trim();
}

const tail = (value) => value?.slice(-2000);
const brief = (args) => (typeof args?.command === 'string' ? args.command : JSON.stringify(args ?? {})).slice(0, 300);

// Every tool call since the input, from the transcript, which keeps them; the live doc only adds output still running.
function stepsOf(entries, input, live) {
  const start = entries.findIndex((entry) => entry.id === input);
  if (start < 0) return [];
  const steps = new Map();
  for (const entry of entries.slice(start + 1)) {
    for (const message of entry.model ?? []) {
      if (message.role === 'assistant') {
        for (const part of message.content ?? []) if (part.type === 'toolCall') steps.set(part.id, { name: part.name, args: brief(part.arguments), status: 'running' });
      } else if (message.role === 'toolResult' && steps.has(message.toolCallId)) {
        Object.assign(steps.get(message.toolCallId), { status: message.isError ? 'error' : 'done', output: tail(text({ model: [message] })) });
      }
    }
  }
  for (const slot of live?.tools ?? []) {
    const step = steps.get(slot.callId);
    if (step?.status === 'running') step.output = tail(slot.output);
  }
  return [...steps.values()];
}

export async function openDurable({ file, deliver, progress }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const registry = createRegistry();
  registry.install(CodingTools);
  const harness = await Harness.open(await openNodeSqliteStorage(file), {
    models: builtinModels({ credentials }),
    registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? os.homedir() }),
  }, context);
  const root = await harness.root(context);
  const state = () => harness.snapshot(Runner, context).then((value) => value ?? Runner.definition.initial());
  const update = (change) => root.commit(async (tx) => change(await tx.doc(Runner)), context);

  async function conversationFor(threadId) {
    const id = (await state()).threads[threadId];
    const existing = id && await harness.conversation(id, context);
    if (existing) return existing;
    const created = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    await update((doc) => { doc.threads[threadId] = created.id; });
    return created;
  }

  // Waits for the answer, then forgets the job: a crash before this point means the answer is still owed.
  // Progress goes out while it waits, at most every 300 ms, and always the latest.
  async function settle(jobId, submissionId) {
    const submission = await harness.submission(submissionId, context);
    const conversation = await harness.conversation((await submission.status(context)).conversationId, context);
    const view = await conversation.viewState(context);
    let input;
    let timer;
    const unsubscribe = view.subscribe(() => {
      timer ??= setTimeout(async () => {
        input ??= (await submission.status(context)).entry;
        timer = undefined;
        const live = view.value.docs['pi.live'];
        const message = live?.generation?.message;
        progress(jobId, { text: text({ model: message ? [message] : [] }), steps: stepsOf(view.value.entries, input, live) });
      }, 300);
    });
    const settled = await submission.wait(context).finally(() => {
      clearTimeout(timer);
      unsubscribe();
    });
    const steps = stepsOf(view.value.entries, settled.entry);
    view.dispose();
    await update((doc) => { delete doc.pending[jobId]; });
    if (settled.status !== 'done') throw new Error(`pi-durable gave no answer: ${settled.reason ?? 'unknown'}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ''}`);
    const body = text(await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context));
    return { body, steps };
  }

  // Answers owed from before a crash are finished and delivered as late replies.
  harness.resume();
  for (const [jobId, submissionId] of Object.entries((await state()).pending)) {
    settle(jobId, submissionId).then((reply) => deliver(jobId, reply), (error) => deliver(jobId, { error: error.message }));
  }

  return {
    // The conversation only sees what it hasn't seen yet, so a long thread costs nothing extra per reply.
    async reply(job, messages, cwd) {
      const conversation = await conversationFor(job.threadId);
      await conversation.configure({
        model: modelOf(job.model),
        cwd,
        instructions: `You are ${job.bot} in a group chat with humans and other bots. Each user message holds the new chat lines as "author: text". Reply as ${job.bot}, with only your message.${job.soul ? `\n\n${job.soul}` : ''}`,
      }, context);
      const seen = (await state()).seen[job.threadId];
      const unseen = messages.slice(messages.findIndex((message) => message.id === seen) + 1)
        .filter((message) => message.type !== 'system' && !(message.kind === 'bot' && message.author === job.bot));
      const content = unseen.map((message) => `${message.author}: ${message.body}`).join('\n') || '(nothing new; reply again)';
      const submission = await conversation.submit({ type: 'input', content, requestId: job.id }, context);
      await update((doc) => {
        doc.pending[job.id] = submission.id;
        if (messages.length) doc.seen[job.threadId] = messages.at(-1).id;
      });
      return settle(job.id, submission.id);
    },
  };
}
