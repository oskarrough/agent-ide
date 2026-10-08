// A steer joins the answer being written. The agent is busy in a tool call when a second message steers in, so one
// answer comes back, and it says it answers both.
import { answered, answers, api, call, check, conversationOf, done, say, scriptedRunner, server, text, until, view } from './lib.js';

await server();
const bot = await scriptedRunner('bot', (request) => request.messages.some((m) => m.role === 'toolResult')
  ? say('answered both') : call('bash', { command: 'sleep 1' }));
const to = { runner: 'bot', model: 'echo/echo' };
const { json: { id } } = await api('POST', '/api/threads', { title: 'steer' });
const first = (await api('POST', `/api/threads/${id}/entries`, { body: 'first', to })).json.entry;
check(Boolean(await until(async () => (await api('GET', '/api/runners')).json.some((r) => r.calls.some((c) => c.what === 'exec')), 8000, 10)), 'the first input is inside its tool call');
const second = (await api('POST', `/api/threads/${id}/entries`, { body: 'second', to, steer: true })).json.entry;
const v = (await answered(id)) ?? await view(id);
const inputs = (await conversationOf(v, 'echo/echo@bot')).entries.filter((e) => e.kind === 'pi.user').map((e) => text(e.model[0]));
check(inputs.includes('oskar: second'), 'Pi placed the steer', JSON.stringify(inputs));
check(answers(v).length === 1, 'both inputs share one answer');
check(JSON.stringify(answers(v)[0]?.data.re) === JSON.stringify([first, second]), 'the answer says it answers both', JSON.stringify(answers(v)[0]?.data.re));
bot.close();
done();
