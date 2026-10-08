// Forking before an agent's first answer. The fork keeps the agent, in a new conversation that has seen nothing.
import { answered, api, check, conversationOf, done, say, scriptedRunner, server, text, until, view } from './lib.js';

let srv = await server({ DIRECTOR: '1' });
const bot = await scriptedRunner('bot', (request) => say(text(request.messages.findLast((m) => m.role === 'user')).includes('@bot')
  ? 'another way' : 'still thinking '.repeat(500)));
const to = { runner: 'bot', model: 'echo/echo' };
const { json: { id } } = await api('POST', '/api/threads', { title: 'first question' });
const ask = (await api('POST', `/api/threads/${id}/entries`, { body: 'try this', to })).json.entry;
await until(async () => (await api('GET', '/api/runners')).json.some((r) => r.calls.some((c) => c.op === 'stream')));
const source = await view(id);
const fork = await view((await api('POST', `/api/threads/${id}/fork`, { at: ask })).json.id);
check(fork.agents.length === 1 && fork.agents[0].name === source.agents[0]?.name, 'the fork keeps the agent asked before its answer', JSON.stringify(fork.agents));
check(fork.agents[0]?.conversation !== source.agents[0]?.conversation, 'in a conversation of its own');
const home = (await api('GET', `/api/conversations/${fork.agents[0]?.conversation}`)).json;
check(!home.entries?.some((e) => e.kind === 'pi.user'), 'which has seen nothing yet', JSON.stringify(home.entries));
await api('POST', `/api/threads/${id}/stop`, {});
const exited = new Promise((resolve) => srv.once('exit', resolve));
srv.kill('SIGKILL');
await exited;
srv = await server({ DIRECTOR: '1' });
check((await view(fork.id)).agents[0]?.status === 'idle', 'the inherited agent stays idle after restart');
const routed = await api('POST', `/api/threads/${fork.id}/entries`, { body: '@bot try another way' });
check(routed.json.to?.[0]?.runner === 'bot', 'the director can address the inherited agent', JSON.stringify(routed.json));
const settled = await answered(fork.id);
check(Boolean(settled), 'the fork answers after restart');
const inputs = (await conversationOf(settled ?? await view(fork.id), 'echo/echo@bot')).entries
  .filter((e) => e.kind === 'pi.user').map((e) => text(e.model[0]));
check(JSON.stringify(inputs) === JSON.stringify(['oskar: try this\n\noskar: @bot try another way']), 'its first input carries the inherited question exactly once', JSON.stringify(inputs));
bot.close();
done();
