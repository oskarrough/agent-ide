// Who wrote what. A thread is plain messages, each with its author and the agents it asks. An agent answers from its
// own Pi conversation, where the thread's messages are stock user input with their authors' names. Someone who names
// no agent asks whom the thread last asked.
import { answered, answers, api, check, conversationOf, done, runner, server, text } from './lib.js';

await server();
await runner('laptop');

const { json: { id } } = await api('POST', '/api/threads', { title: 'test' });
const echo = { runner: 'laptop', model: 'echo/echo' };
const posted = await api('POST', `/api/threads/${id}/entries`, { body: 'hello', to: echo });
check(posted.status === 201 && posted.json.entry > 0, 'posting returns its entry', JSON.stringify(posted.json));

const view = await answered(id);
const input = view?.entries.find((e) => e.id === posted.json.entry);
const answer = answers(view ?? { entries: [] })[0];
check(input?.data.author === 'oskar' && input.data.to?.[0].model === 'echo/echo' && input.data.to[0].runner === 'laptop', 'the message says who wrote it and whom it asks', JSON.stringify(input));
check(answer?.data.author === 'echo@laptop', 'answer author is the agent', JSON.stringify(answer));
check(answer?.data.re?.[0] === input?.id, 'the answer says which message it answers (re)', JSON.stringify(answer?.data.re));
const agent = view?.agents[0];
check(view?.agents.length === 1 && agent.name === 'echo@laptop' && agent.to?.model === 'echo/echo', 'the thread records its agent', JSON.stringify(view?.agents));

const own = await conversationOf(view, 'echo@laptop');
const user = own.entries?.find((e) => e.kind === 'pi.user');
check(text(user?.model[0]) === 'oskar: hello' && user.data === undefined, 'in the agent\'s conversation the message is stock Pi user text, with its author', JSON.stringify(user));
check(answer?.data.answer.conversation === agent?.conversation && own.entries.some((e) => e.id === answer.data.answer.entry && e.kind === 'pi.assistant'), 'the answer points at the entry it came from', JSON.stringify(answer?.data.answer));
check(!(await api('GET', '/api/threads')).json.some((t) => t.id === agent?.conversation), 'the agent\'s conversation is no thread');

// Ana says something without a `to`: whom the thread last asked answers her, and reads only what's new.
await api('POST', `/api/threads/${id}/entries`, { body: 'me too' }, 'ana');
const v2 = await answered(id, 2);
const ana = v2?.entries.find((e) => e.data.author === 'ana');
check(ana?.data.to?.[0].runner === 'laptop', 'no `to` asks whom the thread last asked', JSON.stringify(ana));
check(answers(v2 ?? { entries: [] })[1]?.data.body === 'echo@laptop heard: ana: me too', 'the agent catches up on what\'s new, not its own answer', JSON.stringify(v2?.entries.at(-1)));

done();
