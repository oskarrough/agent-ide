// A `$ cmd` runs on a runner with no model at all. A loud one keeps only the tail of its output while it runs, as its
// entry does when it ends, so the server's memory and every thread list stay small.
import { api, check, done, runner, server, sleep, until, view } from './lib.js';

await server();
await runner('laptop');
const { json: { id } } = await api('POST', '/api/threads', { title: 'commands' });
// The runner's pi has no logins here, so it has no default model.
await api('POST', `/api/threads/${id}/entries`, { body: '$ echo hi', to: { runner: 'laptop' } });
const echoed = await until(async () => (await view(id)).entries.find((e) => e.data.shell));
check(echoed?.data.shell.stdout === 'hi\n', 'a command needs no model', JSON.stringify(echoed?.data));

await api('POST', `/api/threads/${id}/entries`, { body: '$ yes | head -c 2000000; sleep 60', to: { runner: 'laptop' } });
const loud = await until(async () => (await view(id)).shells[0]?.stdout.length >= 20000);
// By now it has printed its two million characters.
await sleep(1000);
const sizes = [];
for (let n = 0; n < 5; n++) sizes.push(JSON.stringify((await api('GET', '/api/threads')).json).length);
check(Boolean(loud) && Math.max(...sizes) < 50000, 'a running command shows only its last 20000 characters', JSON.stringify(sizes));
await api('POST', `/api/threads/${id}/stop`, {});
const stopped = await until(async () => (await view(id)).entries.find((e) => e.data.shell?.error));
check(stopped?.data.shell.error === 'stopped' && stopped.data.shell.stdout.length <= 20000, 'and stopping it posts that tail', stopped?.data.shell.stdout.length);

done();
