// A frame the server can't read is dropped, so one buggy tab or runner never stops the server for everyone.
import { answered, api, base, check, done, runner, server, sleep } from './lib.js';

const server1 = await server();
await runner('laptop');
for (const query of ['', '?runner=bad']) {
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws${query}`);
  await new Promise((resolve) => socket.onopen = resolve);
  for (const frame of ['not json', 'null', '{"id":']) socket.send(frame);
  await sleep(300);
  socket.close();
}
check(server1.exitCode === null, 'frames that aren\'t JSON, or aren\'t an object, leave the server running');
const { json: { id } } = await api('POST', '/api/threads', { title: 'after' });
await api('POST', `/api/threads/${id}/entries`, { body: 'still there?', to: { runner: 'laptop', model: 'echo/echo' } });
check(Boolean(await answered(id)), 'and the runner still answers');

done();
