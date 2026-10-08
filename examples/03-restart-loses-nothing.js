// A restart loses nothing. Ben posts while the runner is offline, the server restarts, and his input is
// still queued, still his, and answered once the runner is back.
import { answered, answers, api, brief, check, done, runner, server, sleep, until, view } from './lib.js';

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
const after = await answered(id, 2, 15000);
const ben = after?.entries.find((e) => e.data.author === 'ben');
check(Boolean(ben) && answers(after).at(-1).data.re?.includes(ben.id), 'after restart ben is answered and credited', brief(after));

done();
