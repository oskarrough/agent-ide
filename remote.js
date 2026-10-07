// The runner protocol, both ends. Over a runner's WebSocket the server asks for two things:
// model streams, which the runner answers with its own logins, and file and shell calls in its folder.
// Server: { id, op: 'stream' | 'env' | 'handle' | 'cancel', … }. Runner: { id, event } | { id, output } | { id, result } | { id, error }.
import path from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import { ExecutionError, FileError } from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

// Bytes and errors don't survive JSON on their own.
function encode(value) {
  return JSON.stringify(value, (key, v) => {
    if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('base64') };
    if (v instanceof FileError || v instanceof ExecutionError) return { $error: v.constructor.name, code: v.code, message: v.message, path: v.path, spillPath: v.spillPath };
    return v;
  });
}
function decode(text) {
  return JSON.parse(text, (key, v) => {
    if (v?.$bytes !== undefined) return new Uint8Array(Buffer.from(v.$bytes, 'base64'));
    if (v?.$error === 'FileError') return new FileError(v.code, v.message, v.path);
    if (v?.$error === 'ExecutionError') return Object.assign(new ExecutionError(v.code, v.message), v.spillPath ? { spillPath: v.spillPath } : {});
    return v;
  });
}

const READERS = {
  openTextLineReader: ['readLine', 'close'],
  openBinaryReader: ['info', 'read', 'scanLines', 'close'],
  openDirReader: ['next', 'close'],
};
const FS = ['absolutePath', 'joinPath', 'readTextFile', 'readTextLines', 'readBinaryFile', 'writeFile', 'appendFile', 'truncateFile', 'flushFile',
  'renameFile', 'fileInfo', 'listDir', 'canonicalPath', 'exists', 'createDir', 'remove', 'createTempDir', 'createTempFile', ...Object.keys(READERS)];

// ── Server end ──

