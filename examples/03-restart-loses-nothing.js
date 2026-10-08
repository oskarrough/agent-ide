// A restart loses nothing. Ben posts while the runner is offline, then the server restarts.
// His input is still queued, still his, and answered once the runner is back.
// bun examples/03-restart-loses-nothing.js
import { answered, api, check, done, runner, server, sleep, until, view } from './lib.js';

let srv = await server();
let laptop = await runner('laptop');

const { json: { id } } = await api('POST', '/api/threads', { title: 'test' });
await api('POST', `/api/threads/${id}/entries`, { body: 'hello', to: { runner: 'laptop', model: 'echo/echo' } });
await answered(id);

laptop.kill();
await until(() => api('GET', '/api/runners').then((r) => r.json.every((x) => !x.online)));
await api('POST', `/api/threads/${id}/entries`, { body: 'while away' }, 'ben');
await sleep(300);
srv.kill();
await sleep(500);
srv = await server();
const queued = await view(id);
check(queued.status === 'blocked', 'after restart the input waits for the runner', queued.status);

laptop = await runner('laptop', { wait: false });
const after = await until(async () => {
  const v = await view(id);
  return v.entries.filter((e) => e.entry.kind === 'pi.assistant' && e.author === 'echo@laptop').length >= 2 ? v : null;
}, 15000);
const benInput = after?.entries.find((e) => e.author === 'ben');
check(Boolean(benInput) && after.entries.some((e) => e.re?.includes(benInput.entry.id)), 'after restart ben is answered and credited', JSON.stringify(after?.entries.map((e) => [e.author, e.entry.kind])));

done();
