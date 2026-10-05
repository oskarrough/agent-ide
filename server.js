import http from 'node:http';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.env.PORT || 3000);
const db = new DatabaseSync(process.env.DB_PATH || `threads-${port}.db`);
// Hold the file for good: a second server on it fails with "database is locked".
db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bots (name TEXT PRIMARY KEY, owner TEXT NOT NULL, runner TEXT NOT NULL, cli TEXT NOT NULL, model TEXT, dir TEXT NOT NULL, soul TEXT NOT NULL, created_at TEXT NOT NULL);
`);
// Older files call the cli column harness.
for (const table of ['threads', 'events', 'bots']) try { db.exec(`ALTER TABLE ${table} RENAME COLUMN harness TO cli`); } catch {}
for (const [table, column] of [['threads', 'parent TEXT'], ['threads', 'runner TEXT'], ['threads', 'cli TEXT'], ['threads', 'model TEXT'], ['threads', 'dir TEXT'], ['events', "author TEXT NOT NULL DEFAULT 'anon'"], ['events', "kind TEXT NOT NULL DEFAULT 'human'"], ['events', 'runner TEXT'], ['events', "type TEXT NOT NULL DEFAULT 'chat'"], ['events', 'cli TEXT'], ['events', 'dir TEXT'], ['events', 'steps TEXT']]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`); } catch {}
}

// A thread with a runner is a job: pinned to that runner, cli and folder. Other threads live nowhere.
const threads = db.prepare('SELECT id, title, parent, runner, cli, model, dir, created_at AS createdAt FROM threads ORDER BY created_at DESC');
const thread = db.prepare('SELECT id, parent, runner, cli, model, dir FROM threads WHERE id = ?');
const events = db.prepare('SELECT id, thread_id AS threadId, author, kind, type, runner, cli, dir, steps, body, created_at AS createdAt FROM events WHERE thread_id = ? ORDER BY created_at, rowid');
const addThread = db.prepare('INSERT INTO threads (id, title, parent, runner, cli, model, dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const addEvent = db.prepare('INSERT INTO events (id, thread_id, body, created_at, author, kind, type, runner, cli, dir, steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
// A bot is a name, a soul, and the runner, cli and folder its replies come from.
const bots = db.prepare('SELECT name, owner, runner, cli, model, dir, soul FROM bots ORDER BY name');
const bot = db.prepare('SELECT name, owner, runner, cli, model, dir, soul FROM bots WHERE name = ?');
const saveBot = db.prepare('INSERT OR REPLACE INTO bots (name, owner, runner, cli, model, dir, soul, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const deleteBot = db.prepare('DELETE FROM bots WHERE name = ?');
const clients = new Set();
// Runners are known while the server runs; online means their socket is open.
const runners = new Map();
// Work handed to a runner, waiting for its answer.
const jobs = new Map();
const page = await readFile(new URL('./client.html', import.meta.url));

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
  return JSON.parse(body);
}

// Fake identity: whoever the x-user header says you are.
const user = (req) => req.headers['x-user'] || 'anon';

function field(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
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

function notify(threadId) {
  const data = frame({ threadId });
  for (const socket of clients) socket.write(data);
}

// Steps are the tool calls a reply made on the way, kept with it.
function append(threadId, { author, kind = 'bot', type = 'chat', runner = null, cli = null, dir = null, steps = null, body }) {
  if (!thread.get(threadId)) throw new Error('Thread not found');
  const item = { id: randomUUID(), threadId, author, kind, type, runner, cli, dir, steps, body, createdAt: new Date().toISOString() };
  addEvent.run(item.id, threadId, item.body, item.createdAt, item.author, item.kind, item.type, item.runner, item.cli, item.dir, steps && JSON.stringify(steps));
  notify(threadId);
  return item;
}

// Hands a job to a runner and answers with the entry it produced.
// An offline runner fails fast in a plain thread; in a job the work waits for it.
async function act(req, res, job) {
  const row = thread.get(job.threadId);
  if (!row) return send(res, 404, { error: 'Thread not found' });
  const runner = runners.get(job.runner);
  const caller = user(req);
  // Only the owner, or someone the owner allowed, may send work to a runner. Checked here, not on the runner.
  if (runner && caller !== runner.owner && !runner.allowed.has(caller)) {
    const entry = append(job.threadId, { author: 'server', type: 'system', runner: job.runner, body: `${caller} may not use ${runner.owner}'s runner ${job.runner} (${job.kind} as ${job.author}); ${runner.owner} has not allowed it` });
    return send(res, 403, { error: entry.body, entry });
  }
  job.id = randomUUID();
  if (runner && !runner.socket && row.runner) {
    jobs.set(job.id, { ...job, caller, queued: true, resolve: () => {} });
    const entry = append(job.threadId, { author: 'server', type: 'system', runner: job.runner, body: `${job.author}'s ${job.kind} is waiting for ${job.runner}, which is offline; it starts when ${job.runner} is back` });
    notify(null);
    return send(res, 202, { queued: job.id, entry });
  }
  if (!runner?.socket) {
    const entry = append(job.threadId, { author: 'server', type: 'system', runner: job.runner, body: `${job.author} could not ${job.kind}: runner ${job.runner} is ${runner ? 'offline' : 'unknown'}` });
    return send(res, 409, { error: entry.body, entry });
  }
  const entry = await new Promise((resolve) => {
    jobs.set(job.id, { ...job, caller, resolve });
    runner.socket.write(frame({ job }));
    notify(null);
  });
  send(res, entry.type === 'system' ? 502 : 200, entry);
}

// A runner that drops leaves a note in every thread it was working in.
function strand(name) {
  for (const job of jobs.values()) {
    if (job.runner !== name || job.stranded || job.queued) continue;
    job.stranded = true;
    job.resolve(append(job.threadId, { author: 'server', type: 'system', runner: name, body: `runner ${name} went offline during ${job.author}'s ${job.kind}; nothing came back yet` }));
  }
}

// Who is busy in a thread right now, for the sidebar and the thread header.
function working(threadId) {
  return [...jobs.values()].filter((job) => job.threadId === threadId && !job.stranded && !job.queued).map((job) => job.author);
}

// What a working bot has said and run so far, for anyone who opens the thread mid-reply.
function live(threadId) {
  return [...jobs.values()].filter((job) => job.threadId === threadId && job.live).map(({ id, author, live }) => ({ jobId: id, author, ...live }));
}

function waiting(threadId) {
  return [...jobs.values()].filter((job) => job.threadId === threadId && job.queued).map(({ id, author, kind, runner }) => ({ id, author, kind, runner }));
}

// A job thread reports each finished reply to its parent, so the result doesn't depend on whoever asked still being around.
function report(job, entry) {
  const row = thread.get(job.threadId);
  if (job.kind !== 'reply' || !row?.runner || !row.parent) return;
  const line = entry.body.split('\n').find(Boolean)?.slice(0, 160) || '(empty reply)';
  append(row.parent, { author: job.author, runner: job.runner, body: `${entry.type === 'system' ? 'Failed' : 'Done'}: ${line} → thread:${job.threadId}` });
}

// Empty fields don't override: a reply's own fields win, then the job's, then the bot's.
function defined(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, v]) => v != null && v !== ''));
}

