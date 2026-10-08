// Two agents in one thread at once. Each answers from its own Pi conversation, where the other's words arrive as user
// text with its name, never as its own. The thread is working while either is, and stop stops both. A stop that withdraws
// a queued input leaves its messages unseen, for the next input to carry.
import { answered, answers, api, brief, call, check, conversationOf, done, say, scriptedRunner, server, sleep, text, until, view } from './lib.js';

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
check(answerTo(q1)?.data.author === 'echo/echo@ann' && answerTo(q2.json)?.data.author === 'echo/echo@bob', 'each answers the message that asked it', brief(v));

// Ana asks ann again. Ann catches up on everything since it last looked: oskar's question to bob, and bob's answer.
const q3 = (await api('POST', `/api/threads/${id}/entries`, { body: 'ann, what did bob say?', to: toAnn }, 'ana')).json;
const v3 = await answered(id, 3);
const own = (await conversationOf(v3, 'echo/echo@ann')).entries;
const caughtUp = text(own.filter((e) => e.kind === 'pi.user').at(-1)?.model[0]);
check(caughtUp.startsWith('oskar: bob, what is 3+3?\n\necho/echo@bob: bob thinks') && caughtUp.endsWith('ana: ann, what did bob say?'), 'bob\'s answer reaches ann as user text with its name', caughtUp.slice(0, 120));
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

// Cy works through a tool call. A follow-up queues behind the run; a steer is placed after the tool call. Stop withdraws
// the follow-up, so the next input to cy carries it.
const cy = await scriptedRunner('cy', (request) => {
  const t = text(request.messages.findLast((m) => m.role === 'user'));
  if (t.includes('again')) return say('cy heard it all');
  if (request.messages.at(-1).role === 'user' && t.includes('work')) return call('bash', { command: 'sleep 1' });
  return say(`cy thinks ${'hmm '.repeat(300)}`);
});
const toCy = { runner: 'cy', model: 'echo/echo' };
const { json: { id: gap } } = await api('POST', '/api/threads', { title: 'gap' });
const cyInputs = async () => (await conversationOf(await view(gap), 'echo/echo@cy')).entries?.filter((e) => e.kind === 'pi.user').map((e) => text(e.model[0])) ?? [];
await api('POST', `/api/threads/${gap}/entries`, { body: 'work', to: toCy });
await until(async () => (await conversationOf(await view(gap), 'echo/echo@cy')).entries?.some((e) => e.kind === 'pi.assistant'), 8000, 20);
await api('POST', `/api/threads/${gap}/entries`, { body: 'and a follow-up', to: toCy });
await api('POST', `/api/threads/${gap}/entries`, { body: 'steer now', to: toCy, steer: true });
const steered = await until(async () => (await cyInputs()).some((t) => t.includes('steer now')), 8000, 20);
await api('POST', `/api/threads/${gap}/stop`, {});
const before = await cyInputs();
check(Boolean(steered) && !before.some((t) => t.includes('follow-up')), 'the steer was placed, the follow-up withdrawn', JSON.stringify(before));
await api('POST', `/api/threads/${gap}/entries`, { body: 'again', to: toCy });
await answered(gap, 1);
const last = (await cyInputs()).at(-1);
check(last === 'oskar: and a follow-up\n\noskar: again', 'the next input carries the withdrawn follow-up', JSON.stringify(last));

ann.close();
bob.close();
cy.close();
done();
