// Forking at any entry: a new thread with everything up to there, and each agent's conversation forked at the last
// answer it gave by then, so it catches up on the rest. Authors survive a fork and a fork of a fork. A fork of a busy
// thread starts idle; after a restart the director knows a fork's agents.
import { answered, answers, api, brief, check, conversationOf, done, runner, server, sleep, text, until, view } from './lib.js';

let srv = await server();
let laptop = await runner('laptop');
const echo = { runner: 'laptop', model: 'echo/echo' };

const { json: { id: a } } = await api('POST', '/api/threads', { title: 'source' });
await api('POST', `/api/threads/${a}/entries`, { body: 'hello', to: echo });
await answered(a);
await api('POST', `/api/threads/${a}/entries`, { body: 'second' }, 'ana');
const source = await answered(a, 2);
const firstAnswer = answers(source)[0];

const forked = await api('POST', `/api/threads/${a}/fork`, { at: firstAnswer.id });
check(forked.status === 201, 'fork created', JSON.stringify(forked.json));
const f = forked.json.id;
let fv = await view(f);
check(fv.title === 'source (fork)', 'fork gets a title', fv.title);
check(fv.conversation?.parent?.conversationId === a && fv.conversation.parent.at === firstAnswer.id, 'Pi records where the fork came from', JSON.stringify(fv.conversation));
check(fv.parent === null, 'a fork is not a child thread', fv.parent);
check(brief(fv) === brief({ entries: source.entries.slice(0, source.entries.indexOf(firstAnswer) + 1) }), 'fork has the history up to the entry', brief(fv));
check(fv.entries[0]?.data.author === 'oskar' && answers(fv)[0]?.data.author === 'echo@laptop', 'inherited messages keep their authors', brief(fv));
const [sourceAgent] = source.agents;
const [forkAgent] = fv.agents;
const forkOwn = await conversationOf(fv, 'echo@laptop');
check(forkAgent?.name === 'echo@laptop' && forkAgent.to?.model === 'echo/echo' && forkAgent.conversation !== sourceAgent.conversation, 'the fork has its own conversation for the agent', JSON.stringify(fv.agents));
check(forkOwn.conversation?.parent?.conversationId === sourceAgent.conversation && forkOwn.conversation.parent.at === firstAnswer.data.answer.entry, 'Pi forked it at the answer the agent had given by then', JSON.stringify(forkOwn.conversation));
check((await api('GET', '/api/threads')).json.some((t) => t.id === f), 'fork is in the thread list');

// Post in the fork: the forked agent catches up on what's new since that answer, and nothing reaches the source.
await api('POST', `/api/threads/${f}/entries`, { body: 'other way' }, 'ben');
fv = await answered(f, 2);
const ben = fv?.entries.find((e) => e.data.author === 'ben');
check(Boolean(ben) && answers(fv).at(-1).data.re?.includes(ben.id), 'fork answers its own message', brief(fv));
const inputs = (await conversationOf(fv, 'echo@laptop')).entries.filter((e) => e.kind === 'pi.user').map((e) => text(e.model[0]));
check(JSON.stringify(inputs) === JSON.stringify(['oskar: hello', 'ben: other way']), 'the forked agent read hello once, then only ben', JSON.stringify(inputs));
check(brief(await view(a)) === brief(source), 'source unchanged, no report from the fork', brief(await view(a)));

const f2 = (await api('POST', `/api/threads/${f}/fork`, { at: answers(fv).at(-1).id, title: 'deeper' })).json.id;
const f2v = await view(f2);
check(f2v.title === 'deeper' && ['oskar', 'ben'].every((who) => f2v.entries.some((e) => e.data.author === who)), 'fork of a fork keeps every author', brief(f2v));

// A fork of a busy thread: runner offline, its input queued in the source. The fork starts idle.
laptop.kill();
await until(() => api('GET', '/api/runners').then((r) => r.json.every((x) => !x.online)));
await api('POST', `/api/threads/${a}/entries`, { body: 'while away' }, 'cy');
await until(async () => (await view(a)).status === 'blocked');
const busy = await view(a);
const f3 = (await api('POST', `/api/threads/${a}/fork`, { at: busy.entries.at(-1).id })).json.id;
const f3v = await view(f3);
check(!['working', 'blocked'].includes(f3v.status) && f3v.agents.every((x) => x.status === 'idle'), 'fork of a busy thread inherits no run or queue', JSON.stringify({ status: f3v.status, agents: f3v.agents }));

// Restart with the director: the queued input is followed in the source, not the fork.
srv.kill();
await sleep(500);
srv = await server({ DIRECTOR: '1' });
laptop = await runner('laptop', { wait: false });
const after = await answered(a, 3, 15000);
check(Boolean(after?.entries.find((e) => e.data.author === 'cy')), 'after restart the source answers its queued message', brief(after));
const f3after = await view(f3);
check(answers(f3after).length === answers(f3v).length && !f3after.entries.some((e) => e.data.error), 'the fork is left alone', brief(f3after));
await api('POST', `/api/threads/${f2}/entries`, { body: '@laptop again' }, 'di');
const f2after = await answered(f2, 3);
check(Boolean(f2after?.entries.find((e) => e.data.author === 'di')?.data.to), 'director routes by agents the fork inherited', brief(f2after));

const bad = await api('POST', `/api/threads/${a}/fork`, { at: 999999 });
check(bad.status >= 400, 'fork at an unknown entry fails', JSON.stringify(bad));

done();