function runnerList() {
  return [...runners.values()].map(({ socket, allowed, ...runner }) => ({ ...runner, allowed: [...allowed], online: Boolean(socket) }));
}

const handleRequest = async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-user' });
    return res.end();
  }
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  try {
    if (req.method === 'GET' && path === '/api/runners') return send(res, 200, runnerList());
    const allow = /^\/api\/runners\/([\w.-]+)\/allow$/.exec(path);
    if (allow && req.method === 'POST') {
      const runner = runners.get(allow[1]);
      if (!runner) return send(res, 404, { error: 'Runner not found' });
      if (user(req) !== runner.owner) return send(res, 403, { error: `Only ${runner.owner} can lend ${runner.name}` });
      const { user: guest, allowed = true } = await input(req);
      if (allowed) runner.allowed.add(field(guest, 'user')); else runner.allowed.delete(guest);
      send(res, 200, { name: runner.name, owner: runner.owner, allowed: [...runner.allowed] });
      return notify(null);
    }
    if (req.method === 'GET' && path === '/api/bots') return send(res, 200, bots.all());
    if (req.method === 'POST' && path === '/api/bots') {
      const { name, runner, cli = 'echo', model = null, dir = '.', soul = '' } = await input(req);
      if (!/^[\w-]+$/.test(field(name, 'name'))) throw new Error('A bot name may use letters, digits, _ and -');
      const existing = bot.get(name);
      if (existing && existing.owner !== user(req)) return send(res, 403, { error: `@${name} belongs to ${existing.owner}` });
      saveBot.run(name, user(req), field(runner, 'runner'), cli || 'echo', model || null, dir || '.', soul || '', new Date().toISOString());
      send(res, 201, bot.get(name));
      return notify(null);
    }
    const removeBot = /^\/api\/bots\/([\w-]+)$/.exec(path);
    if (removeBot && req.method === 'DELETE') {
      const existing = bot.get(removeBot[1]);
      if (!existing) return send(res, 404, { error: 'Bot not found' });
      if (existing.owner !== user(req)) return send(res, 403, { error: `@${existing.name} belongs to ${existing.owner}` });
      deleteBot.run(existing.name);
      send(res, 200, { name: existing.name });
      return notify(null);
    }
    if (req.method === 'GET' && path === '/api/threads') return send(res, 200, threads.all().map((t) => ({ ...t, working: working(t.id), waiting: waiting(t.id), live: live(t.id) })));
    if (req.method === 'POST' && path === '/api/threads') {
      // Passing a runner makes the thread a job, pinned to that runner, cli and folder.
      const { title, parent = null, runner = null, cli = null, model = null, dir = null } = await input(req);
      if (parent && !thread.get(parent)) return send(res, 404, { error: 'Parent thread not found' });
      const item = { id: randomUUID(), title: field(title, 'title'), parent, runner: runner || null, cli: runner ? cli || 'echo' : null, model: runner ? model || null : null, dir: runner ? dir || '.' : null, createdAt: new Date().toISOString() };
      addThread.run(item.id, item.title, item.parent, item.runner, item.cli, item.model, item.dir, item.createdAt);
      send(res, 201, item);
      return notify(null);
    }
    const removeThread = /^\/api\/threads\/([\w-]+)$/.exec(path);
    if (removeThread && req.method === 'DELETE') {
      const id = removeThread[1];
      if (!thread.get(id)) return send(res, 404, { error: 'Thread not found' });
      if ([...jobs.values()].some((job) => job.threadId === id)) return send(res, 409, { error: 'This thread has unfinished jobs; wait for their results before deleting it' });
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE threads SET parent = NULL WHERE parent = ?').run(id);
        db.prepare('DELETE FROM events WHERE thread_id = ?').run(id);
        db.prepare('DELETE FROM threads WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      send(res, 200, { id });
      return notify(null);
    }
    // A runner streams a reply in progress. It lives in memory only; the finished reply is what's kept.
    const progress = /^\/api\/jobs\/([\w-]+)\/progress$/.exec(path);
    if (progress && req.method === 'POST') {
      const job = jobs.get(progress[1]);
      if (!job || job.queued) return send(res, 404, { error: 'Job not found' });
      const { text = '', steps = [] } = await input(req);
      job.live = { text, steps };
      send(res, 200, { ok: true });
      const data = frame({ threadId: job.threadId, live: { jobId: job.id, author: job.author, ...job.live } });
      for (const socket of clients) socket.write(data);
      return;
    }
    const result = /^\/api\/jobs\/([\w-]+)$/.exec(path);
    if (result && req.method === 'POST') {
      const job = jobs.get(result[1]);
      // A job whose runner dropped mid-way is kept, so a late answer still lands in the thread.
      if (!job || job.queued) return send(res, 404, { error: 'Job not found' });
      jobs.delete(job.id);
      const { body, error, steps, ...output } = await input(req);
      const late = job.stranded ? ' (arrived after its runner reconnected)' : '';
      const entry = append(job.threadId, error
        ? { author: 'server', type: 'system', runner: job.runner, body: `${job.author} could not ${job.kind} via ${job.runner}: ${error}` }
        : job.kind === 'exec'
          ? { author: job.author, kind: 'human', type: 'exec', runner: job.runner, dir: job.dir, body: JSON.stringify({ command: job.command, dir: job.dir, ...output }) }
          : { author: job.author, runner: job.runner, cli: job.cli, dir: job.dir, steps, body: (body || '(empty reply)') + late });
      job.resolve(entry);
      report(job, entry);
      send(res, 200, entry);
      return notify(null);
    }
    // Only work that is still waiting can be cancelled, by whoever asked for it or the runner's owner.
    if (result && req.method === 'DELETE') {
      const job = jobs.get(result[1]);
      if (!job?.queued) return send(res, 404, { error: 'No waiting job with that id' });
      if (![job.caller, runners.get(job.runner)?.owner].includes(user(req))) return send(res, 403, { error: `Only ${job.caller} or the runner's owner can cancel this` });
      jobs.delete(job.id);
      const entry = append(job.threadId, { author: 'server', type: 'system', runner: job.runner, body: `${user(req)} cancelled ${job.author}'s waiting ${job.kind}` });
      send(res, 200, entry);
      return notify(null);
    }
    const reply = /^\/api\/threads\/([\w-]+)\/reply$/.exec(path);
    if (reply && req.method === 'POST') {
      const threadId = reply[1];
      const row = thread.get(threadId);
      if (!row) return send(res, 404, { error: 'Thread not found' });
      const { bot: name, ...options } = await input(req);
      const saved = bot.get(field(name, 'bot'));
      const { runner, cli = 'echo', model = null, dir = '.', soul = '' } = { ...defined(saved), ...defined(row), ...defined(options) };
      if (!runner) throw new Error(`@${name} has no runner: register the bot, or pass one`);
      return act(req, res, { kind: 'reply', threadId, author: name, bot: name, runner, cli, model, dir, soul });
    }
    const exec = /^\/api\/threads\/([\w-]+)\/exec$/.exec(path);
    if (exec && req.method === 'POST') {
      const threadId = exec[1];
      const row = thread.get(threadId);
      if (!row) return send(res, 404, { error: 'Thread not found' });
      // A command runs where a job is pinned. A plain thread runs nowhere, so it has nowhere to run one.
      if (!row.runner) return send(res, 409, { error: 'Commands run only in a job, on its runner and folder. This thread is not a job; start one from it and run the command there.' });
      const { command } = await input(req);
      return act(req, res, { kind: 'exec', threadId, author: user(req), runner: row.runner, command: field(command, 'command'), dir: row.dir });
    }
    const match = /^\/api\/threads\/([\w-]+)\/events$/.exec(path);
    if (match) {
      const id = match[1];
      if (!thread.get(id)) return send(res, 404, { error: 'Thread not found' });
      if (req.method === 'GET') return send(res, 200, events.all(id).map((event) => ({ ...event, steps: event.steps ? JSON.parse(event.steps) : null })));
      if (req.method === 'POST') {
        const { body, author = 'anon', kind = 'human' } = await input(req);
        if (!['human', 'bot'].includes(kind)) throw new Error('kind must be human or bot');
        return send(res, 201, append(id, { author: field(author, 'author'), kind, body: field(body, 'body') }));
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
};

// Browsers connect to /ws. A runner connects to /ws?runner=NAME&alias=…&clis=a,b and is online while connected. The alias is display only; the name is the key.
function upgrade(req, socket) {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) return socket.destroy();
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const name = url.searchParams.get('runner');
  if (name) {
    runners.get(name)?.socket?.destroy();
    const clis = (url.searchParams.get('clis') || '').split(',').filter(Boolean);
    const owner = url.searchParams.get('owner') || 'anon';
    const previous = runners.get(name);
    const allowed = previous?.owner === owner ? previous.allowed : new Set();
    runners.set(name, { name, alias: url.searchParams.get('alias') || '', owner, host: url.searchParams.get('host') || '', clis, allowed, lastSeen: new Date().toISOString(), socket });
    console.log(`runner ${name} online: ${clis.join(', ')}`);
    // Work that waited for this runner starts now.
    for (const job of jobs.values()) {
      if (!job.queued || job.runner !== name) continue;
      job.queued = false;
      socket.write(frame({ job }));
    }
    notify(null);
  }
  clients.add(socket);
  const close = () => {
    clients.delete(socket);
    const runner = name && runners.get(name);
    if (runner?.socket !== socket) return;
    runners.set(name, { ...runner, socket: null, lastSeen: new Date().toISOString() });
    console.log(`runner ${name} offline`);
    strand(name);
    notify(null);
  };
  socket.on('data', () => socket.end());
  socket.on('end', () => socket.end());
  socket.on('close', close);
  socket.on('error', close);
}

function urls(host) {
  if (host !== '0.0.0.0') return [host === '::1' ? '[::1]' : host];
  return Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4').map((a) => a.address);
}

for (const host of process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1']) {
  const server = http.createServer(handleRequest);
  server.on('upgrade', upgrade);
  server.on('error', (error) => {
    if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) return;
    console.error(error);
    process.exit(1);
  });
  server.listen(port, host, () => { for (const address of urls(host)) console.log(`http://${address}:${port}`); });
}
