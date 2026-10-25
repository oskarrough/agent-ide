// An agent reads another agent's work in a thread, not just its answer: the tool calls it made and what they printed.
import { answered, api, call, check, done, say, scriptedRunner, server, text } from './lib.js';

const lastOf = (request) => request.messages.findLast((m) => m.role !== 'system');
await server();
// On the vps: looks at the log, then answers with only a summary.
await scriptedRunner('vps', (request) => lastOf(request).role === 'toolResult'
  ? say('found a problem in the log')
  : call('bash', { command: 'echo "ERROR null user in /api/me (line 42)"' }));
// On the laptop: reads what the vps agent saw, then says what it found.
await scriptedRunner('laptop', (request) => {
  const last = lastOf(request);
  if (last.role === 'toolResult') return say(`read: ${text(last)}`);
  if (text(last).includes('which line')) return call('threads', { agent: 'vps', query: 'null user' });
  return call('threads', { agent: 'nobody-here' });
});

const { json: { id } } = await api('POST', '/api/threads', { title: 'errors' });
const ask = async (body, runner, n) => {
  await api('POST', `/api/threads/${id}/entries`, { body, to: { runner, model: 'echo/echo' } });
  return (await answered(id, n))?.entries.at(-1).data.body ?? '';
};
const summary = await ask('what fails on the vps?', 'vps', 1);
check(summary === 'found a problem in the log' && !summary.includes('42'), 'the vps agent answers with only a summary', summary);

const read = await ask('which line fails?', 'laptop', 2);
check(read.includes('bash: ERROR null user in /api/me (line 42)'), 'the laptop agent reads what the vps agent\'s bash printed, word for word', read);
check(!read.includes('said: found a problem'), 'query narrows it to what matches', read);

const wrong = await ask('and someone else?', 'laptop', 3);
check(wrong.includes('No agents in thread') && wrong.includes('echo/echo@vps'), 'an agent that isn\'t there is an error naming who is', wrong);
done();
