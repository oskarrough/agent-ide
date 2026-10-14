// A detail the memory lost is still found word for word: here the writer keeps nothing of what it summarises, as any
// line high in the tree must for most of what it covers, so no line says where crate 412 went. `threads` with a
// `query` finds the message whole, ignoring case, in the agent's own thread when it names none.
import { api, call, check, conversationOf, done, linesOf, say, scriptedRunner, server, text, until, view } from './lib.js';

const route = (request) => {
  const first = text(request.messages.find((m) => m.role === 'user'));
  if (first.includes('<input>')) return say(`tickets moved ${'x'.repeat(280)}`);
  const results = request.messages.filter((m) => m.role === 'toolResult').length;
  return [call('threads', { query: 'CRATE 412' }), call('threads', { query: 'crate 999' })][results] ?? say('done');
};
const fact = (k) => `ticket ${1000 + k}: moved crate ${400 + k} to bay ${k % 31}. ${'Notes on the move. '.repeat(40).trim()}`;

const srv = await server({ MEMORY: '1', MEMORY_MODEL: 'echo/echo@bot' });
await scriptedRunner('bot', route);
const { json: { id } } = await api('POST', '/api/threads', { title: 'crates' });
for (let k = 0; k < 16; k++) await api('POST', `/api/threads/${id}/entries`, { body: fact(k), to: null });
const lines = await until(async () => { const ls = await linesOf(id); return ls.length === 31 && ls; }, 20000);
check(Boolean(lines) && lines.every((x) => !x.text.includes('crate 412')), 'no line of the memory says where crate 412 went');

await api('POST', `/api/threads/${id}/entries`, { body: 'where did crate 412 go?', to: { runner: 'bot', model: 'echo/echo' } });
const v = await until(async () => { const v = await view(id); return v.entries.some((e) => e.data.answer) && v; }, 20000);
const results = (await conversationOf(v, 'echo/echo@bot')).entries.filter((e) => e.kind === 'pi.tool-result').map((e) => text(e.model[0]));
const message = v.entries.find((e) => e.data.body === fact(12));
const [hit, asked] = results[0]?.split('\n') ?? [];
check(hit === `#${message.id} oskar: ${fact(12)}`, 'threads with a query gives the message that holds it, whole, ignoring case', hit?.slice(0, 120));
check(asked?.endsWith('where did crate 412 go?'), 'and the question too, newest last', asked);
check(results[1] === 'No entry contains it.', 'and says so when nothing does', results[1]);

srv.kill();
done();
