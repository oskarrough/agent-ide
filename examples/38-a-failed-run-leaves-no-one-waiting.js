// A message that waits behind a run that fails still gets its answer. The agent is busy in a tool call when a second
// message queues behind it; the model then fails the first run, and the second starts its own.
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { api, call, check, done, say, scriptedRunner, server, until, view } from './lib.js';

await server();
const asked = (request, t) => request.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes(t));
const bot = await scriptedRunner('bot', (request) => asked(request, 'second') ? say('answered second')
  : request.messages.some((m) => m.role === 'toolResult') ? fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'the model broke' })
  : call('bash', { command: 'sleep 1' }));
const to = { runner: 'bot', model: 'echo/echo' };
const { json: { id } } = await api('POST', '/api/threads', { title: 'failed run' });
await api('POST', `/api/threads/${id}/entries`, { body: 'first', to });
check(Boolean(await until(async () => (await api('GET', '/api/runners')).json.some((r) => r.calls.some((c) => c.what === 'exec')), 8000, 10)), 'the first input is inside its tool call');
await api('POST', `/api/threads/${id}/entries`, { body: 'second', to });
const v = (await until(async () => {
  const v = await view(id);
  return v.entries.some((e) => e.data.answer) && v.status !== 'working' ? v : null;
})) ?? await view(id);
const posts = v.entries.filter((e) => e.data.author === 'echo/echo@bot').map((e) => e.data.body);
check(posts.some((b) => b.startsWith('gave no answer')), 'the failed run says so', JSON.stringify(posts));
check(posts.includes('answered second'), 'the queued message gets its own answer', JSON.stringify(posts));
check(v.status !== 'working', 'the agent is not left working', v.status);
bot.close();
done();
