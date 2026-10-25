// RUNNER=dir starts a runner on the server's own machine, named after it, as a process of its own that stops with the server.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answered, api, check, dir, done, server, sleep, until, view } from './lib.js';

const name = os.hostname();
const online = async () => (await api('GET', '/api/runners')).json.find((r) => r.name === name)?.online;
// No pi logins of yours: echo needs none.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'agent-ide-home-'));

let srv = await server({ RUNNER: dir, HOME });
check(await until(online), `the server's machine is a runner, ${name}`);
const { json: { id } } = await api('POST', '/api/threads', { title: 'lent' });
await api('POST', `/api/threads/${id}/entries`, { body: 'hello', to: { runner: name, model: 'echo/echo' } });
const v = await answered(id);
check(v?.entries.at(-1).data.body.startsWith(`echo@${name} heard`), 'an agent on it answers');

srv.kill('SIGTERM');
await new Promise((r) => srv.on('exit', r));
srv = await server();
await sleep(3000);
check(!(await online()), 'its runner stopped with the server, so it never comes back');
check((await view(id)).entries.length === v.entries.length, 'and the thread kept everything');
done();
