import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.env.PORT || 3000);
const db = new DatabaseSync(process.env.DB_PATH || 'threads.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
`);

const threads = db.prepare('SELECT id, title, created_at AS createdAt FROM threads ORDER BY created_at DESC');
const thread = db.prepare('SELECT id FROM threads WHERE id = ?');
const events = db.prepare('SELECT id, thread_id AS threadId, body, created_at AS createdAt FROM events WHERE thread_id = ? ORDER BY created_at, rowid');
const addThread = db.prepare('INSERT INTO threads VALUES (?, ?, ?)');
const addEvent = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
const clients = new Set();
const page = await readFile(new URL('./client.html', import.meta.url));

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(value));
}

async function input(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20000) throw new Error('Request too large');
  }
  return JSON.parse(body);
}

function field(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function notify(threadId) {
  const payload = Buffer.from(JSON.stringify({ threadId }));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  for (const socket of clients) socket.write(Buffer.concat([header, payload]));
}

const handleRequest = async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  try {
    if (req.method === 'GET' && path === '/api/threads') return send(res, 200, threads.all());
    if (req.method === 'POST' && path === '/api/threads') {
      const { title } = await input(req);
      const item = { id: randomUUID(), title: field(title, 'title'), createdAt: new Date().toISOString() };
      addThread.run(item.id, item.title, item.createdAt);
      send(res, 201, item);
      return notify(null);
    }
    const match = /^\/api\/threads\/([\w-]+)\/events$/.exec(path);
    if (match) {
      const id = match[1];
      if (!thread.get(id)) return send(res, 404, { error: 'Thread not found' });
      if (req.method === 'GET') return send(res, 200, events.all(id));
      if (req.method === 'POST') {
        const { body } = await input(req);
        const item = { id: randomUUID(), threadId: id, body: field(body, 'body'), createdAt: new Date().toISOString() };
        addEvent.run(item.id, id, item.body, item.createdAt);
        send(res, 201, item);
        return notify(id);
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
};

function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || !key) return socket.destroy();
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);
  socket.on('data', () => socket.end());
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
}

for (const host of process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1']) {
  const server = http.createServer(handleRequest);
  server.on('upgrade', upgrade);
  server.on('error', (error) => {
    if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) return;
    console.error(error);
    process.exit(1);
  });
  server.listen(port, host, () => console.log(`http://${host === '::1' ? '[::1]' : host}:${port}`));
}
