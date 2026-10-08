// Handing work off: what a child thread answers is reported to its parent as a message from the child. A child that
// was stopped says nothing, in the child or to the parent.
import { api, check, conversationOf, done, runner, say, scriptedRunner, server, sleep, until, view } from './lib.js';

await server();
await runner('laptop');

const { json: { id: parent } } = await api('POST', '/api/threads', { title: 'parent' });
const { json: child } = await api('POST', '/api/threads', { title: 'child', parent });
await api('POST', `/api/threads/${child.id}/entries`, { body: 'do it', to: { runner: 'laptop', model: 'echo/echo' } });
const report = await until(async () => (await view(parent)).entries.find((e) => e.data.author === 'echo/echo@laptop' && e.data.from === child.id));
check(report?.data.body.startsWith('echo@laptop heard: oskar: do it') && !report.data.to, 'child answer reported to the parent, asking nobody', JSON.stringify(report));

// Stopped mid-answer: the input was placed, then aborted.
const slow = await scriptedRunner('slow', () => say(`thinking ${'slowly '.repeat(300)}`));
const { json: stopped } = await api('POST', '/api/threads', { title: 'stopped', parent });
await api('POST', `/api/threads/${stopped.id}/entries`, { body: 'take your time', to: { runner: 'slow', model: 'echo/echo' } });
const placed = await until(async () => (await conversationOf(await view(stopped.id), 'echo/echo@slow')).entries?.some((e) => e.kind === 'pi.user'), 8000, 20);
await api('POST', `/api/threads/${stopped.id}/stop`, {});
await sleep(1000);
const after = await view(stopped.id);
check(Boolean(placed) && after.status !== 'working' && after.entries.every((e) => e.data.author === 'oskar'), 'a stopped child posts nothing in its thread', JSON.stringify(after.entries));
check(!(await view(parent)).entries.some((e) => e.data.from === stopped.id), 'and reports nothing to its parent');

slow.close();
done();
