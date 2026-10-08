// With memory, GET /api/threads/:id/memory gives the thread's memory as lines, and `?zoom=id,n` opens one, as the
// zoom tool does, down to the message whole. The client's memory panel shows just this. Without memory, no endpoint.
import { rmSync } from 'node:fs';
import { api, check, db, done, linesOf, say, scriptedRunner, server, sleep, text, until } from './lib.js';

const route = (request) => say(text(request.messages.find((m) => m.role === 'user')).includes('<input>') ? `L ${'x'.repeat(298)}` : 'ok');
const long = (k) => `message ${k} ${'y'.repeat(1000 - `message ${k} `.length)}`;

let srv = await server({ MEMORY: '1', MEMORY_MODEL: 'echo/echo@bot' });
const bot = await scriptedRunner('bot', route);
const { json: { id } } = await api('POST', '/api/threads', { title: 'panel' });
for (let k = 0; k < 5; k++) await api('POST', `/api/threads/${id}/entries`, { body: long(k), to: null });
await until(async () => (await linesOf(id)).length === 5 + 2 + 1, 15000);
const { status, json: memory } = await api('GET', `/api/threads/${id}/memory`);
check(status === 200 && memory.lines.map((x) => `${x.id}+${x.n}`).join() === '0+1,1+1,2+1,3+1,4+1', 'the memory covers the thread, one line a message while it fits', JSON.stringify(memory));
const halves = (await api('GET', `/api/threads/${id}/memory?zoom=0,4`)).json;
check(halves.lines?.map((x) => `${x.id}+${x.n}`).join() === '0+2,2+2' && halves.lines.every((x) => x.text.startsWith('L ')), 'zoom=0,4 gives the two lines it was made from', JSON.stringify(halves).slice(0, 200));
const whole = (await api('GET', `/api/threads/${id}/memory?zoom=4,1`)).json;
check(whole.message === `oskar: ${long(4)}`, 'zoom=4,1 gives the message whole');
const bad = await api('GET', `/api/threads/${id}/memory?zoom=1,2`);
check(bad.status === 400 && bad.json.error.includes('1+2'), 'a line not in the tree is an error', JSON.stringify(bad));
bot.close();
srv.kill();
await sleep(300);

for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
srv = await server();
const { json: { id: plain } } = await api('POST', '/api/threads', { title: 'plain' });
check((await api('GET', `/api/threads/${plain}/memory`)).status === 404, 'without memory there is no endpoint');
srv.kill();
done();
