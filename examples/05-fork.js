// Forking at any entry: a new thread with everything up to there and the agent it had then. Authors survive a fork
// and a fork of a fork. A fork of a busy thread starts idle; after a restart the director knows a fork's agents.
import { answered, answers, api, brief, check, done, runner, server, sleep, until, view } from './lib.js';

let srv = await server();
let laptop = await runner('laptop');
const echo = { runner: 'laptop', model: 'echo/echo' };

const { json: { id: a } } = await api('POST', '/api/threads', { title: 'source' });
await api('POST', `/api/threads/${a}/entries`, { body: 'hello', to: echo });
await answered(a);
await api('POST', `/api/threads/${a}/entries`, { body: 'second' }, 'ana');
const source = await answered(a, 2);
const hello = source.entries.find((e) => e.entry.kind === 'pi.user');
const firstAnswer = answers(source)[0];

const forked = await api('POST', `/api/threads/${a}/fork`, { at: firstAnswer.entry.id });
check(forked.status === 201, 'fork created', JSON.stringify(forked.json));
const f = forked.json.id;
let fv = await view(f);
check(fv.title === 'source (fork)', 'fork gets a title', fv.title);
check(fv.conversation?.parent?.conversationId === a && fv.conversation.parent.at === firstAnswer.entry.id, 'Pi records where the fork came from', JSON.stringify(fv.conversation));
check(fv.parent === null, 'a fork is not a child thread', fv.parent);
check(fv.entries.length === source.entries.indexOf(firstAnswer) + 1 && fv.entries.at(-1).entry.id === firstAnswer.entry.id, 'fork has the history up to the entry', brief(fv));
const fHello = fv.entries.find((e) => e.entry.kind === 'pi.user');
check(fHello?.author === 'oskar' && fHello.to?.model === 'echo/echo' && fHello.requestId === hello.requestId, 'inherited input keeps author and to', JSON.stringify(fHello));
check(answers(fv)[0]?.author === 'echo@laptop' && answers(fv)[0].re?.[0] === hello.entry.id, 'inherited answer keeps its agent and re', JSON.stringify(answers(fv)[0]));
check(fv.agent?.model === 'echo/echo', 'fork keeps the agent it had then', JSON.stringify(fv.agent));
check((await api('GET', '/api/threads')).json.some((t) => t.id === f), 'fork is in the thread list');

// Post in the fork: answered there, nothing reported to the source.
await api('POST', `/api/threads/${f}/entries`, { body: 'other way' }, 'ben');
fv = await answered(f, 2);
const ben = fv?.entries.find((e) => e.author === 'ben');
check(Boolean(ben) && answers(fv).at(-1).re?.includes(ben.entry.id), 'fork answers its own input', brief(fv));
check((await view(a)).entries.length === source.entries.length, 'source unchanged, no report from the fork', brief(await view(a)));

const f2 = (await api('POST', `/api/threads/${f}/fork`, { at: answers(fv).at(-1).entry.id, title: 'deeper' })).json.id;
const f2v = await view(f2);
check(f2v.title === 'deeper' && ['oskar', 'ben'].every((who) => f2v.entries.some((e) => e.author === who && e.entry.kind === 'pi.user')), 'fork of a fork keeps every author', brief(f2v));

// A fork of a busy thread: runner offline, input queued in the source. The fork starts idle.
laptop.kill();
await until(() => api('GET', '/api/runners').then((r) => r.json.every((x) => !x.online)));
await api('POST', `/api/threads/${a}/entries`, { body: 'while away' }, 'cy');
await until(async () => (await view(a)).status === 'blocked');
const busy = await view(a);
const f3 = (await api('POST', `/api/threads/${a}/fork`, { at: busy.entries.at(-1).entry.id })).json.id;
const f3v = await view(f3);
check(!f3v.docs['pi.live']?.run && !(f3v.docs['pi.inbox']?.items ?? []).length && f3v.status !== 'working' && f3v.status !== 'blocked', 'fork of a busy thread inherits no run or queue', JSON.stringify({ status: f3v.status, live: f3v.docs['pi.live'], inbox: f3v.docs['pi.inbox'] }));

// Restart with the director: the queued input is followed in the source, not the fork.
srv.kill();
await sleep(500);
srv = await server({ DIRECTOR: '1' });
laptop = await runner('laptop', { wait: false });
const after = await answered(a, 3, 15000);
check(Boolean(after?.entries.find((e) => e.author === 'cy')), 'after restart the source answers its queued input', brief(after));
const f3after = await view(f3);
check(answers(f3after).length === answers(f3v).length && !f3after.entries.some((e) => e.entry.kind === 'agent-ide.error'), 'the fork is left alone', brief(f3after));
await api('POST', `/api/threads/${f2}/entries`, { body: '@laptop again' }, 'di');
const f2after = await answered(f2, 3);
check(Boolean(f2after?.entries.find((e) => e.author === 'di')?.to), 'director routes by agents the fork inherited', brief(f2after));

const bad = await api('POST', `/api/threads/${a}/fork`, { at: 999999 });
check(bad.status >= 400, 'fork at an unknown entry fails', JSON.stringify(bad));

done();
