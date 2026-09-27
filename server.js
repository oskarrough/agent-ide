import http from 'node:http';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.env.PORT || 3000);
const db = new DatabaseSync(process.env.DB_PATH || 'threads.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
`);
for (const [table, column] of [['threads', 'parent TEXT'], ['threads', 'runner TEXT'], ['threads', 'harness TEXT'], ['threads', 'model TEXT'], ['events', "author TEXT NOT NULL DEFAULT 'anon'"], ['events', "kind TEXT NOT NULL DEFAULT 'human'"], ['events', 'runner TEXT'], ['events', "type TEXT NOT NULL DEFAULT 'chat'"]]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`); } catch {}
}

const threads = db.prepare('SELECT id, title, parent, runner, harness, model, created_at AS createdAt FROM threads ORDER BY created_at DESC');
const thread = db.prepare('SELECT id FROM threads WHERE id = ?');
const events = db.prepare('SELECT id, thread_id AS threadId, author, kind, type, runner, body, created_at AS createdAt FROM events WHERE thread_id = ? ORDER BY created_at, rowid');
const addThread = db.prepare('INSERT INTO threads (id, title, parent, created_at) VALUES (?, ?, ?, ?)');
const setPlacement = db.prepare('UPDATE threads SET runner = ?, harness = ?, model = ? WHERE id = ?');
const addEvent = db.prepare('INSERT INTO events (id, thread_id, body, created_at, author, kind, type, runner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
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
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}

function notify(threadId) {
  const data = frame({ threadId });
  for (const socket of clients) socket.write(data);
}

function append(threadId, { author, kind = 'bot', type = 'chat', runner = null, body }) {
  const item = { id: randomUUID(), threadId, author, kind, type, runner, body, createdAt: new Date().toISOString() };
  addEvent.run(item.id, threadId, item.body, item.createdAt, item.author, item.kind, item.type, item.runner);
  notify(threadId);
  return item;
}

// Hands a job to a runner and answers with the entry it produced. Offline runners fail fast, in the thread too.
async function act(req, res, job) {
  const runner = runners.get(job.runner);
  const caller = user(req);
  // Only the owner, or someone the owner allowed, may send work to a runner. Checked here, not on the runner.
  if (runner && caller !== runner.owner && !runner.allowed.has(caller)) {
    const entry = append(job.threadId, { author: 'server', type: 'system', runner: job.runner, body: `${caller} may not use ${runner.owner}'s runner ${job.runner} (${job.kind} as ${job.author}); ${runner.owner} has not allowed it` });
    return send(res, 403, { error: entry.body, entry });
  }
  if (!runner?.socket) {
    const entry = append(job.threadId, { author: 'server', type: 'system', runner: job.runner, body: `${job.author} could not ${job.kind}: runner ${job.runner} is ${runner ? 'offline' : 'unknown'}` });
    return send(res, 409, { error: entry.body, entry });
  }
  job.id = randomUUID();
  const entry = await new Promise((resolve) => {
    jobs.set(job.id, { ...job, resolve });
    runner.socket.write(frame({ job }));
  });
  send(res, entry.type === 'system' ? 502 : 200, entry);
}

// A runner that drops leaves a note in every thread it was working in.
function strand(name) {
  for (const job of jobs.values()) {
    if (job.runner !== name || job.stranded) continue;
    job.stranded = true;
    job.resolve(append(job.threadId, { author: 'server', type: 'system', runner: name, body: `runner ${name} went offline during ${job.author}'s ${job.kind}; nothing came back yet` }));
  }
}

function runnerList() {
  return [...runners.values()].map(({ socket, allowed, ...runner }) => ({ ...runner, allowed: [...allowed], online: Boolean(socket) }));
}

const handleRequest = async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-user' });
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
    if (req.method === 'GET' && path === '/api/threads') return send(res, 200, threads.all());
    if (req.method === 'POST' && path === '/api/threads') {
      const { title, parent = null } = await input(req);
      if (parent && !thread.get(parent)) return send(res, 404, { error: 'Parent thread not found' });
      const item = { id: randomUUID(), title: field(title, 'title'), parent, createdAt: new Date().toISOString() };
      addThread.run(item.id, item.title, item.parent, item.createdAt);
      send(res, 201, item);
      return notify(null);
    }
    const result = /^\/api\/jobs\/([\w-]+)$/.exec(path);
    if (result && req.method === 'POST') {
      const job = jobs.get(result[1]);
      // A job whose runner dropped mid-way is kept, so a late answer still lands in the thread.
      if (!job) return send(res, 404, { error: 'Job not found' });
      jobs.delete(job.id);
      const { body, error, ...output } = await input(req);
      const late = job.stranded ? ' (arrived after its runner reconnected)' : '';
      const entry = append(job.threadId, error
        ? { author: 'server', type: 'system', runner: job.runner, body: `${job.author} could not ${job.kind} via ${job.runner}: ${error}` }
        : job.kind === 'exec'
          ? { author: job.author, kind: 'human', type: 'exec', runner: job.runner, body: JSON.stringify({ command: job.command, dir: job.dir, ...output }) }
          : { author: job.author, runner: job.runner, body: (body || '(empty reply)') + late });
      job.resolve(entry);
      return send(res, 200, entry);
    }
    const reply = /^\/api\/threads\/([\w-]+)\/reply$/.exec(path);
    if (reply && req.method === 'POST') {
      const threadId = reply[1];
      if (!thread.get(threadId)) return send(res, 404, { error: 'Thread not found' });
      const { bot, runner, harness = 'echo', model = null, dir = '.' } = await input(req);
      field(bot, 'bot');
      return act(req, res, { kind: 'reply', threadId, author: bot, bot, runner: field(runner, 'runner'), harness, model, dir });
    }
    const exec = /^\/api\/threads\/([\w-]+)\/exec$/.exec(path);
    if (exec && req.method === 'POST') {
      const threadId = exec[1];
      if (!thread.get(threadId)) return send(res, 404, { error: 'Thread not found' });
      const { runner, command, dir = '.' } = await input(req);
      field(command, 'command');
      return act(req, res, { kind: 'exec', threadId, author: user(req), runner: field(runner, 'runner'), command, dir });
    }
    const placement = /^\/api\/threads\/([\w-]+)$/.exec(path);
    if (placement && req.method === 'POST') {
      const id = placement[1];
      if (!thread.get(id)) return send(res, 404, { error: 'Thread not found' });
      const { runner, harness, model } = await input(req);
      setPlacement.run(runner || null, harness || null, model || null, id);
      send(res, 200, { id, runner, harness, model });
      return notify(null);
    }
    const match = /^\/api\/threads\/([\w-]+)\/events$/.exec(path);
    if (match) {
      const id = match[1];
      if (!thread.get(id)) return send(res, 404, { error: 'Thread not found' });
      if (req.method === 'GET') return send(res, 200, events.all(id));
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

// Browsers connect to /ws. A runner connects to /ws?runner=NAME&harnesses=a,b and is online while connected.
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
    const owner = url.searchParams.get('owner') || 'anon';
    const previous = runners.get(name);
    const allowed = previous?.owner === owner ? previous.allowed : new Set();
    runners.set(name, { name, owner, host: url.searchParams.get('host') || '', harnesses, allowed, lastSeen: new Date().toISOString(), socket });
    console.log(`runner ${name} online: ${harnesses.join(', ')}`);
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
