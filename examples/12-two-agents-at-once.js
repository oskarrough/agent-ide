// Two agents in one thread at once. Each answers from its own Pi conversation, where the other's words arrive as user
// text with its name, never as its own. The thread is working while either is, and stop stops both.
import { answered, answers, api, brief, check, conversationOf, done, say, scriptedRunner, server, sleep, text, until, view } from './lib.js';

await server();
const thinks = (who) => () => say(`${who} thinks ${'hmm '.repeat(150)}`);
const ann = await scriptedRunner('ann', thinks('ann'));
const bob = await scriptedRunner('bob', thinks('bob'));
const toAnn = { runner: 'ann', model: 'echo/echo' };
const toBob = { runner: 'bob', model: 'echo/echo' };

const { json: { id } } = await api('POST', '/api/threads', { title: 'two' });
const q1 = (await api('POST', `/api/threads/${id}/entries`, { body: 'ann, what is 2+2?', to: toAnn })).json;
const q2 = await api('POST', `/api/threads/${id}/entries`, { body: 'bob, what is 3+3?', to: toBob });
check(q2.status === 201, 'asking a second agent while the first works is fine', JSON.stringify(q2.json));
const both = await until(async () => {
  const v = await view(id);
  return v.agents.length === 2 && v.agents.every((a) => a.status === 'working') && v.status === 'working' ? v : null;
}, 8000, 20);
check(Boolean(both), 'both agents work at once, and the thread is working', JSON.stringify((await view(id)).agents));

const v = await answered(id, 2);
const answerTo = (q) => answers(v).find((a) => a.data.re?.includes(q.entry));
check(answerTo(q1)?.data.author === 'echo@ann' && answerTo(q2.json)?.data.author === 'echo@bob', 'each answers the message that asked it', brief(v));

// Ana asks ann again. Ann catches up on everything since it last looked: oskar's question to bob, and bob's answer.
const q3 = (await api('POST', `/api/threads/${id}/entries`, { body: 'ann, what did bob say?', to: toAnn }, 'ana')).json;
const v3 = await answered(id, 3);
const own = (await conversationOf(v3, 'echo@ann')).entries;
const caughtUp = text(own.filter((e) => e.kind === 'pi.user').at(-1)?.model[0]);
check(caughtUp.startsWith('oskar: bob, what is 3+3?\n\necho@bob: bob thinks') && caughtUp.endsWith('ana: ann, what did bob say?'), 'bob\'s answer reaches ann as user text with its name', caughtUp.slice(0, 120));
check(!own.some((e) => e.kind === 'pi.assistant' && JSON.stringify(e.model).includes('bob thinks')), 'nothing bob said is in ann\'s conversation as ann\'s own');
check(!own.some((e) => e.kind === 'pi.user' && text(e.model[0]).includes('ann thinks')), 'ann never reads its own answers back');
check(JSON.stringify(answers(v3).at(-1).data.re) === JSON.stringify([q3.entry]), 'ann\'s answer answers only what asked ann', JSON.stringify(answers(v3).at(-1).data));

// Stop stops both.
await api('POST', `/api/threads/${id}/entries`, { body: 'both again', to: [toAnn, toBob] });
await until(async () => (await view(id)).agents.every((a) => a.status === 'working'), 8000, 20);
await api('POST', `/api/threads/${id}/stop`, {});
await sleep(500);
const stopped = await view(id);
check(stopped.agents.every((a) => a.status === 'idle') && stopped.status !== 'working', 'stop stops every agent in the thread', JSON.stringify(stopped.agents));

ann.close();
bob.close();
done();