// What the server knows of a runner: its socket while online, and the calls it hasn't answered.
export function createRunners({ onChange }) {
  const sockets = new Map();
  const waiting = new Map();
  const calls = new Map();
  let next = 0;

  function online(name, signal) {
    if (sockets.has(name)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const list = waiting.get(name) ?? [];
      waiting.set(name, [...list, resolve]);
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
  }

  // One request to a runner. It waits while the runner is offline; a runner that drops mid-call fails the call.
  async function call(name, message, { signal, onMessage }) {
    signal?.throwIfAborted();
    await online(name, signal);
    const id = ++next;
    return new Promise((resolve, reject) => {
      const done = (fn) => (value) => { calls.delete(id); signal?.removeEventListener('abort', cancel); onChange(); fn(value); };
      const cancel = () => sockets.get(name)?.send({ id, op: 'cancel' });
      calls.set(id, { runner: name, op: message.op, what: message.model ?? message.method, onMessage, resolve: done(resolve), reject: done(reject) });
      signal?.addEventListener('abort', cancel, { once: true });
      sockets.get(name).send({ id, ...message });
      onChange();
    });
  }

  return {
    online,
    call,
    isOnline: (name) => sockets.has(name),
    working: (name) => [...calls.values()].filter((c) => c.runner === name).map(({ op, what }) => ({ op, what })),
    connect(name, send) {
      sockets.set(name, { send: (value) => send(encode(value)) });
      for (const resolve of waiting.get(name) ?? []) resolve();
      waiting.delete(name);
    },
    receive(text) {
      const message = decode(text);
      const pending = calls.get(message.id);
      if (!pending) return;
      if ('result' in message) pending.resolve(message.result);
      else if ('error' in message) pending.reject(new Error(message.error));
      else pending.onMessage?.(message);
    },
    disconnect(name) {
      sockets.delete(name);
      for (const pending of [...calls.values()]) if (pending.runner === name) pending.reject(new Error(`runner ${name}: connection lost`));
    },
  };
}

// The chat models a runner can stream: pi's built-in catalog, as `provider/model` under the runner's provider, and echo.
const ECHO = { id: 'echo', name: 'echo', api: 'faux', provider: 'echo', baseUrl: '', input: ['text'], reasoning: false, contextWindow: 200000, maxTokens: 10000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const catalog = [...getBuiltinProviders().flatMap((p) => getBuiltinModels(p)), ECHO];

function failure(model, partial, message, aborted) {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...partial, stopReason: aborted ? 'aborted' : 'error', errorMessage: message,
  };
}

// A pi-ai Provider whose streams run on the runner. The server holds no login: the runner signs each request with its own.
export function runnerProvider(runners, name) {
  const id = `runner:${name}`;
  const models = catalog.map((m) => ({ ...m, provider: id, id: `${m.provider}/${m.id}`, name: `${m.name} on ${name}` }));
  const stream = (model, context, options = {}) => {
    const events = createAssistantMessageEventStream();
    const { signal, apiKey, env, fetch, onPayload, onResponse, onProviderStreamEvent, ...rest } = options;
    let partial;
    runners.call(name, { op: 'stream', model: model.id, context: { messages: context.messages }, options: rest }, {
      signal,
      // The runner sends the growing message only now and then; deltas in between reuse the last one.
      onMessage: ({ event }) => {
        if (event.partial) partial = event.partial;
        else if (!['done', 'error'].includes(event.type)) event.partial = partial;
        events.push(event);
      },
    }).catch((error) => events.push({ type: 'error', reason: signal?.aborted ? 'aborted' : 'error', error: failure(model, partial, error.message, signal?.aborted) }))
      .finally(() => events.end());
    return events;
  };
  return {
    id,
    name: `runner ${name}`,
    auth: { apiKey: { name: `login on ${name}`, resolve: async () => ({ auth: {}, source: `runner ${name}` }) } },
    getModels: () => models,
    stream,
    streamSimple: stream,
  };
}

// An ExecutionEnv whose files and commands are on the runner, in its folder.
export function remoteEnv(runners, name, cwd) {
  const env = { id: `runner:${name}`, cwd };
  const request = (message, context, onMessage) =>
    runners.call(name, message, { signal: context?.abortSignal, onMessage }).catch((error) => ({ ok: false, error: new FileError('unknown', error.message) }));
  const reader = (handle, methods) => Object.fromEntries(methods.map((method) => [method, (...args) => {
    const context = args.pop();
    return request({ op: 'handle', handle, method, args }, context);
  }]));
  for (const method of FS) {
    env[method] = async (...args) => {
      const context = args.pop();
      const result = await request({ op: 'env', cwd, method, args }, context);
      return result.ok && READERS[method] ? { ok: true, value: reader(result.value.handle, READERS[method]) } : result;
    };
  }
  env.exec = async (command, options = {}, context) => {
    const { onOutput, ...rest } = options;
    return runners.call(name, { op: 'env', cwd, method: 'exec', args: [command, rest] }, {
      signal: context?.abortSignal,
      onMessage: ({ output }) => onOutput?.(output.text, context, output.info),
    }).catch((error) => ({ ok: false, error: new ExecutionError(context?.abortSignal?.aborted ? 'aborted' : 'unknown', error.message) }));
  };
  env.watch = async () => ({ ok: false, error: new FileError('not_supported', 'Watching is not supported on a runner') });
  env.cleanup = async () => {};
  return env;
}

// ── Runner end ──

// Answers the server's requests: model streams with this machine's logins, and file and shell calls confined to `dir`.
export function serveRunner({ name, dir, models, echo, send }) {
  const running = new Map();
  const handles = new Map();
  let nextHandle = 0;
  const reply = (value) => send(encode(value));

  function inside(p, cwd = dir) {
    const full = path.resolve(cwd, p ?? '.');
    if (full !== dir && !full.startsWith(dir + path.sep)) throw new FileError('permission_denied', `${p} is outside ${name}'s folder ${dir}`, p);
    return full;
  }

  async function stream({ id, model: ref, context, options }, signal) {
    const [provider, ...rest] = ref.split('/');
    let model = models.getModel(provider, rest.join('/'));
    if (provider === 'echo') {
      // pi-ai's faux provider, told what to say for this one request.
      echo.appendResponses([(ctx) => fauxAssistantMessage(`echo@${name} heard: ${lastUserText(ctx.messages)}`)]);
      model = echo.getModel();
    }
    if (!model) throw new Error(`${name} has no model ${ref}`);
    let sentAt = 0;
    for await (const event of models.streamSimple(model, context, { ...options, signal })) {
      const due = ['start', 'done', 'error'].includes(event.type) || event.type.endsWith('_end') || Date.now() - sentAt > 100;
      const { partial, ...slim } = event;
      if (due && partial) sentAt = Date.now();
      reply({ id, event: due ? event : slim });
    }
  }

  async function env({ id, cwd, method, args }, context) {
    const root = inside(cwd);
    const local = new NodeExecutionEnv({ cwd: root });
    if (method === 'exec') {
      const [command, options = {}] = args;
      return local.exec(command, { ...options, cwd: inside(options.cwd, root), onOutput: (text, _context, info) => reply({ id, output: { text, info } }) }, context);
    }
    if (method === 'createTempDir' || method === 'createTempFile') throw new FileError('permission_denied', `Temporary files are outside ${name}'s folder`);
    if (method !== 'joinPath') args[0] = inside(args[0], root);
    if (method === 'renameFile') args[1] = inside(args[1], root);
    const result = await local[method](...args, context);
    if (result.ok && READERS[method]) {
      handles.set(++nextHandle, result.value);
      return { ok: true, value: { handle: nextHandle } };
    }
    return result;
  }

  async function handle({ handle: key, method, args }, context) {
    const target = handles.get(key);
    if (!target) return { ok: false, error: new FileError('invalid', 'That reader is closed') };
    if (method === 'close') handles.delete(key);
    return target[method](...args, context);
  }

  return {
    receive(text) {
      const message = decode(text);
      if (message.op === 'cancel') return running.get(message.id)?.cancel(new Error('cancelled by the server'));
      const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
      running.set(message.id, { cancel });
      const work = message.op === 'stream' ? stream(message, context.abortSignal)
        : message.op === 'env' ? env(message, context)
          : handle(message, context);
      work.then((result) => reply({ id: message.id, result: result ?? null }), (error) => {
        if (error instanceof FileError) reply({ id: message.id, result: { ok: false, error } });
        else reply({ id: message.id, error: error.message });
      }).finally(() => running.delete(message.id));
    },
    // The server is gone: whatever it asked for is nobody's anymore.
    stopAll() {
      for (const { cancel } of running.values()) cancel(new Error('server disconnected'));
      running.clear();
      handles.clear();
    },
    busy: () => running.size,
  };
}

function lastUserText(messages) {
  const content = messages.findLast((m) => m.role === 'user')?.content;
  return typeof content === 'string' ? content : (content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('');
}
