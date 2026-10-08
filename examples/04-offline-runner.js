// A runner that goes away. A thread waiting for it is blocked, not failed; stopping it leaves it idle, with no error.
// bun examples/04-offline-runner.js
import { api, check, done, runner, server, sleep, until, view } from './lib.js';

await server();
const away = await runner('away');
away.kill();
await until(() => api('GET', '/api/runners').then((r) => r.json.some((x) => x.name === 'away' && !x.online)));

const { json: { id } } = await api('POST', '/api/threads', { title: 'away' });
await api('POST', `/api/threads/${id}/entries`, { body: 'anyone?', to: { runner: 'away', model: 'echo/echo' } });
const blocked = await until(async () => (await view(id)).status === 'blocked');
check(Boolean(blocked), 'a thread waiting for an offline runner is blocked');

await api('POST', `/api/threads/${id}/stop`, {});
await sleep(800);
const stopped = await view(id);
check(stopped.status === 'idle' && !stopped.entries.some((e) => e.entry.kind === 'agent-ide.error'), 'a stopped thread is idle, with no error entry', `${stopped.status} ${stopped.entries.map((e) => e.entry.kind)}`);

done();
