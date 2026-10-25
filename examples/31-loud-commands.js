// A `$ cmd` that prints without end keeps only the tail of its output while it runs, as its entry does when it ends,
// so the server's memory and every thread list stay small.
import { api, check, done, runner, server, until, view } from './lib.js';

await server();
await runner('laptop');
const { json: { id } } = await api('POST', '/api/threads', { title: 'loud' });
await api('POST', `/api/threads/${id}/entries`, { body: '$ yes', to: { runner: 'laptop', model: 'echo/echo' } });
const loud = await until(async () => (await view(id)).shells[0]?.stdout.length >= 20000);
const sizes = [];
for (let n = 0; n < 5; n++) sizes.push(JSON.stringify((await api('GET', '/api/threads')).json).length);
check(Boolean(loud) && Math.max(...sizes) < 50000, 'a running command shows only its last 20000 characters', JSON.stringify(sizes));
await api('POST', `/api/threads/${id}/stop`, {});
const stopped = await until(async () => (await view(id)).entries.find((e) => e.data.shell));
check(stopped?.data.shell.error === 'stopped' && stopped.data.shell.stdout.length <= 20000, 'and stopping it posts that tail', stopped?.data.shell.stdout.length);

done();
