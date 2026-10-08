// A restart loses nothing. Ben posts while the runner is offline, so his message is written but not yet delivered to
// the agent, and the server is killed in between. After the restart his message is still on its way, still his, and
// answered once the runner is back.
import { answered, answers, api, brief, check, conversationOf, done, runner, server, sleep, text, until, view } from './lib.js';

let srv = await server();
let laptop = await runner('laptop');

const { json: { id } } = await api('POST', '/api/threads', { title: 'test' });
await api('POST', `/api/threads/${id}/entries`, { body: 'hello', to: { runner: 'laptop', model: 'echo/echo' } });
await answered(id);

laptop.kill();
await until(() => api('GET', '/api/runners').then((r) => r.json.every((x) => !x.online)));
await api('POST', `/api/threads/${id}/entries`, { body: 'while away' }, 'ben');
const inputs = async () => (await conversationOf(await view(id), 'echo/echo@laptop')).entries.filter((e) => e.kind === 'pi.user').map((e) => text(e.model[0]));
check(!(await inputs()).some((t) => t.includes('while away')), 'the message is written, its delivery waits for the runner', JSON.stringify(await inputs()));
srv.kill('SIGKILL');
await sleep(500);
srv = await server();
const queued = await view(id);
check(queued.status === 'blocked', 'after restart the delivery waits for the runner', queued.status);

laptop = await runner('laptop', { wait: false });
const after = await answered(id, 2, 15000);
const ben = after?.entries.find((e) => e.data.author === 'ben');
check(Boolean(ben) && answers(after).at(-1).data.re?.includes(ben.id), 'after restart ben is answered and credited', brief(after));
await sleep(1000);
check(answers(await view(id)).length === 2 && (await inputs()).filter((t) => t.includes('while away')).length === 1, 'delivered and answered once', JSON.stringify(await inputs()));

done();
