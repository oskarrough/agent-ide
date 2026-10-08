// Handing work off: what a child thread answers is reported to its parent as a message from the child.
import { api, check, done, runner, server, until, view } from './lib.js';

await server();
await runner('laptop');

const { json: { id: parent } } = await api('POST', '/api/threads', { title: 'parent' });
const { json: child } = await api('POST', '/api/threads', { title: 'child', parent });
await api('POST', `/api/threads/${child.id}/entries`, { body: 'do it', to: { runner: 'laptop', model: 'echo/echo' } });
const report = await until(async () => (await view(parent)).entries.find((e) => e.data.author === 'echo@laptop' && e.data.from === child.id));
check(report?.data.body.startsWith('echo@laptop heard: oskar: do it') && !report.data.to, 'child answer reported to the parent, asking nobody', JSON.stringify(report));

done();
