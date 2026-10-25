// With memory, every message gets a line and neighbouring lines merge in pairs, once each, through a SIGKILL. A short
// message is its own line; a long one is written by MEMORY_MODEL, retried when too long. A fork reads its source's
// lines through and builds only its own.
import { api, check, done, linesOf, say, scriptedRunner, server, sleep, text, until, view } from './lib.js';

const env = { MEMORY: '1', MEMORY_MODEL: 'echo/echo@bot' };
const requests = [];
let n = 0;
const line = (size) => { const head = `L${++n} `; return head + 'x'.repeat(size - head.length); };
const route = (request) => {
  const first = text(request.messages.find((m) => m.role === 'user'));
  if (!first.includes('<input>')) return say('ok');
  const all = request.messages.map((m) => text(m)).join('\n');
  const input = first.slice(first.lastIndexOf('<input>'));
  requests.push({ first, all, input });
  return say(line(input.includes('TOOLONG') && request.messages.length <= 3 ? 700 : 300));
};
const long = (tag) => `${tag} ${'y'.repeat(2000 - tag.length - 1)}`;
const has = (lines, l, i) => lines.some((x) => x.l === l && x.i === i);
const post = (id, body) => api('POST', `/api/threads/${id}/entries`, { body, to: null });
const thread = async (title) => (await api('POST', '/api/threads', { title })).json.id;

let srv = await server(env);
await scriptedRunner('bot', route);

const a = await thread('short');
await post(a, 'hi');
const short = await until(async () => (await linesOf(a)).find((x) => x.l === 0 && x.i === 0));
check(short?.text === 'oskar: hi' && requests.length === 0, 'a short message is its own line, with no request', JSON.stringify(short));

const b = await thread('long');
await post(b, long('first'));
await until(async () => has(await linesOf(b), 0, 0));
await post(b, long('second'));
await until(async () => has(await linesOf(b), 1, 0));
await post(b, long('TOOLONG'));
await until(async () => has(await linesOf(b), 0, 2), 15000);
const bl = await linesOf(b);
check(bl.filter((x) => x.l === 0).every((x) => x.size <= 512 && x.text.startsWith('L')), 'a long message gets a written line of at most 512 bytes', JSON.stringify(bl.map((x) => [x.l, x.i, x.size])));
check(bl.find((x) => x.l === 1 && x.i === 0)?.text.startsWith('L') && requests.some((r) => r.input.includes('L1 ') && r.input.includes('L2 ')), 'two 300-byte lines merge into a written line');
check(requests.every((r) => r.first.includes('-'.repeat(512))), 'every line request holds the 512-dash ruler');
const tooLong = requests.filter((r) => r.input.includes('TOOLONG'));
check(tooLong.length === 2 && tooLong[1].all.includes('Too long: your line is 700 bytes') && tooLong[1].all.includes('| ← LIMIT'), 'a line over 512 bytes is asked again, with the cut', tooLong.length);
check(bl.find((x) => x.l === 0 && x.i === 2)?.size === 300, 'and the line that fits is kept');
const second = requests.find((r) => r.input.includes('second'));
check(second?.first.includes(`0+1|${bl.find((x) => x.l === 0 && x.i === 0).text}`), 'the second message\'s request holds the first\'s line in <chat>');

const c = await thread('restart');
const entries = [];
for (let k = 0; k < 8; k++) entries.push((await post(c, long(`m${k}`))).json.entry);
await until(async () => (await linesOf(c)).length > 0, 15000);
srv.kill('SIGKILL');
await sleep(500);
srv = await server(env);
const want = [[0, 8], [1, 4], [2, 2], [3, 1]].flatMap(([l, count]) => Array.from({ length: count }, (_, i) => `${l}:${i}`));
const built = await until(async () => { const ls = await linesOf(c); return want.every((k) => ls.some((x) => `${x.l}:${x.i}` === k)) && ls; }, 30000);
await sleep(1000);
const keys = (await linesOf(c)).map((x) => `${x.l}:${x.i}`);
check(Boolean(built) && keys.length === 15 && want.every((k) => keys.filter((x) => x === k).length === 1), 'after a SIGKILL all 15 lines arrive, each exactly once', JSON.stringify(keys.sort()));

const at = entries[3];
const f = (await api('POST', `/api/threads/${c}/fork`, { at })).json.id;
check((await linesOf(f)).every((x) => x.id <= at), 'a fork copies no lines');
const source = await linesOf(c);
const sourceLine = (l, i) => source.find((x) => x.l === l && x.i === i).text;
const before = requests.length;
for (let k = 4; k < 8; k++) await post(f, long(`fork${k}`));
const forkWant = ['0:4', '0:5', '0:6', '0:7', '1:2', '1:3', '2:1', '3:0'];
await until(async () => { const own = (await linesOf(f)).filter((x) => x.id > at); return forkWant.every((k) => own.some((x) => `${x.l}:${x.i}` === k)); }, 30000);
await sleep(1000);
const own = (await linesOf(f)).filter((x) => x.id > at).map((x) => `${x.l}:${x.i}`).sort();
const firstFork = requests.slice(before).find((r) => r.input.includes('fork4'));
check([0, 1, 2, 3].every((i) => firstFork?.first.includes(`${i}+1|${sourceLine(0, i)}`)), 'the fork\'s first line request reads the source\'s lines through');
check(JSON.stringify(own) === JSON.stringify(forkWant.sort()), 'the fork builds exactly its own lines, up to (3,0)', JSON.stringify(own));
const root = requests.slice(before).find((r) => r.input.includes(sourceLine(2, 0)));
check(Boolean(root) && root.first.includes('merge lines 0+4 and 4+4'), 'its (3,0) merges the source\'s (2,0)');

srv.kill();
done();
