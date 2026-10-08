// Who wrote what. An input keeps its author and its `to` in Pi's own request id, so stock Pi Durable stores them:
// no table of our own, no data on the entry. The answer says which agent wrote it and which input it answers.
// A second person who names no agent gets the thread's agent.
// bun examples/01-who-wrote-what.js
import { answered, api, check, done, runner, server } from './lib.js';

await server();
await runner('laptop');

const { json: { id } } = await api('POST', '/api/threads', { title: 'test' });
const echo = { runner: 'laptop', model: 'echo/echo' };
const posted = await api('POST', `/api/threads/${id}/entries`, { body: 'hello', to: echo });
check(posted.status === 201 && posted.json.requestId.startsWith('author=oskar&runner=laptop&model=echo%2Fecho'), 'request id carries author and to', JSON.stringify(posted.json));

const view = await answered(id);
const input = view?.entries.find((e) => e.entry.kind === 'pi.user');
const answer = view?.entries.find((e) => e.entry.kind === 'pi.assistant');
check(input?.author === 'oskar' && input?.to?.model === 'echo/echo' && input?.to?.runner === 'laptop', 'input shows author and to', JSON.stringify(input));
check(input?.entry.data === undefined, 'pi.user entry carries no data (stock Pi)');
check(answer?.author === 'echo@laptop', 'answer author is the agent', answer?.author);
check(answer?.replyTo?.[0] === input?.entry.id, 'answer replies to the input', JSON.stringify(answer?.replyTo));
check(view?.agent?.model === 'echo/echo', 'thread agent from Pi', JSON.stringify(view?.agent));

// Ana says something without a `to`: the thread's agent answers her.
await api('POST', `/api/threads/${id}/entries`, { body: 'me too' }, 'ana');
const v2 = await answered(id, 2);
const ana = v2?.entries.find((e) => e.author === 'ana');
check(ana?.to?.runner === 'laptop', 'second author defaults to the thread agent', JSON.stringify(ana));

done();
