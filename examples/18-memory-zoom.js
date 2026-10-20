// With memory, an agent zooms a line into the two it was made from, and down to a message whole, a long one in pages
// that say where to go on; a line that isn't in the tree is an error. The prompt tells it to zoom before it guesses, and that an agent's word is only a claim. With MEMORY=0, neither the tool nor the prompt.
import { rmSync } from 'node:fs';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { api, call, check, conversationOf, db, done, linesOf, say, scriptedRunner, server, sleep, text, until, view } from './lib.js';

let offered = [];
let prompt = '';
let n = 0;
const route = (request) => {
  const first = text(request.messages.find((m) => m.role === 'user'));
  if (first.includes('<input>')) { const head = `L${++n} `; return say(head + 'x'.repeat(300 - head.length)); }
  offered = getCurrentTools(request.messages).map((t) => t.name);
  prompt = JSON.stringify(request.messages.filter((m) => m.role === 'system'));
  const results = request.messages.filter((m) => m.role === 'toolResult').length;
  return [call('zoom', { id: 0, n: 4 }), call('zoom', { id: 0, n: 1 }), call('zoom', { id: 1, n: 2 }), call('zoom', { id: 4, n: 1 }), call('zoom', { id: 4, n: 1, at: next })][results] ?? say('done');
};
const bodies = [0, 1, 2, 3].map((k) => { const head = k ? `message ${k} ` : 'message 0 the secret is secret-42 '; return head + 'y'.repeat(1000 - head.length); });
// A long paste: 5,000 lines of "line k", longer than a page.
const long = Array.from({ length: 5000 }, (_, k) => `line ${k}`).join('\n');
const said = `oskar: ${long}`;
const upTo = (n) => said.split('\n').slice(0, n).join('\n').length + 1;
const pageOf = (at, end) => `${said.slice(at, end)}\n\n[characters ${at} to ${end} of ${said.length}: zoom(4, 1, ${end}) goes on]`;
const next = upTo(1000);

async function round(env) {
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  const srv = await server(env);
  const bot = await scriptedRunner('bot', route);
  const { json: { id } } = await api('POST', '/api/threads', { title: 'zoom' });
  for (const body of [...bodies, long]) await api('POST', `/api/threads/${id}/entries`, { body, to: null });
  if (env.MEMORY === '1') await until(async () => (await linesOf(id)).some((x) => x.l === 2 && x.i === 0), 15000);
  await api('POST', `/api/threads/${id}/entries`, { body: 'what was the secret?', to: { runner: 'bot', model: 'echo/echo' } });
  const results = await until(async () => {
    const v = await view(id);
    return v.entries.some((e) => e.data.answer) && (await conversationOf(v, 'echo/echo@bot')).entries.filter((e) => e.kind === 'pi.tool-result').map((e) => e.model[0]);
  }, 15000);
  bot.close();
  srv.kill();
  await sleep(300);
  return { offered, prompt, results: results ?? [] };
}

const on = await round({ MEMORY: '1', MEMORY_MODEL: 'echo/echo@bot' });
const [one, two, three, four, five] = on.results;
const rows = text(one ?? {}).split('\n');
check(rows.length === 2 && rows[0].startsWith('0+2|L') && rows[1].startsWith('2+2|L'), 'zoom(0, 4) gives the two lines it was made from', JSON.stringify(rows.map((r) => r.slice(0, 12))));
check(text(two ?? {}) === `oskar: ${bodies[0]}`, 'zoom(0, 1) gives the message whole', text(two ?? {}).slice(0, 60));
check(three?.isError && text(three).includes('1+2'), 'zoom(1, 2) is an error naming the line', JSON.stringify(three)?.slice(0, 200));
check(text(four ?? {}) === pageOf(0, next), 'zoom(4, 1) gives a long message\'s first page, its first 1000 lines, and where to go on', text(four ?? {}).slice(-90));
check(text(five ?? {}) === pageOf(next, upTo(2000)), 'zoom(4, 1, at) gives the next page', text(five ?? {}).slice(0, 40));
check(on.offered.includes('zoom') && on.prompt.includes('Zoom is your way into the tree') && on.prompt.includes('is a claim'), 'memory on: zoom and its prompt section', JSON.stringify(on.offered));

const off = await round({ MEMORY: '0' });
check(!off.offered.includes('zoom') && !off.prompt.includes('Zoom is your way into the tree'), 'memory off: neither', JSON.stringify(off.offered));
done();
