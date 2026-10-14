// With usage, GET /api/usage gives what each shown thread's agents spent, from Pi's own `pi.usage` ledger on their
// conversations, and GET /api/threads/:id/usage one thread's. A fork's agents count only what they spent since the fork,
// so nothing counts twice. Without usage, no endpoint.
import { rmSync } from 'node:fs';
import { answered, answers, api, check, conversationOf, db, done, runner, server, sleep, view } from './lib.js';

const tokens = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;
let srv = await server({ USAGE: '1' });
await runner('laptop');
const echo = { runner: 'laptop', model: 'echo/echo' };

const { json: { id: a } } = await api('POST', '/api/threads', { title: 'spends' });
await api('POST', `/api/threads/${a}/entries`, { body: 'hello', to: echo });
await answered(a);
await api('POST', `/api/threads/${a}/entries`, { body: 'again' });
const v = await answered(a, 2);
const { json: { id: quiet } } = await api('POST', '/api/threads', { title: 'quiet' });

const one = (await api('GET', `/api/threads/${a}/usage`)).json;
const [agent] = one.agents;
const ledger = (await conversationOf(v, 'echo/echo@laptop')).docs['pi.usage'].models['echo/echo'];
check(agent?.name === 'echo/echo@laptop' && tokens(agent.total) > 0, 'an agent that answered has spent tokens', JSON.stringify(one));
check(['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => agent.total[k] === ledger[k]), 'what it spent is Pi\'s ledger on its conversation', JSON.stringify({ agent, ledger }));
check(Object.keys(agent.models).join() === 'echo/echo', 'by model, named as pi names it', JSON.stringify(agent.models));

const all = (await api('GET', '/api/usage')).json;
check(all.threads.length === 2 && tokens(all.threads.find((t) => t.id === quiet).total) === 0, 'every shown thread is there, one nobody asked at zero', JSON.stringify(all));
check(tokens(all.total) === tokens(one.total), 'the total is the sum of the threads', JSON.stringify(all.total));

// A fork's agent starts with an empty ledger: the source's spend isn't counted again.
const f = (await api('POST', `/api/threads/${a}/fork`, { at: answers(v)[0].id })).json.id;
check(tokens((await api('GET', `/api/threads/${f}/usage`)).json.total) === 0, 'a fork has spent nothing yet');
await api('POST', `/api/threads/${f}/entries`, { body: 'other way' });
await answered(f, 2);
const forked = (await api('GET', `/api/threads/${f}/usage`)).json.total;
const after = (await api('GET', '/api/usage')).json;
check(tokens(forked) > 0 && tokens(after.total) === tokens(one.total) + tokens(forked), 'then only what it spent since', JSON.stringify({ forked, total: after.total }));
check((await api('GET', '/api/threads/999/usage')).status === 404, 'no such thread is a 404');

srv.kill();
await sleep(300);
for (const file of [db, `${db}-wal`, `${db}-shm`]) rmSync(file, { force: true });
srv = await server();
check((await api('GET', '/api/usage')).status === 404, 'without usage there is no endpoint');
srv.kill();
done();
