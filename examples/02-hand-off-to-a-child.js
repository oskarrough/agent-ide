// Handing work off. A thread can have child threads; whatever is answered in a child is reported to its parent as a note.
// bun examples/02-hand-off-to-a-child.js
import { api, check, done, runner, server, until, view } from './lib.js';

await server();
await runner('laptop');

const { json: { id: parent } } = await api('POST', '/api/threads', { title: 'parent' });
const { json: child } = await api('POST', '/api/threads', { title: 'child', parent });
await api('POST', `/api/threads/${child.id}/entries`, { body: 'do it', to: { runner: 'laptop', model: 'echo/echo' } });
const note = await until(async () => (await view(parent)).entries.find((e) => e.entry.kind === 'agent-ide.note' && e.entry.data.text.startsWith('echo@laptop:')));
check(Boolean(note), 'child answer reported to the parent');

done();
