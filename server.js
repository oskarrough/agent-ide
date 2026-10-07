// Keeps threads and their entries, knows which runners are online, and hands each addressed entry to its runner.
// PORT=3000 DB_PATH=threads-3000.db [DIRECTOR=1] bun server.js
import http from 'node:http';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.env.PORT || 3000);
const db = new DatabaseSync(process.env.DB_PATH || `threads-${port}.db`);
// Hold the file for good: a second server on it fails with "database is locked".
db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');

// Older files say events, and an entry's kind and type, where we now say entries, role and kind; bots are now agents.
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
if (columns('events').length && !columns('entries').length) db.exec('ALTER TABLE events RENAME TO entries');
if (columns('entries').includes('type')) db.exec(`
  ALTER TABLE entries RENAME COLUMN kind TO role;
  ALTER TABLE entries RENAME COLUMN type TO kind;
  UPDATE entries SET kind = 'note' WHERE kind = 'system';
  UPDATE entries SET role = 'server' WHERE author = 'server';
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reads (thread_id TEXT NOT NULL, reader TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (thread_id, reader));
`);
for (const [table, column] of [['threads', 'parent TEXT'], ['entries', "author TEXT NOT NULL DEFAULT 'anon'"], ['entries', "role TEXT NOT NULL DEFAULT 'human'"], ['entries', "kind TEXT NOT NULL DEFAULT 'chat'"], ['entries', 'address TEXT'], ['entries', 'reply_to TEXT'], ['entries', 'steps TEXT']]) {
  if (!columns(table).includes(column.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
}
db.exec("UPDATE entries SET role = 'agent' WHERE role = 'bot'; CREATE INDEX IF NOT EXISTS entries_reply_to ON entries (reply_to)");
// Pinned threads, per-entry runners and bots are gone; so is what they stored.
for (const [table, stale] of [['threads', ['runner', 'harness', 'cli', 'model', 'dir']], ['entries', ['runner', 'harness', 'cli', 'dir', 'run']]]) {
  for (const column of stale) if (columns(table).includes(column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
db.exec('DROP TABLE IF EXISTS bots');

const threads = db.prepare('SELECT id, title, parent, created_at AS createdAt FROM threads ORDER BY created_at DESC');
const thread = db.prepare('SELECT id, title, parent FROM threads WHERE id = ?');
const addThread = db.prepare('INSERT INTO threads (id, title, parent, created_at) VALUES (?, ?, ?, ?)');
const ENTRY = 'id, thread_id AS threadId, author, role, kind, address, reply_to AS replyTo, steps, body, created_at AS createdAt';
const entries = db.prepare(`SELECT ${ENTRY} FROM entries WHERE thread_id = ? ORDER BY created_at, rowid`);
const entry = db.prepare(`SELECT ${ENTRY} FROM entries WHERE id = ?`);
const addEntry = db.prepare('INSERT INTO entries (id, thread_id, author, role, kind, address, reply_to, steps, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
// Addressed entries nobody has answered yet: the work still owed, in a thread or to a runner.
const unanswered = db.prepare(`SELECT ${ENTRY} FROM entries e WHERE address IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entries a WHERE a.reply_to = e.id) ORDER BY created_at, rowid`);
// The newest result in a thread: an agent's entry, or an error.
const lastResult = db.prepare("SELECT kind, created_at AS createdAt FROM entries WHERE thread_id = ? AND (role = 'agent' OR kind = 'error') ORDER BY created_at DESC, rowid DESC LIMIT 1");
const readAt = db.prepare('SELECT at FROM reads WHERE thread_id = ? AND reader = ?');
const markRead = db.prepare('INSERT OR REPLACE INTO reads (thread_id, reader, at) VALUES (?, ?, ?)');

const clients = new Set();
// Runners are known while the server runs; online means their socket is open.
const runners = new Map();
// Addressed entries a runner has right now, by entry id, with what it has written so far.
const working = new Map();
// Who answers an entry. On its own, the entry's `to` decides. The director, for multiplayer threads, can decide instead.
const director = process.env.DIRECTOR ? await import('./director.js') : null;
const route = director ? director.route : (posted) => posted.to;
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
  return JSON.parse(body || '{}');
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

function broadcast(value) {
  const data = frame(value);
  for (const socket of clients) socket.write(data);
}

const notify = (threadId) => broadcast({ threadId });

// A `to` says who should answer: a runner, one of its harnesses, and optionally a model, an effort level and a folder.
function address(to) {
  if (!to) return null;
  const clean = { runner: field(to.runner, 'to.runner'), harness: field(to.harness, 'to.harness') };
  for (const key of ['model', 'effort', 'dir']) if (typeof to[key] === 'string' && to[key].trim()) clean[key] = to[key].trim();
  return clean;
}

const agentName = (to) => `${to.harness}@${to.runner}`;

function parse(row) {
  if (!row) return row;
  const { address: to, steps, ...rest } = row;
  return { ...rest, to: to ? JSON.parse(to) : null, steps: steps ? JSON.parse(steps) : null };
}

// An entry is one immutable record in a thread: chat, a command's output, a note, or an error.
// It may say who should answer it (`to`), or which entry it answers (`replyTo`). Steps are the tool calls an answer made.
function append(threadId, { author, role = 'human', kind = 'chat', to = null, replyTo = null, steps = null, body }) {
  const posted = { id: randomUUID(), threadId, author, role, kind, to, replyTo, steps, body, createdAt: new Date().toISOString() };
  addEntry.run(posted.id, threadId, author, role, kind, to && JSON.stringify(to), replyTo, steps && JSON.stringify(steps), body, posted.createdAt);
  notify(threadId);
  if (to) dispatch(posted);
  return posted;
}

// Hands an addressed entry to its runner. An offline runner gets it when it connects; until then it is queued.
function dispatch(posted) {
  const runner = runners.get(posted.to.runner);
  if (!runner?.socket || working.has(posted.id)) return;
  working.set(posted.id, { runner: runner.name, threadId: posted.threadId });
  runner.socket.write(frame({ entry: posted }));
  notify(null);
}

// The answer to an addressed entry, from its runner: text with steps, a command's output, or an error.
function answer(asked, { body, error, steps, ...output }) {
  working.delete(asked.id);
  const author = agentName(asked.to);
  const answered = error
    ? append(asked.threadId, { author, role: 'agent', kind: 'error', replyTo: asked.id, body: `${author} failed: ${error}` })
    : asked.to.harness === 'shell'
      ? append(asked.threadId, { author, role: 'agent', kind: 'exec', replyTo: asked.id, body: JSON.stringify(output) })
      : append(asked.threadId, { author, role: 'agent', replyTo: asked.id, steps, body: body || '(empty reply)' });
  reportToParent(asked, answered);
  notify(null);
  return answered;
}

// A child thread reports each answer to its parent, so the result doesn't depend on whoever asked still watching.
function reportToParent(asked, answered) {
  const parent = thread.get(asked.threadId)?.parent;
  if (!parent || answered.kind === 'exec') return;
  const line = answered.body.split('\n').find(Boolean)?.slice(0, 160) || '(empty reply)';
  append(parent, { author: answered.author, role: 'agent', kind: answered.kind, body: `${line} → thread:${asked.threadId}` });
}

// Where a thread stands for one reader: working, queued, error, done (a result they haven't seen yet) or idle.
function status(threadId, pending, reader) {
  if (pending.some((p) => p.state === 'working')) return 'working';
  if (pending.length) return 'queued';
  const last = lastResult.get(threadId);
  if (!last) return 'idle';
  if (last.kind === 'error') return 'error';
  return last.createdAt > (readAt.get(threadId, reader)?.at ?? '') ? 'done' : 'idle';
}

// A thread as a client sees it: its status, the entries still waiting for an answer, and answers being written.
function view(row, owed, reader) {
  const pending = owed.filter((p) => p.threadId === row.id).map((p) => ({ id: p.id, author: p.author, to: p.to, state: working.has(p.id) ? 'working' : 'queued' }));
  const live = pending.filter((p) => working.get(p.id)?.live).map((p) => ({ entryId: p.id, author: agentName(p.to), ...working.get(p.id).live }));
  return { ...row, status: status(row.id, pending, reader), pending, live };
}

function runnerList() {
  return [...runners.values()].map(({ socket, ...runner }) => ({ ...runner, online: Boolean(socket), working: [...working].filter(([, w]) => w.runner === runner.name).map(([id, w]) => ({ entryId: id, threadId: w.threadId })) }));
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
    if (req.method === 'GET' && path === '/api/server') return send(res, 200, { port, director: Boolean(director), threads: threads.all().length, owed: unanswered.all().length });
    if (req.method === 'GET' && path === '/api/runners') return send(res, 200, runnerList());
    if (req.method === 'GET' && path === '/api/threads') {
      const owed = unanswered.all().map(parse);
      return send(res, 200, threads.all().map((row) => view(row, owed, user(req))));
    }
    if (req.method === 'POST' && path === '/api/threads') {
      const { title, parent = null } = await input(req);
      if (parent && !thread.get(parent)) return send(res, 404, { error: 'Parent thread not found' });
      const row = { id: randomUUID(), title: field(title, 'title'), parent, createdAt: new Date().toISOString() };
      addThread.run(row.id, row.title, row.parent, row.createdAt);
      send(res, 201, row);
      return notify(null);
    }
    const removeThread = /^\/api\/threads\/([\w-]+)$/.exec(path);
    if (removeThread && req.method === 'DELETE') {
      const id = removeThread[1];
      if (!thread.get(id)) return send(res, 404, { error: 'Thread not found' });
      if ([...working.values()].some((w) => w.threadId === id)) return send(res, 409, { error: 'A runner is answering in this thread; wait for it before deleting it' });
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE threads SET parent = NULL WHERE parent = ?').run(id);
        db.prepare('DELETE FROM entries WHERE thread_id = ?').run(id);
        db.prepare('DELETE FROM reads WHERE thread_id = ?').run(id);
        db.prepare('DELETE FROM threads WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      send(res, 200, { id });
      return notify(null);
    }
    // Opening a thread marks it read, so its last result stops counting as done for you.
    const read = /^\/api\/threads\/([\w-]+)\/read$/.exec(path);
    if (read && req.method === 'POST') {
      if (!thread.get(read[1])) return send(res, 404, { error: 'Thread not found' });
      markRead.run(read[1], user(req), new Date().toISOString());
      return send(res, 200, { ok: true });
    }
    const list = /^\/api\/threads\/([\w-]+)\/entries$/.exec(path);
    if (list) {
      const id = list[1];
      if (!thread.get(id)) return send(res, 404, { error: 'Thread not found' });
      if (req.method === 'GET') return send(res, 200, entries.all(id).map(parse));
      if (req.method === 'POST') {
        const { body, to } = await input(req);
        const draft = { author: user(req), body: field(body, 'body'), to: address(to) };
        return send(res, 201, append(id, { ...draft, to: address(route(draft, entries.all(id).map(parse))) }));
      }
    }
    // A runner answers the entry it was handed, or streams the answer while it writes it. The stream lives in memory only.
    const reply = /^\/api\/entries\/([\w-]+)\/(reply|live|cancel)$/.exec(path);
    if (reply && req.method === 'POST') {
      const asked = parse(entry.get(reply[1]));
      if (!asked?.to) return send(res, 404, { error: 'No addressed entry with that id' });
      if (unanswered.all().every((p) => p.id !== asked.id)) return send(res, 409, { error: 'That entry is already answered' });
      const value = await input(req);
      if (reply[2] === 'reply') return send(res, 200, answer(asked, value));
      if (reply[2] === 'live') {
        if (!working.has(asked.id)) return send(res, 409, { error: 'No runner has that entry' });
        working.get(asked.id).live = { text: value.text || '', steps: value.steps || [] };
        send(res, 200, { ok: true });
        return broadcast({ threadId: asked.threadId, live: { entryId: asked.id, author: agentName(asked.to), ...working.get(asked.id).live } });
      }
      // Cancelling answers a queued entry with a note, so nobody owes it anymore.
      if (working.has(asked.id)) return send(res, 409, { error: 'A runner is already answering that entry' });
      send(res, 200, append(asked.threadId, { author: 'server', role: 'server', kind: 'note', replyTo: asked.id, body: `${user(req)} cancelled the entry for ${agentName(asked.to)}` }));
      return notify(null);
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
};

// Browsers connect to /ws. A runner connects to /ws?runner=NAME&alias=…&harnesses=a,b and is online while connected. The alias is display only; the name is the key.
function upgrade(req, socket) {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) return socket.destroy();
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const name = url.searchParams.get('runner');
  if (name) {
    runners.get(name)?.socket?.destroy();
    const harnesses = (url.searchParams.get('harnesses') || '').split(',').filter(Boolean);
    runners.set(name, { name, alias: url.searchParams.get('alias') || '', owner: url.searchParams.get('owner') || 'anon', host: url.searchParams.get('host') || '', harnesses, lastSeen: new Date().toISOString(), socket });
    console.log(`runner ${name} online: ${harnesses.join(', ')}`);
    // Entries that queued for this runner, even across a server restart, go to it now.
    for (const owed of unanswered.all().map(parse)) if (owed.to.runner === name) dispatch(owed);
    notify(null);
  }
  clients.add(socket);
  const close = () => {
    clients.delete(socket);
    const runner = name && runners.get(name);
    if (runner?.socket !== socket) return;
    runners.set(name, { ...runner, socket: null, lastSeen: new Date().toISOString() });
    console.log(`runner ${name} offline`);
    // What it had goes back to queued; it gets it again when it reconnects.
    for (const [id, w] of working) if (w.runner === name) working.delete(id);
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
  server.listen(port, host, () => { for (const address of urls(host)) console.log(`http://${address}:${port}${director ? ' (director on)' : ''}`); });
}
