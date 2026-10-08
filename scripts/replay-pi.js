// Replays pi sessions into one new thread, to try memory on a real history: each user text as `oskar`, and each turn's
// last assistant text as `pi`, all asking nobody. Sessions go in order of their start.
// bun scripts/replay-pi.js <session.jsonl | sessions folder> [--server URL] [--title T] [--limit N]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args, positionals: [source] } = parseArgs({ allowPositionals: true, options: {
  server: { type: 'string', default: 'http://127.0.0.1:3000' },
  title: { type: 'string' },
  limit: { type: 'string' },
} });
if (!source) {
  console.error('usage: bun scripts/replay-pi.js <session.jsonl | sessions folder> [--server URL] [--title T] [--limit N]');
  process.exit(1);
}

const files = statSync(source).isDirectory() ? readdirSync(source).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(source, f)) : [source];
const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')).trim();

// A session's posts: each user text, then the last assistant text before the next user message or the end.
function posts(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const out = [];
  let answer;
  for (const { type, message } of lines) {
    if (type !== 'message') continue;
    if (message.role === 'user') {
      if (answer) out.push({ author: 'pi', body: answer });
      answer = undefined;
      const body = textOf(message.content);
      if (body) out.push({ author: 'oskar', body });
    } else if (message.role === 'assistant') answer = textOf(message.content) || answer;
  }
  if (answer) out.push({ author: 'pi', body: answer });
  return { start: lines.find((l) => l.type === 'session')?.timestamp ?? '', out };
}

const sessions = files.map(posts).sort((a, b) => a.start.localeCompare(b.start));
let all = sessions.flatMap((s) => s.out);
if (args.limit) all = all.slice(0, Number(args.limit));

async function api(method, route, body, user = 'oskar') {
  const res = await fetch(args.server + route, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.status);
  return json;
}

const { id } = await api('POST', '/api/threads', { title: args.title ?? `replay of ${path.basename(path.resolve(source))}` });
const failed = [];
const started = Date.now();
for (const [k, { author, body }] of all.entries()) {
  // The server takes 200 KB a request, and reads `$ ` as a command.
  try { await api('POST', `/api/threads/${id}/entries`, { body: body.replace(/^\$(\s)/, '＄$1').slice(0, 150000), to: null }, author); }
  catch (error) { failed.push(`${k}: ${error.message}`); }
}
const by = (who) => all.filter((p) => p.author === who).length;
console.log(`thread ${id}: ${all.length - failed.length} posts from ${sessions.length} sessions (${by('oskar')} oskar, ${by('pi')} pi) in ${Date.now() - started} ms`);
if (failed.length) console.log(`${failed.length} failed:\n${failed.join('\n')}`);
